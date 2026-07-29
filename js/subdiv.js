// ---------------------------------------------------------------------------
// subdiv.js
// ZBrush の SDiv（分割レベル）相当。
//
//   Divide  : 全辺を中点分割して 1 面 → 4 面にする。元の頂点はインデックスを保つ。
//   SDiv 下 : 細かいレベルの低周波成分を粗いレベルへ落とす（形が引き継がれる）
//   SDiv 上 : 粗いレベルの編集結果に、保存しておいた変位を載せ直す
//
// 変位は「粗い面から予測される位置」との差をローカル座標系（接線 / 従接線 / 法線）で
// 保存する。粗いレベルで曲げたり回したりしても、細部が正しく追従する。
//
// dyntopo / ダイナメッシュで接続が変わるとレベルは無効になる（ZBrush でも同様に
// Sculptris Pro と SDiv は併用できない）。topoVersion で検出して破棄する。
// ---------------------------------------------------------------------------

/** 粗いメッシュの頂点法線を求める（面積加重） */
function coarseNormals(pos, tris, nv) {
  const N = new Float32Array(nv * 3);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
    N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
    N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
  }
  for (let v = 0; v < nv; v++) {
    const i = v * 3;
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (l > 1e-20) { N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
    else { N[i] = 0; N[i + 1] = 1; N[i + 2] = 0; }
  }
  return N;
}

/**
 * 中点 m（辺 a-b 上）の予測位置とローカル基底を作る。
 * 上げ / 下げの両方で同じ規則を使うことが重要。
 */
function midFrame(pos, nrm, a, b, out) {
  const ia = a * 3, ib = b * 3;
  const px = (pos[ia] + pos[ib]) * 0.5;
  const py = (pos[ia + 1] + pos[ib + 1]) * 0.5;
  const pz = (pos[ia + 2] + pos[ib + 2]) * 0.5;

  // 接線は辺方向
  let tx = pos[ib] - pos[ia], ty = pos[ib + 1] - pos[ia + 1], tz = pos[ib + 2] - pos[ia + 2];
  let l = Math.hypot(tx, ty, tz);
  if (l < 1e-20) { tx = 1; ty = 0; tz = 0; l = 1; }
  tx /= l; ty /= l; tz /= l;

  // 法線は両端の平均から接線成分を除いたもの
  let nx = nrm[ia] + nrm[ib], ny = nrm[ia + 1] + nrm[ib + 1], nz = nrm[ia + 2] + nrm[ib + 2];
  const d = nx * tx + ny * ty + nz * tz;
  nx -= tx * d; ny -= ty * d; nz -= tz * d;
  l = Math.hypot(nx, ny, nz);
  if (l < 1e-12) {
    // 接線に垂直な適当な軸を作る
    if (Math.abs(tx) < 0.9) { nx = 0; ny = -tz; nz = ty; }
    else { nx = -tz; ny = 0; nz = tx; }
    l = Math.hypot(nx, ny, nz) || 1;
  }
  nx /= l; ny /= l; nz /= l;

  // 従接線
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;

  out[0] = px; out[1] = py; out[2] = pz;
  out[3] = tx; out[4] = ty; out[5] = tz;
  out[6] = bx; out[7] = by; out[8] = bz;
  out[9] = nx; out[10] = ny; out[11] = nz;
}

/**
 * 中点分割の接続を作る。
 *
 * 辺 → 中点の対応は開番地法のハッシュ表を型付き配列で持つ。以前は
 * `Map<number, number>` に `a * 2^21 + b` を入れていたが、キーが 2^31 を超えて
 * 小整数として扱えず、131 万面の Divide で 400 万回の Map 操作に 750ms
 * かかっていた。Divide は一番よく使う重い操作なのでここが効く。
 *
 * @returns {{indices, edgeA, edgeB, midIdx}}
 *   midIdx は粗い三角形ごとの中点番号 (ab, bc, ca)。これを取っておくと
 *   SDiv 上げのときにハッシュ表を作り直さずに接続を復元できる。
 */
