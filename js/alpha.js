// ---------------------------------------------------------------------------
// alpha.js
// ブラシアルファ（断面形状）とストロークタイプ。ZBrush の Alpha / Stroke パレット相当。
//
// 外部アセットを持てないので、アルファは matcap.js と同じく手続き的に生成する。
// 13 枚を起動時に全部作ると 13 × 128² px の評価になって初回描画が遅れるため、
// 要求されたものだけを作ってキャッシュする（renderer の ensureMatcap / fillNextMatcap
// と同じ考え方。ensureAlpha / fillNextAlpha を用意してある）。
//
// アルファの不変条件（ブラシの断面として使うために必須）:
//   * 値は 0..1
//   * 中心 (u,v) = (0.5, 0.5) が最大で、その値はちょうど 1
//   * 画像の外周は 0（バイリニア補間で外へ滲まない）
// この 3 つは「a = rim(r) × dome(r) × (1 - depth × carve)」という共通の組み立てで
// 構造的に保証している。carve は「中心での値を 0 に正規化した窪み」なので、
// 模様の式をいじっても中心が最大であることは崩れない。
// ---------------------------------------------------------------------------

import { V3, clamp, TAU } from './math.js';

export const ALPHA_SIZE = 128;

// 中心をちょうど 1 ピクセル (HALF, HALF) に載せるための半幅。
// 一般的な「ピクセル中心 = (x+0.5)/size」の割り付けだと偶数サイズでは中心が
// ピクセル間に落ちて、「中心が最大でその値が 1」を厳密に満たせない。
// この割り付けなら u = (x - HALF) / HALF が x = HALF でちょうど 0 になり、
// 外周（x = 0 と x = size-1）は |u| >= 1 - 1/HALF で rim() が完全に 0 を返す。
const HALF = ALPHA_SIZE >> 1;

export const ALPHAS = [
  { id: 'soft', jp: 'ソフト', hint: 'なめらかな円。既定のブラシ断面' },
  { id: 'hard', jp: 'ハード', hint: '縁の立った円。押した跡がはっきり出る' },
  { id: 'square', jp: 'スクエア', hint: '角の丸い四角。平面や角を作るのに' },
  { id: 'ring', jp: 'リング', hint: '同心円。波紋や輪状のディテールに' },
  { id: 'star', jp: 'スター', hint: '5 芒星。刻印やスタンプに' },
  { id: 'crack', jp: 'クラック', hint: 'ひび割れ。乾いた土や岩肌に' },
  { id: 'scale', jp: 'スケール', hint: '鱗。竜や魚の表面に' },
  { id: 'noise', jp: 'ノイズ', hint: '斑。粗い質感を散らす' },
  { id: 'stitch', jp: 'ステッチ', hint: '縫い目。布の合わせ目に' },
  { id: 'brick', jp: 'ブリック', hint: 'レンガ。壁や床に' },
  { id: 'hexTile', jp: 'ヘックス', hint: '六角タイル。機械的なパネルに' },
  { id: 'cloth', jp: 'クロス', hint: '布目。織りの質感に' },
  { id: 'scratch', jp: 'スクラッチ', hint: '引っかき傷。使い込んだ表面に' },
];

export const ALPHA_IDS = ALPHAS.map(a => a.id);
export const ALPHA_BY_ID = new Map(ALPHAS.map(a => [a.id, a]));
export const DEFAULT_ALPHA = 'soft';

// ---------------------------------------------------------------------------
// 生成に使う小道具
// ---------------------------------------------------------------------------

