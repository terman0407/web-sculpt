// ---------------------------------------------------------------------------
// dynamesh.js
// ZBrush の DynaMesh 相当。ボクセル化 → 等値面抽出でメッシュ全体を作り直す。
//
//   1. モデルの AABB を覆うボクセルグリッドを張る
//   2. 狭帯域の符号なし距離場を三角形スプラットで作る（最近傍三角形も記録）
//   3. Z 方向スキャンラインの「符号付き交差数（巻き数）」で内外を判定する
//      → パリティではなく巻き数なので、重なった部品や自己交差が正しく和集合になる
//   4. Surface Nets（デュアルコンタリング）で等値面を取り出す
//   5. Taubin スムージングで仕上げ（体積を保ったまま平滑化）
//
// 辺の均一化（refineRegion）と違い、トポロジを完全に作り直すため
// 「腕を胴体にめり込ませた」ような自己交差もきれいに解消できる。
// ---------------------------------------------------------------------------

import { clamp } from './math.js';
import { wasmSplat, wasmFieldReady } from './wasmkernels.js';
import { parallelSplat, parallelState, lastTiming, buildTiming } from './parallelfield.js';

const LARGE = 1e9;

// --- Surface Nets 用の立方体テーブル ---------------------------------------
const CUBE_EDGES = new Int32Array(24);
const EDGE_TABLE = new Int32Array(256);
(function initTables() {
  let k = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 1; j <= 4; j <<= 1) {
      const p = i ^ j;
      if (i <= p) { CUBE_EDGES[k++] = i; CUBE_EDGES[k++] = p; }
    }
  }
  // 先頭 3 本は角 0 から x, y, z 方向の辺になる（面出力でこの順を前提にする）
  for (let m = 0; m < 256; m++) {
    let em = 0;
    for (let e = 0; e < 12; e++) {
      const a = (m & (1 << CUBE_EDGES[e * 2])) !== 0;
      const b = (m & (1 << CUBE_EDGES[e * 2 + 1])) !== 0;
      if (a !== b) em |= (1 << e);
    }
    EDGE_TABLE[m] = em;
  }
})();

/** 点と三角形の最短距離の 2 乗（Ericson, Real-Time Collision Detection） */
function pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const x = apx - abx * v, y = apy - aby * v, z = apz - abz * v;
    return x * x + y * y + z * z;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const x = apx - acx * w, y = apy - acy * w, z = apz - acz * w;
    return x * x + y * y + z * z;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const x = bpx + (cpx - bpx) * w, y = bpy + (cpy - bpy) * w, z = bpz + (cpz - bpz) * w;
    return x * x + y * y + z * z;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const x = apx - (abx * v + acx * w);
  const y = apy - (aby * v + acy * w);
  const z = apz - (abz * v + acz * w);
  return x * x + y * y + z * z;
}

