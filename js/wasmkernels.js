// ---------------------------------------------------------------------------
// wasmkernels.js
// 平坦な配列だけを触る重いループを WebAssembly で実行する。読み込めなければ
// 静かに JS 版へ戻るので、このモジュールが失敗しても機能は落ちない。
//
// 入っているもの:
//   splat         ダイナメッシュの距離場（3M ポリゴンでは全体の約 9 割）
//   normals       頂点法線。トポロジが変わるたびに走る
//   curvature     平均曲率。同じく毎回走り、法線の 2 倍かかる
//   projectPoints リメッシュの表面投影。反復あたり 90 万クエリ
//
// 「WASM に出す価値があるか」は往復のコストと比べて決めた。2,621,442 頂点
// （位置 30MB + 三角形 60MB）の出し入れは実測 3.2ms で、上のどれも 50ms 以上
// かかるので、往復は問題にならない。逆にブラシの 1 ダブのような小さい領域は
// 出しても意味がないので JS のままにしてある。
//
// スレッドも SharedArrayBuffer も使わない単一スレッド WASM なので、
// COOP/COEP ヘッダを付けられない GitHub Pages でもそのまま動く。
// 単一ファイル版では下の WASM_B64 をビルド時に埋め込むため、
// fetch を一切使わず file:// からも動く。
// ---------------------------------------------------------------------------

// build.mjs が単一ファイル版を作るとき、この行を base64 文字列に差し替える。
const WASM_B64 = '';

// wasm/ の場所はページからの相対。GitHub Pages のサブパス配信でも正しく解決される。
const WASM_URL = 'wasm/kernels.wasm';

let W = null;             // instance.exports
let WMod = null;          // WebAssembly.Module（ワーカーへ渡す）
let state = 'idle';       // idle | loading | ready | failed
let failReason = '';
let enabled = true;       // false にすると全カーネルが JS フォールバックに落ちる

export function wasmFieldState() { return state; }
export function wasmFieldReady() { return state === 'ready' && enabled; }
export function wasmFieldError() { return failReason; }
/**
 * WASM 経路を切る / 戻す。JS 版との突き合わせテストと、
 * 「WASM のせいで結果が変わっていないか」を切り分ける診断のためにある。
 */
export function setWasmKernels(on) { enabled = !!on; }

/** 各カーネルの入口で使う共通判定 */
function usable() { return enabled && state === 'ready' && W !== null; }
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
 * すでにコンパイル済みのモジュールから初期化する（ワーカー用）。
 * WebAssembly.Module は構造化複製で渡せるので、ワーカーで再コンパイルせずに済む。
 */