function ss(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// 外周を確実に 0 にする窓。r >= RIM_START + RIM_WIDTH でちょうど 0 になる。
// 外周ピクセルの r は最小でも 1 - 1/HALF = 0.9922 なので、0.97 で閉じておけば
// 4 辺すべてが厳密に 0 になる。
const RIM_START = 0.90, RIM_WIDTH = 0.07;
function rim(r) {
  return r <= RIM_START ? 1 : 1 - ss((r - RIM_START) / RIM_WIDTH);
}

// 模様系アルファの土台。中央が平らで縁が落ちるスタンプ状の窓。
function stampDome(r) {
  return 1 - ss((r - 0.52) / 0.44);
}

/**
 * 整数格子の決定論的ハッシュ（0..1）。
 * Math.random を使わないのは、アルファもスプレーも「同じ入力なら常に同じ絵」で
 * なければならないため。アルファはキャッシュを捨てて作り直しても同一である必要が
 * あり、スプレーはアンドゥ→リドゥやシンメトリのミラー間で結果が一致しないと
 * 左右対称に撒けない。
 */
function hash1(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0x165667b1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash1(ix, iy), b = hash1(ix + 1, iy);
  const c = hash1(ix, iy + 1), d = hash1(ix + 1, iy + 1);
  const t0 = a + (b - a) * ux;
  const t1 = c + (d - c) * ux;
  return t0 + (t1 - t0) * uy;
}

function fbm(x, y, oct) {
  let s = 0, amp = 0.5, tot = 0;
  for (let i = 0; i < oct; i++) {
    s += vnoise(x, y) * amp;
    tot += amp;
    x = x * 2.03 + 17.1; y = y * 2.03 - 9.7;
    amp *= 0.5;
  }
  return s / tot;
}

// 最近接 2 点までの距離。行ごとに shift ずらした格子のボロノイ辺（d2 - d1）を
// 使うと鱗や六角タイルの継ぎ目がそのまま得られる。返り値は 2 つあるので
// 呼び出しごとにオブジェクトを作らずモジュール変数に置く。
let _d1 = 0, _d2 = 0;
function lattice2(x, y, shift) {
  let d1 = Infinity, d2 = Infinity;
  const j0 = Math.round(y);
  for (let dj = -1; dj <= 1; dj++) {
    const j = j0 + dj;
    const off = (j & 1) ? shift : 0;
    const i0 = Math.round(x - off);
    const cy = y - j;
    for (let di = -1; di <= 1; di++) {
      const cx = x - (i0 + di + off);
      const d = Math.sqrt(cx * cx + cy * cy);
      if (d < d1) { d2 = d1; d1 = d; }
      else if (d < d2) { d2 = d; }
    }
  }
  _d1 = d1; _d2 = d2;
}

// ---------------------------------------------------------------------------
// 模様の定義
//
// 各エントリは
//   dome(r)                : 半径方向の窓（dome(0) = 1）
//   field(u, v, ctx)       : 0..1 の窪み量（大きいほど削れる）。省略で窪みなし
//   depth                  : 窪みの深さ
//   setup()                : field が使う前計算（線の座標など）
// を持つ。field は「中心での値」を引いて正規化するので、中心は必ず窪み 0 になる。
// ---------------------------------------------------------------------------

const SHAPES = {
  soft: {
    dome(r) { const d = 1 - r * r; return d * d; },
  },

  hard: {
    dome(r) { return 1 - ss((r - 0.80) / 0.15); },
  },

  square: {
    // 8 乗ノルムで角丸の四角。|u| か |v| が 1 に近い外周では q >= 1 になり
    // 必ず 0 に落ちるので、半径方向の窓は要らない（rim() だけで足りる）。
    dome() { return 1; },
    field(u, v) {
      const a2 = u * u, a4 = a2 * a2, a8 = a4 * a4;
      const b2 = v * v, b4 = b2 * b2, b8 = b4 * b4;
      const q = Math.pow(a8 + b8, 0.125);
      return ss((q - 0.68) / 0.10);
    },
    depth: 1,
  },

  ring: {
    // 単一の輪だと中心が 0 になってブラシの当たりの中心が消えるので、
    // 中心を頂点とする同心円（波紋）にしてある。
    dome(r) { return 1 - r * r; },
    field(u, v) {
      const r = Math.sqrt(u * u + v * v);
      return 0.5 - 0.5 * Math.cos(r * Math.PI * 6);   // 3 本の同心リング
    },
    depth: 1,
  },

  star: {
    dome(r) { return 1 - 0.30 * r * r; },
    field(u, v) {
      const r = Math.sqrt(u * u + v * v);
      const lobe = 0.5 + 0.5 * Math.cos(Math.atan2(v, u) * 5);
      const edge = 0.30 + 0.58 * lobe * lobe;
      return ss((r - edge) / 0.07);
    },
    depth: 1,
  },

  crack: {
    dome: stampDome,
    field(u, v) {
      // fbm の 0.5 等値線を線として抜き出す（リッジ）。太さを一定にしたいので
      // 2f-1 の絶対値で判定する。粗い方と細かい方を重ねて枝分かれを作る。
      const a = Math.abs(2 * fbm(u * 2.6 + 11.3, v * 2.6 + 7.7, 4) - 1);
      const b = Math.abs(2 * fbm(u * 5.9 - 3.4, v * 5.9 + 21.6, 3) - 1);
      const c1 = 1 - ss(a / 0.085);
      const c2 = (1 - ss(b / 0.070)) * 0.75;
      return c1 > c2 ? c1 : c2;
    },
    depth: 0.95,
  },

  scale: {
    dome: stampDome,
    field(u, v) {
      // 行を半個ずらした格子。原点が鱗の中心に来るので中心が必ず山になる。
      lattice2(u * 3.4, v * 4.3, 0.5);
      const round = ss(_d1 / 0.62);                     // 鱗 1 枚ぶんの丸み
      const seam = 1 - ss((_d2 - _d1) / 0.16);          // 鱗の境目の溝
      return 0.55 * round + 0.45 * seam;
    },
    depth: 0.9,
  },

  noise: {
    dome: stampDome,
    field(u, v) { return fbm(u * 4.4 + 31.7, v * 4.4 - 12.9, 4); },
    depth: 0.85,
  },

  stitch: {
    dome: stampDome,
    field(u, v) {
      // 交互に傾いたカプセルを 1 列並べる。i = 0 の縫い目が原点に来る。
      const k = 2.8;
      const s = u * k, ly = v * k;
      const i = Math.round(s);
      const lu = s - i;
      const ang = (i & 1) ? 0.55 : -0.55;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rx = lu * ca + ly * sa, ry = -lu * sa + ly * ca;
      const t = rx < -0.32 ? -0.32 : (rx > 0.32 ? 0.32 : rx);
      const ex = rx - t;
      const d = Math.sqrt(ex * ex + ry * ry);
      return ss((d - 0.075) / 0.10);        // 縫い目の外は 1 = 全部削れる（＝効かない）
    },
    depth: 1,
  },

  brick: {
    dome: stampDome,
    field(u, v) {
      const bx = u * 2.6, by = v * 3.6;
      const j = Math.floor(by + 0.5);
      const off = (j & 1) ? 0.5 : 0;
      const fx = bx - off;
      const i = Math.floor(fx + 0.5);
      const cx = fx - i, cy = by - j;
      const ax = Math.abs(cx) * 2, ay = Math.abs(cy) * 2;
      const m = ax > ay ? ax : ay;
      const mortar = ss((m - 0.78) / 0.16);
      // レンガごとに少し高さを変えると単調さが消える。中心のレンガが最も高く
      // なるよう field の正規化に任せる（下がる方向にしか効かない）。
      const vary = 0.12 * hash1(i, j);
      return mortar > vary ? mortar : vary;
    },
    depth: 1,
  },

  hexTile: {
    dome: stampDome,
    field(u, v) {
      // 三角格子のボロノイ図はちょうど正六角形になる。y を 1/0.866 倍して
      // 行間を sqrt(3)/2 にしてある。
      lattice2(u * 3.2, v * 3.2 / 0.866, 0.5);
      const seam = 1 - ss((_d2 - _d1) / 0.15);
      const bevel = 0.20 * ss(_d1 / 0.55);
      return seam > bevel ? seam : bevel;
    },
    depth: 0.95,
  },

  cloth: {
    dome: stampDome,
    field(u, v) {
      // 市松で縦糸と横糸の上下を入れ替える。原点は縦糸と横糸の交点（山）。
      const k = 5.5;
      const w = 0.5 + 0.5 * Math.cos(u * TAU * k);
      const f = 0.5 + 0.5 * Math.cos(v * TAU * k);
      const cell = (Math.floor(u * k + 0.5) + Math.floor(v * k + 0.5)) & 1;
      const hi = cell ? w : f;
      const lo = (cell ? f : w) * 0.55;
      return 1 - (hi > lo ? hi : lo);
    },
    depth: 0.8,
  },

  scratch: {
    dome: stampDome,
    // 傷は「線の上だけ効く」形。1 本目を原点ちょうどに通して中心を山にする。
    setup() {
      const n = 9;
      const L = new Float32Array(n * 6);   // px, py, dx, dy, len, phase
      for (let k = 0; k < n; k++) {
        const a = hash1(k, 101) * Math.PI;          // 向き
        const px = k === 0 ? 0 : (hash1(k, 202) * 2 - 1) * 0.72;
        const py = k === 0 ? 0 : (hash1(k, 303) * 2 - 1) * 0.72;
        const i = k * 6;
        L[i] = px; L[i + 1] = py;
        L[i + 2] = Math.cos(a); L[i + 3] = Math.sin(a);
        L[i + 4] = 0.45 + hash1(k, 404) * 0.55;     // 傷の長さ
        L[i + 5] = k === 0 ? 0 : hash1(k, 505) * TAU;  // 揺らぎの位相（0 本目は 0）
      }
      return { L, n };
    },
    field(u, v, ctx) {
      const L = ctx.L, n = ctx.n;
      let mark = 0;
      for (let k = 0; k < n; k++) {
        const i = k * 6;
        const ox = u - L[i], oy = v - L[i + 1];
        const dx = L[i + 2], dy = L[i + 3];
        const t = ox * dx + oy * dy;
        // 直線からの符号付き距離に沿った揺らぎを足して、まっすぐ過ぎない傷にする
        const off = ox * dy - oy * dx + 0.030 * Math.sin(t * 6.3 + L[i + 5]);
        const d = Math.abs(off);
        const len = L[i + 4];
        const taper = 1 - ss((Math.abs(t) - len) / 0.22);
        const m = (1 - ss((d - 0.008) / 0.028)) * taper;
        if (m > mark) mark = m;
      }
      return 1 - mark;
    },
    depth: 1,
  },
};

// ---------------------------------------------------------------------------
// 生成とキャッシュ
// ---------------------------------------------------------------------------

const _cache = new Map();

// SHAPES はオブジェクトリテラルなので SHAPES['toString'] や SHAPES['constructor'] が
// Object.prototype 由来で「在る」ように見えてしまう。保存済みの設定や UI 文字列が
// そのまま id として渡ってきても既定に落ちるよう、自前のキーだけを見る。
// （そのままだと dome が関数でなく TypeError で落ちる）
function shapeFor(id) {
  return Object.prototype.hasOwnProperty.call(SHAPES, id) ? SHAPES[id] : null;
}

function buildAlpha(id) {
  const shp = shapeFor(id) || SHAPES[DEFAULT_ALPHA];
  const size = ALPHA_SIZE;
  const dst = new Float32Array(size * size);
  const ctx = shp.setup ? shp.setup() : null;
  const dome = shp.dome;
  const field = shp.field || null;
  const depth = shp.depth !== undefined ? shp.depth : 0;

  // 中心での窪み量。これを基準にすると「中心の窪み = 0」が保証でき、
  // 中心の値は必ず dome(0) = 1（＝全体の最大）になる。
  const f0 = field ? field(0, 0, ctx) : 0;
  const invk = f0 < 0.999 ? 1 / (1 - f0) : 1;

  for (let y = 0; y < size; y++) {
    const sv = (y - HALF) / HALF;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const su = (x - HALF) / HALF;
      const r = Math.sqrt(su * su + sv * sv);
      let a = 0;
      if (r < 1) {
        a = rim(r) * dome(r);
        if (a > 0 && field) {
          let carve = (field(su, sv, ctx) - f0) * invk;
          if (carve > 0) a *= 1 - depth * (carve > 1 ? 1 : carve);
        }
      }
      dst[row + x] = a < 0 ? 0 : (a > 1 ? 1 : a);
    }
  }
  return dst;
}

