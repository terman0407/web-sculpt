// ---------------------------------------------------------------------------
// mesh.js
// 動的トポロジ対応の三角形メッシュ。
//
// 設計上のポイント:
//  * 頂点/三角形は「削除しても詰めない」。削除された三角形は (0,0,0) の退化三角形に
//    書き換えられるため GPU 側では 1 フラグメントも生成せず、インデックスバッファを
//    作り直す必要がない。空きスロットはフリーリストで再利用する。
//    → 分割/コラプス中にインデックスがずれないので dyntopo の実装が非常に単純になる。
//  * 頂点ごとの隣接三角形リスト(ring)を常に維持する。
//  * GPU 転送は dirty レンジ（最小/最大インデックス）のみ。
// ---------------------------------------------------------------------------

import { wasmNormals, wasmCurvature } from './wasmkernels.js';

export const MAX_VERTS_HARD = 2000000;

// dirty 管理のブロックサイズ（2^11 = 2048 要素ごと）
export const DIRTY_SHIFT = 11;
export const DIRTY_BLOCK = 1 << DIRTY_SHIFT;

// 頂点ごとの隣接三角形は「インライン 8 スロット + はみ出しは JS 配列」で持つ。
// 頂点ごとに JS 配列を 1 本ずつ持つ形だと、260 万頂点で 260 万個の小さな
// ヒープオブジェクトになり、ブラシが触れる 4 万頂点ぶんが全部キャッシュミスになる。
// 平坦な型付き配列にすると 1 回の添字アクセスで済む。valence が 8 を超えるのは稀。
export const RING_STRIDE = 8;   // エッジキーの packing 上限に合わせる

function growF32(src, used, cap) {
  const a = new Float32Array(cap);
  a.set(src.subarray(0, used));
  return a;
}
function growI32(src, used, cap) {
  const a = new Int32Array(cap);
  a.set(src.subarray(0, used));
  return a;
}
function growU8(src, used, cap) {
  const a = new Uint8Array(cap);
  a.set(src.subarray(0, used));
  return a;
}

// ---------------------------------------------------------------------------
// スナップショット（アンドゥ）の配列の持ち方
//
// 詳しくは SculptMesh#snapshot のコメント。ここは「差分をどこまで許すか」と
// 「全長へ戻す」処理。History（sculptor.js）がこれを使って履歴を組む。
// ---------------------------------------------------------------------------

/** スナップショットが差分にできる配列 */
export const SNAP_KEYS = ['positions', 'colors', 'mask', 'vAlive', 'tris'];

// 差分の連鎖の上限。全長へ戻すのに「アンカーからここまで」の回数だけ
// 差分を当てるので、深くすると省メモリだが undo が遅くなる。
// 8 なら 260 万頂点でも 1 回の undo で 8 回ぶんの適用で済む。
const SNAP_MAX_DEPTH = 8;

/**
 * 差分にする / 全長を持つの判定。
 *
 * 差分は 1 要素あたり「添字 4 バイト + 値 elemBytes」。全長は 1 要素 elemBytes。
 * だから差分が得になるのは、変わった割合が elemBytes / (4 + elemBytes) より
 * 小さいとき（Float32 なら 1/2、Uint8 なら 1/5）。ぎりぎりで差分にしても
 * ほとんど縮まないので 0.8 を掛けて余裕を取る。
 */
function deltaCap(n, elemBytes) {
  return Math.floor(n * (elemBytes / (4 + elemBytes)) * 0.8);
}

/** 1 つの配列のスナップショット表現を作る */
function snapEntry(key, src, n, prev, base, shared) {
  const pe = prev ? prev[key] : null;
  const pa = base ? base[key] : null;
  if (pe && pa && pa.length === n) {
    const cap = deltaCap(n, src.BYTES_PER_ELEMENT);
    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (pa[i] !== src[i] && ++changed > cap) break;
    }
    if (changed === 0) { shared.push(key); return pe; }
    if (changed <= cap) {
      const depth = pe.delta ? pe.depth + 1 : 1;
      if (depth <= SNAP_MAX_DEPTH) {
        const idx = new Int32Array(changed);
        const val = new src.constructor(changed);
        let w = 0;
        for (let i = 0; i < n && w < changed; i++) {
          if (pa[i] !== src[i]) { idx[w] = i; val[w] = src[i]; w++; }
        }
        return { delta: true, from: prev, idx, val, depth };
      }
    }
  }
  return src.slice(0, n);
}

/**
 * スナップショットの配列を全長へ戻す。
 *
 * 差分ならアンカー（全長を持っている履歴）まで遡り、そこから**古い方から順に**
 * 差分を当てる。同じ要素を何度も上書きすることがあるので順番は変えられない。
 * 確保は 1 回だけ（アンカーの複製）。
 */
export function resolveSnapshot(state, key) {
  const chain = [];
  let s = state;
  while (s[key] && s[key].delta) { chain.push(s[key]); s = s[key].from; }
  const anchor = s[key];
  if (chain.length === 0) return anchor;
  const out = anchor.slice();
  for (let c = chain.length - 1; c >= 0; c--) {
    const idx = chain[c].idx, val = chain[c].val;
    for (let i = 0; i < idx.length; i++) out[idx[i]] = val[i];
  }
  return out;
}

/**
 * 差分をほどいて全長に置き換える。
 *
 * 差分は `from` で**前のスナップショットのオブジェクト**を指すので、履歴を
 * 捨てても指されている限り解放されない。古い履歴を捨てたら残った先頭に
 * これを掛けて、捨てた履歴への参照を切る。
 *
 * 共有（前の履歴と同じ配列を指している）はほどかなくてよい。配列 1 本を
 * 指しているだけで、履歴オブジェクトを掴んでいるわけではないから。
 */
export function materializeSnapshot(state) {
  let n = 0;
  for (const key of SNAP_KEYS) {
    if (!state[key] || !state[key].delta) continue;
    state[key] = resolveSnapshot(state, key);
    n++;
    const i = state.shared.indexOf(key);
    if (i >= 0) state.shared.splice(i, 1);
  }
  return n;
}

