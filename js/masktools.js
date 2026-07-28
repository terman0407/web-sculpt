// ---------------------------------------------------------------------------
// masktools.js
// ZBrush の Masking パレット相当。mask 配列だけを触るツール群。
//
// 規約: mask[v] は 0..1 で 1 = 完全に保護（動かない）/ 0 = 自由に動く。
// ブラシ側が f *= (1 - mask[v]) を掛けている（brushes.js）ので、ここで作る値も
// 「1 に近いほど守られる」向きで書く。座標・トポロジ・色は一切触らない。
//
// 設計上のポイント:
//  * どれもボタン操作で 1 回だけ呼ばれるが、300 万頂点でも数百 ms で終わらせたい。
//    そのため頂点ごとに ring[] を辿るのはやめ、三角形を 1 回走査して 1-ring 和を
//    積む（mesh.computeAllCurvature と同じ手）。配列間接参照が消えるぶん数倍速い。
//  * 一時配列はモジュールに 1 組だけ持って使い回す。頂点数ぶんの Float32Array を
//    操作ごとに何本も確保すると 300 万頂点で数十 MB のアロケーションが毎回走り、
//    GC で無視できない時間を取られる。
//  * 生成系（maskBy*）は目標値を一時配列に作り、最後に _writeBack が
//    mode（置換/加算/減算）・反転・clamp・NaN 落とし・統計をまとめて処理する。
//    ループが 1 本に集約でき、規約の実装が 1 か所で済む。
// ---------------------------------------------------------------------------

import { clamp } from './math.js';

const DEG = Math.PI / 180;

/** 既存マスクとの合成方法。UI の選択肢としてもそのまま使える */
export const MASK_MODES = [
  { id: 'replace', jp: '置換', hint: '計算した値でマスクを置き換える' },
  { id: 'add', jp: '加算', hint: '既存のマスクに足す（守る範囲を広げる）' },
  { id: 'sub', jp: '減算', hint: '既存のマスクから引く（守る範囲を削る）' },
];

// --- 一時配列 --------------------------------------------------------------
// 内容は毎回書き潰す前提なので、伸ばすときも中身を引き継がない。
// _acc は AO だけが使うので、AO を呼ばないかぎり確保しない。
let _a = new Float32Array(0);      // 目標マスク値 / 拡散の入力
let _b = new Float32Array(0);      // 拡散の出力（ヤコビ法なので入出力は別配列）
let _acc = new Float32Array(0);    // AO の多段積算
let _sum = new Float32Array(0);    // 1-ring 和
let _cnt = new Int32Array(0);      // 1-ring 件数

function _reserve(n) {
  if (_a.length >= n) return;
  const cap = Math.max(1024, n);
  _a = new Float32Array(cap);
  _b = new Float32Array(cap);
  _sum = new Float32Array(cap);
  _cnt = new Int32Array(cap);
}

function _reserveAcc(n) {
  if (_acc.length < n) _acc = new Float32Array(Math.max(1024, n));
}

/** 確保済みの一時配列を解放する（巨大メッシュを閉じた後などに呼ぶ） */
export function releaseScratch() {
  _a = new Float32Array(0);
  _b = new Float32Array(0);
  _acc = new Float32Array(0);
  _sum = new Float32Array(0);
  _cnt = new Int32Array(0);
}

// --- 共通処理 --------------------------------------------------------------

/**
 * 何もしなかったときの統計。masked は「いま実際に保護されている頂点数」を数える。
 * ここで 0 を返すと、長さ 0 の方向を渡した／未知の id を渡したときに UI が
 * 「マスクが全部消えた」と表示してしまう。何もしていないのだから面積は現状のまま。
 */
function _empty(mesh) {
  if (!mesh) return { changed: 0, masked: 0, live: 0 };
  const MK = mesh.mask, A = mesh.vAlive, nv = mesh.nv;
  let masked = 0;
  for (let v = 0; v < nv; v++) if (A[v] !== 0 && MK[v] > 0.5) masked++;
  return { changed: 0, masked, live: mesh.liveVerts };
}

