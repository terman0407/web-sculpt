// ---------------------------------------------------------------------------
// モデリング操作（エッジループ / ループカット / 押し出し / インセット / 細分化）の検証。
//   node test/editops.test.mjs
//
// この手の操作は「見た目は合っているのにトポロジが壊れている」が起きやすい。
// 毎回:
//   * オイラー標数が期待どおりか（V - E + F）
//   * 全部の辺がちょうど 2 面に共有されているか（閉じた形なら）
//   * 面の巻き方が保たれているか（法線が外を向いているか）
//   * 同じ位置に別頂点ができていないか（繋がっていないメッシュ）
// を見る。
// ---------------------------------------------------------------------------

import { EditMesh, editMeshFromSculpt } from '../js/editmesh.js';
import {
  edgeOf, edgeRing, edgeLoop, selectLoopOrRing, loopCut,
  extrudeSelectedFaces, insetSelectedFaces, insetRegion, subdivideSelectedFaces,
  bevelSelectedEdges, bridgeEdgeLoops,
} from '../js/editops.js';
import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { quadDominant } from '../js/remesh.js';

let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.log('  FAIL: ' + m); } };
const head = (t) => console.log('\n== ' + t + ' ==');

/** 単位立方体（四角 6 枚）。巻き方は外向き */
function cube() {
  const P = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ]);
  const F = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const verts = [], starts = [0];
  for (const f of F) { verts.push(...f); starts.push(verts.length); }
  const em = new EditMesh();
  em.setGeometry(P, Int32Array.from(verts), Int32Array.from(starts));
  return em;
}

/** 構造の検証。closed なら境界辺なし、chi でオイラー標数を見る */
function check(em, { closed = true, chi = 2, label = '', outward = true } = {}) {
  const errs = em.validate();
  let bnd = 0;
  for (let e = 0; e < em.ne; e++) if (em.edgeFace[e * 2 + 1] < 0) bnd++;
  if (closed && bnd) errs.push(`境界辺が ${bnd} 本`);
  if (em.nonManifold) errs.push(`非多様体辺 ${em.nonManifold} 本`);
  const st = em.faceStats();
  const c = em.nv - em.ne + st.faces;
  if (chi !== null && c !== chi) errs.push(`オイラー標数 ${c}（期待 ${chi}）`);

  // 同じ位置に別の頂点ができていないか（繋がっていないメッシュの検出）
  const seen = new Map();
  let dup = 0;
  for (let v = 0; v < em.nv; v++) {
    const k = [0, 1, 2].map(j => em.positions[v * 3 + j].toFixed(5)).join(',');
    if (seen.has(k)) dup++; else seen.set(k, v);
  }
  if (dup) errs.push(`同じ位置の頂点が ${dup} 組`);

  // 面の法線が外を向いているか（重心から見て）。閉じた凸形でだけ意味がある
  if (outward && closed) {
    const bb = em.bounds();
    const n = new Float64Array(3), ctr = new Float64Array(3);
    let inward = 0;
    for (let f = 0; f < em.nf; f++) {
      if (!em.faceAlive[f]) continue;
      em.faceNormal(f, n);
      em.faceCenter(f, ctr);
      const dx = ctr[0] - bb.center[0], dy = ctr[1] - bb.center[1], dz = ctr[2] - bb.center[2];
      if (n[0] * dx + n[1] * dy + n[2] * dz < 0) inward++;
    }
    if (inward) errs.push(`裏返った面が ${inward} 枚`);
  }

  if (errs.length) { failures++; console.log(`  FAIL ${label}: ${errs.join(' / ')}`); return false; }
  console.log(`  ok   ${label}  V=${em.nv} E=${em.ne} F=${st.faces}`
    + ` (四角 ${st.quad} / 三角 ${st.tri} / n-gon ${st.ngon}) χ=${c}`);
  return true;
}

