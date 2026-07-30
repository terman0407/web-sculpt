// ---------------------------------------------------------------------------
// editmesh.js
// ポリゴンモデリング用の編集メッシュ（Blender の編集モード相当）。
//
// SculptMesh は三角形専用。動的トポロジがその前提で成り立っているので変えられない。
// 一方ポリゴンモデリングの気持ちよさの核は **四角のループ** で、ループカットや
// エッジループ選択は四角が無いと意味を持たない。だから編集用に別のメッシュを持つ。
//
// 使い方は一方通行が基本:
//   彫刻メッシュ → 四角化して編集メッシュ → 組む → 三角形化して彫刻メッシュ
// 四角は彫刻すると消える（動的トポロジもダイナメッシュも三角形化する）。
// ZBrush の ZModeler と DynaMesh の関係と同じ。
//
// --- データ構造について ---
// ハーフエッジではなく「面は頂点ループの CSR + 辺表（辺 → 面 2 枠）」にしてある。
// 段 1（選択・移動・削除・溶解）にはこれで足り、正しさを保つのがずっと簡単。
// 段 2 の押し出し・インセット・ベベル・ループカットが要るのは
//   * 面の頂点ループ（順序つき）
//   * 辺 → 隣接面
//   * 頂点 → 隣接辺・面
// の 3 つで、どれもここにある。ハーフエッジの「次/対」ポインタを持たない代わりに、
// トポロジを変えたら隣接を丸ごと作り直す（O(n)。編集操作は 1 回きりなので問題ない）。
//
// 非多様体な辺（3 面以上が共有）は先頭 2 面だけを記録し、nonManifold に数える。
// 黙って落とすと「なぜか押し出しが変になる」形で後から出てくるので、数を持つ。
// ---------------------------------------------------------------------------

/** 選択モード */
export const SELECT_MODES = [
  { id: 'vert', jp: '頂点', hint: '頂点を選ぶ' },
  { id: 'edge', jp: '辺', hint: '辺を選ぶ' },
  { id: 'face', jp: '面', hint: '面を選ぶ' },
];

export class EditMesh {
  constructor() {
    this.nv = 0;
    this.positions = new Float32Array(0);
    // 面は可変長。faceStart[f]..faceStart[f+1] が面 f の頂点ループ（順序つき）
    this.nf = 0;
    this.faceStart = new Int32Array(1);
    this.faceVerts = new Int32Array(0);
    this.faceAlive = new Uint8Array(0);
    // 辺（無向・重複なし）
    this.ne = 0;
    this.edgeA = new Int32Array(0);
    this.edgeB = new Int32Array(0);
    this.edgeFace = new Int32Array(0);      // ne*2。-1 = 空き（境界）
    this.nonManifold = 0;
    // 頂点 → 辺 / 面（CSR）
    this.vEdgeStart = new Int32Array(1);
    this.vEdge = new Int32Array(0);
    this.vFaceStart = new Int32Array(1);
    this.vFace = new Int32Array(0);
    // 選択
    this.selVert = new Uint8Array(0);
    this.selEdge = new Uint8Array(0);
    this.selFace = new Uint8Array(0);
    this.version = 0;      // 形が変わるたびに増える（表示の作り直し用）
    this.topoVersion = 0;  // 接続が変わるたびに増える
  }

  get liveFaces() {
    let n = 0;
    for (let f = 0; f < this.nf; f++) if (this.faceAlive[f]) n++;
    return n;
  }

  /**
   * (positions, 面の CSR) から作る。
   * @param {Float32Array} positions
   * @param {Int32Array} faceVerts 面ごとの頂点を並べたもの
   * @param {Int32Array} faceStart 面 f は faceStart[f]..faceStart[f+1]
   */
  setGeometry(positions, faceVerts, faceStart) {
    this.nv = positions.length / 3;
    this.positions = Float32Array.from(positions);
    this.nf = faceStart.length - 1;
    this.faceStart = Int32Array.from(faceStart);
    this.faceVerts = Int32Array.from(faceVerts);
    this.faceAlive = new Uint8Array(this.nf).fill(1);
    this.selVert = new Uint8Array(this.nv);
    this.selFace = new Uint8Array(this.nf);
    this.rebuild();
    this.version++;
    this.topoVersion++;
  }

