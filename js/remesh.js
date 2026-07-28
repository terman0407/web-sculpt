// ---------------------------------------------------------------------------
// remesh.js
// ZRemesher 相当のリメッシュ。
//
// 本家 ZRemesher は「曲率に沿った四角メッシュ」を出すが、あれは
// instant field-aligned meshes 系のクロスフィールド最適化で、研究規模の実装になる。
// ここでは実際に効く部分に絞ってある:
//
//   1. 等方リメッシュ（Botsch-Kobbelt）— 分割 / コラプス / フリップ / 接線緩和を
//      反復して、目標エッジ長のそろった三角形メッシュにする
//   2. 曲率適応 — 曲率の高い所だけ細かくする（平らな所に無駄なポリゴンを置かない）
//   3. 目標ポリゴン数 — 面積から必要なエッジ長を逆算する（ZRemesher の
//      Target Polygons Count 相当）
//   4. 四角優勢化 — 隣り合う三角形を対にして四角にする。OBJ 書き出しで
//      四角として出るので、他のツールで開いたときの見た目が ZRemesher に近くなる
//
// 形を保つのが要点で、緩和したあとに必ず元の表面へ投影して戻す。投影のために
// 元の三角形を一様格子に入れておく（BVH を作るほどの精度は要らない）。
// ---------------------------------------------------------------------------

import { splitEdge, collapseEdge, flipEdge } from './dyntopo.js';
import { RING_STRIDE } from './mesh.js';

/** 点と三角形の最短距離の 2 乗と最近点（Ericson, Real-Time Collision Detection） */
function closestOnTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return apx * apx + apy * apy + apz * apz; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return bpx * bpx + bpy * bpy + bpz * bpz; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v;
    const x = apx - abx * v, y = apy - aby * v, z = apz - abz * v;
    return x * x + y * y + z * z;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return cpx * cpx + cpy * cpy + cpz * cpz; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w;
    const x = apx - acx * w, y = apy - acy * w, z = apz - acz * w;
    return x * x + y * y + z * z;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w;
    const x = bpx + (cpx - bpx) * w, y = bpy + (cpy - bpy) * w, z = bpz + (cpz - bpz) * w;
    return x * x + y * y + z * z;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
  const x = apx - (abx * v + acx * w), y = apy - (aby * v + acy * w), z = apz - (abz * v + acz * w);
  return x * x + y * y + z * z;
}

/**
 * 元の表面への最近点を引くための一様格子。
 *
 * BVH を作らないのは、問い合わせが「緩和で少し動いた頂点を戻す」用途で、
 * 移動量がセル 1 個ぶんに収まるため。1 セル分の近傍を見れば足りる。
 */
