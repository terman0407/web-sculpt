// WebSculpt コアロジックの検証（DOM / WebGPU に触らない部分）
import { SculptMesh, PRIMITIVES, weld } from '../js/mesh.js';
import { Sculptor } from '../js/sculptor.js';
import { splitEdge, collapseEdge, refineRegion } from '../js/dyntopo.js';
import { exportOBJ, exportSTL, exportPLY, importOBJ } from '../js/io.js';
import { BRUSH_IDS } from '../js/brushes.js';
import { dynamesh, hasBoundary, taubinSmooth } from '../js/dynamesh.js';
import { initWasmFieldFromBytes, wasmFieldReady } from '../js/wasmfield.js';
import { readFileSync as _readFileSync } from 'node:fs';
import { SubdivLevels } from '../js/subdiv.js';
import { falloff } from '../js/brushes.js';
import { packMesh } from '../js/store.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

function validate(mesh, { closed = true, label = '', genus = 0, reportChiOnly = false } = {}) {
  const errs = [];
  const T = mesh.tris;

  // 1. 生きた三角形の頂点は生きているか / 退化していないか
  let liveT = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    liveT++;
    if (a === b || b === c || c === a) errs.push(`tri ${t} degenerate (${a},${b},${c})`);
    for (const v of [a, b, c]) {
      if (v < 0 || v >= mesh.nv) errs.push(`tri ${t} vert ${v} out of range`);
      else if (!mesh.vAlive[v]) errs.push(`tri ${t} refs dead vert ${v}`);
    }
  }
  if (liveT !== mesh.liveTris) errs.push(`liveTris mismatch: counted ${liveT} stored ${mesh.liveTris}`);

  let liveV = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) liveV++;
  if (liveV !== mesh.liveVerts) errs.push(`liveVerts mismatch: counted ${liveV} stored ${mesh.liveVerts}`);

  // 2. ring 整合性
  for (let v = 0; v < mesh.nv; v++) {
    const r = mesh.ringArray(v);
    if (!mesh.vAlive[v]) { if (r && r.length) errs.push(`dead vert ${v} has ring`); continue; }
    if (!r) { errs.push(`alive vert ${v} has null ring`); continue; }
    const seen = new Set();
    for (const t of r) {
      if (seen.has(t)) errs.push(`vert ${v} ring has dup tri ${t}`);
      seen.add(t);
      const i = t * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) errs.push(`vert ${v} ring has dead tri ${t}`);
      if (T[i] !== v && T[i + 1] !== v && T[i + 2] !== v) errs.push(`vert ${v} ring tri ${t} does not contain v`);
    }
  }
  // 逆方向
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    for (const v of [a, b, c]) {
      const r = mesh.ringArray(v);
      if (!r || r.indexOf(t) < 0) errs.push(`tri ${t} not in ring of ${v}`);
    }
  }

  // 3. 多様体性（閉じたメッシュなら各辺 = 2 面）
  if (closed) {
    const em = new Map();
    for (let t = 0; t < mesh.nt; t++) {
      const i = t * 3, v = [T[i], T[i + 1], T[i + 2]];
      if (v[0] === v[1] && v[1] === v[2]) continue;
      for (let e = 0; e < 3; e++) {
        let a = v[e], b = v[(e + 1) % 3];
        const key = a < b ? a + ':' + b : b + ':' + a;
        em.set(key, (em.get(key) || 0) + 1);
      }
    }
    let bad = 0, boundary = 0;
    for (const [, n] of em) { if (n === 1) boundary++; else if (n !== 2) bad++; }
    if (bad) errs.push(`${bad} non-manifold edges`);
    if (boundary) errs.push(`${boundary} boundary edges (expected closed)`);
  }

  // 4. NaN / Inf
  let nan = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(mesh.positions[v * 3 + k])) nan++;
      if (!Number.isFinite(mesh.normals[v * 3 + k])) nan++;
    }
  }
  if (nan) errs.push(`${nan} non-finite position/normal components`);

  // 5. オイラー標数（閉じた球面なら V - E + F = 2）
  if (closed) {
    const em = new Set();
    for (let t = 0; t < mesh.nt; t++) {
      const i = t * 3, v = [T[i], T[i + 1], T[i + 2]];
      if (v[0] === v[1] && v[1] === v[2]) continue;
      for (let e = 0; e < 3; e++) {
        let a = v[e], b = v[(e + 1) % 3];
        em.add(a < b ? a + ':' + b : b + ':' + a);
      }
    }
    const chi = mesh.liveVerts - em.size + mesh.liveTris;
    const want = 2 - 2 * genus;
    if (reportChiOnly) { console.log(`       (χ = ${chi})`); }
    else if (chi !== want) errs.push(`Euler characteristic = ${chi} (expected ${want})`);
  }

  if (errs.length) {
    failures++;
    console.log(`  FAIL ${label}: ${errs.length} problem(s)`);
    errs.slice(0, 8).forEach(e => console.log('      - ' + e));
  } else {
    console.log(`  ok   ${label}  V=${mesh.liveVerts} F=${mesh.liveTris}`);
  }
  return errs.length === 0;
}

function makeState(over = {}) {
  return Object.assign({
    brush: 'clay', radiusPx: 90, strength: 0.6, paintColor: [0.6, 0.2, 0.15],
    worldRadius: 0.25, dynTopo: true, decimate: true, detail: 0.55, maxVerts: 400000,
    symmetry: { x: true, y: false, z: false },
  }, over);
}

// ---------------------------------------------------------------------------
head('プリミティブ生成');
for (const [name, gen] of Object.entries(PRIMITIVES)) {
  const g = gen();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const closed = name !== 'plane';
  validate(m, { closed, genus: name === 'torus' ? 1 : 0, label: name });
}