function buildSubdivision(coarseTris, coarseNv) {
  // 閉多様体なら辺は 3F/2 本。境界があると増えるので 3F を上限にする。
  const maxEdge = coarseTris.length;
  let cap = 16;
  while (cap < maxEdge * 2) cap <<= 1;        // 使用率 50% 以下に保つ
  const hmask = cap - 1;
  const kA = new Int32Array(cap).fill(-1);    // -1 = 空きスロット
  const kB = new Int32Array(cap);
  const kM = new Int32Array(cap);
  const edgeA = new Int32Array(maxEdge);
  const edgeB = new Int32Array(maxEdge);
  let nEdge = 0;
  let next = coarseNv;

  const idx = new Uint32Array(coarseTris.length * 4);
  const midIdx = new Int32Array(coarseTris.length);
  let w = 0;
  for (let i = 0; i < coarseTris.length; i += 3) {
    const a = coarseTris[i], b = coarseTris[i + 1], c = coarseTris[i + 2];
    let ab = -1, bc = -1, ca = -1;
    // 3 辺を同じ手順で処理する。関数にすると 400 万回の呼び出しになるので展開する。
    for (let e = 0; e < 3; e++) {
      const u = e === 0 ? a : (e === 1 ? b : c);
      const v = e === 0 ? b : (e === 1 ? c : a);
      const lo = u < v ? u : v, hi = u < v ? v : u;
      // 32bit で混ぜる。imul でないと浮動小数になってビット演算前に丸められる。
      let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) >>> 0;
      h = (h ^ (h >>> 15)) & hmask;
      let m = -1;
      for (;;) {
        const sa = kA[h];
        if (sa === -1) {
          m = next++;
          kA[h] = lo; kB[h] = hi; kM[h] = m;
          edgeA[nEdge] = lo; edgeB[nEdge] = hi; nEdge++;
          break;
        }
        if (sa === lo && kB[h] === hi) { m = kM[h]; break; }
        h = (h + 1) & hmask;
      }
      if (e === 0) ab = m; else if (e === 1) bc = m; else ca = m;
    }
    midIdx[i] = ab; midIdx[i + 1] = bc; midIdx[i + 2] = ca;
    idx[w++] = a; idx[w++] = ab; idx[w++] = ca;
    idx[w++] = b; idx[w++] = bc; idx[w++] = ab;
    idx[w++] = c; idx[w++] = ca; idx[w++] = bc;
    idx[w++] = ab; idx[w++] = bc; idx[w++] = ca;
  }
  return {
    indices: idx,
    edgeA: edgeA.subarray(0, nEdge),
    edgeB: edgeB.subarray(0, nEdge),
    midIdx,
  };
}

/**
 * 保存しておいた中点番号から細かい接続を組み直す。
 * buildSubdivision の後半と同じ並べ方でなければならない（下げ / 上げの往復が
 * 同じインデックスになる前提が崩れる）。
 */
function rebuildIndices(coarseTris, midIdx) {
  const idx = new Uint32Array(coarseTris.length * 4);
  let w = 0;
  for (let i = 0; i < coarseTris.length; i += 3) {
    const a = coarseTris[i], b = coarseTris[i + 1], c = coarseTris[i + 2];
    const ab = midIdx[i], bc = midIdx[i + 1], ca = midIdx[i + 2];
    idx[w++] = a; idx[w++] = ab; idx[w++] = ca;
    idx[w++] = b; idx[w++] = bc; idx[w++] = ab;
    idx[w++] = c; idx[w++] = ca; idx[w++] = bc;
    idx[w++] = ab; idx[w++] = bc; idx[w++] = ca;
  }
  return idx;
}

export class SubdivLevels {
  constructor() {
    this.levels = [];    // levels[i] = レベル i（粗）→ i+1（細）の情報
    this.cur = 0;
    this.guard = -1;     // 最後にレベル操作した時点の mesh.topoVersion
  }

  get count() { return this.levels.length; }
  get level() { return this.cur; }
  canUp() { return this.cur < this.levels.length; }
  canDown() { return this.cur > 0; }

  clear() {
    this.levels.length = 0;
    this.cur = 0;
    this.guard = -1;
  }

  /** 外部でトポロジが変わっていたらレベルを破棄する */
  validate(mesh) {
    if (this.levels.length === 0) return true;
    if (mesh.topoVersion !== this.guard) { this.clear(); return false; }
    return true;
  }

  _sync(mesh) { this.guard = mesh.topoVersion; }

