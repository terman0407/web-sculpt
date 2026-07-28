// ---------------------------------------------------------------------------
// サブツールの E2E テスト（実ブラウザ）。
//   node test/subtools-e2e.mjs
//
// データモデルは test/subtool.test.mjs で見ているので、ここは配線を見る:
// アクティブ切り替えでレンダラと sculptor の参照先が張り替わるか、
// 非アクティブなサブツールが静的スロットから描かれるか、保存と復元が通るか。
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const h = await launch('/index.html', { width: 1400, height: 950 });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.renderer && window.WebSculpt.subtools)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  await cdp.eval('new Promise(r=>setTimeout(r,700))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));
  const frames = (n = 3) => cdp.eval(
    `new Promise(r=>{let i=0;const t=()=>{if(++i>=${n})r(1);else requestAnimationFrame(t)};requestAnimationFrame(t)})`);

  // UI
  let r = await run(`return {
    secs: [...document.querySelectorAll('#rightPanel .sec-head')].map(h => h.textContent.replace('▾','').trim()),
    rows: document.querySelectorAll('#rightPanel .listbox .lrow').length,
    count: window.WebSculpt.subtools.count,
  };`);
  ok(r.secs.includes('サブツール'), 'サブツールのセクションがある');
  ok(r.count === 1, `起動時は 1 個 (${r.count})`);

  // 追加
  r = await run(`const W = window.WebSculpt;
    W.app.subtoolAdd('cube');
    return { count: W.subtools.count, active: W.subtools.active,
      activeTris: W.mesh.liveTris, slots: W.renderer.drawSlots ? W.renderer.drawSlots.length : 0 };`);
  await frames(4);
  ok(r.count === 2 && r.active === 1, `追加してアクティブが移る (${r.count} 個 / active ${r.active})`);
  r = await run(`const W = window.WebSculpt;
    return { slots: W.renderer.drawSlots ? W.renderer.drawSlots.length : 0,
      slotCount: W.renderer.drawSlots && W.renderer.drawSlots[0] ? W.renderer.drawSlots[0].count : 0,
      statics: W.renderer.staticSlots.size };`);
  ok(r.slots === 1 && r.slotCount > 0,
    `非アクティブが静的スロットから描かれる (${r.slots} スロット / ${r.slotCount} インデックス)`);

  // アクティブ切り替えで sculptor の参照先も変わる
  r = await run(`const W = window.WebSculpt;
    const m1 = W.mesh;
    W.app.subtoolSelect(0);
    const m0 = W.mesh;
    return { same: m0 === m1, sculptorMesh: W.sculptor.mesh === m0,
      toolsMesh: W.tools.mesh === m0, active: W.subtools.active,
      statics: W.renderer.staticSlots.size };`);
  ok(!r.same, '切り替えでメッシュが変わる');
  ok(r.sculptorMesh && r.toolsMesh, 'sculptor と tools の参照先も張り替わる');

  // 切り替えた側を彫っても、もう一方は変わらない
  r = await run(`const W = window.WebSculpt;
    W.state.dynTopo = false; W.state.symmetry.x = false; W.state.backfaceMask = false;
    W.state.worldRadius = 0.3; W.state.strength = 0.9;
    const other = W.subtools.list[1].mesh;
    const otherBefore = other.positions.slice(0, other.nv * 3);
    const pt = new Float32Array([1, 0, 0]);
    W.sculptor.beginStroke('clay', pt, 1);
    for (let k = 1; k <= 8; k++) { pt.set([Math.cos(k*0.06), Math.sin(k*0.06)*0.3, 0.25]); W.sculptor.addSample(pt); }
    W.sculptor.endStroke();
    let dOther = 0;
    for (let i = 0; i < otherBefore.length; i++) dOther += Math.abs(other.positions[i] - otherBefore[i]);
    return { dOther, activeVerts: W.mesh.liveVerts };`);
  ok(r.dOther === 0, `非アクティブなサブツールは彫刻されない (変位 ${r.dOther})`);

  // 表示切替とソロ
  r = await run(`const W = window.WebSculpt;
    W.app.subtoolSetVisible(1, false);
    const a = W.renderer.drawSlots ? W.renderer.drawSlots.length : 0;
    W.app.subtoolSetVisible(1, true);
    const b = W.renderer.drawSlots ? W.renderer.drawSlots.length : 0;
    W.app.subtoolSetSolo(true);
    const c = W.renderer.drawSlots ? W.renderer.drawSlots.length : 0;
    W.app.subtoolSetSolo(false);
    return { hidden: a, shown: b, solo: c };`);
  ok(r.hidden === 0 && r.shown === 1 && r.solo === 0,
    `表示切替とソロが効く (非表示 ${r.hidden} / 表示 ${r.shown} / ソロ ${r.solo})`);

  // まとめる → 1 個になり両方の形が残る
  r = await run(`const W = window.WebSculpt;
    const cm = W.subtools.list[1].mesh;
    for (let v = 0; v < cm.nv; v++) cm.positions[v*3] += 3;
    cm.geomVersion++;
    const t0 = W.subtools.list[0].mesh.liveTris, t1 = cm.liveTris;
    W.app.subtoolMerge();
    const m = W.mesh;
    let minX = Infinity, maxX = -Infinity;
    for (let v = 0; v < m.nv; v++) { if (!m.vAlive[v]) continue; const x = m.positions[v*3];
      if (x < minX) minX = x; if (x > maxX) maxX = x; }
    return { count: W.subtools.count, tris: m.liveTris, want: t0 + t1, minX, maxX,
      slots: W.renderer.drawSlots ? W.renderer.drawSlots.length : 0 };`);
  ok(r.count === 1, `まとめて 1 個になる (${r.count})`);
  ok(r.tris === r.want, `面数が合計になる (${r.tris} / ${r.want})`);
  ok(r.minX < -0.5 && r.maxX > 3.0, `両方の形が残る (x ∈ [${r.minX.toFixed(2)}, ${r.maxX.toFixed(2)}])`);
  ok(r.slots === 0, '静的スロットが片付く');

  // 塊で分ける
  r = await run(`const W = window.WebSculpt;
    W.app.subtoolSplitParts();
    return { count: W.subtools.count, tris: W.subtools.list.map(t => t.mesh.liveTris) };`);
  ok(r.count === 2, `塊で 2 個に分かれる (${r.count})`);

  // 保存 → 読み込みで復元される
  r = await run(`const W = window.WebSculpt;
    return { names: W.subtools.list.map(t => t.name), count: W.subtools.count,
      tris: W.subtools.list.map(t => t.mesh.liveTris) };`);
  const before = r;
  await cdp.eval(`window.WebSculpt.app.saveProject('subtool-test')`);
  await cdp.eval('new Promise(r=>setTimeout(r,900))');
  await cdp.eval(`window.WebSculpt.app.newMesh('sphere')`);
  await frames(3);
  r = await run(`return { count: window.WebSculpt.subtools.count };`);
  ok(r.count === 1, `新規作成でサブツールが 1 個に戻る (${r.count})`);
  await cdp.eval(`window.WebSculpt.app.loadProject('subtool-test')`);
  await cdp.eval('new Promise(r=>setTimeout(r,1200))');
  r = await run(`const W = window.WebSculpt;
    return { count: W.subtools.count, names: W.subtools.list.map(t => t.name),
      tris: W.subtools.list.map(t => t.mesh.liveTris) };`);
  ok(r.count === before.count, `読み込みでサブツール数が戻る (${before.count} → ${r.count})`);
  ok(JSON.stringify(r.tris) === JSON.stringify(before.tris),
    `面数も戻る (${before.tris.join(',')} → ${r.tris.join(',')})`);
  await cdp.eval(`window.WebSculpt.app.deleteProject && window.WebSculpt.app.deleteProject('subtool-test')`);

  await frames(4);
  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ サブツール E2E 通過' : '\n❌ ' + fails + ' 件の失敗');
process.exit(fails === 0 ? 0 : 1);