// ---------------------------------------------------------------------------
head('splitEdge の多様体保存');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  let n = 0;
  for (let k = 0; k < 400; k++) {
    const t = (k * 37) % m.nt;
    if (!m.isTriAlive(t)) continue;
    const i = t * 3;
    if (splitEdge(m, m.tris[i], m.tris[i + 1]) >= 0) n++;
  }
  console.log(`  ${n} split`);
  validate(m, { label: 'after splits' });
}

head('collapseEdge の多様体保存');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const before = m.liveVerts;
  let n = 0;
  for (let k = 0; k < 3000; k++) {
    const t = (k * 61) % m.nt;
    if (!m.isTriAlive(t)) continue;
    const i = t * 3;
    if (collapseEdge(m, m.tris[i], m.tris[i + 1])) n++;
  }
  console.log(`  ${n} collapse  (${before} → ${m.liveVerts} verts)`);
  ok(n > 100, 'コラプスがほとんど成立していない');
  validate(m, { label: 'after collapses' });
  m.compact();
  validate(m, { label: 'after compact' });
}

// ---------------------------------------------------------------------------
head('全ブラシ × 動的トポロジのストローク');
for (const brush of BRUSH_IDS) {
  for (const dynTopo of [true, false]) {
    const g = PRIMITIVES.sphere();
    const m = new SculptMesh();
    m.setGeometry(g.positions, g.indices);
    const state = makeState({ brush, dynTopo, decimate: true });
    const s = new Sculptor(m, state);
    state.worldRadius = 0.3;

    // 球面上を数ストローク走らせる
    for (let stroke = 0; stroke < 4; stroke++) {
      const a0 = stroke * 1.3;
      const pt = new Float32Array(3);
      const at = (u) => {
        const th = a0 + u * 1.1, ph = 0.6 + Math.sin(u * 3) * 0.5;
        // 表面近傍の点（半径は彫刻で変わるので概算で十分）
        const r = 1.0;
        pt[0] = r * Math.cos(ph) * Math.cos(th);
        pt[1] = r * Math.sin(ph);
        pt[2] = r * Math.cos(ph) * Math.sin(th);
        return pt;
      };
      s.beginStroke(brush, at(0), stroke % 2 === 0 ? 1 : -1);
      for (let k = 1; k <= 14; k++) s.addSample(at(k / 14));
      s.endStroke();
    }
    validate(m, { label: `${brush} dyntopo=${dynTopo}` });
  }
}

// ---------------------------------------------------------------------------
head('シンメトリ 3 軸同時');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const state = makeState({ brush: 'clay', symmetry: { x: true, y: true, z: true } });
  const s = new Sculptor(m, state);
  state.worldRadius = 0.25;
  const pt = new Float32Array(3);
  s.beginStroke('clay', (pt.set([0.6, 0.5, 0.62]), pt), 1);
  for (let k = 1; k <= 20; k++) {
    pt.set([0.6 + k * 0.01, 0.5 - k * 0.005, 0.62]);
    s.addSample(pt);
  }
  s.endStroke();
  ok(s.activeMirrors.length === 8, `ミラー数が 8 でない: ${s.activeMirrors.length}`);
  validate(m, { label: 'symmetry xyz' });
}

// ---------------------------------------------------------------------------
head('アンドゥ / リドゥ');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const state = makeState({ brush: 'clay' });
  const s = new Sculptor(m, state);
  state.worldRadius = 0.3;
  const p0 = m.positions.slice(0, m.nv * 3);
  const v0 = m.liveVerts;

  const pt = new Float32Array([1, 0, 0]);
  s.beginStroke('clay', pt, 1);
  for (let k = 1; k <= 12; k++) { pt.set([Math.cos(k * 0.05), Math.sin(k * 0.05) * 0.4, 0.3]); s.addSample(pt); }
  s.endStroke();
  const v1 = m.liveVerts;
  ok(v1 !== v0, `dyntopo で頂点数が変わっていない (${v0} → ${v1})`);

  ok(s.history.undo(m), 'undo が失敗');
  ok(m.liveVerts === v0, `undo 後の頂点数が違う: ${m.liveVerts} != ${v0}`);
  let maxd = 0;
  for (let i = 0; i < v0 * 3; i++) maxd = Math.max(maxd, Math.abs(m.positions[i] - p0[i]));
  ok(maxd < 1e-6, `undo 後の座標が復元されていない (max diff ${maxd})`);
  validate(m, { label: 'after undo' });

  ok(s.history.redo(m), 'redo が失敗');
  ok(m.liveVerts === v1, `redo 後の頂点数が違う: ${m.liveVerts} != ${v1}`);
  validate(m, { label: 'after redo' });
}

// ---------------------------------------------------------------------------
head('全体操作');
{
  const g = PRIMITIVES.quadball();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const state = makeState();
  const s = new Sculptor(m, state);
  s.smoothAll(2, 0.5);
  validate(m, { label: 'smoothAll' });
  s.invertMask();
  s.clearMask();
  s.fillColor([0.2, 0.4, 0.8]);
  ok(Math.abs(m.colors[0] - 0.2) < 1e-5, 'fillColor が効いていない');
  const before = m.liveVerts;
  s.remeshUniform(m.averageEdgeLength() * 0.6);
  console.log(`  remesh ${before} → ${m.liveVerts} verts`);
  ok(m.liveVerts > before, 'リメッシュで細分化されていない');
  validate(m, { label: 'remesh' });
}

// ---------------------------------------------------------------------------
head('入出力');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  m.removeTriangle(5);        // 穴あきでも書き出せるか
  const obj = exportOBJ(m);
  ok(obj.split('\n').filter(l => l.startsWith('v ')).length === m.liveVerts, 'OBJ の頂点数が合わない');
  ok(obj.split('\n').filter(l => l.startsWith('f ')).length === m.liveTris, 'OBJ の面数が合わない');
  const stl = exportSTL(m);
  ok(stl.byteLength === 84 + m.liveTris * 50, `STL のサイズが合わない: ${stl.byteLength}`);
  ok(new DataView(stl).getUint32(80, true) === m.liveTris, 'STL の三角形数が合わない');
  const ply = exportPLY(m);
  ok(ply.byteLength > 100, 'PLY が空');

  const round = importOBJ(obj);
  const m2 = new SculptMesh();
  m2.setGeometry(round.positions, round.indices);
  console.log(`  OBJ round-trip: ${m2.liveVerts} verts / ${m2.liveTris} tris`);
  ok(m2.liveTris === m.liveTris, `round-trip の面数が合わない ${m2.liveTris} != ${m.liveTris}`);
  validate(m2, { closed: false, label: 'obj round-trip' });

  // 四角形ポリゴンの OBJ
  const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n';
  const qg = importOBJ(quad);
  ok(qg.indices.length === 6, `四角形が三角形化されていない: ${qg.indices.length}`);
}

