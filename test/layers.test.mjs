// スカルプトレイヤー（js/layers.js）の検証。DOM / WebGPU には触らない。
import { SculptMesh, icosphere } from '../js/mesh.js';
import { Sculptor } from '../js/sculptor.js';
import { SculptLayers } from '../js/layers.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------------------
// メッシュの健全性（core.test.mjs の validate を必要な項目だけ抜き出したもの）

function checkMesh(mesh, label, { closed = true } = {}) {
  const errs = [];
  const T = mesh.tris;

  let liveT = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    liveT++;
    if (a === b || b === c || c === a) errs.push(`tri ${t} degenerate`);
    for (const v of [a, b, c]) {
      if (v < 0 || v >= mesh.nv) errs.push(`tri ${t} vert ${v} out of range`);
      else if (!mesh.vAlive[v]) errs.push(`tri ${t} refs dead vert ${v}`);
    }
  }
  if (liveT !== mesh.liveTris) errs.push(`liveTris mismatch ${liveT} != ${mesh.liveTris}`);

  // ring 整合性（双方向）
  for (let v = 0; v < mesh.nv; v++) {
    const r = mesh.ringArray(v);
    if (!mesh.vAlive[v]) { if (r && r.length) errs.push(`dead vert ${v} has ring`); continue; }
    const seen = new Set();
    for (const t of r) {
      if (seen.has(t)) errs.push(`vert ${v} ring dup tri ${t}`);
      seen.add(t);
      const i = t * 3;
      if (T[i] !== v && T[i + 1] !== v && T[i + 2] !== v) errs.push(`vert ${v} ring tri ${t} lacks v`);
    }
  }

  // 多様体性 + オイラー標数（閉じた球面なら各辺 2 面 / χ = 2）
  if (closed) {
    const em = new Map();
    for (let t = 0; t < mesh.nt; t++) {
      const i = t * 3, v = [T[i], T[i + 1], T[i + 2]];
      if (v[0] === v[1] && v[1] === v[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3];
        const key = a < b ? a + ':' + b : b + ':' + a;
        em.set(key, (em.get(key) || 0) + 1);
      }
    }
    let bad = 0, boundary = 0;
    for (const [, n] of em) { if (n === 1) boundary++; else if (n !== 2) bad++; }
    if (bad) errs.push(`${bad} non-manifold edges`);
    if (boundary) errs.push(`${boundary} boundary edges`);
    const chi = mesh.liveVerts - em.size + mesh.liveTris;
    if (chi !== 2) errs.push(`Euler characteristic ${chi} != 2`);
  }

  const nf = nonFinite(mesh);
  if (nf) errs.push(`${nf} non-finite position/normal components`);

  if (errs.length) {
    failures++;
    console.log(`  FAIL ${label}: ${errs.length} problem(s)`);
    errs.slice(0, 6).forEach(e => console.log('      - ' + e));
  } else {
    console.log(`  ok   ${label}  V=${mesh.liveVerts} F=${mesh.liveTris}`);
  }
  return errs.length === 0;
}

function nonFinite(m) {
  let bad = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(m.positions[v * 3 + k])) bad++;
      if (!Number.isFinite(m.normals[v * 3 + k])) bad++;
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------

function sphere(sub = 4) {
  const g = icosphere(sub, 1);
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  return m;
}
function snap(m) { return m.positions.slice(0, m.nv * 3); }
function maxDiff(a, b, nv) {
  let d = 0;
  for (let i = 0; i < nv * 3; i++) {
    const x = Math.abs(a[i] - b[i]);
    if (x > d) d = x;
  }
  return d;
}
/** 0 <= v < nv から stride ごとに頂点を選ぶ（ブラシの領域リスト相当） */
function pick(m, stride, offset = 0) {
  const out = [];
  for (let v = offset; v < m.nv; v += stride) if (m.vAlive[v]) out.push(v);
  return new Int32Array(out);
}
/** ブラシの代わり。法線方向へ amp 動かす（マスク規約 1 = 動かない を守る） */
function pushAlongNormal(m, verts, count, amp) {
  const P = m.positions, N = m.normals, MK = m.mask;
  for (let k = 0; k < count; k++) {
    const v = verts[k], i = v * 3;
    const mk = MK[v] < 0 ? 0 : (MK[v] > 1 ? 1 : MK[v]);
    const w = 1 - mk;
    if (w === 0) continue;
    P[i] += N[i] * amp * w; P[i + 1] += N[i + 1] * amp * w; P[i + 2] += N[i + 2] * amp * w;
  }
}
/** 1 ダブぶんの記録つき彫刻 */
function dab(L, m, verts, amp) {
  L.captureBefore(m, verts, verts.length);
  pushAlongNormal(m, verts, verts.length, amp);
  return L.commitAfter(m, verts, verts.length);
}

function makeState(over = {}) {
  return Object.assign({
    brush: 'clay', radiusPx: 90, strength: 0.7, paintColor: [0.6, 0.2, 0.15],
    worldRadius: 0.3, dynTopo: false, decimate: false, detail: 0.55, maxVerts: 400000,
    symmetry: { x: false, y: false, z: false },
  }, over);
}

/**
 * Sculptor へレイヤーを配線する（実際に main.js / sculptor.js でやるのと同じ位置）。
 * ブラシ適用の直前 / 直後に captureBefore / commitAfter を挟むだけ。
 */
function hookLayers(s, L) {
  const engine = s.engine;
  const orig = engine.apply;
  engine.apply = function (mesh, c) {
    L.captureBefore(mesh, c.verts, c.count);
    const r = orig.call(this, mesh, c);
    L.commitAfter(mesh, c.verts, c.count);
    return r;
  };
}

function stroke(s, brush, at, samples = 16, dir = 1) {
  s.beginStroke(brush, at(0), dir);
  for (let k = 1; k <= samples; k++) s.addSample(at(k / samples));
  s.endStroke();
}

