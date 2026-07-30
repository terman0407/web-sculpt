// ---------------------------------------------------------------------------
// tools.js
// 各機能モジュール（デフォーム / マスクツール / スカルプトレイヤー / ポリグループ /
// トランスポーズ / クリップ / モーフ）をアプリへ束ねる層。
//
// モジュール側は「メッシュを操作する純粋なロジック」だけを持ち、DOM も WebGPU も
// 知らない。ここが state と履歴と描画更新を面倒みる担当。
// main.js に全部書くと 1200 行を超えるので切り出してある。
//
// 履歴（Undo）はモジュールではなくここで commit する。モジュールは「何頂点変えたか」
// を返すので、0 なら commit しない（空の Undo ステップができてしまう）。
// ---------------------------------------------------------------------------

import { DEFORMS, DEFORM_BY_ID, defaultOpts as deformDefaults, applyDeform } from './deform.js';
import { MASK_OPS, MASK_OP_BY_ID, applyMaskOp } from './masktools.js';
import { SculptLayers } from './layers.js';
import { PolyGroups, GROUP_METHODS } from './polygroups.js';
import { MorphTarget, computeMorphWeights } from './morph.js';
import { Transpose } from './transpose.js';
import { clipPlane, trimPlane, slicePlane, mirrorWeld, planeFromScreenLine, planeFromAxis } from './clip.js';
import { STROKES, strokeDefaults } from './alpha.js';
import { remesh, quadDominant, edgeLengthForTris } from './remesh.js';
import { initRemeshWorker, remeshInWorker, remeshWorkerState, remeshWorkerError, remeshWorkerWasm } from './remeshworker.js';
import { clamp } from './math.js';
import {
  editMeshFromSculpt, editMeshToSculpt, pickVert, pickEdge, pickFace, boxSelect,
} from './editmesh.js';
import {
  selectLoopOrRing, loopCut, extrudeSelectedFaces, insetSelectedFaces, insetRegion,
  subdivideSelectedFaces, bevelSelectedEdges, bridgeEdgeLoops,
} from './editops.js';

/** 変形とマスク操作の既定パラメータ一式（state に置く） */
export function defaultToolState() {
  const deform = { axis: 1, params: {} };
  for (const d of DEFORMS) deform.params[d.id] = deformDefaults(d.id);
  const mask = { id: MASK_OPS[0].id, mode: 'replace', params: {} };
  for (const op of MASK_OPS) {
    const p = {};
    for (const q of (op.params || [])) p[q.key] = q.def;
    mask.params[op.id] = p;
  }
  // ストロークタイプごとのパラメータ
  const strokeParams = {};
  for (const st of STROKES) strokeParams[st.id] = strokeDefaults(st.id);
  return { deform, mask, strokeParams };
}

export class Tools {
  /**
   * @param {object} ctx { state, getMesh, getSculptor, getRenderer, getUI, redraw, autosave }
   *   メッシュとレンダラは差し替わる（newMesh / 起動順）ので getter で受ける。
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.layers = new SculptLayers();
    this.groups = new PolyGroups();
    this.morph = new MorphTarget();
    this.gizmo = new Transpose();

    // 表示に反映済みのポリグループ可視バージョン。変わったときだけ GPU へ送る。
    this._visVersion = -1;
    // グループ色プレビュー用に退避した本来の頂点カラー
    this._savedColors = null;
    this._morphWarned = false;
  }

  get state() { return this.ctx.state; }
  get mesh() { return this.ctx.getMesh(); }
  get sculptor() { return this.ctx.getSculptor(); }
  get renderer() { return this.ctx.getRenderer(); }
  get ui() { return this.ctx.getUI(); }

  toast(msg, ms) { const u = this.ui; if (u) u.toast(msg, ms); }
  redraw() { if (this.ctx.redraw) this.ctx.redraw(); }
  autosave() { if (this.ctx.autosave) this.ctx.autosave(); }

  // --- 彫刻をレイヤーへ記録する仕掛け --------------------------------------

  /**
   * モーフブラシの実処理を sculptor へ差す。
   * ブラシ領域の頂点だけを、減衰重み × 強さで記憶形状へ戻す。
   */
  installMorphHook() {
    const s = this.sculptor;
    if (!s || s.morphHook) return;
    s.morphHook = (mesh, verts, count, center, radius, st) => {
      if (!this.morph.has) {
        // 記憶が無いと何も起きず理由も分からないので 1 回だけ知らせる
        if (!this._morphWarned) {
          this._morphWarned = true;
          this.toast('モーフブラシを使うには先に「モーフターゲット > 記憶」を押します', 4500);
        }
        return;
      }
      if (!this.morph.validate(mesh)) { this.morphInvalid(); return; }
      const w = computeMorphWeights(mesh, verts, count, center, radius, st.focalShift || 0);
      const amount = clamp(st.effStrength !== undefined ? st.effStrength : st.strength, 0, 1);
      this.morph.morphBrush(mesh, verts, count, w, amount);
    };
  }