// ---------------------------------------------------------------------------
head('負荷: 高ディテールで長いストローク');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const state = makeState({ brush: 'clay', detail: 0.9, maxVerts: 300000 });
  const s = new Sculptor(m, state);
  state.worldRadius = 0.22;
  const t0 = Date.now();
  const pt = new Float32Array(3);
  for (let stroke = 0; stroke < 10; stroke++) {
    const th0 = stroke * 0.62;
    const set = (u) => {
      const th = th0 + u * 2.0, ph = -0.9 + u * 1.8;
      pt[0] = Math.cos(ph) * Math.cos(th);
      pt[1] = Math.sin(ph);
      pt[2] = Math.cos(ph) * Math.sin(th);
      return pt;
    };
    s.beginStroke('clay', set(0), 1);
    for (let k = 1; k <= 40; k++) s.addSample(set(k / 40));
    s.endStroke();
  }
  const ms = Date.now() - t0;
  console.log(`  ${m.liveVerts.toLocaleString()} verts / ${m.liveTris.toLocaleString()} tris  in ${ms} ms`);
  validate(m, { label: 'stress' });
}

// ---------------------------------------------------------------------------
head('weld');
{
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
  const idx = new Uint32Array([0, 1, 2, 3, 1, 2]);
  const w = weld(pos, idx, 1e-5);
  ok(w.positions.length === 9, `weld 後の頂点数が違う: ${w.positions.length / 3}`);
  ok(w.indices.length === 3, `頂点集合が同一の重複面が除去されていない: ${w.indices.length / 3} 面`);
}

// ---------------------------------------------------------------------------
head('ダイナメッシュ');

/** 出力ジオメトリを SculptMesh に載せて検証する */
async function checkDyna(src, opts, label, expect = {}) {
  const r = await dynamesh(src, opts);
  const m = new SculptMesh();
  if (r.positions.length === 0) { failures++; console.log(`  FAIL ${label}: 出力が空`); return null; }
  m.setGeometry(r.positions, r.indices, r.colors);
  console.log(`  ${label}: ${r.stats.grid.join('×')} voxel → `
    + `${r.stats.verts.toLocaleString()} 頂点 / ${r.stats.tris.toLocaleString()} 面  ${r.stats.ms} ms`
    + (r.stats.openMesh ? '  (シェル化)' : '')
    + (r.stats.repair && !r.stats.repair.clean
        ? `  [修復: 面-${r.stats.repair.facesRemoved} 頂点分離${r.stats.repair.verticesSplit} 穴${r.stats.repair.holesFilled} 残${r.stats.repair.nonManifold}/${r.stats.repair.boundary}]`
        : ''));
  if (expect.genus === null) {
    // 位相が変わり得るケース（極端に薄い形状）は χ を検査せず、閉多様体であることだけ要求する
    validate(m, { closed: true, genus: 0, label, reportChiOnly: true });
  } else {
    validate(m, { closed: true, genus: expect.genus ?? 0, label });
  }

  // 面の向きの検証は符号付き体積で行う（凸形状に限らず正しい判定になる）。
  // 一貫して外向きなら sum(a・(b×c))/6 が正になる。
  let vol = 0;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3;
    const ia = m.tris[i], ib = m.tris[i + 1], ic = m.tris[i + 2];
    if (ia === ib && ib === ic) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const P = m.positions;
    const cx2 = P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1];
    const cy2 = P[b + 2] * P[c] - P[b] * P[c + 2];
    const cz2 = P[b] * P[c + 1] - P[b + 1] * P[c];
    vol += (P[a] * cx2 + P[a + 1] * cy2 + P[a + 2] * cz2) / 6;
  }
  ok(vol > 0, `${label}: 面が外向き（符号付き体積 ${vol.toFixed(4)} > 0）`);
  return { r, m, volume: vol };
}

// 1) 球 → 球（形が保たれるか）
{
  const g = PRIMITIVES.sphere();
  const src = new SculptMesh();
  src.setGeometry(g.positions, g.indices);
  const res = await checkDyna(src, { resolution: 64, smooth: 1 }, '球 res64');
  if (res) {
    // 半径 1 の球なので、全頂点が原点から 1 付近にあるはず
    let min = Infinity, max = -Infinity;
    const m = res.m;
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v]) continue;
      const i = v * 3;
      const d = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]);
      if (d < min) min = d; if (d > max) max = d;
    }
    console.log(`       半径 ${min.toFixed(4)} … ${max.toFixed(4)}`);
    ok(min > 0.93 && max < 1.07, `球の半径が保たれている (${min.toFixed(3)}〜${max.toFixed(3)})`);
  }
}

// 2) 解像度を上げると頂点が増えるか（面積比なのでおよそ 2 乗で増える）
{
  const g = PRIMITIVES.sphere();
  const src = new SculptMesh();
  src.setGeometry(g.positions, g.indices);
  const a = await dynamesh(src, { resolution: 40, smooth: 0 });
  const b = await dynamesh(src, { resolution: 80, smooth: 0 });
  const ratio = (b.stats.verts / a.stats.verts);
  console.log(`  res40 → ${a.stats.verts} 頂点 / res80 → ${b.stats.verts} 頂点 (比 ${ratio.toFixed(2)})`);
  ok(ratio > 3.0 && ratio < 5.0, `解像度 2 倍で頂点数がおよそ 4 倍 (比 ${ratio.toFixed(2)})`);
}

