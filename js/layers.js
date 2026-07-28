// ---------------------------------------------------------------------------
// layers.js
// ZBrush の Layers パレット相当。「ベース形状の上に載る変位」を何枚も重ね、
// それぞれ強度 -1..1 で効かせる。強度を 0 にすればそのレイヤーで彫った分だけが消え、
// 1 に戻せば元どおりになる（他のレイヤーの彫刻は一切触らない）。
//
// 設計上のポイント:
//  * 変位は全頂点ぶんの Float32Array では持たない。300 万頂点 × 12B × 10 枚で 360MB に
//    なってしまう。彫刻が当たるのはメッシュのごく一部なので、「実際に触られた頂点だけ」を
//    (index, dx, dy, dz) の並行配列（Int32Array + Float32Array）で持つ。
//  * 記録は 2 段 API。呼び出し側がブラシ適用の前後で captureBefore / commitAfter を呼び、
//    その差分を記録レイヤーへ「加算」する。1 ダブごとに閉じた対にしておけば、
//    同じ場所を何度なでても（前回の after が次回の before になるので）変位は
//    二重に入らず、ストローク全体では最初の位置からの総変位が積まれる。
//  * 強度 s のレイヤーへ記録するときは変位を 1/s 倍して積む。rebuild で s 倍されるので、
//    「今画面に見えている形」と rebuild の結果が一致する（記録中に強度を触っても崩れない）。
//  * 接続が変わると頂点番号が意味を失うので、レイヤーは無効になる。ZBrush でも
//    Sculptris Pro / DynaMesh はレイヤーと併用できない。topoVersion で検出する。
// ---------------------------------------------------------------------------

import { DIRTY_SHIFT } from './mesh.js';

// 強度がこれ未満のレイヤーは「切れている」ものとして扱う。記録時に 1/強度 を掛けるので、
// ゼロ割りで Inf/NaN がメッシュ全体に伝染するのを防ぐ意味もある。
const OFF_EPS = 1e-4;

/** レイヤーの実効強度。非表示 / ほぼ 0 は「寄与なし」の 0 に丸める */
function factorOf(L) {
  if (!L.visible) return 0;
  const f = L.intensity;
  return (f > -OFF_EPS && f < OFF_EPS) ? 0 : f;
}

function makeLayer(name) {
  return {
    name: String(name),
    intensity: 1,
    visible: true,
    idx: new Int32Array(0),     // 触った頂点（0..n-1 が有効）
    disp: new Float32Array(0),  // 対応する変位（stride 3）
    n: 0,
  };
}

/** 疎配列を need 件入る大きさまで広げる（内容は保持する） */
function reserveLayer(L, need) {
  if (need <= L.idx.length) return;
  const cap = Math.max(need, Math.ceil(L.idx.length * 1.6), 1024);
  const idx = new Int32Array(cap);
  idx.set(L.idx.subarray(0, L.n));
  L.idx = idx;
  const disp = new Float32Array(cap * 3);
  disp.set(L.disp.subarray(0, L.n * 3));
  L.disp = disp;
}

export class SculptLayers {
  constructor() {
    this.layers = [];
    this.rec = -1;             // 記録対象のレイヤー index（-1 で無し）

    this.base = null;          // ベース形状（Float32Array, stride 3）
    this.baseNv = 0;           // setBase 時の mesh.nv（頂点スロットの上限）
    this.baseLive = 0;         // setBase 時の mesh.liveVerts（生存頂点数）
    this.guard = -1;           // setBase した時点の mesh.topoVersion

    // 記録レイヤーの「頂点 → 変位配列の位置 + 1」。0 を未登録に使うので、
    // 確保しただけ（ゼロ埋め）の状態がそのまま「空」になり fill(-1) が要らない。
    // 全レイヤーで 1 本を共有する（記録対象は常に 1 枚なので足りる）。頂点あたり
    // 4B なので、レイヤーごとに持つ場合の 1/10 で済む。
    this.slotOf = null;
    // slotOf がどのレイヤーを指しているか。index ではなく実体を持つ。
    // 追加 / 削除 / 複製で並びが変わっても指し先がずれない。
    this.slotLayer = null;

    // rebuild で「実際に動かした頂点数」を重複なく数えるためのスタンプ。
    // 単調増加させるので、確保しただけの配列（ゼロ）と衝突せずクリアも要らない。
    this.vStamp = null;
    this.stampId = 0;

    // captureBefore が覚えておく彫刻前の位置
    this.capVerts = new Int32Array(0);
    this.capPos = new Float32Array(0);
    this.capCount = 0;

    // 消えたレイヤーが触っていた頂点。rebuild は「どれかのレイヤーが持っている頂点」しか
    // 見ないので、削除やベイクで持ち主がいなくなった頂点はここに預けておかないと
    // 彫刻が入ったまま取り残される（実際にそのバグを出した）。次の rebuild で回収する。
    this.orphan = new Int32Array(0);
    this.orphanCount = 0;
  }

