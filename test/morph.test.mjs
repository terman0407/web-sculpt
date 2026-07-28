// morph.js（モーフターゲット / Morph ブラシ / Morph Diff）の検証。
// DOM / WebGPU に触らないので node で直接動く。
import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { Sculptor } from '../js/sculptor.js';
import { collapseEdge } from '../js/dyntopo.js';
import { MorphTarget, computeMorphWeights, MORPH_BRUSH } from '../js/morph.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

// core.test.mjs の validate を、モーフに関係する項目（多様体性 / ring 整合性 /
// NaN / オイラー標数）へ絞ったもの。モーフは座標しか触らないはずなので、
// 「トポロジが一切変わっていないこと」までここで担保する。
function validateMesh(mesh, { closed = true, label = '', genus = 0 } = {}) {
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

  for (let v = 0; v < mesh.nv; v++) {
    const r = mesh.ringArray(v);
    if (!mesh.vAlive[v]) { if (r && r.length) errs.push(`dead vert ${v} has ring`); continue; }
    for (const t of r) {
      const i = t * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) errs.push(`vert ${v} ring has dead tri ${t}`);
      if (T[i] !== v && T[i + 1] !== v && T[i + 2] !== v) errs.push(`vert ${v} ring tri ${t} lacks v`);
    }
  }

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
  if (closed) {
    let bad = 0, boundary = 0;
    for (const [, n] of em) { if (n === 1) boundary++; else if (n !== 2) bad++; }
    if (bad) errs.push(`${bad} non-manifold edges`);
    if (boundary) errs.push(`${boundary} boundary edges`);
    const chi = mesh.liveVerts - em.size + mesh.liveTris;
    if (chi !== 2 - 2 * genus) errs.push(`Euler characteristic ${chi} (expected ${2 - 2 * genus})`);
  }

  let nan = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(mesh.positions[v * 3 + k])) nan++;
      if (!Number.isFinite(mesh.normals[v * 3 + k])) nan++;
      if (!Number.isFinite(mesh.curv[v])) nan++;
    }
  }
  if (nan) errs.push(`${nan} non-finite position/normal/curv components`);

  if (errs.length) {
    failures++;
    console.log(`  FAIL ${label}: ${errs.length} problem(s)`);
    errs.slice(0, 8).forEach(e => console.log('      - ' + e));
  } else {
    console.log(`  ok   ${label}  V=${mesh.liveVerts} F=${mesh.liveTris}`);
  }
  return errs.length === 0;
}

function makeState(over = {}) {
  return Object.assign({
    brush: 'clay', radiusPx: 90, strength: 0.6, paintColor: [0.6, 0.2, 0.15],
    worldRadius: 0.25, dynTopo: false, decimate: true, detail: 0.55, maxVerts: 400000,
    symmetry: { x: false, y: false, z: false },
  }, over);
}

function sphere() {
  const g = PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  return m;
}

/** 生存頂点の座標だけを取り出す（死んだスロットは中身が不定なので比較に混ぜない） */
function livePos(mesh) {
  const out = new Float32Array(mesh.liveVerts * 3);
  let w = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    out[w++] = mesh.positions[v * 3];
    out[w++] = mesh.positions[v * 3 + 1];
    out[w++] = mesh.positions[v * 3 + 2];
  }
  return out;
}

function exactSame(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** 適当な変形（記憶形状との差を作る）。彫刻の代わりに解析的に動かす */
function bump(mesh, amp = 0.12) {
  const P = mesh.positions;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const i = v * 3;
    const s = Math.sin(P[i] * 4.1) * Math.cos(P[i + 1] * 3.3 + 0.7);
    P[i] += P[i] * s * amp;
    P[i + 1] += P[i + 1] * s * amp;
    P[i + 2] += P[i + 2] * s * amp;
  }
  mesh.computeAllNormals();
  mesh.computeAllCurvature();
  mesh.geomVersion++;
}

/** 最初の生存頂点。マスクや重みを 1 頂点だけ仕込むときに使う */
function firstAlive(mesh) {
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) return v;
  return -1;
}

/** 生存頂点の座標に非有限値が混ざっていないか数える */
function countNonFinite(mesh) {
  let n = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    for (let e = 0; e < 3; e++) if (!Number.isFinite(mesh.positions[v * 3 + e])) n++;
  }
  return n;
}

/** 死んだスロットが混ざったメッシュを作る（dyntopo のコラプス後の状態） */
function sphereWithDeadSlots(tries = 3000) {
  const m = sphere();
  for (let k = 0; k < tries; k++) {
    const t = (k * 61) % m.nt;
    if (!m.isTriAlive(t)) continue;
    const i = t * 3;
    collapseEdge(m, m.tris[i], m.tris[i + 1]);
  }
  return m;
}

