// ---------------------------------------------------------------------------
// polygroups.js
// ZBrush のポリグループと部分表示（Ctrl+Shift のハイド）相当。
//
// 設計上のポイント:
//  * グループ ID と可視フラグは「三角形ごと」。SculptMesh 本体には持たせず、
//    このオブジェクトが所有して mesh.nt に追従して伸ばす。メッシュに列を足すと
//    snapshot / restore / compact / setGeometry の全経路に手を入れることになり、
//    dyntopo・ダイナメッシュ・分割レベルと衝突するため。
//  * SculptMesh は削除した三角形を詰めずに (0,0,0) の退化三角形として残す。
//    退化スロットは可視操作でも描画出力でも一切触らない。assign() は退化スロットに
//    グループ -1 を入れるが、reset() 直後（＝トポロジ変化を検出した直後）は
//    「全部 0」に戻すだけで退化スロットを走査しない。dyntopo 中は毎ダブここを
//    通るので、そのために nt 回の三角形走査を足すのは高すぎる。
//    したがって groups[t] === -1 は「死んだスロット」の判定には使えない。
//    呼び出し側が生死を知りたいときは mesh.isTriAlive(t) を見ること。
//  * トポロジが変わると三角形 ID の意味が変わる（空いたスロットは別の場所の面として
//    再利用される）。topoVersion を覚えて validate() で検出し、無効になったら
//    「全部 1 グループ・全部可視」へ戻す。黙って古い ID を使い続けると、
//    画面に見えている形とハイド状態が食い違って原因不明のバグになる。
//  * 一番重要な出口は buildVisibleIndices()。GPU 側に「可視」の概念はないので、
//    可視な三角形だけを詰めたインデックス配列を作って渡すしか隠す方法がない。
//
// 頂点は一切動かさない・マスクも書き換えない。ここは純粋に「面の属性」だけを扱う。
// ---------------------------------------------------------------------------

import { clamp } from './math.js';
import { RING_STRIDE } from './mesh.js';

/** UI のメニューに並べる自動グループ分けの手法（ブラシ一覧と同じ形） */
export const GROUP_METHODS = [
  { id: 'byConnectivity', jp: '連結成分', short: '連結', hint: '繋がっている塊ごとに別グループにする' },
  { id: 'byNormalAngle', jp: '法線角', short: '角度', hint: '隣の面との角度がしきい値を超える所で分ける（箱なら 6 面）' },
  { id: 'byMask', jp: 'マスク', short: 'マスク', hint: 'マスクされた領域とされていない領域で 2 分割' },
  { id: 'byVisible', jp: '表示部分', short: '表示', hint: 'いま表示されている部分を 1 グループにする' },
  { id: 'all', jp: '全部 1 つ', short: '解除', hint: 'グループ分けを解除して 1 グループに戻す' },
];

export const GROUP_METHOD_IDS = GROUP_METHODS.map(m => m.id);

// マスク規約は brushes.js と同じ: 1 = 保護（動かない）/ 0 = 自由。
// 「マスクされている」の判定は面の 3 頂点の平均で行う。
const MASK_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// グループ色
// ---------------------------------------------------------------------------

/** 整数ハッシュ（Wang hash 系）。ID から決まるので同じグループは常に同じ色になる */
function hash32(x) {
  x = (x + 0x7ed55d16 + (x << 12)) | 0;
  x = (x ^ 0xc761c23c ^ (x >>> 19)) | 0;
  x = (x + 0x165667b1 + (x << 5)) | 0;
  x = ((x + 0xd3a2646c) ^ (x << 9)) | 0;
  x = (x + 0xfd7046c5 + (x << 3)) | 0;
  x = (x ^ 0xb55a4f09 ^ (x >>> 16)) | 0;
  return x >>> 0;
}