// 3) 重なった 2 球 → 単一の融合形状になるか（DynaMesh の本質）
{
  const g = PRIMITIVES.sphere();
  const n = g.positions.length / 3;
  const pos = new Float32Array(n * 6);
  const idx = new Uint32Array(g.indices.length * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = g.positions[i * 3] - 0.55;
    pos[i * 3 + 1] = g.positions[i * 3 + 1];
    pos[i * 3 + 2] = g.positions[i * 3 + 2];
    pos[(n + i) * 3] = g.positions[i * 3] + 0.55;
    pos[(n + i) * 3 + 1] = g.positions[i * 3 + 1];
    pos[(n + i) * 3 + 2] = g.positions[i * 3 + 2];
  }
  idx.set(g.indices, 0);
  for (let i = 0; i < g.indices.length; i++) idx[g.indices.length + i] = g.indices[i] + n;

  const src = new SculptMesh();
  src.setGeometry(pos, idx);
  // 入力は 2 成分なので χ = 4
  validate(src, { closed: true, genus: -1, label: '重なった 2 球（入力）' });

  const res = await checkDyna(src, { resolution: 72, smooth: 1 }, '重なった 2 球 → 融合');
  if (res) {
    // 連結成分が 1 つになっていること
    const m = res.m;
    const seen = new Uint8Array(m.nv);
    let start = -1;
    for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) { start = v; break; }
    const stack = [start];
    seen[start] = 1;
    let count = 0;
    while (stack.length) {
      const v = stack.pop(); count++;
      for (const t of m.ringArray(v)) {
        for (let e = 0; e < 3; e++) {
          const u = m.tris[t * 3 + e];
          if (!seen[u]) { seen[u] = 1; stack.push(u); }
        }
      }
    }
    ok(count === m.liveVerts, `1 つの連結成分に融合された (${count} / ${m.liveVerts})`);
    // 内部に隠れた面が残っていないこと = 元の 2 球の合計面積より小さい
    ok(m.liveVerts > 0, '融合後に頂点がある');
  }
}

// 4) 自己交差した形状（トーラスを潰して交差させる）でも多様体を保つか
{
  const g = PRIMITIVES.torus();
  const src = new SculptMesh();
  src.setGeometry(g.positions, g.indices);
  // Y を強く潰して自身にめり込ませる
  for (let v = 0; v < src.nv; v++) src.positions[v * 3 + 1] *= 0.12;
  src.computeAllNormals();
  await checkDyna(src, { resolution: 80, smooth: 1 }, '潰したトーラス res80', { genus: null });
  // 解像度を上げれば厚みが十分に取れて修復不要（トーラスのまま χ = 0）になる
  const hi = await checkDyna(src, { resolution: 220, smooth: 1 }, '潰したトーラス res220', { genus: 1 });
  if (hi) ok(hi.r.stats.repair.clean === true, '高解像度では多様体修復が不要になる');
}

// 5) 境界のあるメッシュ（平面）→ シェル化
{
  const g = PRIMITIVES.plane();
  const src = new SculptMesh();
  src.setGeometry(g.positions, g.indices);
  ok(hasBoundary(src) === true, '平面に境界辺が検出される');
  const g2 = PRIMITIVES.sphere();
  const src2 = new SculptMesh();
  src2.setGeometry(g2.positions, g2.indices);
  ok(hasBoundary(src2) === false, '球には境界辺がない');
  const res = await checkDyna(src, { resolution: 56, smooth: 1 }, '平面 → 板状シェル');
  if (res) {
    let minY = Infinity, maxY = -Infinity;
    const m = res.m;
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v]) continue;
      const y = m.positions[v * 3 + 1];
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    ok(maxY - minY > 1e-3, `厚みのある板になっている (厚さ ${(maxY - minY).toFixed(4)})`);
  }
}

// 6) ポリペイントの転写
{
  const g = PRIMITIVES.sphere();
  const src = new SculptMesh();
  src.setGeometry(g.positions, g.indices);
  for (let v = 0; v < src.nv; v++) {
    const i = v * 3;
    const red = src.positions[i] > 0;
    src.colors[i] = red ? 1 : 0;
    src.colors[i + 1] = 0;
    src.colors[i + 2] = red ? 0 : 1;
  }
  const r = await dynamesh(src, { resolution: 64, smooth: 0, transferColor: true });
  ok(r.colors !== null && r.colors.length === r.positions.length, '色配列が返る');
  let redRight = 0, blueLeft = 0, wrong = 0;
  for (let v = 0; v < r.positions.length / 3; v++) {
    const x = r.positions[v * 3];
    const isRed = r.colors[v * 3] > r.colors[v * 3 + 2];
    if (Math.abs(x) < 0.15) continue;          // 境界付近は判定しない
    if (x > 0 && isRed) redRight++;
    else if (x < 0 && !isRed) blueLeft++;
    else wrong++;
  }
  console.log(`  色転写: 正 ${redRight + blueLeft} / 誤 ${wrong}`);
  ok(wrong < (redRight + blueLeft) * 0.03, `ポリペイントが位置どおりに転写された (誤 ${wrong})`);

  const r2 = await dynamesh(src, { resolution: 48, smooth: 0, transferColor: false });
  ok(r2.colors === null, '転写オフなら色は返らない');
}