/** 半径内の生存頂点を集める（Sculptor._gather の代わり。テスト用なので全走査） */
function gatherRegion(mesh, center, radius) {
  const list = [];
  const P = mesh.positions;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const i = v * 3;
    const d = Math.hypot(P[i] - center[0], P[i + 1] - center[1], P[i + 2] - center[2]);
    if (d <= radius) list.push(v);
  }
  return new Int32Array(list);
}

// ---------------------------------------------------------------------------
head('Store / has / bytes / clear');
{
  const m = sphere();
  const mt = new MorphTarget();
  ok(mt.has === false, '初期状態では has が false');
  ok(mt.bytes() === 0, '未記憶なら bytes は 0');
  ok(mt.validate(m) === false, '未記憶なら validate は false');

  const st = mt.store(m);
  ok(mt.has === true, 'Store 後は has が true');
  ok(st.verts === m.liveVerts, `統計の頂点数が一致 (${st.verts})`);
  ok(mt.bytes() === m.nv * 3 * 4, `bytes = nv*3*4 (${mt.bytes()})`);
  ok(mt.validate(m) === true, 'Store 直後は valid');

  const buf = mt.pos;
  mt.store(m);
  ok(mt.pos === buf, '同じサイズの再 Store でバッファを作り直さない');
  ok(mt.stamp === 2, `Store 回数を数えている (${mt.stamp})`);

  mt.clear();
  ok(mt.has === false && mt.bytes() === 0 && mt.validate(m) === false, 'clear で完全に忘れる');
  ok(MORPH_BRUSH.id === 'morph', 'UI 用のブラシ記述子がある');
}

// ---------------------------------------------------------------------------
head('Switch は 2 回で厳密に元へ戻る');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);
  const stored = mt.pos.slice();
  bump(m);
  const sculpted = livePos(m);
  ok(!exactSame(sculpted, mt.pos.slice(0, m.liveVerts * 3)), '変形して差が付いている');

  const r1 = mt.switchTo(m);
  ok(r1.valid && r1.swapped === m.liveVerts, `Switch で全生存頂点を入れ替える (${r1.swapped})`);
  ok(exactSame(livePos(m), stored.slice(0, m.liveVerts * 3)), 'Switch 1 回で記憶形状になる');
  validateMesh(m, { label: 'switch x1' });

  const r2 = mt.switchTo(m);
  ok(r2.valid, 'Switch 2 回目も成功');
  ok(exactSame(livePos(m), sculpted), 'Switch 2 回で厳密に元の形へ戻る（1 ビットも変わらない）');
  ok(exactSame(mt.pos, stored), '記憶側も厳密に元へ戻る');
  validateMesh(m, { label: 'switch x2' });

  // Switch はマスクを見ない（見ると 2 回で戻らなくなる）。マスクを塗ってから
  // 2 回 Switch しても厳密に戻ることを確認する。
  for (let v = 0; v < m.nv; v += 3) m.mask[v] = 0.5;
  m.mask[1] = 1;
  const before = livePos(m);
  mt.switchTo(m); mt.switchTo(m);
  ok(exactSame(livePos(m), before), 'マスクがあっても Switch 2 回で厳密に戻る');
}

// ---------------------------------------------------------------------------
head('restore の境界値とべき等性');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);
  const stored = mt.pos.slice(0, m.liveVerts * 3);
  bump(m);
  const sculpted = livePos(m);

  // restore(0) は 1 バイトも触らない
  const r0 = mt.restore(m, 0);
  ok(r0.valid && r0.changed === 0 && r0.maxDist === 0, `restore(0) は何も変えない (changed=${r0.changed})`);
  ok(exactSame(livePos(m), sculpted), 'restore(0) で座標が変わらない');

  // 負や NaN も 0 と同じ扱い
  ok(mt.restore(m, -1).changed === 0, 'restore(負) は何もしない');
  ok(mt.restore(m, NaN).changed === 0, 'restore(NaN) は何もしない');
  ok(exactSame(livePos(m), sculpted), '負 / NaN で座標が壊れない');

  // 中間値：ちょうど半分の位置
  const rh = mt.restore(m, 0.5);
  ok(rh.valid && rh.changed > 0, `restore(0.5) が頂点を動かす (${rh.changed})`);
  const half = livePos(m);
  const want = new Float32Array(half.length);
  for (let i = 0; i < want.length; i++) want[i] = sculpted[i] + (stored[i] - sculpted[i]) * 0.5;
  ok(maxAbsDiff(half, want) < 1e-6, `restore(0.5) が中間位置になる (差 ${maxAbsDiff(half, want).toExponential(2)})`);

  // restore(1) は厳密一致
  const r1 = mt.restore(m, 1);
  ok(r1.valid && r1.changed > 0, 'restore(1) が動く');
  ok(exactSame(livePos(m), stored), 'restore(1) で厳密に記憶形状と一致する');
  validateMesh(m, { label: 'restore(1)' });

  // もう一度呼んでも動くところが無い（べき等）
  const r1b = mt.restore(m, 1);
  ok(r1b.valid && r1b.changed === 0, `restore(1) はべき等 (2 回目 changed=${r1b.changed})`);

  // 1 を超える値は 1 に丸める
  bump(m);
  mt.restore(m, 5);
  ok(exactSame(livePos(m), stored), 'restore(5) は restore(1) と同じ');
}

