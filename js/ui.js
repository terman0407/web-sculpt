// ---------------------------------------------------------------------------
// ui.js - DOM パネルの構築。state を直接読み書きし、必要な時だけ app にコールバック。
// ---------------------------------------------------------------------------

import { BRUSHES, falloff } from './brushes.js';
import { MATERIALS, materialThumb } from './matcap.js';
import { clamp } from './math.js';
import { DEFORMS } from './deform.js';
import { MASK_OPS } from './masktools.js';
import { GROUP_METHODS } from './polygroups.js';
import { ALPHAS, ALPHA_SIZE, alphaData, STROKES } from './alpha.js';
import { buildHelp, HELP_SOURCES } from './help.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

export function srgbHexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

export function linearToSrgbHex(c) {
  const f = (v) => {
    v = clamp(v, 0, 1);
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(s * 255);
  };
  return '#' + [f(c[0]), f(c[1]), f(c[2])].map(v => v.toString(16).padStart(2, '0')).join('');
}

// --- 汎用コントロール -------------------------------------------------------

function section(parent, title, collapsed = false) {
  const s = el('div', 'section' + (collapsed ? ' collapsed' : ''), parent);
  const h = el('button', 'sec-head', s);
  h.innerHTML = `<span class="chev">▾</span><span>${title}</span>`;
  const body = el('div', 'sec-body', s);
  h.onclick = () => s.classList.toggle('collapsed');
  return body;
}

function slider(parent, opt) {
  const row = el('div', 'ctl slider', parent);
  const top = el('div', 'ctl-top', row);
  el('label', null, top).textContent = opt.label;
  const val = el('span', 'val', top);
  const input = el('input', null, row);
  input.type = 'range';
  input.min = opt.min; input.max = opt.max; input.step = opt.step;
  input.value = opt.value;
  const fmt = opt.fmt || ((v) => v.toFixed(2));
  const sync = () => { val.textContent = fmt(parseFloat(input.value)); };
  input.addEventListener('input', () => { sync(); opt.onInput(parseFloat(input.value)); });
  sync();
  if (opt.title) row.title = opt.title;
  return {
    set(v) { input.value = v; sync(); },
    get() { return parseFloat(input.value); },
    el: row,
  };
}

function toggle(parent, opt) {
  const row = el('button', 'ctl toggle' + (opt.value ? ' on' : ''), parent);
  row.innerHTML = `<span class="box"></span><span class="tlabel">${opt.label}</span>`;
  if (opt.title) row.title = opt.title;
  row.onclick = () => {
    const on = !row.classList.contains('on');
    row.classList.toggle('on', on);
    opt.onChange(on);
  };
  return { set(v) { row.classList.toggle('on', !!v); }, el: row };
}

function btnRow(parent, items) {
  const row = el('div', 'btnrow', parent);
  const made = [];
  for (const it of items) {
    const b = el('button', 'btn' + (it.cls ? ' ' + it.cls : ''), row);
    b.textContent = it.label;
    if (it.title) b.title = it.title;
    b.onclick = it.onClick;
    made.push(b);
  }
  return { row, buttons: made };
}

function segmented(parent, items, value, onChange) {
  const row = el('div', 'segmented', parent);
  const btns = [];
  items.forEach((it) => {
    const b = el('button', 'seg' + (it.value === value ? ' on' : ''), row);
    b.textContent = it.label;
    if (it.title) b.title = it.title;
    b.onclick = () => {
      btns.forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onChange(it.value);
    };
    btns.push(b);
  });
  return { el: row, set(v) { btns.forEach((b, i) => b.classList.toggle('on', items[i].value === v)); } };
}

/**
 * 行を差し替えて使うリスト。スカルプトレイヤーとポリグループで共用する。
 * items は [{ id, label, num, color, visible, selected }]。
 * 毎回全部作り直す（数十行しかないので差分更新の複雑さに見合わない）。
 */
function listBox(parent, opt) {
  const box = el('div', 'listbox', parent);
  box.dataset.empty = opt.empty || '（なし）';
  let editing = -1;
  const render = (items) => {
    box.textContent = '';
    for (const it of items) {
      const row = el('div', 'lrow' + (it.selected ? ' on' : ''), box);
      if (it.color) {
        const sw = el('span', 'swatch', row);
        sw.style.background = `rgb(${it.color.map(c => Math.round(clamp(c, 0, 1) * 255)).join(',')})`;
      }
      if (editing === it.id && opt.onRename) {
        const inp = el('input', 'lname-edit', row);
        inp.value = it.label;
        const done = (commit) => {
          editing = -1;
          if (commit && inp.value.trim()) opt.onRename(it.id, inp.value.trim());
          else opt.refresh();
        };
        inp.onblur = () => done(true);
        inp.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); done(true); }
          if (e.key === 'Escape') { e.preventDefault(); done(false); }
          e.stopPropagation();
        };
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      } else {
        const name = el('span', 'lname', row);
        name.textContent = it.label;
        if (opt.onRename) {
          name.title = 'ダブルクリックで名前を変更';
          name.ondblclick = (e) => { e.stopPropagation(); editing = it.id; opt.refresh(); };
        }
      }
      if (it.num !== undefined && it.num !== null) {
        el('span', 'lnum', row).textContent = it.num;
      }
      if (opt.onToggle) {
        const eye = el('button', 'eye' + (it.visible ? '' : ' off'), row);
        eye.textContent = it.visible ? '◉' : '○';
        eye.title = '表示 / 非表示';
        eye.onclick = (e) => { e.stopPropagation(); opt.onToggle(it.id, !it.visible); };
      }
      row.onclick = () => { if (opt.onSelect) opt.onSelect(it.id); };
    }
  };
  return { el: box, render, cancelEdit() { editing = -1; } };
}

/** 小さいボタンを横並びにする（リストの下の追加・削除など） */
function iconRow(parent, items) {
  const row = el('div', 'iconrow', parent);
  const made = new Map();
  for (const it of items) {
    const b = el('button', 'ibtn', row);
    b.textContent = it.label;
    if (it.title) b.title = it.title;
    b.onclick = it.onClick;
    made.set(it.id || it.label, b);
  }
  return { el: row, buttons: made, enable(id, on) { const b = made.get(id); if (b) b.disabled = !on; } };
}

/**
 * アルファのサムネイル。alphaData は 0..1 の Float32Array なので
 * そのままグレースケールとして描く（matcap.js の materialThumb と同じ方式）。
 */