// ---------------------------------------------------------------------------
head('強度 0 / 1 の往復（1 枚）');
{
  const m = sphere(4);
  const L = new SculptLayers();
  L.setBase(m);
  const before = snap(m);

  const li = L.add('Detail');
  ok(li === 0, `add が index 0 を返す (${li})`);
  ok(L.recording === 0, `追加したレイヤーが記録対象になる (${L.recording})`);

  const verts = pick(m, 3);
  const st = dab(L, m, verts, 0.09);
  ok(st.added === verts.length, `触った頂点だけが登録される (${st.added} / ${verts.length})`);
  ok(st.moved === verts.length, `動いた頂点数 (${st.moved})`);
  const sculpted = snap(m);
  ok(maxDiff(before, sculpted, m.nv) > 0.05, '彫刻で形が変わっている');

  L.setIntensity(0, 0);
  L.rebuild(m);
  const d0 = maxDiff(before, snap(m), m.nv);
  ok(d0 === 0, `強度 0 で彫刻前の形に厳密に戻る (最大差 ${d0})`);
  checkMesh(m, 'intensity 0');

  L.setIntensity(0, 1);
  L.rebuild(m);
  const d1 = maxDiff(sculpted, snap(m), m.nv);
  console.log(`  強度 1 に戻したときの最大差: ${d1.toExponential(2)}`);
  ok(d1 <= 1e-6, `強度 1 で彫刻後の形に戻る (最大差 ${d1.toExponential(2)})`);
  checkMesh(m, 'intensity 1');

  // 中間の強度は線形補間になっている
  L.setIntensity(0, 0.5);
  L.rebuild(m);
  let maxRel = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    for (let c = 0; c < 3; c++) {
      const i = v * 3 + c;
      const want = before[i] + (sculpted[i] - before[i]) * 0.5;
      maxRel = Math.max(maxRel, Math.abs(m.positions[i] - want));
    }
  }
  ok(maxRel < 1e-6, `強度 0.5 で中間の形になる (最大差 ${maxRel.toExponential(2)})`);

  // 負の強度で彫刻が反転する
  L.setIntensity(0, -1);
  L.rebuild(m);
  let maxNeg = 0;
  for (let i = 0; i < m.nv * 3; i++) {
    maxNeg = Math.max(maxNeg, Math.abs(m.positions[i] - (2 * before[i] - sculpted[i])));
  }
  ok(maxNeg < 1e-6, `強度 -1 で彫刻が反転する (最大差 ${maxNeg.toExponential(2)})`);

  // rebuild はべき等（何回呼んでも同じ）
  L.setIntensity(0, 0.35);
  L.rebuild(m);
  const once = snap(m);
  L.rebuild(m); L.rebuild(m);
  ok(maxDiff(once, snap(m), m.nv) === 0, 'rebuild を繰り返しても結果が変わらない');
}

// ---------------------------------------------------------------------------
head('2 枚のレイヤーが独立に効く');
{
  const m = sphere(4);
  const L = new SculptLayers();
  L.setBase(m);
  const P0 = snap(m);

  const vA = pick(m, 4, 0);
  const vB = pick(m, 4, 1);          // A と重ならない集合
  const vC = pick(m, 6, 0);          // A と重なる集合

  L.add('A');
  dab(L, m, vA, 0.08);
  const dA = new Float32Array(m.nv * 3);
  for (let i = 0; i < m.nv * 3; i++) dA[i] = m.positions[i] - P0[i];

  const bi = L.add('B');
  ok(bi === 1 && L.recording === 1, '2 枚目が記録対象になる');
  dab(L, m, vB, -0.05);
  dab(L, m, vC, 0.04);               // A と重なる頂点も含めて彫る
  const both = snap(m);
  const dB = new Float32Array(m.nv * 3);
  for (let i = 0; i < m.nv * 3; i++) dB[i] = both[i] - P0[i] - dA[i];

  ok(L.count === 2, `レイヤーが 2 枚 (${L.count})`);

  // B を切ると A だけが残る
  L.setIntensity(1, 0);
  L.rebuild(m);
  let d = 0;
  for (let i = 0; i < m.nv * 3; i++) d = Math.max(d, Math.abs(m.positions[i] - (P0[i] + dA[i])));
  ok(d < 1e-6, `B を 0 にすると A の彫刻だけが残る (最大差 ${d.toExponential(2)})`);

  // A を切ると B だけが残る
  L.setIntensity(0, 0);
  L.setIntensity(1, 1);
  L.rebuild(m);
  d = 0;
  for (let i = 0; i < m.nv * 3; i++) d = Math.max(d, Math.abs(m.positions[i] - (P0[i] + dB[i])));
  ok(d < 1e-6, `A を 0 にすると B の彫刻だけが残る (最大差 ${d.toExponential(2)})`);

  // 両方切るとベース
  L.setIntensity(1, 0);
  L.rebuild(m);
  ok(maxDiff(P0, snap(m), m.nv) === 0, '両方 0 でベースに厳密に戻る');

  // 両方戻すと加算された形
  L.setIntensity(0, 1); L.setIntensity(1, 1);
  L.rebuild(m);
  d = maxDiff(both, snap(m), m.nv);
  ok(d < 1e-6, `両方 1 で 2 枚が加算される (最大差 ${d.toExponential(2)})`);

  // 可視トグルは強度 0 と同じ扱い
  L.setVisible(1, false);
  L.rebuild(m);
  d = 0;
  for (let i = 0; i < m.nv * 3; i++) d = Math.max(d, Math.abs(m.positions[i] - (P0[i] + dA[i])));
  ok(d < 1e-6, `非表示は強度 0 と同じ (最大差 ${d.toExponential(2)})`);
  L.setVisible(1, true);
  L.rebuild(m);
  checkMesh(m, '2 layers');
}

