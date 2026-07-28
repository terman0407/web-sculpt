// ---------------------------------------------------------------------------
// deform.js
// ZBrush の Deformation パレット相当。メッシュ全体（マスクされていない部分）を
// 選択軸に沿って一括変形する。
//
// 設計上のポイント:
//  * すべての変形を「バウンディングボックスで正規化した t ∈ -1..1 に対する写像」
//    として書く。モデルの大きさ・位置・向きに依らず同じスライダー値が同じ
//    見た目の効果になるので、UI 側でモデルごとに係数を調整しなくて済む。
//  * 適用は破壊的。ZBrush と同じくスライダーを 0 に戻しても形は戻らず、Undo で戻す。
//    履歴の commit は呼び出し側（Sculptor.history）の責任なので、ここでは触らない。
//  * マスクは「変形後の目標位置とのブレンド率」として一律に扱う。
//    weight = 1 - mask なので mask=1 の頂点は 1 ビットも動かない
//    （ブラシ側の f *= (1 - mask) と同じ規約）。
//  * トポロジは一切変えない。頂点数・三角形・ring はそのままなので、
//    分割レベル（SubdivLevels）を破棄する必要がない。
// ---------------------------------------------------------------------------

import { clamp } from './math.js';

/**
 * UI がスライダーを自動生成するためのメタデータ。
 *   axis   : 軸選択 UI（X/Y/Z）を出すかどうか
 *   params : そのまま <input type=range> にできる形（step も入れてある）
 * 既定値は「ボタンを押したら効果が分かる」量にしてある（0 だと何も起きない）。
 */
export const DEFORMS = [
  {
    id: 'taper', jp: 'テーパー', name: 'Taper',
    hint: '軸に沿って先細りさせる。+ で軸の + 側が太り − 側が細くなる',
    axis: true,
    params: [{ key: 'amount', jp: '量', min: -1, max: 1, def: 0.5, step: 0.01 }],
  },
  {
    id: 'twist', jp: 'ツイスト', name: 'Twist',
    hint: '軸まわりに捻る。軸の両端で ±指定角ぶん回る',
    axis: true,
    params: [{ key: 'amount', jp: '角度（度）', min: -720, max: 720, def: 90, step: 1 }],
  },
  {
    id: 'bend', jp: 'ベンド', name: 'Bend',
    hint: '軸に沿って円弧に巻きつけて曲げる。中央の断面は動かない',
    axis: true,
    params: [{ key: 'amount', jp: '角度（度）', min: -180, max: 180, def: 60, step: 1 }],
  },
  {
    id: 'inflate', jp: 'インフレート', name: 'Inflate',
    hint: '各頂点の法線方向に膨張／収縮させる（軸に依存しない）',
    axis: false,
    params: [{ key: 'amount', jp: '量', min: -0.5, max: 0.5, def: 0.06, step: 0.005 }],
  },
  {
    id: 'spherize', jp: 'スフィアライズ', name: 'Spherize',
    hint: 'バウンディング球へ寄せる。1 で完全な球になる',
    axis: false,
    params: [{ key: 'amount', jp: 'ブレンド', min: 0, max: 1, def: 0.5, step: 0.01 }],
  },
  {
    id: 'flattenAxis', jp: 'フラット化', name: 'Flatten',
    hint: '指定軸の座標を中央へ潰す。1 で完全な平面になる',
    axis: true,
    params: [{ key: 'amount', jp: '量', min: 0, max: 1, def: 0.5, step: 0.01 }],
  },
  {
    id: 'stretch', jp: 'ストレッチ', name: 'Stretch',
    hint: '指定軸方向に伸縮する。+1 で 2 倍、−0.5 で半分',
    axis: true,
    params: [{ key: 'amount', jp: '量', min: -0.9, max: 3, def: 0.3, step: 0.01 }],
  },
  {
    id: 'noise', jp: 'ノイズ', name: 'Noise',
    hint: '法線方向に決定論的なノイズを乗せる。同じ設定なら必ず同じ結果',
    axis: false,
    params: [
      { key: 'amount', jp: '強さ', min: -0.3, max: 0.3, def: 0.04, step: 0.002 },
      { key: 'scale', jp: '細かさ', min: 0.5, max: 32, def: 6, step: 0.5 },
    ],
  },
  {
    id: 'smoothAll', jp: 'スムーズ（全体）', name: 'Smooth All',
    hint: '全体を 1-ring 平均で平滑化する。反復するほど滑らかで小さくなる',
    axis: false,
    params: [
      { key: 'amount', jp: '量', min: 0, max: 1, def: 0.5, step: 0.01 },
      { key: 'iterations', jp: '反復', min: 1, max: 20, def: 3, step: 1 },
    ],
  },
];

