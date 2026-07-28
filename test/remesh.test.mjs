// ---------------------------------------------------------------------------
// リメッシュ（ZRemesher 相当）の単体テスト。
//   node test/remesh.test.mjs
// ---------------------------------------------------------------------------

import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { Sculptor } from '../js/sculptor.js';
import { remesh, quadDominant, edgeLengthForTris, SurfaceRef } from '../js/remesh.js';

let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.log('  FAIL: ' + m); } else console.log('  ok   ' + m); };
const head = (t) => console.log('\n== ' + t + ' ==');

const state = (over = {}) => Object.assign({
  brush: 'clay', radiusPx: 90, strength: 0.9, paintColor: [.6, .2, .15], worldRadius: 0.3,
  dynTopo: false, decimate: false, detail: 0.55, maxVerts: 2000000,
  symmetry: { x: false, y: false, z: false }, radial: { on: false, count: 6, axis: 1 },
  localSymmetry: false, focalShift: 0, backfaceMask: false, strokeBudgetMs: 0,
  alpha: '', stroke: 'dots', strokeParams: null, dabSpacing: 0.06,
}, over);

/** 多様体性とオイラー標数 */
const manifold = (m) => {
  const em = new Map();
  const T = m.tris;
  let degen = 0;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    if (a === b || b === c || c === a) { degen++; continue; }
    for (let e = 0; e < 3; e++) {
      const x = [a, b, c][e], y = [a, b, c][(e + 1) % 3];
      const k = x < y ? x + ':' + y : y + ':' + x;
      em.set(k, (em.get(k) || 0) + 1);
    }
  }
  let bad = 0, bnd = 0;
  for (const n of em.values()) { if (n === 1) bnd++; else if (n !== 2) bad++; }
  return { bad, bnd, degen, chi: m.liveVerts - em.size + m.liveTris };
};

/** 辺長の統計 */
const edgeStats = (m) => {
  const P = m.positions, T = m.tris;
  let n = 0, sum = 0, mn = Infinity, mx = 0, sq = 0;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const ix = x * 3, iy = y * 3;
      const d = Math.hypot(P[ix] - P[iy], P[ix + 1] - P[iy + 1], P[ix + 2] - P[iy + 2]);
      sum += d; sq += d * d; n++;
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
  }
  const avg = sum / n;
  return { avg, min: mn, max: mx, cv: Math.sqrt(sq / n - avg * avg) / avg };
};

/** 価数の分布 */
const valence = (m) => {
  const h = new Map();
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const k = m.valence(v);
    h.set(k, (h.get(k) || 0) + 1);
  }
  let good = 0, total = 0;
  for (const [k, n] of h) { total += n; if (k >= 5 && k <= 7) good += n; }
  return { hist: [...h.entries()].sort((a, b) => a[0] - b[0]), goodRatio: good / total };
};

/** 元の形からのずれ（サンプル点から元の表面までの距離） */
const deviation = (m, ref) => {
  const P = m.positions;
  const out = new Float64Array(3);
  let worst = 0, sum = 0, n = 0;
  const step = Math.max(1, Math.floor(m.nv / 400));
  for (let v = 0; v < m.nv; v += step) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (!ref.closest(P[i], P[i + 1], P[i + 2], out)) continue;
    const d = Math.hypot(P[i] - out[0], P[i + 1] - out[1], P[i + 2] - out[2]);
    sum += d; n++;
    if (d > worst) worst = d;
  }
  return { worst, avg: sum / Math.max(1, n) };
};

const snapshotOf = (m) => {
  const remap = new Int32Array(m.nv).fill(-1);
  let nv = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) remap[v] = nv++;
  const P = new Float32Array(nv * 3);
  for (let v = 0; v < m.nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    P[r * 3] = m.positions[v * 3]; P[r * 3 + 1] = m.positions[v * 3 + 1]; P[r * 3 + 2] = m.positions[v * 3 + 2];
  }
  const I = new Int32Array(m.liveTris * 3);
  let w = 0;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3, a = m.tris[i], b = m.tris[i + 1], c = m.tris[i + 2];
    if (a === b && b === c) continue;
    I[w++] = remap[a]; I[w++] = remap[b]; I[w++] = remap[c];
  }
  return { positions: P, indices: I.subarray(0, w) };
};