// ---------------------------------------------------------------------------
head('同じ頂点を何度彫っても二重に入らない');
{
  const m = sphere(4);
  const L = new SculptLayers();
  L.setBase(m);
  const P0 = snap(m);
  L.add('Repeat');

  const verts = pick(m, 5);
  let st = null;
  for (let i = 0; i < 8; i++) st = dab(L, m, verts, 0.012);   // 同じ集合を 8 回なでる
  const sculpted = snap(m);

  ok(st.verts === verts.length,
    `8 回なでても登録は頂点数どおり (${st.verts} / ${verts.length})`);
  ok(st.added === 0, `2 回目以降は新規登録が起きない (${st.added})`);

  // 疎配列の中に同じ頂点が 2 度入っていないこと
  const inner = L.layers[0];
  const set = new Set();
  let dup = 0;
  for (let k = 0; k < inner.n; k++) { if (set.has(inner.idx[k])) dup++; set.add(inner.idx[k]); }
  ok(dup === 0, `疎配列に重複した頂点が無い (${dup})`);

  L.setIntensity(0, 0);
  L.rebuild(m);
  ok(maxDiff(P0, snap(m), m.nv) === 0, '8 回ぶんが 1 枚に積まれ、0 で厳密にベースへ戻る');
  L.setIntensity(0, 1);
  L.rebuild(m);
  const d = maxDiff(sculpted, snap(m), m.nv);
  ok(d <= 1e-6, `1 に戻すと 8 回ぶんの結果に戻る（二重にならない）(最大差 ${d.toExponential(2)})`);

  // 変位の大きさが 8 回ぶん（1 回ぶんの 8 倍前後）で、16 倍にはなっていない
  let mx = 0;
  for (let k = 0; k < inner.n; k++) {
    const j = k * 3;
    mx = Math.max(mx, Math.hypot(inner.disp[j], inner.disp[j + 1], inner.disp[j + 2]));
  }
  console.log(`  変位の最大長 ${mx.toFixed(5)} (1 回 0.012 × 8 = 0.096 相当)`);
  ok(mx > 0.08 && mx < 0.12, `変位が 8 回ぶんに収まっている (${mx.toFixed(5)})`);
}

// ---------------------------------------------------------------------------
head('記録中の強度が 1 でないとき');
{
  // 強度 0.5 のレイヤーへ記録すると 1/0.5 倍で積まれ、画面の形と rebuild が一致する
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  L.add('Half');
  L.setIntensity(0, 0.5);
  const verts = pick(m, 3);
  dab(L, m, verts, 0.07);
  const sculpted = snap(m);
  L.rebuild(m);
  const d = maxDiff(sculpted, snap(m), m.nv);
  ok(d < 1e-6, `強度 0.5 で記録しても rebuild が画面の形を再現する (最大差 ${d.toExponential(2)})`);

  // 1 に上げると 2 倍出てくる（ZBrush の強度と同じ意味）
  const P0 = L.base.slice(0, m.nv * 3);
  L.setIntensity(0, 1);
  L.rebuild(m);
  let mx = 0;
  for (let i = 0; i < m.nv * 3; i++) {
    mx = Math.max(mx, Math.abs((m.positions[i] - P0[i]) - 2 * (sculpted[i] - P0[i])));
  }
  ok(mx < 1e-6, `強度を 2 倍にすると変位も 2 倍になる (最大差 ${mx.toExponential(2)})`);

  // 強度 0（＝切れている）レイヤーへ記録した場合はゼロ割りせず、そのまま積む
  const m2 = sphere(3);
  const L2 = new SculptLayers();
  L2.setBase(m2);
  L2.add('Off');
  L2.setIntensity(0, 0);
  const v2 = pick(m2, 3);
  const before2 = snap(m2);
  dab(L2, m2, v2, 0.07);
  const raw = snap(m2);
  L2.rebuild(m2);
  ok(nonFinite(m2) === 0, '強度 0 のレイヤーへ記録しても NaN / Inf が出ない');
  ok(maxDiff(before2, snap(m2), m2.nv) === 0, '切れたレイヤーへの彫刻は rebuild で消える');
  L2.setIntensity(0, 1);
  L2.rebuild(m2);
  const d2 = maxDiff(raw, snap(m2), m2.nv);
  ok(d2 <= 1e-6, `強度を上げると彫った量がそのまま出る (最大差 ${d2.toExponential(2)})`);
}

// ---------------------------------------------------------------------------
head('マスク');
{
  const m = sphere(4);
  // 上半分を完全に保護（規約: 1 = 動かない）
  let masked = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    if (m.positions[v * 3 + 1] > 0.2) { m.mask[v] = 1; masked++; }
  }
  const L = new SculptLayers();
  L.setBase(m);
  const P0 = snap(m);
  L.add('Masked');
  const verts = pick(m, 2);
  const st = dab(L, m, verts, 0.1);

  // マスク 1 の頂点は 1 つも動いていない
  let moved = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v] || m.mask[v] < 1) continue;
    const i = v * 3;
    if (m.positions[i] !== P0[i] || m.positions[i + 1] !== P0[i + 1] || m.positions[i + 2] !== P0[i + 2]) moved++;
  }
  ok(moved === 0, `マスク 1 の頂点が 1 つも動いていない (${moved} / ${masked})`);

  // マスクされた頂点はレイヤーにも登録されていない（疎配列が無駄に太らない）
  const inner = L.layers[0];
  let bad = 0;
  for (let k = 0; k < inner.n; k++) if (m.mask[inner.idx[k]] >= 1) bad++;
  ok(bad === 0, `マスク 1 の頂点がレイヤーに入っていない (${bad})`);
  ok(inner.n > 0 && inner.n < verts.length,
    `保護されていない頂点だけが登録されている (${inner.n} / ${verts.length})`);
  console.log(`  マスク ${masked} 頂点 / 登録 ${inner.n} 頂点 / 領域 ${verts.length} 頂点`);

  L.setIntensity(0, 0);
  L.rebuild(m);
  ok(maxDiff(P0, snap(m), m.nv) === 0, 'マスクありでも強度 0 で厳密に戻る');

  // 強度をどう動かしても保護された頂点は 1 ビットも動かないこと。
  // レイヤーに入っていない頂点は rebuild が書き戻さない、という規約の検算。
  let drift = 0;
  for (const iv of [1, -1, 0.5, 0]) {
    L.setIntensity(0, iv);
    L.rebuild(m);
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v] || m.mask[v] < 1) continue;
      const i = v * 3;
      if (m.positions[i] !== P0[i] || m.positions[i + 1] !== P0[i + 1] || m.positions[i + 2] !== P0[i + 2]) drift++;
    }
  }
  ok(drift === 0, `強度を往復させてもマスク 1 の頂点が動かない (${drift})`);
}

