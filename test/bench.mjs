// ---------------------------------------------------------------------------
// CPU 側（彫刻パイプライン）のベンチマーク。
//   node test/bench.mjs
//   node --cpu-prof --cpu-prof-dir=prof test/bench.mjs   ← 関数別の内訳を取る
// ---------------------------------------------------------------------------

import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { Sculptor } from '../js/sculptor.js';
import { dynamesh } from '../js/dynamesh.js';

const ARGS = new Set(process.argv.slice(2));
const QUICK = ARGS.has('--quick');

function makeState(over = {}) {
  return Object.assign({
    brush: 'clay', radiusPx: 90, strength: 0.7, paintColor: [0.6, 0.2, 0.15],
    worldRadius: 0.25, dynTopo: true, decimate: true, detail: 0.6, maxVerts: 2000000,
    symmetry: { x: true, y: false, z: false },
    focalShift: 0, backfaceMask: false,
  }, over);
}

/** 球面に沿ってストロークする。実際の使用に近い経路になるようにする */
function stroke(s, brush, seed, samples = 30) {
  const pt = new Float32Array(3);
  const mesh = s.mesh;
  const at = (u) => {
    const th = seed * 0.7 + u * 1.6;
    const ph = -0.8 + Math.sin(seed + u * 2.2) * 0.9;
    const dx = Math.cos(ph) * Math.cos(th), dy = Math.sin(ph), dz = Math.cos(ph) * Math.sin(th);
    // 現在の形状に合わせて表面付近に置く
    let best = 1, bestDot = -1;
    const P = mesh.positions;
    for (let v = 0; v < mesh.nv; v += 31) {
      if (!mesh.vAlive[v]) continue;
      const i = v * 3;
      const l = Math.hypot(P[i], P[i + 1], P[i + 2]) || 1;
      const d = (P[i] * dx + P[i + 1] * dy + P[i + 2] * dz) / l;
      if (d > bestDot) { bestDot = d; best = l; }
    }
    pt[0] = dx * best; pt[1] = dy * best; pt[2] = dz * best;
    return pt;
  };
  s.beginStroke(brush, at(0), 1);
  for (let k = 1; k <= samples; k++) s.addSample(at(k / samples));
  s.endStroke();
}

function fresh(prim = 'sphere', over = {}) {
  const g = PRIMITIVES[prim]();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const st = makeState(over);
  const s = new Sculptor(m, st);
  return { m, s, st };
}

const results = [];
function bench(name, fn, iterations = 1) {
  // ウォームアップ（JIT を温める）
  fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / iterations;
  results.push({ name, ms });
  console.log(`  ${ms.toFixed(2).padStart(9)} ms   ${name}`);
  return ms;
}

console.log('\n=== 彫刻ストローク（1 ストローク = 30 サンプル）===');
{
  // 密度を段階的に上げてスケーリングを見る
  for (const target of QUICK ? [30000] : [30000, 120000, 300000]) {
    const { m, s, st } = fresh();
    st.worldRadius = 0.25;
    // 目標頂点数まで彫って準備
    let i = 0;
    while (m.liveVerts < target && i < 400) { stroke(s, 'clay', i++, 20); }
    const nv = m.liveVerts;
    let k = 1000;
    bench(`clay  dyntopo=on   ${nv.toLocaleString()} 頂点`, () => stroke(s, 'clay', k++, 30));
  }
}

console.log('\n=== ブラシ別（同じメッシュ・同条件）===');
{
  const { m, s, st } = fresh();
  st.worldRadius = 0.25;
  for (let i = 0; i < 60; i++) stroke(s, 'clay', i, 20);
  console.log(`  （${m.liveVerts.toLocaleString()} 頂点 / ${m.liveTris.toLocaleString()} 面）`);
  st.dynTopo = false;
  let k = 500;
  for (const b of ['clay', 'draw', 'smooth', 'relax', 'flatten', 'pinch', 'paint', 'mask']) {
    bench(`${b.padEnd(8)} dyntopo=off`, () => stroke(s, b, k++, 30));
  }
  st.dynTopo = true;
  bench('clay     dyntopo=on ', () => stroke(s, 'clay', k++, 30));
}

console.log('\n=== メッシュ全体の処理 ===');
{
  const { m, s, st } = fresh();
  st.worldRadius = 0.25;
  for (let i = 0; i < 80; i++) stroke(s, 'clay', i, 20);
  const nv = m.liveVerts;
  console.log(`  （${nv.toLocaleString()} 頂点）`);
  bench('computeAllNormals', () => m.computeAllNormals());
  bench('computeAllCurvature', () => m.computeAllCurvature());
  bench('rebuildRings', () => m.rebuildRings());
  bench('snapshot（アンドゥ 1 回分）', () => m.snapshot());
  const snap = m.snapshot();
  bench('restore', () => m.restore(snap));
  bench('bounds', () => m.bounds());
}

console.log('\n=== ダイナメッシュ ===');
{
  const { m, s, st } = fresh();
  st.worldRadius = 0.3;
  for (let i = 0; i < 40; i++) stroke(s, 'clay', i, 20);
  console.log(`  （入力 ${m.liveVerts.toLocaleString()} 頂点）`);
  for (const res of QUICK ? [96] : [64, 96, 128, 192]) {
    const r = dynamesh(m, { resolution: res, smooth: 1, transferColor: true });
    results.push({ name: `dynamesh res${res}`, ms: r.stats.ms });
    console.log(`  ${String(r.stats.ms).padStart(9)} ms   dynamesh res${res} → ${r.stats.verts.toLocaleString()} 頂点`);
  }
}

const total = results.reduce((a, r) => a + r.ms, 0);
console.log(`\n合計 ${total.toFixed(0)} ms（${results.length} 項目）`);

// CI などから比較しやすいよう JSON でも出す
if (ARGS.has('--json')) {
  console.log('\n' + JSON.stringify(results.map(r => ({ name: r.name, ms: +r.ms.toFixed(3) })), null, 0));
}