// ---------------------------------------------------------------------------
head('エッジリングとエッジループ');
{
  const em = cube();
  // 立方体はどの辺も、4 枚の四角を跨いで一周する（閉じたリング）
  const r = edgeRing(em, 0);
  ok(r.closed, 'リングが閉じない');
  ok(r.edges.length === 4, `リングが 4 辺でない (${r.edges.length})`);
  ok(r.faces.length === 4, `リングが 4 面を跨がない (${r.faces.length})`);
  console.log(`  リング: 辺 ${r.edges.length} / 面 ${r.faces.length} / 閉 ${r.closed}`);

  // 立方体の頂点は価数 3 なので、エッジループは伸びない（自分だけ）
  const l = edgeLoop(em, 0);
  ok(l.edges.length === 1, `価数 3 でループが伸びてしまう (${l.edges.length})`);

  // 円柱を四角化すると価数 4 の頂点があり、そこはループが伸びる
  const g = PRIMITIVES.cylinder();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const em2 = editMeshFromSculpt(m, quadDominant);
  let best = 0, bestE = -1;
  for (let e = 0; e < em2.ne; e++) {
    const L = edgeLoop(em2, e);
    if (L.edges.length > best) { best = L.edges.length; bestE = e; }
  }
  ok(best > 4, `円柱でエッジループが伸びない (最長 ${best})`);
  console.log(`  円柱の最長エッジループ: ${best} 辺（辺 ${bestE} から）`);

  // リングを選択に足す
  em2.clearSelection();
  em2.selEdge[bestE] = 1;
  const sr = selectLoopOrRing(em2, 'ring');
  ok(sr.added > 0, `リング選択で増えない (${sr.added})`);
  em2.clearSelection();
  em2.selEdge[bestE] = 1;
  const sl = selectLoopOrRing(em2, 'loop');
  ok(sl.added === best - 1, `ループ選択の本数が合わない (${sl.added + 1} != ${best})`);
}

// ---------------------------------------------------------------------------
head('ループカット');
{
  // 立方体に 1 本入れる: リングは 4 面 4 辺。V+4, E+8, F+4 → χ は 2 のまま
  const em = cube();
  em.clearSelection();
  em.selEdge[0] = 1;
  const r = loopCut(em, 1);
  ok(r.faces === 4, `4 面が割られていない (${r.faces})`);
  ok(r.edges === 4, `4 辺に分割点が入っていない (${r.edges})`);
  ok(em.nv === 12, `頂点が 8+4=12 にならない (${em.nv})`);
  ok(em.liveFaces === 10, `面が 6+4=10 にならない (${em.liveFaces})`);
  check(em, { closed: true, chi: 2, label: 'ループカット 1 本' });
  // 入れた辺が選択されている（続けて動かせる）
  const sel = em.selectionCount();
  ok(sel.edges === 4, `入れた 4 辺が選択されていない (${sel.edges})`);

  // 3 本まとめて
  const em2 = cube();
  em2.clearSelection();
  em2.selEdge[0] = 1;
  const r2 = loopCut(em2, 3);
  ok(r2.cuts === 3, 'cuts が伝わっていない');
  ok(em2.nv === 8 + 4 * 3, `頂点が 8+12 にならない (${em2.nv})`);
  ok(em2.liveFaces === 6 + 4 * 3, `面が 6+12 にならない (${em2.liveFaces})`);
  check(em2, { closed: true, chi: 2, label: 'ループカット 3 本' });

  // 面を取り合う 2 リングを同時に指定したら、片方だけ通して残りは断ること。
  // 直交リングは同じ四角を共有するので、両方切るならその四角を 4 分割しないと
  // 分割点が浮いて穴が開く（実測で境界辺 12 本、χ=-2）。Blender の Ctrl+R も
  // 1 リングずつなので、断る側に倒すのが素直。
  const em3 = cube();
  em3.clearSelection();
  const ring0 = edgeRing(em3, 0);
  let other = -1;
  for (let e = 0; e < em3.ne; e++) if (!ring0.edges.includes(e)) { other = e; break; }
  em3.selEdge[0] = 1; em3.selEdge[other] = 1;
  const r3 = loopCut(em3, 1);
  ok(r3.rings === 1 && r3.refused === 1,
    `面を取り合うリングを同時に切ってしまった (通 ${r3.rings} / 断 ${r3.refused})`);
  check(em3, { closed: true, chi: 2, label: '面を取り合う 2 リング（1 つだけ通す）' });

  // 三角形だけの形はリングが張れないので断る
  {
    const g = PRIMITIVES.sphere();
    const m = new SculptMesh();
    m.setGeometry(g.positions, g.indices);
    const tri = new EditMesh();
    // 三角形のまま面にする
    const starts = [0], verts = [];
    for (let t = 0; t < m.nt; t++) {
      verts.push(m.tris[t * 3], m.tris[t * 3 + 1], m.tris[t * 3 + 2]);
      starts.push(verts.length);
    }
    tri.setGeometry(m.positions.slice(0, m.nv * 3), Int32Array.from(verts), Int32Array.from(starts));
    tri.clearSelection();
    tri.selEdge[0] = 1;
    const rt = loopCut(tri, 1);
    ok(rt.faces === 0, `三角形メッシュでループカットしてしまった (${rt.faces})`);
    ok(rt.refused > 0, '断った数が返らない');
  }
}