  /** 辺表と隣接を作り直す。トポロジを変えたら必ず呼ぶ */
  rebuild() {
    const nv = this.nv;
    // --- 辺を集める。開番地法のハッシュで重複を潰す（Map はキーが 2^31 を
    // 超えると小整数として扱えず遅い。subdiv.js と同じ理由）
    let maxE = 0;
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f]) continue;
      maxE += this.faceStart[f + 1] - this.faceStart[f];
    }
    let cap = 16;
    while (cap < Math.max(16, maxE) * 2) cap <<= 1;
    const hmask = cap - 1;
    const hA = new Int32Array(cap).fill(-1);
    const hB = new Int32Array(cap);
    const hE = new Int32Array(cap);
    const eA = new Int32Array(maxE);
    const eB = new Int32Array(maxE);
    const eF = new Int32Array(maxE * 2).fill(-1);
    let ne = 0;
    this.nonManifold = 0;

    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f]) continue;
      const s = this.faceStart[f], e = this.faceStart[f + 1];
      const n = e - s;
      for (let k = 0; k < n; k++) {
        const u = this.faceVerts[s + k];
        const v = this.faceVerts[s + (k + 1) % n];
        if (u === v) continue;                       // 退化した辺は無視
        const lo = u < v ? u : v, hi = u < v ? v : u;
        let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) >>> 0;
        h = (h ^ (h >>> 15)) & hmask;
        let id = -1;
        for (;;) {
          if (hA[h] === -1) {
            id = ne++;
            hA[h] = lo; hB[h] = hi; hE[h] = id;
            eA[id] = lo; eB[id] = hi;
            break;
          }
          if (hA[h] === lo && hB[h] === hi) { id = hE[h]; break; }
          h = (h + 1) & hmask;
        }
        if (eF[id * 2] === -1) eF[id * 2] = f;
        else if (eF[id * 2 + 1] === -1) eF[id * 2 + 1] = f;
        else this.nonManifold++;                     // 3 面以上。先頭 2 面だけ持つ
      }
    }
    this.ne = ne;
    this.edgeA = eA.subarray(0, ne);
    this.edgeB = eB.subarray(0, ne);
    this.edgeFace = eF.subarray(0, ne * 2);
    if (this.selEdge.length !== ne) this.selEdge = new Uint8Array(ne);

    // --- 頂点 → 辺（CSR。数えて詰める 2 パス）---
    const ecnt = new Int32Array(nv + 1);
    for (let i = 0; i < ne; i++) { ecnt[eA[i] + 1]++; ecnt[eB[i] + 1]++; }
    for (let v = 0; v < nv; v++) ecnt[v + 1] += ecnt[v];
    this.vEdgeStart = ecnt;
    this.vEdge = new Int32Array(ne * 2);
    {
      const w = ecnt.slice(0, nv);
      for (let i = 0; i < ne; i++) { this.vEdge[w[eA[i]]++] = i; this.vEdge[w[eB[i]]++] = i; }
    }

    // --- 頂点 → 面 ---
    const fcnt = new Int32Array(nv + 1);
    let total = 0;
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f]) continue;
      for (let i = this.faceStart[f]; i < this.faceStart[f + 1]; i++) { fcnt[this.faceVerts[i] + 1]++; total++; }
    }
    for (let v = 0; v < nv; v++) fcnt[v + 1] += fcnt[v];
    this.vFaceStart = fcnt;
    this.vFace = new Int32Array(total);
    {
      const w = fcnt.slice(0, nv);
      for (let f = 0; f < this.nf; f++) {
        if (!this.faceAlive[f]) continue;
        for (let i = this.faceStart[f]; i < this.faceStart[f + 1]; i++) this.vFace[w[this.faceVerts[i]]++] = f;
      }
    }
    if (this.selVert.length !== nv) this.selVert = new Uint8Array(nv);
    if (this.selFace.length !== this.nf) this.selFace = new Uint8Array(this.nf);
  }

  // --- 参照 ---------------------------------------------------------------

  faceSize(f) { return this.faceStart[f + 1] - this.faceStart[f]; }
  /** 面 f の k 番目の頂点 */
  faceVert(f, k) { return this.faceVerts[this.faceStart[f] + k]; }

  /** 面の重心を out へ */
  faceCenter(f, out) {
    const s = this.faceStart[f], e = this.faceStart[f + 1];
    let x = 0, y = 0, z = 0;
    for (let i = s; i < e; i++) {
      const v = this.faceVerts[i] * 3;
      x += this.positions[v]; y += this.positions[v + 1]; z += this.positions[v + 2];
    }
    const inv = 1 / Math.max(1, e - s);
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
    return out;
  }

  /**
   * 面の法線（ニューウェルの式）。
   * 三角形の外積だと非平面な四角で頂点の選び方によって向きが変わるので、
   * 全部の辺を回す式を使う。
   */
  faceNormal(f, out) {
    const s = this.faceStart[f], e = this.faceStart[f + 1], n = e - s;
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < n; k++) {
      const a = this.faceVerts[s + k] * 3;
      const b = this.faceVerts[s + (k + 1) % n] * 3;
      const ax = this.positions[a], ay = this.positions[a + 1], az = this.positions[a + 2];
      const bx = this.positions[b], by = this.positions[b + 1], bz = this.positions[b + 2];
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }

  bounds() {
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let v = 0; v < this.nv; v++) {
      const i = v * 3;
      const x = this.positions[i], y = this.positions[i + 1], z = this.positions[i + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    if (!isFinite(mnx)) { mnx = mny = mnz = -1; mxx = mxy = mxz = 1; }
    const c = [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];
    return { min: [mnx, mny, mnz], max: [mxx, mxy, mxz], center: c,
      radius: Math.max(mxx - mnx, mxy - mny, mxz - mnz) * 0.5 || 1 };
  }

  /** 面の内訳（三角 / 四角 / それ以上） */
  faceStats() {
    let tri = 0, quad = 0, ngon = 0;
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f]) continue;
      const n = this.faceSize(f);
      if (n === 3) tri++; else if (n === 4) quad++; else ngon++;
    }
    const live = tri + quad + ngon;
    return { tri, quad, ngon, faces: live, quadRatio: live ? quad / live : 0 };
  }

  // --- 選択 ---------------------------------------------------------------

  clearSelection() {
    this.selVert.fill(0); this.selEdge.fill(0); this.selFace.fill(0);
  }

  selectAll(mode) {
    this.clearSelection();
    if (mode === 'vert') this.selVert.fill(1);
    else if (mode === 'edge') this.selEdge.fill(1);
    else for (let f = 0; f < this.nf; f++) this.selFace[f] = this.faceAlive[f] ? 1 : 0;
    this.syncSelection(mode);
  }

  invertSelection(mode) {
    const a = mode === 'vert' ? this.selVert : (mode === 'edge' ? this.selEdge : this.selFace);
    for (let i = 0; i < a.length; i++) a[i] = a[i] ? 0 : 1;
    if (mode === 'face') for (let f = 0; f < this.nf; f++) if (!this.faceAlive[f]) this.selFace[f] = 0;
    this.syncSelection(mode);
  }

  /**
   * 選択モードの主体から、他の 2 つを導出する。
   *
   * Blender と同じ規則:
   *   頂点 → 辺は両端が選択されているもの、面は全頂点が選択されているもの
   *   辺 → 頂点は端点、面は全辺が選択されているもの
   *   面 → 頂点と辺は面に属するもの全部
   * こうしておくと、モードを切り替えても選択が自然に引き継がれる。
   */
  syncSelection(mode) {
    if (mode === 'face') {
      this.selVert.fill(0); this.selEdge.fill(0);
      for (let f = 0; f < this.nf; f++) {
        if (!this.faceAlive[f] || !this.selFace[f]) continue;
        for (let i = this.faceStart[f]; i < this.faceStart[f + 1]; i++) this.selVert[this.faceVerts[i]] = 1;
      }
      for (let e = 0; e < this.ne; e++) {
        const f0 = this.edgeFace[e * 2], f1 = this.edgeFace[e * 2 + 1];
        this.selEdge[e] = ((f0 >= 0 && this.selFace[f0]) || (f1 >= 0 && this.selFace[f1])) ? 1 : 0;
      }
      return;
    }
    if (mode === 'edge') {
      this.selVert.fill(0);
      for (let e = 0; e < this.ne; e++) {
        if (!this.selEdge[e]) continue;
        this.selVert[this.edgeA[e]] = 1; this.selVert[this.edgeB[e]] = 1;
      }
    } else {
      // vert モード: 両端が選択されている辺を選択にする
      for (let e = 0; e < this.ne; e++) {
        this.selEdge[e] = (this.selVert[this.edgeA[e]] && this.selVert[this.edgeB[e]]) ? 1 : 0;
      }
    }
    // 面は「全部の頂点が選択されている」もの
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f]) { this.selFace[f] = 0; continue; }
      let all = 1;
      for (let i = this.faceStart[f]; i < this.faceStart[f + 1]; i++) {
        if (!this.selVert[this.faceVerts[i]]) { all = 0; break; }
      }
      this.selFace[f] = all;
    }
  }

  /** 選択されている数 */
  selectionCount() {
    let v = 0, e = 0, f = 0;
    for (let i = 0; i < this.nv; i++) if (this.selVert[i]) v++;
    for (let i = 0; i < this.ne; i++) if (this.selEdge[i]) e++;
    for (let i = 0; i < this.nf; i++) if (this.selFace[i] && this.faceAlive[i]) f++;
    return { verts: v, edges: e, faces: f };
  }

  /** 選択を 1-ring ぶん広げる */
  growSelection(mode) {
    const add = new Uint8Array(this.nv);
    for (let e = 0; e < this.ne; e++) {
      const a = this.edgeA[e], b = this.edgeB[e];
      if (this.selVert[a]) add[b] = 1;
      if (this.selVert[b]) add[a] = 1;
    }
    for (let v = 0; v < this.nv; v++) if (add[v]) this.selVert[v] = 1;
    this.syncSelection('vert');
    if (mode !== 'vert') this.syncSelection(mode === 'face' ? 'face' : 'edge');
  }

  /** 選択を 1-ring ぶん縮める（境界の頂点を外す） */
  shrinkSelection(mode) {
    const drop = new Uint8Array(this.nv);
    for (let e = 0; e < this.ne; e++) {
      const a = this.edgeA[e], b = this.edgeB[e];
      if (this.selVert[a] !== this.selVert[b]) {
        if (this.selVert[a]) drop[a] = 1; else drop[b] = 1;
      }
    }
    for (let v = 0; v < this.nv; v++) if (drop[v]) this.selVert[v] = 0;
    this.syncSelection('vert');
    if (mode !== 'vert') this.syncSelection(mode === 'face' ? 'face' : 'edge');
  }

  /** 選択に繋がっている塊を全部選ぶ（Blender の Select Linked） */
  selectLinked() {
    const stack = [];
    for (let v = 0; v < this.nv; v++) if (this.selVert[v]) stack.push(v);
    const seen = this.selVert;
    while (stack.length) {
      const v = stack.pop();
      for (let i = this.vEdgeStart[v]; i < this.vEdgeStart[v + 1]; i++) {
        const e = this.vEdge[i];
        const w = this.edgeA[e] === v ? this.edgeB[e] : this.edgeA[e];
        if (!seen[w]) { seen[w] = 1; stack.push(w); }
      }
    }
    this.syncSelection('vert');
  }

  // --- 編集 ---------------------------------------------------------------

  /**
   * 選択した面を削除する。使われなくなった頂点も落として詰める。
   * @returns {{faces: number, verts: number}} 消えた数
   */
  deleteSelectedFaces() {
    let removed = 0;
    for (let f = 0; f < this.nf; f++) {
      if (this.faceAlive[f] && this.selFace[f]) { this.faceAlive[f] = 0; removed++; }
    }
    if (removed === 0) return { faces: 0, verts: 0 };
    const before = this.nv;
    this.compact();
    this.clearSelection();
    this.version++; this.topoVersion++;
    return { faces: removed, verts: before - this.nv };
  }

  /**
   * 選択した辺を溶解する（両側の 2 面を 1 面にまとめる）。Blender の Dissolve Edges。
   * 四角 2 枚を溶かすと六角形になる。
   * @returns {{edges: number, refused: number}}
   */
  dissolveSelectedEdges() {
    let done = 0, refused = 0;
    // 溶解は面を作り替えるので、1 本ずつ処理して都度 rebuild する。
    // 選択された辺を一気に処理すると、隣の辺の面番号が変わって壊れる。
    for (let pass = 0; pass < 4096; pass++) {
      let target = -1;
      for (let e = 0; e < this.ne; e++) {
        if (!this.selEdge[e]) continue;
        const f0 = this.edgeFace[e * 2], f1 = this.edgeFace[e * 2 + 1];
        if (f0 < 0 || f1 < 0 || f0 === f1) continue;       // 境界 / 同じ面の中
        target = e; break;
      }
      if (target < 0) break;
      if (this._dissolveEdge(target)) done++; else refused++;
      // 溶解した辺の選択を外す（同じ辺を延々と選ばないように）
      this.rebuild();
    }
    for (let e = 0; e < this.ne; e++) if (this.selEdge[e]) refused++;
    if (done) { this.clearSelection(); this.version++; this.topoVersion++; }
    return { edges: done, refused };
  }

  /**
   * 辺 e を挟む 2 面を 1 面にまとめる。
   *
   * 両方の面の頂点ループを、共有辺のところで繋ぎ直す。頂点ループの向きが
   * 揃っている（= 共有辺を逆向きに通る）ことが前提。揃っていない場合は
   * 繋ぐと自己交差した面になるので断る。
   */
  _dissolveEdge(e) {
    const f0 = this.edgeFace[e * 2], f1 = this.edgeFace[e * 2 + 1];
    if (f0 < 0 || f1 < 0 || f0 === f1) return false;
    const a = this.edgeA[e], b = this.edgeB[e];
    const loop = (f) => {
      const s = this.faceStart[f], n = this.faceStart[f + 1] - s;
      const out = new Array(n);
      for (let k = 0; k < n; k++) out[k] = this.faceVerts[s + k];
      return out;
    };
    const L0 = loop(f0), L1 = loop(f1);
    // 各ループで a→b を通る位置を探す
    const findEdge = (L, u, v) => {
      for (let k = 0; k < L.length; k++) if (L[k] === u && L[(k + 1) % L.length] === v) return k;
      return -1;
    };
    let i0 = findEdge(L0, a, b), i1 = findEdge(L1, b, a);
    if (i0 < 0 || i1 < 0) {
      // 向きが逆のパターン
      i0 = findEdge(L0, b, a); i1 = findEdge(L1, a, b);
      if (i0 < 0 || i1 < 0) return false;      // 向きが揃っていない
    }
    // f0 を i0 の次から 1 周、f1 を i1 の次から 1 周繋ぐ（共有辺は 1 回だけ）
    const merged = [];
    for (let k = 1; k < L0.length; k++) merged.push(L0[(i0 + k) % L0.length]);
    for (let k = 1; k < L1.length; k++) merged.push(L1[(i1 + k) % L1.length]);
    if (merged.length < 3) return false;
    // 同じ頂点が 2 回出てきたら自己交差した面になるので断る
    const seen = new Set();
    for (const v of merged) { if (seen.has(v)) return false; seen.add(v); }
    this._replaceFaces([f0, f1], [merged]);
    return true;
  }

  /**
   * 面を差し替える。del の面を消して add の面を足し、CSR を組み直す。
   * 面番号は変わるので、呼んだ側は保持していた面番号を捨てること。
   */
  _replaceFaces(del, add) {
    const kill = new Set(del);
    const starts = [0];
    const verts = [];
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f] || kill.has(f)) continue;
      for (let i = this.faceStart[f]; i < this.faceStart[f + 1]; i++) verts.push(this.faceVerts[i]);
      starts.push(verts.length);
    }
    for (const loop of add) {
      for (const v of loop) verts.push(v);
      starts.push(verts.length);
    }
    this.nf = starts.length - 1;
    this.faceStart = Int32Array.from(starts);
    this.faceVerts = Int32Array.from(verts);
    this.faceAlive = new Uint8Array(this.nf).fill(1);
    this.selFace = new Uint8Array(this.nf);
  }

  /** 選択した面の向きを反転する */
  flipSelectedFaces() {
    let n = 0;
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f] || !this.selFace[f]) continue;
      const s = this.faceStart[f], e = this.faceStart[f + 1];
      for (let i = s, j = e - 1; i < j; i++, j--) {
        const t = this.faceVerts[i]; this.faceVerts[i] = this.faceVerts[j]; this.faceVerts[j] = t;
      }
      n++;
    }
    if (n) { this.rebuild(); this.version++; this.topoVersion++; }
    return n;
  }

  /** 死んだ面を落として、使われていない頂点を詰める */
  compact() {
    const used = new Uint8Array(this.nv);
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f]) continue;
      for (let i = this.faceStart[f]; i < this.faceStart[f + 1]; i++) used[this.faceVerts[i]] = 1;
    }
    const remap = new Int32Array(this.nv).fill(-1);
    let w = 0;
    for (let v = 0; v < this.nv; v++) if (used[v]) remap[v] = w++;
    const P = new Float32Array(w * 3);
    const sel = new Uint8Array(w);
    for (let v = 0; v < this.nv; v++) {
      const r = remap[v];
      if (r < 0) continue;
      P[r * 3] = this.positions[v * 3];
      P[r * 3 + 1] = this.positions[v * 3 + 1];
      P[r * 3 + 2] = this.positions[v * 3 + 2];
      sel[r] = this.selVert[v];
    }
    const starts = [0], verts = [];
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f]) continue;
      for (let i = this.faceStart[f]; i < this.faceStart[f + 1]; i++) verts.push(remap[this.faceVerts[i]]);
      starts.push(verts.length);
    }
    this.nv = w;
    this.positions = P;
    this.selVert = sel;
    this.nf = starts.length - 1;
    this.faceStart = Int32Array.from(starts);
    this.faceVerts = Int32Array.from(verts);
    this.faceAlive = new Uint8Array(this.nf).fill(1);
    this.selFace = new Uint8Array(this.nf);
    this.rebuild();
  }

  /** 検証（テストと診断用）。壊れている点を文字列で返す */
  validate() {
    const errs = [];
    if (this.faceStart.length !== this.nf + 1) errs.push('faceStart の長さが面数と合わない');
    for (let f = 0; f < this.nf; f++) {
      if (!this.faceAlive[f]) continue;
      const n = this.faceSize(f);
      if (n < 3) { errs.push(`面 ${f} の頂点が ${n} 個`); continue; }
      const seen = new Set();
      for (let i = this.faceStart[f]; i < this.faceStart[f + 1]; i++) {
        const v = this.faceVerts[i];
        if (v < 0 || v >= this.nv) { errs.push(`面 ${f} が範囲外の頂点 ${v} を指している`); break; }
        if (seen.has(v)) { errs.push(`面 ${f} に頂点 ${v} が 2 回出ている`); break; }
        seen.add(v);
      }
    }
    for (let e = 0; e < this.ne; e++) {
      if (this.edgeFace[e * 2] < 0) errs.push(`辺 ${e} に面が付いていない`);
    }
    for (let i = 0; i < this.positions.length; i++) {
      if (!isFinite(this.positions[i])) { errs.push('座標に NaN / Inf がある'); break; }
    }
    return errs;
  }
}

