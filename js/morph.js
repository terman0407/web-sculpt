// ---------------------------------------------------------------------------
// morph.js
// ZBrush の Morph Target 相当。「今の形を覚えておいて、あとで比べる / 戻す」。
//
//   Store    : 現在の座標を丸ごと覚える（記憶するのは座標だけ）
//   Switch   : 現在の形と記憶した形を入れ替える（見比べる用。2 回で厳密に元へ戻る）
//   Restore  : 記憶した形へ戻す。amount で部分的に戻せる
//   Morph ブラシ : 領域の頂点だけ、減衰重み × amount で記憶形状へ戻す
//   Amplify  : 記憶形状からの差分を factor 倍する（ZBrush の Morph Diff 相当）
//
// 設計上のポイント:
//  * 座標のコピー 1 本しか持たない。法線 / 色 / マスクは記憶しない。Morph の用途は
//    「彫った所を部分的に元に戻す」であって、スナップショット復元（history）とは別物。
//    覚えるものを増やすと数百万頂点で数十 MB を余分に食うだけで得がない。
//  * 頂点番号が同じ意味を持つ間だけ有効。dyntopo / ダイナメッシュ / SDiv / compact /
//    Undo は番号を振り替えるので、mesh.topoVersion と nv を見張って無効化する
//    （subdiv.js のレベル管理と同じ考え方。ZBrush でも Sculptris Pro と併用できない）。
//  * 「戻し切る」ケースは補間ではなく代入にしてある。f >= 1 のときに lerp を通すと
//    float32 の丸めで記憶形状と 1 ビットずれることがあり、Switch → Switch や
//    Restore(1) が厳密に一致しなくなる。
//  * マスクの規約は brushes.js と同じ: 1 = 完全に保護、0 = 自由。掛けるのは
//    (1 - clamp(mask,0,1))。ただし Switch だけはマスクを見ない（後述）。
// ---------------------------------------------------------------------------

import { clamp } from './math.js';
import { falloff } from './brushes.js';

/**
 * UI のブラシ一覧へ差し込むための記述子。
 * brushes.js の BRUSHES に混ぜて使う（このモジュールから既存配列は書き換えない）。
 */
export const MORPH_BRUSH = {
  id: 'morph', name: 'Morph', jp: 'モーフ', short: 'モーフ', icon: '⟲',
  hint: '記憶した形へ部分的に戻す（先に Store が必要）',
};

/**
 * ブラシ減衰重みを作る。brushes.js の falloff をそのまま使うので、
 * 他のブラシと当たりの硬さ（Focal Shift）が一致する。
 *
 * マスクはここでは掛けない。morphBrush 側で掛けるので、両方で掛けると
 * 保護が二乗になってしまう（BrushEngine.w を流用する場合は ignoreMask: true で
 * 呼ぶこと。理由は同じ）。
 *
 * @param {SculptMesh} mesh
 * @param {Int32Array|number[]} verts 領域頂点
 * @param {number} count 有効数
 * @param {ArrayLike<number>} center ブラシ中心 (world)
 * @param {number} radius ブラシ半径 (world)
 * @param {number} focal -1..1
 * @param {Float32Array|null} out 使い回すバッファ（count 以上あればそのまま使う）
 * @returns {Float32Array} 重み（0..1）
 */
export function computeMorphWeights(mesh, verts, count, center, radius, focal = 0, out = null) {
  const w = out !== null && out.length >= count ? out : new Float32Array(Math.max(1024, count));
  const P = mesh.positions;
  const cx = center[0], cy = center[1], cz = center[2];
  const invR = 1 / Math.max(1e-8, radius);
  const f0 = clamp(focal, -1, 1);
  for (let k = 0; k < count; k++) {
    const i = verts[k] * 3;
    const dx = P[i] - cx, dy = P[i + 1] - cy, dz = P[i + 2] - cz;
    let t = Math.sqrt(dx * dx + dy * dy + dz * dz) * invR;
    if (t > 1) t = 1;
    w[k] = falloff(t, f0);
  }
  return w;
}

export class MorphTarget {
  constructor() {
    this.pos = null;      // 記憶した座標（Float32Array, stride 3）。null = 未記憶
    this.nv = 0;          // 記憶時の mesh.nv（死んだスロットを含むスロット数）
    this.liveVerts = 0;   // 記憶時の生存頂点数（UI 表示用）
    this.guard = -1;      // 記憶時の mesh.topoVersion
    this.stamp = 0;       // Store した回数。UI が「更新された」ことを出せる
  }