export class SculptMesh {
  constructor(capV = 4096, capT = 8192) {
    this.capV = 0;
    this.capT = 0;
    this.nv = 0;              // 使用済み頂点スロットの上限（死んだスロットを含む）
    this.nt = 0;              // 使用済み三角形スロットの上限
    this.liveVerts = 0;
    this.liveTris = 0;

    this.positions = new Float32Array(0);
    this.normals = new Float32Array(0);
    this.colors = new Float32Array(0);
    this.mask = new Float32Array(0);
    // 離散平均曲率（凹 > 0 / 凸 < 0）。キャビティシェーディング用の派生属性なので
    // スナップショットには含めず、復元時に再計算する。
    this.curv = new Float32Array(0);
    this.vAlive = new Uint8Array(0);
    this.tris = new Int32Array(0);

    this.ringCount = new Int32Array(0);   // 頂点ごとの隣接三角形数（valence）
    this.ringData = new Int32Array(0);    // インライン格納（v * RING_STRIDE + j）
    this.ringExt = [];                    // valence > RING_STRIDE の頂点だけ JS 配列
    this._ringScratch = new Int32Array(256);
    this.freeVerts = [];
    this.freeTris = [];

    // 新規に作られた要素を追跡（dyntopo が使う）
    this.trackVerts = null;
    this.trackTris = null;

    // 転送用 dirty 管理。min/max の 1 区間だけだと、ブラシが触れた頂点が
    // インデックス上に散らばっている場合（細分化後は普通に起きる）に
    // 配列全体を毎フレーム転送することになるため、ブロック単位でも持つ。
    this.vDirtyMin = Infinity; this.vDirtyMax = -1;
    this.tDirtyMin = Infinity; this.tDirtyMax = -1;
    this.vBlocks = new Uint8Array(0);
    this.tBlocks = new Uint8Array(0);
    this.vBlockMin = Infinity; this.vBlockMax = -1;
    this.tBlockMin = Infinity; this.tBlockMax = -1;
    this.topoVersion = 0;      // トポロジが変わるたびに増加（ワイヤフレーム再構築用）
    this.geomVersion = 0;      // 形状が変わるたびに増加

    this._allocVerts(capV);
    this._allocTris(capT);
  }

  // --- 容量管理 -----------------------------------------------------------

  _allocVerts(cap) {
    if (cap <= this.capV) return;
    cap = Math.max(cap, Math.ceil(this.capV * 1.6), 1024);
    this.positions = growF32(this.positions, this.nv * 3, cap * 3);
    this.normals = growF32(this.normals, this.nv * 3, cap * 3);
    this.colors = growF32(this.colors, this.nv * 3, cap * 3);
    this.mask = growF32(this.mask, this.nv, cap);
    this.curv = growF32(this.curv, this.nv, cap);
    this.vAlive = growU8(this.vAlive, this.nv, cap);
    {
      // 他の配列と同じく「使用済み分だけ」写す。setGeometry は capV を 0 に戻すので、
      // 旧配列のほうが大きいことがある。
      const used = Math.min(this.nv, cap);
      const rc = new Int32Array(cap); rc.set(this.ringCount.subarray(0, used)); this.ringCount = rc;
      const rd = new Int32Array(cap * RING_STRIDE);
      rd.set(this.ringData.subarray(0, used * RING_STRIDE)); this.ringData = rd;
      for (let i = this.ringExt.length; i < cap; i++) this.ringExt.push(null);
    }
    {
      const nb = (cap >> DIRTY_SHIFT) + 1;
      if (this.vBlocks.length < nb) { const a = new Uint8Array(nb); a.set(this.vBlocks); this.vBlocks = a; }
    }
    this.capV = cap;
  }

  _allocTris(cap) {
    if (cap <= this.capT) return;
    cap = Math.max(cap, Math.ceil(this.capT * 1.6), 2048);
    this.tris = growI32(this.tris, this.nt * 3, cap * 3);
    {
      const nb = (cap >> DIRTY_SHIFT) + 1;
      if (this.tBlocks.length < nb) { const a = new Uint8Array(nb); a.set(this.tBlocks); this.tBlocks = a; }
    }
    this.capT = cap;
  }

  /**
   * 頂点 nv 個・三角形 nt 個ぶんの容量を先に確保する。
   *
   * 呼び出し側が mesh.positions などをローカル変数に持って回るとき、途中で
   * 配列が作り直されると古い配列を掴んだままになる。あらかじめここで広げておけば
   * その区間では再確保が起きないので、キャッシュしたまま安全に使える。
   */
  reserve(nv, nt) {
    if (nv > this.capV) this._allocVerts(nv);
    if (nt > this.capT) this._allocTris(nt);
  }

  // --- dirty マーキング ---------------------------------------------------

  markVert(i) {
    if (i < this.vDirtyMin) this.vDirtyMin = i;
    if (i > this.vDirtyMax) this.vDirtyMax = i;
    const b = i >> DIRTY_SHIFT;
    this.vBlocks[b] = 1;
    if (b < this.vBlockMin) this.vBlockMin = b;
    if (b > this.vBlockMax) this.vBlockMax = b;
  }
  markTri(t) {
    if (t < this.tDirtyMin) this.tDirtyMin = t;
    if (t > this.tDirtyMax) this.tDirtyMax = t;
    const b = t >> DIRTY_SHIFT;
    this.tBlocks[b] = 1;
    if (b < this.tBlockMin) this.tBlockMin = b;
    if (b > this.tBlockMax) this.tBlockMax = b;
  }
  markAllDirty() {
    this.vDirtyMin = 0; this.vDirtyMax = this.nv - 1;
    this.tDirtyMin = 0; this.tDirtyMax = this.nt - 1;
    this.vBlockMin = 0; this.vBlockMax = Math.max(0, (this.nv - 1) >> DIRTY_SHIFT);
    this.tBlockMin = 0; this.tBlockMax = Math.max(0, (this.nt - 1) >> DIRTY_SHIFT);
    this.vBlocks.fill(1, this.vBlockMin, this.vBlockMax + 1);
    this.tBlocks.fill(1, this.tBlockMin, this.tBlockMax + 1);
  }
  clearDirty() {
    if (this.vBlockMax >= this.vBlockMin) this.vBlocks.fill(0, this.vBlockMin, this.vBlockMax + 1);
    if (this.tBlockMax >= this.tBlockMin) this.tBlocks.fill(0, this.tBlockMin, this.tBlockMax + 1);
    this.vDirtyMin = Infinity; this.vDirtyMax = -1;
    this.tDirtyMin = Infinity; this.tDirtyMax = -1;
    this.vBlockMin = Infinity; this.vBlockMax = -1;
    this.tBlockMin = Infinity; this.tBlockMax = -1;
  }

