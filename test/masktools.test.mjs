// masktools.js（マスクツール）の検証。DOM / WebGPU には触らない。
//   node test/masktools.test.mjs
import { SculptMesh, PRIMITIVES, icosphere } from '../js/mesh.js';
import { Sculptor } from '../js/sculptor.js';
import {
  MASK_MODES, MASK_OPS, MASK_OP_IDS, MASK_OP_BY_ID, applyMaskOp,
  clearMask, maskAll, invertMask, blurMask, sharpenMask, growMask, shrinkMask,
  maskByCavity, maskByAmbientOcclusion, maskBySmoothness, maskByColor, maskByNormal,
  releaseScratch,
} from '../js/masktools.js';

let failures = 0;
let checks = 0;
let sectionStart = -1;
function ok(cond, msg) {
  checks++;
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
function head(t) {
  if (sectionStart >= 0) console.log(`  ok   ${checks - sectionStart} 件`);
  sectionStart = checks;
  console.log('\n== ' + t + ' ==');
}

// --- 補助 -------------------------------------------------------------------

function sphere(name = 'sphere') {
  const g = PRIMITIVES[name]();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  return m;
}

/** (1,0,0) 付近を内側へ押し込んだ球。凹（窪みの縁）と凸（反対側）が同時にある形 */
function dentedSphere() {
  const m = sphere('sphereHi');
  const P = m.positions;
  for (let v = 0; v < m.nv; v++) {
    const i = v * 3;
    const t = Math.hypot(P[i] - 1, P[i + 1], P[i + 2]) / 0.45;
    if (t >= 1) continue;
    const s = 1 - 0.25 * (1 - t * t) ** 2;
    P[i] *= s; P[i + 1] *= s; P[i + 2] *= s;
  }
  m.computeAllNormals();
  m.computeAllCurvature();
  return m;
}

function makeState(over = {}) {
  return Object.assign({
    brush: 'clay', radiusPx: 90, strength: 0.6, paintColor: [0.6, 0.2, 0.15],
    worldRadius: 0.25, dynTopo: false, decimate: true, detail: 0.55, maxVerts: 400000,
    symmetry: { x: false, y: false, z: false },
  }, over);
}

/** 位置 c から半径 r 以内の生存頂点 */
function region(m, c, r) {
  const out = [];
  const P = m.positions;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const i = v * 3;
    if (Math.hypot(P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2]) < r) out.push(v);
  }
  return out;
}
const meanMask = (m, vs) => vs.reduce((s, v) => s + m.mask[v], 0) / Math.max(1, vs.length);
const maxMask = (m, vs) => vs.reduce((s, v) => Math.max(s, m.mask[v]), 0);

/** mask が規約（0..1 / 有限）を満たしているか */
function checkRange(m, label) {
  let bad = 0, nan = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const x = m.mask[v];
    if (!Number.isFinite(x)) { nan++; continue; }
    if (x < 0 || x > 1) bad++;
  }
  ok(nan === 0, `${label}: NaN/Inf が ${nan} 個`);
  ok(bad === 0, `${label}: 0..1 の外の値が ${bad} 個`);
  return nan === 0 && bad === 0;
}

/** マスク以外（座標・トポロジ・色・法線）が一切変わっていないこと */
function snapshotGeom(m) {
  return {
    nv: m.nv, nt: m.nt, liveVerts: m.liveVerts, liveTris: m.liveTris,
    positions: m.positions.slice(0, m.nv * 3),
    normals: m.normals.slice(0, m.nv * 3),
    colors: m.colors.slice(0, m.nv * 3),
    tris: m.tris.slice(0, m.nt * 3),
  };
}
function checkGeomUntouched(m, s, label) {
  const errs = [];
  if (m.nv !== s.nv || m.nt !== s.nt) errs.push(`nv/nt が変わった ${s.nv}/${s.nt} → ${m.nv}/${m.nt}`);
  if (m.liveVerts !== s.liveVerts || m.liveTris !== s.liveTris) errs.push('liveVerts/liveTris が変わった');
  let dp = 0, dn = 0, dc = 0, dt = 0;
  for (let i = 0; i < s.positions.length; i++) if (m.positions[i] !== s.positions[i]) dp++;
  for (let i = 0; i < s.normals.length; i++) if (m.normals[i] !== s.normals[i]) dn++;
  for (let i = 0; i < s.colors.length; i++) if (m.colors[i] !== s.colors[i]) dc++;
  for (let i = 0; i < s.tris.length; i++) if (m.tris[i] !== s.tris[i]) dt++;
  if (dp) errs.push(`座標が ${dp} 成分変わった`);
  if (dn) errs.push(`法線が ${dn} 成分変わった`);
  if (dc) errs.push(`色が ${dc} 成分変わった`);
  if (dt) errs.push(`三角形が ${dt} 要素変わった`);
  ok(errs.length === 0, `${label}: マスク以外が変わっている [${errs.join(' / ')}]`);
}

/** ring 整合性と多様体性（マスク操作でトポロジが壊れていないことの確認） */
function validateTopology(m, label, closed = true) {
  const T = m.tris;
  const errs = [];
  for (let v = 0; v < m.nv; v++) {
    const r = m.ringArray(v);
    if (!m.vAlive[v]) { if (r && r.length) errs.push(`dead vert ${v} has ring`); continue; }
    for (const t of r) {
      const i = t * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) errs.push(`vert ${v} ring has dead tri ${t}`);
      if (T[i] !== v && T[i + 1] !== v && T[i + 2] !== v) errs.push(`vert ${v} ring tri ${t} 不整合`);
    }
  }
  const em = new Map();
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    for (const [u, w] of [[a, b], [b, c], [c, a]]) {
      const key = u < w ? u + ':' + w : w + ':' + u;
      em.set(key, (em.get(key) || 0) + 1);
    }
  }
  let bad = 0, boundary = 0;
  for (const [, n] of em) { if (n === 1) boundary++; else if (n !== 2) bad++; }
  if (bad) errs.push(`${bad} non-manifold edges`);
  if (closed && boundary) errs.push(`${boundary} boundary edges`);
  ok(errs.length === 0, `${label}: 多様体性が壊れた [${errs.slice(0, 4).join(' / ')}]`);
}

