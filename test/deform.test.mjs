// deform.js（デフォーメーションパレット）の検証。DOM / WebGPU には触らない。
import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { DEFORMS, DEFORM_IDS, DEFORM_BY_ID, defaultOpts, applyDeform } from '../js/deform.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

// core.test.mjs の validate を必要な項目だけに絞ったもの。
// 変形はトポロジを変えないので、ring と多様体性が壊れていないこと、
// NaN が混ざっていないこと、χ が保たれることを見る。
function validate(mesh, { closed = true, label = '', genus = 0 } = {}) {
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
  let bad = 0, boundary = 0;
  for (const [, n] of em) { if (n === 1) boundary++; else if (n !== 2) bad++; }
  if (bad) errs.push(`${bad} non-manifold edges`);
  if (closed && boundary) errs.push(`${boundary} boundary edges (expected closed)`);

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

  if (closed) {
    const chi = mesh.liveVerts - em.size + mesh.liveTris;
    if (chi !== 2 - 2 * genus) errs.push(`Euler characteristic ${chi} (expected ${2 - 2 * genus})`);
  }

  if (errs.length) {
    failures++;
    console.log(`  FAIL ${label}: ${errs.length} problem(s)`);
    errs.slice(0, 6).forEach(e => console.log('      - ' + e));
  }
  return errs.length === 0;
}

function sphere(sub = 3) {
  const g = sub === 3 ? PRIMITIVES.sphere() : PRIMITIVES.sphereHi();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  return m;
}
function cylinder() {
  const g = PRIMITIVES.cylinder();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  return m;
}
function snap(m) { return m.positions.slice(0, m.nv * 3); }
function maxDiff(a, b, n = a.length) {
  let d = 0;
  for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}
function axisExtent(m, a) {
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const x = m.positions[v * 3 + a];
    if (x < lo) lo = x; if (x > hi) hi = x;
  }
  return hi - lo;
}
/** 隣接頂点との距離の平均（粗さ / 細部の指標） */
function roughness(m) {
  const T = m.tris, P = m.positions;
  let s = 0, n = 0, s2 = 0;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3;
    if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = T[i + e] * 3, b = T[i + (e + 1) % 3] * 3;
      const d = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
      s += d; s2 += d * d; n++;
    }
  }
  const mean = s / n;
  return { mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

// ---------------------------------------------------------------------------
head('メタデータ');
{
  ok(DEFORMS.length === 9, `変形が 9 種ある (${DEFORMS.length})`);
  const want = ['taper', 'twist', 'bend', 'inflate', 'spherize', 'flattenAxis', 'stretch', 'noise', 'smoothAll'];
  for (const id of want) ok(DEFORM_BY_ID.has(id), `${id} がある`);
  ok(new Set(DEFORM_IDS).size === DEFORM_IDS.length, 'id が重複していない');
  for (const d of DEFORMS) {
    ok(typeof d.jp === 'string' && d.jp.length > 0, `${d.id}: jp がある`);
    ok(typeof d.name === 'string' && d.name.length > 0, `${d.id}: name がある`);
    ok(typeof d.hint === 'string' && d.hint.length > 4, `${d.id}: hint がある`);
    ok(typeof d.axis === 'boolean', `${d.id}: axis が bool`);
    ok(Array.isArray(d.params) && d.params.length > 0, `${d.id}: params がある`);
    for (const p of d.params) {
      ok(typeof p.key === 'string' && p.key.length > 0, `${d.id}.${p.key}: key`);
      ok(typeof p.jp === 'string' && p.jp.length > 0, `${d.id}.${p.key}: jp`);
      ok(Number.isFinite(p.min) && Number.isFinite(p.max) && p.min < p.max, `${d.id}.${p.key}: min < max`);
      ok(Number.isFinite(p.def) && p.def >= p.min && p.def <= p.max, `${d.id}.${p.key}: min <= def <= max`);
      ok(Number.isFinite(p.step) && p.step > 0, `${d.id}.${p.key}: step > 0`);
    }
    const o = defaultOpts(d.id);
    ok(o !== null && o.axis === 1, `${d.id}: defaultOpts の既定軸が Y`);
    for (const p of d.params) ok(o[p.key] === p.def, `${d.id}: defaultOpts に ${p.key} が入る`);
  }
  ok(defaultOpts('nope') === null, '未知 id の defaultOpts は null');
}

// ---------------------------------------------------------------------------
head('全変形 × 3 軸: 多様体性・NaN・トポロジ不変');
// 球だけで回すと spherize が「もう球なので何もしない」状態を「効いている」と
// 誤認できてしまう（初版がそうだった）。球でない円柱も必ず通す。
for (const [shape, make] of [['球', () => sphere()], ['円柱', cylinder]]) {
  for (const d of DEFORMS) {
    for (const axis of [0, 1, 2]) {
      const m = make();
      const v0 = m.liveVerts, t0 = m.liveTris, topo0 = m.topoVersion, geom0 = m.geomVersion;
      // setGeometry が全体を dirty にしているので、markAllDirty の検算のために消しておく
      m.clearDirty();
      const r = applyDeform(m, d.id, Object.assign(defaultOpts(d.id), { axis }));
      // 球に spherize を掛けても 1 ビットも動かないのが正しい（べき等の裏返し）
      const noop = shape === '球' && d.id === 'spherize';
      ok(r.ok === true, `${shape} ${d.id} axis=${axis}: ok`);
      ok(r.id === d.id, `${shape} ${d.id}: id が返る`);
      ok(noop ? r.changed === 0 : r.changed > 0, `${shape} ${d.id} axis=${axis}: 頂点が動いた (${r.changed})`);
      ok(r.changed <= v0, `${shape} ${d.id}: changed <= liveVerts`);
      ok(r.verts === v0, `${shape} ${d.id}: verts = liveVerts (${r.verts})`);
      ok(r.skipped === 0, `${shape} ${d.id}: 非有限で棄却された頂点がない (${r.skipped})`);
      ok(r.axis === (d.axis ? axis : -1), `${shape} ${d.id}: 返る axis (${r.axis})`);
      ok(typeof r.ms === 'number' && r.ms >= 0, `${shape} ${d.id}: ms が数値`);
      ok(m.liveVerts === v0 && m.liveTris === t0, `${shape} ${d.id}: トポロジが変わらない`);
      ok(m.topoVersion === topo0, `${shape} ${d.id}: topoVersion が増えない`);
      ok(noop ? m.geomVersion === geom0 : m.geomVersion > geom0, `${shape} ${d.id}: geomVersion`);
      // 動いたら GPU 転送のために全体が dirty になっていること（clearDirty 済みなので実質的な検算）
      ok(noop ? m.vDirtyMax === -1 : (m.vDirtyMin === 0 && m.vDirtyMax === m.nv - 1),
        `${shape} ${d.id}: dirty レンジ (${m.vDirtyMin}..${m.vDirtyMax})`);
      validate(m, { label: `${shape} ${d.id} axis=${axis}` });
      // 軸に依存しない変形は axis を変えてもビット単位で同じ結果になること
      if (!d.axis && axis === 2) {
        const m2 = make();
        applyDeform(m2, d.id, Object.assign(defaultOpts(d.id), { axis: 0 }));
        ok(maxDiff(snap(m), snap(m2)) === 0, `${shape} ${d.id}: axis に依存しない`);
      }
    }
  }
}
console.log(`  ${DEFORMS.length} 種 × 3 軸 × 2 形状 を検証`);

// ---------------------------------------------------------------------------
head('マスクの規約（1 = 完全に保護）');
// 球ではなく円柱を使う。spherize は球に対しては正しく何もしないので、
// 「マスクしていない側は動く」の検算が空振りになってしまう。
for (const d of DEFORMS) {
  const m = cylinder();
  // x > 0 側を完全マスク、x <= 0 側は自由
  const locked = [];
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    if (m.positions[v * 3] > 0) { m.mask[v] = 1; locked.push(v); }
  }
  const before = snap(m);
  const r = applyDeform(m, d.id, Object.assign(defaultOpts(d.id), { axis: 1 }));
  let moved = 0;
  for (const v of locked) {
    const i = v * 3;
    if (m.positions[i] !== before[i] || m.positions[i + 1] !== before[i + 1]
      || m.positions[i + 2] !== before[i + 2]) moved++;
  }
  ok(locked.length > 10, `${d.id}: マスクした頂点がちゃんとある (${locked.length})`);
  ok(moved === 0, `${d.id}: mask=1 の頂点が ${moved} 個動いた`);
  ok(r.masked === locked.length, `${d.id}: masked の数が合う (${r.masked} / ${locked.length})`);
  ok(r.changed > 0, `${d.id}: マスクしていない側は動く`);
  validate(m, { label: `${d.id} masked` });
}

