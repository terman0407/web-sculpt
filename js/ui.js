// ---------------------------------------------------------------------------
// ui.js - DOM パネルの構築。state を直接読み書きし、必要な時だけ app にコールバック。
// ---------------------------------------------------------------------------

import { BRUSHES, falloff } from './brushes.js';
import { MATERIALS, materialThumb } from './matcap.js';
import { clamp } from './math.js';

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

// ---------------------------------------------------------------------------

export function buildUI(app) {
  const state = app.state;
  const brushList = document.getElementById('brushList');
  const right = document.getElementById('rightPanel');
  const meshBar = document.getElementById('meshBar');
  const statsEl = document.getElementById('stats');
  const toastEl = document.getElementById('toast');

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
    { label: '読み込み OBJ', title: 'OBJ ファイルを読み込む', onClick: () => app.importOBJ() },
    { label: 'OBJ', title: 'OBJ で書き出し（頂点カラー付き）', onClick: () => app.exportFile('obj') },
    { label: 'PLY', title: 'PLY で書き出し（ポリペイント保持）', onClick: () => app.exportFile('ply') },
    { label: 'STL', title: 'STL で書き出し（3D プリント向け）', onClick: () => app.exportFile('stl') },
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

  return {
    setBrush, setMaterial, toast, refreshStats, showBusy, hideBusy,
    askRestore, refreshLevels, refreshProjects, setAutosaveMark,
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
    },
  };
}