export const DEFORM_IDS = DEFORMS.map(d => d.id);
export const DEFORM_BY_ID = new Map(DEFORMS.map(d => [d.id, d]));

/** その変形の既定オプション（UI の初期値・applyDeform への素の引数に使える） */
export function defaultOpts(id) {
  const d = DEFORM_BY_ID.get(id);
  if (!d) return null;
  const o = { axis: 1 };                       // Y は人体・柱状のモデルで最も使う軸
  for (let i = 0; i < d.params.length; i++) o[d.params[i].key] = d.params[i].def;
  return o;
}

// ---------------------------------------------------------------------------
// 共通の下準備
// ---------------------------------------------------------------------------

/**
 * スライダー値の解決。UI から undefined / NaN（空欄）/ 範囲外が来ても
 * 既定値と min/max で挟み込む。ここで弾かないと 1 頂点が NaN になった時点で
 * 法線計算を通じて全体に伝播し、モデルが画面から消える。
 */
function param(def, key, opts) {
  const ps = def.params;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.key !== key) continue;
    const v = opts[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return p.def;
    return clamp(v, p.min, p.max);
  }
  return 0;
}

/**
 * 軸・中心・正規化スケールを決める。
 * 中心は既定でバウンディングボックス中心、opts.center で上書きできる。
 */
function resolve(mesh, def, opts) {
  const bb = mesh.bounds();
  const a = (opts.axis === 0 || opts.axis === 1 || opts.axis === 2) ? opts.axis : 1;
  const c = (opts.center && opts.center.length >= 3) ? opts.center : bb.center;
  return {
    a,
    au: (a + 1) % 3,          // 断面を張る 2 軸（右手系の巡回順）
    av: (a + 2) % 3,
    cen: [c[0], c[1], c[2]],
    // 軸方向の半幅。潰れたモデル（平面など）で 0 割りしないよう下限を置く
    half: Math.max(1e-6, (bb.max[a] - bb.min[a]) * 0.5),
    unit: bb.radius,          // 長さの基準（法線変位・ノイズ周波数をスケール不変にする）
    amount: param(def, 'amount', opts),
    scale: param(def, 'scale', opts),
    iterations: Math.max(1, Math.round(param(def, 'iterations', opts))),
    bb,
  };
}

// ---------------------------------------------------------------------------
// 決定論的ノイズ
// ---------------------------------------------------------------------------

// Math.random は使わない。座標から決まる整数ハッシュにすることで、
// 同じメッシュ・同じ設定なら必ず同じ結果になる（Undo → 再適用でぶれない）。
// 乗算はすべて Math.imul で 32bit に閉じる（浮動小数の精度落ちで
// ハッシュが崩れるのを防ぐ）。
function hash31(ix, iy, iz) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 格子値ノイズ（-1..1）。頂点ごとの純粋なハッシュだと紙やすり状の白色雑音に
// なってしまい「細かさ」を制御できないので、整数格子の値を smoothstep で
// 補間して空間周波数を持たせている。
function valueNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const c000 = hash31(ix, iy, iz), c100 = hash31(ix + 1, iy, iz);
  const c010 = hash31(ix, iy + 1, iz), c110 = hash31(ix + 1, iy + 1, iz);
  const c001 = hash31(ix, iy, iz + 1), c101 = hash31(ix + 1, iy, iz + 1);
  const c011 = hash31(ix, iy + 1, iz + 1), c111 = hash31(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * ux, x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux, x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy, y1 = x01 + (x11 - x01) * uy;
  return (y0 + (y1 - y0) * uz) * 2 - 1;
}