  // --- 頂点 ---------------------------------------------------------------

  addVertex(x, y, z, r = 1, g = 1, b = 1, m = 0) {
    let v;
    if (this.freeVerts.length > 0) {
      v = this.freeVerts.pop();
    } else {
      if (this.nv >= this.capV) this._allocVerts(this.nv + 1);
      v = this.nv++;
    }
    const i = v * 3;
    this.positions[i] = x; this.positions[i + 1] = y; this.positions[i + 2] = z;
    this.normals[i] = 0; this.normals[i + 1] = 1; this.normals[i + 2] = 0;
    this.colors[i] = r; this.colors[i + 1] = g; this.colors[i + 2] = b;
    this.mask[v] = m;
    this.curv[v] = 0;
    this.vAlive[v] = 1;
    this.ringCount[v] = 0; this.ringExt[v] = null;
    this.liveVerts++;
    this.markVert(v);
    if (this.trackVerts) this.trackVerts.push(v);
    return v;
  }

  /** 辺 (a,b) 上の t の位置に新しい頂点を作る（法線/色/マスクも補間） */
  addVertexOnEdge(a, b, t = 0.5) {
    const P = this.positions, C = this.colors, N = this.normals;
    const ia = a * 3, ib = b * 3;
    const v = this.addVertex(
      P[ia] + (P[ib] - P[ia]) * t,
      P[ia + 1] + (P[ib + 1] - P[ia + 1]) * t,
      P[ia + 2] + (P[ib + 2] - P[ia + 2]) * t,
      C[ia] + (C[ib] - C[ia]) * t,
      C[ia + 1] + (C[ib + 1] - C[ia + 1]) * t,
      C[ia + 2] + (C[ib + 2] - C[ia + 2]) * t,
      this.mask[a] + (this.mask[b] - this.mask[a]) * t,
    );
    // 暫定法線を補間で入れておく（分割直後にブラシが法線を読むため）
    const iv = v * 3;
    let nx = N[ia] + (N[ib] - N[ia]) * t;
    let ny = N[ia + 1] + (N[ib + 1] - N[ia + 1]) * t;
    let nz = N[ia + 2] + (N[ib + 2] - N[ia + 2]) * t;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 1; nz = 0; }
    N[iv] = nx; N[iv + 1] = ny; N[iv + 2] = nz;
    return v;
  }

  removeVertex(v) {
    if (!this.vAlive[v]) return;
    this.vAlive[v] = 0;
    this.ringCount[v] = 0; this.ringExt[v] = null;
    this.freeVerts.push(v);
    this.liveVerts--;
    this.topoVersion++;
  }

  isVertAlive(v) { return this.vAlive[v] === 1; }

  // --- 三角形 -------------------------------------------------------------

  _link(v, t) {
    const c = this.ringCount[v];
    if (c < RING_STRIDE) {
      this.ringData[v * RING_STRIDE + c] = t;
    } else if (c === RING_STRIDE) {
      // インラインから溢れた: 全件を JS 配列へ移す
      const ex = new Array(RING_STRIDE + 1);
      const b = v * RING_STRIDE;
      for (let j = 0; j < RING_STRIDE; j++) ex[j] = this.ringData[b + j];
      ex[RING_STRIDE] = t;
      this.ringExt[v] = ex;
    } else {
      this.ringExt[v].push(t);
    }
    this.ringCount[v] = c + 1;
  }

  _unlink(v, t) {
    const c = this.ringCount[v];
    if (c === 0) return;
    if (c <= RING_STRIDE) {
      const b = v * RING_STRIDE;
      for (let j = 0; j < c; j++) {
        if (this.ringData[b + j] === t) {
          this.ringData[b + j] = this.ringData[b + c - 1];
          this.ringCount[v] = c - 1;
          return;
        }
      }
      return;
    }
    const ex = this.ringExt[v];
    const k = ex.indexOf(t);
    if (k < 0) return;
    ex[k] = ex[ex.length - 1]; ex.pop();
    this.ringCount[v] = c - 1;
    if (c - 1 <= RING_STRIDE) {            // インラインへ戻す
      const b = v * RING_STRIDE;
      for (let j = 0; j < c - 1; j++) this.ringData[b + j] = ex[j];
      this.ringExt[v] = null;
    }
  }

  /**
   * 頂点 v の隣接三角形を走査するための (配列, 開始位置, 個数) を返す。
   * 通常はインライン領域をそのまま指すのでコピーは起きない。
   * はみ出している稀な頂点だけスクラッチへ写す。
   */
  ringView(v) {
    const c = this.ringCount[v];
    if (c <= RING_STRIDE) return { arr: this.ringData, off: v * RING_STRIDE, n: c };
    const ex = this.ringExt[v];
    let sc = this._ringScratch;
    if (sc.length < c) { sc = this._ringScratch = new Int32Array(Math.ceil(c * 1.5)); }
    for (let j = 0; j < c; j++) sc[j] = ex[j];
    return { arr: sc, off: 0, n: c };
  }

  /** 走査用の開始位置だけ返す軽量版（呼び出し側で ringCount と合わせて使う） */
  ringBase(v) {
    const c = this.ringCount[v];
    if (c <= RING_STRIDE) return v * RING_STRIDE;
    const ex = this.ringExt[v];
    let sc = this._ringScratch;
    if (sc.length < c) { sc = this._ringScratch = new Int32Array(Math.ceil(c * 1.5)); }
    for (let j = 0; j < c; j++) sc[j] = ex[j];
    return -1;                              // -1 = スクラッチを見る合図
  }

  /** 冷たい経路向け: 隣接三角形を JS 配列で返す */
  ringArray(v) {
    const c = this.ringCount[v];
    if (c > RING_STRIDE) return this.ringExt[v].slice();
    const b = v * RING_STRIDE, out = new Array(c);
    for (let j = 0; j < c; j++) out[j] = this.ringData[b + j];
    return out;
  }

  addTriangle(a, b, c) {
    let t;
    if (this.freeTris.length > 0) {
      t = this.freeTris.pop();
    } else {
      if (this.nt >= this.capT) this._allocTris(this.nt + 1);
      t = this.nt++;
    }
    const i = t * 3;
    this.tris[i] = a; this.tris[i + 1] = b; this.tris[i + 2] = c;
    this._link(a, t); this._link(b, t); this._link(c, t);
    this.liveTris++;
    this.markTri(t);
    this.topoVersion++;
    if (this.trackTris) this.trackTris.push(t);
    return t;
  }

  /** 既存三角形の頂点を差し替える（ring も更新） */
  setTriangle(t, a, b, c) {
    const i = t * 3, T = this.tris;
    const oa = T[i], ob = T[i + 1], oc = T[i + 2];
    if (oa === a && ob === b && oc === c) return;
    this._unlink(oa, t); this._unlink(ob, t); this._unlink(oc, t);
    T[i] = a; T[i + 1] = b; T[i + 2] = c;
    this._link(a, t); this._link(b, t); this._link(c, t);
    this.markTri(t);
    this.topoVersion++;
  }

  removeTriangle(t) {
    const i = t * 3, T = this.tris;
    if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) return; // 既に死んでいる
    this._unlink(T[i], t); this._unlink(T[i + 1], t); this._unlink(T[i + 2], t);
    T[i] = 0; T[i + 1] = 0; T[i + 2] = 0;   // 退化 → ラスタライズされない
    this.freeTris.push(t);
    this.liveTris--;
    this.markTri(t);
    this.topoVersion++;
  }

  isTriAlive(t) {
    const i = t * 3, T = this.tris;
    return !(T[i] === T[i + 1] && T[i + 1] === T[i + 2]);
  }

  // --- 隣接情報 -----------------------------------------------------------

  /** 辺 (a,b) を共有する三角形を out に詰める（向きは無視） */
  trianglesWithEdge(a, b, out) {
    out.length = 0;
    const c = this.ringCount[a];
    if (c === 0) return out;
    const RD = this.ringData, T = this.tris;
    const base = c <= RING_STRIDE ? a * RING_STRIDE : -1;
    const ex = base < 0 ? this.ringExt[a] : null;
    for (let k = 0; k < c; k++) {
      const t = ex ? ex[k] : RD[base + k];
      const i = t * 3;
      if (T[i] === b || T[i + 1] === b || T[i + 2] === b) out.push(t);
    }
    return out;
  }

  /** 頂点 v の 1-ring 頂点を out(Set 互換 push) に集める */
  oneRing(v, out) {
    out.length = 0;
    const c = this.ringCount[v];
    if (c === 0) return out;
    const RD = this.ringData, T = this.tris;
    const base = c <= RING_STRIDE ? v * RING_STRIDE : -1;
    const ex = base < 0 ? this.ringExt[v] : null;
    for (let k = 0; k < c; k++) {
      const i = (ex ? ex[k] : RD[base + k]) * 3;
      for (let j = 0; j < 3; j++) {
        const w = T[i + j];
        if (w !== v && out.indexOf(w) < 0) out.push(w);
      }
    }
    return out;
  }

  valence(v) { return this.ringCount[v]; }

  // --- 法線 ---------------------------------------------------------------

  // このループはハイポリのブラシで最も重い場所の一つなので、
  //  * this.xxx のプロパティ読みを全部ローカルへ退避
  //  * valence <= RING_STRIDE（ほぼ全部）と、はみ出し組を別ループに分ける
  //    → 内側ループから ex ? ex[j] : RD[...] の分岐が消える
  //  * markVert() の呼び出しをインライン化してループ後に 1 回だけ書き戻す
  //    （呼び出しごとに this への読み書きが 8 回あった）
  // という形にしてある。アルゴリズムは変えていない。
  computeNormalsFor(list, count = list.length) {
    const P = this.positions, N = this.normals, T = this.tris;
    const RD = this.ringData, RC = this.ringCount, REX = this.ringExt;
    const VB = this.vBlocks;
    let dMin = this.vDirtyMin, dMax = this.vDirtyMax;
    let bMin = this.vBlockMin, bMax = this.vBlockMax;

    for (let k = 0; k < count; k++) {
      const v = list[k];
      const rc = RC[v];
      if (rc === 0) continue;
      let nx = 0, ny = 0, nz = 0;
      if (rc <= RING_STRIDE) {
        const base = v * RING_STRIDE;
        for (let j = 0; j < rc; j++) {
          const i = RD[base + j] * 3;
          const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
          const ax = P[a], ay = P[a + 1], az = P[a + 2];
          const e1x = P[b] - ax, e1y = P[b + 1] - ay, e1z = P[b + 2] - az;
          const e2x = P[c] - ax, e2y = P[c + 1] - ay, e2z = P[c + 2] - az;
          nx += e1y * e2z - e1z * e2y;
          ny += e1z * e2x - e1x * e2z;
          nz += e1x * e2y - e1y * e2x;
        }
      } else {
        const ex = REX[v];
        for (let j = 0; j < rc; j++) {
          const i = ex[j] * 3;
          const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
          const ax = P[a], ay = P[a + 1], az = P[a + 2];
          const e1x = P[b] - ax, e1y = P[b + 1] - ay, e1z = P[b + 2] - az;
          const e2x = P[c] - ax, e2y = P[c + 1] - ay, e2z = P[c + 2] - az;
          nx += e1y * e2z - e1z * e2y;
          ny += e1z * e2x - e1x * e2z;
          nz += e1x * e2y - e1y * e2x;
        }
      }
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const iv = v * 3;
      if (l > 1e-20) { const s = 1 / l; N[iv] = nx * s; N[iv + 1] = ny * s; N[iv + 2] = nz * s; }
      // markVert(v) のインライン展開
      if (v < dMin) dMin = v;
      if (v > dMax) dMax = v;
      const bb = v >> DIRTY_SHIFT;
      VB[bb] = 1;
      if (bb < bMin) bMin = bb;
      if (bb > bMax) bMax = bb;
    }
    this.vDirtyMin = dMin; this.vDirtyMax = dMax;
    this.vBlockMin = bMin; this.vBlockMax = bMax;
  }

  /**
   * 離散平均曲率を求める。ラプラシアン（1-ring 重心 − 自身）を法線方向へ射影し、
   * 平均エッジ長で割ってスケール不変にする。凹 > 0 / 凸 < 0。
   * キャビティシェーディングと Relax ブラシで使う。
   */
  // 辺長は二乗和の平方根（RMS）で代用する。平均長との差は正則なメッシュでは小さく、
  // 陰影用の量なので実用上問題ない。内側ループから sqrt を丸ごと外せる。
  // 内側は「三角形の 3 頂点のうち v でない 2 つ」を足す。以前は e=0..3 を回して
  // u === v を弾いていたが、どれが v かは比較 2 回で分かるので
  // ループと分岐をまとめて消せる（近傍 6 個に対して 18 反復 → 12 回の読み出し）。
  // 各近傍が 2 回数えられるのは平均を取るので結果に影響しない。
  computeCurvatureFor(list, count = list.length) {
    const P = this.positions, N = this.normals, T = this.tris, CV = this.curv;
    const RD = this.ringData, RC = this.ringCount, REX = this.ringExt;
    for (let k = 0; k < count; k++) {
      const v = list[k];
      const rc = RC[v];
      if (rc === 0) { CV[v] = 0; continue; }
      const inline = rc <= RING_STRIDE;
      const base = inline ? v * RING_STRIDE : 0;
      const ex = inline ? null : REX[v];
      const iv = v * 3;
      const px = P[iv], py = P[iv + 1], pz = P[iv + 2];
      let sx = 0, sy = 0, sz = 0, e2 = 0, cnt = 0;
      for (let j = 0; j < rc; j++) {
        const ti = (inline ? RD[base + j] : ex[j]) * 3;
        const t0 = T[ti], t1 = T[ti + 1], t2 = T[ti + 2];
        let u1, u2;
        if (t0 === v) { u1 = t1; u2 = t2; }
        else if (t1 === v) { u1 = t2; u2 = t0; }
        else { u1 = t0; u2 = t1; }
        const i1 = u1 * 3;
        let dx = P[i1] - px, dy = P[i1 + 1] - py, dz = P[i1 + 2] - pz;
        sx += dx; sy += dy; sz += dz;
        e2 += dx * dx + dy * dy + dz * dz;
        const i2 = u2 * 3;
        dx = P[i2] - px; dy = P[i2 + 1] - py; dz = P[i2 + 2] - pz;
        sx += dx; sy += dy; sz += dz;
        e2 += dx * dx + dy * dy + dz * dz;
        cnt += 2;
      }
      if (cnt === 0 || e2 <= 0) { CV[v] = 0; continue; }
      const inv = 1 / cnt;
      const e = Math.sqrt(e2 * inv);
      const d = (sx * N[iv] + sy * N[iv + 1] + sz * N[iv + 2]) * inv / e;
      CV[v] = d < -1 ? -1 : (d > 1 ? 1 : d);
    }
  }

  /** 曲率は 2 次量でノイズが乗りやすいので 1-ring 平均で軽く均す */
  smoothCurvatureFor(list, count = list.length, amount = 0.55) {
    const T = this.tris, CV = this.curv;
    const RD = this.ringData, RC = this.ringCount, REX = this.ringExt;
    const tmp = this._curvTmp && this._curvTmp.length >= count
      ? this._curvTmp : (this._curvTmp = new Float32Array(Math.max(1024, count * 2)));
    for (let k = 0; k < count; k++) {
      const v = list[k];
      const rc = RC[v];
      const cv = CV[v];
      if (rc === 0) { tmp[k] = cv; continue; }
      const inline = rc <= RING_STRIDE;
      const base = inline ? v * RING_STRIDE : 0;
      const ex = inline ? null : REX[v];
      let s = 0;
      for (let j = 0; j < rc; j++) {
        const ti = (inline ? RD[base + j] : ex[j]) * 3;
        const t0 = T[ti], t1 = T[ti + 1], t2 = T[ti + 2];
        // computeCurvatureFor と同じ「v でない 2 つ」の取り出し方
        if (t0 === v) s += CV[t1] + CV[t2];
        else if (t1 === v) s += CV[t2] + CV[t0];
        else s += CV[t0] + CV[t1];
      }
      tmp[k] = cv + (s / (rc * 2) - cv) * amount;
    }
    for (let k = 0; k < count; k++) CV[list[k]] = tmp[k];
  }

  /**
   * 全頂点の曲率。ring[] を辿らず三角形を 1 回走査して隣接和を積む。
   * 配列間接参照が消えるぶん、頂点ごとに ring を舐める版より数倍速い。
   */
  computeAllCurvature() {
    const nv = this.nv;
    if (nv === 0) return;
    // 平坦な配列だけを触るループなので WASM に出す。260 万頂点で 122ms → 34ms。
    // トポロジが変わるたびに走るので、ここが効くと全機能が速くなる。
    if (wasmCurvature(this)) { this.markAllDirty(); return; }
    const P = this.positions, N = this.normals, T = this.tris, CV = this.curv;

    if (!this._cvSum || this._cvSum.length < nv * 3) {
      this._cvSum = new Float32Array(nv * 3);
      this._cvE2 = new Float32Array(nv);
      this._cvCnt = new Float32Array(nv);
    }
    const S = this._cvSum, E2 = this._cvE2, CN = this._cvCnt;
    S.fill(0, 0, nv * 3); E2.fill(0, 0, nv); CN.fill(0, 0, nv);

    for (let t = 0; t < this.nt; t++) {
      const i = t * 3;
      const ia = T[i], ib = T[i + 1], ic = T[i + 2];
      if (ia === ib && ib === ic) continue;
      const a = ia * 3, b = ib * 3, c = ic * 3;
      const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2];
      const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2];
      const bcx = P[c] - P[b], bcy = P[c + 1] - P[b + 1], bcz = P[c + 2] - P[b + 2];
      const lab = abx * abx + aby * aby + abz * abz;
      const lac = acx * acx + acy * acy + acz * acz;
      const lbc = bcx * bcx + bcy * bcy + bcz * bcz;
      S[a] += abx + acx; S[a + 1] += aby + acy; S[a + 2] += abz + acz;
      S[b] += bcx - abx; S[b + 1] += bcy - aby; S[b + 2] += bcz - abz;
      S[c] += -acx - bcx; S[c + 1] += -acy - bcy; S[c + 2] += -acz - bcz;
      E2[ia] += lab + lac; E2[ib] += lab + lbc; E2[ic] += lac + lbc;
      CN[ia] += 2; CN[ib] += 2; CN[ic] += 2;
    }

    for (let v = 0; v < nv; v++) {
      const cnt = CN[v];
      if (cnt === 0 || E2[v] <= 0) { CV[v] = 0; continue; }
      const iv = v * 3;
      const inv = 1 / cnt;
      const e = Math.sqrt(E2[v] * inv);
      const d = (S[iv] * N[iv] + S[iv + 1] * N[iv + 1] + S[iv + 2] * N[iv + 2]) * inv / e;
      CV[v] = d < -1 ? -1 : (d > 1 ? 1 : d);
    }

    // 平滑化も同じく三角形走査で
    S.fill(0, 0, nv); CN.fill(0, 0, nv);
    for (let t = 0; t < this.nt; t++) {
      const i = t * 3;
      const ia = T[i], ib = T[i + 1], ic = T[i + 2];
      if (ia === ib && ib === ic) continue;
      const ca = CV[ia], cb = CV[ib], cc = CV[ic];
      S[ia] += cb + cc; S[ib] += cc + ca; S[ic] += ca + cb;
      CN[ia] += 2; CN[ib] += 2; CN[ic] += 2;
    }
    const amount = 0.55;
    for (let v = 0; v < nv; v++) {
      const cnt = CN[v];
      if (cnt === 0) continue;
      CV[v] += (S[v] / cnt - CV[v]) * amount;
    }
    this.markAllDirty();
  }

  computeAllNormals() {
    if (wasmNormals(this)) { this.markAllDirty(); return; }
    const P = this.positions, N = this.normals, T = this.tris;
    N.fill(0, 0, this.nv * 3);
    for (let t = 0; t < this.nt; t++) {
      const i = t * 3;
      const ia = T[i], ib = T[i + 1], ic = T[i + 2];
      if (ia === ib && ib === ic) continue;
      const a = ia * 3, b = ib * 3, c = ic * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (let v = 0; v < this.nv; v++) {
      const i = v * 3;
      const l = Math.sqrt(N[i] * N[i] + N[i + 1] * N[i + 1] + N[i + 2] * N[i + 2]);
      if (l > 1e-20) { N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
      else { N[i] = 0; N[i + 1] = 1; N[i + 2] = 0; }
    }
    this.markAllDirty();
  }

  rebuildRings() {
    const nv = this.nv, T = this.tris;
    this.ringCount.fill(0, 0, nv);
    for (let v = 0; v < nv; v++) this.ringExt[v] = null;
    for (let t = 0; t < this.nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      this._link(a, t); this._link(b, t); this._link(c, t);
    }
  }

  // --- 統計 / 領域 --------------------------------------------------------

  bounds() {
    const P = this.positions;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < this.nv; v++) {
      if (!this.vAlive[v]) continue;
      const i = v * 3;
      if (P[i] < minX) minX = P[i]; if (P[i] > maxX) maxX = P[i];
      if (P[i + 1] < minY) minY = P[i + 1]; if (P[i + 1] > maxY) maxY = P[i + 1];
      if (P[i + 2] < minZ) minZ = P[i + 2]; if (P[i + 2] > maxZ) maxZ = P[i + 2];
    }
    if (minX > maxX) { minX = minY = minZ = -1; maxX = maxY = maxZ = 1; }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    const r = Math.max(1e-4, 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], center: [cx, cy, cz], radius: r };
  }

  /** 生きている辺の平均長（サンプリング） */
  averageEdgeLength(sampleTris = 3000) {
    const P = this.positions, T = this.tris;
    let sum = 0, n = 0;
    const step = Math.max(1, Math.floor(this.nt / sampleTris));
    for (let t = 0; t < this.nt; t += step) {
      const i = t * 3;
      const ia = T[i], ib = T[i + 1], ic = T[i + 2];
      if (ia === ib && ib === ic) continue;
      const a = ia * 3, b = ib * 3, c = ic * 3;
      sum += Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
      sum += Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]);
      sum += Math.hypot(P[a] - P[c], P[a + 1] - P[c + 1], P[a + 2] - P[c + 2]);
      n += 3;
    }
    return n > 0 ? sum / n : 0.05;
  }

  // --- 構築 / 圧縮 --------------------------------------------------------

  /**
   * インデックス付きジオメトリからメッシュを作り直す。
   * colors / mask を渡すとポリペイントとマスクも引き継ぐ。
   */
  setGeometry(positions, indices, colors = null, mask = null) {
    const nv = positions.length / 3;
    const nt = indices.length / 3;
    this.capV = 0; this.capT = 0;
    this.positions = new Float32Array(0);
    this.normals = new Float32Array(0);
    this.colors = new Float32Array(0);
    this.mask = new Float32Array(0);
    this.vAlive = new Uint8Array(0);
    this.tris = new Int32Array(0);
    this.nv = 0; this.nt = 0;
    this.freeVerts.length = 0; this.freeTris.length = 0;
    this._allocVerts(Math.max(1024, Math.ceil(nv * 1.5)));
    this._allocTris(Math.max(2048, Math.ceil(nt * 1.5)));

    this.positions.set(positions);
    if (colors && colors.length >= nv * 3) {
      this.colors.set(colors.subarray(0, nv * 3));
    } else {
      this.colors.fill(1, 0, nv * 3);
    }
    if (mask && mask.length >= nv) {
      this.mask.set(mask.subarray(0, nv));
    } else {
      this.mask.fill(0, 0, nv);
    }
    this.curv.fill(0, 0, nv);
    this.vAlive.fill(1, 0, nv);
    this.nv = nv;
    this.liveVerts = nv;

    this.tris.set(indices);
    this.nt = nt;
    this.liveTris = nt;
    this.rebuildRings();
    this.computeAllNormals();
    this.computeAllCurvature();
    this.topoVersion++;
    this.geomVersion++;
    this.markAllDirty();
  }

  /** フリースロットが多くなったら詰める（ストローク終了時に呼ぶ） */
  /**
   * 死んだスロットを詰めて 0..liveVerts-1 / 0..liveTris-1 が全部生きている状態にする。
   *
   * ゴミが少ないうちは費用に見合わないので既定では何もしない（false を返す）。
   * 「詰まっていること」を前提にする処理（分割レベル）は force=true で呼ぶこと。
   * 実際に、dyntopo で死んだスロットが 2 個（0.03%）残っただけで Divide が
   * 範囲外の頂点を参照して形が崩壊するバグを出した。
   */
  compact(force = false) {
    if (!force && this.freeTris.length < this.nt * 0.2 && this.freeVerts.length < this.nv * 0.2) return false;
    if (this.freeTris.length === 0 && this.freeVerts.length === 0) return false;
    const remapV = new Int32Array(this.nv).fill(-1);
    const P = new Float32Array(this.liveVerts * 3);
    const N = new Float32Array(this.liveVerts * 3);
    const C = new Float32Array(this.liveVerts * 3);
    const M = new Float32Array(this.liveVerts);
    const CV = new Float32Array(this.liveVerts);
    let w = 0;
    for (let v = 0; v < this.nv; v++) {
      if (!this.vAlive[v]) continue;
      remapV[v] = w;
      P[w * 3] = this.positions[v * 3];
      P[w * 3 + 1] = this.positions[v * 3 + 1];
      P[w * 3 + 2] = this.positions[v * 3 + 2];
      N[w * 3] = this.normals[v * 3];
      N[w * 3 + 1] = this.normals[v * 3 + 1];
      N[w * 3 + 2] = this.normals[v * 3 + 2];
      C[w * 3] = this.colors[v * 3];
      C[w * 3 + 1] = this.colors[v * 3 + 1];
      C[w * 3 + 2] = this.colors[v * 3 + 2];
      M[w] = this.mask[v];
      CV[w] = this.curv[v];
      w++;
    }
    const idx = new Int32Array(this.liveTris * 3);
    let wt = 0;
    for (let t = 0; t < this.nt; t++) {
      const i = t * 3, T = this.tris;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
      const a = remapV[T[i]], b = remapV[T[i + 1]], c = remapV[T[i + 2]];
      if (a < 0 || b < 0 || c < 0) continue;
      idx[wt * 3] = a; idx[wt * 3 + 1] = b; idx[wt * 3 + 2] = c;
      wt++;
    }

    const nv = w, nt = wt;
    this.capV = 0; this.capT = 0;
    this.positions = new Float32Array(0);
    this.normals = new Float32Array(0);
    this.colors = new Float32Array(0);
    this.mask = new Float32Array(0);
    this.vAlive = new Uint8Array(0);
    this.tris = new Int32Array(0);
    this.nv = 0; this.nt = 0;
    this.freeVerts.length = 0; this.freeTris.length = 0;
    this._allocVerts(Math.max(1024, Math.ceil(nv * 1.4)));
    this._allocTris(Math.max(2048, Math.ceil(nt * 1.4)));
    this.positions.set(P.subarray(0, nv * 3));
    this.normals.set(N.subarray(0, nv * 3));
    this.colors.set(C.subarray(0, nv * 3));
    this.mask.set(M.subarray(0, nv));
    this.curv.set(CV.subarray(0, nv));
    this.vAlive.fill(1, 0, nv);
    this.nv = nv; this.liveVerts = nv;
    this.tris.set(idx.subarray(0, nt * 3));
    this.nt = nt; this.liveTris = nt;
    this.rebuildRings();
    this.topoVersion++;
    this.markAllDirty();
    return true;
  }

  // --- スナップショット（アンドゥ） --------------------------------------

  /**
   * アンドゥ用のスナップショット。
   *
   * 配列ごとに **3 つの形** のどれかを持つ（`resolveSnapshot` で全長へ戻す）:
   *
   *   1. **共有** — 中身が 1 つも変わっていなければ、前の履歴の入れ物を
   *      そのまま指す（restore は読むだけなので安全）。コストは 0。
   *   2. **差分** — 変わった要素だけを `{delta, from, idx, val}` で持つ。
   *      `from` は**前のスナップショットのオブジェクト**。全長へ戻すときは
   *      アンカー（全長を持っている履歴）まで遡ってから差分を当てていく。
   *   3. **全長** — 上の 2 つが使えないとき（長さが変わった = トポロジが変わった、
   *      変わった要素が多すぎる、差分の連鎖が深すぎる）は切り出してコピーする。
   *
   * 1 ストロークで全部が変わることはまずない。粘土で彫れば positions だけ、
   * ポリペイントなら colors だけ、マスクを塗れば mask だけが変わり、接続
   * （tris / vAlive / フリーリスト）は動的トポロジを使わない限り変わらない。
   * さらに **変わるのは筆の下の数千頂点だけ** なので、そこを差分にすると
   * 1 件あたりが桁で小さくなる。260 万頂点で 1 件 44.6MB（戻れるのは 7 回）
   * だったものが、差分なら数十 KB で済む。
   *
   * 判定は **中身の比較**。topoVersion では駄目で、addVertex はこれを上げないし、
   * 上げ忘れが 1 か所あるだけで履歴が黙って壊れる（違う接続を共有してしまう）。
   * 比較は上限を超えた時点で打ち切る。
   *
   * @param {object} [prev] 直前のスナップショット
   * @param {object} [base] prev の**中身**（全長の配列を key ごとに持つ）。
   *   差分を取る相手。prev が差分の連鎖でも毎回ほどかずに済むよう、History が
   *   materialize したものを渡す。無ければ差分にせず全長を持つ
   */
  snapshot(prev = null, base = null) {
    const nv = this.nv, nt = this.nt;
    const shared = [];
    const lens = { positions: nv * 3, colors: nv * 3, mask: nv, vAlive: nv, tris: nt * 3 };
    /** フリーリストは JS 配列なので別扱い（小さいので差分にしない） */
    const keepList = (key, src) => {
      const p = prev ? prev[key] : null;
      if (p && p.length === src.length) {
        let same = true;
        for (let i = 0; i < src.length; i++) { if (p[i] !== src[i]) { same = false; break; } }
        if (same) { shared.push(key); return p; }
      }
      return src.slice();
    };
    const out = {
      nv, nt,
      liveVerts: this.liveVerts, liveTris: this.liveTris,
      freeVerts: keepList('freeVerts', this.freeVerts),
      freeTris: keepList('freeTris', this.freeTris),
      // 前の履歴と共有している配列の名前（診断用）
      shared,
    };
    for (const key of SNAP_KEYS) {
      out[key] = snapEntry(key, this[key], lens[key], prev, base, shared);
    }
    return out;
  }

  restore(s) {
    this._allocVerts(s.nv);
    this._allocTris(s.nt);
    this.positions.set(resolveSnapshot(s, 'positions'));
    this.colors.set(resolveSnapshot(s, 'colors'));
    this.mask.set(resolveSnapshot(s, 'mask'));
    this.vAlive.set(resolveSnapshot(s, 'vAlive'));
    this.tris.set(resolveSnapshot(s, 'tris'));
    this.nv = s.nv; this.nt = s.nt;
    this.liveVerts = s.liveVerts; this.liveTris = s.liveTris;
    this.freeVerts = s.freeVerts.slice();
    this.freeTris = s.freeTris.slice();
    this.rebuildRings();
    this.computeAllNormals();
    this.computeAllCurvature();
    this.topoVersion++;
    this.geomVersion++;
    this.markAllDirty();
  }

  byteSize() {
    return this.positions.byteLength + this.normals.byteLength + this.colors.byteLength
      + this.mask.byteLength + this.curv.byteLength + this.tris.byteLength;
  }
}

