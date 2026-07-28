// ---------------------------------------------------------------------------
// dyntopo.js
// 動的トポロジ（Sculptris Pro 相当）: ブラシ領域内で辺分割 / 辺コラプスを行い、
// 目標エッジ長に近づける。
//
// SculptMesh は削除時にインデックスを詰めないため、ここで保持する頂点 ID / 三角形 ID は
// 操作をまたいでも有効（生存チェックだけすればよい）。
// ---------------------------------------------------------------------------

import { MAX_VERTS_HARD } from './mesh.js';

const _sh = [];
const _ringA = [];
const _ringB = [];
const _one = [0];

/** (p,q) が辺になるよう三角形の巡回順を回して [p, q, opposite] を返す */
function rotateToEdge(T, i, a, b) {
  const v0 = T[i], v1 = T[i + 1], v2 = T[i + 2];
  if ((v0 === a && v1 === b) || (v0 === b && v1 === a)) return [v0, v1, v2];
  if ((v1 === a && v2 === b) || (v1 === b && v2 === a)) return [v1, v2, v0];
  if ((v2 === a && v0 === b) || (v2 === b && v0 === a)) return [v2, v0, v1];
  return null;
}

/**
 * 辺 (a,b) を中点で分割する。隣接する 1 ～ 2 枚の三角形が 2 枚ずつになる。
 * 巻き方向は保存される。新しい頂点 ID を返す（失敗時 -1）。
 */
export function splitEdge(mesh, a, b) {
  mesh.trianglesWithEdge(a, b, _sh);
  if (_sh.length === 0) return -1;
  const shared = _sh.slice();

  const m = mesh.addVertexOnEdge(a, b, 0.5);
  const T = mesh.tris;
  for (let k = 0; k < shared.length; k++) {
    const t = shared[k];
    const rot = rotateToEdge(T, t * 3, a, b);
    if (!rot) continue;
    const [p, q, c] = rot;
    mesh.setTriangle(t, p, m, c);
    mesh.addTriangle(m, q, c);
  }
  // 新頂点はリングが確定したので正しい面積加重法線に置き換える
  _one[0] = m;
  mesh.computeNormalsFor(_one, 1);
  return m;
}

function triNormal(P, ia, ib, ic, out) {
  const a = ia * 3, b = ib * 3, c = ic * 3;
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  out[0] = e1y * e2z - e1z * e2y;
  out[1] = e1z * e2x - e1x * e2z;
  out[2] = e1x * e2y - e1y * e2x;
  return out;
}

const _n0 = new Float64Array(3);
const _n1 = new Float64Array(3);

/**
 * 辺 (a,b) をコラプスして b を a に統合する。
 * 多様体性を壊さない link condition と法線反転チェックを通った場合のみ実行。
 */
export function collapseEdge(mesh, a, b, maxValence = 16) {
  if (!mesh.isVertAlive(a) || !mesh.isVertAlive(b)) return false;

  mesh.trianglesWithEdge(a, b, _sh);
  if (_sh.length !== 2) return false;              // 境界 / 非多様体は触らない
  const shared = [_sh[0], _sh[1]];

  mesh.oneRing(a, _ringA);
  mesh.oneRing(b, _ringB);
  let common = 0;
  for (let i = 0; i < _ringA.length; i++) {
    if (_ringB.indexOf(_ringA[i]) >= 0) common++;
  }
  if (common !== 2) return false;                  // link condition
  if (_ringA.length + _ringB.length - 4 > maxValence) return false;

  const P = mesh.positions;
  const ia = a * 3, ib = b * 3;
  const nax = P[ia], nay = P[ia + 1], naz = P[ia + 2];
  const nbx = P[ib], nby = P[ib + 1], nbz = P[ib + 2];
  const px = (nax + nbx) * 0.5, py = (nay + nby) * 0.5, pz = (naz + nbz) * 0.5;

  // --- 反転 / 退化チェック（実際に動かす前に予測法線で判定） ---
  const ringA = mesh.ring[a], ringB = mesh.ring[b];
  const check = (tris, moved) => {
    for (let k = 0; k < tris.length; k++) {
      const t = tris[k];
      if (t === shared[0] || t === shared[1]) continue;
      const i = t * 3, T = mesh.tris;
      triNormal(P, T[i], T[i + 1], T[i + 2], _n0);
      const v0 = T[i] === moved ? a : T[i];
      const v1 = T[i + 1] === moved ? a : T[i + 1];
      const v2 = T[i + 2] === moved ? a : T[i + 2];
      if (v0 === v1 || v1 === v2 || v2 === v0) return false;
      // a を統合後の位置に一時的に差し替えて法線を予測する
      const si = a * 3;
      const sx = P[si], sy = P[si + 1], sz = P[si + 2];
      P[si] = px; P[si + 1] = py; P[si + 2] = pz;
      triNormal(P, v0, v1, v2, _n1);
      P[si] = sx; P[si + 1] = sy; P[si + 2] = sz;
      const d = _n0[0] * _n1[0] + _n0[1] * _n1[1] + _n0[2] * _n1[2];
      const l1 = _n1[0] * _n1[0] + _n1[1] * _n1[1] + _n1[2] * _n1[2];
      if (d <= 0 || l1 < 1e-24) return false;
    }
    return true;
  };
  if (!check(ringB, b)) return false;
  if (!check(ringA, a)) return false;

  // --- 実行 ---
  P[ia] = px; P[ia + 1] = py; P[ia + 2] = pz;
  const C = mesh.colors;
  C[ia] = (C[ia] + C[ib]) * 0.5;
  C[ia + 1] = (C[ia + 1] + C[ib + 1]) * 0.5;
  C[ia + 2] = (C[ia + 2] + C[ib + 2]) * 0.5;
  mesh.mask[a] = (mesh.mask[a] + mesh.mask[b]) * 0.5;
  mesh.markVert(a);

  mesh.removeTriangle(shared[0]);
  mesh.removeTriangle(shared[1]);

  const bt = mesh.ring[b].slice();
  const T = mesh.tris;
  for (let k = 0; k < bt.length; k++) {
    const t = bt[k], i = t * 3;
    mesh.setTriangle(t, T[i] === b ? a : T[i], T[i + 1] === b ? a : T[i + 1], T[i + 2] === b ? a : T[i + 2]);
  }
  mesh.removeVertex(b);
  return true;
}

