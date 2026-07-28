// トランスポーズ（ギズモ）の検証。DOM / WebGPU に触らない純粋な幾何のみ。
import { SculptMesh, PRIMITIVES, DIRTY_SHIFT } from '../js/mesh.js';
import { Transpose } from '../js/transpose.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

/** 正八面体（頂点が軸上にあるので変換の期待値を手で書ける） */
function octahedron() {
  const positions = new Float32Array([
    1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1,
  ]);
  const indices = new Uint32Array([
    0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4,
    2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5,
  ]);
  const m = new SculptMesh();
  m.setGeometry(positions, indices);
  return m;
}

function sphere(hi = false) {
  const g = hi ? PRIMITIVES.sphereHi() : PRIMITIVES.sphere();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  return m;
}

/** 多様体性 / ring 整合性 / NaN / オイラー標数（閉じた球面 = 2） */
function checkMesh(mesh, label) {
  const errs = [];
  const T = mesh.tris;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    if (a === b || b === c || c === a) errs.push(`tri ${t} degenerate`);
    for (const v of [a, b, c]) {
      if (v < 0 || v >= mesh.nv) errs.push(`tri ${t} vert out of range`);
      else if (!mesh.vAlive[v]) errs.push(`tri ${t} refs dead vert ${v}`);
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
  if (boundary) errs.push(`${boundary} boundary edges`);
  const chi = mesh.liveVerts - em.size + mesh.liveTris;
  if (chi !== 2) errs.push(`Euler characteristic = ${chi} (expected 2)`);

  let nan = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(mesh.positions[v * 3 + k])) nan++;
      if (!Number.isFinite(mesh.normals[v * 3 + k])) nan++;
    }
  }
  if (nan) errs.push(`${nan} non-finite position/normal components`);

  // ring の双方向整合性
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    for (const v of [a, b, c]) {
      const r = mesh.ringArray(v);
      if (!r || r.indexOf(t) < 0) errs.push(`tri ${t} not in ring of ${v}`);
    }
  }

  if (errs.length) {
    failures++;
    console.log(`  FAIL ${label}: ${errs.length} problem(s)`);
    errs.slice(0, 6).forEach(e => console.log('      - ' + e));
  } else {
    console.log(`  ok   ${label}  V=${mesh.liveVerts} F=${mesh.liveTris}`);
  }
  return errs.length === 0;
}

function snap(mesh) { return mesh.positions.slice(0, mesh.nv * 3); }