// ---------------------------------------------------------------------------
head('基本操作（clear / all / invert）');
{
  const m = sphere();
  const g = snapshotGeom(m);

  let r = maskAll(m);
  ok(r.changed === m.liveVerts, `maskAll で全頂点が変わる (${r.changed} == ${m.liveVerts})`);
  ok(r.masked === m.liveVerts && r.live === m.liveVerts, `統計が返る masked=${r.masked} live=${r.live}`);
  let allOne = true;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] !== 1) allOne = false;
  ok(allOne, 'maskAll で全部 1 になる');
  ok(maskAll(m).changed === 0, 'maskAll はべき等（2 回目は 0 変更）');

  r = invertMask(m);
  ok(r.changed === m.liveVerts && r.masked === 0, `invert で全部 0 になる (masked=${r.masked})`);
  ok(invertMask(m).changed === m.liveVerts, 'invert をもう一度で戻る');
  let backToOne = true;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] !== 1) backToOne = false;
  ok(backToOne, 'invert は可逆（2 回で元の値）');

  r = clearMask(m);
  ok(r.changed === m.liveVerts && r.masked === 0, 'clear で全部 0');
  ok(clearMask(m).changed === 0, 'clear はべき等');

  // 中間値の可逆性
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) m.mask[v] = (v % 7) / 6;
  const before = m.mask.slice(0, m.nv);
  invertMask(m); invertMask(m);
  let maxd = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) maxd = Math.max(maxd, Math.abs(m.mask[v] - before[v]));
  ok(maxd < 1e-6, `中間値でも invert x2 で元に戻る (最大差 ${maxd.toExponential(2)})`);
  checkRange(m, 'invert x2');
  checkGeomUntouched(m, g, '基本操作');
}

// ---------------------------------------------------------------------------
head('死んだスロットを触らないこと');
{
  const m = sphere();
  // 三角形と頂点を落として死んだスロットを作る
  const t0 = m.tris[0], t1 = m.tris[1], t2 = m.tris[2];
  m.removeTriangle(0);
  let dead = -1;
  for (const v of [t0, t1, t2]) {
    if (m.ringCount[v] === 0) { m.removeVertex(v); dead = v; break; }
  }
  if (dead < 0) {           // 孤立しなかった場合は使っていないスロットを 1 つ作る
    dead = m.addVertex(9, 9, 9);
    m.removeVertex(dead);
  }
  m.mask[dead] = 0.5;
  const r = maskAll(m);
  ok(m.mask[dead] === 0.5, '死んだ頂点のマスクは書き換えない');
  ok(r.live === m.liveVerts, `live 統計が生存数と一致 (${r.live} == ${m.liveVerts})`);
  ok(r.changed <= m.liveVerts, 'changed が生存数を超えない');
  blurMask(m, 2); growMask(m, 2); maskByNormal(m, [0, 1, 0], {});
  ok(m.mask[dead] === 0.5, 'ぼかし / 拡張 / 生成系でも死んだ頂点は触らない');
  validateTopology(m, '死んだスロットあり', false);   // 面を削ったので境界辺はある
}

// ---------------------------------------------------------------------------
head('ぼかし / シャープ');
{
  const m = sphere('sphereHi');
  const g = snapshotGeom(m);
  // 半分だけマスクした階段状の初期状態
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3] > 0 ? 1 : 0;

  // 隣接差の総和（境界のシャープさの指標）
  const contrast = () => {
    const T = m.tris;
    let s = 0, n = 0;
    for (let t = 0; t < m.nt; t++) {
      const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      s += Math.abs(m.mask[a] - m.mask[b]) + Math.abs(m.mask[b] - m.mask[c]) + Math.abs(m.mask[c] - m.mask[a]);
      n += 3;
    }
    return s / n;
  };
  const c0 = contrast();
  const r = blurMask(m, 3);
  const c1 = contrast();
  ok(c1 < c0, `ぼかしで隣接差が減る (${c0.toFixed(4)} → ${c1.toFixed(4)})`);
  ok(r.changed > 0, `ぼかしで頂点が変わる (${r.changed})`);
  checkRange(m, 'blur');

  const r2 = sharpenMask(m, 2);
  const c2 = contrast();
  ok(c2 > c1, `シャープで隣接差が増える (${c1.toFixed(4)} → ${c2.toFixed(4)})`);
  ok(r2.changed > 0, 'シャープで頂点が変わる');
  checkRange(m, 'sharpen');

  // 一様なマスクはぼかしても変わらない（1-ring 平均が自分と同じ）
  maskAll(m);
  ok(blurMask(m, 5).changed === 0, '一様マスクはぼかしても変化なし');
  ok(sharpenMask(m, 5).changed === 0, '一様マスクはシャープでも変化なし');
  clearMask(m);
  ok(blurMask(m, 5).changed === 0, '空マスクはぼかしても変化なし');

  // 反復回数が多いほど平坦化が進む（単調）
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3] > 0 ? 1 : 0;
  blurMask(m, 1);
  const cA = contrast();
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3] > 0 ? 1 : 0;
  blurMask(m, 6);
  const cB = contrast();
  ok(cB < cA, `回数が多いほどぼける (${cA.toFixed(4)} > ${cB.toFixed(4)})`);
  checkGeomUntouched(m, g, 'blur/sharpen');
}

// ---------------------------------------------------------------------------
head('拡張 / 収縮（grow / shrink）');
{
  const m = sphere();
  const g = snapshotGeom(m);

  // 1 頂点だけマスクして grow 1 段 → ちょうどその 1-ring だけが 1 になる
  clearMask(m);
  const seed = 100;
  m.mask[seed] = 1;
  const ring = [];
  m.oneRing(seed, ring);
  growMask(m, 1);
  let inside = 0, outside = 0;
  const ringSet = new Set(ring);
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    if (v === seed || ringSet.has(v)) { if (m.mask[v] === 1) inside++; }
    else if (m.mask[v] !== 0) outside++;
  }
  ok(inside === ring.length + 1, `grow 1 段で 1-ring がちょうど 1 になる (${inside} == ${ring.length + 1})`);
  ok(outside === 0, `grow 1 段で 1-ring の外へは漏れない (漏れ ${outside})`);

  // grow は単調非減少 / shrink は単調非増加
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) m.mask[v] = (v % 5 === 0) ? 1 : 0;
  let before = m.mask.slice(0, m.nv);
  growMask(m, 2);
  let dec = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] < before[v] - 1e-7) dec++;
  ok(dec === 0, `grow でマスクが減る頂点はない (${dec})`);

  before = m.mask.slice(0, m.nv);
  shrinkMask(m, 1);
  let inc = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] > before[v] + 1e-7) inc++;
  ok(inc === 0, `shrink でマスクが増える頂点はない (${inc})`);

  // 単一頂点は 1 段の shrink で消える（縁しかないので）
  clearMask(m);
  m.mask[seed] = 1;
  const rs = shrinkMask(m, 1);
  let any = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] > 0) any++;
  ok(any === 0, `孤立した 1 頂点は shrink で消える (残 ${any})`);
  ok(rs.changed === 1, `変更頂点数が 1 (${rs.changed})`);

  // grow → shrink（クロージング）はもとの領域を含む
  clearMask(m);
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.positions[v * 3] > 0.5) m.mask[v] = 1;
  const orig = m.mask.slice(0, m.nv);
  growMask(m, 2);
  shrinkMask(m, 2);
  let lost = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && orig[v] === 1 && m.mask[v] < 1 - 1e-6) lost++;
  ok(lost === 0, `grow→shrink で元の領域が失われない (${lost})`);
  checkRange(m, 'grow/shrink');

  // 全面マスクは grow しても飽和したまま / 空マスクは shrink しても空
  maskAll(m);
  ok(growMask(m, 3).changed === 0, '全面マスクは grow しても変わらない');
  clearMask(m);
  ok(shrinkMask(m, 3).changed === 0, '空マスクは shrink しても変わらない');
  checkGeomUntouched(m, g, 'grow/shrink');
}

