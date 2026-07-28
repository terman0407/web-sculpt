// polygroups.js の検証（DOM / WebGPU に触らない）
//   node test/polygroups.test.mjs
import { SculptMesh, PRIMITIVES, icosphere, cube, plane } from '../js/mesh.js';
import { PolyGroups, GROUP_METHODS, GROUP_METHOD_IDS, groupColorOf } from '../js/polygroups.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------------------
// メッシュ側の健全性（core.test.mjs の validate を必要な項目だけ縮めたもの）
// ---------------------------------------------------------------------------
function validateMesh(mesh, { closed = true, genus = 0, label = '' } = {}) {
  const errs = [];
  const T = mesh.tris;
  let liveT = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    liveT++;
    if (a === b || b === c || c === a) errs.push(`tri ${t} degenerate`);
    for (const v of [a, b, c]) {
      if (v < 0 || v >= mesh.nv) errs.push(`tri ${t} vert ${v} out of range`);
      else if (!mesh.vAlive[v]) errs.push(`tri ${t} refs dead vert ${v}`);
    }
  }
  if (liveT !== mesh.liveTris) errs.push(`liveTris mismatch ${liveT} != ${mesh.liveTris}`);

  // ring の整合性（面 → ring の向きだけ。ここが壊れていれば連結成分も嘘になる）
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    for (const v of [a, b, c]) {
      const r = mesh.ringArray(v);
      if (!r || r.indexOf(t) < 0) errs.push(`tri ${t} not in ring of ${v}`);
    }
  }

  const em = new Map();
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, v = [T[i], T[i + 1], T[i + 2]];
    if (v[0] === v[1] && v[1] === v[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const key = a < b ? a + ':' + b : b + ':' + a;
      em.set(key, (em.get(key) || 0) + 1);
    }
  }
  let bad = 0, boundary = 0;
  for (const n of em.values()) { if (n === 1) boundary++; else if (n !== 2) bad++; }
  if (bad) errs.push(`${bad} non-manifold edges`);
  if (closed && boundary) errs.push(`${boundary} boundary edges (expected closed)`);

  let nan = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(mesh.positions[v * 3 + k])) nan++;
      if (!Number.isFinite(mesh.normals[v * 3 + k])) nan++;
    }
    if (!Number.isFinite(mesh.mask[v])) nan++;
  }
  if (nan) errs.push(`${nan} non-finite components`);

  if (closed) {
    const chi = mesh.liveVerts - em.size + mesh.liveTris;
    if (chi !== 2 - 2 * genus) errs.push(`Euler χ = ${chi} (expected ${2 - 2 * genus})`);
  }

  if (errs.length) {
    failures++;
    console.log(`  FAIL ${label}: ${errs.length} problem(s)`);
    errs.slice(0, 6).forEach(e => console.log('      - ' + e));
  } else {
    console.log(`  ok   ${label}  V=${mesh.liveVerts} F=${mesh.liveTris}`);
  }
  return errs.length === 0;
}

/** ポリグループは頂点を動かさない・マスクも触らないことを毎回確かめるための控え */
function snap(mesh) {
  return {
    positions: mesh.positions.slice(0, mesh.nv * 3),
    normals: mesh.normals.slice(0, mesh.nv * 3),
    colors: mesh.colors.slice(0, mesh.nv * 3),
    mask: mesh.mask.slice(0, mesh.nv),
    tris: mesh.tris.slice(0, mesh.nt * 3),
    vAlive: mesh.vAlive.slice(0, mesh.nv),
    topoVersion: mesh.topoVersion,
    geomVersion: mesh.geomVersion,
    liveTris: mesh.liveTris,
  };
}
function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function assertMeshUntouched(s, mesh, label) {
  ok(sameArray(s.positions, mesh.positions.slice(0, mesh.nv * 3)), `${label}: positions が動いた`);
  ok(sameArray(s.mask, mesh.mask.slice(0, mesh.nv)), `${label}: mask が書き換わった`);
  ok(sameArray(s.colors, mesh.colors.slice(0, mesh.nv * 3)), `${label}: colors が書き換わった`);
  ok(sameArray(s.tris, mesh.tris.slice(0, mesh.nt * 3)), `${label}: tris が書き換わった`);
  ok(sameArray(s.vAlive, mesh.vAlive.slice(0, mesh.nv)), `${label}: vAlive が書き換わった`);
  ok(s.topoVersion === mesh.topoVersion, `${label}: topoVersion が動いた`);
  ok(s.geomVersion === mesh.geomVersion, `${label}: geomVersion が動いた`);
}

function makeMesh(geo) {
  const m = new SculptMesh();
  m.setGeometry(geo.positions, geo.indices);
  return m;
}

/** 球を n 個、離れた位置に並べた 1 つのジオメトリ（連結成分のテスト用） */
function disjointSpheres(n, subdiv = 2) {
  const g = icosphere(subdiv, 0.4);
  const nv = g.positions.length / 3, ni = g.indices.length;
  const pos = new Float32Array(nv * 3 * n);
  const idx = new Uint32Array(ni * n);
  for (let k = 0; k < n; k++) {
    for (let v = 0; v < nv; v++) {
      pos[(k * nv + v) * 3] = g.positions[v * 3] + k * 3;
      pos[(k * nv + v) * 3 + 1] = g.positions[v * 3 + 1];
      pos[(k * nv + v) * 3 + 2] = g.positions[v * 3 + 2];
    }
    for (let i = 0; i < ni; i++) idx[k * ni + i] = g.indices[i] + k * nv;
  }
  return { positions: pos, indices: idx, perSphereVerts: nv, perSphereTris: ni / 3 };
}

function liveTris(mesh) {
  const out = [];
  const T = mesh.tris;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3;
    if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
    out.push(t);
  }
  return out;
}
function triVerts(mesh, t) { const i = t * 3, T = mesh.tris; return [T[i], T[i + 1], T[i + 2]]; }

function faceNormalOf(mesh, t) {
  const [ia, ib, ic] = triVerts(mesh, t);
  const P = mesh.positions, a = ia * 3, b = ib * 3, c = ic * 3;
  const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
  const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** 可視面のインデックス列を素朴に作った期待値 */
function expectedIndices(mesh, isVis) {
  const out = [];
  const T = mesh.tris;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    if (!isVis(t)) continue;
    out.push(a, b, c);
  }
  return out;
}
function matchIndices(res, exp, label) {
  ok(res.count === exp.length, `${label}: count=${res.count} 期待 ${exp.length}`);
  let diff = 0;
  for (let i = 0; i < Math.min(res.count, exp.length); i++) if (res.indices[i] !== exp[i]) diff++;
  ok(diff === 0, `${label}: インデックスの中身が ${diff} 個違う`);
}

// ---------------------------------------------------------------------------
head('前提: テストに使うメッシュ自体が健全か');
const sphere = makeMesh(PRIMITIVES.sphere());
validateMesh(sphere, { label: 'icosphere(4)' });
const boxSeg = 6;
const box = makeMesh(cube(boxSeg, 1.5, false));
validateMesh(box, { label: `cube(${boxSeg})` });
const flat = makeMesh(plane(8, 2));
validateMesh(flat, { closed: false, label: 'plane(8)' });

