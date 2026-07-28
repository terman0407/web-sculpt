// ---------------------------------------------------------------------------
// transpose.js
// トランスポーズ（ZBrush の Transpose / Gizmo 3D 相当）。
// マスクされていない領域を移動 / 回転 / スケールする。
//
// 設計上のポイント:
//  * 入力はワールド空間のレイだけを受け取る。画面座標 → レイの変換はカメラを
//    持っている呼び出し側の仕事で、ここに view/proj を持ち込むと幾何モジュールが
//    描画側に依存してしまう。ヒットの許容距離も「画面 n px をワールドに換算した値」を
//    呼び出し側が計算して渡す。
//  * ドラッグは常に「開始時の位置からの絶対変換」として適用する。フレームごとの
//    相対適用にすると、往復させただけで誤差が溜まって形が痩せる。そのために
//    beginDrag で領域の座標を丸ごと控える（cancelDrag のビット完全な復元も
//    これで手に入る）。
//  * 領域は「weight = 1 - mask > 0 の頂点」。mask 1 の頂点は領域に入らないので
//    1 ビットも書き換えられない（ブラシと同じ規約）。
//  * 頂点数は数百万になりうるので、領域は Int32Array + カウンタで持ち、
//    ドラッグ 1 フレームの計算は O(領域頂点数) の 1 ループに収める。
// ---------------------------------------------------------------------------

import { clamp } from './math.js';
import { RING_STRIDE, DIRTY_SHIFT } from './mesh.js';

// X/Y/Z の色は他の 3D ツールの慣習に合わせる（呼び出し側がそのまま線色に使う）
const AXIS_COLOR = [[0.94, 0.29, 0.31], [0.44, 0.82, 0.27], [0.31, 0.53, 0.97]];
const CENTER_COLOR = [0.87, 0.88, 0.92];

const RING_SEGS = 48;        // 回転リングの描画分割数
const HIT_RING_SEGS = 32;    // ヒットテスト用の分割数。弦と弧のずれは半径の 0.5% で
                             // 許容距離よりずっと小さいので描画より粗くてよい
const HEAD_LEN = 0.14;       // 矢印の先端長 / 軸長
const HEAD_RAD = 0.045;
const PLANE_OFF = 0.42;      // 平面ハンドルの中心位置 / 軸長
const PLANE_HALF = 0.09;
const CENTER_HALF = 0.06;

// スナップ幅。角度と倍率は絶対値で決まるが、移動だけは世界の寸法が分からないので
// ハンドル長（= 呼び出し側が決めたギズモの大きさ）に対する比で決める。
const SNAP_ANGLE = Math.PI / 12;   // 15 度
const SNAP_FACTOR = 0.1;
const SNAP_MOVE_FRAC = 0.1;

const EPS_DIR = 1e-7;
const MIN_FACTOR = 0.01;     // これ以下に縮めない（負に通すと面が裏返る）
const MAX_FACTOR = 100;

// 四角ハンドルの角と立方体の辺。毎フレーム作らないようモジュール定数にしてある
const QUAD_U = [1, 1, -1, -1];
const QUAD_V = [1, -1, -1, 1];
const BOX_EDGES = [0, 1, 0, 2, 0, 4, 1, 3, 1, 5, 2, 3, 2, 6, 3, 7, 4, 5, 4, 6, 5, 7, 6, 7];

function growI32(src, n) {
  const a = new Int32Array(Math.max(1024, n, src.length * 2));
  a.set(src);
  return a;
}

/** レイ（原点 o・単位方向 d・t >= 0）と線分 [a,b] の最短距離の 2 乗 */
function raySegDist2(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const wx = ax - ox, wy = ay - oy, wz = az - oz;
  const uu = ux * ux + uy * uy + uz * uz;
  const ud = ux * dx + uy * dy + uz * dz;
  const uw = ux * wx + uy * wy + uz * wz;
  const dw = dx * wx + dy * wy + dz * wz;
  // s: 線分上の位置 0..1 / t: レイ上の位置 >= 0
  const den = uu - ud * ud;
  let s;
  if (den < 1e-12 * (uu + 1)) s = 0;                    // ほぼ平行
  else s = (ud * dw - uw) / den;
  if (s < 0) s = 0; else if (s > 1) s = 1;
  let t = dw + s * ud;
  if (t < 0) t = 0;
  const cx = ax + ux * s - (ox + dx * t);
  const cy = ay + uy * s - (oy + dy * t);
  const cz = az + uz * s - (oz + dz * t);
  return cx * cx + cy * cy + cz * cz;
}

/** レイと点の最短距離の 2 乗 */
function rayPointDist2(ox, oy, oz, dx, dy, dz, px, py, pz) {
  const wx = px - ox, wy = py - oy, wz = pz - oz;
  let t = wx * dx + wy * dy + wz * dz;
  if (t < 0) t = 0;
  const cx = wx - dx * t, cy = wy - dy * t, cz = wz - dz * t;
  return cx * cx + cy * cy + cz * cz;
}

/**
 * 3x3 対称行列のヤコビ回転による固有値分解。
 * a は破壊的に書き換える。固有ベクトル j は V の列（V[0*3+j], V[3+j], V[6+j]）。
 * 3x3 なので反復は数回で収束し、特性方程式の解析解より桁落ちに強い。
 */
function jacobiEigen3(a, V, w) {
  V[0] = 1; V[1] = 0; V[2] = 0;
  V[3] = 0; V[4] = 1; V[5] = 0;
  V[6] = 0; V[7] = 0; V[8] = 1;
  for (let sweep = 0; sweep < 16; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-18) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p * 3 + q];
        if (Math.abs(apq) < 1e-20) continue;
        const app = a[p * 3 + p], aqq = a[q * 3 + q];
        const theta = (aqq - app) / (2 * apq);
        // theta = 0（対角が等しい）ときは 45 度回転になるよう符号 +1 を選ぶ
        const sg = theta >= 0 ? 1 : -1;
        const t = sg / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        a[p * 3 + p] = app - t * apq;
        a[q * 3 + q] = aqq + t * apq;
        a[p * 3 + q] = 0; a[q * 3 + p] = 0;
        for (let r = 0; r < 3; r++) {
          if (r === p || r === q) continue;
          const arp = a[r * 3 + p], arq = a[r * 3 + q];
          a[r * 3 + p] = c * arp - s * arq; a[p * 3 + r] = a[r * 3 + p];
          a[r * 3 + q] = s * arp + c * arq; a[q * 3 + r] = a[r * 3 + q];
        }
        for (let r = 0; r < 3; r++) {
          const vrp = V[r * 3 + p], vrq = V[r * 3 + q];
          V[r * 3 + p] = c * vrp - s * vrq;
          V[r * 3 + q] = s * vrp + c * vrq;
        }
      }
    }
  }
  w[0] = a[0]; w[1] = a[4]; w[2] = a[8];
}

