// clip.js（クリップ / トリム / スライス / ミラー溶接）の検証。
// DOM / WebGPU には触らないので node で単体実行できる。
import { SculptMesh, PRIMITIVES, icosphere } from '../js/mesh.js';
import {
  clipPlane, trimPlane, slicePlane, mirrorWeld,
  planeFromScreenLine, planeFromPointNormal, planeFromAxis, flipPlane, planeDistance,
  axisIndex,
} from '../js/clip.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

const KEY = 8388608;

// core.test.mjs の validate と同じ検査。辺のキーは文字列だと数十万面で重いので
// 数値キー（a * 2^23 + b）にしてある。
function validate(mesh, { closed = true, label = '', genus = 0, reportChiOnly = false } = {}) {
  const errs = [];
  const T = mesh.tris;

  let liveT = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    liveT++;
    if (a === b || b === c || c === a) errs.push(`tri ${t} degenerate (${a},${b},${c})`);
    for (const v of [a, b, c]) {
      if (v < 0 || v >= mesh.nv) errs.push(`tri ${t} vert ${v} out of range`);
      else if (!mesh.vAlive[v]) errs.push(`tri ${t} refs dead vert ${v}`);
    }
  }
  if (liveT !== mesh.liveTris) errs.push(`liveTris mismatch: counted ${liveT} stored ${mesh.liveTris}`);

  let liveV = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) liveV++;
  if (liveV !== mesh.liveVerts) errs.push(`liveVerts mismatch: counted ${liveV} stored ${mesh.liveVerts}`);

  // ring 整合性
  for (let v = 0; v < mesh.nv; v++) {
    const r = mesh.ringArray(v);
    if (!mesh.vAlive[v]) { if (r && r.length) errs.push(`dead vert ${v} has ring`); continue; }
    if (!r) { errs.push(`alive vert ${v} has null ring`); continue; }
    const seen = new Set();
    for (const t of r) {
      if (seen.has(t)) errs.push(`vert ${v} ring has dup tri ${t}`);
      seen.add(t);
      const i = t * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) errs.push(`vert ${v} ring has dead tri ${t}`);
      if (T[i] !== v && T[i + 1] !== v && T[i + 2] !== v) errs.push(`vert ${v} ring tri ${t} does not contain v`);
    }
  }
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    for (const v of [a, b, c]) {
      const r = mesh.ringArray(v);
      if (!r || r.indexOf(t) < 0) errs.push(`tri ${t} not in ring of ${v}`);
    }
  }

  // 多様体性（閉じたメッシュなら各辺 = 2 面）
  const em = new Map();
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, v0 = T[i], v1 = T[i + 1], v2 = T[i + 2];
    if (v0 === v1 && v1 === v2) continue;
    for (let e = 0; e < 3; e++) {
      const a = e === 0 ? v0 : (e === 1 ? v1 : v2);
      const b = e === 0 ? v1 : (e === 1 ? v2 : v0);
      const key = a < b ? a * KEY + b : b * KEY + a;
      em.set(key, (em.get(key) || 0) + 1);
    }
  }
  if (closed) {
    let bad = 0, boundary = 0;
    for (const [, n] of em) { if (n === 1) boundary++; else if (n !== 2) bad++; }
    if (bad) errs.push(`${bad} non-manifold edges`);
    if (boundary) errs.push(`${boundary} boundary edges (expected closed)`);
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

  if (closed) {
    const chi = mesh.liveVerts - em.size + mesh.liveTris;
    const want = 2 - 2 * genus;
    if (reportChiOnly) console.log(`       (χ = ${chi})`);
    else if (chi !== want) errs.push(`Euler characteristic = ${chi} (expected ${want})`);
  }

  if (errs.length) {
    failures++;
    console.log(`  FAIL ${label}: ${errs.length} problem(s)`);
    errs.slice(0, 8).forEach(e => console.log('      - ' + e));
  } else {
    console.log(`  ok   ${label}  V=${mesh.liveVerts} F=${mesh.liveTris}`);
  }
  return errs.length === 0;
}

// --- 追加の検査 ------------------------------------------------------------

/** 面の向きが一貫して外向きか（符号付き体積 > 0） */
function signedVolume(mesh) {
  const T = mesh.tris, P = mesh.positions;
  let vol = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3;
    const ia = T[i], ib = T[i + 1], ic = T[i + 2];
    if (ia === ib && ib === ic) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const cx = P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1];
    const cy = P[b + 2] * P[c] - P[b] * P[c + 2];
    const cz = P[b] * P[c + 1] - P[b + 1] * P[c];
    vol += (P[a] * cx + P[a + 1] * cy + P[a + 2] * cz) / 6;
  }
  return vol;
}

function surfaceArea(mesh) {
  const T = mesh.tris, P = mesh.positions;
  let s = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3;
    const ia = T[i], ib = T[i + 1], ic = T[i + 2];
    if (ia === ib && ib === ic) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    s += 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
  }
  return s;
}

function minTriArea(mesh) {
  const T = mesh.tris, P = mesh.positions;
  let mn = Infinity;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3;
    const ia = T[i], ib = T[i + 1], ic = T[i + 2];
    if (ia === ib && ib === ic) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const ar = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    if (ar < mn) mn = ar;
  }
  return mn === Infinity ? 0 : mn;
}

/** 同じ位置に 2 個以上ある生存頂点の数 */
function duplicateVerts(mesh, eps = 1e-6) {
  const seen = new Map();
  const P = mesh.positions;
  const inv = 1 / eps;
  let dup = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const i = v * 3;
    const key = `${Math.round(P[i] * inv)},${Math.round(P[i + 1] * inv)},${Math.round(P[i + 2] * inv)}`;
    if (seen.has(key)) dup++; else seen.set(key, v);
  }
  return dup;
}

function sphereMesh(subdiv = 4) {
  const g = icosphere(subdiv, 1);
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  return m;
}
/**
 * プリミティブを載せたメッシュ。torus / cylinder は元々内向き（符号付き体積が負）
 * なので、向きの検査を一律「体積 > 0」で書けるように巻き方向を揃えてから返す。
 */
function primMesh(name) {
  const g = PRIMITIVES[name]();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  if (signedVolume(m) < 0) {
    for (let t = 0; t < m.nt; t++) {
      const i = t * 3;
      if (m.tris[i] === m.tris[i + 1] && m.tris[i + 1] === m.tris[i + 2]) continue;
      const s = m.tris[i + 1]; m.tris[i + 1] = m.tris[i + 2]; m.tris[i + 2] = s;
    }
    m.rebuildRings();
    m.computeAllNormals();
  }
  return m;
}

/**
 * 「操作後の法線が、今のトポロジで計算し直したものと一致しているか」。
 * 部分更新（refreshAround）が拾い漏らしていると、切り口の周りだけ
 * 古い法線が残ってマットキャップに継ぎ目が出る。
 * 呼ぶと mesh.normals は正しい値に上書きされる（検査のあとに使ってよい）。
 *
 * 面法線の和がちょうど打ち消し合う頂点は除外する。ハードクリップは裏側を平面へ
 * 潰すので、球の手前と奥が同じ場所へ重なって面が折り返す領域ができる。そこでは
 * 法線が数学的に決まらず、mesh.js 側でも computeNormalsFor（古い値を残す）と
 * computeAllNormals（(0,1,0) を入れる）で答えが違う。比べても意味がない。
 * @returns {{worst: number, degen: number}}
 */