// ---------------------------------------------------------------------------
head('ベイク');
{
  const m = sphere(4);
  const L = new SculptLayers();
  L.setBase(m);
  L.add('A');
  dab(L, m, pick(m, 4, 0), 0.06);
  L.add('B');
  dab(L, m, pick(m, 4, 1), 0.05);
  L.setIntensity(1, 0.6);
  L.rebuild(m);
  const looks = snap(m);

  const st = L.bake(0, m);
  ok(st !== null && st.baked === true, 'ベイクが成立する');
  ok(L.count === 1, `ベイクしたレイヤーが消える (${L.count})`);
  ok(L.list()[0].name === 'B', `残ったのは B (${L.list()[0].name})`);
  L.rebuild(m);
  const d = maxDiff(looks, snap(m), m.nv);
  ok(d < 1e-5, `ベイク後も見た目の形が変わらない (最大差 ${d.toExponential(2)})`);
  checkMesh(m, 'after bake');

  // 残った B の強度がまだ効く（ベイクは A だけを固めた）
  L.setIntensity(0, 0);
  L.rebuild(m);
  ok(maxDiff(looks, snap(m), m.nv) > 1e-4, 'ベイク後も残ったレイヤーの強度は効く');
  L.setIntensity(0, 0.6);
  L.rebuild(m);
  ok(maxDiff(looks, snap(m), m.nv) < 1e-5, '強度を戻すと元の見た目に戻る');

  // 切れているレイヤーのベイクは形を変えずに消えるだけ
  const before = snap(m);
  L.setVisible(0, false);
  L.rebuild(m);
  const hidden = snap(m);
  const st2 = L.bake(0, m);
  ok(st2 !== null && st2.baked === false, '非表示レイヤーは焼かずに削除される');
  L.rebuild(m);
  ok(maxDiff(hidden, snap(m), m.nv) === 0, '非表示レイヤーのベイクで形が変わらない');
  ok(maxDiff(before, snap(m), m.nv) > 1e-4, '（非表示にした時点で形は変わっている＝比較が有効）');
  ok(L.count === 0, `全部ベイクして 0 枚 (${L.count})`);
}

// ---------------------------------------------------------------------------
head('複製 / 削除 / 名前 / 選択');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  const P0 = snap(m);
  L.add('A');
  dab(L, m, pick(m, 3), 0.05);
  const one = snap(m);

  const di = L.duplicate(0);
  ok(di === 1, `複製は 1 つ上に挿さる (${di})`);
  ok(L.list()[1].verts === L.list()[0].verts, '複製の頂点数が一致する');
  L.rebuild(m);
  let mx = 0;
  for (let i = 0; i < m.nv * 3; i++) mx = Math.max(mx, Math.abs((m.positions[i] - P0[i]) - 2 * (one[i] - P0[i])));
  ok(mx < 1e-6, `複製で変位が 2 倍になる (最大差 ${mx.toExponential(2)})`);

  ok(L.rename(1, '二枚目') === true, 'rename が成立');
  ok(L.list()[1].name === '二枚目', '名前が変わる');
  ok(L.rename(9, 'x') === false, '範囲外の rename は false');
  ok(L.setVisible(-1, true) === false, '範囲外の setVisible は false');
  ok(L.setIntensity(9, 0.5) === 0, '範囲外の setIntensity は 0');
  ok(L.select(9) === false, '範囲外の select は false');
  ok(L.select(-1) === true && L.recording === -1, 'select(-1) で記録を止められる');

  // 記録対象が無いときは記録されない
  const held = snap(m);
  const stray = pick(m, 7);
  ok(L.captureBefore(m, stray, 3) === 0, '記録対象なしでは captureBefore が 0');
  pushAlongNormal(m, stray, 3, 0.03);
  const st = L.commitAfter(m, stray, 3);
  ok(st.moved === 0 && st.added === 0, '記録対象なしでは commitAfter が何もしない');
  ok(L.list()[0].verts === L.list()[1].verts, '記録対象なしの彫刻はどのレイヤーにも入らない');
  // レイヤーの外で動かした 3 頂点はレイヤーの管理外なので、以降の比較から外すために戻す
  m.positions.set(held.subarray(0, m.nv * 3));

  ok(L.remove(0) === true, 'remove が成立');
  ok(L.count === 1, `1 枚になる (${L.count})`);
  L.rebuild(m);
  mx = maxDiff(one, snap(m), m.nv);
  ok(mx < 1e-6, `1 枚消すと 1 枚ぶんの形になる (最大差 ${mx.toExponential(2)})`);
  ok(L.remove(5) === false, '範囲外の remove は false');
  L.remove(0);
  L.rebuild(m);
  ok(maxDiff(P0, snap(m), m.nv) === 0, '全部消すとベースに厳密に戻る');
  checkMesh(m, 'after removes');

  // 記録対象の付け替え（slotOf の張り替え）が壊れていないこと
  L.add('X');
  const vx = pick(m, 4, 0);
  dab(L, m, vx, 0.04);
  L.add('Y');
  const vy = pick(m, 4, 0);          // X と同じ集合をわざと選ぶ
  dab(L, m, vy, 0.04);
  L.select(0);
  dab(L, m, vx, 0.04);               // X へ戻って追加で彫る
  ok(L.list()[0].verts === vx.length, `X の登録数が増えていない (${L.list()[0].verts})`);
  ok(L.list()[1].verts === vy.length, `Y の登録数も正しい (${L.list()[1].verts})`);
  const two = snap(m);
  L.setIntensity(0, 0); L.setIntensity(1, 0);
  L.rebuild(m);
  ok(maxDiff(P0, snap(m), m.nv) === 0, '記録対象を往復させてもベースへ厳密に戻る');
  L.setIntensity(0, 1); L.setIntensity(1, 1);
  L.rebuild(m);
  ok(maxDiff(two, snap(m), m.nv) <= 1e-6, '記録対象を往復させても彫刻後の形に戻る');
}