  /**
   * sculptor の recorder フックを、いまのレイヤー状態に合わせて張り替える。
   * 記録対象のレイヤーが無いときは null にして、ブラシ経路のオーバーヘッドを消す。
   * ついでにモーフブラシのフックも差す（どちらも sculptor へ挿す穴なので一緒に見る）。
   */
  syncRecorder() {
    const s = this.sculptor;
    if (!s) return;
    this.installMorphHook();
    if (this.layers.recording < 0) { s.recorder = null; return; }
    if (!s.recorder) {
      s.recorder = {
        before: (mesh, verts, count) => this.layers.captureBefore(mesh, verts, count),
        after: (mesh, verts, count) => this.layers.commitAfter(mesh, verts, count),
      };
    }
  }

  /**
   * デフォームやギズモのようにメッシュ全体を動かす操作を、記録中のレイヤーへ入れる。
   * ZBrush でもデフォーメーションはアクティブなレイヤーに乗るので、それに合わせる。
   * 記録していなければそのまま実行する。
   */
  withLayerRecording(fn) {
    const rec = this.layers.recording;
    if (rec < 0 || !this.layers.validate(this.mesh)) return fn();
    const all = this._aliveList();
    this.layers.captureBefore(this.mesh, all, all.length);
    const r = fn();
    this.layers.commitAfter(this.mesh, all, all.length);
    return r;
  }

  /** 生存頂点の一覧（パレット操作で 1 回だけ使うので毎回作る） */
  _aliveList() {
    const m = this.mesh;
    const out = new Int32Array(m.liveVerts);
    let n = 0;
    for (let v = 0; v < m.nv; v++) if (m.vAlive[v]) out[n++] = v;
    return n === out.length ? out : out.subarray(0, n);
  }

  /** メッシュが差し替わった（新規作成 / 読み込み / ダイナメッシュ）ときに呼ぶ */
  onMeshReplaced() {
    this.layers.clear();
    this.morph.clear();
    this.gizmo.clear();
    this.syncRecorder();
    this.groups.sync(this.mesh);
    this.restoreColors();
    this.syncVisibility(true);
  }

  // --- デフォーメーション --------------------------------------------------

  /** デフォームを 1 回適用する。ZBrush と同じで破壊的（Undo で戻す） */
  applyDeform(id) {
    const meta = DEFORM_BY_ID.get(id);
    if (!meta) return;
    const st = this.state;
    const opts = Object.assign({}, st.deform.params[id], { axis: st.deform.axis });
    const r = this.withLayerRecording(() => applyDeform(this.mesh, id, opts));
    if (!r.ok) { this.toast(`${meta.jp}: 適用できませんでした`); return; }
    if (r.skipped === r.verts && r.changed === 0) {
      this.toast(`${meta.jp}: パラメータが不正です（NaN が入っていませんか）`, 3500);
      return;
    }
    if (r.changed === 0) {
      // 異常ではない。amount=0、既に球へ spherize、平面への軸方向 taper などは正しく 0。
      this.toast(`${meta.jp}: 変化なし`);
      return;
    }
    // 曲率は applyDeform 内で全再計算済みなので、溜まっている差分更新は捨てる
    this.sculptor.dropPendingCurvature();
    this.afterGeometryChange();
    let msg = `${meta.jp}: ${r.changed.toLocaleString()} / ${r.verts.toLocaleString()} 頂点 (${r.ms}ms)`;
    if (r.masked > 0) msg += ` / マスク保護 ${r.masked.toLocaleString()}`;
    this.toast(msg, 3000);
  }

  // --- マスクツール --------------------------------------------------------

  applyMaskOp(id) {
    const meta = MASK_OP_BY_ID.get(id);
    if (!meta) return;
    const st = this.state;
    const opts = Object.assign({}, st.mask.params[id] || {}, { mode: st.mask.mode });
    // 色は現在のペイント色、法線は視線方向を既定にする。
    // どちらもパレット側に別途スライダーを持たせるより、いま使っている値を
    // そのまま拾うほうが ZBrush の使い方に近い。
    if (id === 'color') opts.rgb = st.paintColor;
    if (id === 'normal') opts.dir = st.toCamera;
    const r = applyMaskOp(this.mesh, id, opts);
    this.sculptor.history.commit(this.mesh);
    this.redraw();
    this.toast(`${meta.jp}: マスク ${r.masked.toLocaleString()} / ${r.live.toLocaleString()} 頂点`);
  }

  // --- スカルプトレイヤー --------------------------------------------------

  /** レイヤーが使える状態か。使えないなら理由を toast で出す */
  layersReady(quiet = false) {
    if (this.layers.count === 0 && !this.layers.validate(this.mesh)) {
      // まだベースが無い
      return false;
    }
    if (!this.layers.validate(this.mesh)) {
      this.layers.clear();
      this.syncRecorder();
      if (!quiet) this.toast('トポロジが変わったためレイヤーを破棄しました（動的トポロジ / ダイナメッシュとは併用できません）', 4500);
      if (this.ui) this.ui.refreshLayers();
      return false;
    }
    return true;
  }

  layerAdd() {
    if (this.state.dynTopo) {
      this.state.dynTopo = false;
      if (this.ui) this.ui.syncFromState();
      this.toast('レイヤーを使うため動的トポロジをオフにしました', 3200);
    }
    if (this.layers.count === 0 || !this.layers.validate(this.mesh)) this.layers.setBase(this.mesh);
    const i = this.layers.add(`レイヤー ${this.layers.count + 1}`);
    this.syncRecorder();
    if (this.ui) this.ui.refreshLayers();
    this.toast(`レイヤーを追加しました（記録中: ${this.layers.list()[i].name}）`);
    return i;
  }

