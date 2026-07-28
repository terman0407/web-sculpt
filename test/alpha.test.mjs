// ブラシアルファ（js/alpha.js）とストロークタイプの検証。
// DOM / WebGPU には触らないので node で単体で走る。
import {
  ALPHAS, ALPHA_IDS, ALPHA_SIZE, ALPHA_BY_ID, DEFAULT_ALPHA,
  alphaData, alphaBytes, sampleAlpha, alphaWeightAt,
  ensureAlpha, fillNextAlpha, clearAlphaCache,
  STROKES, STROKE_IDS, STROKE_BY_ID, DAB_STRIDE, MAX_DABS, DEFAULT_STROKE,
  planDabs, strokeDefaults, isDragStroke, isSprayStroke,
} from '../js/alpha.js';
import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { BrushEngine, falloff } from '../js/brushes.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

const S = ALPHA_SIZE, H = S >> 1;

// ---------------------------------------------------------------------------
head('アルファの定義表');
{
  ok(ALPHAS.length === 13, `13 枚ある (${ALPHAS.length})`);
  const seen = new Set();
  for (const a of ALPHAS) {
    ok(typeof a.id === 'string' && a.id.length > 0, 'id がある');
    ok(typeof a.jp === 'string' && a.jp.length > 0, `${a.id}: 日本語名がある`);
    ok(typeof a.hint === 'string' && a.hint.length > 0, `${a.id}: hint がある`);
    ok(!seen.has(a.id), `${a.id}: id が重複していない`);
    seen.add(a.id);
    ok(ALPHA_BY_ID.get(a.id) === a, `${a.id}: 索引から引ける`);
  }
  for (const want of ['soft', 'hard', 'square', 'ring', 'star', 'crack', 'scale',
    'noise', 'stitch', 'brick', 'hexTile', 'cloth', 'scratch']) {
    ok(seen.has(want), `${want} が定義されている`);
  }
  ok(ALPHA_IDS.length === ALPHAS.length, 'ALPHA_IDS の長さが一致');
  ok(seen.has(DEFAULT_ALPHA), '既定アルファが表にある');
}

