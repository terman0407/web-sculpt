// ---------------------------------------------------------------------------
// matcap.js
// 外部アセットを使わずに MatCap（ZBrush 風のマテリアル球）を手続き的に生成する。
// 出力は rgba8unorm-srgb 用の sRGB エンコード済みバイト列（2D 配列テクスチャの全レイヤ）。
// ---------------------------------------------------------------------------

function srgb(x) {
  x = x < 0 ? 0 : (x > 1 ? 1 : x);
  const v = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// 疑似環境（chrome 用）: 上は空、下は床
function fakeEnv(d) {
  const y = d[1];
  const sky = [0.55, 0.68, 0.92];
  const horizon = [0.92, 0.90, 0.86];
  const ground = [0.16, 0.15, 0.15];
  let c;
  if (y > 0) {
    const t = Math.pow(y, 0.6);
    c = [horizon[0] + (sky[0] - horizon[0]) * t, horizon[1] + (sky[1] - horizon[1]) * t, horizon[2] + (sky[2] - horizon[2]) * t];
  } else {
    const t = Math.pow(-y, 0.5);
    c = [horizon[0] + (ground[0] - horizon[0]) * t, horizon[1] + (ground[1] - horizon[1]) * t, horizon[2] + (ground[2] - horizon[2]) * t];
  }
  // 疑似的なハイライト（強い光源）
  const L = norm([-0.45, 0.75, 0.5]);
  const s = Math.max(0, d[0] * L[0] + d[1] * L[1] + d[2] * L[2]);
  const g = Math.pow(s, 220) * 2.5;
  const k = 0.82;
  return [c[0] * k + g, c[1] * k + g, c[2] * k + g];
}

// 各プリセットは「拡散のピークが 0.9 前後、影側が 0.05 前後」に収まるよう調整してある。
// 白飛びさせないことで SSAO の陰影が乗る余地を残すのが狙い。
export const MATERIALS = [
  {
    id: 'redwax', name: 'Red Wax', jp: 'レッドワックス',
    base: [0.42, 0.082, 0.058], ambient: [0.030, 0.010, 0.009],
    lights: [
      { dir: [-0.45, 0.60, 0.65], color: [1.0, 0.93, 0.85], intensity: 1.50, wrap: 0.14 },
      { dir: [0.70, -0.40, 0.50], color: [1.0, 0.50, 0.30], intensity: 0.40, wrap: 0.60 },
      { dir: [0.10, 0.15, -0.95], color: [0.90, 0.26, 0.18], intensity: 0.30, wrap: 0.95 },
    ],
    spec: [
      { dir: [-0.45, 0.60, 0.65], color: [1.0, 0.96, 0.90], power: 190, intensity: 0.80 },
      { dir: [-0.45, 0.60, 0.65], color: [1.0, 0.62, 0.45], power: 12, intensity: 0.055 },
    ],
    rim: { color: [1.0, 0.34, 0.22], power: 3.5, intensity: 0.32 },
  },
  {
    id: 'clay', name: 'White Clay', jp: 'ホワイトクレイ',
    base: [0.55, 0.545, 0.53], ambient: [0.050, 0.053, 0.060],
    lights: [
      { dir: [-0.40, 0.65, 0.60], color: [1.0, 0.99, 0.96], intensity: 1.25, wrap: 0.20 },
      { dir: [0.70, -0.30, 0.45], color: [0.62, 0.68, 0.85], intensity: 0.28, wrap: 0.60 },
      { dir: [0.15, 0.10, -0.95], color: [0.30, 0.32, 0.38], intensity: 0.38, wrap: 0.95 },
    ],
    spec: [{ dir: [-0.40, 0.65, 0.60], color: [1, 1, 1], power: 45, intensity: 0.085 }],
    rim: { color: [0.80, 0.87, 1.0], power: 4.5, intensity: 0.14 },
  },
  {
    id: 'skin', name: 'Skin', jp: 'スキン',
    base: [0.60, 0.355, 0.295], ambient: [0.045, 0.022, 0.020],
    lights: [
      { dir: [-0.38, 0.58, 0.68], color: [1.0, 0.96, 0.90], intensity: 1.30, wrap: 0.24 },
      { dir: [0.62, -0.40, 0.50], color: [1.0, 0.42, 0.30], intensity: 0.42, wrap: 0.70 },
      { dir: [0.10, 0.20, -0.95], color: [0.55, 0.18, 0.14], intensity: 0.35, wrap: 0.95 },
    ],
    spec: [
      { dir: [-0.38, 0.58, 0.68], color: [1, 0.98, 0.95], power: 80, intensity: 0.26 },
      { dir: [-0.38, 0.58, 0.68], color: [1, 0.90, 0.85], power: 8, intensity: 0.05 },
    ],
    rim: { color: [1.0, 0.44, 0.36], power: 2.9, intensity: 0.34 },
  },
  {
    id: 'pearl', name: 'Pearl', jp: 'パール',
    base: [0.50, 0.515, 0.585], ambient: [0.070, 0.075, 0.095],
    lights: [
      { dir: [-0.33, 0.70, 0.60], color: [1.0, 0.99, 1.0], intensity: 1.10, wrap: 0.32 },
      { dir: [0.75, 0.10, 0.45], color: [0.72, 0.58, 0.86], intensity: 0.36, wrap: 0.50 },
      { dir: [0.0, -0.75, 0.50], color: [0.48, 0.72, 0.86], intensity: 0.32, wrap: 0.60 },
    ],
    spec: [
      { dir: [-0.33, 0.70, 0.60], color: [1, 1, 1], power: 260, intensity: 0.95 },
      { dir: [0.75, 0.10, 0.45], color: [0.90, 0.80, 1.0], power: 30, intensity: 0.14 },
    ],
    rim: { color: [0.62, 0.80, 1.0], power: 3.2, intensity: 0.30 },
  },
  {
    id: 'chrome', name: 'Chrome', jp: 'クローム',
    env: true, tint: [0.90, 0.93, 1.0], ambient: [0, 0, 0],
    rim: { color: [1, 1, 1], power: 5.5, intensity: 0.18 },
  },
  {
    id: 'basalt', name: 'Dark Stone', jp: 'ダークストーン',
    base: [0.075, 0.079, 0.092], ambient: [0.0090, 0.0100, 0.0130],
    lights: [
      { dir: [-0.45, 0.70, 0.55], color: [1.0, 0.98, 0.95], intensity: 1.10, wrap: 0.10 },
      { dir: [0.70, -0.20, 0.50], color: [0.50, 0.60, 0.85], intensity: 0.40, wrap: 0.50 },
    ],
    spec: [{ dir: [-0.45, 0.70, 0.55], color: [1, 1, 1], power: 60, intensity: 0.22 }],
    rim: { color: [0.55, 0.70, 1.0], power: 3.2, intensity: 0.30 },
  },
  {
    id: 'basic', name: 'Basic', jp: 'ベーシック',
    base: [0.46, 0.465, 0.475], ambient: [0.055, 0.058, 0.062],
    lights: [
      { dir: [-0.42, 0.55, 0.72], color: [1.0, 1.0, 1.0], intensity: 1.35, wrap: 0.05 },
      { dir: [0.60, -0.35, 0.72], color: [0.95, 0.96, 1.0], intensity: 0.45, wrap: 0.30 },
    ],
    spec: [{ dir: [-0.42, 0.55, 0.72], color: [1, 1, 1], power: 30, intensity: 0.20 }],
    rim: { color: [0.9, 0.92, 0.96], power: 6.0, intensity: 0.08 },
  },
  {
    id: 'toyplastic', name: 'Toy Plastic', jp: 'トイプラスチック',
    base: [0.30, 0.42, 0.62], ambient: [0.035, 0.050, 0.080],
    lights: [
      { dir: [-0.35, 0.62, 0.70], color: [1.0, 1.0, 1.0], intensity: 1.55, wrap: 0.10 },
      { dir: [0.65, -0.45, 0.60], color: [0.55, 0.75, 1.0], intensity: 0.55, wrap: 0.45 },
    ],
    spec: [
      { dir: [-0.35, 0.62, 0.70], color: [1, 1, 1], power: 420, intensity: 1.25 },
      { dir: [-0.35, 0.62, 0.70], color: [1, 1, 1], power: 18, intensity: 0.10 },
    ],
    rim: { color: [0.70, 0.88, 1.0], power: 2.6, intensity: 0.42 },
  },
  {
    id: 'gold', name: 'Gold', jp: 'ゴールド',
    env: true, tint: [1.22, 0.86, 0.38], ambient: [0.02, 0.012, 0.004],
    rim: { color: [1.0, 0.82, 0.45], power: 4.0, intensity: 0.22 },
  },
  {
    id: 'jade', name: 'Jade', jp: 'ジェイド',
    base: [0.16, 0.42, 0.30], ambient: [0.030, 0.075, 0.055],
    lights: [
      { dir: [-0.35, 0.60, 0.70], color: [0.90, 1.0, 0.94], intensity: 1.40, wrap: 0.35 },
      { dir: [0.60, -0.40, 0.60], color: [0.45, 1.0, 0.70], intensity: 0.70, wrap: 0.80 },
      { dir: [0.05, 0.10, -0.95], color: [0.35, 0.95, 0.65], intensity: 0.75, wrap: 0.98 },
    ],
    spec: [
      { dir: [-0.35, 0.60, 0.70], color: [1, 1, 1], power: 220, intensity: 0.75 },
      { dir: [-0.35, 0.60, 0.70], color: [0.8, 1.0, 0.9], power: 10, intensity: 0.10 },
    ],
    rim: { color: [0.55, 1.0, 0.75], power: 2.2, intensity: 0.45 },
  },
];

/**
 * ピクセルループから定数計算を追い出すための事前計算。
 * 光源方向の正規化やハーフベクトルは法線に依存しないので、
 * 素直に書くと 1 枚 65536 px × 光源数ぶん無駄に計算・確保していた。
 */
function prepare(cfg) {
  const p = {
    env: !!cfg.env,
    ar: cfg.ambient[0], ag: cfg.ambient[1], ab: cfg.ambient[2],
    lights: [], specs: [],
    rimR: 0, rimG: 0, rimB: 0, rimP: 0, hasRim: false,
    tr: 1, tg: 1, tb: 1,
  };
  if (cfg.env) {
    p.tr = cfg.tint[0]; p.tg = cfg.tint[1]; p.tb = cfg.tint[2];
  } else {
    for (const L of cfg.lights || []) {
      const d = norm(L.dir);
      const wr = L.wrap || 0;
      p.lights.push({
        dx: d[0], dy: d[1], dz: d[2],
        wrap: wr, invW: 1 / (1 + wr),
        // base × color × intensity をまとめておく
        r: cfg.base[0] * L.color[0] * L.intensity,
        g: cfg.base[1] * L.color[1] * L.intensity,
        b: cfg.base[2] * L.color[2] * L.intensity,
      });
    }
    for (const S of cfg.spec || []) {
      const d = norm(S.dir);
      const h = norm([d[0], d[1], d[2] + 1]);   // 視線 = +Z のハーフベクトル
      p.specs.push({
        hx: h[0], hy: h[1], hz: h[2], power: S.power,
        r: S.color[0] * S.intensity, g: S.color[1] * S.intensity, b: S.color[2] * S.intensity,
      });
    }
  }
  if (cfg.rim) {
    p.hasRim = true;
    p.rimR = cfg.rim.color[0] * cfg.rim.intensity;
    p.rimG = cfg.rim.color[1] * cfg.rim.intensity;
    p.rimB = cfg.rim.color[2] * cfg.rim.intensity;
    p.rimP = cfg.rim.power;
  }
  return p;
}

const _envL = norm([-0.45, 0.75, 0.5]);
const _out = [0, 0, 0];

/** 事前計算済みのマテリアルで法線 n を陰影付けする（確保なし） */
function shadeP(p, nx, ny, nz) {
  let r = p.ar, g = p.ag, b = p.ab;

  if (p.env) {
    // 反射ベクトル（視線 = +Z）
    const d = 2 * nz;
    let rx = d * nx, ry = d * ny, rz = d * nz - 1;
    const l = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    rx /= l; ry /= l; rz /= l;

    // 疑似環境（インライン展開）
    const y = ry;
    let cr, cg, cb;
    if (y > 0) {
      const t = Math.pow(y, 0.6);
      cr = 0.92 + (0.55 - 0.92) * t; cg = 0.90 + (0.68 - 0.90) * t; cb = 0.86 + (0.92 - 0.86) * t;
    } else {
      const t = Math.pow(-y, 0.5);
      cr = 0.92 + (0.16 - 0.92) * t; cg = 0.90 + (0.15 - 0.90) * t; cb = 0.86 + (0.15 - 0.86) * t;
    }
    const s = rx * _envL[0] + ry * _envL[1] + rz * _envL[2];
    const gl = s > 0 ? Math.pow(s, 220) * 2.5 : 0;
    const kk = 0.82;
    cr = cr * kk + gl; cg = cg * kk + gl; cb = cb * kk + gl;

    const f = 0.06 + 0.94 * Math.pow(1 - (nz > 0 ? nz : 0), 4);   // フレネル
    const k = 0.55 + 0.45 * f;
    r += cr * p.tr * k; g += cg * p.tg * k; b += cb * p.tb * k;
  } else {
    const L = p.lights;
    for (let i = 0; i < L.length; i++) {
      const li = L[i];
      let ndl = (nx * li.dx + ny * li.dy + nz * li.dz + li.wrap) * li.invW;
      if (ndl <= 0) continue;
      r += li.r * ndl; g += li.g * ndl; b += li.b * ndl;
    }
    const S = p.specs;
    for (let i = 0; i < S.length; i++) {
      const si = S[i];
      const nh = nx * si.hx + ny * si.hy + nz * si.hz;
      if (nh <= 0) continue;
      const k = Math.pow(nh, si.power);
      r += si.r * k; g += si.g * k; b += si.b * k;
    }
  }

  if (p.hasRim) {
    const c = nz < 0 ? 0 : (nz > 1 ? 1 : nz);
    const f = Math.pow(1 - c, p.rimP);
    r += p.rimR * f; g += p.rimG * f; b += p.rimB * f;
  }
  _out[0] = r; _out[1] = g; _out[2] = b;
  return _out;
}

/**
 * 全マテリアルの MatCap を生成する。
 * @returns {{data: Uint8Array, size: number, layers: number}}
 */
/** 1 枚ぶんだけ生成する（起動時は表示中のマテリアルだけ作れば足りる） */
export function generateMatcapLayer(index, size = 256) {
  const r = generateMatcaps(size, [index]);
  return r.data;
}

/**
 * @param {number} size 1 辺の px 数
 * @param {number[]|null} only 生成するマテリアル番号。null なら全部。
 *        指定した場合、data は指定枚数ぶんだけを詰めた並びになる。
 */
export function generateMatcaps(size = 256, only = null) {
  const idx = only || MATERIALS.map((_, i) => i);
  const layers = idx.length;
  const data = new Uint8Array(size * size * 4 * layers);
  for (let li = 0; li < layers; li++) {
    const l = idx[li];
    const mat = prepare(MATERIALS[l]);
    const off = li * size * size * 4;
    for (let y = 0; y < size; y++) {
      const v = 1 - ((y + 0.5) / size) * 2;      // 上が +Y
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * 2 - 1;
        const r2 = u * u + v * v;
        let nx, ny, nz;
        if (r2 <= 1) {
          nx = u; ny = v; nz = Math.sqrt(1 - r2);
        } else {
          // 円外はリム（シルエット）の色で埋めてバイリニアの滲みを防ぐ
          const l2 = Math.sqrt(r2);
          nx = u / l2; ny = v / l2; nz = 0;
        }
        const c = shadeP(mat, nx, ny, nz);
        const p = off + (y * size + x) * 4;
        data[p] = srgb(c[0]);
        data[p + 1] = srgb(c[1]);
        data[p + 2] = srgb(c[2]);
        data[p + 3] = 255;
      }
    }
  }
  return { data, size, layers, indices: idx };
}

/** UI のマテリアルサムネイル用に小さい canvas を返す */
export function materialThumb(index, size = 34) {
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const mat = prepare(MATERIALS[index]);
  for (let y = 0; y < size; y++) {
    const v = 1 - ((y + 0.5) / size) * 2;
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const r2 = u * u + v * v;
      const p = (y * size + x) * 4;
      if (r2 > 1) { img.data[p + 3] = 0; continue; }
      const c = shadeP(mat, u, v, Math.sqrt(1 - r2));
      img.data[p] = srgb(c[0]);
      img.data[p + 1] = srgb(c[1]);
      img.data[p + 2] = srgb(c[2]);
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