/** ビット単位で同一か（Float32Array 同士なので厳密比較でよい） */
function bitEqual(a, b, n) {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** ロドリゲス回転（モジュールとは独立に書いた参照実装） */
function rot(p, n, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
  const cx = n[1] * p[2] - n[2] * p[1];
  const cy = n[2] * p[0] - n[0] * p[2];
  const cz = n[0] * p[1] - n[1] * p[0];
  return [
    p[0] * c + cx * s + n[0] * d * (1 - c),
    p[1] * c + cy * s + n[1] * d * (1 - c),
    p[2] * c + cz * s + n[2] * d * (1 - c),
  ];
}

// レイはギズモのピボットと基底から作る。ワールド軸を決め打ちにすると PCA 基底や
// 移動後のピボットでは意図したハンドルを掴めない。また移動 / 回転はドラッグ中に
// ピボットと基底が動くので、ドラッグ開始前のものを控えて使う（モジュール側も
// 開始時の値を基準に計算しているので、これが「マウスを動かしていない状態」に対応する）。
function frameOf(tp) { return { p: tp.pivot(), B: tp.basis().slice() }; }
function ax3(F, i) { return [F.B[i * 3], F.B[i * 3 + 1], F.B[i * 3 + 2]]; }

/** a に直交する単位ベクトル */
function perpOf(a) {
  const e = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c = [a[1] * e[2] - a[2] * e[1], a[2] * e[0] - a[0] * e[2], a[0] * e[1] - a[1] * e[0]];
  const l = Math.hypot(c[0], c[1], c[2]);
  return [c[0] / l, c[1] / l, c[2] / l];
}

/** 軸 i を横から覗くレイ。軸上の最近接位置がちょうど t になる */
function axisRay(F, i, t, dist = 4) {
  const a = ax3(F, i), q = perpOf(a), o = [0, 0, 0];
  for (let k = 0; k < 3; k++) o[k] = F.p[k] + a[k] * t + q[k] * dist;
  return { o, d: [-q[0], -q[1], -q[2]] };
}

/** 軸 i の回転リング上で角度 ang を指すレイ（リング面を正面から覗く） */
function ringRay(F, i, ang, dist = 5) {
  const u = ax3(F, (i + 1) % 3), v = ax3(F, (i + 2) % 3), n = ax3(F, i);
  const c = Math.cos(ang), s = Math.sin(ang), o = [0, 0, 0];
  for (let k = 0; k < 3; k++) o[k] = F.p[k] + u[k] * c + v[k] * s + n[k] * dist;
  return { o, d: [-n[0], -n[1], -n[2]] };
}

/** 軸 i を法線とする平面ハンドルを、面内の距離 r の位置で掴むレイ */
function planeRay(F, i, r, dist = 5) {
  const u = ax3(F, (i + 1) % 3), n = ax3(F, i), o = [0, 0, 0];
  for (let k = 0; k < 3; k++) o[k] = F.p[k] + u[k] * r + n[k] * dist;
  return { o, d: [-n[0], -n[1], -n[2]] };
}

let mesh, tp, before, r, F;

// ---------------------------------------------------------------------------
head('setFromMask: 領域とピボット');
{
  mesh = octahedron();
  tp = new Transpose();
  ok(tp.active === false, '初期状態は非アクティブ');
  ok(tp.handles(1).length === 0, '非アクティブなら handles は空');
  ok(tp.hitTest([0, 0, 5], [0, 0, -1], 0.1, 1) === null, '非アクティブなら hitTest は null');

  ok(tp.setFromMask(mesh) === true, 'マスク無しなら領域はメッシュ全体');
  ok(tp.active === true, 'setFromMask 後はアクティブ');
  ok(tp.stats().verts === 6, `領域頂点数 = 6 (${tp.stats().verts})`);
  let p = tp.pivot();
  ok(Math.hypot(p[0], p[1], p[2]) < 1e-6, `ピボットは重心 (${p.map(x => x.toFixed(3))})`);

  mesh.mask.fill(1, 0, mesh.nv);
  ok(tp.setFromMask(mesh) === false, '全部マスクされていたら false');
  ok(tp.active === false, '空領域なら非アクティブに戻る');

  // 部分マスクを含む加重重心
  mesh.mask.fill(0, 0, mesh.nv);
  mesh.mask[3] = 1; mesh.mask[5] = 0.5;
  ok(tp.setFromMask(mesh) === true, '部分マスクでも領域が取れる');
  ok(tp.stats().verts === 5, `mask=1 の頂点は領域に入らない (${tp.stats().verts})`);
  {
    let cx = 0, cy = 0, cz = 0, ws = 0;
    for (let v = 0; v < mesh.nv; v++) {
      const w = 1 - mesh.mask[v];
      if (w <= 1e-4) continue;
      cx += mesh.positions[v * 3] * w; cy += mesh.positions[v * 3 + 1] * w;
      cz += mesh.positions[v * 3 + 2] * w; ws += w;
    }
    p = tp.pivot();
    const d = Math.hypot(p[0] - cx / ws, p[1] - cy / ws, p[2] - cz / ws);
    ok(d < 1e-6, `ピボットは 1-mask の加重重心 (誤差 ${d.toExponential(1)})`);
  }
  tp.clear();
  ok(tp.active === false, 'clear で非アクティブ');
}

// ---------------------------------------------------------------------------
head('ハンドル形状');
{
  mesh = octahedron();
  tp = new Transpose();
  tp.setFromMask(mesh);
  const L = 2.5;
  const H = tp.handles(L);
  ok(H.length === 10, `ハンドル数 = 10 (${H.length})`);
  const kinds = H.map(h => h.kind).join(',');
  ok(kinds === 'move,move,move,scale,scale,scale,rotate,rotate,rotate,uniform',
    `種類の並び (${kinds})`);
  let nan = 0, segs = 0, badLen = 0;
  for (const h of H) {
    if (h.points.length % 6 !== 0) badLen++;
    segs += h.points.length / 6;
    for (let i = 0; i < h.points.length; i++) if (!Number.isFinite(h.points[i])) nan++;
    ok(Array.isArray(h.color) && h.color.length === 3, `${h.kind} に色がある`);
  }
  ok(badLen === 0, '全ハンドルの points は 6 の倍数（線分リスト）');
  ok(nan === 0, `ハンドル座標に NaN が無い (${nan})`);
  console.log(`       線分 ${segs} 本`);

  // 回転リングは半径 L の円周上にある
  for (let i = 0; i < 3; i++) {
    const p = H[6 + i].points;
    let emax = 0;
    for (let k = 0; k < p.length; k += 3) {
      emax = Math.max(emax, Math.abs(Math.hypot(p[k], p[k + 1], p[k + 2]) - L));
    }
    ok(emax < 1e-5, `回転リング ${i} は半径 ${L} (誤差 ${emax.toExponential(1)})`);
  }
  // 矢印の一番遠い点は軸上の L
  for (let i = 0; i < 3; i++) {
    const p = H[i].points;
    let dmax = 0;
    for (let k = 0; k < p.length; k += 3) dmax = Math.max(dmax, Math.hypot(p[k], p[k + 1], p[k + 2]));
    ok(Math.abs(dmax - L) < 1e-5, `矢印 ${i} の全長 = ${L} (${dmax.toFixed(4)})`);
  }
  ok(tp.handles(L)[0].points === H[0].points, 'handles は配列を使い回す');
}

// ---------------------------------------------------------------------------
head('ヒットテスト');
{
  mesh = octahedron();
  tp = new Transpose();
  tp.setFromMask(mesh);
  const L = 1, tol = 0.03;
  const cases = [
    [[0.5, 0, 3], [0, 0, -1], 'move', 0, 'X 矢印の途中'],
    [[0, 0.5, 3], [0, 0, -1], 'move', 1, 'Y 矢印の途中'],
    [[0, 3, 0.5], [0, -1, 0], 'move', 2, 'Z 矢印の途中'],
    [[0, 0, 3], [0, 0, -1], 'uniform', -1, 'ど真ん中は一様スケール'],
    [[0.42, 0.42, 3], [0, 0, -1], 'scale', 2, 'XY 平面ハンドル'],
    [[0.42, 3, 0.42], [0, -1, 0], 'scale', 1, 'ZX 平面ハンドル'],
    [[Math.SQRT1_2, Math.SQRT1_2, 3], [0, 0, -1], 'rotate', 2, 'XY 面の回転リング'],
    [[Math.SQRT1_2, 3, Math.SQRT1_2], [0, -1, 0], 'rotate', 1, 'ZX 面の回転リング'],
  ];
  for (const [o, d, kind, axis, label] of cases) {
    const h = tp.hitTest(o, d, tol, L);
    ok(h !== null && h.kind === kind && h.axis === axis,
      `${label} → ${kind}/${axis} (得られたのは ${h ? h.kind + '/' + h.axis : 'null'})`);
  }
  ok(tp.hitTest([5, 5, 3], [0, 0, -1], tol, L) === null, '離れた所は null');
  ok(tp.hitTest([0.5, 0, 3], [0, 0, -1], tol, L).kind
    === tp.hitTest([0.5, 0, 3], [0, 0, -7.5], tol, L).kind, 'レイ方向は正規化されていなくてよい');
  ok(tp.hitTest([0.5, 0, 3], [0, 0, 1], tol, L) === null, 'レイの後方は拾わない');
}

// ---------------------------------------------------------------------------
head('移動: オフセットが正確 / マスクは不動');
{
  mesh = sphere();
  // 上半分をマスク（グラデーション無し）
  for (let v = 0; v < mesh.nv; v++) mesh.mask[v] = mesh.positions[v * 3 + 1] > 0 ? 1 : 0;
  tp = new Transpose();
  ok(tp.setFromMask(mesh) === true, '半分マスクで領域が取れる');
  before = snap(mesh);
  const topo0 = mesh.topoVersion, geom0 = mesh.geomVersion;

  F = frameOf(tp);
  const g0 = axisRay(F, 0, 0.5), g1 = axisRay(F, 0, 1.1);
  const hit = tp.hitTest(g0.o, g0.d, 0.05, 1);
  ok(hit && hit.kind === 'move' && hit.axis === 0, 'X 矢印を掴む');
  ok(tp.beginDrag(mesh, hit, g0.o, g0.d) === true, 'beginDrag が成功');
  r = tp.updateDrag(mesh, g1.o, g1.d);
  ok(Math.abs(r.offset - 0.6) < 1e-6, `オフセット = 0.6 (${r.offset.toFixed(6)})`);
  ok(r.changed === tp.stats().verts, `changed = 領域頂点数 (${r.changed}/${tp.stats().verts})`);

  let emax = 0, movedMasked = 0;
  for (let v = 0; v < mesh.nv; v++) {
    const i = v * 3;
    if (mesh.mask[v] >= 1) {
      if (mesh.positions[i] !== before[i] || mesh.positions[i + 1] !== before[i + 1]
        || mesh.positions[i + 2] !== before[i + 2]) movedMasked++;
      continue;
    }
    emax = Math.max(emax,
      Math.abs(mesh.positions[i] - (before[i] + 0.6)),
      Math.abs(mesh.positions[i + 1] - before[i + 1]),
      Math.abs(mesh.positions[i + 2] - before[i + 2]));
  }
  ok(movedMasked === 0, `mask=1 の頂点は 1 ビットも動かない (動いた数 ${movedMasked})`);
  ok(emax < 1e-6, `weight=1 の頂点は正確に +0.6X (最大誤差 ${emax.toExponential(1)})`);
  ok(Math.abs(tp.pivot()[0] - (F.p[0] + 0.6)) < 1e-6,
    `ピボットが移動に追従する (${tp.pivot()[0].toFixed(4)})`);

  // 同じレイで何度更新しても結果は同じ（べき等）
  const after1 = snap(mesh);
  tp.updateDrag(mesh, g1.o, g1.d);
  tp.updateDrag(mesh, g1.o, g1.d);
  ok(bitEqual(after1, mesh.positions, mesh.nv * 3), '同じレイでの updateDrag はべき等');

  // 開始位置のレイに戻せばビット単位で元の形（絶対変換なので誤差が溜まらない）
  tp.updateDrag(mesh, g0.o, g0.d);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), '開始レイに戻すと厳密に元の形');
  r = tp.updateDrag(mesh, g0.o, g0.d);
  ok(r.changed === 0, '変位ゼロなら changed = 0');

  tp.updateDrag(mesh, g1.o, g1.d);
  const st = tp.endDrag(mesh);
  ok(st.changed === tp.stats().verts, `endDrag が移動頂点数を返す (${st.changed})`);
  ok(mesh.topoVersion === topo0, 'トポロジは変わらない');
  ok(mesh.geomVersion > geom0, 'geomVersion が進む');
  checkMesh(mesh, '移動後');
}

// ---------------------------------------------------------------------------
head('移動: 往復しても誤差が溜まらない');
{
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  F = frameOf(tp);
  const b0 = axisRay(F, 1, 0.2);
  tp.beginDrag(mesh, { kind: 'move', axis: 1 }, b0.o, b0.d);
  for (let k = 0; k < 200; k++) {
    const bk = axisRay(F, 1, 0.2 + Math.sin(k * 0.31) * 1.7);
    tp.updateDrag(mesh, bk.o, bk.d);
  }
  tp.updateDrag(mesh, b0.o, b0.d);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), '200 回動かして戻しても厳密に一致');
  tp.endDrag(mesh);
}