/**
 * src[] の値を mask へ書き戻す。ここが「マスク規約を守る唯一の場所」。
 * NaN を 0 に落としているのは、曲率や法線が壊れた入力でもマスクが 0..1 の外へ
 * 出ないようにするため（各操作でいちいち検査しないための最後の砦）。
 */
function _writeBack(mesh, src, mode, invert) {
  const MK = mesh.mask, A = mesh.vAlive, nv = mesh.nv;
  // mode の分岐はループ内に置く。3 本のループに分けても分岐予測が当たる
  // 比較 2 回ぶんしか得しないのに、規約の実装が 3 か所に散る。
  const add = mode === 'add', sub = mode === 'sub';
  const inv = !!invert;
  let changed = 0, masked = 0, live = 0;
  for (let v = 0; v < nv; v++) {
    if (A[v] === 0) continue;      // 死んだスロットは触らない（addVertex が初期化する）
    live++;
    const old = MK[v];
    let x = src[v];
    if (!(x >= 0)) x = 0;          // NaN もこの条件で真になる
    else if (x > 1) x = 1;
    if (inv) x = 1 - x;
    if (add || sub) {
      // 既存の値（old）も畳んでから足し引きする。既存マスクに壊れた値が混ざって
      // いると NaN ± x = NaN になり、下の clamp は比較が全部偽になるので
      // そのまますり抜けてしまう。壊れた値は「マスクされていない」と見なす。
      const o = old > 0 ? (old > 1 ? 1 : old) : 0;
      x = add ? o + x : o - x;
    }
    // 最初の比較を否定形にしておくと、万一 NaN が来ても 0 に落ちる（費用は同じ）
    if (!(x > 0)) x = 0; else if (x > 1) x = 1;
    if (x !== old) changed++;
    MK[v] = x;
    if (x > 0.5) masked++;
  }
  mesh.markAllDirty();             // マスクは色として GPU へ行く
  return { changed, masked, live };
}

/** 全生存頂点を定数にする（clear / maskAll 用の直書き経路） */
function _fillConst(mesh, value) {
  const MK = mesh.mask, A = mesh.vAlive, nv = mesh.nv;
  let changed = 0;
  for (let v = 0; v < nv; v++) {
    if (A[v] === 0) continue;
    if (MK[v] !== value) { MK[v] = value; changed++; }
  }
  mesh.markAllDirty();
  const live = mesh.liveVerts;
  return { changed, masked: value > 0.5 ? live : 0, live };
}

/**
 * src[] の 1-ring 和と件数を _sum / _cnt に積む。
 * 内部辺を共有する近傍は 2 回数えられるが、和を件数で割るので平均は変わらない。
 * 境界辺の向こう側だけ 1 回になるので、開いたメッシュの縁ではわずかに
 * 自分寄りの重みになる（mesh.computeAllCurvature と同じ性質。陰影・マスク用途では問題ない）。
 */
function _ringSums(mesh, src) {
  const nv = mesh.nv, nt = mesh.nt, T = mesh.tris;
  const S = _sum, C = _cnt;
  S.fill(0, 0, nv); C.fill(0, 0, nv);
  for (let t = 0; t < nt; t++) {
    const i = t * 3;
    const a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;   // 削除済みの退化三角形
    const sa = src[a], sb = src[b], sc = src[c];
    S[a] += sb + sc; S[b] += sc + sa; S[c] += sa + sb;
    C[a] += 2; C[b] += 2; C[c] += 2;
  }
}

/**
 * dst = src + (1-ring 平均 − src) * lambda。src と dst は別配列でなければならない。
 * lambda = 1 でちょうど 1-ring 平均になる。
 */
function _ringMix(mesh, src, dst, lambda) {
  _ringSums(mesh, src);
  const nv = mesh.nv, S = _sum, C = _cnt;
  for (let v = 0; v < nv; v++) {
    const c = C[v];
    const x = src[v];
    dst[v] = c === 0 ? x : x + (S[v] / c - x) * lambda;
  }
}

/**
 * 1-ring 最大値への置き換え（モルフォロジー膨張）。src と dst は別配列。
 * 三角形の 3 頂点は互いに 1-ring なので、面を 1 回舐めるだけで全方向に配れる。
 */