const build = (kind, divides = 0) => {
  const g = PRIMITIVES[kind]();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const s = new Sculptor(m, state());
  for (let i = 0; i < divides; i++) s.divide();
  return { m, s };
};

head('目標エッジ長の逆算');
{
  // 半径 1 の球の表面積は 4π。そこから 5000 面ぶんのエッジ長を出して逆算が合うか
  const area = 4 * Math.PI;
  const L = edgeLengthForTris(area, 5000);
  const back = (4 * area) / (Math.sqrt(3) * L * L);
  ok(Math.abs(back - 5000) < 1, `面積とエッジ長の関係が整合する (${back.toFixed(0)} ≈ 5000)`);
  ok(edgeLengthForTris(0, 100) === 0 && edgeLengthForTris(1, 0) === 0, '不正な入力で 0 を返す');
}

head('SurfaceRef（表面への最近点）');
{
  const { m } = build('sphere');
  const s = snapshotOf(m);
  const ref = new SurfaceRef(s.positions, s.indices, m.averageEdgeLength());
  const out = new Float64Array(3);
  // 球の外の点は球面上へ落ちる
  ok(ref.closest(2, 0, 0, out), '球の外から最近点が引ける');
  const r = Math.hypot(out[0], out[1], out[2]);
  ok(Math.abs(r - 1) < 0.02, `落とした点が球面上にある (|p| = ${r.toFixed(4)})`);
  ok(Math.abs(out[1]) < 0.05 && Math.abs(out[2]) < 0.05,
    `方向が保たれる (${out[0].toFixed(3)}, ${out[1].toFixed(3)}, ${out[2].toFixed(3)})`);
  // 球面上の点はほぼそのまま
  const P = m.positions;
  ref.closest(P[0], P[1], P[2], out);
  const d = Math.hypot(P[0] - out[0], P[1] - out[1], P[2] - out[2]);
  ok(d < 1e-5, `表面上の点はほぼ動かない (${d.toExponential(1)})`);
}

head('等方リメッシュ（球）');
{
  const { m } = build('sphere', 1);
  const before = { verts: m.liveVerts, tris: m.liveTris, edges: edgeStats(m), val: valence(m) };
  const ref = new SurfaceRef(...(() => { const s = snapshotOf(m); return [s.positions, s.indices, m.averageEdgeLength()]; })());
  const r = remesh(m, { targetTris: 4000, iterations: 5, adaptive: 0, relax: 0.5 });
  ok(r.ok, 'リメッシュが走る');
  const after = { edges: edgeStats(m), val: valence(m) };
  console.log(`       ${before.tris} → ${m.liveTris} 面 / 目標 4000`
    + ` / 辺長 ${before.edges.avg.toFixed(4)} → ${after.edges.avg.toFixed(4)} (目標 ${r.targetLen.toFixed(4)})`
    + ` / ${r.ms}ms`);
  ok(Math.abs(m.liveTris - 4000) / 4000 < 0.35,
    `目標面数の ±35% に入る (${m.liveTris} / 4000)`);
  ok(Math.abs(after.edges.avg - r.targetLen) / r.targetLen < 0.25,
    `平均辺長が目標に近い (${after.edges.avg.toFixed(4)} / ${r.targetLen.toFixed(4)})`);
  // 入力（細分化した icosphere）は変動係数 0.065 という理想的な状態なので、
  // 「入力より良くなる」を要求するのは無理筋。等方リメッシュの実用域である
  // 絶対値で見る（Botsch-Kobbelt 系は 0.1〜0.2 に落ち着く）。
  ok(after.edges.cv < 0.25,
    `辺長がそろっている (変動係数 ${after.edges.cv.toFixed(3)} < 0.25、入力は ${before.edges.cv.toFixed(3)})`);
  const mf = manifold(m);
  ok(mf.bad === 0 && mf.bnd === 0 && mf.degen === 0,
    `閉多様体を保つ (非多様体 ${mf.bad} / 境界 ${mf.bnd} / 退化 ${mf.degen})`);
  ok(mf.chi === 2, `オイラー標数が 2 (${mf.chi})`);
  ok(after.val.goodRatio > 0.9,
    `価数 5〜7 の頂点が 90% 以上 (${(after.val.goodRatio * 100).toFixed(1)}% / 分布 ${after.val.hist.map(([k, n]) => k + ':' + n).join(' ')})`);
  const dev = deviation(m, ref);
  ok(dev.worst < r.targetLen * 0.6,
    `形が保たれる (最大ずれ ${dev.worst.toFixed(5)} = 目標辺長の ${(dev.worst / r.targetLen * 100).toFixed(0)}%)`);
  let nan = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) if (!Number.isFinite(m.positions[v * 3 + k])) nan++;
  }
  ok(nan === 0, `NaN が無い (${nan})`);
}