// 部分マスク（0.5）はちょうど半分だけ効く。
// 初版はここで頂点 10 を使っていたが、この頂点は y = 0（= 変形しても動かない位置）
// なので、マスクを完全に無視する実装でも通ってしまう空のテストになっていた。
// 変形の効果が最大になる頂点（|y| が最大のもの）を選び直す。
{
  let target = -1, best = -1;
  {
    const m0 = sphere();
    for (let v = 0; v < m0.nv; v++) {
      if (!m0.vAlive[v]) continue;
      const y = Math.abs(m0.positions[v * 3 + 1]);
      if (y > best) { best = y; target = v; }
    }
  }
  ok(best > 0.5, `部分マスクの検算に使う頂点の |y| が十分大きい (${best.toFixed(4)})`);

  // flattenAxis: 中心（原点）へ 100% 潰す指定を mask=0.5 で受けると、ちょうど半分の位置
  const m = sphere();
  m.mask[target] = 0.5;
  const y0 = m.positions[target * 3 + 1];
  applyDeform(m, 'flattenAxis', { axis: 1, amount: 1 });
  ok(Math.abs(m.positions[target * 3 + 1] - y0 * 0.5) < 1e-6,
    `flattenAxis: mask=0.5 で効果が半分 (${m.positions[target * 3 + 1].toFixed(6)} / 期待 ${(y0 * 0.5).toFixed(6)})`);

  // stretch: 倍率 2 倍を mask=0.5 で受けると 1.5 倍の位置
  const s = sphere();
  s.mask[target] = 0.5;
  applyDeform(s, 'stretch', { axis: 1, amount: 1, center: [0, 0, 0] });
  ok(Math.abs(s.positions[target * 3 + 1] - y0 * 1.5) < 1e-6,
    `stretch: mask=0.5 で効果が半分 (${s.positions[target * 3 + 1].toFixed(6)} / 期待 ${(y0 * 1.5).toFixed(6)})`);

  // flattenAxis を mask=1 にしたら 1 ビットも動かない（早期 continue と *w の両方を通す）
  const f = sphere();
  f.mask[target] = 1;
  applyDeform(f, 'flattenAxis', { axis: 1, amount: 1 });
  ok(f.positions[target * 3 + 1] === y0, 'flattenAxis: mask=1 は 1 ビットも動かない');
}

// twist は「位置の線形補間」ではなく「回転角に weight を掛ける」実装になっているか。
// 位置を補間すると回転が弦になり、半分マスクした頂点が軸へ寄って体積が痩せる。
// 全頂点を mask=0.5 にしても軸からの距離が厳密に保たれることで区別できる
// （マスク無しだと weight=1 でどちらの実装も一致してしまうので、必ず部分マスクで見る）。
for (const axis of [0, 1, 2]) {
  const m = cylinder();
  const au = (axis + 1) % 3, av = (axis + 2) % 3;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) m.mask[v] = 0.5;
  const before = snap(m);
  const r = applyDeform(m, 'twist', { axis, amount: 120, center: [0, 0, 0] });
  let dRad = 0, dAxis = 0, rotated = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    dAxis = Math.max(dAxis, Math.abs(m.positions[i + axis] - before[i + axis]));
    const r0 = Math.hypot(before[i + au], before[i + av]);
    const r1 = Math.hypot(m.positions[i + au], m.positions[i + av]);
    dRad = Math.max(dRad, Math.abs(r1 - r0));
    if (Math.abs(m.positions[i + au] - before[i + au]) > 1e-3) rotated++;
  }
  ok(dRad < 1e-5, `twist axis=${axis}: mask=0.5 でも軸からの距離が保たれる (${dRad.toExponential(2)})`);
  ok(dAxis < 1e-6, `twist axis=${axis}: mask=0.5 でも軸座標が変わらない (${dAxis.toExponential(2)})`);
  ok(rotated > 10, `twist axis=${axis}: mask=0.5 でも実際に回っている (${rotated})`);
  ok(r.masked === 0, `twist axis=${axis}: mask=0.5 は「保護された頂点」には数えない (${r.masked})`);
}