  get count() { return this.layers.length; }
  get recording() { return this.rec; }

  // --- ベースと有効性 -----------------------------------------------------

  /** 現在の形をベースにしてレイヤーを全消去する */
  setBase(mesh) {
    this.clear();
    const nv = mesh.nv;
    // 死んだスロットも含めて丸ごと写す。生きている頂点だけ詰めると番号が変わり、
    // レイヤーの idx が指す先が mesh.positions と食い違ってしまう。
    this.base = mesh.positions.slice(0, nv * 3);
    this.baseNv = nv;
    this.baseLive = mesh.liveVerts;
    this.guard = mesh.topoVersion;
    return { verts: nv, bytes: this.bytes() };
  }

  /**
   * トポロジが変わっていないか。変わっていたら（頂点番号が意味を失うので）
   * レイヤーを捨てて false を返す。呼び出し側は警告を出して setBase をやり直す。
   */
  validate(mesh) {
    if (this.base === null) return false;
    // compact / dyntopo / DynaMesh / undo はすべて topoVersion を進める。
    // nv が縮んだ場合は idx が範囲外を指しうるので、そちらも見ておく。
    // 頂点数も見るのは mesh.addVertex が topoVersion を進めないため。死んだスロットが
    // 再利用されると、そのスロットの base は「前の持ち主の座標」なので、そこを彫ると
    // rebuild で全く別の場所へ飛ぶ。生存頂点数が変わった時点で捨てるのが安全。
    if (mesh.topoVersion !== this.guard || mesh.nv < this.baseNv
      || mesh.liveVerts !== this.baseLive) { this.clear(); return false; }
    return true;
  }

  clear() {
    this.layers.length = 0;
    this.rec = -1;
    this.slotOf = null;
    this.slotLayer = null;
    this.vStamp = null;
    this.capCount = 0;
    this.orphan = new Int32Array(0);
    this.orphanCount = 0;
    this.base = null;
    this.baseNv = 0;
    this.baseLive = 0;
    this.guard = -1;
  }

  /** レイヤーが持っていた頂点を「持ち主なし」として預かる */
  _orphanize(L) {
    const need = this.orphanCount + L.n;
    if (need > this.orphan.length) {
      const a = new Int32Array(Math.max(1024, need, this.orphan.length * 2));
      a.set(this.orphan.subarray(0, this.orphanCount));
      this.orphan = a;
    }
    const O = this.orphan, idx = L.idx;
    let w = this.orphanCount;
    for (let k = 0, n = L.n; k < n; k++) O[w++] = idx[k];
    this.orphanCount = w;
  }

  _ensureSlots() {
    if (this.slotOf === null || this.slotOf.length < this.baseNv) {
      this.slotOf = new Int32Array(this.baseNv);
      this.slotLayer = null;      // 作り直したので束縛は無効
    }
  }

  _ensureStamp() {
    if (this.vStamp === null || this.vStamp.length < this.baseNv) {
      this.vStamp = new Int32Array(this.baseNv);
      this.stampId = 0;
    }
  }

  /**
   * slotOf を L の内容に張り替える。前のレイヤーぶんは「そのレイヤーが持っている
   * 頂点リスト」だけ 0 に戻せばよいので、配列全体を触らずに済む
   * （3M 頂点で fill するのと、触った数万件だけ戻すのとで桁が違う）。
   */
  _bindSlots(L) {
    if (this.slotLayer === L) return;
    const S = this.slotOf;
    const prev = this.slotLayer;
    if (prev !== null) {
      const idx = prev.idx;
      for (let k = 0, n = prev.n; k < n; k++) S[idx[k]] = 0;
    }
    if (L !== null) {
      const idx = L.idx;
      for (let k = 0, n = L.n; k < n; k++) S[idx[k]] = k + 1;
    }
    this.slotLayer = L;
  }

