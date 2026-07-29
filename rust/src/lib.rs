// ---------------------------------------------------------------------------
// dynafield — Rust → WebAssembly
//
// assembly/dynafield.ts（AssemblyScript 版）と同じ ABI・同じアルゴリズムの
// Rust 実装。どちらが速いかを実測で決めるために両方を残してある。
// js/wasmfield.js は export 名だけを見ているので、.wasm を差し替えるだけで
// 切り替わる。
//
// アロケータは自前のバンプ方式。使い方が「大きいバッファを数本取って
// まとめて返す」だけなので、汎用アロケータの機能は要らない。
// ---------------------------------------------------------------------------

#![allow(non_snake_case)]
// static mut を直接触る。単一スレッド WASM なので競合しない。
#![allow(static_mut_refs)]

// --- バンプアロケータ ------------------------------------------------------
// WASM の線形メモリを直接伸ばす。使い方は毎回
//   「大きいバッファを数本まとめて取る → 使う → まとめて返す」
// なので、確保順のスタックを持って「末尾から解放済みのぶんだけ巻き戻す」
// だけで十分。バッチ内での解放順は問わない（LIFO でなくても回収される）。
//
// スタックが溢れた場合は回収をあきらめる（伸びるだけで、動作は正しい）。

const PAGE: usize = 65536;
const SLOTS: usize = 32;

static mut BUMP: usize = 0; // 次に配る先頭アドレス
static mut LIMIT: usize = 0; // 現在確保済みメモリの終端
static mut STARTS: [usize; SLOTS] = [0; SLOTS]; // 各確保の先頭（0 = 解放済み）
static mut ENDS: [usize; SLOTS] = [0; SLOTS]; // 各確保の終端
static mut SP: usize = 0; // スタックの深さ
static mut OVERFLOW: bool = false; // スロットが溢れた（以後は回収しない）

/// 線形メモリを確保して先頭アドレスを返す。0 は失敗。
#[no_mangle]
pub extern "C" fn alloc(bytes: i32) -> usize {
    if bytes <= 0 {
        return 0;
    }
    unsafe {
        if BUMP == 0 {
            // __heap_base 以降が自由に使える領域。リンカが用意する。
            BUMP = heap_base();
            LIMIT = core::arch::wasm32::memory_size(0) * PAGE;
        }
        // 16 バイト境界に揃える（Float32Array / Int32Array のビューを張るため）
        let p = (BUMP + 15) & !15usize;
        let end = p + bytes as usize;
        if end > LIMIT {
            let need = (end - LIMIT + PAGE - 1) / PAGE;
            if core::arch::wasm32::memory_grow(0, need) == usize::MAX {
                return 0;
            }
            LIMIT += need * PAGE;
        }
        BUMP = end;
        if SP < SLOTS {
            // SP < SLOTS は直前で確認済み。境界チェックを残すと panic 経路として
            // core::fmt が丸ごとリンクされ、wasm が 2.6KB → 18KB に膨らむ。
            *STARTS.get_unchecked_mut(SP) = p;
            *ENDS.get_unchecked_mut(SP) = end;
            SP += 1;
        } else {
            OVERFLOW = true;
        }
        p
    }
}

#[no_mangle]
pub extern "C" fn release(ptr: usize) {
    if ptr == 0 {
        return;
    }
    unsafe {
        if OVERFLOW {
            return; // 追跡しきれていないので回収は行わない
        }
        let mut i = SP;
        while i > 0 {
            i -= 1;
            if *STARTS.get_unchecked(i) == ptr {
                *STARTS.get_unchecked_mut(i) = 0;
                break;
            }
        }
        // 末尾の解放済みスロットをまとめて巻き戻す
        while SP > 0 && *STARTS.get_unchecked(SP - 1) == 0 {
            SP -= 1;
        }
        BUMP = if SP > 0 { *ENDS.get_unchecked(SP - 1) } else { heap_base() };
    }
}