const EMPTY_HANDLES = [];

function makeHandleStore() {
  const list = [];
  // 矢印 = 軸 1 本 + 先端 4 本 + 先端の底リング 4 本 = 9 線分
  for (let i = 0; i < 3; i++) {
    list.push({ kind: 'move', axis: i, points: new Float32Array(9 * 6), color: AXIS_COLOR[i] });
  }
  for (let i = 0; i < 3; i++) {
    list.push({ kind: 'scale', axis: i, points: new Float32Array(4 * 6), color: AXIS_COLOR[i] });
  }
  for (let i = 0; i < 3; i++) {
    list.push({ kind: 'rotate', axis: i, points: new Float32Array(RING_SEGS * 6), color: AXIS_COLOR[i] });
  }
  list.push({ kind: 'uniform', axis: -1, points: new Float32Array(12 * 6), color: CENTER_COLOR });
  return list;
}

// ---------------------------------------------------------------------------

export class Transpose {
  constructor() {
    this._active = false;
    this._pivot = new Float32Array(3);
    // 軸 i の単位ベクトルは _basis[i * 3 .. i * 3 + 2]（3 本の行として持つ）
    this._basis = new Float32Array(9);
    this._identityBasis();

    this._verts = new Int32Array(0);      // 領域頂点（weight > 0）
    this._weights = new Float32Array(0);  // 1 - mask
    this._count = 0;
    this._wsum = 0;
    // 領域は頂点インデックスの配列なので、外でトポロジが変わったら意味を失う。
    // SubdivLevels.validate と同じ流儀で topoVersion を控えて突き合わせる。
    this._guard = -1;
    this._orig = new Float32Array(0);     // ドラッグ開始時の座標（絶対変換の基準）
    this._nset = new Int32Array(0);       // 法線を直す頂点（領域 + その 1-ring）
    this._nsetCount = 0;
    this._stamp = new Int32Array(0);
    this._stampId = 0;

    this._handles = null;
    this._lastScale = 1;
    this._ringScratch = new Float64Array(12);   // 矢印の先端リング（毎フレーム使い回す）

    // --- ドラッグ状態 ---------------------------------------------------
    this._kind = null;
    this._axis = -1;
    this._dragPivot = new Float32Array(3);   // 開始時のピボット（変換の中心）
    this._dragBasis = new Float32Array(9);   // 開始時の基底（変換の軸）
    this._planeN = new Float32Array(3);      // uniform の参照平面法線（視線で固定）
    this._refDir = new Float32Array(3);      // uniform の参照方向（符号付き半径用）
    this._planeScratch = new Float64Array(3);
    this._s0 = 0;         // move: 軸上の開始位置
    this._sCur = 0;       // move: 直近の軸上位置（退化フレームで前値を保つ）
    this._angPrev = 0;    // rotate: 直近の生の角度
    this._angAcc = 0;     // rotate: 累積角（1 回転を超えても連続する）
    this._r0 = 0;         // scale: 開始半径
    this._u0 = 0; this._v0 = 0;  // scale: 平面内の開始方向（符号付き半径用）
    this._factor = 1;
    this._refOk = false;  // 基準量が取れているか（退化した掴み方だと取れない）
    this._lastChanged = 0;
    this._touched = false;
    this._normalsStale = false;

    this._D = new Float64Array(9);   // 変換 A から単位行列を引いたもの（後述）
    this._result = { changed: 0, kind: null, axis: -1, offset: 0, degrees: 0, factor: 1 };
  }

  _identityBasis() {
    const B = this._basis;
    B[0] = 1; B[1] = 0; B[2] = 0;
    B[3] = 0; B[4] = 1; B[5] = 0;
    B[6] = 0; B[7] = 0; B[8] = 1;
  }

  get active() { return this._active; }

  /**
   * 内部の配列も解放する（トランスポーズモードを抜けるとき）。
   * ドラッグ中なら先に endDrag / cancelDrag を呼ぶこと。mesh を受け取らないので
   * mods.normals = false で後回しにした法線をここでは清算できない。
   */
  clear() {
    this._active = false;
    this._kind = null;
    this._axis = -1;
    this._count = 0;
    this._wsum = 0;
    this._guard = -1;
    this._verts = new Int32Array(0);
    this._weights = new Float32Array(0);
    this._orig = new Float32Array(0);
    this._nset = new Int32Array(0);
    this._nsetCount = 0;
    // stamp は capV ぶん（数百万頂点で 12MB）あるので一緒に返す。
    // _stampId は増やしたままにしておけば、次に確保したゼロ埋め配列と衝突しない。
    this._stamp = new Int32Array(0);
    this._lastChanged = 0;
    this._touched = false;
    this._normalsStale = false;
    this._pivot[0] = 0; this._pivot[1] = 0; this._pivot[2] = 0;
    this._identityBasis();
  }

  /** ピボット（ワールド）。ドラッグ中の移動もここに反映される */
  pivot() { return [this._pivot[0], this._pivot[1], this._pivot[2]]; }

  /**
   * 基底。軸 i は [i * 3 + 0..2]。毎フレーム呼ばれるので内部配列をそのまま返す
   * （書き換えないこと）。
   */
  basis() { return this._basis; }

  /** 領域の統計（UI 表示用） */
  stats() {
    return { active: this._active, verts: this._count, weightSum: this._wsum, dragging: this._kind };
  }

  /**
   * 領域がまだこのメッシュのものか確かめる。ダイナメッシュ / 細分化 / 分離のあとは
   * 同じ頂点番号が別の頂点を指すので、控えた領域で書き込むと無関係な場所が動く
   * （範囲外は黙って捨てられるので気付けない）。false が返ったら setFromMask を
   * やり直す。beginDrag も内部でこれを通す。
   * @returns {boolean} まだ使えるか
   */
  validate(mesh) {
    if (!this._active) return false;
    if (mesh.topoVersion === this._guard) return true;
    this.clear();
    return false;
  }

  // --- 領域とピボットの決定 ----------------------------------------------