/**
 * アルファのビットマップ（size*size の Float32Array, 0..1）。初回だけ生成する。
 * 未知の id は既定（soft）に落ちる。呼び出し側でキャッシュを持つ必要はない。
 */
export function alphaData(id) {
  let d = _cache.get(id);
  if (d) return d;
  if (!shapeFor(id)) id = DEFAULT_ALPHA;
  d = _cache.get(id);
  if (!d) { d = buildAlpha(id); _cache.set(id, d); }
  return d;
}

/**
 * まだ作っていなければ作る。作ったら true（renderer.ensureMatcap と同じ用途）。
 * キャッシュは既定に落ちた後の id で引く。そうしないと未知の id では
 * 毎回 true が返り、「true ならテクスチャを転送」する呼び出し側が毎フレーム
 * 転送し続けてしまう。
 */
export function ensureAlpha(id) {
  if (!shapeFor(id)) id = DEFAULT_ALPHA;
  if (_cache.has(id)) return false;
  alphaData(id);
  return true;
}

/**
 * 未生成のアルファを 1 枚だけ埋める。アイドル時に毎フレーム呼んで少しずつ進める。
 * SHAPES に無い id は飛ばす。飛ばさないと（表がずれたときに）その id が永久に
 * キャッシュに入らず、true を返し続けて先読みが終わらなくなる。
 */
