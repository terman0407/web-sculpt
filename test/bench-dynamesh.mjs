// ---------------------------------------------------------------------------
// ダイナメッシュの入力ポリゴン数に対するスケーリングを測る。
//   node test/bench-dynamesh.mjs [--max 3000000] [--res 128]
// 段階別の内訳（距離場 / 内外判定 / Surface Nets / 修復 / 平滑化 / 色）も出す。
// ---------------------------------------------------------------------------

import { SculptMesh, PRIMITIVES, icosphere, torus } from '../js/mesh.js';
import { SubdivLevels } from '../js/subdiv.js';
import { dynamesh } from '../js/dynamesh.js';
import { initWasmFieldFromBytes, wasmFieldReady } from '../js/wasmfield.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const MAX_TRIS = argVal('--max', 3_000_000);
const RES = argVal('--res', 128);

const mb = (b) => (b / 1048576).toFixed(0) + ' MB';

/** ベース形状を n 回 Divide して目標ポリゴン数に近づける */
function buildMesh(baseGen, divides) {
  const g = baseGen();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const lv = new SubdivLevels();
  for (let i = 0; i < divides; i++) lv.divide(m);
  return m;
}

// 20·4^k 系列だと 3M 付近に来ないので、トーラスを土台にして 4^3 倍する
const CASES = [
  ['icosphere(5)', () => icosphere(5), 1],       //   81,920 面
  ['icosphere(5)', () => icosphere(5), 2],       //  327,680 面
  ['torus 46.8k', () => torus(192, 122, 0.8, 0.3), 2],  //  749,568 面
  ['icosphere(5)', () => icosphere(5), 3],       // 1,310,720 面
  ['torus 46.8k', () => torus(192, 122, 0.8, 0.3), 3],  // 2,998,272 面
];

// --nowasm で JS 版のみに強制できる（比較用）
if (!args.includes('--nowasm')) {
  try {
    // WEBSCULPT_WASM で別ビルド（Rust 版など）を指定して比較できる
    const wp = process.env.WEBSCULPT_WASM
      ? new URL(process.env.WEBSCULPT_WASM, `file://${process.cwd()}/`)
      : new URL('../wasm/dynafield.wasm', import.meta.url);
    await initWasmFieldFromBytes(readFileSync(wp));
  } catch { /* 無ければ JS 版のまま */ }
}
console.log(`\n解像度 res=${RES} 固定、入力ポリゴン数を変えて計測`
  + `（距離場 WASM: ${wasmFieldReady() ? 'ON' : 'OFF'}）\n`);
console.log('  入力面数     総時間   距離場   内外   SurfNets   修復  平滑  色    出力面数   voxel');
console.log('  ' + '-'.repeat(92));

for (const [name, gen, div] of CASES) {
  let m;
  try {
    m = buildMesh(gen, div);
  } catch (e) {
    console.log(`  ${name} x${div}: メッシュ生成に失敗 (${e.message})`);
    continue;
  }
  if (m.liveTris > MAX_TRIS * 1.2) {
    console.log(`  ${m.liveTris.toLocaleString()} 面: --max を超えるためスキップ`);
    continue;
  }

  let r;
  try {
    r = await dynamesh(m, { resolution: RES, smooth: 1, transferColor: true });
  } catch (e) {
    console.log(`  ${m.liveTris.toLocaleString()} 面: ダイナメッシュ失敗 (${e.message})`);
    continue;
  }
  const p = r.stats.phase;
  const vox = r.stats.grid[0] * r.stats.grid[1] * r.stats.grid[2];
  console.log(
    `  ${m.liveTris.toLocaleString().padStart(10)}  ${String(r.stats.ms).padStart(7)}ms`
    + `  ${String(p.distance).padStart(6)}  ${String(p.inside).padStart(5)}`
    + `  ${String(p.surfaceNets).padStart(8)}  ${String(p.repair).padStart(5)}`
    + `  ${String(p.smooth).padStart(4)}  ${String(p.color).padStart(4)}`
    + `  ${r.stats.tris.toLocaleString().padStart(9)}  ${(vox / 1e6).toFixed(1)}M`);

  if (global.gc) global.gc();
}

console.log('\n  メモリ:', mb(process.memoryUsage().heapUsed), '(heap)');