// ---------------------------------------------------------------------------
head('トポロジ変化で無効化される');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  L.add('A');
  dab(L, m, pick(m, 3), 0.05);
  ok(L.validate(m) === true, '触っていなければ有効');

  // 接続を変えると頂点番号が意味を失うので破棄される
  m.topoVersion++;
  ok(L.validate(m) === false, 'topoVersion が変わると無効になる');
  ok(L.count === 0, `無効化でレイヤーが捨てられる (${L.count})`);
  ok(L.recording === -1, '記録対象も外れる');
  ok(L.rebuild(m).invalid === true, '無効なら rebuild は何もしない');
  ok(L.captureBefore(m, pick(m, 3), 4) === 0, '無効なら captureBefore は 0');
  ok(L.bake(0, m) === null, '無効なら bake は null');
  ok(L.add('B') === -1, 'ベース未設定では add できない');

  // 実際の dyntopo ストロークでも壊れずに無効化されるだけ
  const m2 = sphere(3);
  const L2 = new SculptLayers();
  L2.setBase(m2);
  L2.add('A');
  const s = new Sculptor(m2, makeState({ dynTopo: true, decimate: true, detail: 0.8 }));
  hookLayers(s, L2);
  const pt = new Float32Array(3);
  stroke(s, 'clay', (u) => {
    const th = u * 0.9;
    pt[0] = Math.cos(th); pt[1] = 0.2; pt[2] = Math.sin(th);
    return pt;
  });
  ok(L2.validate(m2) === false, '動的トポロジのストロークでレイヤーが無効になる');
  ok(nonFinite(m2) === 0, '無効化されても NaN が出ない');
  checkMesh(m2, 'dyntopo + layers（無効化後）');
}

// ---------------------------------------------------------------------------
head('実ブラシのストローク（Sculptor 経由 / シンメトリあり）');
{
  const m = sphere(5);
  const L = new SculptLayers();
  const state = makeState({ dynTopo: false, symmetry: { x: true, y: false, z: false } });
  const s = new Sculptor(m, state);
  L.setBase(m);
  const P0 = snap(m);
  L.add('Sculpt');
  hookLayers(s, L);

  const pt = new Float32Array(3);
  state.worldRadius = 0.25;
  for (const brush of ['clay', 'draw', 'crease', 'inflate', 'flatten', 'smooth', 'pinch']) {
    stroke(s, brush, (u) => {
      const th = 0.3 + u * 0.7, ph = -0.3 + u * 0.6;
      pt[0] = Math.cos(ph) * Math.cos(th); pt[1] = Math.sin(ph); pt[2] = Math.cos(ph) * Math.sin(th);
      return pt;
    }, 12);
  }
  const sculpted = snap(m);
  const info = L.list()[0];
  console.log(`  ${info.verts.toLocaleString()} / ${m.liveVerts.toLocaleString()} 頂点を記録`
    + ` (${(info.verts / m.liveVerts * 100).toFixed(1)}%) / ${(L.bytes() / 1048576).toFixed(2)} MB`);
  ok(info.verts > 0 && info.verts < m.liveVerts, '一部の頂点だけが記録されている');
  ok(L.validate(m) === true, 'dynTopo オフのストロークではレイヤーが生き残る');
  checkMesh(m, 'ストローク後');

  L.setIntensity(0, 0);
  const rb = L.rebuild(m);
  console.log(`  rebuild: ${rb.verts.toLocaleString()} 頂点を書き戻し / 有効レイヤー ${rb.layers}`);
  ok(rb.verts === info.verts, `rebuild の統計が登録数と一致 (${rb.verts})`);
  const d0 = maxDiff(P0, snap(m), m.nv);
  ok(d0 === 0, `実ブラシでも強度 0 で彫刻前の形に厳密に戻る (最大差 ${d0})`);
  checkMesh(m, '強度 0');

  L.setIntensity(0, 1);
  L.rebuild(m);
  const d1 = maxDiff(sculpted, snap(m), m.nv);
  console.log(`  強度 1 に戻したときの最大差: ${d1.toExponential(2)}`);
  ok(d1 <= 1e-6, `実ブラシでも強度 1 で彫刻後の形に戻る (最大差 ${d1.toExponential(2)})`);
  ok(nonFinite(m) === 0, '法線まで含めて NaN / Inf が無い');
  checkMesh(m, '強度 1');

  // 2 枚目を重ねてから 1 枚目だけ消す
  L.add('Second');
  state.worldRadius = 0.2;
  stroke(s, 'crease', (u) => {
    pt[0] = -0.2; pt[1] = Math.cos(0.4 + u * 0.5); pt[2] = Math.sin(0.4 + u * 0.5);
    return pt;
  }, 12);
  const two = snap(m);
  L.setIntensity(0, 0);
  L.rebuild(m);
  ok(maxDiff(two, snap(m), m.nv) > 1e-3, '1 枚目を切ると形が変わる');
  L.setIntensity(0, 1);
  L.rebuild(m);
  ok(maxDiff(two, snap(m), m.nv) <= 1e-6, '1 枚目を戻すと 2 枚重ねた形に戻る');
  L.setIntensity(1, 0);
  L.rebuild(m);
  const d2 = maxDiff(sculpted, snap(m), m.nv);
  ok(d2 <= 1e-6, `2 枚目だけ切ると 1 枚目までの形に戻る (最大差 ${d2.toExponential(2)})`);
  checkMesh(m, '2 枚重ね');
}