function normalDrift(mesh) {
  const P = mesh.positions, T = mesh.tris;
  const sum = new Float64Array(mesh.nv * 3);   // 正規化前の面法線の和
  const mag = new Float64Array(mesh.nv);       // 面法線の長さの合計（= 面積の 2 倍）
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, ia = T[i], ib = T[i + 1], ic = T[i + 2];
    if (ia === ib && ib === ic) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    for (const v of [ia, ib, ic]) {
      sum[v * 3] += nx; sum[v * 3 + 1] += ny; sum[v * 3 + 2] += nz;
      mag[v] += l;
    }
  }
  const before = mesh.normals.slice(0, mesh.nv * 3);
  mesh.computeAllNormals();
  let worst = 0, degen = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const i = v * 3;
    if (!(Math.hypot(sum[i], sum[i + 1], sum[i + 2]) > mag[v] * 1e-4)) { degen++; continue; }
    const d = Math.hypot(before[i] - mesh.normals[i], before[i + 1] - mesh.normals[i + 1],
      before[i + 2] - mesh.normals[i + 2]);
    if (d > worst) worst = d;
  }
  return { worst, degen };
}

/** 曲率も同じく取り残しを見る（部分平滑化のぶんだけ全体再計算とはずれる） */
function curvDrift(mesh) {
  const before = mesh.curv.slice(0, mesh.nv);
  mesh.computeAllCurvature();
  let worst = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const d = Math.abs(before[v] - mesh.curv[v]);
    if (d > worst) worst = d;
  }
  return worst;
}

/** 面で繋がった連結成分の数（孤立頂点は数えない） */
function componentCount(mesh) {
  const parent = new Int32Array(mesh.nv);
  for (let v = 0; v < mesh.nv; v++) parent[v] = v;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = mesh.tris[i], b = mesh.tris[i + 1], c = mesh.tris[i + 2];
    if (a === b && b === c) continue;
    parent[find(a)] = find(b);
    parent[find(b)] = find(c);
  }
  const roots = new Set();
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v] && mesh.ringCount[v] > 0) roots.add(find(v));
  return roots.size;
}

/** 座標が 1 成分も動いていないか（changed=false の意味を検算する） */
function positionsUnchanged(mesh, before) {
  for (let i = 0; i < mesh.nv * 3; i++) if (mesh.positions[i] !== before[i]) return false;
  return true;
}

/** 生存頂点に NaN / Infinity が 1 つもないか */
function countNonFinite(mesh) {
  let n = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(mesh.positions[v * 3 + k])) n++;
      if (!Number.isFinite(mesh.normals[v * 3 + k])) n++;
    }
    if (!Number.isFinite(mesh.curv[v]) || !Number.isFinite(mesh.mask[v])) n++;
  }
  return n;
}

/** 平面より裏にある頂点の最大深さ */
function maxBehind(mesh, plane) {
  let worst = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const i = v * 3;
    const s = planeDistance(plane, mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
    if (s < -worst) worst = -s;
  }
  return worst;
}

// ---------------------------------------------------------------------------
head('平面ヘルパ');
{
  // 画面右へドラッグ（視線 -Z）→ 上側が表
  const pl = planeFromScreenLine([0, 0, 0], [1, 0, 0], [0, 0, -1]);
  ok(pl !== null, 'ドラッグから平面が作れる');
  ok(Math.abs(Math.hypot(pl.n[0], pl.n[1], pl.n[2]) - 1) < 1e-6, '法線が正規化されている');
  ok(Math.abs(planeDistance(pl, 0, 0, 0)) < 1e-6 && Math.abs(planeDistance(pl, 1, 0, 0)) < 1e-6,
    'ドラッグの 2 点が平面上にある');
  ok(Math.abs(pl.n[2]) < 1e-6, '視線方向に平行（画面上では直線に見える）');
  ok(planeDistance(pl, 0, 1, 0) > 0.9, `ドラッグ方向の左（画面上）が表 (${planeDistance(pl, 0, 1, 0)})`);
  // 斜めのドラッグでも 2 点と視線を含む
  const p2 = planeFromScreenLine([0.2, -0.3, 1], [-0.5, 0.7, 1], [0.3, 0.1, -0.9]);
  ok(Math.abs(planeDistance(p2, 0.2, -0.3, 1)) < 1e-6 && Math.abs(planeDistance(p2, -0.5, 0.7, 1)) < 1e-6,
    '斜めドラッグでも 2 点が平面上');
  ok(Math.abs(p2.n[0] * 0.3 + p2.n[1] * 0.1 + p2.n[2] * -0.9) < 1e-6, '斜めでも視線に平行');
  ok(planeFromScreenLine([1, 2, 3], [1, 2, 3], [0, 0, -1]) === null, '長さ 0 のドラッグは null');
  ok(planeFromScreenLine([0, 0, 0], [0, 0, 2], [0, 0, -1]) === null, '視線と平行なドラッグは null');

  const ax = planeFromAxis('x', 0.3, 1);
  ok(Math.abs(planeDistance(ax, 1, 0, 0) - 0.7) < 1e-9, 'planeFromAxis の符号付き距離');
  ok(planeDistance(planeFromAxis('x', 0.3, -1), 1, 0, 0) < 0, 'keep=-1 で表裏が反転する');
  const fl = flipPlane(ax);
  ok(Math.abs(planeDistance(fl, 1, 0, 0) + 0.7) < 1e-9, 'flipPlane で符号が反転する');
  const pn = planeFromPointNormal([0, 2, 0], [0, 3, 0]);
  ok(Math.abs(planeDistance(pn, 0, 5, 0) - 3) < 1e-9, 'planeFromPointNormal が正規化される');
  ok(planeFromPointNormal([0, 0, 0], [0, 0, 0]) === null, '法線 0 は null');
}

// ---------------------------------------------------------------------------
head('clipPlane（ハードクリップ）');
{
  const m = sphereMesh(4);
  const plane = planeFromAxis('y', 0, 1);           // y > 0 を残す
  let behind = 0;
  for (let v = 0; v < m.nv; v++) if (m.positions[v * 3 + 1] < 0) behind++;

  const r = clipPlane(m, plane);
  ok(r.changed, 'クリップが実行される');
  ok(r.moved === behind, `裏側の頂点だけが動く (${r.moved} == ${behind})`);
  ok(r.back === behind, `裏側の頂点数が報告される (${r.back})`);
  ok(maxBehind(m, plane) < 1e-6, `平面より裏に何も残らない (最大 ${maxBehind(m, plane).toExponential(2)})`);
  ok(Math.abs(r.maxMove - 1) < 0.01, `最深部が平面まで動く (${r.maxMove.toFixed(4)})`);
  // トポロジは変わらない
  ok(m.liveVerts === 2562 && m.liveTris === 5120, `頂点/面が増減しない (${m.liveVerts}/${m.liveTris})`);
  validate(m, { label: 'clip hard' });

  // べき等性: もう一度同じ平面でクリップしても形が変わらない
  const before = m.positions.slice(0, m.nv * 3);
  const r2 = clipPlane(m, plane);
  let maxd = 0;
  for (let i = 0; i < m.nv * 3; i++) maxd = Math.max(maxd, Math.abs(m.positions[i] - before[i]));
  ok(maxd < 1e-6, `2 回目のクリップで形が変わらない（べき等） (最大差 ${maxd.toExponential(2)})`);
  ok(r2.maxMove < 1e-6, `2 回目の移動量がほぼ 0 (${r2.maxMove.toExponential(2)})`);
}