// ---------------------------------------------------------------------------
// 彫刻メッシュとの相互変換
// ---------------------------------------------------------------------------

/**
 * 彫刻メッシュ（三角形）から編集メッシュを作る。
 *
 * 三角形をそのまま面にすると四角のループが無く、ループカットもエッジループ選択も
 * 意味を持たない。そこで **quadDominant で隣り合う三角形を対にして四角にする**
 * （書き出し用に既にある貪欲アルゴリズム。「平坦さ × 角の直角度」で採点する）。
 * 対にできなかった三角形は三角形のまま残る。
 *
 * @param {SculptMesh} mesh
 * @param {(m: SculptMesh) => object} quadFn remesh.quadDominant を渡す
 *   （editmesh.js から remesh.js を import すると依存が太くなるので、外から渡す）
 */
export function editMeshFromSculpt(mesh, quadFn) {
  const q = quadFn(mesh);
  // 生きている頂点だけに詰め直す
  const remap = new Int32Array(mesh.nv).fill(-1);
  let nv = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) remap[v] = nv++;
  const P = new Float32Array(nv * 3);
  for (let v = 0; v < mesh.nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    P[r * 3] = mesh.positions[v * 3];
    P[r * 3 + 1] = mesh.positions[v * 3 + 1];
    P[r * 3 + 2] = mesh.positions[v * 3 + 2];
  }
  const starts = [0], verts = [];
  for (let f = 0; f + 1 < q.offsets.length; f++) {
    const s = q.offsets[f], e = q.offsets[f + 1];
    let bad = false;
    for (let i = s; i < e; i++) if (remap[q.faces[i]] < 0) { bad = true; break; }
    if (bad) continue;
    for (let i = s; i < e; i++) verts.push(remap[q.faces[i]]);
    starts.push(verts.length);
  }
  const em = new EditMesh();
  em.setGeometry(P, Int32Array.from(verts), Int32Array.from(starts));
  return em;
}

