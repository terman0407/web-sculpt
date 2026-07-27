// ---------------------------------------------------------------------------
// 実マウスイベント（CDP Input ドメイン）で操作し、
//   ホバー時のブラシリング表示 → ドラッグで彫刻 → 背景ドラッグで回転
//   → ホイールでズーム → Shift スムーズ / Ctrl マスク → Undo
// が期待どおり動くかを検証する E2E テスト。
//
//   node test/interaction.mjs           モジュール版 (http 経由の index.html)
//   node test/interaction.mjs --file    単一ファイル版 (file:// の websculpt.html)
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, waitFor, sleep, ROOT } from './cdp.mjs';

const OUT = join(ROOT, 'test', 'shots');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};

const SINGLE_FILE = process.argv.includes('--file');
// --url http://localhost:8080  で既存サーバ（serve.ps1 など）を対象にできる
const urlArg = process.argv.indexOf('--url');
const BASE_URL = urlArg >= 0 ? process.argv[urlArg + 1] : null;

async function main() {
  const page = SINGLE_FILE ? '/websculpt.html' : '/index.html';
  console.log(`  target: ${SINGLE_FILE ? 'file://…' : (BASE_URL || 'http://…')}${page}`);
  const h = await launch(page, { width: 1440, height: 900, file: SINGLE_FILE, baseUrl: BASE_URL });
  const { cdp } = h;

  const frames = (n = 3) => cdp.eval(
    `new Promise(r=>{let i=0;const t=()=>{if(++i>=${n})r(1);else requestAnimationFrame(t)};requestAnimationFrame(t)})`);
  const mouse = (type, x, y, opts = {}) => cdp.send('Input.dispatchMouseEvent', Object.assign({
    type, x, y, button: opts.button || (type === 'mouseMoved' ? 'none' : 'left'),
    buttons: type === 'mouseReleased' ? 0 : (type === 'mouseMoved' && !opts.dragging ? 0 : 1),
    clickCount: type === 'mousePressed' ? 1 : 0,
    modifiers: opts.modifiers || 0,
  }, opts.extra || {}));
  const key = (type, code, keyName, mods = 0) => cdp.send('Input.dispatchKeyEvent', {
    type, code, key: keyName, windowsVirtualKeyCode: 0, modifiers: mods,
  });
  const st = (expr) => cdp.eval(`(${expr})`);
  const shot = async (name) => {
    const f = SINGLE_FILE ? name.replace(/\.png$/, '-singlefile.png') : name;
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, f), Buffer.from(r.data, 'base64'));
    console.log('       saved ' + f);
  };

  try {
    await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.renderer && window.WebSculpt.sculptor)'), 40000, 'boot');
    const fatal = await cdp.eval("document.getElementById('fatal').style.display");
    if (fatal === 'flex') {
      const m = await cdp.eval("document.getElementById('fatalMsg').textContent");
      throw new Error('起動時エラー: ' + m);
    }
    await frames(8);

    // キャンバスの中心（CSS 座標 = ビューポート座標）
    const rect = await cdp.eval(`JSON.stringify((()=>{const r=document.getElementById('gpu').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})())`);
    const R = JSON.parse(rect);
    const cx = Math.round(R.x + R.w / 2);
    const cy = Math.round(R.y + R.h / 2);
    console.log(`  canvas ${R.w}x${R.h} at (${R.x},${R.y}) center (${cx},${cy})`);

    // ---- 1) ホバー → ピック成功 + ブラシリング表示 ---------------------
    await mouse('mouseMoved', cx, cy);
    await frames(6);
    const pickOk = await st('WebSculpt.renderer.pick.ok');
    ok(pickOk === true, 'ホバーでピッキングが成功する');
    const pickR = await st('Math.hypot(...WebSculpt.renderer.pick.point)');
    ok(Math.abs(pickR - 1) < 0.05, `ピック点が球面上 (|p|=${Number(pickR).toFixed(4)})`);
    await shot('11-hover-ring.png');

    // メッシュ全体の形状シグネチャ（一部の頂点だけ見ると領域外で気づけない）
    const sig = () => st(`(()=>{const m=WebSculpt.mesh;let s=0;
      for(let v=0;v<m.nv;v++){ if(!m.vAlive[v]) continue; const i=v*3;
        s += m.positions[i]*1.7 + m.positions[i+1]*2.3 + m.positions[i+2]*3.1; }
      return s;})()`);

    // ---- 2) 実ドラッグで彫刻 ------------------------------------------
    const v0 = await st('WebSculpt.mesh.liveVerts');
    const before = await sig();
    await cdp.eval(`WebSculpt.state.strength = 0.9; WebSculpt.state.radiusPx = 110; WebSculpt.state.detail = 0.55`);
    await mouse('mousePressed', cx - 90, cy - 40);
    await frames(2);
    for (let k = 1; k <= 14; k++) {
      await mouse('mouseMoved', cx - 90 + k * 13, cy - 40 + Math.round(Math.sin(k * 0.4) * 22), { dragging: true });
      await frames(2);
    }
    await mouse('mouseReleased', cx + 92, cy - 40);
    await frames(4);
    const v1 = await st('WebSculpt.mesh.liveVerts');
    const after = await sig();
    ok(Math.abs(after - before) > 1e-4, `ドラッグで形状が変化した (${v0} → ${v1} 頂点)`);
    ok(v1 > v0, `動的トポロジでブラシ領域が細分化された (${v0} → ${v1})`);
    const stroking = await st('WebSculpt.sculptor.stroking');
    ok(stroking === false, 'ポインタアップでストロークが終了している');
    await shot('12-drag-sculpt.png');

    // ---- 3) Undo で戻る ------------------------------------------------
    await cdp.eval('WebSculpt.app.undo()');
    await frames(3);
    const v2 = await st('WebSculpt.mesh.liveVerts');
    ok(v2 === v0, `Undo で頂点数が戻った (${v2} == ${v0})`);
    await cdp.eval('WebSculpt.app.redo()');
    await frames(3);
    ok((await st('WebSculpt.mesh.liveVerts')) === v1, 'Redo で戻った');

    // ---- 4) 背景ドラッグで回転 -----------------------------------------
    const yaw0 = await st('WebSculpt.camera.yaw');
    const bgx = Math.round(R.x + 60), bgy = Math.round(R.y + 60);
    await mouse('mouseMoved', bgx, bgy);
    await frames(4);
    await mouse('mousePressed', bgx, bgy);
    for (let k = 0; k < 8; k++) { await mouse('mouseMoved', bgx + k * 12, bgy + k * 4, { dragging: true }); await frames(1); }
    await mouse('mouseReleased', bgx + 96, bgy + 32);
    await frames(3);
    const yaw1 = await st('WebSculpt.camera.yaw');
    ok(Math.abs(yaw1 - yaw0) > 1e-3, `背景ドラッグでカメラが回転した (${yaw0.toFixed(3)} → ${yaw1.toFixed(3)})`);
    const v3 = await st('WebSculpt.mesh.liveVerts');
    ok(v3 === v1, '背景ドラッグではメッシュが変化しない');

    // 縦方向の向き: 下へドラッグ → 手前側が下がる → カメラは上へ回り込む (pitch 増加)
    await cdp.eval('WebSculpt.camera.pitch = 0; WebSculpt.state.invertOrbitY = false');
    await frames(2);
    await mouse('mousePressed', bgx, bgy);
    for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', bgx, bgy + k * 10, { dragging: true }); await frames(1); }
    await mouse('mouseReleased', bgx, bgy + 80);
    await frames(2);
    const pitchDown = await st('WebSculpt.camera.pitch');
    ok(pitchDown > 0.05, `下ドラッグでカメラが上へ回り込む (pitch 0 → ${pitchDown.toFixed(3)})`);

    // 反転オプション
    await cdp.eval('WebSculpt.camera.pitch = 0; WebSculpt.state.invertOrbitY = true');
    await frames(2);
    await mouse('mousePressed', bgx, bgy);
    for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', bgx, bgy + k * 10, { dragging: true }); await frames(1); }
    await mouse('mouseReleased', bgx, bgy + 80);
    await frames(2);
    const pitchInv = await st('WebSculpt.camera.pitch');
    ok(pitchInv < -0.05, `反転オプションで逆向きになる (pitch 0 → ${pitchInv.toFixed(3)})`);
    await cdp.eval('WebSculpt.state.invertOrbitY = false; WebSculpt.camera.pitch = 0.25');
    await frames(2);

    // ---- 5) ホイールズーム --------------------------------------------
    const d0 = await st('WebSculpt.camera.distance');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -240, button: 'none', buttons: 0 });
    await frames(3);
    const d1 = await st('WebSculpt.camera.distance');
    ok(d1 < d0 - 1e-4, `ホイールでズームした (${d0.toFixed(3)} → ${d1.toFixed(3)})`);

    // ---- 6) Shift ドラッグ = スムーズ ----------------------------------
    await mouse('mouseMoved', cx, cy);
    await frames(5);
    await mouse('mousePressed', cx, cy, { modifiers: 8 });         // 8 = Shift
    await frames(2);
    const brushUsed = await st('JSON.stringify({b: WebSculpt.sculptor.strokeBrush, s: WebSculpt.sculptor.stroking})');
    for (let k = 1; k <= 6; k++) { await mouse('mouseMoved', cx + k * 10, cy + k * 3, { dragging: true, modifiers: 8 }); await frames(1); }
    await mouse('mouseReleased', cx + 60, cy + 18, { modifiers: 8 });
    await frames(3);
    ok(JSON.parse(brushUsed).b === 'smooth', `Shift+ドラッグでスムーズブラシになる (${brushUsed})`);

    // ---- 7) Ctrl ドラッグ = マスク ------------------------------------
    await mouse('mouseMoved', cx - 40, cy + 40);
    await frames(5);
    await mouse('mousePressed', cx - 40, cy + 40, { modifiers: 2 });  // 2 = Ctrl
    await frames(2);
    const maskBrush = await st('WebSculpt.sculptor.strokeBrush');
    for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', cx - 40 + k * 9, cy + 40, { dragging: true, modifiers: 2 }); await frames(1); }
    await mouse('mouseReleased', cx + 32, cy + 40, { modifiers: 2 });
    await frames(3);
    ok(maskBrush === 'mask', `Ctrl+ドラッグでマスクブラシになる (${maskBrush})`);
    const maskSum = await st('(()=>{let s=0;const m=WebSculpt.mesh;for(let v=0;v<m.nv;v++)s+=m.mask[v];return s;})()');
    ok(maskSum > 0.5, `マスクが実際に塗られた (合計 ${Number(maskSum).toFixed(1)})`);
    await shot('13-mask-drag.png');

    // ---- 8) キーボードショートカット ----------------------------------
    await key('keyDown', 'KeyW', 'w'); await key('keyUp', 'KeyW', 'w');
    await frames(2);
    ok((await st('WebSculpt.state.wireframe')) === true, 'W キーでワイヤフレーム切り替え');
    await key('keyDown', 'KeyW', 'w'); await key('keyUp', 'KeyW', 'w');
    await key('keyDown', 'Digit3', '3'); await key('keyUp', 'Digit3', '3');
    await frames(2);
    ok((await st('WebSculpt.state.brush')) === 'inflate', `3 キーでインフレート (${await st('WebSculpt.state.brush')})`);
    const rad0 = await st('WebSculpt.state.radiusPx');
    await key('keyDown', 'BracketRight', ']'); await key('keyUp', 'BracketRight', ']');
    await frames(1);
    ok((await st('WebSculpt.state.radiusPx')) > rad0, '] キーでブラシ半径が増える');
    await key('keyDown', 'KeyX', 'x'); await key('keyUp', 'KeyX', 'x');
    await frames(1);
    ok((await st('WebSculpt.state.symmetry.x')) === false, 'X キーで X ミラーが切り替わる');

    // ---- 9) ムーブブラシ（掴んで引っぱる） -----------------------------
    await cdp.eval(`WebSculpt.state.brush='move'; WebSculpt.state.symmetry.x=true; WebSculpt.state.strength=0.8`);
    await mouse('mouseMoved', cx, cy);
    await frames(5);
    const p0 = await sig();
    await mouse('mousePressed', cx, cy);
    for (let k = 1; k <= 10; k++) { await mouse('mouseMoved', cx + k * 8, cy - k * 5, { dragging: true }); await frames(1); }
    await mouse('mouseReleased', cx + 80, cy - 50);
    await frames(3);
    const p1 = await sig();
    ok(Math.abs(p1 - p0) > 1e-4, `ムーブブラシで頂点が移動した (Δ=${(p1 - p0).toExponential(2)})`);
    await shot('14-move-brush.png');

    // ---- 10) ダイナメッシュ（UI ボタン経由） ---------------------------
    await cdp.eval(`WebSculpt.state.dynaResolution = 72; WebSculpt.state.dynaSmooth = 1`);
    const vDyna0 = await st('WebSculpt.mesh.liveVerts');
    // ボタンを探してクリックする
    // オーバーレイの表示はクリックと同期なので、フレームを待たず同一評価内で確認する
    // （待つと処理が終わって非表示に戻ってしまう）
    const clicked = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('#rightPanel .btn')]
        .find(x => x.textContent.includes('ダイナメッシュ実行'));
      if (!b) return JSON.stringify({ found: false });
      b.click();
      return JSON.stringify({
        found: true,
        busy: document.getElementById('busy').classList.contains('show'),
      });
    })()`);
    const cl = JSON.parse(clicked);
    ok(cl.found === true, 'ダイナメッシュボタンが存在する');
    ok(cl.busy === true, '押した時点で処理中オーバーレイが表示される');
    // 完了を待つ
    await waitFor(async () => {
      const done = await st(`!document.getElementById('busy').classList.contains('show')`);
      return done === true;
    }, 30000, 'dynamesh 完了');
    await frames(4);
    const vDyna1 = await st('WebSculpt.mesh.liveVerts');
    ok(vDyna1 > 1000 && vDyna1 !== vDyna0, `ダイナメッシュでトポロジが再構築された (${vDyna0} → ${vDyna1})`);
    // 出力が閉多様体であること（各辺が 2 面）
    const manifold = await st(`(() => {
      const m = WebSculpt.mesh, T = m.tris, em = new Map();
      for (let t = 0; t < m.nt; t++) {
        const i = t*3, v = [T[i], T[i+1], T[i+2]];
        if (v[0] === v[1] && v[1] === v[2]) continue;
        for (let e = 0; e < 3; e++) {
          let a = v[e], b = v[(e+1)%3];
          const k = a < b ? a + ':' + b : b + ':' + a;
          em.set(k, (em.get(k)||0)+1);
        }
      }
      let bad = 0, bnd = 0;
      for (const n of em.values()) { if (n === 1) bnd++; else if (n !== 2) bad++; }
      return JSON.stringify({ bad, bnd, chi: m.liveVerts - em.size + m.liveTris });
    })()`);
    const mf = JSON.parse(manifold);
    ok(mf.bad === 0 && mf.bnd === 0, `ダイナメッシュ出力が閉多様体 (${manifold})`);
    ok(mf.chi === 2, `ダイナメッシュ出力の位相が球面 (χ = ${mf.chi})`);
    await shot('16-dynamesh.png');
    // ダイナメッシュ後も彫刻できる
    await mouse('mouseMoved', cx, cy);
    await frames(6);
    const sigA = await sig();
    await mouse('mousePressed', cx, cy);
    for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', cx + k * 11, cy + k * 4, { dragging: true }); await frames(2); }
    await mouse('mouseReleased', cx + 88, cy + 32);
    await frames(3);
    const sigB = await sig();
    ok(Math.abs(sigB - sigA) > 1e-4, 'ダイナメッシュ後も彫刻できる');
    // Undo で戻る
    await cdp.eval('WebSculpt.app.undo(); WebSculpt.app.undo()');
    await frames(3);
    ok((await st('WebSculpt.mesh.liveVerts')) === vDyna0, 'ダイナメッシュを Undo で戻せる');

    // ---- 11) UI 要素のクリック ----------------------------------------
    await cdp.eval(`document.querySelectorAll('#brushList .brush')[0].click()`);
    ok((await st('WebSculpt.state.brush')) === 'clay', 'ブラシパレットのクリックが効く');
    await cdp.eval(`document.querySelectorAll('.matgrid .mat')[2].click()`);
    ok((await st('WebSculpt.state.material')) === 2, 'マテリアルのクリックが効く');
    await cdp.eval(`WebSculpt.app.newMesh('torus')`);
    await frames(4);
    ok((await st('WebSculpt.mesh.liveTris')) === 3136, `トーラス生成 (${await st('WebSculpt.mesh.liveTris')} 面)`);
    await shot('15-torus.png');

    // ---- 12) 分割レベル（SDiv） ----------------------------------------
    await cdp.eval(`WebSculpt.app.newMesh('sphere'); WebSculpt.state.dynTopo = false`);
    await frames(4);
    const dv0 = await st('WebSculpt.mesh.liveVerts');
    const dt0 = await st('WebSculpt.mesh.liveTris');
    const divClicked = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('#rightPanel .btn')]
        .find(x => x.textContent.includes('分割する'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    ok(divClicked === true, '分割ボタンが存在する');
    await frames(6);
    const dv1 = await st('WebSculpt.mesh.liveVerts');
    const dt1 = await st('WebSculpt.mesh.liveTris');
    ok(dt1 === dt0 * 4, `分割で面が 4 倍 (${dt0} → ${dt1})`);
    ok((await st('WebSculpt.sculptor.levels.count')) === 1, 'レベルが 1 段作られる');
    const lvlText = await st(`document.querySelector('#rightPanel .lvl').textContent`);
    ok(/2\s*\/\s*2/.test(lvlText), `レベル表示が更新される (${lvlText})`);

    // 細かいレベルで彫って、下げて上げても細部が残るか
    await mouse('mouseMoved', cx, cy);
    await frames(6);
    await cdp.eval(`WebSculpt.state.brush='crease'; WebSculpt.state.radiusPx=45; WebSculpt.state.strength=1`);
    await mouse('mousePressed', cx - 60, cy);
    for (let k = 1; k <= 10; k++) { await mouse('mouseMoved', cx - 60 + k * 12, cy, { dragging: true }); await frames(2); }
    await mouse('mouseReleased', cx + 60, cy);
    await frames(4);
    const sigFine = await sig();
    ok((await st('WebSculpt.sculptor.levels.count')) === 1, '動的トポロジオフの彫刻でレベルが残る');

    await cdp.eval('WebSculpt.app.levelDown()');
    await frames(4);
    ok((await st('WebSculpt.mesh.liveVerts')) === dv0, `下げると元のレベルに戻る (${dv0})`);
    await cdp.eval('WebSculpt.app.levelUp()');
    await frames(4);
    ok((await st('WebSculpt.mesh.liveVerts')) === dv1, '上げると細かいレベルに戻る');
    const sigBack = await sig();
    ok(Math.abs(sigBack - sigFine) < 1e-2,
      `往復しても細部が保たれる (Δ=${Math.abs(sigBack - sigFine).toExponential(2)})`);

    // 動的トポロジを使うとレベルが破棄される
    await cdp.eval(`WebSculpt.state.dynTopo = true; WebSculpt.state.brush='clay'; WebSculpt.state.detail=0.9`);
    await mouse('mouseMoved', cx, cy);
    await frames(6);
    await mouse('mousePressed', cx, cy);
    for (let k = 1; k <= 6; k++) { await mouse('mouseMoved', cx + k * 10, cy + k * 3, { dragging: true }); await frames(2); }
    await mouse('mouseReleased', cx + 60, cy + 18);
    await frames(4);
    ok((await st('WebSculpt.sculptor.levels.count')) === 0, '動的トポロジでレベルが破棄される');

    // ---- 13) レイジーマウス --------------------------------------------
    await cdp.eval(`WebSculpt.app.newMesh('sphere'); WebSculpt.state.lazyRadius = 40`);
    await frames(4);
    await mouse('mouseMoved', cx, cy);
    await frames(4);
    // 大きく動かした直後は、ブラシ位置がカーソルから lazyRadius だけ遅れる（リード方式）
    await mouse('mouseMoved', cx + 200, cy);
    await frames(3);
    const lag = await st(
      `Math.hypot(WebSculpt.pointer.x - WebSculpt.pointer.lazyX, WebSculpt.pointer.y - WebSculpt.pointer.lazyY)`);
    ok(Math.abs(lag - 40) < 2.0, `カーソルとの距離が lazyRadius に保たれる (${lag.toFixed(1)} ≈ 40)`);
    ok((await st('WebSculpt.renderer.pick.ok')) === true, 'レイジーマウス有効時もピックできる');

    // カーソルを止めればリードは追いつかない（=そこで止まる）
    await frames(6);
    const lag2 = await st(
      `Math.hypot(WebSculpt.pointer.x - WebSculpt.pointer.lazyX, WebSculpt.pointer.y - WebSculpt.pointer.lazyY)`);
    ok(Math.abs(lag2 - lag) < 0.01, 'カーソル静止中はリードも動かない（フレームレート非依存）');

    // 無効にすればカーソルに一致する
    await cdp.eval('WebSculpt.state.lazyRadius = 0');
    await frames(3);
    const lag3 = await st(
      `Math.hypot(WebSculpt.pointer.x - WebSculpt.pointer.lazyX, WebSculpt.pointer.y - WebSculpt.pointer.lazyY)`);
    ok(lag3 < 0.01, `無効時はカーソルに一致する (${lag3})`);

    // ---- 14) ブラウザ内保存（IndexedDB） -------------------------------
    await cdp.eval(`WebSculpt.state.brush='clay'; WebSculpt.state.radiusPx=100; WebSculpt.state.strength=0.9`);
    await mouse('mouseMoved', cx, cy);
    await frames(6);
    await mouse('mousePressed', cx - 50, cy - 20);
    for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', cx - 50 + k * 12, cy - 20, { dragging: true }); await frames(2); }
    await mouse('mouseReleased', cx + 46, cy - 20);
    await frames(4);
    const savedVerts = await st('WebSculpt.mesh.liveVerts');
    const savedSig = await sig();

    await cdp.eval(`(() => {
      const inp = document.querySelector('#rightPanel input.text');
      inp.value = 'e2e-test';
      const b = [...document.querySelectorAll('#rightPanel .btn')].find(x => x.textContent.trim() === '保存');
      b.click();
      return true;
    })()`);
    await waitFor(async () => {
      const l = await cdp.eval('WebSculpt.app.listProjects().then(x => JSON.stringify(x.map(i=>i.name)))');
      return l && l.includes('e2e-test');
    }, 15000, 'IndexedDB 保存');
    ok(true, 'IndexedDB に保存できる');

    // 別のメッシュに切り替えてから読み戻す
    await cdp.eval(`WebSculpt.app.newMesh('cube')`);
    await frames(4);
    ok((await st('WebSculpt.mesh.liveVerts')) !== savedVerts, '別のメッシュに切り替わった');
    await cdp.eval(`WebSculpt.app.loadProject('e2e-test')`);
    await waitFor(async () => (await st('WebSculpt.mesh.liveVerts')) === savedVerts, 15000, '読み込み完了');
    await frames(4);
    ok((await st('WebSculpt.mesh.liveVerts')) === savedVerts, `保存したメッシュを読み戻せる (${savedVerts} 頂点)`);
    const loadedSig = await sig();
    ok(Math.abs(loadedSig - savedSig) < 1e-2,
      `形状が一致する (Δ=${Math.abs(loadedSig - savedSig).toExponential(2)})`);
    const manifold2 = await st(`(() => {
      const m = WebSculpt.mesh, T = m.tris, em = new Map();
      for (let t = 0; t < m.nt; t++) {
        const i = t*3, v = [T[i], T[i+1], T[i+2]];
        if (v[0] === v[1] && v[1] === v[2]) continue;
        for (let e = 0; e < 3; e++) {
          let a = v[e], b = v[(e+1)%3];
          const k = a < b ? a + ':' + b : b + ':' + a;
          em.set(k, (em.get(k)||0)+1);
        }
      }
      let bad = 0, bnd = 0;
      for (const n of em.values()) { if (n === 1) bnd++; else if (n !== 2) bad++; }
      return bad + ':' + bnd;
    })()`);
    ok(manifold2 === '0:0', `読み込んだメッシュが閉多様体 (${manifold2})`);

    // 設定も localStorage に保存されているか
    const hasSettings = await st(`!!localStorage.getItem('websculpt.settings.v1')`);
    ok(hasSettings === true, '設定が localStorage に保存される');

    // 削除
    await cdp.eval(`WebSculpt.app.deleteProject('e2e-test')`);
    await waitFor(async () => {
      const l = await cdp.eval('WebSculpt.app.listProjects().then(x => JSON.stringify(x.map(i=>i.name)))');
      return l && !l.includes('e2e-test');
    }, 15000, '削除完了');
    ok(true, 'IndexedDB から削除できる');
    await shot('20-saveload.png');

    // ---- 15) 新ブラシが選べて動くこと ----------------------------------
    for (const [key, id] of [['layer', 'layer'], ['hpolish', 'hpolish'], ['relax', 'relax'], ['snakehook', 'snakehook']]) {
      await cdp.eval(`WebSculpt.ui ? 0 : 0; WebSculpt.state.brush = '${id}'`);
      await mouse('mouseMoved', cx, cy);
      await frames(6);
      const before2 = await sig();
      await mouse('mousePressed', cx, cy);
      for (let k = 1; k <= 6; k++) { await mouse('mouseMoved', cx + k * 12, cy + k * 5, { dragging: true }); await frames(2); }
      await mouse('mouseReleased', cx + 72, cy + 30);
      await frames(3);
      const after2 = await sig();
      ok(Math.abs(after2 - before2) > 1e-5, `${id} ブラシが形状を変える`);
    }

    // ---- 16) 例外・GPU エラーが出ていないこと -------------------------
    const logs = await cdp.eval(`JSON.stringify(window.__errs || [])`);
    ok(logs === '[]' || logs === undefined, 'ページ例外なし ' + (logs || ''));

    console.log('\n' + (failures === 0 ? '✅ 操作系 E2E すべて通過' : `❌ ${failures} 件の失敗`));
  } catch (e) {
    console.error('\n❌ ' + (e.stack || e.message));
    const se = h.stderr();
    if (se) console.error('--- browser stderr ---\n' + se.slice(-2000));
    failures++;
  } finally {
    await h.stop();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