  layerRemove(index) {
    if (!this.layersReady()) return;
    const info = this.layers.list()[index];
    if (!info) return;
    if (!this.layers.remove(index)) return;
    this.syncRecorder();
    this.layers.rebuild(this.mesh);
    this.afterGeometryChange();
    if (this.ui) this.ui.refreshLayers();
    this.toast(`レイヤー「${info.name}」を削除しました`);
  }

  layerDuplicate(index) {
    if (!this.layersReady()) return;
    const i = this.layers.duplicate(index);
    if (i < 0) return;
    this.layers.rebuild(this.mesh);
    this.afterGeometryChange();
    if (this.ui) this.ui.refreshLayers();
    this.toast('レイヤーを複製しました');
  }

  layerRename(index, name) {
    this.layers.rename(index, name);
    if (this.ui) this.ui.refreshLayers();
  }

  layerSelect(index) {
    this.layers.select(index);
    this.syncRecorder();
    if (this.ui) this.ui.refreshLayers();
  }

  layerSetVisible(index, on) {
    if (!this.layersReady()) return;
    this.layers.setVisible(index, on);
    this.layers.rebuild(this.mesh);
    this.afterGeometryChange();
    if (this.ui) this.ui.refreshLayers();
  }

  /** 強度スライダー。ドラッグ中に毎回呼ばれるので履歴には積まない */
  layerSetIntensity(index, v, commit = false) {
    if (!this.layersReady()) return;
    this.layers.setIntensity(index, v);
    this.layers.rebuild(this.mesh);
    this.sculptor.dropPendingCurvature();
    this.mesh.computeAllNormals();
    this.mesh.computeAllCurvature();
    this.mesh.markAllDirty();
    if (commit) this.sculptor.history.commit(this.mesh);
    this.redraw();
    if (this.ui) this.ui.refreshLayers();
  }

  layerBake(index) {
    if (!this.layersReady()) return;
    const r = this.layers.bake(index, this.mesh);
    if (!r) return;
    if (this.ui) this.ui.refreshLayers();
    this.toast(`レイヤー「${r.name}」を焼き込みました（${r.verts.toLocaleString()} 頂点）`);
  }

  // --- ポリグループと部分表示 ----------------------------------------------

  groupAssign(method) {
    const meta = GROUP_METHODS.find((m) => m.id === method);
    const opts = {};
    if (method === 'byNormalAngle') opts.angle = this.state.groupAngle || 35;
    const r = this.groups.assign(this.mesh, method, opts);
    if (!r.ok) { this.toast('グループを作れませんでした'); return; }
    this.syncVisibility(true);
    if (this.state.groupView) this.applyGroupColors();
    this.redraw();
    if (this.ui) this.ui.refreshGroups();
    this.toast(`${meta ? meta.jp : method}: ${r.groups} グループ / ${r.tris.toLocaleString()} 面`);
  }

  /** 表示・非表示の操作をまとめて受ける。name は PolyGroups のメソッド名 */
  groupVisibility(name, ...args) {
    const fn = this.groups[name];
    if (typeof fn !== 'function') return;
    const r = fn.call(this.groups, this.mesh, ...args);
    this.syncVisibility();
    this.redraw();
    if (this.ui) this.ui.refreshGroups();
    if (r && r.hidden !== undefined) {
      this.toast(r.allVisible ? '全体を表示しました'
        : `表示 ${r.visible.toLocaleString()} 面 / 非表示 ${r.hidden.toLocaleString()} 面`);
    }
  }

  /** 可視インデックスを GPU へ送る。変わっていなければ何もしない */
  syncVisibility(force = false) {
    const r = this.renderer;
    if (!r) return;
    this.groups.sync(this.mesh);
    if (this.groups.allVisible) {
      if (force || this._visVersion !== -1) { r.setVisibleIndices(null, 0); this._visVersion = -1; }
      return;
    }
    const v = this.groups.buildVisibleIndices(this.mesh);
    if (!force && v.version === this._visVersion) return;
    r.setVisibleIndices(v.indices, v.count);
    this._visVersion = v.version;
  }

  /** グループ色を頂点カラーへ焼いてプレビューする（元の色は退避しておく） */
  applyGroupColors() {
    const m = this.mesh;
    if (!this._savedColors) this._savedColors = m.colors.slice(0, m.nv * 3);
    const r = this.groups.buildVertexGroupColors(m);
    m.colors.set(r.colors.subarray(0, m.nv * 3));
    m.markAllDirty();
    this.redraw();
  }

  /** グループ色プレビューを解除して元の頂点カラーへ戻す */
  restoreColors() {
    if (!this._savedColors) return;
    const m = this.mesh;
    const n = Math.min(this._savedColors.length, m.colors.length);
    m.colors.set(this._savedColors.subarray(0, n));
    this._savedColors = null;
    m.markAllDirty();
    this.redraw();
  }

  setGroupView(on) {
    this.state.groupView = on;
    if (on) this.applyGroupColors(); else this.restoreColors();
  }

  // --- モーフターゲット ----------------------------------------------------