// ---------------------------------------------------------------------------
head('アルファのビットマップの不変条件');
for (const a of ALPHAS) {
  const d = alphaData(a.id);
  ok(d instanceof Float32Array, `${a.id}: Float32Array が返る`);
  ok(d.length === S * S, `${a.id}: 長さが size*size (${d.length})`);

  let min = Infinity, max = -Infinity, nan = 0, sum = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (!Number.isFinite(v)) { nan++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  ok(nan === 0, `${a.id}: NaN / Inf がない (${nan})`);
  ok(min >= 0, `${a.id}: 下限が 0 以上 (${min})`);
  ok(max <= 1, `${a.id}: 上限が 1 以下 (${max})`);

  // 中心が最大でちょうど 1
  const center = d[H * S + H];
  ok(Math.abs(center - 1) < 1e-9, `${a.id}: 中心の値が 1 (${center})`);
  ok(center >= max - 1e-9, `${a.id}: 中心が最大 (中心 ${center} / 最大 ${max})`);

  // 外周 4 辺が厳密に 0（バイリニアで外へ滲まないこと）
  let border = 0;
  for (let k = 0; k < S; k++) {
    border = Math.max(border, d[k], d[(S - 1) * S + k], d[k * S], d[k * S + S - 1]);
  }
  ok(border === 0, `${a.id}: 外周が 0 (最大 ${border})`);

  // 円の外（r >= 1）はすべて 0
  let outside = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x - H) / H, v = (y - H) / H;
      if (u * u + v * v >= 1) outside = Math.max(outside, d[y * S + x]);
    }
  }
  ok(outside === 0, `${a.id}: 半径 1 の外が 0 (最大 ${outside})`);

  // ブラシ断面として使えること = 内側のほうが濃い
  let inS = 0, inN = 0, outS = 0, outN = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x - H) / H, v = (y - H) / H, r = Math.sqrt(u * u + v * v);
      if (r >= 1) continue;
      if (r < 0.5) { inS += d[y * S + x]; inN++; } else { outS += d[y * S + x]; outN++; }
    }
  }
  ok(inS / inN > outS / outN, `${a.id}: 内側が外側より濃い (${(inS / inN).toFixed(3)} > ${(outS / outN).toFixed(3)})`);
  ok(sum > 0, `${a.id}: 全部 0 ではない`);
  console.log(`  ok   ${a.id.padEnd(8)} 平均 ${(sum / d.length).toFixed(3)}  内 ${(inS / inN).toFixed(3)} / 外 ${(outS / outN).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
head('生成の再現性とキャッシュ');
{
  const a = alphaData('crack');
  const b = alphaData('crack');
  ok(a === b, 'キャッシュが効いて同一インスタンスが返る');

  // 作り直しても 1 bit も変わらないこと（Math.random を使っていない証拠）
  const copy = a.slice();
  clearAlphaCache();
  const c = alphaData('crack');
  ok(c !== copy, '作り直しで別インスタンスになる');
  let diff = 0;
  for (let i = 0; i < copy.length; i++) if (copy[i] !== c[i]) diff++;
  ok(diff === 0, `作り直しても完全に同一 (差 ${diff})`);

  ok(ensureAlpha('star') === true, '未生成なら ensureAlpha が true');
  ok(ensureAlpha('star') === false, '生成済みなら false');
  let built = 0;
  while (fillNextAlpha()) { built++; if (built > 100) break; }
  ok(built === ALPHA_IDS.length - 2, `fillNextAlpha が残りを埋める (${built})`);
  ok(fillNextAlpha() === false, '全部埋まったら false');

  // 未知の id は既定に落ちる（UI が壊れた設定を持っていても死なない）
  const unknown = alphaData('no-such-alpha');
  const soft = alphaData('soft');
  ok(unknown === soft, '未知の id は既定アルファになる');

  // 形の表を素のオブジェクトで持つと Object.prototype 由来の名前が
  // 「在る」ように見え、dome が関数でないまま呼ばれて TypeError になる。
  // 保存済み設定や URL から来た文字列がそのまま渡されても落ちないこと。
  for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    let threw = null, same = false;
    try { same = alphaData(evil) === soft; } catch (e) { threw = e; }
    ok(threw === null, `alphaData('${evil}') が例外を投げない (${threw && threw.message})`);
    ok(same, `alphaData('${evil}') が既定に落ちる`);
    let w = NaN;
    try { w = alphaWeightAt(evil, 0, 0, 0, [0, 0, 0], [1, 0, 0], [0, 1, 0], 1, 0); } catch (e) { w = NaN; }
    ok(Math.abs(w - 1) < 1e-9, `alphaWeightAt('${evil}') も既定で動く (${w})`);
    ok(alphaBytes(evil).length === S * S * 4, `alphaBytes('${evil}') も動く`);
  }
  // 未知の id で ensureAlpha が毎回 true を返すと、「true ならテクスチャ転送」
  // という呼び出し側が毎フレーム転送し続けてしまう
  ok(ensureAlpha('no-such-alpha') === false && ensureAlpha('no-such-alpha') === false,
    '未知の id では ensureAlpha が「作った」と言わない');

  // 13 枚が互いに別の絵であること。SHAPES に定義を書き忘れた id は静かに
  // soft へ落ちるだけなので、これを見ないと「13 枚あるつもりで実は 12 枚」に気づけない
  const hashes = new Map();
  for (const id of ALPHA_IDS) {
    const d = alphaData(id);
    let h = 0;
    for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + Math.round(d[i] * 65535)) | 0;
    ok(!hashes.has(h), `${id}: ${hashes.get(h)} と同じ絵になっていない`);
    hashes.set(h, id);
  }
  ok(hashes.size === ALPHA_IDS.length, `13 枚すべて別の絵 (${hashes.size})`);

  // fillNextAlpha が必ず止まること
  clearAlphaCache();
  let loops = 0;
  while (fillNextAlpha()) { if (++loops > ALPHA_IDS.length) break; }
  ok(loops === ALPHA_IDS.length, `fillNextAlpha が枚数ぶんで止まる (${loops})`);

  // 「ALPHAS には足したが形の定義を書き忘れた」という将来のずれを模す。
  // その id はキャッシュに入らないので、飛ばさずに先読みを回すと
  // 「毎回その id で既定を引き当てて false」で止まり、残りが永久に生成されない。
  // 先頭に置くのは、既定（soft）がまだキャッシュに無い状態を踏むため。
  ALPHA_IDS.unshift('ghost-alpha');
  try {
    clearAlphaCache();
    let spins = 0;
    while (fillNextAlpha()) { if (++spins > ALPHA_IDS.length + 4) break; }
    ok(spins === ALPHA_IDS.length - 1, `表がずれても枚数ぶん先読みできる (${spins})`);
    let unbuilt = 0;
    for (let i = 1; i < ALPHA_IDS.length; i++) if (ensureAlpha(ALPHA_IDS[i])) unbuilt++;
    ok(unbuilt === 0, `ずれがあっても取り残しが出ない (${unbuilt})`);
  } finally { ALPHA_IDS.shift(); }
}

// ---------------------------------------------------------------------------
head('サンプリング');
{
  ok(Math.abs(sampleAlpha('soft', 0.5, 0.5) - 1) < 1e-9, '中心で 1');

  // 範囲外は 0
  for (const [u, v] of [[-0.01, 0.5], [0.5, -0.01], [1.01, 0.5], [0.5, 1.01],
    [-5, -5], [2, 2], [NaN, 0.5], [0.5, NaN]]) {
    ok(sampleAlpha('soft', u, v) === 0, `範囲外 (${u}, ${v}) は 0`);
  }
  // 端はちょうど 0
  ok(sampleAlpha('soft', 0, 0) === 0, '(0,0) は 0');
  ok(sampleAlpha('soft', 1, 1) === 0, '(1,1) は 0');
  ok(sampleAlpha('soft', 0.5, 0) === 0, '上辺の中央は 0');

  // すべての id で 0..1、NaN なし
  let bad = 0, nan = 0;
  for (const id of ALPHA_IDS) {
    for (let i = 0; i <= 97; i++) {
      for (let j = 0; j <= 97; j++) {
        const s = sampleAlpha(id, i / 97, j / 97);
        if (!Number.isFinite(s)) nan++;
        else if (s < 0 || s > 1) bad++;
      }
    }
  }
  ok(nan === 0, `補間で NaN が出ない (${nan})`);
  ok(bad === 0, `補間値が 0..1 に収まる (${bad})`);

  // バイリニアが格子点でその値そのものを返す（u = x / size の割り付け）
  const d = alphaData('soft');
  let maxd = 0;
  for (let x = 0; x < S; x++) {
    maxd = Math.max(maxd, Math.abs(sampleAlpha('soft', x / S, H / S) - d[H * S + x]));
  }
  ok(maxd < 1e-6, `格子点でビットマップの値と一致 (最大差 ${maxd.toExponential(2)})`);

  // 格子の間（tx, ty がどちらも 0 でない点）で本当にバイリニアになっているか。
  // 格子点や 1 行だけ見ても tx と ty を取り違えたコードが素通りしてしまう。
  {
    const dc = alphaData('crack');
    let maxErr = 0, discrim = 0, samples = 0;
    for (let i = 0; i < 400; i++) {
      const u = 0.2 + (i % 23) / 23 * 0.6 + 0.017;
      const v = 0.25 + (i % 17) / 17 * 0.5 + 0.011;
      const fx = u * S, fy = v * S;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      if (tx < 0.1 || tx > 0.9 || ty < 0.1 || ty > 0.9) continue;
      const a00 = dc[y0 * S + x0], a10 = dc[y0 * S + x0 + 1];
      const a01 = dc[(y0 + 1) * S + x0], a11 = dc[(y0 + 1) * S + x0 + 1];
      const want = (a00 + (a10 - a00) * tx) * (1 - ty) + (a01 + (a11 - a01) * tx) * ty;
      // tx / ty を入れ替えた版。これと十分に違う点があってはじめて上の検算に意味が出る
      const swapped = (a00 + (a10 - a00) * ty) * (1 - tx) + (a01 + (a11 - a01) * ty) * tx;
      maxErr = Math.max(maxErr, Math.abs(sampleAlpha('crack', u, v) - want));
      discrim = Math.max(discrim, Math.abs(swapped - want));
      samples++;
    }
    ok(samples > 50, `格子の間の標本が取れている (${samples})`);
    ok(maxErr < 1e-6, `手計算のバイリニアと一致 (最大差 ${maxErr.toExponential(2)})`);
    ok(discrim > 0.05, `tx/ty を取り違えたら差が出る標本がある (${discrim.toFixed(3)})`);
  }

  // 単調性（soft は中心から外へ単調非増加）
  let mono = true, prev = Infinity;
  for (let k = 0; k <= 64; k++) {
    const s = sampleAlpha('soft', 0.5 + 0.5 * k / 64, 0.5);
    if (s > prev + 1e-9) mono = false;
    prev = s;
  }
  ok(mono, 'soft は中心から外へ単調非増加');

  // id を切り替えても取り違えない（直前 id のキャッシュ回路の検証）
  const softC = sampleAlpha('soft', 0.5, 0.25);
  const hardC = sampleAlpha('hard', 0.5, 0.25);
  ok(sampleAlpha('soft', 0.5, 0.25) === softC && sampleAlpha('hard', 0.5, 0.25) === hardC
    && sampleAlpha('soft', 0.5, 0.25) === softC, 'id を交互に切り替えても値が混ざらない');
  ok(hardC > softC, 'hard のほうが中間で濃い（縁が立っている）');
}

// ---------------------------------------------------------------------------
head('alphaWeightAt（接平面へのマッピング）');
{
  const center = new Float32Array([1, 2, 3]);
  const t = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 0, 1]);   // 法線 = -Y の接平面
  const R = 0.4;

  ok(Math.abs(alphaWeightAt('soft', 1, 2, 3, center, t, b, R, 0) - 1) < 1e-9,
    '中心にある頂点は 1');

  // 半径の外は 0（円の外は必ず 0 になっている）
  ok(alphaWeightAt('soft', 1 + R * 1.2, 2, 3, center, t, b, R, 0) === 0, '+t 側の外は 0');
  ok(alphaWeightAt('soft', 1 - R * 1.2, 2, 3, center, t, b, R, 0) === 0, '-t 側の外は 0');
  ok(alphaWeightAt('soft', 1, 2, 3 + R * 1.2, center, t, b, R, 0) === 0, '+b 側の外は 0');

  // 接平面から離れていても（法線方向のずれ）投影して読む
  const on = alphaWeightAt('soft', 1 + R * 0.4, 2, 3, center, t, b, R, 0);
  const off = alphaWeightAt('soft', 1 + R * 0.4, 2 + 99, 3, center, t, b, R, 0);
  ok(Math.abs(on - off) < 1e-9, '法線方向のずれは結果に影響しない（接平面へ投影）');

  // 回転：スクエアの角は回すと入れ替わる
  const p = R * 0.62;
  const noRot = alphaWeightAt('square', 1 + p, 2, 3 + p, center, t, b, R, 0);
  const rot45 = alphaWeightAt('square', 1 + p, 2, 3 + p, center, t, b, R, Math.PI / 4);
  ok(Math.abs(noRot - rot45) > 0.2, `回転が効いている (${noRot.toFixed(3)} vs ${rot45.toFixed(3)})`);
  // 90 度単位の回転は 4 回で元に戻る（可逆性）
  const q = R * 0.35;
  const a0 = alphaWeightAt('star', 1 + q, 2, 3 + q * 0.5, center, t, b, R, 0);
  const a4 = alphaWeightAt('star', 1 + q, 2, 3 + q * 0.5, center, t, b, R, Math.PI * 2);
  ok(Math.abs(a0 - a4) < 1e-5, `2π 回転で元に戻る (${a0.toFixed(5)} vs ${a4.toFixed(5)})`);

  // 回転の向きの規約: 「スタンプを +rotation 回す」＝ アルファ角 α の模様が
  // 接平面上の角 α + rotation に現れる。符号を逆にしても大きさだけ見る検算は
  // 通ってしまうので、模様が付いてくる側を名指しで押さえる。
  // stitch は縫い目が u 軸に並んでいて左右対称なので、これが判定に使える。
  {
    const rad = 0.45 * R;
    let bad = 0, minGap = Infinity;
    for (const rho of [0.4, 1.0, -0.7]) {
      const w0 = alphaWeightAt('stitch', 1 + rad, 2, 3, center, t, b, R, 0);
      // 世界角 rho の位置を rotation=rho で読む → アルファ角 0 に戻るので w0 と同じ
      const px = 1 + Math.cos(rho) * rad, pz = 3 + Math.sin(rho) * rad;
      const same = alphaWeightAt('stitch', px, 2, pz, center, t, b, R, rho);
      const flip = alphaWeightAt('stitch', px, 2, pz, center, t, b, R, -rho);
      if (Math.abs(same - w0) > 1e-6) bad++;
      minGap = Math.min(minGap, Math.abs(same - flip));
    }
    ok(bad === 0, `+rotation で模様がスタンプごと回る (ずれ ${bad} 件)`);
    ok(minGap > 0.05, `符号を逆にすると別の値になる（向きが特定できている, ${minGap.toFixed(3)}）`);
  }

  // 半径 0 でも NaN を返さない
  const z = alphaWeightAt('soft', 1.5, 2, 3, center, t, b, 0, 0);
  ok(Number.isFinite(z) && z >= 0 && z <= 1, `半径 0 でも有限値 (${z})`);

  // 壊れた入力でも NaN を外に出さない。呼び出し側は死んだ頂点スロットの
  // 座標（初期化されていない / 古い値）をうっかり渡すことがあり、そこから
  // NaN が返るとメッシュに NaN が書き込まれてしまう。
  for (const [nm, args] of [
    ['頂点座標が NaN', [NaN, 2, 3, center, t, b, R, 0]],
    ['中心が NaN', [1, 2, 3, [NaN, 0, 0], t, b, R, 0]],
    ['基底が NaN', [1.1, 2, 3, center, [NaN, 0, 0], b, R, 0]],
    ['半径が NaN', [1.1, 2, 3, center, t, b, NaN, 0]],
    ['半径が負', [1.1, 2, 3, center, t, b, -R, 0]],
    ['回転が NaN', [1.1, 2, 3, center, t, b, R, NaN]],
    ['回転が Inf', [1.1, 2, 3, center, t, b, R, Infinity]],
    ['基底がゼロ', [1.1, 2, 3, center, [0, 0, 0], [0, 0, 0], R, 0]],
    ['座標が Inf', [Infinity, 2, 3, center, t, b, R, 0]],
  ]) {
    const w = alphaWeightAt('star', ...args);
    ok(Number.isFinite(w) && w >= 0 && w <= 1, `${nm} でも 0..1 の有限値 (${w})`);
  }

  // 全 id × 多数の位置で 0..1 / NaN なし
  let bad = 0, nan = 0;
  for (const id of ALPHA_IDS) {
    for (let i = -20; i <= 20; i++) {
      for (let j = -20; j <= 20; j++) {
        const w = alphaWeightAt(id, 1 + i * R * 0.08, 2 + j * 0.01, 3 + j * R * 0.08,
          center, t, b, R, 0.7);
        if (!Number.isFinite(w)) nan++;
        else if (w < 0 || w > 1) bad++;
      }
    }
  }
  ok(nan === 0 && bad === 0, `全 id で 0..1 かつ有限 (NaN ${nan} / 範囲外 ${bad})`);
}

// ---------------------------------------------------------------------------
head('alphaBytes');
{
  const b = alphaBytes('soft');
  ok(b instanceof Uint8Array && b.length === S * S * 4, `RGBA8 が返る (${b.length})`);
  const c = b[(H * S + H) * 4];
  ok(c === 255, `中心が 255 (${c})`);
  ok(b[0] === 0, '外周が 0');
  const reuse = new Uint8Array(S * S * 4);
  ok(alphaBytes('hard', reuse) === reuse, '渡した配列を使い回す');

  // R=G=B=A。A を 255 固定にすると、サムネイルを透過で重ねたときに
  // 効かない部分が黒い四角として出てしまう
  let mismatch = 0, aOne = 0;
  const d = alphaData('soft');
  for (let i = 0; i < S * S; i++) {
    const g = b[i * 4];
    if (b[i * 4 + 1] !== g || b[i * 4 + 2] !== g || b[i * 4 + 3] !== g) mismatch++;
    if (g !== Math.round(d[i] * 255)) aOne++;
  }
  ok(mismatch === 0, `R=G=B=A になっている (${mismatch})`);
  ok(aOne === 0, `ビットマップの値がそのまま 0..255 になっている (${aOne})`);

  // 短すぎる out は無視して自前で確保する（書き込みが溢れないこと）
  const tooSmall = new Uint8Array(16);
  const got = alphaBytes('soft', tooSmall);
  ok(got !== tooSmall && got.length === S * S * 4, '短い out は使わない');
}

// ---------------------------------------------------------------------------
head('ストロークの定義表');
{
  for (const want of ['dots', 'freehand', 'dragRect', 'spray', 'colorSpray', 'sprayLight']) {
    ok(STROKE_BY_ID.has(want), `${want} が定義されている`);
  }
  ok(STROKE_IDS.length === STROKES.length, 'STROKE_IDS の長さが一致');
  for (const s of STROKES) {
    ok(typeof s.jp === 'string' && s.jp.length > 0, `${s.id}: 日本語名がある`);
    ok(typeof s.hint === 'string' && s.hint.length > 0, `${s.id}: hint がある`);
    ok(Array.isArray(s.params), `${s.id}: params が配列`);
    const def = strokeDefaults(s.id);
    ok(def !== s.def, `${s.id}: strokeDefaults は複製を返す`);
    for (const p of s.params) {
      ok(def[p] !== undefined, `${s.id}: params の ${p} に既定値がある`);
    }
  }
  ok(isDragStroke('dragRect') === true && isDragStroke('dots') === false, 'isDragStroke');
  ok(isSprayStroke('spray') && isSprayStroke('colorSpray') && isSprayStroke('sprayLight'),
    'isSprayStroke がスプレー 3 種を拾う');
  ok(!isSprayStroke('dots') && !isSprayStroke('freehand'), 'isSprayStroke が非スプレーを拾わない');
  ok(DAB_STRIDE === 6, `stride が 6 (${DAB_STRIDE})`);
}

// ---------------------------------------------------------------------------
head('planDabs: 個数が spacing どおりか');
{
  const from = new Float32Array([0, 0, 0]);
  const to = new Float32Array([1, 0, 0]);
  const radius = 0.1;

  for (const [spacing, want] of [[0.2, 50], [0.1, 100], [0.5, 20], [0.25, 40]]) {
    const r = planDabs('dots', { from, to, radius, spacing, seed: 1, dabIndex: 0 });
    ok(r.count === want, `spacing=${spacing} → ${want} 個 (${r.count})`);
    ok(Math.abs(r.step - radius * spacing) < 1e-12, `step が radius*spacing (${r.step})`);
    ok(Math.abs(r.advance - r.step * r.count) < 1e-9, 'advance = step * count');
    ok(r.stride === DAB_STRIDE, 'stride が返る');
    // 位置が等間隔に並んでいるか
    let maxErr = 0;
    for (let k = 0; k < r.count; k++) {
      const o = k * r.stride;
      maxErr = Math.max(maxErr, Math.abs(r.dabs[o] - r.step * (k + 1)),
        Math.abs(r.dabs[o + 1]), Math.abs(r.dabs[o + 2]));
    }
    ok(maxErr < 1e-6, `等間隔に並ぶ (最大誤差 ${maxErr.toExponential(2)})`);
  }

  // 移動量が spacing 未満なら 1 個も置かない（残りは advance=0 で持ち越す）
  const tiny = new Float32Array([0.001, 0, 0]);
  const r0 = planDabs('dots', { from, to: tiny, radius, spacing: 0.2, seed: 1, dabIndex: 0 });
  ok(r0.count === 0 && r0.advance === 0, `spacing 未満では 0 個 (${r0.count})`);

  // 割り切れない spacing で「端数を次回に持ち越す」ことになっているか。
  // advance を dist にしてしまうと端数が消えて、間隔が少しずつ広がっていく。
  {
    const r = planDabs('dots', { from, to, radius, spacing: 0.16, seed: 1, dabIndex: 0 });
    ok(r.count === 62, `spacing=0.16 → 62 個 (${r.count})`);
    ok(Math.abs(r.advance - r.step * r.count) < 1e-12, `advance が step*count (${r.advance})`);
    ok(r.advance < 1 - 1e-6, `端数 ${(1 - r.advance).toFixed(6)} が次回に残る`);
    // 端数を持ち越しながら 2 区間打っても、間隔がずれないこと。
    // 戻り値はスクラッチ（次の planDabs で上書きされる）なので先に写しておく
    const step0 = r.step, count0 = r.count, adv0 = r.advance;
    const lastX = r.dabs[(count0 - 1) * DAB_STRIDE];
    ok(Math.abs(lastX - step0 * count0) < 1e-6, `最後のダブが step*count の位置 (${lastX})`);
    const mid = new Float32Array([adv0, 0, 0]);
    const r2 = planDabs('dots', { from: mid, to: new Float32Array([2, 0, 0]), radius, spacing: 0.16, seed: 1, dabIndex: 62 });
    // 区間 1 の最後のダブは step*count = advance の位置にある。
    // 区間 2 の最初のダブとの差がちょうど step なら端数が正しく持ち越されている。
    const firstGap = r2.dabs[0] - lastX;
    ok(Math.abs(firstGap - step0) < 1e-6, `継ぎ目の間隔も step どおり (${firstGap.toFixed(6)} vs ${step0})`);
  }

  // 上限で打ち切られること（1 フレームの作業量を有界にする）
  const far = new Float32Array([100, 0, 0]);
  const rc = planDabs('dots', { from, to: far, radius, spacing: 0.02, seed: 1, dabIndex: 0, maxDabs: 32 });
  ok(rc.count === 32 && rc.truncated === true, `maxDabs で打ち切る (${rc.count}, truncated=${rc.truncated})`);
  // 打ち切ったぶんは advance に入れてはいけない（入れると飛ばした区間が消える）
  ok(Math.abs(rc.advance - rc.step * rc.count) < 1e-12,
    `打ち切り時も advance = step*count (${rc.advance})`);
  ok(rc.advance < 100, `打ち切り時に to まで進めない (${rc.advance})`);
  const rc2 = planDabs('dots', { from, to, radius, spacing: 0.2, seed: 1, dabIndex: 0 });
  ok(rc2.truncated === false, '打ち切っていなければ truncated=false');

  // freehand は同じドラッグで dots より密になる
  const a = planDabs('dots', { from, to, radius, seed: 1, dabIndex: 0 }).count;
  const b = planDabs('freehand', { from, to, radius, seed: 1, dabIndex: 0 }).count;
  ok(b > a, `freehand が dots より密 (${b} > ${a})`);
}

// ---------------------------------------------------------------------------
head('planDabs: dragRect');
{
  const from = new Float32Array([1, 1, 1]);
  const to = new Float32Array([1.6, 1, 1]);
  const radius = 0.3;
  const r = planDabs('dragRect', { from, to, radius, seed: 5, dabIndex: 0 });
  ok(r.count === 1, `1 個だけ返す (${r.count})`);
  ok(r.dabs[0] === 1 && r.dabs[1] === 1 && r.dabs[2] === 1, '押した点に置かれる');
  ok(Math.abs(r.dabs[3] - 0.6 / 0.3) < 1e-6, `引いた長さがスケールになる (${r.dabs[3]})`);
  ok(r.advance === 0, 'アンカーは進めない (advance = 0)');

  // 引く向きで回転が変わる。
  // 戻り値はスクラッチなので、次に planDabs を呼ぶ前に値を取り出しておくこと
  // （この「次の呼び出しまでしか有効でない」規約自体もここで踏んでいる）。
  const t2 = new Float32Array([1, 1, 1.6]);
  const rot1 = planDabs('dragRect', {
    from, to, radius, seed: 5, dabIndex: 0,
    tangent: [1, 0, 0], bitangent: [0, 0, 1],
  }).dabs[4];
  const rot2 = planDabs('dragRect', {
    from, to: t2, radius, seed: 5, dabIndex: 0,
    tangent: [1, 0, 0], bitangent: [0, 0, 1],
  }).dabs[4];
  ok(Math.abs(rot1 - 0) < 1e-6, `+t 方向のドラッグは回転 0 (${rot1})`);
  ok(Math.abs(rot2 - Math.PI / 2) < 1e-6, `+b 方向のドラッグは回転 π/2 (${rot2})`);

  // 押した点から動いていなくても壊れない
  const r3 = planDabs('dragRect', { from, to: from, radius, seed: 5, dabIndex: 0 });
  ok(r3.count === 1 && r3.dabs[3] > 0 && Number.isFinite(r3.dabs[4]),
    `静止でも有限のスタンプを返す (scale ${r3.dabs[3]}, rot ${r3.dabs[4]})`);
}

// ---------------------------------------------------------------------------
head('planDabs: spray の決定論性とばらつき');
{
  const from = new Float32Array([0, 0, 0]);
  const to = new Float32Array([1, 0, 0]);
  const radius = 0.1;
  const base = { from, to, radius, seed: 1234, dabIndex: 0, tangent: [0, 1, 0], bitangent: [0, 0, 1] };

  const A = planDabs('spray', base);
  const nA = A.count, scatteredA = A.scattered;
  const copyA = A.dabs.slice(0, nA * DAB_STRIDE);
  ok(nA > 0, `ダブが返る (${nA})`);

  // 同じ seed / dabIndex なら完全に同じ結果（アンドゥ→リドゥとミラーの一致に必須）
  const B = planDabs('spray', base);
  let diff = 0;
  for (let i = 0; i < nA * DAB_STRIDE; i++) if (copyA[i] !== B.dabs[i]) diff++;
  ok(B.count === nA && diff === 0, `同じ seed で完全に同一 (差 ${diff})`);

  // 途中に別のストロークを挟んでも変わらない（内部状態を持ち回っていない）
  planDabs('colorSpray', Object.assign({}, base, { seed: 999, dabIndex: 77 }));
  const C = planDabs('spray', base);
  let diff2 = 0;
  for (let i = 0; i < nA * DAB_STRIDE; i++) if (copyA[i] !== C.dabs[i]) diff2++;
  ok(diff2 === 0, `別ストロークを挟んでも同一 (差 ${diff2})`);

  // seed が違えば違う結果
  const D = planDabs('spray', Object.assign({}, base, { seed: 4321 }));
  let same = 0;
  for (let i = 0; i < nA * DAB_STRIDE; i++) if (copyA[i] === D.dabs[i]) same++;
  ok(same < nA * DAB_STRIDE * 0.5, `seed を変えると結果が変わる (一致 ${same}/${nA * DAB_STRIDE}）`);

  // dabIndex が違えば違う位相（ストロークを継いでも同じ模様が繰り返さない）
  const E = planDabs('spray', Object.assign({}, base, { dabIndex: 1 }));
  let same2 = 0;
  for (let i = 0; i < Math.min(nA, E.count) * DAB_STRIDE; i++) if (copyA[i] === E.dabs[i]) same2++;
  ok(same2 < nA * DAB_STRIDE * 0.6, `dabIndex で位相がずれる (一致 ${same2}）`);

  // ばらつきが実際に散っていること（軸から離れた位置がある）
  let maxOff = 0, nanC = 0;
  for (let k = 0; k < nA; k++) {
    const o = k * DAB_STRIDE;
    const x = copyA[o], y = copyA[o + 1], z = copyA[o + 2];
    if (![x, y, z, copyA[o + 3], copyA[o + 4], copyA[o + 5]].every(Number.isFinite)) nanC++;
    maxOff = Math.max(maxOff, Math.hypot(y, z));   // 進行方向は x なので y,z が散り
  }
  ok(nanC === 0, `NaN がない (${nanC})`);
  ok(maxOff > radius * 0.2, `接平面上に散っている (最大 ${maxOff.toFixed(4)})`);
  ok(maxOff <= radius * 1.0 + 1e-9, `散らす量が scatter*radius 以内 (${maxOff.toFixed(4)})`);
  ok(scatteredA === nA, `散らした個数が返る (${scatteredA})`);

  // sprayLight のばらつきは spray より小さい
  const L = planDabs('sprayLight', Object.assign({}, base, { spacing: 0.22 }));
  let maxL = 0;
  for (let k = 0; k < L.count; k++) {
    const o = k * DAB_STRIDE;
    maxL = Math.max(maxL, Math.hypot(L.dabs[o + 1], L.dabs[o + 2]));
  }
  ok(maxL < maxOff, `sprayLight のばらつきが小さい (${maxL.toFixed(4)} < ${maxOff.toFixed(4)})`);

  // スケールと回転の範囲
  let sMin = Infinity, sMax = -Infinity, rMin = Infinity, rMax = -Infinity;
  for (let k = 0; k < nA; k++) {
    const o = k * DAB_STRIDE;
    sMin = Math.min(sMin, copyA[o + 3]); sMax = Math.max(sMax, copyA[o + 3]);
    rMin = Math.min(rMin, copyA[o + 4]); rMax = Math.max(rMax, copyA[o + 4]);
  }
  ok(sMin > 0 && sMax <= 2, `スケールが正で 2 以下 (${sMin.toFixed(3)}〜${sMax.toFixed(3)})`);
  ok(sMax > sMin, 'スケールが揺らいでいる');
  ok(rMin >= 0 && rMax <= Math.PI * 2 + 1e-9, `回転が 0..2π (${rMin.toFixed(3)}〜${rMax.toFixed(3)})`);

  // 色の揺らぎ: spray は 0、colorSpray だけ 0 以外
  let cs = 0;
  for (let k = 0; k < nA; k++) if (copyA[k * DAB_STRIDE + 5] !== 0) cs++;
  ok(cs === 0, `spray は色を揺らさない (${cs})`);
  const CS = planDabs('colorSpray', base);
  let nz = 0, outR = 0;
  for (let k = 0; k < CS.count; k++) {
    const c = CS.dabs[k * DAB_STRIDE + 5];
    if (c !== 0) nz++;
    if (c < -1 || c > 1) outR++;
  }
  ok(nz > 0, `colorSpray は色を揺らす (${nz}/${CS.count})`);
  ok(outR === 0, `色の揺らぎが -1..1 (${outR})`);

  // dots は一切揺らがない（現状の挙動と同じ）
  const DT = planDabs('dots', base);
  let jitter = 0;
  for (let k = 0; k < DT.count; k++) {
    const o = k * DAB_STRIDE;
    if (DT.dabs[o + 3] !== 1 || DT.dabs[o + 4] !== 0 || DT.dabs[o + 5] !== 0) jitter++;
    if (Math.hypot(DT.dabs[o + 1], DT.dabs[o + 2]) > 1e-9) jitter++;
  }
  ok(jitter === 0, `dots は揺らがない (${jitter})`);
}

// ---------------------------------------------------------------------------
head('planDabs: 接平面の基底');
{
  const from = new Float32Array([0, 0, 0]);
  const to = new Float32Array([0.5, 0, 0]);
  const radius = 0.1;

  // tangent/bitangent 指定 → 散らしがその平面に乗る
  const r = planDabs('spray', {
    from, to, radius, seed: 7, dabIndex: 0,
    tangent: [1, 0, 0], bitangent: [0, 1, 0],
  });
  let maxZ = 0;
  for (let k = 0; k < r.count; k++) maxZ = Math.max(maxZ, Math.abs(r.dabs[k * DAB_STRIDE + 2]));
  ok(maxZ < 1e-9, `指定した平面から出ない (z 最大 ${maxZ})`);

  // normal 指定 → 法線方向には散らない
  const rn = planDabs('spray', { from, to, radius, seed: 7, dabIndex: 0, normal: [0, 0, 1] });
  let maxZ2 = 0;
  for (let k = 0; k < rn.count; k++) maxZ2 = Math.max(maxZ2, Math.abs(rn.dabs[k * DAB_STRIDE + 2]));
  ok(maxZ2 < 1e-6, `法線方向には散らない (z 最大 ${maxZ2})`);

  // 基底の指定なし → 進行方向から作る（NaN を出さないこと）
  const rf = planDabs('spray', { from, to, radius, seed: 7, dabIndex: 0 });
  let nan = 0;
  for (let i = 0; i < rf.count * DAB_STRIDE; i++) if (!Number.isFinite(rf.dabs[i])) nan++;
  ok(nan === 0, `基底なしでも NaN が出ない (${nan})`);

  // 進行方向が 0 でも壊れない
  const rz = planDabs('spray', { from, to: from, radius, seed: 7, dabIndex: 0 });
  ok(rz.count === 0, '動いていなければ 0 個');

  // 長さ 0 の法線（潰れた面や孤立頂点で実際に起きる）。正規化すると 0 ベクトルに
  // なり、cross が 0 になって基底の片側が消える = 散らしが直線に潰れる。
  const rn0 = planDabs('spray', {
    from, to: new Float32Array([1, 0, 0]), radius, seed: 7, dabIndex: 0, normal: [0, 0, 0],
  });
  let off0 = 0, nan0 = 0;
  for (let k = 0; k < rn0.count; k++) {
    const o = k * DAB_STRIDE;
    for (let e = 0; e < DAB_STRIDE; e++) if (!Number.isFinite(rn0.dabs[o + e])) nan0++;
    off0 = Math.max(off0, Math.hypot(rn0.dabs[o + 1], rn0.dabs[o + 2]));
  }
  ok(nan0 === 0, `法線が 0 でも NaN が出ない (${nan0})`);
  ok(rn0.count > 0 && off0 > 1e-6, `法線が 0 でも散らしが潰れない (最大 ${off0.toFixed(5)})`);

  // NaN 入りの基底 / 法線も同じく作り直しに落ちること
  for (const [nm, extra] of [
    ['法線が NaN', { normal: [NaN, 0, 1] }],
    ['基底が NaN', { tangent: [NaN, 0, 0], bitangent: [0, 1, 0] }],
    ['基底がゼロ', { tangent: [0, 0, 0], bitangent: [0, 0, 0] }],
    ['bitangent 忘れ', { tangent: [0, 1, 0] }],
  ]) {
    const r = planDabs('spray', Object.assign(
      { from, to: new Float32Array([1, 0, 0]), radius, seed: 7, dabIndex: 0 }, extra));
    let nan = 0, off = 0;
    for (let k = 0; k < r.count; k++) {
      const o = k * DAB_STRIDE;
      for (let e = 0; e < DAB_STRIDE; e++) if (!Number.isFinite(r.dabs[o + e])) nan++;
      off = Math.max(off, Math.hypot(r.dabs[o + 1], r.dabs[o + 2]));
    }
    ok(nan === 0 && r.count > 0 && off > 1e-6, `${nm} でも有限で散る (NaN ${nan}, 最大 ${off.toFixed(5)})`);
  }
}

// ---------------------------------------------------------------------------
head('planDabs: 壊れた入力');
{
  const from = new Float32Array([0, 0, 0]);
  const radius = 0.1;

  // 逆投影が外れた等で to に NaN が来ると dist が NaN になる。dist < step の
  // 比較は false 側に落ちるので、素通りさせると count / advance が NaN で返る。
  // advance は呼び出し側のストローク位置に足されるため、一度 NaN を返すと
  // そのストロークが復帰しない。
  for (const nm of ['to', 'from']) {
    const broken = new Float32Array([NaN, 0, 0]);
    const r = planDabs('dots', {
      from: nm === 'from' ? broken : from,
      to: nm === 'to' ? broken : new Float32Array([1, 0, 0]),
      radius, spacing: 0.16, seed: 1, dabIndex: 0,
    });
    ok(Number.isFinite(r.count) && r.count === 0, `${nm} が NaN → count が 0 (${r.count})`);
    ok(r.advance === 0, `${nm} が NaN → advance が 0 (${r.advance})`);
    ok(Number.isFinite(r.step), `${nm} が NaN → step が有限 (${r.step})`);
    // NaN のあと、まともな入力で作業用バッファが壊れていないこと
    const good = planDabs('dots', {
      from, to: new Float32Array([1, 0, 0]), radius, spacing: 0.16, seed: 1, dabIndex: 0,
    });
    ok(good.count === 62 && good.dabs.length >= good.count * DAB_STRIDE,
      `${nm} が NaN の後も普通に動く (${good.count}, buf ${good.dabs.length})`);
  }
  const rd = planDabs('dragRect', { from, to: new Float32Array([NaN, 0, 0]), radius, seed: 1, dabIndex: 0 });
  ok(rd.count === 1 && Number.isFinite(rd.dabs[3]) && rd.dabs[3] > 0 && Number.isFinite(rd.dabs[4]),
    `dragRect も NaN で壊れない (scale ${rd.dabs[3]}, rot ${rd.dabs[4]})`);

  // 上限は整数に丸めてから使う。小数だと非整数長の Float32Array を作ろうとして
  // RangeError になる経路があり、count も小数で返る。
  const rf = planDabs('dots', {
    from, to: new Float32Array([1000, 0, 0]), radius, spacing: 0.02, seed: 1, dabIndex: 0, maxDabs: 1000.3,
  });
  ok(Number.isInteger(rf.count) && rf.count === 1000, `小数の maxDabs でも整数個 (${rf.count})`);

  // 異常に大きい maxDabs で数百 MB を確保しないこと
  const rb = planDabs('dots', {
    from, to: new Float32Array([1e6, 0, 0]), radius, spacing: 0.2, seed: 1, dabIndex: 0, maxDabs: 1e7,
  });
  ok(rb.count === MAX_DABS && rb.truncated === true, `maxDabs は MAX_DABS で頭打ち (${rb.count})`);
  ok(rb.dabs.length <= (MAX_DABS + 1) * DAB_STRIDE, `確保が上限内 (${rb.dabs.length})`);

  // sizeJitter を上げきっても半径 0 のダブを作らない（呼び出し側で 0/0 になる）
  let minScale = Infinity;
  for (let s = 0; s < 60; s++) {
    const r = planDabs('spray', {
      from, to: new Float32Array([1, 0, 0]), radius, spacing: 0.05, sizeJitter: 1,
      seed: s * 7919, dabIndex: s * 101, tangent: [0, 1, 0], bitangent: [0, 0, 1],
    });
    for (let k = 0; k < r.count; k++) minScale = Math.min(minScale, r.dabs[k * DAB_STRIDE + 3]);
  }
  ok(minScale > 0.001, `sizeJitter=1 でもスケールが 0 にならない (最小 ${minScale.toFixed(5)})`);

  // spacing / scatter / sizeJitter に NaN が来たら既定に落ちるだけで済むこと
  const rn = planDabs('spray', {
    from, to: new Float32Array([1, 0, 0]), radius, spacing: NaN, scatter: NaN,
    sizeJitter: NaN, colorJitter: NaN, seed: 1, dabIndex: 0, normal: [0, 1, 0],
  });
  let nanC = 0;
  for (let i = 0; i < rn.count * DAB_STRIDE; i++) if (!Number.isFinite(rn.dabs[i])) nanC++;
  ok(rn.count > 0 && nanC === 0, `パラメータが NaN でも有限 (${rn.count} 個, NaN ${nanC})`);

  // 未知のストローク id は既定に落ちる
  const ru = planDabs('no-such-stroke', { from, to: new Float32Array([1, 0, 0]), radius, seed: 1, dabIndex: 0 });
  const rr = planDabs('dots', { from, to: new Float32Array([1, 0, 0]), radius, seed: 1, dabIndex: 0 });
  ok(ru.count === rr.count && ru.count > 0, `未知のストロークは既定と同じ (${ru.count})`);
  ok(strokeDefaults('no-such-stroke').spacing === STROKE_BY_ID.get(DEFAULT_STROKE).def.spacing,
    'strokeDefaults も既定に落ちる');
}

// ---------------------------------------------------------------------------
head('全アルファ × 全ストロークで NaN / 範囲外が出ないか');
{
  const from = new Float32Array([0.1, -0.2, 0.3]);
  const to = new Float32Array([0.9, 0.4, -0.1]);
  let nan = 0, bad = 0, total = 0;
  for (const sid of STROKE_IDS) {
    for (let d = 0; d < 4; d++) {
      const r = planDabs(sid, {
        from, to, radius: 0.12 + d * 0.05, seed: 31 + d, dabIndex: d * 13,
        normal: [0, 1, 0],
      });
      for (let k = 0; k < r.count; k++) {
        const o = k * DAB_STRIDE;
        for (let e = 0; e < DAB_STRIDE; e++) if (!Number.isFinite(r.dabs[o + e])) nan++;
        if (r.dabs[o + 3] <= 0) bad++;
        total++;
      }
    }
  }
  ok(total > 0, `ダブが生成された (${total})`);
  ok(nan === 0, `NaN がない (${nan})`);
  ok(bad === 0, `スケールが正 (${bad})`);
}

// ---------------------------------------------------------------------------
// ブラシとの結線をシミュレートして、マスク規約が守られるかを確かめる。
// alpha.js 自体はメッシュに触らないが、呼び出し側は
//   f = falloff(t, focal) * (1 - mask[v]) * alphaWeightAt(...)
// の形で使う。この掛け方で「mask = 1 の頂点が動かない」ことを検算する。
head('ブラシへの結線（マスク規約）');
{
  const g = PRIMITIVES.sphere();
  const mesh = new SculptMesh();
  mesh.setGeometry(g.positions, g.indices);

  // 上半球をマスクで完全に保護する
  for (let v = 0; v < mesh.nv; v++) mesh.mask[v] = mesh.positions[v * 3 + 1] > 0 ? 1 : 0;
  const before = mesh.positions.slice(0, mesh.nv * 3);

  const center = new Float32Array([1, 0, 0]);
  const tangent = new Float32Array([0, 1, 0]);
  const bitangent = new Float32Array([0, 0, 1]);
  const R = 0.6;

  // 領域を集める（球の全頂点を渡して、重みで絞る）
  const verts = new Int32Array(mesh.liveVerts);
  let n = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) verts[n++] = v;

  // alphaWeightAt を減衰に掛けたときの重みを自前で計算し、その重みで法線方向に押す
  const P = mesh.positions, N = mesh.normals, MK = mesh.mask;
  let moved = 0, maskedMoved = 0;
  for (let k = 0; k < n; k++) {
    const v = verts[k], i = v * 3;
    const dx = P[i] - center[0], dy = P[i + 1] - center[1], dz = P[i + 2] - center[2];
    const t = Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / R);
    let f = falloff(t, 0);
    f *= (1 - Math.min(1, Math.max(0, MK[v])));
    f *= alphaWeightAt('star', P[i], P[i + 1], P[i + 2], center, tangent, bitangent, R, 0.3);
    if (f === 0) continue;
    P[i] += N[i] * 0.05 * f;
    P[i + 1] += N[i + 1] * 0.05 * f;
    P[i + 2] += N[i + 2] * 0.05 * f;
    moved++;
    if (MK[v] >= 1) maskedMoved++;
  }
  console.log(`  ${moved} 頂点が動いた（アルファで絞られたぶん）`);
  ok(moved > 0, 'アルファ越しでも頂点が動く');
  ok(maskedMoved === 0, `マスク 1 の頂点は 1 つも動かない (${maskedMoved})`);

  let maxUp = 0, nan = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    for (let e = 0; e < 3; e++) {
      const a = P[v * 3 + e];
      if (!Number.isFinite(a)) nan++;
      if (mesh.mask[v] >= 1) maxUp = Math.max(maxUp, Math.abs(a - before[v * 3 + e]));
    }
  }
  ok(nan === 0, `NaN が出ていない (${nan})`);
  ok(maxUp === 0, `保護された頂点の座標が 1 bit も変わらない (${maxUp})`);

  // アルファ soft を掛けても、掛けないときの重みを超えないこと（0..1 の係数である証拠）
  let over = 0;
  for (let k = 0; k < n; k++) {
    const v = verts[k], i = v * 3;
    const dx = P[i] - center[0], dy = P[i + 1] - center[1], dz = P[i + 2] - center[2];
    const t = Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / R);
    const plain = falloff(t, 0);
    const withA = plain * alphaWeightAt('soft', P[i], P[i + 1], P[i + 2],
      center, tangent, bitangent, R, 0);
    if (withA > plain + 1e-9) over++;
  }
  ok(over === 0, `アルファは減衰を増やさない (${over})`);

  // 死んだ頂点は触らない。頂点は削除しても詰めないので、vAlive を見ずに
  // nv まで回すと死んだスロットの古い座標に書き込んでしまう。
  {
    const dead = [];
    for (let v = 5; v < mesh.nv && dead.length < 12; v += 37) {
      if (mesh.vAlive[v]) { mesh.removeVertex(v); dead.push(v); }
    }
    ok(dead.length > 0, `死んだ頂点を作れた (${dead.length})`);
    const snap = new Float32Array(dead.length * 3);
    for (let k = 0; k < dead.length; k++) {
      for (let e = 0; e < 3; e++) snap[k * 3 + e] = P[dead[k] * 3 + e];
    }
    // 領域は vAlive で組む（呼び出し側の規約）
    const v2 = new Int32Array(mesh.liveVerts);
    let n2 = 0, deadIn = 0;
    for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) v2[n2++] = v;
    for (let k = 0; k < n2; k++) if (!mesh.vAlive[v2[k]]) deadIn++;
    ok(deadIn === 0, `領域に死んだ頂点が入らない (${deadIn})`);
    ok(n2 === mesh.liveVerts, `liveVerts と一致 (${n2} / ${mesh.liveVerts})`);
    let touched = 0;
    for (let k = 0; k < n2; k++) {
      const v = v2[k], i = v * 3;
      const w = alphaWeightAt('soft', P[i], P[i + 1], P[i + 2], center, tangent, bitangent, R, 0)
        * (1 - Math.min(1, Math.max(0, MK[v])));
      if (w === 0) continue;
      P[i] += N[i] * 0.01 * w; P[i + 1] += N[i + 1] * 0.01 * w; P[i + 2] += N[i + 2] * 0.01 * w;
      touched++;
    }
    ok(touched > 0, `生きた頂点は動く (${touched})`);
    let moveDead = 0;
    for (let k = 0; k < dead.length; k++) {
      for (let e = 0; e < 3; e++) if (P[dead[k] * 3 + e] !== snap[k * 3 + e]) moveDead++;
    }
    ok(moveDead === 0, `死んだ頂点の座標が 1 bit も変わらない (${moveDead})`);
    // 退化三角形（削除で (0,0,0) になったもの）を数えて、増えていないこと
    let degen = 0;
    for (let t = 0; t < mesh.nt; t++) {
      const i = t * 3, a = mesh.tris[i], b2 = mesh.tris[i + 1], c2 = mesh.tris[i + 2];
      if (a === b2 && b2 === c2) continue;
      if (a === b2 || b2 === c2 || c2 === a) degen++;
    }
    ok(degen === 0, `退化三角形を作っていない (${degen})`);
  }

  // 既存のブラシエンジンが（アルファ抜きで）依然として動くこと = 副作用がない
  const eng = new BrushEngine();
  eng.beginStroke();
  eng.apply(mesh, {
    type: 'clay', verts, count: n, center, radius: R,
    strength: 0.5, dir: 1, delta: new Float32Array(3),
    color: [0.5, 0.5, 0.5], focal: 0, toCamera: null, backface: false, ignoreMask: false,
  });
  let nan2 = 0, mm = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    for (let e = 0; e < 3; e++) {
      if (!Number.isFinite(mesh.positions[v * 3 + e])) nan2++;
      if (mesh.mask[v] >= 1 && mesh.positions[v * 3 + e] !== before[v * 3 + e]) mm++;
    }
  }
  ok(nan2 === 0 && mm === 0, `既存ブラシもマスクを守る (NaN ${nan2} / 動いた ${mm})`);
}

// ---------------------------------------------------------------------------
head('性能（数万頂点ぶんのサンプリング）');
{
  const center = new Float32Array([0, 0, 0]);
  const t = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  const N = 400000;
  const t0 = Date.now();
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const u = ((i * 7919) % 1000) / 1000 - 0.5;
    const v = ((i * 104729) % 1000) / 1000 - 0.5;
    acc += alphaWeightAt('scale', u, v, 0.3, center, t, b, 1, 0.4);
  }
  const ms = Date.now() - t0;
  console.log(`  ${N.toLocaleString()} 回のサンプリング ${ms} ms (合計 ${acc.toFixed(1)})`);
  ok(ms < 2000, `1 ダブぶんの規模でも十分速い (${ms} ms)`);

  // 全アルファの生成コスト
  clearAlphaCache();
  const t1 = Date.now();
  for (const id of ALPHA_IDS) alphaData(id);
  const ms2 = Date.now() - t1;
  console.log(`  ${ALPHA_IDS.length} 枚の生成 ${ms2} ms`);
  ok(ms2 < 3000, `全アルファ生成が現実的な時間 (${ms2} ms)`);
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