// ---------------------------------------------------------------------------
head('amplify（Morph Diff）');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);
  const stored = mt.pos.slice(0, m.liveVerts * 3);
  bump(m);
  const sculpted = livePos(m);

  const a1 = mt.amplify(m, 1);
  ok(a1.valid && a1.changed === 0, `amplify(1) は恒等 (changed=${a1.changed})`);
  ok(exactSame(livePos(m), sculpted), 'amplify(1) で 1 ビットも変わらない');

  ok(mt.amplify(m, NaN).changed === 0, 'amplify(NaN) は恒等扱い');
  ok(exactSame(livePos(m), sculpted), 'NaN で座標が壊れない');

  // 2 倍：記憶形状からの差分がちょうど 2 倍になる
  const a2 = mt.amplify(m, 2);
  ok(a2.valid && a2.changed > 0, `amplify(2) が動く (${a2.changed})`);
  const doubled = livePos(m);
  const want = new Float32Array(doubled.length);
  for (let i = 0; i < want.length; i++) want[i] = stored[i] + (sculpted[i] - stored[i]) * 2;
  ok(maxAbsDiff(doubled, want) < 1e-6, `差分が 2 倍になる (差 ${maxAbsDiff(doubled, want).toExponential(2)})`);
  validateMesh(m, { label: 'amplify(2)' });

  // 0.5 倍 →（2 倍のあとなので）元の差分に戻る＝可逆
  mt.amplify(m, 0.5);
  ok(maxAbsDiff(livePos(m), sculpted) < 1e-6,
    `amplify(2) → amplify(0.5) で元に戻る (差 ${maxAbsDiff(livePos(m), sculpted).toExponential(2)})`);

  // 0 倍 = 記憶形状そのもの
  const a0 = mt.amplify(m, 0);
  ok(a0.valid, 'amplify(0) が成功');
  ok(maxAbsDiff(livePos(m), stored) < 1e-6, 'amplify(0) で記憶形状に戻る');
  validateMesh(m, { label: 'amplify(0)' });
}

// ---------------------------------------------------------------------------
head('マスクの尊重（1 = 動かない）');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);
  bump(m);
  const sculpted = livePos(m);

  // 3 頂点ごとにマスク 1、その隣を 0.5 にする
  const locked = [];
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    if (v % 3 === 0) { m.mask[v] = 1; locked.push(v); }
    else if (v % 3 === 1) m.mask[v] = 0.5;
    else m.mask[v] = 0;
  }
  const before = m.positions.slice(0, m.nv * 3);

  mt.restore(m, 1);
  let moved = 0;
  for (const v of locked) {
    const i = v * 3;
    if (m.positions[i] !== before[i] || m.positions[i + 1] !== before[i + 1]
      || m.positions[i + 2] !== before[i + 2]) moved++;
  }
  ok(moved === 0, `restore(1) でマスク 1 の頂点が 1 つも動かない (動いた ${moved}/${locked.length})`);

  // マスク 0.5 の頂点はちょうど半分だけ戻る
  {
    let worst = 0;
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v] || v % 3 !== 1) continue;
      const i = v * 3;
      for (let k = 0; k < 3; k++) {
        const want = before[i + k] + (mt.pos[i + k] - before[i + k]) * 0.5;
        worst = Math.max(worst, Math.abs(m.positions[i + k] - want));
      }
    }
    ok(worst < 1e-6, `マスク 0.5 で効果が半分になる (差 ${worst.toExponential(2)})`);
  }

  // amplify も同じ規約
  const beforeAmp = m.positions.slice(0, m.nv * 3);
  mt.amplify(m, 3);
  moved = 0;
  for (const v of locked) {
    const i = v * 3;
    if (m.positions[i] !== beforeAmp[i] || m.positions[i + 1] !== beforeAmp[i + 1]
      || m.positions[i + 2] !== beforeAmp[i + 2]) moved++;
  }
  ok(moved === 0, `amplify でもマスク 1 の頂点が動かない (動いた ${moved})`);
  validateMesh(m, { label: 'masked restore/amplify' });
  ok(sculpted.length > 0, '比較用データが取れている');
}