// ---------------------------------------------------------------------------
head('押し出し');
{
  // 1 面を押し出す: V+4, F は -1+1+4=+4, E+8 → χ は 2 のまま
  const em = cube();
  em.clearSelection();
  em.selFace[0] = 1;
  em.syncSelection('face');
  const r = extrudeSelectedFaces(em, 0.5);
  ok(r.faces === 1 && r.walls === 4, `1 面 4 壁にならない (面 ${r.faces} / 壁 ${r.walls})`);
  ok(em.nv === 12, `頂点が 8+4 にならない (${em.nv})`);
  ok(em.liveFaces === 10, `面が 6-1+1+4=10 にならない (${em.liveFaces})`);
  check(em, { closed: true, chi: 2, label: '1 面を押し出し', outward: true });
  // 押し出した面が選択されている
  ok(em.selectionCount().faces === 1, `押し出した面が選択されていない (${em.selectionCount().faces})`);
  // 実際に伸びているか
  const bb = em.bounds();
  ok(bb.max[2] - bb.min[2] > 2.4 || bb.max[1] - bb.min[1] > 2.4 || bb.max[0] - bb.min[0] > 2.4,
    `押し出しで伸びていない (${(bb.max[0] - bb.min[0]).toFixed(2)}, `
    + `${(bb.max[1] - bb.min[1]).toFixed(2)}, ${(bb.max[2] - bb.min[2]).toFixed(2)})`);

  // 隣り合う 2 面をまとめて押し出す → 共有辺には壁を張らない
  const em2 = cube();
  em2.clearSelection();
  // 辺を共有する 2 面を探す
  let fa = -1, fb = -1;
  for (let e = 0; e < em2.ne && fa < 0; e++) {
    const f0 = em2.edgeFace[e * 2], f1 = em2.edgeFace[e * 2 + 1];
    if (f0 >= 0 && f1 >= 0 && f0 !== f1) { fa = f0; fb = f1; }
  }
  em2.selFace[fa] = 1; em2.selFace[fb] = 1;
  em2.syncSelection('face');
  const r2 = extrudeSelectedFaces(em2, 0.4);
  ok(r2.walls === 6, `共有辺に壁を張ってしまった（壁 ${r2.walls}、期待 6）`);
  check(em2, { closed: true, chi: 2, label: '2 面をまとめて押し出し', outward: false });

  // 押し出しを 3 回繰り返しても壊れない
  const em3 = cube();
  em3.clearSelection();
  em3.selFace[0] = 1;
  em3.syncSelection('face');
  for (let k = 0; k < 3; k++) extrudeSelectedFaces(em3, 0.3);
  check(em3, { closed: true, chi: 2, label: '押し出し 3 回', outward: false });
}

// ---------------------------------------------------------------------------
head('インセット');
{
  const em = cube();
  em.clearSelection();
  em.selFace[0] = 1;
  em.syncSelection('face');
  const r = insetSelectedFaces(em, 0.3);
  ok(r.faces === 1 && r.verts === 4, `1 面 4 頂点にならない (${r.faces} / ${r.verts})`);
  ok(em.liveFaces === 6 - 1 + 1 + 4, `面が 10 にならない (${em.liveFaces})`);
  check(em, { closed: true, chi: 2, label: '1 面をインセット' });
  ok(em.selectionCount().faces === 1, '内側の面が選択されていない');

  // インセット → 押し出しの連携（Blender で一番よく使う流れ）
  const r2 = extrudeSelectedFaces(em, -0.4);
  ok(r2.faces === 1, 'インセット後に押し出せない');
  check(em, { closed: true, chi: 2, label: 'インセット → 押し出し（凹み）', outward: false });

  // 全面インセット
  const em2 = cube();
  em2.selectAll('face');
  insetSelectedFaces(em2, 0.25);
  check(em2, { closed: true, chi: 2, label: '全面インセット' });
}