function hsv2rgb(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/**
 * グループ ID から表示色を決める。ID だけで決まる（状態を持たない）。
 *
 * 色相をハッシュで直接決めると隣の ID がたまたま近い色になり、境目が消える。
 * 黄金比の等差数列にすると必ず離れるので、色相はこちらで作り、
 * 彩度と明度だけハッシュで散らす。ZBrush のポリグループに合わせて高彩度寄り。
 */
export function groupColorOf(id) {
  if (id < 0) return [0.58, 0.58, 0.60];    // グループ無し（退化スロット）は無彩色
  const h = (id * 0.6180339887498949 + 0.055) % 1;
  const r = hash32(id + 1);
  const s = 0.62 + (r & 63) / 63 * 0.32;
  const v = 0.76 + ((r >>> 8) & 63) / 63 * 0.22;
  return hsv2rgb(h, s, v);
}

// ---------------------------------------------------------------------------
// 面の隣接（ホットループ用のモジュール関数）
// ---------------------------------------------------------------------------

/**
 * 辺 (a,b) を共有する t 以外の三角形。無ければ -1。
 *
 * mesh.trianglesWithEdge() は JS 配列に push するので、面ごとに 3 回呼ぶこの
 * 用途では使えない（数百万面ぶんの push になる）。ring は生きた面しか
 * 持たないので、死んだスロットの除外も要らない。
 * 非多様体辺（3 面以上）では最初に見つかった 1 枚を返す。
 *
 * 走るのは「価数の小さい側」の ring。辺の両端はどちらも共有面を持つので
 * どちらを見ても答えは同じだが、常に a 側を見ると 1 頂点に何万面も集まる形
 * （円錐の頂点・UV 球の極・扇状に潰れたダイナメッシュ）で全体が Σvalence²
 * に化ける。実測で 32,000 面の扇に 0.8 秒かかっていた（正則な 130 万面が
 * 70ms なのに）。扇の反対側の端点は価数 2〜3 なので、小さい方を選ぶだけで
 * 面数に線形へ戻る。
 */
function edgeNeighbor(T, RC, RD, REX, t, a, b) {
  let p = a, q = b;
  if (RC[b] < RC[a]) { p = b; q = a; }
  const rc = RC[p];
  if (rc === 0) return -1;
  if (rc <= RING_STRIDE) {
    const base = p * RING_STRIDE;
    for (let j = 0; j < rc; j++) {
      const u = RD[base + j];
      if (u === t) continue;
      const i = u * 3;
      if (T[i] === q || T[i + 1] === q || T[i + 2] === q) return u;
    }
    return -1;
  }
  const ex = REX[p];
  for (let j = 0; j < rc; j++) {
    const u = ex[j];
    if (u === t) continue;
    const i = u * 3;
    if (T[i] === q || T[i + 1] === q || T[i + 2] === q) return u;
  }
  return -1;
}

/**
 * 面法線を out に入れて長さ（= 面積の 2 倍）を返す。
 * 正規化しないのは、2 面の内積を比べるときに割り算 1 回で足りるため。
 */
function faceNormal(P, T, t, out) {
  const i = t * 3;
  const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const e1x = P[b] - ax, e1y = P[b + 1] - ay, e1z = P[b + 2] - az;
  const e2x = P[c] - ax, e2y = P[c + 1] - ay, e2z = P[c + 2] - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  out[0] = nx; out[1] = ny; out[2] = nz;
  return Math.sqrt(nx * nx + ny * ny + nz * nz);
}

// ---------------------------------------------------------------------------

export class PolyGroups {
  constructor() {
    this.groups = new Int32Array(0);     // 三角形 → グループ ID（-1 = 退化スロット）
    this.vis = new Uint8Array(0);        // 三角形 → 1 = 表示 / 0 = 非表示

    // 可視操作は必ず全ての生きた面を舐めるので、その場で数え直して
    // _visCount を常に正しく保つ。差分で足し引きするだけだと、履歴の巻き戻しや
    // トポロジ変化を挟んだときにずれてもう戻せない。
    this._visCount = 0;
    this._liveTris = 0;
    this._groupCount = 1;
    this._nt = 0;
    this._guard = -1;                    // 最後に同期した時点の mesh.topoVersion
    // 「今が初期状態（全部 1 グループ・全部可視）かどうか」。dyntopo 中は
    // 毎ダブで topoVersion が変わるので sync() ごとにリセットが走るが、
    // ポリグループを一度も使っていなければ配列は既に初期状態なので
    // 数百万要素の fill を毎フレームやる意味がない。
    this._pristine = true;

    // 呼び出し側が「前回と変わったか」を 1 個の整数で見られるようにする。
    // buildVisibleIndices() は O(nt) なので毎フレーム呼ばせたくない。
    this.visVersion = 0;
    this.groupVersion = 0;

    this._queue = new Int32Array(0);     // 面の BFS キュー（面は 1 回しか入らない）
    this._vflag = new Uint8Array(0);     // grow / shrink 用の頂点フラグ
    this._indices = new Uint32Array(0);  // 描画用インデックス（作り直さず使い回す）
    this._gcol = new Float32Array(0);    // グループ色のキャッシュ
    this._n1 = new Float64Array(3);
    this._n2 = new Float64Array(3);
  }

  // --- 容量とトポロジ ------------------------------------------------------

  get groupCount() { return this._groupCount; }
  /** 全部見えているか（描画側は true なら通常のインデックスバッファでよい） */
  get allVisible() { return this._visCount >= this._liveTris; }

  /** 容量を mesh に合わせ、トポロジが変わっていたら初期状態へ戻す */
  sync(mesh) {
    const nt = mesh.nt;
    if (this.groups.length < nt) {
      const cap = Math.max(2048, Math.ceil(nt * 1.5));
      const g = new Int32Array(cap);
      g.set(this.groups);
      this.groups = g;
      const v = new Uint8Array(cap);
      v.set(this.vis);
      v.fill(1, this.vis.length);        // 増えた枠の既定は「表示」
      this.vis = v;
    }
    // 面が増えたのに topoVersion が変わっていない、という経路は本来ないが、
    // あったとしても「未初期化のグループ ID で描く」ことは避ける。
    if (nt > this._nt) {
      this.groups.fill(0, this._nt, nt);
      this.vis.fill(1, this._nt, nt);
    }
    this._nt = nt;
    this._liveTris = mesh.liveTris;
    const ok = this.validate(mesh);
    if (ok && this._visCount > this._liveTris) this._visCount = this._liveTris;
    return ok;
  }

  /**
   * トポロジ変化の検出。変わっていたら reset() して false を返す。
   * 三角形 ID の意味が変わったあとのグループ／可視情報は復元できないので捨てる。
   */
  validate(mesh) {
    if (this._guard === mesh.topoVersion) return true;
    this.reset(mesh);
    return false;
  }

  /** 全部 1 グループ・全部可視に戻す */
  reset(mesh) {
    if (!this._pristine) {
      this.groups.fill(0);
      this.vis.fill(1);
      this._pristine = true;
      // 版を進めるのは本当に状態が変わったときだけ。dyntopo 中は毎ダブ
      // ここを通るので、無条件に進めると描画側が毎フレーム
      // インデックスを作り直すことになる。
      this.visVersion++;
      this.groupVersion++;
    }
    this._groupCount = 1;
    if (mesh) {
      this._liveTris = mesh.liveTris;
      this._nt = mesh.nt;
      this._guard = mesh.topoVersion;
    }
    this._visCount = this._liveTris;
    return this._stats(0);
  }

  /**
   * 三角形 → グループ ID。長さは容量なので mesh.nt で区切って読むこと。
   * 死んだスロットは assign() の直後だけ -1 で、リセット直後は 0 になっている
   * （モジュール先頭のコメント参照）。生死は mesh.isTriAlive(t) で見ること。
   */
  groupsOf(mesh) {
    this.sync(mesh);
    return this.groups;                  // 有効範囲は [0, mesh.nt)
  }

  groupColor(id) { return groupColorOf(id); }

  isVisible(t) {
    if (t < 0) return false;
    // 同期前のスロットは既定状態（可視）として答える
    return t >= this.vis.length ? true : this.vis[t] === 1;
  }

  visibleCount() { return this._visCount; }
  hiddenCount() { return this._liveTris - this._visCount; }

  /** グループごとの面数（UI の一覧表示用） */
  groupSizes(mesh) {
    this.sync(mesh);
    const T = mesh.tris, G = this.groups, nt = mesh.nt;
    const out = new Int32Array(Math.max(1, this._groupCount));
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      const g = G[t];
      if (g >= 0 && g < out.length) out[g]++;
    }
    return out;
  }

  // --- 自動グループ分け ---------------------------------------------------

  /**
   * @param method GROUP_METHOD_IDS のいずれか
   * @param opts   angle: byNormalAngle のしきい値（度, 既定 30）
   *               threshold: byMask のマスクしきい値（既定 0.5）
   * @returns {{groups, tris, method, visible, hidden}}
   */
  assign(mesh, method, opts = {}) {
    this.sync(mesh);
    let groups = 0;
    switch (method) {
      case 'byConnectivity': case 'connectivity':
        groups = this._byConnectivity(mesh); break;
      case 'byNormalAngle': case 'normalAngle':
        groups = this._byNormalAngle(mesh, opts.angle === undefined ? 30 : opts.angle); break;
      case 'byMask': case 'mask':
        groups = this._bySplit(mesh, 0, opts.threshold === undefined ? MASK_THRESHOLD : opts.threshold); break;
      case 'byVisible': case 'visible':
        groups = this._bySplit(mesh, 1, 0); break;
      case 'all': case 'none':
        groups = this._all(mesh); break;
      default:
        // 知らない手法で黙って全部 1 グループにされると原因が追いにくいので、
        // 何も変えずに ok:false を返す。
        return { groups: this._groupCount, tris: 0, method, ok: false,
          visible: this._visCount, hidden: this._liveTris - this._visCount };
    }
    this._groupCount = groups;
    this._pristine = false;
    this.groupVersion++;
    return { groups, tris: this._liveTris, method, ok: true,
      visible: this._visCount, hidden: this._liveTris - this._visCount };
  }

  /**
   * 連結成分ごと。頂点を共有していれば同じグループ（1 点で触れている 2 枚も同じ塊と見る）。
   *
   * 頂点に「ring はもう展開した」印を付けるので、ring を舐める回数は
   * 頂点ごとに 1 回、全体で Σvalence = O(面数)。印を付けないと面ごとに
   * 3 頂点ぶん舐め直すことになり Σvalence² になる。正則なメッシュなら
   * 定数 6 倍の差だが、1 頂点に何万面も集まる形では二乗に跳ねて
   * 32,000 面で 1 秒かかった（印を付けると 3ms）。
   * 一度展開した頂点の面は全部同じ gid が入っているので、2 度目に見ても
   * 新しく見つかる面は無い（別の成分からその頂点に到達することもできない）。
   */
  _byConnectivity(mesh) {
    const T = mesh.tris, G = this.groups, nt = mesh.nt, nv = mesh.nv;
    const RC = mesh.ringCount, RD = mesh.ringData, REX = mesh.ringExt;
    const q = this._ensureQueue(nt);
    const seen = this._ensureVFlag(nv);
    seen.fill(0, 0, nv);
    G.fill(-1, 0, nt);
    let gid = 0;
    for (let seed = 0; seed < nt; seed++) {
      if (G[seed] !== -1) continue;
      const si = seed * 3;
      if (T[si] === T[si + 1] && T[si + 1] === T[si + 2]) continue;
      let head = 0, tail = 0;
      G[seed] = gid;
      q[tail++] = seed;
      while (head < tail) {
        const ti = q[head++] * 3;
        for (let e = 0; e < 3; e++) {
          const v = T[ti + e];
          if (seen[v] === 1) continue;
          seen[v] = 1;
          const rc = RC[v];
          if (rc === 0) continue;
          if (rc <= RING_STRIDE) {
            const base = v * RING_STRIDE;
            for (let j = 0; j < rc; j++) {
              const u = RD[base + j];
              if (G[u] === -1) { G[u] = gid; q[tail++] = u; }
            }
          } else {
            const ex = REX[v];
            for (let j = 0; j < rc; j++) {
              const u = ex[j];
              if (G[u] === -1) { G[u] = gid; q[tail++] = u; }
            }
          }
        }
      }
      gid++;
    }
    return gid;
  }

  /**
   * 隣接面の法線角がしきい値を超える辺で分ける（スムーズグループ相当）。
   * しきい値以下の辺だけを渡って BFS するので、結果は「なめらかに繋がった面の集合」。
   *
   * 面法線はその場で作る。前計算して配列に持つと 100 万面で 12MB 常駐する一方、
   * 外積は面あたり 4 回で済むため（自分 1 回 + 隣 3 回）割に合わない。
   * 面積 0 の面と裏返った面は角度が出ないので硬い辺として扱う（＝跨がない）。
   */
  _byNormalAngle(mesh, angleDeg) {
    const T = mesh.tris, P = mesh.positions, G = this.groups, nt = mesh.nt;
    const RC = mesh.ringCount, RD = mesh.ringData, REX = mesh.ringExt;
    const q = this._ensureQueue(nt);
    const n1 = this._n1, n2 = this._n2;
    // 角度が NaN（UI の数値入力が空のときの parseFloat など）だと cosT が NaN に
    // なり「どの辺も硬い」判定になって面数と同じ数のグループができる。
    // 130 万面でそれをやると groupSizes / グループ色の確保だけで数十 MB 使うので、
    // 静かに既定値へ落とす。文字列で来ても動くように単項 + で数値化してから見る。
    const deg = +angleDeg;
    const cosT = Math.cos(clamp(Number.isFinite(deg) ? deg : 30, 0, 180) * Math.PI / 180);
    G.fill(-1, 0, nt);
    let gid = 0;
    for (let seed = 0; seed < nt; seed++) {
      if (G[seed] !== -1) continue;
      const si = seed * 3;
      if (T[si] === T[si + 1] && T[si + 1] === T[si + 2]) continue;
      let head = 0, tail = 0;
      G[seed] = gid;
      q[tail++] = seed;
      while (head < tail) {
        const t = q[head++];
        const ti = t * 3;
        const a = T[ti], b = T[ti + 1], c = T[ti + 2];
        const l1 = faceNormal(P, T, t, n1);
        if (l1 <= 0) continue;
        const n1x = n1[0], n1y = n1[1], n1z = n1[2];
        for (let e = 0; e < 3; e++) {
          const ea = e === 0 ? a : (e === 1 ? b : c);
          const eb = e === 0 ? b : (e === 1 ? c : a);
          const u = edgeNeighbor(T, RC, RD, REX, t, ea, eb);
          if (u < 0 || G[u] !== -1) continue;
          const l2 = faceNormal(P, T, u, n2);
          if (l2 <= 0) continue;
          const d = (n1x * n2[0] + n1y * n2[1] + n1z * n2[2]) / (l1 * l2);
          if (d >= cosT) { G[u] = gid; q[tail++] = u; }
        }
      }
      gid++;
    }
    return gid;
  }

  /**
   * 2 分割（kind 0 = マスク / kind 1 = 可視）。
   * 片方が空のときは ID を詰めて 1 グループにする（空グループを残さない）。
   */
  _bySplit(mesh, kind, threshold) {
    const T = mesh.tris, G = this.groups, nt = mesh.nt;
    const MK = mesh.mask, V = this.vis;
    const inv3 = 1 / 3;
    let n0 = 0, n1 = 0;
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) { G[t] = -1; continue; }
      let second;
      if (kind === 0) second = (MK[a] + MK[b] + MK[c]) * inv3 >= threshold;
      else second = V[t] === 0;
      if (second) { G[t] = 1; n1++; } else { G[t] = 0; n0++; }
    }
    if (n1 === 0) return n0 > 0 ? 1 : 0;
    if (n0 === 0) {
      for (let t = 0; t < nt; t++) if (G[t] === 1) G[t] = 0;
      return 1;
    }
    return 2;
  }

  _all(mesh) {
    const T = mesh.tris, G = this.groups, nt = mesh.nt;
    let live = 0;
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) { G[t] = -1; continue; }
      G[t] = 0; live++;
    }
    return live > 0 ? 1 : 0;
  }

  // --- 表示操作 -----------------------------------------------------------

  hideGroup(mesh, id) { return this._setGroupVis(mesh, id, 0); }
  showGroup(mesh, id) { return this._setGroupVis(mesh, id, 1); }

  _setGroupVis(mesh, id, on) {
    this.sync(mesh);
    if (id < 0) return this._stats(0);    // -1 は退化スロット用の番号。表示操作の対象外
    const T = mesh.tris, G = this.groups, V = this.vis, nt = mesh.nt;
    let changed = 0, vc = 0;
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      if (G[t] === id && V[t] !== on) { V[t] = on; changed++; }
      if (V[t] === 1) vc++;
    }
    this._visCount = vc;
    return this._stats(changed);
  }

  /** そのグループだけを表示する（Ctrl+Shift クリックのハイド操作そのもの） */
  showGroupOnly(mesh, id) {
    this.sync(mesh);
    const T = mesh.tris, G = this.groups, V = this.vis, nt = mesh.nt;
    let changed = 0, vc = 0;
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      const on = G[t] === id ? 1 : 0;
      if (V[t] !== on) { V[t] = on; changed++; }
      vc += on;
    }
    this._visCount = vc;
    return this._stats(changed);
  }

  showAll(mesh) {
    this.sync(mesh);
    const T = mesh.tris, V = this.vis, nt = mesh.nt;
    let changed = 0, vc = 0;
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      if (V[t] !== 1) { V[t] = 1; changed++; }
      vc++;
    }
    this._visCount = vc;
    return this._stats(changed);
  }

  invertVisible(mesh) {
    this.sync(mesh);
    const T = mesh.tris, V = this.vis, nt = mesh.nt;
    let changed = 0, vc = 0;
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      const on = V[t] === 1 ? 0 : 1;
      V[t] = on; changed++;
      vc += on;
    }
    this._visCount = vc;
    return this._stats(changed);
  }

  /** マスクされている面を隠す（mask >= threshold は「保護されている」側） */
  hideMasked(mesh, threshold = MASK_THRESHOLD) { return this._maskVis(mesh, threshold, false); }
  /** マスクされている面だけを表示する */
  showMaskedOnly(mesh, threshold = MASK_THRESHOLD) { return this._maskVis(mesh, threshold, true); }

  _maskVis(mesh, threshold, only) {
    this.sync(mesh);
    const T = mesh.tris, V = this.vis, MK = mesh.mask, nt = mesh.nt;
    const inv3 = 1 / 3;
    let changed = 0, vc = 0;
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      const masked = (MK[a] + MK[b] + MK[c]) * inv3 >= threshold;
      // only=false は「マスクされた面を隠す」だけなので、今隠れている面は触らない。
      // only=true は表示状態を作り直す（マスクされた面だけが見える状態にする）。
      let on;
      if (only) on = masked ? 1 : 0;
      else on = masked ? 0 : V[t];
      if (V[t] !== on) { V[t] = on; changed++; }
      vc += on;
    }
    this._visCount = vc;
    return this._stats(changed);
  }

  /**
   * 表示領域を steps 段だけ広げる。頂点を共有している面が次の段になる。
   *
   * 段ごとに「可視面の頂点」へ印を付けてから隠れている面を見る 2 パス構成。
   * 面から面へ辿ると 1 段のうちに連鎖して一気に広がってしまうので、
   * 印を先に確定させることが必要。1 段が O(面数 + 頂点数)。
   */
  growVisible(mesh, steps = 1) { return this._dilate(mesh, steps, 1); }
  /** 表示領域を steps 段だけ狭める（境界の面から順に隠れる） */
  shrinkVisible(mesh, steps = 1) { return this._dilate(mesh, steps, 0); }

  _dilate(mesh, steps, on) {
    this.sync(mesh);
    const T = mesh.tris, V = this.vis, nt = mesh.nt, nv = mesh.nv;
    const flag = this._ensureVFlag(nv);
    const from = on === 1 ? 1 : 0;       // 印を付ける側（広げるなら可視、狭めるなら非可視）
    const n = Math.max(0, Math.round(steps || 0));
    let changed = 0;
    for (let it = 0; it < n; it++) {
      flag.fill(0, 0, nv);
      for (let t = 0; t < nt; t++) {
        if (V[t] !== from) continue;
        const i = t * 3;
        const a = T[i], b = T[i + 1], c = T[i + 2];
        if (a === b && b === c) continue;
        flag[a] = 1; flag[b] = 1; flag[c] = 1;
      }
      let step = 0;
      for (let t = 0; t < nt; t++) {
        if (V[t] === from) continue;
        const i = t * 3;
        const a = T[i], b = T[i + 1], c = T[i + 2];
        if (a === b && b === c) continue;
        if (flag[a] === 1 || flag[b] === 1 || flag[c] === 1) { V[t] = on; step++; }
      }
      if (step === 0) break;             // これ以上動かない
      changed += step;
    }
    if (changed > 0) this._visCount += on === 1 ? changed : -changed;
    return this._stats(changed);
  }

  // --- 描画への出口 -------------------------------------------------------

  /**
   * 可視な三角形だけを詰めたインデックス配列を作る。
   *
   * 返す indices は使い回しのバッファなので、長さではなく count（描くインデックス数）
   * を見ること。allVisible が true なら呼び出し側は通常のインデックスバッファに
   * 戻していい（この関数を呼ぶ必要すらない）。
   * O(面数) なので毎フレーム呼ばず、visVersion が変わったときだけ呼ぶ。
   */
  buildVisibleIndices(mesh) {
    this.sync(mesh);
    const T = mesh.tris, V = this.vis, nt = mesh.nt;
    // 先に数えてから確保する。_visCount を信じてバッファを取ると、もし
    // どこかで数がずれていたときに「入り切らなかった面が黙って消える」ため。
    // vis は 1 バイト配列なので、この 1 パスは書き込みループに比べて無視できる。
    let live = 0;
    for (let t = 0; t < nt; t++) {
      if (V[t] === 0) continue;
      const i = t * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
      live++;
    }
    this._visCount = live;
    let idx = this._indices;
    if (idx.length < live * 3) {
      idx = new Uint32Array(Math.max(3072, Math.ceil(live * 3 * 1.25)));
      this._indices = idx;
    }
    let w = 0;
    for (let t = 0; t < nt; t++) {
      if (V[t] === 0) continue;
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;  // 退化スロットは GPU に渡さない
      idx[w++] = a; idx[w++] = b; idx[w++] = c;
    }
    return {
      indices: idx,
      count: w,                          // drawIndexed に渡す値（= 面数 * 3）
      tris: w / 3,
      allVisible: this._visCount >= this._liveTris,
      version: this.visVersion,
    };
  }

  /**
   * グループ色を頂点カラー配列に焼く（色分け表示用）。
   * 面属性を頂点に落とすので境界の頂点は「最後に書いた面の色」になる。
   * mesh.colors を直接渡すとポリペイントが消えるので、別バッファを渡すこと。
   */
  buildVertexGroupColors(mesh, out = null) {
    this.sync(mesh);
    const T = mesh.tris, G = this.groups, nt = mesh.nt, nv = mesh.nv;
    let C = out;
    if (!C || C.length < nv * 3) C = new Float32Array(nv * 3);
    const ng = Math.max(1, this._groupCount);
    if (this._gcol.length < ng * 3) this._gcol = new Float32Array(ng * 3);
    const gc = this._gcol;
    for (let g = 0; g < ng; g++) {
      const rgb = groupColorOf(g);
      gc[g * 3] = rgb[0]; gc[g * 3 + 1] = rgb[1]; gc[g * 3 + 2] = rgb[2];
    }
    C.fill(0.58, 0, nv * 3);
    for (let t = 0; t < nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      const g = G[t];
      if (g < 0 || g >= ng) continue;
      const s = g * 3;
      const r = gc[s], gg = gc[s + 1], bb = gc[s + 2];
      const ia = a * 3, ib = b * 3, ic = c * 3;
      C[ia] = r; C[ia + 1] = gg; C[ia + 2] = bb;
      C[ib] = r; C[ib + 1] = gg; C[ib + 2] = bb;
      C[ic] = r; C[ic + 1] = gg; C[ic + 2] = bb;
    }
    return { colors: C, groups: ng };
  }

  bytes() {
    return this.groups.byteLength + this.vis.byteLength + this._queue.byteLength
      + this._vflag.byteLength + this._indices.byteLength + this._gcol.byteLength;
  }

  // --- 内部 ---------------------------------------------------------------

  _ensureQueue(nt) {
    if (this._queue.length < nt) this._queue = new Int32Array(Math.max(2048, nt));
    return this._queue;
  }

  _ensureVFlag(nv) {
    if (this._vflag.length < nv) this._vflag = new Uint8Array(Math.max(1024, nv));
    return this._vflag;
  }

  _stats(changed) {
    if (changed > 0) { this.visVersion++; this._pristine = false; }
    return {
      changed,
      visible: this._visCount,
      hidden: this._liveTris - this._visCount,
      allVisible: this._visCount >= this._liveTris,
      groups: this._groupCount,
    };
  }
}