// ---------------------------------------------------------------------------
head('Morph ブラシ（領域だけ部分的に戻す）');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);
  bump(m, 0.18);
  const sculpted = m.positions.slice(0, m.nv * 3);

  // 中心はある頂点の位置そのものにする（t = 0 → 重み 1 で厳密一致を検査できる）
  let hub = -1;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) { hub = v; break; }
  const center = m.positions.slice(hub * 3, hub * 3 + 3);
  const radius = 0.45;
  const verts = gatherRegion(m, center, radius);
  ok(verts.length > 4, `領域頂点が集まる (${verts.length})`);
  const weights = computeMorphWeights(m, verts, verts.length, center, radius, 0);
  ok(Math.abs(weights[0] - 1) < 1e-12, `中心の頂点の重みが 1 (${weights[0]})`);

  // マスク 1 の頂点を領域内に 1 つ仕込む
  const lockedV = verts[Math.floor(verts.length / 2)];
  m.mask[lockedV] = 1;

  m.clearDirty();
  const r = mt.morphBrush(m, verts, verts.length, weights, 1);
  ok(r.valid && r.changed > 0, `Morph ブラシが頂点を動かす (${r.changed})`);
  ok(m.vDirtyMax >= 0, 'dirty マークが付く（GPU 転送のため）');

  // 中心は完全に記憶形状へ戻る
  {
    const i = hub * 3;
    ok(m.positions[i] === mt.pos[i] && m.positions[i + 1] === mt.pos[i + 1]
      && m.positions[i + 2] === mt.pos[i + 2], '重み 1 の頂点は厳密に記憶形状と一致');
  }
  // マスク 1 の頂点は動かない
  {
    const i = lockedV * 3;
    ok(m.positions[i] === sculpted[i] && m.positions[i + 1] === sculpted[i + 1]
      && m.positions[i + 2] === sculpted[i + 2], 'マスク 1 の頂点は Morph ブラシでも動かない');
  }
  // 領域外は 1 つも動いていない
  {
    const inRegion = new Uint8Array(m.nv);
    for (let k = 0; k < verts.length; k++) inRegion[verts[k]] = 1;
    let outside = 0;
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v] || inRegion[v]) continue;
      const i = v * 3;
      if (m.positions[i] !== sculpted[i] || m.positions[i + 1] !== sculpted[i + 1]
        || m.positions[i + 2] !== sculpted[i + 2]) outside++;
    }
    ok(outside === 0, `領域外の頂点は動かない (動いた ${outside})`);
  }
  // 領域の縁（重み 0）も動かない
  {
    let edgeMoved = 0;
    for (let k = 0; k < verts.length; k++) {
      if (weights[k] > 0) continue;
      const i = verts[k] * 3;
      if (m.positions[i] !== sculpted[i]) edgeMoved++;
    }
    ok(edgeMoved === 0, `重み 0 の頂点は動かない (動いた ${edgeMoved})`);
  }
  validateMesh(m, { label: 'morphBrush' });

  // 何度なでても記憶形状を越えない（行き過ぎない = 符号が反転しない）
  const sign = new Float32Array(verts.length * 3);
  for (let k = 0; k < verts.length; k++) {
    const i = verts[k] * 3;
    for (let e = 0; e < 3; e++) sign[k * 3 + e] = sculpted[i + e] - mt.pos[i + e];
  }
  let prevSum = Infinity;
  for (let rep = 0; rep < 12; rep++) {
    mt.morphBrush(m, verts, verts.length, weights, 0.5);
    let flip = 0, sum = 0;
    for (let k = 0; k < verts.length; k++) {
      const i = verts[k] * 3;
      for (let e = 0; e < 3; e++) {
        const d = m.positions[i + e] - mt.pos[i + e];
        if (d * sign[k * 3 + e] < 0) flip++;
        sum += Math.abs(d);
      }
    }
    ok(flip === 0, `${rep + 1} 回目: 記憶形状を越えて行き過ぎない (反転 ${flip})`);
    ok(sum <= prevSum + 1e-9, `${rep + 1} 回目: 記憶形状との差が単調に減る`);
    prevSum = sum;
  }
  validateMesh(m, { label: 'morphBrush x12' });

  // amount 0 / NaN / count 0 は何もしない
  const snap = m.positions.slice(0, m.nv * 3);
  ok(mt.morphBrush(m, verts, verts.length, weights, 0).changed === 0, 'amount 0 で何もしない');
  ok(mt.morphBrush(m, verts, verts.length, weights, NaN).changed === 0, 'amount NaN で何もしない');
  ok(mt.morphBrush(m, verts, 0, weights, 1).changed === 0, 'count 0 で何もしない');
  ok(exactSame(m.positions.slice(0, m.nv * 3), snap), '無効な引数で座標が壊れない');

  // 重みに NaN が混ざっても座標に伝播しない
  const bad = weights.slice();
  bad[1] = NaN; bad[2] = -1;
  mt.morphBrush(m, verts, verts.length, bad, 1);
  let nan = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    for (let e = 0; e < 3; e++) if (!Number.isFinite(m.positions[v * 3 + e])) nan++;
  }
  ok(nan === 0, `重みの NaN / 負が座標に伝播しない (NaN ${nan})`);
}