export function fillNextAlpha() {
  for (let i = 0; i < ALPHA_IDS.length; i++) {
    const id = ALPHA_IDS[i];
    if (shapeFor(id) && !_cache.has(id)) return ensureAlpha(id);
  }
  return false;
}

/** キャッシュを捨てる（メモリを返したいときだけ。作り直しても結果は同一） */
export function clearAlphaCache() {
  _cache.clear();
  // sampleAlpha が握っている直前の配列も忘れる。作り直せば同じ中身になるので
  // 実害はないが、捨てたはずの配列を参照し続けるのは紛らわしい。
  _lastId = ''; _lastData = null;
}

/**
 * UI サムネイル / GPU テクスチャ用の RGBA8 バイト列。
 * DOM に触らないので Node からも呼べる。out を渡せば確保しない。
 */
export function alphaBytes(id, out = null) {
  const d = alphaData(id);
  const n = d.length;
  const b = out && out.length >= n * 4 ? out : new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const g = Math.round(d[i] * 255);
    const p = i * 4;
    b[p] = g; b[p + 1] = g; b[p + 2] = g; b[p + 3] = g;
  }
  return b;
}

// ---------------------------------------------------------------------------
// サンプリング
// ---------------------------------------------------------------------------

// 1 ダブで数万頂点ぶん sampleAlpha が呼ばれるので、Map 参照を毎回やらずに
// 直前の id と配列を覚えておく（ダブの途中で id が変わることはない）。
let _lastId = '';
let _lastData = null;