  get has() { return this.pos !== null; }

  /**
   * 現在の形を記憶する。
   * @returns {object} 統計
   */
  store(mesh) {
    const need = mesh.nv * 3;
    // 260 万頂点だと 1 本 30MB を超える。Store を押し直すだけで毎回 30MB の
    // ゴミが出るのは避けたいので、同じ長さなら確保し直さず上書きする。
    if (this.pos === null || this.pos.length !== need) this.pos = new Float32Array(need);
    this.pos.set(mesh.positions.subarray(0, need));
    this.nv = mesh.nv;
    this.liveVerts = mesh.liveVerts;
    this.guard = mesh.topoVersion;
    this.stamp++;
    return { verts: this.liveVerts, bytes: this.pos.byteLength, stamp: this.stamp };
  }

  clear() {
    this.pos = null;
    this.nv = 0;
    this.liveVerts = 0;
    this.guard = -1;
  }

  bytes() { return this.pos === null ? 0 : this.pos.byteLength; }

  /**
   * まだ使えるか。見ているのは「頂点番号が記憶時と同じ意味を持つか」だけ。
   *
   * ブラシで形が変わっても番号は動かないので有効なまま（それが Morph ブラシの前提）。
   * 一方 dyntopo / ダイナメッシュ / SDiv / compact / Undo は番号を振り替えるか
   * スロット数を変えるので、topoVersion か nv のどちらかで必ず引っかかる。
   * ここを緩めると「別の頂点の座標へ戻す」ことになって形が崩壊する。
   *
   * liveVerts も見るのは、死んだスロットの再利用を捕まえるため。addVertex は
   * フリーリストから取るときに nv も topoVersion も動かさないので、nv と
   * topoVersion だけだと「消えた頂点の座標」を新しい頂点へ復元してしまう
   * （実際に collapse でゴミが残ったメッシュで再現した）。生存数が変わる操作は
   * 必ず addVertex / removeVertex を通るので、これで両方向とも塞がる。
   * ブラシは生存数を変えないので、Morph ブラシの前提は壊れない。
   *
   * 自動では破棄しない（has は true のまま）。UI が「トポロジが変わったので
   * モーフターゲットは使えない」と出せるようにしておきたいので、
   * 捨てるかどうかは呼び出し側の判断に任せる。
   */
  validate(mesh) {
    if (this.pos === null) return false;
    return mesh.nv === this.nv && mesh.liveVerts === this.liveVerts
      && mesh.topoVersion === this.guard;
  }

  /**
   * 現在の形と記憶した形を入れ替える（ZBrush の Switch）。
   *
   * マスクは見ない。見てしまうと「2 回押したら元に戻る」性質が壊れる
   * （半分マスクされた頂点は入れ替えの途中で止まり、もう一度押しても戻らない）。
   * Switch は見比べるための操作なので、全体をそのまま交換するのが正しい。
   * 部分的に戻したいときは restore / morphBrush を使う。
   * @returns {object} 統計
   */
  switchTo(mesh) {
    if (!this.validate(mesh)) return { valid: false, swapped: 0 };
    const P = mesh.positions, Q = this.pos, A = mesh.vAlive;
    const nv = this.nv;
    let n = 0;
    for (let v = 0; v < nv; v++) {
      if (A[v] === 0) continue;      // 死んだスロットの座標は意味を持たない
      const i = v * 3;
      let t = P[i]; P[i] = Q[i]; Q[i] = t;
      t = P[i + 1]; P[i + 1] = Q[i + 1]; Q[i + 1] = t;
      t = P[i + 2]; P[i + 2] = Q[i + 2]; Q[i + 2] = t;
      n++;
    }
    this._finish(mesh);
    return { valid: true, swapped: n };
  }