fn heap_base() -> usize {
    extern "C" {
        static __heap_base: u8;
    }
    unsafe { &__heap_base as *const u8 as usize }
}

// --- 点と三角形の最短距離の 2 乗（Ericson, Real-Time Collision Detection）--

#[inline(always)]
fn point_tri_dist2(
    px: f64, py: f64, pz: f64,
    ax: f64, ay: f64, az: f64,
    bx: f64, by: f64, bz: f64,
    cx: f64, cy: f64, cz: f64,
) -> f64 {
    let (abx, aby, abz) = (bx - ax, by - ay, bz - az);
    let (acx, acy, acz) = (cx - ax, cy - ay, cz - az);
    let (apx, apy, apz) = (px - ax, py - ay, pz - az);
    let d1 = abx * apx + aby * apy + abz * apz;
    let d2 = acx * apx + acy * apy + acz * apz;
    if d1 <= 0.0 && d2 <= 0.0 {
        return apx * apx + apy * apy + apz * apz;
    }

    let (bpx, bpy, bpz) = (px - bx, py - by, pz - bz);
    let d3 = abx * bpx + aby * bpy + abz * bpz;
    let d4 = acx * bpx + acy * bpy + acz * bpz;
    if d3 >= 0.0 && d4 <= d3 {
        return bpx * bpx + bpy * bpy + bpz * bpz;
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        let (x, y, z) = (apx - abx * v, apy - aby * v, apz - abz * v);
        return x * x + y * y + z * z;
    }

    let (cpx, cpy, cpz) = (px - cx, py - cy, pz - cz);
    let d5 = abx * cpx + aby * cpy + abz * cpz;
    let d6 = acx * cpx + acy * cpy + acz * cpz;
    if d6 >= 0.0 && d5 <= d6 {
        return cpx * cpx + cpy * cpy + cpz * cpz;
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        let (x, y, z) = (apx - acx * w, apy - acy * w, apz - acz * w);
        return x * x + y * y + z * z;
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        let x = bpx + (cpx - bpx) * w;
        let y = bpy + (cpy - bpy) * w;
        let z = bpz + (cpz - bpz) * w;
        return x * x + y * y + z * z;
    }

    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    let x = apx - (abx * v + acx * w);
    let y = apy - (aby * v + acy * w);
    let z = apz - (abz * v + acz * w);
    x * x + y * y + z * z
}

// --- 距離場スプラット ------------------------------------------------------