function _dilate(mesh, src, dst) {
  const nv = mesh.nv, nt = mesh.nt, T = mesh.tris;
  for (let v = 0; v < nv; v++) dst[v] = src[v];
  for (let t = 0; t < nt; t++) {
    const i = t * 3;
    const a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    const sa = src[a], sb = src[b], sc = src[c];
    let m = dst[a];
    if (sb > m) m = sb;
    if (sc > m) m = sc;
    dst[a] = m;
    m = dst[b];
    if (sc > m) m = sc;
    if (sa > m) m = sa;
    dst[b] = m;
    m = dst[c];
    if (sa > m) m = sa;
    if (sb > m) m = sb;
    dst[c] = m;
  }
}

/**
 * mask を dst に写す（生存判定は _writeBack でやるのでここでは全スロット写す）。
 *
 * 写しながら 0..1 へ畳み NaN を 0 にしている。_writeBack にも同じ砦があるが、
 * それだけでは足りない: 壊れた値が 1 個混ざったマスクを 1-ring 拡散に通すと
 * NaN が近傍へ広がり、最後に _writeBack がまとめて 0 に落とすので
 * 「1 個の壊れた値で広い範囲のマスクが黙って消える」ことになる。入口で止める。
 * （マスクは保存ファイルや他のモジュール経由で外から入ってくる）
 *
 * complement = true なら 1 − 値を書く。収縮が膨張のコードを使い回すのに要る。
 * 分岐はループの外に出しておく。
 */
function _loadMask(mesh, dst, complement = false) {
  const MK = mesh.mask, nv = mesh.nv;
  if (complement) {
    for (let v = 0; v < nv; v++) { const x = MK[v]; dst[v] = x > 0 ? (x > 1 ? 0 : 1 - x) : 1; }
  } else {
    for (let v = 0; v < nv; v++) { const x = MK[v]; dst[v] = x > 0 ? (x > 1 ? 1 : x) : 0; }
  }
}

// ---------------------------------------------------------------------------
// 基本操作
// ---------------------------------------------------------------------------

export function clearMask(mesh) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  return _fillConst(mesh, 0);
}

export function maskAll(mesh) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  return _fillConst(mesh, 1);
}

export function invertMask(mesh) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const MK = mesh.mask, A = mesh.vAlive, nv = mesh.nv;
  let changed = 0, masked = 0, live = 0;
  for (let v = 0; v < nv; v++) {
    if (A[v] === 0) continue;
    live++;
    const old = MK[v];
    // 入力が 0..1 の外に出ている（外部データを読み込んだ直後など）場合も
    // ここで畳んでおく。1 - x を先にやると符号が残ってしまう。
    // NaN も畳むこと: 1 - NaN は NaN のままで、そのマスクを持つ頂点は
    // ブラシ側の f *= (1 - mask) が NaN になって座標が壊れる。
    // この比較の向きなら NaN は「> 0 が偽」で 0 に落ちる。
    const c = old > 0 ? (old > 1 ? 1 : old) : 0;
    const x = 1 - c;
    if (x !== old) changed++;
    MK[v] = x;
    if (x > 0.5) masked++;
  }
  mesh.markAllDirty();
  return { changed, masked, live };
}

/**
 * 1-ring 平均でぼかす（ZBrush の Blur Mask）。
 * mode は取らない。ぼかしは「既存マスクの変換」であって新しい領域を作る操作では
 * ないので、加算すると端が一方的に太るだけで意味を持たない。
 */
export function blurMask(mesh, iterations = 1, opts = {}) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  _reserve(nv);
  const it = clamp(Math.round(iterations || 1), 1, 64);
  // lambda = 1（純粋な 1-ring 平均）は二部グラフ的な並びで振動するので、
  // 既定は 0.7 に落として単調に減衰させる。
  const lambda = opts.amount !== undefined ? clamp(opts.amount, 0, 1) : 0.7;
  let src = _a, dst = _b;
  _loadMask(mesh, src);
  for (let k = 0; k < it; k++) {
    _ringMix(mesh, src, dst, lambda);
    const t = src; src = dst; dst = t;
  }
  return _writeBack(mesh, src, 'replace', false);
}