// ---------------------------------------------------------------------------
head('キャビティ（曲率）');
{
  const m = dentedSphere();
  const g = snapshotGeom(m);
  const dent = region(m, [0.75, 0, 0], 0.3);
  const far = region(m, [-1, 0, 0], 0.4);
  ok(dent.length > 50 && far.length > 50, `検証用の領域が取れている (窪み ${dent.length} / 反対側 ${far.length})`);

  clearMask(m);
  let r = maskByCavity(m, { side: 'concave' });
  const dConc = meanMask(m, dent), fConc = meanMask(m, far);
  ok(dConc > fConc + 0.05, `凹モードで窪みの縁が強くマスクされる (窪み ${dConc.toFixed(3)} > 反対側 ${fConc.toFixed(3)})`);
  ok(maxMask(m, dent) > 0.5, `窪みに完全マスクに近い頂点がある (最大 ${maxMask(m, dent).toFixed(3)})`);
  ok(fConc < 0.02, `凸だけの面は凹モードでほぼ 0 (${fConc.toFixed(4)})`);
  checkRange(m, 'cavity concave');

  clearMask(m);
  r = maskByCavity(m, { side: 'convex' });
  const dConv = meanMask(m, dent), fConv = meanMask(m, far);
  ok(fConv > dConv, `凸モードでは向きが逆になる (窪み ${dConv.toFixed(3)} < 反対側 ${fConv.toFixed(3)})`);
  checkRange(m, 'cavity convex');

  clearMask(m);
  maskByCavity(m, { side: 'both' });
  const dBoth = meanMask(m, dent), fBoth = meanMask(m, far);
  ok(dBoth >= dConc - 1e-6 && fBoth >= fConv - 1e-6,
    `両方モードは凹・凸のどちらも拾う (窪み ${dBoth.toFixed(3)} / 反対側 ${fBoth.toFixed(3)})`);

  // 立方体の鋭いエッジは凸モードで選ばれ、凹モードでは選ばれない
  const c = sphere('cube');
  clearMask(c);
  const rc = maskByCavity(c, { side: 'convex' });
  ok(rc.masked > 100, `立方体の稜線が凸モードで選ばれる (${rc.masked} 頂点)`);
  clearMask(c);
  ok(maskByCavity(c, { side: 'concave' }).masked === 0, '立方体に凹はない');

  // ゲインを上げれば選ばれる量は増える（単調）
  let prev = -1, mono = true;
  for (const gain of [5, 10, 20, 40]) {
    clearMask(m);
    const n = maskByCavity(m, { side: 'concave', gain }).masked;
    if (n < prev) mono = false;
    prev = n;
  }
  ok(mono, 'ゲインを上げるとマスク面積が単調に増える');
  checkGeomUntouched(m, g, 'cavity');
  validateTopology(m, 'cavity');
}

// ---------------------------------------------------------------------------
head('AO（簡易アンビエントオクルージョン）');
{
  const m = dentedSphere();
  const g = snapshotGeom(m);
  const dent = region(m, [0.75, 0, 0], 0.3);
  const far = region(m, [-1, 0, 0], 0.4);

  clearMask(m);
  const r = maskByAmbientOcclusion(m, {});
  const dAO = meanMask(m, dent), fAO = meanMask(m, far);
  ok(dAO > fAO + 0.1, `窪みほど強くマスクされる (窪み ${dAO.toFixed(3)} > 反対側 ${fAO.toFixed(3)})`);
  ok(fAO < 0.01, `凸だけの面は AO ゼロ (${fAO.toFixed(4)})`);
  ok(r.changed > 0 && r.live === m.liveVerts, `統計が返る changed=${r.changed}`);
  checkRange(m, 'ao');

  // 決定的（レイもハッシュも使っていないので 2 回で完全一致）
  const first = m.mask.slice(0, m.nv);
  clearMask(m);
  maskByAmbientOcclusion(m, {});
  let diff = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] !== first[v]) diff++;
  ok(diff === 0, `同じ入力なら同じ結果 (差 ${diff})`);

  // 凸だけの形（球）と平面では何も出ない
  for (const name of ['sphere', 'sphereHi', 'plane', 'cube']) {
    const p = sphere(name);
    const rr = maskByAmbientOcclusion(p, {});
    ok(rr.masked === 0, `${name}: 窪みが無いので AO でマスクされない (${rr.masked})`);
    checkRange(p, `ao ${name}`);
  }

  // 段数を増やしても発散しない（0..1 のまま）
  for (const steps of [1, 3, 12, 24]) {
    clearMask(m);
    maskByAmbientOcclusion(m, { steps });
    if (!checkRange(m, `ao steps=${steps}`)) break;
  }
  // ゲインを上げると面積が単調に増える
  let prev = -1, mono = true;
  for (const gain of [5, 10, 20, 40]) {
    clearMask(m);
    const n = maskByAmbientOcclusion(m, { gain }).masked;
    if (n < prev) mono = false;
    prev = n;
  }
  ok(mono, 'ゲインを上げると AO のマスク面積が単調に増える');
  checkGeomUntouched(m, g, 'ao');
}