// ---------------------------------------------------------------------------
head('回転: 距離を保つ / 参照実装と一致');
{
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  F = frameOf(tp);
  const piv = F.p;
  const a0 = ringRay(F, 1, 0), a1 = ringRay(F, 1, Math.PI / 2);
  ok(tp.beginDrag(mesh, { kind: 'rotate', axis: 1 }, a0.o, a0.d) === true, '回転リングを掴む');
  r = tp.updateDrag(mesh, a1.o, a1.d);
  ok(Math.abs(r.degrees - 90) < 1e-4, `90 度回った (${r.degrees.toFixed(4)})`);

  let dmax = 0, pmax = 0;
  for (let v = 0; v < mesh.nv; v++) {
    const i = v * 3;
    const o = [before[i] - piv[0], before[i + 1] - piv[1], before[i + 2] - piv[2]];
    const n = [mesh.positions[i] - piv[0], mesh.positions[i + 1] - piv[1], mesh.positions[i + 2] - piv[2]];
    dmax = Math.max(dmax, Math.abs(Math.hypot(...o) - Math.hypot(...n)));
    const e = rot(o, [0, 1, 0], Math.PI / 2);
    pmax = Math.max(pmax, Math.abs(e[0] - n[0]), Math.abs(e[1] - n[1]), Math.abs(e[2] - n[2]));
  }
  ok(dmax < 1e-5, `ピボットからの距離が保たれる (最大差 ${dmax.toExponential(1)})`);
  ok(pmax < 1e-5, `参照ロドリゲス回転と一致 (最大差 ${pmax.toExponential(1)})`);

  // 1 回転を超える累積（170 度 → 190 度でも折り返さない）
  const a2 = ringRay(F, 1, Math.PI * 170 / 180);
  const a3 = ringRay(F, 1, Math.PI * 190 / 180);
  tp.updateDrag(mesh, a2.o, a2.d);
  r = tp.updateDrag(mesh, a3.o, a3.d);
  ok(Math.abs(r.degrees - 190) < 1e-3, `190 度まで連続して回る (${r.degrees.toFixed(3)})`);
  {
    let e2 = 0;
    for (let v = 0; v < mesh.nv; v++) {
      const i = v * 3;
      const o = [before[i] - piv[0], before[i + 1] - piv[1], before[i + 2] - piv[2]];
      const e = rot(o, [0, 1, 0], Math.PI * 190 / 180);
      e2 = Math.max(e2,
        Math.abs(e[0] - (mesh.positions[i] - piv[0])),
        Math.abs(e[1] - (mesh.positions[i + 1] - piv[1])),
        Math.abs(e[2] - (mesh.positions[i + 2] - piv[2])));
    }
    ok(e2 < 1e-5, `190 度の位置も参照実装と一致 (${e2.toExponential(1)})`);
  }
  // 基底も一緒に回っている（軸 1 まわりなので軸 0 が倒れ、軸 1 は不動）
  {
    const B = tp.basis();
    const e = rot([1, 0, 0], [0, 1, 0], Math.PI * 190 / 180);
    ok(Math.hypot(B[0] - e[0], B[1] - e[1], B[2] - e[2]) < 1e-5, '基底が同じ回転で回る');
    ok(Math.abs(B[3]) < 1e-6 && Math.abs(B[4] - 1) < 1e-6, '回転軸は動かない');
  }
  tp.endDrag(mesh);
  checkMesh(mesh, '回転後');
}

// ---------------------------------------------------------------------------
head('回転: スナップ');
{
  mesh = octahedron();
  tp = new Transpose();
  tp.setFromMask(mesh);
  F = frameOf(tp);
  const a0 = ringRay(F, 1, 0), a1 = ringRay(F, 1, Math.PI * 47 / 180);
  tp.beginDrag(mesh, { kind: 'rotate', axis: 1 }, a0.o, a0.d);
  r = tp.updateDrag(mesh, a1.o, a1.d, { snap: true });
  ok(Math.abs(r.degrees - 45) < 1e-6, `47 度は 45 度へスナップ (${r.degrees.toFixed(6)})`);
  r = tp.updateDrag(mesh, a1.o, a1.d, { snap: false });
  ok(Math.abs(r.degrees - 47) < 1e-3, `スナップ無しなら 47 度 (${r.degrees.toFixed(4)})`);
  tp.cancelDrag(mesh);
}

// ---------------------------------------------------------------------------
head('平面スケール: 比例する / 軸方向は変わらない');
{
  mesh = octahedron();
  mesh.mask[4] = 1;                      // (0,0,1) を固定
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  F = frameOf(tp);
  const piv = F.p;
  ok(Math.abs(piv[2] + 0.2) < 1e-6, `ピボットは固定点を除いた重心 (z=${piv[2].toFixed(3)})`);

  // 法線 X の平面（軸 1,2 = Y,Z が面内）。+Y 側を掴んで倍に伸ばす
  const s0 = planeRay(F, 0, 0.5), s1 = planeRay(F, 0, 1.0);
  ok(tp.beginDrag(mesh, { kind: 'scale', axis: 0 }, s0.o, s0.d) === true, '平面ハンドルを掴む');
  r = tp.updateDrag(mesh, s1.o, s1.d);
  ok(Math.abs(r.factor - 2) < 1e-6, `倍率 = 2 (${r.factor.toFixed(6)})`);

  let emax = 0, movedMasked = 0;
  for (let v = 0; v < mesh.nv; v++) {
    const i = v * 3;
    if (mesh.mask[v] >= 1) {
      if (mesh.positions[i] !== before[i] || mesh.positions[i + 1] !== before[i + 1]
        || mesh.positions[i + 2] !== before[i + 2]) movedMasked++;
      continue;
    }
    emax = Math.max(emax,
      Math.abs((mesh.positions[i] - piv[0]) - (before[i] - piv[0])),
      Math.abs((mesh.positions[i + 1] - piv[1]) - (before[i + 1] - piv[1]) * 2),
      Math.abs((mesh.positions[i + 2] - piv[2]) - (before[i + 2] - piv[2]) * 2));
  }
  ok(movedMasked === 0, 'mask=1 の頂点は動かない（スケールでも）');
  ok(emax < 1e-6, `面内 (Y,Z) だけが 2 倍・X はそのまま (誤差 ${emax.toExponential(1)})`);

  // スナップ（1.04 → 1.0）
  const s2 = planeRay(F, 0, 0.52);
  r = tp.updateDrag(mesh, s2.o, s2.d, { snap: true });
  ok(Math.abs(r.factor - 1) < 1e-9, `倍率 1.04 は 1.0 へスナップ (${r.factor})`);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), '倍率 1 なら形はビット単位で元のまま');

  tp.updateDrag(mesh, s1.o, s1.d);
  tp.endDrag(mesh);
  checkMesh(mesh, '平面スケール後');
}

// ---------------------------------------------------------------------------
head('一様スケール');
{
  mesh = octahedron();
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  ok(tp.beginDrag(mesh, { kind: 'uniform', axis: -1 }, [0.5, 0, 5], [0, 0, -1]) === true,
    '中心ハンドルを掴む');
  r = tp.updateDrag(mesh, [1.5, 0, 5], [0, 0, -1]);
  ok(Math.abs(r.factor - 3) < 1e-6, `倍率 = 3 (${r.factor.toFixed(6)})`);
  let emax = 0;
  for (let v = 0; v < mesh.nv; v++) {
    const i = v * 3;
    for (let k = 0; k < 3; k++) emax = Math.max(emax, Math.abs(mesh.positions[i + k] - before[i + k] * 3));
  }
  ok(emax < 1e-6, `全成分が 3 倍 (誤差 ${emax.toExponential(1)})`);

  // 反対側へ通り越しても負に折り返さない（面が裏返らない）
  r = tp.updateDrag(mesh, [-3, 0, 5], [0, 0, -1]);
  ok(r.factor >= 0.01 && r.factor < 0.011, `正の下限で止まる (${r.factor})`);
  let inv = 0;
  for (let v = 0; v < mesh.nv; v++) {
    const i = v * 3;
    if (before[i] * mesh.positions[i] < 0) inv++;
  }
  ok(inv === 0, `座標の符号が反転しない (${inv})`);
  tp.cancelDrag(mesh);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), 'cancelDrag で厳密に元へ');
}

// ---------------------------------------------------------------------------
head('cancelDrag は厳密に元へ戻す');
{
  mesh = sphere();
  for (let v = 0; v < mesh.nv; v++) {
    mesh.mask[v] = Math.min(1, Math.max(0, mesh.positions[v * 3] * 0.5 + 0.5));
  }
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  const nrm0 = mesh.normals.slice(0, mesh.nv * 3);
  F = frameOf(tp);
  const piv0 = F.p, bas0 = F.B;
  const a0 = ringRay(F, 2, 0.3), a1 = ringRay(F, 2, 2.1);
  tp.beginDrag(mesh, { kind: 'rotate', axis: 2 }, a0.o, a0.d);
  tp.updateDrag(mesh, a1.o, a1.d);
  ok(!bitEqual(before, mesh.positions, mesh.nv * 3), 'ドラッグで実際に形が変わっている');
  const cr = tp.cancelDrag(mesh);
  ok(cr.changed > 0, `cancelDrag が戻した頂点数を返す (${cr.changed})`);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), 'cancelDrag で座標がビット単位で元へ');
  let nmax = 0;
  for (let i = 0; i < mesh.nv * 3; i++) nmax = Math.max(nmax, Math.abs(nrm0[i] - mesh.normals[i]));
  ok(nmax < 1e-6, `法線も元に戻る (最大差 ${nmax.toExponential(1)})`);
  const piv1 = tp.pivot();
  ok(Math.hypot(piv1[0] - piv0[0], piv1[1] - piv0[1], piv1[2] - piv0[2]) < 1e-9, 'ピボットも元へ');
  ok(bitEqual(bas0, tp.basis(), 9), '基底も元へ');
  ok(tp.cancelDrag(mesh).changed === 0, 'ドラッグ中でなければ cancelDrag は何もしない');
  checkMesh(mesh, 'キャンセル後');
}