/**
 * ぼかしの逆（アンシャープ）。1-ring 平均との差を足し戻して境界を立てる。
 * 反復ごとに 0..1 へ畳んでいるのは、差の増幅が発散するのを防ぐため。
 */
export function sharpenMask(mesh, iterations = 1, opts = {}) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  _reserve(nv);
  const it = clamp(Math.round(iterations || 1), 1, 64);
  const amount = opts.amount !== undefined ? clamp(opts.amount, 0, 4) : 0.8;
  const src = _a, avg = _b;
  _loadMask(mesh, src);
  for (let k = 0; k < it; k++) {
    _ringMix(mesh, src, avg, 1);         // avg = 1-ring 平均
    for (let v = 0; v < nv; v++) {
      const x = src[v] + (src[v] - avg[v]) * amount;
      src[v] = x < 0 ? 0 : (x > 1 ? 1 : x);
    }
  }
  return _writeBack(mesh, src, 'replace', false);
}

/** マスク領域を 1-ring ぶん広げる（steps 回） */
export function growMask(mesh, steps = 1) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  _reserve(nv);
  const n = clamp(Math.round(steps || 1), 1, 64);
  let src = _a, dst = _b;
  _loadMask(mesh, src);
  for (let k = 0; k < n; k++) {
    _dilate(mesh, src, dst);
    const t = src; src = dst; dst = t;
  }
  return _writeBack(mesh, src, 'replace', false);
}

/**
 * マスク領域を 1-ring ぶん縮める（steps 回）。
 * 収縮は「1 − マスクの膨張」と厳密に同じ（min(a,b) = 1 − max(1−a, 1−b)）なので、
 * 膨張の実装を 1 本だけ持てば済む。
 */
export function shrinkMask(mesh, steps = 1) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  _reserve(nv);
  const n = clamp(Math.round(steps || 1), 1, 64);
  let src = _a, dst = _b;
  _loadMask(mesh, src, true);            // 1 − マスク（畳みと NaN 落としも兼ねる）
  for (let k = 0; k < n; k++) {
    _dilate(mesh, src, dst);
    const t = src; src = dst; dst = t;
  }
  for (let v = 0; v < nv; v++) src[v] = 1 - src[v];
  return _writeBack(mesh, src, 'replace', false);
}

// ---------------------------------------------------------------------------
// 生成系（形状から作る）
// ---------------------------------------------------------------------------

/**
 * 曲率から溝／稜線をマスクする。
 * mesh.curv は「凹 > 0 / 凸 < 0」でエッジ長で割ってあるので、モデルを何倍に
 * 拡大しても値が変わらない（＝しきい値を world 単位に換算しなくてよい）。
 * ただしメッシュの細かさには依存する（下のゲインのコメント参照）。
 *
 * opts: side 'concave'|'convex'|'both', gain, threshold, blur, invert, mode, recompute
 */
export function maskByCavity(mesh, opts = {}) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  _reserve(nv);
  // 曲率はストローク中は触った頂点だけしか更新されない（Sculptor.flushCurvature）。
  // 全体に対する操作なので、既定では呼ぶ前に全部作り直す。
  if (opts.recompute !== false) mesh.computeAllCurvature();

  const side = opts.side || 'concave';
  const wantConcave = side !== 'convex';
  const wantConvex = side !== 'concave';
  // mesh.curv は「1-ring 重心のずれ ÷ 平均エッジ長」なので値が小さく、しかも
  // エッジ長に比例する（半径 1 の球で subdiv4 なら 0.036、subdiv5 なら 0.018）。
  // つまりゲインとしきい値はメッシュ密度に依存する量で、細かいメッシュでは
  // ゲインを上げる必要がある。既定は 10 万頂点前後を想定した値。
  const gain = opts.gain !== undefined ? Math.max(0, opts.gain) : 20;
  const th = opts.threshold !== undefined ? Math.max(0, opts.threshold) : 0.01;
  const blur = opts.blur !== undefined ? clamp(Math.round(opts.blur), 0, 16) : 1;

  const CV = mesh.curv;
  let src = _a, dst = _b;
  for (let v = 0; v < nv; v++) {
    const c = CV[v];
    let x = 0;
    if (c > 0) { if (wantConcave) x = c; }
    else if (wantConvex) x = -c;
    x = (x - th) * gain;
    src[v] = x < 0 ? 0 : (x > 1 ? 1 : x);
  }
  // 曲率は 2 次量でノイズが乗りやすい。そのままマスクにすると 1 頂点だけ
  // 抜けた穴だらけになるので、既定で軽くぼかす。
  for (let k = 0; k < blur; k++) {
    _ringMix(mesh, src, dst, 0.7);
    const t = src; src = dst; dst = t;
  }
  return _writeBack(mesh, src, opts.mode, opts.invert);
}

