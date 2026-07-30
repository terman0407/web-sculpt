// ---------------------------------------------------------------------------
// store.js - ブラウザ内保存
//
//   設定（ブラシ・表示など）  → localStorage（数 KB の JSON）
//   メッシュ本体              → IndexedDB（localStorage は 5MB 前後で足りない。
//                               IndexedDB なら型付き配列をそのまま保存できる）
//
// オートセーブはストローク終了から一定時間後に 1 回だけ走らせ、
// 次回起動時に「復元しますか」と聞ける状態にしておく。
// ---------------------------------------------------------------------------

const DB_NAME = 'websculpt';
const DB_VERSION = 1;
const STORE = 'projects';
const SETTINGS_KEY = 'websculpt.settings.v1';
const AUTOSAVE_NAME = '__autosave__';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) { reject(new Error('この環境では IndexedDB が使えません')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB を開けません'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error || new Error('IndexedDB エラー'));
    t.onabort = () => reject(t.error || new Error('IndexedDB 中断'));
  }));
}

// --- 設定（localStorage） --------------------------------------------------

const SETTING_KEYS = [
  'brush', 'radiusPx', 'strength', 'focalShift', 'lazyRadius', 'usePressure',
  'pressureSize', 'pressureStrength', 'backfaceMask',
  'dynTopo', 'decimate', 'detail', 'maxVerts',
  'dynaResolution', 'dynaSmooth', 'dynaTransferColor',
  'material', 'shading', 'autoSmoothAngle', 'wireframe', 'ao', 'aoIntensity', 'aoRadius', 'aoPower',
  'cavity', 'peak', 'cavityGain', 'grid', 'exposure', 'maskDarken',
  'renderScale', 'invertOrbitY', 'bgPreset', 'paintColor', 'symmetry',
];

export function saveSettings(state) {
  try {
    const o = {};
    for (const k of SETTING_KEYS) {
      if (state[k] === undefined) continue;
      o[k] = (k === 'symmetry' || k === 'paintColor') ? JSON.parse(JSON.stringify(state[k])) : state[k];
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
    return true;
  } catch { return false; }
}

export function loadSettings(state) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    for (const k of SETTING_KEYS) {
      if (o[k] === undefined) continue;
      if (k === 'symmetry') {
        if (o.symmetry && typeof o.symmetry === 'object') {
          state.symmetry.x = !!o.symmetry.x;
          state.symmetry.y = !!o.symmetry.y;
          state.symmetry.z = !!o.symmetry.z;
        }
      } else if (k === 'paintColor') {
        if (Array.isArray(o.paintColor) && o.paintColor.length === 3) state.paintColor = o.paintColor.slice();
      } else {
        state[k] = o[k];
      }
    }
    return true;
  } catch { return false; }
}

export function clearSettings() {
  try { localStorage.removeItem(SETTINGS_KEY); return true; } catch { return false; }
}

// --- プロジェクト（IndexedDB） --------------------------------------------

/** 保存用にメッシュを詰め直す（死んだ頂点 / 面を除去した状態で保存する） */
export function packMesh(mesh) {
  const remap = new Int32Array(mesh.nv).fill(-1);
  let n = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) remap[v] = n++;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const mask = new Float32Array(n);
  for (let v = 0; v < mesh.nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    positions[r * 3] = mesh.positions[v * 3];
    positions[r * 3 + 1] = mesh.positions[v * 3 + 1];
    positions[r * 3 + 2] = mesh.positions[v * 3 + 2];
    colors[r * 3] = mesh.colors[v * 3];
    colors[r * 3 + 1] = mesh.colors[v * 3 + 1];
    colors[r * 3 + 2] = mesh.colors[v * 3 + 2];
    mask[r] = mesh.mask[v];
  }
  const idx = new Uint32Array(mesh.liveTris * 3);
  let w = 0;
  const T = mesh.tris;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3;
    if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
    const a = remap[T[i]], b = remap[T[i + 1]], c = remap[T[i + 2]];
    if (a < 0 || b < 0 || c < 0) continue;
    idx[w++] = a; idx[w++] = b; idx[w++] = c;
  }
  return {
    positions, colors, mask,
    indices: idx.subarray(0, w),
    verts: n, tris: w / 3,
  };
}