export class SurfaceRef {
  /**
   * @param {number} cellSize セルの一辺。**元メッシュの平均辺長**を渡すこと。
   *   目標エッジ長（＝粗い側）を渡すと 1 セルに何十枚も入り、1 回の問い合わせで
   *   1000 回近い点‐三角形判定になる（520 万面で 1 クエリ 25.5µs、
   *   260 万頂点 × 5 反復で 330 秒）。
   * @param {number} maxCells セル数の上限。細かくしすぎるとメモリが爆発するので、
   *   超える場合はセルを大きくする。
   */
  constructor(positions, indices, cellSize, maxCells = 6e6) {
    this.P = positions;
    this.I = indices;
    const n = indices.length / 3;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < minX) minX = positions[i];
      if (positions[i] > maxX) maxX = positions[i];
      if (positions[i + 1] < minY) minY = positions[i + 1];
      if (positions[i + 1] > maxY) maxY = positions[i + 1];
      if (positions[i + 2] < minZ) minZ = positions[i + 2];
      if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
    }
    let h = Math.max(cellSize, 1e-6);
    // セル数が予算を超えるならセルを大きくする
    for (let guard = 0; guard < 64; guard++) {
      const cx = Math.ceil((maxX - minX) / h) + 3;
      const cy = Math.ceil((maxY - minY) / h) + 3;
      const cz = Math.ceil((maxZ - minZ) / h) + 3;
      if (cx * cy * cz <= maxCells) break;
      h *= 1.25;
    }
    this.h = h;
    this.ox = minX - h; this.oy = minY - h; this.oz = minZ - h;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / h) + 2);
    this.ny = Math.max(1, Math.ceil((maxY - minY) / h) + 2);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / h) + 2);
    const cells = this.nx * this.ny * this.nz;

    // CSR で「セル → 三角形リスト」を作る。件数を数えてから詰める 2 パス。
    const count = new Int32Array(cells + 1);
    const bb = new Int32Array(n * 6);
    for (let t = 0; t < n; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const i0 = this._clampX(Math.floor((Math.min(positions[a], positions[b], positions[c]) - this.ox) / h));
      const i1 = this._clampX(Math.floor((Math.max(positions[a], positions[b], positions[c]) - this.ox) / h));
      const j0 = this._clampY(Math.floor((Math.min(positions[a + 1], positions[b + 1], positions[c + 1]) - this.oy) / h));
      const j1 = this._clampY(Math.floor((Math.max(positions[a + 1], positions[b + 1], positions[c + 1]) - this.oy) / h));
      const k0 = this._clampZ(Math.floor((Math.min(positions[a + 2], positions[b + 2], positions[c + 2]) - this.oz) / h));
      const k1 = this._clampZ(Math.floor((Math.max(positions[a + 2], positions[b + 2], positions[c + 2]) - this.oz) / h));
      bb[t * 6] = i0; bb[t * 6 + 1] = i1; bb[t * 6 + 2] = j0;
      bb[t * 6 + 3] = j1; bb[t * 6 + 4] = k0; bb[t * 6 + 5] = k1;
      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          const base = j * this.nx + k * this.nx * this.ny;
          for (let i = i0; i <= i1; i++) count[base + i + 1]++;
        }
      }
    }
    for (let c = 0; c < cells; c++) count[c + 1] += count[c];
    this.off = count;
    this.tri = new Int32Array(count[cells]);
    const fill = count.slice(0, cells);
    for (let t = 0; t < n; t++) {
      const i0 = bb[t * 6], i1 = bb[t * 6 + 1], j0 = bb[t * 6 + 2];
      const j1 = bb[t * 6 + 3], k0 = bb[t * 6 + 4], k1 = bb[t * 6 + 5];
      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          const base = j * this.nx + k * this.nx * this.ny;
          for (let i = i0; i <= i1; i++) this.tri[fill[base + i]++] = t;
        }
      }
    }
    this._c = new Float64Array(3);
  }

  _clampX(i) { return i < 0 ? 0 : (i >= this.nx ? this.nx - 1 : i); }
  _clampY(i) { return i < 0 ? 0 : (i >= this.ny ? this.ny - 1 : i); }
  _clampZ(i) { return i < 0 ? 0 : (i >= this.nz ? this.nz - 1 : i); }

  /**
   * ヒントの三角形（前回この頂点で当たったもの）だけを試す軽量版。
   *
   * 緩和は頂点を接線方向へわずかに動かすだけなので、直前に当たった三角形が
   * そのまま最近傍であることがほとんど。まずここで済ませると格子を引かずに終わる。
   * 「その三角形の内部に落ちた」= 辺や頂点にクランプされていない場合だけ採用する
   * （辺にクランプされたときは隣の三角形のほうが近い可能性がある）。
   *
   * ヒントは頂点スロット番号で持つので、分割・統合でスロットが再利用されると
   * 死んだ頂点のヒントを新しい頂点が引き継いでしまう。そのまま採用すると
   * 表面の遠い場所へ飛ぶ（実測で単位球のモデルを跨ぐ 1.71 のずれが出た）。
   * maxD2 を超える距離のヒントは信用しないことで弾く。
   *
   * @param {number} maxD2 許容する距離の 2 乗。これを超えたら -1
   * @returns {number} 採用できたら距離の 2 乗、できなければ -1
   */
  tryHint(px, py, pz, t, out, maxD2) {
    if (t < 0) return -1;
    const P = this.P, I = this.I;
    const i = t * 3;
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const d = closestOnTri(px, py, pz,
      P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2], out);
    // 最近点が三角形の内部か辺の内側にあるかを、重心座標を使わず
    // 「3 頂点のどれとも一致しない」で近似する。頂点にクランプされた場合は
    // 隣の面のほうが近いことがあるので却下する。
    if (d > maxD2) return -1;                     // 使い回されたスロットの古いヒント
    const ex = 1e-12;
    const nearVert = (vi) => (out[0] - P[vi]) ** 2 + (out[1] - P[vi + 1]) ** 2 + (out[2] - P[vi + 2]) ** 2 < ex;
    if (nearVert(a) || nearVert(b) || nearVert(c)) return -1;
    return d;
  }

  /**
   * 点 (px,py,pz) に最も近い表面上の点を out へ入れる。
   * 見つからなければ false（元の点をそのまま使う）。
   * @returns {number} 当たった三角形の番号（-1 で見つからず）。次回のヒントに使う。
   */
  closest(px, py, pz, out) {
    const h = this.h, P = this.P, I = this.I, tmp = this._c;
    const ci = this._clampX(Math.floor((px - this.ox) / h));
    const cj = this._clampY(Math.floor((py - this.oy) / h));
    const ck = this._clampZ(Math.floor((pz - this.oz) / h));
    let best = Infinity;
    let found = false;
    let bestTri = -1;
    const maxRing = 4;
    for (let ring = 0; ring <= maxRing; ring++) {
      const i0 = Math.max(0, ci - ring), i1 = Math.min(this.nx - 1, ci + ring);
      const j0 = Math.max(0, cj - ring), j1 = Math.min(this.ny - 1, cj + ring);
      const k0 = Math.max(0, ck - ring), k1 = Math.min(this.nz - 1, ck + ring);
      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            // 外殻だけ見る（内側の殻は前の ring で見ている）
            if (ring > 0 && i > i0 && i < i1 && j > j0 && j < j1 && k > k0 && k < k1) continue;
            const c = i + j * this.nx + k * this.nx * this.ny;
            for (let q = this.off[c]; q < this.off[c + 1]; q++) {
              const ti = this.tri[q];
              const t = ti * 3;
              const a = I[t] * 3, b = I[t + 1] * 3, cc = I[t + 2] * 3;
              const d = closestOnTri(px, py, pz,
                P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[cc], P[cc + 1], P[cc + 2], tmp);
              if (d < best) {
                best = d;
                out[0] = tmp[0]; out[1] = tmp[1]; out[2] = tmp[2];
                found = true;
                bestTri = ti;
              }
            }
          }
        }
      }
      // この殻の外にはこれより近い面が無いと言えたら打ち切る
      // 打ち切りの下界。「殻 ring まで見たら、未走査の点は少なくとも ring*h 先」
      // という見方だと ring=0 で下界が 0 になり、必ず 27 セル（殻 1）まで
      // 走査してしまう。実測で 1 クエリ 319 回の点-三角形判定になっていた。
      // 走査済みボックスの面までの実距離を使うと下界が h/2 前後まで上がり、
      // 表面上の点はほとんど殻 0（1 セル）で確定する。
      const bound = Math.min(
        px - (this.ox + (ci - ring) * h), (this.ox + (ci + ring + 1) * h) - px,
        py - (this.oy + (cj - ring) * h), (this.oy + (cj + ring + 1) * h) - py,
        pz - (this.oz + (ck - ring) * h), (this.oz + (ck + ring + 1) * h) - pz);
      if (found && best <= bound * bound) break;
    }
    return found ? bestTri : -1;
  }
}