  /**
   * 記憶形状との差の統計。ZBrush には無いが、Switch で目視するより
   * 「どれだけ彫ったか」が分かるので UI に出す用。
   *
   * @param {number} eps 動いたと見なす距離（world 単位の絶対値）
   * @returns {object} verts=生存頂点数, changed=eps 超え頂点数,
   *                   maxDist / avgDist（生存頂点平均）/ avgChanged（動いた頂点だけの平均）
   */
  createDiff(mesh, eps = 1e-6) {
    if (!this.validate(mesh)) {
      return { valid: false, verts: 0, changed: 0, maxDist: 0, avgDist: 0, avgChanged: 0, maxVert: -1 };
    }
    const P = mesh.positions, Q = this.pos, A = mesh.vAlive;
    const nv = this.nv;
    let live = 0, changed = 0, sum = 0, sumCh = 0, maxD2 = 0, maxV = -1;
    for (let v = 0; v < nv; v++) {
      if (A[v] === 0) continue;
      const i = v * 3;
      const dx = P[i] - Q[i], dy = P[i + 1] - Q[i + 1], dz = P[i + 2] - Q[i + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      live++;
      if (d2 > maxD2) { maxD2 = d2; maxV = v; }
      // 平均変位は二乗平均だと大きい変位に引っぱられて「彫った量」の感覚と合わない。
      // 頂点あたり sqrt 1 回で済むのでそのまま距離で平均する（ボタン操作なので十分安い）。
      const d = Math.sqrt(d2);
      sum += d;
      if (d > eps) { changed++; sumCh += d; }
    }
    return {
      valid: true,
      verts: live,
      changed,
      maxDist: Math.sqrt(maxD2),
      avgDist: live > 0 ? sum / live : 0,
      avgChanged: changed > 0 ? sumCh / changed : 0,
      maxVert: maxV,
    };
  }

  /**
   * 記憶した形へ戻す。amount 0..1 で部分的に戻せる。
   * @returns {object} 統計（changed = 実際に座標が書き換わった頂点数）
   */
  restore(mesh, amount = 1) {
    if (!this.validate(mesh)) return { valid: false, changed: 0, maxDist: 0 };
    const a = clamp(amount, 0, 1);
    // NaN もここで落ちる（NaN は比較が全部 false なので > 0 を通らない）。
    // 座標に NaN が入ると法線も曲率も壊れて復帰不能になるので必ず弾く。
    if (!(a > 0)) return { valid: true, changed: 0, maxDist: 0 };

    const P = mesh.positions, Q = this.pos, MK = mesh.mask, A = mesh.vAlive;
    const nv = this.nv;
    let changed = 0, maxD2 = 0;
    for (let v = 0; v < nv; v++) {
      if (A[v] === 0) continue;
      // マスクを先に見て 1 以上（と NaN）を弾く。mask に NaN が紛れていると
      // f が NaN になり、そのまま lerp を通って座標が NaN になる（法線も曲率も
      // 壊れて復帰不能）。保護量が分からない頂点は「動かさない」側に倒す。
      const mk = clamp(MK[v], 0, 1);
      if (!(mk < 1)) continue;
      const f = a * (1 - mk);
      const i = v * 3;
      const ox = P[i], oy = P[i + 1], oz = P[i + 2];
      if (f >= 1) {
        P[i] = Q[i]; P[i + 1] = Q[i + 1]; P[i + 2] = Q[i + 2];
      } else {
        P[i] = ox + (Q[i] - ox) * f;
        P[i + 1] = oy + (Q[i + 1] - oy) * f;
        P[i + 2] = oz + (Q[i + 2] - oz) * f;
      }
      // 「動いた頂点数」は書き換え後の値と比べて数える。f が極小で float32 の
      // 丸めに埋もれた頂点を動いたことにしないため（UI の数字が嘘にならない）。
      const dx = P[i] - ox, dy = P[i + 1] - oy, dz = P[i + 2] - oz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 0) { changed++; if (d2 > maxD2) maxD2 = d2; }
    }
    if (changed > 0) this._finish(mesh);
    return { valid: true, changed, maxDist: Math.sqrt(maxD2) };
  }

