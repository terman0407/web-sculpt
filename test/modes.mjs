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

  // --- G / R / S でハンドルを絞る -------------------------------------------
  head('G / R / S でギズモのハンドルを絞る');
  await run(`const W = window.WebSculpt;
    W.app.editSetSelectMode('face');
    W.tools.editSelect('all');
    return 1;`);
  for (const [code, keyName, want] of [
    ['KeyG', 'g', 'move'], ['KeyR', 'r', 'rotate'], ['KeyS', 's', 'scale'],
  ]) {
    await key(code, keyName);
    await frames(3);
    r = await run(`const W = window.WebSculpt, g = W.tools.gizmo;
      const kinds = [...new Set(g.handles(1).map(x => x.kind))].sort();
      return { active: g.active, only: g.only, kinds, transpose: W.state.transposeMode };`);
    ok(r.active === true && r.transpose === true, `${keyName.toUpperCase()} でギズモが立つ`);
    ok(r.only === want, `${keyName.toUpperCase()} は only='${want}' になる (${r.only})`);
    const expect = want === 'scale' ? ['scale', 'uniform'] : [want];
    ok(JSON.stringify(r.kinds) === JSON.stringify(expect),
      `${keyName.toUpperCase()} は ${expect.join('/')} のハンドルだけ出す (${r.kinds.join(',')})`);
  }
  await key('KeyG', 'G', MOD.shift);
  await frames(3);
  r = await run(`const W = window.WebSculpt, g = W.tools.gizmo;
    return { only: g.only, kinds: [...new Set(g.handles(1).map(x => x.kind))].sort() };`);
  ok(r.only === null, `Shift+G は絞り込みを外す (${r.only})`);
  ok(r.kinds.length >= 4, `Shift+G は全部のハンドルを出す (${r.kinds.join(',')})`);

  // 絞っているハンドル以外は掴めない（見えないものが当たらない）
  await key('KeyG', 'g');
  await frames(3);
  r = await run(`const W = window.WebSculpt, g = W.tools.gizmo;
    // ピボットから離れた所を狙って、回転リングだけに近いレイを作る意味はないので、
    // 「only を切り替えると hitTest の答えが変わる」ことだけを見る
    const O = new Float32Array([0, 0, 6]), D = new Float32Array([0, 0, -1]);
    const withMove = g.hitTest(O, D, 0.05, 1);
    g.only = 'rotate';
    const withRot = g.hitTest(O, D, 0.05, 1);
    g.only = 'move';
    return { withMove: withMove && withMove.kind, withRot: withRot && withRot.kind };`);
  ok(r.withMove === null || r.withMove === 'move',
    `only='move' では move しか当たらない (${r.withMove})`);
  ok(r.withRot === null || r.withRot === 'rotate',
    `only='rotate' では rotate しか当たらない (${r.withRot})`);

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