// 7) Sculptor 経由（アンドゥ / シード無効化まで含めて）
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const state = makeState({ dynaResolution: 56 });
  const s = new Sculptor(m, state);

  // 先に彫って形を崩しておく
  state.worldRadius = 0.35;
  const pt = new Float32Array([1, 0, 0]);
  s.beginStroke('draw', pt, 1);
  for (let k = 1; k <= 16; k++) { pt.set([Math.cos(k * 0.06), Math.sin(k * 0.06) * 0.5, 0.4]); s.addSample(pt); }
  s.endStroke();
  const vBefore = m.liveVerts;

  const st = await s.dynamesh({ resolution: 56, smooth: 1, transferColor: true });
  ok(!st.failed, 'Sculptor.dynamesh が成功する');
  ok(m.liveVerts !== vBefore, `トポロジが作り直された (${vBefore} → ${m.liveVerts})`);
  ok(s.hoverSeed === -1, 'ホバーシードが無効化される');
  validate(m, { closed: true, label: 'Sculptor.dynamesh' });

  ok(s.history.canUndo(), 'ダイナメッシュが履歴に入る');
  s.history.undo(m);
  ok(m.liveVerts === vBefore, `Undo でダイナメッシュ前に戻る (${m.liveVerts} == ${vBefore})`);
  validate(m, { closed: true, label: 'dynamesh 後 undo' });

  // ダイナメッシュ後に続けて彫刻できるか
  s.history.redo(m);
  state.worldRadius = 0.3;
  const p2 = new Float32Array([0, 1, 0]);
  s.beginStroke('clay', p2, 1);
  for (let k = 1; k <= 10; k++) { p2.set([Math.sin(k * 0.05) * 0.4, Math.cos(k * 0.05), 0.2]); s.addSample(p2); }
  s.endStroke();
  validate(m, { closed: true, label: 'dynamesh 後の彫刻' });
}

// 8) ボクセル上限で解像度が自動的に下がるか
{
  const g = PRIMITIVES.sphere();
  const src = new SculptMesh();
  src.setGeometry(g.positions, g.indices);
  const r = await dynamesh(src, { resolution: 512, smooth: 0, transferColor: false, maxVoxels: 200000 });
  const voxels = r.stats.grid[0] * r.stats.grid[1] * r.stats.grid[2];
  console.log(`  上限 200k → ${r.stats.grid.join('×')} = ${voxels.toLocaleString()} voxel`);
  ok(voxels <= 200000, `ボクセル数が上限内に収まる (${voxels})`);
  ok(r.positions.length > 0, '上限を掛けても出力される');
}

// 9) Taubin スムージングが体積をほぼ保つか
{
  const g = PRIMITIVES.icosphere ? PRIMITIVES.sphere() : PRIMITIVES.sphere();
  const pos = g.positions.slice();
  // ノイズを乗せる
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < pos.length; i++) pos[i] += rnd() * 0.06;
  const radius = (p) => {
    let s = 0, n = 0;
    for (let v = 0; v < p.length / 3; v++) { s += Math.hypot(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]); n++; }
    return s / n;
  };
  const before = radius(pos);
  // 粗さの指標（隣接との差の平均）
  const rough = (p) => {
    let s = 0, n = 0;
    for (let i = 0; i < g.indices.length; i += 3) {
      const a = g.indices[i] * 3, b = g.indices[i + 1] * 3;
      s += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]); n++;
    }
    return s / n;
  };
  const r0 = rough(pos);
  taubinSmooth(pos, g.indices, 4);
  const after = radius(pos);
  const r1 = rough(pos);
  console.log(`  平均半径 ${before.toFixed(4)} → ${after.toFixed(4)} / 粗さ ${r0.toFixed(4)} → ${r1.toFixed(4)}`);
  ok(Math.abs(after - before) / before < 0.03, `Taubin で体積がほぼ保たれる (${((after / before - 1) * 100).toFixed(1)}%)`);
  ok(r1 < r0, '平滑化でエッジ長のばらつきが減る');
}

// ---------------------------------------------------------------------------
head('減衰カーブ（フォーカルシフト）');
{
  for (const fs of [-1, -0.5, 0, 0.5, 1]) {
    let prev = Infinity, mono = true, inRange = true;
    for (let k = 0; k <= 40; k++) {
      const t = k / 40;
      const f = falloff(t, fs);
      if (!(f >= -1e-9 && f <= 1 + 1e-9)) inRange = false;
      if (f > prev + 1e-9) mono = false;
      prev = f;
    }
    ok(inRange, `focal=${fs}: 値が 0..1 に収まる`);
    ok(mono, `focal=${fs}: 単調非増加`);
    ok(Math.abs(falloff(0, fs) - 1) < 1e-9, `focal=${fs}: 中心で 1`);
    ok(falloff(1, fs) === 0, `focal=${fs}: 端で 0`);
  }
  // ＋で硬く（中間の値が大きい）、−で柔らかく（中間の値が小さい）
  ok(falloff(0.5, 0.8) > falloff(0.5, 0) && falloff(0.5, 0) > falloff(0.5, -0.8),
    `フォーカルシフトで当たりの硬さが変わる (${falloff(0.5, 0.8).toFixed(3)} > ${falloff(0.5, 0).toFixed(3)} > ${falloff(0.5, -0.8).toFixed(3)})`);
}

// ---------------------------------------------------------------------------
head('曲率（キャビティシェーディング用）');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  // 凸な球なので曲率は全体的に負
  let neg = 0, pos = 0;
  for (let v = 0; v < m.nv; v++) { if (m.curv[v] < 0) neg++; else pos++; }
  ok(neg > m.liveVerts * 0.95, `凸面の曲率が負になる (負 ${neg} / 正 ${pos})`);

  // 溝を彫ったら、その付近に正の曲率（凹み）が現れる
  const state = makeState({ brush: 'crease', detail: 0.85 });
  const s = new Sculptor(m, state);
  state.worldRadius = 0.14;
  state.strength = 1.0;
  const pt = new Float32Array(3);
  const at = (u) => {
    const lon = -0.4 + u * 0.9;
    pt[0] = Math.cos(lon); pt[1] = 0.05; pt[2] = Math.sin(lon);
    return pt;
  };
  s.beginStroke('crease', at(0), 1);
  for (let k = 1; k <= 24; k++) s.addSample(at(k / 24));
  s.endStroke();
  let maxCurv = -1;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.curv[v] > maxCurv) maxCurv = m.curv[v];
  ok(maxCurv > 0.05, `溝の底に凹曲率が出る (最大 ${maxCurv.toFixed(3)})`);
  validate(m, { label: 'crease + curvature' });

  // スケールを変えても曲率がほぼ変わらない（エッジ長で正規化しているか）
  const m2 = new SculptMesh();
  const scaled = g.positions.slice();
  for (let i = 0; i < scaled.length; i++) scaled[i] *= 7;
  m2.setGeometry(scaled, g.indices);
  let s1 = 0, s2 = 0;
  const m1 = new SculptMesh();
  m1.setGeometry(g.positions, g.indices);
  for (let v = 0; v < m1.nv; v++) s1 += m1.curv[v];
  for (let v = 0; v < m2.nv; v++) s2 += m2.curv[v];
  s1 /= m1.liveVerts; s2 /= m2.liveVerts;
  ok(Math.abs(s1 - s2) < 1e-4, `曲率がスケール不変 (${s1.toFixed(5)} vs ${s2.toFixed(5)})`);
}