/**
 * 面を三角形に分ける（扇状）。凸でない n-gon は扇では正しく割れないが、
 * 四角優勢の編集メッシュではほぼ四角なので実用上問題にならない。
 * @returns {{positions: Float32Array, indices: Uint32Array}}
 */
export function triangulate(em) {
  let nt = 0;
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f]) nt += Math.max(0, em.faceSize(f) - 2);
  const idx = new Uint32Array(nt * 3);
  let w = 0;
  for (let f = 0; f < em.nf; f++) {
    if (!em.faceAlive[f]) continue;
    const s = em.faceStart[f], n = em.faceSize(f);
    for (let k = 1; k + 1 < n; k++) {
      idx[w++] = em.faceVerts[s];
      idx[w++] = em.faceVerts[s + k];
      idx[w++] = em.faceVerts[s + k + 1];
    }
  }
  return { positions: em.positions, indices: idx.subarray(0, w) };
}

/** 編集メッシュを彫刻メッシュへ書き戻す（三角形化して setGeometry） */
export function editMeshToSculpt(em, mesh) {
  const g = triangulate(em);
  mesh.setGeometry(g.positions, g.indices);
  return { verts: em.nv, tris: g.indices.length / 3 };
}

// ---------------------------------------------------------------------------
// 選択のための当たり判定
//
// レンダラのピッキングは「カーソル下の表面のワールド座標」を返す。そこから
// 一番近い頂点 / 辺 / 面を探す。加速構造は持たない: 選択はクリック 1 回に対して
// 1 度だけなので、100 万頂点の総当たりでも 10ms 程度で済む。
// ---------------------------------------------------------------------------