  morphStore() {
    this._morphWarned = false;
    const r = this.morph.store(this.mesh);
    if (this.ui) this.ui.refreshMorph();
    this.toast(`モーフターゲットを記憶しました（${r.verts.toLocaleString()} 頂点 / ${(r.bytes / 1048576).toFixed(1)} MB）`);
  }

  morphSwitch() {
    if (!this.morph.has) { this.toast('モーフターゲットがありません'); return; }
    const r = this.morph.switchTo(this.mesh);
    if (!r.valid) { this.morphInvalid(); return; }
    this.afterGeometryChange();
    this.toast('モーフターゲットと入れ替えました');
  }

  morphRestore(amount) {
    if (!this.morph.has) { this.toast('モーフターゲットがありません'); return; }
    const r = this.withLayerRecording(() => this.morph.restore(this.mesh, amount));
    if (!r.valid) { this.morphInvalid(); return; }
    if (r.changed === 0) { this.toast('変化なし'); return; }
    this.afterGeometryChange();
    this.toast(`モーフへ ${Math.round(amount * 100)}% 戻しました（${r.changed.toLocaleString()} 頂点）`);
  }

  morphAmplify(factor) {
    if (!this.morph.has) { this.toast('モーフターゲットがありません'); return; }
    const r = this.withLayerRecording(() => this.morph.amplify(this.mesh, factor));
    if (!r.valid) { this.morphInvalid(); return; }
    if (r.changed === 0) { this.toast('変化なし'); return; }
    this.afterGeometryChange();
    this.toast(`差分を ${factor.toFixed(2)} 倍にしました（${r.changed.toLocaleString()} 頂点）`);
  }

  morphDiff() {
    if (!this.morph.has) return null;
    return this.morph.createDiff(this.mesh);
  }

  morphInvalid() {
    this.morph.clear();
    if (this.ui) this.ui.refreshMorph();
    this.toast('トポロジが変わったためモーフターゲットを破棄しました', 4000);
  }

  // --- リメッシュ（ZRemesher 相当） ----------------------------------------

  /** UI の設定から remesh() のオプションを作る */
  remeshOpts() {
    const st = this.state;
    return {
      targetTris: Math.max(100, Math.round(st.remeshTris || 20000)),
      iterations: Math.max(1, Math.round(st.remeshIterations || 5)),
      adaptive: st.remeshAdaptive || 0,
      relax: st.remeshRelax === undefined ? 0.5 : st.remeshRelax,
      project: st.remeshProject !== false,
      maxVerts: st.maxVerts,
    };
  }

  _remeshToast(before, r, where) {
    this.toast(`リメッシュ: ${before.toLocaleString()} → ${r.tris.toLocaleString()} 面`
      + ` / 目標辺長 ${r.targetLen.toFixed(4)} / ${r.ms}ms${where}`
      + `（分割 ${r.split} / 統合 ${r.collapse} / 反転 ${r.flip}）`, 5000);
  }

  /**
   * 目標ポリゴン数でリメッシュする（メインスレッド）。
   * トポロジが変わるので分割レベル・レイヤー・モーフは破棄される。
   */
  applyRemesh() {
    const m = this.mesh;
    const before = m.liveTris;
    const r = remesh(m, this.remeshOpts());
    if (!r.ok) { this.toast('リメッシュできませんでした: ' + r.reason, 4000); return; }
    this.afterTopologyChange();
    this._remeshToast(before, r, '');
  }

  /**
   * リメッシュをワーカーで走らせる。
   *
   * 520 万面だと 6 秒台かかる。メインスレッドで回すとビジー表示すら描き直されず
   * ブラウザが固まって見える（実際にそう報告された）ので、別スレッドへ出して
   * 進捗を出しながら待つ。ワーカーが使えない環境（file://、単一ファイル版、
   * Worker 無効）では黙ってメインスレッドに落ちる。
   *
   * @param {(p: object) => void} [onProgress] { stage, done, total, tris } を受ける
   * @returns {Promise<boolean>} ワーカーで実行できたか
   */
  async applyRemeshAsync(onProgress = null) {
    const m = this.mesh;
    const before = m.liveTris;
    const ok = await initRemeshWorker();
    if (!ok) { this.applyRemesh(); return false; }
    const res = await remeshInWorker(m, this.remeshOpts(), onProgress);
    if (!res) {
      // ワーカーで失敗した。理由を出してメインスレッドでやり直す。
      const why = remeshWorkerError();
      if (why) console.warn('リメッシュのワーカー実行に失敗、メインスレッドで再試行:', why);
      this.applyRemesh();
      return false;
    }
    m.setGeometry(res.positions, res.indices, res.colors, res.mask);
    this.afterTopologyChange();
    this._remeshToast(before, res.stats, ' / 別スレッド');
    return true;
  }

  /** リメッシュのワーカーが使える状態か（診断とテスト用） */
  remeshWorkerInfo() {
    return { state: remeshWorkerState(), error: remeshWorkerError(), wasm: remeshWorkerWasm() };
  }

  /** 現在の形を四角優勢にしたときの面の内訳（書き出しと表示用） */
  quadStats() {
    const q = quadDominant(this.mesh);
    return q;
  }

  /** いまの面数から、目標ポリゴン数の目安を返す（UI の初期値用） */
  suggestRemeshTris() {
    return Math.max(1000, Math.min(500000, Math.round(this.mesh.liveTris / 2)));
  }

