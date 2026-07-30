// ---------------------------------------------------------------------------
// main.js - アプリ本体（状態 / 入力 / メインループ）
// ---------------------------------------------------------------------------

import { M4, V3, clamp } from './math.js';
import { OrbitCamera } from './camera.js';
import { SculptMesh, PRIMITIVES } from './mesh.js';
import { Sculptor, buildMirrors, mirrorPoint, mirrorVector } from './sculptor.js';
import { Renderer } from './renderer.js';
import { BRUSH_IDS, BRUSHES, usesGrabPlane } from './brushes.js';
import { buildUI } from './ui.js';
import { exportOBJ, exportSTL, exportPLY, importMesh as importMeshFile, importSTL, download } from './io.js';
import * as store from './store.js';
import { initWasmField, wasmFieldState, wasmFieldError, wasmFieldModule } from './wasmkernels.js';
import { dynamesh } from './dynamesh.js';
import { initParallelField, parallelState, parallelWorkers } from './parallelfield.js';
import { Tools, defaultToolState } from './tools.js';
import { SubToolSet } from './subtool.js';

const BG_PRESETS = {
  dark: { top: [0.032, 0.036, 0.046, 1], bot: [0.0065, 0.0075, 0.011, 1], ring: [1, 1, 1, 0.92] },
  grey: { top: [0.215, 0.225, 0.245, 1], bot: [0.065, 0.070, 0.080, 1], ring: [1, 1, 1, 0.95] },
  light: { top: [0.76, 0.775, 0.80, 1], bot: [0.30, 0.315, 0.345, 1], ring: [0.04, 0.04, 0.05, 0.95] },
};

const state = {
  // ブラシ
  brush: 'clay',
  radiusPx: 90,
  strength: 0.5,
  focalShift: 0,             // -1..1（ZBrush の Focal Shift 相当）
  dabSpacing: 0.06,         // ダブ間隔（ブラシ半径に対する割合。小さいほど滑らか）
  alpha: '',                // ブラシアルファ（空文字で無効。ZBrush の Alpha パレット相当）
  alphaAlign: true,         // アルファをストローク方向に合わせる
  stroke: 'dots',           // ストロークタイプ（ZBrush の Stroke パレット相当）
  strokeParams: null,       // ストロークごとのパラメータ（defaultToolState が埋める）
  lazyRadius: 10,            // レイジーマウスの追従半径（画面px、0 で無効）
  usePressure: true,
  pressureSize: 0.45,        // 筆圧が半径に効く割合
  pressureStrength: 0.75,    // 筆圧が強さに効く割合
  backfaceMask: true,
  paintColor: [0.62, 0.075, 0.055],
  worldRadius: 0.2,
  toCamera: V3.create(0, 0, 1),   // バックフェイスマスク用
  // トポロジ
  dynTopo: true,
  decimate: true,
  detail: 0.60,
  maxVerts: 1200000,
  strokeBudgetMs: 12,   // 1 フレームの彫刻に使う上限時間（0 で無制限）
  // ダイナメッシュ
  dynaResolution: 96,
  dynaSmooth: 1,
  dynaTransferColor: true,
  // シンメトリ
  symmetry: { x: true, y: false, z: false },
  radial: { on: false, count: 6, axis: 1 },   // ラジアルシンメトリ（軸まわりの回転コピー）
  localSymmetry: false,                        // 原点ではなくモデル中心を基準にする
  // 追加ツール（デフォーム / マスクツールのパラメータは defaultToolState が埋める）
  deform: null,
  mask: null,
  groupAngle: 35,          // 法線角でグループ分けするときのしきい値（度）
  groupView: false,        // グループ色で表示するか
  clipMode: 'off',         // 'off' | 'clip' | 'trim' | 'slice'（ドラッグで平面カット）
  clipFalloff: 0,          // クリップの減衰（0 で完全な平面）
  transposeMode: false,    // トランスポーズ中か（W キーで切り替え）
  transposeLocal: false,   // ギズモの軸を選択領域の主成分に合わせる
  // リメッシュ（ZRemesher 相当）
  remeshTris: 20000,       // 目標三角形数
  remeshIterations: 5,
  remeshAdaptive: 0.5,     // 曲率適応の強さ 0..1
  remeshRelax: 0.5,        // 接線緩和の量
  remeshProject: true,     // 元の表面へ投影して形を保つ
  exportQuads: false,      // OBJ を四角優勢で書き出す
  // 表示
  material: 0,
  wireframe: false,
  ao: true,
  aoIntensity: 1.0,
  aoRadius: 1.0,
  aoPower: 1.6,
  cavity: 0.55,          // キャビティ（溝を暗くする）強度
  peak: 0.18,            // 稜線をわずかに明るくする強度
  cavityGain: 3.2,       // 曲率の増幅
  grid: true,            // フロアグリッド
  gridColor: [0.55, 0.60, 0.68, 0.32],
  gridY: -1,             // 床の高さ（モデルの底に合わせて更新）
  debugView: 0,          // 0 = 通常, 1 = AO のみ
  exposure: 1.0,
  wireAlpha: 0.32,
  maskDarken: 0.9,
  renderScale: 1,
  // 仕上げレンダリング（BPR 相当）。実時間表示には影響しない
  bprScale: 2,             // スーパーサンプリング倍率 1/2/4
  bprShadow: 0.75,         // 影の強さ
  bprShadowSoft: 1.5,      // 影のにじみ（シャドウマップの texel 単位）
  bprAoSamples: 64,        // AO のサンプル数（実時間表示は 24）
  bprOutline: 0,           // 輪郭線の太さ（出力 px。0 で無し）
  bprOutlineStrength: 0.7,
  bprDiffuse: 0.75,        // 拡散光の強さ
  bprAmbient: 0.45,        // 環境光（影の中の明るさ）
  bprLightAz: -40,         // 光の方位角（度）
  bprLightEl: 45,          // 光の高度角（度）
  bprTransparent: false,   // 背景を透明にして書き出す
  bprGrid: false,          // 床グリッドを入れる
  // ポリゴンモデリング（編集モード）
  editMode: false,        // 編集モードに入っているか
  editSelect: 'face',     // 'vert' | 'edge' | 'face'
  editCuts: 1,            // ループカットの本数
  editExtrude: 0.25,      // 押し出し量（モデル半径に対する割合）
  editInset: 0.2,         // インセット量 0..1
  editBevel: 0.2,         // ベベル量 0..0.49（区間の重心へ寄せる割合）
  invertOrbitY: false,
  bgPreset: 'dark',
  bgTop: BG_PRESETS.dark.top,
  bgBot: BG_PRESETS.dark.bot,
  ringColor: BG_PRESETS.dark.ring,
};

// デフォーム / マスクツールの既定パラメータを流し込む。
// モジュールが持つメタデータから作るので、機能を足しても main.js を触らなくてよい。
Object.assign(state, defaultToolState());

const canvas = document.getElementById('gpu');
const camera = new OrbitCamera();
let mesh = new SculptMesh();
const subtools = new SubToolSet();
let renderer = null;
let sculptor = null;
let ui = null;
let tools = null;

// --- 入力状態 --------------------------------------------------------------
const ptr = {
  x: 0, y: 0, px: 0, py: 0, dx: 0, dy: 0,
  down: false, mode: 'none', inside: false, id: -1,
  pressure: 1, isPen: false,
  // レイジーマウス（ZBrush の LazyMouse 相当）: カーソルが lazyRadius より
  // 離れたときだけ、その距離を保ちながら引っぱられる「リード」方式。
  // フレームレートに依存せず、手ぶれだけがきれいに落ちる。
  lazyX: 0, lazyY: 0, lazyInit: false,
};
let spaceDown = false;
let busy = false;
let activeBrush = 'clay';
let activeDir = 1;
let grabPlanePoint = null;   // move / snakehook 用の投影平面

// --- 作業用 ----------------------------------------------------------------
const tmpPoint = V3.create();
const tmpNormal = V3.create();
const rayO = V3.create();
const rayD = V3.create();
const ringMats = [];
for (let i = 0; i < 8; i++) {
  ringMats.push({ matrix: M4.create(), pos: V3.create(), nrm: V3.create() });
}
const ringOut = [];