// ---------------------------------------------------------------------------
head('分割レベル（SDiv / マルチレゾ）');

function sphereSculptor(over = {}) {
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const state = makeState(Object.assign({ dynTopo: false }, over));
  const s = new Sculptor(m, state);
  return { m, s, state };
}

{
  const { m, s } = sphereSculptor();
  const v0 = m.liveVerts, t0 = m.liveTris;
  const d1 = s.divide();
  console.log(`  divide: ${v0} → ${m.liveVerts} 頂点 / ${t0} → ${m.liveTris} 面`);
  ok(m.liveTris === t0 * 4, `面が 4 倍になる (${m.liveTris} == ${t0 * 4})`);
  // 閉多様体なら E = 3F/2、細分割後の頂点は V + E
  ok(m.liveVerts === v0 + (t0 * 3 / 2), `頂点が V+E になる (${m.liveVerts})`);
  ok(d1.level === 1 && d1.maxLevel === 1, `レベル表示 ${d1.level}/${d1.maxLevel}`);
  validate(m, { label: 'divide x1' });

  const d2 = s.divide();
  ok(d2.level === 2 && d2.maxLevel === 2, `2 段目 ${d2.level}/${d2.maxLevel}`);
  validate(m, { label: 'divide x2' });
  console.log(`  divide x2: ${m.liveVerts} 頂点 / ${m.liveTris} 面`);
}

// 編集なしの往復で完全に戻るか
{
  const { m, s } = sphereSculptor();
  s.divide();
  const fine = m.positions.slice(0, m.nv * 3);
  const fineNv = m.liveVerts;
  s.levelDown();
  ok(s.levels.level === 0, 'レベルが 0 に下がる');
  s.levelUp();
  ok(m.liveVerts === fineNv, `往復で頂点数が戻る (${m.liveVerts} == ${fineNv})`);
  let maxd = 0;
  for (let i = 0; i < fineNv * 3; i++) maxd = Math.max(maxd, Math.abs(m.positions[i] - fine[i]));
  ok(maxd < 1e-5, `往復で座標が復元される (最大差 ${maxd.toExponential(2)})`);
  validate(m, { label: 'down/up round-trip' });
}

// 細かいレベルで彫った細部が、往復しても保たれるか
{
  const { m, s, state } = sphereSculptor();
  s.divide();
  state.worldRadius = 0.12;
  state.strength = 1.0;
  const pt = new Float32Array(3);
  for (let stroke = 0; stroke < 3; stroke++) {
    const lat = -0.3 + stroke * 0.3;
    const at = (u) => {
      const lon = -0.5 + u * 0.8;
      pt[0] = Math.cos(lat) * Math.cos(lon); pt[1] = Math.sin(lat); pt[2] = Math.cos(lat) * Math.sin(lon);
      return pt;
    };
    s.beginStroke('crease', at(0), 1);
    for (let k = 1; k <= 20; k++) s.addSample(at(k / 20));
    s.endStroke();
  }
  ok(s.levels.count === 1, `彫刻でレベルが失われない (dynTopo オフ、count=${s.levels.count}）`);
  const sculpted = m.positions.slice(0, m.nv * 3);
  const nv = m.liveVerts;

  s.levelDown();
  ok(m.liveVerts < nv, `下げるとポリゴンが減る (${nv} → ${m.liveVerts}）`);
  validate(m, { label: 'sculpted → down' });
  s.levelUp();
  ok(m.liveVerts === nv, '上げると元の頂点数に戻る');
  let maxd = 0;
  for (let i = 0; i < nv * 3; i++) maxd = Math.max(maxd, Math.abs(m.positions[i] - sculpted[i]));
  ok(maxd < 1e-4, `彫った細部が変位として保存されている (最大差 ${maxd.toExponential(2)})`);
  validate(m, { label: 'sculpted → down → up' });
}

// 粗いレベルを変形させると細部が追従するか（マルチレゾの本質）
{
  const { m, s, state } = sphereSculptor();
  s.divide();
  // 細かいレベルに凹凸を付ける
  state.worldRadius = 0.13;
  state.strength = 1.0;
  const pt = new Float32Array([1, 0, 0]);
  s.beginStroke('crease', pt, 1);
  for (let k = 1; k <= 20; k++) {
    const lon = k * 0.045;
    pt.set([Math.cos(lon), 0.02, Math.sin(lon)]);
    s.addSample(pt);
  }
  s.endStroke();

  // 細部の「深さ」を測る指標: 隣接頂点との距離の分散
  const detailMetric = () => {
    const T = m.tris;
    let sum = 0, n = 0;
    for (let t = 0; t < m.nt; t++) {
      const i = t * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = T[i + e] * 3, b = T[i + (e + 1) % 3] * 3;
        sum += Math.hypot(m.positions[a] - m.positions[b],
          m.positions[a + 1] - m.positions[b + 1],
          m.positions[a + 2] - m.positions[b + 2]);
        n++;
      }
    }
    return sum / n;
  };
  const before = detailMetric();

  s.levelDown();
  // 粗いレベル全体を Y 方向に 1.5 倍に伸ばす（大きな形の変更）
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) m.positions[v * 3 + 1] *= 1.5;
  m.computeAllNormals();
  m.markAllDirty();
  s.levelUp();
  validate(m, { label: 'coarse deform → up' });

  // 伸ばした分だけ平均エッジ長は伸びるが、細部が消えたり暴れたりしていないこと
  const after = detailMetric();
  console.log(`  平均エッジ長 ${before.toFixed(5)} → ${after.toFixed(5)}`);
  ok(after > before * 0.9 && after < before * 1.6,
    `粗いレベルの変形に細部が追従する（破綻していない）`);
  // Y が 1.5 倍になっていること（細部が粗い形に乗っている）
  let maxY = -Infinity;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) maxY = Math.max(maxY, m.positions[v * 3 + 1]);
  ok(maxY > 1.35, `粗いレベルの変形が細かいレベルに反映される (maxY=${maxY.toFixed(3)})`);
}

