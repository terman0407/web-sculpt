// ---------------------------------------------------------------------------
// subtool.js
// サブツール（ZBrush の SubTool 相当）。1 つのシーンに独立したメッシュを複数置く。
//
// ZBrush と同じで
//   * 編集できるのはアクティブな 1 つだけ
//   * ほかは表示されるが彫刻の対象にならない
//   * オブジェクトごとの変換は持たない（すべてワールド座標）
// という設計にしてある。オブジェクト変換を持たせると、シンメトリ・ダイナメッシュ・
// ピッキングのすべてに座標系の掛け替えが要る。ZBrush でも SubTool は
// ワールド座標で持っていて、移動はジオメトリを動かす形なので、それに合わせた。
//
// メッシュそのもの（SculptMesh）は使い回すのではなく 1 サブツールに 1 つ持つ。
// アクティブを切り替えると main.js の参照先が差し替わる。
// ---------------------------------------------------------------------------

import { SculptMesh, PRIMITIVES } from './mesh.js';

let nextId = 1;

/**
 * 連結成分に分ける。戻り値は頂点 → 成分番号（0..count-1）と成分数。
 *
 * ring を辿るフラッドフィルではなく三角形 1 周の Union-Find にしてある。
 * 三角形を 1 回舐めるだけで済み、ring の間接参照が入らない。
 */
function connectedComponents(mesh) {
  const T = mesh.tris, nv = mesh.nv;
  const par = new Int32Array(nv);
  for (let i = 0; i < nv; i++) par[i] = i;
  const find = (x) => {
    let r = x;
    while (par[r] !== r) r = par[r];
    // 経路圧縮（次回以降を浅くする）
    while (par[x] !== r) { const nx = par[x]; par[x] = r; x = nx; }
    return r;
  };
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    let ra = find(a), rb = find(b);
    if (ra !== rb) par[rb] = ra;
    ra = find(a); const rc = find(c);
    if (ra !== rc) par[rc] = ra;
  }
  // 根に 0 から番号を振り直す
  const label = new Int32Array(nv).fill(-1);
  const comp = new Int32Array(nv).fill(-1);
  let count = 0;
  for (let v = 0; v < nv; v++) {
    if (!mesh.vAlive[v]) continue;
    const r = find(v);
    if (label[r] < 0) label[r] = count++;
    comp[v] = label[r];
  }
  return { comp, count };
}

/**
 * 三角形の部分集合から新しいメッシュを作る。
 * 使われている頂点だけを詰め直して番号を振り直す。
 */
function extract(mesh, keepTri) {
  const T = mesh.tris;
  const remap = new Int32Array(mesh.nv).fill(-1);
  let nv = 0, nt = 0;
  for (let t = 0; t < mesh.nt; t++) {
    if (!keepTri(t)) continue;
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    nt++;
    for (const v of [a, b, c]) if (remap[v] < 0) remap[v] = nv++;
  }
  if (nt === 0) return null;
  const pos = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  const msk = new Float32Array(nv);
  for (let v = 0; v < mesh.nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    pos[r * 3] = mesh.positions[v * 3];
    pos[r * 3 + 1] = mesh.positions[v * 3 + 1];
    pos[r * 3 + 2] = mesh.positions[v * 3 + 2];
    col[r * 3] = mesh.colors[v * 3];
    col[r * 3 + 1] = mesh.colors[v * 3 + 1];
    col[r * 3 + 2] = mesh.colors[v * 3 + 2];
    msk[r] = mesh.mask[v];
  }
  const idx = new Uint32Array(nt * 3);
  let w = 0;
  for (let t = 0; t < mesh.nt; t++) {
    if (!keepTri(t)) continue;
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    idx[w++] = remap[a]; idx[w++] = remap[b]; idx[w++] = remap[c];
  }
  return { positions: pos, indices: idx, colors: col, mask: msk };
}

export class SubTool {
  constructor(name, mesh) {
    this.id = nextId++;
    this.name = name;
    this.mesh = mesh;
    this.visible = true;
  }
  get verts() { return this.mesh.liveVerts; }
  get tris() { return this.mesh.liveTris; }
  bytes() { return this.mesh.byteSize(); }
}

export class SubToolSet {
  constructor() {
    this.list = [];
    this.active = 0;
    // ソロ表示（アクティブだけ表示する。ZBrush の Solo）
    this.solo = false;
  }

  get count() { return this.list.length; }
  get activeTool() { return this.list[this.active] || null; }
  get activeMesh() { return this.activeTool ? this.activeTool.mesh : null; }

  /** 表示すべきサブツール（ソロ中はアクティブだけ） */
  visibleTools() {
    if (this.solo) return this.activeTool ? [this.activeTool] : [];
    return this.list.filter((t) => t.visible);
  }

  /** アクティブ以外で表示されているもの（レンダラの静的スロット用） */
  inactiveVisible() {
    const a = this.activeTool;
    return this.visibleTools().filter((t) => t !== a);
  }