// ---------------------------------------------------------------------------
// アプリ API（UI から呼ばれる）
// ---------------------------------------------------------------------------
const app = {
  state,
  get subtools() { return subtools; },
  /** キー操作の一覧（使い方ページが読む。定義は下の SHORTCUTS が唯一） */
  shortcuts: () => SHORTCUTS,
  newMesh(kind) {
    const gen = PRIMITIVES[kind] || PRIMITIVES.sphere;
    const g = gen();
    // 新規作成はサブツールも 1 個に戻す（「作り直し」の意味をはっきりさせる）。
    // ただしメッシュのオブジェクトは作り直さず、いまアクティブなものを使い回す。
    // 差し替えると外から掴んでいる参照（テストや拡張）が古いメッシュを指すため。
    mesh.setGeometry(g.positions, g.indices);
    if (renderer) {
      for (const t of subtools.list) renderer.destroyStatic(t.id);
      renderer.drawSlots = null;
      renderer.gpuCapV = 0; renderer.gpuCapT = 0;
    }
    subtools.adopt(mesh, 'サブツール 1');
    if (sculptor) { sculptor.setMesh(mesh); }
    if (tools) { tools.onMeshReplaced(); applyTransposeMode(false); }
    frameCamera();
    if (ui) { ui.refreshSubtools(); ui.toast('新しいメッシュを作成しました'); }
  },
  undo() {
    if (sculptor.history.undo(mesh)) { sculptor.hoverSeed = -1; ui.toast('元に戻しました'); }
    else ui.toast('これ以上戻せません');
  },
  redo() {
    if (sculptor.history.redo(mesh)) { sculptor.hoverSeed = -1; ui.toast('やり直しました'); }
    else ui.toast('やり直せる操作がありません');
  },
  smoothAll() {
    sculptor.smoothAll(1, 0.6);
    ui.toast('全体をスムーズしました');
  },
  remesh() {
    const avg = mesh.averageEdgeLength();
    sculptor.remeshUniform(avg);
    sculptor.hoverSeed = -1;
    ui.toast(`均一化: ${mesh.liveVerts.toLocaleString()} 頂点`);
  },
  /**
   * ダイナメッシュ。数百 ms〜数秒かかる同期処理なので、
   * オーバーレイを出して 2 フレーム待ってから実行し、UI が固まったように見えないようにする。
   */
  async dynamesh() {
    if (busy) return;
    busy = true;
    ui.showBusy('ダイナメッシュ処理中…');
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    try {
      const before = mesh.liveVerts;
      const s = await sculptor.dynamesh({
        resolution: state.dynaResolution,
        smooth: state.dynaSmooth,
        transferColor: state.dynaTransferColor,
      });
      if (s.failed) {
        ui.toast('ダイナメッシュに失敗しました（形状が空か解像度が低すぎます）', 4000);
      } else {
        if (tools) tools.onMeshReplaced();
        frameCameraKeepView();
        const shell = s.openMesh ? '（境界があるためシェル化）' : '';
        ui.toast(
          `ダイナメッシュ ${s.grid.join('×')} → ${before.toLocaleString()} → `
          + `${s.verts.toLocaleString()} 頂点 / ${s.ms} ms ${shell}`, 4200);
      }
    } catch (e) {
      ui.toast('ダイナメッシュでエラー: ' + e.message, 5000);
      console.error(e);
    } finally {
      ui.hideBusy();
      busy = false;
    }
  },
  clearMask() { sculptor.clearMask(); ui.toast('マスクをクリアしました'); },
  invertMask() { sculptor.invertMask(); ui.toast('マスクを反転しました'); },
  fillColor() { sculptor.fillColor(state.paintColor); ui.toast('全体を塗りました'); },
  setRenderScale(v) { renderer.setRenderScale(v); },
  setView(name) { camera.setView(name); ui.toast('視点: ' + name); },

  // --- 分割レベル（SDiv） ----------------------------------------------
  divide() {
    if (busy) return;
    const before = mesh.liveVerts;
    if (state.maxVerts && before * 4 > state.maxVerts) {
      ui.toast('最大頂点数を超えるため分割できません（設定を上げてください）', 3500);
      return;
    }
    if (state.dynTopo) {
      state.dynTopo = false;
      ui.syncFromState();
      ui.toast('分割レベルを使うため動的トポロジをオフにしました', 3200);
    }
    const s = sculptor.divide();
    if (tools) tools.onMeshReplaced();
    frameCameraKeepView();
    ui.refreshLevels();
    scheduleAutosave();
    ui.toast(`分割: レベル ${s.level}/${s.maxLevel}  ${before.toLocaleString()} → ${s.verts.toLocaleString()} 頂点`, 3000);
  },
  levelUp() {
    const s = sculptor.levelUp();
    ui.refreshLevels();
    if (!s) { ui.toast('これ以上上のレベルはありません'); return; }
    frameCameraKeepView();
    ui.toast(`レベル ${s.level}/${s.maxLevel}  ${s.verts.toLocaleString()} 頂点`);
  },
  levelDown() {
    const s = sculptor.levelDown();
    ui.refreshLevels();
    if (!s) { ui.toast('これ以上下のレベルはありません'); return; }
    frameCameraKeepView();
    ui.toast(`レベル ${s.level}/${s.maxLevel}  ${s.verts.toLocaleString()} 頂点`);
  },

  // --- ブラウザ内保存 ----------------------------------------------------
  async saveProject(name) {
    if (!name) return;
    try {
      const r = await store.saveProject(name, subtools, state);
      store.saveSettings(state);
      ui.toast(`保存しました: ${name}（${r.verts.toLocaleString()} 頂点 / ${(r.bytes / 1048576).toFixed(1)} MB）`, 3200);
      await ui.refreshProjects();
    } catch (e) {
      ui.toast('保存に失敗: ' + e.message, 4000);
    }
  },
  async loadProject(name) {
    try {
      const rec = await store.loadProject(name);
      if (!rec) { ui.toast('見つかりません: ' + name, 3000); return; }
      restoreRecord(rec);
      if (tools) tools.onMeshReplaced();
      if (rec.settings) {
        store.loadSettings(Object.assign(state, {}));   // 既定を壊さないよう state に直接
        for (const k of Object.keys(rec.settings)) {
          if (k === 'symmetry') Object.assign(state.symmetry, rec.settings.symmetry);
          else if (k === 'paintColor') state.paintColor = rec.settings.paintColor.slice();
          else state[k] = rec.settings[k];
        }
        renderer.setRenderScale(state.renderScale);
        app.setBackground(state.bgPreset);
        ui.syncFromState();
      }
      frameCamera();
      ui.refreshLevels();
      ui.toast(`読み込みました: ${name === store.AUTOSAVE ? '自動保存' : name}`
        + `（${mesh.liveVerts.toLocaleString()} 頂点）`, 3200);
    } catch (e) {
      ui.toast('読み込みに失敗: ' + e.message, 4000);
    }
  },
  async deleteProject(name) {
    try {
      await store.deleteProject(name);
      await ui.refreshProjects();
      ui.toast('削除しました: ' + name);
    } catch (e) {
      ui.toast('削除に失敗: ' + e.message, 4000);
    }
  },
  sculptorRef: () => sculptor,
  listProjects: () => store.listProjects(),
  estimateUsage: () => store.estimateUsage(),
  saveSettingsNow() { store.saveSettings(state); },
  /**
   * リメッシュ。数百 ms〜数秒かかるのでオーバーレイを出してから実行する。
   * 本体はワーカーで走るので、待っている間も画面は動き進捗が出る。
   */
  async remeshAdaptive() {
    if (busy) return;
    busy = true;
    ui.showBusy('リメッシュ中…');
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    try {
      await tools.applyRemeshAsync((p) => {
        const pct = Math.min(99, Math.round(p.done / Math.max(1, p.total) * 100));
        ui.showBusy(`リメッシュ中… ${pct}%（${p.stage} / ${p.tris.toLocaleString()} 面）`);
      });
      frameCameraKeepView();
    } catch (e) {
      ui.toast('リメッシュでエラー: ' + e.message, 5000);
      console.error(e);
    } finally {
      ui.hideBusy();
      busy = false;
    }
  },
  /**
   * 仕上げレンダリング（BPR 相当）。影・高品質 AO・輪郭線つきで
   * 解像度を上げて描き、PNG にして落とす。
   */
  async renderStill(opts = {}) {
    if (busy || !renderer) return null;
    // プレビューはスライダーを動かすたびに走るので、
    // ビジー表示もトーストも出さない（点滅して読めなくなる）。
    const quiet = !!opts.preview;
    busy = true;
    if (!quiet) {
      ui.showBusy('レンダリング中…');
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }
    try {
      const az = (state.bprLightAz || 0) * Math.PI / 180;
      const el = (state.bprLightEl || 0) * Math.PI / 180;
      const r = await renderer.renderStill(camera, mesh, state, Object.assign({
        scale: state.bprScale,
        shadow: state.bprShadow,
        shadowSoft: state.bprShadowSoft,
        aoSamples: state.bprAoSamples,
        outline: state.bprOutline,
        outlineStrength: state.bprOutlineStrength,
        diffuse: state.bprDiffuse,
        ambient: state.bprAmbient,
        transparent: state.bprTransparent,
        grid: state.bprGrid,
        // 方位角 / 高度角から向きを作る（スライダー 2 本で回せるように）
        lightDir: [
          Math.cos(el) * Math.sin(az),
          Math.sin(el),
          Math.cos(el) * Math.cos(az),
        ],
      }, opts));
      if (opts.download !== false) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        download(r.blob, `websculpt-render-${stamp}.png`, 'image/png');
      }
      if (!quiet) {
        const ss = r.scale > 1 ? ` / ${r.scale}x（${r.renderedAt[0]}×${r.renderedAt[1]} で描画）` : '';
        ui.toast(`レンダリング: ${r.width}×${r.height}${ss} / ${r.ms}ms`, 4000);
      }
      return r;
    } catch (e) {
      ui.toast('レンダリングでエラー: ' + e.message, 5000);
      console.error(e);
      return null;
    } finally {
      if (!quiet) ui.hideBusy();
      busy = false;
    }
  },
  // --- ポリゴンモデリング（編集モード）------------------------------------
  setEditMode(on) {
    if (busy) return;
    if (on === state.editMode) return;
    if (on) {
      // 編集モードとトランスポーズ / 平面カットは同時に使えない（どれも
      // 左ドラッグを取り合う）
      applyTransposeMode(false);
      state.clipMode = 'off';
      if (!tools.editEnter()) return;
      state.editMode = true;
      tools.editSetMode(state.editSelect);
    } else {
      tools.editExit(true);
      state.editMode = false;
    }
    ui.syncFromState();
    if (ui.refreshEdit) ui.refreshEdit();
  },
  toggleEditMode() { app.setEditMode(!state.editMode); },
  /**
   * 選択した頂点にギズモを立てる。
   *
   * トランスポーズのギズモをそのまま使う。**編集メッシュと表示用の彫刻メッシュは
   * 頂点番号が 1:1** なので（triangulate は positions をそのまま渡し、setGeometry は
   * 並べ替えない）、選択をマスクへ写せば既存のギズモがそのまま効く。
   * ギズモは「マスクされていない頂点」を動かす規約なので、選択を 0、非選択を 1 にする。
   */
  editGizmo() {
    if (!state.editMode || !tools.edit) { ui.toast('先に編集モードに入ります'); return; }
    const em = tools.edit;
    const sel = em.selectionCount();
    if (sel.verts === 0) { ui.toast('頂点が選択されていません'); return; }
    if (mesh.nv !== em.nv) {
      // 1:1 の前提が崩れている（表示の作り直しを忘れている）。黙って変な所を
      // 動かすより、作り直してから立てる。
      tools.editRefreshDisplay();
    }
    for (let v = 0; v < mesh.nv; v++) mesh.mask[v] = em.selVert[v] ? 0 : 1;
    mesh.markAllDirty();
    if (!tools.gizmoActivate()) return;
    applyTransposeMode(true);
    ui.toast(`${sel.verts.toLocaleString()} 頂点にギズモを立てました（ハンドルを掴んで動かします）`, 4000);
  },
  editSetSelectMode(mode) {
    state.editSelect = mode;
    if (state.editMode) tools.editSetMode(mode);
    ui.syncFromState();
  },
  setTranspose(on) { applyTransposeMode(on); },
  toggleTranspose() { applyTransposeMode(!state.transposeMode); },
  resetSettings() {
    store.clearSettings();
    ui.toast('設定を初期化しました。再読み込みで反映されます', 3500);
  },
  setBackground(preset) {
    const p = BG_PRESETS[preset] || BG_PRESETS.dark;
    state.bgPreset = preset;
    state.bgTop = p.top; state.bgBot = p.bot; state.ringColor = p.ring;
  },
  exportFile(kind) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (kind === 'obj') {
      // 四角優勢で出すと ZRemesher の出力に近い見た目で他のツールで開ける。
      // 対にできなかった三角形は三角形のまま出る。
      const quads = state.exportQuads && tools ? tools.quadStats() : null;
      download(exportOBJ(mesh, { quads }), `websculpt-${stamp}.obj`, 'text/plain');
      if (quads) {
        ui.toast(`OBJ を書き出しました（四角 ${quads.quads.toLocaleString()} + 三角 ${quads.tris.toLocaleString()}`
          + ` / 四角化率 ${(quads.ratio * 100).toFixed(0)}%）`, 3500);
        return;
      }
    } else if (kind === 'stl') {
      download(exportSTL(mesh), `websculpt-${stamp}.stl`, 'model/stl');
    } else if (kind === 'ply') {
      download(exportPLY(mesh), `websculpt-${stamp}.ply`, 'application/octet-stream');
    }
    ui.toast(`${kind.toUpperCase()} を書き出しました`);
  },
  /** OBJ / STL を読み込む（拡張子と中身の両方で形式を見分ける） */
  importMesh() {
    if (busy) return;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.obj,.stl,text/plain,model/stl';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      busy = true;
      ui.showBusy('読み込み中…');
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      try {
        // STL はバイナリなので ArrayBuffer で読む。OBJ もそこから文字列にする。
        const r = importMeshFile(f.name, await f.arrayBuffer());
        const g = r.geom;
        // いまアクティブなサブツールの形を差し替える（従来の OBJ 読み込みと同じ挙動）
        mesh.setGeometry(g.positions, g.indices);
        sculptor.setMesh(mesh);
        if (tools) tools.onMeshReplaced();
        frameCamera();
        // STL は三角形の寄せ集めなので、溶接でどれだけ頂点が繋がったかを出す。
        // ここが「元の面数 × 3 と同じ」なら溶接できておらず、彫刻すると剥がれる。
        const welded = g.sourceTris
          ? ` / ${(g.sourceTris * 3).toLocaleString()} 個の頂点を ${mesh.liveVerts.toLocaleString()} 個に溶接`
          : '';
        ui.toast(`${r.kind} を読み込み: ${mesh.liveVerts.toLocaleString()} 頂点`
          + ` / ${mesh.liveTris.toLocaleString()} 面${welded}`, 4500);
      } catch (e) {
        ui.toast('読み込み失敗: ' + e.message, 4000);
        console.error(e);
      } finally {
        ui.hideBusy();
        busy = false;
      }
    };
    inp.click();
  },
  frameCamera,
};