/// field は事前に band で埋めておくこと。closest_ptr に 0 を渡すと
/// 最近傍三角形の記録を省略する。
///
/// field / closest は [k_begin, k_end] のスラブぶんだけを持つ配列で、
/// 添字は i + j*nx + (k - k_begin)*nx*ny。
#[no_mangle]
pub extern "C" fn splat(
    pos_ptr: usize, tri_ptr: usize, nt: i32,
    field_ptr: usize, closest_ptr: usize,
    nx: i32, ny: i32, nz: i32,
    k_begin: i32, k_end: i32,
    ox: f64, oy: f64, oz: f64, h: f64, band: f64,
) {
    let _ = nz;
    let pos = pos_ptr as *const f32;
    let tri = tri_ptr as *const i32;
    let field = field_ptr as *mut f32;
    let closest = closest_ptr as *mut i32;
    let want_closest = closest_ptr != 0;

    let sy = nx;
    let sz = nx * ny;
    let band2 = band * band;
    let inv_h = 1.0 / h;

    unsafe {
        for t in 0..nt {
            let tb = tri.add((t * 3) as usize);
            let ia = *tb;
            let ib = *tb.add(1);
            let ic = *tb.add(2);
            if ia == ib && ib == ic {
                continue;
            }

            let pa = pos.add((ia * 3) as usize);
            let pb = pos.add((ib * 3) as usize);
            let pc = pos.add((ic * 3) as usize);
            let (ax, ay, az) = (*pa as f64, *pa.add(1) as f64, *pa.add(2) as f64);
            let (bx, by, bz) = (*pb as f64, *pb.add(1) as f64, *pb.add(2) as f64);
            let (cx, cy, cz) = (*pc as f64, *pc.add(1) as f64, *pc.add(2) as f64);

            let tx0 = ax.min(bx.min(cx));
            let tx1 = ax.max(bx.max(cx));
            let ty0 = ay.min(by.min(cy));
            let ty1 = ay.max(by.max(cy));
            let tz0 = az.min(bz.min(cz));
            let tz1 = az.max(bz.max(cz));

            let mut i0 = ((tx0 - band - ox) * inv_h).ceil() as i32;
            if i0 < 0 { i0 = 0; }
            let mut i1 = ((tx1 + band - ox) * inv_h).floor() as i32;
            if i1 > nx - 1 { i1 = nx - 1; }
            let mut j0 = ((ty0 - band - oy) * inv_h).ceil() as i32;
            if j0 < 0 { j0 = 0; }
            let mut j1 = ((ty1 + band - oy) * inv_h).floor() as i32;
            if j1 > ny - 1 { j1 = ny - 1; }
            let mut k0 = ((tz0 - band - oz) * inv_h).ceil() as i32;
            if k0 < k_begin { k0 = k_begin; }
            let mut k1 = ((tz1 + band - oz) * inv_h).floor() as i32;
            if k1 > k_end { k1 = k_end; }

            let mut k = k0;
            while k <= k1 {
                let pz = oz + k as f64 * h;
                let ez = if pz < tz0 { tz0 - pz } else if pz > tz1 { pz - tz1 } else { 0.0 };
                let e2z = ez * ez;
                if e2z >= band2 { k += 1; continue; }
                let mut j = j0;
                while j <= j1 {
                    let py = oy + j as f64 * h;
                    let ey = if py < ty0 { ty0 - py } else if py > ty1 { py - ty1 } else { 0.0 };
                    let e2zy = e2z + ey * ey;
                    if e2zy >= band2 { j += 1; continue; }
                    let mut idx = i0 + j * sy + (k - k_begin) * sz;
                    let mut i = i0;
                    while i <= i1 {
                        let px = ox + i as f64 * h;
                        let cur = *field.add(idx as usize) as f64;
                        let ex = if px < tx0 { tx0 - px } else if px > tx1 { px - tx1 } else { 0.0 };
                        if e2zy + ex * ex < cur * cur {
                            let d2 = point_tri_dist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
                            if d2 < cur * cur {
                                *field.add(idx as usize) = d2.sqrt() as f32;
                                if want_closest {
                                    *closest.add(idx as usize) = t;
                                }
                            }
                        }
                        i += 1;
                        idx += 1;
                    }
                    j += 1;
                }
                k += 1;
            }
        }
    }
}

/// field を指定値で埋める（JS 側から fill するより往復が減る）
#[no_mangle]
pub extern "C" fn fillField(field_ptr: usize, count: i32, value: f32) {
    let p = field_ptr as *mut f32;
    unsafe {
        for i in 0..count as usize {
            *p.add(i) = value;
        }
    }
}

/// closest を -1 で埋める
#[no_mangle]
pub extern "C" fn fillClosest(ptr: usize, count: i32) {
    let p = ptr as *mut i32;
    unsafe {
        for i in 0..count as usize {
            *p.add(i) = -1;
        }
    }
}

// --- 頂点法線 --------------------------------------------------------------
// 面法線（正規化しない = 面積加重）を 3 頂点へ足し込んでから正規化する。
// JS 版（SculptMesh.computeAllNormals）と同じ式・同じ退避値。
// トポロジが変わるたびに呼ばれるので、ここが速いと全機能が速くなる。

