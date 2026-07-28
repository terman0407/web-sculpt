// ---------------------------------------------------------------------------
// ハイポリでのブラシストロークを段階別に計測する。
//   node test/bench-brush.mjs [--tris 3000000] [--dabs 40] [--repeat 3]
//
// 実ブラウザ（CDP）で動かす。理由は 2 つ:
//  * WebGPU の転送を含む本番と同じ経路で測りたい
//  * Node の V8 と Chrome の V8 はバージョンが違い、最適化の当たり方が変わる
//
// 内訳は sculptor 側にフックを差さず、performance のマークではなく
// 「関数を差し替えて自前に積算する」方式で取る。こうすると計測対象の
// 実装を書き換えても計測コードを直す必要がない。
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const TRIS = argVal('--tris', 3_000_000);
const DABS = argVal('--dabs', 40);
const REPEAT = argVal('--repeat', 3);
const DYNTOPO = args.includes('--dyntopo');

const h = await launch('/index.html', { width: 1000, height: 700 });
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.renderer)'), 60000, 'boot');
  await waitFor(async () => cdp.eval("!window.__wasmState || window.__wasmState() !== 'loading'"), 30000, 'wasm');

  const raw = await cdp.eval(`(() => {
    const W = window.WebSculpt, { mesh, sculptor, state } = W;
    state.maxVerts = 8000000;
    state.dynTopo = ${DYNTOPO};
    W.app.newMesh('sphere');
    for (let i = 0; i < 6 && mesh.liveTris * 4 <= ${TRIS}; i++) sculptor.divide();
    state.worldRadius = 0.25; state.strength = 0.6;

    // --- 段階別の積算 ---------------------------------------------------
    // sculptor / mesh のメソッドを包んで自前に足す。差し替えは計測後に戻す。
    const acc = {};
    const saved = [];
    const wrap = (obj, name, key) => {
      const f = obj[name];
      if (typeof f !== 'function') return;
      saved.push([obj, name, f]);
      acc[key] = 0;
      obj[name] = function (...a) {
        const t0 = performance.now();
        const r = f.apply(this, a);
        acc[key] += performance.now() - t0;
        return r;
      };
    };
    const S = Object.getPrototypeOf(sculptor);
    const M = Object.getPrototypeOf(mesh);
    wrap(S, '_gather', 'gather');
    wrap(S, '_seedNear', 'seed 探索');
    wrap(S, '_updateNormals', 'normals(集合構築込み)');
    wrap(M, 'computeNormalsFor', '  └ computeNormalsFor');
    wrap(Object.getPrototypeOf(sculptor.engine), 'apply', 'brush.apply');
    wrap(S, 'flushCurvature', 'curvature(フレーム末)');
    wrap(M, 'computeCurvatureFor', '  └ computeCurvatureFor');
    wrap(M, 'smoothCurvatureFor', '  └ smoothCurvatureFor');

    const rows = [];
    const pt = new Float32Array(3);
    const at = (k) => { pt.set([Math.cos(k * 0.09), Math.sin(k * 0.09) * 0.3, 0.3]); return pt; };
    for (let rep = 0; rep < ${REPEAT}; rep++) {
      for (const k of Object.keys(acc)) acc[k] = 0;
      const dabMs = [];
      const t0 = performance.now();
      sculptor.beginStroke('clay', at(0), 1);
      for (let k = 1; k <= ${DABS}; k++) {
        const d0 = performance.now();
        sculptor.addSample(at(k));
        // 本番のフレームループは毎フレーム 1 回 flushCurvature を呼ぶ。
        // ダブ 1 回 ≒ 1 フレームなので、ここでも毎回呼んで実際の負荷に寄せる。
        sculptor.flushCurvature();
        dabMs.push(performance.now() - d0);
      }
      sculptor.endStroke();
      const total = performance.now() - t0;
      dabMs.sort((a, b) => a - b);
      rows.push({
        total, acc: { ...acc },
        p50: dabMs[dabMs.length >> 1], p95: dabMs[Math.floor(dabMs.length * 0.95)],
        max: dabMs[dabMs.length - 1], n: dabMs.length,
      });
      // 次の反復のために形状を戻す（履歴を使うと計測にノイズが乗るので作り直す）
      W.app.newMesh('sphere');
      for (let i = 0; i < 6 && mesh.liveTris * 4 <= ${TRIS}; i++) sculptor.divide();
    }
    for (const [o, n, f] of saved) o[n] = f;
    return JSON.stringify({ verts: mesh.liveVerts, tris: mesh.liveTris, rows });
  })()`);

  const o = JSON.parse(raw);
  const best = o.rows.reduce((a, b) => (a.total <= b.total ? a : b));
  const med = (key) => {
    const v = o.rows.map((r) => (key === 'total' ? r.total : r.acc[key])).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  console.log(`\n  ${o.verts.toLocaleString()} 頂点 / ${o.tris.toLocaleString()} 面`
    + `  dyntopo=${DYNTOPO}  ${DABS} ダブ × ${REPEAT} 回`);
  console.log(`  総時間 中央値 ${med('total').toFixed(0)}ms  最良 ${best.total.toFixed(0)}ms`);
  console.log(`  1 ダブ  p50 ${best.p50.toFixed(1)}ms  p95 ${best.p95.toFixed(1)}ms  max ${best.max.toFixed(1)}ms`);
  console.log('\n         ms      %   段階');
  const tot = med('total');
  for (const k of Object.keys(o.rows[0].acc)) {
    const v = med(k);
    console.log(`  ${v.toFixed(1).padStart(9)}  ${(v / tot * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
  // JSON も出す（前後比較をスクリプトで取りたいとき用）
  if (args.includes('--json')) {
    console.log('\nJSON ' + JSON.stringify({
      verts: o.verts, tris: o.tris, total: tot,
      acc: Object.fromEntries(Object.keys(o.rows[0].acc).map((k) => [k, +med(k).toFixed(1)])),
      p50: +best.p50.toFixed(1), p95: +best.p95.toFixed(1),
    }));
  }
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  await h.stop();
}