  /**
   * マスクされていない領域からピボットと基底を決める。
   * マスクが真っ白（全部 0）なら領域はメッシュ全体になる（ZBrush と同じ）。
   *
   * @param {SculptMesh} mesh
   * @param {object} opts
   *   basis     : 'world'（既定）| 'pca'  領域の主成分をローカル軸にする
   *   threshold : これ以下の weight は領域に入れない（既定 1e-4）
   * @returns {boolean} 領域が空なら false
   */
  setFromMask(mesh, opts = {}) {
    // ドラッグ中に呼ばれたら、その変形は確定済みとして扱い状態だけ捨てる。
    // mods.normals = false で後回しにしていたぶんはここで清算しておく。以後
    // endDrag は来ないので、やらないと法線が永久に 1 フレーム前のままになる。
    if (this._normalsStale && mesh.topoVersion === this._guard) {
      mesh.computeNormalsFor(this._nset, this._nsetCount);
    }
    this._normalsStale = false;
    this._kind = null;
    this._touched = false;
    this._lastChanged = 0;
    const thr = opts.threshold !== undefined ? opts.threshold : 1e-4;
    const nv = mesh.nv;
    const M = mesh.mask, A = mesh.vAlive, P = mesh.positions;

    // 件数を数えてから 1 回で確保する（push を使わないため）
    let n = 0;
    for (let v = 0; v < nv; v++) {
      if (A[v] === 0) continue;
      const mk = M[v];
      if (1 - (mk < 0 ? 0 : (mk > 1 ? 1 : mk)) > thr) n++;
    }
    if (n === 0) { this.clear(); return false; }

    if (this._verts.length < n) {
      this._verts = new Int32Array(n);
      this._weights = new Float32Array(n);
    }
    const V = this._verts, W = this._weights;
    let k = 0;
    let cx = 0, cy = 0, cz = 0, wsum = 0;
    for (let v = 0; v < nv; v++) {
      if (A[v] === 0) continue;
      const mk = M[v];
      const w = 1 - (mk < 0 ? 0 : (mk > 1 ? 1 : mk));
      if (w <= thr) continue;
      V[k] = v; W[k] = w; k++;
      const i = v * 3;
      cx += P[i] * w; cy += P[i + 1] * w; cz += P[i + 2] * w;
      wsum += w;
    }
    this._count = k;
    this._wsum = wsum;
    if (wsum <= 0) { this.clear(); return false; }

    // ピボットは加重重心。マスクのグラデーションがそのまま「引っぱりの中心」に
    // 効くので、部分マスクでも直感どおりの位置になる。
    const inv = 1 / wsum;
    this._pivot[0] = cx * inv; this._pivot[1] = cy * inv; this._pivot[2] = cz * inv;

    if (opts.basis === 'pca') this._basisFromPCA(mesh);
    else this._identityBasis();

    this._guard = mesh.topoVersion;
    this._active = true;
    return true;
  }

  /**
   * 領域の主成分を基底にする（ZBrush の Gizmo のローカル軸相当）。
   * 共分散行列は 3x3 なのでヤコビ回転で十分。
   */
  _basisFromPCA(mesh) {
    const P = mesh.positions, V = this._verts, W = this._weights, n = this._count;
    const px = this._pivot[0], py = this._pivot[1], pz = this._pivot[2];
    let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
    for (let k = 0; k < n; k++) {
      const i = V[k] * 3, w = W[k];
      const dx = P[i] - px, dy = P[i + 1] - py, dz = P[i + 2] - pz;
      cxx += dx * dx * w; cyy += dy * dy * w; czz += dz * dz * w;
      cxy += dx * dy * w; cxz += dx * dz * w; cyz += dy * dz * w;
    }
    const inv = 1 / this._wsum;
    // 対角が全部ゼロ（1 点に縮退）なら主成分は定まらないのでワールド軸に落とす
    if ((cxx + cyy + czz) * inv < 1e-20) { this._identityBasis(); return; }
    const a = new Float64Array(9);
    a[0] = cxx * inv; a[4] = cyy * inv; a[8] = czz * inv;
    a[1] = a[3] = cxy * inv;
    a[2] = a[6] = cxz * inv;
    a[5] = a[7] = cyz * inv;
    const Vm = new Float64Array(9), ev = new Float64Array(3);
    jacobiEigen3(a, Vm, ev);

    // 固有値の降順に並べる（3 個なので添字を直接入れ替える）
    let i0 = 0, i1 = 1, i2 = 2;
    if (ev[i1] > ev[i0]) { const t = i0; i0 = i1; i1 = t; }
    if (ev[i2] > ev[i0]) { const t = i0; i0 = i2; i2 = t; }
    if (ev[i2] > ev[i1]) { const t = i1; i1 = i2; i2 = t; }

    const B = this._basis;
    // 固有ベクトルの符号は不定なので「絶対値最大の成分を正にする」で固定する。
    // そうしないと同じ形に対して setFromMask を呼び直すたびに軸が反転して、
    // ハンドルの向きがちらつく。
    this._putEigen(B, 0, Vm, i0);
    this._putEigen(B, 1, Vm, i1);
    // 2 本目を 1 本目に直交化（固有ベクトルは数値誤差で完全直交ではない）
    {
      const d = B[3] * B[0] + B[4] * B[1] + B[5] * B[2];
      B[3] -= B[0] * d; B[4] -= B[1] * d; B[5] -= B[2] * d;
      const l = Math.hypot(B[3], B[4], B[5]);
      if (l < 1e-9) { this._identityBasis(); return; }
      B[3] /= l; B[4] /= l; B[5] /= l;
    }
    // 3 本目は外積で作る。第 3 固有ベクトルをそのまま使うと符号固定のあとで
    // 左手系になることがあり、回転の向きが軸ごとに食い違う。
    B[6] = B[1] * B[5] - B[2] * B[4];
    B[7] = B[2] * B[3] - B[0] * B[5];
    B[8] = B[0] * B[4] - B[1] * B[3];
  }

  _putEigen(B, row, Vm, col) {
    let x = Vm[col], y = Vm[3 + col], z = Vm[6 + col];
    const l = Math.hypot(x, y, z);
    if (l < 1e-12) { x = row === 0 ? 1 : 0; y = row === 1 ? 1 : 0; z = row === 2 ? 1 : 0; }
    else { x /= l; y /= l; z /= l; }
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    const m = ax >= ay && ax >= az ? x : (ay >= az ? y : z);
    if (m < 0) { x = -x; y = -y; z = -z; }
    B[row * 3] = x; B[row * 3 + 1] = y; B[row * 3 + 2] = z;
  }

  // --- ハンドル形状 -------------------------------------------------------