// ---------------------------------------------------------------------------
// プリミティブ
// ---------------------------------------------------------------------------

/**
 * 位置が一致する頂点を溶接し、退化三角形と（頂点集合が同一の）重複面を除去する。
 * 壊れた OBJ を読み込んでも多様体に近い状態を保つための保険。
 */
export function weld(positions, indices, eps = 1e-5) {
  const map = new Map();
  const remap = new Int32Array(positions.length / 3);
  const out = [];
  const inv = 1 / eps;
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(x, y, z);
    }
    remap[v] = id;
  }
  const idx = [];
  const faces = new Set();
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]], b = remap[indices[i + 1]], c = remap[indices[i + 2]];
    if (a === b || b === c || c === a) continue;
    const s = a < b ? (b < c ? [a, b, c] : (a < c ? [a, c, b] : [c, a, b]))
      : (a < c ? [b, a, c] : (b < c ? [b, c, a] : [c, b, a]));
    const key = `${s[0]},${s[1]},${s[2]}`;
    if (faces.has(key)) continue;
    faces.add(key);
    idx.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(idx) };
}

export function icosphere(subdiv = 3, radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(p => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l];
  });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < subdiv; s++) {
    const cache = new Map();
    const nf = [];
    const mid = (a, b) => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      let m = cache.get(key);
      if (m === undefined) {
        const pa = verts[a], pb = verts[b];
        let x = pa[0] + pb[0], y = pa[1] + pb[1], z = pa[2] + pb[2];
        const l = Math.hypot(x, y, z);
        m = verts.length;
        verts.push([x / l, y / l, z / l]);
        cache.set(key, m);
      }
      return m;
    };
    for (const f of faces) {
      const a = mid(f[0], f[1]), b = mid(f[1], f[2]), c = mid(f[2], f[0]);
      nf.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]);
    }
    faces = nf;
  }

  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i][0] * radius;
    positions[i * 3 + 1] = verts[i][1] * radius;
    positions[i * 3 + 2] = verts[i][2] * radius;
  }
  const indices = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    indices[i * 3] = faces[i][0]; indices[i * 3 + 1] = faces[i][1]; indices[i * 3 + 2] = faces[i][2];
  }
  return { positions, indices };
}