/** 境界辺（1 面しか接していない辺）を持つか */
export function hasBoundary(mesh) {
  const seen = new Map();
  const T = mesh.tris;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3;
    const v = [T[i], T[i + 1], T[i + 2]];
    if (v[0] === v[1] && v[1] === v[2]) continue;
    for (let e = 0; e < 3; e++) {
      let a = v[e], b = v[(e + 1) % 3];
      if (a > b) { const s = a; a = b; b = s; }
      const key = a * 2097152 + b;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  for (const n of seen.values()) if (n === 1) return true;
  return false;
}

/**
 * ダイナメッシュ本体。
 *
 * @param {SculptMesh} mesh
 * @param {object} opts
 *   resolution    : 最長辺方向のボクセル数（16..512）
 *   smooth        : Taubin スムージングの反復回数（0..5）
 *   transferColor : ポリペイントを最近傍三角形から転写するか
 *   maxVoxels     : 総ボクセル数の上限（超えると解像度を自動的に落とす）
 * @returns {{positions, indices, colors, stats}}
 */
export async function dynamesh(mesh, opts = {}) {
  const t0 = Date.now();
  // 段階別の所要時間（どこが重いかを実測できるようにしておく）
  const phase = {};
  let _tp = Date.now();
  const mark = (name) => { const n = Date.now(); phase[name] = (phase[name] || 0) + (n - _tp); _tp = n; };
  const res = clamp(Math.round(opts.resolution || 96), 16, 512);
  const smoothIters = clamp(Math.round(opts.smooth ?? 1), 0, 5);
  const transferColor = opts.transferColor !== false;
  const maxVoxels = opts.maxVoxels || 24e6;

  // ---- 1. グリッド ------------------------------------------------------
  const bb = mesh.bounds();
  const ex = bb.max[0] - bb.min[0];
  const ey = bb.max[1] - bb.min[1];
  const ez = bb.max[2] - bb.min[2];
  const maxExt = Math.max(ex, ey, ez, 1e-6);

  // ボクセルサイズ h を「一番長い軸を res 分割する」で決めると、細長い形で
  // 短い軸のボクセルまで一緒に粗くなる。実測（球を 3 回分割してから +Y に
  // 突起を引き出した場合）:
  //   bbox 2×2×2 → グリッド 103×103×103  h=0.0208  出力 43,268 頂点
  //   bbox 2×4×2 → グリッド  55×103×55   h=0.0417  出力 13,474 頂点
  // 伸ばした軸以外も含めてモデル全体のディテールが 3 分の 1 に落ちていた。
  //
  // 3 軸の相乗平均で決めると総ボクセル数が形に関係なく res³ 前後に保たれる
  // （ex/h · ey/h · ez/h = ex·ey·ez / h³ = res³）。立方体の bbox では
  // 相乗平均 = 最長軸なので、これまでと完全に同じ h になる。
  const eMin = maxExt / 24;      // 板のように潰れた軸で h が 0 に落ちないための下限
  const gmExt = Math.cbrt(Math.max(ex, eMin) * Math.max(ey, eMin) * Math.max(ez, eMin));

  let h = gmExt / res;
  let nx, ny, nz, ox, oy, oz;
  // 軸に平行な平面がグリッド頂点に「ちょうど乗る」と内外判定が不定になるため、
  // 原点を h の無理数倍だけずらして退化を避ける（軸整列した板や箱で効く）。
  const JIT = [0.013717, 0.021139, 0.008719];
  for (let guard = 0; guard < 64; guard++) {
    const pad = h * 3;                 // 外周セルが確実に「外側」になるよう余白を取る
    ox = bb.min[0] - pad + h * JIT[0];
    oy = bb.min[1] - pad + h * JIT[1];
    oz = bb.min[2] - pad + h * JIT[2];
    nx = Math.ceil((ex + pad * 2) / h) + 1;
    ny = Math.ceil((ey + pad * 2) / h) + 1;
    nz = Math.ceil((ez + pad * 2) / h) + 1;
    if (nx * ny * nz <= maxVoxels) break;
    h *= 1.12;
  }
  const sy = nx, sz = nx * ny;
  const total = nx * ny * nz;

  const band = h * 2.0;                // 少なくとも sqrt(3)*h 必要（セル対角）
  // 初期値を band にしておくと、下の下界カリングが 1 枚目の三角形から効く。
  // 帯域外の voxel は符号しか使わないので、正確な距離が入っていなくても問題ない。
  const field = new Float32Array(total).fill(band);
  const closest = transferColor ? new Int32Array(total).fill(-1) : null;
  const P = mesh.positions, T = mesh.tris;

  mark('grid');
  // ---- 2. 狭帯域の符号なし距離場 ---------------------------------------
  // 全体の 9 割を占める部分。WASM が使えればそちらへ（結果は JS 版と完全一致）。
  const gp = { nx, ny, nz, ox, oy, oz, h, band };
  let usedWasm = false, usedParallel = false;
  // 十分大きいときだけワーカーに出す（小さいと転送のほうが高くつく）
  const heavy = mesh.liveTris >= 60000 || total >= 400000;
  if (opts.parallel !== false && heavy && parallelState() === 'ready') {
    usedParallel = await parallelSplat(mesh, field, closest, gp);
    usedWasm = usedParallel;
  }
  if (!usedWasm && opts.wasm !== false && wasmFieldReady()) {
    usedWasm = wasmSplat(mesh, field, closest, gp);
  }

  // WASM が使えなかったときの JS 版（アルゴリズムは同一）
  if (!usedWasm) for (let t = 0; t < mesh.nt; t++) {
    const ti = t * 3;
    const ia = T[ti], ib = T[ti + 1], ic = T[ti + 2];
    if (ia === ib && ib === ic) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const bx = P[b], by = P[b + 1], bz = P[b + 2];
    const cx = P[c], cy = P[c + 1], cz = P[c + 2];

    const tx0 = Math.min(ax, bx, cx), tx1 = Math.max(ax, bx, cx);
    const ty0 = Math.min(ay, by, cy), ty1 = Math.max(ay, by, cy);
    const tz0 = Math.min(az, bz, cz), tz1 = Math.max(az, bz, cz);

    // 走査すべきは「三角形から band 以内にある格子点」。格子点 i の座標は ox + i*h
    // なので下限は ceil、上限は floor が正しい。floor/ceil を逆に取ると軸ごとに
    // 2 セル余分に回ることになり、点に近い三角形では 7^3 と 5^3 で 2.7 倍の差が出る。
    const i0 = Math.max(0, Math.ceil((tx0 - band - ox) / h));
    const i1 = Math.min(nx - 1, Math.floor((tx1 + band - ox) / h));
    const j0 = Math.max(0, Math.ceil((ty0 - band - oy) / h));
    const j1 = Math.min(ny - 1, Math.floor((ty1 + band - oy) / h));
    const k0 = Math.max(0, Math.ceil((tz0 - band - oz) / h));
    const k1 = Math.min(nz - 1, Math.floor((tz1 + band - oz) / h));

    // AABB までの距離は三角形までの距離の下界になる。これを軸ごとに外へ括り出して
    // 「確実に現在値より遠い voxel」を pointTriDist2 を呼ばずに捨てる。
    for (let k = k0; k <= k1; k++) {
      const pz = oz + k * h;
      const ez = pz < tz0 ? tz0 - pz : (pz > tz1 ? pz - tz1 : 0);
      const e2z = ez * ez;
      if (e2z >= band * band) continue;                       // この z 面は丸ごと不要
      for (let j = j0; j <= j1; j++) {
        const py = oy + j * h;
        const ey = py < ty0 ? ty0 - py : (py > ty1 ? py - ty1 : 0);
        const e2zy = e2z + ey * ey;
        if (e2zy >= band * band) continue;                    // この行は丸ごと不要
        let idx = i0 + j * sy + k * sz;
        for (let i = i0; i <= i1; i++, idx++) {
          const px = ox + i * h;
          const cur = field[idx];
          const ex = px < tx0 ? tx0 - px : (px > tx1 ? px - tx1 : 0);
          if (e2zy + ex * ex >= cur * cur) continue;          // 下界が既存値以上 → 更新されない
          // 平方で比較して大半の voxel で sqrt を省く
          const d2 = pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
          if (d2 < cur * cur) {
            field[idx] = Math.sqrt(d2);
            if (closest) closest[idx] = t;
          }
        }
      }
    }
  }

  mark('distance');
  // ---- 3. 内外判定 ------------------------------------------------------
  //
  // 境界の有無は「全辺を Map に入れて 1 面しかない辺を探す」のが素直だが、
  // 300 万面だと 900 万件の Map 操作で 1.4 秒かかっていた。
  // 実際に知りたいのは「巻き数が信用できるか」なので、スキャンラインを
  // 走査し終えたときに巻き数が 0 に戻るかどうかで判定する（追加コストなし）。
  // 閉じたメッシュならレイは必ず外側で始まり外側で終わるので必ず 0 に戻る。
  const far = band + h;
  let openMesh = false;

  {
    // Z 方向のスキャンラインごとに符号付き交差（巻き数）を集める
    const lines = new Array(nx * ny);
    for (let t = 0; t < mesh.nt; t++) {
      const ti = t * 3;
      const ia = T[ti], ib = T[ti + 1], ic = T[ti + 2];
      if (ia === ib && ib === ic) continue;
      const a = ia * 3, b = ib * 3, c = ic * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const bx = P[b], by = P[b + 1], bz = P[b + 2];
      const cx = P[c], cy = P[c + 1], cz = P[c + 2];

      // XY 平面に射影した符号付き面積（= 法線の z 成分の符号）
      const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area2) < 1e-20) continue;
      const dir = area2 > 0 ? -1 : 1;   // 法線 -Z なら +Z 進行のレイは「入る」

      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - ox) / h));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - ox) / h));
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - oy) / h));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - oy) / h));
      if (i1 < i0 || j1 < j0) continue;

      const inv = 1 / area2;
      for (let j = j0; j <= j1; j++) {
        const py = oy + j * h;
        for (let i = i0; i <= i1; i++) {
          const px = ox + i * h;
          // 2D 重心座標で内包判定
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
          if (w0 < 0 || w0 > 1) continue;
          const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
          if (w1 < 0 || w1 > 1) continue;
          const w2 = 1 - w0 - w1;
          if (w2 < 0 || w2 > 1) continue;
          const zc = az * w0 + bz * w1 + cz * w2;
          const li = i + j * nx;
          let L = lines[li];
          if (!L) { L = lines[li] = []; }
          L.push(zc, dir);
        }
      }
    }

    // まず全ラインの巻き数が 0 に戻るか確認する（= 境界がないか）
    const orders = new Array(nx * ny);
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      if (!L) continue;
      const n = L.length / 2;
      const order = new Int32Array(n);
      for (let q = 0; q < n; q++) order[q] = q;
      const sorted = Array.prototype.sort.call(order, (p, r) => L[p * 2] - L[r * 2]);
      orders[li] = sorted;
      let wind = 0;
      for (let q = 0; q < n; q++) wind += L[q * 2 + 1];
      if (wind !== 0) { openMesh = true; break; }
    }

    let insideCount = 0;
    if (!openMesh) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const li = i + j * nx;
          const L = lines[li];
          if (!L) continue;
          const order = orders[li];
          const n = order.length;
          let wind = 0, q = 0;
          const colBase = i + j * sy;
          for (let k = 0; k < nz; k++) {
            const pz = oz + k * h;
            while (q < n && L[order[q] * 2] <= pz) { wind += L[order[q] * 2 + 1]; q++; }
            if (wind !== 0) {
              const idx = colBase + k * sz;
              field[idx] = -Math.min(field[idx], far);
              insideCount++;
            }
          }
        }
      }
      // 内側が 1 つも無い = Z レイから見て中身がない。
      // 面が XZ 平面に乗っている板（射影面積 0 で交差を生まない）や、
      // 1 ボクセル未満の薄い閉殻がこれに当たる。どちらもシェル化が正しい。
      if (insideCount === 0) openMesh = true;
    }

    if (openMesh) {
      // 境界があるメッシュは巻き数が使えないので、厚みを持つシェルとして扱う。
      // （平面をダイナメッシュすると板になる）
      const thickness = h * 1.25;
      for (let i = 0; i < total; i++) {
        field[i] = Math.min(Math.abs(field[i]), far) - thickness;
      }
    } else {
      // 内側にならなかった voxel は外側として帯域外をクランプする
      for (let i = 0; i < total; i++) {
        if (field[i] > 0) field[i] = Math.min(field[i], far);
      }
    }
  }

  mark('inside');
  // ---- 4. Surface Nets --------------------------------------------------
  const verts = [];
  const idxOut = [];
  const cellTri = transferColor ? [] : null;
  const nxy = nx * ny;
  let bufA = new Int32Array(nxy).fill(-1);   // 現在の z 層
  let bufB = new Int32Array(nxy).fill(-1);   // 1 つ前の z 層
  const grid = new Float64Array(8);

  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    idxOut.push(a, b, c, a, c, d);
  };

  for (let cz = 0; cz < nz - 1; cz++) {
    bufA.fill(-1);
    for (let cy = 0; cy < ny - 1; cy++) {
      for (let cx = 0; cx < nx - 1; cx++) {
        const base = cx + cy * sy + cz * sz;
        let mask = 0;
        for (let b = 0; b < 8; b++) {
          const g = field[base + (b & 1) + ((b >> 1) & 1) * sy + ((b >> 2) & 1) * sz];
          grid[b] = g;
          if (g > 0) mask |= (1 << b);
        }
        if (mask === 0 || mask === 0xff) continue;

        const em = EDGE_TABLE[mask];
        let vx = 0, vy = 0, vz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          if (!(em & (1 << e))) continue;
          const ea = CUBE_EDGES[e * 2], eb = CUBE_EDGES[e * 2 + 1];
          const ga = grid[ea], gb = grid[eb];
          const den = ga - gb;
          if (Math.abs(den) < 1e-20) continue;
          const t = ga / den;
          let px = ea & 1, py = (ea >> 1) & 1, pz = (ea >> 2) & 1;
          const axis = ea ^ eb;
          if (axis === 1) px += t; else if (axis === 2) py += t; else pz += t;
          vx += px; vy += py; vz += pz; cnt++;
        }
        if (cnt === 0) continue;
        const inv = 1 / cnt;
        const vi = verts.length / 3;
        verts.push(
          ox + (cx + vx * inv) * h,
          oy + (cy + vy * inv) * h,
          oz + (cz + vz * inv) * h,
        );
        if (cellTri) cellTri.push(closest[base] >= 0 ? closest[base] : -1);
        const cur = cx + cy * nx;
        bufA[cur] = vi;

        // 角 0 から伸びる 3 本の辺に符号変化があれば、その辺を囲む 4 セルで面を張る。
        // 角 0 が外側（field > 0）かどうかで巻き方向を反転させ、法線を外向きに揃える。
        const positive0 = (mask & 1) !== 0;
        if ((em & 1) && cy > 0 && cz > 0) {           // x 方向の辺 → (y, z) 側の 4 セル
          const A = bufA[cur], B = bufA[cur - nx], C = bufB[cur - nx], D = bufB[cur];
          if (positive0) quad(A, D, C, B); else quad(A, B, C, D);
        }
        if ((em & 2) && cz > 0 && cx > 0) {           // y 方向の辺 → (z, x) 側の 4 セル
          const A = bufA[cur], B = bufB[cur], C = bufB[cur - 1], D = bufA[cur - 1];
          if (positive0) quad(A, D, C, B); else quad(A, B, C, D);
        }
        if ((em & 4) && cx > 0 && cy > 0) {           // z 方向の辺 → (x, y) 側の 4 セル
          const A = bufA[cur], B = bufA[cur - 1], C = bufA[cur - nx - 1], D = bufA[cur - nx];
          if (positive0) quad(A, D, C, B); else quad(A, B, C, D);
        }
      }
    }
    const tmp = bufB; bufB = bufA; bufA = tmp;
  }

  mark('surfaceNets');
  // ---- 5. 多様体修復（1 ボクセル未満の薄い部分で必要になる） ------------
  const rep = repairManifold(new Float32Array(verts), new Uint32Array(idxOut));
  const positions = rep.positions;
  const indices = rep.indices;

  mark('repair');
  // ---- 6. Taubin スムージング ------------------------------------------
  if (smoothIters > 0 && positions.length > 0) {
    taubinSmooth(positions, indices, smoothIters, 0.55, 0.58);
  }

  mark('smooth');
  // ---- 7. 色の転写 ------------------------------------------------------
  let colors = null;
  if (transferColor && cellTri) {
    colors = new Float32Array(positions.length);
    const C = mesh.colors;
    const nOut = positions.length / 3;
    for (let v = 0; v < nOut; v++) {
      const s = rep.attrSource[v];
      const t = (s >= 0 && s < cellTri.length) ? cellTri[s] : -1;
      const o = v * 3;
      if (t < 0) { colors[o] = 1; colors[o + 1] = 1; colors[o + 2] = 1; continue; }
      const ti = t * 3;
      const a = T[ti] * 3, b = T[ti + 1] * 3, c = T[ti + 2] * 3;
      colors[o] = (C[a] + C[b] + C[c]) / 3;
      colors[o + 1] = (C[a + 1] + C[b + 1] + C[c + 1]) / 3;
      colors[o + 2] = (C[a + 2] + C[b + 2] + C[c + 2]) / 3;
    }
  }

  mark('color');

  return {
    positions, indices, colors,
    stats: {
      phase,
      inputTris: mesh.liveTris,
      wasm: usedWasm,
      parallel: usedParallel,
      parTiming: usedParallel ? Object.assign({}, lastTiming, buildTiming) : null,
      resolution: res,
      grid: [nx, ny, nz],
      voxelSize: h,
      openMesh,
      verts: positions.length / 3,
      tris: indices.length / 3,
      repair: rep.stats,
      ms: Date.now() - t0,
    },
  };
}