#[no_mangle]
pub extern "C" fn normals(pos_ptr: usize, tri_ptr: usize, nt: i32, nrm_ptr: usize, nv: i32) {
    let pos = pos_ptr as *const f32;
    let tri = tri_ptr as *const i32;
    let nrm = nrm_ptr as *mut f32;
    unsafe {
        for i in 0..(nv as usize) * 3 {
            *nrm.add(i) = 0.0;
        }
        for t in 0..nt as usize {
            let tb = tri.add(t * 3);
            let ia = *tb;
            let ib = *tb.add(1);
            let ic = *tb.add(2);
            if ia == ib && ib == ic {
                continue;
            }
            let a = (ia * 3) as usize;
            let b = (ib * 3) as usize;
            let c = (ic * 3) as usize;
            // JS は Float32Array を読んだ時点で f64 に昇格し、格納のときだけ
            // f32 に丸める。同じ結果にするには中間計算を f64 で行う必要がある。
            // f32 のまま計算すると法線が 1e-7 ほどずれた（実測）。
            let e1x = *pos.add(b) as f64 - *pos.add(a) as f64;
            let e1y = *pos.add(b + 1) as f64 - *pos.add(a + 1) as f64;
            let e1z = *pos.add(b + 2) as f64 - *pos.add(a + 2) as f64;
            let e2x = *pos.add(c) as f64 - *pos.add(a) as f64;
            let e2y = *pos.add(c + 1) as f64 - *pos.add(a + 1) as f64;
            let e2z = *pos.add(c + 2) as f64 - *pos.add(a + 2) as f64;
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            *nrm.add(a) = (*nrm.add(a) as f64 + nx) as f32;
            *nrm.add(a + 1) = (*nrm.add(a + 1) as f64 + ny) as f32;
            *nrm.add(a + 2) = (*nrm.add(a + 2) as f64 + nz) as f32;
            *nrm.add(b) = (*nrm.add(b) as f64 + nx) as f32;
            *nrm.add(b + 1) = (*nrm.add(b + 1) as f64 + ny) as f32;
            *nrm.add(b + 2) = (*nrm.add(b + 2) as f64 + nz) as f32;
            *nrm.add(c) = (*nrm.add(c) as f64 + nx) as f32;
            *nrm.add(c + 1) = (*nrm.add(c + 1) as f64 + ny) as f32;
            *nrm.add(c + 2) = (*nrm.add(c + 2) as f64 + nz) as f32;
        }
        for v in 0..nv as usize {
            let i = v * 3;
            // JS 版と 1 ビットまで同じ結果にするため、正規化は f64 で行う。
            // JS の `N[i]*N[i] + …` は f64 に昇格して計算されるので、こちらも
            // f32 のまま二乗和を取ると 1e-7 ほどずれる（実測で確認した）。
            let x = *nrm.add(i) as f64;
            let y = *nrm.add(i + 1) as f64;
            let z = *nrm.add(i + 2) as f64;
            let l = (x * x + y * y + z * z).sqrt();
            if l > 1e-20 {
                *nrm.add(i) = (x / l) as f32;
                *nrm.add(i + 1) = (y / l) as f32;
                *nrm.add(i + 2) = (z / l) as f32;
            } else {
                *nrm.add(i) = 0.0;
                *nrm.add(i + 1) = 1.0;
                *nrm.add(i + 2) = 0.0;
            }
        }
    }
}

// --- 平均曲率（正規化） ----------------------------------------------------
// 1-ring の重心へ向かうベクトルを法線へ射影して、平均辺長で割った量。
// 真の曲率半径ではないが -1..1 に収まり、彫刻の「見た目の細かさ」に対応する。
// JS 版（SculptMesh.computeAllCurvature）と同じ式・同じ平滑化量。
//
// scratch は f32 で nv*5 個（sum: 3, e2: 1, cnt: 1）。JS 側で確保して渡す。
// ここで alloc するとメモリが伸びて JS 側のビューが外れるため。