/** 生きている三角形だけを詰めた (positions, indices) を作る */
function snapshot(mesh) {
  const remap = new Int32Array(mesh.nv).fill(-1);
  let nv = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) remap[v] = nv++;
  const P = new Float32Array(nv * 3);
  for (let v = 0; v < mesh.nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    P[r * 3] = mesh.positions[v * 3];
    P[r * 3 + 1] = mesh.positions[v * 3 + 1];
    P[r * 3 + 2] = mesh.positions[v * 3 + 2];
  }
  const T = mesh.tris;
  const I = new Int32Array(mesh.liveTris * 3);
  let w = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    I[w++] = remap[a]; I[w++] = remap[b]; I[w++] = remap[c];
  }
  return { positions: P, indices: I.subarray(0, w) };
}

/** 表面積の合計 */
function surfaceArea(mesh) {
  const P = mesh.positions, T = mesh.tris;
  let area = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, ia = T[i], ib = T[i + 1], ic = T[i + 2];
    if (ia === ib && ib === ic) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2];
    const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5;
  }
  return area;
}

/**
 * 目標三角形数から必要なエッジ長を逆算する。
 * 正三角形の面積は √3/4 · L² なので nTris ≈ Area / (√3/4 · L²)。
 */
export function edgeLengthForTris(area, nTris) {
  if (nTris <= 0 || area <= 0) return 0;
  return Math.sqrt((4 * area) / (Math.sqrt(3) * nTris));
}