// ---------------------------------------------------------------------------
head('死んだ頂点は触らない');
for (const d of DEFORMS) {
  const m = sphere();
  // 頂点 0 の三角形を全部消してから頂点を殺し、番兵座標を入れておく
  const v0 = 0;
  for (const t of m.ringArray(v0)) m.removeTriangle(t);
  m.removeVertex(v0);
  m.positions[v0 * 3] = 999; m.positions[v0 * 3 + 1] = -999; m.positions[v0 * 3 + 2] = 777;
  const live = m.liveVerts;
  const r = applyDeform(m, d.id, Object.assign(defaultOpts(d.id), { axis: 1 }));
  ok(m.positions[v0 * 3] === 999 && m.positions[v0 * 3 + 1] === -999 && m.positions[v0 * 3 + 2] === 777,
    `${d.id}: 死んだ頂点が動いていない`);
  ok(r.verts === live, `${d.id}: verts が生存数 (${r.verts} / ${live})`);
  ok(r.changed <= live, `${d.id}: changed が生存数以内`);
  validate(m, { closed: false, label: `${d.id} with dead vert` });
}

// ---------------------------------------------------------------------------
head('量 0 は何もしない（changed = 0）');
for (const d of DEFORMS) {
  const m = sphere();
  const before = snap(m);
  const geom0 = m.geomVersion;
  const r = applyDeform(m, d.id, { axis: 1, amount: 0, scale: 6, iterations: 3 });
  ok(r.changed === 0, `${d.id}: amount=0 で changed=0 (${r.changed})`);
  ok(maxDiff(snap(m), before) === 0, `${d.id}: amount=0 で座標がビット単位で不変`);
  ok(m.geomVersion === geom0, `${d.id}: 何も動かないなら geomVersion も増えない`);
  // 「何も起きない」は「全部 NaN で棄却された」であってはならない。
  // bend は amount=0 だと曲率半径が発散するので、早期 return で逃げているかを見る。
  ok(r.skipped === 0, `${d.id}: amount=0 は棄却ではなく素通り (skipped=${r.skipped})`);
}

// ---------------------------------------------------------------------------
head('軸ごとの幾何の検算');

// flattenAxis: 1 で完全に平面、他軸は不変
for (const axis of [0, 1, 2]) {
  const m = sphere();
  const before = snap(m);
  applyDeform(m, 'flattenAxis', { axis, amount: 1 });
  let maxOff = 0, otherMoved = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    maxOff = Math.max(maxOff, Math.abs(m.positions[v * 3 + axis]));
    for (let k = 0; k < 3; k++) {
      if (k === axis) continue;
      if (m.positions[v * 3 + k] !== before[v * 3 + k]) otherMoved++;
    }
  }
  ok(maxOff < 1e-6, `flatten axis=${axis}: 完全に平面になる (最大 ${maxOff.toExponential(2)})`);
  ok(otherMoved === 0, `flatten axis=${axis}: 他の 2 軸は 1 ビットも動かない`);
  // べき等性: 平面を潰しても何も起きない
  const r2 = applyDeform(m, 'flattenAxis', { axis, amount: 1 });
  ok(r2.changed === 0, `flatten axis=${axis}: べき等 (2 回目の changed=${r2.changed})`);
}

// stretch: 指定軸だけが伸び、逆倍率で厳密に戻る（可逆性）
for (const axis of [0, 1, 2]) {
  const m = sphere();
  const before = snap(m);
  const ex0 = [axisExtent(m, 0), axisExtent(m, 1), axisExtent(m, 2)];
  const center = [0, 0, 0];
  applyDeform(m, 'stretch', { axis, amount: 1, center });
  const ex1 = [axisExtent(m, 0), axisExtent(m, 1), axisExtent(m, 2)];
  ok(Math.abs(ex1[axis] / ex0[axis] - 2) < 1e-4, `stretch axis=${axis}: 幅が 2 倍 (${(ex1[axis] / ex0[axis]).toFixed(4)})`);
  for (const k of [0, 1, 2]) {
    if (k === axis) continue;
    ok(Math.abs(ex1[k] - ex0[k]) < 1e-6, `stretch axis=${axis}: 他軸の幅が変わらない`);
  }
  applyDeform(m, 'stretch', { axis, amount: -0.5, center });
  const d = maxDiff(snap(m), before, m.nv * 3);
  ok(d < 1e-5, `stretch axis=${axis}: 逆倍率で元に戻る (最大差 ${d.toExponential(2)})`);
  validate(m, { label: `stretch axis=${axis} 往復` });
}