// ---------------------------------------------------------------------------
// 各変形。すべて同じ骨格:
//   生存頂点だけ走査 → 目標位置を求める → weight でブレンド →
//   非有限なら捨てる → 書き戻す → 実際に動いた数を数える
// ホットループなので this / mesh へのプロパティ読みは全部ループ外へ退避する。
//
// 「動いた」の判定は必ず *書き戻したあとの* Float32Array と比べる。計算途中の値は
// double なので、float32 の 1 ULP に届かない変位（微小な amount、あるいは中心を
// double で渡されたときの桁落ち）でも「≠」になってしまい、実際には 1 ビットも
// 変わっていないのに changed > 0 になる。そうなると applyDeform が全体の
// 法線・曲率を作り直し（数百万頂点で 100ms 級）、geomVersion まで進めてしまう。
// ---------------------------------------------------------------------------

function taper(mesh, o, st) {
  const P = mesh.positions, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv;
  const a = o.a, au = o.au, av = o.av;
  const ca = o.cen[a], cu = o.cen[au], cv = o.cen[av];
  const invHalf = 1 / o.half, amount = o.amount;
  let changed = 0, masked = 0, skipped = 0;
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const w = 1 - clamp(MK[i], 0, 1);
    if (w <= 0) { masked++; continue; }
    const b = i * 3;
    let t = (P[b + a] - ca) * invHalf;
    t = t < -1 ? -1 : (t > 1 ? 1 : t);       // 中心を外に置いても暴走させない
    let s = 1 + amount * t;
    if (s < 0) s = 0;                        // 断面が反転して裏返るのを防ぐ
    const pu = P[b + au], pv = P[b + av];
    const nu = pu + ((cu + (pu - cu) * s) - pu) * w;
    const nvv = pv + ((cv + (pv - cv) * s) - pv) * w;
    if (!Number.isFinite(nu) || !Number.isFinite(nvv)) { skipped++; continue; }
    P[b + au] = nu; P[b + av] = nvv;
    if (P[b + au] !== pu || P[b + av] !== pv) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

function twist(mesh, o, st) {
  const P = mesh.positions, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv;
  const a = o.a, au = o.au, av = o.av;
  const ca = o.cen[a], cu = o.cen[au], cv = o.cen[av];
  const invHalf = 1 / o.half;
  const maxAng = o.amount * Math.PI / 180;
  let changed = 0, masked = 0, skipped = 0;
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const w = 1 - clamp(MK[i], 0, 1);
    if (w <= 0) { masked++; continue; }
    const b = i * 3;
    let t = (P[b + a] - ca) * invHalf;
    t = t < -1 ? -1 : (t > 1 ? 1 : t);
    // 回転角そのものに weight を掛ける。位置の線形補間では回転が弦になって
    // 半分マスクされた頂点が軸へ寄ってしまうため（回転は等長でなくなる）。
    const ang = maxAng * t * w;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const pu = P[b + au], pv = P[b + av];
    const du = pu - cu, dv = pv - cv;
    const nu = cu + du * cs - dv * sn;
    const nvv = cv + du * sn + dv * cs;
    if (!Number.isFinite(nu) || !Number.isFinite(nvv)) { skipped++; continue; }
    P[b + au] = nu; P[b + av] = nvv;
    if (P[b + au] !== pu || P[b + av] !== pv) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

// 軸に沿った直線を半径 R の円弧に巻きつける。t=0（中央）の断面は不動点になり、
// 角度 0 で厳密に恒等写像になる形にしてある（amount を小さくすれば連続的に効く）。
function bend(mesh, o, st) {
  const P = mesh.positions, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv;
  const a = o.a, au = o.au, av = o.av;
  const ca = o.cen[a], cu = o.cen[au];
  const half = o.half, invHalf = 1 / half;
  const total = o.amount * Math.PI / 180;
  let changed = 0, masked = 0, skipped = 0;
  if (Math.abs(total) < 1e-9) { st.changed = 0; st.masked = 0; st.skipped = 0; return; }
  const R = half / total;                    // 曲率半径（total の符号で曲がる向きが決まる）
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const w = 1 - clamp(MK[i], 0, 1);
    if (w <= 0) { masked++; continue; }
    const b = i * 3;
    const pa = P[b + a], pu = P[b + au];
    let t = (pa - ca) * invHalf;
    t = t < -1 ? -1 : (t > 1 ? 1 : t);
    const ang = total * t;
    const arm = R - (pu - cu);
    const ta = ca + arm * Math.sin(ang);
    const tu = cu + R - arm * Math.cos(ang);
    const na = pa + (ta - pa) * w;
    const nu = pu + (tu - pu) * w;
    if (!Number.isFinite(na) || !Number.isFinite(nu)) { skipped++; continue; }
    P[b + a] = na; P[b + au] = nu;
    if (P[b + a] !== pa || P[b + au] !== pu) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

function inflate(mesh, o, st) {
  const P = mesh.positions, N = mesh.normals, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv;
  const amp = o.amount * o.unit;             // モデルの大きさに比例させてスケール不変に
  let changed = 0, masked = 0, skipped = 0;
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const w = 1 - clamp(MK[i], 0, 1);
    if (w <= 0) { masked++; continue; }
    const b = i * 3;
    const d = amp * w;
    const px = P[b], py = P[b + 1], pz = P[b + 2];
    const nx = px + N[b] * d, ny = py + N[b + 1] * d, nz = pz + N[b + 2] * d;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) { skipped++; continue; }
    P[b] = nx; P[b + 1] = ny; P[b + 2] = nz;
    if (P[b] !== px || P[b + 1] !== py || P[b + 2] !== pz) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

// 半径にはバウンディング球の半径ではなく中心からの平均距離を使う。
// 半対角線を使うと立方体のような形が一気に膨れ上がって「球へ寄せた」感じに
// ならないため、体積がだいたい保たれるほうを取った。
function spherize(mesh, o, st) {
  const P = mesh.positions, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv;
  const cx = o.cen[0], cy = o.cen[1], cz = o.cen[2];
  const amount = o.amount;
  let sum = 0, cnt = 0;
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const b = i * 3;
    const dx = P[b] - cx, dy = P[b + 1] - cy, dz = P[b + 2] - cz;
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz); cnt++;
  }
  const R = cnt > 0 ? sum / cnt : o.unit;
  let changed = 0, masked = 0, skipped = 0;
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const w = 1 - clamp(MK[i], 0, 1);
    if (w <= 0) { masked++; continue; }
    const b = i * 3;
    const px = P[b], py = P[b + 1], pz = P[b + 2];
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-12) continue;                 // 中心と一致 → 寄せる向きが決まらない
    const s = (R / d - 1) * amount * w;
    const nx = px + dx * s, ny = py + dy * s, nz = pz + dz * s;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) { skipped++; continue; }
    P[b] = nx; P[b + 1] = ny; P[b + 2] = nz;
    if (P[b] !== px || P[b + 1] !== py || P[b + 2] !== pz) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

