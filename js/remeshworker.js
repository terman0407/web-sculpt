// ---------------------------------------------------------------------------
// remeshworker.js
// リメッシュを Web Worker で走らせる。
//
// 6 秒かかる処理をメインスレッドで回すと、ビジー表示すら描き直されずに
// ブラウザが固まる（実際にそう報告された）。ワーカーへ出せば UI は 144fps を
// 保ったまま進捗を出せる。
//
// メッシュそのもの（SculptMesh）は送れないので (positions, indices) を渡し、
// 結果の (positions, indices) を受け取って setGeometry で差し替える。
// リメッシュはトポロジを作り直す操作なので、この粒度でちょうどよい。
//
// ワーカー本体は「モジュール URL を受け取って動的 import する薄い殻」にしてある。
// remesh の実装を文字列へ埋めると同じアルゴリズムを 2 か所に持つことになり、
// 片方だけ直してずれる。殻だけならずれようがない。
//
// ワーカーが使えない環境（file://、単一ファイル版、Worker 無効）では
// initRemeshWorker() が false を返し、呼び出し側がメインスレッドで実行する。
// ---------------------------------------------------------------------------

import { wasmFieldModule } from './wasmkernels.js';

// ワーカーは「モジュール URL を受け取って import する」だけの薄い殻にする。
// これなら remesh の実装はワーカー側でも本体と同じものが 1 つだけになる。
const WORKER_SRC = `
let remeshMod = null, meshMod = null;
let jid = 0;
self.onmessage = async (ev) => {
  const m = ev.data;
  jid = m.id || 0;
  try {
    if (m.type === 'init') {
      remeshMod = await import(m.url);
      meshMod = await import(m.meshUrl);
      // WASM カーネル（法線 / 曲率 / 表面投影）もワーカー側で立ち上げる。
      // コンパイル済みモジュールを貰うので再コンパイルは要らない。
      let wasm = false;
      if (m.wasmModule) {
        const k = await import(m.kernelUrl);
        wasm = await k.initWasmFieldFromModule(m.wasmModule);
      }
      self.postMessage({ type: 'ready', wasm });
      return;
    }
    if (m.type === 'remesh') {
      const { positions, indices, opts } = m;
      // ワーカー側で SculptMesh を組んでリメッシュし、結果を返す
      const mesh = new meshMod.SculptMesh();
      mesh.setGeometry(positions, indices, m.colors || null, m.mask || null);
      const r = remeshMod.remesh(mesh, Object.assign({}, opts, {
        onProgress: (p) => { self.postMessage({ type: 'progress', id: m.id, p }); },
      }));
      if (!r.ok) { self.postMessage({ type: 'done', id: m.id, ok: false, reason: r.reason }); return; }
      // 生きているものだけ詰め直して返す
      const nv = mesh.liveVerts;
      const remap = new Int32Array(mesh.nv).fill(-1);
      let w = 0;
      for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) remap[v] = w++;
      const P = new Float32Array(nv * 3);
      const C = new Float32Array(nv * 3);
      const MK = new Float32Array(nv);
      for (let v = 0; v < mesh.nv; v++) {
        const rr = remap[v];
        if (rr < 0) continue;
        P[rr * 3] = mesh.positions[v * 3];
        P[rr * 3 + 1] = mesh.positions[v * 3 + 1];
        P[rr * 3 + 2] = mesh.positions[v * 3 + 2];
        C[rr * 3] = mesh.colors[v * 3];
        C[rr * 3 + 1] = mesh.colors[v * 3 + 1];
        C[rr * 3 + 2] = mesh.colors[v * 3 + 2];
        MK[rr] = mesh.mask[v];
      }
      const I = new Uint32Array(mesh.liveTris * 3);
      let q = 0;
      for (let t = 0; t < mesh.nt; t++) {
        const i = t * 3, a = mesh.tris[i], b = mesh.tris[i + 1], c = mesh.tris[i + 2];
        if (a === b && b === c) continue;
        I[q++] = remap[a]; I[q++] = remap[b]; I[q++] = remap[c];
      }
      self.postMessage({
        type: 'done', id: m.id, ok: true, stats: r,
        positions: P, indices: I, colors: C, mask: MK,
      }, [P.buffer, I.buffer, C.buffer, MK.buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: jid, message: String((err && err.stack) || err) });
  }
};
`;

let worker = null;
let blobUrl = null;
let meshModUrl = '';
let state = 'idle';      // idle | ready | failed
let failReason = '';
let initPromise = null;
let jobId = 0;
let wasmInWorker = false;

export function remeshWorkerState() { return state; }
export function remeshWorkerError() { return failReason; }
/** ワーカー側で WASM カーネルが立ち上がったか（診断とテスト用） */
export function remeshWorkerWasm() { return wasmInWorker; }

/**
 * ワーカーを用意する。読み込めなければ静かに失敗して false を返す
 * （呼び出し側はメインスレッドで実行する）。
 */
export function initRemeshWorker() {
  if (state === 'ready') return Promise.resolve(true);
  if (state === 'failed') return Promise.resolve(false);
  // 初期化中に二度呼ばれたら同じ約束を返す。作りかけのワーカーを捨てて
  // もう 1 個作ってしまうと、前のがそのまま残って漏れる。
  if (!initPromise) initPromise = _init().finally(() => { initPromise = null; });
  return initPromise;
}