  // --- クリップ / トリム / スライス / ミラー&ウェルド -----------------------

  /**
   * 画面のドラッグから作った平面で切る。
   * @param {string} kind 'clip' | 'trim' | 'slice'
   */
  applyPlane(kind, plane) {
    if (!plane) { this.toast('平面を作れませんでした（ドラッグが短すぎます）'); return; }
    const m = this.mesh;
    let r;
    if (kind === 'trim') r = trimPlane(m, plane, {});
    else if (kind === 'slice') r = slicePlane(m, plane, {});
    else r = clipPlane(m, plane, { falloff: this.state.clipFalloff || 0 });
    if (r.refused) { this.toast(`実行できませんでした: ${r.refused}`, 4000); return; }
    if (!r.changed) { this.toast('平面の裏側に形がありませんでした'); return; }
    this.afterTopologyChange();
    if (kind === 'trim') {
      this.toast(`トリム: ${r.removed.toLocaleString()} 頂点を削除 / ${r.added.toLocaleString()} 頂点を追加（切り口 ${r.loops} 個）`, 3500);
    } else if (kind === 'slice') {
      this.toast(`スライス: ${r.added.toLocaleString()} 頂点を追加`);
    } else {
      this.toast(`クリップ: ${r.moved.toLocaleString()} 頂点を平面上へ`);
    }
  }

  applyAxisPlane(kind, axis, offset, keep) {
    this.applyPlane(kind, planeFromAxis(axis, offset, keep));
  }

  planeFromDrag(a, b, viewDir) { return planeFromScreenLine(a, b, viewDir); }

  mirrorWeld(axis, keep) {
    const r = mirrorWeld(this.mesh, axis, { keep });
    if (r.refused) { this.toast(`ミラー&ウェルド: ${r.refused}`, 4000); return; }
    if (!r.changed) { this.toast('変化なし'); return; }
    this.afterTopologyChange();
    this.toast(`ミラー&ウェルド: ${r.removed.toLocaleString()} 頂点を削除 / 接合 ${r.welded.toLocaleString()} 頂点`, 3500);
  }

  // --- トランスポーズ ------------------------------------------------------

  /** マスクされていない領域からギズモを立てる */
  gizmoActivate() {
    const ok = this.gizmo.setFromMask(this.mesh, { local: !!this.state.transposeLocal });
    if (!ok) {
      this.toast('マスクされていない領域がありません（マスクを塗ってから使います）', 4000);
      return false;
    }
    const s = this.gizmo.stats();
    this.toast(`トランスポーズ: ${s.verts.toLocaleString()} 頂点が対象`);
    return true;
  }

  /** ギズモのドラッグ開始時に呼ぶ。レイヤー記録の「前」を押さえる */
  gizmoBeginRecord() {
    const rec = this.layers.recording;
    if (rec < 0 || !this.layers.validate(this.mesh)) { this._gizmoRecList = null; return; }
    this._gizmoRecList = this._aliveList();
    this.layers.captureBefore(this.mesh, this._gizmoRecList, this._gizmoRecList.length);
  }

  /** ギズモのドラッグ終了時に呼ぶ */
  gizmoEndRecord() {
    const list = this._gizmoRecList;
    this._gizmoRecList = null;
    if (!list) return;
    this.layers.commitAfter(this.mesh, list, list.length);
  }

  gizmoDeactivate() {
    this.gizmo.clear();
    if (this.renderer) this.renderer.setOverlayLines(null, 0);
  }

  /** ハンドルの線をレンダラへ送る。ホバー中のハンドルだけ明るくする */
  gizmoDrawHandles(scale, hover) {
    const r = this.renderer;
    if (!r) return;
    if (!this.gizmo.active) { r.setOverlayLines(null, 0); return; }
    const hs = this.gizmo.handles(scale);
    let n = 0;
    for (const h of hs) n += h.points.length / 3;
    if (n === 0) { r.setOverlayLines(null, 0); return; }
    if (!this._ovBuf || this._ovBuf.length < n * 7) this._ovBuf = new Float32Array(n * 7);
    const out = this._ovBuf;
    let w = 0;
    for (const h of hs) {
      const on = hover && hover.kind === h.kind && hover.axis === h.axis;
      const c = h.color;
      // ホバーしていないハンドルは少し暗く・薄くして、狙っている軸を目立たせる
      const k = on ? 1.0 : 0.62;
      const a = on ? 1.0 : 0.78;
      const p = h.points;
      for (let i = 0; i < p.length; i += 3) {
        out[w] = p[i]; out[w + 1] = p[i + 1]; out[w + 2] = p[i + 2];
        out[w + 3] = c[0] * k; out[w + 4] = c[1] * k; out[w + 5] = c[2] * k; out[w + 6] = a;
        w += 7;
      }
    }
    r.setOverlayLines(out, n, true);
  }

  // --- 共通の後処理 --------------------------------------------------------

  /** 形だけ変わったとき（トポロジ不変）。法線と曲率はモジュール側で済んでいる前提 */
  afterGeometryChange() {
    this.sculptor.history.commit(this.mesh);
    this.redraw();
    this.autosave();
  }