function frameCamera() {
  const bb = mesh.bounds();
  camera.frame(bb.center, bb.radius);
  updateFloor(bb);
  camera.update(canvas.clientWidth || 1, canvas.clientHeight || 1);
}

/** 床グリッドをモデルの底に合わせる（毎フレーム動くとちらつくので明示操作時だけ） */
function updateFloor(bb) {
  const h = Math.max(bb.max[1] - bb.min[1], 1e-4);
  state.gridY = bb.min[1] - h * 0.02;
}

// --- オートセーブ ----------------------------------------------------------
let autosaveTimer = 0;
let autosaveDirty = false;

function scheduleAutosave() {
  autosaveDirty = true;
  clearTimeout(autosaveTimer);
  // 連続したストロークの直後に何度も書かないよう、落ち着いてから 1 回だけ保存する
  autosaveTimer = setTimeout(async () => {
    if (!autosaveDirty || busy) return;
    autosaveDirty = false;
    try {
      await store.saveAutosave(subtools, state);
      store.saveSettings(state);
      if (ui) ui.setAutosaveMark(new Date());
    } catch { /* 容量超過などは黙って諦める */ }
  }, 4000);
}

/** 視点（距離・角度）は保ったまま、AO の基準となるモデル半径だけ更新する */
function frameCameraKeepView() {
  const bb = mesh.bounds();
  camera.modelRadius = Math.max(bb.radius, 1e-3);
  updateFloor(bb);
  camera.update(canvas.clientWidth || 1, canvas.clientHeight || 1);
}

