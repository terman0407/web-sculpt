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

export const MAX_VERTS_HARD = 2000000;   // エッジキーの packing 上限に合わせる

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

    this.ring = [];            // ring[v] = 隣接三角形 id の配列
    this.freeVerts = [];
    this.freeTris = [];

    // 新規に作られた要素を追跡（dyntopo が使う）
    this.trackVerts = null;
    this.trackTris = null;

    // 転送用 dirty レンジ
    this.vDirtyMin = Infinity; this.vDirtyMax = -1;
    this.tDirtyMin = Infinity; this.tDirtyMax = -1;
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
    // ring はスロットを使い回す（毎回作り直すと小さい配列の大量確保で GC が重くなる）
    for (let i = this.ring.length; i < cap; i++) this.ring.push(null);
    this.capV = cap;
  }

  _allocTris(cap) {
    if (cap <= this.capT) return;
    cap = Math.max(cap, Math.ceil(this.capT * 1.6), 2048);
    this.tris = growI32(this.tris, this.nt * 3, cap * 3);
    this.capT = cap;
  }

  // --- dirty マーキング ---------------------------------------------------

  markVert(i) {
    if (i < this.vDirtyMin) this.vDirtyMin = i;
    if (i > this.vDirtyMax) this.vDirtyMax = i;
  }
  markTri(t) {
    if (t < this.tDirtyMin) this.tDirtyMin = t;
    if (t > this.tDirtyMax) this.tDirtyMax = t;
  }
  markAllDirty() {
    this.vDirtyMin = 0; this.vDirtyMax = this.nv - 1;
    this.tDirtyMin = 0; this.tDirtyMax = this.nt - 1;
  }
  clearDirty() {
    this.vDirtyMin = Infinity; this.vDirtyMax = -1;
    this.tDirtyMin = Infinity; this.tDirtyMax = -1;
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
    { const r = this.ring[v]; if (r) r.length = 0; else this.ring[v] = []; }
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
    { const r = this.ring[v]; if (r) r.length = 0; else this.ring[v] = []; }
    this.freeVerts.push(v);
    this.liveVerts--;
    this.topoVersion++;
  }

  isVertAlive(v) { return this.vAlive[v] === 1; }

  // --- 三角形 -------------------------------------------------------------

  _link(v, t) {
    const r = this.ring[v];
    if (r) r.push(t);
  }
  _unlink(v, t) {
    const r = this.ring[v];
    if (!r) return;
    const k = r.indexOf(t);
    if (k >= 0) { r[k] = r[r.length - 1]; r.pop(); }
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
    const r = this.ring[a];
    if (!r) return out;
    const T = this.tris;
    for (let k = 0; k < r.length; k++) {
      const i = r[k] * 3;
      if (T[i] === b || T[i + 1] === b || T[i + 2] === b) out.push(r[k]);
    }
    return out;
  }

  /** 頂点 v の 1-ring 頂点を out(Set 互換 push) に集める */
  oneRing(v, out) {
    out.length = 0;
    const r = this.ring[v];
    if (!r) return out;
    const T = this.tris;
    for (let k = 0; k < r.length; k++) {
      const i = r[k] * 3;
      for (let j = 0; j < 3; j++) {
        const w = T[i + j];
        if (w !== v && out.indexOf(w) < 0) out.push(w);
      }
    }
    return out;
  }

  valence(v) {
    const r = this.ring[v];
    return r ? r.length : 0;
  }

  // --- 法線 ---------------------------------------------------------------

  computeNormalsFor(list, count = list.length) {
    const P = this.positions, N = this.normals, T = this.tris;
    for (let k = 0; k < count; k++) {
      const v = list[k];
      const r = this.ring[v];
      if (!r || r.length === 0) continue;
      let nx = 0, ny = 0, nz = 0;
      for (let j = 0; j < r.length; j++) {
        const i = r[j] * 3;
        const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        nx += e1y * e2z - e1z * e2y;
        ny += e1z * e2x - e1x * e2z;
        nz += e1x * e2y - e1y * e2x;
      }
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const iv = v * 3;
      if (l > 1e-20) { N[iv] = nx / l; N[iv + 1] = ny / l; N[iv + 2] = nz / l; }
      this.markVert(v);
    }
  }

  /**
   * 離散平均曲率を求める。ラプラシアン（1-ring 重心 − 自身）を法線方向へ射影し、
   * 平均エッジ長で割ってスケール不変にする。凹 > 0 / 凸 < 0。
   * キャビティシェーディングと Relax ブラシで使う。
   */
  // 辺長は二乗和の平方根（RMS）で代用する。平均長との差は正則なメッシュでは小さく、
  // 陰影用の量なので実用上問題ない。内側ループから sqrt を丸ごと外せる。
  computeCurvatureFor(list, count = list.length) {
    const P = this.positions, N = this.normals, T = this.tris, CV = this.curv;
    for (let k = 0; k < count; k++) {
      const v = list[k];
      const r = this.ring[v];
      if (!r || r.length === 0) { CV[v] = 0; continue; }
      const iv = v * 3;
      const px = P[iv], py = P[iv + 1], pz = P[iv + 2];
      let sx = 0, sy = 0, sz = 0, e2 = 0, cnt = 0;
      for (let j = 0; j < r.length; j++) {
        const ti = r[j] * 3;
        for (let e = 0; e < 3; e++) {
          const u = T[ti + e];
          if (u === v) continue;
          const iu = u * 3;
          const dx = P[iu] - px, dy = P[iu + 1] - py, dz = P[iu + 2] - pz;
          sx += dx; sy += dy; sz += dz;
          e2 += dx * dx + dy * dy + dz * dz;
          cnt++;
        }
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
    const tmp = this._curvTmp && this._curvTmp.length >= count
      ? this._curvTmp : (this._curvTmp = new Float32Array(Math.max(1024, count * 2)));
    for (let k = 0; k < count; k++) {
      const v = list[k];
      const r = this.ring[v];
      if (!r || r.length === 0) { tmp[k] = CV[v]; continue; }
      let s = 0, cnt = 0;
      for (let j = 0; j < r.length; j++) {
        const ti = r[j] * 3;
        for (let e = 0; e < 3; e++) {
          const u = T[ti + e];
          if (u === v) continue;
          s += CV[u]; cnt++;
        }
      }
      tmp[k] = cnt ? CV[v] + (s / cnt - CV[v]) * amount : CV[v];
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
    const nv = this.nv, ring = this.ring, T = this.tris;
    // 既存の配列を length=0 で再利用する（作り直すと nv 個ぶんの確保が発生する）
    for (let v = 0; v < nv; v++) {
      const r = ring[v];
      if (r) r.length = 0; else ring[v] = [];
    }
    for (let t = 0; t < this.nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      ring[a].push(t); ring[b].push(t); ring[c].push(t);
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
  compact() {
    if (this.freeTris.length < this.nt * 0.2 && this.freeVerts.length < this.nv * 0.2) return false;
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

  snapshot() {
    return {
      nv: this.nv, nt: this.nt,
      liveVerts: this.liveVerts, liveTris: this.liveTris,
      positions: this.positions.slice(0, this.nv * 3),
      colors: this.colors.slice(0, this.nv * 3),
      mask: this.mask.slice(0, this.nv),
      vAlive: this.vAlive.slice(0, this.nv),
      tris: this.tris.slice(0, this.nt * 3),
      freeVerts: this.freeVerts.slice(),
      freeTris: this.freeTris.slice(),
    };
  }

  restore(s) {
    this._allocVerts(s.nv);
    this._allocTris(s.nt);
    this.positions.set(s.positions);
    this.colors.set(s.colors);
    this.mask.set(s.mask);
    this.vAlive.set(s.vAlive);
    this.tris.set(s.tris);
    this.nv = s.nv; this.nt = s.nt;
    this.liveVerts = s.liveVerts; this.liveTris = s.liveTris;
    this.freeVerts = s.freeVerts.slice();
    this.freeTris = s.freeTris.slice();
    this.ring.length = Math.max(this.ring.length, this.capV);
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