// ---------------------------------------------------------------------------
head('createDiff の統計');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);

  const d0 = mt.createDiff(m);
  ok(d0.valid && d0.changed === 0 && d0.maxDist === 0,
    `Store 直後は差が 0 (changed=${d0.changed} max=${d0.maxDist})`);
  ok(d0.verts === m.liveVerts, `生存頂点数を返す (${d0.verts})`);

  // 決まった数の頂点だけを決まった量だけ動かす
  const target = [];
  for (let v = 0; v < m.nv; v += 7) if (m.vAlive[v]) { m.positions[v * 3] += 0.25; target.push(v); }
  const d1 = mt.createDiff(m);
  ok(d1.changed === target.length, `動かした頂点数と一致 (${d1.changed} == ${target.length})`);
  ok(Math.abs(d1.maxDist - 0.25) < 1e-6, `最大変位が正しい (${d1.maxDist.toFixed(6)})`);
  ok(Math.abs(d1.avgChanged - 0.25) < 1e-6, `動いた頂点の平均が正しい (${d1.avgChanged.toFixed(6)})`);
  const wantAvg = 0.25 * target.length / m.liveVerts;
  ok(Math.abs(d1.avgDist - wantAvg) < 1e-6, `全体平均が正しい (${d1.avgDist.toFixed(6)} ≈ ${wantAvg.toFixed(6)})`);
  ok(target.indexOf(d1.maxVert) >= 0, `最大変位の頂点番号を返す (${d1.maxVert})`);
}

// ---------------------------------------------------------------------------
head('validate がトポロジ変化を検出する');
{
  // 1) 面の削除（topoVersion が進む）
  {
    const m = sphere();
    const mt = new MorphTarget();
    mt.store(m);
    for (let t = 0; t < m.nt; t++) if (m.isTriAlive(t)) { m.removeTriangle(t); break; }
    ok(mt.validate(m) === false, '面を削除すると invalid になる');
    ok(mt.has === true, '無効になっても自動では捨てない（UI が知らせるため）');
  }

  // 2) スロット数が増える。addVertex は topoVersion を進めないので、
  //    nv も見ていないと「記憶に無い頂点」を素通ししてしまう
  {
    const m = sphere();
    const mt = new MorphTarget();
    mt.store(m);
    const before = m.topoVersion;
    m.addVertex(0, 0, 0);
    ok(m.topoVersion === before, 'addVertex は topoVersion を進めない（前提の確認）');
    ok(mt.validate(m) === false, 'nv が増えると invalid になる');
  }

  // 3) compact で番号が詰め替わる
  {
    const m = sphere();
    for (let t = 0; t < m.nt; t++) if (m.isTriAlive(t)) { m.removeTriangle(t); break; }
    const mt = new MorphTarget();
    mt.store(m);
    ok(mt.validate(m) === true, 'ゴミがある状態で Store した直後は valid');
    ok(m.compact(true) === true, 'compact(true) が実際に詰める（前提の確認）');
    ok(mt.validate(m) === false, 'compact 後は invalid');
  }

  // 4) dyntopo ありのストローク
  {
    const m = sphere();
    const mt = new MorphTarget();
    mt.store(m);
    const state = makeState({ dynTopo: true, worldRadius: 0.3, detail: 0.8 });
    const s = new Sculptor(m, state);
    const pt = new Float32Array([1, 0, 0]);
    s.beginStroke('clay', pt, 1);
    for (let k = 1; k <= 12; k++) { pt.set([Math.cos(k * 0.05), Math.sin(k * 0.05) * 0.4, 0.3]); s.addSample(pt); }
    s.endStroke();
    ok(m.liveVerts !== mt.liveVerts, `dyntopo で頂点数が変わった (${mt.liveVerts} → ${m.liveVerts})`);
    ok(mt.validate(m) === false, 'dyntopo ストローク後は invalid');

    // 無効な状態では一切書き換えない
    const snap = m.positions.slice(0, m.nv * 3);
    const rr = mt.restore(m, 1);
    const ra = mt.amplify(m, 2);
    const rs = mt.switchTo(m);
    const rd = mt.createDiff(m);
    const rb = mt.morphBrush(m, new Int32Array([0, 1, 2]), 3, new Float32Array([1, 1, 1]), 1);
    ok(!rr.valid && !ra.valid && !rs.valid && !rd.valid && !rb.valid, '無効時はすべて valid=false を返す');
    ok(rr.changed === 0 && ra.changed === 0 && rs.swapped === 0 && rb.changed === 0, '無効時は 0 件');
    ok(exactSame(m.positions.slice(0, m.nv * 3), snap), '無効時に座標を書き換えない');
    validateMesh(m, { label: 'invalid target 後' });

    // 撮り直せば再び使える
    mt.store(m);
    ok(mt.validate(m) === true, '再 Store で有効に戻る');
  }

  // 5) Undo（番号が振り替わる可能性があるので落とす）
  {
    const m = sphere();
    const state = makeState({ dynTopo: false, worldRadius: 0.3 });
    const s = new Sculptor(m, state);
    const mt = new MorphTarget();
    const pt = new Float32Array([1, 0, 0]);
    s.beginStroke('clay', pt, 1);
    for (let k = 1; k <= 8; k++) { pt.set([Math.cos(k * 0.05), Math.sin(k * 0.05) * 0.4, 0.3]); s.addSample(pt); }
    s.endStroke();
    mt.store(m);
    ok(s.history.undo(m) === true, 'undo できる');
    ok(mt.validate(m) === false, 'Undo 後は invalid（mesh.restore が topoVersion を進める）');
  }

  // 6) SDiv（分割レベル）
  {
    const m = sphere();
    const s = new Sculptor(m, makeState({ dynTopo: false }));
    const mt = new MorphTarget();
    mt.store(m);
    s.divide();
    ok(mt.validate(m) === false, 'Divide 後は invalid');
  }
}