// ---------------------------------------------------------------------------
// 座標変換ユーティリティ
// ---------------------------------------------------------------------------
function unproject(nx, ny, nz, out) {
  const m = camera.invViewProj;
  const x = m[0] * nx + m[4] * ny + m[8] * nz + m[12];
  const y = m[1] * nx + m[5] * ny + m[9] * nz + m[13];
  const z = m[2] * nx + m[6] * ny + m[10] * nz + m[14];
  const w = m[3] * nx + m[7] * ny + m[11] * nz + m[15];
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 1;
  out[0] = x * iw; out[1] = y * iw; out[2] = z * iw;
  return out;
}

const _p0 = V3.create(), _p1 = V3.create();
function screenRay(cssX, cssY) {
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  const nx = (cssX / w) * 2 - 1;
  const ny = 1 - (cssY / h) * 2;
  unproject(nx, ny, 0, _p0);
  unproject(nx, ny, 1, _p1);
  V3.copy(rayO, _p0);
  V3.sub(rayD, _p1, _p0);
  V3.normalize(rayD, rayD);
}

/** カメラ前方を法線とする平面（planePoint を通る）とカーソルレイの交点 */
function rayPlanePoint(cssX, cssY, planePoint, out) {
  screenRay(cssX, cssY);
  V3.sub(tmpNormal, camera.target, camera.eye);
  V3.normalize(tmpNormal, tmpNormal);
  const denom = V3.dot(rayD, tmpNormal);
  if (Math.abs(denom) < 1e-6) return false;
  V3.sub(_p0, planePoint, rayO);
  const t = V3.dot(_p0, tmpNormal) / denom;
  if (t <= 0) return false;
  V3.addScaled(out, rayO, rayD, t);
  return true;
}

/** 筆圧を考慮した実効ブラシ半径 / 強さ */
function effectiveRadiusPx() {
  if (!state.usePressure || !ptr.isPen) return state.radiusPx;
  const p = clamp(ptr.pressure, 0.02, 1);
  return state.radiusPx * (1 - state.pressureSize + state.pressureSize * p);
}
function effectiveStrength() {
  if (!state.usePressure || !ptr.isPen) return state.strength;
  const p = clamp(ptr.pressure, 0.02, 1);
  return state.strength * (1 - state.pressureStrength + state.pressureStrength * p);
}

function updateWorldRadius() {
  let dist = camera.distance;
  if (renderer.pick.ok) {
    dist = V3.dist(renderer.pick.point, camera.eye);
  }
  state.worldRadius = Math.max(1e-6, effectiveRadiusPx() * camera.worldPerPixel(dist));
  state.effStrength = effectiveStrength();
  // バックフェイスマスク用の視線方向（表面 → カメラ）
  V3.sub(state.toCamera, camera.eye, camera.target);
  V3.normalize(state.toCamera, state.toCamera);
}