// ---------------------------------------------------------------------------
head('メモリと計算量');
{
  const m = sphere(6);                 // 40,962 頂点
  const L = new SculptLayers();
  L.setBase(m);
  const dense = m.nv * 3 * 4;          // 全頂点ぶんの Float32Array 1 枚の大きさ

  const t0 = Date.now();
  for (let i = 0; i < 8; i++) {
    L.add('L' + i);
    dab(L, m, pick(m, 40, i), 0.01);   // 各レイヤーが全体の 2.5% を触る
  }
  const tRec = Date.now() - t0;

  const bytes = L.bytes();
  console.log(`  ${m.nv.toLocaleString()} 頂点 / 8 枚 / 各 ${L.list()[0].verts} 頂点`);
  console.log(`  実測 ${(bytes / 1024).toFixed(0)} KB  (全頂点ぶんを 8 枚持つと ${(dense * 3 * 8 / 1024).toFixed(0)} KB)`);
  ok(bytes < dense * 3 * 8 * 0.35, `疎表現が密表現よりずっと小さい (${bytes} < ${dense * 3 * 8})`);
  ok(tRec < 2000, `記録が現実的な時間で終わる (${tRec} ms)`);

  const t1 = Date.now();
  for (let i = 0; i < 20; i++) {
    L.setIntensity(i % 8, (i % 5) / 4);
    L.rebuild(m, { normals: false });   // スライダのドラッグ相当
  }
  const tRb = Date.now() - t1;
  console.log(`  rebuild(normals:false) × 20 回で ${tRb} ms`);
  ok(tRb < 1500, `強度スライダの連続操作に耐える (${tRb} ms)`);

  for (let i = 0; i < 8; i++) L.setIntensity(i, 1);
  L.rebuild(m, { normals: true, curvature: true });
  ok(nonFinite(m) === 0, '大きなメッシュでも NaN が出ない');
  checkMesh(m, '8 枚 / 40k 頂点');

  // 全部ベイクしても形が変わらない
  const looks = snap(m);
  while (L.count > 0) L.bake(0, m);
  L.rebuild(m);
  ok(maxDiff(looks, snap(m), m.nv) < 1e-5, '8 枚まとめてベイクしても形が変わらない');
  ok(L.count === 0, '全部消えている');
}

// ---------------------------------------------------------------------------
// 回帰: rebuild は「どれかのレイヤーが持っている頂点」しか見ないので、削除やベイクで
// 持ち主が消えた頂点を預かっていないと、彫刻が入ったまま取り残される。
head('持ち主が消えた頂点の回収');
{
  const m = sphere(4);
  const L = new SculptLayers();
  L.setBase(m);
  const P0 = snap(m);

  // 1 枚だけ彫って消す → 残るレイヤーが 0 枚でもベースへ戻ること
  L.add('Only');
  dab(L, m, pick(m, 3), 0.07);
  ok(maxDiff(P0, snap(m), m.nv) > 0.05, '彫れている');
  L.remove(0);
  const rb = L.rebuild(m);
  ok(rb.verts > 0, `0 枚になっても回収対象が報告される (${rb.verts})`);
  ok(maxDiff(P0, snap(m), m.nv) === 0, '最後の 1 枚を消すとベースへ厳密に戻る');

  // 重なった 2 枚のうち片方を消す → 残った側の寄与だけになること
  L.add('A');
  const va = pick(m, 3, 0);
  dab(L, m, va, 0.06);
  const onlyA = snap(m);
  L.add('B');
  dab(L, m, va, 0.05);               // A と完全に同じ集合
  L.remove(1);
  L.rebuild(m);
  const d = maxDiff(onlyA, snap(m), m.nv);
  ok(d <= 1e-6, `重なっている B を消すと A の形だけが残る (最大差 ${d.toExponential(2)})`);

  // 消したあと rebuild せずに次のレイヤーへ彫っても、ベースとの関係が壊れないこと
  L.add('C');
  dab(L, m, pick(m, 5, 1), 0.04);
  L.remove(0);                       // rebuild を挟まずに A を消す
  L.rebuild(m);
  const onlyC = snap(m);
  L.setIntensity(0, 0);
  L.rebuild(m);
  ok(maxDiff(P0, snap(m), m.nv) === 0, '削除と彫刻を混ぜてもベースへ厳密に戻る');
  L.setIntensity(0, 1);
  L.rebuild(m);
  ok(maxDiff(onlyC, snap(m), m.nv) === 0, '強度の往復も一致する');
  checkMesh(m, '回収後');
}

// ---------------------------------------------------------------------------
head('レイヤー外の編集を巻き戻さない');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  L.add('A');
  const inLayer = pick(m, 4, 0);
  dab(L, m, inLayer, 0.05);

  // レイヤーが触っていない頂点を直接動かす（記録レイヤー無しで彫った状況）
  const touched = new Set(Array.from(L.layers[0].idx.subarray(0, L.layers[0].n)));
  let free = -1;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && !touched.has(v)) { free = v; break; }
  ok(free >= 0, 'レイヤー外の頂点が見つかる');
  m.positions[free * 3 + 1] += 0.25;
  const want = m.positions[free * 3 + 1];
  L.rebuild(m);
  ok(m.positions[free * 3 + 1] === want, 'レイヤーが触っていない頂点は rebuild で巻き戻されない');
}

// ---------------------------------------------------------------------------
head('境界条件');
{
  const L = new SculptLayers();
  ok(L.count === 0 && L.recording === -1, '初期状態');
  ok(L.validate({ topoVersion: 0, nv: 0 }) === false, 'ベース未設定なら validate は false');
  ok(L.list().length === 0, 'list は空配列');
  ok(L.bytes() >= 0, 'bytes が呼べる');
  ok(L.remove(0) === false, '空で remove しても false');
  ok(L.duplicate(0) === -1, '空で duplicate しても -1');

  const m = sphere(2);
  L.setBase(m);
  ok(L.count === 0, 'setBase 直後は 0 枚');
  ok(L.rebuild(m).verts === 0, '0 枚の rebuild は何も動かさない');
  const P0 = snap(m);
  L.add('A');
  ok(L.captureBefore(m, new Int32Array(0), 0) === 0, 'count 0 の captureBefore は 0');
  ok(L.commitAfter(m, new Int32Array(0), 0).moved === 0, '捕獲なしの commitAfter は何もしない');

  // 動かさずに commit しても登録は増えない
  const verts = pick(m, 3);
  L.captureBefore(m, verts, verts.length);
  const st = L.commitAfter(m, verts, verts.length);
  ok(st.added === 0 && st.moved === 0, `動いていなければ何も積まない (${st.added})`);
  ok(L.list()[0].verts === 0, '登録 0 のまま');

  // setBase をやり直すとレイヤーは消える
  dab(L, m, verts, 0.04);
  ok(L.list()[0].verts > 0, '彫れば登録される');
  L.setBase(m);
  ok(L.count === 0 && L.recording === -1, 'setBase でレイヤーが全消去される');
  ok(maxDiff(snap(m), L.base, m.nv) === 0, '新しいベースが今の形になっている');

  // NaN 強度を弾く
  L.add('N');
  ok(L.setIntensity(0, NaN) === 0, 'NaN 強度は 0 に落ちる');
  ok(L.setIntensity(0, 5) === 1, '1 より大きい強度は 1 に丸める');
  ok(L.setIntensity(0, -5) === -1, '-1 より小さい強度は -1 に丸める');
  dab(L, m, verts, 0.03);
  L.setIntensity(0, NaN);
  L.rebuild(m);
  ok(nonFinite(m) === 0, 'NaN 強度でメッシュが壊れない');
  ok(P0.length > 0, '（初期スナップショットが取れている）');
  L.clear();
  ok(L.count === 0 && L.base === null, 'clear で完全に初期化される');
}