#[no_mangle]
pub extern "C" fn curvature(
    pos_ptr: usize, nrm_ptr: usize, tri_ptr: usize, nt: i32,
    curv_ptr: usize, nv: i32, scratch_ptr: usize,
) {
    let pos = pos_ptr as *const f32;
    let nrm = nrm_ptr as *const f32;
    let tri = tri_ptr as *const i32;
    let cv = curv_ptr as *mut f32;
    let n = nv as usize;
    let s = scratch_ptr as *mut f32; // [0, 3n) = sum
    unsafe {
        let e2 = s.add(3 * n); // [0, n)
        let cnt = s.add(4 * n); // [0, n)
        for i in 0..3 * n {
            *s.add(i) = 0.0;
        }
        for i in 0..n {
            *e2.add(i) = 0.0;
            *cnt.add(i) = 0.0;
        }

        for t in 0..nt as usize {
            let tb = tri.add(t * 3);
            let ia = *tb;
            let ib = *tb.add(1);
            let ic = *tb.add(2);
            if ia == ib && ib == ic {
                continue;
            }
            let a = (ia * 3) as usize;
            let b = (ib * 3) as usize;
            let c = (ic * 3) as usize;
            // 法線と同じ理由で中間計算は f64（JS の昇格に合わせる）
            let abx = *pos.add(b) as f64 - *pos.add(a) as f64;
            let aby = *pos.add(b + 1) as f64 - *pos.add(a + 1) as f64;
            let abz = *pos.add(b + 2) as f64 - *pos.add(a + 2) as f64;
            let acx = *pos.add(c) as f64 - *pos.add(a) as f64;
            let acy = *pos.add(c + 1) as f64 - *pos.add(a + 1) as f64;
            let acz = *pos.add(c + 2) as f64 - *pos.add(a + 2) as f64;
            let bcx = *pos.add(c) as f64 - *pos.add(b) as f64;
            let bcy = *pos.add(c + 1) as f64 - *pos.add(b + 1) as f64;
            let bcz = *pos.add(c + 2) as f64 - *pos.add(b + 2) as f64;
            let lab = abx * abx + aby * aby + abz * abz;
            let lac = acx * acx + acy * acy + acz * acz;
            let lbc = bcx * bcx + bcy * bcy + bcz * bcz;
            let add = |p: *mut f32, i: usize, x: f64| {
                *p.add(i) = (*p.add(i) as f64 + x) as f32;
            };
            add(s, a, abx + acx);
            add(s, a + 1, aby + acy);
            add(s, a + 2, abz + acz);
            add(s, b, bcx - abx);
            add(s, b + 1, bcy - aby);
            add(s, b + 2, bcz - abz);
            add(s, c, -acx - bcx);
            add(s, c + 1, -acy - bcy);
            add(s, c + 2, -acz - bcz);
            add(e2, ia as usize, lab + lac);
            add(e2, ib as usize, lab + lbc);
            add(e2, ic as usize, lac + lbc);
            *cnt.add(ia as usize) += 2.0;
            *cnt.add(ib as usize) += 2.0;
            *cnt.add(ic as usize) += 2.0;
        }

        for v in 0..n {
            let k = *cnt.add(v);
            if k == 0.0 || *e2.add(v) <= 0.0 {
                *cv.add(v) = 0.0;
                continue;
            }
            let iv = v * 3;
            let inv = 1.0 / k as f64;
            let e = ((*e2.add(v) as f64) * inv).sqrt();
            // 内積も f64 で。JS 側は f64 に昇格して計算している。
            let dot = *s.add(iv) as f64 * *nrm.add(iv) as f64
                + *s.add(iv + 1) as f64 * *nrm.add(iv + 1) as f64
                + *s.add(iv + 2) as f64 * *nrm.add(iv + 2) as f64;
            let d = dot * inv / e;
            *cv.add(v) = if d < -1.0 { -1.0 } else if d > 1.0 { 1.0 } else { d as f32 };
        }

        // 平滑化も三角形走査で。sum の先頭 n 個を作業領域として使い回す。
        for i in 0..n {
            *s.add(i) = 0.0;
            *cnt.add(i) = 0.0;
        }
        for t in 0..nt as usize {
            let tb = tri.add(t * 3);
            let ia = *tb;
            let ib = *tb.add(1);
            let ic = *tb.add(2);
            if ia == ib && ib == ic {
                continue;
            }
            let (a, b, c) = (ia as usize, ib as usize, ic as usize);
            let ca = *cv.add(a) as f64;
            let cb = *cv.add(b) as f64;
            let cc = *cv.add(c) as f64;
            *s.add(a) = (*s.add(a) as f64 + (cb + cc)) as f32;
            *s.add(b) = (*s.add(b) as f64 + (cc + ca)) as f32;
            *s.add(c) = (*s.add(c) as f64 + (ca + cb)) as f32;
            *cnt.add(a) += 2.0;
            *cnt.add(b) += 2.0;
            *cnt.add(c) += 2.0;
        }
        let amount = 0.55f64;
        for v in 0..n {
            let k = *cnt.add(v);
            if k == 0.0 {
                continue;
            }
            let c = *cv.add(v) as f64;
            *cv.add(v) = (c + (*s.add(v) as f64 / k as f64 - c) * amount) as f32;
        }
    }
}