// ---------------------------------------------------------------------------
// 多様体修復
//
// Surface Nets は 1 セルに 1 頂点しか置かないため、1 ボクセル程度しか厚みのない
// 部分では 1 頂点が 2 枚のシートに使われ、非多様体な辺 / 頂点が生じることがある
// （デュアルコンタリング共通の既知の限界）。
// 彫刻側は多様体を前提にしているので、抽出後にここで必ず閉多様体へ直す。
//
//   1. 3 枚以上の面が付いた辺は、向きの整合が取れる 2 枚だけ残して他を削除
//   2. 面の連結成分が 2 つ以上ある頂点を複製して切り離す
//   3. 空いた穴（境界ループ）を重心ファンで閉じる
// ---------------------------------------------------------------------------

const EKEY = 2097152;

function buildEdgeFaces(tris, nf) {
  const map = new Map();
  for (let f = 0; f < nf; f++) {
    const i = f * 3;
    if (tris[i] < 0) continue;
    for (let e = 0; e < 3; e++) {
      const a = tris[i + e], b = tris[i + (e + 1) % 3];
      const key = a < b ? a * EKEY + b : b * EKEY + a;
      let L = map.get(key);
      if (!L) { L = []; map.set(key, L); }
      L.push(f);
    }
  }
  return map;
}