// ---------------------------------------------------------------------------
head('面の細分化');
{
  const em = cube();
  em.selectAll('face');
  const r = subdivideSelectedFaces(em);
  ok(r.faces === 6, `6 面が細分化されない (${r.faces})`);
  // 各四角 → 4 枚。辺の中点 12 + 面の中心 6 = 18 頂点追加
  ok(em.nv === 8 + 12 + 6, `頂点が 26 にならない (${em.nv})`);
  ok(em.liveFaces === 24, `面が 24 にならない (${em.liveFaces})`);
  check(em, { closed: true, chi: 2, label: '全面を細分化' });

  // 一部だけ細分化しても、隣と中点を共有していること（穴が開かない）
  const em2 = cube();
  em2.clearSelection();
  em2.selFace[0] = 1; em2.selFace[1] = 1;
  em2.syncSelection('face');
  subdivideSelectedFaces(em2);
  // 隣の未選択面には中点が差し込まれて n-gon になる（T 字接合を作らない）
  let bnd = 0;
  for (let e = 0; e < em2.ne; e++) if (em2.edgeFace[e * 2 + 1] < 0) bnd++;
  ok(bnd === 0, `一部細分化で境界辺ができた (${bnd})`);
  ok(em2.validate().length === 0, `一部細分化で構造が壊れた (${em2.validate().join(' / ')})`);
  const st2 = em2.faceStats();
  ok(st2.ngon > 0, '隣の面が n-gon になっていない（中点が差し込まれていない）');
  const chi2 = em2.nv - em2.ne + em2.liveFaces;
  ok(chi2 === 2, `一部細分化でオイラー標数が崩れた (${chi2})`);
  console.log(`  一部細分化: V=${em2.nv} E=${em2.ne} F=${em2.liveFaces}`
    + ` (四角 ${st2.quad} / n-gon ${st2.ngon}) χ=${chi2}`);
}