// twist: 軸座標と軸からの距離が保たれる（等長）／中央断面は不動／可逆
for (const axis of [0, 1, 2]) {
  const m = cylinder();
  const au = (axis + 1) % 3, av = (axis + 2) % 3;
  const before = snap(m);
  const center = [0, 0, 0];
  applyDeform(m, 'twist', { axis, amount: 120, center });
  let dAxis = 0, dRad = 0, midMoved = 0, rotated = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    dAxis = Math.max(dAxis, Math.abs(m.positions[i + axis] - before[i + axis]));
    const r0 = Math.hypot(before[i + au], before[i + av]);
    const r1 = Math.hypot(m.positions[i + au], m.positions[i + av]);
    dRad = Math.max(dRad, Math.abs(r1 - r0));
    if (Math.abs(before[i + axis]) < 1e-6) {
      // 中央（t=0）の断面は回転角 0 なので動かない
      if (Math.abs(m.positions[i + au] - before[i + au]) > 1e-6
        || Math.abs(m.positions[i + av] - before[i + av]) > 1e-6) midMoved++;
    } else if (Math.abs(m.positions[i + au] - before[i + au]) > 1e-4) rotated++;
  }
  ok(dAxis < 1e-6, `twist axis=${axis}: 軸座標が変わらない (${dAxis.toExponential(2)})`);
  ok(dRad < 1e-5, `twist axis=${axis}: 軸からの距離が保たれる (${dRad.toExponential(2)})`);
  ok(midMoved === 0, `twist axis=${axis}: 中央の断面が動かない (${midMoved} 個動いた)`);
  ok(rotated > 10, `twist axis=${axis}: 端の方は実際に回っている (${rotated})`);
  applyDeform(m, 'twist', { axis, amount: -120, center });
  const d = maxDiff(snap(m), before, m.nv * 3);
  ok(d < 1e-5, `twist axis=${axis}: 逆角度で元に戻る (最大差 ${d.toExponential(2)})`);
  validate(m, { label: `twist axis=${axis} 往復` });
}

// taper: 中央の断面は不動、軸の − 側の断面が細くなる（+ 量のとき）
for (const axis of [0, 1, 2]) {
  const m = cylinder();
  const au = (axis + 1) % 3, av = (axis + 2) % 3;
  const before = snap(m);
  // 軸ごとに BBox の幅が違う（円柱は Y だけ長い）ので、正規化した t で端を選ぶ
  const bb = m.bounds();
  const invHalf = 2 / (bb.max[axis] - bb.min[axis]);
  applyDeform(m, 'taper', { axis, amount: 1, center: [0, 0, 0] });
  let midMoved = 0, rMinusBefore = 0, rMinusAfter = 0, rPlusBefore = 0, rPlusAfter = 0, nm = 0, np = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    const t = before[i + axis] * invHalf;
    if (Math.abs(t) < 1e-6) {
      if (Math.abs(m.positions[i + au] - before[i + au]) > 1e-6) midMoved++;
      continue;
    }
    const r0 = Math.hypot(before[i + au], before[i + av]);
    const r1 = Math.hypot(m.positions[i + au], m.positions[i + av]);
    if (t < -0.98) { rMinusBefore += r0; rMinusAfter += r1; nm++; }
    if (t > 0.98) { rPlusBefore += r0; rPlusAfter += r1; np++; }
  }
  ok(midMoved === 0, `taper axis=${axis}: 中央の断面が動かない`);
  ok(nm > 0 && np > 0, `taper axis=${axis}: 両端の断面が取れている`);
  ok(rMinusAfter < rMinusBefore * 0.05,
    `taper axis=${axis}: − 端の断面が潰れる (${(rMinusAfter / nm).toFixed(4)} ← ${(rMinusBefore / nm).toFixed(4)})`);
  ok(rPlusAfter > rPlusBefore * 1.9,
    `taper axis=${axis}: + 端の断面が 2 倍近くに太る (${(rPlusAfter / np).toFixed(4)} ← ${(rPlusBefore / np).toFixed(4)})`);
  validate(m, { label: `taper axis=${axis}` });
}

// bend: 中央断面は不動 / 角度 → 0 で恒等に近づく / 弧長がだいたい保たれる
for (const axis of [0, 1, 2]) {
  const m = cylinder();
  const au = (axis + 1) % 3;
  const before = snap(m);
  const r0 = roughness(m);
  applyDeform(m, 'bend', { axis, amount: 90, center: [0, 0, 0] });
  let midMoved = 0, bentMax = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (Math.abs(before[i + axis]) < 1e-6) {
      if (Math.abs(m.positions[i + axis] - before[i + axis]) > 1e-5
        || Math.abs(m.positions[i + au] - before[i + au]) > 1e-5) midMoved++;
    }
    bentMax = Math.max(bentMax, Math.abs(m.positions[i + au] - before[i + au]));
  }
  const r1 = roughness(m);
  ok(midMoved === 0, `bend axis=${axis}: 中央の断面が動かない (${midMoved})`);
  ok(bentMax > 0.2, `bend axis=${axis}: 実際に曲がっている (最大 ${bentMax.toFixed(3)})`);
  ok(r1.mean > r0.mean * 0.7 && r1.mean < r0.mean * 1.4,
    `bend axis=${axis}: 弧長がだいたい保たれる (${r0.mean.toFixed(5)} → ${r1.mean.toFixed(5)})`);
  validate(m, { label: `bend axis=${axis}` });

  // 角度 → 0 で恒等写像に近づく（連続性）。角度に比例して変位が小さくなることを見る。
  // 変位そのものは「断面の大きさ × 角度」で決まるので、絶対値ではなく比で検算する。
  const disp = (deg) => {
    const s = cylinder();
    const s0 = snap(s);
    applyDeform(s, 'bend', { axis, amount: deg, center: [0, 0, 0] });
    return maxDiff(snap(s), s0, s.nv * 3);
  };
  const d1 = disp(0.5), d2 = disp(0.05);
  ok(d2 < 2e-3, `bend axis=${axis}: 微小角ではほぼ恒等 (最大差 ${d2.toExponential(2)})`);
  ok(d2 > 0 && d1 / d2 > 8 && d1 / d2 < 12,
    `bend axis=${axis}: 変位が角度に比例する (10 倍の角度で ${(d1 / d2).toFixed(2)} 倍)`);
}