// ---------------------------------------------------------------------------
head('既定状態（同期しただけ）');
{
  const pg = new PolyGroups();
  const s = snap(sphere);
  pg.sync(sphere);
  ok(pg.groupCount === 1, `既定は 1 グループ (実際 ${pg.groupCount})`);
  ok(pg.visibleCount() === sphere.liveTris, `既定は全部可視 (${pg.visibleCount()}/${sphere.liveTris})`);
  ok(pg.hiddenCount() === 0, '既定で隠れている面がある');
  ok(pg.allVisible === true, 'allVisible が false');
  const g = pg.groupsOf(sphere);
  ok(g.length >= sphere.nt, 'groupsOf の長さが nt に足りない');
  let badId = 0;
  for (let t = 0; t < sphere.nt; t++) if (g[t] !== 0) badId++;
  ok(badId === 0, `既定のグループ ID が 0 でない面が ${badId}`);
  const r = pg.buildVisibleIndices(sphere);
  ok(r.count === sphere.liveTris * 3, `count=${r.count} 期待 ${sphere.liveTris * 3}`);
  ok(r.allVisible === true, 'allVisible が false');
  let outOfRange = 0;
  for (let i = 0; i < r.count; i++) {
    const v = r.indices[i];
    if (!(v >= 0 && v < sphere.nv) || sphere.vAlive[v] !== 1) outOfRange++;
  }
  ok(outOfRange === 0, `死んでいる/範囲外の頂点を指すインデックスが ${outOfRange}`);
  ok(pg.bytes() > 0, 'bytes() が 0');
  assertMeshUntouched(s, sphere, '既定状態');
}

// ---------------------------------------------------------------------------
head('byConnectivity: 連結成分の数');
{
  const pg = new PolyGroups();
  const r1 = pg.assign(sphere, 'byConnectivity');
  ok(r1.groups === 1, `球は 1 グループのはず (実際 ${r1.groups})`);
  ok(pg.groupCount === 1, 'groupCount が assign の戻り値と違う');
  ok(r1.tris === sphere.liveTris, `tris=${r1.tris} 期待 ${sphere.liveTris}`);

  for (const n of [2, 3, 5]) {
    const d = disjointSpheres(n);
    const m = makeMesh({ positions: d.positions, indices: d.indices });
    const p = new PolyGroups();
    const r = p.assign(m, 'byConnectivity');
    ok(r.groups === n, `離れた球 ${n} 個 → ${r.groups} グループ`);
    const G = p.groups;
    const sizes = p.groupSizes(m);
    let sizeErr = 0, spanErr = 0;
    for (let i = 0; i < sizes.length; i++) if (sizes[i] !== d.perSphereTris) sizeErr++;
    // 各グループが 1 個の球の頂点範囲に収まっているか（別の塊と混ざっていないか）
    for (const t of liveTris(m)) {
      const g = G[t];
      for (const v of triVerts(m, t)) {
        if (Math.floor(v / d.perSphereVerts) !== Math.floor(triVerts(m, t)[0] / d.perSphereVerts)) spanErr++;
        if (g !== Math.floor(v / d.perSphereVerts)) {
          // ID の並びは走査順なので球の並びと一致する
          spanErr++;
        }
      }
    }
    ok(sizeErr === 0, `球 ${n} 個: グループごとの面数が均等でない`);
    ok(spanErr === 0, `球 ${n} 個: グループが別の塊に跨っている`);
  }

  // 板（境界のある開いたメッシュ）でも 1 グループ
  const p2 = new PolyGroups();
  ok(p2.assign(flat, 'byConnectivity').groups === 1, '板が 1 グループにならない');
}

// ---------------------------------------------------------------------------
head('byNormalAngle: 箱が 6 グループ');
{
  const s = snap(box);
  const pg = new PolyGroups();
  const r = pg.assign(box, 'byNormalAngle', { angle: 30 });
  ok(r.groups === 6, `箱は 6 グループのはず (実際 ${r.groups})`);
  const sizes = pg.groupSizes(box);
  const per = boxSeg * boxSeg * 2;
  let sizeErr = 0;
  for (let i = 0; i < sizes.length; i++) if (sizes[i] !== per) sizeErr++;
  ok(sizeErr === 0, `1 面あたり ${per} 三角形になっていない: [${sizes.join(',')}]`);

  // 同じグループの面法線は一致していること（＝角度で正しく切れている）
  const first = new Map();
  let normErr = 0;
  for (const t of liveTris(box)) {
    const g = pg.groups[t];
    const n = faceNormalOf(box, t);
    if (!first.has(g)) { first.set(g, n); continue; }
    const f = first.get(g);
    if (n[0] * f[0] + n[1] * f[1] + n[2] * f[2] < 0.999) normErr++;
  }
  ok(normErr === 0, `同一グループ内で法線が違う面が ${normErr}`);

  // しきい値を 90 度より大きくすれば全部つながる
  const r2 = pg.assign(box, 'byNormalAngle', { angle: 120 });
  ok(r2.groups === 1, `角度 120 度なら 1 グループ (実際 ${r2.groups})`);
  // 平らな板は角度をいくら小さくしても 1 グループ
  const p2 = new PolyGroups();
  ok(p2.assign(flat, 'byNormalAngle', { angle: 1 }).groups === 1, '平らな板が分かれてしまった');
  // 球は細分が細かいので緩いしきい値で 1 グループ
  const p3 = new PolyGroups();
  ok(p3.assign(sphere, 'byNormalAngle', { angle: 20 }).groups === 1, `球が分かれた`);
  ok(p3.assign(sphere, 'byNormalAngle', { angle: 0 }).groups === sphere.liveTris,
    '角度 0 なら面ごとにばらばらになるはず');
  assertMeshUntouched(s, box, 'byNormalAngle');
}