// ---------------------------------------------------------------------------
head('ベベル');
{
  // 立方体の全 12 辺（どの頂点でもベベル辺が 3 本集まる）
  {
    const em = cube();
    em.selectAll('edge');
    const r = bevelSelectedEdges(em, 0.25);
    ok(r.edges === 12, `12 辺ベベルできない (${r.edges} / ${r.reason})`);
    // 各頂点が 3 分割される: 8*3 = 24 頂点
    ok(em.nv === 24, `頂点が 24 にならない (${em.nv})`);
    // 面: 元 6 + 帯 12 + 角 8 = 26
    ok(r.faces === 12, `帯が 12 枚でない (${r.faces})`);
    ok(r.corners === 8, `角の面が 8 枚でない (${r.corners})`);
    ok(em.liveFaces === 26, `面が 26 にならない (${em.liveFaces})`);
    check(em, { closed: true, chi: 2, label: '立方体の全 12 辺をベベル' });
    const st = em.faceStats();
    ok(st.tri === 8, `角が三角形 8 枚になっていない (三角 ${st.tri})`);
  }

  // 1 面のまわりの 4 辺（閉じたループ。どの頂点でもベベル辺が 2 本）
  {
    const em = cube();
    em.clearSelection();
    const s = em.faceStart[0], n = em.faceSize(0);
    for (let k = 0; k < n; k++) {
      const e = edgeOf(em, em.faceVerts[s + k], em.faceVerts[s + (k + 1) % n]);
      em.selEdge[e] = 1;
    }
    const r = bevelSelectedEdges(em, 0.2);
    ok(r.edges === 4, `4 辺ベベルできない (${r.edges} / ${r.reason})`);
    ok(r.corners === 0, `2 本しか集まらないのに角の面を張った (${r.corners})`);
    ok(em.nv === 8 + 4, `頂点が 12 にならない (${em.nv})`);
    check(em, { closed: true, chi: 2, label: '1 面のまわり 4 辺をベベル' });
  }

  // ベベル辺が 1 本しか集まらない頂点があるときは断る
  {
    const em = cube();
    em.clearSelection();
    em.selEdge[0] = 1;
    const before = { nv: em.nv, nf: em.liveFaces };
    const r = bevelSelectedEdges(em, 0.2);
    ok(r.edges === 0, `1 本だけの辺をベベルしてしまった (${r.edges})`);
    ok(/1 本しか集まらない/.test(r.reason), `理由が返らない (${r.reason})`);
    ok(em.nv === before.nv && em.liveFaces === before.nf, '断ったのに形が変わっている');
  }

  // 境界の辺は断る
  {
    const em = cube();
    em.clearSelection();
    em.selFace[0] = 1;
    em.syncSelection('face');
    em.deleteSelectedFaces();
    em.clearSelection();
    let n = 0;
    for (let e = 0; e < em.ne; e++) if (em.edgeFace[e * 2 + 1] < 0) { em.selEdge[e] = 1; n++; }
    ok(n > 0, '境界辺が見つからない');
    const r = bevelSelectedEdges(em, 0.2);
    ok(r.edges === 0, `境界辺をベベルしてしまった (${r.edges})`);
    ok(em.validate().length === 0, '断ったのに構造が変わっている');
  }

  // ベベル → 押し出し / ループカットの連携
  {
    const em = cube();
    em.selectAll('edge');
    bevelSelectedEdges(em, 0.2);
    // ベベルで張った帯が選択されている
    ok(em.selectionCount().faces > 0, 'ベベル後に帯が選択されていない');
    extrudeSelectedFaces(em, 0.1);
    check(em, { closed: true, chi: 2, label: 'ベベル → 押し出し', outward: false });
    em.clearSelection();
    // 四角の辺を 1 本選んでループカット
    for (let e = 0; e < em.ne; e++) {
      const f0 = em.edgeFace[e * 2], f1 = em.edgeFace[e * 2 + 1];
      if (f0 >= 0 && f1 >= 0 && em.faceSize(f0) === 4 && em.faceSize(f1) === 4) { em.selEdge[e] = 1; break; }
    }
    loopCut(em, 1);
    ok(em.validate().length === 0, `ベベル → ループカットで壊れた (${em.validate().join(' / ')})`);
    console.log(`  ベベル → 押し出し → ループカット: V=${em.nv} E=${em.ne} F=${em.liveFaces}`
      + ` χ=${em.nv - em.ne + em.liveFaces}`);
  }

  // 四角化した球（価数がばらつく形）でも通ること
  {
    const g = PRIMITIVES.quadball();
    const m = new SculptMesh();
    m.setGeometry(g.positions, g.indices);
    const em = editMeshFromSculpt(m, quadDominant);
    // 1 本の辺のエッジループを選んでベベルする（閉じたループなら k=2 になる）
    em.clearSelection();
    let picked = -1, best = 0;
    for (let e = 0; e < em.ne; e += 37) {
      const L = edgeLoop(em, e);
      if (L.closed && L.edges.length > best) { best = L.edges.length; picked = e; }
    }
    if (picked >= 0) {
      em.clearSelection();
      for (const e of edgeLoop(em, picked).edges) em.selEdge[e] = 1;
      const r = bevelSelectedEdges(em, 0.15);
      ok(r.edges === best, `ループ ${best} 辺をベベルできない (${r.edges} / ${r.reason})`);
      check(em, { closed: true, chi: 2, label: `quadball の閉じたループ ${best} 辺をベベル`, outward: false });
    } else {
      console.log('  quadball に閉じたエッジループが見つからず、この検査はスキップ');
    }
  }
}