// ---------------------------------------------------------------------------
head('マスクのグラデーション: weight で補間される');
{
  mesh = sphere();
  // x に対して滑らかに変化するマスク（0..1 が全域に散る）
  for (let v = 0; v < mesh.nv; v++) {
    mesh.mask[v] = Math.min(1, Math.max(0, mesh.positions[v * 3] * 0.5 + 0.5));
  }
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  F = frameOf(tp);
  const t0 = axisRay(F, 1, 0), t1 = axisRay(F, 1, 0.8);
  tp.beginDrag(mesh, { kind: 'move', axis: 1 }, t0.o, t0.d);
  r = tp.updateDrag(mesh, t1.o, t1.d);
  const T = r.offset;
  ok(Math.abs(T - 0.8) < 1e-6, `オフセット 0.8 (${T.toFixed(6)})`);

  const rows = [];
  let emax = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const i = v * 3;
    const dy = mesh.positions[i + 1] - before[i + 1];
    const dxz = Math.abs(mesh.positions[i] - before[i]) + Math.abs(mesh.positions[i + 2] - before[i + 2]);
    const w = 1 - mesh.mask[v];
    emax = Math.max(emax, Math.abs(dy - w * T), dxz);
    rows.push([mesh.mask[v], dy]);
  }
  ok(emax < 1e-6, `変位 = weight × オフセット (誤差 ${emax.toExponential(1)})`);
  rows.sort((a, b) => a[0] - b[0]);
  let bad = 0;
  for (let k = 1; k < rows.length; k++) if (rows[k][1] > rows[k - 1][1] + 1e-7) bad++;
  ok(bad === 0, `マスクが濃いほど変位が小さい（単調） (違反 ${bad})`);
  ok(rows[0][1] > rows[rows.length - 1][1], '端どうしで実際に差がある');

  // 回転でも「元位置 ↔ 変換後位置」の線形補間になっている
  tp.cancelDrag(mesh);
  F = frameOf(tp);
  const piv = F.p;
  const a0 = ringRay(F, 1, 0), a1 = ringRay(F, 1, 0.7);
  tp.beginDrag(mesh, { kind: 'rotate', axis: 1 }, a0.o, a0.d);
  tp.updateDrag(mesh, a1.o, a1.d);
  const rows2 = [];
  let rbad = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const i = v * 3;
    const o = [before[i] - piv[0], before[i + 1] - piv[1], before[i + 2] - piv[2]];
    const n = [mesh.positions[i] - piv[0], mesh.positions[i + 1] - piv[1], mesh.positions[i + 2] - piv[2]];
    const e = rot(o, [0, 1, 0], 0.7);
    const w = 1 - mesh.mask[v];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(n[k] - (o[k] + (e[k] - o[k]) * w)) > 1e-5) { rbad++; break; }
    }
    rows2.push([mesh.mask[v], Math.hypot(n[0] - o[0], n[1] - o[1], n[2] - o[2])]);
  }
  ok(rbad === 0, `回転も「元位置 ↔ 変換後位置」の weight 補間 (違反 ${rbad})`);
  rows2.sort((a, b) => a[0] - b[0]);
  // 回転の変位量は半径にも依存するので、完全な単調性ではなく両端の大小を見る
  ok(rows2[0][1] >= rows2[rows2.length - 1][1], 'マスクが濃い端のほうが動いていない');
  tp.endDrag(mesh);
  checkMesh(mesh, 'グラデーション後');
}

// ---------------------------------------------------------------------------
head('法線の更新（mods.normals = false で後回しにできる）');
{
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  F = frameOf(tp);
  const a0 = ringRay(F, 0, 0), a1 = ringRay(F, 0, 0.9);
  tp.beginDrag(mesh, { kind: 'rotate', axis: 0 }, a0.o, a0.d);
  tp.updateDrag(mesh, a1.o, a1.d, { normals: false });
  const stale = mesh.normals.slice(0, mesh.nv * 3);
  tp.endDrag(mesh);
  ok(!bitEqual(stale, mesh.normals, mesh.nv * 3), 'endDrag で後回しの法線が直る');
  const got = mesh.normals.slice(0, mesh.nv * 3);
  mesh.computeAllNormals();
  let nmax = 0;
  for (let i = 0; i < mesh.nv * 3; i++) nmax = Math.max(nmax, Math.abs(got[i] - mesh.normals[i]));
  ok(nmax < 1e-6, `法線が全体再計算と一致 (最大差 ${nmax.toExponential(1)})`);

  // 既定（毎フレーム更新）でも同じ結果になる
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  F = frameOf(tp);
  tp.beginDrag(mesh, { kind: 'rotate', axis: 0 }, a0.o, a0.d);
  tp.updateDrag(mesh, a1.o, a1.d);
  const live = mesh.normals.slice(0, mesh.nv * 3);
  mesh.computeAllNormals();
  nmax = 0;
  for (let i = 0; i < mesh.nv * 3; i++) nmax = Math.max(nmax, Math.abs(live[i] - mesh.normals[i]));
  ok(nmax < 1e-6, `毎フレーム更新でも全体再計算と一致 (最大差 ${nmax.toExponential(1)})`);
  tp.endDrag(mesh);
}

// ---------------------------------------------------------------------------
head('PCA 基底');
{
  const g = PRIMITIVES.sphere();
  const pos = g.positions.slice();
  const ca = Math.cos(Math.PI / 6), sa = Math.sin(Math.PI / 6);
  for (let v = 0; v < pos.length / 3; v++) {
    // 楕円体に潰してから Z 軸まわりに 30 度回す
    const x = pos[v * 3] * 3, y = pos[v * 3 + 1] * 1, z = pos[v * 3 + 2] * 0.4;
    pos[v * 3] = x * ca - y * sa;
    pos[v * 3 + 1] = x * sa + y * ca;
    pos[v * 3 + 2] = z;
  }
  mesh = new SculptMesh();
  mesh.setGeometry(pos, g.indices);
  tp = new Transpose();
  tp.setFromMask(mesh, { basis: 'pca' });
  const B = tp.basis();
  let omax = 0;
  for (let i = 0; i < 3; i++) {
    omax = Math.max(omax, Math.abs(Math.hypot(B[i * 3], B[i * 3 + 1], B[i * 3 + 2]) - 1));
    for (let j = i + 1; j < 3; j++) {
      omax = Math.max(omax, Math.abs(B[i * 3] * B[j * 3] + B[i * 3 + 1] * B[j * 3 + 1]
        + B[i * 3 + 2] * B[j * 3 + 2]));
    }
  }
  ok(omax < 1e-5, `PCA 基底は直交正規 (誤差 ${omax.toExponential(1)})`);
  const det = B[0] * (B[4] * B[8] - B[5] * B[7]) - B[1] * (B[3] * B[8] - B[5] * B[6])
    + B[2] * (B[3] * B[7] - B[4] * B[6]);
  ok(Math.abs(det - 1) < 1e-5, `右手系 (det = ${det.toFixed(6)})`);
  const d0 = Math.abs(B[0] * ca + B[1] * sa);
  ok(d0 > 0.999, `第 1 軸が長軸（30 度方向）を向く (|cos| = ${d0.toFixed(5)})`);
  ok(B[0] > 0, '符号が固定される（絶対値最大の成分が正）');
  ok(Math.abs(B[8]) > 0.999, `第 3 軸が最短軸 Z を向く (${B[8].toFixed(5)})`);
  const B1 = tp.basis().slice();
  tp.setFromMask(mesh, { basis: 'pca' });
  ok(bitEqual(B1, tp.basis(), 9), '呼び直しても同じ基底（軸がちらつかない）');

  tp.setFromMask(mesh, {});
  const Bw = tp.basis();
  ok(Bw[0] === 1 && Bw[4] === 1 && Bw[8] === 1 && Bw[1] === 0 && Bw[5] === 0, '既定はワールド軸');

  // PCA 基底での移動は長軸方向へ動く
  tp.setFromMask(mesh, { basis: 'pca' });
  before = snap(mesh);
  F = frameOf(tp);
  const ax = ax3(F, 0);
  const m0 = axisRay(F, 0, 0.5), m1 = axisRay(F, 0, 1.5);
  tp.beginDrag(mesh, { kind: 'move', axis: 0 }, m0.o, m0.d);
  r = tp.updateDrag(mesh, m1.o, m1.d);
  ok(Math.abs(r.offset - 1) < 1e-5, `ローカル軸に沿って 1.0 動く (${r.offset.toFixed(6)})`);
  let pmax = 0;
  for (let v = 0; v < mesh.nv; v++) {
    const i = v * 3;
    for (let k = 0; k < 3; k++) {
      pmax = Math.max(pmax, Math.abs(mesh.positions[i + k] - (before[i + k] + ax[k] * r.offset)));
    }
  }
  ok(pmax < 1e-5, `変位が第 1 主成分と平行 (誤差 ${pmax.toExponential(1)})`);
  tp.endDrag(mesh);
  checkMesh(mesh, 'PCA 基底で移動後');
}