// ---------------------------------------------------------------------------
head('inflate / spherize');
{
  // 単位球なら unit = 半対角線 = √3。半径が amount*unit だけ増えるはず
  const m = sphere();
  const unit = m.bounds().radius;
  applyDeform(m, 'inflate', { amount: 0.1 });
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    const r = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]);
    if (r < lo) lo = r; if (r > hi) hi = r;
  }
  const want = 1 + 0.1 * unit;
  ok(Math.abs(lo - want) < 2e-3 && Math.abs(hi - want) < 2e-3,
    `inflate: 半径が一様に ${want.toFixed(4)} になる (${lo.toFixed(4)}…${hi.toFixed(4)})`);
  validate(m, { label: 'inflate' });

  // 往復させると球のまま元の大きさ付近に戻る。
  // 厳密には戻らない: 変位量は「モデルの大きさ × 量」なので、膨らんだ状態で
  // 掛ける戻し量のほうが大きくなる（0.08 → 実質 0.091 相当）。これは仕様。
  const m2 = sphere();
  applyDeform(m2, 'inflate', { amount: 0.08 });
  applyDeform(m2, 'inflate', { amount: -0.08 });
  let lo2 = Infinity, hi2 = -Infinity;
  for (let v = 0; v < m2.nv; v++) {
    if (!m2.vAlive[v]) continue;
    const i = v * 3;
    const r = Math.hypot(m2.positions[i], m2.positions[i + 1], m2.positions[i + 2]);
    if (r < lo2) lo2 = r; if (r > hi2) hi2 = r;
  }
  ok(hi2 - lo2 < 3e-3, `inflate: 往復しても球のまま (半径幅 ${(hi2 - lo2).toExponential(2)})`);
  ok(Math.abs(lo2 - 1) < 0.03, `inflate: 往復でほぼ元の大きさに戻る (半径 ${lo2.toFixed(4)})`);

  // スケール不変: 7 倍のモデルでは変位も 7 倍
  const g = PRIMITIVES.sphere();
  const big = new SculptMesh();
  const scaled = g.positions.slice();
  for (let i = 0; i < scaled.length; i++) scaled[i] *= 7;
  big.setGeometry(scaled, g.indices);
  const bb = snap(big);
  applyDeform(big, 'inflate', { amount: 0.1 });
  let dBig = 0;
  for (let v = 0; v < big.nv; v++) {
    if (!big.vAlive[v]) continue;
    const i = v * 3;
    dBig = Math.max(dBig, Math.hypot(big.positions[i] - bb[i], big.positions[i + 1] - bb[i + 1],
      big.positions[i + 2] - bb[i + 2]));
  }
  ok(Math.abs(dBig / (0.1 * unit) - 7) < 0.05, `inflate: スケール不変（変位が 7 倍: ${(dBig / (0.1 * unit)).toFixed(3)}）`);
}
{
  // spherize 1.0 で全頂点が等距離になり、もう一度掛けても変わらない（べき等）
  const m = cylinder();
  applyDeform(m, 'spherize', { amount: 1 });
  let lo = Infinity, hi = -Infinity;
  const c = m.bounds().center;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    const r = Math.hypot(m.positions[i] - c[0], m.positions[i + 1] - c[1], m.positions[i + 2] - c[2]);
    if (r < lo) lo = r; if (r > hi) hi = r;
  }
  ok(hi - lo < 1e-5, `spherize=1 で球になる (半径 ${lo.toFixed(5)}…${hi.toFixed(5)})`);
  validate(m, { label: 'spherize' });
  const before = snap(m);
  applyDeform(m, 'spherize', { amount: 1 });
  const d = maxDiff(snap(m), before, m.nv * 3);
  ok(d < 1e-5, `spherize はべき等 (最大差 ${d.toExponential(2)})`);
}

// ---------------------------------------------------------------------------
head('noise の再現性（Math.random 非依存）');
{
  const a = sphere(), b = sphere();
  const ra = applyDeform(a, 'noise', { amount: 0.05, scale: 8 });
  const rb = applyDeform(b, 'noise', { amount: 0.05, scale: 8 });
  ok(maxDiff(snap(a), snap(b)) === 0, 'noise: 同じ入力ならビット単位で同じ結果');
  ok(ra.changed === rb.changed, `noise: changed も一致 (${ra.changed})`);

  const c = sphere();
  applyDeform(c, 'noise', { amount: 0.05, scale: 3 });
  ok(maxDiff(snap(a), snap(c)) > 1e-4, 'noise: 細かさを変えると結果が変わる');

  const d = sphere();
  applyDeform(d, 'noise', { amount: -0.05, scale: 8 });
  ok(maxDiff(snap(a), snap(d)) > 1e-4, 'noise: 強さの符号で結果が変わる');

  // 法線方向の平均変位がほぼ 0（膨らみっぱなしにならない）
  const base = sphere();
  const p0 = snap(base);
  const r = applyDeform(base, 'noise', { amount: 0.05, scale: 8 });
  let sum = 0, n = 0, amax = 0;
  for (let v = 0; v < base.nv; v++) {
    if (!base.vAlive[v]) continue;
    const i = v * 3;
    const nr = Math.hypot(base.positions[i], base.positions[i + 1], base.positions[i + 2]);
    sum += nr - 1; n++;
    amax = Math.max(amax, Math.abs(nr - 1));
  }
  const unit = 1.7320508;
  ok(amax > 0.005 && amax <= 0.05 * unit + 1e-6,
    `noise: 変位が強さ×モデル半径の範囲に収まる (最大 ${amax.toFixed(5)} <= ${(0.05 * unit).toFixed(5)})`);
  ok(Math.abs(sum / n) < 0.35 * 0.05 * unit, `noise: 平均変位がほぼ 0 (${(sum / n).toExponential(2)})`);
  ok(r.changed > base.liveVerts * 0.99, `noise: ほぼ全頂点が動く (${r.changed}/${base.liveVerts})`);
  ok(maxDiff(snap(base), p0) > 0, 'noise: 実際に変わっている');
  validate(base, { label: 'noise' });
}