  /**
   * ハンドルをワールド座標の線分リストとして返す。
   * points は 2 点ずつが 1 線分（line-list 用）で、要素数は常に 6 の倍数。
   * 回転リングも「円周上の点列」を線分に展開して返すので、呼び出し側は
   * 種類を区別せずそのまま線で描ける。
   *
   * 毎フレーム呼ばれるので配列は使い回す（返ってきた Float32Array を保持せず、
   * その場で GPU へ書くこと）。
   *
   * @param {number} scale ギズモの大きさ（ワールド）。矢印の全長 = リング半径
   */
  handles(scale = 1) {
    // 領域が無いときは空を返す。呼び出し側が active を見ずに描いても何も出ない
    if (!this._active) return EMPTY_HANDLES;
    if (!this._handles) this._handles = makeHandleStore();
    const H = this._handles;
    const L = scale > 0 ? scale : 1;
    this._lastScale = L;
    const B = this._basis;
    const px = this._pivot[0], py = this._pivot[1], pz = this._pivot[2];

    for (let i = 0; i < 3; i++) {
      const ax = B[i * 3], ay = B[i * 3 + 1], az = B[i * 3 + 2];
      const j = (i + 1) % 3, k = (i + 2) % 3;
      const ux = B[j * 3], uy = B[j * 3 + 1], uz = B[j * 3 + 2];
      const vx = B[k * 3], vy = B[k * 3 + 1], vz = B[k * 3 + 2];

      // --- 矢印 ---------------------------------------------------------
      {
        const p = H[i].points, rp = this._ringScratch;
        const bl = L * (1 - HEAD_LEN), hr = L * HEAD_RAD;
        const bx = px + ax * bl, by = py + ay * bl, bz = pz + az * bl;
        const tx = px + ax * L, ty = py + ay * L, tz = pz + az * L;
        p[0] = px; p[1] = py; p[2] = pz;
        p[3] = bx; p[4] = by; p[5] = bz;
        // 先端の底リング 4 点を (+u, +v, -u, -v) の順に作る
        for (let e = 0; e < 4; e++) {
          const su = e === 0 ? 1 : (e === 2 ? -1 : 0);
          const sv = e === 1 ? 1 : (e === 3 ? -1 : 0);
          const o = e * 3;
          rp[o] = bx + (ux * su + vx * sv) * hr;
          rp[o + 1] = by + (uy * su + vy * sv) * hr;
          rp[o + 2] = bz + (uz * su + vz * sv) * hr;
        }
        // 「先端 → 各点」と「隣り合う点どうし」で円錐の輪郭になる
        let o = 6;
        for (let e = 0; e < 4; e++) {
          const a0 = e * 3;
          p[o] = tx; p[o + 1] = ty; p[o + 2] = tz;
          p[o + 3] = rp[a0]; p[o + 4] = rp[a0 + 1]; p[o + 5] = rp[a0 + 2];
          o += 6;
        }
        for (let e = 0; e < 4; e++) {
          const a0 = e * 3, b0 = ((e + 1) & 3) * 3;
          p[o] = rp[a0]; p[o + 1] = rp[a0 + 1]; p[o + 2] = rp[a0 + 2];
          p[o + 3] = rp[b0]; p[o + 4] = rp[b0 + 1]; p[o + 5] = rp[b0 + 2];
          o += 6;
        }
      }

      // --- 平面スケールハンドル（法線が軸 i / 面内が軸 j,k）-------------
      {
        const p = H[3 + i].points;
        const off = L * PLANE_OFF, h = L * PLANE_HALF;
        const cx = px + (ux + vx) * off, cy = py + (uy + vy) * off, cz = pz + (uz + vz) * off;
        let o = 0;
        for (let e = 0; e < 4; e++) {
          const f = (e + 1) & 3;
          p[o] = cx + (ux * QUAD_U[e] + vx * QUAD_V[e]) * h;
          p[o + 1] = cy + (uy * QUAD_U[e] + vy * QUAD_V[e]) * h;
          p[o + 2] = cz + (uz * QUAD_U[e] + vz * QUAD_V[e]) * h;
          p[o + 3] = cx + (ux * QUAD_U[f] + vx * QUAD_V[f]) * h;
          p[o + 4] = cy + (uy * QUAD_U[f] + vy * QUAD_V[f]) * h;
          p[o + 5] = cz + (uz * QUAD_U[f] + vz * QUAD_V[f]) * h;
          o += 6;
        }
      }

      // --- 回転リング ---------------------------------------------------
      {
        const p = H[6 + i].points;
        const dth = (Math.PI * 2) / RING_SEGS;
        let o = 0, c0 = L, s0 = 0;
        for (let e = 0; e < RING_SEGS; e++) {
          const th = (e + 1) * dth;
          const c1 = Math.cos(th) * L, s1 = Math.sin(th) * L;
          p[o] = px + ux * c0 + vx * s0;
          p[o + 1] = py + uy * c0 + vy * s0;
          p[o + 2] = pz + uz * c0 + vz * s0;
          p[o + 3] = px + ux * c1 + vx * s1;
          p[o + 4] = py + uy * c1 + vy * s1;
          p[o + 5] = pz + uz * c1 + vz * s1;
          c0 = c1; s0 = s1;
          o += 6;
        }
      }
    }

    // --- 中心の箱（一様スケール）-----------------------------------------
    {
      const p = H[9].points;
      const h = L * CENTER_HALF;
      for (let e = 0; e < 24; e++) {
        const s = BOX_EDGES[e];
        const sx = (s & 1) ? 1 : -1, sy = (s & 2) ? 1 : -1, sz = (s & 4) ? 1 : -1;
        p[e * 3] = px + (B[0] * sx + B[3] * sy + B[6] * sz) * h;
        p[e * 3 + 1] = py + (B[1] * sx + B[4] * sy + B[7] * sz) * h;
        p[e * 3 + 2] = pz + (B[2] * sx + B[5] * sy + B[8] * sz) * h;
      }
    }
    return H;
  }

  // --- ヒットテスト -------------------------------------------------------

  /**
   * どのハンドルに当たったかを返す。
   *
   * @param {ArrayLike<number>} rayOrigin ワールド
   * @param {ArrayLike<number>} rayDir    ワールド（正規化していなくてよい）
   * @param {number} tol 画面上の許容距離をワールドに換算した値
   * @param {number} scale handles() に渡すのと同じギズモの大きさ
   * @returns {{kind: string, axis: number}|null}
   */
  hitTest(rayOrigin, rayDir, tol, scale = this._lastScale) {
    if (!this._active) return null;
    const L = scale > 0 ? scale : 1;
    this._lastScale = L;
    let dx = rayDir[0], dy = rayDir[1], dz = rayDir[2];
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-20) return null;
    dx /= dl; dy /= dl; dz /= dl;
    const ox = rayOrigin[0], oy = rayOrigin[1], oz = rayOrigin[2];
    const t = tol > 0 ? tol : L * 0.04;
    const B = this._basis;
    const px = this._pivot[0], py = this._pivot[1], pz = this._pivot[2];

