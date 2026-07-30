// ---------------------------------------------------------------------------
// 2 モード体系（スカルプト = ZBrush / モデリング = Blender）の E2E テスト。
//   node test/modes.mjs           モジュール版
//   node test/modes.mjs --file    単一ファイル版
//
// ここで見たいのは「モードでキーとマウスの意味が変わること」。
// 同じキーが両モードに登録されている（A・X・1/2/3・G・E・I・R）ので、
// 絞り込みが壊れると**片方のモードで別の操作が走る**。それは見た目では
// 気付きにくく、形が黙って変わる事故になるので実キーで叩いて確かめる。
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const MOD = { alt: 1, ctrl: 2, shift: 8 };

const args = process.argv.slice(2);
const useFile = args.includes('--file');
const h = await launch(useFile ? '/websculpt.html' : '/index.html',
  { width: 1400, height: 950, file: useFile });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const head = (t) => console.log('\n== ' + t + ' ==');
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.tools)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  await cdp.eval('new Promise(r=>setTimeout(r,800))');

  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));
  const frames = (n = 3) => cdp.eval(
    `new Promise(r=>{let i=0;const t=()=>{if(++i>=${n})r(1);else requestAnimationFrame(t)};requestAnimationFrame(t)})`);
  /** 実キーを叩く。mods は MOD を足したもの */
  const key = async (code, keyName, mods = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent',
        { type, code, key: keyName, windowsVirtualKeyCode: 0, modifiers: mods });
    }
    await frames(2);
  };
  const mouse = (type, x, y, opts = {}) => cdp.send('Input.dispatchMouseEvent', Object.assign({
    type, x, y,
    button: opts.button || (type === 'mouseMoved' ? 'none' : 'left'),
    buttons: opts.buttons !== undefined ? opts.buttons
      : (type === 'mouseReleased' ? 0 : (type === 'mouseMoved' && !opts.dragging ? 0 : 1)),
    clickCount: type === 'mousePressed' ? 1 : 0,
    modifiers: opts.modifiers || 0,
  }));

  const rect = await run(`const r = document.getElementById('gpu').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };`);
  const cx = Math.round(rect.x + rect.w / 2), cy = Math.round(rect.y + rect.h / 2);

  // 動的トポロジを切って、立方体から始める（四角 100%）
  await run(`const W = window.WebSculpt;
    W.state.dynTopo = false;
    W.app.newMesh('cube');
    if (W.state.mode !== 'sculpt') W.app.setMode('sculpt');
    return 1;`);
  await frames(3);

  // --- Tab で行き来する ----------------------------------------------------
  head('Tab でモードを切り替える');
  let r = await run(`return { mode: window.WebSculpt.state.mode };`);
  ok(r.mode === 'sculpt', `最初はスカルプト (${r.mode})`);
  await key('Tab', 'Tab');
  await frames(4);
  r = await run(`const W = window.WebSculpt;
    return { mode: W.state.mode, edit: !!W.tools.edit,
      seg: [...document.querySelectorAll('#rightPanel .segmented .seg.on')].map(b => b.textContent) };`);
  ok(r.mode === 'model', `Tab でモデリングへ入る (${r.mode})`);
  ok(r.edit === true, 'モデリングで編集メッシュができている');
  ok(r.seg.includes('モデリング'), `UI のモード表示が追従する (${r.seg.join(',')})`);
  await key('Tab', 'Tab');
  await frames(4);
  r = await run(`const W = window.WebSculpt; return { mode: W.state.mode, edit: !!W.tools.edit };`);
  ok(r.mode === 'sculpt' && r.edit === false, `Tab でスカルプトへ戻る (${r.mode})`);

  // --- 同じキーがモードで別の意味になる ------------------------------------
  head('モードでキーの意味が変わる');

  // A: スカルプト = AO の入り切り / モデリング = すべて選ぶ
  r = await run(`const W = window.WebSculpt; W.state.ao = true; return { ao: W.state.ao };`);
  await key('KeyA', 'a');
  r = await run(`return { ao: window.WebSculpt.state.ao };`);
  ok(r.ao === false, 'スカルプトの A は AO を切り替える');

  await key('Tab', 'Tab');
  await frames(4);
  await run(`window.WebSculpt.tools.editSelect('none'); return 1;`);
  const before = await run(`return window.WebSculpt.tools.editInfo();`);
  await key('KeyA', 'a');
  r = await run(`const W = window.WebSculpt;
    return { sel: W.tools.editInfo().sel, ao: W.state.ao, total: W.tools.editInfo().faces };`);
  ok(r.sel.faces === r.total, `モデリングの A はすべて選ぶ (${r.sel.faces}/${r.total})`);
  ok(r.ao === false, 'モデリングの A で AO が変わらない（スカルプト側の項目が漏れていない）');

  // モデリングでも Shift+A なら AO を切り替えられる（逃げ道）
  await key('KeyA', 'A', MOD.shift);
  r = await run(`return { ao: window.WebSculpt.state.ao };`);
  ok(r.ao === true, 'モデリングの Shift+A は AO を切り替える');

  // Alt+A で解除
  await key('KeyA', 'a', MOD.alt);
  r = await run(`return window.WebSculpt.tools.editInfo().sel;`);
  ok(r.faces === 0 && r.verts === 0, `モデリングの Alt+A は選択を解除する (面 ${r.faces})`);

  // 1 / 2 / 3: スカルプト = ブラシ / モデリング = 選択の単位
  await key('Digit2', '2');
  r = await run(`const W = window.WebSculpt;
    return { unit: W.tools.editInfo().selectUnit, brush: W.state.brush };`);
  ok(r.unit === 'edge', `モデリングの 2 は辺モードにする (${r.unit})`);
  const brushInModel = r.brush;
  await key('Digit3', '3');
  r = await run(`const W = window.WebSculpt;
    return { unit: W.tools.editInfo().selectUnit, brush: W.state.brush };`);
  ok(r.unit === 'face', `モデリングの 3 は面モードにする (${r.unit})`);
  ok(r.brush === brushInModel, `モデリングの数字キーでブラシが変わらない (${r.brush})`);

  // X: スカルプト = ミラー / モデリング = 面を削除
  await run(`const W = window.WebSculpt;
    W.tools.editSelect('none');
    W.tools.edit.selFace[0] = 1;
    W.tools.edit.syncSelection('face');
    return 1;`);
  const symBefore = await run(`return { x: window.WebSculpt.state.symmetry.x };`);
  const facesBefore = await run(`return window.WebSculpt.tools.editInfo().faces;`);
  await key('KeyX', 'x');
  await frames(3);
  r = await run(`const W = window.WebSculpt;
    return { faces: W.tools.editInfo().faces, symX: W.state.symmetry.x };`);
  ok(r.faces === facesBefore - 1, `モデリングの X は面を削除する (${facesBefore} → ${r.faces})`);
  ok(r.symX === symBefore.x, 'モデリングの X で X ミラーが変わらない');

  // --- モデリングの主要操作をキーから ---------------------------------------
  head('モデリングの操作キー');
  r = await run(`const W = window.WebSculpt, T = W.tools;
    // 穴を閉じ直したいので作り直す（X で 1 枚消しているため）
    W.app.setMode('sculpt');
    W.app.newMesh('cube');
    W.app.setMode('model');
    T.editSelect('none');
    T.edit.selFace[0] = 1;
    T.edit.syncSelection('face');
    W.state.editExtrude = 0.3; W.state.editInset = 0.3;
    return T.editInfo();`);
  const start = r;
  await key('KeyE', 'e');
  const afterE = await run(`return window.WebSculpt.tools.editInfo();`);
  ok(afterE.faces === start.faces + 4, `E で押し出せる (${start.faces} → ${afterE.faces})`);
  await key('KeyI', 'i');
  const afterI = await run(`return window.WebSculpt.tools.editInfo();`);
  ok(afterI.faces === afterE.faces + 4, `I でインセットできる (${afterE.faces} → ${afterI.faces})`);
  await key('KeyI', 'I', MOD.shift);
  const afterSI = await run(`return window.WebSculpt.tools.editInfo();`);
  ok(afterSI.faces === afterI.faces + 4, `Shift+I で面ごとインセットできる (${afterI.faces} → ${afterSI.faces})`);

  // Ctrl+R ループカット / Ctrl+B ベベル（辺を選び直してから）
  r = await run(`const W = window.WebSculpt, T = W.tools;
    W.app.editSetSelectMode('edge');
    T.editSelect('none');
    const em = T.edit;
    for (let e = 0; e < em.ne; e++) {
      const a = em.edgeFace[e*2], b = em.edgeFace[e*2+1];
      if (a >= 0 && b >= 0 && em.faceSize(a) === 4 && em.faceSize(b) === 4) { em.selEdge[e] = 1; break; }
    }
    em.syncSelection('edge');
    return T.editInfo();`);
  const beforeCut = r;
  await key('KeyR', 'r', MOD.ctrl);
  const afterCut = await run(`return window.WebSculpt.tools.editInfo();`);
  ok(afterCut.faces > beforeCut.faces, `Ctrl+R でループカットできる (${beforeCut.faces} → ${afterCut.faces})`);

  // ベベルは「通り抜ける」選択でだけ通るので、素の立方体の閉じたループを使う
  // （押し出しやループカットを重ねた形では価数 3 の頂点でループが途切れる）
  r = await run(`const W = window.WebSculpt, T = W.tools;
    W.app.setMode('sculpt');
    W.app.newMesh('cube');
    W.app.setMode('model');
    W.app.editSetSelectMode('edge');
    T.editSelect('none');
    T.edit.selEdge[0] = 1;
    T.edit.syncSelection('edge');
    T.editModel('loopSelect');
    return Object.assign(T.editInfo(), { sel: T.editInfo().sel });`);
  const beforeBevel = r;
  ok(beforeBevel.sel.edges > 4, `ベベル用のループが伸びている (${beforeBevel.sel.edges} 辺)`);
  await key('KeyB', 'b', MOD.ctrl);
  const afterBevel = await run(`const W = window.WebSculpt;
    return Object.assign(W.tools.editInfo(), { errs: W.tools.edit.validate() });`);
  ok(afterBevel.faces > beforeBevel.faces, `Ctrl+B でベベルできる (${beforeBevel.faces} → ${afterBevel.faces})`);
  ok(afterBevel.errs.length === 0, `Ctrl+B のあと構造が壊れない (${afterBevel.errs.join(' / ')})`);
  ok(afterBevel.nonManifold === 0, `Ctrl+B のあと非多様体辺が無い (${afterBevel.nonManifold})`);

  // --- G / R / S のモーダル変形（Blender 式）--------------------------------
  head('G / R / S でマウスで自由に動かす');
  // 面を選び直してから。以降はカーソルを中央に置いた状態で始める
  await run(`const W = window.WebSculpt;
    W.app.setMode('sculpt');
    W.app.newMesh('cube');
    W.app.setMode('model');
    W.app.editSetSelectMode('face');
    W.tools.editSelect('all');
    return 1;`);
  await frames(4);
  await mouse('mouseMoved', cx, cy);
  await frames(2);

  /** 選択頂点の座標をまとめて拾う（比較用） */
  const snap = () => run(`const W = window.WebSculpt;
    const p = W.mesh.positions;
    return { p: [p[0], p[1], p[2], p[30], p[31], p[32]], nv: W.mesh.nv };`);

  // G: 掴んで動かして確定する
  {
    const before = await snap();
    await key('KeyG', 'g');
    r = await run(`const W = window.WebSculpt;
      return { on: W.modal.on, op: W.modal.op, axis: W.modal.axis,
        hud: document.getElementById('modalhud').classList.contains('show') };`);
    ok(r.on === true && r.op === 'move', `G でモーダル移動に入る (${r.op} / on=${r.on})`);
    ok(r.hud === true, '変形中の表示（HUD）が出る');
    // ボタンを押さずにカーソルを動かすだけで動く
    for (let k = 1; k <= 6; k++) {
      await mouse('mouseMoved', cx + k * 18, cy + k * 6);
      await frames(1);
    }
    const during = await snap();
    let moved = 0;
    for (let i = 0; i < 6; i++) if (Math.abs(during.p[i] - before.p[i]) > 1e-6) moved++;
    ok(moved > 0, `ボタンを押さずにカーソルだけで動く (${moved}/6 成分)`);
    r = await run(`return { hud: document.getElementById('modalhud').textContent };`);
    ok(/移動/.test(r.hud) && /自由/.test(r.hud), `HUD に操作と軸が出る (${r.hud.slice(0, 20)})`);
    // クリックで確定
    await mouse('mousePressed', cx + 108, cy + 36);
    await mouse('mouseReleased', cx + 108, cy + 36);
    await frames(3);
    r = await run(`const W = window.WebSculpt;
      return { on: W.modal.on, hud: document.getElementById('modalhud').classList.contains('show'),
        canUndo: W.sculptor.history.canUndo(), errs: W.tools.edit.validate(),
        editMatches: W.tools.edit.positions[0] === W.mesh.positions[0] };`);
    ok(r.on === false, 'クリックで確定して抜ける');
    ok(r.hud === false, '確定したら HUD が消える');
    ok(r.canUndo === true, '確定が履歴に入る');
    ok(r.errs.length === 0, `確定後に構造が壊れていない (${r.errs.join(' / ')})`);
    ok(r.editMatches, '編集メッシュへ書き戻されている');
    const after = await snap();
    let kept = 0;
    for (let i = 0; i < 6; i++) if (Math.abs(after.p[i] - before.p[i]) > 1e-6) kept++;
    ok(kept > 0, `確定した動きが残る (${kept}/6 成分)`);
  }

  // Esc で取り消すと**ビット単位で**元に戻る
  {
    const before = await snap();
    await mouse('mouseMoved', cx, cy);
    await key('KeyG', 'g');
    for (let k = 1; k <= 5; k++) {
      await mouse('mouseMoved', cx - k * 20, cy - k * 12);
      await frames(1);
    }
    const during = await snap();
    let moved = 0;
    for (let i = 0; i < 6; i++) if (during.p[i] !== before.p[i]) moved++;
    ok(moved > 0, `取り消す前に動いている (${moved}/6 成分)`);
    await key('Escape', 'Escape');
    await frames(3);
    const after = await snap();
    let same = 0;
    for (let i = 0; i < 6; i++) if (after.p[i] === before.p[i]) same++;
    r = await run(`return { on: window.WebSculpt.modal.on };`);
    ok(r.on === false, 'Esc で抜ける');
    ok(same === 6, `Esc で元の座標へ完全に戻る (${same}/6 成分が一致)`);
  }

  // 右クリックでも取り消せる
  {
    const before = await snap();
    await mouse('mouseMoved', cx, cy);
    await key('KeyG', 'g');
    await mouse('mouseMoved', cx + 60, cy + 40);
    await frames(2);
    await mouse('mousePressed', cx + 60, cy + 40, { button: 'right', buttons: 2 });
    await mouse('mouseReleased', cx + 60, cy + 40, { button: 'right', buttons: 0 });
    await frames(3);
    const after = await snap();
    let same = 0;
    for (let i = 0; i < 6; i++) if (after.p[i] === before.p[i]) same++;
    r = await run(`return { on: window.WebSculpt.modal.on };`);
    ok(r.on === false && same === 6, `右クリックで取り消せる (on=${r.on} / 一致 ${same}/6)`);
  }

  // X / Y / Z で軸に固定できる（その軸しか動かない）
  {
    await mouse('mouseMoved', cx, cy);
    const before = await snap();
    await key('KeyG', 'g');
    await key('KeyX', 'x');
    r = await run(`const W = window.WebSculpt;
      return { axis: W.modal.axis, hud: document.getElementById('modalhud').textContent };`);
    ok(r.axis === 0, `X で X 軸固定になる (${r.axis})`);
    ok(/X 軸/.test(r.hud), `HUD に軸が出る (${r.hud.slice(0, 24)})`);
    for (let k = 1; k <= 6; k++) {
      await mouse('mouseMoved', cx + k * 22, cy + k * 14);
      await frames(1);
    }
    const during = await snap();
    const dx = Math.abs(during.p[0] - before.p[0]);
    const dy = Math.abs(during.p[1] - before.p[1]);
    const dz = Math.abs(during.p[2] - before.p[2]);
    ok(dx > 1e-5, `X 軸固定で X は動く (${dx.toExponential(2)})`);
    ok(dy < 1e-6 && dz < 1e-6,
      `X 軸固定で Y / Z は動かない (${dy.toExponential(2)} / ${dz.toExponential(2)})`);
    // 同じキーをもう一度で自由に戻る
    await key('KeyX', 'x');
    r = await run(`return { axis: window.WebSculpt.modal.axis };`);
    ok(r.axis === -1, `X をもう一度押すと自由に戻る (${r.axis})`);
    await key('Escape', 'Escape');
    await frames(2);
  }

  // R / S も動く。変形中に押し替えられる
  {
    await mouse('mouseMoved', cx + 40, cy + 40);
    const before = await snap();
    await key('KeyR', 'r');
    r = await run(`return { on: window.WebSculpt.modal.on, op: window.WebSculpt.modal.op };`);
    ok(r.on && r.op === 'rotate', `R で回転に入る (${r.op})`);
    for (let k = 1; k <= 6; k++) {
      await mouse('mouseMoved', cx + 40 + k * 16, cy + 40 - k * 10);
      await frames(1);
    }
    let during = await snap();
    let moved = 0;
    for (let i = 0; i < 6; i++) if (Math.abs(during.p[i] - before.p[i]) > 1e-6) moved++;
    ok(moved > 0, `回転で座標が動く (${moved}/6 成分)`);
    // 変形中に S へ乗り換える
    await key('KeyS', 's');
    r = await run(`return { op: window.WebSculpt.modal.op, axis: window.WebSculpt.modal.axis };`);
    ok(r.op === 'scale' && r.axis === -1, `変形中に S で拡大縮小へ乗り換える (${r.op})`);
    for (let k = 1; k <= 4; k++) {
      await mouse('mouseMoved', cx + 40 + k * 24, cy + 40);
      await frames(1);
    }
    during = await snap();
    r = await run(`return { hud: document.getElementById('modalhud').textContent };`);
    ok(/拡大縮小/.test(r.hud), `HUD が乗り換えに追従する (${r.hud.slice(0, 16)})`);
    await key('Escape', 'Escape');
    await frames(2);
    const after = await snap();
    let same = 0;
    for (let i = 0; i < 6; i++) if (after.p[i] === before.p[i]) same++;
    ok(same === 6, `乗り換えたあとの Esc でも最初の座標へ戻る (${same}/6)`);
  }

  // 選択が空なら何も始まらない
  {
    await run(`window.WebSculpt.tools.editSelect('none'); return 1;`);
    await key('KeyG', 'g');
    r = await run(`return { on: window.WebSculpt.modal.on };`);
    ok(r.on === false, '選択が無いときは変形に入らない');
    await run(`window.WebSculpt.tools.editSelect('all'); return 1;`);
  }

  // Shift+G は従来のギズモ（ハンドルを掴む方式）
  await key('KeyG', 'G', MOD.shift);
  await frames(3);
  r = await run(`const W = window.WebSculpt, g = W.tools.gizmo;
    return { only: g.only, active: g.active, transpose: W.state.transposeMode,
      kinds: [...new Set(g.handles(1).map(x => x.kind))].sort(), modal: W.modal.on };`);
  ok(r.active === true && r.transpose === true, 'Shift+G でギズモが立つ');
  ok(r.modal === false, 'Shift+G はモーダル変形ではない');
  ok(r.kinds.length >= 4, `Shift+G は全部のハンドルを出す (${r.kinds.join(',')})`);
  await run(`window.WebSculpt.app.setTranspose(false); return 1;`);
  await frames(2);

  // --- マウスの割り当てがモードで変わる ------------------------------------
  head('マウスの割り当て');
  // モデリング: 中ドラッグ = 視点回転
  await run(`const W = window.WebSculpt;
    W.app.setTranspose(false);
    return 1;`);
  const camBefore = await run(`const c = window.WebSculpt.camera; return { yaw: c.yaw, pitch: c.pitch,
    tx: c.target[0], ty: c.target[1] };`);
  await mouse('mouseMoved', cx, cy);
  await mouse('mousePressed', cx, cy, { button: 'middle', buttons: 4 });
  r = await run(`return { ptr: window.WebSculpt.pointer.mode };`);
  ok(r.ptr === 'orbit', `モデリングの中ドラッグは視点回転 (${r.ptr})`);
  for (let k = 1; k <= 6; k++) {
    await mouse('mouseMoved', cx + k * 14, cy, { button: 'middle', buttons: 4, dragging: true });
    await frames(1);
  }
  await mouse('mouseReleased', cx + 84, cy, { button: 'middle', buttons: 0 });
  await frames(3);
  let cam = await run(`const c = window.WebSculpt.camera; return { yaw: c.yaw, pitch: c.pitch,
    tx: c.target[0], ty: c.target[1] };`);
  ok(Math.abs(cam.yaw - camBefore.yaw) > 1e-4, `中ドラッグで視点が回った (yaw ${camBefore.yaw.toFixed(3)} → ${cam.yaw.toFixed(3)})`);

  // モデリング: Shift+中ドラッグ = 平行移動
  await mouse('mousePressed', cx, cy, { button: 'middle', buttons: 4, modifiers: MOD.shift });
  r = await run(`return { ptr: window.WebSculpt.pointer.mode };`);
  ok(r.ptr === 'pan', `モデリングの Shift+中ドラッグは平行移動 (${r.ptr})`);
  await mouse('mouseReleased', cx, cy, { button: 'middle', buttons: 0, modifiers: MOD.shift });

  // スカルプト: 中ドラッグ = 平行移動
  await run(`const W = window.WebSculpt; W.app.setMode('sculpt'); return 1;`);
  await frames(4);
  await mouse('mousePressed', cx, cy, { button: 'middle', buttons: 4 });
  r = await run(`return { ptr: window.WebSculpt.pointer.mode };`);
  ok(r.ptr === 'pan', `スカルプトの中ドラッグは平行移動 (${r.ptr})`);
  await mouse('mouseReleased', cx, cy, { button: 'middle', buttons: 0 });

  // スカルプト: 左ドラッグはモデルの上なら彫る
  await mouse('mouseMoved', cx, cy);
  await frames(4);
  await mouse('mousePressed', cx, cy);
  r = await run(`return { ptr: window.WebSculpt.pointer.mode };`);
  ok(r.ptr === 'sculpt', `スカルプトの左ドラッグは彫る (${r.ptr})`);
  await mouse('mouseReleased', cx, cy);
  await frames(3);

  // モデリング: 左ドラッグは選択
  await run(`const W = window.WebSculpt; W.app.setMode('model'); return 1;`);
  await frames(4);
  await mouse('mouseMoved', cx, cy);
  await frames(3);
  await mouse('mousePressed', cx, cy);
  r = await run(`return { ptr: window.WebSculpt.pointer.mode };`);
  ok(r.ptr === 'editbox', `モデリングの左ドラッグは選択 (${r.ptr})`);
  await mouse('mouseReleased', cx, cy);
  await frames(3);

  // --- Alt+クリックでエッジループ ------------------------------------------
  head('Alt+クリックでエッジループ / Ctrl+Alt+クリックでエッジリング');
  await run(`const W = window.WebSculpt;
    W.app.setMode('sculpt');
    W.app.newMesh('cube');
    W.app.setMode('model');
    W.app.editSetSelectMode('edge');
    W.tools.editSelect('none');
    return 1;`);
  await frames(4);
  await mouse('mouseMoved', cx + 30, cy + 20);
  await frames(4);
  await mouse('mousePressed', cx + 30, cy + 20);
  await mouse('mouseReleased', cx + 30, cy + 20);
  await frames(3);
  const plain = await run(`return window.WebSculpt.tools.editInfo().sel;`);
  await run(`window.WebSculpt.tools.editSelect('none'); return 1;`);
  await mouse('mousePressed', cx + 30, cy + 20, { modifiers: MOD.alt });
  await mouse('mouseReleased', cx + 30, cy + 20, { modifiers: MOD.alt });
  await frames(3);
  const loop = await run(`return window.WebSculpt.tools.editInfo().sel;`);
  ok(plain.edges === 1, `ふつうのクリックは辺 1 本 (${plain.edges})`);
  ok(loop.edges > plain.edges, `Alt+クリックでループへ伸びる (${plain.edges} → ${loop.edges})`);

  await run(`window.WebSculpt.tools.editSelect('none'); return 1;`);
  await mouse('mousePressed', cx + 30, cy + 20, { modifiers: MOD.alt | MOD.ctrl });
  await mouse('mouseReleased', cx + 30, cy + 20, { modifiers: MOD.alt | MOD.ctrl });
  await frames(3);
  const ring = await run(`return window.WebSculpt.tools.editInfo().sel;`);
  ok(ring.edges > 1, `Ctrl+Alt+クリックでリングへ伸びる (${ring.edges})`);

  // --- 右パネルのタブ -------------------------------------------------------
  head('右パネルのタブ');
  {
    r = await run(`const W = window.WebSculpt;
      const bar = document.querySelector('.tabbar');
      const tabs = [...document.querySelectorAll('.tab')];
      const pages = [...document.querySelectorAll('.tabpage')];
      return {
        n: tabs.length, labels: tabs.map(t => t.textContent),
        overflow: bar.scrollWidth > bar.clientWidth + 1,
        clipped: tabs.some(t => t.scrollWidth > t.clientWidth + 1),
        shown: pages.filter(p => p.classList.contains('show')).length,
        empty: pages.filter(p => p.querySelectorAll('.sec-head').length === 0).length,
        cur: W.ui.currentTab(),
        secs: pages.map(p => [...p.querySelectorAll('.sec-head')].length),
      };`);
    ok(r.n === 6, `タブが 6 つある (${r.n}: ${r.labels.join('/')})`);
    ok(!r.overflow, 'タブが横に溢れていない');
    ok(!r.clipped, 'タブの文字が切れていない');
    ok(r.shown === 1, `見えているページはいつも 1 つ (${r.shown})`);
    ok(r.empty === 0, `空のタブが無い (${r.empty})`);
    ok(Math.max(...r.secs) <= 8, `1 タブに詰め込みすぎていない (最大 ${Math.max(...r.secs)} 節)`);
    console.log(`       節の配分: ${r.secs.join(' / ')}（合計 ${r.secs.reduce((a, b) => a + b, 0)}）`);

    // モードを切り替えるとそのモードのタブへ移る
    await run(`window.WebSculpt.app.setMode('sculpt'); return 1;`);
    await frames(3);
    r = await run(`return { cur: window.WebSculpt.ui.currentTab() };`);
    ok(r.cur === 'sculpt', `スカルプトへ入ると〔彫る〕タブへ移る (${r.cur})`);
    await key('Tab', 'Tab');
    await frames(4);
    r = await run(`const W = window.WebSculpt;
      const page = [...document.querySelectorAll('.tabpage')].find(p => p.classList.contains('show'));
      return { cur: W.ui.currentTab(), mode: W.state.mode,
        secs: [...page.querySelectorAll('.sec-head')].map(s => s.textContent.replace('▾','').trim()) };`);
    ok(r.mode === 'model' && r.cur === 'model',
      `モデリングへ入ると〔モデル〕タブへ移る (${r.cur})`);
    ok(r.secs.includes('ポリゴンモデリング'), `見えているのがモデリングの節 (${r.secs.join(',')})`);

    // タブを手で切り替えられる
    await run(`window.WebSculpt.ui.setTab('view'); return 1;`);
    await frames(2);
    r = await run(`const page = [...document.querySelectorAll('.tabpage')].find(p => p.classList.contains('show'));
      return { cur: window.WebSculpt.ui.currentTab(),
        first: (page.querySelector('.sec-head') || {}).textContent || '' };`);
    ok(r.cur === 'view', `タブを手で切り替えられる (${r.cur})`);
    ok(/マテリアル/.test(r.first), `表示タブの先頭はマテリアル (${r.first.replace('▾', '').trim()})`);
    await run(`window.WebSculpt.ui.setTab('model'); return 1;`);
  }

  // --- 使い方ページがモードごとの表を出す ----------------------------------
  head('使い方ページのキー表');
  r = await run(`const W = window.WebSculpt;
    W.ui.toggleHelp();
    const sec = document.getElementById('help-keys');
    const modes = [...sec.querySelectorAll('h3.help-mode')].map(h => h.textContent);
    const rows = [...sec.querySelectorAll('tr')].map(t => t.dataset.search || '');
    W.ui.closeHelp();
    return { modes, hasTab: rows.some(s => /tab/.test(s)),
      hasModelInset: rows.some(s => /モデリング/.test(s) && /インセット/.test(s)),
      hasSculptBrush: rows.some(s => /スカルプト/.test(s) && /ブラシ/.test(s)),
      altClick: rows.some(s => /alt\\+クリック/.test(s)) };`);
  ok(r.modes.length === 3, `モードの見出しが 3 つ出る (${r.modes.length}: ${r.modes.join(' / ')})`);
  ok(r.hasTab, 'Tab が表に出ている');
  ok(r.hasModelInset, 'モデリングの表にインセットが出ている');
  ok(r.hasSculptBrush, 'スカルプトの表にブラシが出ている');
  ok(r.altClick, 'Alt+クリックが表に出ている');

  // --- 最後にスカルプトへ戻して壊れていないこと ----------------------------
  await run(`const W = window.WebSculpt; W.app.setMode('sculpt'); return 1;`);
  await frames(4);
  r = await run(`const W = window.WebSculpt;
    return { mode: W.state.mode, edit: !!W.tools.edit, tris: W.mesh.liveTris,
      only: W.tools.gizmo.only };`);
  ok(r.mode === 'sculpt' && !r.edit, 'スカルプトへ戻れる');
  ok(r.tris > 0, `形が残っている (${r.tris} 三角形)`);
  ok(r.only === null, 'ハンドルの絞り込みが持ち越されない');

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ 2 モード体系 E2E 通過' : `\n❌ ${fails} 件の失敗`);
process.exit(fails === 0 ? 0 : 1);