// ---------------------------------------------------------------------------
head('可視インデックスは可視面だけを含む / 隠して戻すと復活する');
{
  const s = snap(box);
  const pg = new PolyGroups();
  pg.assign(box, 'byNormalAngle', { angle: 30 });
  const full = pg.buildVisibleIndices(box);
  const fullCopy = full.indices.slice(0, full.count);
  const perGroup = pg.groupSizes(box);

  const h = pg.hideGroup(box, 2);
  ok(h.changed === perGroup[2], `hideGroup の changed=${h.changed} 期待 ${perGroup[2]}`);
  ok(pg.visibleCount() === box.liveTris - perGroup[2], `visibleCount=${pg.visibleCount()}`);
  ok(pg.hiddenCount() === perGroup[2], 'hiddenCount が合わない');
  ok(pg.allVisible === false, '隠したのに allVisible が true');
  ok(pg.isVisible(liveTris(box).find(t => pg.groups[t] === 2)) === false, 'isVisible が隠した面で true');

  const r = pg.buildVisibleIndices(box);
  matchIndices(r, expectedIndices(box, t => pg.groups[t] !== 2), 'hideGroup(2) 後');
  ok(r.count === (box.liveTris - perGroup[2]) * 3, 'count が可視面数 * 3 でない');
  ok(r.allVisible === false, 'allVisible が true');

  // べき等性: もう一度隠しても何も変わらない
  const h2 = pg.hideGroup(box, 2);
  ok(h2.changed === 0, `2 回目の hideGroup で changed=${h2.changed}`);
  const r2 = pg.buildVisibleIndices(box);
  matchIndices(r2, expectedIndices(box, t => pg.groups[t] !== 2), '2 回目の hideGroup 後');

  // 可逆性: 戻すと元のインデックス列と完全に一致する
  const back = pg.showGroup(box, 2);
  ok(back.changed === perGroup[2], `showGroup の changed=${back.changed}`);
  const r3 = pg.buildVisibleIndices(box);
  ok(r3.count === fullCopy.length, `復活後の count=${r3.count} 期待 ${fullCopy.length}`);
  ok(sameArray(fullCopy, r3.indices.slice(0, r3.count)), '隠して戻したらインデックス列が変わった');
  ok(pg.allVisible === true, '戻したのに allVisible が false');

  // 複数グループを隠して showAll で戻す
  pg.hideGroup(box, 0); pg.hideGroup(box, 3); pg.hideGroup(box, 5);
  ok(pg.visibleCount() === box.liveTris - perGroup[0] - perGroup[3] - perGroup[5], '3 グループ隠した後の数が合わない');
  const sa = pg.showAll(box);
  ok(sa.changed === perGroup[0] + perGroup[3] + perGroup[5], `showAll の changed=${sa.changed}`);
  const r4 = pg.buildVisibleIndices(box);
  ok(sameArray(fullCopy, r4.indices.slice(0, r4.count)), 'showAll で元に戻らない');
  ok(pg.showAll(box).changed === 0, 'showAll がべき等でない');

  // invertVisible を 2 回で元に戻る
  pg.hideGroup(box, 1);
  const beforeInv = pg.vis.slice(0, box.nt);
  pg.invertVisible(box);
  ok(pg.visibleCount() === perGroup[1], `反転後の可視面数=${pg.visibleCount()} 期待 ${perGroup[1]}`);
  pg.invertVisible(box);
  ok(sameArray(beforeInv, pg.vis.slice(0, box.nt)), '反転 2 回で元に戻らない');
  pg.showAll(box);

  // showGroupOnly（Ctrl+Shift クリック相当）
  pg.showGroupOnly(box, 4);
  ok(pg.visibleCount() === perGroup[4], `showGroupOnly の可視面数=${pg.visibleCount()}`);
  const r5 = pg.buildVisibleIndices(box);
  matchIndices(r5, expectedIndices(box, t => pg.groups[t] === 4), 'showGroupOnly(4)');
  pg.showAll(box);
  assertMeshUntouched(s, box, '表示操作');
}

// ---------------------------------------------------------------------------
head('マスク: byMask / hideMasked / showMaskedOnly（頂点は動かない）');
{
  const m = makeMesh(PRIMITIVES.sphere());
  // 右半分を完全保護（1 = 動かない）にする
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3] > 0.2 ? 1 : 0;
  const s = snap(m);
  const pg = new PolyGroups();

  const isMasked = (t) => {
    const [a, b, c] = triVerts(m, t);
    return (m.mask[a] + m.mask[b] + m.mask[c]) / 3 >= 0.5;
  };
  let nMasked = 0;
  for (const t of liveTris(m)) if (isMasked(t)) nMasked++;
  ok(nMasked > 0 && nMasked < m.liveTris, `テスト前提: マスク面が ${nMasked}/${m.liveTris}`);

  const r = pg.assign(m, 'byMask');
  ok(r.groups === 2, `byMask は 2 グループのはず (実際 ${r.groups})`);
  let gErr = 0;
  for (const t of liveTris(m)) {
    const want = isMasked(t) ? 1 : 0;
    if (pg.groups[t] !== want) gErr++;
  }
  ok(gErr === 0, `byMask のグループ割り当てが ${gErr} 面ずれている`);

  const hm = pg.hideMasked(m);
  ok(hm.hidden === nMasked, `hideMasked: hidden=${hm.hidden} 期待 ${nMasked}`);
  const ri = pg.buildVisibleIndices(m);
  matchIndices(ri, expectedIndices(m, t => !isMasked(t)), 'hideMasked');
  ok(pg.hideMasked(m).changed === 0, 'hideMasked がべき等でない');

  pg.showAll(m);
  const sm = pg.showMaskedOnly(m);
  ok(sm.visible === nMasked, `showMaskedOnly: visible=${sm.visible} 期待 ${nMasked}`);
  matchIndices(pg.buildVisibleIndices(m), expectedIndices(m, isMasked), 'showMaskedOnly');
  ok(pg.showMaskedOnly(m).changed === 0, 'showMaskedOnly がべき等でない');

  // マスクが全く無いメッシュでは byMask は 1 グループ
  const m2 = makeMesh(PRIMITIVES.sphere());
  const pg2 = new PolyGroups();
  ok(pg2.assign(m2, 'byMask').groups === 1, 'マスク無しで byMask が 2 グループになった');
  ok(pg2.hideMasked(m2).changed === 0, 'マスク無しで hideMasked が面を隠した');

  assertMeshUntouched(s, m, 'マスク操作');
  validateMesh(m, { label: 'マスク操作後のメッシュ' });
}

// ---------------------------------------------------------------------------
head('byVisible / all');
{
  const pg = new PolyGroups();
  pg.assign(box, 'byNormalAngle', { angle: 30 });
  const per = pg.groupSizes(box);
  pg.hideGroup(box, 0);
  const r = pg.assign(box, 'byVisible');
  ok(r.groups === 2, `byVisible は 2 グループのはず (実際 ${r.groups})`);
  let err = 0;
  for (const t of liveTris(box)) {
    const want = pg.isVisible(t) ? 0 : 1;
    if (pg.groups[t] !== want) err++;
  }
  ok(err === 0, `byVisible の割り当てが ${err} 面ずれている`);
  const sizes = pg.groupSizes(box);
  ok(sizes[1] === per[0], `隠れている側の面数=${sizes[1]} 期待 ${per[0]}`);

  pg.showAll(box);
  ok(pg.assign(box, 'byVisible').groups === 1, '全部可視なら byVisible は 1 グループ');
  const ra = pg.assign(box, 'all');
  ok(ra.groups === 1, 'all が 1 グループにならない');
  let allErr = 0;
  for (const t of liveTris(box)) if (pg.groups[t] !== 0) allErr++;
  ok(allErr === 0, 'all の後にグループ 0 以外が残っている');

  // 知らない手法は何も変えない
  const before = pg.groups.slice(0, box.nt);
  const bad = pg.assign(box, 'nonsense');
  ok(bad.ok === false, '未知の手法が ok:true を返した');
  ok(sameArray(before, pg.groups.slice(0, box.nt)), '未知の手法でグループが書き換わった');
  ok(GROUP_METHOD_IDS.length === 5, `GROUP_METHOD_IDS が 5 個でない (${GROUP_METHOD_IDS.length})`);
}