head('clipPlane（マスクの尊重）');
{
  const m = sphereMesh(4);
  const plane = planeFromAxis('y', 0, 1);
  // x > 0 側を完全保護、x < 0 側は半分だけ動く
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3] > 0 ? 1 : 0.5;
  const before = m.positions.slice(0, m.nv * 3);
  const r = clipPlane(m, plane);
  let lockedMoved = 0, halfBad = 0, halfCount = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    const s0 = before[i + 1];
    if (s0 >= 0) continue;
    if (m.mask[v] === 1) {
      for (let k = 0; k < 3; k++) if (m.positions[i + k] !== before[i + k]) { lockedMoved++; break; }
    } else {
      halfCount++;
      // mask 0.5 → 移動量はちょうど半分
      if (Math.abs(m.positions[i + 1] - s0 * 0.5) > 1e-6) halfBad++;
      if (Math.abs(m.positions[i] - before[i]) > 1e-6) halfBad++;
    }
  }
  ok(lockedMoved === 0, `mask=1 の頂点が 1 つも動かない (動いた ${lockedMoved})`);
  ok(halfCount > 100 && halfBad === 0, `mask=0.5 でちょうど半分だけ動く (対象 ${halfCount} / 不正 ${halfBad})`);
  ok(r.moved === halfCount, `統計が実際に動いた数と一致 (${r.moved} == ${halfCount})`);
  validate(m, { label: 'clip masked' });

  // ignoreMask ならマスクを無視して落としきる
  const m2 = sphereMesh(3);
  for (let v = 0; v < m2.nv; v++) m2.mask[v] = 1;
  ok(clipPlane(m2, plane).moved === 0, 'mask=1 だけなら何も動かない');
  const r3 = clipPlane(m2, plane, { ignoreMask: true });
  ok(r3.moved > 0 && maxBehind(m2, plane) < 1e-6, 'ignoreMask でマスクを無視できる');
}

head('clipPlane（ソフトクリップ）');
{
  const w = 0.5;
  const plane = planeFromAxis('y', 0, 1);
  const hard = sphereMesh(4); clipPlane(hard, plane);
  const soft = sphereMesh(4);
  const before = soft.positions.slice(0, soft.nv * 3);
  const r = clipPlane(soft, plane, { falloff: w });
  ok(r.changed, 'ソフトクリップが実行される');

  let frontMoved = 0, worstBehind = 0, deepBad = 0, deepCount = 0;
  for (let v = 0; v < soft.nv; v++) {
    if (!soft.vAlive[v]) continue;
    const i = v * 3;
    const s0 = before[i + 1];
    const s1 = soft.positions[i + 1];
    if (s0 >= 0) {
      for (let k = 0; k < 3; k++) if (soft.positions[i + k] !== before[i + k]) { frontMoved++; break; }
    } else {
      if (s1 < -worstBehind) worstBehind = -s1;
      if (s0 <= -w) { deepCount++; if (Math.abs(s1) > 1e-6) deepBad++; }
    }
    ok(Number.isFinite(s1), 'ソフトクリップで NaN が出ない');
  }
  ok(frontMoved === 0, `表側の頂点は 1 つも動かない (動いた ${frontMoved})`);
  ok(deepCount > 100 && deepBad === 0, `深さ ${w} 以上は完全に平面へ落ちる (対象 ${deepCount} / 不正 ${deepBad})`);
  ok(worstBehind < w * 0.27, `裏に残るのは 0.27*falloff 以内 (${worstBehind.toFixed(4)} < ${(w * 0.27).toFixed(4)})`);
  ok(surfaceArea(soft) > surfaceArea(hard),
    `ハードより丸い肩が残る（面積が大きい ${surfaceArea(soft).toFixed(4)} > ${surfaceArea(hard).toFixed(4)}）`);
  validate(soft, { label: 'clip soft' });
}

// ---------------------------------------------------------------------------
head('trimPlane（球）');
{
  const m = sphereMesh(4);
  const plane = planeFromAxis('y', 0.13, 1);       // 頂点に当たらない高さで切る
  const v0 = m.liveVerts;
  const r = trimPlane(m, plane);
  console.log(`  ${v0} → ${m.liveVerts} 頂点 / 除去 ${r.removed} 追加 ${r.added}`
    + ` / 交点 ${r.cutVerts} / 輪郭 ${r.loops}`);
  ok(r.changed, 'トリムが実行される');
  ok(r.removed > 0 && r.added > 0 && r.cutVerts > 0, '除去 / 追加 / 交点が報告される');
  ok(r.loops === 1, `輪郭が 1 本 (${r.loops})`);
  validate(m, { closed: true, genus: 0, label: 'trim sphere' });
  ok(maxBehind(m, plane) < 1e-6, `裏側の頂点が残っていない (${maxBehind(m, plane).toExponential(2)})`);
  ok(signedVolume(m) > 0, `面が外向き（体積 ${signedVolume(m).toFixed(4)} > 0）`);
  ok(duplicateVerts(m) === 0, `重複頂点がない (${duplicateVerts(m)})`);
  ok(minTriArea(m) > 1e-12, `面積 0 の三角形がない (最小 ${minTriArea(m).toExponential(2)})`);

  // 切り口は平らか（平面上の頂点 = 輪郭 + 中心 1 個）
  let onPlane = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (Math.abs(planeDistance(plane, m.positions[i], m.positions[i + 1], m.positions[i + 2])) < 1e-6) onPlane++;
  }
  ok(onPlane === r.cutVerts + 1, `切り口が平面上に乗っている (${onPlane} == ${r.cutVerts} + 1)`);

  // 平面より上（外）に何も削られていないこと: 半径 1 の球なので上半分は半径のまま
  let rmin = Infinity;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (m.positions[i + 1] < 0.4) continue;
    rmin = Math.min(rmin, Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]));
  }
  ok(rmin > 0.99, `残った側の形が保たれている (最小半径 ${rmin.toFixed(4)})`);
}

head('trimPlane（境界ケース）');
{
  // 交差しない平面 → 何もしない
  const m = sphereMesh(3);
  const before = m.positions.slice(0, m.nv * 3);
  const r = trimPlane(m, planeFromAxis('y', -5, 1));
  ok(!r.changed && r.removed === 0, '交差しない平面では何もしない');
  let same = true;
  for (let i = 0; i < m.nv * 3; i++) if (m.positions[i] !== before[i]) same = false;
  ok(same, '交差しない平面で座標が 1 つも変わらない');

  // 全部が裏 → 拒否（空メッシュを作らない）
  const r2 = trimPlane(m, planeFromAxis('y', 5, 1));
  ok(r2.refused === 'all-back' && m.liveVerts > 0, `全部消える切り方は拒否する (${r2.refused})`);
  validate(m, { label: 'trim no-op' });

  // 頂点をちょうど通る平面（球の頂点は y = ±1 にある）
  const m2 = sphereMesh(3);
  const p3 = planeFromAxis('y', 0, 1);
  const r3 = trimPlane(m2, p3);
  ok(r3.changed && r3.loops === 1, `頂点上を通る平面でも輪郭が 1 本 (${r3.loops})`);
  validate(m2, { closed: true, label: 'trim through verts' });
  ok(duplicateVerts(m2) === 0, '頂点上を通っても重複頂点が出ない');
  ok(minTriArea(m2) > 1e-12, `頂点上を通っても退化三角形が出ない (${minTriArea(m2).toExponential(2)})`);

  // 反対側を残す
  const m3 = sphereMesh(3);
  trimPlane(m3, planeFromAxis('y', 0, -1));
  let maxY = -Infinity;
  for (let v = 0; v < m3.nv; v++) if (m3.vAlive[v]) maxY = Math.max(maxY, m3.positions[v * 3 + 1]);
  ok(maxY < 1e-6, `keep=-1 で負側が残る (maxY=${maxY.toExponential(2)})`);
  validate(m3, { closed: true, label: 'trim keep=-1' });
}