// ---------------------------------------------------------------------------
// 「実効強度で焼く」ことの検算。強度 1 のレイヤーだけを焼いていると 1 倍で
// 焼いても通ってしまうので、中間の強度で確かめる。
head('中間強度のベイク');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  L.add('A');
  dab(L, m, pick(m, 3), 0.06);
  L.setIntensity(0, 0.4);
  L.rebuild(m);
  const looks = snap(m);

  const st = L.bake(0, m);
  ok(st !== null && st.baked === true && Math.abs(st.intensity - 0.4) < 1e-6,
    `実効強度 0.4 で焼いたと報告される (${st && st.intensity})`);
  L.rebuild(m);
  ok(maxDiff(looks, snap(m), m.nv) === 0, '強度 0.4 のレイヤーを焼いても形が厳密に変わらない');
  ok(L.count === 0, `焼いたレイヤーが消える (${L.count})`);

  // 負の強度でも同じ（焼き込みの符号が合っているか）
  const m2 = sphere(3);
  const L2 = new SculptLayers();
  L2.setBase(m2);
  L2.add('B');
  dab(L2, m2, pick(m2, 3), 0.05);
  L2.setIntensity(0, -0.7);
  L2.rebuild(m2);
  const looks2 = snap(m2);
  L2.bake(0, m2);
  L2.rebuild(m2);
  ok(maxDiff(looks2, snap(m2), m2.nv) === 0, '負の強度のレイヤーを焼いても形が厳密に変わらない');
  checkMesh(m2, '負の強度のベイク後');
}

// ---------------------------------------------------------------------------
// 複製 / 削除で並びが変わったとき、記録先が別のレイヤーへずれると
// 「彫ったはずのレイヤーに入っていない」という分かりにくい壊れ方をする。
head('記録先が並び替えでずれない');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  const P0 = snap(m);
  const vA = pick(m, 4, 0), vB = pick(m, 4, 1);
  L.add('A'); dab(L, m, vA, 0.05);
  L.add('B'); dab(L, m, vB, 0.05);
  ok(L.recording === 1, `B が記録対象 (${L.recording})`);

  // 記録対象より下を複製すると index が 1 つ後ろへずれる
  const at = L.duplicate(0);
  ok(at === 1, `複製は index 1 に入る (${at})`);
  ok(L.recording === 2, `記録対象が B のまま追従する (${L.recording})`);
  ok(L.list()[2].name === 'B', `index 2 が B (${L.list()[2].name})`);

  const nA = L.list()[0].verts, nCopy = L.list()[1].verts;
  dab(L, m, vB, 0.03);               // B へ追い彫り
  ok(L.list()[0].verts === nA && L.list()[1].verts === nCopy,
    'A と複製の登録数が増えていない（別レイヤーへ書いていない）');
  ok(L.list()[2].verts === vB.length, `B にだけ入っている (${L.list()[2].verts})`);

  // 記録対象より下を削除しても同じ
  L.remove(0);
  ok(L.recording === 1, `削除で記録対象が詰まる (${L.recording})`);
  ok(L.list()[1].name === 'B', `index 1 が B (${L.list()[1].name})`);
  const nB = L.list()[1].verts;
  dab(L, m, vB, 0.02);
  ok(L.list()[1].verts === nB && L.list()[0].verts === nCopy, '削除後も B にだけ入る');

  for (let i = 0; i < L.count; i++) L.setIntensity(i, 0);
  L.rebuild(m);
  ok(maxDiff(P0, snap(m), m.nv) === 0, '並び替えを挟んでもベースへ厳密に戻る');
  checkMesh(m, '並び替え後');
}

// ---------------------------------------------------------------------------
// 呼び出し側（UI）が壊れた領域リストを渡してきても、統計で知らせるだけにして
// メッシュを壊さないこと。ここが崩れると原因の分からない形の破壊になる。
head('壊れた入力への耐性');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  const P0 = snap(m);
  L.add('A');

  // 範囲外 / 負の頂点番号が混ざっていても skipped になるだけ
  const good = pick(m, 7)[1];
  const verts = new Int32Array([good, m.nv + 5, -1]);
  L.captureBefore(m, verts, 3);
  pushAlongNormal(m, verts, 1, 0.04);
  const st = L.commitAfter(m, verts, 3);
  ok(st.skipped === 2, `範囲外の頂点は skipped に数えられる (${st.skipped})`);
  ok(st.added === 1 && L.list()[0].verts === 1, `有効な頂点だけが登録される (${st.added})`);
  ok(nonFinite(m) === 0, '範囲外の頂点を渡しても NaN が出ない');

  // count が verts の長さより大きい（捕獲バッファの残りが混ざる経路）
  const two = new Int32Array([pick(m, 9)[2], pick(m, 9)[3]]);
  const cap = L.captureBefore(m, two, 6);
  ok(cap === 2, `count は verts の長さに丸められる (${cap})`);
  pushAlongNormal(m, two, 2, 0.03);
  const st2 = L.commitAfter(m, two, 2);
  ok(st2.added === 2 && st2.skipped === 0, `嘘の count でも余計な頂点を積まない (${st2.added})`);
  ok(L.list()[0].verts === 3, `登録は 3 頂点だけ (${L.list()[0].verts})`);

  L.setIntensity(0, 0);
  L.rebuild(m);
  ok(maxDiff(P0, snap(m), m.nv) === 0, '壊れた入力のあとでもベースへ厳密に戻る');
  checkMesh(m, '壊れた入力のあと');
}