// ---------------------------------------------------------------------------
head('growVisible / shrinkVisible');
{
  const s = snap(box);
  const pg = new PolyGroups();
  pg.assign(box, 'byNormalAngle', { angle: 30 });

  // 全部可視なら伸ばしても縮めても何も起きない
  ok(pg.growVisible(box, 1).changed === 0, '全部可視で grow が動いた');
  ok(pg.shrinkVisible(box, 1).changed === 0, '全部可視で shrink が動いた');

  pg.showGroupOnly(box, 0);
  const base = pg.vis.slice(0, box.nt);
  const baseCount = pg.visibleCount();

  // 「可視面の頂点に触っている面」が次の段になる、を素朴な集合演算で検算する
  const visVerts = new Set();
  for (const t of liveTris(box)) if (base[t] === 1) for (const v of triVerts(box, t)) visVerts.add(v);
  const g1 = pg.growVisible(box, 1);
  let missed = 0, extra = 0;
  for (const t of liveTris(box)) {
    const touches = triVerts(box, t).some(v => visVerts.has(v));
    const nowVis = pg.isVisible(t);
    if (base[t] === 1) { if (!nowVis) extra++; continue; }
    if (touches && !nowVis) missed++;
    if (!touches && nowVis) extra++;
  }
  ok(missed === 0 && extra === 0, `grow(1) の結果が定義と合わない (missed=${missed} extra=${extra})`);
  ok(pg.visibleCount() > baseCount, 'grow で可視面が増えていない');
  ok(g1.changed === pg.visibleCount() - baseCount, `grow の changed=${g1.changed} と差分が違う`);

  // 縮める側も同様に、非可視面の頂点に触っている可視面が消える
  const cur = pg.vis.slice(0, box.nt);
  const hidVerts = new Set();
  for (const t of liveTris(box)) if (cur[t] === 0) for (const v of triVerts(box, t)) hidVerts.add(v);
  const s1 = pg.shrinkVisible(box, 1);
  let missed2 = 0, extra2 = 0;
  for (const t of liveTris(box)) {
    const touches = triVerts(box, t).some(v => hidVerts.has(v));
    const nowVis = pg.isVisible(t);
    if (cur[t] === 0) { if (nowVis) extra2++; continue; }
    if (touches && nowVis) missed2++;
    if (!touches && !nowVis) extra2++;
  }
  ok(missed2 === 0 && extra2 === 0, `shrink(1) の結果が定義と合わない (missed=${missed2} extra=${extra2})`);
  ok(s1.changed > 0 && pg.visibleCount() < box.liveTris, 'shrink で減っていない');

  // 単調性: grow は減らない / shrink は増えない
  let prev = pg.visibleCount(), mono = 0;
  for (let i = 0; i < 4; i++) { pg.growVisible(box, 1); if (pg.visibleCount() < prev) mono++; prev = pg.visibleCount(); }
  for (let i = 0; i < 20; i++) { pg.shrinkVisible(box, 1); if (pg.visibleCount() > prev) mono++; prev = pg.visibleCount(); }
  ok(mono === 0, '単調性が壊れている');

  // 全部隠した状態からは広げようがない（無限ループにならないこと）
  pg.showGroupOnly(box, -1);
  ok(pg.visibleCount() === 0, '全部隠せていない');
  ok(pg.growVisible(box, 100).changed === 0, '可視面 0 から grow が動いた');
  ok(pg.buildVisibleIndices(box).count === 0, '可視面 0 なのにインデックスが出た');

  // 十分な段数で広げれば全面が戻る（箱は 1 つの塊なので）
  pg.showGroupOnly(box, 0);
  pg.growVisible(box, 200);
  ok(pg.visibleCount() === box.liveTris, `grow(200) で全面に戻らない (${pg.visibleCount()}/${box.liveTris})`);
  ok(pg.growVisible(box, 0).changed === 0, 'steps=0 で動いた');
  pg.showAll(box);
  assertMeshUntouched(s, box, 'grow / shrink');
}

// ---------------------------------------------------------------------------
head('トポロジ変化の検出（黙って壊れたデータを使わない）');
{
  const m = makeMesh(PRIMITIVES.sphere());
  const pg = new PolyGroups();
  pg.assign(m, 'byNormalAngle', { angle: 20 });
  pg.assign(m, 'byConnectivity');
  pg.hideGroup(m, 0);
  ok(pg.visibleCount() === 0, '1 グループを隠したので可視面は 0 のはず');

  // 形だけ変えた場合はハイド状態を保つ
  m.positions[0] += 0.1;
  m.geomVersion++;
  ok(pg.sync(m) === true, '形の変化でリセットされてしまった');
  ok(pg.visibleCount() === 0, '形の変化でハイド状態が消えた');

  // トポロジが変わったら全部 1 グループ・全部可視へ
  const t0 = liveTris(m)[10];
  m.removeTriangle(t0);
  ok(pg.sync(m) === false, 'トポロジ変化を検出できていない');
  ok(pg.groupCount === 1, `リセット後の groupCount=${pg.groupCount}`);
  ok(pg.visibleCount() === m.liveTris, `リセット後の可視面数=${pg.visibleCount()} 期待 ${m.liveTris}`);
  ok(pg.allVisible === true, 'リセット後に allVisible が false');
  const r = pg.buildVisibleIndices(m);
  ok(r.count === m.liveTris * 3, `退化面を含んでいる? count=${r.count} 期待 ${m.liveTris * 3}`);
  matchIndices(r, expectedIndices(m, () => true), 'リセット後');

  // 退化スロット（削除された面）はどの手法でもグループ -1 のままで、
  // 面数の集計にも描画にも出てこないこと
  const liveSet = new Set(liveTris(m));
  ok(liveSet.size < m.nt, 'テスト前提: 退化スロットが無い');
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3] > 0 ? 1 : 0;
  for (const method of GROUP_METHOD_IDS) {
    const st = pg.assign(m, method, { angle: 30 });
    let deadGroup = 0;
    for (let t = 0; t < m.nt; t++) if (!liveSet.has(t) && pg.groups[t] !== -1) deadGroup++;
    ok(deadGroup === 0, `${method}: 死んだスロットのグループが -1 でない (${deadGroup})`);
    let sum = 0;
    for (const n of pg.groupSizes(m)) sum += n;
    ok(sum === m.liveTris, `${method}: groupSizes の合計=${sum} 期待 ${m.liveTris}`);
    ok(st.tris === m.liveTris, `${method}: tris=${st.tris} 期待 ${m.liveTris}`);
    pg.showAll(m);
    ok(pg.buildVisibleIndices(m).count === m.liveTris * 3, `${method}: 退化面が描画に出ている`);
  }
  for (let v = 0; v < m.nv; v++) m.mask[v] = 0;

  // 面が増える方向（分割）でも同じ
  pg.hideGroup(m, 0);
  const geo = PRIMITIVES.sphereHi();
  m.setGeometry(geo.positions, geo.indices);
  ok(pg.sync(m) === false, 'setGeometry を検出できていない');
  ok(pg.visibleCount() === m.liveTris, 'setGeometry 後に全部可視になっていない');
  ok(pg.groups.length >= m.nt, '容量が nt に追従していない');
  let nz = 0;
  for (let t = 0; t < m.nt; t++) if (pg.groups[t] !== 0) nz++;
  ok(nz === 0, `リセット後に 0 以外のグループが ${nz}`);
  validateMesh(m, { label: 'トポロジ変化後のメッシュ' });

  // 一度も使っていない状態でトポロジが何度変わっても既定状態のまま
  // （dyntopo 中は毎ダブここを通る）
  const fresh = new PolyGroups();
  for (let k = 0; k < 3; k++) {
    m.removeTriangle(liveTris(m)[20 + k]);
    fresh.sync(m);
    ok(fresh.groupCount === 1 && fresh.visibleCount() === m.liveTris && fresh.allVisible,
      `未使用の状態でトポロジ変化 ${k}: ${fresh.visibleCount()} / ${m.liveTris}`);
    ok(fresh.buildVisibleIndices(m).count === m.liveTris * 3, `未使用の状態 ${k}: インデックス数が合わない`);
  }
  // 使ったあとにトポロジが変わった場合は必ず初期状態へ戻る（fill を省く最適化の穴）
  fresh.assign(m, 'byNormalAngle', { angle: 20 });
  fresh.hideGroup(m, 1);
  m.removeTriangle(liveTris(m)[30]);
  fresh.sync(m);
  let nz2 = 0;
  for (let t = 0; t < m.nt; t++) if (fresh.groups[t] !== 0) nz2++;
  ok(nz2 === 0, `使用後のリセットでグループが残っている (${nz2})`);
  ok(fresh.visibleCount() === m.liveTris, `使用後のリセットで可視面数=${fresh.visibleCount()} 期待 ${m.liveTris}`);
  ok(fresh.buildVisibleIndices(m).count === m.liveTris * 3, '使用後のリセットで隠れたままの面がある');

  // グループ分けをせず「隠しただけ」の状態からのリセットも同じこと
  const onlyHidden = new PolyGroups();
  onlyHidden.sync(m);
  onlyHidden.hideGroup(m, 0);                 // 既定の 1 グループ = 全面
  ok(onlyHidden.visibleCount() === 0, '既定グループを隠せていない');
  m.removeTriangle(liveTris(m)[40]);
  ok(onlyHidden.sync(m) === false, '隠しただけの状態でトポロジ変化を検出できていない');
  ok(onlyHidden.visibleCount() === m.liveTris, `隠しただけ→リセットで可視面数=${onlyHidden.visibleCount()} 期待 ${m.liveTris}`);
  ok(onlyHidden.buildVisibleIndices(m).count === m.liveTris * 3, '隠しただけ→リセットで面が戻らない');
}