// ---------------------------------------------------------------------------
// Morph ブラシが実用になる条件。dynTopo オフのストロークでは頂点番号が動かない
// ので、彫ったあとに Morph ブラシで戻せる（ZBrush で SDiv と併用するのと同じ状況）。
head('dynTopo オフのストローク後も有効なまま');
{
  const m = sphere();
  const state = makeState({ dynTopo: false, worldRadius: 0.22, strength: 1.0 });
  const s = new Sculptor(m, state);
  const mt = new MorphTarget();
  mt.store(m);
  const stored = mt.pos.slice(0, m.nv * 3);

  const pt = new Float32Array(3);
  const at = (u) => {
    const lon = -0.4 + u * 0.9;
    pt[0] = Math.cos(lon); pt[1] = 0.05; pt[2] = Math.sin(lon);
    return pt;
  };
  s.beginStroke('crease', at(0), 1);
  for (let k = 1; k <= 20; k++) s.addSample(at(k / 20));
  s.endStroke();

  ok(mt.validate(m) === true, 'dynTopo オフの彫刻では有効なまま');
  const d = mt.createDiff(m);
  ok(d.changed > 0 && d.maxDist > 1e-3, `彫った量が測れる (${d.changed} 頂点 / 最大 ${d.maxDist.toFixed(4)})`);

  // 彫った所を Morph ブラシで半分戻す
  const center = new Float32Array([Math.cos(0.05), 0.05, Math.sin(0.05)]);
  const radius = 0.3;
  const verts = gatherRegion(m, center, radius);
  const weights = computeMorphWeights(m, verts, verts.length, center, radius, 0);
  const beforeMax = d.maxDist;
  for (let i = 0; i < 6; i++) mt.morphBrush(m, verts, verts.length, weights, 0.6);
  // ブラシ経路では法線を呼び出し側が直す約束なので、ここで再計算して検証する
  m.computeAllNormals();
  m.computeAllCurvature();
  const after = mt.createDiff(m);
  ok(after.maxDist <= beforeMax + 1e-9, `Morph ブラシで記憶形状に近づく (${beforeMax.toFixed(4)} → ${after.maxDist.toFixed(4)})`);
  ok(after.changed < d.changed || after.avgChanged < d.avgChanged, '差の総量が減っている');
  validateMesh(m, { label: 'stroke → morphBrush' });

  // 最後に全部戻すと厳密に一致する
  mt.restore(m, 1);
  ok(exactSame(livePos(m), stored.subarray(0, m.liveVerts * 3)), '最終的に厳密に記憶形状へ戻る');
  validateMesh(m, { label: 'stroke → restore(1)' });
}

// ---------------------------------------------------------------------------
// 死んだスロットが混ざったメッシュ（dyntopo のコラプス後）でも壊れないか。
// nv > liveVerts の状態で「詰まっている」前提を置くと死んだ座標を掴んでしまう。
head('死んだスロットが混ざったメッシュ');
{
  const m = sphere();
  let n = 0;
  for (let k = 0; k < 3000; k++) {
    const t = (k * 61) % m.nt;
    if (!m.isTriAlive(t)) continue;
    const i = t * 3;
    if (collapseEdge(m, m.tris[i], m.tris[i + 1])) n++;
  }
  ok(m.nv > m.liveVerts, `死んだスロットがある (${m.nv - m.liveVerts} 個 / ${m.nv})`);
  validateMesh(m, { label: 'collapse 後' });

  const mt = new MorphTarget();
  mt.store(m);
  const stored = livePos(m);
  bump(m, 0.1);

  const sw = mt.switchTo(m);
  ok(sw.swapped === m.liveVerts, `Switch が生存頂点数だけ入れ替える (${sw.swapped} == ${m.liveVerts})`);
  ok(exactSame(livePos(m), stored), '死んだスロット混在でも Switch が正しい');
  mt.switchTo(m);
  mt.restore(m, 1);
  ok(exactSame(livePos(m), stored), '死んだスロット混在でも restore(1) が厳密');
  validateMesh(m, { label: 'dead slots + morph' });
  ok(n > 100, `コラプスが成立している (${n})`);
}

// ---------------------------------------------------------------------------
// ここから下はレビューで「テストが無くて壊しても気付けない」と分かった項目。
// 実装をわざと壊すと落ちることを確認してから追加している。
// ---------------------------------------------------------------------------

