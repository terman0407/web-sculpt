// ---------------------------------------------------------------------------
// parallelfield.js
// 距離場スプラットを Web Worker で並列化する。
//
// 分割は Z スラブ。各ワーカーは自分の [kBegin, kEnd] の voxel だけを書くので
// 書き込み先が重ならず、マージ処理が要らない（結果を所定のオフセットへ置くだけ）。
//
// SharedArrayBuffer を使わないのが要点。スラブ単位で結果を Transferable として
// 返せば足りるので、COOP/COEP ヘッダを設定できない GitHub Pages でも動く。
//
// 各ワーカーには「自分のスラブに band 以内で掛かる三角形」だけを、
// 頂点を詰め直して送る。全頂点配列を人数分コピーすると転送量が跳ね上がるため。
//
// ワーカーを作れない環境（file:// の Blob Worker はブロックされる）では
// 単に false を返し、呼び出し側が単一スレッド版へフォールバックする。
// ---------------------------------------------------------------------------

// ワーカー本体。別ファイルにすると単一ファイル版で読めなくなるので文字列で持つ。
const WORKER_SRC = `
let W = null;
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      const inst = await WebAssembly.instantiate(m.module, {
        env: { abort() { throw new Error('wasm abort'); } },
      });
      W = inst.exports;
      self.postMessage({ type: 'ready', id: m.id });
      return;
    }
    if (m.type === 'splat') {
      const { pos, tris, ids, nv, nt, g, kBegin, kEnd, wantClosest, id } = m;
      const slabK = kEnd - kBegin + 1;
      const count = g.nx * g.ny * slabK;
      const pPos = W.alloc(nv * 12);
      const pTri = W.alloc(nt * 12);
      const pField = W.alloc(count * 4);
      const pClose = wantClosest ? W.alloc(count * 4) : 0;
      const buf = W.memory.buffer;
      new Float32Array(buf, pPos, nv * 3).set(pos.subarray(0, nv * 3));
      new Int32Array(buf, pTri, nt * 3).set(tris.subarray(0, nt * 3));
      W.fillField(pField, count, g.band);
      if (pClose) W.fillClosest(pClose, count);
      W.splat(pPos, pTri, nt, pField, pClose,
        g.nx, g.ny, g.nz, kBegin, kEnd, g.ox, g.oy, g.oz, g.h, g.band);
      const b2 = W.memory.buffer;
      const field = new Float32Array(count);
      field.set(new Float32Array(b2, pField, count));
      let closest = null;
      if (pClose) {
        closest = new Int32Array(count);
        closest.set(new Int32Array(b2, pClose, count));
        // splat が返すのは「このスラブに渡した三角形リストの中での番号」。
        // 呼び出し側（ポリペイント転写）が欲しいのは元メッシュの三角形 ID なので
        // ここで引き直す。これを忘れると色が無関係な三角形から拾われる。
        for (let i = 0; i < count; i++) {
          const c = closest[i];
          closest[i] = c >= 0 && c < nt ? ids[c] : -1;
        }
      }
      if (pClose) W.release(pClose);
      W.release(pField); W.release(pTri); W.release(pPos);
      const transfer = closest ? [field.buffer, closest.buffer] : [field.buffer];
      self.postMessage({ type: 'done', id, kBegin, slabK, field, closest }, transfer);
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m && m.id, message: String((err && err.message) || err) });
  }
};
`;

let pool = null;          // { workers: [], size }
let poolState = 'idle';   // idle | ready | failed
let poolError = '';
let blobUrl = null;

export function parallelState() { return poolState; }
export function parallelError() { return poolError; }
export function parallelWorkers() { return pool ? pool.workers.length : 0; }

// 直列部分（振り分け・ペイロード構築）とワーカー待ちの内訳
export let lastTiming = { build: 0, wait: 0, merge: 0 };

function hardwareThreads() {
  const n = (typeof navigator === 'object' && navigator.hardwareConcurrency) || 4;
  // 1 コアは UI とメインスレッドの後処理に残す
  return Math.max(1, Math.min(8, n - 1));
}

/**
 * ワーカープールを用意する。WebAssembly.Module を渡すと各ワーカーで
 * 再コンパイルせずに済む（Module は構造化クローンで安く複製できる）。
 * @returns {Promise<boolean>}
 */
