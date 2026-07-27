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
  const maxNew = opt.maxNewPerStep || 12000;

  // 分割 / コラプスのしきい値。目標長を挟んでヒステリシスを持たせ、
  // 同じ辺が分割と統合を往復するのを防ぐ。コラプス側は既存ディテールを
  // 壊しすぎないよう控えめにしてある。
  const splitLen = targetLen * 1.45;
  const collapseLen = targetLen * 0.45;
  const r2 = (radius * 1.15) * (radius * 1.15);
  const cx = center[0], cy = center[1], cz = center[2];
  const P = mesh.positions;
  let changed = false;

  let consider = regionTris.slice();

  // ---- 分割パス --------------------------------------------------------
  if (doSplit && mesh.liveVerts < maxVerts) {
    let created = 0;
    for (let pass = 0; pass < 5; pass++) {
      mesh.trackTris = [];
      let splits = 0;
      const T = mesh.tris;
      for (let k = 0; k < consider.length; k++) {
        const t = consider[k];
        if (!mesh.isTriAlive(t)) continue;
        const i = t * 3;
        const v = [T[i], T[i + 1], T[i + 2]];
        // 最長辺を選ぶ
        let bestLen = -1, ba = -1, bb = -1, bmx = 0, bmy = 0, bmz = 0;
        for (let e = 0; e < 3; e++) {
          const a = v[e], b = v[(e + 1) % 3];
          const pa = a * 3, pb = b * 3;
          const dx = P[pb] - P[pa], dy = P[pb + 1] - P[pa + 1], dz = P[pb + 2] - P[pa + 2];
          const l = dx * dx + dy * dy + dz * dz;
          if (l > bestLen) {
            bestLen = l; ba = a; bb = b;
            bmx = (P[pa] + P[pb]) * 0.5; bmy = (P[pa + 1] + P[pb + 1]) * 0.5; bmz = (P[pa + 2] + P[pb + 2]) * 0.5;
          }
        }
        if (bestLen <= splitLen * splitLen) continue;
        const ddx = bmx - cx, ddy = bmy - cy, ddz = bmz - cz;
        if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue;
        if (splitEdge(mesh, ba, bb) >= 0) { splits++; created++; }
        if (mesh.liveVerts >= maxVerts || created >= maxNew) break;
      }
      const fresh = mesh.trackTris;
      mesh.trackTris = null;
      if (splits > 0) changed = true;
      if (splits === 0 || mesh.liveVerts >= maxVerts || created >= maxNew) break;
      // 分割された三角形も再チェックしたいので既存 + 新規を次パスへ
      for (let k = 0; k < fresh.length; k++) consider.push(fresh[k]);
    }
  }

  // ---- コラプスパス ----------------------------------------------------
  if (doCollapse) {
    const seen = new Set();
    const edges = [];
    const T = mesh.tris;
    const cr2 = radius * radius;
    for (let k = 0; k < consider.length; k++) {
      const t = consider[k];
      if (!mesh.isTriAlive(t)) continue;
      const i = t * 3;
      const v = [T[i], T[i + 1], T[i + 2]];
      for (let e = 0; e < 3; e++) {
        let a = v[e], b = v[(e + 1) % 3];
        if (a > b) { const s = a; a = b; b = s; }
        const key = a * 2097152 + b;
        if (seen.has(key)) continue;
        seen.add(key);
        const pa = a * 3, pb = b * 3;
        const dx = P[pb] - P[pa], dy = P[pb + 1] - P[pa + 1], dz = P[pb + 2] - P[pa + 2];
        const l2 = dx * dx + dy * dy + dz * dz;
        if (l2 >= collapseLen * collapseLen) continue;
        // 両端がブラシ球内に入っている辺のみ
        const max = (P[pa] - cx) ** 2 + (P[pa + 1] - cy) ** 2 + (P[pa + 2] - cz) ** 2;
        const mbx = (P[pb] - cx) ** 2 + (P[pb + 1] - cy) ** 2 + (P[pb + 2] - cz) ** 2;
        if (max > cr2 || mbx > cr2) continue;
        edges.push(a, b, l2);
      }
    }
    // 短い辺から順に
    const order = [];
    for (let i = 0; i < edges.length; i += 3) order.push(i);
    order.sort((x, y) => edges[x + 2] - edges[y + 2]);
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const a = edges[i], b = edges[i + 1];
      if (!mesh.isVertAlive(a) || !mesh.isVertAlive(b)) continue;
      // 再計算（周囲が動いている可能性）
      const pa = a * 3, pb = b * 3;
      const dx = P[pb] - P[pa], dy = P[pb + 1] - P[pa + 1], dz = P[pb + 2] - P[pa + 2];
      if (dx * dx + dy * dy + dz * dz >= collapseLen * collapseLen) continue;
      if (collapseEdge(mesh, a, b)) {
        changed = true;
        _touchedVerts.length = 0;
        _touchedVerts.push(a);
        mesh.computeNormalsFor(_touchedVerts);
      }
    }
  }

  if (changed) mesh.geomVersion++;
  return changed;
}