// ---------------------------------------------------------------------------
head('groupColor: 決定論的・高彩度・ID ごとに離れている');
{
  let bad = 0, dull = 0;
  const cols = [];
  for (let id = 0; id < 64; id++) {
    const a = groupColorOf(id), b = groupColorOf(id);
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) bad++;
    for (const c of a) if (!Number.isFinite(c) || c < 0 || c > 1) bad++;
    const mx = Math.max(a[0], a[1], a[2]), mn = Math.min(a[0], a[1], a[2]);
    if (mx < 0.7 || mx - mn < 0.35) dull++;   // 彩度・明度が十分あるか
    cols.push(a);
  }
  ok(bad === 0, `groupColor が決定論的でない/範囲外 (${bad})`);
  ok(dull === 0, `彩度か明度が足りない色が ${dull} 個`);

  // 近い ID どうしが似た色にならないこと（境目が見えないと使えない）
  let minD = Infinity;
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      const d = Math.hypot(cols[i][0] - cols[j][0], cols[i][1] - cols[j][1], cols[i][2] - cols[j][2]);
      if (d < minD) minD = d;
    }
  }
  ok(minD > 0.12, `ID 0..15 の色が近すぎる (最小距離 ${minD.toFixed(3)})`);
  const gray = groupColorOf(-1);
  ok(Math.abs(gray[0] - gray[2]) < 0.05, 'グループ -1 が無彩色でない');

  // 頂点カラーへの焼き込み
  const pg = new PolyGroups();
  pg.assign(box, 'byNormalAngle', { angle: 30 });
  const vc = pg.buildVertexGroupColors(box);
  ok(vc.colors.length >= box.nv * 3, '頂点カラーの長さが足りない');
  let cbad = 0;
  for (let i = 0; i < box.nv * 3; i++) {
    const c = vc.colors[i];
    if (!Number.isFinite(c) || c < 0 || c > 1) cbad++;
  }
  ok(cbad === 0, `頂点カラーに NaN / 範囲外が ${cbad}`);
  ok(vc.colors !== box.colors, 'mesh.colors を直接書き換えている');
}

// ---------------------------------------------------------------------------
head('統計と使い回しの一貫性');
{
  const pg = new PolyGroups();
  pg.assign(box, 'byNormalAngle', { angle: 30 });
  const sizes = pg.groupSizes(box);
  let sum = 0;
  for (const n of sizes) sum += n;
  ok(sum === box.liveTris, `groupSizes の合計=${sum} 期待 ${box.liveTris}`);

  const v0 = pg.visVersion;
  pg.hideGroup(box, 1);
  ok(pg.visVersion > v0, '可視状態が変わったのに visVersion が増えていない');
  const v1 = pg.visVersion;
  pg.hideGroup(box, 1);
  ok(pg.visVersion === v1, '何も変わっていないのに visVersion が増えた');

  // buildVisibleIndices を続けて呼んでも同じ結果（バッファ使い回しの副作用が無い）
  const a = pg.buildVisibleIndices(box);
  const copy = a.indices.slice(0, a.count);
  const b = pg.buildVisibleIndices(box);
  ok(b.count === copy.length && sameArray(copy, b.indices.slice(0, b.count)), '2 回呼ぶと結果が変わる');
  pg.showAll(box);
}

// ---------------------------------------------------------------------------
head('大きめのメッシュで O(n) を確認（時間の目安）');
{
  const geo = icosphere(6, 1);       // 40,962 頂点 / 81,920 面
  const m = makeMesh(geo);
  const pg = new PolyGroups();
  const t0 = Date.now();
  const rc = pg.assign(m, 'byConnectivity');
  const t1 = Date.now();
  const rn = pg.assign(m, 'byNormalAngle', { angle: 15 });
  const t2 = Date.now();
  pg.hideGroup(m, 0);
  const bi = pg.buildVisibleIndices(m);
  const t3 = Date.now();
  console.log(`       F=${m.liveTris}  connectivity ${t1 - t0}ms  normalAngle ${t2 - t1}ms  indices ${t3 - t2}ms  bytes=${(pg.bytes() / 1024 / 1024).toFixed(2)}MB`);
  ok(rc.groups === 1, '大きい球が 1 連結成分でない');
  ok(rn.groups === 1, `角度 15 度で球が分かれた (${rn.groups})`);
  ok(bi.count === 0, '1 グループを隠したのに面が残っている');
  ok(t2 - t0 < 4000, `グループ分けが遅すぎる (${t2 - t0}ms)`);
}