export async function initParallelField(wasmModule, opts = {}) {
  if (poolState === 'ready') return true;
  if (poolState === 'failed') return false;
  try {
    if (typeof Worker !== 'function' || typeof Blob !== 'function' || !wasmModule) {
      throw new Error('Worker が使えません');
    }
    const size = Math.max(1, Math.min(opts.workers || hardwareThreads(), 16));
    blobUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    const workers = [];
    for (let i = 0; i < size; i++) workers.push(new Worker(blobUrl));

    // 全ワーカーで WASM を初期化できるまで待つ
    await Promise.all(workers.map((w, i) => new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('ワーカー初期化がタイムアウト')), 10000);
      w.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'ready') { clearTimeout(to); res(); }
        else if (ev.data && ev.data.type === 'error') { clearTimeout(to); rej(new Error(ev.data.message)); }
      };
      w.onerror = (e) => { clearTimeout(to); rej(new Error(e.message || 'ワーカーエラー')); };
      w.postMessage({ type: 'init', id: i, module: wasmModule });
    })));

    pool = { workers };
    poolState = 'ready';
    return true;
  } catch (err) {
    poolError = String((err && err.message) || err);
    poolState = 'failed';
    disposeParallelField();
    return false;
  }
}

export function disposeParallelField() {
  if (pool) { for (const w of pool.workers) { try { w.terminate(); } catch { /* ignore */ } } }
  pool = null;
  if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ } blobUrl = null; }
}

/**
 * 各スラブに掛かる三角形を集めて、頂点を詰め直したペイロードを作る。
 * 全頂点配列を人数分コピーすると 3M 面で 100MB を超えるため、
 * 参照される頂点だけを取り出して番号を振り直す。
 */
export let buildTiming = { krange: 0, csr: 0, pack: 0 };

function buildSlabPayloads(mesh, g, slabs) {
  const _now = () => (typeof performance === 'object' ? performance.now() : Date.now());
  const _t0 = _now();
  const P = mesh.positions, T = mesh.tris;
  const nSlab = slabs.length;
  const invH = 1 / g.h;
  const band = g.band;

  // k → スラブ番号の逆引き。スラブは連続範囲なので、三角形の [k0,k1] から
  // 掛かるスラブ範囲を O(1) で求められる（全スラブを走査しなくてよい）。
  const slabOfK = new Int32Array(g.nz);
  for (let s = 0; s < nSlab; s++) {
    for (let k = slabs[s].kBegin; k <= slabs[s].kEnd; k++) slabOfK[k] = s;
  }

  // 1) 各三角形の [k0,k1] を求め、掛かるスラブの件数を数える
  const counts = new Int32Array(nSlab);
  const kOf = new Int32Array(mesh.nt * 2);   // 三角形ごとの [k0, k1]
  // 300 万回まわるので Math.min/max（3 引数）と Math.ceil/floor の呼び出しを避け、
  // 比較と加算で書く。ceil(x) は -floor(-x)、floor は | 0 で代用できるが
  // 負値で切り捨て方向が変わるため、下駄を履かせてから整数化する。
  const nzMax = g.nz - 1;
  const oz = g.oz;
  const BIAS = 1 << 22;                      // |k| がこの値を超えない前提の下駄
  for (let t = 0; t < mesh.nt; t++) {
    const ti = t * 3;
    const ia = T[ti], ib = T[ti + 1], ic = T[ti + 2];
    if (ia === ib && ib === ic) { kOf[t * 2] = 1; kOf[t * 2 + 1] = 0; continue; }
    const az = P[ia * 3 + 2], bz = P[ib * 3 + 2], cz = P[ic * 3 + 2];
    let z0 = az, z1 = az;
    if (bz < z0) z0 = bz; else if (bz > z1) z1 = bz;
    if (cz < z0) z0 = cz; else if (cz > z1) z1 = cz;
    // ceil((z0 - band - oz) * invH)
    let k0 = BIAS - (((BIAS - (z0 - band - oz) * invH)) | 0);
    // floor((z1 + band - oz) * invH)
    let k1 = ((((z1 + band - oz) * invH) + BIAS) | 0) - BIAS;
    if (k0 < 0) k0 = 0;
    if (k1 > nzMax) k1 = nzMax;
    kOf[t * 2] = k0; kOf[t * 2 + 1] = k1;
    if (k1 < k0) continue;
    const s0 = slabOfK[k0], s1 = slabOfK[k1];
    for (let s = s0; s <= s1; s++) counts[s]++;
  }

  const _t1 = _now();

  // 2) CSR に詰めて「スラブ → 三角形リスト」を作る。
  //    これをやらずにスラブごとに全三角形を走査すると O(スラブ数 × 面数) になり、
  //    300 万面 × 8 スラブで 2600 万回のループになってしまう。
  const off = new Int32Array(nSlab + 1);
  for (let s = 0; s < nSlab; s++) off[s + 1] = off[s] + counts[s];
  const slabTris = new Int32Array(off[nSlab]);
  const fill = off.slice(0, nSlab);
  for (let t = 0; t < mesh.nt; t++) {
    const k0 = kOf[t * 2], k1 = kOf[t * 2 + 1];
    if (k1 < k0) continue;
    const s0 = slabOfK[k0], s1 = slabOfK[k1];
    for (let s = s0; s <= s1; s++) slabTris[fill[s]++] = t;
  }

  const _t2 = _now();

  // 3) スラブごとに頂点を詰め直す
  const payloads = new Array(nSlab);
  const remap = new Int32Array(mesh.nv);
  const stamp = new Int32Array(mesh.nv);
  let stampId = 0;
  for (let s = 0; s < nSlab; s++) {
    const n = counts[s];
    const sl = slabs[s];
    if (n === 0) { payloads[s] = null; continue; }
    const tris = new Int32Array(n * 3);
    // closest を元メッシュの三角形 ID に戻すための対応表（ワーカー側で引き直す）
    const ids = new Int32Array(n);
    // 使う頂点数は上限が 3n。多少余っても転送はバッファ所有権の移動（ゼロコピー）
    // なので、伸長判定を無くして一気に確保したほうが速い。
    const pos = new Float32Array(n * 9);
    let nv = 0, w = 0;
    stampId++;
    const st = stamp, rm = remap;
    // pushVert をクロージャで呼ぶと 1000 万回の呼び出しになるため展開する
    for (let q = off[s]; q < off[s + 1]; q++) {
      const gt = slabTris[q];
      ids[q - off[s]] = gt;
      const ti = gt * 3;
      for (let e = 0; e < 3; e++) {
        const v = T[ti + e];
        let r;
        if (st[v] === stampId) {
          r = rm[v];
        } else {
          st[v] = stampId;
          r = nv;
          rm[v] = nv;
          const o = nv * 3, pv = v * 3;
          pos[o] = P[pv]; pos[o + 1] = P[pv + 1]; pos[o + 2] = P[pv + 2];
          nv++;
        }
        tris[w++] = r;
      }
    }
    payloads[s] = { pos, tris, ids, nv, nt: w / 3 };
  }
  buildTiming = { krange: Math.round(_t1 - _t0), csr: Math.round(_t2 - _t1), pack: Math.round(_now() - _t2) };
  return payloads;
}