// ---------------------------------------------------------------------------
head('退化した入力');
{
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  ok(tp.beginDrag(mesh, null, [0, 0, 5], [0, 0, -1]) === false, 'hit が null なら掴めない');
  ok(tp.beginDrag(mesh, { kind: 'zoom', axis: 0 }, [0, 0, 5], [0, 0, -1]) === false,
    '知らない kind は掴めない');
  ok(tp.beginDrag(mesh, { kind: 'move', axis: 0 }, [0, 0, 5], [0, 0, 0]) === false,
    'ゼロ方向のレイは弾く');
  before = snap(mesh);
  r = tp.updateDrag(mesh, [0, 0, 5], [0, 0, -1]);
  ok(r.changed === 0, 'ドラッグしていなければ updateDrag は何もしない');

  // 軸を真正面から覗く（軸とレイが平行）→ 形が飛ばない
  tp.beginDrag(mesh, { kind: 'move', axis: 2 }, [0, 0, 5], [0, 0, -1]);
  tp.updateDrag(mesh, [0, 0, 4], [0, 0, -1]);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), '軸と平行なレイでは動かさない');
  tp.cancelDrag(mesh);

  // 回転面をエッジオンで見る → NaN を出さない
  const piv = tp.pivot();
  tp.beginDrag(mesh, { kind: 'rotate', axis: 1 }, [piv[0], piv[1], piv[2] + 5], [0, 0, -1]);
  tp.updateDrag(mesh, [piv[0] + 0.1, piv[1], piv[2] + 5], [0, 0, -1]);
  let nan = 0;
  for (let i = 0; i < mesh.nv * 3; i++) if (!Number.isFinite(mesh.positions[i])) nan++;
  ok(nan === 0, `エッジオンの回転面でも NaN が出ない (${nan})`);
  tp.cancelDrag(mesh);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), 'その後も厳密に元の形');

  // ピボットを掴んだ（半径ゼロの）スケールは倍率を決められないので何もしない
  tp.beginDrag(mesh, { kind: 'uniform', axis: -1 }, [piv[0], piv[1], piv[2] + 5], [0, 0, -1]);
  r = tp.updateDrag(mesh, [piv[0] + 1, piv[1], piv[2] + 5], [0, 0, -1]);
  ok(r.changed === 0 && bitEqual(before, mesh.positions, mesh.nv * 3),
    '基準半径ゼロのスケールは何もしない');
  tp.cancelDrag(mesh);
  checkMesh(mesh, '退化入力後');

  // 死んだ頂点は領域に入らない
  mesh.removeVertex(mesh.nv - 1);
  const n0 = mesh.liveVerts;
  tp.setFromMask(mesh);
  ok(tp.stats().verts === n0, `死んだスロットを拾わない (${tp.stats().verts}/${n0})`);
}

// ---------------------------------------------------------------------------
head('大きめのメッシュで一通り');
{
  mesh = sphere(true);
  for (let v = 0; v < mesh.nv; v++) {
    mesh.mask[v] = Math.min(1, Math.max(0, mesh.positions[v * 3 + 1] * 2));
  }
  tp = new Transpose();
  ok(tp.setFromMask(mesh, { basis: 'pca' }) === true, `${mesh.liveVerts} 頂点で領域が取れる`);
  before = snap(mesh);
  const t0 = Date.now();
  const seq = [['move', 0], ['move', 1], ['rotate', 2], ['scale', 1], ['uniform', -1]];
  for (const [kind, axis] of seq) {
    F = frameOf(tp);
    let g0, g1;
    if (kind === 'rotate') { g0 = ringRay(F, axis, 0); g1 = ringRay(F, axis, 0.4); }
    else if (kind === 'move') { g0 = axisRay(F, axis, 0.3); g1 = axisRay(F, axis, 0.5); }
    else if (kind === 'scale') { g0 = planeRay(F, axis, 0.6); g1 = planeRay(F, axis, 0.7); }
    else { g0 = planeRay(F, 0, 0.6); g1 = planeRay(F, 0, 0.8); }
    ok(tp.beginDrag(mesh, { kind, axis }, g0.o, g0.d) === true, `${kind}/${axis} を掴む`);
    tp.updateDrag(mesh, g1.o, g1.d);
    const st = tp.endDrag(mesh);
    ok(st.changed > 0, `${kind}/${axis} で ${st.changed} 頂点が動いた`);
  }
  console.log(`       5 種のドラッグで ${Date.now() - t0} ms`);
  let movedMasked = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (mesh.mask[v] < 1) continue;
    const i = v * 3;
    if (mesh.positions[i] !== before[i] || mesh.positions[i + 1] !== before[i + 1]
      || mesh.positions[i + 2] !== before[i + 2]) movedMasked++;
  }
  ok(movedMasked === 0, `5 種のドラッグを通して mask=1 は不動 (${movedMasked})`);
  checkMesh(mesh, '連続ドラッグ後');
}

// ---------------------------------------------------------------------------
// 回転行列は軸ごとに別の成分を使うので、1 軸だけ検算しても足りない
// （軸 1 だけだと歪んだ行列でも通ってしまう）。3 軸ぜんぶ参照実装と突き合わせる。
head('回転: 3 軸すべてを参照実装と照合');
for (let axis = 0; axis < 3; axis++) {
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  F = frameOf(tp);
  const piv = F.p, n = ax3(F, axis);
  const a0 = ringRay(F, axis, 0), a1 = ringRay(F, axis, 0.8);
  tp.beginDrag(mesh, { kind: 'rotate', axis }, a0.o, a0.d);
  r = tp.updateDrag(mesh, a1.o, a1.d);
  ok(Math.abs(r.degrees - 0.8 * 180 / Math.PI) < 1e-3,
    `軸 ${axis}: リング上の角度がそのまま回転量 (${r.degrees.toFixed(4)})`);
  let pmax = 0, dmax = 0;
  for (let v = 0; v < mesh.nv; v++) {
    const i = v * 3;
    const o = [before[i] - piv[0], before[i + 1] - piv[1], before[i + 2] - piv[2]];
    const q = [mesh.positions[i] - piv[0], mesh.positions[i + 1] - piv[1], mesh.positions[i + 2] - piv[2]];
    const e = rot(o, n, 0.8);
    pmax = Math.max(pmax, Math.abs(e[0] - q[0]), Math.abs(e[1] - q[1]), Math.abs(e[2] - q[2]));
    dmax = Math.max(dmax, Math.abs(Math.hypot(...o) - Math.hypot(...q)));
  }
  ok(pmax < 1e-5, `軸 ${axis}: 参照ロドリゲス回転と一致 (${pmax.toExponential(1)})`);
  ok(dmax < 1e-5, `軸 ${axis}: ピボットからの距離が保たれる (${dmax.toExponential(1)})`);
  // 回転は剛体なので、任意の 2 点間の距離も保たれる（行列にせん断が入れば崩れる）
  let lmax = 0;
  for (let v = 0; v + 7 < mesh.nv; v += 7) {
    const i = v * 3, j = (v + 7) * 3;
    const l0 = Math.hypot(before[i] - before[j], before[i + 1] - before[j + 1], before[i + 2] - before[j + 2]);
    const l1 = Math.hypot(mesh.positions[i] - mesh.positions[j],
      mesh.positions[i + 1] - mesh.positions[j + 1], mesh.positions[i + 2] - mesh.positions[j + 2]);
    lmax = Math.max(lmax, Math.abs(l0 - l1));
  }
  ok(lmax < 1e-5, `軸 ${axis}: 頂点どうしの距離も保たれる（せん断が無い） (${lmax.toExponential(1)})`);
  tp.endDrag(mesh);
}