/**
 * 簡易アンビエントオクルージョンをマスクにする（窪んでいるほど 1）。
 *
 * レイトレースをしない理由:
 *  * 300 万頂点にレイを飛ばすには BVH が要る。構築だけで秒単位かかり、
 *    「ボタンを押したら出る」操作にならない。
 *  * AO は「その頂点の周りがどれだけ内側に閉じているか」の積分なので、
 *    メッシュ上の熱拡散（1-ring 平均の反復）で近似できる。k 回の拡散は
 *    エッジ長 √k 程度の測地半径をガウス重みで見るのと同じ意味を持つ。
 *    半径の違う各段を重み付きで足すと、細い溝も大きな窪みも暗くなる。
 *  * コストは頂点数 × 段数で完全に O(n)。空間構造も乱数も使わないので、
 *    同じメッシュなら必ず同じ結果になる（テストできる）。
 * 別の物体に遮られる影は表せないが、マスク用途で要るのは「窪みほど強い」
 * という順序だけなのでこれで足りる。
 *
 * opts: steps, gain, bias, spread, invert, mode, recompute
 */
export function maskByAmbientOcclusion(mesh, opts = {}) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  _reserve(nv);
  _reserveAcc(nv);
  if (opts.recompute !== false) mesh.computeAllCurvature();

  const steps = clamp(Math.round(opts.steps !== undefined ? opts.steps : 6), 1, 32);
  // 拡散を通すと振幅がさらに落ちる（生の平均で 0.02 前後）ので、
  // キャビティより大きめのゲインが既定値になる。
  const gain = opts.gain !== undefined ? Math.max(0, opts.gain) : 20;
  const bias = opts.bias !== undefined ? opts.bias : 0;
  const spread = opts.spread !== undefined ? clamp(opts.spread, 0.05, 1) : 0.9;

  // 種は局所凹凸の「凹の側だけ」。負（凸）を残したまま拡散させると、溝の両側に
  // できた稜線の負値が溝の正値を打ち消してしまい、鋭い溝がまったく暗くならない
  // （クリースで彫った球で実際にそうなった）。凹だけにしておくと単調になり、
  // 「窪みの周りも少し暗い」という AO 本来のにじみ方にもなる。
  const CV = mesh.curv;
  const acc = _acc;
  let src = _a, dst = _b;
  for (let v = 0; v < nv; v++) { const c = CV[v]; src[v] = c > 0 ? c : 0; acc[v] = 0; }

  // 重みは 1/(i+1)。遠い（＝段数の多い）スケールほど寄与を落とすと
  // 距離減衰のある本来の AO に近い当たりになる。
  let wsum = 0;
  for (let k = 0; k < steps; k++) {
    _ringMix(mesh, src, dst, spread);
    const t = src; src = dst; dst = t;
    const w = 1 / (k + 1);
    wsum += w;
    for (let v = 0; v < nv; v++) acc[v] += src[v] * w;
  }
  const invW = wsum > 0 ? 1 / wsum : 0;
  for (let v = 0; v < nv; v++) {
    const x = (acc[v] * invW - bias) * gain;
    src[v] = x < 0 ? 0 : (x > 1 ? 1 : x);
  }
  return _writeBack(mesh, src, opts.mode, opts.invert);
}