// ---------------------------------------------------------------------------
// ブラシ側の不具合や退化した法線で NaN / Inf が出ても、レイヤーへ持ち込まないこと。
// disp に入ると以後すべての rebuild とベイクに伝染する。
head('NaN / Inf をレイヤーへ持ち込まない');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  L.add('A');
  const verts = pick(m, 4);
  L.captureBefore(m, verts, verts.length);
  pushAlongNormal(m, verts, verts.length, 0.04);
  m.positions[verts[0] * 3] = NaN;              // 壊れたブラシの想定
  m.positions[verts[1] * 3 + 1] = Infinity;
  m.positions[verts[2] * 3 + 2] = -Infinity;
  const st = L.commitAfter(m, verts, verts.length);

  const inner = L.layers[0];
  let badDisp = 0;
  for (let k = 0; k < inner.n * 3; k++) if (!Number.isFinite(inner.disp[k])) badDisp++;
  ok(badDisp === 0, `disp に non-finite が入っていない (${badDisp})`);
  let poisoned = 0;
  for (let k = 0; k < inner.n; k++) {
    const v = inner.idx[k];
    if (v === verts[0] || v === verts[1] || v === verts[2]) poisoned++;
  }
  ok(poisoned === 0, `NaN / Inf になった頂点は登録されない (${poisoned})`);
  ok(st.added === verts.length - 3, `残りは正しく登録される (${st.added} / ${verts.length - 3})`);

  // ベイクしてもベースが汚染されない
  L.bake(0, m);
  let badBase = 0;
  for (let i = 0; i < L.base.length; i++) if (!Number.isFinite(L.base[i])) badBase++;
  ok(badBase === 0, `ベースに non-finite が伝染していない (${badBase})`);
}

// ---------------------------------------------------------------------------
head('統計と後始末');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  const verts = pick(m, 4);

  // 記録していない間に mismatch が立ちっぱなしになると UI の警告に使えない
  L.captureBefore(m, verts, verts.length);
  let st = L.commitAfter(m, verts, verts.length);
  ok(st.mismatch === false, '記録対象なしでは mismatch が立たない');
  ok(st.layer === -1, `記録対象なしでは layer が -1 (${st.layer})`);

  L.add('A');
  L.captureBefore(m, verts, verts.length);
  pushAlongNormal(m, verts, verts.length, 0.03);
  st = L.commitAfter(m, verts, verts.length - 5);   // わざと食い違わせる
  ok(st.mismatch === true, '捕獲と食い違うと mismatch が立つ');
  ok(st.moved === verts.length, `走査するのは捕獲側 (${st.moved} / ${verts.length})`);
  ok(st.layer === 0, `layer に記録先が入る (${st.layer})`);

  // 無効化された直後は、破棄済みの index を報告しない
  L.captureBefore(m, verts, verts.length);
  pushAlongNormal(m, verts, verts.length, 0.01);
  m.topoVersion++;
  st = L.commitAfter(m, verts, verts.length);
  ok(st.layer === -1 && st.moved === 0, `無効化されたら layer は -1 (${st.layer})`);

  // 削除で預かった頂点は rebuild で回収され、預かりが空になる（際限なく溜まらない）
  const m2 = sphere(3);
  const L2 = new SculptLayers();
  L2.setBase(m2);
  for (let i = 0; i < 5; i++) { L2.add('L' + i); dab(L2, m2, pick(m2, 6, i), 0.02); }
  while (L2.count > 0) L2.remove(0);
  ok(L2.orphanCount > 0, `削除した 5 枚ぶんが預かりに入る (${L2.orphanCount})`);
  const rb = L2.rebuild(m2);
  ok(L2.orphanCount === 0, `rebuild で預かりが空になる (${L2.orphanCount})`);
  ok(rb.verts > 0 && rb.layers === 0, `回収した頂点数が報告される (${rb.verts})`);
}

// ---------------------------------------------------------------------------
// 死んだスロットは addVertex で再利用され、そのとき topoVersion は進まない。
// base はそのスロットの「前の持ち主の座標」なので、気づかずに彫ると形が飛ぶ。
head('頂点が増えたらレイヤーを捨てる');
{
  const m = sphere(2);
  const L = new SculptLayers();
  L.setBase(m);
  L.add('A');
  dab(L, m, pick(m, 3), 0.03);
  const tv = m.topoVersion;
  m.addVertex(2, 2, 2);              // 三角形を張らないので topoVersion は動かない
  ok(m.topoVersion === tv, '（addVertex は topoVersion を進めない）');
  ok(L.validate(m) === false, '頂点が増えたらレイヤーは無効になる');
  ok(L.count === 0 && L.recording === -1, '無効化でレイヤーが捨てられる');
}

// ---------------------------------------------------------------------------
head('記録中に強度を動かしてから追い彫り');
{
  const m = sphere(3);
  const L = new SculptLayers();
  L.setBase(m);
  L.add('A');
  const verts = pick(m, 3);
  dab(L, m, verts, 0.03);            // 強度 1 で 1 ダブ
  L.setIntensity(0, 0.5);
  L.rebuild(m);
  const mid = snap(m);
  dab(L, m, verts, 0.03);            // 強度 0.5 のまま追い彫り
  const live = snap(m);
  L.rebuild(m);
  const d = maxDiff(live, snap(m), m.nv);
  ok(d <= 1e-6, `強度を動かしたあとの追い彫りも rebuild と一致する (最大差 ${d.toExponential(2)})`);
  ok(maxDiff(mid, snap(m), m.nv) > 1e-3, '（追い彫りで形が変わっている＝比較が有効）');
  L.setIntensity(0, 1);
  L.rebuild(m);
  ok(nonFinite(m) === 0, '強度を戻しても NaN が出ない');
  checkMesh(m, '追い彫り後');
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