// ---------------------------------------------------------------------------
head('平坦部（smoothness）');
{
  // 平面は全面が平ら
  const p = sphere('plane');
  const rp = maskBySmoothness(p, {});
  ok(rp.masked === rp.live, `平面は全部マスクされる (${rp.masked}/${rp.live})`);
  checkRange(p, 'smoothness plane');

  // 窪みのある球では、曲がっている縁のほうがマスクが弱い
  const m = dentedSphere();
  const dent = region(m, [0.78, 0, 0], 0.22);
  const far = region(m, [-1, 0, 0], 0.4);
  clearMask(m);
  maskBySmoothness(m, {});
  ok(meanMask(m, dent) < meanMask(m, far),
    `曲がっている所は平坦部マスクが弱い (窪み ${meanMask(m, dent).toFixed(3)} < 反対側 ${meanMask(m, far).toFixed(3)})`);

  // 反転すると「ディテールのある所」になる
  const flat = m.mask.slice(0, m.nv);
  clearMask(m);
  maskBySmoothness(m, { invert: true });
  let maxd = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) maxd = Math.max(maxd, Math.abs(m.mask[v] - (1 - flat[v])));
  ok(maxd < 1e-6, `invert が 1 − 値と一致する (最大差 ${maxd.toExponential(2)})`);

  // 許容曲率を上げれば「平ら」と判定される範囲が広がる（単調）
  let prev = -1, mono = true;
  for (const tolerance of [0.01, 0.03, 0.08, 0.2]) {
    clearMask(m);
    const n = maskBySmoothness(m, { tolerance }).masked;
    if (n < prev) mono = false;
    prev = n;
  }
  ok(mono, '許容曲率を上げるとマスク面積が単調に増える');
  checkRange(m, 'smoothness');
}

// ---------------------------------------------------------------------------
head('色で選択（maskByColor）');
{
  const m = sphere('sphereHi');
  // x > 0 を赤、x <= 0 を青に塗る
  for (let v = 0; v < m.nv; v++) {
    const i = v * 3;
    const red = m.positions[i] > 0;
    m.colors[i] = red ? 1 : 0;
    m.colors[i + 1] = 0;
    m.colors[i + 2] = red ? 0 : 1;
  }
  const g = snapshotGeom(m);
  const r = maskByColor(m, [1, 0, 0], 0.3);
  let wrong = 0, right = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const red = m.positions[v * 3] > 0;
    if (red === (m.mask[v] > 0.5)) right++; else wrong++;
  }
  ok(wrong === 0, `赤い頂点だけがマスクされる (正 ${right} / 誤 ${wrong})`);
  ok(r.masked > 0 && r.masked < r.live, `半分だけ選ばれている (${r.masked}/${r.live})`);
  checkRange(m, 'color');

  // 許容差を広げれば両方入る
  const wide = maskByColor(m, [1, 0, 0], 3);
  ok(wide.masked === wide.live, `許容差を広げると全部入る (${wide.masked}/${wide.live})`);
  // 二値モードは 0 か 1 だけ
  clearMask(m);
  maskByColor(m, [1, 0, 0], 0.3, { hard: true });
  let mid = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] !== 0 && m.mask[v] !== 1) mid++;
  ok(mid === 0, `hard なら中間値が出ない (${mid})`);
  // 一致する色が無ければ何も選ばれない
  clearMask(m);
  ok(maskByColor(m, [0, 1, 0], 0.2).masked === 0, '無い色を指定すると何も選ばれない');
  checkGeomUntouched(m, g, 'color');
}

// ---------------------------------------------------------------------------
head('法線で選択（maskByNormal）');
{
  const m = sphere('sphereHi');
  const g = snapshotGeom(m);
  const r = maskByNormal(m, [0, 1, 0], { angle: 90 });
  let wrong = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    const up = m.normals[v * 3 + 1] > 0.02;
    const down = m.normals[v * 3 + 1] < -0.02;
    if (up && m.mask[v] <= 0) wrong++;
    if (down && m.mask[v] > 1e-6) wrong++;
  }
  ok(wrong === 0, `+Y 側の半球だけが選ばれる (誤 ${wrong})`);
  ok(r.masked > 0 && r.masked < r.live, `半球ぶんが選ばれている (${r.masked}/${r.live})`);
  checkRange(m, 'normal');

  // 角度を広げるとマスク面積が単調に増える
  let prev = -1, mono = true;
  for (const angle of [10, 30, 60, 90, 140, 180]) {
    clearMask(m);
    const n = maskByNormal(m, [0, 1, 0], { angle }).masked;
    if (n < prev) mono = false;
    prev = n;
  }
  ok(mono, '角度を広げるとマスク面積が単調に増える');
  clearMask(m);
  ok(maskByNormal(m, [0, 1, 0], { angle: 180, hard: true }).masked === m.liveVerts,
    '180 度（二値）なら全面が入る');
  clearMask(m);
  maskByNormal(m, [0, 1, 0], { angle: 180 });
  ok(Math.abs(m.mask[0] - (m.normals[1] + 1) * 0.5) < 1e-6,
    '180 度のランプは (法線・方向 + 1) / 2 になる');

  // 逆向きの指定は反転と一致する
  clearMask(m);
  maskByNormal(m, [0, 1, 0], { angle: 90, hard: true });
  const upMask = m.mask.slice(0, m.nv);
  clearMask(m);
  maskByNormal(m, [0, -1, 0], { angle: 90, hard: true });
  let overlap = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && upMask[v] > 0.5 && m.mask[v] > 0.5) overlap++;
  ok(overlap === 0, `+Y と −Y の二値マスクは重ならない (重複 ${overlap})`);

  // 方向が潰れていても壊れない
  clearMask(m);
  const zero = maskByNormal(m, [0, 0, 0], {});
  ok(zero.changed === 0, '長さ 0 の方向では何もしない');
  checkGeomUntouched(m, g, 'normal');
}

// ---------------------------------------------------------------------------
head('合成モード（置換 / 加算 / 減算）');
{
  const m = sphere('sphereHi');
  // 既存マスク: 下半球
  const base = () => {
    for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3 + 1] < 0 ? 0.5 : 0;
  };
  base();
  const before = m.mask.slice(0, m.nv);

  maskByNormal(m, [0, 1, 0], { angle: 90, hard: true, mode: 'replace' });
  let ok1 = true;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    if (m.normals[v * 3 + 1] < -0.02 && m.mask[v] !== 0) ok1 = false;   // 上書きされている
  }
  ok(ok1, '置換モードは既存マスクを上書きする');

  base();
  maskByNormal(m, [0, 1, 0], { angle: 90, hard: true, mode: 'add' });
  let dec = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] < before[v] - 1e-7) dec++;
  ok(dec === 0, `加算モードでマスクが減る頂点はない (${dec})`);
  let grew = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] > before[v] + 1e-7) grew++;
  ok(grew > 0, `加算モードで増えた頂点がある (${grew})`);
  checkRange(m, 'add');

  base();
  maskByNormal(m, [0, -1, 0], { angle: 90, hard: true, mode: 'sub' });
  let inc = 0, cleared = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v]) continue;
    if (m.mask[v] > before[v] + 1e-7) inc++;
    if (before[v] > 0 && m.mask[v] === 0) cleared++;
  }
  ok(inc === 0, `減算モードでマスクが増える頂点はない (${inc})`);
  ok(cleared > 0, `減算モードで削られた頂点がある (${cleared})`);
  checkRange(m, 'sub');

  // 飽和: 加算を繰り返しても 1 を超えない
  maskAll(m);
  const r = maskByNormal(m, [0, 1, 0], { angle: 180, mode: 'add' });
  ok(r.changed === 0, '既に 1 の所へ加算しても変化しない（飽和）');
  checkRange(m, 'add saturate');
  ok(MASK_MODES.length === 3, `MASK_MODES が 3 つ (${MASK_MODES.length})`);
}