/**
 * 平らな所をマスクする（曲率の絶対値が小さい所）。
 * tolerance を「これ以上曲がっていたらもう平らではない」境目として、
 * |curv| = 0 で 1、|curv| >= tolerance で 0 の直線ランプにする。
 * maskByCavity と同じく tolerance は mesh.curv と同じ単位＝エッジ長に比例するので、
 * 同じ形でもメッシュが細かいほど「平ら」と判定されやすくなる。
 *
 * opts: tolerance, blur, invert, mode, recompute
 */
export function maskBySmoothness(mesh, opts = {}) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  _reserve(nv);
  if (opts.recompute !== false) mesh.computeAllCurvature();

  const tol = Math.max(1e-6, opts.tolerance !== undefined ? opts.tolerance : 0.05);
  const blur = opts.blur !== undefined ? clamp(Math.round(opts.blur), 0, 16) : 1;
  const inv = 1 / tol;
  const CV = mesh.curv;
  let src = _a, dst = _b;
  for (let v = 0; v < nv; v++) {
    const c = CV[v];
    const x = 1 - (c < 0 ? -c : c) * inv;
    src[v] = x < 0 ? 0 : (x > 1 ? 1 : x);
  }
  for (let k = 0; k < blur; k++) {
    _ringMix(mesh, src, dst, 0.7);
    const t = src; src = dst; dst = t;
  }
  return _writeBack(mesh, src, opts.mode, opts.invert);
}

/**
 * ポリペイントの色が近い頂点をマスクする。
 * 距離はリニア RGB のユークリッド距離。tol で 0 になる直線ランプにしてあり、
 * opts.hard で 0/1 の二値になる。
 *
 * opts: hard, blur, invert, mode
 */
export function maskByColor(mesh, rgb, tol = 0.25, opts = {}) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  _reserve(nv);
  const cr = rgb ? rgb[0] : 1, cg = rgb ? rgb[1] : 1, cb = rgb ? rgb[2] : 1;
  const t = Math.max(1e-6, tol);
  const inv = 1 / t;
  const hard = !!opts.hard;
  const blur = opts.blur !== undefined ? clamp(Math.round(opts.blur), 0, 16) : 0;
  const C = mesh.colors;
  let src = _a, dst = _b;
  for (let v = 0; v < nv; v++) {
    const i = v * 3;
    const dr = C[i] - cr, dg = C[i + 1] - cg, db = C[i + 2] - cb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db) * inv;
    src[v] = hard ? (d <= 1 ? 1 : 0) : (d >= 1 ? 0 : 1 - d);
  }
  for (let k = 0; k < blur; k++) {
    _ringMix(mesh, src, dst, 0.7);
    const t2 = src; src = dst; dst = t2;
  }
  return _writeBack(mesh, src, opts.mode, opts.invert);
}

/**
 * 指定方向を向いた面をマスクする（ZBrush の Mask By Normal）。
 * dir と法線の角度が 0 度で 1、angle 度で 0 になるランプ。angle = 90 なら
 * 「dir 側の半球」がまるごと入る。opts.hard で二値。
 *
 * opts: angle（度）, hard, blur, invert, mode
 */
export function maskByNormal(mesh, dir, opts = {}) {
  if (!mesh || mesh.nv === 0) return _empty(mesh);
  const nv = mesh.nv;
  const dx = dir ? dir[0] : 0, dy = dir ? dir[1] : 1, dz = dir ? dir[2] : 0;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(l > 1e-12)) return _empty(mesh);   // 方向が潰れている：何もしない
  _reserve(nv);
  const nx = dx / l, ny = dy / l, nz = dz / l;
  const angle = clamp(opts.angle !== undefined ? opts.angle : 45, 0, 180);
  const cut = Math.cos(angle * DEG);
  const span = 1 - cut;
  // 角度 0 だと幅が無く比較しかできない。hard と同じ扱いにする。
  const hard = !!opts.hard || span < 1e-6;
  const invSpan = span > 1e-6 ? 1 / span : 0;
  const blur = opts.blur !== undefined ? clamp(Math.round(opts.blur), 0, 16) : 0;
  const N = mesh.normals;
  let src = _a, dst = _b;
  for (let v = 0; v < nv; v++) {
    const i = v * 3;
    const d = N[i] * nx + N[i + 1] * ny + N[i + 2] * nz;
    if (hard) { src[v] = d >= cut ? 1 : 0; continue; }
    const x = (d - cut) * invSpan;
    src[v] = x < 0 ? 0 : (x > 1 ? 1 : x);
  }
  for (let k = 0; k < blur; k++) {
    _ringMix(mesh, src, dst, 0.7);
    const t = src; src = dst; dst = t;
  }
  return _writeBack(mesh, src, opts.mode, opts.invert);
}