// ---------------------------------------------------------------------------
head('退化スロットが可視数と描画に混ざらない');
{
  // 退化スロットを可視面として数えてしまうと allVisible / visibleCount が嘘になり、
  // 描画側が「全部見えている」と判断して隠した面まで描く。穴あきの箱で確かめる。
  const m = makeMesh(cube(boxSeg, 1.5, false));
  const holes = [];
  for (let k = 0; k < 10; k++) holes.push(liveTris(m)[k * 13]);
  for (const t of holes) m.removeTriangle(t);
  const pg = new PolyGroups();
  pg.assign(m, 'byNormalAngle', { angle: 30 });
  const per = pg.groupSizes(m);
  pg.hideGroup(m, 2);
  let bruteVis = 0;
  for (const t of liveTris(m)) if (pg.isVisible(t)) bruteVis++;
  ok(bruteVis > 0 && bruteVis < m.liveTris, `テスト前提: 一部だけ可視 (${bruteVis}/${m.liveTris})`);
  ok(pg.visibleCount() === bruteVis, `hideGroup 後 visibleCount=${pg.visibleCount()} 総当たり ${bruteVis}`);
  ok(pg.hiddenCount() === m.liveTris - bruteVis, `hiddenCount=${pg.hiddenCount()}`);
  ok(pg.allVisible === false, '一部隠しているのに allVisible が true');

  const r = pg.buildVisibleIndices(m);
  ok(r.count === bruteVis * 3, `count=${r.count} 期待 ${bruteVis * 3}`);
  ok(pg.visibleCount() === bruteVis,
    `buildVisibleIndices が退化スロットを可視数に数えた (${pg.visibleCount()} 期待 ${bruteVis})`);
  ok(r.allVisible === false, '一部隠しているのに r.allVisible が true');
  let degOut = 0, deadOut = 0;
  for (let i = 0; i < r.count; i += 3) {
    if (r.indices[i] === r.indices[i + 1] && r.indices[i + 1] === r.indices[i + 2]) degOut++;
  }
  for (let i = 0; i < r.count; i++) if (m.vAlive[r.indices[i]] !== 1) deadOut++;
  ok(degOut === 0, `描画インデックスに退化三角形が ${degOut} 個`);
  ok(deadOut === 0, `描画インデックスが死んだ頂点を ${deadOut} 個指している`);
  ok(per[2] === m.liveTris - bruteVis, `隠したグループの面数=${per[2]} 期待 ${m.liveTris - bruteVis}`);

  // assign する前（＝リセット直後）は退化スロットのグループ ID も 0 なので、
  // groupSizes が三角形の退化判定を省くと合計が liveTris を超える。
  // assign 後は -1 が入って g >= 0 の判定で弾かれるため、この経路でしか出ない。
  const fresh = new PolyGroups();
  fresh.sync(m);
  const fs = fresh.groupSizes(m);
  let fsum = 0;
  for (const n of fs) fsum += n;
  ok(fs.length === 1, `リセット直後の groupSizes 長さ=${fs.length} 期待 1`);
  ok(fsum === m.liveTris, `リセット直後の groupSizes 合計=${fsum} 期待 ${m.liveTris}（退化スロットを数えている）`);
}

// ---------------------------------------------------------------------------
head('可視数の総当たり検算（ランダム操作 300 回）');
{
  // _visCount は操作ごとに数え直す前提。差分で足し引きしている経路
  // （grow / shrink）が 1 つでもずれると、以降ずっと嘘の統計を返し続ける。
  const m = makeMesh(cube(5, 1.5, false));
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3 + 1] > 0 ? 1 : 0;
  const s = snap(m);
  const pg = new PolyGroups();
  pg.assign(m, 'byNormalAngle', { angle: 30 });
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ops = ['hideGroup', 'showGroup', 'showGroupOnly', 'showAll', 'invertVisible',
    'hideMasked', 'showMaskedOnly', 'growVisible', 'shrinkVisible'];
  let countErr = 0, idxErr = 0, sumErr = 0, firstBad = '';
  for (let it = 0; it < 300; it++) {
    const op = ops[Math.floor(rnd() * ops.length)];
    if (op === 'hideGroup' || op === 'showGroup' || op === 'showGroupOnly') {
      pg[op](m, Math.floor(rnd() * 8) - 1);   // 範囲外の ID もわざと混ぜる
    } else if (op === 'growVisible' || op === 'shrinkVisible') {
      pg[op](m, 1 + Math.floor(rnd() * 3));
    } else {
      pg[op](m);
    }
    let brute = 0;
    for (const t of liveTris(m)) if (pg.vis[t] === 1) brute++;
    if (pg.visibleCount() !== brute) { countErr++; if (!firstBad) firstBad = `${op}: visibleCount=${pg.visibleCount()} 総当たり ${brute}`; }
    if (pg.visibleCount() + pg.hiddenCount() !== m.liveTris) sumErr++;
    if (pg.buildVisibleIndices(m).count !== brute * 3) { idxErr++; if (!firstBad) firstBad = `${op}: indices ${brute * 3} と違う`; }
  }
  ok(countErr === 0, `可視数がずれた回数 ${countErr}  ${firstBad}`);
  ok(idxErr === 0, `インデックス数がずれた回数 ${idxErr}`);
  ok(sumErr === 0, `可視 + 非可視 が liveTris にならなかった回数 ${sumErr}`);
  assertMeshUntouched(s, m, 'ランダム操作');
}

// ---------------------------------------------------------------------------
head('端数マスクとしきい値（1 = 動かない の向き）');
{
  const m = makeMesh(PRIMITIVES.sphere());
  const pg = new PolyGroups();

  // 平均 0.4 は「保護されていない」側 → 隠れないしグループも分かれない
  for (let v = 0; v < m.nv; v++) m.mask[v] = 0.4;
  ok(pg.assign(m, 'byMask').groups === 1, 'mask=0.4 全面で byMask が 2 グループになった');
  ok(pg.hideMasked(m).changed === 0, 'mask=0.4（保護されていない）面を隠してしまった');
  // 平均 0.6 は保護されている側 → 全部隠れる
  for (let v = 0; v < m.nv; v++) m.mask[v] = 0.6;
  const h = pg.hideMasked(m);
  ok(h.hidden === m.liveTris, `mask=0.6 全面で hidden=${h.hidden} 期待 ${m.liveTris}`);
  ok(pg.visibleCount() === 0, 'mask=0.6 全面なのに見えている面がある');
  pg.showAll(m);
  // しきい値を渡せば境目が動く
  ok(pg.hideMasked(m, 0.7).changed === 0, 'threshold=0.7 で mask=0.6 が隠れた');
  ok(pg.hideMasked(m, 0.5).hidden === m.liveTris, 'threshold=0.5 で mask=0.6 が隠れない');
  pg.showAll(m);
  for (let v = 0; v < m.nv; v++) m.mask[v] = 0.4;
  ok(pg.hideMasked(m, 0.3).hidden === m.liveTris, 'threshold=0.3 で mask=0.4 が隠れない');
  pg.showAll(m);
  ok(pg.assign(m, 'byMask', { threshold: 0.3 }).groups === 1, 'threshold=0.3 mask=0.4 全面で 2 グループ');

  // 半分ずつにして byMask のしきい値が効くか
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3] > 0 ? 0.45 : 0.05;
  const s = snap(m);
  ok(pg.assign(m, 'byMask', { threshold: 0.4 }).groups === 2, 'threshold=0.4 で 2 グループにならない');
  ok(pg.assign(m, 'byMask', { threshold: 0.5 }).groups === 1, 'threshold=0.5 で分かれてしまった');

  // hideMasked は「今隠れている面」を触らない（documented な非対称性）
  pg.assign(m, 'byMask', { threshold: 0.4 });
  const sizes = pg.groupSizes(m);
  pg.showGroupOnly(m, 1);                       // マスク側だけ表示
  const beforeVis = pg.vis.slice(0, m.nt);
  pg.hideMasked(m, 0.4);                        // マスク側を隠す → 全部隠れる
  ok(pg.visibleCount() === 0, `hideMasked 後の可視面数=${pg.visibleCount()} 期待 0`);
  pg.showAll(m);
  pg.showGroupOnly(m, 0);                       // 非マスク側だけ表示
  ok(pg.hideMasked(m, 0.4).changed === 0, 'hideMasked が非マスク面を触った');
  ok(sizes[0] + sizes[1] === m.liveTris, 'byMask の 2 グループ合計が liveTris と違う');
  ok(beforeVis.length === m.nt, 'テスト前提');
  assertMeshUntouched(s, m, '端数マスク');
}