/**
 * 抽出結果を必ず「閉じた多様体」に直す。
 * @returns {{positions, indices, attrSource, stats}}
 *   attrSource[newVertexIndex] = 元の抽出頂点インデックス（属性の引き直し用）
 */
export function repairManifold(positionsIn, indicesIn) {
  const nv0 = positionsIn.length / 3;

  // まず 1 回だけ辺マップを作り、直すものが無ければ即返す（通常はこちら）
  {
    const map = buildEdgeFaces(indicesIn, indicesIn.length / 3);
    let dirty = false;
    for (const L of map.values()) if (L.length !== 2) { dirty = true; break; }
    if (!dirty) {
      const id = new Int32Array(nv0);
      for (let v = 0; v < nv0; v++) id[v] = v;
      return {
        positions: positionsIn, indices: indicesIn, attrSource: id,
        stats: { facesRemoved: 0, verticesSplit: 0, holesFilled: 0, nonManifold: 0, boundary: 0, clean: true },
      };
    }
  }

  const pos = Array.from(positionsIn);
  const tris = Array.from(indicesIn);
  const src = new Array(nv0);
  for (let v = 0; v < nv0; v++) src[v] = v;
  let nf = tris.length / 3;
  let facesRemoved = 0, verticesSplit = 0, holesFilled = 0;

  const hasDirected = (f, a, b) => {
    const i = f * 3;
    return (tris[i] === a && tris[i + 1] === b)
      || (tris[i + 1] === a && tris[i + 2] === b)
      || (tris[i + 2] === a && tris[i] === b);
  };

  // ---- 1. 3 枚以上付いた辺を 2 枚に間引く ------------------------------
  for (let pass = 0; pass < 8; pass++) {
    const map = buildEdgeFaces(tris, nf);
    let removed = 0;
    for (const [key, L] of map) {
      if (L.length <= 2) continue;
      const a = Math.floor(key / EKEY), b = key % EKEY;
      const live = L.filter(f => tris[f * 3] >= 0);
      if (live.length <= 2) continue;
      // 向きが逆の 2 枚（a→b と b→a）を優先して残す
      const fwd = live.filter(f => hasDirected(f, a, b));
      const rev = live.filter(f => hasDirected(f, b, a));
      const keep = new Set();
      if (fwd.length && rev.length) { keep.add(fwd[0]); keep.add(rev[0]); }
      else { keep.add(live[0]); keep.add(live[1]); }
      for (const f of live) {
        if (keep.has(f)) continue;
        tris[f * 3] = -1; tris[f * 3 + 1] = -1; tris[f * 3 + 2] = -1;
        removed++;
      }
    }
    facesRemoved += removed;
    if (removed === 0) break;
  }

  // ---- 2. 非多様体頂点の分離 -------------------------------------------
  {
    const nv0 = pos.length / 3;
    const incident = new Array(nv0);
    for (let f = 0; f < nf; f++) {
      const i = f * 3;
      if (tris[i] < 0) continue;
      for (let e = 0; e < 3; e++) {
        const v = tris[i + e];
        if (!incident[v]) incident[v] = [];
        incident[v].push(f);
      }
    }
    for (let v = 0; v < nv0; v++) {
      const fs = incident[v];
      if (!fs || fs.length < 2) continue;
      // v の周りで辺を共有する面同士を結び、連結成分に分ける
      const other = (f) => {
        const i = f * 3;
        const a = tris[i], b = tris[i + 1], c = tris[i + 2];
        if (a === v) return [b, c];
        if (b === v) return [c, a];
        return [a, b];
      };
      const byNbr = new Map();
      for (const f of fs) {
        for (const u of other(f)) {
          let L = byNbr.get(u);
          if (!L) { L = []; byNbr.set(u, L); }
          L.push(f);
        }
      }
      const comp = new Map();
      let nComp = 0;
      for (const f of fs) {
        if (comp.has(f)) continue;
        const id = nComp++;
        const stack = [f];
        comp.set(f, id);
        while (stack.length) {
          const g = stack.pop();
          for (const u of other(g)) {
            for (const hh of (byNbr.get(u) || [])) {
              if (!comp.has(hh)) { comp.set(hh, id); stack.push(hh); }
            }
          }
        }
      }
      if (nComp <= 1) continue;
      // 成分 0 は元の頂点をそのまま使い、1 以降は複製する
      const dup = new Array(nComp).fill(-1);
      for (let c = 1; c < nComp; c++) {
        dup[c] = pos.length / 3;
        pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        src.push(src[v]);
        verticesSplit++;
      }
      for (const f of fs) {
        const c = comp.get(f);
        if (c === 0) continue;
        const i = f * 3;
        for (let e = 0; e < 3; e++) if (tris[i + e] === v) tris[i + e] = dup[c];
      }
    }
  }

  // ---- 3. 穴埋め --------------------------------------------------------
  {
    const map = buildEdgeFaces(tris, nf);
    // 境界辺を「穴側の向き」（面の巻きと逆）で集める
    const next = new Map();
    for (const [key, L] of map) {
      const live = L.filter(f => tris[f * 3] >= 0);
      if (live.length !== 1) continue;
      const a = Math.floor(key / EKEY), b = key % EKEY;
      const f = live[0];
      const [s, e] = hasDirected(f, a, b) ? [b, a] : [a, b];
      let L2 = next.get(s);
      if (!L2) { L2 = []; next.set(s, L2); }
      L2.push(e);
    }
    const addTri = (a, b, c) => {
      if (a === b || b === c || c === a) return;
      tris.push(a, b, c);
      nf++;
    };
    let guard = 0;
    while (next.size > 0 && guard++ < 100000) {
      // 適当な境界辺からループを辿る
      const startKey = next.keys().next().value;
      const loop = [startKey];
      let cur = startKey;
      let okLoop = true;
      for (let step = 0; step < 100000; step++) {
        const L = next.get(cur);
        if (!L || L.length === 0) { okLoop = false; break; }
        const nxt = L.pop();
        if (L.length === 0) next.delete(cur);
        if (nxt === startKey) break;
        if (loop.includes(nxt)) { okLoop = false; break; }
        loop.push(nxt);
        cur = nxt;
      }
      if (!okLoop || loop.length < 3) continue;
      if (loop.length === 3) {
        addTri(loop[0], loop[1], loop[2]);
      } else {
        // 重心を足してファン状に塞ぐ
        let cxx = 0, cyy = 0, czz = 0;
        for (const v of loop) { cxx += pos[v * 3]; cyy += pos[v * 3 + 1]; czz += pos[v * 3 + 2]; }
        const n = loop.length;
        const ci = pos.length / 3;
        pos.push(cxx / n, cyy / n, czz / n);
        src.push(src[loop[0]]);
        for (let k = 0; k < n; k++) addTri(ci, loop[k], loop[(k + 1) % n]);
      }
      holesFilled++;
    }
  }

  // ---- 4. 詰め直し ------------------------------------------------------
  const nvAll = pos.length / 3;
  const used = new Uint8Array(nvAll);
  for (let f = 0; f < nf; f++) {
    const i = f * 3;
    if (tris[i] < 0) continue;
    used[tris[i]] = 1; used[tris[i + 1]] = 1; used[tris[i + 2]] = 1;
  }
  const remap = new Int32Array(nvAll).fill(-1);
  let w = 0;
  for (let v = 0; v < nvAll; v++) if (used[v]) remap[v] = w++;
  const outPos = new Float32Array(w * 3);
  const attrSource = new Int32Array(w);
  for (let v = 0; v < nvAll; v++) {
    const r = remap[v];
    if (r < 0) continue;
    outPos[r * 3] = pos[v * 3];
    outPos[r * 3 + 1] = pos[v * 3 + 1];
    outPos[r * 3 + 2] = pos[v * 3 + 2];
    attrSource[r] = src[v];
  }
  const outIdx = [];
  for (let f = 0; f < nf; f++) {
    const i = f * 3;
    if (tris[i] < 0) continue;
    outIdx.push(remap[tris[i]], remap[tris[i + 1]], remap[tris[i + 2]]);
  }

  // 修復後の状態を確認する
  const check = buildEdgeFaces(outIdx, outIdx.length / 3);
  let nonManifold = 0, boundary = 0;
  for (const L of check.values()) {
    if (L.length === 1) boundary++;
    else if (L.length > 2) nonManifold++;
  }

  return {
    positions: outPos,
    indices: new Uint32Array(outIdx),
    attrSource,
    stats: { facesRemoved, verticesSplit, holesFilled, nonManifold, boundary, clean: false },
  };
}