// ---------------------------------------------------------------------------
head('領域インセット（Blender の I）');
{
  // 1 枚だけなら面ごとインセットと同じ結果
  {
    const a = cube(), b = cube();
    a.clearSelection(); a.selFace[0] = 1; a.syncSelection('face');
    b.clearSelection(); b.selFace[0] = 1; b.syncSelection('face');
    insetRegion(a, 0.3);
    insetSelectedFaces(b, 0.3);
    ok(a.nv === b.nv && a.ne === b.ne && a.liveFaces === b.liveFaces,
      `1 枚のとき面ごとインセットと違う (${a.nv}/${a.ne}/${a.liveFaces}`
      + ` vs ${b.nv}/${b.ne}/${b.liveFaces})`);
    check(a, { closed: true, chi: 2, label: '1 面を領域インセット' });
  }

  // 隣り合う 2 枚: 境目に帯を作らない（面ごとインセットとの違い）
  {
    const em = cube();
    em.clearSelection();
    // 辺を共有する 2 枚を選ぶ
    const e = 0, f0 = em.edgeFace[0], f1 = em.edgeFace[1];
    ok(f0 >= 0 && f1 >= 0, '共有辺が見つからない');
    em.selFace[f0] = 1; em.selFace[f1] = 1;
    em.syncSelection('face');
    const r = insetRegion(em, 0.3);
    ok(r.faces === 2, `2 面を処理していない (${r.faces})`);
    ok(r.band === 6, `帯が 6 枚にならない (${r.band})`);   // 2 枚の輪郭は 6 辺
    ok(em.liveFaces === 12, `面が 4+2+6=12 にならない (${em.liveFaces})`);
    // 縮めた 2 枚がまだ辺を共有している（境目に帯が挟まっていない）
    let sharedInner = 0;
    for (let x = 0; x < em.ne; x++) {
      const g0 = em.edgeFace[x * 2], g1 = em.edgeFace[x * 2 + 1];
      if (g0 >= 0 && g1 >= 0 && em.selFace[g0] && em.selFace[g1]) sharedInner++;
    }
    ok(sharedInner === 1, `縮めた 2 枚が辺を共有していない (${sharedInner})`);
    check(em, { closed: true, chi: 2, label: '隣り合う 2 面を領域インセット' });

    const per = cube();
    per.clearSelection();
    per.selFace[f0] = 1; per.selFace[f1] = 1;
    per.syncSelection('face');
    insetSelectedFaces(per, 0.3);
    ok(per.liveFaces === 14, `面ごとインセットは 14 面のはず (${per.liveFaces})`);
    ok(em.liveFaces < per.liveFaces, '領域インセットが面ごとと同じ面数になっている');
  }

  // 縁が無い（全部選んだ）ときは断る
  {
    const em = cube();
    em.selectAll('face');
    const before = { nv: em.nv, nf: em.liveFaces };
    const r = insetRegion(em, 0.3);
    ok(r.faces === 0, `縁が無いのにインセットしてしまった (${r.faces})`);
    ok(/縁がありません/.test(r.reason), `理由が返らない (${r.reason})`);
    ok(em.nv === before.nv && em.liveFaces === before.nf, '断ったのに形が変わっている');
  }

  // 領域インセット → 内側へ押し出し（凹み）
  {
    const em = cube();
    em.clearSelection();
    em.selFace[em.edgeFace[0]] = 1; em.selFace[em.edgeFace[1]] = 1;
    em.syncSelection('face');
    insetRegion(em, 0.35);
    extrudeSelectedFaces(em, -0.3);
    check(em, { closed: true, chi: 2, label: '領域インセット → 内側へ押し出し', outward: false });
  }

  // 頂点だけで触れ合う 2 枚（砂時計形）でも非多様体にならない
  {
    const em = cube();
    em.selectAll('face');
    subdivideSelectedFaces(em);          // 24 枚の四角にする
    em.clearSelection();
    // 頂点を 1 個だけ共有する 2 枚を探す
    let pa = -1, pb = -1;
    for (let f = 0; f < em.nf && pa < 0; f++) {
      if (!em.faceAlive[f]) continue;
      const vs = new Set();
      for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) vs.add(em.faceVerts[i]);
      for (let g = 0; g < em.nf; g++) {
        if (g === f || !em.faceAlive[g]) continue;
        let sharedN = 0;
        for (let i = em.faceStart[g]; i < em.faceStart[g + 1]; i++) if (vs.has(em.faceVerts[i])) sharedN++;
        if (sharedN === 1) { pa = f; pb = g; break; }
      }
    }
    ok(pa >= 0, '頂点だけを共有する 2 枚が見つからない');
    em.selFace[pa] = 1; em.selFace[pb] = 1;
    em.syncSelection('face');
    const r = insetRegion(em, 0.3);
    ok(r.faces === 2, `砂時計形で処理できない (${r.faces} / ${r.reason})`);
    check(em, { closed: true, chi: 2, label: '頂点だけで触れ合う 2 面を領域インセット', outward: false });
    // 続けて押し出しても壊れない
    extrudeSelectedFaces(em, 0.2);
    check(em, { closed: true, chi: 2, label: '砂時計形を領域インセット → 押し出し', outward: false });
  }
}

// ---------------------------------------------------------------------------
head('ブリッジ（Bridge Edge Loops）');

