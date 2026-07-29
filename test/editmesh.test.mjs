// ---------------------------------------------------------------------------
// 編集メッシュ（ポリゴンモデリング）の検証。
//   node test/editmesh.test.mjs
//
// 見るところ:
//   * 彫刻メッシュ ⇄ 編集メッシュの往復で形が保たれるか
//   * 辺表と隣接が正しいか（閉じた形なら全部の辺が 2 面に共有される）
//   * 選択モードの相互変換が Blender の規則どおりか
//   * 削除・溶解・反転が構造を壊さないか
// ---------------------------------------------------------------------------

import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { quadDominant } from '../js/remesh.js';
import {
  EditMesh, editMeshFromSculpt, editMeshToSculpt, triangulate,
  pickVert, pickEdge, pickFace, boxSelect,
} from '../js/editmesh.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

/** 構造の整合性。閉じた形なら境界辺が無いことも見る */
function check(em, { closed = true, label = '' } = {}) {
  const errs = em.validate();
  let boundary = 0, three = 0;
  for (let e = 0; e < em.ne; e++) {
    if (em.edgeFace[e * 2 + 1] < 0) boundary++;
  }
  if (closed && boundary > 0) errs.push(`境界辺が ${boundary} 本ある（閉じた形のはず）`);
  if (em.nonManifold > 0) three = em.nonManifold;
  // 頂点 → 辺 の CSR が辺表と一致するか
  let csrBad = 0;
  for (let v = 0; v < em.nv; v++) {
    for (let i = em.vEdgeStart[v]; i < em.vEdgeStart[v + 1]; i++) {
      const e = em.vEdge[i];
      if (em.edgeA[e] !== v && em.edgeB[e] !== v) csrBad++;
    }
  }
  if (csrBad) errs.push(`頂点→辺の CSR が ${csrBad} 件おかしい`);
  // 面の辺が全部辺表にあるか
  let missing = 0;
  const key = new Set();
  for (let e = 0; e < em.ne; e++) key.add(em.edgeA[e] + ':' + em.edgeB[e]);
  for (let f = 0; f < em.nf; f++) {
    if (!em.faceAlive[f]) continue;
    const s = em.faceStart[f], n = em.faceSize(f);
    for (let k = 0; k < n; k++) {
      const a = em.faceVerts[s + k], b = em.faceVerts[s + (k + 1) % n];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (!key.has(lo + ':' + hi)) missing++;
    }
  }
  if (missing) errs.push(`面の辺 ${missing} 本が辺表に無い`);

  const st = em.faceStats();
  if (errs.length) {
    failures++;
    console.log(`  FAIL ${label}: ${errs.join(' / ')}`);
  } else {
    console.log(`  ok   ${label}  V=${em.nv} E=${em.ne} F=${st.faces}`
      + ` (四角 ${st.quad} / 三角 ${st.tri} / n-gon ${st.ngon}`
      + `${three ? ` / 非多様体辺 ${three}` : ''})`);
  }
  return errs.length === 0;
}

// ---------------------------------------------------------------------------
head('彫刻メッシュからの変換');
const built = {};
for (const name of ['sphere', 'cube', 'cylinder', 'quadball', 'torus']) {
  if (!PRIMITIVES[name]) continue;
  const g = PRIMITIVES[name]();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const em = editMeshFromSculpt(m, quadDominant);
  built[name] = { m, em };
  check(em, { closed: true, label: name });
  const st = em.faceStats();
  ok(st.quad > 0, `${name}: 四角が 1 つも作られていない`);
  ok(em.nv === m.liveVerts, `${name}: 頂点数が変わった (${em.nv} != ${m.liveVerts})`);
  // オイラー標数（閉じた形で穴が無ければ 2、トーラスは 0）
  const chi = em.nv - em.ne + st.faces;
  const want = name === 'torus' ? 0 : 2;
  ok(chi === want, `${name}: オイラー標数が ${chi}（期待 ${want}）`);
}

// ---------------------------------------------------------------------------
head('往復（三角形化して戻す）');
{
  const { m, em } = built.sphere;
  const before = m.positions.slice(0, m.nv * 3);
  const nvBefore = m.liveVerts;
  const m2 = new SculptMesh();
  const r = editMeshToSculpt(em, m2);
  ok(m2.liveVerts === nvBefore, `頂点数が変わった (${m2.liveVerts} != ${nvBefore})`);
  ok(m2.liveTris === m.liveTris, `面数が変わった (${m2.liveTris} != ${m.liveTris})`);
  let maxd = 0;
  for (let i = 0; i < nvBefore * 3; i++) maxd = Math.max(maxd, Math.abs(m2.positions[i] - before[i]));
  ok(maxd < 1e-6, `座標が変わった (最大差 ${maxd.toExponential(2)})`);
  console.log(`  往復: ${nvBefore} 頂点 / ${m.liveTris} 三角形 → ${r.tris} 三角形（差 ${maxd.toExponential(1)}）`);

  // 三角形化の面数は Σ(n-2)
  const st = em.faceStats();
  const want = st.quad * 2 + st.tri + st.ngon * 0 + (() => {
    let s = 0;
    for (let f = 0; f < em.nf; f++) if (em.faceAlive[f] && em.faceSize(f) > 4) s += em.faceSize(f) - 2;
    return s;
  })();
  ok(triangulate(em).indices.length / 3 === want,
    `三角形化の枚数が Σ(n-2) と合わない (${triangulate(em).indices.length / 3} != ${want})`);
}