/** レイジーマウスのリードを更新して、ブラシが追う画面座標を返す */
function updateLazy() {
  if (!ptr.lazyInit) {
    ptr.lazyX = ptr.x; ptr.lazyY = ptr.y; ptr.lazyInit = true;
    return;
  }
  const r = Math.max(0, state.lazyRadius);
  if (r <= 0.5) { ptr.lazyX = ptr.x; ptr.lazyY = ptr.y; return; }
  const dx = ptr.x - ptr.lazyX, dy = ptr.y - ptr.lazyY;
  const len = Math.hypot(dx, dy);
  if (len > r) {
    const k = 1 - r / len;
    ptr.lazyX += dx * k;
    ptr.lazyY += dy * k;
  }
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------
function resolveBrush(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  let brush = state.brush;
  let dir = 1;
  if (ctrl) {
    brush = 'mask';
    dir = e.altKey ? -1 : 1;
  } else if (e.shiftKey) {
    brush = 'smooth';
  } else if (e.altKey) {
    dir = -1;
  }
  return { brush, dir };
}

// ---------------------------------------------------------------------------
// サブツール（複数メッシュ）
//
// mesh はモジュールスコープの let で、アクティブなサブツールのメッシュを指す。
// 切り替えると sculptor / tools / レンダラの参照先をまとめて張り替える。
// 非アクティブなものはレンダラの静的スロットから描く（彫刻されないので
// 毎フレーム転送する必要がない）。
// ---------------------------------------------------------------------------

/**
 * 保存レコードからサブツールを復元する。
 * サブツール版のデータが無ければ単一メッシュとして読む（旧形式の互換）。
 */
function restoreRecord(rec) {
  if (renderer) {
    for (const t of subtools.list) renderer.destroyStatic(t.id);
    renderer.drawSlots = null;
    renderer.gpuCapV = 0; renderer.gpuCapT = 0;
  }
  if (Array.isArray(rec.subtools) && rec.subtools.length > 0) {
    const made = [];
    for (const r of rec.subtools) {
      const m = new SculptMesh();
      m.setGeometry(r.positions, r.indices, r.colors, r.mask);
      m.computeAllNormals();
      m.computeAllCurvature();
      made.push({ mesh: m, name: r.name, visible: r.visible !== false });
    }
    subtools.adopt(made[0].mesh, made[0].name);
    subtools.list[0].visible = made[0].visible;
    for (let i = 1; i < made.length; i++) {
      const t = subtools.add(made[i].mesh, made[i].name);
      t.visible = made[i].visible;
    }
    subtools.select(Math.min(rec.activeSubtool || 0, subtools.count - 1));
    mesh = subtools.activeMesh;
    sculptor.setMesh(mesh);
    return;
  }
  // 旧形式（単一メッシュ）
  sculptor.loadGeometry(rec.positions, rec.indices, rec.colors, rec.mask);
  subtools.adopt(mesh, 'サブツール 1');
}

/** アクティブなサブツールを切り替える */
function setActiveSubtool(index, opts = {}) {
  if (!subtools.select(index)) return false;
  mesh = subtools.activeMesh;
  if (sculptor) sculptor.setMesh(mesh);
  if (tools) tools.onMeshReplaced();
  // 新しくアクティブになったものは毎フレーム転送する側へ回るので、
  // 静的スロットは捨てる（残すと GPU メモリを二重に持つ）
  if (renderer) {
    renderer.destroyStatic(subtools.activeTool.id);
    renderer.gpuCapV = 0; renderer.gpuCapT = 0;   // メッシュが変わったので全転送させる
  }
  applyTransposeMode(false);
  if (!opts.keepView) frameCameraKeepView();
  if (ui) { ui.refreshSubtools(); ui.refreshLevels(); }
  return true;
}

/** 非アクティブで表示中のサブツールをレンダラへ渡す */
function syncSubtoolSlots() {
  if (!renderer) return;
  const inactive = subtools.inactiveVisible();
  const slots = [];
  const keep = new Set();
  for (const t of inactive) {
    keep.add(t.id);
    slots.push(renderer.ensureStatic(t.id, t.mesh));
  }
  // 片付けは代入より先に。pruneStatic は破棄済みスロットを掴まないよう
  // drawSlots を落とすので、逆順にすると今作ったリストが消える。
  renderer.pruneStatic(keep);
  renderer.drawSlots = slots;
}

const subtoolApp = {
  subtoolAdd(kind) {
    if (busy) return;
    subtools.addPrimitive(kind || 'sphere');
    setActiveSubtool(subtools.active);
    scheduleAutosave();
    ui.toast(`サブツールを追加しました（${subtools.count} 個）`);
  },
  subtoolDuplicate() {
    if (busy) return;
    if (!subtools.duplicate()) { ui.toast('複製できませんでした'); return; }
    setActiveSubtool(subtools.active);
    scheduleAutosave();
    ui.toast(`複製しました（${subtools.count} 個）`);
  },
  subtoolRemove(index) {
    if (busy) return;
    const i = index === undefined ? subtools.active : index;
    const name = subtools.list[i] ? subtools.list[i].name : '';
    if (!subtools.remove(i)) { ui.toast('最後の 1 個は削除できません'); return; }
    if (renderer) renderer.pruneStatic(new Set(subtools.list.map(t => t.id)));
    setActiveSubtool(subtools.active);
    scheduleAutosave();
    ui.toast(`「${name}」を削除しました`);
  },
  subtoolSelect(index) {
    if (busy) return;
    setActiveSubtool(index, { keepView: true });
  },
  subtoolRename(index, name) {
    subtools.rename(index, name);
    ui.refreshSubtools();
    scheduleAutosave();
  },
  subtoolSetVisible(index, on) {
    subtools.setVisible(index, on);
    syncSubtoolSlots();
    ui.refreshSubtools();
  },
  subtoolSetSolo(on) {
    subtools.solo = !!on;
    syncSubtoolSlots();
    ui.refreshSubtools();
  },
  subtoolMove(index, dir) {
    if (subtools.move(index, dir)) { ui.refreshSubtools(); scheduleAutosave(); }
  },
  subtoolMerge() {
    if (busy) return;
    const r = subtools.mergeVisible();
    if (!r) { ui.toast('まとめるには表示中のサブツールが 2 個以上必要です', 3500); return; }
    if (renderer) renderer.pruneStatic(new Set(subtools.list.map(t => t.id)));
    setActiveSubtool(subtools.active);
    scheduleAutosave();
    ui.toast(`${r.count} 個をまとめました（${r.verts.toLocaleString()} 頂点 / ${r.tris.toLocaleString()} 面）`, 3500);
  },
  subtoolSplitParts() {
    if (busy) return;
    const r = subtools.splitToParts();
    if (!r || r.made === 0) { ui.toast(r ? r.reason : '分けられませんでした', 3500); return; }
    setActiveSubtool(subtools.active);
    scheduleAutosave();
    ui.toast(`${r.made} 個に分けました`);
  },
  subtoolSplitMasked() {
    if (busy) return;
    const r = subtools.splitMasked();
    if (!r || r.made === 0) { ui.toast(r ? r.reason : '分けられませんでした', 3500); return; }
    setActiveSubtool(subtools.active);
    scheduleAutosave();
    ui.toast('マスク部分を切り出しました');
  },
  subtoolInfo() { return subtools.info(); },
  get subtoolSolo() { return subtools.solo; },
  /** 全サブツールが収まるように視点を合わせる */
  frameAll() {
    const b = subtools.bounds();
    if (!b) return;
    camera.frame(b.center, b.radius);
    updateFloor(b);
    camera.update(canvas.clientWidth || 1, canvas.clientHeight || 1);
    ui.toast('全体表示');
  },
};

// ---------------------------------------------------------------------------
// トランスポーズ（ギズモ）と平面カットのドラッグ
// ---------------------------------------------------------------------------

// --- トランスポーズ ---------------------------------------------------------
// ZBrush の W キー相当のモーダル。有効な間はビューのドラッグがギズモ操作になる。
let gizmoHover = null;      // いまホバーしているハンドル { kind, axis }
let gizmoScale = 1;         // ハンドルの大きさ

/**
 * ハンドルの大きさをピボットまでの距離に比例させる。
 * モデルの大小や寄り引きで矢印の見た目が変わると掴みにくいので、
 * 画面上のサイズがほぼ一定に見えるようにしておく。
 */
function updateGizmoScale() {
  if (!tools || !tools.gizmo.active) return;
  gizmoScale = Math.max(1e-4, V3.dist(tools.gizmo.pivot(), camera.eye) * 0.16);
}

/** ハンドルの当たり判定の許容距離（画面 14px 相当をワールド長へ換算） */
function gizmoTolerance() {
  const d = V3.dist(tools.gizmo.pivot(), camera.eye);
  const h = Math.max(1, canvas.clientHeight);
  // 画角から「画面 1px が何ワールド長か」を出す
  const perPixel = (2 * d * Math.tan(camera.fov * 0.5)) / h;
  return Math.max(1e-6, perPixel * 14);
}

function applyTransposeMode(on) {
  if (!tools) return;
  if (on) {
    if (!tools.gizmoActivate()) { if (ui) ui.syncTranspose(false); return; }
    state.transposeMode = true;
    updateGizmoScale();
    tools.gizmoDrawHandles(gizmoScale, null);
  } else {
    state.transposeMode = false;
    tools.gizmoDeactivate();
    gizmoHover = null;
  }
  if (ui) ui.syncTranspose(state.transposeMode);
}

/** ホバー中のハンドルを更新して線を描き直す */
function updateGizmoHover(cssX, cssY) {
  if (!tools || !tools.gizmo.active) return;
  updateGizmoScale();
  screenRay(cssX, cssY);
  gizmoHover = tools.gizmo.hitTest(rayO, rayD, gizmoTolerance(), gizmoScale);
  tools.gizmoDrawHandles(gizmoScale, gizmoHover);
}

// --- 平面カット（クリップ / トリム / スライス） -----------------------------
// ドラッグの始点と終点をワールドへ落とし、その 2 点と視線方向で平面を作る。
// ZBrush の ClipCurve と同じ操作感で、線の表側が残る。
const clipDrag = {
  on: false, x0: 0, y0: 0,
  a: V3.create(), b: V3.create(), center: V3.create(), vd: V3.create(),
};

function clipDragBegin(cssX, cssY) {
  const c = mesh.bounds().center;
  V3.set(clipDrag.center, c[0], c[1], c[2]);
  if (!rayPlanePoint(cssX, cssY, clipDrag.center, clipDrag.a)) return false;
  V3.copy(clipDrag.b, clipDrag.a);
  clipDrag.on = true;
  clipDrag.x0 = cssX; clipDrag.y0 = cssY;
  // 平面の押し出し方向は視線。ドラッグ中は動かさないので 1 回だけ取る
  V3.sub(clipDrag.vd, camera.target, camera.eye);
  V3.normalize(clipDrag.vd, clipDrag.vd);
  drawClipGuide();
  return true;
}

function clipDragMove(cssX, cssY) {
  if (!clipDrag.on) return;
  if (rayPlanePoint(cssX, cssY, clipDrag.center, clipDrag.b)) drawClipGuide();
}

/** ドラッグ中の平面を線で見せる（切る前に位置と向きが分かるように） */
const _clipGuide = new Float32Array(10 * 7);
function drawClipGuide() {
  if (!renderer || !clipDrag.on) return;
  const a = clipDrag.a, b = clipDrag.b, vd = clipDrag.vd;
  const r = mesh.bounds().radius * 1.8;
  const p = [
    [a[0] - vd[0] * r, a[1] - vd[1] * r, a[2] - vd[2] * r],
    [a[0] + vd[0] * r, a[1] + vd[1] * r, a[2] + vd[2] * r],
    [b[0] + vd[0] * r, b[1] + vd[1] * r, b[2] + vd[2] * r],
    [b[0] - vd[0] * r, b[1] - vd[1] * r, b[2] - vd[2] * r],
  ];
  // 外周 4 本 + ドラッグ線そのもの
  const segs = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 3]];
  const out = _clipGuide;
  let w = 0;
  for (const [i, j] of segs) {
    for (const k of [i, j]) {
      out[w] = p[k][0]; out[w + 1] = p[k][1]; out[w + 2] = p[k][2];
      out[w + 3] = 1.0; out[w + 4] = 0.52; out[w + 5] = 0.18; out[w + 6] = 0.92;
      w += 7;
    }
  }
  renderer.setOverlayLines(out, segs.length * 2, true);
}

function clipDragEnd() {
  if (!clipDrag.on) return;
  clipDrag.on = false;
  if (renderer) renderer.setOverlayLines(null, 0);
  if (V3.dist(clipDrag.a, clipDrag.b) < mesh.bounds().radius * 0.02) {
    ui.toast('ドラッグが短すぎます');
    return;
  }
  const plane = tools.planeFromDrag(clipDrag.a, clipDrag.b, clipDrag.vd);
  tools.applyPlane(state.clipMode, plane);
}

// ---------------------------------------------------------------------------
// キー操作。
//
// **ここが唯一の定義**で、使い方ページ（js/help.js）も同じ表を読む。
// 以前は keydown の switch 文だったが、それだとヘルプに書き写すことになり、
// キーを増やしたときにヘルプだけ古くなる。
//
// 照合は「指定した修飾キーと完全に一致」で見る（shift を書いていない項目は
// shift を押していないときだけ効く）。Shift+W とただの W のように、
// 同じキーで別の動作を割り当てているものがあるため。
// 上から順に見て最初に当たったものを実行するので、修飾キー付きを先に置く。
// ---------------------------------------------------------------------------
// 文字を打つ場所にフォーカスがあるか。ショートカットを譲るかどうかの判定。
// range / checkbox / radio / button / color / file は「入力欄」だが文字は打たない。
const NON_TEXT_INPUT = new Set(['range', 'checkbox', 'radio', 'button', 'submit',
  'reset', 'color', 'file', 'image']);
function isTypingTarget(t, ctrl) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || t.isContentEditable) return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT.has(String(t.type || 'text').toLowerCase());
  // select は文字キーで項目を選べるので、修飾キー無しのショートカットだけ譲る
  if (tag === 'SELECT') return !ctrl;
  return false;
}