// --- 表面への投影（リメッシュ） --------------------------------------------
// 一様格子（CSR）に入れた元の三角形から、点ごとに最近点を引いて書き戻す。
// リメッシュの反復あたり 90 万クエリ走るところ。
//
// 打ち切りの下界は「走査済みボックスの面までの実距離」を使う。ring*h に
// すると ring=0 で 0 になり、必ず 27 セルまで見てしまう（JS 版と同じ判断）。

/// 点と三角形の最近点を out3 へ書き、距離の 2 乗を返す
#[inline(always)]
unsafe fn closest_on_tri(
    px: f64, py: f64, pz: f64,
    pos: *const f32, a: usize, b: usize, c: usize,
    out: *mut f64,
) -> f64 {
    let ax = *pos.add(a) as f64;
    let ay = *pos.add(a + 1) as f64;
    let az = *pos.add(a + 2) as f64;
    let bx = *pos.add(b) as f64;
    let by = *pos.add(b + 1) as f64;
    let bz = *pos.add(b + 2) as f64;
    let cx = *pos.add(c) as f64;
    let cy = *pos.add(c + 1) as f64;
    let cz = *pos.add(c + 2) as f64;

    let (abx, aby, abz) = (bx - ax, by - ay, bz - az);
    let (acx, acy, acz) = (cx - ax, cy - ay, cz - az);
    let (apx, apy, apz) = (px - ax, py - ay, pz - az);
    let d1 = abx * apx + aby * apy + abz * apz;
    let d2 = acx * apx + acy * apy + acz * apz;
    if d1 <= 0.0 && d2 <= 0.0 {
        *out = ax; *out.add(1) = ay; *out.add(2) = az;
        return apx * apx + apy * apy + apz * apz;
    }
    let (bpx, bpy, bpz) = (px - bx, py - by, pz - bz);
    let d3 = abx * bpx + aby * bpy + abz * bpz;
    let d4 = acx * bpx + acy * bpy + acz * bpz;
    if d3 >= 0.0 && d4 <= d3 {
        *out = bx; *out.add(1) = by; *out.add(2) = bz;
        return bpx * bpx + bpy * bpy + bpz * bpz;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        *out = ax + abx * v; *out.add(1) = ay + aby * v; *out.add(2) = az + abz * v;
        // 距離は「点から見た相対ベクトル」で計算する。最近点から引き算すると
        // 数値が変わり、JS 版と結果がずれる（実測で 6e-8 の差が出た）。
        let (x, y, z) = (apx - abx * v, apy - aby * v, apz - abz * v);
        return x * x + y * y + z * z;
    }
    let (cpx, cpy, cpz) = (px - cx, py - cy, pz - cz);
    let d5 = abx * cpx + aby * cpy + abz * cpz;
    let d6 = acx * cpx + acy * cpy + acz * cpz;
    if d6 >= 0.0 && d5 <= d6 {
        *out = cx; *out.add(1) = cy; *out.add(2) = cz;
        return cpx * cpx + cpy * cpy + cpz * cpz;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        *out = ax + acx * w; *out.add(1) = ay + acy * w; *out.add(2) = az + acz * w;
        let (x, y, z) = (apx - acx * w, apy - acy * w, apz - acz * w);
        return x * x + y * y + z * z;
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        *out = bx + (cx - bx) * w;
        *out.add(1) = by + (cy - by) * w;
        *out.add(2) = bz + (cz - bz) * w;
        let (x, y, z) = (bpx + (cpx - bpx) * w, bpy + (cpy - bpy) * w, bpz + (cpz - bpz) * w);
        return x * x + y * y + z * z;
    }
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    *out = ax + abx * v + acx * w;
    *out.add(1) = ay + aby * v + acy * w;
    *out.add(2) = az + abz * v + acz * w;
    let x = apx - (abx * v + acx * w);
    let y = apy - (aby * v + acy * w);
    let z = apz - (abz * v + acz * w);
    x * x + y * y + z * z
}