/**
 * 距離場をワーカーで並列に計算して field / closest を埋める。
 * @returns {Promise<boolean>} 実行できたか（false なら呼び出し側が単一スレッド版へ）
 */
export async function parallelSplat(mesh, field, closest, g) {
  if (poolState !== 'ready' || !pool) return false;
  const nSlab = pool.workers.length;
  if (nSlab < 2) return false;

  try {
    // Z 方向をワーカー数に分割（端数は前から配る）
    const slabs = [];
    const base = Math.floor(g.nz / nSlab), rem = g.nz % nSlab;
    let k = 0;
    for (let s = 0; s < nSlab; s++) {
      const len = base + (s < rem ? 1 : 0);
      if (len <= 0) continue;
      slabs.push({ kBegin: k, kEnd: k + len - 1 });
      k += len;
    }

    const tB = (typeof performance === 'object' ? performance.now() : Date.now());
    const payloads = buildSlabPayloads(mesh, g, slabs);
    const tW = (typeof performance === 'object' ? performance.now() : Date.now());
    const wantClosest = !!closest;
    const gp = { nx: g.nx, ny: g.ny, nz: g.nz, ox: g.ox, oy: g.oy, oz: g.oz, h: g.h, band: g.band };
    const plane = g.nx * g.ny;

    await Promise.all(slabs.map((sl, s) => new Promise((res, rej) => {
      const p = payloads[s];
      const slabK = sl.kEnd - sl.kBegin + 1;
      if (!p) {
        // 三角形が掛からないスラブ: band のままで良い（初期値と同じ）
        res();
        return;
      }
      const w = pool.workers[s];
      const to = setTimeout(() => rej(new Error('スラブ計算がタイムアウト')), 120000);
      w.onmessage = (ev) => {
        const d = ev.data;
        if (!d) return;
        if (d.type === 'error') { clearTimeout(to); rej(new Error(d.message)); return; }
        if (d.type !== 'done') return;
        clearTimeout(to);
        field.set(d.field, sl.kBegin * plane);
        if (closest && d.closest) closest.set(d.closest, sl.kBegin * plane);
        res();
      };
      w.onerror = (e) => { clearTimeout(to); rej(new Error(e.message || 'ワーカーエラー')); };
      // バッファの所有権ごと渡す（構造化クローンのコピーを避ける）。
      // 送ったあとメインスレッド側では使わないので detach されて問題ない。
      w.postMessage({
        type: 'splat', id: s, pos: p.pos, tris: p.tris, ids: p.ids, nv: p.nv, nt: p.nt,
        g: gp, kBegin: sl.kBegin, kEnd: sl.kEnd, wantClosest, slabK,
      }, [p.pos.buffer, p.tris.buffer, p.ids.buffer]);
    })));
    const tE = (typeof performance === 'object' ? performance.now() : Date.now());
    lastTiming = { build: Math.round(tW - tB), wait: Math.round(tE - tW), merge: 0 };
    return true;
  } catch (err) {
    poolError = String((err && err.message) || err);
    return false;
  }
}