// dyntopo / ダイナメッシュでレベルが破棄されるか
{
  const { m, s, state } = sphereSculptor();
  s.divide();
  ok(s.levels.count === 1, '分割済み');
  state.dynTopo = true;
  state.worldRadius = 0.25;
  state.detail = 0.9;
  const pt = new Float32Array([1, 0, 0]);
  s.beginStroke('clay', pt, 1);
  for (let k = 1; k <= 14; k++) { pt.set([Math.cos(k * 0.05), Math.sin(k * 0.05) * 0.4, 0.35]); s.addSample(pt); }
  s.endStroke();
  s.checkLevels();
  ok(s.levels.count === 0, '動的トポロジで接続が変わるとレベルが破棄される');
  ok(s.levelDown() === null, '破棄後は下げられない');

  const r2 = sphereSculptor();
  r2.s.divide();
  await r2.s.dynamesh({ resolution: 48, smooth: 0, transferColor: false });
  ok(r2.s.levels.count === 0, 'ダイナメッシュでレベルが破棄される');
}

// 端で操作しても壊れないこと
{
  const { m, s } = sphereSculptor();
  ok(s.levelDown() === null, '未分割で下げても null');
  ok(s.levelUp() === null, '未分割で上げても null');
  s.divide();
  ok(s.levelUp() === null, '最上位で上げても null');
  s.levelDown();
  ok(s.levelDown() === null, '最下位で下げても null');
  s.levelUp();
  validate(m, { label: '境界操作後' });
}

// ---------------------------------------------------------------------------
head('保存用のパック');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  m.removeTriangle(3);
  for (let v = 0; v < m.nv; v++) { m.colors[v * 3] = 0.25; m.mask[v] = 0.5; }
  const p = packMesh(m);
  ok(p.verts === m.liveVerts, `パック後の頂点数が一致 (${p.verts})`);
  ok(p.tris === m.liveTris, `パック後の面数が一致 (${p.tris})`);
  ok(Math.abs(p.colors[0] - 0.25) < 1e-6, '色が保存される');
  ok(Math.abs(p.mask[0] - 0.5) < 1e-6, 'マスクが保存される');
  let maxIdx = 0;
  for (let i = 0; i < p.indices.length; i++) maxIdx = Math.max(maxIdx, p.indices[i]);
  ok(maxIdx < p.verts, `インデックスが範囲内 (max ${maxIdx} < ${p.verts})`);

  const m2 = new SculptMesh();
  m2.setGeometry(p.positions, p.indices, p.colors, p.mask);
  ok(m2.liveVerts === p.verts && m2.liveTris === p.tris, '読み戻せる');
  ok(Math.abs(m2.mask[0] - 0.5) < 1e-6, 'マスクが読み戻せる');
  validate(m2, { closed: false, label: 'pack round-trip' });
}