export async function initWasmFieldFromModule(mod) {
  if (state === 'ready') return true;
  try {
    const instance = await WebAssembly.instantiate(mod, {
      env: { abort() { throw new Error('wasm abort'); } },
    });
    W = instance.exports;
    WMod = mod;
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
    for (const fn of ['alloc', 'release', 'splat', 'fillField', 'fillClosest',
      'normals', 'curvature', 'projectPoints', 'memory']) {
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
  if (!usable()) return false;
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

// --- 法線 / 曲率 -----------------------------------------------------------
// どちらもトポロジが変わるたびに全頂点で走る。260 万頂点で JS だと
// 法線 58ms + 曲率 122ms かかり、Divide・変形・リメッシュ・ダイナメッシュの
// すべてがこの 180ms を共通で払っていた。
//
// alloc でメモリが伸びるとビューが無効になるので、確保を全部済ませてから
// ビューを作るという順序は崩さないこと（splat と同じ）。

/**
 * 頂点法線を WASM で作って mesh.normals へ書き戻す。
 * @returns {boolean} 実行できたか（false なら呼び出し側が JS 版を走らせる）
 */
export function wasmNormals(mesh) {
  if (!usable()) return false;
  const nv = mesh.nv, nt = mesh.nt;
  if (nv === 0 || nt === 0) return false;
  let pPos = 0, pTri = 0, pNrm = 0;
  try {
    pPos = W.alloc(nv * 12);
    pTri = W.alloc(nt * 12);
    pNrm = W.alloc(nv * 12);
    if (!pPos || !pTri || !pNrm) throw new Error('alloc 失敗');
    const buf = W.memory.buffer;
    new Float32Array(buf, pPos, nv * 3).set(mesh.positions.subarray(0, nv * 3));
    new Int32Array(buf, pTri, nt * 3).set(mesh.tris.subarray(0, nt * 3));
    W.normals(pPos, pTri, nt, pNrm, nv);
    mesh.normals.set(new Float32Array(W.memory.buffer, pNrm, nv * 3));
    return true;
  } catch (err) {
    failReason = String(err && err.message || err);
    return false;
  } finally {
    if (pNrm) W.release(pNrm);
    if (pTri) W.release(pTri);
    if (pPos) W.release(pPos);
  }
}

/**
 * 平均曲率を WASM で作って mesh.curv へ書き戻す。
 * 法線が最新であることを前提にする（JS 版と同じ）。
 * @returns {boolean} 実行できたか
 */
export function wasmCurvature(mesh) {
  if (!usable()) return false;
  const nv = mesh.nv, nt = mesh.nt;
  if (nv === 0 || nt === 0) return false;
  let pPos = 0, pNrm = 0, pTri = 0, pCv = 0, pScr = 0;
  try {
    pPos = W.alloc(nv * 12);
    pNrm = W.alloc(nv * 12);
    pTri = W.alloc(nt * 12);
    pCv = W.alloc(nv * 4);
    pScr = W.alloc(nv * 20);          // sum(3) + e2(1) + cnt(1) を f32 で
    if (!pPos || !pNrm || !pTri || !pCv || !pScr) throw new Error('alloc 失敗');
    const buf = W.memory.buffer;
    new Float32Array(buf, pPos, nv * 3).set(mesh.positions.subarray(0, nv * 3));
    new Float32Array(buf, pNrm, nv * 3).set(mesh.normals.subarray(0, nv * 3));
    new Int32Array(buf, pTri, nt * 3).set(mesh.tris.subarray(0, nt * 3));
    W.curvature(pPos, pNrm, pTri, nt, pCv, nv, pScr);
    mesh.curv.set(new Float32Array(W.memory.buffer, pCv, nv));
    return true;
  } catch (err) {
    failReason = String(err && err.message || err);
    return false;
  } finally {
    if (pScr) W.release(pScr);
    if (pCv) W.release(pCv);
    if (pTri) W.release(pTri);
    if (pNrm) W.release(pNrm);
    if (pPos) W.release(pPos);
  }
}

// --- リメッシュの表面投影 --------------------------------------------------
// 格子（CSR）は反復のあいだ変わらないので、WASM 側に置いたまま使い回す。
// 反復ごとに入れ直すと 520 万面で毎回 100MB 超のコピーになる。

/**
 * SurfaceRef の格子を WASM メモリへ載せる。返ったハンドルを projectPoints へ渡す。
 * @returns {object|null} 載せられなければ null
 */
export function wasmUploadSurface(ref) {
  if (!usable()) return null;
  const np = ref.P.length, ni = ref.I.length;
  const nOff = ref.off.length, nCell = ref.tri.length;
  let pPos = 0, pIdx = 0, pOff = 0, pCell = 0;
  try {
    pPos = W.alloc(np * 4);
    pIdx = W.alloc(ni * 4);
    pOff = W.alloc(nOff * 4);
    pCell = W.alloc(Math.max(4, nCell * 4));
    if (!pPos || !pIdx || !pOff || !pCell) throw new Error('alloc 失敗');
    const buf = W.memory.buffer;
    new Float32Array(buf, pPos, np).set(ref.P);
    new Int32Array(buf, pIdx, ni).set(ref.I);
    new Int32Array(buf, pOff, nOff).set(ref.off);
    if (nCell) new Int32Array(buf, pCell, nCell).set(ref.tri);
    return { pPos, pIdx, pOff, pCell, ref };
  } catch (err) {
    failReason = String(err && err.message || err);
    if (pCell) W.release(pCell);
    if (pOff) W.release(pOff);
    if (pIdx) W.release(pIdx);
    if (pPos) W.release(pPos);
    return null;
  }
}

/** wasmUploadSurface で取ったものを返す */
export function wasmReleaseSurface(h) {
  if (!h || !usable()) return;
  W.release(h.pCell); W.release(h.pOff); W.release(h.pIdx); W.release(h.pPos);
}

/**
 * 点群をまとめて表面へ投影する。tgt / hint はその場で更新される。
 * @param {object} h wasmUploadSurface の戻り値
 * @param {Float32Array} tgt 投影したい点（count*3）。結果を書き戻す
 * @param {Int32Array} hint 点ごとの前回当たった三角形（count）。-1 で無し
 * @param {Uint8Array} skip 0 以外なら投影しない（count）
 * @returns {{projected: number, hinted: number}|null}
 */
export function wasmProjectPoints(h, tgt, hint, skip, count, hintMaxD2) {
  if (!h || !usable()) return null;
  if (count === 0) return { projected: 0, hinted: 0 };
  let pTgt = 0, pHint = 0, pSkip = 0, pStats = 0;
  try {
    pTgt = W.alloc(count * 12);
    pHint = W.alloc(count * 4);
    pSkip = W.alloc(count);
    pStats = W.alloc(8);
    if (!pTgt || !pHint || !pSkip || !pStats) throw new Error('alloc 失敗');
    const buf = W.memory.buffer;
    new Float32Array(buf, pTgt, count * 3).set(tgt.subarray(0, count * 3));
    new Int32Array(buf, pHint, count).set(hint.subarray(0, count));
    new Uint8Array(buf, pSkip, count).set(skip.subarray(0, count));
    const r = h.ref;
    W.projectPoints(pTgt, pHint, pSkip, count,
      h.pPos, h.pIdx, h.pOff, h.pCell,
      r.nx, r.ny, r.nz, r.ox, r.oy, r.oz, r.h, hintMaxD2, pStats);
    const b2 = W.memory.buffer;
    tgt.set(new Float32Array(b2, pTgt, count * 3), 0);
    hint.set(new Int32Array(b2, pHint, count), 0);
    const st = new Int32Array(b2, pStats, 2);
    return { projected: st[0], hinted: st[1] };
  } catch (err) {
    failReason = String(err && err.message || err);
    return null;
  } finally {
    if (pStats) W.release(pStats);
    if (pSkip) W.release(pSkip);
    if (pHint) W.release(pHint);
    if (pTgt) W.release(pTgt);
  }
}