// ---------------------------------------------------------------------------
// UI 自動生成用のテーブル
// ---------------------------------------------------------------------------

// 生成系に共通のパラメータ。読み取り専用の記述子なので実体を共有してよい。
const P_MODE = {
  key: 'mode', jp: '適用', type: 'enum', def: 'replace',
  options: MASK_MODES.map(m => ({ value: m.id, jp: m.jp, hint: m.hint })),
  hint: '既存のマスクに対する合成方法',
};
const P_INVERT = { key: 'invert', jp: '反転', type: 'bool', def: false, hint: '選ばれた側とその逆を入れ替える' };

/**
 * UI を自動生成するための一覧。run を記述子と同じ場所に置いてあるのは、
 * id と実装の対応が食い違いようがない形にしたいため（dispatch を別表にすると
 * 追加のときに片方だけ直してしまう）。
 * params の type は 'int' | 'float' | 'bool' | 'enum' | 'color' | 'vec3'。
 */
export const MASK_OPS = [
  {
    id: 'clear', jp: 'クリア', hint: 'マスクを全部外す（どこも保護されない）',
    params: [],
    run: (mesh) => clearMask(mesh),
  },
  {
    id: 'all', jp: '全面マスク', hint: 'すべてを保護する。反転や減算と組み合わせて使う',
    params: [],
    run: (mesh) => maskAll(mesh),
  },
  {
    id: 'invert', jp: '反転', hint: '守る所と彫れる所を入れ替える',
    params: [],
    run: (mesh) => invertMask(mesh),
  },
  {
    id: 'blur', jp: 'ぼかす', hint: 'マスクの境界をなめらかにする（段差を消す）',
    params: [
      { key: 'iterations', jp: '回数', type: 'int', min: 1, max: 20, step: 1, def: 2 },
      { key: 'amount', jp: '強さ', type: 'float', min: 0.1, max: 1, step: 0.05, def: 0.7 },
    ],
    run: (mesh, o) => blurMask(mesh, o.iterations, o),
  },
  {
    id: 'sharpen', jp: 'シャープ', hint: 'ぼけたマスクの境界を立てる',
    params: [
      { key: 'iterations', jp: '回数', type: 'int', min: 1, max: 20, step: 1, def: 1 },
      { key: 'amount', jp: '強さ', type: 'float', min: 0.1, max: 2, step: 0.05, def: 0.8 },
    ],
    run: (mesh, o) => sharpenMask(mesh, o.iterations, o),
  },
  {
    id: 'grow', jp: '広げる', hint: 'マスク領域を 1-ring ぶん外へ広げる',
    params: [{ key: 'steps', jp: '段数', type: 'int', min: 1, max: 20, step: 1, def: 1 }],
    run: (mesh, o) => growMask(mesh, o.steps),
  },
  {
    id: 'shrink', jp: '縮める', hint: 'マスク領域を 1-ring ぶん内へ縮める',
    params: [{ key: 'steps', jp: '段数', type: 'int', min: 1, max: 20, step: 1, def: 1 }],
    run: (mesh, o) => shrinkMask(mesh, o.steps),
  },
  {
    id: 'cavity', jp: 'キャビティ', hint: '曲率から溝や稜線をマスクする',
    params: [
      {
        key: 'side', jp: '対象', type: 'enum', def: 'concave',
        options: [
          { value: 'concave', jp: '凹（溝）' },
          { value: 'convex', jp: '凸（稜線）' },
          { value: 'both', jp: '両方' },
        ],
      },
      { key: 'gain', jp: 'ゲイン', type: 'float', min: 1, max: 60, step: 0.5, def: 20 },
      { key: 'threshold', jp: 'しきい値', type: 'float', min: 0, max: 0.2, step: 0.005, def: 0.01 },
      { key: 'blur', jp: 'ぼかし', type: 'int', min: 0, max: 8, step: 1, def: 1 },
      P_INVERT, P_MODE,
    ],
    run: (mesh, o) => maskByCavity(mesh, o),
  },
  {
    id: 'ao', jp: 'AO（窪み）', hint: '簡易アンビエントオクルージョン。窪んだ所ほど強くマスクする',
    params: [
      { key: 'steps', jp: '段数（広さ）', type: 'int', min: 1, max: 24, step: 1, def: 6 },
      { key: 'gain', jp: 'ゲイン', type: 'float', min: 1, max: 60, step: 0.5, def: 20 },
      { key: 'bias', jp: 'バイアス', type: 'float', min: -0.2, max: 0.2, step: 0.005, def: 0 },
      P_INVERT, P_MODE,
    ],
    run: (mesh, o) => maskByAmbientOcclusion(mesh, o),
  },
  {
    id: 'smooth', jp: '平坦部', hint: '平らな所をマスクする（ディテールのある所を彫り残す）',
    params: [
      { key: 'tolerance', jp: '許容曲率', type: 'float', min: 0.005, max: 0.3, step: 0.005, def: 0.05 },
      { key: 'blur', jp: 'ぼかし', type: 'int', min: 0, max: 8, step: 1, def: 1 },
      P_INVERT, P_MODE,
    ],
    run: (mesh, o) => maskBySmoothness(mesh, o),
  },
  {
    id: 'color', jp: '色で選択', hint: 'ポリペイントの色が近い頂点をマスクする',
    params: [
      { key: 'rgb', jp: '色', type: 'color', def: [1, 1, 1] },
      { key: 'tol', jp: '許容差', type: 'float', min: 0.01, max: 1, step: 0.01, def: 0.25 },
      { key: 'hard', jp: '境界を立てる', type: 'bool', def: false },
      { key: 'blur', jp: 'ぼかし', type: 'int', min: 0, max: 8, step: 1, def: 0 },
      P_INVERT, P_MODE,
    ],
    run: (mesh, o) => maskByColor(mesh, o.rgb, o.tol, o),
  },
  {
    id: 'normal', jp: '法線で選択', hint: '指定方向を向いた面をマスクする（ZBrush の Mask By Normal）',
    params: [
      { key: 'dir', jp: '方向', type: 'vec3', def: [0, 1, 0] },
      { key: 'angle', jp: '角度', type: 'float', min: 1, max: 180, step: 1, def: 45 },
      { key: 'hard', jp: '境界を立てる', type: 'bool', def: false },
      { key: 'blur', jp: 'ぼかし', type: 'int', min: 0, max: 8, step: 1, def: 0 },
      P_INVERT, P_MODE,
    ],
    run: (mesh, o) => maskByNormal(mesh, o.dir, o),
  },
];

export const MASK_OP_IDS = MASK_OPS.map(o => o.id);
export const MASK_OP_BY_ID = new Map(MASK_OPS.map(o => [o.id, o]));

/**
 * id で操作を実行する。opts に無いパラメータは params の def で埋めるので、
 * UI 側は触られたスライダーの値だけ渡せばよい。
 * @returns {{id: string, changed: number, masked: number, live: number}}
 */
export function applyMaskOp(mesh, id, opts = {}) {
  const op = MASK_OP_BY_ID.get(id);
  if (!op) return Object.assign({ id }, _empty(mesh));
  const o = {};
  const ps = op.params;
  for (let i = 0; i < ps.length; i++) o[ps[i].key] = ps[i].def;
  if (opts) for (const k in opts) { if (opts[k] !== undefined) o[k] = opts[k]; }
  const r = op.run(mesh, o);
  return { id, changed: r.changed, masked: r.masked, live: r.live };
}
