// ---------------------------------------------------------------------------
// dynafield.ts — AssemblyScript → WebAssembly
//
// ダイナメッシュで最も重い「狭帯域の符号なし距離場を三角形スプラットで作る」
// ループだけを WASM 化したもの。JS 版（js/dynamesh.js）と同じアルゴリズム・
// 同じ打ち切り条件なので、出力は一致する。
//
// 単一のフラットな線形メモリ上で動くので、JS から見ると
//   alloc() でバッファを取る → 書き込む → splat() → 結果を読む
// だけで済む。SharedArrayBuffer もスレッドも使わないため、
// COOP/COEP ヘッダを設定できない GitHub Pages でもそのまま動く。
// ---------------------------------------------------------------------------

/** 線形メモリを確保して先頭アドレスを返す */
export function alloc(bytes: i32): usize {
  return heap.alloc(bytes);
}

export function release(ptr: usize): void {
  heap.free(ptr);
}

/** 点と三角形の最短距離の 2 乗（Ericson, Real-Time Collision Detection） */
@inline
function pointTriDist2(
  px: f64, py: f64, pz: f64,
  ax: f64, ay: f64, az: f64,
  bx: f64, by: f64, bz: f64,
  cx: f64, cy: f64, cz: f64,
): f64 {
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

  const denom = 1.0 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const x = apx - (abx * v + acx * w);
  const y = apy - (aby * v + acy * w);
  const z = apz - (abz * v + acz * w);
  return x * x + y * y + z * z;
}

/**
 * 距離場スプラット。field は事前に band で埋めておくこと。
 * closestPtr に 0 を渡すと最近傍三角形の記録を省略する。
 */
export function splat(
  posPtr: usize, triPtr: usize, nt: i32,
  fieldPtr: usize, closestPtr: usize,
  nx: i32, ny: i32, nz: i32,
  ox: f64, oy: f64, oz: f64, h: f64, band: f64,
): void {
  const sy = nx;
  const sz = nx * ny;
  const band2 = band * band;
  const invH = 1.0 / h;
  const wantClosest = closestPtr != 0;

  for (let t = 0; t < nt; t++) {
    const ti = triPtr + (<usize>t) * 12;
    const ia = load<i32>(ti);
    const ib = load<i32>(ti, 4);
    const ic = load<i32>(ti, 8);
    if (ia == ib && ib == ic) continue;

    const pa = posPtr + (<usize>ia) * 12;
    const pb = posPtr + (<usize>ib) * 12;
    const pc = posPtr + (<usize>ic) * 12;
    const ax = <f64>load<f32>(pa), ay = <f64>load<f32>(pa, 4), az = <f64>load<f32>(pa, 8);
    const bx = <f64>load<f32>(pb), by = <f64>load<f32>(pb, 4), bz = <f64>load<f32>(pb, 8);
    const cx = <f64>load<f32>(pc), cy = <f64>load<f32>(pc, 4), cz = <f64>load<f32>(pc, 8);

    const tx0 = Math.min(ax, Math.min(bx, cx)), tx1 = Math.max(ax, Math.max(bx, cx));
    const ty0 = Math.min(ay, Math.min(by, cy)), ty1 = Math.max(ay, Math.max(by, cy));
    const tz0 = Math.min(az, Math.min(bz, cz)), tz1 = Math.max(az, Math.max(bz, cz));

    let i0 = <i32>Math.ceil((tx0 - band - ox) * invH); if (i0 < 0) i0 = 0;
    let i1 = <i32>Math.floor((tx1 + band - ox) * invH); if (i1 > nx - 1) i1 = nx - 1;
    let j0 = <i32>Math.ceil((ty0 - band - oy) * invH); if (j0 < 0) j0 = 0;
    let j1 = <i32>Math.floor((ty1 + band - oy) * invH); if (j1 > ny - 1) j1 = ny - 1;
    let k0 = <i32>Math.ceil((tz0 - band - oz) * invH); if (k0 < 0) k0 = 0;
    let k1 = <i32>Math.floor((tz1 + band - oz) * invH); if (k1 > nz - 1) k1 = nz - 1;

    for (let k = k0; k <= k1; k++) {
      const pz = oz + <f64>k * h;
      const ez = pz < tz0 ? tz0 - pz : (pz > tz1 ? pz - tz1 : 0.0);
      const e2z = ez * ez;
      if (e2z >= band2) continue;
      for (let j = j0; j <= j1; j++) {
        const py = oy + <f64>j * h;
        const ey = py < ty0 ? ty0 - py : (py > ty1 ? py - ty1 : 0.0);
        const e2zy = e2z + ey * ey;
        if (e2zy >= band2) continue;
        let idx = i0 + j * sy + k * sz;
        for (let i = i0; i <= i1; i++, idx++) {
          const px = ox + <f64>i * h;
          const cur = <f64>load<f32>(fieldPtr + (<usize>idx) * 4);
          const ex = px < tx0 ? tx0 - px : (px > tx1 ? px - tx1 : 0.0);
          if (e2zy + ex * ex >= cur * cur) continue;
          const d2 = pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
          if (d2 < cur * cur) {
            store<f32>(fieldPtr + (<usize>idx) * 4, <f32>Math.sqrt(d2));
            if (wantClosest) store<i32>(closestPtr + (<usize>idx) * 4, t);
          }
        }
      }
    }
  }
}

/** field を指定値で埋める（JS 側から fill するより往復が減る） */
export function fillField(fieldPtr: usize, count: i32, value: f32): void {
  for (let i = 0; i < count; i++) store<f32>(fieldPtr + (<usize>i) * 4, value);
}

/** closest を -1 で埋める */
export function fillClosest(ptr: usize, count: i32): void {
  for (let i = 0; i < count; i++) store<i32>(ptr + (<usize>i) * 4, -1);
}