  /**
   * 現在のレベルを分割して 1 段上げる。上位レベルがあれば破棄する（ZBrush と同じ）。
   * @returns {object} 統計
   */
  divide(mesh) {
    // dyntopo などでトポロジが変わっていたら、積んであるレベルはもう使えない。
    // 先に捨てておかないと、古い番号で作られた coarseTris が残ったまま
    // 新しいレベルが積まれ、SDiv 下げで壊れる。
    this.validate(mesh);
    // ここは「詰まっている」ことに完全に依存するので必ず詰める。
    // 既定の compact() はゴミが 20% 未満だと何もしないため、
    // dyntopo が残した数個の死んだスロットで前提が崩れていた。
    mesh.compact(true);
    const nv = mesh.liveVerts;
    // compact 済みなので 0..nv-1 が生きている頂点、0..nt-1 が生きている面
    const coarseTris = new Int32Array(mesh.liveTris * 3);
    {
      let w = 0;
      for (let t = 0; t < mesh.nt; t++) {
        const i = t * 3, T = mesh.tris;
        if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
        coarseTris[w++] = T[i]; coarseTris[w++] = T[i + 1]; coarseTris[w++] = T[i + 2];
      }
    }

    const sub = buildSubdivision(coarseTris, nv);
    const nMid = sub.edgeA.length;
    const fineNv = nv + nMid;

    const pos = new Float32Array(fineNv * 3);
    const col = new Float32Array(fineNv * 3);
    const msk = new Float32Array(fineNv);
    pos.set(mesh.positions.subarray(0, nv * 3));
    col.set(mesh.colors.subarray(0, nv * 3));
    msk.set(mesh.mask.subarray(0, nv));
    for (let k = 0; k < nMid; k++) {
      const a = sub.edgeA[k], b = sub.edgeB[k];
      const m = nv + k;
      const ia = a * 3, ib = b * 3, im = m * 3;
      pos[im] = (pos[ia] + pos[ib]) * 0.5;
      pos[im + 1] = (pos[ia + 1] + pos[ib + 1]) * 0.5;
      pos[im + 2] = (pos[ia + 2] + pos[ib + 2]) * 0.5;
      col[im] = (col[ia] + col[ib]) * 0.5;
      col[im + 1] = (col[ia + 1] + col[ib + 1]) * 0.5;
      col[im + 2] = (col[ia + 2] + col[ib + 2]) * 0.5;
      msk[m] = (msk[a] + msk[b]) * 0.5;
    }

    // cur より上のレベルは破棄
    this.levels.length = this.cur;
    this.levels.push({
      coarseTris,
      coarseNv: nv,
      edgeA: sub.edgeA,
      edgeB: sub.edgeB,
      // 中点番号を取っておく。上げるたびにハッシュ表を作り直すと、
      // 131 万面で 270ms ほど「すでに分かっていること」を計算し直すことになる。
      midIdx: sub.midIdx,
      // 下げるときに埋める
      local: null,
      fineCol: null,
      fineMask: null,
    });
    this.cur++;

    mesh.setGeometry(pos, sub.indices, col, msk);
    this._sync(mesh);
    return { level: this.cur, maxLevel: this.levels.length, verts: fineNv, tris: sub.indices.length / 3 };
  }

