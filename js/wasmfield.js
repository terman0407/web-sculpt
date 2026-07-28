// ---------------------------------------------------------------------------
// wasmfield.js
// ダイナメッシュの距離場スプラットを WebAssembly で実行する（js/dynamesh.js の
// フォールバック付き高速版）。読み込めなければ静かに JS 版へ戻るので、
// このモジュールが失敗しても機能は落ちない。
//
// 3M ポリゴンのダイナメッシュでは距離場が全体の約 9 割を占めるため、
// ここだけ WASM 化すると全体で 1.4〜1.5 倍になる。
//
// スレッドも SharedArrayBuffer も使わない単一スレッド WASM なので、
// COOP/COEP ヘッダを付けられない GitHub Pages でもそのまま動く。
// 単一ファイル版では下の WASM_B64 をビルド時に埋め込むため、
// fetch を一切使わず file:// からも動く。
// ---------------------------------------------------------------------------

// build.mjs が単一ファイル版を作るとき、この行を base64 文字列に差し替える。
const WASM_B64 = '';

// wasm/ の場所はページからの相対。GitHub Pages のサブパス配信でも正しく解決される。
const WASM_URL = 'wasm/dynafield.wasm';

let W = null;             // instance.exports
let WMod = null;          // WebAssembly.Module（ワーカーへ渡す）
let state = 'idle';       // idle | loading | ready | failed
let failReason = '';

export function wasmFieldState() { return state; }
export function wasmFieldReady() { return state === 'ready'; }
export function wasmFieldError() { return failReason; }
/** ワーカーに渡す用のコンパイル済みモジュール */
export function wasmFieldModule() { return WMod; }

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * すでに手元にあるバイト列から初期化する（Node のテスト / ベンチ用）。
 */
export async function initWasmFieldFromBytes(bytes) {
  try {
    const { instance, module } = await WebAssembly.instantiate(bytes, {
      env: { abort() { throw new Error('wasm abort'); } },
    });
    W = instance.exports;
    WMod = module;
    state = 'ready';
    return true;
  } catch (err) {
    failReason = String(err && err.message || err);
    state = 'failed';
    W = null;
    return false;
  }
}

/**
 * WASM を読み込む。起動時に一度だけ呼べばよい（await しなくてもよい）。
 * 失敗しても例外は投げず、JS 版フォールバックのままになる。
 */
export async function initWasmField() {
  if (state !== 'idle') return state === 'ready';
  state = 'loading';
  try {
    let bytes;
    if (WASM_B64) {
      bytes = base64ToBytes(WASM_B64);
    } else {
      if (typeof fetch !== 'function') throw new Error('fetch が使えません');
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error(`${WASM_URL} が ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    const { instance, module } = await WebAssembly.instantiate(bytes, {
      env: { abort() { throw new Error('wasm abort'); } },
    });
    WMod = module;
    const e = instance.exports;
    for (const fn of ['alloc', 'release', 'splat', 'fillField', 'fillClosest', 'memory']) {
      if (!e[fn]) throw new Error(`export ${fn} がありません`);
    }
    W = e;
    state = 'ready';
    return true;
  } catch (err) {
    failReason = String(err && err.message || err);
    state = 'failed';
    W = null;
    return false;
  }
}

/**
 * 距離場スプラットを WASM で実行して field / closest を埋める。
 * @returns {boolean} 実行できたか（false なら呼び出し側が JS 版を走らせる）
 */
export function wasmSplat(mesh, field, closest, g) {
  if (state !== 'ready' || !W) return false;
  const nv = mesh.nv, nt = mesh.nt;
  const total = field.length;
  if (nv === 0 || nt === 0 || total === 0) return false;

  let pPos = 0, pTri = 0, pField = 0, pClose = 0;
  try {
    // 先にすべて確保する。alloc でメモリが伸びるとビューが無効になるため、
    // ビューは確保が全部終わってから作る。
    pPos = W.alloc(nv * 12);
    pTri = W.alloc(nt * 12);
    pField = W.alloc(total * 4);
    pClose = closest ? W.alloc(total * 4) : 0;
    if (!pPos || !pTri || !pField || (closest && !pClose)) throw new Error('alloc 失敗');

    const buf = W.memory.buffer;
    new Float32Array(buf, pPos, nv * 3).set(mesh.positions.subarray(0, nv * 3));
    new Int32Array(buf, pTri, nt * 3).set(mesh.tris.subarray(0, nt * 3));
    W.fillField(pField, total, g.band);
    if (pClose) W.fillClosest(pClose, total);

    W.splat(pPos, pTri, nt, pField, pClose,
      g.nx, g.ny, g.nz, 0, g.nz - 1, g.ox, g.oy, g.oz, g.h, g.band);

    // 結果を JS 側の配列へ戻す（以降の処理は通常の TypedArray 上で行う）
    const b2 = W.memory.buffer;
    field.set(new Float32Array(b2, pField, total));
    if (closest) closest.set(new Int32Array(b2, pClose, total));
    return true;
  } catch (err) {
    failReason = String(err && err.message || err);
    return false;
  } finally {
    if (pClose) W.release(pClose);
    if (pField) W.release(pField);
    if (pTri) W.release(pTri);
    if (pPos) W.release(pPos);
  }
}