/** 点 p に最も近い頂点。範囲外なら -1 */
export function pickVert(em, p, maxDist) {
  let best = maxDist * maxDist, bi = -1;
  const P = em.positions;
  for (let v = 0; v < em.nv; v++) {
    const i = v * 3;
    const dx = P[i] - p[0], dy = P[i + 1] - p[1], dz = P[i + 2] - p[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; bi = v; }
  }
  return bi;
}

/** 点 p に最も近い辺（線分との距離）。範囲外なら -1 */
export function pickEdge(em, p, maxDist) {
  let best = maxDist * maxDist, bi = -1;
  const P = em.positions;
  for (let e = 0; e < em.ne; e++) {
    const a = em.edgeA[e] * 3, b = em.edgeB[e] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const ex = P[b] - ax, ey = P[b + 1] - ay, ez = P[b + 2] - az;
    const ll = ex * ex + ey * ey + ez * ez;
    let t = ll > 1e-20 ? ((p[0] - ax) * ex + (p[1] - ay) * ey + (p[2] - az) * ez) / ll : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const dx = ax + ex * t - p[0], dy = ay + ey * t - p[1], dz = az + ez * t - p[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; bi = e; }
  }
  return bi;
}

/** 点 p に最も近い面（重心との距離）。範囲外なら -1 */
export function pickFace(em, p, maxDist) {
  let best = maxDist * maxDist, bi = -1;
  const c = new Float64Array(3);
  for (let f = 0; f < em.nf; f++) {
    if (!em.faceAlive[f]) continue;
    em.faceCenter(f, c);
    const dx = c[0] - p[0], dy = c[1] - p[1], dz = c[2] - p[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; bi = f; }
  }
  return bi;
}