// ---------------------------------------------------------------------------
head('高価数の頂点（円錐の頂点・UV 球の極）で二乗にならない');
{
  // 1 頂点に何万面も集まる形。面ごとに大きい ring を舐める実装だと
  // Σvalence² になって 3 万面で 1 秒級になる（正則な 130 万面より遅い）。
  function fan(n, z, m, apex) {
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      ring.push(m.addVertex(Math.cos(a), Math.sin(a), z));
    }
    for (let i = 0; i < n; i++) m.addTriangle(apex, ring[i], ring[(i + 1) % n]);
  }
  const N = 15000;
  const m = new SculptMesh();
  const apex = m.addVertex(0, 0, 0);
  fan(N, 1, m, apex);
  fan(N, -1, m, apex);                          // 頂点だけを共有する 2 枚の円錐
  m.computeAllNormals();
  ok(m.ringCount[apex] === N * 2, `テスト前提: apex の価数=${m.ringCount[apex]}`);
  ok(m.liveTris === N * 2, `テスト前提: F=${m.liveTris}`);

  const pg = new PolyGroups();
  const t0 = Date.now();
  const rc = pg.assign(m, 'byConnectivity');
  const t1 = Date.now();
  const rn = pg.assign(m, 'byNormalAngle', { angle: 30 });
  const t2 = Date.now();
  console.log(`       F=${m.liveTris} valence(apex)=${m.ringCount[apex]}  connectivity ${t1 - t0}ms  normalAngle ${t2 - t1}ms`);
  // 頂点を共有しているので連結成分は 1 つ、辺は共有していないので法線角では 2 つ
  ok(rc.groups === 1, `頂点共有の 2 円錐が ${rc.groups} 連結成分になった (期待 1)`);
  ok(rn.groups === 2, `法線角で ${rn.groups} グループ (期待 2: 辺を共有していない)`);
  const sizes = pg.groupSizes(m);
  ok(sizes.length === 2 && sizes[0] === N && sizes[1] === N, `グループの面数が ${sizes.join(',')}`);
  ok(t1 - t0 < 400, `byConnectivity が高価数で二乗になっている (${t1 - t0}ms)`);
  ok(t2 - t1 < 400, `byNormalAngle が高価数で二乗になっている (${t2 - t1}ms)`);

  // 高価数でも表示操作・描画出力が壊れないこと
  pg.hideGroup(m, 0);
  const r = pg.buildVisibleIndices(m);
  ok(r.count === N * 3, `高価数で hideGroup 後の count=${r.count} 期待 ${N * 3}`);
  ok(pg.growVisible(m, 1).changed === N, `apex 経由で反対の円錐へ広がらない`);
}

// ---------------------------------------------------------------------------
head('非多様体・死んだ頂点・退化面が混ざったメッシュ');
{
  // 1 辺に 3 面。edgeNeighbor は「最初に見つけた 1 枚」を隣とみなす仕様なので、
  // 結果の内訳は問わず「落ちない・ハングしない・統計が整合する」ことだけ見る。
  const m = new SculptMesh();
  const a = m.addVertex(0, 0, 0), b = m.addVertex(1, 0, 0);
  const c = m.addVertex(0, 1, 0), d = m.addVertex(0, -1, 0), e = m.addVertex(0, 0, 1);
  m.addTriangle(a, b, c); m.addTriangle(b, a, d); m.addTriangle(a, b, e);
  m.computeAllNormals();
  const pg = new PolyGroups();
  ok(pg.assign(m, 'byConnectivity').groups === 1, '1 辺 3 面が 1 連結成分にならない');
  const rn = pg.assign(m, 'byNormalAngle', { angle: 30 });
  ok(rn.groups >= 1 && rn.groups <= 3, `非多様体で groups=${rn.groups}`);
  let sum = 0;
  for (const n of pg.groupSizes(m)) sum += n;
  ok(sum === m.liveTris, `非多様体で groupSizes の合計=${sum} 期待 ${m.liveTris}`);
  pg.hideGroup(m, 0);
  let brute = 0;
  for (const t of liveTris(m)) if (pg.vis[t] === 1) brute++;
  ok(pg.visibleCount() === brute, '非多様体で可視数がずれた');
  ok(pg.buildVisibleIndices(m).count === brute * 3, '非多様体でインデックス数がずれた');
  ok(pg.growVisible(m, 5).changed === m.liveTris - brute, '非多様体で grow が全面に届かない');

  // 死んだ頂点を含むメッシュ（周りの面を全部消した頂点）
  const m2 = makeMesh(PRIMITIVES.sphere());
  const dv = 5;
  for (const t of m2.ringArray(dv)) m2.removeTriangle(t);
  m2.removeVertex(dv);
  ok(m2.vAlive[dv] === 0, 'テスト前提: 頂点が死んでいる');
  const p2 = new PolyGroups();
  p2.assign(m2, 'byConnectivity');
  p2.hideGroup(m2, 0);
  p2.growVisible(m2, 2);
  const bi = p2.buildVisibleIndices(m2);
  let dead = 0;
  for (let i = 0; i < bi.count; i++) if (m2.vAlive[bi.indices[i]] !== 1) dead++;
  ok(dead === 0, `死んだ頂点を指すインデックスが ${dead}`);
  const vc = p2.buildVertexGroupColors(m2);
  let nan = 0;
  for (let i = 0; i < m2.nv * 3; i++) if (!Number.isFinite(vc.colors[i]) || vc.colors[i] < 0 || vc.colors[i] > 1) nan++;
  ok(nan === 0, `死んだ頂点込みで頂点カラーに NaN / 範囲外が ${nan}`);
  validateMesh(m2, { closed: false, label: '死んだ頂点があるメッシュ' });
}

// ---------------------------------------------------------------------------
head('壊れた引数で暴れない');
{
  const m = makeMesh(cube(4, 1.5, false));
  const pg = new PolyGroups();
  const good = pg.assign(m, 'byNormalAngle', { angle: 30 }).groups;
  ok(good === 6, `テスト前提: 箱が ${good} グループ`);
  // angle が NaN のまま cos に入ると「どの辺も硬い」判定になり、
  // 面数と同じグループができて groupSizes / グループ色の確保が破綻する。
  for (const bad of [NaN, undefined, null, Infinity, -Infinity, '30']) {
    const r = pg.assign(m, 'byNormalAngle', { angle: bad });
    ok(r.ok === true && r.groups === good,
      `angle=${String(bad)} で groups=${r.groups} 期待 ${good}（既定値へ落ちていない）`);
  }
  ok(pg.assign(m, 'byNormalAngle', { angle: -10 }).groups === good, 'angle=-10 が 0 に丸められていない');
  ok(pg.assign(m, 'byNormalAngle', { angle: 400 }).groups === 1, 'angle=400 が 180 に丸められていない');
  ok(pg.assign(m, 'byMask', {}).groups >= 0, 'opts 空で byMask が落ちた');

  // steps の異常値
  pg.assign(m, 'byNormalAngle', { angle: 30 });
  pg.showGroupOnly(m, 0);
  const v0 = pg.visibleCount();
  // undefined は既定引数 (steps = 1) が効くので「動く」のが正しい。ここでは除く。
  for (const bad of [NaN, null, -5, 0]) {
    ok(pg.growVisible(m, bad).changed === 0, `steps=${String(bad)} で grow が動いた`);
    ok(pg.shrinkVisible(m, bad).changed === 0, `steps=${String(bad)} で shrink が動いた`);
  }
  ok(pg.visibleCount() === v0, '異常な steps で可視面が変わった');
  ok(pg.growVisible(m).changed > 0, 'steps 省略時に既定の 1 段が効いていない');
  // 段数は四捨五入した整数として扱う（1.4 段 = 1 段、1.6 段 = 2 段）
  pg.showGroupOnly(m, 0);
  const step1 = pg.growVisible(m, 1).visible;
  pg.showGroupOnly(m, 0);
  const step2 = pg.growVisible(m, 2).visible;
  ok(step2 > step1, 'テスト前提: 2 段は 1 段より広い');
  pg.showGroupOnly(m, 0);
  ok(pg.growVisible(m, 1.4).visible === step1, 'steps=1.4 が 1 段に丸められていない');
  pg.showGroupOnly(m, 0);
  ok(pg.growVisible(m, 1.6).visible === step2, 'steps=1.6 が 2 段に丸められていない');
  ok(pg.growVisible(m, 1e9).allVisible === true, 'steps が巨大でも打ち切って全面に届くはず');
}