/**
 * 全辺を (a,b) の組で列挙する（a < b、重複なし）。
 *
 * Set にキーを入れて重複を弾く形だと 520 万面で 1 回 2.7 秒かかっていた
 * （反復ごとに 3 回呼ぶので、それだけで 40 秒以上）。
 * 頂点ごとにリングを舐めて「番号が自分より大きい隣接頂点」だけを出す形に変え、
 * 重複判定は頂点数ぶんのスタンプ配列で O(1) にした。ハッシュも確保も無い。
 */
function collectEdges(mesh, out, stamp, stampId) {
  const T = mesh.tris;
  const RC = mesh.ringCount, RD = mesh.ringData, REX = mesh.ringExt;
  let n = 0;
  let id = stampId;
  const limit = out.length >> 1;
  for (let v = 0; v < mesh.nv; v++) {
    const rc = RC[v];
    if (rc === 0 || !mesh.vAlive[v]) continue;
    id++;
    const inline = rc <= RING_STRIDE;
    const base = inline ? v * RING_STRIDE : 0;
    const ex = inline ? null : REX[v];
    for (let j = 0; j < rc; j++) {
      const ti = (inline ? RD[base + j] : ex[j]) * 3;
      for (let e = 0; e < 3; e++) {
        const u = T[ti + e];
        // 各辺は「番号が小さい側の頂点」から 1 回だけ出す
        if (u <= v) continue;
        if (stamp[u] === id) continue;
        stamp[u] = id;
        if (n >= limit) return { n, stampId: id };
        out[n * 2] = v; out[n * 2 + 1] = u;
        n++;
      }
    }
  }
  return { n, stampId: id };
}

/**
 * 等方（または曲率適応）リメッシュ。
 *
 * @param {SculptMesh} mesh
 * @param {object} opts
 *   targetTris  目標三角形数（0 なら targetLen か現在の平均辺長を使う）
 *   targetLen   目標エッジ長（targetTris があれば無視）
 *   iterations  反復回数（既定 5）
 *   adaptive    曲率適応の強さ 0..1（0 で完全に均一）
 *   minScale    適応時のエッジ長の下限倍率（既定 0.4）
 *   maxScale    上限倍率（既定 2.0）
 *   project     元の表面へ投影して形を保つか（既定 true）
 *   relax       接線緩和の量 0..1（既定 0.5）
 *   maxVerts    頂点数の上限（安全弁）
 * @returns {object} 統計
 */