/// 1 点だけを格子から引く。当たった三角形を返す（-1 で見つからず）
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn grid_closest(
    px: f64, py: f64, pz: f64,
    pos: *const f32, idx: *const i32, off: *const i32, cell_tri: *const i32,
    nx: i32, ny: i32, nz: i32,
    ox: f64, oy: f64, oz: f64, h: f64,
    out: *mut f64, tmp: *mut f64,
) -> i32 {
    let clamp = |v: i32, n: i32| if v < 0 { 0 } else if v >= n { n - 1 } else { v };
    let ci = clamp(((px - ox) / h).floor() as i32, nx);
    let cj = clamp(((py - oy) / h).floor() as i32, ny);
    let ck = clamp(((pz - oz) / h).floor() as i32, nz);
    let mut best = f64::INFINITY;
    let mut best_tri = -1i32;
    let sz = nx * ny;
    for ring in 0..=4i32 {
        let i0 = (ci - ring).max(0);
        let i1 = (ci + ring).min(nx - 1);
        let j0 = (cj - ring).max(0);
        let j1 = (cj + ring).min(ny - 1);
        let k0 = (ck - ring).max(0);
        let k1 = (ck + ring).min(nz - 1);
        let mut k = k0;
        while k <= k1 {
            let mut j = j0;
            while j <= j1 {
                let mut i = i0;
                while i <= i1 {
                    // 外殻だけ見る（内側は前の ring で見ている）
                    if ring > 0 && i > i0 && i < i1 && j > j0 && j < j1 && k > k0 && k < k1 {
                        i += 1;
                        continue;
                    }
                    let c = (i + j * nx + k * sz) as usize;
                    let mut q = *off.add(c);
                    let qe = *off.add(c + 1);
                    while q < qe {
                        let ti = *cell_tri.add(q as usize);
                        let tb = idx.add((ti * 3) as usize);
                        let d = closest_on_tri(
                            px, py, pz, pos,
                            (*tb * 3) as usize, (*tb.add(1) * 3) as usize, (*tb.add(2) * 3) as usize,
                            tmp,
                        );
                        if d < best {
                            best = d;
                            *out = *tmp;
                            *out.add(1) = *tmp.add(1);
                            *out.add(2) = *tmp.add(2);
                            best_tri = ti;
                        }
                        q += 1;
                    }
                    i += 1;
                }
                j += 1;
            }
            k += 1;
        }
        // 走査済みボックスの面までの距離が下界になる
        let bx0 = px - (ox + (ci - ring) as f64 * h);
        let bx1 = (ox + (ci + ring + 1) as f64 * h) - px;
        let by0 = py - (oy + (cj - ring) as f64 * h);
        let by1 = (oy + (cj + ring + 1) as f64 * h) - py;
        let bz0 = pz - (oz + (ck - ring) as f64 * h);
        let bz1 = (oz + (ck + ring + 1) as f64 * h) - pz;
        let bound = bx0.min(bx1).min(by0).min(by1).min(bz0).min(bz1);
        if best_tri >= 0 && best <= bound * bound {
            break;
        }
    }
    best_tri
}