// ---------------------------------------------------------------------------
head('空メッシュ / 三角形 1 枚 / 範囲外のグループ ID');
{
  const empty = new SculptMesh();
  const pg = new PolyGroups();
  ok(pg.sync(empty) === false, '初回 sync は false（guard 未設定）のはず');
  ok(pg.groupCount === 1 && pg.visibleCount() === 0 && pg.allVisible === true,
    `空メッシュ: groups=${pg.groupCount} visible=${pg.visibleCount()} allVisible=${pg.allVisible}`);
  for (const meth of GROUP_METHOD_IDS) {
    const r = pg.assign(empty, meth, { angle: 30 });
    ok(r.ok === true && r.groups === 0 && r.tris === 0, `空メッシュ ${meth}: ${JSON.stringify(r)}`);
  }
  ok(pg.buildVisibleIndices(empty).count === 0, '空メッシュでインデックスが出た');
  ok(pg.groupSizes(empty).length >= 1, '空メッシュで groupSizes が空配列');
  ok(pg.buildVertexGroupColors(empty).colors.length === 0, '空メッシュで頂点カラーが出た');
  ok(pg.showAll(empty).changed === 0 && pg.invertVisible(empty).changed === 0, '空メッシュで面が動いた');

  const one = new SculptMesh();
  const a = one.addVertex(0, 0, 0), b = one.addVertex(1, 0, 0), c = one.addVertex(0, 1, 0);
  one.addTriangle(a, b, c);
  one.computeAllNormals();
  const p1 = new PolyGroups();
  ok(p1.assign(one, 'byConnectivity').groups === 1, '三角形 1 枚が 1 グループにならない');
  ok(p1.buildVisibleIndices(one).count === 3, '三角形 1 枚のインデックスが 3 個でない');
  ok(p1.shrinkVisible(one, 1).changed === 0, '孤立した 1 枚が shrink で消えた');
  ok(p1.hideGroup(one, 0).changed === 1, '1 枚を隠せない');
  ok(p1.buildVisibleIndices(one).count === 0, '隠したのにインデックスが出た');
  ok(p1.growVisible(one, 1).changed === 0, '全部隠した 1 枚が grow で復活した');

  // 存在しないグループ ID
  const m = makeMesh(cube(4, 1.5, false));
  const p2 = new PolyGroups();
  p2.assign(m, 'byNormalAngle', { angle: 30 });
  ok(p2.hideGroup(m, 99).changed === 0, '存在しない ID で面が隠れた');
  ok(p2.hideGroup(m, -1).changed === 0, 'ID -1（退化スロット用）で面が隠れた');
  ok(p2.showGroup(m, 99).changed === 0, '存在しない ID で面が現れた');
  ok(p2.allVisible === true, '存在しない ID の操作で状態が変わった');
  ok(p2.showGroupOnly(m, 99).visible === 0, '存在しない ID の showGroupOnly で全部隠れない');
  p2.showAll(m);
  ok(p2.groupSizes(m).length === p2.groupCount, 'groupSizes の長さが groupCount と違う');
  ok(p2.isVisible(-1) === false, 'isVisible(-1) が true');
  ok(p2.isVisible(m.nt + 100000) === true, '未同期スロットの isVisible が既定（可視）でない');
}

// ---------------------------------------------------------------------------
head('メニュー用の一覧と頂点カラーのバッファ再利用');
{
  ok(GROUP_METHODS.length === GROUP_METHOD_IDS.length, 'GROUP_METHODS と ID 一覧の長さが違う');
  let shape = 0;
  for (const x of GROUP_METHODS) {
    if (typeof x.id !== 'string' || typeof x.jp !== 'string'
      || typeof x.short !== 'string' || typeof x.hint !== 'string') shape++;
  }
  ok(shape === 0, `GROUP_METHODS に id/jp/short/hint が揃っていない項目が ${shape}`);

  const m = makeMesh(cube(4, 1.5, false));
  const pg = new PolyGroups();
  pg.assign(m, 'byNormalAngle', { angle: 30 });
  ok(JSON.stringify(pg.groupColor(7)) === JSON.stringify(groupColorOf(7)),
    'groupColor(id) と groupColorOf(id) が違う');

  // out を渡したら使い回す（毎フレーム確保させない）
  const buf = new Float32Array(m.nv * 3);
  const r1 = pg.buildVertexGroupColors(m, buf);
  ok(r1.colors === buf, '十分な大きさの out を渡したのに新規確保した');
  const r2 = pg.buildVertexGroupColors(m, buf);
  ok(r2.colors === buf, '2 回目に別のバッファを返した');
  let diff = 0;
  for (let i = 0; i < m.nv * 3; i++) if (r1.colors[i] !== r2.colors[i]) diff++;
  ok(diff === 0, `同じ状態で 2 回焼いたら ${diff} 個違った`);
  const small = pg.buildVertexGroupColors(m, new Float32Array(3));
  ok(small.colors.length >= m.nv * 3, '小さすぎる out を渡したのに伸ばさなかった');
  ok(r1.groups === pg.groupCount, `頂点カラーの groups=${r1.groups} 期待 ${pg.groupCount}`);
}

// ---------------------------------------------------------------------------
head('reset / validate を直に呼ぶ');
{
  const m = makeMesh(PRIMITIVES.sphere());
  const s = snap(m);
  const pg = new PolyGroups();
  pg.assign(m, 'byNormalAngle', { angle: 20 });
  pg.hideGroup(m, 0);
  ok(pg.validate(m) === true, '同じ topoVersion で validate が false');
  ok(pg.visibleCount() === 0, 'validate がハイド状態を捨てた');
  const r = pg.reset(m);
  ok(r.changed === 0, `reset の changed=${r.changed}（reset は面の付け替えではない）`);
  ok(r.groups === 1 && pg.groupCount === 1, 'reset 後に 1 グループでない');
  ok(pg.visibleCount() === m.liveTris && pg.allVisible === true, 'reset 後に全部可視でない');
  let nz = 0;
  for (let t = 0; t < m.nt; t++) if (pg.groups[t] !== 0 || pg.vis[t] !== 1) nz++;
  ok(nz === 0, `reset 後に既定状態でないスロットが ${nz}`);
  ok(pg.buildVisibleIndices(m).count === m.liveTris * 3, 'reset 後に面が戻っていない');
  // reset の直後は topoVersion を取り込んでいるので validate は true
  ok(pg.validate(m) === true, 'reset 直後の validate が false');
  assertMeshUntouched(s, m, 'reset / validate');
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\n全テスト通過' : `\n${failures} 件の失敗`);
process.exit(failures === 0 ? 0 : 1);