// ---------------------------------------------------------------------------
head('回転: 逆向きに 1 回転を超える');
{
  mesh = octahedron();
  tp = new Transpose();
  tp.setFromMask(mesh);
  F = frameOf(tp);
  const a0 = ringRay(F, 1, 0);
  tp.beginDrag(mesh, { kind: 'rotate', axis: 1 }, a0.o, a0.d);
  // -170 度 → -190 度。atan2 が +170 度側へ飛ぶので、差分の畳み込みが
  // 「+π を超えた側」でも効いていないと -170 度に張り付く。
  for (const [deg, want] of [[-30, -30], [-170, -170], [-190, -190], [-350, -350]]) {
    const g = ringRay(F, 1, Math.PI * deg / 180);
    r = tp.updateDrag(mesh, g.o, g.d);
    ok(Math.abs(r.degrees - want) < 1e-3, `${deg} 度まで連続して戻る (${r.degrees.toFixed(3)})`);
  }
  tp.cancelDrag(mesh);
}

// ---------------------------------------------------------------------------
// markVert を手で展開しているので、GPU 転送の dirty 範囲が本物と一致するかを見る。
// ここが抜けると「計算は合っているのに画面が更新されない」になる。
head('GPU の dirty 管理');
{
  // 変更を検出して dirty 範囲と突き合わせる。法線の再計算は自前で dirty を立てて
  // しまうので、位置ループ側の markVert 展開を見るには normals: false が必要。
  const checkDirty = (m, ref, label) => {
    let lo = Infinity, hi = -1, missBlock = 0, moved = 0;
    for (let v = 0; v < m.nv; v++) {
      const i = v * 3;
      if (m.positions[i] === ref[i] && m.positions[i + 1] === ref[i + 1]
        && m.positions[i + 2] === ref[i + 2]) continue;
      moved++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      if (m.vBlocks[v >> DIRTY_SHIFT] !== 1) missBlock++;
    }
    ok(moved > 0, `${label}: 動いた頂点がある (${moved})`);
    ok(m.vDirtyMin <= lo && m.vDirtyMax >= hi,
      `${label}: dirty 範囲が動いた頂点を覆う ([${m.vDirtyMin},${m.vDirtyMax}] ⊇ [${lo},${hi}])`);
    ok(missBlock === 0, `${label}: 動いた頂点のブロックが立っている (漏れ ${missBlock})`);
    ok(m.vBlockMin <= (lo >> DIRTY_SHIFT) && m.vBlockMax >= (hi >> DIRTY_SHIFT),
      `${label}: ブロック範囲も覆っている`);
  };

  // 移動（_applyTranslate）
  mesh = sphere();
  for (let v = 0; v < mesh.nv; v++) mesh.mask[v] = mesh.positions[v * 3] > 0 ? 1 : 0;
  tp = new Transpose();
  tp.setFromMask(mesh);
  F = frameOf(tp);
  let g0 = axisRay(F, 1, 0), g1 = axisRay(F, 1, 0.4);
  tp.beginDrag(mesh, { kind: 'move', axis: 1 }, g0.o, g0.d);
  before = snap(mesh);
  mesh.clearDirty();
  tp.updateDrag(mesh, g1.o, g1.d, { normals: false });
  checkDirty(mesh, before, '移動');
  tp.cancelDrag(mesh);

  // 回転 / スケール（_applyLinear）
  for (const kind of ['rotate', 'scale']) {
    mesh = sphere();
    for (let v = 0; v < mesh.nv; v++) mesh.mask[v] = mesh.positions[v * 3] > 0 ? 1 : 0;
    tp = new Transpose();
    tp.setFromMask(mesh);
    F = frameOf(tp);
    g0 = kind === 'rotate' ? ringRay(F, 2, 0) : planeRay(F, 2, 0.5);
    g1 = kind === 'rotate' ? ringRay(F, 2, 0.5) : planeRay(F, 2, 0.9);
    tp.beginDrag(mesh, { kind, axis: 2 }, g0.o, g0.d);
    before = snap(mesh);
    mesh.clearDirty();
    tp.updateDrag(mesh, g1.o, g1.d, { normals: false });
    checkDirty(mesh, before, kind);

    // cancelDrag も戻した頂点を dirty にしないと画面に古い形が残る
    const bent = snap(mesh);
    mesh.clearDirty();
    tp.cancelDrag(mesh);
    checkDirty(mesh, bent, kind + ' の取り消し');
  }
}

// ---------------------------------------------------------------------------
// マスクで固定した側の頂点は動かないが、隣が動くので法線は変わる。法線を直す集合に
// 領域の 1-ring が入っていないと、境界に陰影の継ぎ目が残る。
head('マスク境界の法線も直る');
{
  mesh = sphere();
  for (let v = 0; v < mesh.nv; v++) mesh.mask[v] = mesh.positions[v * 3 + 1] > 0 ? 1 : 0;
  tp = new Transpose();
  tp.setFromMask(mesh);
  F = frameOf(tp);
  const g0 = ringRay(F, 0, 0), g1 = ringRay(F, 0, 0.5);
  tp.beginDrag(mesh, { kind: 'rotate', axis: 0 }, g0.o, g0.d);
  tp.updateDrag(mesh, g1.o, g1.d);
  const got = mesh.normals.slice(0, mesh.nv * 3);
  mesh.computeAllNormals();
  let nmax = 0, frozenMax = 0;
  for (let v = 0; v < mesh.nv; v++) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(got[v * 3 + k] - mesh.normals[v * 3 + k]);
      nmax = Math.max(nmax, d);
      if (mesh.mask[v] >= 1) frozenMax = Math.max(frozenMax, d);
    }
  }
  ok(nmax < 1e-6, `法線が全体再計算と一致 (最大差 ${nmax.toExponential(1)})`);
  ok(frozenMax < 1e-6, `固定側（mask=1）の法線も直っている (最大差 ${frozenMax.toExponential(1)})`);
  tp.endDrag(mesh);
}

// ---------------------------------------------------------------------------
head('交点が背後に出るレイは何もしない');
{
  // 「レイの向きだけ反転」では直線が同じなので判定にならない。ドラッグ開始とは
  // 違う場所を指す直線を、交点が原点の後ろに来る向きで渡す。交点の前後を見て
  // いなければ、カメラが向いていない方向のハンドルで形が動いてしまう。
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  F = frameOf(tp);
  for (const kind of ['rotate', 'scale', 'uniform']) {
    const axis = kind === 'uniform' ? -1 : 1;
    const g0 = kind === 'rotate' ? ringRay(F, 1, 0) : planeRay(F, 1, 0.5);
    ok(tp.beginDrag(mesh, { kind, axis }, g0.o, g0.d) === true, `${kind} を掴む`);
    before = snap(mesh);
    const g1 = kind === 'rotate' ? ringRay(F, 1, 1.2) : planeRay(F, 1, 1.4);
    r = tp.updateDrag(mesh, g1.o, [-g1.d[0], -g1.d[1], -g1.d[2]]);
    ok(bitEqual(before, mesh.positions, mesh.nv * 3),
      `${kind}: 交点が背後のレイでは形が変わらない`);
    ok(r.changed === 0 && Math.abs(r.degrees) < 1e-12 && Math.abs(r.factor - 1) < 1e-12,
      `${kind}: 変換量もゼロのまま (deg=${r.degrees} f=${r.factor})`);
    // 同じ直線を正しい向きで渡せば、ちゃんと効く（上の no-op が「常に何もしない」
    // だけの実装で通ってしまわないことの確認）
    r = tp.updateDrag(mesh, g1.o, g1.d);
    ok(!bitEqual(before, mesh.positions, mesh.nv * 3), `${kind}: 正しい向きなら効く`);
    let nan = 0;
    for (let i = 0; i < mesh.nv * 3; i++) if (!Number.isFinite(mesh.positions[i])) nan++;
    ok(nan === 0, `${kind}: NaN が出ない`);
    tp.cancelDrag(mesh);
  }
}