// ---------------------------------------------------------------------------
head('smoothAll');
{
  // ノイズを乗せてから平滑化 → ばらつきが減る
  const m = sphere();
  applyDeform(m, 'noise', { amount: 0.08, scale: 14 });
  const r0 = roughness(m);
  const before = snap(m);
  const r = applyDeform(m, 'smoothAll', { amount: 0.6, iterations: 4 });
  const r1 = roughness(m);
  console.log(`  粗さ sd ${r0.sd.toFixed(5)} → ${r1.sd.toFixed(5)}  (${r.changed} 頂点 / ${r.ms}ms)`);
  ok(r1.sd < r0.sd * 0.8, `smoothAll: エッジ長のばらつきが減る (${r0.sd.toFixed(5)} → ${r1.sd.toFixed(5)})`);
  ok(maxDiff(snap(m), before) > 0, 'smoothAll: 実際に動いている');
  validate(m, { label: 'smoothAll' });

  // 反復を増やすほど滑らかになる（単調性）
  const a = sphere(), b = sphere();
  applyDeform(a, 'noise', { amount: 0.08, scale: 14 });
  applyDeform(b, 'noise', { amount: 0.08, scale: 14 });
  applyDeform(a, 'smoothAll', { amount: 0.5, iterations: 1 });
  applyDeform(b, 'smoothAll', { amount: 0.5, iterations: 8 });
  ok(roughness(b).sd < roughness(a).sd, '反復回数が多いほど滑らかになる');

  // 球を平滑化しても潰れない（凸形状は縮むだけで形は保つ）
  const s = sphere();
  applyDeform(s, 'smoothAll', { amount: 1, iterations: 10 });
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < s.nv; v++) {
    if (!s.vAlive[v]) continue;
    const i = v * 3;
    const rr = Math.hypot(s.positions[i], s.positions[i + 1], s.positions[i + 2]);
    if (rr < lo) lo = rr; if (rr > hi) hi = rr;
  }
  ok(lo > 0.9 && hi < 1.001, `球を強く平滑化しても崩れない (半径 ${lo.toFixed(4)}…${hi.toFixed(4)})`);
  validate(s, { label: 'smoothAll x10' });
}

// ---------------------------------------------------------------------------
head('center の上書きと BBox 外に置いたときの clamp');
{
  // stretch: 中心を上書きすると伸縮の不動点がそこに移る
  const m = sphere();
  const before = snap(m);
  applyDeform(m, 'stretch', { axis: 1, amount: 1, center: [0, 0.5, 0] });
  let worst = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    const want = 0.5 + (before[i + 1] - 0.5) * 2;      // 中心 0.5 から 2 倍
    worst = Math.max(worst, Math.abs(m.positions[i + 1] - want));
    if (m.positions[i] !== before[i] || m.positions[i + 2] !== before[i + 2]) worst = Infinity;
  }
  ok(worst < 1e-6, `stretch: center が伸縮の不動点になる (最大差 ${worst.toExponential(2)})`);

  // taper: 中心を BBox の外に置くと t が ±1 に張り付く。clamp がないと
  // t が 8〜10 になって倍率が 10 倍近くまで暴走する。
  const a = sphere();
  applyDeform(a, 'taper', { axis: 1, amount: 1, center: [0, -8, 0] });
  const ex = axisExtent(a, 0);
  ok(Math.abs(ex - 4) < 1e-3, `taper: BBox 外の中心でも倍率が 2 倍で止まる (X 幅 ${ex.toFixed(4)} / 期待 4)`);
  validate(a, { label: 'taper 中心が BBox 外' });

  // twist: 同じく t が全頂点で 1 に張り付くので、モデル全体が指定角ちょうどの
  // 剛体回転になる。clamp が抜けると頂点ごとに角度がばらけて一致しない。
  const b = sphere();
  const b0 = snap(b);
  applyDeform(b, 'twist', { axis: 1, amount: 90, center: [0, -8, 0] });
  let wr = 0;
  for (let v = 0; v < b.nv; v++) {
    if (!b.vAlive[v]) continue;
    const i = v * 3;
    // axis=1 → au=2(Z), av=0(X)。角度 +90° で (z,x) → (-x, z)
    wr = Math.max(wr, Math.abs(b.positions[i + 2] - (-b0[i])), Math.abs(b.positions[i] - b0[i + 2]));
  }
  ok(wr < 1e-6, `twist: BBox 外の中心では指定角ちょうどの剛体回転になる (最大差 ${wr.toExponential(2)})`);
  validate(b, { label: 'twist 中心が BBox 外' });

  // bend も t が 1 に張り付くので閉じた式になる。axis=1 / au=2(Z) / cu=0 のとき
  //   arm = R - z_old,  y_new = ca + arm*sin(total),  z_new = cu + R - arm*cos(total)
  // で total = 90° なら y_new = ca + R - z_old, z_new = R。
  // clamp が抜けると頂点ごとに角度がばらけて一致しない。
  const c = sphere();
  const c0 = snap(c);
  const half = (c.bounds().max[1] - c.bounds().min[1]) * 0.5;
  applyDeform(c, 'bend', { axis: 1, amount: 90, center: [0, -8, 0] });
  const R = half / (90 * Math.PI / 180);
  let wb = 0;
  for (let v = 0; v < c.nv; v++) {
    if (!c.vAlive[v]) continue;
    const i = v * 3;
    wb = Math.max(wb, Math.abs(c.positions[i + 1] - (-8 + R - c0[i + 2])), Math.abs(c.positions[i + 2] - R));
  }
  ok(wb < 2e-6, `bend: BBox 外の中心では角度が上限で止まる (最大差 ${wb.toExponential(2)})`);
  validate(c, { label: 'bend 中心が BBox 外' });
}