// ---------------------------------------------------------------------------
head('マスクされた頂点はブラシで動かない');
{
  // マスク規約（1 = 保護）が実際にブラシで効いているかを検算する。
  // dynTopo はトポロジを変えてしまうので切っておく。
  const m = sphere('sphereHi');
  const state = makeState({ brush: 'clay', dynTopo: false, worldRadius: 0.5, strength: 1 });
  const s = new Sculptor(m, state);

  // +X から 45 度以内を完全マスク。ストロークはその境目（45 度の位置）に置くので
  // 1 つのブラシの中にマスク側と自由な側の両方が入る。
  maskByNormal(m, [1, 0, 0], { angle: 45, hard: true });
  // 「ブラシが実際に届く範囲の中にある保護頂点」だけを見る。全体から集めると
  // ブラシから遠い頂点が大量に混ざり、動かないのが当たり前になって検査が空振りする。
  const cc = Math.SQRT1_2;
  const locked = region(m, [cc, cc, 0], 0.45).filter(v => m.mask[v] === 1);
  ok(locked.length > 30, `ブラシの届く範囲に保護頂点がある (${locked.length})`);
  const before = m.positions.slice(0, m.nv * 3);
  const maskBefore = m.mask.slice(0, m.nv);

  for (const brush of ['clay', 'draw', 'inflate', 'crease', 'flatten', 'smooth', 'move', 'pinch']) {
    const pt = new Float32Array([cc, cc, 0]);
    s.beginStroke(brush, pt, 1);
    for (let k = 1; k <= 12; k++) {
      const a = k * 0.05;
      pt.set([cc, cc * Math.cos(a), cc * Math.sin(a)]);
      s.addSample(pt);
    }
    s.endStroke();
  }
  let moved = 0, maxd = 0;
  for (const v of locked) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(m.positions[v * 3 + k] - before[v * 3 + k]);
      if (d > maxd) maxd = d;
      if (d > 0) { moved++; break; }
    }
  }
  ok(moved === 0, `mask=1 の頂点は 1 mm も動かない (動いた ${moved} / 最大 ${maxd.toExponential(2)})`);
  let maskChanged = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] !== maskBefore[v]) maskChanged++;
  ok(maskChanged === 0, `彫刻でマスク自体は変わらない (${maskChanged})`);

  // マスクされていない側はちゃんと動いていること（テストが空振りしていない証明）
  let free = 0;
  for (let v = 0; v < m.nv; v++) {
    if (!m.vAlive[v] || m.mask[v] === 1) continue;
    if (m.positions[v * 3] !== before[v * 3]) free++;
  }
  ok(free > 50, `マスク外は彫刻されている (${free} 頂点が移動)`);
  validateTopology(m, 'ブラシ + マスク');
}

// ---------------------------------------------------------------------------
head('MASK_OPS / applyMaskOp');
{
  ok(MASK_OPS.length === MASK_OP_IDS.length, 'MASK_OP_IDS の数が一致');
  ok(new Set(MASK_OP_IDS).size === MASK_OP_IDS.length, 'id が重複していない');
  for (const op of MASK_OPS) {
    ok(typeof op.id === 'string' && op.id.length > 0, 'id がある');
    ok(typeof op.jp === 'string' && op.jp.length > 0, `${op.id}: jp がある`);
    ok(typeof op.hint === 'string' && op.hint.length > 0, `${op.id}: hint がある`);
    ok(Array.isArray(op.params), `${op.id}: params が配列`);
    ok(typeof op.run === 'function', `${op.id}: run がある`);
    ok(MASK_OP_BY_ID.get(op.id) === op, `${op.id}: 索引が張れている`);
    for (const p of op.params) {
      ok(typeof p.key === 'string' && p.key.length > 0, `${op.id}: params の key`);
      ok(typeof p.jp === 'string' && p.jp.length > 0, `${op.id}.${p.key}: jp がある`);
      ok(['int', 'float', 'bool', 'enum', 'color', 'vec3'].includes(p.type),
        `${op.id}.${p.key}: type が既知 (${p.type})`);
      ok(p.def !== undefined, `${op.id}.${p.key}: 既定値がある`);
      if (p.type === 'int' || p.type === 'float') {
        ok(typeof p.min === 'number' && typeof p.max === 'number' && typeof p.step === 'number',
          `${op.id}.${p.key}: min/max/step がある`);
        ok(p.def >= p.min && p.def <= p.max, `${op.id}.${p.key}: 既定値が範囲内 (${p.def})`);
      }
      if (p.type === 'enum') {
        ok(Array.isArray(p.options) && p.options.length > 0, `${op.id}.${p.key}: options がある`);
        ok(p.options.some(o => o.value === p.def), `${op.id}.${p.key}: 既定値が options にある`);
      }
    }
  }

  // 既定パラメータで全部走らせて、規約が保たれることを確認
  const m = dentedSphere();
  for (let v = 0; v < m.nv; v++) {
    const i = v * 3;
    m.colors[i] = m.positions[i] > 0 ? 1 : 0.2;
    m.colors[i + 1] = 0.2; m.colors[i + 2] = 0.6;
    m.mask[v] = (v % 3 === 0) ? 0.7 : 0;
  }
  const g = snapshotGeom(m);
  for (const id of MASK_OP_IDS) {
    const r = applyMaskOp(m, id, {});
    ok(r.id === id, `applyMaskOp('${id}') が id を返す`);
    ok(Number.isInteger(r.changed) && r.changed >= 0 && r.changed <= m.liveVerts,
      `${id}: changed が妥当 (${r.changed})`);
    ok(r.live === m.liveVerts, `${id}: live が生存数と一致`);
    checkRange(m, `applyMaskOp ${id}`);
  }
  checkGeomUntouched(m, g, 'applyMaskOp 全部');
  validateTopology(m, 'applyMaskOp 全部');

  // 全モード × 全 op の組み合わせでも規約が壊れない
  for (const id of MASK_OP_IDS) {
    for (const mode of ['replace', 'add', 'sub']) {
      applyMaskOp(m, id, { mode, invert: true });
      if (!checkRange(m, `${id} mode=${mode} invert`)) break;
    }
  }

  // 未知の id / 空メッシュでも落ちない
  const unknown = applyMaskOp(m, 'そんなものはない', {});
  ok(unknown.changed === 0 && unknown.id === 'そんなものはない', '未知の id は 0 変更で返る');
  const empty = new SculptMesh();
  for (const id of MASK_OP_IDS) {
    const r = applyMaskOp(empty, id, {});
    ok(r.changed === 0, `空メッシュでも ${id} が落ちない`);
  }
}