// ---------------------------------------------------------------------------
// 移動のスナップ幅だけは世界の寸法が分からないので、ギズモの大きさに対する比で
// 決めている（= 直前に handles / hitTest へ渡した scale に依存する）。
head('移動のスナップ');
{
  mesh = octahedron();
  tp = new Transpose();
  tp.setFromMask(mesh);
  tp.handles(2);                    // スナップ幅 = 0.1 × 2 = 0.2
  F = frameOf(tp);
  const g0 = axisRay(F, 0, 0), g1 = axisRay(F, 0, 0.34);
  tp.beginDrag(mesh, { kind: 'move', axis: 0 }, g0.o, g0.d);
  before = snap(mesh);
  r = tp.updateDrag(mesh, g1.o, g1.d, { snap: true });
  ok(Math.abs(r.offset - 0.4) < 1e-9, `0.34 は 0.2 刻みで 0.4 へ (${r.offset})`);
  ok(Math.abs(mesh.positions[0] - (before[0] + 0.4)) < 1e-6, '形もスナップ後の量で動く');
  r = tp.updateDrag(mesh, g1.o, g1.d);
  ok(Math.abs(r.offset - 0.34) < 1e-6, `スナップ無しなら 0.34 のまま (${r.offset.toFixed(6)})`);
  tp.handles(1);                    // スナップ幅 = 0.1
  r = tp.updateDrag(mesh, g1.o, g1.d, { snap: true });
  ok(Math.abs(r.offset - 0.3) < 1e-9, `ギズモを小さくすると刻みも細かくなる (${r.offset})`);
  tp.cancelDrag(mesh);
}

// ---------------------------------------------------------------------------
head('退化した掴み方から復帰しても形が飛ばない');
{
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  const p = tp.pivot();
  // 軸 2 に平行なレイで掴む（軸上の位置が決まらない）→ その後 横から見る
  ok(tp.beginDrag(mesh, { kind: 'move', axis: 2 }, [p[0] + 0.3, p[1], p[2] + 5], [0, 0, -1]) === true,
    '軸を正面から覗いた状態でも掴める');
  r = tp.updateDrag(mesh, [p[0] + 5, p[1], p[2] + 0.1], [-1, 0, 0]);
  ok(Math.abs(r.offset) < 1e-9, `最初の有効フレームを基準にする（跳ばない） (offset=${r.offset})`);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), '形はまだ元のまま');
  // そこから更に動かしたぶんだけが変位になる
  r = tp.updateDrag(mesh, [p[0] + 5, p[1], p[2] + 0.6], [-1, 0, 0]);
  ok(Math.abs(r.offset - 0.5) < 1e-6, `基準からの差だけ動く (${r.offset.toFixed(6)})`);
  tp.cancelDrag(mesh);
}

// ---------------------------------------------------------------------------
head('normals: false のまま setFromMask を呼んでも法線が残らない');
{
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  F = frameOf(tp);
  const a0 = ringRay(F, 0, 0), a1 = ringRay(F, 0, 0.9);
  tp.beginDrag(mesh, { kind: 'rotate', axis: 0 }, a0.o, a0.d);
  tp.updateDrag(mesh, a1.o, a1.d, { normals: false });
  tp.setFromMask(mesh);          // endDrag を挟まずに領域を作り直す
  const got = mesh.normals.slice(0, mesh.nv * 3);
  mesh.computeAllNormals();
  let nmax = 0;
  for (let i = 0; i < mesh.nv * 3; i++) nmax = Math.max(nmax, Math.abs(got[i] - mesh.normals[i]));
  ok(nmax < 1e-6, `後回しの法線が setFromMask で清算される (最大差 ${nmax.toExponential(1)})`);
  ok(tp.stats().dragging === null, 'setFromMask はドラッグ状態を捨てる');
}

// ---------------------------------------------------------------------------
head('トポロジが変わったら領域を捨てる');
{
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  ok(tp.validate(mesh) === true, '同じトポロジなら有効');
  before = snap(mesh);
  mesh.removeTriangle(0);                   // topoVersion が進む
  ok(tp.validate(mesh) === false, 'トポロジが変わったら無効');
  ok(tp.active === false, '無効化で非アクティブになる');
  tp.setFromMask(mesh);
  mesh.removeTriangle(1);
  ok(tp.beginDrag(mesh, { kind: 'move', axis: 0 }, [5, 0, 0], [-1, 0, 0]) === false,
    '古い領域では beginDrag が失敗する');
  r = tp.updateDrag(mesh, [5, 0, 0.5], [-1, 0, 0]);
  ok(r.changed === 0 && bitEqual(before, mesh.positions, mesh.nv * 3),
    '掴めていないので 1 頂点も動かない');
}

// ---------------------------------------------------------------------------
// mask は 0..1 の約束だが、外から範囲外の値が入っていても weight は 0..1 に
// 収まっていなければならない（負の weight は逆方向に動き、1 超えは伸びすぎる）。
head('マスクが 0..1 の外にあっても規約どおり');
{
  mesh = octahedron();
  mesh.mask.fill(0, 0, mesh.nv);
  mesh.mask[0] = -0.5;      // clamp → 0 → weight 1（完全に自由）
  mesh.mask[1] = 1.7;       // clamp → 1 → weight 0（完全に固定）
  tp = new Transpose();
  ok(tp.setFromMask(mesh) === true, '範囲外マスクでも領域が取れる');
  ok(tp.stats().verts === 5, `mask > 1 は領域に入らない (${tp.stats().verts})`);
  before = snap(mesh);
  F = frameOf(tp);
  const g0 = axisRay(F, 2, 0), g1 = axisRay(F, 2, 0.7);
  tp.beginDrag(mesh, { kind: 'move', axis: 2 }, g0.o, g0.d);
  r = tp.updateDrag(mesh, g1.o, g1.d);
  ok(Math.abs(mesh.positions[2] - (before[2] + r.offset)) < 1e-6,
    `mask < 0 は weight 1 として動く (${(mesh.positions[2] - before[2]).toFixed(4)} / ${r.offset.toFixed(4)})`);
  ok(mesh.positions[3] === before[3] && mesh.positions[4] === before[4]
    && mesh.positions[5] === before[5], 'mask > 1 は 1 ビットも動かない');
  tp.cancelDrag(mesh);
}

// ---------------------------------------------------------------------------
head('平面スケール: 通り越しても裏返らない / 倍率スナップ');
{
  mesh = octahedron();
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  F = frameOf(tp);
  const piv = F.p;
  const s0 = planeRay(F, 0, 0.5);
  tp.beginDrag(mesh, { kind: 'scale', axis: 0 }, s0.o, s0.d);
  // 掴んだ向きと逆側（ピボットの反対）へ引く。距離で測っていると倍率が正へ
  // 折り返して、面が裏返ったのに気付けない。
  const sNeg = planeRay(F, 0, -0.5);
  r = tp.updateDrag(mesh, sNeg.o, sNeg.d);
  ok(r.factor >= 0.01 && r.factor < 0.011, `符号付きで測るので下限で止まる (${r.factor})`);
  let flipped = 0;
  for (let v = 0; v < mesh.nv; v++) {
    const i = v * 3;
    for (let k = 1; k < 3; k++) {   // 面内は軸 1,2
      const a = before[i + k] - piv[k], b = mesh.positions[i + k] - piv[k];
      if (a * b < -1e-12) flipped++;
    }
  }
  ok(flipped === 0, `面内の向きが反転しない (${flipped})`);
  // 倍率スナップの刻みは 0.1
  const s16 = planeRay(F, 0, 0.5 * 1.16);
  r = tp.updateDrag(mesh, s16.o, s16.d, { snap: true });
  ok(Math.abs(r.factor - 1.2) < 1e-9, `1.16 は 0.1 刻みで 1.2 へ (${r.factor})`);
  const s13 = planeRay(F, 0, 0.5 * 1.34);
  r = tp.updateDrag(mesh, s13.o, s13.d, { snap: true });
  ok(Math.abs(r.factor - 1.3) < 1e-9, `1.34 は 1.3 へ (${r.factor})`);
  tp.cancelDrag(mesh);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), '取り消しで厳密に元へ');
}