  info() {
    return this.list.map((t, i) => ({
      index: i, id: t.id, name: t.name, visible: t.visible,
      verts: t.verts, tris: t.tris, active: i === this.active,
    }));
  }

  /** 既存のメッシュを 1 つめのサブツールとして取り込む */
  adopt(mesh, name = 'サブツール 1') {
    this.list = [new SubTool(name, mesh)];
    this.active = 0;
    this.solo = false;
    return this.list[0];
  }

  add(mesh, name) {
    const t = new SubTool(name || `サブツール ${this.list.length + 1}`, mesh);
    // ZBrush と同じでアクティブの直後に入れる
    this.list.splice(this.active + 1, 0, t);
    this.active = this.list.indexOf(t);
    return t;
  }

  addPrimitive(kind) {
    const gen = PRIMITIVES[kind] || PRIMITIVES.sphere;
    const g = gen();
    const m = new SculptMesh();
    m.setGeometry(g.positions, g.indices);
    return this.add(m, `${kind} ${this.list.length + 1}`);
  }

  duplicate(index = this.active) {
    const src = this.list[index];
    if (!src) return null;
    const m = new SculptMesh();
    const s = src.mesh;
    // 生きているものだけを詰め直して複製する（死んだスロットを引き継がない）
    const g = extract(s, (t) => s.isTriAlive(t));
    if (!g) return null;
    m.setGeometry(g.positions, g.indices, g.colors, g.mask);
    return this.add(m, src.name + ' コピー');
  }

  remove(index = this.active) {
    if (this.list.length <= 1) return false;
    const t = this.list[index];
    if (!t) return false;
    this.list.splice(index, 1);
    if (this.active >= this.list.length) this.active = this.list.length - 1;
    return true;
  }

  rename(index, name) {
    const t = this.list[index];
    if (!t || !name) return false;
    t.name = name;
    return true;
  }

  select(index) {
    if (index < 0 || index >= this.list.length) return false;
    this.active = index;
    return true;
  }

  selectById(id) {
    const i = this.list.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.active = i;
    return true;
  }

  setVisible(index, on) {
    const t = this.list[index];
    if (!t) return false;
    t.visible = !!on;
    return true;
  }

  move(index, dir) {
    const j = index + dir;
    if (index < 0 || index >= this.list.length || j < 0 || j >= this.list.length) return false;
    const [t] = this.list.splice(index, 1);
    this.list.splice(j, 0, t);
    this.active = this.list.indexOf(t);
    return true;
  }

  /**
   * 表示されているサブツールを 1 つにまとめる。
   * 頂点は詰め直して連結し、色とマスクも引き継ぐ。
   * ジオメトリ的には別の塊が同居した状態になる（ダイナメッシュを掛けると和になる）。
   */
  mergeVisible() {
    const tools = this.visibleTools();
    if (tools.length < 2) return null;
    let nv = 0, nt = 0;
    const parts = [];
    for (const t of tools) {
      const g = extract(t.mesh, (x) => t.mesh.isTriAlive(x));
      if (!g) continue;
      parts.push(g);
      nv += g.positions.length / 3;
      nt += g.indices.length / 3;
    }
    if (parts.length < 2) return null;
    const pos = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const msk = new Float32Array(nv);
    const idx = new Uint32Array(nt * 3);
    let vo = 0, io = 0;
    for (const g of parts) {
      pos.set(g.positions, vo * 3);
      col.set(g.colors, vo * 3);
      msk.set(g.mask, vo);
      for (let i = 0; i < g.indices.length; i++) idx[io + i] = g.indices[i] + vo;
      vo += g.positions.length / 3;
      io += g.indices.length;
    }
    const m = new SculptMesh();
    m.setGeometry(pos, idx, col, msk);
    // まとめた結果を 1 つのサブツールに置き換える
    const keep = this.list.filter((t) => !tools.includes(t));
    const merged = new SubTool('まとめ', m);
    this.list = [merged, ...keep];
    this.active = 0;
    return { tool: merged, count: tools.length, verts: nv, tris: nt };
  }

  /** 連結成分ごとに分ける（ZBrush の Split To Parts） */
  splitToParts(index = this.active) {
    const t = this.list[index];
    if (!t) return null;
    const m = t.mesh;
    const { comp, count } = connectedComponents(m);
    if (count <= 1) return { made: 0, reason: '1 つの塊しかありません' };
    const made = [];
    for (let c = 0; c < count; c++) {
      const g = extract(m, (tri) => {
        if (!m.isTriAlive(tri)) return false;
        return comp[m.tris[tri * 3]] === c;
      });
      if (!g) continue;
      const nm = new SculptMesh();
      nm.setGeometry(g.positions, g.indices, g.colors, g.mask);
      made.push(new SubTool(`${t.name}-${made.length + 1}`, nm));
    }
    if (made.length < 2) return { made: 0, reason: '分けられませんでした' };
    this.list.splice(index, 1, ...made);
    this.active = index;
    return { made: made.length };
  }