head('trimPlane（トーラス: 輪郭 2 本）');
{
  // x = 0 で半分に割る。切り口はチューブの断面 2 つで、どちらも円盤状なので
  // 重心ファンで正しく塞げる（輪郭が複数ある通常のケース）。
  const m3 = primMesh('torus');
  const p3 = planeFromAxis('x', 0, 1);
  const v3 = signedVolume(m3);
  const r3 = trimPlane(m3, p3);
  console.log(`  x=0: 輪郭 ${r3.loops} / 交点 ${r3.cutVerts} / 体積 ${v3.toFixed(4)} → ${signedVolume(m3).toFixed(4)}`);
  ok(r3.loops === 2, `半分に割ると輪郭 2 本 (${r3.loops})`);
  validate(m3, { closed: true, genus: 0, label: 'trim torus x=0' });
  ok(signedVolume(m3) > 0, `半分でも外向き (${signedVolume(m3).toFixed(4)})`);
  ok(Math.abs(signedVolume(m3) - v3 * 0.5) < v3 * 0.02,
    `体積がちょうど半分になる (${(v3 * 0.5).toFixed(4)} vs ${signedVolume(m3).toFixed(4)})`);
  ok(duplicateVerts(m3) === 0, `重複頂点がない (${duplicateVerts(m3)})`);
  ok(maxBehind(m3, p3) < 1e-6, '裏側が残っていない');

  // y = 0 はトーラスの内外の赤道をちょうど通る（交点を作らず既存頂点だけで切れる）。
  // 切り口が円環（輪郭が入れ子）になるケースで、重心ファンでは内側の穴を
  // 二重に覆ってしまう。閉多様体・体積は正しいが面が重なる — 既知の限界。
  const m = primMesh('torus');
  const plane = planeFromAxis('y', 0, 1);
  const vol0 = signedVolume(m);
  const r = trimPlane(m, plane);
  console.log(`  y=0: 輪郭 ${r.loops} / 交点 ${r.cutVerts} / 除去 ${r.removed} 追加 ${r.added}`);
  ok(r.loops === 2, `内側と外側で輪郭 2 本 (${r.loops})`);
  ok(r.cutVerts === 0, `既存頂点が平面上なので交点は作られない (${r.cutVerts})`);
  validate(m, { closed: true, genus: 0, label: 'trim torus y=0 (入れ子の輪郭)' });
  ok(Math.abs(signedVolume(m) - vol0 * 0.5) < Math.abs(vol0) * 0.02,
    `入れ子でも体積は半分になる (${(vol0 * 0.5).toFixed(4)} vs ${signedVolume(m).toFixed(4)})`);
  ok(maxBehind(m, plane) < 1e-6, '裏側が残っていない');

  // 頂点に当たらない高さ → 交点を作る経路
  const m2 = primMesh('torus');
  const p2 = planeFromAxis('y', 0.077, 1);
  const r2 = trimPlane(m2, p2);
  console.log(`  y=0.077: 輪郭 ${r2.loops} / 交点 ${r2.cutVerts}`);
  ok(r2.loops === 2 && r2.cutVerts > 0, `斜めの高さでも輪郭 2 本 (${r2.loops})`);
  validate(m2, { closed: true, genus: 0, label: 'trim torus y=0.077' });
  ok(maxBehind(m2, p2) < 1e-6, '裏側が残っていない');
  ok(minTriArea(m2) > 1e-14, `退化三角形がない (${minTriArea(m2).toExponential(2)})`);
}

head('trimPlane（cap=false は穴を開けたまま）');
{
  const m = sphereMesh(3);
  const r = trimPlane(m, planeFromAxis('y', 0.1, 1), { cap: false });
  ok(r.changed && r.loops === 0, '塞がない');
  validate(m, { closed: false, label: 'trim cap=false' });
  // 境界辺がちょうど輪郭 1 本ぶんある
  const em = new Map();
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3, v0 = m.tris[i], v1 = m.tris[i + 1], v2 = m.tris[i + 2];
    if (v0 === v1 && v1 === v2) continue;
    for (let e = 0; e < 3; e++) {
      const a = e === 0 ? v0 : (e === 1 ? v1 : v2);
      const b = e === 0 ? v1 : (e === 1 ? v2 : v0);
      const key = a < b ? a * KEY + b : b * KEY + a;
      em.set(key, (em.get(key) || 0) + 1);
    }
  }
  let boundary = 0, bad = 0;
  for (const [, n] of em) { if (n === 1) boundary++; else if (n !== 2) bad++; }
  ok(bad === 0, `非多様体辺がない (${bad})`);
  ok(boundary > 3, `切り口が境界辺として残る (${boundary} 本)`);
  const chi = m.liveVerts - em.size + m.liveTris;
  ok(chi === 1, `円盤のオイラー標数 χ=1 (${chi})`);
}

// ---------------------------------------------------------------------------
head('slicePlane');
{
  const m = sphereMesh(4);
  const plane = planeFromAxis('y', 0.13, 1);
  const v0 = m.liveVerts, t0 = m.liveTris;
  const area0 = surfaceArea(m), vol0 = signedVolume(m);
  const bb0 = m.bounds();

  const r = slicePlane(m, plane);
  console.log(`  ${v0} → ${m.liveVerts} 頂点 / ${t0} → ${m.liveTris} 面 / 交点 ${r.cutVerts}`);
  ok(r.changed && r.added > 0, 'スライスが実行される');
  ok(m.liveVerts === v0 + r.added, `頂点が交点ぶんだけ増える (${m.liveVerts})`);
  validate(m, { closed: true, genus: 0, label: 'slice sphere' });

  // 形は変わらない（接続だけ変わる）
  ok(Math.abs(surfaceArea(m) - area0) < area0 * 1e-5,
    `表面積が変わらない (${area0.toFixed(6)} → ${surfaceArea(m).toFixed(6)})`);
  ok(Math.abs(signedVolume(m) - vol0) < Math.abs(vol0) * 1e-5,
    `体積が変わらない (${vol0.toFixed(6)} → ${signedVolume(m).toFixed(6)})`);
  const bb1 = m.bounds();
  let bbSame = true;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(bb0.min[k] - bb1.min[k]) > 1e-6 || Math.abs(bb0.max[k] - bb1.max[k]) > 1e-6) bbSame = false;
  }
  ok(bbSame, 'バウンディングボックスが変わらない');
  ok(duplicateVerts(m) === 0, `重複頂点がない (${duplicateVerts(m)})`);
  ok(minTriArea(m) > 1e-14, `退化三角形がない (最小面積 ${minTriArea(m).toExponential(2)})`);

  // 平面を跨ぐ三角形が 1 枚も残っていない（= 平面上に辺ができた）
  let straddle = 0, onPlane = 0;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3;
    const a = m.tris[i], b = m.tris[i + 1], c = m.tris[i + 2];
    if (a === b && b === c) continue;
    let f = 0, k = 0;
    for (const v of [a, b, c]) {
      const j = v * 3;
      const s = planeDistance(plane, m.positions[j], m.positions[j + 1], m.positions[j + 2]);
      if (s > 1e-6) f++; else if (s < -1e-6) k++;
    }
    if (f > 0 && k > 0) straddle++;
  }
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (Math.abs(planeDistance(plane, m.positions[i], m.positions[i + 1], m.positions[i + 2])) < 1e-6) onPlane++;
  }
  ok(straddle === 0, `平面を跨ぐ三角形が残っていない (${straddle})`);
  ok(onPlane === r.cutVerts, `平面上の頂点が交点と一致 (${onPlane} == ${r.cutVerts})`);

  // べき等性: 同じ平面でもう一度スライスしても何も増えない
  const r2 = slicePlane(m, plane);
  ok(!r2.changed && r2.added === 0, `2 回目のスライスは何もしない（べき等） (added=${r2.added})`);
  ok(m.liveVerts === v0 + r.added, '2 回目で頂点が増えない');

  // 交差しない平面
  ok(slicePlane(m, planeFromAxis('y', 9, 1)).changed === false, '交差しない平面では何もしない');
}

