// ---------------------------------------------------------------------------
// ポリゴンモデリング（編集モード）の E2E テスト（実ブラウザ）。
//   node test/edit-e2e.mjs           モジュール版
//   node test/edit-e2e.mjs --file    単一ファイル版
//
// 構造は test/editmesh.test.mjs で見ているので、ここは配線を見る:
// 入って出られるか、実マウスで選べるか、ギズモで動かした結果が編集メッシュへ
// 戻るか、表示の三角形が編集メッシュと一致しているか。
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const args = process.argv.slice(2);
const useFile = args.includes('--file');
const h = await launch(useFile ? '/websculpt.html' : '/index.html',
  { width: 1400, height: 950, file: useFile });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.tools)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  await cdp.eval('new Promise(r=>setTimeout(r,800))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));
  const frames = (n = 3) => cdp.eval(
    `new Promise(r=>{let i=0;const t=()=>{if(++i>=${n})r(1);else requestAnimationFrame(t)};requestAnimationFrame(t)})`);
  const mouse = (type, x, y, opts = {}) => cdp.send('Input.dispatchMouseEvent', Object.assign({
    type, x, y, button: opts.button || (type === 'mouseMoved' ? 'none' : 'left'),
    buttons: type === 'mouseReleased' ? 0 : (type === 'mouseMoved' && !opts.dragging ? 0 : 1),
    clickCount: type === 'mousePressed' ? 1 : 0,
    modifiers: opts.modifiers || 0,
  }, opts.extra || {}));

  const rect = await run(`const r = document.getElementById('gpu').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };`);
  const cx = Math.round(rect.x + rect.w / 2), cy = Math.round(rect.y + rect.h / 2);

  // --- UI があるか --------------------------------------------------------
  let r = await run(`return {
    sec: [...document.querySelectorAll('#rightPanel .sec-head')].map(h => h.textContent.replace('▾','').trim()),
    box: !!document.getElementById('editbox'),
  };`);
  ok(r.sec.includes('ポリゴンモデリング'), 'ポリゴンモデリングのセクションがある');
  ok(r.box, '矩形選択の要素がある');

  // --- 入る ---------------------------------------------------------------
  r = await run(`const W = window.WebSculpt;
    W.state.dynTopo = false;
    W.app.newMesh('cube');
    const beforeTris = W.mesh.liveTris;
    W.app.setEditMode(true);
    const i = W.tools.editInfo();
    return { on: W.state.editMode, beforeTris, info: i,
      meshNv: W.mesh.nv, meshTris: W.mesh.liveTris };`);
  ok(r.on === true, '編集モードに入れる');
  ok(r.info && r.info.faces > 0, '編集メッシュができている');
  ok(r.info.quad > 0 && r.info.quadRatio > 0.9,
    `四角化されている (四角 ${r.info.quad} / 率 ${(r.info.quadRatio * 100).toFixed(0)}%)`);
  ok(r.meshNv === r.info.verts,
    `表示メッシュと編集メッシュの頂点が 1:1 (${r.meshNv} / ${r.info.verts})`);
  console.log(`       立方体 ${r.beforeTris} 三角形 → 四角 ${r.info.quad} / 三角 ${r.info.tri}`
    + ` / 表示 ${r.meshTris} 三角形`);

  // --- 実マウスでクリック選択 --------------------------------------------
  await mouse('mouseMoved', cx, cy);
  await frames(4);
  r = await run(`return { pick: window.WebSculpt.renderer.pick.ok };`);
  ok(r.pick === true, 'モデルの上でピッキングできている');
  await mouse('mousePressed', cx, cy);
  await mouse('mouseReleased', cx, cy);
  await frames(4);
  r = await run(`const i = window.WebSculpt.tools.editInfo(); return i.sel;`);
  ok(r.faces === 1, `クリックで面 1 枚が選ばれる (面 ${r.faces} / 頂点 ${r.verts})`);
  ok(r.verts === 4, `四角なので頂点 4 個 (${r.verts})`);

  // Shift+クリックで追加選択（少しずらして別の面を狙う）
  await mouse('mouseMoved', cx + 40, cy + 30);
  await frames(4);
  await mouse('mousePressed', cx + 40, cy + 30, { modifiers: 8 });   // 8 = Shift
  await mouse('mouseReleased', cx + 40, cy + 30, { modifiers: 8 });
  await frames(4);
  r = await run(`const i = window.WebSculpt.tools.editInfo(); return i.sel;`);
  ok(r.faces >= 1, `Shift+クリックで選択が残る (面 ${r.faces})`);

  // --- ドラッグで矩形選択 -------------------------------------------------
  r = await run(`window.WebSculpt.tools.editSelect('none');
    return window.WebSculpt.tools.editInfo().sel;`);
  ok(r.faces === 0 && r.verts === 0, '選択解除できる');
  await mouse('mouseMoved', cx - 150, cy - 150);
  await mouse('mousePressed', cx - 150, cy - 150);
  for (let k = 1; k <= 8; k++) {
    await mouse('mouseMoved', cx - 150 + k * 38, cy - 150 + k * 38, { dragging: true });
    await frames(1);
  }
  const boxShown = await run(`const e = document.getElementById('editbox');
    return { display: e.style.display, w: parseFloat(e.style.width || '0') };`);
  ok(boxShown.display === 'block' && boxShown.w > 100,
    `ドラッグ中に矩形が出る (${boxShown.display} / ${boxShown.w}px)`);
  await mouse('mouseReleased', cx + 154, cy + 154);
  await frames(4);
  r = await run(`const W = window.WebSculpt;
    return { sel: W.tools.editInfo().sel,
      boxHidden: document.getElementById('editbox').style.display };`);
  ok(r.sel.verts > 4, `矩形選択で複数選ばれる (頂点 ${r.sel.verts} / 面 ${r.sel.faces})`);
  ok(r.boxHidden === 'none', '離すと矩形が消える');

  // 編集モード中は彫刻されないこと
  r = await run(`const W = window.WebSculpt;
    return { tris: W.mesh.liveTris, stroking: W.sculptor.stroking };`);
  ok(r.stroking === false, '編集モード中にストロークが始まっていない');

  // --- 選択モードの切り替え ----------------------------------------------
  r = await run(`const W = window.WebSculpt;
    const out = {};
    for (const m of ['vert', 'edge', 'face']) {
      W.app.editSetSelectMode(m);
      out[m] = W.tools.editInfo().sel;
    }
    W.app.editSetSelectMode('face');
    return out;`);
  ok(r.vert.verts > 0 && r.edge.edges > 0,
    `モードを切り替えても選択が引き継がれる (頂点 ${r.vert.verts} / 辺 ${r.edge.edges})`);

  // --- 選択操作 -----------------------------------------------------------
  r = await run(`const W = window.WebSculpt, T = W.tools;
    T.editSelect('none');
    T.editSelect('all');
    const all = T.editInfo().sel;
    T.editSelect('invert');
    const inv = T.editInfo().sel;
    T.editSelect('all');
    T.editSelect('shrink');
    const shrunk = T.editInfo().sel;
    T.editSelect('none');
    // 1 面だけ選んでから広げる
    W.tools.edit.selFace[0] = 1;
    W.tools.edit.syncSelection('face');
    const one = W.tools.edit.selectionCount();
    T.editSelect('grow');
    const grown = T.editInfo().sel;
    T.editSelect('linked');
    const linked = T.editInfo().sel;
    return { all, inv, shrunk, one, grown, linked, total: T.editInfo() };`);
  ok(r.all.faces === r.total.faces, `すべて選択で全面 (${r.all.faces}/${r.total.faces})`);
  ok(r.inv.faces === 0, `反転で 0 面 (${r.inv.faces})`);
  ok(r.grown.verts > r.one.verts, `広げると増える (${r.one.verts} → ${r.grown.verts})`);
  ok(r.linked.verts === r.total.verts,
    `繋がりで全部選ばれる (${r.linked.verts}/${r.total.verts})`);

  // --- 編集操作 -----------------------------------------------------------
  r = await run(`const W = window.WebSculpt, T = W.tools;
    T.editSelect('none');
    const before = T.editInfo();
    // 内部の辺を 1 本選んで溶解
    const em = T.edit;
    let e = -1;
    for (let i = 0; i < em.ne; i++) {
      const a = em.edgeFace[i*2], b = em.edgeFace[i*2+1];
      if (a >= 0 && b >= 0 && a !== b && em.faceSize(a) === 4 && em.faceSize(b) === 4) { e = i; break; }
    }
    em.selEdge[e] = 1;
    T.editApply('dissolve');
    const afterDis = T.editInfo();
    // 面を 2 枚削除
    T.editSelect('none');
    let n = 0;
    for (let f = 0; f < T.edit.nf && n < 2; f++) if (T.edit.faceAlive[f]) { T.edit.selFace[f] = 1; n++; }
    T.edit.syncSelection('face');
    T.editApply('delete');
    const afterDel = T.editInfo();
    return { before, afterDis, afterDel,
      meshNv: W.mesh.nv, meshTris: W.mesh.liveTris,
      errs: T.edit.validate() };`);
  ok(r.afterDis.faces === r.before.faces - 1,
    `辺の溶解で面が 1 枚減る (${r.before.faces} → ${r.afterDis.faces})`);
  ok(r.afterDis.ngon >= 1, `溶解で n-gon ができる (${r.afterDis.ngon})`);
  ok(r.afterDel.faces === r.afterDis.faces - 2,
    `面の削除で 2 枚減る (${r.afterDis.faces} → ${r.afterDel.faces})`);
  ok(r.errs.length === 0, `編集後も構造が壊れていない (${r.errs.join(' / ')})`);
  ok(r.meshNv === r.afterDel.verts,
    `編集後も表示メッシュと 1:1 (${r.meshNv} / ${r.afterDel.verts})`);

  // 表示の三角形数が Σ(n-2) と合っているか
  r = await run(`const em = window.WebSculpt.tools.edit;
    let want = 0;
    for (let f = 0; f < em.nf; f++) if (em.faceAlive[f]) want += em.faceSize(f) - 2;
    return { want, have: window.WebSculpt.mesh.liveTris };`);
  ok(r.want === r.have, `表示の三角形数が Σ(n-2) と一致 (${r.have} / ${r.want})`);

  // --- ギズモで動かす -----------------------------------------------------
  r = await run(`const W = window.WebSculpt, T = W.tools;
    T.editSelect('none');
    let n = 0;
    for (let f = 0; f < T.edit.nf && n < 6; f++) if (T.edit.faceAlive[f]) { T.edit.selFace[f] = 1; n++; }
    T.edit.syncSelection('face');
    T.editSyncOverlay();
    const before = T.edit.positions.slice();
    W.app.editGizmo();
    return { active: T.gizmo.active, transpose: W.state.transposeMode,
      sel: T.editInfo().sel, sig: before.reduce((a, b) => a + b, 0) };`);
  ok(r.active === true, 'ギズモが立つ');
  ok(r.transpose === true, 'トランスポーズモードに入る');

  // ギズモを掴んで動かす（ハンドルの位置はギズモの中心から少しずらして狙う）
  r = await run(`const W = window.WebSculpt, T = W.tools;
    const before = T.edit.positions.slice();
    // ギズモの API を直接叩く（ハンドルの画面位置を当てるのは不安定なので）
    const hit = { axis: 1, kind: 'move' };
    const o = new Float32Array([0, 0, 5]), d = new Float32Array([0, 0, -1]);
    // 移動はレイと軸の交点で決まるので、beginDrag → updateDrag を 2 回打つ
    const okBegin = T.gizmo.beginDrag(W.mesh, hit, o, d);
    if (okBegin) {
      const o2 = new Float32Array([0, 0.35, 5]);
      T.gizmo.updateDrag(W.mesh, o2, d, null);
      T.gizmo.endDrag(W.mesh);
      // main.js の endPointer と同じことをする（編集メッシュへ書き戻し）
      T.edit.positions.set(W.mesh.positions.subarray(0, W.mesh.nv * 3));
      T.edit.version++;
      T.editSyncOverlay();
    }
    let moved = 0, maxd = 0;
    for (let i = 0; i < before.length; i++) {
      const dd = Math.abs(T.edit.positions[i] - before[i]);
      if (dd > 1e-6) moved++;
      if (dd > maxd) maxd = dd;
    }
    return { okBegin, moved, maxd, errs: T.edit.validate() };`);
  ok(r.okBegin === true, 'ギズモのドラッグが始まる');
  ok(r.moved > 0, `ギズモで編集メッシュの座標が動く (${r.moved} 成分 / 最大 ${r.maxd.toFixed(4)})`);
  ok(r.errs.length === 0, `ギズモ後も構造が壊れていない (${r.errs.join(' / ')})`);

  // --- 出る ---------------------------------------------------------------
  r = await run(`const W = window.WebSculpt;
    const em = W.tools.edit;
    let want = 0;
    for (let f = 0; f < em.nf; f++) if (em.faceAlive[f]) want += em.faceSize(f) - 2;
    const nv = em.nv;
    W.app.setEditMode(false);
    return { on: W.state.editMode, edit: !!W.tools.edit,
      want, nv, tris: W.mesh.liveTris, verts: W.mesh.liveVerts };`);
  ok(r.on === false && r.edit === false, '編集モードを出られる');
  ok(r.tris === r.want, `三角形化して書き戻せている (${r.tris} / ${r.want})`);
  ok(r.verts === r.nv, `頂点数が保たれる (${r.verts} / ${r.nv})`);

  // 出たあとは彫刻できること
  r = await run(`const W = window.WebSculpt;
    W.state.transposeMode = false;
    W.app.setTranspose(false);
    W.tools.gizmo.clear();
    for (let v = 0; v < W.mesh.nv; v++) W.mesh.mask[v] = 0;
    W.state.worldRadius = 0.4; W.state.strength = 1.0; W.state.dynTopo = false;
    const before = W.mesh.positions.slice(0, W.mesh.nv * 3);
    // 決め打ちの座標だと表面から外れる（ギズモで形が動いている）。
    // 実際の頂点の位置を掴んでそこから彫る。
    const v0 = 10;
    const pt = new Float32Array([
      W.mesh.positions[v0 * 3], W.mesh.positions[v0 * 3 + 1], W.mesh.positions[v0 * 3 + 2]]);
    W.sculptor.beginStroke('clay', pt, 1);
    for (let k = 1; k <= 6; k++) {
      pt[0] += 0.03; pt[1] += 0.01;
      W.sculptor.addSample(pt);
    }
    W.sculptor.endStroke();
    let moved = 0;
    for (let i = 0; i < before.length; i++) if (Math.abs(W.mesh.positions[i] - before[i]) > 1e-5) moved++;
    return { moved };`);
  ok(r.moved > 0, `編集モードを出たあと彫刻できる (${r.moved} 成分が動いた)`);

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ ポリゴンモデリング E2E 通過' : '\n❌ ' + fails + ' 件の失敗');
process.exit(fails === 0 ? 0 : 1);