async function _init() {
  try {
    if (typeof Worker !== 'function' || typeof Blob !== 'function'
      || typeof URL === 'undefined' || typeof document === 'undefined') {
      throw new Error('Worker が使えません');
    }
    // モジュールの場所を出す。
    // import.meta.url は使えない：単一ファイル版はクラシックスクリプトなので
    // import.meta があるとファイル全体が構文エラーになる。代わりに
    // エントリの module スクリプトタグ（src="js/main.js"）の src から引く。
    // 単一ファイル版ではこのタグがインライン化されて src を持たないので、
    // そのままワーカーを諦める判定にもなる（固めた JS はどうせ import できない）。
    const tag = document.querySelector('script[type="module"][src]');
    if (!tag) throw new Error('モジュールの場所が分かりません（単一ファイル版）');
    const base = new URL(tag.src, location.href);
    // file:// では Blob ワーカーからの import が CORS で失敗する
    if (!/^https?:$/.test(base.protocol)) throw new Error('http 経由でないため import できません');
    const remeshUrl = new URL('./remesh.js', base).href;
    const meshUrl = new URL('./mesh.js', base).href;
    const kernelUrl = new URL('./wasmkernels.js', base).href;

    blobUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    worker = new Worker(blobUrl, { type: 'module' });
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('ワーカー初期化がタイムアウト')), 10000);
      worker.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'ready') {
          clearTimeout(to);
          wasmInWorker = !!ev.data.wasm;
          res();
        } else if (ev.data && ev.data.type === 'error') { clearTimeout(to); rej(new Error(ev.data.message)); }
      };
      worker.onerror = (e) => { clearTimeout(to); rej(new Error(e.message || 'ワーカーエラー')); };
      worker.postMessage({
        type: 'init', url: remeshUrl, meshUrl, kernelUrl,
        wasmModule: wasmFieldModule(),
      });
    });
    meshModUrl = meshUrl;
    state = 'ready';
    return true;
  } catch (err) {
    disposeRemeshWorker();
    // 「使えない」の確定は dispose のあとで。dispose が state を idle に戻すので、
    // 先に failed を立てると打ち消されて毎回作り直しに行ってしまう。
    failReason = String((err && err.message) || err);
    state = 'failed';
    return false;
  }
}

export function disposeRemeshWorker() {
  if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
  worker = null;
  if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ } blobUrl = null; }
  state = 'idle';
}

/**
 * ワーカーでリメッシュする。
 * @returns {Promise<object|null>} 成功なら { positions, indices, colors, mask, stats }。
 *   ワーカーが使えない / 失敗したら null（呼び出し側がメインスレッドで実行する）
 */
export async function remeshInWorker(mesh, opts, onProgress = null) {
  if (state !== 'ready' || !worker) return null;
  // 生きているものだけ詰めて送る
  const nv = mesh.liveVerts;
  const remap = new Int32Array(mesh.nv).fill(-1);
  let w = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) remap[v] = w++;
  const P = new Float32Array(nv * 3);
  const C = new Float32Array(nv * 3);
  const MK = new Float32Array(nv);
  for (let v = 0; v < mesh.nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    P[r * 3] = mesh.positions[v * 3];
    P[r * 3 + 1] = mesh.positions[v * 3 + 1];
    P[r * 3 + 2] = mesh.positions[v * 3 + 2];
    C[r * 3] = mesh.colors[v * 3];
    C[r * 3 + 1] = mesh.colors[v * 3 + 1];
    C[r * 3 + 2] = mesh.colors[v * 3 + 2];
    MK[r] = mesh.mask[v];
  }
  const I = new Uint32Array(mesh.liveTris * 3);
  let q = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = mesh.tris[i], b = mesh.tris[i + 1], c = mesh.tris[i + 2];
    if (a === b && b === c) continue;
    I[q++] = remap[a]; I[q++] = remap[b]; I[q++] = remap[c];
  }

  // 仕事ごとに番号を振り、返事の番号が合わないものは捨てる。
  // 打ち切ったあとも前の仕事は走り続けていることがあり、その 'done' が
  // 次の仕事の待ち受けに届くと、まったく別のジオメトリで差し替えてしまう。
  const id = ++jobId;
  const wk = worker;
  try {
    return await new Promise((res, rej) => {
      // 520 万面で 7 秒台、2000 万面で 53 秒。余裕を持って 5 分で打ち切る
      const to = setTimeout(() => {
        // 止まったワーカーは信用できないので捨てる（次回は作り直しになる）
        disposeRemeshWorker();
        rej(new Error('リメッシュがタイムアウトしました'));
      }, 300000);
      wk.onmessage = (ev) => {
        const d = ev.data;
        if (!d || d.id !== id) return;
        if (d.type === 'error') { clearTimeout(to); rej(new Error(d.message)); return; }
        if (d.type === 'progress') { if (onProgress) onProgress(d.p); return; }
        if (d.type !== 'done') return;
        clearTimeout(to);
        if (!d.ok) { rej(new Error(d.reason || 'リメッシュできませんでした')); return; }
        res(d);
      };
      wk.onerror = (e) => { clearTimeout(to); rej(new Error(e.message || 'ワーカーエラー')); };
      // バッファの所有権ごと渡す（構造化複製のコピーを避ける）
      wk.postMessage({
        type: 'remesh', id, meshUrl: meshModUrl, opts,
        positions: P, indices: I, colors: C, mask: MK,
      }, [P.buffer, I.buffer, C.buffer, MK.buffer]);
    });
  } catch (err) {
    failReason = String((err && err.message) || err);
    return null;
  }
}