head('slicePlane（トーラス / 既に辺がある平面）');
{
  const m = primMesh('torus');
  const r = slicePlane(m, planeFromAxis('y', 0, 1));
  ok(r.added === 0, `既に平面上に辺があるなら交点を作らない (${r.added})`);
  validate(m, { closed: true, genus: 1, label: 'slice torus y=0 (no-op)' });

  const m2 = primMesh('torus');
  const p2 = planeFromAxis('z', 0.31, 1);
  const r2 = slicePlane(m2, p2);
  ok(r2.changed && r2.added > 0, 'トーラスをスライスできる');
  validate(m2, { closed: true, genus: 1, label: 'slice torus z=0.31' });
  let straddle = 0;
  for (let t = 0; t < m2.nt; t++) {
    const i = t * 3;
    const a = m2.tris[i], b = m2.tris[i + 1], c = m2.tris[i + 2];
    if (a === b && b === c) continue;
    let f = 0, k = 0;
    for (const v of [a, b, c]) {
      const j = v * 3;
      const s = planeDistance(p2, m2.positions[j], m2.positions[j + 1], m2.positions[j + 2]);
      if (s > 1e-6) f++; else if (s < -1e-6) k++;
    }
    if (f > 0 && k > 0) straddle++;
  }
  ok(straddle === 0, `トーラスでも跨ぐ面が残らない (${straddle})`);
}

// ---------------------------------------------------------------------------
head('mirrorWeld');
{
  const m = sphereMesh(4);
  // 片側だけ非対称に変形させる（対称化されたか分かるように）
  for (let v = 0; v < m.nv; v++) {
    const i = v * 3;
    if (m.positions[i] > 0.5) {
      const s = 1 + 0.35 * (m.positions[i] - 0.5);
      m.positions[i + 1] *= s; m.positions[i + 2] *= s;
    }
  }
  m.computeAllNormals();
  const r = mirrorWeld(m, 'x');
  console.log(`  除去 ${r.removed} / 溶接 ${r.welded} / 追加 ${r.added} 頂点 ${r.addedTris} 面`
    + ` → ${m.liveVerts} 頂点 / ${m.liveTris} 面`);
  ok(r.changed && r.welded > 0, `接合部が溶接される (welded=${r.welded})`);
  validate(m, { closed: true, genus: 0, label: 'mirrorWeld x' });
  ok(signedVolume(m) > 0, `鏡像側も外向き（体積 ${signedVolume(m).toFixed(4)} > 0）`);
  ok(duplicateVerts(m) === 0, `重複頂点がない (${duplicateVerts(m)})`);
  ok(minTriArea(m) > 1e-14, `退化三角形がない (${minTriArea(m).toExponential(2)})`);

  // 位置の集合が x について鏡対称か
  const key = (x, y, z) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const set = new Set();
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    set.add(key(m.positions[i], m.positions[i + 1], m.positions[i + 2]));
  }
  let missing = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (!set.has(key(-m.positions[i], m.positions[i + 1], m.positions[i + 2]))) missing++;
  }
  ok(missing === 0, `全頂点に鏡像の相手がいる (欠け ${missing})`);
  ok(set.size === m.liveVerts, `同じ位置の頂点が 2 個ない (${set.size} == ${m.liveVerts})`);

  // 変形が反対側にも現れている
  let maxRy = 0, maxLy = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (m.positions[i] > 0.5) maxRy = Math.max(maxRy, Math.abs(m.positions[i + 1]));
    if (m.positions[i] < -0.5) maxLy = Math.max(maxLy, Math.abs(m.positions[i + 1]));
  }
  ok(maxLy > 0 && Math.abs(maxRy - maxLy) < 1e-5, `変形が反対側へコピーされる (${maxRy.toFixed(5)} vs ${maxLy.toFixed(5)})`);

  // べき等性: 既に対称なので 2 回目で形も頂点数も変わらない
  const nv1 = m.liveVerts, nt1 = m.liveTris, vol1 = signedVolume(m);
  const r2 = mirrorWeld(m, 'x');
  ok(m.liveVerts === nv1 && m.liveTris === nt1,
    `2 回目で頂点/面数が変わらない (${m.liveVerts}/${m.liveTris} == ${nv1}/${nt1})`);
  ok(Math.abs(signedVolume(m) - vol1) < Math.abs(vol1) * 1e-5, '2 回目で体積が変わらない');
  ok(r2.welded === r.welded, `溶接点数が同じ (${r2.welded} == ${r.welded})`);
  validate(m, { closed: true, genus: 0, label: 'mirrorWeld x ×2' });
}