/** 立方体 2 個（x 方向に離れている）。繋いで 1 つの形にできる */
function twoCubes() {
  const P = [], verts = [], starts = [0];
  for (const dx of [-2.5, 2.5]) {
    const base = P.length / 3;
    for (const [x, y, z] of [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ]) P.push(x + dx, y, z);
    for (const f of [
      [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
      [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
    ]) { verts.push(...f.map(i => i + base)); starts.push(verts.length); }
  }
  const em = new EditMesh();
  em.setGeometry(Float32Array.from(P), Int32Array.from(verts), Int32Array.from(starts));
  return em;
}

/** 境界辺を全部選ぶ */
function selectBoundary(em) {
  em.clearSelection();
  let n = 0;
  for (let e = 0; e < em.ne; e++) if (em.edgeFace[e * 2 + 1] < 0) { em.selEdge[e] = 1; n++; }
  return n;
}

{
  // 離れた 2 つの立方体を、向かい合う面を消して繋ぐ → 1 つの閉じた形（χ=2）
  {
    const em = twoCubes();
    ok(em.liveFaces === 12 && em.nv === 16, `立方体 2 個になっていない (${em.nv}/${em.liveFaces})`);
    // 向かい合う面（左の +x 面と右の -x 面）を消す
    em.clearSelection();
    const ctr = new Float64Array(3);
    for (let f = 0; f < em.nf; f++) {
      em.faceCenter(f, ctr);
      if (Math.abs(Math.abs(ctr[0]) - 1.5) < 1e-6) em.selFace[f] = 1;
    }
    ok(em.selectionCount().faces === 2, `向かい合う 2 面が選べない (${em.selectionCount().faces})`);
    em.syncSelection('face');
    em.deleteSelectedFaces();
    const nb = selectBoundary(em);
    ok(nb === 8, `境界辺が 8 本にならない (${nb})`);
    const r = bridgeEdgeLoops(em);
    ok(r.faces === 4, `帯が 4 枚張られない (${r.faces} / ${r.reason})`);
    ok(em.selectionCount().faces === 4, `張った帯が選択に残らない (${em.selectionCount().faces})`);
    check(em, { closed: true, chi: 2, label: '離れた 2 つの穴をブリッジ', outward: false });
  }

  // 同じ形の離れた 2 つの穴を繋ぐと取っ手になる（χ=0 のトーラス）
  {
    const em = cube();
    // 2 回細分化して 96 枚にする（細分化は選択を引き継がないので選び直す）。
    // 穴どうしが十分離れていないと、桁になる辺が既にあってブリッジが断られる
    em.selectAll('face');
    subdivideSelectedFaces(em);
    em.selectAll('face');
    subdivideSelectedFaces(em);
    ok(em.liveFaces === 96, `96 枚にならない (${em.liveFaces})`);
    em.clearSelection();
    // +x 側と -x 側の、中心にいちばん近い面を 1 枚ずつ消す
    const ctr = new Float64Array(3);
    for (const sx of [1, -1]) {
      let bestF = -1, bestD = Infinity;
      for (let f = 0; f < em.nf; f++) {
        if (!em.faceAlive[f]) continue;
        em.faceCenter(f, ctr);
        if (Math.sign(ctr[0]) !== sx || Math.abs(ctr[0]) < 0.9) continue;
        const d = ctr[1] * ctr[1] + ctr[2] * ctr[2];
        if (d < bestD) { bestD = d; bestF = f; }
      }
      ok(bestF >= 0, `${sx > 0 ? '+x' : '-x'} 側の面が見つからない`);
      em.selFace[bestF] = 1;
    }
    em.syncSelection('face');
    em.deleteSelectedFaces();
    selectBoundary(em);
    const r = bridgeEdgeLoops(em);
    ok(r.faces === 4, `取っ手の帯が張られない (${r.faces} / ${r.reason})`);
    check(em, { closed: true, chi: 0, label: '同じ形の 2 つの穴をブリッジ（取っ手）', outward: false });
  }

  // 立方体の向かい合う 2 面を消して繋ぐのは断る（側面の辺が既に埋まっている）
  {
    const em = cube();
    em.clearSelection();
    em.selFace[0] = 1; em.selFace[1] = 1;      // z=-1 と z=+1
    em.syncSelection('face');
    em.deleteSelectedFaces();
    selectBoundary(em);
    const before = { nf: em.liveFaces, ne: em.ne };
    const r = bridgeEdgeLoops(em);
    ok(r.faces === 0, `非多様体になる繋ぎ方を通してしまった (${r.faces})`);
    ok(/既に 2 面が付いた辺/.test(r.reason), `理由が返らない (${r.reason})`);
    ok(em.liveFaces === before.nf && em.ne === before.ne, '断ったのに形が変わっている');
  }

  // 頂点数が違うループは断る
  {
    const em = twoCubes();
    em.clearSelection();
    const ctr = new Float64Array(3);
    for (let f = 0; f < em.nf; f++) {
      em.faceCenter(f, ctr);
      if (Math.abs(Math.abs(ctr[0]) - 1.5) < 1e-6) em.selFace[f] = 1;
    }
    em.syncSelection('face');
    em.deleteSelectedFaces();
    // 片方の穴の縁に 1 本ループカットを入れて数を変える… のではなく、
    // 片方の穴の縁の辺を細分化する代わりに、隣の面を細分化して縁の辺を増やす
    em.clearSelection();
    let target = -1;
    for (let f = 0; f < em.nf; f++) {
      if (!em.faceAlive[f]) continue;
      let bnd = 0;
      const s = em.faceStart[f], n = em.faceSize(f);
      for (let k = 0; k < n; k++) {
        const e = edgeOf(em, em.faceVerts[s + k], em.faceVerts[s + (k + 1) % n]);
        if (e >= 0 && em.edgeFace[e * 2 + 1] < 0) bnd++;
      }
      em.faceCenter(f, ctr);
      if (bnd === 1 && ctr[0] < 0) { target = f; break; }
    }
    ok(target >= 0, '穴に接する面が見つからない');
    em.selFace[target] = 1;
    em.syncSelection('face');
    subdivideSelectedFaces(em);          // 片方の縁だけ辺が 1 本増える
    selectBoundary(em);
    const r = bridgeEdgeLoops(em);
    ok(r.faces === 0, `頂点数が違うのに繋いでしまった (${r.faces})`);
    ok(/頂点数が違います/.test(r.reason), `理由が返らない (${r.reason})`);
  }

  // 面に挟まれた辺（境界でない辺）を選んだときは、そう言って断る
  {
    const em = cube();
    em.clearSelection();
    em.selEdge[0] = 1; em.selEdge[1] = 1;
    const r = bridgeEdgeLoops(em);
    ok(r.faces === 0, `境界でない辺で繋いでしまった (${r.faces})`);
    ok(/面に挟まれた辺/.test(r.reason), `理由が返らない (${r.reason})`);
  }

  // 何も選んでいないとき
  {
    const em = cube();
    em.clearSelection();
    const r = bridgeEdgeLoops(em);
    ok(r.faces === 0, '何も選んでいないのに動いた');
    ok(/選択されていません/.test(r.reason), `理由が返らない (${r.reason})`);
  }
}

// ---------------------------------------------------------------------------
head('組み合わせ（実際の使い方に近い流れ）');
{
  // 立方体 → ループカット → 一部を選んで押し出し → インセット → 押し出し
  const em = cube();
  em.clearSelection();
  em.selEdge[0] = 1;
  loopCut(em, 1);
  check(em, { closed: true, chi: 2, label: '1) ループカット' });

  em.clearSelection();
  let n = 0;
  for (let f = 0; f < em.nf && n < 2; f++) if (em.faceAlive[f]) { em.selFace[f] = 1; n++; }
  em.syncSelection('face');
  extrudeSelectedFaces(em, 0.5);
  check(em, { closed: true, chi: 2, label: '2) 押し出し', outward: false });

  insetSelectedFaces(em, 0.3);
  check(em, { closed: true, chi: 2, label: '3) インセット', outward: false });

  extrudeSelectedFaces(em, -0.35);
  check(em, { closed: true, chi: 2, label: '4) 内側へ押し出し', outward: false });

  subdivideSelectedFaces(em);
  ok(em.validate().length === 0, `5) 細分化で壊れた (${em.validate().join(' / ')})`);
  console.log(`  最終: V=${em.nv} E=${em.ne} F=${em.liveFaces}`
    + ` χ=${em.nv - em.ne + em.liveFaces}`);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\n✅ すべて通過' : `\n❌ ${failures} 件の失敗`);
process.exit(failures === 0 ? 0 : 1);