// ---------------------------------------------------------------------------
head('applyMaskOp が MASK_OPS の既定値を使う');
{
  // 既定値が「表の def」と「関数の既定引数」の 2 か所に書かれているので、
  // applyMaskOp が本当に表を見ているかを確かめる。blur だけ表の既定（2 回）が
  // 関数の既定（1 回）と違うので、ここが唯一の観測点になる。
  const stripe = (m) => { for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3] > 0 ? 1 : 0; };
  const a = sphere('sphereHi'), b = sphere('sphereHi'), c = sphere('sphereHi');
  stripe(a); stripe(b); stripe(c);
  applyMaskOp(a, 'blur', {});
  blurMask(b, 2, { amount: 0.7 });
  blurMask(c, 1, { amount: 0.7 });
  let same = 0, diff = 0;
  for (let v = 0; v < a.nv; v++) {
    if (Math.abs(a.mask[v] - b.mask[v]) > 1e-7) same++;
    if (Math.abs(a.mask[v] - c.mask[v]) > 1e-7) diff++;
  }
  ok(same === 0, `applyMaskOp('blur') が表の既定 iterations=2 を使う (差 ${same})`);
  ok(diff > 0, `1 回だけの結果とは別物（検査が空振りしていない証明: 差 ${diff}）`);

  // 明示的に渡した値は既定を上書きし、直接呼びと一致する
  const d = sphere('sphereHi'), e = sphere('sphereHi');
  clearMask(d); clearMask(e);
  d.mask[100] = 1; e.mask[100] = 1;
  applyMaskOp(d, 'grow', { steps: 3 });
  growMask(e, 3);
  let g3 = 0;
  for (let v = 0; v < d.nv; v++) if (d.mask[v] !== e.mask[v]) g3++;
  ok(g3 === 0, `明示した opts が既定を上書きする (差 ${g3})`);
  ok(applyMaskOp(d, 'grow', { steps: 1 }).changed < applyMaskOp(e, 'grow', { steps: 5 }).changed,
    '段数の指定が実際に効いている');
}

// ---------------------------------------------------------------------------
head('壊れた入力（NaN / Inf / 範囲外）を持ち込まない');
{
  // マスクは保存ファイルや他のモジュール経由で外から入ってくる。1 個でも NaN が
  // 残るとブラシ側の f *= (1 - mask) が NaN になり、その頂点の座標が壊れる。
  const broken = () => {
    const m = sphere();
    m.mask[0] = NaN; m.mask[1] = Infinity; m.mask[2] = -Infinity;
    m.mask[3] = -5; m.mask[4] = 7; m.mask[5] = 0.5;
    return m;
  };
  for (const id of MASK_OP_IDS) {
    const m = broken();
    applyMaskOp(m, id, {});
    checkRange(m, `壊れた入力 → ${id}`);
  }
  for (const [name, fn] of [
    ['invertMask', (m) => invertMask(m)],
    ['blurMask', (m) => blurMask(m, 3)],
    ['sharpenMask', (m) => sharpenMask(m, 3)],
    ['growMask', (m) => growMask(m, 2)],
    ['shrinkMask', (m) => shrinkMask(m, 2)],
    ['maskByColor', (m) => maskByColor(m, [1, 0, 0], 0.3, { mode: 'add' })],
    ['maskByNormal', (m) => maskByNormal(m, [0, 1, 0], { mode: 'sub', invert: true })],
  ]) {
    const m = broken();
    fn(m);
    checkRange(m, `壊れた入力 → ${name}`);
  }

  // NaN が 1-ring 拡散で近傍へ広がらないこと。広がると最後の clamp が
  // まとめて 0 に落とすので「1 個の壊れた値でマスクが広範囲に消える」事故になる。
  const m = sphere('sphereHi');
  maskAll(m);
  m.mask[500] = NaN;
  blurMask(m, 6, { amount: 1 });
  let lost = 0;
  for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] < 0.9) lost++;
  ok(lost === 0, `NaN 1 個が近傍のマスクを消さない (0.9 未満になった頂点 ${lost})`);
  checkRange(m, 'NaN + blur');

  // 曲率 / 色 / 法線が壊れていても 0..1 を守る（recompute を切って残す）
  const c = sphere();
  c.curv[5] = NaN; c.curv[6] = Infinity;
  maskByCavity(c, { recompute: false });
  checkRange(c, '壊れた curv → cavity');
  clearMask(c);
  c.curv[5] = NaN;
  maskByAmbientOcclusion(c, { recompute: false });
  checkRange(c, '壊れた curv → ao');
  clearMask(c);
  c.curv[5] = NaN;
  maskBySmoothness(c, { recompute: false });
  checkRange(c, '壊れた curv → smoothness');
  const n2 = sphere();
  n2.normals[3] = NaN;
  maskByNormal(n2, [0, 1, 0], {});
  checkRange(n2, '壊れた法線 → normal');
  const c2 = sphere();
  c2.colors[3] = NaN;
  maskByColor(c2, [1, 1, 1], 0.3);
  checkRange(c2, '壊れた色 → color');

  // 壊れた値は「あらかじめ 0..1 に畳んだ値」とまったく同じ結果を出すこと。
  // これが全 op × 全モードで成り立っていれば、NaN が近傍へ漏れる経路や
  // invert / 加算・減算だけ砦をすり抜ける経路が残っていないと言い切れる。
  {
    const fold = (x) => (x > 0 ? (x > 1 ? 1 : x) : 0);
    const BAD = [NaN, Infinity, -Infinity, -5, 7, 0.5, 0, 1];
    const a = sphere(), b = sphere();
    for (const id of MASK_OP_IDS) {
      for (const extra of [{}, { invert: true }, { mode: 'add' }, { mode: 'sub' },
        { mode: 'add', invert: true }, { mode: 'sub', invert: true }]) {
        for (let v = 0; v < a.nv; v++) { a.mask[v] = 0.25; b.mask[v] = 0.25; }
        for (let k = 0; k < BAD.length; k++) { a.mask[k] = BAD[k]; b.mask[k] = fold(BAD[k]); }
        applyMaskOp(a, id, extra);
        applyMaskOp(b, id, extra);
        let d = 0;
        for (let v = 0; v < a.nv; v++) if (a.vAlive[v] && a.mask[v] !== b.mask[v]) d++;
        ok(d === 0, `${id} ${JSON.stringify(extra)}: 壊れた値を畳んだ値と同じに扱う (差 ${d})`);
      }
    }
  }

  // invert は「1 − 非反転の結果」と厳密に一致すること。生成元（曲率）が壊れていても
  // 成り立つ＝NaN を 0 に落とす砦が invert より前にあることの検査。
  for (const [name, fn] of [
    ['cavity', (m, o) => maskByCavity(m, Object.assign({ recompute: false }, o))],
    ['ao', (m, o) => maskByAmbientOcclusion(m, Object.assign({ recompute: false }, o))],
    ['smoothness', (m, o) => maskBySmoothness(m, Object.assign({ recompute: false }, o))],
  ]) {
    const p = sphere(), q = sphere();
    p.curv[7] = NaN; p.curv[8] = Infinity; p.curv[9] = -Infinity;
    for (let v = 0; v < q.nv; v++) q.curv[v] = p.curv[v];
    clearMask(p); clearMask(q);
    fn(p, {});
    fn(q, { invert: true });
    let d = 0;
    for (let v = 0; v < p.nv; v++) {
      if (p.vAlive[v] && Math.abs((1 - p.mask[v]) - q.mask[v]) > 1e-6) d++;
    }
    ok(d === 0, `${name}: 壊れた曲率でも invert が 1 − 非反転と一致する (差 ${d})`);
    checkRange(q, `壊れた曲率 → ${name} invert`);
  }

  // 範囲外の値を含むマスクでも収縮の向きは正しい（入口で畳めば 7 は 1 扱い）
  const s = sphere();
  clearMask(s);
  for (let v = 0; v < s.nv; v++) if (s.vAlive[v] && s.positions[v * 3] > 0.3) s.mask[v] = 7;
  const raw = s.mask.slice(0, s.nv);
  shrinkMask(s, 1);
  let inc = 0;
  for (let v = 0; v < s.nv; v++) {
    if (!s.vAlive[v]) continue;
    const cl = raw[v] < 0 ? 0 : (raw[v] > 1 ? 1 : raw[v]);
    if (s.mask[v] > cl + 1e-7) inc++;
  }
  ok(inc === 0, `範囲外の値を含むマスクでも shrink で増えない (${inc})`);
  checkRange(s, '範囲外 → shrink');
}