head('mirrorWeld（軸とオフセット）');
{
  for (const axis of ['x', 'y', 'z']) {
    for (const keep of [1, -1]) {
      const m = sphereMesh(3);
      const r = mirrorWeld(m, axis, { keep });
      const ax = 'xyz'.indexOf(axis);
      let bad = 0;
      const key = (v) => {
        const i = v * 3;
        const p = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
        p[ax] = -p[ax];
        return `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
      };
      const set = new Set();
      for (let v = 0; v < m.nv; v++) {
        if (!m.vAlive[v]) continue;
        const i = v * 3;
        set.add(`${Math.round(m.positions[i] * 1e5)},${Math.round(m.positions[i + 1] * 1e5)},${Math.round(m.positions[i + 2] * 1e5)}`);
      }
      for (let v = 0; v < m.nv; v++) { if (m.vAlive[v] && !set.has(key(v))) bad++; }
      ok(bad === 0 && r.welded > 0, `${axis} keep=${keep}: 鏡対称になる (欠け ${bad})`);
      validate(m, { closed: true, genus: 0, label: `mirrorWeld ${axis} keep=${keep}` });
      ok(signedVolume(m) > 0, `${axis} keep=${keep}: 外向き`);
    }
  }

  // オフセットした鏡
  const m = sphereMesh(3);
  const r = mirrorWeld(m, 'x', { offset: 0.25 });
  ok(r.welded > 0, `オフセット鏡でも溶接される (${r.welded})`);
  validate(m, { closed: true, genus: 0, label: 'mirrorWeld offset' });
  let minX = Infinity, maxX = -Infinity;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    minX = Math.min(minX, m.positions[v * 3]);
    maxX = Math.max(maxX, m.positions[v * 3]);
  }
  ok(Math.abs((minX + maxX) * 0.5 - 0.25) < 1e-5, `鏡が x=0.25 にある (中心 ${((minX + maxX) * 0.5).toFixed(5)})`);

  // 不正な軸
  ok(mirrorWeld(sphereMesh(2), 'w').changed === false, '不正な軸では何もしない');
  // トーラス（半分に割ってから鏡像 → トーラスに戻る）
  const t = primMesh('torus');
  mirrorWeld(t, 'x');
  validate(t, { closed: true, genus: 1, label: 'mirrorWeld torus' });
  ok(signedVolume(t) > 0, 'トーラスでも外向き');
}

// ---------------------------------------------------------------------------
head('ポリペイント / マスクの引き継ぎ');
{
  const m = sphereMesh(3);
  for (let v = 0; v < m.nv; v++) {
    const i = v * 3;
    m.colors[i] = 0.25; m.colors[i + 1] = 0.5; m.colors[i + 2] = 0.75;
    m.mask[v] = 0.4;
  }
  trimPlane(m, planeFromAxis('y', 0.11, 1));
  let badC = 0, badM = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (Math.abs(m.colors[i] - 0.25) > 1e-5 || Math.abs(m.colors[i + 1] - 0.5) > 1e-5
      || Math.abs(m.colors[i + 2] - 0.75) > 1e-5) badC++;
    if (Math.abs(m.mask[v] - 0.4) > 1e-5) badM++;
  }
  ok(badC === 0, `交点と蓋の色が補間される (不正 ${badC})`);
  ok(badM === 0, `交点と蓋のマスクが補間される (不正 ${badM})`);

  const m2 = sphereMesh(3);
  for (let v = 0; v < m2.nv; v++) { m2.colors[v * 3] = 0.8; m2.mask[v] = 0.3; }
  mirrorWeld(m2, 'x');
  let badC2 = 0, badM2 = 0;
  for (let v = 0; v < m2.nv; v++) {
    if (!m2.vAlive[v]) continue;
    if (Math.abs(m2.colors[v * 3] - 0.8) > 1e-5) badC2++;
    if (Math.abs(m2.mask[v] - 0.3) > 1e-5) badM2++;
  }
  ok(badC2 === 0 && badM2 === 0, `鏡像側も色 / マスクを引き継ぐ (色 ${badC2} / マスク ${badM2})`);
}

// ---------------------------------------------------------------------------
head('axisIndex');
{
  ok(axisIndex('x') === 0 && axisIndex('y') === 1 && axisIndex('z') === 2, "'x','y','z' → 0,1,2");
  ok(axisIndex('X') === 0 && axisIndex('Z') === 2, '大文字も通る');
  ok(axisIndex(0) === 0 && axisIndex(1) === 1 && axisIndex(2) === 2, '0,1,2 はそのまま');
  ok(axisIndex('w') === -1 && axisIndex('xy') === -1 && axisIndex(3) === -1
    && axisIndex(1.5) === -1 && axisIndex(null) === -1 && axisIndex(undefined) === -1,
    '不正な軸は -1');
  ok(planeFromAxis('w') === null, '不正な軸では planeFromAxis が null');
}

// ---------------------------------------------------------------------------
head('法線 / 曲率が操作後に正しく更新されている');
{
  // 部分更新（切り口の周りだけ）で足りているかを、全体再計算と突き合わせて確かめる。
  // ここが緩むとマットキャップとキャビティ陰影に継ぎ目が出る。
  const plane = planeFromAxis('y', 0.13, 1);

  // ソフトクリップは折り返しを作らないので、全頂点で厳密に一致するはず
  const mc = sphereMesh(4); clipPlane(mc, plane, { falloff: 0.3 });
  const dc = normalDrift(mc);
  ok(dc.worst < 1e-5 && dc.degen === 0,
    `clip 後の法線が正しい (最大ずれ ${dc.worst.toExponential(2)} / 除外 ${dc.degen})`);

  // ハードクリップは折り返した頂点だけ法線が決まらない（既知の限界）。
  // それ以外の頂点は厳密に一致していること。
  const mh = sphereMesh(4); clipPlane(mh, plane);
  const dh = normalDrift(mh);
  ok(dh.worst < 1e-5, `ハードクリップ後も折り返し以外の法線は正しい (最大ずれ ${dh.worst.toExponential(2)})`);
  ok(dh.degen > 0 && dh.degen < mh.liveVerts * 0.1,
    `折り返しは平面近傍の一部だけ (${dh.degen} / ${mh.liveVerts} 頂点)`);

  const mt = sphereMesh(4); trimPlane(mt, plane);
  const dt = normalDrift(mt), ct = curvDrift(mt);
  ok(dt.worst < 1e-5 && dt.degen === 0, `trim 後の法線が正しい (最大ずれ ${dt.worst.toExponential(2)})`);
  ok(ct < 0.02, `trim 後の曲率が概ね正しい (最大ずれ ${ct.toFixed(5)})`);

  const ms = sphereMesh(4); slicePlane(ms, plane);
  const ds = normalDrift(ms), cs = curvDrift(ms);
  ok(ds.worst < 1e-5 && ds.degen === 0, `slice 後の法線が正しい (最大ずれ ${ds.worst.toExponential(2)})`);
  ok(cs < 0.02, `slice 後の曲率が概ね正しい (最大ずれ ${cs.toFixed(5)})`);

  const mm = sphereMesh(4); mirrorWeld(mm, 'x');
  const dm = normalDrift(mm), cm = curvDrift(mm);
  ok(dm.worst < 1e-5 && dm.degen === 0, `mirrorWeld 後の法線が正しい (最大ずれ ${dm.worst.toExponential(2)})`);
  ok(cm < 0.02, `mirrorWeld 後の曲率が正しい (最大ずれ ${cm.toFixed(5)})`);

  // 連続適用でも取り残しが出ないこと（2 回目の切り口が 1 回目の跡と重なる）
  const mq = sphereMesh(4);
  trimPlane(mq, planeFromAxis('x', 0.2, 1));
  trimPlane(mq, planeFromAxis('y', 0.2, -1));
  const dq = normalDrift(mq);
  ok(dq.worst < 1e-5 && dq.degen === 0, `2 回トリムしても法線が正しい (最大ずれ ${dq.worst.toExponential(2)})`);

  // バージョン番号: clip は形だけ、trim / slice は接続まで変える
  const mv = sphereMesh(3);
  const g0 = mv.geomVersion, t0 = mv.topoVersion;
  clipPlane(mv, planeFromAxis('y', 0, 1));
  ok(mv.geomVersion > g0, 'clip は geomVersion を進める');
  ok(mv.topoVersion === t0, 'clip は topoVersion を進めない（ワイヤ再構築は不要）');
  ok(mv.vDirtyMax >= 0, 'clip が dirty レンジを立てる（GPU 転送される）');
  const t1 = mv.topoVersion;
  trimPlane(mv, planeFromAxis('y', 0.3, 1));
  ok(mv.topoVersion > t1, 'trim は topoVersion を進める');
}

// ---------------------------------------------------------------------------
head('平面のごく近くを通る切り方（スナップ）');
{
  // 既存頂点から eps の半分だけずれた平面で切る。スナップしないと
  // 切り口が eps ぶん波打ち、t≈0 の交点が既存頂点と重なって
  // 面積ゼロの三角形と実質的な重複頂点が残る。
  const m = sphereMesh(4);
  const eps = m.bounds().radius * 1e-5;
  const ys = [];
  for (let v = 0; v < m.nv; v++) ys.push(m.positions[v * 3 + 1]);
  ys.sort((a, b) => a - b);
  const plane = planeFromAxis('y', ys[Math.floor(ys.length * 0.55)] + eps * 0.5, 1);

  const r = trimPlane(m, plane);
  ok(r.snapped > 0, `平面のすぐ近くの頂点が吸い寄せられる (snapped=${r.snapped})`);
  ok(r.loops === 1, `輪郭が 1 本にまとまる (${r.loops})`);
  validate(m, { closed: true, genus: 0, label: 'trim (eps 近傍を通る平面)' });
  // 切り口の頂点は「eps 以内」ではなく「ほぼ厳密に」平面上に乗っていること
  let onPlane = 0, maxOff = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    const s = Math.abs(planeDistance(plane, m.positions[i], m.positions[i + 1], m.positions[i + 2]));
    if (s < eps * 4) { onPlane++; if (s > maxOff) maxOff = s; }
  }
  ok(onPlane > 10 && maxOff < eps * 0.01,
    `切り口が平らになる (${onPlane} 頂点 / 最大ずれ ${maxOff.toExponential(2)} << ${eps.toExponential(2)})`);
  ok(duplicateVerts(m, 1e-7) === 0, `重複頂点が出ない (${duplicateVerts(m, 1e-7)})`);
  ok(minTriArea(m) > 1e-14, `面積ゼロの三角形が出ない (${minTriArea(m).toExponential(2)})`);
}

// ---------------------------------------------------------------------------
head('斜めの平面 / 正規化されていない平面');
{
  // 軸に平行な平面だけだと、符号計算が 1 成分で済んでしまい 3 成分の経路を通らない
  const pl = planeFromPointNormal([0.1, 0.05, -0.02], [0.3, 0.9, -0.31]);
  const m = sphereMesh(4);
  const r = trimPlane(m, pl);
  ok(r.changed && r.loops === 1 && r.cutVerts > 0, `斜め平面でトリムできる (輪郭 ${r.loops})`);
  validate(m, { closed: true, genus: 0, label: 'trim 斜め平面' });
  ok(maxBehind(m, pl) < 1e-6, `斜めでも裏に残らない (${maxBehind(m, pl).toExponential(2)})`);
  ok(signedVolume(m) > 0, '斜めでも外向き');
  ok(duplicateVerts(m) === 0, '斜めでも重複頂点がない');
  ok(minTriArea(m) > 1e-14, '斜めでも退化三角形がない');
  ok(normalDrift(m).worst < 1e-5, '斜めでも法線が正しい');

  const m2 = sphereMesh(4);
  const area0 = surfaceArea(m2);
  const s1 = slicePlane(m2, pl);
  ok(s1.changed && s1.added > 0, '斜め平面でスライスできる');
  validate(m2, { closed: true, genus: 0, label: 'slice 斜め平面' });
  ok(Math.abs(surfaceArea(m2) - area0) < area0 * 1e-5, '斜めスライスでも表面積が変わらない');
  const s2 = slicePlane(m2, pl);
  ok(!s2.changed && s2.added === 0, '斜めスライスもべき等');

  // 単位法線でない平面を渡しても、正規化した平面と同じ結果になること
  const a = sphereMesh(3); const ra = trimPlane(a, { n: [0, 2, 0], d: -0.4 });
  const b = sphereMesh(3); const rb = trimPlane(b, planeFromAxis('y', 0.2, 1));
  ok(a.liveVerts === b.liveVerts && a.liveTris === b.liveTris && ra.cutVerts === rb.cutVerts,
    `非正規化な平面でも同じ結果 (${a.liveVerts}/${a.liveTris} == ${b.liveVerts}/${b.liveTris})`);
  ok(Math.abs(signedVolume(a) - signedVolume(b)) < 1e-6, '非正規化でも同じ形');
}

// ---------------------------------------------------------------------------
head('strength / falloff の境界値');
{
  const plane = planeFromAxis('y', 0, 1);
  const m = sphereMesh(3);
  const r = clipPlane(m, plane, { strength: 0.5 });
  ok(Math.abs(r.maxMove - 0.5) < 0.01, `strength=0.5 で移動量が半分 (${r.maxMove.toFixed(4)})`);
  // 半分だけ動いたので、まだ裏に残っているのが正しい
  ok(Math.abs(maxBehind(m, plane) - 0.5) < 0.01, 'strength=0.5 では裏に半分残る');
  ok(countNonFinite(m) === 0, 'strength=0.5 で NaN が出ない');

  const m0 = sphereMesh(3);
  const before0 = m0.positions.slice(0, m0.nv * 3);
  const r0 = clipPlane(m0, plane, { strength: 0 });
  ok(!r0.changed && r0.moved === 0 && positionsUnchanged(m0, before0), 'strength=0 で何もしない');

  const mn = sphereMesh(3);
  const beforeN = mn.positions.slice(0, mn.nv * 3);
  const rn = clipPlane(mn, plane, { strength: -1 });
  ok(!rn.changed && positionsUnchanged(mn, beforeN), '負の strength でも何もしない');

  // falloff = 0 はハードクリップと同じ、負 / 無限は 0 扱い
  const h1 = sphereMesh(3); clipPlane(h1, plane);
  const h2 = sphereMesh(3); clipPlane(h2, plane, { falloff: 0 });
  const h3 = sphereMesh(3); clipPlane(h3, plane, { falloff: -1 });
  const h4 = sphereMesh(3); clipPlane(h4, plane, { falloff: Infinity });
  let same = true;
  for (let i = 0; i < h1.nv * 3; i++) {
    if (h2.positions[i] !== h1.positions[i] || h3.positions[i] !== h1.positions[i]) same = false;
  }
  ok(same, 'falloff <= 0 はハードクリップと同一');
  ok(countNonFinite(h4) === 0, 'falloff=Infinity でも NaN が出ない');
}

// ---------------------------------------------------------------------------
head('壊れた入力（NaN / Infinity）でメッシュを壊さない');
{
  // NaN が 1 つ混ざった平面を通してしまうと、符号が表でも裏でもなくなって
  // 全頂点が「平面上」に分類され、座標が丸ごと NaN になる。しかも操作は
  // 「何も切らなかった」ように見えるので呼び出し側は履歴を積まない
  // → 取り消せない破壊になる。入口で弾いていることを確かめる。
  const bad = [
    ['d=NaN', { n: [0, 1, 0], d: NaN }],
    ['d=Infinity', { n: [0, 1, 0], d: Infinity }],
    ['n に NaN', { n: [0, NaN, 0], d: 0 }],
    ['n に Infinity', { n: [Infinity, 0, 0], d: 0 }],
    ['n が 0', { n: [0, 0, 0], d: 0 }],
    ['n がない', { d: 0 }],
    ['null', null],
  ];
  for (const [name, plane] of bad) {
    for (const [opName, op] of [['clip', clipPlane], ['trim', trimPlane], ['slice', slicePlane]]) {
      const m = sphereMesh(3);
      const before = m.positions.slice(0, m.nv * 3);
      const v0 = m.liveVerts, t0 = m.liveTris;
      const r = op(m, plane);
      ok(r.changed === false, `${opName}(${name}) は changed=false`);
      ok(positionsUnchanged(m, before), `${opName}(${name}) で座標が動かない`);
      ok(m.liveVerts === v0 && m.liveTris === t0, `${opName}(${name}) で頂点/面が変わらない`);
      ok(countNonFinite(m) === 0, `${opName}(${name}) で NaN が出ない`);
    }
  }
  // オプションに NaN が入っても壊れない
  const m = sphereMesh(3);
  const before = m.positions.slice(0, m.nv * 3);
  const r = clipPlane(m, planeFromAxis('y', 0, 1), { strength: NaN });
  ok(!r.changed && positionsUnchanged(m, before) && countNonFinite(m) === 0,
    'strength=NaN では何もしない');
  const m2 = sphereMesh(3);
  trimPlane(m2, planeFromAxis('y', 0.1, 1), { eps: NaN });
  ok(countNonFinite(m2) === 0, 'eps=NaN でも NaN が出ない');
  validate(m2, { closed: true, label: 'trim eps=NaN' });
  const m3 = sphereMesh(3);
  mirrorWeld(m3, 'x', { offset: NaN });
  ok(countNonFinite(m3) === 0, 'offset=NaN でも NaN が出ない');
  validate(m3, { closed: true, label: 'mirrorWeld offset=NaN' });
  ok(planeFromAxis('x', NaN) === null, 'planeFromAxis(NaN) は null');
  ok(planeFromPointNormal([NaN, 0, 0], [0, 1, 0]) === null, 'planeFromPointNormal(NaN 点) は null');
  ok(planeFromPointNormal([0, 0, 0], [NaN, 1, 0]) === null, 'planeFromPointNormal(NaN 法線) は null');
  ok(planeFromScreenLine([0, NaN, 0], [1, 0, 0], [0, 0, -1]) === null, 'planeFromScreenLine(NaN) は null');
}

// ---------------------------------------------------------------------------
head('changed=false / refused のときは 1 ビットも変えない');
{
  // 呼び出し側は changed を見て履歴を積むかどうか決める。false なのに
  // 形が変わっていると、その変更は取り消せないまま残る。
  const cases = [
    ['交差しない平面 (trim)', (m) => trimPlane(m, planeFromAxis('y', -5, 1))],
    ['全部裏 (trim)', (m) => trimPlane(m, planeFromAxis('y', 5, 1))],
    ['交差しない平面 (slice)', (m) => slicePlane(m, planeFromAxis('y', 5, 1))],
    ['接している平面 (slice)', (m) => slicePlane(m, planeFromAxis('y', 1, 1))],
    ['離れた鏡 (mirrorWeld)', (m) => mirrorWeld(m, 'x', { offset: -5 })],
    ['不正な軸 (mirrorWeld)', (m) => mirrorWeld(m, 'w')],
  ];
  for (const [name, run] of cases) {
    const m = sphereMesh(4);
    const before = m.positions.slice(0, m.nv * 3);
    const v0 = m.liveVerts, t0 = m.liveTris;
    const r = run(m);
    ok(!r.changed, `${name}: changed=false`);
    ok(positionsUnchanged(m, before), `${name}: 座標が 1 成分も動かない`);
    ok(m.liveVerts === v0 && m.liveTris === t0, `${name}: 頂点/面が増減しない`);
  }
  // 全部裏 / 離れた鏡は理由を返す
  ok(trimPlane(sphereMesh(3), planeFromAxis('y', 5, 1)).refused === 'all-back', "refused='all-back'");
  const rm = mirrorWeld(sphereMesh(3), 'x', { offset: -5 });
  ok(rm.refused === 'no-intersection', `離れた鏡は refused='no-intersection' (${rm.refused})`);

  // 平面がちょうど頂点に接するだけの位置（eps 内に頂点があるが裏側は空）でも
  // 座標を動かさないこと。以前は分類のスナップだけが先に走って
  // changed=false のまま形が eps ぶんずれていた。
  const m = sphereMesh(4);
  const eps = m.bounds().radius * 1e-5;
  const plane = planeFromAxis('y', -1 + eps * 0.5, 1);   // 球の最下点のすぐ上
  const before = m.positions.slice(0, m.nv * 3);
  const r = trimPlane(m, plane);
  ok(!r.changed && r.snapped === 0 && positionsUnchanged(m, before),
    `拒否した切り方でスナップも起きない (snapped=${r.snapped})`);
}

// ---------------------------------------------------------------------------
head('mirrorWeld が塊を 2 つに割らない');
{
  const m = sphereMesh(3);
  ok(componentCount(m) === 1, '元の球は 1 つの塊');
  mirrorWeld(m, 'x');
  ok(componentCount(m) === 1, `鏡像化しても 1 つの塊のまま (${componentCount(m)})`);
  // オフセット鏡でも接合される
  const m2 = sphereMesh(3);
  mirrorWeld(m2, 'x', { offset: 0.25 });
  ok(componentCount(m2) === 1, `オフセット鏡でも 1 つの塊 (${componentCount(m2)})`);
  // 半分だけのモデル（cap=false でトリム）を鏡像化する正当な使い方
  const half = sphereMesh(3);
  trimPlane(half, planeFromAxis('x', 0, 1), { cap: false });
  const rh = mirrorWeld(half, 'x');
  ok(!rh.refused && rh.welded > 0, `開いた半球でも溶接できる (welded=${rh.welded})`);
  ok(componentCount(half) === 1, '半球 + 鏡像で 1 つの塊');
  validate(half, { closed: true, genus: 0, label: 'mirrorWeld 開いた半球' });
  ok(signedVolume(half) > 0, '半球 + 鏡像でも外向き');
  ok(duplicateVerts(half) === 0, '半球 + 鏡像でも重複頂点がない');
}

// ---------------------------------------------------------------------------
head('死んだスロットが残っている状態からの操作');
{
  // トリムはフリーリストに大量のスロットを残す。そのあとの操作で
  // 「生き返ったスロット」を二重に処理すると頂点が増殖する（実際に起きた事故）。
  const m = sphereMesh(4);
  trimPlane(m, planeFromAxis('y', 0.2, 1));
  ok(m.freeVerts.length > 0 && m.freeTris.length > 0,
    `死んだスロットが残っている (V:${m.freeVerts.length} T:${m.freeTris.length})`);

  const s = slicePlane(m, planeFromAxis('x', 0.1, 1));
  ok(s.changed, 'フリースロットがあってもスライスできる');
  validate(m, { closed: true, genus: 0, label: 'slice (フリースロットあり)' });
  ok(duplicateVerts(m) === 0, 'スライスで重複頂点が生えない');

  const w = mirrorWeld(m, 'z');
  ok(w.changed, 'フリースロットがあってもミラーできる');
  validate(m, { closed: true, genus: 0, label: 'mirrorWeld (フリースロットあり)' });
  ok(duplicateVerts(m) === 0, `ミラーで重複頂点が生えない (${duplicateVerts(m)})`);
  ok(componentCount(m) === 1, 'ミラー後も 1 つの塊');
  ok(normalDrift(m).worst < 1e-5, 'フリースロット込みでも法線が正しい');

  // compact してから同じことをしても結果が変わらない
  const c = sphereMesh(4);
  trimPlane(c, planeFromAxis('y', 0.2, 1));
  c.compact(true);
  ok(c.freeVerts.length === 0, 'compact でフリーリストが空になる');
  const s2 = slicePlane(c, planeFromAxis('x', 0.1, 1));
  ok(s2.added === s.added, `compact してもスライスの交点数が同じ (${s2.added} == ${s.added})`);
  validate(c, { closed: true, genus: 0, label: 'slice (compact 後)' });
}

// ---------------------------------------------------------------------------
head('負荷: 大きめのメッシュ');
{
  const m = sphereMesh(5);      // 10242 頂点
  const big = sphereMesh(6);    // 40962 頂点
  const t0 = Date.now();
  const rt = trimPlane(big, planeFromAxis('x', 0.1, 1));
  const t1 = Date.now();
  const rs = slicePlane(big, planeFromAxis('z', 0.07, 1));
  const t2 = Date.now();
  const rm = mirrorWeld(big, 'z');
  const t3 = Date.now();
  ok(duplicateVerts(big) === 0, `トリム→スライス→ミラーで重複頂点が出ない (${duplicateVerts(big)})`);
  ok(signedVolume(big) > 0, '外向き');
  // クリップは裏側を平面へ潰すので、投影が重なる頂点は原理的に同じ位置になる
  // （ZBrush の Clip も同じ）。ここでは重複頂点の検査はしない。
  const rc = clipPlane(big, planeFromAxis('y', 0.05, 1));
  const t4 = Date.now();
  console.log(`  ${big.liveVerts.toLocaleString()} 頂点: trim ${t1 - t0}ms / slice ${t2 - t1}ms`
    + ` / mirror ${t3 - t2}ms / clip ${t4 - t3}ms`);
  ok(rc.changed && rt.changed && rs.changed && rm.changed, '大きめでも全部動く');
  ok(t4 - t0 < 20000, `4 操作が現実的な時間で終わる (${t4 - t0}ms)`);
  validate(big, { closed: true, genus: 0, label: 'big: trim→slice→mirror→clip' });

  // 連続適用（3 方向から削る）でも壊れないこと
  const seq = m;
  trimPlane(seq, planeFromAxis('x', 0.4, -1));
  trimPlane(seq, planeFromAxis('y', 0.4, -1));
  trimPlane(seq, planeFromAxis('z', 0.4, -1));
  validate(seq, { closed: true, genus: 0, label: '3 方向トリム' });
  ok(signedVolume(seq) > 0, '3 方向トリム後も外向き');
  ok(duplicateVerts(seq) === 0, '3 方向トリム後も重複頂点がない');
  ok(minTriArea(seq) > 1e-14, `3 方向トリム後も退化三角形がない (${minTriArea(seq).toExponential(2)})`);
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