/**
 * カメラを向いている面（と、それに触っている頂点・辺）に印を付ける。
 *
 * 範囲選択で**裏側まで拾ってしまわない**ために使う。判定は面ごとの向きで、
 *   面   … その面がカメラを向いているか
 *   辺   … 両側のどちらかの面がカメラを向いているか
 *   頂点 … 触っている面のどれかがカメラを向いているか
 * とする。頂点の可視を「面の可視から」決めるのが大事で、頂点だけで見ると
 * 立方体の裏面の 4 頂点は横の面（こちら向き）にも触っているので可視に見えてしまい、
 * 裏面まで選ばれる。
 *
 * 他のパーツに隠れている場合（胴の裏の手など）はここでは弾けない。深度バッファを
 * 読み戻せば厳密にできるが、選択が 1 フレーム遅れる作りになるので採っていない。
 * 突き抜けて選びたいときは xray を立てる（Blender の X 線表示と同じ）。
 */
function frontFacing(em, eye) {
  const faceOk = new Uint8Array(em.nf);
  const vertOk = new Uint8Array(em.nv);
  const n = new Float64Array(3), c = new Float64Array(3);
  for (let f = 0; f < em.nf; f++) {
    if (!em.faceAlive[f]) continue;
    em.faceNormal(f, n);
    em.faceCenter(f, c);
    const d = (eye[0] - c[0]) * n[0] + (eye[1] - c[1]) * n[1] + (eye[2] - c[2]) * n[2];
    if (d <= 0) continue;
    faceOk[f] = 1;
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) vertOk[em.faceVerts[i]] = 1;
  }
  return { faceOk, vertOk };
}