const _touchedVerts = [];
// コラプス候補の辺。ダブごとに確保し直さないようモジュールスコープで使い回す
let _edgeA = new Int32Array(0);
let _edgeB = new Int32Array(0);
let _edgeL = new Float64Array(0);
let _edgeOrder = new Int32Array(0);
const _orderList = [];
const _considerBuf = [];
const _freshTris = [];

/**
 * ブラシ領域を目標エッジ長に合わせて再分割 / 間引きする。
 *
 * @param {SculptMesh} mesh
 * @param {number[]} regionTris  領域内の三角形 ID
 * @param {number[]} center      ブラシ中心 (world)
 * @param {number} radius        ブラシ半径 (world)
 * @param {number} targetLen     目標エッジ長 (world)
 * @param {object} opt {subdivide, decimate, maxVerts, maxNewPerStep}
 * @returns {boolean} トポロジが変化したか
 */
export function refineRegion(mesh, regionTris, center, radius, targetLen, opt = {}) {
  const doSplit = opt.subdivide !== false;
  const doCollapse = opt.decimate === true;
  const maxVerts = Math.min(opt.maxVerts || 1200000, MAX_VERTS_HARD);
  // 1 ダブの領域は数百頂点なので、1 万を超える生成は明らかに異常系。低めに抑える
  const maxNew = opt.maxNewPerStep || 4000;

  // 分割 / コラプスのしきい値。目標長を挟んでヒステリシスを持たせ、
  // 同じ辺が分割と統合を往復するのを防ぐ。コラプス側は既存ディテールを
  // 壊しすぎないよう控えめにしてある。
  const splitLen = targetLen * 1.45;
  const collapseLen = targetLen * 0.45;
  const r2 = (radius * 1.15) * (radius * 1.15);
  const cx = center[0], cy = center[1], cz = center[2];
  const P = mesh.positions;
  let changed = false;

  // 領域の三角形リストは使い回しの配列にコピーする（ダブごとの slice を避ける）
  const consider = _considerBuf;
  consider.length = 0;
  for (let k = 0; k < regionTris.length; k++) consider.push(regionTris[k]);

  // ---- 分割パス --------------------------------------------------------
  if (doSplit && mesh.liveVerts < maxVerts) {
    let created = 0;
    const sl2 = splitLen * splitLen;
    for (let pass = 0; pass < 5; pass++) {
      _freshTris.length = 0;
      mesh.trackTris = _freshTris;
      let splits = 0;
      const T = mesh.tris;
      for (let k = 0; k < consider.length; k++) {
        const t = consider[k];
        const i = t * 3;
        const i0 = T[i], i1 = T[i + 1], i2 = T[i + 2];
        if (i0 === i1 && i1 === i2) continue;                 // 死んだ三角形
        // 最長辺を選ぶ（配列を作らずスカラで持つ。ここは毎ダブ数千回通る）
        const p0 = i0 * 3, p1 = i1 * 3, p2 = i2 * 3;
        const x0 = P[p0], y0 = P[p0 + 1], z0 = P[p0 + 2];
        const x1 = P[p1], y1 = P[p1 + 1], z1 = P[p1 + 2];
        const x2 = P[p2], y2 = P[p2 + 1], z2 = P[p2 + 2];
        const d01 = (x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2;
        const d12 = (x2 - x1) ** 2 + (y2 - y1) ** 2 + (z2 - z1) ** 2;
        const d20 = (x0 - x2) ** 2 + (y0 - y2) ** 2 + (z0 - z2) ** 2;
        let bestLen, ba, bb, bmx, bmy, bmz;
        if (d01 >= d12 && d01 >= d20) {
          bestLen = d01; ba = i0; bb = i1;
          bmx = (x0 + x1) * 0.5; bmy = (y0 + y1) * 0.5; bmz = (z0 + z1) * 0.5;
        } else if (d12 >= d20) {
          bestLen = d12; ba = i1; bb = i2;
          bmx = (x1 + x2) * 0.5; bmy = (y1 + y2) * 0.5; bmz = (z1 + z2) * 0.5;
        } else {
          bestLen = d20; ba = i2; bb = i0;
          bmx = (x2 + x0) * 0.5; bmy = (y2 + y0) * 0.5; bmz = (z2 + z0) * 0.5;
        }
        if (bestLen <= sl2) continue;
        const ddx = bmx - cx, ddy = bmy - cy, ddz = bmz - cz;
        if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue;
        if (splitEdge(mesh, ba, bb) >= 0) { splits++; created++; }
        if (mesh.liveVerts >= maxVerts || created >= maxNew) break;
      }
      mesh.trackTris = null;
      if (splits > 0) changed = true;
      if (splits === 0 || mesh.liveVerts >= maxVerts || created >= maxNew) break;
      // 分割で作られた三角形も次パスで再チェックする
      for (let k = 0; k < _freshTris.length; k++) consider.push(_freshTris[k]);
    }
  }

  // ---- コラプスパス ----------------------------------------------------
  if (doCollapse) {
    // 重複除去に Set を使うとダブごとに数千要素の確保が走るのでやめた。
    // 同じ辺が 2 回入っても、2 回目は生存チェックと長さ再計算で O(1) に弾かれる。
    const T = mesh.tris;
    const cr2 = radius * radius;
    const cl2 = collapseLen * collapseLen;
    let ne = 0;
    if (_edgeA.length < consider.length * 3) {
      const cap = Math.max(1024, consider.length * 4);
      _edgeA = new Int32Array(cap);
      _edgeB = new Int32Array(cap);
      _edgeL = new Float64Array(cap);
      _edgeOrder = new Int32Array(cap);
    }
    for (let k = 0; k < consider.length; k++) {
      const t = consider[k];
      if (!mesh.isTriAlive(t)) continue;
      const i = t * 3;
      const v0 = T[i], v1 = T[i + 1], v2 = T[i + 2];
      for (let e = 0; e < 3; e++) {
        let a = e === 0 ? v0 : (e === 1 ? v1 : v2);
        let b = e === 0 ? v1 : (e === 1 ? v2 : v0);
        if (a > b) { const s = a; a = b; b = s; }
        const pa = a * 3, pb = b * 3;
        const dx = P[pb] - P[pa], dy = P[pb + 1] - P[pa + 1], dz = P[pb + 2] - P[pa + 2];
        const l2 = dx * dx + dy * dy + dz * dz;
        if (l2 >= cl2) continue;
        // 両端がブラシ球内に入っている辺のみ
        const da = (P[pa] - cx) ** 2 + (P[pa + 1] - cy) ** 2 + (P[pa + 2] - cz) ** 2;
        if (da > cr2) continue;
        const db = (P[pb] - cx) ** 2 + (P[pb + 1] - cy) ** 2 + (P[pb + 2] - cz) ** 2;
        if (db > cr2) continue;
        if (ne >= _edgeA.length) break;
        _edgeA[ne] = a; _edgeB[ne] = b; _edgeL[ne] = l2; ne++;
      }
    }
    // 短い辺から順に（インデックスだけ並べ替える）
    const order = _orderList;
    order.length = 0;
    for (let i = 0; i < ne; i++) order.push(i);
    const EL = _edgeL;
    order.sort((x, y) => EL[x] - EL[y]);
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const a = _edgeA[i], b = _edgeB[i];
      if (!mesh.isVertAlive(a) || !mesh.isVertAlive(b)) continue;
      // 再計算（周囲が動いている / 既に別の辺で潰れている可能性）
      const pa = a * 3, pb = b * 3;
      const dx = P[pb] - P[pa], dy = P[pb + 1] - P[pa + 1], dz = P[pb + 2] - P[pa + 2];
      if (dx * dx + dy * dy + dz * dz >= cl2) continue;
      if (collapseEdge(mesh, a, b)) {
        changed = true;
        _touchedVerts.length = 0;
        _touchedVerts.push(a);
        mesh.computeNormalsFor(_touchedVerts);
        // 位置が動いた頂点を呼び出し側へ知らせる。
        // 辺分割は形状を変えない（分割後の面法線の和は元と同じ）ので、
        // 法線を直す必要があるのはコラプスで動いたここだけ。
        if (opt.moved) opt.moved.push(a);
      }
    }
  }

  if (changed) mesh.geomVersion++;
  return changed;
}