function dataFor(id) {
  if (id === _lastId && _lastData) return _lastData;
  const d = alphaData(id);
  _lastId = id; _lastData = d;
  return d;
}

/**
 * u, v は 0..1（0.5, 0.5 が中心）。バイリニア補間。範囲外は 0。
 * 格子点割り付け（u = x / size）なので u = 0.5 はちょうど中心ピクセルを返す。
 */
export function sampleAlpha(id, u, v) {
  if (!(u >= 0) || !(v >= 0) || u > 1 || v > 1) return 0;   // NaN もここで落ちる
  const d = dataFor(id);
  const size = ALPHA_SIZE;
  const fx = u * size, fy = v * size;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const x1 = x0 + 1, y1 = y0 + 1;
  const okx0 = x0 >= 0 && x0 < size, okx1 = x1 >= 0 && x1 < size;
  const oky0 = y0 >= 0 && y0 < size, oky1 = y1 >= 0 && y1 < size;
  const a00 = (okx0 && oky0) ? d[y0 * size + x0] : 0;
  const a10 = (okx1 && oky0) ? d[y0 * size + x1] : 0;
  const a01 = (okx0 && oky1) ? d[y1 * size + x0] : 0;
  const a11 = (okx1 && oky1) ? d[y1 * size + x1] : 0;
  const t0 = a00 + (a10 - a00) * tx;
  const t1 = a01 + (a11 - a01) * tx;
  return t0 + (t1 - t0) * ty;
}

/**
 * ダブの接平面に貼ったアルファの重み。ブラシの減衰に掛ける係数（0..1）。
 * @param {string} id
 * @param {number} px,py,pz  頂点のワールド座標
 * @param {ArrayLike<number>} center     ダブ中心（ワールド）
 * @param {ArrayLike<number>} tangent    接平面の基底 1（単位ベクトル）
 * @param {ArrayLike<number>} bitangent  接平面の基底 2（単位ベクトル）
 * @param {number} radius    ブラシ半径。これがアルファの半幅に対応する
 * @param {number} rotation  アルファの回転（rad, 反時計回り）
 */
export function alphaWeightAt(id, px, py, pz, center, tangent, bitangent, radius, rotation) {
  const inv = 1 / (radius > 1e-12 ? radius : 1e-12);
  const dx = px - center[0], dy = py - center[1], dz = pz - center[2];
  let x = (dx * tangent[0] + dy * tangent[1] + dz * tangent[2]) * inv;
  let y = (dx * bitangent[0] + dy * bitangent[1] + dz * bitangent[2]) * inv;
  if (rotation) {
    // スタンプを +rotation 回すので、サンプリング座標は -rotation 回す
    const c = Math.cos(rotation), s = Math.sin(rotation);
    const xr = x * c + y * s;
    y = -x * s + y * c;
    x = xr;
  }
  return sampleAlpha(id, x * 0.5 + 0.5, y * 0.5 + 0.5);
}

// ---------------------------------------------------------------------------
// ストロークタイプ
// ---------------------------------------------------------------------------