  /**
   * 記憶形状からの差分を factor 倍する（ZBrush の Deformation > Morph Diff 相当）。
   * 1 = 変化なし / 2 = 2 倍に強調 / 0 = 記憶形状そのもの（= restore(1)）。
   * あとからディテールを強めたいときに使う。
   * @returns {object} 統計
   */
  amplify(mesh, factor = 1) {
    if (!this.validate(mesh)) return { valid: false, changed: 0, maxDist: 0 };
    // 負にすると差分が反転する（凹凸が裏返る）。使い道はあるので許すが、
    // NaN / Inf / 極端な値が入ると座標が壊れて戻せなくなるので範囲で守る。
    const k = clamp(Number.isFinite(factor) ? factor : 1, -8, 8) - 1;
    // factor が 1 のときは 1 バイトも触らない。0 を足すだけでも法線の再計算が
    // 走ってしまい、「恒等なのに毎回 O(n)」になるのを避ける。
    if (k === 0) return { valid: true, changed: 0, maxDist: 0 };

    const P = mesh.positions, Q = this.pos, MK = mesh.mask, A = mesh.vAlive;
    const nv = this.nv;
    let changed = 0, maxD2 = 0;
    for (let v = 0; v < nv; v++) {
      if (A[v] === 0) continue;
      const mk = clamp(MK[v], 0, 1);
      if (!(mk < 1)) continue;                   // マスク 1（と NaN）は動かさない
      const f = k * (1 - mk);
      const i = v * 3;
      const ox = P[i], oy = P[i + 1], oz = P[i + 2];
      // 差分 (p - q) を f 倍ぶん足す形にしておくと、f = 0 が厳密な恒等になる。
      P[i] = ox + (ox - Q[i]) * f;
      P[i + 1] = oy + (oy - Q[i + 1]) * f;
      P[i + 2] = oz + (oz - Q[i + 2]) * f;
      const dx = P[i] - ox, dy = P[i + 1] - oy, dz = P[i + 2] - oz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 0) { changed++; if (d2 > maxD2) maxD2 = d2; }
    }
    if (changed > 0) this._finish(mesh);
    return { valid: true, changed, maxDist: Math.sqrt(maxD2) };
  }

  /**
   * Morph ブラシ 1 ダブ。領域の頂点だけを、減衰重み × amount で記憶形状へ戻す。
   * 「彫った所を部分的に元に戻す」用途（ZBrush の Morph ブラシと同じ）。
   *
   * 法線 / 曲率はここでは直さない。ブラシ経路では Sculptor が領域ぶんだけ
   * まとめて更新する（BrushEngine.apply と同じ約束）。dirty マークだけ付ける。
   *
   * @param {SculptMesh} mesh
   * @param {Int32Array|number[]} verts 領域頂点
   * @param {number} count 有効数
   * @param {ArrayLike<number>} weights 減衰重み（verts と同じ並び。マスクは含めない）
   * @param {number} amount 0..1（ブラシ強度）
   * @returns {object} 統計
   */
  morphBrush(mesh, verts, count, weights, amount = 1) {
    if (!this.validate(mesh)) return { valid: false, changed: 0, maxDist: 0 };
    const a = clamp(amount, 0, 1);
    if (!(a > 0) || count <= 0) return { valid: true, changed: 0, maxDist: 0 };

    const P = mesh.positions, Q = this.pos, MK = mesh.mask, A = mesh.vAlive;
    const nv = this.nv;
    let changed = 0, maxD2 = 0;
    for (let k = 0; k < count; k++) {
      const v = verts[k];
      // 記憶に無い番号（領域リストが古い / 記憶後に伸びた）は戻す先が無いので飛ばす。
      // validate を通っていれば起きないが、ここで落ちると範囲外の座標を読むので保険。
      if (v < 0 || v >= nv || A[v] === 0) continue;
      let f = weights[k];
      if (!(f > 0)) continue;                       // NaN もここで落ちる
      const mk = clamp(MK[v], 0, 1);
      if (!(mk < 1)) continue;                      // マスク 1（と NaN）は動かさない
      f *= a * (1 - mk);
      if (f <= 0) continue;                         // 重みが極小でアンダーフローした場合
      if (f > 1) f = 1;                             // 行き過ぎない（記憶形状を越えない）
      const i = v * 3;
      const ox = P[i], oy = P[i + 1], oz = P[i + 2];
      if (f >= 1) {
        P[i] = Q[i]; P[i + 1] = Q[i + 1]; P[i + 2] = Q[i + 2];
      } else {
        P[i] = ox + (Q[i] - ox) * f;
        P[i + 1] = oy + (Q[i + 1] - oy) * f;
        P[i + 2] = oz + (Q[i + 2] - oz) * f;
      }
      const dx = P[i] - ox, dy = P[i + 1] - oy, dz = P[i + 2] - oz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 0) {
        changed++;
        if (d2 > maxD2) maxD2 = d2;
        mesh.markVert(v);
      }
    }
    return { valid: true, changed, maxDist: Math.sqrt(maxD2) };
  }

  /**
   * 全体を動かす操作の後始末。全頂点に触るので範囲更新より全体再計算が速い
   * （sculptor.js の smoothAll と同じ扱い）。markAllDirty は両者の中で呼ばれる。
   */
  _finish(mesh) {
    mesh.computeAllNormals();
    mesh.computeAllCurvature();
    mesh.geomVersion++;
  }
}
