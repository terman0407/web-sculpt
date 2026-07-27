// ---------------------------------------------------------------------------
// math.js
// 右手系 / 列優先 mat4 / WebGPU 深度レンジ [0,1] 前提の最小数学ライブラリ。
// 毎フレーム呼ばれるものは一切アロケーションしない方針（出力先を渡す）。
// ---------------------------------------------------------------------------

export const EPS = 1e-9;
export const TAU = Math.PI * 2;

export function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
export function saturate(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

// --- vec3 -----------------------------------------------------------------

export const V3 = {
  create(x = 0, y = 0, z = 0) { return new Float32Array([x, y, z]); },
  set(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; },
  copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  add(o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
  sub(o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
  mul(o, a, b) { o[0] = a[0] * b[0]; o[1] = a[1] * b[1]; o[2] = a[2] * b[2]; return o; },
  scale(o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
  addScaled(o, a, b, s) { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; },
  dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
  cross(o, a, b) {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
    o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx; return o;
  },
  lenSq(a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; },
  len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
  distSq(a, b) { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; },
  dist(a, b) { return Math.sqrt(V3.distSq(a, b)); },
  normalize(o, a) {
    const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (l < EPS) { o[0] = 0; o[1] = 0; o[2] = 0; return o; }
    const s = 1 / l; o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o;
  },
  lerp(o, a, b, t) {
    o[0] = a[0] + (b[0] - a[0]) * t;
    o[1] = a[1] + (b[1] - a[1]) * t;
    o[2] = a[2] + (b[2] - a[2]) * t; return o;
  },
  // 位置として mat4 変換（w 除算あり）
  transformPoint(o, a, m) {
    const x = a[0], y = a[1], z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (Math.abs(w) < EPS) w = 1;
    const iw = 1 / w;
    o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw;
    o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw;
    o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw;
    return o;
  },
  // 方向として mat4 変換（平行移動なし）
  transformDir(o, a, m) {
    const x = a[0], y = a[1], z = a[2];
    o[0] = m[0] * x + m[4] * y + m[8] * z;
    o[1] = m[1] * x + m[5] * y + m[9] * z;
    o[2] = m[2] * x + m[6] * y + m[10] * z;
    return o;
  },
  // a に直交する成分だけ残す（n は正規化済み前提）
  tangential(o, a, n) {
    const d = V3.dot(a, n);
    o[0] = a[0] - n[0] * d; o[1] = a[1] - n[1] * d; o[2] = a[2] - n[2] * d;
    return o;
  },
  // n に垂直な任意の単位ベクトル
  perpendicular(o, n) {
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    if (ax <= ay && ax <= az) { o[0] = 0; o[1] = -n[2]; o[2] = n[1]; }
    else if (ay <= az) { o[0] = -n[2]; o[1] = 0; o[2] = n[0]; }
    else { o[0] = -n[1]; o[1] = n[0]; o[2] = 0; }
    return V3.normalize(o, o);
  },
};

// --- mat4 (列優先: m[col*4 + row]) ---------------------------------------

// diskBasis 用のスクラッチ（毎フレーム呼ばれるためアロケーションしない）
const _dbT = V3.create();
const _dbB = V3.create();

export const M4 = {
  create() {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
  },
  identity(m) {
    m.fill(0); m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1; return m;
  },
  copy(o, a) { o.set(a); return o; },

  multiply(o, a, b) {
    // o = a * b
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
      o[c * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
      o[c * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
      o[c * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
    }
    return o;
  },

  // WebGPU / 深度 0..1、右手系（視線 -Z）
  perspective(o, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy * 0.5);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = far / (near - far);
    o[11] = -1;
    o[14] = (far * near) / (near - far);
    return o;
  },

  lookAt(o, eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let l = Math.hypot(zx, zy, zz);
    if (l < EPS) { zz = 1; l = 1; }
    zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz);
    if (l < EPS) {
      // up と視線が平行 → 適当な軸で作り直す
      xx = 1; xy = 0; xz = 0;
      const d = xx * zx + xy * zy + xz * zz;
      xx -= zx * d; xy -= zy * d; xz -= zz * d;
      l = Math.hypot(xx, xy, xz) || 1;
    }
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
    o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    o[15] = 1;
    return o;
  },

  invert(o, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-20) return M4.identity(o);
    det = 1 / det;

    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },

  transpose(o, a) {
    if (o === a) {
      let t;
      t = a[1]; o[1] = a[4]; o[4] = t;
      t = a[2]; o[2] = a[8]; o[8] = t;
      t = a[3]; o[3] = a[12]; o[12] = t;
      t = a[6]; o[6] = a[9]; o[9] = t;
      t = a[7]; o[7] = a[13]; o[13] = t;
      t = a[11]; o[11] = a[14]; o[14] = t;
      return o;
    }
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r * 4 + c];
    return o;
  },

  // 法線 n を Z 軸、pos を原点、半径 r のスケールを持つ基底行列（ブラシリング用）
  diskBasis(o, pos, n, r) {
    const t = _dbT, b = _dbB;
    V3.perpendicular(t, n);
    V3.cross(b, n, t);
    o[0] = t[0] * r; o[1] = t[1] * r; o[2] = t[2] * r; o[3] = 0;
    o[4] = b[0] * r; o[5] = b[1] * r; o[6] = b[2] * r; o[7] = 0;
    o[8] = n[0] * r; o[9] = n[1] * r; o[10] = n[2] * r; o[11] = 0;
    o[12] = pos[0]; o[13] = pos[1]; o[14] = pos[2]; o[15] = 1;
    return o;
  },
};