export const STROKES = [
  {
    id: 'dots', jp: 'ドット', hint: '等間隔にダブを置く（既定の挙動）',
    params: ['spacing'],
    def: { spacing: 0.16, scatter: 0, sizeJitter: 0, colorJitter: 0, spin: false, align: false },
  },
  {
    id: 'freehand', jp: 'フリーハンド', hint: '間隔を詰めて連続した線にする',
    params: ['spacing'],
    def: { spacing: 0.04, scatter: 0, sizeJitter: 0, colorJitter: 0, spin: false, align: true },
  },
  {
    id: 'dragRect', jp: 'ドラッグ矩形', hint: '押した点から引いた分でスタンプ 1 個の大きさと向きが決まる',
    params: [],
    def: { spacing: 0, scatter: 0, sizeJitter: 0, colorJitter: 0, spin: false, align: true },
  },
  {
    id: 'spray', jp: 'スプレー', hint: '半径内にばらつかせて撒く',
    params: ['spacing', 'scatter', 'sizeJitter'],
    def: { spacing: 0.22, scatter: 0.85, sizeJitter: 0.45, colorJitter: 0, spin: true, align: false },
  },
  {
    id: 'colorSpray', jp: 'カラースプレー', hint: 'スプレーに加えて色も揺らす',
    params: ['spacing', 'scatter', 'sizeJitter', 'colorJitter'],
    def: { spacing: 0.22, scatter: 0.85, sizeJitter: 0.45, colorJitter: 0.5, spin: true, align: false },
  },
  {
    id: 'sprayLight', jp: 'スプレー（弱）', hint: 'ばらつきの小さいスプレー',
    params: ['spacing', 'scatter', 'sizeJitter'],
    def: { spacing: 0.12, scatter: 0.3, sizeJitter: 0.18, colorJitter: 0, spin: true, align: false },
  },
];

export const STROKE_IDS = STROKES.map(s => s.id);
export const STROKE_BY_ID = new Map(STROKES.map(s => [s.id, s]));
export const DEFAULT_STROKE = 'dots';

/** ダブ 1 個ぶんの要素数: x, y, z, scaleMul, rotation, colorJitter */
export const DAB_STRIDE = 6;

/** 1 回の planDabs が返すダブ数の絶対上限（スクラッチの確保量を有界にする） */
export const MAX_DABS = 65536;

/** 押した点を基準に 1 個だけスタンプするタイプか（呼び出し側の扱いが変わる） */
export function isDragStroke(id) { return id === 'dragRect'; }

/** ばらつきを持つタイプか（アルファの回転をランダム化してよいか） */
export function isSprayStroke(id) {
  return id === 'spray' || id === 'colorSpray' || id === 'sprayLight';
}

/** UI の初期値に使うパラメータ既定値（複製を返すので書き換えて構わない） */
export function strokeDefaults(id) {
  const s = STROKE_BY_ID.get(id) || STROKE_BY_ID.get(DEFAULT_STROKE);
  return Object.assign({}, s.def);
}

// planDabs は 1 フレームにミラー数 × 区間ぶん呼ばれるので、戻り値も含めて何も
// 確保しない。返るオブジェクトと dabs は使い回しなので、次に planDabs を呼ぶまでしか
// 有効でない（sculptor の MirrorState.verts と同じ規約）。値を跨いで持ちたいときは
// 呼び出し側で写すこと。
let _dabs = new Float32Array(256 * DAB_STRIDE);
const _out = {
  dabs: _dabs, count: 0, stride: DAB_STRIDE,
  step: 0, advance: 0, truncated: false, scattered: 0,
};

const _bt = V3.create();   // 接平面の基底 1
const _bb = V3.create();   // 接平面の基底 2
const _bn = V3.create();

function ensureDabs(n) {
  if (_dabs.length >= n * DAB_STRIDE) return;
  _dabs = new Float32Array(Math.max(256, n) * DAB_STRIDE);
  _out.dabs = _dabs;
}

/**
 * ctx.tangent / bitangent が来ていればそれを使う。無ければ法線から、
 * それも無ければ進行方向から作る。スプレーの散らしと回転はこの基底の上で決まるので、
 * 呼び出し側が毎ダブ同じ基底を渡す限りミラー間でも結果が一致する。
 */