function alphaThumb(id, size = 40) {
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = alphaData(id);
  const N = ALPHA_SIZE;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(N - 1, Math.floor((y + 0.5) / size * N));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(N - 1, Math.floor((x + 0.5) / size * N));
      const a = clamp(data[sy * N + sx], 0, 1);
      const g = Math.round(Math.pow(a, 1 / 2.2) * 255);
      const q = (y * size + x) * 4;
      img.data[q] = g; img.data[q + 1] = g; img.data[q + 2] = g; img.data[q + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** X / Y / Z の軸選択 */
function axisPicker(parent, value, onChange) {
  return segmented(parent, [
    { label: 'X', value: 0 }, { label: 'Y', value: 1 }, { label: 'Z', value: 2 },
  ], value, onChange);
}

/** セクション内の小見出し */
function subhead(parent, text) {
  el('div', 'subhead', parent).textContent = text;
  return parent;
}

// ---------------------------------------------------------------------------

export function buildUI(app) {
  const state = app.state;
  const brushList = document.getElementById('brushList');
  const right = document.getElementById('rightPanel');
  const meshBar = document.getElementById('meshBar');
  const statsEl = document.getElementById('stats');
  const toastEl = document.getElementById('toast');

  // --- 追加ツールのパネル用に持ち回る参照 --------------------------------
  // section() を作る順で参照が必要になるので、先に宣言しておく。
  let deformAxisSeg = null;
  let layerList = null, layerIcons = null, layerInt = null;
  let groupList = null, groupAngleSlider = null, groupViewToggle = null;
  let morphAmount = null, morphFactor = null, morphInfo = null;
  let clipModeSeg = null, transposeToggle = null;
  let alphaGrid = null, strokeSeg = null, strokeParamBox = null;
  let subtoolList = null, subtoolIcons = null, subtoolSolo = null, subtoolPrimSeg = null;
  let remeshTrisSlider = null, remeshQuadInfo = null;
  let subtoolPrim = 'sphere';
  let syncStrokeParams = () => {};

  /** 選択中のレイヤーに対して何かする。無ければ促す */
  const withLayer = (fn) => {
    const t = app.tools;
    const i = t.layers.recording;
    if (i < 0) { toast('先にレイヤーを選んでください'); return; }
    fn(i);
  };

  function refreshLayers() {
    if (!layerList) return;
    const t = app.tools;
    const rec = t.layers.recording;
    layerList.render(t.layers.list().map((L) => ({
      id: L.index, label: L.name, num: L.verts ? L.verts.toLocaleString() : '',
      visible: L.visible, selected: L.index === rec,
    })));
    const has = rec >= 0;
    layerIcons.enable('dup', has);
    layerIcons.enable('bake', has);
    layerIcons.enable('del', has);
    if (has) layerInt.set(t.layers.list()[rec].intensity);
    layerInt.el.style.opacity = has ? '' : '.45';
  }

  function refreshGroups() {
    if (!groupList || !app.tools) return;
    const t = app.tools;
    const mesh = t.mesh;
    if (!mesh) return;
    t.groups.sync(mesh);
    const sizes = t.groups.groupSizes(mesh);
    // 「グループごとに可視面があるか」を三角形 1 周で数える。
    // グループ数 × 面数 で回すと 300 万面 × 数十グループになるので必ず 1 パスで。
    const vis = new Int32Array(sizes.length);
    const groups = t.groups.groupsOf(mesh);
    const T = mesh.tris;
    for (let tri = 0; tri < mesh.nt; tri++) {
      const i = tri * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
      if (!t.groups.isVisible(tri)) continue;
      const g = groups[tri];
      if (g >= 0 && g < vis.length) vis[g]++;
    }
    const rows = [];
    for (let g = 0; g < sizes.length; g++) {
      if (sizes[g] === 0) continue;
      rows.push({
        id: g, label: `グループ ${g + 1}`, num: sizes[g].toLocaleString(),
        color: t.groups.groupColor(g), visible: vis[g] > 0, selected: false,
      });
    }
    groupList.render(rows);
  }

  function refreshSubtools() {
    if (!subtoolList || !app.subtools) return;
    const set = app.subtools;
    subtoolList.render(set.info().map((t) => ({
      id: t.index, label: t.name,
      num: t.tris.toLocaleString() + ' 面',
      visible: t.visible, selected: t.active,
    })));
    const many = set.count > 1;
    subtoolIcons.enable('del', many);
    subtoolIcons.enable('up', many);
    subtoolIcons.enable('down', many);
    if (subtoolSolo) subtoolSolo.set(set.solo);
  }

  function refreshMorph() {
    if (!morphInfo) return;
    const t = app.tools;
    if (!t.morph.has) { morphInfo.textContent = 'モーフターゲットは未記憶です。'; return; }
    const d = t.morphDiff();
    if (!d || !d.valid) { morphInfo.textContent = 'モーフターゲットはトポロジ変更で無効になりました。'; return; }
    morphInfo.textContent = `記憶済み: ${d.changed.toLocaleString()} / ${d.verts.toLocaleString()} 頂点が変化`
      + `（最大 ${d.maxDist.toFixed(4)} / 平均 ${d.avgChanged.toFixed(4)}）`;
  }


  // --- 左：ブラシパレット ------------------------------------------------
  const brushBtns = new Map();
  BRUSHES.forEach((b, i) => {
    const btn = el('button', 'brush' + (b.id === state.brush ? ' on' : ''), brushList);
    btn.innerHTML = `<span class="bi">${b.icon}</span><span class="bn">${b.short || b.jp}</span>`;
    btn.title = `${b.name} / ${b.jp}  (${i + 1 <= 10 ? (i + 1) % 10 : '-'})\n${b.hint}`;
    btn.onclick = () => setBrush(b.id);
    brushBtns.set(b.id, btn);
  });
  function setBrush(id) {
    state.brush = id;
    brushBtns.forEach((btn, key) => btn.classList.toggle('on', key === id));
    const b = BRUSHES.find(x => x.id === id);
    if (b) toast(`${b.jp} — ${b.hint}`);
    if (paintRow) paintRow.style.display = (id === 'paint') ? '' : 'none';
  }

  // --- 上：メッシュ操作 --------------------------------------------------
  const meshes = [
    ['sphere', '球'], ['sphereHi', '球(高)'], ['quadball', 'クアッド球'],
    ['cube', '立方体'], ['cylinder', '円柱'], ['torus', 'トーラス'], ['plane', '平面'],
  ];
  const sel = el('select', 'mesh-select', meshBar);
  meshes.forEach(([v, l]) => {
    const o = el('option', null, sel);
    o.value = v; o.textContent = l;
  });
  sel.value = 'sphere';
  sel.title = '新しいベースメッシュ';
  sel.onchange = () => app.newMesh(sel.value);

  btnRow(meshBar, [
    { label: '↺ 元に戻す', title: 'Ctrl+Z', onClick: () => app.undo() },
    { label: '↻ やり直し', title: 'Ctrl+Shift+Z', onClick: () => app.redo() },
  ]);
  btnRow(meshBar, [
    { label: '読み込み', title: 'OBJ / STL を読み込む', onClick: () => app.importMesh() },
    { label: 'OBJ', title: 'OBJ で書き出し（頂点カラー付き）', onClick: () => app.exportFile('obj') },
    { label: 'PLY', title: 'PLY で書き出し（ポリペイント保持）', onClick: () => app.exportFile('ply') },
    { label: 'STL', title: 'STL で書き出し（3D プリント向け）', onClick: () => app.exportFile('stl') },
  ]);
  // --- 使い方ページ -------------------------------------------------------
  // 中身はツールの表から生成される（js/help.js）。キー操作は main.js の
  // SHORTCUTS をそのまま読むので、キーを増やしてもここは触らなくてよい。
  const help = buildHelp(document.getElementById('help'), {
    shortcuts: app.shortcuts ? app.shortcuts() : [],
  });
  btnRow(meshBar, [
    { label: '? 使い方', cls: 'wide', title: 'ツールの使い方とキー操作 (F1)',
      onClick: () => help.toggle() },
  ]);

  // --- 右：ブラシ設定 ---------------------------------------------------
  const bs = section(right, 'ブラシ');
  const sRadius = slider(bs, {
    label: '半径 (画面px)', min: 6, max: 400, step: 1, value: state.radiusPx,
    fmt: v => v.toFixed(0), title: '[ / ] キーで変更',
    onInput: v => { state.radiusPx = v; },
  });
  const sStrength = slider(bs, {
    label: '強さ', min: 0.01, max: 1, step: 0.01, value: state.strength,
    title: ', / . キーで変更',
    onInput: v => { state.strength = v; },
  });

  // --- 減衰カーブ（フォーカルシフト）+ プレビュー -----------------------
  const fRow = el('div', 'ctl', bs);
  const fTop = el('div', 'ctl-top', fRow);
  el('label', null, fTop).textContent = 'フォーカルシフト';
  const fVal = el('span', 'val', fTop);
  const fWrap = el('div', 'falloff-wrap', fRow);
  const fCanvas = el('canvas', 'falloff', fWrap);
  fCanvas.width = 236; fCanvas.height = 52;
  const fInput = el('input', null, fRow);
  fInput.type = 'range'; fInput.min = -100; fInput.max = 100; fInput.step = 1;
  fInput.value = Math.round(state.focalShift * 100);
  fRow.title = '＋で中心が平らになり当たりが硬く、−で柔らかくなる（ZBrush の Focal Shift）';

  function drawFalloff() {
    const ctx = fCanvas.getContext('2d');
    const W = fCanvas.width, H = fCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#2b303a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      const x = (W - 1) * k / 4 + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    ctx.stroke();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(217,116,75,0.35)');
    grad.addColorStop(1, 'rgba(217,116,75,0.02)');
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      const y = H - 1 - falloff(t, state.focalShift) * (H - 3);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W - 1, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      const y = H - 1 - falloff(t, state.focalShift) * (H - 3);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#f0925f';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  const syncFocal = () => {
    const v = parseInt(fInput.value, 10);
    state.focalShift = v / 100;
    fVal.textContent = (v > 0 ? '+' : '') + v;
    drawFalloff();
  };
  fInput.addEventListener('input', syncFocal);
  syncFocal();

  // --- レイジーマウス / 筆圧 --------------------------------------------
  const sLazy = slider(bs, {
    label: 'レイジーマウス', min: 0, max: 120, step: 1, value: state.lazyRadius,
    fmt: v => (v < 0.5 ? 'オフ' : v.toFixed(0) + ' px'),
    title: 'カーソルから遅れて追従させ、手ぶれを取る（L キーで切り替え）',
    onInput: v => { state.lazyRadius = v; },
  });
  const tBackface = toggle(bs, {
    label: 'バックフェイスマスク', value: state.backfaceMask,
    title: '視点から見て裏を向いた面を彫らない（B キー）',
    onChange: v => { state.backfaceMask = v; },
  });
  const tPressure = toggle(bs, {
    label: '筆圧を使う（ペン）', value: state.usePressure,
    title: 'ペンタブレットの筆圧を半径と強さに反映する',
    onChange: v => { state.usePressure = v; },
  });
  slider(bs, {
    label: 'ダブ間隔', min: 0.02, max: 0.25, step: 0.01, value: state.dabSpacing,
    title: '小さいほど滑らか（点が並んだ感じが減る）。1 ダブの強さは自動で補正される',
    onInput: v => { state.dabSpacing = v; },
  });

  const paintRow = el('div', 'ctl', bs);
  {
    const top = el('div', 'ctl-top', paintRow);
    el('label', null, top).textContent = 'ペイント色';
    const ci = el('input', 'color', paintRow);
    ci.type = 'color';
    ci.value = linearToSrgbHex(state.paintColor);
    ci.oninput = () => { state.paintColor = srgbHexToLinear(ci.value); };
    const sw = el('div', 'swatches', paintRow);
    ['#d8d3c8', '#c8503c', '#e0a060', '#6f9f5a', '#4e7fa8', '#8a6fa8', '#2a2a2e', '#f2efe6']
      .forEach(hex => {
        const b = el('button', 'sw', sw);
        b.style.background = hex;
        b.onclick = () => { ci.value = hex; state.paintColor = srgbHexToLinear(hex); };
      });
    const fill = el('button', 'btn wide', paintRow);
    fill.textContent = '全体を塗る（マスク考慮）';
    fill.onclick = () => app.fillColor();
    paintRow.style.display = state.brush === 'paint' ? '' : 'none';
  }

  // --- シンメトリ -------------------------------------------------------
  const sy = section(right, 'シンメトリ');
  const symRow = el('div', 'btnrow', sy);
  const symBtns = {};
  for (const ax of ['x', 'y', 'z']) {
    const b = el('button', 'btn sym' + (state.symmetry[ax] ? ' on' : ''), symRow);
    b.textContent = ax.toUpperCase();
    b.title = `${ax.toUpperCase()} 軸ミラー` + (ax === 'x' ? '（X キー）' : '');
    b.onclick = () => {
      state.symmetry[ax] = !state.symmetry[ax];
      b.classList.toggle('on', state.symmetry[ax]);
    };
    symBtns[ax] = b;
  }

  // --- トポロジ ---------------------------------------------------------
  const tp = section(right, '動的トポロジ');
  const tDyn = toggle(tp, {
    label: 'ダイナミックトポロジ', value: state.dynTopo,
    title: 'ストローク中に自動で再分割する（G キー）',
    onChange: v => { state.dynTopo = v; },
  });
  toggle(tp, {
    label: '間引き（デシメート）', value: state.decimate,
    title: '短くなった辺を統合してポリゴンを節約する',
    onChange: v => { state.decimate = v; },
  });
  const sDetail = slider(tp, {
    label: 'ディテール', min: 0, max: 1, step: 0.01, value: state.detail,
    title: 'ブラシ直径あたりの分割数。大きいほど細かい',
    onInput: v => { state.detail = v; },
  });
  el('p', 'note', tp).textContent =
    '目標ポリゴン密度はブラシの大きさに比例します。細部を作るときはブラシを小さくする（またはズームする）と自動的に分割されます。';
  slider(tp, {
    label: '最大頂点数', min: 100000, max: 2000000, step: 50000, value: state.maxVerts,
    fmt: v => (v / 1000).toFixed(0) + 'k',
    onInput: v => { state.maxVerts = v; },
  });
  btnRow(tp, [
    { label: '辺の長さを均一化', title: '現在の平均エッジ長で全体を均一化（トポロジは組み替えない）', onClick: () => app.remesh() },
    { label: '全体スムーズ', title: '全体を 1 回平滑化', onClick: () => app.smoothAll() },
  ]);

  // --- 分割レベル（SDiv） -----------------------------------------------
  const sd = section(right, '分割レベル');
  const lvlLabel = el('div', 'lvl', sd);
  btnRow(sd, [
    { label: '◀ 下げる', title: 'PageDown', onClick: () => app.levelDown() },
    { label: '上げる ▶', title: 'PageUp', onClick: () => app.levelUp() },
  ]);
  const divBtn = el('button', 'btn wide primary', sd);
  divBtn.textContent = '分割する（Divide）';
  divBtn.title = '全辺を中点分割してポリゴンを 4 倍にし、1 段上のレベルを作る';
  divBtn.onclick = () => app.divide();
  el('p', 'note', sd).textContent =
    '低いレベルで大きな形を整え、高いレベルで細部を彫る使い方ができます。'
    + '下げたレベルで形を変えると、上のレベルの細部が保存された変位として追従します。'
    + '動的トポロジやダイナメッシュで接続が変わるとレベルは破棄されます。';
  function refreshLevels() {
    const L = app.sculptorRef ? app.sculptorRef().levels : null;
    if (!L || L.count === 0) {
      lvlLabel.textContent = 'レベル 1 / 1（未分割）';
      lvlLabel.classList.remove('on');
      return;
    }
    lvlLabel.textContent = `レベル ${L.level + 1} / ${L.count + 1}`;
    lvlLabel.classList.toggle('on', L.count > 0);
  }

  // --- ダイナメッシュ ---------------------------------------------------
  const dm = section(right, 'ダイナメッシュ');
  const sDynaRes = slider(dm, {
    label: '解像度', min: 24, max: 320, step: 4, value: state.dynaResolution,
    fmt: v => v.toFixed(0),
    title: 'モデルの最長辺方向のボクセル数。大きいほど細かく、遅くなる',
    onInput: v => { state.dynaResolution = v; },
  });
  slider(dm, {
    label: '仕上げスムーズ', min: 0, max: 4, step: 1, value: state.dynaSmooth,
    fmt: v => v.toFixed(0),
    title: 'Taubin スムージングの反復回数（体積は保たれる）',
    onInput: v => { state.dynaSmooth = v; },
  });
  toggle(dm, {
    label: 'ポリペイントを転写', value: state.dynaTransferColor,
    title: '最近傍の面から頂点カラーを引き継ぐ',
    onChange: v => { state.dynaTransferColor = v; },
  });
  const dmBtn = el('button', 'btn wide primary', dm);
  dmBtn.textContent = 'ダイナメッシュ実行  (D)';
  dmBtn.title = 'ボクセル化してトポロジを作り直す';
  dmBtn.onclick = () => app.dynamesh();
  el('p', 'note', dm).textContent =
    'メッシュ全体をボクセル化して均一なトポロジに作り直します。'
    + 'めり込ませた形状や分離した部品は和集合として結合され、自己交差も解消されます。'
    + 'ラフに形を出す → ダイナメッシュ → 彫り込む、を繰り返すのが基本の流れです。';

  // --- マスク -----------------------------------------------------------
  const mk = section(right, 'マスク');
  btnRow(mk, [
    { label: 'クリア', onClick: () => app.clearMask() },
    { label: '反転', onClick: () => app.invertMask() },
  ]);
  el('p', 'note', mk).textContent = 'Ctrl+ドラッグでマスクを塗る / Ctrl+Alt+ドラッグで消す。マスク部分は彫刻されません。';

  // --- サブツール ---------------------------------------------------------
  // ZBrush の SubTool 相当。1 つのシーンに独立したメッシュを複数置き、
  // 編集できるのはアクティブな 1 つだけ。
  const su = section(right, 'サブツール');
  {
    subtoolList = listBox(su, {
      empty: '（サブツールなし）',
      refresh: () => refreshSubtools(),
      onSelect: (i) => app.subtoolSelect(i),
      onToggle: (i, on) => app.subtoolSetVisible(i, on),
      onRename: (i, name) => app.subtoolRename(i, name),
    });
    subtoolIcons = iconRow(su, [
      { id: 'add', label: '＋', title: 'サブツールを追加（球）', onClick: () => app.subtoolAdd(subtoolPrim) },
      { id: 'dup', label: '複製', title: 'アクティブなサブツールを複製', onClick: () => app.subtoolDuplicate() },
      { id: 'up', label: '↑', title: '順番を上へ', onClick: () => app.subtoolMove(app.subtools.active, -1) },
      { id: 'down', label: '↓', title: '順番を下へ', onClick: () => app.subtoolMove(app.subtools.active, 1) },
      { id: 'del', label: '削除', title: 'アクティブなサブツールを削除', onClick: () => app.subtoolRemove() },
    ]);
    el('div', 'subhead', su).textContent = '追加する形';
    subtoolPrimSeg = segmented(su, [
      { label: '球', value: 'sphere' }, { label: '箱', value: 'cube' },
      { label: '円柱', value: 'cylinder' }, { label: 'トーラス', value: 'torus' },
    ], 'sphere', (v) => { subtoolPrim = v; });

    subtoolSolo = toggle(su, {
      label: 'ソロ表示', value: false,
      title: 'アクティブなサブツールだけを表示する（ZBrush の Solo）',
      onChange: (on) => app.subtoolSetSolo(on),
    });

    el('div', 'subhead', su).textContent = 'まとめる / 分ける';
    btnRow(su, [
      { label: 'まとめる', title: '表示中のサブツールを 1 つに結合する（ダイナメッシュを掛けると和になる）', onClick: () => app.subtoolMerge() },
    ]);
    btnRow(su, [
      { label: '塊で分ける', title: '離れている塊ごとに別のサブツールへ分ける', onClick: () => app.subtoolSplitParts() },
      { label: 'マスクで分ける', title: 'マスクした部分を別のサブツールへ切り出す', onClick: () => app.subtoolSplitMasked() },
    ]);
    btnRow(su, [
      { label: '全体表示', cls: 'wide', title: '全サブツールが収まるように視点を合わせる', onClick: () => app.frameAll() },
    ]);
    el('p', 'note', su).textContent =
      '彫刻できるのはアクティブな 1 つだけです。行をクリックで切り替え、'
      + '目のアイコンで表示切替、名前をダブルクリックで変更できます。'
      + '別々のサブツールを重ねて「まとめる」→「ダイナメッシュ」で 1 つの形に融合できます。';
  }

  // --- アルファ / ストローク ---------------------------------------------
  // ZBrush の Alpha パレットと Stroke パレット相当。
  const al = section(right, 'アルファ / ストローク', true);
  {
    el('div', 'subhead', al).textContent = 'ブラシアルファ（断面形状）';
    const grid = el('div', 'alphagrid', al);
    const alphaBtns = new Map();
    const mkAlpha = (id, label, title) => {
      const b = el('button', 'alpha' + (state.alpha === id ? ' on' : ''), grid);
      b.title = title;
      if (id === '') {
        // 「なし」は文字で示す（サムネイルを作る意味がない）
        b.textContent = '—';
        b.style.color = 'var(--text-dim)';
        b.style.fontSize = '15px';
      } else {
        b.appendChild(alphaThumb(id, 40));
      }
      b.onclick = () => {
        state.alpha = id;
        alphaBtns.forEach((x, k) => x.classList.toggle('on', k === id));
      };
      alphaBtns.set(id, b);
    };
    mkAlpha('', 'なし', 'アルファを使わない（通常の丸い当たり）');
    for (const a of ALPHAS) mkAlpha(a.id, a.jp, `${a.jp} — ${a.hint}`);
    alphaGrid = { btns: alphaBtns };
    toggle(al, {
      label: 'ストローク方向に合わせる', value: state.alphaAlign,
      title: 'アルファの向きをドラッグ方向に合わせる（ZBrush の Align to Stroke）',
      onChange: (on) => { state.alphaAlign = on; },
    });

    el('div', 'subhead', al).textContent = 'ストロークタイプ';
    strokeSeg = segmented(al, STROKES.map((s) => ({
      label: s.jp, value: s.id, title: s.hint,
    })), state.stroke, (v) => { state.stroke = v; syncStrokeParams(); });

    // ストロークごとのパラメータ。選んだものだけ出す
    strokeParamBox = el('div', 'ctl-group', al);
    syncStrokeParams = () => {
      strokeParamBox.textContent = '';
      const meta = STROKES.find((s) => s.id === state.stroke);
      if (!meta || !meta.params || meta.params.length === 0) {
        strokeParamBox.style.display = 'none';
        return;
      }
      strokeParamBox.style.display = '';
      const o = state.strokeParams[state.stroke];
      const RANGE = {
        spacing: { min: 0.02, max: 0.6, step: 0.01, jp: 'ダブ間隔' },
        scatter: { min: 0, max: 2, step: 0.05, jp: '散らし' },
        sizeJitter: { min: 0, max: 1, step: 0.05, jp: 'サイズのゆらぎ' },
        colorJitter: { min: 0, max: 1, step: 0.05, jp: '色のゆらぎ' },
      };
      for (const key of meta.params) {
        const r = RANGE[key];
        if (!r) continue;
        slider(strokeParamBox, {
          label: r.jp, min: r.min, max: r.max, step: r.step, value: o[key],
          title: meta.hint,
          onInput: (v) => { o[key] = v; },
        });
      }
      toggle(strokeParamBox, {
        label: 'ダブごとに回す', value: !!o.spin,
        title: 'アルファの向きをダブごとにランダムに回す（同じストロークなら同じ結果）',
        onChange: (on) => { o.spin = on; },
      });
    };
    syncStrokeParams();

    el('p', 'note', al).textContent =
      'アルファはブラシの断面形状です。鱗・ひび・布目などをスタンプのように押せます。'
      + 'スプレーは同じストロークなら必ず同じ模様になるので、Undo してやり直しても結果が変わりません。';
  }

  // --- デフォーメーション -----------------------------------------------
  // ZBrush の Deformation パレット相当。スライダーは値を決めるだけで、
  // 「適用」を押した瞬間に 1 回だけ効く破壊的操作（Undo で戻す）。
  // onInput で毎回掛けるとドラッグ中に何十回も適用されてしまう。
  const df = section(right, 'デフォーム', true);
  {
    const axisRow = el('div', null, df);
    el('div', 'subhead', axisRow).textContent = '軸';
    const axisSeg = axisPicker(axisRow, state.deform.axis, (v) => { state.deform.axis = v; });
    deformAxisSeg = axisSeg;
    for (const d of DEFORMS) {
      const box = el('div', 'ctl-group', df);
      const head = el('div', 'subhead', box);
      head.textContent = `${d.jp}　${d.name}`;
      head.title = d.hint;
      const o = state.deform.params[d.id];
      for (const q of (d.params || [])) {
        slider(box, {
          label: q.jp, min: q.min, max: q.max, step: q.step, value: o[q.key],
          title: d.hint,
          fmt: (v) => (q.step >= 1 ? String(Math.round(v)) : v.toFixed(2)),
          onInput: (v) => { o[q.key] = v; },
        });
      }
      btnRow(box, [{
        label: '適用', cls: d.axis ? '' : 'wide',
        title: d.hint + (d.axis ? '' : '（軸は使いません）'),
        onClick: () => app.tools.applyDeform(d.id),
      }]);
      if (!d.axis) box.dataset.noaxis = '1';
    }
    el('p', 'note', df).textContent =
      '選んだ軸に沿ってモデル全体を変形します。マスクした部分は保護されます。'
      + 'スライダーを 0 に戻しても形は戻りません（Undo で戻します）。'
      + '膨張・球化・ノイズ・スムーズは軸を使いません。';
  }

  // --- マスクツール -----------------------------------------------------
  const mkt = section(right, 'マスクツール', true);
  {
    el('div', 'subhead', mkt).textContent = '合成方法';
    segmented(mkt, [
      { label: '置換', value: 'replace', title: '既存のマスクを置き換える' },
      { label: '加算', value: 'add', title: '既存のマスクに足す' },
      { label: '減算', value: 'sub', title: '既存のマスクから引く' },
    ], state.mask.mode, (v) => { state.mask.mode = v; });

    for (const op of MASK_OPS) {
      const ps = (op.params || []).filter((q) => q.type === 'float' || q.type === 'int'
        || (q.min !== undefined && q.max !== undefined));
      if (ps.length === 0) continue;
      const box = el('div', 'ctl-group', mkt);
      const head = el('div', 'subhead', box);
      head.textContent = op.jp;
      head.title = op.hint;
      const o = state.mask.params[op.id];
      for (const q of ps) {
        slider(box, {
          label: q.jp, min: q.min, max: q.max, step: q.step || 1, value: o[q.key],
          title: op.hint,
          fmt: (v) => ((q.step || 1) >= 1 ? String(Math.round(v)) : v.toFixed(2)),
          onInput: (v) => { o[q.key] = v; },
        });
      }
      // 凹凸の選択があるものだけ（キャビティ）
      if ((op.params || []).some((q) => q.key === 'side')) {
        segmented(box, [
          { label: '溝', value: 'concave' }, { label: '稜線', value: 'convex' }, { label: '両方', value: 'both' },
        ], o.side, (v) => { o.side = v; });
      }
      btnRow(box, [{ label: '適用', cls: 'wide', title: op.hint, onClick: () => app.tools.applyMaskOp(op.id) }]);
    }
    // パラメータのない単純な操作はまとめてボタン列に
    const simple = MASK_OPS.filter((op) => (op.params || []).length === 0);
    if (simple.length) {
      el('div', 'subhead', mkt).textContent = '単純操作';
      btnRow(mkt, simple.map((op) => ({
        label: op.jp, title: op.hint, onClick: () => app.tools.applyMaskOp(op.id),
      })));
    }
    el('p', 'note', mkt).textContent =
      '色で選択は現在のペイント色を、法線で選択は現在の視線方向を基準にします。';
  }

  // --- スカルプトレイヤー -----------------------------------------------
  const ly = section(right, 'スカルプトレイヤー', true);
  {
    layerList = listBox(ly, {
      empty: '（レイヤーなし。「＋」で追加）',
      refresh: () => refreshLayers(),
      onSelect: (i) => app.tools.layerSelect(i),
      onToggle: (i, on) => app.tools.layerSetVisible(i, on),
      onRename: (i, name) => app.tools.layerRename(i, name),
    });
    layerIcons = iconRow(ly, [
      { id: 'add', label: '＋', title: 'レイヤーを追加して記録を始める', onClick: () => app.tools.layerAdd() },
      { id: 'dup', label: '複製', title: '選択中のレイヤーを複製', onClick: () => withLayer((i) => app.tools.layerDuplicate(i)) },
      { id: 'bake', label: '焼込', title: '選択中のレイヤーをベース形状へ焼き込む', onClick: () => withLayer((i) => app.tools.layerBake(i)) },
      { id: 'del', label: '削除', title: '選択中のレイヤーを削除', onClick: () => withLayer((i) => app.tools.layerRemove(i)) },
    ]);
    layerInt = slider(ly, {
      label: '強度', min: -1, max: 1, step: 0.01, value: 1,
      title: '選択中のレイヤーの効き（マイナスで反転）',
      onInput: (v) => withLayer((i) => app.tools.layerSetIntensity(i, v)),
    });
    layerInt.el.addEventListener('pointerup', () => withLayer((i) => app.tools.layerSetIntensity(i, layerInt.get(), true)));
    el('p', 'note', ly).textContent =
      '記録中のレイヤーに彫刻の差分が入り、強度を下げるとその彫刻だけ弱まります。'
      + 'トポロジが変わると使えないので、動的トポロジ・ダイナメッシュ・Divide とは併用できません。';
  }

  // --- ポリグループ / 部分表示 ------------------------------------------
  const pg = section(right, 'ポリグループ', true);
  {
    el('div', 'subhead', pg).textContent = 'グループを作る';
    btnRow(pg, GROUP_METHODS.map((g) => ({
      label: g.jp, title: g.hint, onClick: () => app.tools.groupAssign(g.id),
    })));
    groupAngleSlider = slider(pg, {
      label: '法線角のしきい値', min: 5, max: 90, step: 1, value: state.groupAngle,
      fmt: (v) => Math.round(v) + '°',
      title: '「法線角」でグループ分けするときの折れ目の角度',
      onInput: (v) => { state.groupAngle = v; },
    });
    groupViewToggle = toggle(pg, {
      label: 'グループ色で表示', value: state.groupView,
      title: 'ポリグループを色分けして表示（ポリペイントは一時的に隠れます）',
      onChange: (on) => app.tools.setGroupView(on),
    });
    el('div', 'subhead', pg).textContent = '表示 / 非表示';
    groupList = listBox(pg, {
      empty: '（グループなし）',
      refresh: () => refreshGroups(),
      onSelect: (i) => app.tools.groupVisibility('showGroupOnly', i),
      onToggle: (i, on) => app.tools.groupVisibility(on ? 'showGroup' : 'hideGroup', i),
    });
    btnRow(pg, [
      { label: '全表示', onClick: () => app.tools.groupVisibility('showAll') },
      { label: '反転', onClick: () => app.tools.groupVisibility('invertVisible') },
    ]);
    btnRow(pg, [
      { label: 'マスクを隠す', title: 'マスクした部分を非表示にする', onClick: () => app.tools.groupVisibility('hideMasked') },
      { label: 'マスクだけ', title: 'マスクした部分だけ表示する', onClick: () => app.tools.groupVisibility('showMaskedOnly') },
    ]);
    btnRow(pg, [
      { label: '広げる', onClick: () => app.tools.groupVisibility('growVisible', 1) },
      { label: '縮める', onClick: () => app.tools.groupVisibility('shrinkVisible', 1) },
    ]);
    el('p', 'note', pg).textContent =
      '非表示にした部分は描画とピッキングから外れるので、隠れた側を彫らずに済みます。'
      + 'トポロジが変わるとグループは作り直しになります。';
  }

  // --- モーフターゲット --------------------------------------------------
  const mo = section(right, 'モーフターゲット', true);
  {
    btnRow(mo, [
      { label: '記憶', cls: 'primary', title: 'いまの形をモーフターゲットとして記憶する', onClick: () => app.tools.morphStore() },
      { label: '入れ替え', title: '記憶した形といまの形を入れ替える（ZBrush の Switch）', onClick: () => app.tools.morphSwitch() },
    ]);
    morphAmount = slider(mo, {
      label: '戻す量', min: 0, max: 1, step: 0.01, value: 1,
      title: '記憶した形へどれだけ戻すか',
      onInput: () => {},
    });
    btnRow(mo, [{ label: '戻す', cls: 'wide', onClick: () => app.tools.morphRestore(morphAmount.get()) }]);
    morphFactor = slider(mo, {
      label: '差分の倍率', min: 0, max: 3, step: 0.05, value: 1,
      title: '記憶した形からの差分を何倍にするか（1 で変化なし、2 で強調）',
      onInput: () => {},
    });
    btnRow(mo, [{ label: '差分を増幅', cls: 'wide', onClick: () => app.tools.morphAmplify(morphFactor.get()) }]);
    morphInfo = el('p', 'note', mo);
    el('p', 'note', mo).textContent =
      '彫る前に記憶しておくと、あとで部分的に戻したりディテールを強調したりできます。'
      + 'モーフブラシ（左のパレット）で塗った所だけ戻すこともできます。';
  }

  // --- リメッシュ（ZRemesher 相当） ---------------------------------------
  const rm = section(right, 'リメッシュ', true);
  {
    remeshTrisSlider = slider(rm, {
      label: '目標ポリゴン数', min: 500, max: 300000, step: 500, value: state.remeshTris,
      fmt: (v) => (v >= 10000 ? (v / 1000).toFixed(0) + 'k' : String(Math.round(v))),
      title: 'この面数に近づくようエッジ長を逆算して均一化します（ZRemesher の Target Polygons Count 相当）',
      onInput: (v) => { state.remeshTris = v; },
    });
    slider(rm, {
      label: '曲率への追従', min: 0, max: 1, step: 0.05, value: state.remeshAdaptive,
      title: '上げると曲率の高い所を細かく、平らな所を粗くします（0 で完全に均一）',
      onInput: (v) => { state.remeshAdaptive = v; },
    });
    slider(rm, {
      label: '整え（緩和）', min: 0, max: 1, step: 0.05, value: state.remeshRelax,
      title: '三角形の形をそろえる強さ。上げるほど整うが、細部が丸まりやすくなる',
      onInput: (v) => { state.remeshRelax = v; },
    });
    slider(rm, {
      label: '反復回数', min: 1, max: 12, step: 1, value: state.remeshIterations,
      fmt: (v) => String(Math.round(v)),
      title: '多いほど整うが時間がかかる',
      onInput: (v) => { state.remeshIterations = v; },
    });
    toggle(rm, {
      label: '元の形へ投影して保つ', value: state.remeshProject,
      title: '整えたあと元の表面へ引き戻して形を維持します（切ると細部が丸まります）',
      onChange: (on) => { state.remeshProject = on; },
    });
    btnRow(rm, [
      { label: '現在の半分', title: 'いまの面数の半分を目標にする', onClick: () => {
        state.remeshTris = app.tools.suggestRemeshTris();
        remeshTrisSlider.set(state.remeshTris);
      } },
      { label: 'リメッシュ実行', cls: 'primary', onClick: () => app.remeshAdaptive() },
    ]);
    el('div', 'subhead', rm).textContent = '書き出し';
    toggle(rm, {
      label: 'OBJ を四角優勢で書き出す', value: state.exportQuads,
      title: '隣り合う三角形を対にして四角として書き出します（ZRemesher の出力に近い見た目になります）',
      onChange: (on) => { state.exportQuads = on; },
    });
    remeshQuadInfo = el('p', 'note', rm);
    btnRow(rm, [
      { label: '四角化率を調べる', cls: 'wide', onClick: () => {
        const q = app.tools.quadStats();
        remeshQuadInfo.textContent = `四角 ${q.quads.toLocaleString()} + 三角 ${q.tris.toLocaleString()}`
          + `（三角形の ${(q.ratio * 100).toFixed(1)}% が四角に入ります）`;
      } },
    ]);
    el('p', 'note', rm).textContent =
      'ダイナメッシュが「形を作り直す」のに対して、リメッシュは「形を保ったまま'
      + 'ポリゴンの配置だけを整える」操作です。分割 / 統合 / 辺の張り替え / 接線緩和を'
      + '反復し、毎回元の表面へ引き戻します。トポロジが変わるので分割レベル・'
      + 'レイヤー・モーフは破棄されます。';
  }

  // --- ポリゴンモデリング（編集モード）------------------------------------
  let editToggle = null, editModeSeg = null, editInfoEl = null;
  {
    const ed = section(right, 'ポリゴンモデリング', true);
    el('p', 'note', ed).textContent =
      '彫刻メッシュを四角化して、頂点 / 辺 / 面を選んで編集します。'
      + '入るときに四角化し、出るときに三角形化して戻します。'
      + '四角は彫刻すると消えるので「編集モードで組む → 彫刻へ移る」の順で使います。';
    editToggle = toggle(ed, {
      label: '編集モード', value: state.editMode,
      title: '四角化して編集モードに入ります（トランスポーズ / 平面カットとは同時に使えません）',
      onChange: (on) => app.setEditMode(on),
    });
    editInfoEl = el('p', 'note', ed);

    el('div', 'subhead', ed).textContent = '選択の単位';
    editModeSeg = segmented(ed, [
      { label: '頂点', value: 'vert', title: '頂点を選ぶ' },
      { label: '辺', value: 'edge', title: '辺を選ぶ' },
      { label: '面', value: 'face', title: '面を選ぶ' },
    ], state.editSelect, (v) => app.editSetSelectMode(v));
    el('p', 'note', ed).textContent =
      'ビューポートをクリックで選択、ドラッグで矩形選択。Shift で追加選択します。';

    el('div', 'subhead', ed).textContent = '選択';
    btnRow(ed, [
      { label: 'すべて', title: '全部選ぶ', onClick: () => app.tools.editSelect('all') },
      { label: '解除', title: '選択を外す', onClick: () => app.tools.editSelect('none') },
      { label: '反転', title: '選択を反転する', onClick: () => app.tools.editSelect('invert') },
    ]);
    btnRow(ed, [
      { label: '広げる', title: '隣を 1 段ぶん足す', onClick: () => app.tools.editSelect('grow') },
      { label: '縮める', title: '縁を 1 段ぶん外す', onClick: () => app.tools.editSelect('shrink') },
      { label: '繋がり', title: '繋がっている塊を全部選ぶ', onClick: () => app.tools.editSelect('linked') },
    ]);

    el('div', 'subhead', ed).textContent = 'ループ（辺モードで使います）';
    btnRow(ed, [
      { label: 'エッジループ', title: '選択した辺から、頂点を跨いで一列に伸びる辺を選びます（Blender の Alt+クリック）',
        onClick: () => app.tools.editModel('loopSelect') },
      { label: 'エッジリング', title: '選択した辺から、四角を跨いで向かい側へ渡る辺を選びます',
        onClick: () => app.tools.editModel('ringSelect') },
    ]);
    slider(ed, {
      label: 'ループカットの本数', min: 1, max: 10, step: 1, value: state.editCuts,
      fmt: v => v.toFixed(0) + ' 本',
      title: '1 本なら中点。2 本なら 1/3 と 2/3 の位置に入ります',
      onInput: (v) => { state.editCuts = v; },
    });
    btnRow(ed, [
      { label: 'ループカット', cls: 'wide',
        title: '選択した辺のエッジリングに沿って四角を割ります（Blender の Ctrl+R）',
        onClick: () => app.tools.editModel('loopCut') },
    ]);
    slider(ed, {
      label: 'ベベル量', min: 0.02, max: 0.49, step: 0.01, value: state.editBevel,
      title: '角を落とす幅。区間の重心へ寄せる割合',
      onInput: (v) => { state.editBevel = v; },
    });
    btnRow(ed, [
      { label: 'ベベル（面取り）', cls: 'wide',
        title: '選択した辺の角を落として帯を張ります（Blender の Ctrl+B）。'
          + '〔エッジループ〕で繋がった形に選んでから使ってください',
        onClick: () => app.tools.editModel('bevel') },
    ]);
    el('p', 'note', ed).textContent =
      'ベベルは辺が「通り抜ける」選択でだけ通ります。端が途切れる選択（辺が 1 本しか'
      + '集まらない頂点がある）は、帯の両側に別の頂点を割り当てられないので断ります。';

    el('div', 'subhead', ed).textContent = '面を増やす（面モードで使います）';
    slider(ed, {
      label: '押し出し量', min: -1, max: 1, step: 0.02, value: state.editExtrude,
      title: '法線方向に動かす量（モデルの大きさに対する割合）。0 でも押し出しは成立します',
      onInput: (v) => { state.editExtrude = v; },
    });
    btnRow(ed, [
      { label: '押し出し', cls: 'wide',
        title: '選択した面を複製して、縁に側面を張ります（Blender の E）',
        onClick: () => app.tools.editModel('extrude') },
    ]);
    slider(ed, {
      label: 'インセット量', min: 0.02, max: 0.9, step: 0.02, value: state.editInset,
      title: '重心へ寄せる割合',
      onInput: (v) => { state.editInset = v; },
    });
    btnRow(ed, [
      { label: 'インセット', title: '面の内側に一段小さい面を作ります（Blender の Shift+I 相当。面ごと）',
        onClick: () => app.tools.editModel('inset') },
      { label: '面を細分化', title: '選択した面を 4 分割します',
        onClick: () => app.tools.editModel('subdivide') },
    ]);
    el('p', 'note', ed).textContent =
      '押し出しとインセットのあとは新しくできた面が選択されたままなので、続けて押せます'
      + '（インセット → 内側へ押し出しで凹みになります）。';

    el('div', 'subhead', ed).textContent = '減らす / 直す';
    btnRow(ed, [
      { label: '面を削除', title: '選択した面を消します（使われなくなった頂点も消えます）',
        onClick: () => app.tools.editApply('delete') },
      { label: '辺を溶解', title: '選択した辺を消して両側の 2 面を 1 面にまとめます',
        onClick: () => app.tools.editApply('dissolve') },
    ]);
    btnRow(ed, [
      { label: '面の向きを反転', cls: 'wide', title: '選択した面の裏表を入れ替えます',
        onClick: () => app.tools.editApply('flip') },
    ]);
    el('p', 'note', ed).textContent =
      '選択した頂点を動かすには、〔トランスポーズ〕ではなくこの下の〔選択を動かす〕を使います。';
    btnRow(ed, [
      { label: '選択を動かす（ギズモ）', cls: 'wide primary',
        title: '選択した頂点にギズモを立てて、移動・回転・拡大縮小します',
        onClick: () => app.editGizmo() },
    ]);
  }

  // --- 仕上げレンダリング（BPR 相当）------------------------------------
  //
  // プレビューは 1x で描く（実測 13ms 程度）。設定を動かすたびに描き直せる
  // 速さなので、スライダーを掴んだまま光の向きを回して見られる。
  // 保存だけは指定倍率で描き直す。
  const rpv = document.getElementById('rpv');
  const rpvImg = document.getElementById('rpvImg');
  const rpvInfo = document.getElementById('rpvInfo');
  let rpvUrl = null;
  let rpvPending = false, rpvQueued = false;

  const rpvIsOpen = () => rpv.classList.contains('show');
  /**
   * プレビューを描き直す。描画中に呼ばれたら 1 回だけ予約する
   * （スライダーのドラッグで呼び出しが溜まらないように）。
   */
  const rpvRender = async () => {
    if (!rpvIsOpen()) return;
    if (rpvPending) { rpvQueued = true; return; }
    rpvPending = true;
    rpv.classList.add('busy');
    try {
      for (;;) {
        rpvQueued = false;
        // プレビューは倍率 1（速さ優先）。保存時に本来の倍率で描き直す。
        const r = await app.renderStill({ download: false, scale: 1, preview: true });
        if (r) {
          if (rpvUrl) URL.revokeObjectURL(rpvUrl);
          rpvUrl = URL.createObjectURL(r.blob);
          rpvImg.src = rpvUrl;
          rpvInfo.textContent = `${r.width}×${r.height} / ${r.ms}ms`
            + `（保存は ${state.bprScale}x = ${r.width * state.bprScale}×${r.height * state.bprScale}）`;
        }
        if (!rpvQueued || !rpvIsOpen()) break;
      }
    } finally {
      rpvPending = false;
      rpv.classList.remove('busy');
    }
  };
  const rpvOpen = () => { rpv.classList.add('show'); rpvRender(); };
  const rpvClose = () => {
    rpv.classList.remove('show');
    if (rpvUrl) { URL.revokeObjectURL(rpvUrl); rpvUrl = null; }
    rpvImg.removeAttribute('src');
  };
  document.getElementById('rpvClose').onclick = rpvClose;
  document.getElementById('rpvSave').onclick = () => app.renderStill();
  rpv.addEventListener('pointerdown', (e) => { if (e.target === rpv) rpvClose(); });

  {
    const rd = section(right, 'レンダリング', true);
    el('p', 'note', rd).textContent =
      '影・高品質 AO・輪郭線を入れて解像度を上げ、静止画として PNG に書き出します。'
      + 'ビューポートの表示は変わりません（押したときだけ別に描きます）。';

    el('div', 'subhead', rd).textContent = '解像度';
    segmented(rd, [
      { label: '1x', value: 1, title: '画面と同じ解像度' },
      { label: '2x', value: 2, title: '2 倍で描いて縮小（輪郭がなめらかになる）' },
      { label: '4x', value: 4, title: '4 倍で描いて縮小（いちばんきれい。時間はかかる）' },
    ], state.bprScale, (v) => { state.bprScale = v; rpvRender(); });

    el('div', 'subhead', rd).textContent = '光と影';
    slider(rd, {
      label: '影の強さ', min: 0, max: 1, step: 0.05, value: state.bprShadow,
      title: '0 で影なし。上げるほど影が濃くなります',
      onInput: (v) => { state.bprShadow = v; rpvRender(); },
    });
    slider(rd, {
      label: '影のやわらかさ', min: 0, max: 6, step: 0.25, value: state.bprShadowSoft,
      fmt: v => v.toFixed(2),
      title: '影の輪郭のにじみ幅。上げるとふんわりしますが、細部の影が消えます',
      onInput: (v) => { state.bprShadowSoft = v; rpvRender(); },
    });
    slider(rd, {
      label: '光の向き（水平）', min: -180, max: 180, step: 5, value: state.bprLightAz,
      fmt: v => v.toFixed(0) + '°',
      title: 'モデルのまわりを光が回ります',
      onInput: (v) => { state.bprLightAz = v; rpvRender(); },
    });
    slider(rd, {
      label: '光の高さ', min: -80, max: 89, step: 1, value: state.bprLightEl,
      fmt: v => v.toFixed(0) + '°',
      title: '上げると真上から、下げると下から照らします',
      onInput: (v) => { state.bprLightEl = v; rpvRender(); },
    });
    slider(rd, {
      label: '拡散光', min: 0, max: 1.5, step: 0.05, value: state.bprDiffuse,
      title: '光が当たっている面をどれだけ明るくするか',
      onInput: (v) => { state.bprDiffuse = v; rpvRender(); },
    });
    slider(rd, {
      label: '環境光', min: 0, max: 1.5, step: 0.05, value: state.bprAmbient,
      title: '影の中の明るさ。下げるほど影が黒くなります',
      onInput: (v) => { state.bprAmbient = v; rpvRender(); },
    });

    el('div', 'subhead', rd).textContent = '陰影と線';
    slider(rd, {
      label: 'AO サンプル数', min: 8, max: 64, step: 8, value: state.bprAoSamples,
      fmt: v => v.toFixed(0),
      title: '窪みの陰影の精度。実時間表示は 24 で、上げるとざらつきが減ります',
      onInput: (v) => { state.bprAoSamples = v; rpvRender(); },
    });
    slider(rd, {
      label: '輪郭線の太さ', min: 0, max: 4, step: 1, value: state.bprOutline,
      fmt: v => (v === 0 ? 'なし' : v.toFixed(0) + 'px'),
      title: '深度の段差と法線の折れから線を出します（0 で無し）',
      onInput: (v) => { state.bprOutline = v; rpvRender(); },
    });
    slider(rd, {
      label: '輪郭線の濃さ', min: 0, max: 1, step: 0.05, value: state.bprOutlineStrength,
      title: '輪郭線の暗さ',
      onInput: (v) => { state.bprOutlineStrength = v; rpvRender(); },
    });

    el('div', 'subhead', rd).textContent = '書き出し';
    toggle(rd, {
      label: '背景を透明にする', value: state.bprTransparent,
      title: '背景のグラデーションを描かず、何も無い所を透明にした PNG を出します',
      onChange: (on) => { state.bprTransparent = on; rpvRender(); },
    });
    toggle(rd, {
      label: '床グリッドを入れる', value: state.bprGrid,
      title: '床のグリッドを一緒に描きます（透明背景のときは無効）',
      onChange: (on) => { state.bprGrid = on; rpvRender(); },
    });
    btnRow(rd, [
      { label: 'プレビュー', cls: 'wide primary',
        title: '結果を画面で確認します。開いている間、上の設定を動かすと描き直します',
        onClick: () => rpvOpen() },
    ]);
    btnRow(rd, [
      { label: 'PNG 保存', title: '指定した倍率で描いて PNG として保存します',
        onClick: () => app.renderStill() },
    ]);
  }

  // --- クリップ / トリム -------------------------------------------------
  const cl = section(right, 'クリップ / トリム', true);
  {
    el('div', 'subhead', cl).textContent = 'ドラッグで切る';
    clipModeSeg = segmented(cl, [
      { label: 'オフ', value: 'off', title: '通常の彫刻に戻る' },
      { label: 'クリップ', value: 'clip', title: '平面の裏側を平面上へ押しつける（トポロジは変わらない）' },
      { label: 'トリム', value: 'trim', title: '平面の裏側を切り落として切り口を塞ぐ' },
      { label: 'スライス', value: 'slice', title: '切らずに平面上に辺だけ作る' },
    ], state.clipMode, (v) => { state.clipMode = v; });
    slider(cl, {
      label: 'クリップの減衰', min: 0, max: 1, step: 0.01, value: state.clipFalloff,
      title: '0 で完全な平面。上げると平面から離れるほど押しつけを弱める',
      onInput: (v) => { state.clipFalloff = v; },
    });
    el('div', 'subhead', cl).textContent = '軸平面で切る';
    for (const [ai, an] of [[0, 'X'], [1, 'Y'], [2, 'Z']]) {
      btnRow(cl, [
        { label: `${an}+ を残す`, title: `${an} が正の側を残す`, onClick: () => app.tools.applyAxisPlane(state.clipMode === 'off' ? 'trim' : state.clipMode, ai, 0, 1) },
        { label: `${an}- を残す`, title: `${an} が負の側を残す`, onClick: () => app.tools.applyAxisPlane(state.clipMode === 'off' ? 'trim' : state.clipMode, ai, 0, -1) },
      ]);
    }
    el('div', 'subhead', cl).textContent = 'ミラー & ウェルド';
    for (const [ai, an] of [[0, 'X'], [1, 'Y'], [2, 'Z']]) {
      btnRow(cl, [
        { label: `${an}+ を鏡像`, title: `${an} が正の側を残して反対側へ鏡像コピーし、接合部を溶接する`, onClick: () => app.tools.mirrorWeld(ai, 1) },
        { label: `${an}- を鏡像`, onClick: () => app.tools.mirrorWeld(ai, -1) },
      ]);
    }
    el('p', 'note', cl).textContent =
      'モードを選んでからビューをドラッグすると、その線と視線で決まる平面で切ります。'
      + 'トリムとミラー&ウェルドはトポロジを変えるので分割レベルとレイヤーは破棄されます。';
  }

  // --- トランスポーズ ----------------------------------------------------
  const tr = section(right, 'トランスポーズ', true);
  {
    transposeToggle = toggle(tr, {
      label: 'トランスポーズ（W キー）', value: false,
      title: 'マスクされていない領域を移動・回転・スケールする',
      onChange: (on) => app.setTranspose(on),
    });
    toggle(tr, {
      label: '軸を選択領域に合わせる', value: state.transposeLocal,
      title: '選択領域の主成分方向を軸にする（オフならワールド軸）',
      onChange: (on) => { state.transposeLocal = on; if (app.tools.gizmo.active) app.tools.gizmoActivate(); },
    });
    el('p', 'note', tr).textContent =
      'マスクを塗った部分が保護され、塗っていない部分が動きます。'
      + '赤緑青の矢印で移動、リングで回転、外側の四角でスケール。'
      + 'マスクの濃さで効き方が変わるので、ぼかしたマスクを使うと柔らかく変形します。';
  }

  // --- マテリアル -------------------------------------------------------
  const mt = section(right, 'マテリアル');
  const matGrid = el('div', 'matgrid', mt);
  const matBtns = [];
  MATERIALS.forEach((m, i) => {
    const b = el('button', 'mat' + (i === state.material ? ' on' : ''), matGrid);
    b.appendChild(materialThumb(i, 40));
    b.title = `${m.name} / ${m.jp}`;
    b.onclick = () => setMaterial(i);
    matBtns.push(b);
  });
  function setMaterial(i) {
    state.material = i;
    matBtns.forEach((b, k) => b.classList.toggle('on', k === i));
    toast(MATERIALS[i].jp);
  }

  // --- ブラウザ内保存 ---------------------------------------------------
  const sv = section(right, '保存（ブラウザ内）');
  const nameInput = el('input', 'text', sv);
  nameInput.type = 'text';
  nameInput.placeholder = 'スロット名（例: head-01）';
  nameInput.spellcheck = false;
  btnRow(sv, [
    {
      label: '保存', cls: 'primary', title: 'この名前で保存（同名は上書き）',
      onClick: () => {
        const n = nameInput.value.trim();
        if (!n) { toast('スロット名を入力してください'); nameInput.focus(); return; }
        app.saveProject(n);
      },
    },
  ]);
  const projList = el('div', 'projlist', sv);
  const autoMark = el('p', 'note', sv);
  el('p', 'note', sv).textContent =
    'メッシュは IndexedDB、設定は localStorage に保存されます（この端末のこのブラウザ内だけ）。'
    + 'ストロークの 4 秒後に自動保存され、次回起動時に復元を提案します。'
    + '別の端末へ持って行くには OBJ / PLY で書き出してください。';

  async function refreshProjects() {
    let items = [];
    try { items = await app.listProjects(); } catch { items = []; }
    projList.innerHTML = '';
    if (items.length === 0) {
      const p = el('p', 'note', projList);
      p.textContent = '保存されたデータはまだありません。';
      return;
    }
    for (const it of items) {
      const row = el('div', 'projrow', projList);
      const nm = el('button', 'projname', row);
      nm.textContent = it.auto ? '⟳ 自動保存' : it.name;
      const d = new Date(it.updated);
      nm.title = `${d.toLocaleString()}\n${it.verts.toLocaleString()} 頂点 / ${it.tris.toLocaleString()} 面`
        + `\n${(it.bytes / 1048576).toFixed(1)} MB\nクリックで読み込み`;
      nm.onclick = () => app.loadProject(it.name);
      const meta = el('span', 'projmeta', row);
      meta.textContent = `${(it.verts / 1000).toFixed(0)}k`;
      const del = el('button', 'projdel', row);
      del.textContent = '✕';
      del.title = '削除';
      del.onclick = async () => {
        if (!await askRestore(`「${it.auto ? '自動保存' : it.name}」を削除しますか？`, '削除', 'キャンセル')) return;
        app.deleteProject(it.name);
      };
    }
    try {
      const u = await app.estimateUsage();
      if (u && u.quota) {
        const p = el('p', 'note', projList);
        p.textContent = `使用量 ${(u.usage / 1048576).toFixed(1)} MB / 上限 ${(u.quota / 1048576 / 1024).toFixed(1)} GB`;
      }
    } catch { /* 非対応環境 */ }
  }

  function setAutosaveMark(date) {
    autoMark.textContent = date
      ? `最後の自動保存: ${date.toLocaleTimeString()}`
      : '';
  }

  // --- 表示 -------------------------------------------------------------
  const dp = section(right, '表示', true);
  const tWire = toggle(dp, {
    label: 'ワイヤフレーム', value: state.wireframe, title: 'W キー',
    onChange: v => { state.wireframe = v; },
  });
  const tGrid = toggle(dp, {
    label: 'フロアグリッド', value: state.grid, title: 'H キー',
    onChange: v => { state.grid = v; },
  });
  const tAO = toggle(dp, {
    label: 'アンビエントオクルージョン', value: state.ao, title: 'A キー / SSAO (compute shader)',
    onChange: v => { state.ao = v; },
  });
  slider(dp, {
    label: 'キャビティ（溝を暗く）', min: 0, max: 1.2, step: 0.01, value: state.cavity,
    title: '曲率から溝を暗くする。彫刻の形が読み取りやすくなる',
    onInput: v => { state.cavity = v; },
  });
  slider(dp, {
    label: 'ピーク（稜線を明るく）', min: 0, max: 0.8, step: 0.01, value: state.peak,
    onInput: v => { state.peak = v; },
  });
  slider(dp, {
    label: 'キャビティ感度', min: 0.5, max: 8, step: 0.1, value: state.cavityGain,
    onInput: v => { state.cavityGain = v; },
  });
  slider(dp, {
    label: 'AO 強度', min: 0, max: 1, step: 0.01, value: state.aoIntensity,
    onInput: v => { state.aoIntensity = v; },
  });
  slider(dp, {
    label: 'AO 半径', min: 0.2, max: 3, step: 0.05, value: state.aoRadius,
    onInput: v => { state.aoRadius = v; },
  });
  slider(dp, {
    label: '露出', min: 0.4, max: 2, step: 0.01, value: state.exposure,
    onInput: v => { state.exposure = v; },
  });
  slider(dp, {
    label: 'レンダースケール', min: 0.5, max: 2, step: 0.05, value: state.renderScale,
    title: '1 未満で軽量化、1 超で高精細',
    onInput: v => { state.renderScale = v; app.setRenderScale(v); },
  });
  toggle(dp, {
    label: 'カメラ縦回転を反転', value: state.invertOrbitY,
    title: '既定は「掴んだ点がカーソルに追従する」向き。逆が好みならこちら',
    onChange: v => { state.invertOrbitY = v; },
  });
  el('div', 'sublabel', dp).textContent = '背景';
  segmented(dp, [
    { label: '暗', value: 'dark' }, { label: '灰', value: 'grey' }, { label: '明', value: 'light' },
  ], state.bgPreset, (v) => app.setBackground(v));
  el('div', 'sublabel', dp).textContent = 'デバッグ表示';
  segmented(dp, [
    { label: '通常', value: 0, title: '通常のシェーディング' },
    { label: 'AO のみ', value: 1, title: 'SSAO の結果だけを表示' },
  ], state.debugView, (v) => { state.debugView = v; });

  // --- ヘルプ -----------------------------------------------------------
  const hp = section(right, '操作方法', true);
  hp.innerHTML = `
    <table class="keys">
      <tr><td>左ドラッグ（モデル上）</td><td>彫刻</td></tr>
      <tr><td>左ドラッグ（背景）/ 右ドラッグ</td><td>回転</td></tr>
      <tr><td>中ドラッグ / Space+左</td><td>平行移動</td></tr>
      <tr><td>ホイール</td><td>ズーム</td></tr>
      <tr><td>Shift+ドラッグ</td><td>スムーズ</td></tr>
      <tr><td>Alt+ドラッグ</td><td>ブラシ反転（掘る）</td></tr>
      <tr><td>Ctrl+ドラッグ</td><td>マスクを塗る</td></tr>
      <tr><td>Ctrl+Alt+ドラッグ</td><td>マスクを消す</td></tr>
      <tr><td>1 … 0</td><td>ブラシ切り替え</td></tr>
      <tr><td>[ ]</td><td>ブラシ半径</td></tr>
      <tr><td>, .</td><td>ブラシ強さ</td></tr>
      <tr><td>X / G / W / A / M</td><td>Xミラー / 動的トポロジ / ワイヤ / AO / マテリアル</td></tr>
      <tr><td>D</td><td>ダイナメッシュ実行</td></tr>
      <tr><td>L / B / H</td><td>レイジーマウス / バックフェイスマスク / グリッド</td></tr>
      <tr><td>PageUp / PageDown</td><td>分割レベルを上げる / 下げる</td></tr>
      <tr><td>F</td><td>モデル全体を表示</td></tr>
      <tr><td>Ctrl+Z / Ctrl+Shift+Z</td><td>元に戻す / やり直し</td></tr>
    </table>`;

  // --- 視点プリセット ----------------------------------------------------
  const vw = section(right, '視点', true);
  btnRow(vw, [
    { label: '正面', onClick: () => app.setView('front') },
    { label: '背面', onClick: () => app.setView('back') },
    { label: '左', onClick: () => app.setView('left') },
    { label: '右', onClick: () => app.setView('right') },
  ]);
  btnRow(vw, [
    { label: '上', onClick: () => app.setView('top') },
    { label: '下', onClick: () => app.setView('bottom') },
    { label: '全体表示 (F)', onClick: () => app.frameCamera() },
  ]);
  btnRow(vw, [
    { label: '設定を初期化', title: '保存された UI 設定を消す', onClick: () => app.resetSettings() },
  ]);

  // --- トースト / 処理中オーバーレイ ------------------------------------
  let toastTimer = 0;
  function toast(msg, ms = 1800) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
  const busyEl = document.getElementById('busy');
  const busyMsgEl = document.getElementById('busyMsg');
  function showBusy(msg) {
    busyMsgEl.textContent = msg;
    busyEl.classList.add('show');
  }
  function hideBusy() {
    busyEl.classList.remove('show');
  }

  // --- 確認ダイアログ（window.confirm は使わず自前で出す） ---------------
  const askEl = document.getElementById('ask');
  const askMsg = document.getElementById('askMsg');
  const askYes = document.getElementById('askYes');
  const askNo = document.getElementById('askNo');
  function askRestore(msg, yes = 'はい', no = 'いいえ') {
    return new Promise((resolve) => {
      askMsg.textContent = msg;
      askYes.textContent = yes;
      askNo.textContent = no;
      askEl.classList.add('show');
      const done = (v) => {
        askEl.classList.remove('show');
        askYes.onclick = null; askNo.onclick = null;
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        else if (e.key === 'Enter') { e.stopPropagation(); done(true); }
      };
      askYes.onclick = () => done(true);
      askNo.onclick = () => done(false);
      document.addEventListener('keydown', onKey, true);
    });
  }

  // --- 統計表示 ---------------------------------------------------------
  let statHtml = '';
  function refreshStats(info) {
    const h = `<span><b>${info.verts.toLocaleString()}</b> 頂点</span>`
      + `<span><b>${info.tris.toLocaleString()}</b> 面</span>`
      + `<span><b>${info.fps.toFixed(0)}</b> fps</span>`
      + `<span class="dim">${info.mb.toFixed(0)} MB</span>`;
    if (h !== statHtml) { statsEl.innerHTML = h; statHtml = h; }
  }

  // 初回描画
  refreshLayers();
  refreshGroups();
  refreshMorph();
  refreshSubtools();

  return {
    setBrush, setMaterial, toast, refreshStats, showBusy, hideBusy,
    askRestore, refreshLevels, refreshProjects, setAutosaveMark,
    refreshLayers, refreshGroups, refreshMorph, refreshSubtools,
    /** 使い方ページ（F1 / ? / Esc から呼ばれる） */
    openHelp() { help.open(); },
    closeHelp() { help.close(); },
    toggleHelp() { help.toggle(); },
    helpIsOpen() { return help.isOpen(); },
    /** 編集モードの表示を state / 編集メッシュに合わせる */
    refreshEdit() {
      if (editToggle) editToggle.set(state.editMode);
      if (editModeSeg) editModeSeg.set(state.editSelect);
      if (!editInfoEl) return;
      const i = app.tools ? app.tools.editInfo() : null;
      if (!i) { editInfoEl.textContent = '編集モードに入っていません。'; return; }
      const n = (x) => x.toLocaleString();
      editInfoEl.textContent =
        `頂点 ${n(i.verts)} / 辺 ${n(i.edges)} / 面 ${n(i.faces)}`
        + `（四角 ${n(i.quad)} / 三角 ${n(i.tri)}${i.ngon ? ` / n-gon ${n(i.ngon)}` : ''}`
        + ` — 四角化率 ${(i.quadRatio * 100).toFixed(0)}%）\n`
        + `選択中: 頂点 ${n(i.sel.verts)} / 辺 ${n(i.sel.edges)} / 面 ${n(i.sel.faces)}`
        + `${i.nonManifold ? `　⚠ 非多様体辺 ${n(i.nonManifold)}` : ''}`;
    },
    /** レンダリングプレビュー */
    openRenderPreview() { rpvOpen(); },
    closeRenderPreview() { rpvClose(); },
    renderPreviewIsOpen() { return rpvIsOpen(); },
    /** プレビューの描き直しを待つ（テスト用） */
    renderPreviewSrc() { return rpvImg.getAttribute('src') || ''; },
    /** 使い方ページが元にしているパレットの定義（ずれ検出のテスト用） */
    helpSources() { return HELP_SOURCES; },
    /** トランスポーズのトグル表示を state に合わせる（キー操作から呼ばれる） */
    syncTranspose(on) { if (transposeToggle) transposeToggle.set(on); },
    syncFromState() {
      sRadius.set(state.radiusPx);
      sStrength.set(state.strength);
      sDetail.set(state.detail);
      sDynaRes.set(state.dynaResolution);
      sLazy.set(state.lazyRadius);
      fInput.value = Math.round(state.focalShift * 100);
      syncFocal();
      tWire.set(state.wireframe);
      tGrid.set(state.grid);
      tAO.set(state.ao);
      tDyn.set(state.dynTopo);
      tBackface.set(state.backfaceMask);
      tPressure.set(state.usePressure);
      brushBtns.forEach((btn, key) => btn.classList.toggle('on', key === state.brush));
      matBtns.forEach((b, k) => b.classList.toggle('on', k === state.material));
      if (paintRow) paintRow.style.display = (state.brush === 'paint') ? '' : 'none';
      for (const ax of ['x', 'y', 'z']) symBtns[ax].classList.toggle('on', state.symmetry[ax]);
      if (deformAxisSeg) deformAxisSeg.set(state.deform.axis);
      if (groupAngleSlider) groupAngleSlider.set(state.groupAngle);
      if (groupViewToggle) groupViewToggle.set(state.groupView);
      if (clipModeSeg) clipModeSeg.set(state.clipMode);
      if (remeshTrisSlider) remeshTrisSlider.set(state.remeshTris);
      if (strokeSeg) strokeSeg.set(state.stroke);
      if (alphaGrid) alphaGrid.btns.forEach((b, k) => b.classList.toggle('on', k === state.alpha));
      refreshLayers();
      refreshGroups();
      refreshMorph();
      refreshSubtools();
    },
  };
}