// ---------------------------------------------------------------------------
head('退化三角形 / 非正規化ベクトル');
{
  // 削除された三角形は (0,0,0) になる。1-ring 和の走査でこれを飛ばさないと
  // 頂点 0 だけが「自分を 2 回足す」ことになり、平均が自分寄りに偏る。
  const m = sphere();
  for (let t = 0; t < 12; t++) m.removeTriangle(t);
  let deg = 0;
  for (let t = 0; t < m.nt; t++) if (!m.isTriAlive(t)) deg++;
  ok(deg > 0 && m.ringCount[0] > 0, `前提: 退化三角形 ${deg} 個 / 頂点 0 は生きている (ring ${m.ringCount[0]})`);
  clearMask(m);
  m.mask[0] = 1;
  blurMask(m, 1, { amount: 1 });     // lambda=1 → 純粋な 1-ring 平均
  ok(m.mask[0] === 0, `退化三角形が頂点 0 の 1-ring 平均を汚さない (mask[0]=${m.mask[0]})`);
  validateTopology(m, '退化三角形あり', false);

  // UI からは長さ 1 でない方向ベクトルが来る。正規化していれば結果は同じになる
  const a = sphere('sphereHi');
  maskByNormal(a, [0, 1, 0], { angle: 60 });
  for (const dir of [[0, 5, 0], [0, 0.2, 0], [0, 1e4, 0]]) {
    const b = sphere('sphereHi');
    maskByNormal(b, dir, { angle: 60 });
    let d = 0;
    for (let v = 0; v < a.nv; v++) if (Math.abs(a.mask[v] - b.mask[v]) > 1e-7) d++;
    ok(d === 0, `dir=[${dir}] の長さが結果に影響しない (差 ${d})`);
  }
}

// ---------------------------------------------------------------------------
head('しきい値 / バイアスが効いていること');
{
  // ゲインは既存のテストで見ているが、しきい値とバイアス（ノイズを切る側の
  // つまみ）を無視していても気づかなかったので、逆向きの単調性も検算する。
  const m = dentedSphere();
  const area = (fn) => { clearMask(m); return fn().masked; };

  let prev = Infinity, mono = true;
  const seen = [];
  for (const threshold of [0, 0.005, 0.02, 0.06]) {
    const n = area(() => maskByCavity(m, { side: 'concave', gain: 40, threshold }));
    seen.push(n);
    if (n > prev) mono = false;
    prev = n;
  }
  ok(mono, `しきい値を上げるとキャビティの面積が単調に減る (${seen.join(' → ')})`);
  ok(seen[0] > seen[seen.length - 1], `しきい値が結果を変えている (${seen[0]} → ${seen[seen.length - 1]})`);

  prev = Infinity; mono = true;
  const seenB = [];
  for (const bias of [-0.02, 0, 0.01, 0.03]) {
    const n = area(() => maskByAmbientOcclusion(m, { gain: 40, bias }));
    seenB.push(n);
    if (n > prev) mono = false;
    prev = n;
  }
  ok(mono, `バイアスを上げると AO の面積が単調に減る (${seenB.join(' → ')})`);
  ok(seenB[0] > seenB[seenB.length - 1], `バイアスが結果を変えている (${seenB[0]} → ${seenB[seenB.length - 1]})`);

  // 色の許容差も同じく逆向きの単調性を持つ
  const c = sphere('sphereHi');
  for (let v = 0; v < c.nv; v++) {
    const i = v * 3;
    c.colors[i] = c.positions[i] > 0 ? 1 : 0.4; c.colors[i + 1] = 0.1; c.colors[i + 2] = 0.1;
  }
  prev = -1; mono = true;
  for (const tol of [0.05, 0.2, 0.5, 1.5]) {
    clearMask(c);
    const n = maskByColor(c, [1, 0.1, 0.1], tol).masked;
    if (n < prev) mono = false;
    prev = n;
  }
  ok(mono, '許容差を広げると色マスクの面積が単調に増える');
}