/** 分割立方体（spherify=true で球状に投影） */
export function cube(seg = 12, size = 1, spherify = false) {
  const pos = [], idx = [];
  const dirs = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of dirs) {
    const base = pos.length / 3;
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * 2 - 1;
        const b = (j / seg) * 2 - 1;
        let x = n[0] + u[0] * a + v[0] * b;
        let y = n[1] + u[1] * a + v[1] * b;
        let z = n[2] + u[2] * a + v[2] * b;
        if (spherify) {
          const l = Math.hypot(x, y, z);
          x /= l; y /= l; z /= l;
          pos.push(x * size, y * size, z * size);
        } else {
          pos.push(x * size * 0.5773502692, y * size * 0.5773502692, z * size * 0.5773502692);
        }
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const p = base + j * (seg + 1) + i;
        idx.push(p, p + 1, p + seg + 2, p, p + seg + 2, p + seg + 1);
      }
    }
  }
  return weld(new Float32Array(pos), new Uint32Array(idx), 1e-5);
}

export function cylinder(radial = 32, height = 2, radius = 0.7, heightSeg = 12) {
  const pos = [], idx = [];
  for (let j = 0; j <= heightSeg; j++) {
    const y = -height * 0.5 + (j / heightSeg) * height;
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      pos.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
    }
  }
  for (let j = 0; j < heightSeg; j++) {
    for (let i = 0; i < radial; i++) {
      const i2 = (i + 1) % radial;
      const p0 = j * radial + i, p1 = j * radial + i2;
      const p2 = (j + 1) * radial + i2, p3 = (j + 1) * radial + i;
      idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
  // 蓋
  const bot = pos.length / 3; pos.push(0, -height * 0.5, 0);
  const top = pos.length / 3; pos.push(0, height * 0.5, 0);
  for (let i = 0; i < radial; i++) {
    const i2 = (i + 1) % radial;
    idx.push(bot, i2, i);
    const off = heightSeg * radial;
    idx.push(top, off + i, off + i2);
  }
  return weld(new Float32Array(pos), new Uint32Array(idx), 1e-5);
}

export function torus(radial = 48, tubular = 24, R = 0.8, r = 0.32) {
  const pos = [], idx = [];
  for (let i = 0; i < radial; i++) {
    const u = (i / radial) * Math.PI * 2;
    for (let j = 0; j < tubular; j++) {
      const v = (j / tubular) * Math.PI * 2;
      pos.push(
        (R + r * Math.cos(v)) * Math.cos(u),
        r * Math.sin(v),
        (R + r * Math.cos(v)) * Math.sin(u),
      );
    }
  }
  for (let i = 0; i < radial; i++) {
    for (let j = 0; j < tubular; j++) {
      const i2 = (i + 1) % radial, j2 = (j + 1) % tubular;
      const p0 = i * tubular + j, p1 = i2 * tubular + j;
      const p2 = i2 * tubular + j2, p3 = i * tubular + j2;
      idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export function plane(seg = 40, size = 2) {
  const pos = [], idx = [];
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      pos.push((i / seg - 0.5) * size, 0, (j / seg - 0.5) * size);
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const p = j * (seg + 1) + i;
      idx.push(p, p + seg + 1, p + seg + 2, p, p + seg + 2, p + 1);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export const PRIMITIVES = {
  sphere: () => icosphere(4, 1),
  sphereHi: () => icosphere(5, 1),
  quadball: () => cube(20, 1, true),
  cube: () => cube(16, 1.5, false),
  cylinder: () => cylinder(40, 2, 0.65, 16),
  torus: () => torus(56, 28, 0.8, 0.3),
  plane: () => plane(48, 2.4),
};