export function remesh(mesh, opts = {}) {
  const t0 = Date.now();
  if (mesh.liveTris === 0) return { ok: false, reason: '空のメッシュです' };

  const iterations = Math.max(1, Math.min(20, Math.round(opts.iterations ?? 5)));
  const adaptive = Math.max(0, Math.min(1, opts.adaptive ?? 0));
  const minScale = Math.max(0.05, opts.minScale ?? 0.4);
  const maxScale = Math.max(minScale, opts.maxScale ?? 2.0);
  const relaxAmt = Math.max(0, Math.min(1, opts.relax ?? 0.5));
  const doProject = opts.project !== false;
  const maxVerts = Math.max(1000, opts.maxVerts || 2000000);
  // 進捗の通知先（ワーカーから UI へ流すため）。同期処理なので、呼ばれた側で
  // 描画はできない。ワーカー側で postMessage するのが前提。
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  // 補正ラウンドが何回入るかは終わるまで分からないので、最大まで回ったときの
  // パス数で割って進捗を出す。実際は途中で抜けるので最後は一気に 100% になる。
  const estPasses = iterations + (opts.targetTris > 0 ? 6 : 0);
  let donePasses = 0;
  const tell = (stage) => {
    if (!report) return;
    report({ stage, done: donePasses, total: estPasses, tris: mesh.liveTris, verts: mesh.liveVerts });
  };

  const area = surfaceArea(mesh);
  let L = opts.targetLen > 0 ? opts.targetLen : 0;
  if (!L && opts.targetTris > 0) L = edgeLengthForTris(area, opts.targetTris);
  if (!L) L = mesh.averageEdgeLength();
  if (!(L > 0)) return { ok: false, reason: '目標エッジ長を決められません' };

  // 元の形を控えて投影の基準にする。
  // セルは「元メッシュの平均辺長」に合わせる（目標エッジ長にすると 1 セルへ
  // 何十枚も入って問い合わせが 1000 回近い判定になる）。
  const srcEdge = mesh.averageEdgeLength();
  tell('下準備');
  const ref = doProject ? new SurfaceRef(...(() => {
    const s = snapshot(mesh);
    return [s.positions, s.indices, Math.max(srcEdge, 1e-6)];
  })()) : null;
  // 頂点ごとに「前回当たった三角形」を覚えておく。緩和の移動量は小さいので
  // ほとんどの頂点は同じ面に当たり続け、格子を引かずに済む。
  let projHint = doProject ? new Int32Array(mesh.capV).fill(-1) : null;

  // 曲率適応の重み。mesh.curv は -1..1 に正規化した平均曲率なので、
  // 絶対値が大きいほど（溝や稜線ほど）短いエッジを目標にする。
  // 真の曲率半径ではないが、彫刻の「見た目の細かさ」とはよく対応する。
  mesh.computeAllCurvature();

  const stats = { split: 0, collapse: 0, flip: 0, relaxed: 0, projected: 0, hinted: 0 };
  const phase = { edges: 0, split: 0, collapse: 0, flip: 0, relax: 0, project: 0, normals: 0, curv: 0 };
  const now = () => Date.now();
  let scratchSum = null, scratchCnt = null;
  const edges = new Int32Array(Math.max(4096, mesh.capT * 6));
  let edgeStamp = new Int32Array(mesh.capV);
  let edgeStampId = 0;
  const tmp = new Float64Array(3);
  const target = new Float32Array(mesh.capV);

  // 曲率適応の局所目標長。平ら（curv=0）なところは基準そのまま、
  // 曲率が高いところだけ短くする。
  // 以前は s * maxScale を掛けていて、平らなところが 2 倍の長さになり
  // 目標面数から大きく外れていた（5000 面狙いで 1160 面）。
  let scaleL = 1;
  const localLen = (v) => {
    if (adaptive <= 0) return L * scaleL;
    const k = Math.abs(mesh.curv[v]);
    const s = 1 / (1 + adaptive * 6 * k);
    return L * scaleL * Math.max(minScale, Math.min(maxScale, s));
  };

  // 4/3 と 4/5 のしきい値で落ち着く平均辺長は目標より少し長くなるので、
  // 目標面数を指定されたときは「面数 ∝ L^-2」を使って L を補正しながら回す。
  // 実測では無補正だと一貫して 29% ほど面数が足りなかった。
  const runPasses = (n) => {
  for (let it = 0; it < n; it++) {
    // 分割で増えた頂点の curv は 0 のままなので、適応するなら毎回作り直す。
    // 作り直さないと新しい頂点が全部「平ら」扱いになり、適応がほとんど効かない。
    if (adaptive > 0 && it > 0) { const _t = now(); mesh.computeAllCurvature(); phase.curv += now() - _t; }
    // --- 分割: 目標より 4/3 倍長い辺 -----------------------------------
    tell('分割');
    if (mesh.liveVerts < maxVerts) {
      const _te = now(); const cr = collectEdges(mesh, edges, edgeStamp, edgeStampId); const n = cr.n; edgeStampId = cr.stampId; phase.edges += now() - _te; const _tp = now();
      const P = mesh.positions;
      for (let e = 0; e < n; e++) {
        if (mesh.liveVerts >= maxVerts) break;
        const a = edges[e * 2], b = edges[e * 2 + 1];
        if (!mesh.isVertAlive(a) || !mesh.isVertAlive(b)) continue;
        const ia = a * 3, ib = b * 3;
        const d = Math.hypot(P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]);
        const lt = (localLen(a) + localLen(b)) * 0.5;
        if (d > lt * (4 / 3)) { if (splitEdge(mesh, a, b) >= 0) stats.split++; }
      }
      phase.split += now() - _tp;
    }

    // --- コラプス: 目標より 4/5 倍短い辺 --------------------------------
    tell('統合');
    {
      const _te = now(); const cr = collectEdges(mesh, edges, edgeStamp, edgeStampId); const n = cr.n; edgeStampId = cr.stampId; phase.edges += now() - _te; const _tp = now();
      const P = mesh.positions;
      for (let e = 0; e < n; e++) {
        const a = edges[e * 2], b = edges[e * 2 + 1];
        if (!mesh.isVertAlive(a) || !mesh.isVertAlive(b)) continue;
        const ia = a * 3, ib = b * 3;
        const d = Math.hypot(P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]);
        const lt = (localLen(a) + localLen(b)) * 0.5;
        if (d < lt * (4 / 5)) { if (collapseEdge(mesh, a, b)) stats.collapse++; }
      }
      phase.collapse += now() - _tp;
    }

    // --- フリップ: 価数を 6 に近づける ----------------------------------
    tell('整え');
    {
      const _te = now(); const cr = collectEdges(mesh, edges, edgeStamp, edgeStampId); const n = cr.n; edgeStampId = cr.stampId; phase.edges += now() - _te; const _tp = now();
      for (let e = 0; e < n; e++) {
        const a = edges[e * 2], b = edges[e * 2 + 1];
        if (!mesh.isVertAlive(a) || !mesh.isVertAlive(b)) continue;
        if (flipEdge(mesh, a, b)) stats.flip++;
      }
      phase.flip += now() - _tp;
    }

    // --- 接線緩和 + 表面へ投影 -----------------------------------------
    tell('投影');
    if (relaxAmt > 0) {
      const _tn = now();
      mesh.computeAllNormals();
      phase.normals += now() - _tn;
      const _tr = now();
      if (target.length < mesh.capV * 3) {
        // 頂点が増えたので作り直す
        stats.grown = true;
      }
      const tgt = target.length >= mesh.capV * 3 ? target : new Float32Array(mesh.capV * 3);
      const P = mesh.positions, N = mesh.normals, T = mesh.tris;
      // 1-ring の重心を三角形 1 周で積む（ring を辿るより速い）。
      // スクラッチは使い回す。反復ごとに確保すると 260 万頂点で毎回 40MB になる。
      if (!scratchSum || scratchSum.length < mesh.nv * 3) {
        scratchSum = new Float32Array(mesh.capV * 3);
        scratchCnt = new Float32Array(mesh.capV);
      } else {
        scratchSum.fill(0, 0, mesh.nv * 3);
        scratchCnt.fill(0, 0, mesh.nv);
      }
      if (projHint && projHint.length < mesh.capV) {
        const h2 = new Int32Array(mesh.capV).fill(-1);
        h2.set(projHint);
        projHint = h2;
      }
      const sum = scratchSum, cnt = scratchCnt;
      for (let t = 0; t < mesh.nt; t++) {
        const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
        if (a === b && b === c) continue;
        for (const [x, y] of [[a, b], [b, c], [c, a]]) {
          sum[x * 3] += P[y * 3]; sum[x * 3 + 1] += P[y * 3 + 1]; sum[x * 3 + 2] += P[y * 3 + 2];
          cnt[x]++;
          sum[y * 3] += P[x * 3]; sum[y * 3 + 1] += P[x * 3 + 1]; sum[y * 3 + 2] += P[x * 3 + 2];
          cnt[y]++;
        }
      }
      for (let v = 0; v < mesh.nv; v++) {
        if (!mesh.vAlive[v] || cnt[v] === 0) continue;
        const i = v * 3;
        const inv = 1 / cnt[v];
        // 重心へのベクトルから法線成分を抜く（接線方向にだけ動かす = 形を変えない）
        let dx = sum[i] * inv - P[i], dy = sum[i + 1] * inv - P[i + 1], dz = sum[i + 2] * inv - P[i + 2];
        const dn = dx * N[i] + dy * N[i + 1] + dz * N[i + 2];
        dx -= N[i] * dn; dy -= N[i + 1] * dn; dz -= N[i + 2] * dn;
        tgt[i] = P[i] + dx * relaxAmt;
        tgt[i + 1] = P[i + 1] + dy * relaxAmt;
        tgt[i + 2] = P[i + 2] + dz * relaxAmt;
        stats.relaxed++;
      }
      phase.relax += now() - _tr;
      const _tj = now();
      // 動いていない頂点は投影しない。しきい値は目標辺長に対する相対値。
      const moveEps = L * 1e-4;
      const moveEps2 = moveEps * moveEps;
      // ヒントとして信用できる距離。緩和で動く量は目標辺長の一部なので、
      // これより遠い当たりは「別の頂点のヒントを引き継いだ」と判断する。
      const hintMaxD2 = (L * 0.5) * (L * 0.5);
      for (let v = 0; v < mesh.nv; v++) {
        if (!mesh.vAlive[v] || cnt[v] === 0) continue;
        const i = v * 3;
        const dx = tgt[i] - P[i], dy = tgt[i + 1] - P[i + 1], dz = tgt[i + 2] - P[i + 2];
        if (dx * dx + dy * dy + dz * dz < moveEps2) continue;   // 実質動いていない
        if (ref) {
          // まず前回当たった面だけを試す。緩和の移動量は小さいので大半はここで済む。
          const hint = projHint[v];
          const dh = ref.tryHint(tgt[i], tgt[i + 1], tgt[i + 2], hint, tmp, hintMaxD2);
          if (dh >= 0) {
            P[i] = tmp[0]; P[i + 1] = tmp[1]; P[i + 2] = tmp[2];
            stats.projected++; stats.hinted++;
            continue;
          }
          const ti = ref.closest(tgt[i], tgt[i + 1], tgt[i + 2], tmp);
          if (ti >= 0) {
            projHint[v] = ti;
            P[i] = tmp[0]; P[i + 1] = tmp[1]; P[i + 2] = tmp[2];
            stats.projected++;
            continue;
          }
        }
        P[i] = tgt[i]; P[i + 1] = tgt[i + 1]; P[i + 2] = tgt[i + 2];
      }
      phase.project += now() - _tj;
    }
    donePasses++;
  }

  };

  runPasses(iterations);
  if (opts.targetTris > 0) {
    // 面数が 8% 以上ずれていたら L を調整して詰めのパスを回す（最大 3 回）
    for (let round = 0; round < 3; round++) {
      const cur = mesh.liveTris;
      const err = (cur - opts.targetTris) / opts.targetTris;
      if (Math.abs(err) < 0.08) break;
      // 面数 ∝ L^-2 なので L を sqrt(cur/target) 倍する
      scaleL *= Math.sqrt(cur / opts.targetTris);
      stats.rounds = (stats.rounds || 0) + 1;
      runPasses(2);
    }
  }

  donePasses = estPasses;
  tell('仕上げ');
  mesh.compact(true);
  mesh.computeAllNormals();
  mesh.computeAllCurvature();
  mesh.markAllDirty();
  mesh.geomVersion++;
  mesh.topoVersion++;

  return {
    ok: true, ms: Date.now() - t0,
    targetLen: L, area,
    verts: mesh.liveVerts, tris: mesh.liveTris,
    phase,
    ...stats,
  };
}