  /**
   * 1 段下げる。細かいレベルの形は粗い頂点へ引き継がれ、
   * 中点頂点の変位はローカル座標で保存して上げ直しに使う。
   */
  down(mesh) {
    if (!this.canDown()) return null;
    if (!this.validate(mesh)) return null;
    const L = this.levels[this.cur - 1];
    const nv = L.coarseNv;
    const nMid = L.edgeA.length;
    if (mesh.liveVerts !== nv + nMid) { this.clear(); return null; }

    // 粗いレベルの位置 = 細かいレベルの先頭 nv 個（元頂点はインデックスが保たれている）
    const cpos = mesh.positions.slice(0, nv * 3);
    const ccol = mesh.colors.slice(0, nv * 3);
    const cmsk = mesh.mask.slice(0, nv);
    const cnrm = coarseNormals(cpos, L.coarseTris, nv);

    // 中点の変位をローカル座標で保存
    const local = new Float32Array(nMid * 3);
    const fineCol = new Float32Array(nMid * 3);
    const fineMask = new Float32Array(nMid);
    const fr = new Float64Array(12);
    for (let k = 0; k < nMid; k++) {
      const a = L.edgeA[k], b = L.edgeB[k];
      midFrame(cpos, cnrm, a, b, fr);
      const im = (nv + k) * 3;
      const dx = mesh.positions[im] - fr[0];
      const dy = mesh.positions[im + 1] - fr[1];
      const dz = mesh.positions[im + 2] - fr[2];
      local[k * 3] = dx * fr[3] + dy * fr[4] + dz * fr[5];
      local[k * 3 + 1] = dx * fr[6] + dy * fr[7] + dz * fr[8];
      local[k * 3 + 2] = dx * fr[9] + dy * fr[10] + dz * fr[11];
      fineCol[k * 3] = mesh.colors[im];
      fineCol[k * 3 + 1] = mesh.colors[im + 1];
      fineCol[k * 3 + 2] = mesh.colors[im + 2];
      fineMask[k] = mesh.mask[nv + k];
    }
    L.local = local;
    L.fineCol = fineCol;
    L.fineMask = fineMask;

    mesh.setGeometry(cpos, new Uint32Array(L.coarseTris), ccol, cmsk);
    this.cur--;
    this._sync(mesh);
    return { level: this.cur, maxLevel: this.levels.length, verts: nv, tris: L.coarseTris.length / 3 };
  }

  /** 1 段上げる。粗いレベルの編集結果に保存済みの変位を載せ直す。 */
  up(mesh) {
    if (!this.canUp()) return null;
    if (!this.validate(mesh)) return null;
    const L = this.levels[this.cur];
    const nv = L.coarseNv;
    const nMid = L.edgeA.length;
    if (mesh.liveVerts !== nv) { this.clear(); return null; }
    if (!L.local) { this.clear(); return null; }

    const cpos = mesh.positions.slice(0, nv * 3);
    const ccol = mesh.colors.slice(0, nv * 3);
    const cmsk = mesh.mask.slice(0, nv);
    const cnrm = coarseNormals(cpos, L.coarseTris, nv);

    const fineNv = nv + nMid;
    const pos = new Float32Array(fineNv * 3);
    const col = new Float32Array(fineNv * 3);
    const msk = new Float32Array(fineNv);
    pos.set(cpos); col.set(ccol); msk.set(cmsk);

    const fr = new Float64Array(12);
    for (let k = 0; k < nMid; k++) {
      const a = L.edgeA[k], b = L.edgeB[k];
      midFrame(cpos, cnrm, a, b, fr);
      const lx = L.local[k * 3], ly = L.local[k * 3 + 1], lz = L.local[k * 3 + 2];
      const im = (nv + k) * 3;
      pos[im] = fr[0] + fr[3] * lx + fr[6] * ly + fr[9] * lz;
      pos[im + 1] = fr[1] + fr[4] * lx + fr[7] * ly + fr[10] * lz;
      pos[im + 2] = fr[2] + fr[5] * lx + fr[8] * ly + fr[11] * lz;
      col[im] = L.fineCol[k * 3];
      col[im + 1] = L.fineCol[k * 3 + 1];
      col[im + 2] = L.fineCol[k * 3 + 2];
      msk[nv + k] = L.fineMask[k];
    }

    // 接続は分割したときに確定しているので、取っておいた中点番号から組み直す。
    // 古い保存データには midIdx が無いので、そのときだけハッシュ表を作り直す。
    if (!L.midIdx) L.midIdx = buildSubdivision(L.coarseTris, nv).midIdx;
    const indices = rebuildIndices(L.coarseTris, L.midIdx);
    mesh.setGeometry(pos, indices, col, msk);
    this.cur++;
    this._sync(mesh);
    return { level: this.cur, maxLevel: this.levels.length, verts: fineNv, tris: indices.length / 3 };
  }

  bytes() {
    let b = 0;
    for (const L of this.levels) {
      b += L.coarseTris.byteLength + L.edgeA.byteLength + L.edgeB.byteLength;
      if (L.midIdx) b += L.midIdx.byteLength;
      if (L.local) b += L.local.byteLength + L.fineCol.byteLength + L.fineMask.byteLength;
    }
    return b;
  }
}