/** Taubin スムージング（λ で縮め、μ で戻すので体積がほぼ保たれる） */
export function taubinSmooth(positions, indices, iterations, lambda = 0.55, mu = 0.58) {
  const nv = positions.length / 3;
  if (nv === 0) return;

  // 1-ring 隣接を CSR で構築
  const deg = new Int32Array(nv);
  for (let i = 0; i < indices.length; i += 3) {
    deg[indices[i]] += 2; deg[indices[i + 1]] += 2; deg[indices[i + 2]] += 2;
  }
  const off = new Int32Array(nv + 1);
  for (let v = 0; v < nv; v++) off[v + 1] = off[v] + deg[v];
  const adj = new Int32Array(off[nv]);
  const fill = off.slice(0, nv);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    adj[fill[a]++] = b; adj[fill[a]++] = c;
    adj[fill[b]++] = c; adj[fill[b]++] = a;
    adj[fill[c]++] = a; adj[fill[c]++] = b;
  }

  const tmp = new Float32Array(positions.length);
  const pass = (k) => {
    for (let v = 0; v < nv; v++) {
      const s = off[v], e = off[v + 1];
      if (e === s) {
        tmp[v * 3] = positions[v * 3];
        tmp[v * 3 + 1] = positions[v * 3 + 1];
        tmp[v * 3 + 2] = positions[v * 3 + 2];
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (let q = s; q < e; q++) {
        const u = adj[q] * 3;
        ax += positions[u]; ay += positions[u + 1]; az += positions[u + 2];
      }
      const n = e - s;
      const o = v * 3;
      tmp[o] = positions[o] + (ax / n - positions[o]) * k;
      tmp[o + 1] = positions[o + 1] + (ay / n - positions[o + 1]) * k;
      tmp[o + 2] = positions[o + 2] + (az / n - positions[o + 2]) * k;
    }
    positions.set(tmp);
  };

  for (let it = 0; it < iterations; it++) {
    pass(lambda);
    pass(-mu);
  }
}