/**
 * 隣り合う三角形を対にして四角にする（四角優勢化）。
 *
 * ZRemesher の出力が四角なので、書き出したときに近い見た目にしたい。
 * メッシュ本体は三角形専用なので、ここでは「書き出し用の面リスト」だけを作る。
 *
 * 対の選び方は貪欲。各共有辺について「その辺を消して四角にしたときの質」を
 * 見積もり、良い順に取っていく。質は
 *   * 2 枚の法線がそろっているか（平坦なペアほど良い）
 *   * できる四角の角が 90 度に近いか
 * の積。完全マッチングを解くほどの差は出ないので、ソート + 貪欲で十分。
 *
 * @returns {{ faces: Int32Array, offsets: Int32Array, quads: number, tris: number }}
 *   faces は面ごとの頂点を並べたもの、offsets[i]..offsets[i+1] が i 番目の面。
 */
export function quadDominant(mesh) {
  const T = mesh.tris, P = mesh.positions;
  // 辺 → 隣接三角形（最大 2）
  const edgeMap = new Map();
  const alive = [];
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    alive.push(t);
    for (let e = 0; e < 3; e++) {
      let x = e === 0 ? a : (e === 1 ? b : c);
      let y = e === 0 ? b : (e === 1 ? c : a);
      if (x > y) { const s = x; x = y; y = s; }
      const key = x * 8388608 + y;
      const cur = edgeMap.get(key);
      if (cur === undefined) edgeMap.set(key, t);
      else if (typeof cur === 'number') edgeMap.set(key, [cur, t]);
    }
  }

  const nrm = (t, out) => {
    const i = t * 3, a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
    const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2];
    const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2];
    out[0] = aby * acz - abz * acy; out[1] = abz * acx - abx * acz; out[2] = abx * acy - aby * acx;
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
  };
  const n0 = new Float64Array(3), n1 = new Float64Array(3);

  // 候補ペアを質つきで集める
  const cand = [];
  for (const [key, val] of edgeMap) {
    if (typeof val === 'number') continue;
    const [t0, t1] = val;
    const x = Math.floor(key / 8388608), y = key % 8388608;
    // 四角の順序 (x, o1, y, o0) を作る
    const opp = (t) => {
      const i = t * 3;
      for (let e = 0; e < 3; e++) { const v = T[i + e]; if (v !== x && v !== y) return v; }
      return -1;
    };
    const o0 = opp(t0), o1 = opp(t1);
    if (o0 < 0 || o1 < 0 || o0 === o1) continue;
    nrm(t0, n0); nrm(t1, n1);
    const flat = Math.max(0, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]);
    // 角の質: 四角 (x, o1, y, o0) の 4 角が 90 度に近いか
    const q = [x, o1, y, o0];
    let ang = 1;
    for (let i = 0; i < 4; i++) {
      const p = q[i] * 3, pv = q[(i + 3) % 4] * 3, nx2 = q[(i + 1) % 4] * 3;
      const ux = P[pv] - P[p], uy = P[pv + 1] - P[p + 1], uz = P[pv + 2] - P[p + 2];
      const vx = P[nx2] - P[p], vy = P[nx2 + 1] - P[p + 1], vz = P[nx2 + 2] - P[p + 2];
      const lu = Math.hypot(ux, uy, uz) || 1, lv = Math.hypot(vx, vy, vz) || 1;
      const cs = (ux * vx + uy * vy + uz * vz) / (lu * lv);
      // cos が 0 に近いほど良い
      ang *= 1 - Math.min(1, Math.abs(cs));
    }
    cand.push({ t0, t1, quad: q, score: flat * (0.2 + 0.8 * Math.pow(ang, 0.25)) });
  }
  cand.sort((a, b) => b.score - a.score);

  const used = new Uint8Array(mesh.nt);
  const faces = [];
  const offsets = [0];
  let quads = 0;
  for (const c of cand) {
    if (used[c.t0] || used[c.t1]) continue;
    used[c.t0] = 1; used[c.t1] = 1;
    faces.push(c.quad[0], c.quad[1], c.quad[2], c.quad[3]);
    offsets.push(faces.length);
    quads++;
  }
  let leftover = 0;
  for (const t of alive) {
    if (used[t]) continue;
    const i = t * 3;
    faces.push(T[i], T[i + 1], T[i + 2]);
    offsets.push(faces.length);
    leftover++;
  }
  return {
    faces: new Int32Array(faces), offsets: new Int32Array(offsets),
    quads, tris: leftover,
    ratio: quads * 2 / Math.max(1, alive.length),
  };
}