  /** トポロジが変わったとき。シード・レベル・レイヤー・モーフを無効化する */
  afterTopologyChange() {
    const s = this.sculptor;
    s.hoverSeed = -1;
    s.dropPendingCurvature();
    s.levels.clear();
    this.layers.clear();
    this.morph.clear();
    this.gizmo.clear();
    this.syncRecorder();
    this.groups.sync(this.mesh);
    this.restoreColors();
    this.syncVisibility(true);
    s.history.commit(this.mesh);
    this.redraw();
    this.autosave();
    const u = this.ui;
    if (u) {
      if (u.refreshLevels) u.refreshLevels();
      if (u.refreshLayers) u.refreshLayers();
      if (u.refreshGroups) u.refreshGroups();
      if (u.refreshMorph) u.refreshMorph();
    }
  }

  // --- ポリゴンモデリング（編集モード）------------------------------------
  //
  // 彫刻メッシュは三角形専用なので、編集は別の n-gon メッシュ（EditMesh）で行う。
  // 入るときに四角化して取り込み、出るときに三角形化して書き戻す。
  // 編集中は彫刻メッシュを「表示用の三角形化したもの」として使う。

  /** 編集モードに入る。四角化して EditMesh を作る */
  editEnter() {
    if (this.edit) return true;
    const before = this.mesh.liveTris;
    const em = editMeshFromSculpt(this.mesh, quadDominant);
    if (em.nv === 0 || em.liveFaces === 0) {
      this.toast('編集モードに入れませんでした（形が空です）', 3500);
      return false;
    }
    this.edit = em;
    this.selectUnit = 'face';
    // 表示用に三角形化して彫刻メッシュへ入れる。編集中の見た目はこれ。
    editMeshToSculpt(em, this.mesh);
    this.afterTopologyChange();
    this.editSyncOverlay();
    const st = em.faceStats();
    this.toast(`編集モード: ${before.toLocaleString()} 三角形 → `
      + `四角 ${st.quad.toLocaleString()} + 三角 ${st.tri.toLocaleString()}`
      + `（四角化率 ${(st.quadRatio * 100).toFixed(0)}%）`, 5000);
    return true;
  }

  /** 編集モードを出る。三角形化して彫刻メッシュへ書き戻す */
  editExit(apply = true) {
    if (!this.edit) return;
    const em = this.edit;
    this.edit = null;
    if (this.renderer) this.renderer.setOverlayLines(null, 0);
    if (apply) {
      const r = editMeshToSculpt(em, this.mesh);
      this.afterTopologyChange();
      this.toast(`編集モードを終了: ${r.verts.toLocaleString()} 頂点 / ${r.tris.toLocaleString()} 三角形`);
    }
    if (this.ui && this.ui.refreshEdit) this.ui.refreshEdit();
  }

  editIsOn() { return !!this.edit; }

  /**
   * 編集メッシュの情報（UI 表示用）。
   * 選択数は sel に入れる。faceStats() も selectionCount() も verts / faces という
   * 名前を持つので、平らに混ぜると片方が消える。
   */
  editInfo() {
    if (!this.edit) return null;
    const st = this.edit.faceStats();
    return {
      selectUnit: this.selectUnit,
      verts: this.edit.nv, edges: this.edit.ne,
      faces: st.faces, quad: st.quad, tri: st.tri, ngon: st.ngon,
      quadRatio: st.quadRatio,
      nonManifold: this.edit.nonManifold,
      sel: this.edit.selectionCount(),
    };
  }

  /** 選択の単位を変える。unit は 'vert' | 'edge' | 'face' */
  editSetSelectUnit(unit) {
    if (!this.edit) return;
    this.selectUnit = unit;
    // 選択を新しい単位の主体へ持ち替える（Blender と同じ引き継ぎ）
    this.edit.syncSelection(unit);
    this.editSyncOverlay();
    if (this.ui && this.ui.refreshEdit) this.ui.refreshEdit();
  }

