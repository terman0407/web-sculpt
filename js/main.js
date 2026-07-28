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
import { exportOBJ, exportSTL, exportPLY, importOBJ, download } from './io.js';
import * as store from './store.js';
import { initWasmField, wasmFieldState, wasmFieldError, wasmFieldModule } from './wasmfield.js';
import { dynamesh } from './dynamesh.js';
import { initParallelField, parallelState, parallelWorkers } from './parallelfield.js';

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
  invertOrbitY: false,
  bgPreset: 'dark',
  bgTop: BG_PRESETS.dark.top,
  bgBot: BG_PRESETS.dark.bot,
  ringColor: BG_PRESETS.dark.ring,
};

const canvas = document.getElementById('gpu');
const camera = new OrbitCamera();
const mesh = new SculptMesh();
let renderer = null;
let sculptor = null;
let ui = null;

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
  newMesh(kind) {
    const gen = PRIMITIVES[kind] || PRIMITIVES.sphere;
    const g = gen();
    mesh.setGeometry(g.positions, g.indices);
    if (sculptor) { sculptor.setMesh(mesh); }
    frameCamera();
    if (ui) ui.toast('新しいメッシュを作成しました');
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
      const r = await store.saveProject(name, mesh, state);
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
      sculptor.loadGeometry(rec.positions, rec.indices, rec.colors, rec.mask);
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
      download(exportOBJ(mesh), `websculpt-${stamp}.obj`, 'text/plain');
    } else if (kind === 'stl') {
      download(exportSTL(mesh), `websculpt-${stamp}.stl`, 'model/stl');
    } else if (kind === 'ply') {
      download(exportPLY(mesh), `websculpt-${stamp}.ply`, 'application/octet-stream');
    }
    ui.toast(`${kind.toUpperCase()} を書き出しました`);
  },
  importOBJ() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.obj,text/plain';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const g = importOBJ(await f.text());
        mesh.setGeometry(g.positions, g.indices);
        sculptor.setMesh(mesh);
        frameCamera();
        ui.toast(`読み込み: ${mesh.liveVerts.toLocaleString()} 頂点 / ${mesh.liveTris.toLocaleString()} 面`);
      } catch (e) {
        ui.toast('読み込み失敗: ' + e.message, 4000);
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
      await store.saveAutosave(mesh, state);
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

function bindInput() {
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
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
  });

  const endPointer = () => {
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
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) app.redo(); else app.undo();
      return;
    }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); app.redo(); return; }
    if (ctrl) return;

    switch (e.code) {
      case 'Space': spaceDown = true; e.preventDefault(); break;
      case 'BracketLeft':
        state.radiusPx = clamp(state.radiusPx * 0.88, 6, 400); ui.syncFromState(); break;
      case 'BracketRight':
        state.radiusPx = clamp(state.radiusPx * 1.14, 6, 400); ui.syncFromState(); break;
      case 'Comma':
        state.strength = clamp(state.strength - 0.05, 0.01, 1); ui.syncFromState(); break;
      case 'Period':
        state.strength = clamp(state.strength + 0.05, 0.01, 1); ui.syncFromState(); break;
      case 'KeyX':
        state.symmetry.x = !state.symmetry.x; ui.syncFromState();
        ui.toast('X ミラー: ' + (state.symmetry.x ? 'ON' : 'OFF')); break;
      case 'KeyW':
        state.wireframe = !state.wireframe; ui.syncFromState(); break;
      case 'KeyA':
        state.ao = !state.ao; ui.syncFromState();
        ui.toast('AO: ' + (state.ao ? 'ON' : 'OFF')); break;
      case 'KeyG':
        state.dynTopo = !state.dynTopo; ui.syncFromState();
        ui.toast('動的トポロジ: ' + (state.dynTopo ? 'ON' : 'OFF')); break;
      case 'KeyM':
        ui.setMaterial((state.material + 1) % renderer.matcapCount); break;
      case 'KeyF':
        frameCamera(); ui.toast('全体表示'); break;
      case 'KeyD':
        app.dynamesh(); break;
      case 'KeyB':
        state.backfaceMask = !state.backfaceMask; ui.syncFromState();
        ui.toast('バックフェイスマスク: ' + (state.backfaceMask ? 'ON' : 'OFF')); break;
      case 'KeyL':
        state.lazyRadius = state.lazyRadius > 0.5 ? 0 : 24; ui.syncFromState();
        ui.toast('レイジーマウス: ' + (state.lazyRadius > 0.5 ? `ON (${state.lazyRadius}px)` : 'OFF')); break;
      case 'KeyH':
        state.grid = !state.grid; ui.syncFromState();
        ui.toast('フロアグリッド: ' + (state.grid ? 'ON' : 'OFF')); break;
      case 'PageUp':
        e.preventDefault(); app.levelUp(); break;
      case 'PageDown':
        e.preventDefault(); app.levelDown(); break;
      default: {
        const m = /^Digit(\d)$/.exec(e.code);
        if (m) {
          const idx = (parseInt(m[1], 10) + 9) % 10;   // 1→0, 0→9
          if (idx < BRUSH_IDS.length) ui.setBrush(BRUSH_IDS[idx]);
        }
      }
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
  sculptor = new Sculptor(mesh, state);
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
window.WebSculpt = {
  state, mesh, camera, app, BRUSHES,
  pointer: ptr,
  get renderer() { return renderer; },
  get sculptor() { return sculptor; },
  get ui() { return ui; },
};