const SHORTCUTS = [
  // --- 編集 ---
  { group: '編集', keys: 'Ctrl+Z', jp: '元に戻す', code: 'KeyZ', ctrl: true, prevent: true,
    run: () => app.undo() },
  { group: '編集', keys: 'Ctrl+Shift+Z', jp: 'やり直す', code: 'KeyZ', ctrl: true, shift: true, prevent: true,
    run: () => app.redo() },
  { group: '編集', keys: 'Ctrl+Y', jp: 'やり直す（別のキー）', code: 'KeyY', ctrl: true, prevent: true,
    run: () => app.redo() },

  // --- ブラシ ---
  { group: 'ブラシ', keys: '1 〜 9, 0', jp: 'ブラシを選ぶ（左の並び順）',
    match: (e) => !e.ctrlKey && !e.metaKey && /^Digit\d$/.test(e.code),
    run: (e) => {
      const idx = (parseInt(e.code.slice(5), 10) + 9) % 10;   // 1→0, 0→9
      if (idx < BRUSH_IDS.length) ui.setBrush(BRUSH_IDS[idx]);
    } },
  { group: 'ブラシ', keys: '[ / ]', jp: 'ブラシの大きさ', code: 'BracketLeft',
    run: () => { state.radiusPx = clamp(state.radiusPx * 0.88, 6, 400); ui.syncFromState(); } },
  { keys: ']', hidden: true, code: 'BracketRight',
    run: () => { state.radiusPx = clamp(state.radiusPx * 1.14, 6, 400); ui.syncFromState(); } },
  { group: 'ブラシ', keys: ', / .', jp: 'ブラシの強さ', code: 'Comma',
    run: () => { state.strength = clamp(state.strength - 0.05, 0.01, 1); ui.syncFromState(); } },
  { keys: '.', hidden: true, code: 'Period',
    run: () => { state.strength = clamp(state.strength + 0.05, 0.01, 1); ui.syncFromState(); } },
  { group: 'ブラシ', keys: 'B', jp: 'バックフェイスマスク（裏側を彫らない）', code: 'KeyB',
    run: () => {
      state.backfaceMask = !state.backfaceMask; ui.syncFromState();
      ui.toast('バックフェイスマスク: ' + (state.backfaceMask ? 'ON' : 'OFF'));
    } },
  { group: 'ブラシ', keys: 'L', jp: 'レイジーマウス（線を滑らかにする）', code: 'KeyL',
    run: () => {
      state.lazyRadius = state.lazyRadius > 0.5 ? 0 : 24; ui.syncFromState();
      ui.toast('レイジーマウス: ' + (state.lazyRadius > 0.5 ? `ON (${state.lazyRadius}px)` : 'OFF'));
    } },

  // --- 形を変える ---
  { group: '形を変える', keys: 'X', jp: 'X ミラー（左右対称）', code: 'KeyX',
    run: () => {
      state.symmetry.x = !state.symmetry.x; ui.syncFromState();
      ui.toast('X ミラー: ' + (state.symmetry.x ? 'ON' : 'OFF'));
    } },
  { group: '形を変える', keys: 'G', jp: '動的トポロジ（彫りながら細かくする）', code: 'KeyG',
    run: () => {
      state.dynTopo = !state.dynTopo; ui.syncFromState();
      ui.toast('動的トポロジ: ' + (state.dynTopo ? 'ON' : 'OFF'));
    } },
  { group: '形を変える', keys: 'D', jp: 'ダイナメッシュ（形を作り直す）', code: 'KeyD',
    run: () => app.dynamesh() },
  { group: '形を変える', keys: 'W', jp: 'トランスポーズ（掴んで動かす）', code: 'KeyW',
    run: () => app.toggleTranspose() },
  { group: '形を変える', keys: 'C', jp: '平面カットの切り替え（オフ→クリップ→トリム→スライス）', code: 'KeyC',
    run: () => {
      const order = ['off', 'clip', 'trim', 'slice'];
      state.clipMode = order[(order.indexOf(state.clipMode) + 1) % order.length];
      ui.syncFromState();
      const jp = { off: 'オフ', clip: 'クリップ', trim: 'トリム', slice: 'スライス' };
      ui.toast('平面カット: ' + jp[state.clipMode]);
    } },
  { group: '形を変える', keys: 'PageUp / PageDown', jp: '分割レベルを上げる / 下げる', code: 'PageUp', prevent: true,
    run: () => app.levelUp() },
  { keys: 'PageDown', hidden: true, code: 'PageDown', prevent: true,
    run: () => app.levelDown() },

  // --- 表示 ---
  { group: '表示', keys: 'F', jp: '全体が入るように視点を戻す', code: 'KeyF',
    run: () => { frameCamera(); ui.toast('全体表示'); } },
  { group: '表示', keys: 'M', jp: 'マテリアル（MatCap）を次へ', code: 'KeyM',
    run: () => ui.setMaterial((state.material + 1) % renderer.matcapCount) },
  { group: '表示', keys: 'A', jp: '陰影（AO）', code: 'KeyA',
    run: () => { state.ao = !state.ao; ui.syncFromState(); ui.toast('AO: ' + (state.ao ? 'ON' : 'OFF')); } },
  { group: '表示', keys: 'Shift+W', jp: 'ワイヤフレーム', code: 'KeyW', shift: true,
    run: () => { state.wireframe = !state.wireframe; ui.syncFromState(); } },
  { group: '表示', keys: 'H', jp: '床のグリッド', code: 'KeyH',
    run: () => { state.grid = !state.grid; ui.syncFromState(); ui.toast('フロアグリッド: ' + (state.grid ? 'ON' : 'OFF')); } },

  // --- ヘルプ ---
  { group: 'ヘルプ', keys: 'F1 または ?', jp: '使い方を開く / 閉じる', code: 'F1', prevent: true,
    run: () => ui.toggleHelp() },
  // help: true は「使い方ページを開いている間も通すキー」の印
  { keys: '?', hidden: true, help: true, prevent: true,
    match: (e) => e.key === '?' && !e.ctrlKey && !e.metaKey,
    run: () => ui.toggleHelp() },
  { group: 'ヘルプ', keys: 'Esc', jp: '使い方を閉じる', code: 'Escape',
    run: () => ui.closeHelp() },

  // 視点操作は下の「押している間」の扱いなので、表示用の項目だけ持たせる
  { group: '視点', keys: 'Space+ドラッグ', jp: '平行移動（パン）', code: 'Space', prevent: true,
    run: () => { spaceDown = true; } },
];

// ---------------------------------------------------------------------------
// 編集モードの選択（クリックで拾う / ドラッグで矩形選択）
//
// 矩形は DOM の div で描く。オーバーレイ線のバッファは編集メッシュのワイヤ表示に
// 使っていて 1 本しかないので、そこへ混ぜると毎フレーム作り直しになる。
// ---------------------------------------------------------------------------
const editBox = { on: false, x0: 0, y0: 0, x1: 0, y1: 0, add: false, el: null };

function editBoxEl() {
  if (!editBox.el) editBox.el = document.getElementById('editbox');
  return editBox.el;
}

function editDragBegin(x, y, add) {
  editBox.on = true;
  editBox.x0 = x; editBox.y0 = y; editBox.x1 = x; editBox.y1 = y;
  editBox.add = !!add;
  const el = editBoxEl();
  if (el) { el.style.display = 'none'; }
}

function editDragMove(x, y) {
  if (!editBox.on) return;
  editBox.x1 = x; editBox.y1 = y;
  const el = editBoxEl();
  if (!el) return;
  const w = Math.abs(x - editBox.x0), h = Math.abs(y - editBox.y0);
  if (w < 4 && h < 4) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.left = Math.min(x, editBox.x0) + 'px';
  el.style.top = Math.min(y, editBox.y0) + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
}

/** ワールド座標 → キャンバス座標。矩形選択の判定に使う */
function makeProjector() {
  const vp = camera.viewProj;
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  return (x, y, z) => {
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 1e-6) return [0, 0, false];
    return [(cx / cw * 0.5 + 0.5) * w, (0.5 - cy / cw * 0.5) * h, true];
  };
}