/// 点群をまとめて表面へ投影する。
///
/// * `tgt` は投影したい点（f32、count*3）。結果をその場に書き戻す。
/// * `hint` は点ごとの「前回当たった三角形」（i32、count）。更新して返す。
///   -1 はヒント無し。`hint_max_d2` を超える当たりは古いヒントとして捨てる。
/// * `skip` は 0 以外なら投影しない点（u8、count）。JS 側で「動いていない」
///   「死んでいる」を判断して渡す。
/// * 戻り値は下位 24bit に投影できた数、上位にヒントで済んだ数を詰めて返す
///   ……のような詰め込みはしない。代わりに `stats`（i32×2）へ書く。
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn projectPoints(
    tgt_ptr: usize, hint_ptr: usize, skip_ptr: usize, count: i32,
    pos_ptr: usize, idx_ptr: usize, off_ptr: usize, cell_ptr: usize,
    nx: i32, ny: i32, nz: i32,
    ox: f64, oy: f64, oz: f64, h: f64,
    hint_max_d2: f64, stats_ptr: usize,
) {
    let tgt = tgt_ptr as *mut f32;
    let hint = hint_ptr as *mut i32;
    let skip = skip_ptr as *const u8;
    let pos = pos_ptr as *const f32;
    let idx = idx_ptr as *const i32;
    let off = off_ptr as *const i32;
    let cell = cell_ptr as *const i32;
    let stats = stats_ptr as *mut i32;
    let mut out = [0.0f64; 3];
    let mut tmp = [0.0f64; 3];
    let mut projected = 0i32;
    let mut hinted = 0i32;
    unsafe {
        let po = out.as_mut_ptr();
        let pt = tmp.as_mut_ptr();
        for v in 0..count as usize {
            if *skip.add(v) != 0 {
                continue;
            }
            let i = v * 3;
            let px = *tgt.add(i) as f64;
            let py = *tgt.add(i + 1) as f64;
            let pz = *tgt.add(i + 2) as f64;

            // まず前回当たった三角形だけを試す
            let hv = *hint.add(v);
            if hv >= 0 {
                let tb = idx.add((hv * 3) as usize);
                let a = (*tb * 3) as usize;
                let b = (*tb.add(1) * 3) as usize;
                let c = (*tb.add(2) * 3) as usize;
                let d = closest_on_tri(px, py, pz, pos, a, b, c, po);
                if d <= hint_max_d2 {
                    // 頂点にクランプされていたら隣の面のほうが近いことがあるので却下
                    let ex = 1e-12;
                    let near = |vi: usize| {
                        let dx = out[0] - *pos.add(vi) as f64;
                        let dy = out[1] - *pos.add(vi + 1) as f64;
                        let dz = out[2] - *pos.add(vi + 2) as f64;
                        dx * dx + dy * dy + dz * dz < ex
                    };
                    if !near(a) && !near(b) && !near(c) {
                        *tgt.add(i) = out[0] as f32;
                        *tgt.add(i + 1) = out[1] as f32;
                        *tgt.add(i + 2) = out[2] as f32;
                        projected += 1;
                        hinted += 1;
                        continue;
                    }
                }
            }

            let ti = grid_closest(
                px, py, pz, pos, idx, off, cell, nx, ny, nz, ox, oy, oz, h, po, pt,
            );
            if ti >= 0 {
                *hint.add(v) = ti;
                *tgt.add(i) = out[0] as f32;
                *tgt.add(i + 1) = out[1] as f32;
                *tgt.add(i + 2) = out[2] as f32;
                projected += 1;
            }
        }
        *stats = projected;
        *stats.add(1) = hinted;
    }
}