/**
 * 画面上の領域に入るものを選ぶ（矩形と投げ縄の共通処理）。
 *
 * @param {(x,y,z) => [number,number,boolean]} project ワールド → 画面。
 *   3 つ目は「カメラの前にあるか」
 * @param {(x: number, y: number) => boolean} inRegion 画面座標が領域に入るか
 * @param {string} mode 'vert' | 'edge' | 'face'
 * @param {boolean} add true なら既存の選択に足す
 * @param {object} [opts] { eye, xray } eye を渡すと裏側を拾わない。xray で無効化
 */
function regionSelect(em, project, inRegion, mode, add = false, opts = null) {
  if (!add) em.clearSelection();
  const eye = opts && opts.eye && !(opts && opts.xray) ? opts.eye : null;
  const vis = eye ? frontFacing(em, eye) : null;
  const inside = new Uint8Array(em.nv);
  const P = em.positions;
  let hit = 0;
  for (let v = 0; v < em.nv; v++) {
    const i = v * 3;
    const s = project(P[i], P[i + 1], P[i + 2]);
    if (!s[2]) continue;
    if (!inRegion(s[0], s[1])) continue;
    inside[v] = 1; hit++;
  }
  if (mode === 'vert') {
    for (let v = 0; v < em.nv; v++) {
      if (inside[v] && (!vis || vis.vertOk[v])) em.selVert[v] = 1;
    }
    em.syncSelection('vert');
  } else if (mode === 'edge') {
    // 辺は両端が領域に入っているものだけ（Blender の既定と同じ）
    for (let e = 0; e < em.ne; e++) {
      if (!inside[em.edgeA[e]] || !inside[em.edgeB[e]]) continue;
      if (vis) {
        const f0 = em.edgeFace[e * 2], f1 = em.edgeFace[e * 2 + 1];
        const ok = (f0 >= 0 && vis.faceOk[f0]) || (f1 >= 0 && vis.faceOk[f1]);
        if (!ok) continue;
      }
      em.selEdge[e] = 1;
    }
    em.syncSelection('edge');
  } else {
    for (let f = 0; f < em.nf; f++) {
      if (!em.faceAlive[f]) continue;
      if (vis && !vis.faceOk[f]) continue;
      let all = 1;
      for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
        if (!inside[em.faceVerts[i]]) { all = 0; break; }
      }
      if (all) em.selFace[f] = 1;
    }
    em.syncSelection('face');
  }
  return { candidates: hit, ...em.selectionCount() };
}