// ---------------------------------------------------------------------------
head('潰れたモデル（平面）: 0 除算と長さ 0 の正規化');
// 軸方向の幅が 0 のモデルでは BBox 半幅が 0 になる（half に下限 1e-6 を置いている）。
// さらに平面は BBox 中心にちょうど頂点が乗るので、spherize の「中心からの向きが
// 決まらない」経路も通る。どちらも 0 除算で NaN を吐きやすい場所。
for (const d of DEFORMS) {
  const g = PRIMITIVES.plane();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const live = m.liveVerts;
  const r = applyDeform(m, d.id, Object.assign(defaultOpts(d.id), { axis: 1 }));
  let bad = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(m.positions[v * 3 + k])) bad++;
      if (!Number.isFinite(m.normals[v * 3 + k])) bad++;
    }
    if (!Number.isFinite(m.curv[v])) bad++;
  }
  ok(bad === 0, `平面 ${d.id}: 位置・法線・曲率に非有限が出ない (${bad} 成分)`);
  ok(r.skipped === 0, `平面 ${d.id}: 棄却された頂点がない (${r.skipped})`);
  ok(r.changed <= live, `平面 ${d.id}: changed が生存数以内 (${r.changed}/${live})`);
  validate(m, { closed: false, label: `平面 ${d.id}` });
}
{
  // BBox 中心と一致する頂点は spherize の対象から外れる（寄せる向きが決まらない）。
  // 平面の中心頂点がちょうどそれなので、生存数より 1 つ少ないことで確認できる。
  const g = PRIMITIVES.plane();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  const c = m.bounds().center;
  let atCenter = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (Math.hypot(m.positions[i] - c[0], m.positions[i + 1] - c[1], m.positions[i + 2] - c[2]) < 1e-12) atCenter++;
  }
  ok(atCenter === 1, `平面の中心に頂点がちょうど 1 つある (${atCenter})`);
  const r = applyDeform(m, 'spherize', { amount: 1 });
  ok(r.changed === m.liveVerts - atCenter,
    `spherize: 中心と一致する頂点だけ動かさない (${r.changed} / ${m.liveVerts - atCenter})`);
}

// ---------------------------------------------------------------------------
head('changed が実際の変化と一致する');
// 計算途中の double で比較していた頃は、float32 の 1 ULP に届かない変位でも
// changed > 0 になり、全体の法線・曲率の作り直しが無駄に走っていた。
// 「微小量」と「double で渡した中心」の 2 つがその条件を踏む。
for (const d of DEFORMS) {
  for (const [tag, opts] of [
    ['微小量', { axis: 1, amount: 1e-9, scale: 6, iterations: 3 }],
    ['double 中心', { axis: 1, amount: 0, scale: 6, iterations: 3, center: [0.3, -0.7, 0.11] }],
  ]) {
    const m = sphere();
    const before = snap(m);
    const geom0 = m.geomVersion;
    const r = applyDeform(m, d.id, opts);
    let moved = 0;
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v]) continue;
      const i = v * 3;
      if (m.positions[i] !== before[i] || m.positions[i + 1] !== before[i + 1]
        || m.positions[i + 2] !== before[i + 2]) moved++;
    }
    ok(r.changed === moved, `${d.id} ${tag}: changed が実際の変化数と一致 (${r.changed} / ${moved})`);
    ok(moved > 0 || m.geomVersion === geom0,
      `${d.id} ${tag}: 動いていないなら geomVersion も増えない`);
  }
}

// ---------------------------------------------------------------------------
head('smoothAll の隣接和');
{
  // 退化三角形（削除済み = (0,0,0)）を数えていないこと。退化判定が抜けると
  // 頂点 0 だけが「自分自身を隣接」として数えられ、平滑化が鈍る。
  // 頂点 0 に接していない三角形を消してから、頂点 0 の 1-ring 平均を独立に検算する。
  const m = sphere();
  let victim = -1;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3;
    if (m.tris[i] !== 0 && m.tris[i + 1] !== 0 && m.tris[i + 2] !== 0) { victim = t; break; }
  }
  ok(victim >= 0, '頂点 0 に接していない三角形が見つかる');
  m.removeTriangle(victim);
  ok(m.tris[victim * 3] === 0 && m.tris[victim * 3 + 2] === 0, '削除された三角形は (0,0,0) になっている');

  const P = m.positions, T = m.tris;
  // 実装と同じ重み付け（接する三角形ぶん重複して数える）で 1-ring 平均を作る
  let sx = 0, sy = 0, sz = 0, cnt = 0;
  for (const t of m.ringArray(0)) {
    const i = t * 3;
    for (let e = 0; e < 3; e++) {
      const u = T[i + e];
      if (u === 0) continue;
      sx += P[u * 3]; sy += P[u * 3 + 1]; sz += P[u * 3 + 2]; cnt++;
    }
  }
  const amount = 0.4;
  const want = [
    P[0] + (sx / cnt - P[0]) * amount,
    P[1] + (sy / cnt - P[1]) * amount,
    P[2] + (sz / cnt - P[2]) * amount,
  ];
  applyDeform(m, 'smoothAll', { amount, iterations: 1 });
  const d = Math.max(Math.abs(P[0] - want[0]), Math.abs(P[1] - want[1]), Math.abs(P[2] - want[2]));
  ok(d < 1e-6, `smoothAll: 退化三角形を隣接に数えていない (頂点 0 の差 ${d.toExponential(2)})`);
  validate(m, { closed: false, label: 'smoothAll + 退化三角形' });
}

// ---------------------------------------------------------------------------
head('非有限な入力で NaN を書かない');
{
  // 中心に NaN を渡す。中心を使う変形は全頂点を棄却し、使わない変形
  // （inflate / noise / smoothAll）は通常どおり動く。どちらにしても座標に
  // 非有限を 1 つでも残すと computeAllNormals 経由で全体へ広がりモデルが消える。
  for (const d of DEFORMS) {
    const m = sphere();
    const before = snap(m);
    const r = applyDeform(m, d.id, Object.assign(defaultOpts(d.id), { axis: 1, center: [NaN, NaN, NaN] }));
    let bad = 0;
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v]) continue;
      for (let k = 0; k < 3; k++) if (!Number.isFinite(m.positions[v * 3 + k])) bad++;
    }
    ok(bad === 0, `${d.id}: NaN 中心でも非有限を書かない (${bad} 成分)`);
    ok(r.skipped === 0 || r.skipped === m.liveVerts,
      `${d.id}: 棄却するなら全生存頂点 (${r.skipped} / ${m.liveVerts})`);
    if (r.changed === 0) ok(maxDiff(snap(m), before) === 0, `${d.id}: 全部棄却なら座標は 1 ビットも動かない`);
    validate(m, { label: `${d.id} NaN 中心` });
  }

  // 最初から壊れているメッシュ（生存頂点に Infinity）を渡しても、その頂点以外へ
  // 非有限を広げないこと。ブラシや IO 経由で 1 頂点だけ壊れることは実際に起きる。
  for (const d of DEFORMS) {
    const m = sphere();
    m.positions[3] = Infinity;                 // 頂点 1 を壊す
    const r = applyDeform(m, d.id, Object.assign(defaultOpts(d.id), { axis: 1 }));
    let bad = 0;
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v] || v === 1) continue;
      for (let k = 0; k < 3; k++) if (!Number.isFinite(m.positions[v * 3 + k])) bad++;
    }
    ok(bad === 0, `${d.id}: 壊れた 1 頂点から他へ非有限が漏れない (${bad} 成分)`);
    ok(r.changed + r.masked + r.skipped <= m.liveVerts, `${d.id}: 統計の合計が生存数を超えない`);
  }
}