function flattenAxis(mesh, o, st) {
  const P = mesh.positions, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv;
  const a = o.a, ca = o.cen[a], amount = o.amount;
  let changed = 0, masked = 0, skipped = 0;
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const w = 1 - clamp(MK[i], 0, 1);
    if (w <= 0) { masked++; continue; }
    const b = i * 3;
    const pa = P[b + a];
    const na = pa + (ca - pa) * amount * w;
    if (!Number.isFinite(na)) { skipped++; continue; }
    P[b + a] = na;
    if (P[b + a] !== pa) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

function stretch(mesh, o, st) {
  const P = mesh.positions, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv;
  const a = o.a, ca = o.cen[a];
  let f = 1 + o.amount;
  if (f < 0) f = 0;                          // 負の倍率で裏返さない
  let changed = 0, masked = 0, skipped = 0;
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const w = 1 - clamp(MK[i], 0, 1);
    if (w <= 0) { masked++; continue; }
    const b = i * 3;
    const pa = P[b + a];
    const na = pa + ((ca + (pa - ca) * f) - pa) * w;
    if (!Number.isFinite(na)) { skipped++; continue; }
    P[b + a] = na;
    if (P[b + a] !== pa) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

function noise(mesh, o, st) {
  const P = mesh.positions, N = mesh.normals, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv;
  const cx = o.cen[0], cy = o.cen[1], cz = o.cen[2];
  const freq = o.scale / o.unit;             // 「モデル半径あたり何山」
  const amp = o.amount * o.unit;
  let changed = 0, masked = 0, skipped = 0;
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    const w = 1 - clamp(MK[i], 0, 1);
    if (w <= 0) { masked++; continue; }
    const b = i * 3;
    const px = P[b], py = P[b + 1], pz = P[b + 2];
    const gx = (px - cx) * freq, gy = (py - cy) * freq, gz = (pz - cz) * freq;
    // 2 オクターブ。1 オクターブだと粘土を握った程度の大きな凹凸しか出ず
    // 「ノイズ」に見えないため、倍の周波数を半分の振幅で足している。
    const n1 = valueNoise(gx, gy, gz);
    const n2 = valueNoise(gx * 2.017 + 19.31, gy * 2.017 - 7.77, gz * 2.017 + 3.53);
    const d = (n1 + n2 * 0.5) * (1 / 1.5) * amp * w;
    const nx = px + N[b] * d, ny = py + N[b + 1] * d, nz = pz + N[b + 2] * d;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) { skipped++; continue; }
    P[b] = nx; P[b + 1] = ny; P[b + 2] = nz;
    if (P[b] !== px || P[b + 1] !== py || P[b + 2] !== pz) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

// 1-ring 平均のヤコビ反復。ring[] を頂点ごとに辿るのではなく三角形を 1 回
// 走査して隣接和を積む（mesh.computeAllCurvature と同じ方針）。配列の間接参照が
// 消えるので数百万頂点でも実用的な速度になる。
// スクラッチはモジュールに残して使い回す。毎回 nv*4 バイト × 4 本を確保すると
// パレットを触るたびに数十 MB の GC を起こすため。
let _smSum = new Float32Array(0);
let _smCnt = new Float32Array(0);
let _smOrig = new Float32Array(0);

function smoothAll(mesh, o, st) {
  const P = mesh.positions, T = mesh.tris, A = mesh.vAlive, MK = mesh.mask;
  const nv = mesh.nv, nt = mesh.nt;
  const amount = o.amount, iters = o.iterations;
  if (_smSum.length < nv * 3) {
    _smSum = new Float32Array(nv * 3);
    _smCnt = new Float32Array(nv);
    _smOrig = new Float32Array(nv * 3);
  }
  const S = _smSum, C = _smCnt;
  let changed = 0, masked = 0, skipped = 0;
  // 「動いたか」は開始時との比較で数える（反復の途中で元の位置に戻る頂点もある）
  const before = _smOrig;
  before.set(P.subarray(0, nv * 3));
  for (let it = 0; it < iters; it++) {
    S.fill(0, 0, nv * 3); C.fill(0, 0, nv);
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const ia = T[i], ib = T[i + 1], ic = T[i + 2];
      if (ia === ib && ib === ic) continue;   // 退化 = 削除済み
      const a = ia * 3, b = ib * 3, c = ic * 3;
      S[a] += P[b] + P[c]; S[a + 1] += P[b + 1] + P[c + 1]; S[a + 2] += P[b + 2] + P[c + 2];
      S[b] += P[c] + P[a]; S[b + 1] += P[c + 1] + P[a + 1]; S[b + 2] += P[c + 2] + P[a + 2];
      S[c] += P[a] + P[b]; S[c + 1] += P[a + 1] + P[b + 1]; S[c + 2] += P[a + 2] + P[b + 2];
      C[ia] += 2; C[ib] += 2; C[ic] += 2;
    }
    for (let i = 0; i < nv; i++) {
      if (A[i] === 0) continue;
      const cnt = C[i];
      if (cnt === 0) continue;               // 孤立頂点は平均が取れない
      const k = amount * (1 - clamp(MK[i], 0, 1));
      if (k <= 0) continue;
      const b = i * 3, inv = 1 / cnt;
      const nx = P[b] + (S[b] * inv - P[b]) * k;
      const ny = P[b + 1] + (S[b + 1] * inv - P[b + 1]) * k;
      const nz = P[b + 2] + (S[b + 2] * inv - P[b + 2]) * k;
      if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) continue;
      P[b] = nx; P[b + 1] = ny; P[b + 2] = nz;
    }
  }
  for (let i = 0; i < nv; i++) {
    if (A[i] === 0) continue;
    if (1 - clamp(MK[i], 0, 1) <= 0) { masked++; continue; }
    const b = i * 3;
    const x = P[b], y = P[b + 1], z = P[b + 2];
    // 巻き戻しを先にやる。あとで数えると「棄却したのに動いた」と二重に報告され、
    // 元から NaN が入っていた頂点（NaN !== NaN）まで changed に入ってしまう。
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      P[b] = before[b]; P[b + 1] = before[b + 1]; P[b + 2] = before[b + 2];
      skipped++;
      continue;
    }
    if (x !== before[b] || y !== before[b + 1] || z !== before[b + 2]) changed++;
  }
  st.changed = changed; st.masked = masked; st.skipped = skipped;
}