function makeBasis(ctx, dx, dy, dz, dist) {
  // 長さ 0 の基底や NaN 入りの基底を信じると、散らしが 1 次元に潰れる
  // （法線が 0 だと cross が 0 ベクトルになる）か、全ダブが NaN になる。
  // 潰れた面や孤立頂点の法線は実際に 0 になり得るので、使えないと分かったら
  // 黙って次の作り方に落とす。lenSq が NaN / Inf のときも下の比較で弾かれる。
  if (ctx.tangent && ctx.bitangent) {
    const tl = V3.lenSq(ctx.tangent), bl = V3.lenSq(ctx.bitangent);
    if (tl > 1e-20 && tl < Infinity && bl > 1e-20 && bl < Infinity) {
      V3.copy(_bt, ctx.tangent);
      V3.copy(_bb, ctx.bitangent);
      return;
    }
  }
  const nl = ctx.normal ? V3.lenSq(ctx.normal) : 0;
  if (nl > 1e-20 && nl < Infinity) {
    V3.normalize(_bn, ctx.normal);
    if (dist > 1e-12) {
      V3.set(_bt, dx / dist, dy / dist, dz / dist);
      V3.tangential(_bt, _bt, _bn);
      if (V3.lenSq(_bt) < 1e-16) V3.perpendicular(_bt, _bn);
      else V3.normalize(_bt, _bt);
    } else {
      V3.perpendicular(_bt, _bn);
    }
    V3.cross(_bb, _bn, _bt);
    return;
  }
  if (dist > 1e-12) {
    V3.set(_bt, dx / dist, dy / dist, dz / dist);
    V3.perpendicular(_bb, _bt);
  } else {
    V3.set(_bt, 1, 0, 0);
    V3.set(_bb, 0, 1, 0);
  }
}

/**
 * 1 区間ぶんのダブの撒き方を決める。
 *
 * @param {string} strokeId
 * @param {object} ctx
 *   from      : ArrayLike(3) 前回のダブ位置（dragRect では押した点）
 *   to        : ArrayLike(3) 現在のカーソル位置
 *   radius    : number ブラシ半径（world）
 *   spacing   : number ダブ間隔（半径に対する割合）。省略でタイプの既定値
 *   scatter   : number 散らす量（半径に対する割合）
 *   sizeJitter: number 大きさの揺らぎ 0..1
 *   colorJitter: number 色の揺らぎ 0..1
 *   seed      : number ストロークごとの整数シード
 *   dabIndex  : number ストローク内の通し番号（揺らぎの位相に使う）
 *   normal / tangent / bitangent : 散らす平面（省略時は進行方向から作る）
 *   maxDabs   : number 1 回で返す上限（既定 256、MAX_DABS で頭打ち）
 * @returns {{dabs: Float32Array, count: number, stride: number,
 *            step: number, advance: number, truncated: boolean, scattered: number}}
 *   dabs      : (x, y, z, scaleMul, rotation, colorJitter) × count
 *   step      : 実際に使ったダブ間隔（world）。dragRect ではドラッグ長
 *   advance   : from をどこまで進めてよいか。端数は次回に持ち越す
 *   truncated : maxDabs で打ち切ったか（UI に「間隔が細かすぎる」と出せる）
 *   scattered : 散らしたダブの数（統計表示用）
 */