// ---------------------------------------------------------------------------
head('AO の拡散が効いていること');
{
  // 段数と広がり幅が実際にマスクの及ぶ範囲を変えること（拡散が死んでいたら
  // 種の位置から動かないので、段数を増やしても範囲が広がらない）。
  const m = dentedSphere();
  const spread = (opts) => {
    clearMask(m);
    maskByAmbientOcclusion(m, opts);
    let n = 0;
    for (let v = 0; v < m.nv; v++) if (m.vAlive[v] && m.mask[v] > 0.01) n++;
    return n;
  };
  const s1 = spread({ steps: 1 }), s8 = spread({ steps: 8 }), s16 = spread({ steps: 16 });
  ok(s8 > s1 && s16 > s8, `段数を増やすと AO の及ぶ範囲が広がる (${s1} → ${s8} → ${s16})`);
  const w1 = spread({ spread: 0.05 }), w9 = spread({ spread: 0.9 });
  ok(w9 > w1, `広がり幅 (spread) が範囲を変える (${w1} → ${w9})`);
}

// ---------------------------------------------------------------------------
head('何もしなかったときの統計');
{
  // masked は UI にそのまま出す値なので、no-op の経路でも実際のマスク面積を
  // 返さないといけない（0 を返すと「マスクが全部消えた」と読めてしまう）。
  const m = sphere();
  maskAll(m);
  const z = maskByNormal(m, [0, 0, 0], {});
  ok(z.changed === 0, '長さ 0 の方向では何も変えない');
  ok(z.masked === m.liveVerts, `no-op でも masked が実際の面積 (${z.masked} == ${m.liveVerts})`);
  ok(z.live === m.liveVerts, 'no-op でも live が返る');
  const u = applyMaskOp(m, 'そんな id はない', {});
  ok(u.changed === 0 && u.masked === m.liveVerts, `未知の id でも masked が実際の面積 (${u.masked})`);
  clearMask(m);
  ok(maskByNormal(m, [0, 0, 0], {}).masked === 0, 'マスクが空なら no-op でも 0');
  // dir を渡し忘れたときは +Y にフォールバックする（rgb の白と同じ扱い）。
  // 一方 [] や [0,0,0] は「潰れた方向」なので no-op。
  clearMask(m);
  maskByNormal(m, null, { angle: 60 });
  const nullDir = m.mask.slice(0, m.nv);
  clearMask(m);
  maskByNormal(m, [0, 1, 0], { angle: 60 });
  let dn = 0;
  for (let v = 0; v < m.nv; v++) if (nullDir[v] !== m.mask[v]) dn++;
  ok(dn === 0, `dir が null なら +Y と同じ扱い (差 ${dn})`);
  ok(maskByNormal(m, [], {}).changed === 0, '空配列の dir は no-op');
  ok(maskByColor(m, null, 0.3).live === m.liveVerts, 'rgb が null でも落ちない');
}

// ---------------------------------------------------------------------------
head('一時配列の解放後も動く（releaseScratch）');
{
  const m = sphere();
  maskAll(m);
  releaseScratch();
  const r = blurMask(m, 2);
  ok(r.live === m.liveVerts, '解放直後の blur が動く');
  checkRange(m, 'releaseScratch → blur');
  releaseScratch();
  maskByAmbientOcclusion(m, {});          // _acc も作り直される経路
  checkRange(m, 'releaseScratch → ao');
  // 小さいメッシュ → 大きいメッシュの順でも一時配列が足りること
  releaseScratch();
  blurMask(sphere(), 1);
  const big = sphere('sphereHi');
  for (let v = 0; v < big.nv; v++) big.mask[v] = (v % 3 === 0) ? 1 : 0;
  const rb = growMask(big, 2);
  ok(rb.changed > 0, `小 → 大の順でも一時配列が足りる (${rb.changed})`);
  checkRange(big, '小→大の grow');
}

// ---------------------------------------------------------------------------
head('markAllDirty が呼ばれる（GPU 転送）');
{
  const m = sphere();
  for (const id of MASK_OP_IDS) {
    m.clearDirty();
    applyMaskOp(m, id, {});
    ok(m.vDirtyMin === 0 && m.vDirtyMax === m.nv - 1,
      `${id}: 頂点 dirty レンジが全体になる (${m.vDirtyMin}..${m.vDirtyMax})`);
  }
}

// ---------------------------------------------------------------------------
head('計算量（頂点数に比例していること）');
{
  const times = [];
  for (const sub of [4, 5, 6, 7]) {
    const g = icosphere(sub, 1);
    const m = new SculptMesh();
    m.setGeometry(g.positions, g.indices);
    for (let v = 0; v < m.nv; v++) m.mask[v] = (v % 4 === 0) ? 1 : 0;
    for (const id of MASK_OP_IDS) applyMaskOp(m, id, {});   // JIT の暖機
    const t0 = performance.now();
    for (const id of MASK_OP_IDS) applyMaskOp(m, id, {});
    const ms = performance.now() - t0;
    times.push({ nv: m.liveVerts, ms });
    console.log(`  ${m.liveVerts.toLocaleString()} 頂点: 全 ${MASK_OP_IDS.length} 操作で ${ms.toFixed(1)} ms`);
    checkRange(m, `perf sub=${sub}`);
  }
  // 比は大きい 2 つで見る。小さいメッシュは測定誤差と暖機の影響が大きすぎる。
  const a = times[times.length - 2], b = times[times.length - 1];
  const sizeRatio = b.nv / a.nv;
  const timeRatio = b.ms / Math.max(0.05, a.ms);
  console.log(`  頂点数 ${sizeRatio.toFixed(1)} 倍で時間 ${timeRatio.toFixed(1)} 倍`);
  ok(timeRatio < sizeRatio * 3, `時間が頂点数にほぼ比例している（O(n²) でない）: ${timeRatio.toFixed(1)} 倍`);
  // 16 万頂点で全操作 1 巡が 1 秒以内なら、300 万頂点でも単発操作は数百 ms に収まる
  ok(b.ms < 1000, `16 万頂点で全操作が 1 秒以内 (${b.ms.toFixed(0)} ms)`);
}

console.log(`  ok   ${checks - sectionStart} 件`);
console.log('\n' + (failures === 0 ? `✅ すべて通過（${checks} 件の検査）` : `❌ ${checks} 件中 ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