// ---------------------------------------------------------------------------
head('不正な入力');
{
  const m = sphere();
  const before = snap(m);
  const r = applyDeform(m, 'nosuchdeform', { amount: 1 });
  ok(r.ok === false && r.changed === 0, '未知 id は ok=false / changed=0');
  ok(maxDiff(snap(m), before) === 0, '未知 id で座標が変わらない');

  // NaN / 範囲外 / 型違いは既定値と min/max に丸められる
  const a = sphere(), b = sphere();
  applyDeform(a, 'taper', { axis: 1, amount: NaN });
  applyDeform(b, 'taper', { axis: 1, amount: DEFORM_BY_ID.get('taper').params[0].def });
  ok(maxDiff(snap(a), snap(b)) === 0, 'NaN の量は既定値にフォールバックする');
  validate(a, { label: 'NaN amount' });

  const c = sphere(), d = sphere();
  applyDeform(c, 'taper', { axis: 1, amount: 1e9 });
  applyDeform(d, 'taper', { axis: 1, amount: 1 });
  ok(maxDiff(snap(c), snap(d)) === 0, '範囲外の量は max に丸められる');
  validate(c, { label: 'clamped amount' });

  const e = sphere(), f = sphere();
  applyDeform(e, 'taper', { axis: 7, amount: 0.5 });
  applyDeform(f, 'taper', { axis: 1, amount: 0.5 });
  ok(maxDiff(snap(e), snap(f)) === 0, '不正な軸は Y にフォールバックする');

  // 中心の上書きが効く
  const g1 = sphere(), g2 = sphere();
  applyDeform(g1, 'flattenAxis', { axis: 1, amount: 1 });
  applyDeform(g2, 'flattenAxis', { axis: 1, amount: 1, center: [0, 0.5, 0] });
  ok(Math.abs(g1.positions[1]) < 1e-6, '既定の中心は BBox 中心（原点）');
  ok(Math.abs(g2.positions[1] - 0.5) < 1e-6, `center で潰す高さを指定できる (${g2.positions[1]})`);

  // opts をまるごと省略しても既定値で動く（UI 配線前の呼び出しで踏む）
  const h1 = sphere(), h2 = sphere();
  applyDeform(h1, 'taper');
  applyDeform(h2, 'taper', defaultOpts('taper'));
  ok(maxDiff(snap(h1), snap(h2)) === 0, 'opts 省略は defaultOpts と同じ結果');

  // iterations は 1..20 に丸められる（1e9 で固まらない）
  const i1 = sphere(), i2 = sphere();
  applyDeform(i1, 'noise', { amount: 0.08, scale: 14 });
  applyDeform(i2, 'noise', { amount: 0.08, scale: 14 });
  applyDeform(i1, 'smoothAll', { amount: 0.5, iterations: 1e9 });
  applyDeform(i2, 'smoothAll', { amount: 0.5, iterations: 20 });
  ok(maxDiff(snap(i1), snap(i2)) === 0, 'iterations は max(20) に丸められる');
  const i3 = sphere(), i4 = sphere();
  applyDeform(i3, 'smoothAll', { amount: 0.5, iterations: -5 });
  applyDeform(i4, 'smoothAll', { amount: 0.5, iterations: 1 });
  ok(maxDiff(snap(i3), snap(i4)) === 0, 'iterations は min(1) に丸められる');

  // 空のメッシュでも落ちない
  const empty = new SculptMesh();
  const re = applyDeform(empty, 'taper', { axis: 1, amount: 0.5 });
  ok(re.ok === false && re.changed === 0, '空メッシュでも安全に何もしない');
  ok(re.verts === 0 && re.axis === -1, '空メッシュの統計が既定値 (verts=0 / axis=-1)');
}

// ---------------------------------------------------------------------------
head('連続適用と規模');
{
  // パレットを次々に押しても壊れないこと
  const m = sphere(4);
  const t0 = Date.now();
  let total = 0;
  for (const d of DEFORMS) {
    const r = applyDeform(m, d.id, Object.assign(defaultOpts(d.id), { axis: (DEFORM_IDS.indexOf(d.id)) % 3 }));
    total += r.changed;
    ok(r.skipped === 0, `${d.id}: 連鎖適用でも非有限が出ない`);
  }
  console.log(`  ${m.liveVerts.toLocaleString()} 頂点に 9 種を連続適用: ${total.toLocaleString()} 頂点更新 / ${Date.now() - t0} ms`);
  validate(m, { label: '9 種連続適用' });

  // 規模を上げても線形の範囲に収まること（時間は環境依存なので出力のみ）
  const big = sphere(4);
  for (const id of ['taper', 'twist', 'bend', 'noise', 'smoothAll']) {
    const s = Date.now();
    const r = applyDeform(big, id, Object.assign(defaultOpts(id), { axis: 1 }));
    console.log(`  ${id.padEnd(12)} ${big.liveVerts.toLocaleString()} 頂点 → ${Date.now() - s} ms (内部計測 ${r.ms} ms)`);
  }
  validate(big, { label: '高密度' });
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
