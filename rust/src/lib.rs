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