head('等方リメッシュ（彫った形）');
{
  const { m, s } = build('sphere', 1);
  const pt = new Float32Array(3);
  for (let k = 0; k < 4; k++) {
    const th = k * 1.4;
    pt.set([Math.cos(th), 0.3, Math.sin(th)]);
    s.beginStroke('clay', pt, 1);
    for (let q = 1; q <= 10; q++) { pt.set([Math.cos(th + q * 0.05), 0.3 + q * 0.01, Math.sin(th + q * 0.05)]); s.addSample(pt); }
    s.endStroke();
  }
  const ref = new SurfaceRef(...(() => { const sn = snapshotOf(m); return [sn.positions, sn.indices, m.averageEdgeLength()]; })());
  const t0 = m.liveTris;
  const r = remesh(m, { targetTris: 6000, iterations: 5, adaptive: 0, relax: 0.5 });
  console.log(`       ${t0} → ${m.liveTris} 面 / ${r.ms}ms`);
  ok(r.ok && m.liveTris > 0, 'リメッシュが走る');
  const mf = manifold(m);
  ok(mf.bad === 0 && mf.bnd === 0 && mf.degen === 0,
    `閉多様体を保つ (非多様体 ${mf.bad} / 境界 ${mf.bnd} / 退化 ${mf.degen})`);
  const dev = deviation(m, ref);
  ok(dev.worst < r.targetLen * 1.2,
    `彫った形も保たれる (最大ずれ ${dev.worst.toFixed(5)} = 目標辺長の ${(dev.worst / r.targetLen * 100).toFixed(0)}%)`);
  const v = valence(m);
  ok(v.goodRatio > 0.85, `価数 5〜7 が 85% 以上 (${(v.goodRatio * 100).toFixed(1)}%)`);
}

head('曲率適応');
{
  // 箱で比べる。平らな面は曲率 0、稜線と角は曲率が高いので差がはっきり出る。
  // 球に溝を彫った形でも試したが、溝が目標辺長より細くて曲率差がほとんど付かず
  // （0.043 対 0.037）判定にならなかった。
  const run = (adaptive) => {
    const { m } = build('cube', 2);
    const r = remesh(m, { targetTris: 5000, iterations: 6, adaptive, relax: 0.5 });
    // 曲率の高い頂点まわりの平均辺長と、低い頂点まわりの平均辺長を比べる
    // 曲率のしきい値を決め打ちすると片方が 0 本になる（実際になった）。
    // 曲率の上位／下位 3 分の 1 で比べれば必ず本数が確保できる。
    const P = m.positions, T = m.tris;
    const rows = [];
    for (let t = 0; t < m.nt; t++) {
      const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        const ix = x * 3, iy = y * 3;
        const d = Math.hypot(P[ix] - P[iy], P[ix + 1] - P[iy + 1], P[ix + 2] - P[iy + 2]);
        const k = (Math.abs(m.curv[x]) + Math.abs(m.curv[y])) * 0.5;
        rows.push({ d, k });
      }
    }
    rows.sort((p, q) => q.k - p.k);
    const third = Math.max(1, Math.floor(rows.length / 3));
    const hiArr = rows.slice(0, third), loArr = rows.slice(-third);
    const meanD = (arr) => arr.reduce((acc, x) => acc + x.d, 0) / arr.length;
    const meanK = (arr) => arr.reduce((acc, x) => acc + x.k, 0) / arr.length;
    return {
      r, hi: meanD(hiArr), lo: meanD(loArr),
      hiK: meanK(hiArr), loK: meanK(loArr),
      hiN: hiArr.length, loN: loArr.length, tris: m.liveTris, m,
    };
  };
  const off = run(0);
  const on = run(0.8);
  const line = (l, x) => `       ${l}: 曲率上位1/3 の辺長 ${x.hi.toFixed(4)} / 下位 ${x.lo.toFixed(4)}`
    + ` （曲率 ${x.hiK.toFixed(3)} vs ${x.loK.toFixed(3)}、${x.tris} 面）`;
  console.log(line('適応なし', off));
  console.log(line('適応あり', on));
  ok(on.hiN > 20 && on.loN > 20, `比較できる本数がある (高 ${on.hiN} / 低 ${on.loN})`);
  ok(on.hi / on.lo < off.hi / off.lo,
    `適応で曲率の高い所が相対的に細かくなる (比 ${(off.hi / off.lo).toFixed(3)} → ${(on.hi / on.lo).toFixed(3)})`);
  const mf = manifold(on.m);
  ok(mf.bad === 0 && mf.bnd === 0, `適応ありでも閉多様体 (${mf.bad} / ${mf.bnd})`);
}