  /**
   * 編集メッシュの辺と選択をオーバーレイ線として作る。
   *
   * 大きいメッシュだと全部の辺を線にすると頂点数が爆発する（1 辺 = 2 頂点 ×
   * 7 float）。編集する形は普通そこまで大きくないが、彫刻してから入ることも
   * あるので上限を設けて「選択と境界だけ」に落とす。
   */
  editSyncOverlay() {
    const em = this.edit;
    if (!em || !this.renderer) return;
    const MAX_EDGES = 300000;
    const full = em.ne <= MAX_EDGES;
    // 何本描くか数える
    let n = 0;
    for (let e = 0; e < em.ne; e++) {
      if (full || em.selEdge[e] || em.edgeFace[e * 2 + 1] < 0) n++;
    }
    const buf = new Float32Array(n * 2 * 7);
    const P = em.positions;
    let w = 0;
    const put = (v, r, g, b, a) => {
      const i = v * 3;
      buf[w++] = P[i]; buf[w++] = P[i + 1]; buf[w++] = P[i + 2];
      buf[w++] = r; buf[w++] = g; buf[w++] = b; buf[w++] = a;
    };
    for (let e = 0; e < em.ne; e++) {
      const sel = em.selEdge[e];
      const bnd = em.edgeFace[e * 2 + 1] < 0;
      if (!full && !sel && !bnd) continue;
      // 選択 = 橙、境界 = 赤寄り、その他 = 薄い灰
      let r = 0.55, g = 0.60, b = 0.68, a = 0.30;
      if (bnd) { r = 0.95; g = 0.35; b = 0.25; a = 0.85; }
      if (sel) { r = 1.0; g = 0.60; b = 0.20; a = 0.95; }
      put(em.edgeA[e], r, g, b, a);
      put(em.edgeB[e], r, g, b, a);
    }
    // 選択した頂点は小さな十字で示す（頂点モードで見えるように）
    let extra = null;
    if (this.selectUnit === 'vert') {
      const sel = [];
      for (let v = 0; v < em.nv; v++) if (em.selVert[v]) sel.push(v);
      const cap = Math.min(sel.length, 20000);
      const s = em.bounds().radius * 0.012;
      extra = new Float32Array(cap * 6 * 7);
      let x = 0;
      const putp = (px, py, pz) => {
        extra[x++] = px; extra[x++] = py; extra[x++] = pz;
        extra[x++] = 1.0; extra[x++] = 0.75; extra[x++] = 0.25; extra[x++] = 1.0;
      };
      for (let k = 0; k < cap; k++) {
        const i = sel[k] * 3;
        const px = P[i], py = P[i + 1], pz = P[i + 2];
        putp(px - s, py, pz); putp(px + s, py, pz);
        putp(px, py - s, pz); putp(px, py + s, pz);
        putp(px, py, pz - s); putp(px, py, pz + s);
      }
    }
    if (extra && extra.length) {
      const all = new Float32Array(w + extra.length);
      all.set(buf.subarray(0, w));
      all.set(extra, w);
      this.renderer.setOverlayLines(all, (w + extra.length) / 7, true);
    } else {
      this.renderer.setOverlayLines(buf, w / 7, false);
    }
  }

  /** 表示用の三角形メッシュを作り直す（形を変えたあとに呼ぶ） */
  editRefreshDisplay() {
    if (!this.edit) return;
    editMeshToSculpt(this.edit, this.mesh);
    this.mesh.markAllDirty();
    this.edit.version++;
    this.editSyncOverlay();
    this.redraw();
  }

  /** 選択操作。op は 'all' | 'none' | 'invert' | 'grow' | 'shrink' | 'linked' */
  editSelect(op) {
    if (!this.edit) return;
    const em = this.edit, mode = this.selectUnit;
    if (op === 'all') em.selectAll(mode);
    else if (op === 'none') em.clearSelection();
    else if (op === 'invert') em.invertSelection(mode);
    else if (op === 'grow') em.growSelection(mode);
    else if (op === 'shrink') em.shrinkSelection(mode);
    else if (op === 'linked') em.selectLinked();
    this.editSyncOverlay();
    this.redraw();
    if (this.ui && this.ui.refreshEdit) this.ui.refreshEdit();
  }

  /**
   * クリックで拾う。renderer のピッキングが返したワールド座標を渡す。
   * @param {Array} p ワールド座標
   * @param {boolean} add true なら選択に足す
   */
  editPick(p, add = false) {
    if (!this.edit) return null;
    const em = this.edit, mode = this.selectUnit;
    // 拾う範囲はモデルの大きさに対する相対値。画面の px では測れない
    // （ピッキングは表面のワールド座標を返すので、そこからの距離で決める）
    const tol = em.bounds().radius * 0.12;
    if (!add) em.clearSelection();
    let hit = -1;
    if (mode === 'vert') {
      hit = pickVert(em, p, tol);
      if (hit >= 0) em.selVert[hit] = 1;
    } else if (mode === 'edge') {
      hit = pickEdge(em, p, tol);
      if (hit >= 0) em.selEdge[hit] = 1;
    } else {
      hit = pickFace(em, p, tol);
      if (hit >= 0) em.selFace[hit] = 1;
    }
    em.syncSelection(mode);
    this.editSyncOverlay();
    this.redraw();
    if (this.ui && this.ui.refreshEdit) this.ui.refreshEdit();
    return hit;
  }

  /** 矩形選択。project はワールド → 画面 */
  editBoxSelect(project, rect, add = false) {
    if (!this.edit) return null;
    const r = boxSelect(this.edit, project, rect, this.selectUnit, add);
    this.editSyncOverlay();
    this.redraw();
    if (this.ui && this.ui.refreshEdit) this.ui.refreshEdit();
    return r;
  }