// ---------------------------------------------------------------------------
head('選択モードの相互変換');
{
  // 立方体を四角 6 枚で手作りする（規則を確かめやすい形）
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
  check(em, { closed: true, label: '手作りの立方体' });
  ok(em.nv === 8 && em.ne === 12 && em.liveFaces === 6,
    `立方体の V/E/F が 8/12/6 でない (${em.nv}/${em.ne}/${em.liveFaces})`);

  // 面 1 枚を選ぶ → 頂点 4 個、辺 4 本
  em.clearSelection();
  em.selFace[0] = 1;
  em.syncSelection('face');
  let c = em.selectionCount();
  ok(c.verts === 4 && c.edges === 4 && c.faces === 1,
    `面 1 枚から 頂点4/辺4 にならない (${c.verts}/${c.edges}/${c.faces})`);

  // 頂点 4 個（1 面ぶん）を選ぶ → その面が選択される
  em.clearSelection();
  for (const v of F[0]) em.selVert[v] = 1;
  em.syncSelection('vert');
  c = em.selectionCount();
  ok(c.faces === 1, `頂点 4 個からその面が選ばれない (面 ${c.faces})`);
  ok(c.edges === 4, `頂点 4 個から辺 4 本が選ばれない (辺 ${c.edges})`);

  // 頂点 2 個（1 辺の両端）→ 辺 1 本、面は 0
  em.clearSelection();
  em.selVert[0] = 1; em.selVert[1] = 1;
  em.syncSelection('vert');
  c = em.selectionCount();
  ok(c.edges === 1 && c.faces === 0,
    `辺の両端から 辺1/面0 にならない (${c.edges}/${c.faces})`);

  // 広げる / 縮める
  em.clearSelection();
  em.selVert[0] = 1;
  em.syncSelection('vert');
  em.growSelection('vert');
  c = em.selectionCount();
  ok(c.verts === 4, `1 頂点を広げて 4 個にならない (${c.verts})`);  // 立方体は価数 3
  em.shrinkSelection('vert');
  c = em.selectionCount();
  ok(c.verts === 1, `縮めて 1 個に戻らない (${c.verts})`);

  // すべて / 反転
  em.selectAll('face');
  ok(em.selectionCount().faces === 6, 'すべて選択で 6 面にならない');
  em.invertSelection('face');
  ok(em.selectionCount().faces === 0, '反転で 0 面にならない');

  // 繋がっている塊
  em.clearSelection();
  em.selVert[0] = 1;
  em.selectLinked();
  ok(em.selectionCount().verts === 8, `リンク選択で 8 頂点にならない (${em.selectionCount().verts})`);
}