    // 「距離 / そのハンドルの許容半径」が最小のものを選ぶ。許容半径がハンドルごとに
    // 違う（点ハンドルは自分の大きさぶん広い）ので、生の距離では比べられない。
    let best = 1, kind = null, axis = -1;

    // 中心は矢印の根元と重なる。先に見て厳密不等号で比べることで、
    // ど真ん中を掴んだら一様スケールになる（他ツールと同じ挙動）。
    {
      const r = t + L * CENTER_HALF;
      const s = Math.sqrt(rayPointDist2(ox, oy, oz, dx, dy, dz, px, py, pz)) / r;
      if (s < best) { best = s; kind = 'uniform'; axis = -1; }
    }
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3, k = (i + 2) % 3;
      const ux = B[j * 3], uy = B[j * 3 + 1], uz = B[j * 3 + 2];
      const vx = B[k * 3], vy = B[k * 3 + 1], vz = B[k * 3 + 2];
      const off = L * PLANE_OFF;
      const r = t + L * PLANE_HALF;
      const s = Math.sqrt(rayPointDist2(ox, oy, oz, dx, dy, dz,
        px + (ux + vx) * off, py + (uy + vy) * off, pz + (uz + vz) * off)) / r;
      if (s < best) { best = s; kind = 'scale'; axis = i; }
    }
    for (let i = 0; i < 3; i++) {
      const s = Math.sqrt(raySegDist2(ox, oy, oz, dx, dy, dz, px, py, pz,
        px + B[i * 3] * L, py + B[i * 3 + 1] * L, pz + B[i * 3 + 2] * L)) / t;
      if (s < best) { best = s; kind = 'move'; axis = i; }
    }
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3, k = (i + 2) % 3;
      const ux = B[j * 3], uy = B[j * 3 + 1], uz = B[j * 3 + 2];
      const vx = B[k * 3], vy = B[k * 3 + 1], vz = B[k * 3 + 2];
      const dth = (Math.PI * 2) / HIT_RING_SEGS;
      let d2 = Infinity, c0 = L, s0 = 0;
      for (let e = 0; e < HIT_RING_SEGS; e++) {
        const th = (e + 1) * dth;
        const c1 = Math.cos(th) * L, s1 = Math.sin(th) * L;
        const q = raySegDist2(ox, oy, oz, dx, dy, dz,
          px + ux * c0 + vx * s0, py + uy * c0 + vy * s0, pz + uz * c0 + vz * s0,
          px + ux * c1 + vx * s1, py + uy * c1 + vy * s1, pz + uz * c1 + vz * s1);
        if (q < d2) d2 = q;
        c0 = c1; s0 = s1;
      }
      const s = Math.sqrt(d2) / t;
      if (s < best) { best = s; kind = 'rotate'; axis = i; }
    }
    return kind === null ? null : { kind, axis };
  }

  // --- ドラッグ -----------------------------------------------------------

  /**
   * ドラッグ開始。領域の座標を控え、ハンドル種別ごとの基準量を求める。
   * 前回の setFromMask からトポロジが変わっていたら領域を捨てて false を返す
   * （validate 参照）。
   * @returns {boolean} 掴めたか
   */
  beginDrag(mesh, hit, rayOrigin, rayDir) {
    if (!this._active || !hit || this._count === 0) return false;
    if (!this.validate(mesh)) return false;
    const kind = hit.kind;
    if (kind !== 'move' && kind !== 'rotate' && kind !== 'scale' && kind !== 'uniform') return false;
    let dx = rayDir[0], dy = rayDir[1], dz = rayDir[2];
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-20) return false;
    dx /= dl; dy /= dl; dz /= dl;

    // 開始時の座標を控える。これがあるので毎フレーム「元位置からの絶対変換」で
    // 書けて、cancelDrag もビット単位で元へ戻せる（f32 → f32 のコピーは無損失）。
    const n = this._count;
    if (this._orig.length < n * 3) this._orig = new Float32Array(n * 3);
    const P = mesh.positions, V = this._verts, O = this._orig;
    for (let k = 0; k < n; k++) {
      const i = V[k] * 3, o = k * 3;
      O[o] = P[i]; O[o + 1] = P[i + 1]; O[o + 2] = P[i + 2];
    }
    // トポロジはドラッグ中に変わらないので、法線を直す集合は 1 回だけ作る
    this._buildNormalSet(mesh);

    this._kind = kind;
    this._axis = kind === 'uniform' ? -1 : (hit.axis | 0);
    this._dragPivot.set(this._pivot);
    this._dragBasis.set(this._basis);
    this._factor = 1;
    this._angAcc = 0;
    this._lastChanged = 0;
    this._touched = false;
    this._normalsStale = false;
    this._refOk = false;

    const B = this._dragBasis;
    const i3 = this._axis * 3;
    const ox = rayOrigin[0], oy = rayOrigin[1], oz = rayOrigin[2];
    if (kind === 'move') {
      // 視線が軸と重なっていると軸上の位置が決まらない。そこで 0 を基準にすると
      // 最初の有効フレームで形が飛ぶので、回転と同じく「最初に取れたフレーム」を
      // 基準にする（取れるまでは変位ゼロ）。
      const s = this._axisParam(ox, oy, oz, dx, dy, dz, B[i3], B[i3 + 1], B[i3 + 2], NaN);
      this._refOk = Number.isFinite(s);
      this._s0 = this._refOk ? s : 0;
      this._sCur = this._s0;
    } else if (kind === 'rotate') {
      const a = this._planeAngle(ox, oy, oz, dx, dy, dz, this._axis);
      if (Number.isFinite(a)) { this._angPrev = a; this._refOk = true; }
    } else if (kind === 'scale') {
      const j = (this._axis + 1) % 3, k = (this._axis + 2) % 3;
      const q = this._planeHit(ox, oy, oz, dx, dy, dz, B[i3], B[i3 + 1], B[i3 + 2]);
      if (q) {
        const cu = q[0] * B[j * 3] + q[1] * B[j * 3 + 1] + q[2] * B[j * 3 + 2];
        const cv = q[0] * B[k * 3] + q[1] * B[k * 3 + 1] + q[2] * B[k * 3 + 2];
        const r = Math.hypot(cu, cv);
        if (r > 1e-9) {
          // 掴んだ向きを基準方向にして「符号付きの半径」で倍率を測る。
          // 単純な距離だとピボットを通り越したときに倍率が折り返してしまう。
          this._u0 = cu / r; this._v0 = cv / r; this._r0 = r; this._refOk = true;
        }
      }
    } else {
      // uniform: 視線に垂直な平面を開始時の向きで固定する。毎フレーム視線から
      // 取り直すと透視投影では法線がわずかに変わり、倍率がふらつく。
      this._planeN[0] = -dx; this._planeN[1] = -dy; this._planeN[2] = -dz;
      const q = this._planeHit(ox, oy, oz, dx, dy, dz,
        this._planeN[0], this._planeN[1], this._planeN[2]);
      if (q) {
        const r = Math.hypot(q[0], q[1], q[2]);
        if (r > 1e-9) {
          this._refDir[0] = q[0] / r; this._refDir[1] = q[1] / r; this._refDir[2] = q[2] / r;
          this._r0 = r; this._refOk = true;
        }
      }
    }
    return true;
  }

  /**
   * 新しいレイでドラッグを更新する。常に開始時の座標から作り直すので、
   * 同じレイで何度呼んでも結果は変わらない（べき等）。
   *
   * @param {object} mods
   *   snap    : 移動 / 角度 / 倍率をきりの良い値に丸める
   *   normals : false を渡すと法線の再計算を飛ばす（endDrag でまとめて直す）。
   *             数百万頂点で対話性を優先したいときだけ使う
   * @returns {{changed:number, kind:string, axis:number, offset:number, degrees:number, factor:number}}
   *          戻り値のオブジェクトは使い回す（毎フレームのゴミを作らないため）。
   */
  updateDrag(mesh, rayOrigin, rayDir, mods = null) {
    const res = this._result;
    res.changed = 0; res.kind = this._kind; res.axis = this._axis;
    res.offset = 0; res.degrees = 0; res.factor = 1;
    if (!this._active || !this._kind) return res;

    let dx = rayDir[0], dy = rayDir[1], dz = rayDir[2];
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-20) return res;
    dx /= dl; dy /= dl; dz /= dl;
    const ox = rayOrigin[0], oy = rayOrigin[1], oz = rayOrigin[2];
    const snap = !!(mods && mods.snap);
    const B = this._dragBasis;
    const px = this._dragPivot[0], py = this._dragPivot[1], pz = this._dragPivot[2];
    const i3 = this._axis * 3;
    let changed = 0;

    if (this._kind === 'move') {
      const ax = B[i3], ay = B[i3 + 1], az = B[i3 + 2];
      const s = this._axisParam(ox, oy, oz, dx, dy, dz, ax, ay, az, NaN);
      if (Number.isFinite(s)) {
        if (!this._refOk) { this._s0 = s; this._refOk = true; }
        this._sCur = s;   // 退化フレームでは前値を保つ（形が飛ばない）
      }
      let off = this._sCur - this._s0;
      if (snap) {
        const step = Math.max(1e-9, this._lastScale * SNAP_MOVE_FRAC);
        off = Math.round(off / step) * step;
      }
      changed = this._applyTranslate(mesh, ax * off, ay * off, az * off);
      this._pivot[0] = px + ax * off;
      this._pivot[1] = py + ay * off;
      this._pivot[2] = pz + az * off;
      res.offset = off;
    } else if (this._kind === 'rotate') {
      const a = this._planeAngle(ox, oy, oz, dx, dy, dz, this._axis);
      if (Number.isFinite(a)) {
        if (!this._refOk) { this._angPrev = a; this._refOk = true; }
        // 差分を -π..π に畳んで足すことで、1 回転を超えても連続に増える
        let d = a - this._angPrev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this._angPrev = a;
        this._angAcc += d;
      }
      let ang = this._angAcc;
      if (snap) ang = Math.round(ang / SNAP_ANGLE) * SNAP_ANGLE;
      this._rotationDelta(B[i3], B[i3 + 1], B[i3 + 2], ang);
      changed = this._applyLinear(mesh);
      this._rotateBasis();
      res.degrees = ang * 180 / Math.PI;
    } else {
      let f = this._factor;
      if (this._kind === 'scale') {
        const j = (this._axis + 1) % 3, k = (this._axis + 2) % 3;
        if (this._refOk) {
          const q = this._planeHit(ox, oy, oz, dx, dy, dz, B[i3], B[i3 + 1], B[i3 + 2]);
          if (q) {
            const cu = q[0] * B[j * 3] + q[1] * B[j * 3 + 1] + q[2] * B[j * 3 + 2];
            const cv = q[0] * B[k * 3] + q[1] * B[k * 3 + 1] + q[2] * B[k * 3 + 2];
            f = (cu * this._u0 + cv * this._v0) / this._r0;
          }
        }
        f = this._snapFactor(f, snap);
        this._factor = f;
        this._planeScaleDelta(j, k, f - 1);
      } else {
        if (this._refOk) {
          const q = this._planeHit(ox, oy, oz, dx, dy, dz,
            this._planeN[0], this._planeN[1], this._planeN[2]);
          if (q) {
            f = (q[0] * this._refDir[0] + q[1] * this._refDir[1] + q[2] * this._refDir[2]) / this._r0;
          }
        }
        f = this._snapFactor(f, snap);
        this._factor = f;
        const D = this._D, g = f - 1;
        D[0] = g; D[1] = 0; D[2] = 0;
        D[3] = 0; D[4] = g; D[5] = 0;
        D[6] = 0; D[7] = 0; D[8] = g;
      }
      changed = this._applyLinear(mesh);
      res.factor = f;
    }

    res.changed = changed;
    // 前フレームで動いていて今フレームで元に戻った場合も法線を直す必要がある
    // （位置は元どおりでも法線が前フレームのままになる）
    if (changed > 0 || this._lastChanged > 0) {
      mesh.geomVersion++;
      if (mods && mods.normals === false) {
        this._normalsStale = true;
      } else {
        mesh.computeNormalsFor(this._nset, this._nsetCount);
        this._normalsStale = false;
      }
    }
    if (changed > 0) this._touched = true;
    this._lastChanged = changed;
    return res;
  }

  /**
   * ドラッグ確定。ピボット / 基底はドラッグ中に更新した値をそのまま残す
   * （移動したら次のドラッグもその位置から始まる）。
   * 履歴の commit と曲率の再計算は呼び出し側で行う。
   */
  endDrag(mesh) {
    const kind = this._kind;
    let changed = 0;
    if (kind && this._touched) {
      if (this._normalsStale) {
        mesh.computeNormalsFor(this._nset, this._nsetCount);
        this._normalsStale = false;
      }
      const P = mesh.positions, V = this._verts, O = this._orig, n = this._count;
      for (let k = 0; k < n; k++) {
        const i = V[k] * 3, o = k * 3;
        if (P[i] !== O[o] || P[i + 1] !== O[o + 1] || P[i + 2] !== O[o + 2]) changed++;
      }
    }
    this._kind = null;
    this._axis = -1;
    this._lastChanged = 0;
    this._touched = false;
    return { changed, kind };
  }

  /** ドラッグ中止。開始時の座標へビット単位で戻す */
  cancelDrag(mesh) {
    if (!this._kind) return { changed: 0, kind: null };
    const kind = this._kind;
    const P = mesh.positions, V = this._verts, O = this._orig, n = this._count;
    let changed = 0;
    for (let k = 0; k < n; k++) {
      const v = V[k], i = v * 3, o = k * 3;
      if (P[i] !== O[o] || P[i + 1] !== O[o + 1] || P[i + 2] !== O[o + 2]) {
        P[i] = O[o]; P[i + 1] = O[o + 1]; P[i + 2] = O[o + 2];
        mesh.markVert(v);
        changed++;
      }
    }
    this._pivot.set(this._dragPivot);
    this._basis.set(this._dragBasis);
    if (changed > 0 || this._normalsStale) {
      mesh.geomVersion++;
      mesh.computeNormalsFor(this._nset, this._nsetCount);
      this._normalsStale = false;
    }
    this._kind = null;
    this._axis = -1;
    this._lastChanged = 0;
    this._touched = false;
    return { changed, kind };
  }

  // --- 内部：レイと基準量 -------------------------------------------------

  /**
   * 直線（ピボット + a * s）とレイの最近接位置 s。ほぼ平行なら fallback を返す。
   * 前フレームの値を fallback にすることで、視線が軸と重なったフレームでも
   * 形が飛ばない。
   */
  _axisParam(ox, oy, oz, dx, dy, dz, ax, ay, az, fallback) {
    const ad = ax * dx + ay * dy + az * dz;
    const den = 1 - ad * ad;
    if (den < 1e-9) return fallback;
    const rx = this._dragPivot[0] - ox, ry = this._dragPivot[1] - oy, rz = this._dragPivot[2] - oz;
    const ar = ax * rx + ay * ry + az * rz;
    const dr = dx * rx + dy * ry + dz * rz;
    return (ad * dr - ar) / den;
  }

  /**
   * ピボットを通り法線 n の平面とレイの交点（ピボット基準の相対座標）。
   * 交わらない / 背後なら null。1 フレーム数回しか呼ばないので配列で返す。
   */
  _planeHit(ox, oy, oz, dx, dy, dz, nx, ny, nz) {
    const nd = nx * dx + ny * dy + nz * dz;
    if (Math.abs(nd) < EPS_DIR) return null;
    const px = this._dragPivot[0], py = this._dragPivot[1], pz = this._dragPivot[2];
    const t = ((px - ox) * nx + (py - oy) * ny + (pz - oz) * nz) / nd;
    if (t <= 0) return null;
    const s = this._planeScratch;
    s[0] = ox + dx * t - px; s[1] = oy + dy * t - py; s[2] = oz + dz * t - pz;
    return s;
  }

  /**
   * 軸 i を法線とする平面上での角度。基底 (u, v, n) = (軸 i+1, 軸 i+2, 軸 i) は
   * u × v = n の右手系に並ぶので、ここで測った角がロドリゲス回転の符号と
   * そのまま一致する（軸ごとに符号を場合分けしなくてよい）。
   */
  _planeAngle(ox, oy, oz, dx, dy, dz, i) {
    const B = this._dragBasis;
    const i3 = i * 3;
    const q = this._planeHit(ox, oy, oz, dx, dy, dz, B[i3], B[i3 + 1], B[i3 + 2]);
    if (!q) return NaN;
    const j = (i + 1) % 3, k = (i + 2) % 3;
    const cu = q[0] * B[j * 3] + q[1] * B[j * 3 + 1] + q[2] * B[j * 3 + 2];
    const cv = q[0] * B[k * 3] + q[1] * B[k * 3 + 1] + q[2] * B[k * 3 + 2];
    if (Math.abs(cu) + Math.abs(cv) < 1e-12) return NaN;
    return Math.atan2(cv, cu);
  }

  _snapFactor(f, snap) {
    if (snap) f = Math.round(f / SNAP_FACTOR) * SNAP_FACTOR;
    return clamp(f, MIN_FACTOR, MAX_FACTOR);
  }

  // --- 内部：変換の適用 ---------------------------------------------------

  // 変換は「ピボット中心の線形変換 A」だが、保持するのは D = A - I。
  // 変位が D * (元位置 - ピボット) の 1 本の式になるので、回転 / 平面スケール /
  // 一様スケールを同じループで書けるうえ、変換なし（D = 0）のときに元の座標が
  // ビット単位でそのまま残る（べき等性がタダで手に入る）。
  _rotationDelta(nx, ny, nz, ang) {
    const D = this._D;
    const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    D[0] = t * (nx * nx - 1); D[1] = t * nx * ny - s * nz; D[2] = t * nx * nz + s * ny;
    D[3] = t * ny * nx + s * nz; D[4] = t * (ny * ny - 1); D[5] = t * ny * nz - s * nx;
    D[6] = t * nz * nx - s * ny; D[7] = t * nz * ny + s * nx; D[8] = t * (nz * nz - 1);
  }

  /** 軸 j,k の張る平面内だけを (g + 1) 倍する（軸 i はそのまま） */
  _planeScaleDelta(j, k, g) {
    const B = this._dragBasis, D = this._D;
    const ux = B[j * 3], uy = B[j * 3 + 1], uz = B[j * 3 + 2];
    const vx = B[k * 3], vy = B[k * 3 + 1], vz = B[k * 3 + 2];
    D[0] = g * (ux * ux + vx * vx); D[1] = g * (ux * uy + vx * vy); D[2] = g * (ux * uz + vx * vz);
    D[3] = D[1]; D[4] = g * (uy * uy + vy * vy); D[5] = g * (uy * uz + vy * vz);
    D[6] = D[2]; D[7] = D[5]; D[8] = g * (uz * uz + vz * vz);
  }

  /** 基底も同じ回転で回す（ローカル軸のギズモが形と一緒に回る） */
  _rotateBasis() {
    const D = this._D, B = this._basis, S = this._dragBasis;
    for (let r = 0; r < 3; r++) {
      const x = S[r * 3], y = S[r * 3 + 1], z = S[r * 3 + 2];
      B[r * 3] = x + D[0] * x + D[1] * y + D[2] * z;
      B[r * 3 + 1] = y + D[3] * x + D[4] * y + D[5] * z;
      B[r * 3 + 2] = z + D[6] * x + D[7] * y + D[8] * z;
    }
  }

  /**
   * 平行移動。マスクのグラデーションは変位に weight を掛けるだけでよい。
   * @returns {number} 実際に動いた頂点数
   */
  _applyTranslate(mesh, tx, ty, tz) {
    const P = mesh.positions, V = this._verts, W = this._weights, O = this._orig;
    const n = this._count, VB = mesh.vBlocks;
    let dMin = mesh.vDirtyMin, dMax = mesh.vDirtyMax;
    let bMin = mesh.vBlockMin, bMax = mesh.vBlockMax;
    let changed = 0;
    for (let k = 0; k < n; k++) {
      const w = W[k];
      const ax = tx * w, ay = ty * w, az = tz * w;
      const v = V[k], i = v * 3, o = k * 3;
      P[i] = O[o] + ax; P[i + 1] = O[o + 1] + ay; P[i + 2] = O[o + 2] + az;
      if (ax === 0 && ay === 0 && az === 0) continue;
      changed++;
      // markVert(v) のインライン展開（1 頂点あたり this への読み書きが 8 回あった）
      if (v < dMin) dMin = v;
      if (v > dMax) dMax = v;
      const b = v >> DIRTY_SHIFT;
      VB[b] = 1;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
    mesh.vDirtyMin = dMin; mesh.vDirtyMax = dMax;
    mesh.vBlockMin = bMin; mesh.vBlockMax = bMax;
    return changed;
  }

  /**
   * D（= A - I）による変換の適用。
   *
   * 部分マスクの頂点は「変換後の位置」と「元の位置」を weight で線形補間する。
   * 行列（回転角や倍率）を weight で補間してはいけない：回転行列と単位行列の
   * 線形補間は回転ではなくなり、体積が痩せたりせん断が入る。位置を補間すれば
   * weight = 1 の頂点は厳密に剛体変換のまま、weight = 0 は 1 ビットも動かない、
   * その間は滑らかに繋がる（= ZBrush のソフトな変形）。
   *
   * @returns {number} 実際に動いた頂点数
   */
  _applyLinear(mesh) {
    const P = mesh.positions, V = this._verts, W = this._weights, O = this._orig;
    const n = this._count, VB = mesh.vBlocks, D = this._D;
    const d0 = D[0], d1 = D[1], d2 = D[2];
    const d3 = D[3], d4 = D[4], d5 = D[5];
    const d6 = D[6], d7 = D[7], d8 = D[8];
    const px = this._dragPivot[0], py = this._dragPivot[1], pz = this._dragPivot[2];
    let dMin = mesh.vDirtyMin, dMax = mesh.vDirtyMax;
    let bMin = mesh.vBlockMin, bMax = mesh.vBlockMax;
    let changed = 0;
    for (let k = 0; k < n; k++) {
      const v = V[k], i = v * 3, o = k * 3;
      const gx = O[o], gy = O[o + 1], gz = O[o + 2];
      const rx = gx - px, ry = gy - py, rz = gz - pz;
      const w = W[k];
      const ax = (d0 * rx + d1 * ry + d2 * rz) * w;
      const ay = (d3 * rx + d4 * ry + d5 * rz) * w;
      const az = (d6 * rx + d7 * ry + d8 * rz) * w;
      P[i] = gx + ax; P[i + 1] = gy + ay; P[i + 2] = gz + az;
      if (ax === 0 && ay === 0 && az === 0) continue;
      changed++;
      if (v < dMin) dMin = v;
      if (v > dMax) dMax = v;
      const b = v >> DIRTY_SHIFT;
      VB[b] = 1;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
    mesh.vDirtyMin = dMin; mesh.vDirtyMax = dMax;
    mesh.vBlockMin = bMin; mesh.vBlockMax = bMax;
    return changed;
  }

  /**
   * 法線を直す頂点集合（領域 + その 1-ring）を作る。
   * マスク境界の頂点は動かないが、隣が動くので法線は変わる。
   * ドラッグ中はトポロジが変わらないので開始時に 1 回作れば足りる。
   */
  _buildNormalSet(mesh) {
    if (this._stamp.length < mesh.capV) this._stamp = new Int32Array(mesh.capV);
    // stamp は単調増加させる。新しい配列はゼロ埋めで、既存の値は必ず今の id より
    // 小さいので衝突しない。
    const st = this._stamp, id = ++this._stampId;
    const V = this._verts, n = this._count;
    const T = mesh.tris, RC = mesh.ringCount, RD = mesh.ringData, REX = mesh.ringExt;
    let set = this._nset;
    if (set.length < n + 64) { set = new Int32Array(Math.max(1024, (n + 64) * 2)); this._nset = set; }
    let ns = 0;
    for (let k = 0; k < n; k++) {
      const v = V[k];
      const rc = RC[v];
      // v 自身の 1 個ぶんも含めて先に確保する。Int32Array の範囲外書き込みは黙って
      // 捨てられるので、書いてから確保すると集合から頂点が抜けたまま気付けない。
      if (ns + rc * 3 + 1 > set.length) { set = growI32(set, ns + rc * 3 + 1); this._nset = set; }
      if (st[v] !== id) { st[v] = id; set[ns++] = v; }
      if (rc === 0) continue;
      const inline = rc <= RING_STRIDE;
      const rb = inline ? v * RING_STRIDE : 0;
      const rex = inline ? null : REX[v];
      for (let j = 0; j < rc; j++) {
        const ti = (inline ? RD[rb + j] : rex[j]) * 3;
        let u = T[ti];
        if (st[u] !== id) { st[u] = id; set[ns++] = u; }
        u = T[ti + 1];
        if (st[u] !== id) { st[u] = id; set[ns++] = u; }
        u = T[ti + 2];
        if (st[u] !== id) { st[u] = id; set[ns++] = u; }
      }
    }
    this._nsetCount = ns;
  }
}