  // --- レイヤー操作 -------------------------------------------------------

  list() {
    const layers = this.layers;
    const out = new Array(layers.length);
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      out[i] = { index: i, name: L.name, intensity: L.intensity, visible: L.visible, verts: L.n };
    }
    return out;
  }

  /** 追加して記録対象にする。ベース未設定なら何もせず -1 を返す */
  add(name = 'Layer') {
    if (this.base === null) return -1;
    this.layers.push(makeLayer(name));
    this.rec = this.layers.length - 1;
    return this.rec;
  }

  /** 削除する。形が変わるので呼び出し側は続けて rebuild すること */
  remove(index) {
    const layers = this.layers;
    if (index < 0 || index >= layers.length) return false;
    const L = layers[index];
    if (this.slotLayer === L) this._bindSlots(null);   // 消えた配列を指したままにしない
    this._orphanize(L);
    layers.splice(index, 1);
    if (this.rec === index) this.rec = -1;
    else if (this.rec > index) this.rec--;
    return true;
  }

  /** 複製して元の 1 つ上に挿す。記録対象は変えない */
  duplicate(index) {
    const layers = this.layers;
    if (index < 0 || index >= layers.length) return -1;
    const S = layers[index];
    const D = makeLayer(S.name + ' copy');
    D.intensity = S.intensity;
    D.visible = S.visible;
    D.idx = S.idx.slice(0, S.n);
    D.disp = S.disp.slice(0, S.n * 3);
    D.n = S.n;
    const at = index + 1;
    layers.splice(at, 0, D);
    if (this.rec >= at) this.rec++;
    return at;
  }

  rename(index, name) {
    if (index < 0 || index >= this.layers.length) return false;
    this.layers[index].name = String(name);
    return true;
  }

  /** 強度 -1..1。形が変わるので呼び出し側は続けて rebuild すること */
  setIntensity(index, v) {
    if (index < 0 || index >= this.layers.length) return 0;
    // NaN を通すとメッシュ全体が NaN で埋まる（スライダから来る値なので実際に起きる）
    let x = +v;
    if (x !== x) x = 0;
    x = x < -1 ? -1 : (x > 1 ? 1 : x);
    this.layers[index].intensity = x;
    return x;
  }

  setVisible(index, on) {
    if (index < 0 || index >= this.layers.length) return false;
    this.layers[index].visible = !!on;
    return true;
  }

  /** 記録対象を切り替える。index < 0 で記録を止める */
  select(index) {
    if (index < 0) { this.rec = -1; return true; }
    if (index >= this.layers.length) return false;
    this.rec = index;
    return true;
  }

  // --- 記録 ---------------------------------------------------------------

  /**
   * 彫刻の直前に呼ぶ。これから動かす頂点の位置を覚えておく。
   * @returns {number} 覚えた頂点数（記録レイヤーが無い / 無効なら 0）
   */
  captureBefore(mesh, verts, count) {
    this.capCount = 0;
    if (!this.validate(mesh) || this.rec < 0 || count <= 0) return 0;
    // count が verts の長さを超えていると、余った枠には捕獲バッファの前回の残りが
    // 入ったままになり、commitAfter で「頂点 0 が大きく動いた」と誤認して
    // でたらめな変位を積んでしまう（バッファは使い回しているため）。
    const lim = verts.length;
    if (lim >= 0 && count > lim) count = lim;
    if (this.capVerts.length < count) {
      const cap = Math.max(1024, Math.ceil(count * 1.6));
      this.capVerts = new Int32Array(cap);
      this.capPos = new Float32Array(cap * 3);
    }
    const CV = this.capVerts, CP = this.capPos, P = mesh.positions;
    for (let k = 0; k < count; k++) {
      const v = verts[k];
      CV[k] = v;
      const i = v * 3, j = k * 3;
      CP[j] = P[i]; CP[j + 1] = P[i + 1]; CP[j + 2] = P[i + 2];
    }
    this.capCount = count;
    return count;
  }

  /**
   * 彫刻の直後に呼ぶ。差分を記録レイヤーへ加算する。
   *
   * 走査するのは常に captureBefore で捕まえた側。差分の基準（before）を持っている
   * 頂点はそれだけであり、リストが食い違っていた場合に基準の無い頂点を混ぜて
   * でたらめな変位を積むより、統計で知らせるほうが安全。
   *
   * @returns {object} 統計（レイヤーの総頂点数 / 新規に登録した数 / 実際に動いた数）
   */
  commitAfter(mesh, verts, count) {
    const n = this.capCount;
    this.capCount = 0;     // 対で使うものなので、commit したら必ず捕獲を捨てる
    // mismatch は「捕獲したのにリストが食い違った」ときだけ立てる。捕獲が無いとき
    // （記録レイヤー無し / 無効）にも立てると、記録していない間ずっと立ちっぱなしになり
    // UI の警告として使えなくなる。layer も、validate が clear() することがあるので
    // 実際に積む layer が確定してから入れる（破棄済みの index を報告しない）。
    const stats = { verts: 0, added: 0, moved: 0, skipped: 0, layer: -1, mismatch: n > 0 && count !== n };
    if (n === 0 || !this.validate(mesh) || this.rec < 0) return stats;

    const L = this.layers[this.rec];
    stats.layer = this.rec;
    this._ensureSlots();
    this._bindSlots(L);

    const f = factorOf(L);
    // rebuild で f 倍されるぶんを見越して 1/f 倍で積む。完全に切れているときだけは
    // 割れないのでそのまま積む（強度を上げれば彫った量がそのまま出てくる）。
    const inv = f === 0 ? 1 : 1 / f;

    const CV = this.capVerts, CP = this.capPos, P = mesh.positions, S = this.slotOf;
    const bnv = this.baseNv;
    let added = 0, moved = 0, skipped = 0;
    for (let k = 0; k < n; k++) {
      const v = CV[k];
      if (v < 0 || v >= bnv) { skipped++; continue; }   // ベース以降に生えた頂点は載せられない
      const i = v * 3, j = k * 3;
      const dx = P[i] - CP[j], dy = P[i + 1] - CP[j + 1], dz = P[i + 2] - CP[j + 2];
      const m2 = dx * dx + dy * dy + dz * dz;
      // 動いていない（マスク 1 / 減衰 0）頂点と、NaN / Inf をまとめて弾く。
      // NaN は比較が全部 false になるので、この 2 つの不等式で同時に落ちる。
      // ここで弾いておかないとマスクした頂点にも entry ができ、疎配列が太る。
      if (!(m2 > 0) || !(m2 < Infinity)) continue;
      let slot = S[v];
      if (slot === 0) {
        reserveLayer(L, L.n + 1);
        const w = L.n++;
        L.idx[w] = v;
        const d0 = w * 3;
        L.disp[d0] = 0; L.disp[d0 + 1] = 0; L.disp[d0 + 2] = 0;
        slot = w + 1;
        S[v] = slot;
        added++;
      }
      // reserveLayer で作り直されている可能性があるので、ここで読み直す
      const D = L.disp, d = (slot - 1) * 3;
      D[d] += dx * inv; D[d + 1] += dy * inv; D[d + 2] += dz * inv;
      moved++;
    }
    stats.verts = L.n; stats.added = added; stats.moved = moved; stats.skipped = skipped;
    return stats;
  }

  // --- 再構築 -------------------------------------------------------------

  /**
   * base + 全レイヤー × 強度 で mesh.positions を作り直す。
   *
   * 全頂点を舐めず「どれかのレイヤーが触った頂点」だけを対象にする。速さのためだけでなく、
   * レイヤーの外で加えられた編集（記録レイヤー無しで彫った結果など）を巻き戻して
   * しまわないためでもある。
   *
   * @param opts.normals   法線を張り直すか（既定 true）。強度スライダのドラッグ中など、
   *                       高密度で毎フレーム呼ぶ場所では false にして離したときに 1 回だけ計算する。
   * @param opts.curvature 曲率（キャビティ陰影）も張り直すか（既定 false）
   * @returns {object} 統計（動かした頂点数 / 効いているレイヤー数）
   */
  rebuild(mesh, opts = {}) {
    if (!this.validate(mesh)) return { verts: 0, layers: 0, invalid: true };
    const layers = this.layers;
    const P = mesh.positions, B = this.base;
    this._ensureStamp();
    const ST = this.vStamp, id = ++this.stampId;

    // markVert() はホットループで呼ぶと this への読み書きが 1 頂点あたり 8 回になるので、
    // mesh.js の法線計算と同じようにインライン展開してループ後に 1 回だけ書き戻す。
    const VB = mesh.vBlocks;
    let dMin = mesh.vDirtyMin, dMax = mesh.vDirtyMax;
    let bMin = mesh.vBlockMin, bMax = mesh.vBlockMax;

    // 1 パス目: 触られた頂点をベースへ戻す。同じ頂点を複数のレイヤーが持っていても
    // ベースを書くだけなので、重複して実行されても結果は変わらない。
    // 持ち主が消えた頂点（orphan）も同じ扱いで回収する。
    let uniq = 0;
    for (let li = 0; li <= layers.length; li++) {
      const idx = li < layers.length ? layers[li].idx : this.orphan;
      const n = li < layers.length ? layers[li].n : this.orphanCount;
      for (let k = 0; k < n; k++) {
        const v = idx[k], i = v * 3;
        P[i] = B[i]; P[i + 1] = B[i + 1]; P[i + 2] = B[i + 2];
        if (ST[v] !== id) { ST[v] = id; uniq++; }
        if (v < dMin) dMin = v;
        if (v > dMax) dMax = v;
        const bb = v >> DIRTY_SHIFT;
        VB[bb] = 1;
        if (bb < bMin) bMin = bb;
        if (bb > bMax) bMax = bb;
      }
    }
    this.orphanCount = 0;      // 回収したので預かりを空にする
    mesh.vDirtyMin = dMin; mesh.vDirtyMax = dMax;
    mesh.vBlockMin = bMin; mesh.vBlockMax = bMax;

    // 2 パス目: 可視かつ強度が乗っているレイヤーの寄与を足す。1 パス目を全部
    // 終えてから足すので、レイヤーが重なっている頂点でも正しく加算される。
    let active = 0;
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      const f = factorOf(L);
      if (f === 0 || L.n === 0) continue;
      active++;
      const idx = L.idx, D = L.disp, n = L.n;
      for (let k = 0; k < n; k++) {
        const i = idx[k] * 3, j = k * 3;
        P[i] += D[j] * f; P[i + 1] += D[j + 1] * f; P[i + 2] += D[j + 2] * f;
      }
    }

    mesh.geomVersion++;
    if (opts.normals !== false) mesh.computeAllNormals();
    if (opts.curvature) mesh.computeAllCurvature();
    return { verts: uniq, layers: active, invalid: false };
  }

  /**
   * そのレイヤーをベースへ焼き込んで削除する。
   *
   * 焼き込みには「今の実効強度」を使う。非表示 / 強度 0 のレイヤーの変位は今の形に
   * 入っていないので、それを 1 倍で焼くと見た目が変わってしまう。実効強度で焼けば
   * 「ベイクしても形は変わらない」が常に成り立つ（切れたレイヤーは単に消える）。
   *
   * 呼び出し側は続けて rebuild すること（形は変わらないが、焼いた頂点の
   * 持ち主がいなくなるので、rebuild で回収してベースとの対応を締めておく）。
   */
  bake(index, mesh) {
    if (!this.validate(mesh)) return null;
    const layers = this.layers;
    if (index < 0 || index >= layers.length) return null;
    const L = layers[index];
    const f = factorOf(L);
    if (f !== 0) {
      const B = this.base, idx = L.idx, D = L.disp, n = L.n;
      for (let k = 0; k < n; k++) {
        const i = idx[k] * 3, j = k * 3;
        B[i] += D[j] * f; B[i + 1] += D[j + 1] * f; B[i + 2] += D[j + 2] * f;
      }
    }
    const stats = { name: L.name, index, verts: L.n, intensity: f, baked: f !== 0 };
    this.remove(index);
    return stats;
  }

  bytes() {
    let b = this.base === null ? 0 : this.base.byteLength;
    const layers = this.layers;
    for (let i = 0; i < layers.length; i++) b += layers[i].idx.byteLength + layers[i].disp.byteLength;
    if (this.slotOf !== null) b += this.slotOf.byteLength;
    if (this.vStamp !== null) b += this.vStamp.byteLength;
    return b + this.capVerts.byteLength + this.capPos.byteLength + this.orphan.byteLength;
  }
}