  /** マスクした部分を切り出す（ZBrush の Split Masked Points） */
  splitMasked(index = this.active, threshold = 0.5) {
    const t = this.list[index];
    if (!t) return null;
    const m = t.mesh;
    const isMasked = (tri) => {
      const i = tri * 3;
      const a = m.tris[i], b = m.tris[i + 1], c = m.tris[i + 2];
      return (m.mask[a] + m.mask[b] + m.mask[c]) / 3 >= threshold;
    };
    const gA = extract(m, (tri) => m.isTriAlive(tri) && isMasked(tri));
    const gB = extract(m, (tri) => m.isTriAlive(tri) && !isMasked(tri));
    if (!gA || !gB) return { made: 0, reason: 'マスクが全体か空です' };
    const made = [];
    for (const [g, suffix] of [[gA, 'マスク'], [gB, '残り']]) {
      const nm = new SculptMesh();
      nm.setGeometry(g.positions, g.indices, g.colors, g.mask);
      made.push(new SubTool(`${t.name}-${suffix}`, nm));
    }
    this.list.splice(index, 1, ...made);
    this.active = index;
    return { made: made.length };
  }

  /** 三角形の部分集合から新メッシュを作るヘルパ（ポリグループの分割などに使う） */
  splitByPredicate(index, keepTri, nameA, nameB) {
    const t = this.list[index];
    if (!t) return null;
    const m = t.mesh;
    const gA = extract(m, (tri) => m.isTriAlive(tri) && keepTri(tri));
    const gB = extract(m, (tri) => m.isTriAlive(tri) && !keepTri(tri));
    if (!gA || !gB) return { made: 0, reason: '分けられませんでした' };
    const made = [];
    for (const [g, nm2] of [[gA, nameA], [gB, nameB]]) {
      const nm = new SculptMesh();
      nm.setGeometry(g.positions, g.indices, g.colors, g.mask);
      made.push(new SubTool(nm2, nm));
    }
    this.list.splice(index, 1, ...made);
    this.active = index;
    return { made: made.length };
  }

  /** 全サブツールを覆うバウンディングボックス（カメラ合わせ用） */
  bounds() {
    const tools = this.visibleTools();
    if (tools.length === 0) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const t of tools) {
      const b = t.mesh.bounds();
      if (b.min[0] < minX) minX = b.min[0];
      if (b.min[1] < minY) minY = b.min[1];
      if (b.min[2] < minZ) minZ = b.min[2];
      if (b.max[0] > maxX) maxX = b.max[0];
      if (b.max[1] > maxY) maxY = b.max[1];
      if (b.max[2] > maxZ) maxZ = b.max[2];
    }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    return {
      min: [minX, minY, minZ], max: [maxX, maxY, maxZ], center: [cx, cy, cz],
      radius: Math.max(1e-4, 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)),
    };
  }

  /**
   * ワールド点がどのサブツールの表面に最も近いかを返す。
   * ピッキングは深度から作るのでどのサブツールを指したか分からない。
   * まずバウンディングボックスで絞ってから最近傍頂点を見る
   * （全サブツールで全頂点走査すると高密度で重い）。
   */
  pickTool(point) {
    const tools = this.visibleTools();
    if (tools.length <= 1) return tools[0] || null;
    let best = null, bd = Infinity;
    for (const t of tools) {
      const b = t.mesh.bounds();
      // bbox までの距離が既知の最良より遠ければ中は見ない
      let dx = 0, dy = 0, dz = 0;
      if (point[0] < b.min[0]) dx = b.min[0] - point[0]; else if (point[0] > b.max[0]) dx = point[0] - b.max[0];
      if (point[1] < b.min[1]) dy = b.min[1] - point[1]; else if (point[1] > b.max[1]) dy = point[1] - b.max[1];
      if (point[2] < b.min[2]) dz = b.min[2] - point[2]; else if (point[2] > b.max[2]) dz = point[2] - b.max[2];
      const boxD = dx * dx + dy * dy + dz * dz;
      if (boxD > bd) continue;
      const m = t.mesh, P = m.positions;
      let d2 = Infinity;
      // 高密度では間引いて見る。表面の判定なので厳密な最近傍は要らない
      const step = Math.max(1, Math.floor(m.nv / 20000));
      for (let v = 0; v < m.nv; v += step) {
        if (!m.vAlive[v]) continue;
        const i = v * 3;
        const ex = P[i] - point[0], ey = P[i + 1] - point[1], ez = P[i + 2] - point[2];
        const d = ex * ex + ey * ey + ez * ez;
        if (d < d2) d2 = d;
      }
      if (d2 < bd) { bd = d2; best = t; }
    }
    return best;
  }

  bytes() {
    let b = 0;
    for (const t of this.list) b += t.bytes();
    return b;
  }
}