head('目標面数の追従');
{
  for (const target of [1000, 3000, 12000]) {
    const { m } = build('sphere', 1);
    const r = remesh(m, { targetTris: target, iterations: 6, adaptive: 0, relax: 0.5 });
    const err = Math.abs(m.liveTris - target) / target;
    console.log(`       目標 ${target} → ${m.liveTris} 面（誤差 ${(err * 100).toFixed(1)}%）${r.ms}ms`);
    ok(err < 0.4, `目標 ${target} に ±40% で追従する (${m.liveTris})`);
    const mf = manifold(m);
    ok(mf.bad === 0 && mf.bnd === 0 && mf.chi === 2, `目標 ${target}: 閉多様体 χ=2 (${mf.chi})`);
  }
}

head('四角優勢化');
{
  const { m } = build('sphere', 1);
  remesh(m, { targetTris: 4000, iterations: 5, relax: 0.5 });
  const q = quadDominant(m);
  console.log(`       ${m.liveTris} 三角形 → 四角 ${q.quads} + 三角 ${q.tris}`
    + ` （四角化率 ${(q.ratio * 100).toFixed(1)}%）`);
  ok(q.quads > 0, `四角ができる (${q.quads})`);
  ok(q.ratio > 0.8, `三角形の 80% 以上が四角に取り込まれる (${(q.ratio * 100).toFixed(1)}%)`);
  ok(q.quads * 2 + q.tris === m.liveTris,
    `面数の帳尻が合う (${q.quads}×2 + ${q.tris} = ${q.quads * 2 + q.tris} / ${m.liveTris})`);
  // offsets の整合性
  ok(q.offsets.length === q.quads + q.tris + 1,
    `offsets の長さが面数 + 1 (${q.offsets.length} / ${q.quads + q.tris + 1})`);
  ok(q.offsets[q.offsets.length - 1] === q.faces.length,
    '最後の offset が faces の長さと一致する');
  // 各面の頂点が重複していないこと、生きている頂点であること
  let dup = 0, dead = 0;
  for (let f = 0; f + 1 < q.offsets.length; f++) {
    const a = q.offsets[f], b = q.offsets[f + 1];
    const set = new Set();
    for (let i = a; i < b; i++) {
      const v = q.faces[i];
      if (set.has(v)) dup++;
      set.add(v);
      if (!m.vAlive[v]) dead++;
    }
  }
  ok(dup === 0, `同じ頂点が 1 つの面に 2 回出てこない (${dup})`);
  ok(dead === 0, `死んだ頂点を参照していない (${dead})`);
}

head('端のケース');
{
  const empty = new SculptMesh();
  const r = remesh(empty, { targetTris: 100 });
  ok(!r.ok, `空のメッシュで ok:false (${r.reason}）`);

  // 板（境界あり）でも壊れないこと
  const { m } = build('plane', 1);
  const before = m.liveTris;
  const r2 = remesh(m, { targetTris: Math.max(200, before), iterations: 3, relax: 0.4 });
  ok(r2.ok, '境界のあるメッシュでも走る');
  const mf = manifold(m);
  ok(mf.bad === 0 && mf.degen === 0,
    `非多様体辺と退化三角形を作らない (${mf.bad} / ${mf.degen}、境界辺 ${mf.bnd} は元からある)`);
  let nan = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) if (!Number.isFinite(m.positions[v * 3 + k])) nan++;
  }
  ok(nan === 0, `NaN が無い (${nan})`);
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