function editDragEnd() {
  if (!editBox.on) return;
  editBox.on = false;
  const el = editBoxEl();
  if (el) el.style.display = 'none';
  const w = Math.abs(editBox.x1 - editBox.x0), h = Math.abs(editBox.y1 - editBox.y0);
  if (w < 4 && h < 4) {
    // クリック扱い。カーソル下の表面のワールド座標から一番近いものを拾う
    if (renderer.pick.ok) tools.editPick(renderer.pick.point, editBox.add);
    else if (!editBox.add) tools.editSelect('none');
    return;
  }
  const r = tools.editBoxSelect(makeProjector(),
    { x0: editBox.x0, y0: editBox.y0, x1: editBox.x1, y1: editBox.y1 }, editBox.add);
  if (r) {
    ui.toast(`選択: 頂点 ${r.verts.toLocaleString()} / 辺 ${r.edges.toLocaleString()}`
      + ` / 面 ${r.faces.toLocaleString()}`);
  }
}

function bindInput() {
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    // 重い処理中は入力を受けない。
    // 以前はメインスレッドが止まっていたので勝手に弾かれていたが、リメッシュを
    // ワーカーへ出して UI が動くようになったため、明示的に弾かないと処理中に
    // 彫り始められる。その状態で結果を setGeometry すると、進行中のストロークが
    // 別のトポロジを掴んだままになる。
    if (busy) { e.preventDefault(); return; }
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top;
    ptr.px = ptr.x; ptr.py = ptr.y;
    ptr.dx = 0; ptr.dy = 0;
    ptr.down = true; ptr.id = e.pointerId; ptr.inside = true;
    ptr.isPen = e.pointerType === 'pen';
    ptr.pressure = ptr.isPen ? (e.pressure || 0.5) : 1;
    // ストローク開始時はリードを掴んでいる点に合わせる（初動が遅れないように）
    ptr.lazyX = ptr.x; ptr.lazyY = ptr.y; ptr.lazyInit = true;

    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      ptr.mode = 'pan';
    } else if (e.button === 2) {
      ptr.mode = 'orbit';
    } else if (e.button === 0 && state.transposeMode && tools.gizmo.active) {
      // ギズモのハンドルを掴んでいればトランスポーズ、外していれば視点回転
      screenRay(ptr.x, ptr.y);
      const hit = tools.gizmo.hitTest(rayO, rayD, gizmoTolerance(), gizmoScale);
      if (hit && tools.gizmo.beginDrag(mesh, hit, rayO, rayD)) {
        tools.gizmoBeginRecord();
        ptr.mode = 'gizmo';
        gizmoHover = hit;
        tools.gizmoDrawHandles(gizmoScale, gizmoHover);
      } else {
        ptr.mode = 'orbit';
      }
    } else if (e.button === 0 && state.editMode) {
      // 編集モードでは彫らない。クリックで拾い、ドラッグで矩形選択する
      editDragBegin(ptr.x, ptr.y, e.shiftKey);
      ptr.mode = 'editbox';
    } else if (e.button === 0 && state.clipMode !== 'off') {
      ptr.mode = clipDragBegin(ptr.x, ptr.y) ? 'clip' : 'orbit';
    } else if (e.button === 0) {
      if (renderer.pick.ok) {
        const rb = resolveBrush(e);
        activeBrush = rb.brush;
        activeDir = rb.dir;
        ptr.mode = 'sculpt';
        updateWorldRadius();
        V3.copy(tmpPoint, renderer.pick.point);
        grabPlanePoint = usesGrabPlane(activeBrush)
          ? V3.create(tmpPoint[0], tmpPoint[1], tmpPoint[2]) : null;
        sculptor.beginStroke(activeBrush, tmpPoint, activeDir);
      } else {
        ptr.mode = 'orbit';
      }
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const nx = e.clientX - r.left, ny = e.clientY - r.top;
    ptr.dx += nx - ptr.x;
    ptr.dy += ny - ptr.y;
    ptr.x = nx; ptr.y = ny;
    ptr.inside = true;
    if (e.pointerType === 'pen') {
      ptr.isPen = true;
      ptr.pressure = e.pressure || ptr.pressure;
    }
    if (ptr.mode === 'gizmo') {
      screenRay(ptr.x, ptr.y);
      tools.gizmo.updateDrag(mesh, rayO, rayD, { snap: e.shiftKey });
      tools.gizmoDrawHandles(gizmoScale, gizmoHover);
    } else if (ptr.mode === 'editbox') {
      editDragMove(ptr.x, ptr.y);
    } else if (ptr.mode === 'clip') {
      clipDragMove(ptr.x, ptr.y);
    } else if (!ptr.down && state.transposeMode && tools && tools.gizmo.active) {
      // 掴んでいないときはホバー表示だけ更新する
      updateGizmoHover(ptr.x, ptr.y);
    }
  });

  const endPointer = () => {
    if (ptr.mode === 'gizmo') {
      const r = tools.gizmo.endDrag(mesh);
      tools.gizmoEndRecord();
      if (r.changed > 0) {
        sculptor.hoverSeed = -1;
        sculptor.dropPendingCurvature();
        mesh.computeAllCurvature();
        sculptor.history.commit(mesh);
        scheduleAutosave();
      }
      // 編集モード中は、動かした結果を編集メッシュへ書き戻す。
      // 頂点番号は 1:1 なのでそのまま写せる。
      if (state.editMode && tools.edit && tools.edit.nv === mesh.nv) {
        tools.edit.positions.set(mesh.positions.subarray(0, mesh.nv * 3));
        tools.edit.version++;
        tools.editSyncOverlay();
        if (ui.refreshEdit) ui.refreshEdit();
      }
      // 動かしたぶんピボットがずれるので立て直す
      tools.gizmoActivate();
      updateGizmoScale();
      tools.gizmoDrawHandles(gizmoScale, gizmoHover);
    } else if (ptr.mode === 'clip') {
      clipDragEnd();
    } else if (ptr.mode === 'editbox') {
      editDragEnd();
    }
    if (ptr.mode === 'sculpt') {
      sculptor.endStroke();
      sculptor.checkLevels();
      ui.refreshLevels();
      frameCameraKeepView();     // 床の高さと AO 半径を追従させる
      scheduleAutosave();
    }
    ptr.down = false;
    ptr.mode = 'none';
    grabPlanePoint = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { ptr.inside = false; });
  canvas.addEventListener('pointerenter', () => { ptr.inside = true; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const steps = Math.sign(e.deltaY) * Math.min(3, Math.max(1, Math.abs(e.deltaY) / 100));
    camera.zoom(steps);
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    // 文字を打っている場所ではショートカットを奪わない（Ctrl+Z は文字の
    // 取り消しに要る）。ただし **スライダーやチェックボックスは「入力欄」では
    // あっても文字を打つ場所ではない** ので通す。
    // 以前は tagName が INPUT なら一律で弾いていて、スライダーを 1 回触ると
    // フォーカスが残り、そのあと Ctrl+Z が効かなくなっていた。
    if (isTypingTarget(e.target, e.ctrlKey || e.metaKey)) return;
    // 使い方ページを開いている間は、閉じるキーだけ通す。オーバーレイの裏で
    // D（ダイナメッシュ）などが走ると、読んでいるうちに形が変わってしまう。
    const helpOpen = ui && ui.helpIsOpen && ui.helpIsOpen();
    const ctrl = e.ctrlKey || e.metaKey;
    for (const s of SHORTCUTS) {
      if (helpOpen && s.group !== 'ヘルプ' && !s.help) continue;
      const hit = s.match
        ? s.match(e)
        : s.code === e.code && !!s.ctrl === ctrl && !!s.shift === e.shiftKey;
      if (!hit) continue;
      if (s.prevent) e.preventDefault();
      s.run(e);
      return;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceDown = false;
  });

  window.addEventListener('blur', () => { spaceDown = false; });
  window.addEventListener('resize', () => renderer.resize());
}

// ---------------------------------------------------------------------------
// フレーム処理
// ---------------------------------------------------------------------------
function processInput() {
  const dx = ptr.dx, dy = ptr.dy;
  ptr.dx = 0; ptr.dy = 0;

  if (!ptr.down || busy) return;

  if (ptr.mode === 'orbit') {
    camera.invertOrbitY = state.invertOrbitY;
    if (dx || dy) camera.orbit(dx, dy);
    return;
  }
  if (ptr.mode === 'pan') {
    if (dx || dy) camera.pan(dx, dy, canvas.clientHeight || 1);
    return;
  }
  if (ptr.mode !== 'sculpt') return;

  updateWorldRadius();

  if (usesGrabPlane(activeBrush)) {
    if (!grabPlanePoint) return;
    if (!rayPlanePoint(ptr.lazyX, ptr.lazyY, grabPlanePoint, tmpPoint)) return;
    sculptor.addSample(tmpPoint);
  } else {
    if (!renderer.pick.ok) return;
    V3.copy(tmpPoint, renderer.pick.point);
    sculptor.addSample(tmpPoint);
  }
}