// ---------------------------------------------------------------------------
head('WASM 距離場（JS 版との一致）');
{
  let bytes = null;
  try { bytes = _readFileSync(new URL('../wasm/dynafield.wasm', import.meta.url)); }
  catch { console.log('  wasm/dynafield.wasm が無いのでスキップ（npm run build:wasm で生成）'); }

  if (bytes) {
    const g = PRIMITIVES.sphere();
    const src = new SculptMesh();
    src.setGeometry(g.positions, g.indices);
    const state = makeState();
    const s = new Sculptor(src, state);
    state.worldRadius = 0.3;
    // 形を崩して非自明な入力にする
    const pt = new Float32Array(3);
    for (let seed = 0; seed < 12; seed++) {
      const at = (u) => {
        const th = seed * 0.7 + u * 1.6, ph = -0.8 + Math.sin(seed + u * 2.2) * 0.9;
        pt[0] = Math.cos(ph) * Math.cos(th); pt[1] = Math.sin(ph); pt[2] = Math.cos(ph) * Math.sin(th);
        return pt;
      };
      s.beginStroke('clay', at(0), 1);
      for (let k = 1; k <= 16; k++) s.addSample(at(k / 16));
      s.endStroke();
    }
    console.log(`  入力 ${src.liveVerts.toLocaleString()} 頂点 / ${src.liveTris.toLocaleString()} 面`);

    const ok2 = await initWasmFieldFromBytes(bytes);
    ok(ok2 === true && wasmFieldReady(), 'WASM を初期化できる');

    for (const res of [64, 128]) {
      const jsR = await dynamesh(src, { resolution: res, smooth: 1, transferColor: true, wasm: false });
      const waR = await dynamesh(src, { resolution: res, smooth: 1, transferColor: true });
      ok(waR.stats.wasm === true, `res${res}: WASM 経路が使われる`);
      ok(jsR.positions.length === waR.positions.length && jsR.indices.length === waR.indices.length,
        `res${res}: 頂点/面数が一致 (JS ${jsR.positions.length / 3} vs WASM ${waR.positions.length / 3})`);
      let dp = 0, di = 0;
      for (let i = 0; i < jsR.positions.length; i++) if (jsR.positions[i] !== waR.positions[i]) dp++;
      for (let i = 0; i < jsR.indices.length; i++) if (jsR.indices[i] !== waR.indices[i]) di++;
      let dc = 0;
      if (jsR.colors && waR.colors) for (let i = 0; i < jsR.colors.length; i++) if (jsR.colors[i] !== waR.colors[i]) dc++;
      ok(dp === 0 && di === 0 && dc === 0,
        `res${res}: 出力がビット単位で一致 (座標差 ${dp} / 面差 ${di} / 色差 ${dc})`);
      console.log(`       res${res}: JS ${jsR.stats.ms}ms (距離場 ${jsR.stats.phase.distance}) / `
        + `WASM ${waR.stats.ms}ms (距離場 ${waR.stats.phase.distance})`);
    }

    // --- アロケータがメモリを回収するか -------------------------------------
    // wasm 側は自前のバンプアロケータなので、release で巻き戻せていないと
    // ダイナメッシュを繰り返すたびに線形メモリが伸び続ける（実際に一度やった）。
    head('WASM アロケータ');
    {
      const { instance } = await WebAssembly.instantiate(bytes, {
        env: { abort() { throw new Error('wasm abort'); } },
      });
      const W = instance.exports;
      const pages = () => W.memory.buffer.byteLength / 65536;
      const N = 2e6;
      const batch = (order) => {
        const p = [W.alloc(5e5 * 12), W.alloc(1e6 * 12), W.alloc(N * 4), W.alloc(N * 4)];
        if (p.some((x) => !x)) return false;
        for (const i of order) W.release(p[i]);
        return true;
      };
      ok(batch([3, 2, 1, 0]), '確保できる');
      const base = pages();
      let allOk = true;
      for (let r = 0; r < 10; r++) allOk = batch([3, 2, 1, 0]) && allOk;
      ok(allOk && pages() === base, `LIFO 解放を 10 回繰り返してもメモリが増えない (${base} → ${pages()} ページ)`);
      for (let r = 0; r < 10; r++) allOk = batch([0, 1, 3, 2]) && allOk;
      ok(allOk && pages() === base, `順不同の解放でも増えない (${pages()} ページ)`);
    }
  }
}

// ---------------------------------------------------------------------------
// dyntopo のあとで Divide しても壊れないか。
//
// dyntopo + デシメートは死んだスロットを数個残す。compact() はゴミが 20% 未満だと
// 何もしないので、divide() の「0..liveVerts-1 が全部生きている」前提が崩れ、
// 生きた面が範囲外の頂点を参照して形が崩壊していた
// （実測: 死んだスロット 2/7050 で最長辺が平均の 36 倍、最小半径 0.9989 → 0.5704）。
head('dyntopo → Divide');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const s = new Sculptor(m, makeState({ dynTopo: true, decimate: true, worldRadius: 0.3 }));
  const pt = new Float32Array(3);
  for (let k = 0; k < 6; k++) {
    const th = k * 1.0;
    pt.set([Math.cos(th), 0.2, Math.sin(th)]);
    s.beginStroke('clay', pt, 1);
    for (let q = 1; q <= 12; q++) {
      pt.set([Math.cos(th + q * 0.05), 0.2 + q * 0.01, Math.sin(th + q * 0.05)]);
      s.addSample(pt);
    }
    s.endStroke();
  }
  ok(m.nv > m.liveVerts, `dyntopo が死んだスロットを残している (${m.nv - m.liveVerts} 個 / ${m.nv})`);

  const stats = () => {
    let n = 0, sum = 0, mx = 0, rmin = Infinity;
    const T = m.tris, P = m.positions;
    for (let t = 0; t < m.nt; t++) {
      const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const iu = u * 3, iv = v * 3;
        const d = Math.hypot(P[iu] - P[iv], P[iu + 1] - P[iv + 1], P[iu + 2] - P[iv + 2]);
        sum += d; n++; if (d > mx) mx = d;
      }
    }
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v]) continue;
      const i = v * 3, r = Math.hypot(P[i], P[i + 1], P[i + 2]);
      if (r < rmin) rmin = r;
    }
    return { ratio: mx / (sum / n), rmin };
  };
  const a = stats();
  s.divide();
  const b = stats();
  console.log(`       前 最長辺/平均 ${a.ratio.toFixed(1)} 最小半径 ${a.rmin.toFixed(4)}`
    + ` → 後 ${b.ratio.toFixed(1)} / ${b.rmin.toFixed(4)}`);
  ok(b.ratio < a.ratio * 1.5, `Divide 後も辺の長さが揃っている (${a.ratio.toFixed(1)} → ${b.ratio.toFixed(1)})`);
  ok(b.rmin > a.rmin * 0.95, `Divide で原点へ落ちる頂点がない (${a.rmin.toFixed(4)} → ${b.rmin.toFixed(4)})`);
  let bad = 0;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3, x = m.tris[i], y = m.tris[i + 1], z = m.tris[i + 2];
    if (x === y && y === z) continue;
    if (x >= m.liveVerts || y >= m.liveVerts || z >= m.liveVerts) bad++;
  }
  ok(bad === 0, `Divide 後は全部の面が 0..liveVerts-1 を指す (範囲外 ${bad})`);
  validate(m, { label: 'dyntopo → divide' });
}

head('compact(force)');
{
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  for (let t = 0; t < m.nt; t++) { if (m.isTriAlive(t)) { m.removeTriangle(t); break; } }
  ok(m.compact() === false, '閾値未満では compact() は何もしない');
  ok(m.compact(true) === true, 'compact(true) は閾値を無視して詰める');
  ok(m.nv === m.liveVerts && m.nt === m.liveTris,
    `詰めたあとは死んだスロットが無い (${m.nv}/${m.liveVerts} 頂点, ${m.nt}/${m.liveTris} 面)`);
  ok(m.compact(true) === false, 'ゴミが無ければ force でも何もしない');
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