export function planDabs(strokeId, ctx) {
  const S = STROKE_BY_ID.get(strokeId) || STROKE_BY_ID.get(DEFAULT_STROKE);
  const def = S.def;
  const R = ctx.radius > 0 ? ctx.radius : 1e-6;
  const from = ctx.from, to = ctx.to;
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // from / to に NaN（レイが外れたときの逆投影など）が混ざると dist が NaN になり、
  // dist < step の比較が false 側に落ちて count と advance が NaN のまま外へ出る。
  // advance は呼び出し側のストローク位置に足し込まれるので、一度 NaN を返すと
  // そのストロークが二度と復帰しない。ここで「動いていない」に丸めて閉じる。
  if (!(dist > 0)) dist = 0;

  _out.count = 0; _out.step = 0; _out.advance = 0;
  _out.truncated = false; _out.scattered = 0;

  makeBasis(ctx, dx, dy, dz, dist);
  const tx = _bt[0], ty = _bt[1], tz = _bt[2];
  const bx = _bb[0], by = _bb[1], bz = _bb[2];

  // 進行方向を接平面上の角度に直す（アルファをストロークに沿わせるため）
  let align = 0;
  if (def.align && dist > 1e-12) {
    align = Math.atan2(dx * bx + dy * by + dz * bz, dx * tx + dy * ty + dz * tz);
  }

  // --- ドラッグ 1 個ぶんのスタンプ ---------------------------------------
  if (S.id === 'dragRect') {
    ensureDabs(1);
    const d = _dabs;
    d[0] = from[0]; d[1] = from[1]; d[2] = from[2];
    d[3] = Math.max(0.05, dist / R);     // 引いた長さがそのままスタンプ半径になる
    d[4] = align;
    d[5] = 0;
    _out.count = 1;
    _out.step = dist;
    _out.advance = 0;                    // アンカーは動かさない
    return _out;
  }

  // --- 距離で刻むタイプ ---------------------------------------------------
  const spacing = ctx.spacing > 0 ? ctx.spacing : def.spacing;
  const step = Math.max(R * spacing, 1e-6);
  _out.step = step;
  if (dist < step) return _out;

  // 上限は整数に丸めてから使う。小数のままだと ensureDabs が非整数長の
  // Float32Array を作ろうとして RangeError になり、count も小数になる。
  // さらに MAX_DABS で頭を押さえる。異常な値が来ても数百 MB のスクラッチを
  // 掴んで離さない事故にしないため（打ち切りぶんは truncated で次回に回る）。
  let maxDabs = ctx.maxDabs > 0 ? Math.floor(ctx.maxDabs) : 256;
  if (maxDabs > MAX_DABS) maxDabs = MAX_DABS;
  // radius * spacing は割り切れないことが多く、素の floor だと
  // 「1.0 / (0.1*0.2) = 49.99999999999999」で最後の 1 本が落ちる。
  // 設定した間隔どおりの本数を返したいので丸め誤差ぶんだけ許す。
  let n = Math.floor(dist / step + 1e-9);
  if (n > maxDabs) { n = maxDabs; _out.truncated = true; }
  ensureDabs(n);

  const scatter = ctx.scatter !== undefined ? ctx.scatter : def.scatter;
  const sizeJit = ctx.sizeJitter !== undefined ? ctx.sizeJitter : def.sizeJitter;
  const colJit = ctx.colorJitter !== undefined ? ctx.colorJitter : def.colorJitter;
  const spin = def.spin;
  const seed = (ctx.seed | 0);
  const base = (ctx.dabIndex | 0);
  const ux = dist > 0 ? dx / dist : 0, uy = dist > 0 ? dy / dist : 0, uz = dist > 0 ? dz / dist : 0;
  const fx = from[0], fy = from[1], fz = from[2];
  const d = _dabs;

  let scattered = 0;
  for (let k = 0; k < n; k++) {
    const t = step * (k + 1);
    let px = fx + ux * t, py = fy + uy * t, pz = fz + uz * t;
    let scaleMul = 1, rot = align, cj = 0;

    if (scatter > 0 || sizeJit > 0 || colJit > 0 || spin) {
      // ハッシュのキーは (seed, 通し番号) だけ。時間や乱数状態に依存しないので
      // アンドゥ→リドゥでも、シンメトリの各ミラーでも同じ絵になる。
      const gi = (base + k) * 8;
      if (scatter > 0) {
        // sqrt で円板上に一様に散らす（中心に寄りすぎない）
        const rr = Math.sqrt(hash1(seed, gi)) * scatter * R;
        const aa = hash1(seed, gi + 1) * TAU;
        const ca = Math.cos(aa) * rr, sa = Math.sin(aa) * rr;
        px += tx * ca + bx * sa;
        py += ty * ca + by * sa;
        pz += tz * ca + bz * sa;
        if (rr > 0) scattered++;
      }
      // sizeJitter を 1 近くまで上げると素の式は 0 倍を返し得る。半径 0 のダブは
      // 呼び出し側の dist / radius が 0/0 になって NaN を生むので、dragRect と
      // 同じ下限で止める（既定の 0.45 では下限に当たらない）。
      if (sizeJit > 0) {
        const m = 1 + (hash1(seed, gi + 2) * 2 - 1) * clamp(sizeJit, 0, 1);
        scaleMul = m > 0.05 ? m : 0.05;
      }
      if (spin) rot = hash1(seed, gi + 3) * TAU;
      if (colJit > 0) cj = (hash1(seed, gi + 4) * 2 - 1) * clamp(colJit, 0, 1);
    }

    const o = k * DAB_STRIDE;
    d[o] = px; d[o + 1] = py; d[o + 2] = pz;
    d[o + 3] = scaleMul; d[o + 4] = rot; d[o + 5] = cj;
  }

  _out.count = n;
  _out.advance = step * n < dist ? step * n : dist;
  _out.scattered = scattered;
  return _out;
}