export function projectBytes(p) {
  return p.positions.byteLength + p.colors.byteLength + p.mask.byteLength + p.indices.byteLength;
}

/**
 * プロジェクトを保存する。
 * @param {string} name スロット名
 * @param {SculptMesh} mesh
 * @param {object} state 設定（一緒に保存して復元時に戻す）
 */
/**
 * サブツールを 1 つぶんレコードへ詰める形にして返す。
 * subarray のままだと構造化複製で親バッファ全体が複製されるので実体化する。
 */
function packSubTool(t) {
  const p = packMesh(t.mesh);
  return {
    name: t.name, visible: t.visible !== false,
    verts: p.verts, tris: p.tris,
    positions: p.positions, colors: p.colors, mask: p.mask,
    indices: new Uint32Array(p.indices),
  };
}

/**
 * プロジェクトを保存する。
 * @param {string} name スロット名
 * @param {SculptMesh|object} mesh 単一メッシュ、または { list, active } のサブツール集合
 * @param {object} state 設定（一緒に保存して復元時に戻す）
 */
export async function saveProject(name, mesh, state) {
  // サブツール集合が渡されたら全部を保存する。
  // 1 つめは旧形式のフィールドにも入れておく（古い版で開いても最低限読める）。
  const set = mesh && Array.isArray(mesh.list) ? mesh : null;
  const p = packMesh(set ? set.list[set.active || 0].mesh : mesh);
  // subarray のままだと構造化複製で親バッファ全体が複製されるので実体化する
  const rec = {
    name,
    updated: Date.now(),
    verts: p.verts,
    tris: p.tris,
    positions: p.positions,
    colors: p.colors,
    mask: p.mask,
    indices: new Uint32Array(p.indices),
    // サブツール版のデータ。無ければ単一メッシュとして読まれる
    subtools: set ? set.list.map(packSubTool) : null,
    activeSubtool: set ? (set.active || 0) : 0,
    settings: (() => {
      const o = {};
      for (const k of SETTING_KEYS) if (state[k] !== undefined) {
        o[k] = (k === 'symmetry' || k === 'paintColor') ? JSON.parse(JSON.stringify(state[k])) : state[k];
      }
      return o;
    })(),
  };
  await tx('readwrite', (s) => { s.put(rec); });
  return { name, verts: p.verts, tris: p.tris, bytes: projectBytes(p) };
}

export async function loadProject(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listProjects() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const out = (req.result || []).map(r => ({
        name: r.name,
        updated: r.updated,
        verts: r.verts,
        tris: r.tris,
        subtools: r.subtools ? r.subtools.length : 1,
        bytes: r.subtools
          ? r.subtools.reduce((acc, t) => acc
            + (t.positions ? t.positions.byteLength : 0)
            + (t.colors ? t.colors.byteLength : 0)
            + (t.mask ? t.mask.byteLength : 0)
            + (t.indices ? t.indices.byteLength : 0), 0)
          : (r.positions ? r.positions.byteLength : 0)
            + (r.colors ? r.colors.byteLength : 0)
            + (r.mask ? r.mask.byteLength : 0)
            + (r.indices ? r.indices.byteLength : 0),
        auto: r.name === AUTOSAVE_NAME,
      }));
      out.sort((a, b) => b.updated - a.updated);
      resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteProject(name) {
  await tx('readwrite', (s) => { s.delete(name); });
}

export async function saveAutosave(mesh, state) {
  return saveProject(AUTOSAVE_NAME, mesh, state);
}
export async function loadAutosave() {
  return loadProject(AUTOSAVE_NAME);
}
export async function clearAutosave() {
  return deleteProject(AUTOSAVE_NAME);
}
export const AUTOSAVE = AUTOSAVE_NAME;

/** 保存容量の見積り（対応環境のみ） */
export async function estimateUsage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch { /* ignore */ }
  return null;
}