const IMPL = {
  taper, twist, bend, inflate, spherize, flattenAxis, stretch, noise, smoothAll,
};

// ---------------------------------------------------------------------------

/**
 * 変形を 1 回適用する（破壊的）。履歴の commit は呼び出し側で行う。
 *
 * @param {SculptMesh} mesh
 * @param {string} id   DEFORMS の id
 * @param {object} [opts]
 *   axis       : 0|1|2 (X/Y/Z、既定 1)。DEFORMS[].axis が false の変形は無視される
 *   amount     : 主パラメータ（意味は変形ごと。DEFORMS のメタデータ参照）
 *   scale      : noise の細かさ
 *   iterations : smoothAll の反復回数
 *   center     : [x,y,z] 変形の中心（既定はバウンディングボックス中心）
 * @returns {{id:string, ok:boolean, changed:number, verts:number, masked:number,
 *            skipped:number, axis:number, ms:number}}
 *   changed = 実際に座標が動いた頂点数 / masked = mask=1 で保護された頂点数 /
 *   skipped = 計算結果が非有限で棄却した頂点数（通常 0）
 */
export function applyDeform(mesh, id, opts = {}) {
  const t0 = performance.now();
  const def = DEFORM_BY_ID.get(id);
  const st = { id, ok: false, changed: 0, verts: mesh ? mesh.liveVerts : 0, masked: 0, skipped: 0, axis: -1, ms: 0 };
  if (!def || !mesh || mesh.nv === 0 || mesh.liveVerts === 0) return st;

  const o = resolve(mesh, def, opts);
  st.ok = true;
  st.axis = def.axis ? o.a : -1;
  IMPL[id](mesh, o, st);

  // 何も動いていないなら全体の法線・曲率を作り直す意味がない
  // （数百万頂点では両方で 100ms 級かかる）。
  if (st.changed > 0) {
    mesh.computeAllNormals();
    mesh.computeAllCurvature();
    mesh.markAllDirty();
    mesh.geomVersion++;
  }
  st.ms = Math.round((performance.now() - t0) * 10) / 10;
  return st;
}