function buildRings() {
  if (!ptr.inside && !ptr.down) return null;
  if (!renderer.pick.ok) return null;

  V3.copy(tmpPoint, renderer.pick.point);
  if (ptr.mode === 'sculpt' && usesGrabPlane(activeBrush) && grabPlanePoint) {
    rayPlanePoint(ptr.lazyX, ptr.lazyY, grabPlanePoint, tmpPoint);
  }

  let haveN = false;
  if (ptr.mode === 'sculpt' && sculptor.stroking) {
    const an = sculptor.engine.avgN;
    if (V3.lenSq(an) > 0.5) { V3.copy(tmpNormal, an); haveN = true; }
  }
  if (!haveN) haveN = sculptor.surfaceNormalAt(tmpPoint, tmpNormal);
  if (!haveN) V3.set(tmpNormal, 0, 0, 1);

  const mirrors = sculptor.stroking ? sculptor.activeMirrors : sculptor.buildActiveMirrors();

  ringOut.length = 0;
  // リングの枚数だけは上限を設ける。ラジアルシンメトリで 32 分割すると
  // カーソルのリングが 32 個出て何も見えなくなるため。
  const maxRings = Math.min(ringMats.length, state.lazyRadius > 0.5 ? 7 : 8);
  for (let i = 0; i < mirrors.length && i < maxRings; i++) {
    const mir = mirrors[i];
    const r = ringMats[i];
    mirrorPoint(mir, tmpPoint, r.pos);
    mirrorVector(mir, tmpNormal, r.nrm);
    M4.diskBasis(r.matrix, r.pos, r.nrm, state.worldRadius);
    ringOut.push(r);
  }

  // レイジーマウス有効時は、実カーソル位置にも小さな印を出して遅れを可視化する
  if (state.lazyRadius > 0.5 && ringOut.length < 8) {
    const d = Math.hypot(ptr.x - ptr.lazyX, ptr.y - ptr.lazyY);
    if (d > 1) {
      const r = ringMats[ringOut.length];
      if (rayPlanePoint(ptr.x, ptr.y, tmpPoint, r.pos)) {
        V3.copy(r.nrm, tmpNormal);
        M4.diskBasis(r.matrix, r.pos, r.nrm, state.worldRadius * 0.14);
        ringOut.push(r);
      }
    }
  }
  return ringOut;
}

let lastT = performance.now();
let fpsAvg = 60;
let statTimer = 0;

function loop(t) {
  const dt = Math.min(100, t - lastT);
  lastT = t;
  fpsAvg += ((1000 / Math.max(1, dt)) - fpsAvg) * 0.12;

  renderer.resize();
  updateLazy();
  processInput();
  camera.update(canvas.clientWidth || 1, canvas.clientHeight || 1);
  // 毎フレーム更新しないと、スライダーやキーで半径を変えてもカーソルリングに
  // 反映されない（彫刻を始めるまで古い値が使われてしまう）
  updateWorldRadius();
  // このフレームのダブで溜まった曲率更新をまとめて処理する
  sculptor.flushCurvature();

  const rings = buildRings();
  // ピックはレイジーマウスのリード位置で行う（ブラシが当たるのはそこ）
  if (ptr.inside || ptr.down) renderer.requestPick(ptr.lazyX, ptr.lazyY);
  else renderer.pickRequest = null;

  // 非アクティブなサブツールは静的バッファから描く（彫刻されないので転送は初回だけ）
  if (subtools.count > 1 || renderer.drawSlots) syncSubtoolSlots();
  renderer.render(camera, mesh, state, rings);
  // 残りの MatCap を 1 フレーム 1 枚ずつ裏で用意する（起動を待たせない）
  renderer.fillNextMatcap();

  statTimer += dt;
  if (statTimer > 250) {
    statTimer = 0;
    ui.refreshStats({
      verts: mesh.liveVerts,
      tris: mesh.liveTris,
      fps: fpsAvg,
      mb: (mesh.byteSize() + sculptor.history.bytes()) / (1024 * 1024),
    });
  }

  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
function fatal(msg, detail) {
  const box = document.getElementById('fatal');
  box.style.display = 'flex';
  document.getElementById('fatalMsg').textContent = msg;
  document.getElementById('fatalDetail').textContent = detail || '';
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';
}

async function boot() {
  if (location.protocol === 'file:') {
    fatal('http(s) 経由で開いてください',
      'ES モジュールは file:// では読み込めません。同梱の server.mjs を使って '
      + '`node server.mjs` を実行し、表示される URL を開いてください。');
    return;
  }
  if (!navigator.gpu) {
    fatal('WebGPU が利用できません',
      'Chrome / Edge 113 以降、または WebGPU を有効にした Firefox / Safari で開いてください。'
      + ' 企業ポリシーや GPU ドライバの制限で無効化されている場合もあります。');
    return;
  }
  try {
    renderer = await Renderer.create(canvas);
  } catch (err) {
    fatal('WebGPU の初期化に失敗しました', String(err && err.message || err));
    return;
  }

  // 前回の設定を復元（メッシュは IndexedDB、設定は localStorage）
  store.loadSettings(state);
  app.setBackground(state.bgPreset);

  const g = PRIMITIVES.sphere();
  mesh.setGeometry(g.positions, g.indices);
  subtools.adopt(mesh, 'サブツール 1');
  sculptor = new Sculptor(mesh, state);
  tools = new Tools({
    state,
    getMesh: () => mesh,
    getSculptor: () => sculptor,
    getRenderer: () => renderer,
    getUI: () => ui,
    redraw: () => { /* 毎フレーム描いているので即時の再描画要求は不要 */ },
    autosave: scheduleAutosave,
  });
  Object.assign(app, subtoolApp);
  app.tools = tools;
  tools.syncRecorder();   // モーフブラシのフックもここで差される
  ui = buildUI(app);
  renderer.setRenderScale(state.renderScale);
  frameCamera();
  bindInput();
  ui.refreshLevels();
  ui.refreshProjects();

  // 距離場の WASM を裏で読み込む（失敗しても JS 版で動くので待たない）
  initWasmField().then(async (ok) => {
    if (!ok) { console.info('WASM 距離場は使えないため JS 版で動作します: ' + wasmFieldError()); return; }
    // ワーカープールも用意する（作れなければ単一スレッドのまま）
    await initParallelField(wasmFieldModule());
  });

  renderer.onDeviceLost = (info) => {
    fatal('GPU デバイスが失われました', info && info.message ? info.message : 'ページを再読み込みしてください。');
  };

  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';

  // 自動保存があれば復元を提案する（勝手に上書きはしない）
  let restored = false;
  try {
    const auto = await store.loadAutosave();
    if (auto && auto.verts > 0) {
      const when = new Date(auto.updated);
      const label = `${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}`;
      ui.setAutosaveMark(when);
      restored = await ui.askRestore(
        `${label} の自動保存が見つかりました（${auto.verts.toLocaleString()} 頂点）。復元しますか？`);
      if (restored) await app.loadProject(store.AUTOSAVE);
    }
  } catch { /* IndexedDB が使えない環境では黙って続行 */ }

  if (!restored) ui.toast('モデルの上を左ドラッグで彫刻、背景ドラッグで回転', 3600);

  window.addEventListener('beforeunload', () => { store.saveSettings(state); });

  lastT = performance.now();
  requestAnimationFrame(loop);
}

boot();

// デバッグ / 自動テスト用
window.__wasmState = wasmFieldState;
window.__parState = () => parallelState() + ':' + parallelWorkers();
// ダイナメッシュを差し替え前の生の形で呼べるようにしておく（並列と逐次の突き合わせ用）
window.__rawDynamesh = dynamesh;
// 入出力の関数。ファイル選択ダイアログはテストから出せないので、
// 読み込みの配線はここを直に叩いて確かめる。
window.__io = { exportSTL, exportOBJ, exportPLY, importMesh: importMeshFile, importSTL };
window.WebSculpt = {
  state, camera, app, BRUSHES,
  get mesh() { return mesh; },
  get subtools() { return subtools; },
  pointer: ptr,
  get renderer() { return renderer; },
  get sculptor() { return sculptor; },
  get ui() { return ui; },
  get tools() { return tools; },
};