// ---------------------------------------------------------------------------
head('endDrag: 元の位置に戻していれば changed は 0');
{
  mesh = sphere();
  tp = new Transpose();
  tp.setFromMask(mesh);
  before = snap(mesh);
  F = frameOf(tp);
  const g0 = axisRay(F, 1, 0.2), g1 = axisRay(F, 1, 1.3);
  tp.beginDrag(mesh, { kind: 'move', axis: 1 }, g0.o, g0.d);
  r = tp.updateDrag(mesh, g1.o, g1.d);
  ok(r.changed > 0, `途中では動いている (${r.changed})`);
  tp.updateDrag(mesh, g0.o, g0.d);          // 開始レイに戻す
  const st = tp.endDrag(mesh);
  ok(bitEqual(before, mesh.positions, mesh.nv * 3), '形は開始時と厳密に同じ');
  ok(st.changed === 0, `endDrag の changed は「本当に変わった頂点数」 (${st.changed})`);
  ok(st.kind === 'move', 'kind は返る');
}

// ---------------------------------------------------------------------------
head('PCA: 固有値が縮退していても基底が壊れない');
{
  const cases = [
    ['球（3 重縮退）', 1, 1, 1],
    ['回転体（2 重縮退）', 3, 1, 1],
    ['円盤（2 重縮退）', 1, 1, 0.2],
  ];
  for (const [label, sx, sy, sz] of cases) {
    const g = PRIMITIVES.sphere();
    const pos = g.positions.slice();
    for (let v = 0; v < pos.length / 3; v++) {
      pos[v * 3] *= sx; pos[v * 3 + 1] *= sy; pos[v * 3 + 2] *= sz;
    }
    mesh = new SculptMesh();
    mesh.setGeometry(pos, g.indices);
    tp = new Transpose();
    tp.setFromMask(mesh, { basis: 'pca' });
    const B = tp.basis();
    let omax = 0, nan = 0;
    for (let i = 0; i < 9; i++) if (!Number.isFinite(B[i])) nan++;
    for (let i = 0; i < 3; i++) {
      omax = Math.max(omax, Math.abs(Math.hypot(B[i * 3], B[i * 3 + 1], B[i * 3 + 2]) - 1));
      for (let j = i + 1; j < 3; j++) {
        omax = Math.max(omax, Math.abs(B[i * 3] * B[j * 3] + B[i * 3 + 1] * B[j * 3 + 1]
          + B[i * 3 + 2] * B[j * 3 + 2]));
      }
    }
    const det = B[0] * (B[4] * B[8] - B[5] * B[7]) - B[1] * (B[3] * B[8] - B[5] * B[6])
      + B[2] * (B[3] * B[7] - B[4] * B[6]);
    ok(nan === 0, `${label}: 基底に NaN が無い`);
    ok(omax < 1e-5, `${label}: 直交正規 (誤差 ${omax.toExponential(1)})`);
    ok(Math.abs(det - 1) < 1e-5, `${label}: 右手系 (det=${det.toFixed(6)})`);
    // 縮退していても回転は剛体のまま（基底が左手系だと向きが食い違う）
    F = frameOf(tp);
    const piv = F.p, n = ax3(F, 2);
    before = snap(mesh);
    const a0 = ringRay(F, 2, 0), a1 = ringRay(F, 2, 0.6);
    tp.beginDrag(mesh, { kind: 'rotate', axis: 2 }, a0.o, a0.d);
    tp.updateDrag(mesh, a1.o, a1.d);
    let pmax = 0;
    for (let v = 0; v < mesh.nv; v++) {
      const i = v * 3;
      const o = [before[i] - piv[0], before[i + 1] - piv[1], before[i + 2] - piv[2]];
      const e = rot(o, n, 0.6);
      for (let k = 0; k < 3; k++) pmax = Math.max(pmax, Math.abs(e[k] - (mesh.positions[i + k] - piv[k])));
    }
    ok(pmax < 1e-5, `${label}: 軸まわりの回転が参照と一致 (${pmax.toExponential(1)})`);
    tp.endDrag(mesh);
  }
}

// ---------------------------------------------------------------------------
head('threshold と孤立頂点');
{
  mesh = octahedron();
  // weight = 1e-5（既定の threshold 1e-4 より小さい）→ 領域に入らない
  mesh.mask.fill(1 - 1e-5, 0, mesh.nv);
  tp = new Transpose();
  ok(tp.setFromMask(mesh) === false, '既定 threshold 以下の weight は領域にしない');
  ok(tp.setFromMask(mesh, { threshold: 1e-7 }) === true, 'threshold を下げれば拾う');
  ok(tp.stats().verts === 6, `全頂点が入る (${tp.stats().verts})`);
  {
    let wexp = 0;
    for (let v = 0; v < mesh.nv; v++) wexp += 1 - mesh.mask[v];
    ok(Math.abs(tp.stats().weightSum - wexp) < 1e-9,
      `weightSum が weight の和 (${tp.stats().weightSum.toExponential(4)})`);
  }

  // 三角形を持たない生存頂点（ringCount = 0）が領域に混ざっても壊れない
  mesh = octahedron();
  const iso = mesh.addVertex(2, 2, 2);
  tp = new Transpose();
  tp.setFromMask(mesh);
  ok(tp.stats().verts === 7, `孤立頂点も領域に入る (${tp.stats().verts})`);
  before = snap(mesh);
  F = frameOf(tp);
  const j0 = axisRay(F, 0, 0.1), j1 = axisRay(F, 0, 0.6);
  ok(tp.beginDrag(mesh, { kind: 'move', axis: 0 }, j0.o, j0.d) === true, '孤立頂点入りで掴める');
  r = tp.updateDrag(mesh, j1.o, j1.d);
  ok(Math.abs(r.offset - 0.5) < 1e-6, `オフセット 0.5 (${r.offset.toFixed(6)})`);
  ok(r.changed === 7, `孤立頂点も動く (${r.changed})`);
  let nan = 0;
  for (let i = 0; i < mesh.nv * 3; i++) {
    if (!Number.isFinite(mesh.positions[i]) || !Number.isFinite(mesh.normals[i])) nan++;
  }
  ok(nan === 0, `孤立頂点があっても NaN が出ない (${nan})`);
  ok(Math.abs(mesh.positions[iso * 3] - (before[iso * 3] + r.offset)) < 1e-6, '孤立頂点も同じ変位');
  tp.endDrag(mesh);
}

// ---------------------------------------------------------------------------
head('API の細かい約束');
{
  mesh = octahedron();
  tp = new Transpose();
  tp.setFromMask(mesh);
  // hitTest の scale 既定値は直前に handles / hitTest で使った値
  tp.handles(2.5);
  const hA = tp.hitTest([2, 0, 3], [0, 0, -1], 0.03);
  ok(hA !== null && hA.kind === 'move' && hA.axis === 0,
    `scale 省略時は前回の handles の大きさを使う (${hA ? hA.kind : 'null'})`);
  ok(tp.hitTest([2, 0, 3], [0, 0, -1], 0.03, 1) === null, 'scale=1 なら軸の外なので当たらない');
  // pivot は新しい配列 / basis は内部配列
  const p1 = tp.pivot(), p2 = tp.pivot();
  ok(p1 !== p2 && p1[0] === p2[0], 'pivot は毎回新しい配列');
  ok(tp.basis() === tp.basis(), 'basis は内部配列をそのまま返す');
  ok(tp.basis().length === 9 && tp.basis() instanceof Float32Array, 'basis は Float32Array(9)');
  // updateDrag の戻り値は使い回し
  F = frameOf(tp);
  const g0 = axisRay(F, 0, 0.2), g1 = axisRay(F, 0, 0.5);
  tp.beginDrag(mesh, { kind: 'move', axis: 0 }, g0.o, g0.d);
  const r1 = tp.updateDrag(mesh, g1.o, g1.d);
  const r2 = tp.updateDrag(mesh, g1.o, g1.d);
  ok(r1 === r2, 'updateDrag は同じオブジェクトを返す（毎フレームのゴミを作らない）');
  ok(r1.kind === 'move' && r1.axis === 0, '戻り値に kind / axis が入る');
  const e = tp.endDrag(mesh);
  ok(e.kind === 'move' && e.changed > 0, 'endDrag は kind と変更頂点数を返す');
  ok(tp.endDrag(mesh).kind === null, '2 度目の endDrag は何もしない');
  ok(tp.stats().dragging === null, 'endDrag 後は dragging が null');
  // clear のあとは配列も含めて何も返さない
  tp.clear();
  ok(tp.handles(1).length === 0 && tp.hitTest([0, 0, 5], [0, 0, -1], 0.1, 1) === null,
    'clear 後は handles / hitTest が空');
  ok(tp.beginDrag(mesh, { kind: 'move', axis: 0 }, g0.o, g0.d) === false, 'clear 後は掴めない');
  ok(tp.stats().verts === 0 && tp.stats().active === false, 'clear 後の stats');
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