// 1 を超える amount / 重みは、マスクを併用しないと観測できない。マスク 0 の
// 頂点は f >= 1 の代入経路に落ちて restore(1) と区別が付かないため。
head('amount / 重みの上限（マスク併用で観測する）');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);
  bump(m);
  const v0 = firstAlive(m);
  m.mask[v0] = 0.5;
  const before = m.positions.slice(0, m.nv * 3);

  mt.restore(m, 5);
  {
    const i = v0 * 3;
    let worst = 0;
    for (let e = 0; e < 3; e++) {
      const want = before[i + e] + (mt.pos[i + e] - before[i + e]) * 0.5;
      worst = Math.max(worst, Math.abs(m.positions[i + e] - want));
    }
    ok(worst < 1e-6, `restore(5) が amount 1 に丸められている（マスク 0.5 で半分だけ戻る 差 ${worst.toExponential(2)}）`);
  }

  // morphBrush も同じ。amount 5 / 重み 1 / マスク 0.5 → 半分だけ戻る
  m.positions.set(before);
  const one = new Int32Array([v0]);
  mt.morphBrush(m, one, 1, new Float32Array([1]), 5);
  {
    const i = v0 * 3;
    let worst = 0;
    for (let e = 0; e < 3; e++) {
      const want = before[i + e] + (mt.pos[i + e] - before[i + e]) * 0.5;
      worst = Math.max(worst, Math.abs(m.positions[i + e] - want));
    }
    ok(worst < 1e-6, `morphBrush(amount=5) が 1 に丸められている（差 ${worst.toExponential(2)}）`);
  }

  // 呼び出し側が 1 を超える重みを渡しても記憶形状を越えない（= 厳密に一致で止まる）
  m.positions.set(before);
  m.mask[v0] = 0;
  mt.morphBrush(m, one, 1, new Float32Array([4]), 1);
  {
    const i = v0 * 3;
    ok(m.positions[i] === mt.pos[i] && m.positions[i + 1] === mt.pos[i + 1]
      && m.positions[i + 2] === mt.pos[i + 2], '重み 4 でも記憶形状で止まる（行き過ぎない）');
  }
}

// ---------------------------------------------------------------------------
// 全体操作は法線と曲率まで直してから返す約束（ブラシ経路と違って呼び出し側が
// 直さない）。直後に再計算しても 1 ビットも変わらない = 最新であることの検算。
head('switchTo / restore / amplify のあと法線と曲率が最新');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);
  bump(m);
  const fresh = (label) => {
    const n0 = m.normals.slice(0, m.nv * 3);
    const c0 = m.curv.slice(0, m.nv);
    m.computeAllNormals();
    m.computeAllCurvature();
    ok(exactSame(n0, m.normals.slice(0, m.nv * 3)), `${label} のあと法線が最新`);
    ok(exactSame(c0, m.curv.slice(0, m.nv)), `${label} のあと曲率が最新`);
  };
  const g0 = m.geomVersion;
  mt.switchTo(m);
  fresh('switchTo');
  ok(m.geomVersion > g0, 'switchTo が geomVersion を進める');
  mt.switchTo(m);
  mt.restore(m, 0.5);
  fresh('restore(0.5)');
  mt.amplify(m, 1.5);
  fresh('amplify(1.5)');
  ok(m.vDirtyMax >= 0, '全体操作で dirty レンジが立っている');
}

// ---------------------------------------------------------------------------
// morphBrush には Sculptor が集めた領域リストが渡る。トポロジが動いた直後の
// 古いリストが来ても、死んだスロットや範囲外を書かないこと。
head('morphBrush に死んだ / 範囲外の頂点番号を渡す');
{
  const m = sphereWithDeadSlots();
  ok(m.nv > m.liveVerts, `死んだスロットがある (${m.nv - m.liveVerts} 個)`);
  const mt = new MorphTarget();
  mt.store(m);
  bump(m, 0.1);

  let deadV = -1;
  for (let v = 0; v < m.nv; v++) if (!m.vAlive[v]) { deadV = v; break; }
  ok(deadV >= 0, '死んだスロットを 1 つ見つけた');

  // positions は capV*3 まであるので配列全体を比べる（範囲外書き込みも捕まえる）
  const snap = m.positions.slice();
  const bad = new Int32Array([deadV, m.nv + 5, -3, m.nv]);
  const r = mt.morphBrush(m, bad, 4, new Float32Array([1, 1, 1, 1]), 1);
  ok(r.valid && r.changed === 0, `死んだ / 範囲外の番号では 1 頂点も動かさない (changed=${r.changed})`);
  ok(exactSame(m.positions, snap), '配列のどこも書き換えない（死んだスロットも含む）');
  ok(countNonFinite(m) === 0, '座標に NaN が入らない');
}