  /**
   * モデリング操作（段 2 / 段 3）。
   * op は 'loopSelect' | 'ringSelect' | 'loopCut' | 'extrude' | 'inset' | 'insetFaces'
   * | 'subdivide' | 'bevel' | 'bridge'
   */
  editModel(op) {
    if (!this.edit) return;
    const em = this.edit;
    const st = this.state;
    if (op === 'loopSelect' || op === 'ringSelect') {
      const r = selectLoopOrRing(em, op === 'ringSelect' ? 'ring' : 'loop');
      if (r.seeds === 0) { this.toast('辺が選択されていません'); return; }
      if (r.added === 0) {
        this.toast(op === 'ringSelect'
          ? 'リングが伸びませんでした（四角でない面に囲まれています）'
          : 'ループが伸びませんでした（辺が 4 本集まる頂点がありません）', 4500);
        return;
      }
      this.toast(`${op === 'ringSelect' ? 'エッジリング' : 'エッジループ'}: ${r.added} 辺を追加`);
      this.editSyncOverlay();
      this.redraw();
      if (this.ui && this.ui.refreshEdit) this.ui.refreshEdit();
      return;
    }
    if (op === 'loopCut') {
      const r = loopCut(em, st.editCuts || 1);
      if (r.faces === 0) {
        this.toast(r.refused > 0
          ? 'ループカットできませんでした（四角のリングが張れません）'
          : '辺が選択されていません', 4500);
        return;
      }
      this.toast(`ループカット: ${r.rings} リング / ${r.faces} 面を分割`
        + `${r.refused ? `（${r.refused} リングは面を取り合うため断りました）` : ''}`, 4500);
    } else if (op === 'extrude') {
      const bb = em.bounds();
      const r = extrudeSelectedFaces(em, bb.radius * (st.editExtrude || 0));
      if (r.faces === 0) { this.toast('面が選択されていません'); return; }
      this.toast(`押し出し: ${r.faces} 面 / 側面 ${r.walls} 枚`);
    } else if (op === 'inset') {
      const r = insetRegion(em, st.editInset || 0.2);
      if (r.faces === 0) { this.toast(r.reason || '面が選択されていません', 5000); return; }
      this.toast(`インセット（領域）: ${r.faces} 面 / 帯 ${r.band} 枚`);
    } else if (op === 'insetFaces') {
      const r = insetSelectedFaces(em, st.editInset || 0.2);
      if (r.faces === 0) { this.toast('面が選択されていません'); return; }
      this.toast(`インセット（面ごと）: ${r.faces} 面`);
    } else if (op === 'bridge') {
      const r = bridgeEdgeLoops(em);
      if (r.faces === 0) { this.toast(r.reason || '辺が選択されていません', 6000); return; }
      this.toast(`ブリッジ: 帯 ${r.faces} 枚で 2 つの穴を繋ぎました（${r.verts} 頂点ずつ）`, 4000);
    } else if (op === 'subdivide') {
      const r = subdivideSelectedFaces(em);
      if (r.faces === 0) { this.toast('面が選択されていません'); return; }
      this.toast(`細分化: ${r.faces} 面 → ${r.faces * 4} 面（頂点 +${r.verts}）`);
    } else if (op === 'bevel') {
      const r = bevelSelectedEdges(em, st.editBevel || 0.2);
      // 断るときは理由がそのまま出る。黙って壊さない方針
      if (r.edges === 0) { this.toast(r.reason || '辺が選択されていません', 6000); return; }
      this.toast(`ベベル: ${r.edges} 辺 → 帯 ${r.faces} 枚 / 角 ${r.corners} 枚（頂点 +${r.verts}）`
        + `${r.refused ? `（${r.refused} 本は境界のため断りました）` : ''}`
        + ' — 帯を選択にしてあるので続けて押し出せます', 5000);
    }
    this.editRefreshDisplay();
    if (this.ui && this.ui.refreshEdit) this.ui.refreshEdit();
  }

  /** 編集操作。op は 'delete' | 'dissolve' | 'flip' */
  editApply(op) {
    if (!this.edit) return;
    const em = this.edit;
    if (op === 'delete') {
      const r = em.deleteSelectedFaces();
      if (r.faces === 0) { this.toast('面が選択されていません'); return; }
      this.toast(`${r.faces} 面を削除（頂点 ${r.verts} 個も一緒に消えました）`);
    } else if (op === 'dissolve') {
      const r = em.dissolveSelectedEdges();
      if (r.edges === 0) {
        this.toast(r.refused > 0
          ? '溶解できませんでした（境界の辺、または向きが揃っていない面）'
          : '辺が選択されていません', 4000);
        return;
      }
      this.toast(`${r.edges} 本の辺を溶解${r.refused ? `（${r.refused} 本は断りました）` : ''}`);
    } else if (op === 'flip') {
      const n = em.flipSelectedFaces();
      if (n === 0) { this.toast('面が選択されていません'); return; }
      this.toast(`${n} 面の向きを反転`);
    }
    this.editRefreshDisplay();
    if (this.ui && this.ui.refreshEdit) this.ui.refreshEdit();
  }

  /**
   * 選択した頂点を動かす（ギズモから呼ばれる）。
   * @param {Float32Array} m 4x4 行列（列優先）
   */
  editTransform(m) {
    if (!this.edit) return 0;
    const em = this.edit, P = em.positions;
    let n = 0;
    for (let v = 0; v < em.nv; v++) {
      if (!em.selVert[v]) continue;
      const i = v * 3;
      const x = P[i], y = P[i + 1], z = P[i + 2];
      P[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      P[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      P[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      n++;
    }
    if (n) this.editRefreshDisplay();
    return n;
  }

  /** 選択の重心（ギズモの置き場所） */
  editSelectionCenter(out) {
    if (!this.edit) return false;
    const em = this.edit, P = em.positions;
    let x = 0, y = 0, z = 0, n = 0;
    for (let v = 0; v < em.nv; v++) {
      if (!em.selVert[v]) continue;
      const i = v * 3;
      x += P[i]; y += P[i + 1]; z += P[i + 2]; n++;
    }
    if (n === 0) return false;
    out[0] = x / n; out[1] = y / n; out[2] = z / n;
    return true;
  }

  bytes() {
    return this.layers.bytes() + this.groups.bytes() + this.morph.bytes();
  }
}