// ---------------------------------------------------------------------------
head('編集操作');
{
  const mk = () => {
    const g = PRIMITIVES.cube();
    const m = new SculptMesh();
    m.setGeometry(g.positions, g.indices);
    return editMeshFromSculpt(m, quadDominant);
  };

  // 面の削除
  {
    const em = mk();
    const f0 = em.liveFaces, v0 = em.nv;
    em.clearSelection();
    let n = 0;
    for (let f = 0; f < em.nf && n < 3; f++) if (em.faceAlive[f]) { em.selFace[f] = 1; n++; }
    em.syncSelection('face');
    const r = em.deleteSelectedFaces();
    ok(r.faces === 3, `3 面消えていない (${r.faces})`);
    ok(em.liveFaces === f0 - 3, `面数が合わない (${em.liveFaces} != ${f0 - 3})`);
    ok(em.nv <= v0, '頂点が増えている');
    check(em, { closed: false, label: '3 面削除後' });
  }

  // 辺の溶解（四角 2 枚 → 六角形）
  {
    const em = mk();
    const st0 = em.faceStats();
    // 内部の辺（両側に面がある）を 1 本選ぶ
    em.clearSelection();
    let picked = -1;
    for (let e = 0; e < em.ne; e++) {
      const a = em.edgeFace[e * 2], b = em.edgeFace[e * 2 + 1];
      if (a >= 0 && b >= 0 && a !== b && em.faceSize(a) === 4 && em.faceSize(b) === 4) { picked = e; break; }
    }
    ok(picked >= 0, '溶解できる内部辺が見つからない');
    em.selEdge[picked] = 1;
    const r = em.dissolveSelectedEdges();
    ok(r.edges === 1, `1 本溶解できていない (${r.edges} / 断られた ${r.refused})`);
    const st1 = em.faceStats();
    ok(st1.faces === st0.faces - 1, `面が 1 枚減っていない (${st0.faces} → ${st1.faces})`);
    ok(st1.ngon >= 1, `六角形ができていない (n-gon ${st1.ngon})`);
    check(em, { closed: true, label: '辺 1 本を溶解' });
  }

  // 境界辺は溶解できない（断る）
  {
    const em = mk();
    em.clearSelection();
    for (let f = 0; f < em.nf; f++) if (em.faceAlive[f]) { em.selFace[f] = 1; break; }
    em.syncSelection('face');
    em.deleteSelectedFaces();
    // 穴の縁の辺を選ぶ
    em.clearSelection();
    let bnd = 0;
    for (let e = 0; e < em.ne; e++) {
      if (em.edgeFace[e * 2 + 1] < 0) { em.selEdge[e] = 1; bnd++; }
    }
    ok(bnd > 0, '境界辺が見つからない');
    const r = em.dissolveSelectedEdges();
    ok(r.edges === 0, `境界辺を溶解してしまった (${r.edges})`);
    check(em, { closed: false, label: '境界辺の溶解を断った後' });
  }

  // 面の反転
  {
    const em = mk();
    const nrm = new Float64Array(3);
    em.selectAll('face');
    let f0 = -1;
    for (let f = 0; f < em.nf; f++) if (em.faceAlive[f]) { f0 = f; break; }
    em.faceNormal(f0, nrm);
    const before = [nrm[0], nrm[1], nrm[2]];
    const n = em.flipSelectedFaces();
    ok(n === em.liveFaces, `全部反転していない (${n} / ${em.liveFaces})`);
    em.faceNormal(f0, nrm);
    const dot = before[0] * nrm[0] + before[1] * nrm[1] + before[2] * nrm[2];
    ok(dot < -0.99, `法線が反転していない (内積 ${dot.toFixed(3)})`);
    check(em, { closed: true, label: '全面反転' });
  }
}

// ---------------------------------------------------------------------------
head('当たり判定と矩形選択');
{
  const { em } = built.sphere;
  const P = em.positions;
  // 既知の頂点のすぐ近くを指したら、その頂点が返ること
  const v = 100;
  const p = [P[v * 3] + 1e-4, P[v * 3 + 1], P[v * 3 + 2]];
  ok(pickVert(em, p, 0.1) === v, `頂点の当たり判定が外れる (${pickVert(em, p, 0.1)} != ${v})`);
  ok(pickVert(em, [10, 10, 10], 0.1) === -1, '遠い点で頂点を拾ってしまう');

  // 辺の中点を指したらその辺
  const e = 50;
  const a = em.edgeA[e] * 3, b = em.edgeB[e] * 3;
  const mid = [(P[a] + P[b]) / 2, (P[a + 1] + P[b + 1]) / 2, (P[a + 2] + P[b + 2]) / 2];
  ok(pickEdge(em, mid, 0.1) === e, `辺の当たり判定が外れる (${pickEdge(em, mid, 0.1)} != ${e})`);

  // 面の重心を指したらその面
  const c = new Float64Array(3);
  let f = -1;
  for (let i = 0; i < em.nf; i++) if (em.faceAlive[i]) { f = i; break; }
  em.faceCenter(f, c);
  ok(pickFace(em, [c[0], c[1], c[2]], 0.5) === f, '面の当たり判定が外れる');

  // 矩形選択: x > 0 の半分だけを囲う
  const project = (x, y, z) => [x, y, z > -99];
  const r = boxSelect(em, project, { x0: 0.05, y0: -9, x1: 9, y1: 9 }, 'vert');
  ok(r.verts > 0, '矩形選択で何も選ばれない');
  let bad = 0;
  for (let i = 0; i < em.nv; i++) if (em.selVert[i] && em.positions[i * 3] < 0.05) bad++;
  ok(bad === 0, `矩形の外の頂点が選ばれている (${bad})`);
  console.log(`  矩形選択: ${r.verts} 頂点 / ${r.edges} 辺 / ${r.faces} 面`);

  // 面モードでは「全頂点が矩形に入っている面」だけ
  boxSelect(em, project, { x0: 0.05, y0: -9, x1: 9, y1: 9 }, 'face');
  let fbad = 0;
  for (let i = 0; i < em.nf; i++) {
    if (!em.selFace[i]) continue;
    for (let k = em.faceStart[i]; k < em.faceStart[i + 1]; k++) {
      if (em.positions[em.faceVerts[k] * 3] < 0.05) { fbad++; break; }
    }
  }
  ok(fbad === 0, `矩形にまたがる面が選ばれている (${fbad})`);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\n✅ すべて通過' : `\n❌ ${failures} 件の失敗`);
process.exit(failures === 0 ? 0 : 1);