/**
 * 画面上の矩形に入るものを選ぶ（ボックス選択）。
 * @param {object} rect {x0, y0, x1, y1}
 */
export function boxSelect(em, project, rect, mode, add = false, opts = null) {
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  const inRect = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  return regionSelect(em, project, inRect, mode, add, opts);
}

/**
 * 画面上の自由な囲みに入るものを選ぶ（投げ縄選択）。
 *
 * 判定は交差数（点から右へ伸ばした半直線が辺を何回横切るか）。囲みは閉じている
 * ものとして扱う（最後の点と最初の点を繋ぐ）ので、輪を閉じ切らなくても効く。
 *
 * @param {Array<number>} pts 画面座標を x, y の順に並べたもの
 */
export function lassoSelect(em, project, pts, mode, add = false, opts = null) {
  const n = pts.length >> 1;
  if (n < 3) return { candidates: 0, ...em.selectionCount() };
  // まず外接矩形で粗く弾く（交差数の計算は点数に比例するので、外は先に落とす）
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
  }
  const inLasso = (x, y) => {
    if (x < bx0 || x > bx1 || y < by0 || y > by1) return false;
    let cross = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[i * 2], yi = pts[i * 2 + 1];
      const xj = pts[j * 2], yj = pts[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) cross = !cross;
    }
    return cross;
  };
  return regionSelect(em, project, inLasso, mode, add, opts);
}