// ---------------------------------------------------------------------------
// 「f >= 1 なら lerp ではなく代入」が効いているかは、桁が大きく離れた座標でしか
// 差が出ない（ox + (Q - ox) は |ox| >> |Q| だと桁落ちして Q に戻らない）。
head('桁が離れた座標でも f = 1 は厳密（代入経路の検算）');
{
  const m = sphere();
  const v0 = firstAlive(m);
  const i = v0 * 3;
  // ほぼ原点にある頂点を記憶してから、遠くへ引っぱった状態にする
  m.positions[i] = 1e-12; m.positions[i + 1] = -1e-12; m.positions[i + 2] = 1e-12;
  const mt = new MorphTarget();
  mt.store(m);
  const tiny = mt.pos.slice(i, i + 3);
  const far = [1e3, -2e3, 3e3];

  for (let e = 0; e < 3; e++) m.positions[i + e] = far[e];
  mt.restore(m, 1);
  ok(m.positions[i] === tiny[0] && m.positions[i + 1] === tiny[1] && m.positions[i + 2] === tiny[2],
    `restore(1) が桁落ちなしで厳密に戻す (${m.positions[i]} == ${tiny[0]})`);

  for (let e = 0; e < 3; e++) m.positions[i + e] = far[e];
  mt.morphBrush(m, new Int32Array([v0]), 1, new Float32Array([1]), 1);
  ok(m.positions[i] === tiny[0] && m.positions[i + 1] === tiny[1] && m.positions[i + 2] === tiny[2],
    'morphBrush（重み 1）も厳密に戻す');
  ok(countNonFinite(m) === 0, '極端な座標でも NaN にならない');
}

// ---------------------------------------------------------------------------
// mask は外から読み込んだデータ（io / masktools）由来のこともあるので、
// NaN が入っていても座標へ伝播させない。座標が NaN になると法線も曲率も
// 壊れて復帰不能になる（restore すら効かない）。
head('マスクに NaN が入っても座標に伝播しない');
{
  const m = sphere();
  const mt = new MorphTarget();
  mt.store(m);
  bump(m);
  const v0 = firstAlive(m);
  const i = v0 * 3;
  m.mask[v0] = NaN;
  const before = m.positions.slice(0, m.nv * 3);
  const same = (label) => {
    ok(m.positions[i] === before[i] && m.positions[i + 1] === before[i + 1]
      && m.positions[i + 2] === before[i + 2], `${label}: マスク NaN の頂点は動かない`);
    ok(countNonFinite(m) === 0, `${label}: 座標に NaN が出ない`);
  };
  mt.restore(m, 1);
  same('restore');
  m.positions.set(before);
  mt.amplify(m, 2);
  same('amplify');
  m.positions.set(before);
  mt.morphBrush(m, new Int32Array([v0]), 1, new Float32Array([1]), 1);
  same('morphBrush');
  validateMesh(m, { label: 'NaN マスク後' });
}

// ---------------------------------------------------------------------------
// addVertex はフリースロットを再利用するとき nv も topoVersion も動かさない。
// nv + topoVersion だけを見ていると「消えた頂点の座標」を新しい頂点へ
// 復元してしまうので、liveVerts も番号の意味を守る条件に入っている。
head('死んだスロットの再利用を検出する');
{
  const m = sphereWithDeadSlots(600);
  ok(m.freeVerts.length > 0, `再利用できるフリースロットがある (${m.freeVerts.length})`);
  const mt = new MorphTarget();
  mt.store(m);
  ok(mt.validate(m) === true, 'ゴミがある状態で Store した直後は valid');

  const nv0 = m.nv, tv0 = m.topoVersion;
  const v = m.addVertex(9, 9, 9);
  ok(v < nv0 && m.nv === nv0 && m.topoVersion === tv0,
    'スロット再利用では nv も topoVersion も動かない（前提の確認）');
  ok(mt.validate(m) === false, 'スロットが生き返ったら invalid');
  const r = mt.restore(m, 1);
  ok(r.valid === false && m.positions[v * 3] === 9,
    '無効なので新しい頂点を「消えた頂点の座標」へ飛ばさない');
}

// ---------------------------------------------------------------------------
head('大きいメッシュでの O(n) 確認');
{
  const g = PRIMITIVES.sphereHi();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const mt = new MorphTarget();
  const t0 = Date.now();
  mt.store(m);
  const tStore = Date.now() - t0;
  bump(m, 0.05);
  const t1 = Date.now();
  const d = mt.createDiff(m);
  const tDiff = Date.now() - t1;
  const t2 = Date.now();
  mt.restore(m, 0.5);
  const tRestore = Date.now() - t2;
  console.log(`  ${m.liveVerts.toLocaleString()} 頂点: store ${tStore}ms / diff ${tDiff}ms / restore ${tRestore}ms`
    + ` / ${(mt.bytes() / 1048576).toFixed(1)}MB`);
  ok(d.changed > 0, '差が検出される');
  validateMesh(m, { label: 'sphereHi' });
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
