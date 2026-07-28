// ---------------------------------------------------------------------------
// sculptor.js
// ストローク制御・領域抽出・シンメトリ・動的トポロジ・アンドゥ。
//
// 領域抽出はメッシュの連結性を使ったフラッドフィル。空間分割構造を持たない代わりに
//   * ストローク開始時のみ全頂点線形探索でシード頂点を求める
//   * ストローク中はシードを 1-ring 最急降下で追従させる
// という方針。結果として「近いが繋がっていない面」に滲まない（ZBrush と同じ挙動）。
// ---------------------------------------------------------------------------

import { V3, clamp } from './math.js';
import { BrushEngine, needsTopology, usesDelta } from './brushes.js';
import { refineRegion } from './dyntopo.js';
import { dynamesh } from './dynamesh.js';
import { SubdivLevels } from './subdiv.js';

export function buildMirrors(sym) {
  let list = [[1, 1, 1]];
  const axes = [[0, sym.x], [1, sym.y], [2, sym.z]];
  for (const [i, on] of axes) {
    if (!on) continue;
    const next = [];
    for (const m of list) {
      next.push(m);
      const c = m.slice();
      c[i] = -c[i];
      next.push(c);
    }
    list = next;
  }
  return list;
}

/** 全頂点走査で p に最も近い生存頂点を返す */
export function nearestVertexBrute(mesh, p) {
  const P = mesh.positions, A = mesh.vAlive;
  const px = p[0], py = p[1], pz = p[2];
  let best = -1, bd = Infinity;
  for (let v = 0; v < mesh.nv; v++) {
    if (A[v] === 0) continue;
    const i = v * 3;
    const dx = P[i] - px, dy = P[i + 1] - py, dz = P[i + 2] - pz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

/** start から 1-ring 最急降下で p に近い頂点まで歩く */
function descend(mesh, start, p, maxSteps = 400) {
  if (start < 0 || start >= mesh.nv || !mesh.isVertAlive(start)) return -1;
  const P = mesh.positions, T = mesh.tris;
  const px = p[0], py = p[1], pz = p[2];
  let cur = start;
  let ci = cur * 3;
  let cd = (P[ci] - px) ** 2 + (P[ci + 1] - py) ** 2 + (P[ci + 2] - pz) ** 2;
  for (let s = 0; s < maxSteps; s++) {
    const r = mesh.ring[cur];
    if (!r || r.length === 0) return cur;
    let next = -1, nd = cd;
    for (let j = 0; j < r.length; j++) {
      const ti = r[j] * 3;
      for (let e = 0; e < 3; e++) {
        const u = T[ti + e];
        if (u === cur) continue;
        const ui = u * 3;
        const d = (P[ui] - px) ** 2 + (P[ui + 1] - py) ** 2 + (P[ui + 2] - pz) ** 2;
        if (d < nd) { nd = d; next = u; }
      }
    }
    if (next < 0) return cur;
    cur = next; cd = nd; ci = cur * 3;
  }
  return cur;
}

// ---------------------------------------------------------------------------

export class History {
  constructor(limit = 24, byteLimit = 320 * 1024 * 1024) {
    this.limit = limit;
    this.byteLimit = byteLimit;
    this.states = [];
    this.cur = -1;
  }
  reset(mesh) {
    this.states = [mesh.snapshot()];
    this.cur = 0;
  }
  commit(mesh) {
    if (this.cur < this.states.length - 1) this.states.length = this.cur + 1;
    this.states.push(mesh.snapshot());
    this.cur = this.states.length - 1;
    // 件数とメモリ量の両方で古い履歴を捨てる（最新 2 件は必ず残す）
    while (this.states.length > this.limit
      || (this.states.length > 2 && this.bytes() > this.byteLimit)) {
      this.states.shift();
      this.cur--;
    }
  }
  canUndo() { return this.cur > 0; }
  canRedo() { return this.cur >= 0 && this.cur < this.states.length - 1; }
  undo(mesh) {
    if (!this.canUndo()) return false;
    this.cur--;
    mesh.restore(this.states[this.cur]);
    return true;
  }
  redo(mesh) {
    if (!this.canRedo()) return false;
    this.cur++;
    mesh.restore(this.states[this.cur]);
    return true;
  }
  bytes() {
    let b = 0;
    for (const s of this.states) {
      b += s.positions.byteLength + s.colors.byteLength + s.mask.byteLength
        + s.vAlive.byteLength + s.tris.byteLength;
    }
    return b;
  }
}

// ---------------------------------------------------------------------------

class MirrorState {
  constructor() {
    this.seed = -1;
    this.lastPoint = V3.create();
    this.center = V3.create();
    this.lockedVerts = null;   // move ブラシ用の固定領域
    this.lockedCount = 0;
    this.verts = [];
    this.tris = [];
    this.count = 0;
  }
}

export class Sculptor {
  constructor(mesh, state) {
    this.mesh = mesh;
    this.state = state;
    this.engine = new BrushEngine();
    this.history = new History();

    this.vStamp = new Int32Array(0);
    this.tStamp = new Int32Array(0);
    this.stamp = 0;
    this.queue = new Int32Array(0);
    this.normalSet = [];
    this.curvSet = [];
    this.curvPending = [];      // フレーム末にまとめて曲率を直す頂点
    this.cvStamp = new Int32Array(0);
    this.cvStampId = 1;
    this._movedVerts = [];      // dyntopo のコラプスで位置が動いた頂点
    this.nStamp = new Int32Array(0);
    this.levels = new SubdivLevels();

    this.mirrors = [];
    for (let i = 0; i < 8; i++) this.mirrors.push(new MirrorState());
    this.activeMirrors = [[1, 1, 1]];

    this.hoverSeed = -1;
    this.stroking = false;
    this.strokeBrush = 'clay';
    this.strokeDir = 1;
    this.topoChanged = false;
    this.dabCount = 0;
    this._delta = V3.create();
    this._pt = V3.create();
    this._mp = V3.create();
    this._step = V3.create();
    this._walk = V3.create();

    this.history.reset(mesh);
  }

  setMesh(mesh) {
    this.mesh = mesh;
    this.history.reset(mesh);
    this.stroking = false;
    this.hoverSeed = -1;
    this.levels.clear();
    this.dropPendingCurvature();
  }

  /**
   * ブラシカーソル表示用にカーソル位置の表面法線を得る。
   * ホバー用シードを 1-ring 降下で追従させるので毎フレーム呼んでも安価。
   */
  surfaceNormalAt(point, out) {
    const m = this.mesh;
    if (m.liveVerts === 0) return false;
    let s = this.hoverSeed;
    if (s < 0 || s >= m.nv || !m.isVertAlive(s)) s = nearestVertexBrute(m, point);
    else {
      const d = descend(m, s, point);
      s = d < 0 ? nearestVertexBrute(m, point) : d;
      // 最急降下が局所解に落ちた場合だけ全走査でやり直す
      if (s >= 0) {
        const i = s * 3, P = m.positions;
        const dist = Math.hypot(P[i] - point[0], P[i + 1] - point[1], P[i + 2] - point[2]);
        const tol = Math.max(this.state.worldRadius * 2, this.targetEdgeLength(this.state.worldRadius) * 4);
        if (dist > tol) s = nearestVertexBrute(m, point);
      }
    }
    if (s < 0) return false;
    this.hoverSeed = s;
    const i = s * 3;
    out[0] = m.normals[i]; out[1] = m.normals[i + 1]; out[2] = m.normals[i + 2];
    return true;
  }

  // stamp は単調増加させる。新しく確保した配列はゼロ埋め、既存配列の値は
  // すべて現在の stamp より小さいので、カウンタをリセットしなければ衝突しない。
  _ensureStamps() {
    const m = this.mesh;
    if (this.vStamp.length < m.capV) {
      this.vStamp = new Int32Array(m.capV);
      this.nStamp = new Int32Array(m.capV);
      this.cvStamp = new Int32Array(m.capV);
      this.queue = new Int32Array(m.capV);
    }
    if (this.tStamp.length < m.capT) {
      this.tStamp = new Int32Array(m.capT);
    }
  }

  /** ブラシ球内の連結頂点と、それに接する三角形を収集 */
  _gather(ms, center, radius) {
    const m = this.mesh;
    this._ensureStamps();
    const id = ++this.stamp;
    const vS = this.vStamp, tS = this.tStamp, q = this.queue;
    const P = m.positions, T = m.tris;
    const verts = ms.verts, tris = ms.tris;
    verts.length = 0; tris.length = 0;

    const cx = center[0], cy = center[1], cz = center[2];
    const r2 = radius * radius;
    let head = 0, tail = 0;

    const seed = ms.seed;
    if (seed < 0 || seed >= m.nv || !m.isVertAlive(seed)) { ms.count = 0; return; }
    vS[seed] = id;
    q[tail++] = seed;

    while (head < tail) {
      const v = q[head++];
      verts.push(v);
      const r = m.ring[v];
      if (!r) continue;
      for (let j = 0; j < r.length; j++) {
        const t = r[j];
        if (tS[t] !== id) { tS[t] = id; tris.push(t); }
        const ti = t * 3;
        for (let e = 0; e < 3; e++) {
          const u = T[ti + e];
          if (vS[u] === id) continue;
          vS[u] = id;
          const ui = u * 3;
          const dx = P[ui] - cx, dy = P[ui + 1] - cy, dz = P[ui + 2] - cz;
          if (dx * dx + dy * dy + dz * dz <= r2 && tail < q.length) q[tail++] = u;
        }
      }
    }
    ms.count = verts.length;
  }

  /**
   * 移動した頂点とその近傍の法線と曲率を再計算する。
   * 曲率は 1-ring 平均に依存するので、法線より 1 段広い範囲を更新する。
   */
  _updateNormals(verts, count) {
    const m = this.mesh;
    this._ensureStamps();
    const T = m.tris;

    // 1 段目: 移動頂点 + その 1-ring（法線の更新範囲）
    const id1 = ++this.stamp;
    const nS = this.nStamp;
    const set = this.normalSet;
    set.length = 0;
    for (let k = 0; k < count; k++) {
      const v = verts[k];
      if (nS[v] !== id1) { nS[v] = id1; set.push(v); }
      const r = m.ring[v];
      if (!r) continue;
      for (let j = 0; j < r.length; j++) {
        const ti = r[j] * 3;
        for (let e = 0; e < 3; e++) {
          const u = T[ti + e];
          if (nS[u] !== id1) { nS[u] = id1; set.push(u); }
        }
      }
    }
    m.computeNormalsFor(set, set.length);

    // 曲率は見た目（キャビティ陰影）にしか使わず、彫刻の挙動には影響しない。
    // 1 フレームに何十ダブも打たれるので、ここでは「後で計算する頂点」を
    // 積むだけにして、実際の計算はフレーム末に 1 回だけ行う。
    const cs = this.cvStamp, cid = this.cvStampId;
    const pend = this.curvPending;
    for (let k = 0; k < set.length; k++) {
      const v = set[k];
      if (cs[v] !== cid) { cs[v] = cid; pend.push(v); }
    }
  }

  /**
   * 溜まっていた曲率の再計算をまとめて行う。毎フレーム 1 回、描画前に呼ぶ。
   * @returns {number} 更新した頂点数
   */
  flushCurvature() {
    const pend = this.curvPending;
    if (pend.length === 0) return 0;
    const m = this.mesh;
    this._ensureStamps();
    const T = m.tris;

    // 法線が変わった頂点の隣も曲率が変わるので 1-ring 広げる
    const id = ++this.stamp;
    const nS = this.nStamp;
    const cset = this.curvSet;
    cset.length = 0;
    for (let k = 0; k < pend.length; k++) {
      const v = pend[k];
      if (v >= m.nv || !m.isVertAlive(v)) continue;
      if (nS[v] !== id) { nS[v] = id; cset.push(v); }
      const r = m.ring[v];
      if (!r) continue;
      for (let j = 0; j < r.length; j++) {
        const ti = r[j] * 3;
        for (let e = 0; e < 3; e++) {
          const u = T[ti + e];
          if (nS[u] !== id) { nS[u] = id; cset.push(u); }
        }
      }
    }
    pend.length = 0;
    this.cvStampId++;
    if (cset.length === 0) return 0;
    m.computeCurvatureFor(cset, cset.length);
    m.smoothCurvatureFor(cset, cset.length);
    for (let k = 0; k < cset.length; k++) m.markVert(cset[k]);
    return cset.length;
  }

  /** メッシュを差し替えたときなど、溜まっている曲率更新を捨てる */
  dropPendingCurvature() {
    this.curvPending.length = 0;
    this.cvStampId++;
  }

  /**
   * 目標エッジ長（world）。ブラシ半径に比例させることで、
   * 「ブラシの見た目の大きさに対して一定のポリゴン密度」になる（Sculptris Pro 方式）。
   * detail 0 → ブラシ直径あたり約 9 分割、detail 1 → 約 44 分割。
   */
  targetEdgeLength(radius) {
    const d = clamp(this.state.detail, 0, 1);
    return radius * (0.22 - 0.175 * d);
  }

  // --- ストローク --------------------------------------------------------

  beginStroke(brush, point, dir) {
    const m = this.mesh;
    this.stroking = true;
    this.strokeBrush = brush;
    this.strokeDir = dir;
    this.topoChanged = false;
    this.dabCount = 0;
    this.engine.beginStroke();
    this.activeMirrors = buildMirrors(this.state.symmetry);

    for (let i = 0; i < this.activeMirrors.length; i++) {
      const ms = this.mirrors[i];
      const sgn = this.activeMirrors[i];
      V3.set(this._mp, point[0] * sgn[0], point[1] * sgn[1], point[2] * sgn[2]);
      ms.seed = nearestVertexBrute(m, this._mp);
      V3.copy(ms.lastPoint, this._mp);
      V3.copy(ms.center, this._mp);
      ms.lockedVerts = null;
      ms.lockedCount = 0;
    }
    V3.set(this._delta, 0, 0, 0);
    this._dabAll(point, this._delta, true);
  }

  /**
   * ストローク中のサンプル追加。前回位置から spacing 間隔でダブを打つので
   * フレームレートに依存しない。
   */
  addSample(point) {
    if (!this.stroking) return;
    const brush = this.strokeBrush;
    const radius = this.state.worldRadius;
    const ms0 = this.mirrors[0];

    if (brush === 'move') {
      // グラブ：領域を固定し、カーソル差分だけ動かす
      V3.sub(this._delta, point, ms0.lastPoint);
      if (V3.lenSq(this._delta) < 1e-14) return;
      this._dabAll(point, this._delta, false);
      return;
    }

    const spacing = Math.max(radius * 0.16, 1e-6);
    V3.sub(this._delta, point, ms0.lastPoint);
    let dist = V3.len(this._delta);
    if (dist < spacing) {
      if (usesDelta(brush)) return;
      // 動いていなくても圧を掛け続けたいブラシ（塗り系）は薄く継続
      if (brush === 'paint' || brush === 'mask' || brush === 'smooth') {
        V3.set(this._delta, 0, 0, 0);
        this._dabAll(point, this._delta, false, 0.35);
      }
      return;
    }

    // カーソルが大きく飛んだフレームで何十ダブも打つとフレームが数百 ms 固まる。
    // 上限本数に加えて時間予算でも打ち切り、1 フレームの作業量を有界にする。
    // 打ち切った場合も lastPoint は進めた所までなので、次フレームで続きから再開する。
    const steps = Math.min(32, Math.max(1, Math.floor(dist / spacing)));
    const step = this._step, p = this._walk;
    V3.scale(step, this._delta, 1 / steps);
    V3.copy(p, ms0.lastPoint);
    const budget = this.state.strokeBudgetMs > 0 ? this.state.strokeBudgetMs : Infinity;
    const t0 = budget === Infinity ? 0 : performance.now();
    for (let s = 0; s < steps; s++) {
      V3.add(p, p, step);
      this._dabAll(p, step, false);
      // 1 ダブが数十 ms かかることがあるので、間引かず毎回見る
      if (budget !== Infinity && performance.now() - t0 > budget) break;
    }
  }

  endStroke() {
    if (!this.stroking) return;
    this.stroking = false;
    const m = this.mesh;
    if (this.dabCount > 0) {
      // compact は頂点番号を詰め替えるので、その前に曲率を確定させる
      this.flushCurvature();
      if (m.compact()) {
        this.topoChanged = true;
        this.dropPendingCurvature();
      }
      this.history.commit(m);
    }
  }

  _dabAll(point, delta, first, scale = 1) {
    const mirrors = this.activeMirrors;
    for (let i = 0; i < mirrors.length; i++) {
      const sgn = mirrors[i];
      const ms = this.mirrors[i];
      V3.set(this._mp, point[0] * sgn[0], point[1] * sgn[1], point[2] * sgn[2]);
      V3.set(this._pt, delta[0] * sgn[0], delta[1] * sgn[1], delta[2] * sgn[2]);
      this._dab(ms, this._mp, this._pt, first, scale);
      V3.copy(ms.lastPoint, this._mp);
    }
    this.dabCount++;
  }

  _dab(ms, point, delta, first, scale) {
    const m = this.mesh;
    const st = this.state;
    const brush = this.strokeBrush;
    const radius = st.worldRadius;
    if (radius <= 0) return;

    // --- シード追従 -----------------------------------------------------
    let seed = descend(m, ms.seed, point);
    if (seed < 0) seed = nearestVertexBrute(m, point);
    else {
      const i = seed * 3, P = m.positions;
      const d = Math.hypot(P[i] - point[0], P[i + 1] - point[1], P[i + 2] - point[2]);
      const tol = Math.max(radius, this.targetEdgeLength(radius) * 3);
      if (d > tol) seed = nearestVertexBrute(m, point);
    }
    if (seed < 0) return;
    ms.seed = seed;

    // --- move ブラシ: 固定領域 ------------------------------------------
    if (brush === 'move') {
      if (first || !ms.lockedVerts) {
        this._gather(ms, point, radius);
        ms.lockedVerts = ms.verts.slice();
        ms.lockedCount = ms.count;
        V3.copy(ms.center, point);
      } else {
        V3.add(ms.center, ms.center, delta);
      }
      if (ms.lockedCount === 0) return;
      this.engine.apply(m, {
        type: 'move',
        verts: ms.lockedVerts, count: ms.lockedCount,
        center: ms.center, radius,
        strength: (st.effStrength !== undefined ? st.effStrength : st.strength) * scale, dir: this.strokeDir,
        delta, color: st.paintColor, ignoreMask: false,
        focal: st.focalShift, toCamera: st.toCamera, backface: st.backfaceMask,
      });
      this._updateNormals(ms.lockedVerts, ms.lockedCount);
      return;
    }

    // --- 領域収集 -------------------------------------------------------
    // 半径より少し広めに 1 回だけ集め、dyntopo とブラシ適用で共用する。
    // 半径の外側は減衰が 0 になるので、余分に含めても結果は変わらない。
    const gatherR = radius * 1.1;
    this._gather(ms, point, gatherR);

    // --- 動的トポロジ ---------------------------------------------------
    if (st.dynTopo && needsTopology(brush) && ms.count > 0) {
      const target = this.targetEdgeLength(radius);
      const moved = this._movedVerts;
      moved.length = 0;
      // 1 ダブで作れる頂点数を領域サイズに比例させる。粗い面に大きなブラシを
      // 当てたときに 1 フレームで数千頂点作って固まるのを防ぐ。
      // 上限に当たっても次のダブで続きが分割されるので、数フレームで目標密度に届く。
      const ch = refineRegion(m, ms.tris, point, radius, target, {
        subdivide: true,
        decimate: st.decimate,
        maxVerts: st.maxVerts,
        maxNewPerStep: Math.max(150, Math.min(300, ms.count)),
        moved,
      });
      if (ch) {
        this.topoChanged = true;
        // トポロジが変わったのでシードを取り直して領域を集め直す
        let s2 = descend(m, ms.seed, point);
        if (s2 < 0 || !m.isVertAlive(s2)) s2 = nearestVertexBrute(m, point);
        ms.seed = s2;
        if (s2 >= 0) this._gather(ms, point, gatherR);
        // 形状が動いたのはコラプス先だけなので、そこだけ法線を直せば足りる
        if (moved.length) this._updateNormals(moved, moved.length);
      }
    }

    if (ms.count === 0) return;

    this.engine.apply(m, {
      type: brush,
      verts: ms.verts, count: ms.count,
      center: point, radius,
      strength: (st.effStrength !== undefined ? st.effStrength : st.strength) * scale, dir: this.strokeDir,
      delta, color: st.paintColor,
      ignoreMask: brush === 'mask',
      focal: st.focalShift, toCamera: st.toCamera, backface: st.backfaceMask,
    });

    if (brush !== 'paint' && brush !== 'mask') {
      this._updateNormals(ms.verts, ms.count);
    }
  }

  // --- グローバル操作 ---------------------------------------------------

  clearMask() {
    const m = this.mesh;
    m.mask.fill(0, 0, m.nv);
    m.markAllDirty();
    this.history.commit(m);
  }

  invertMask() {
    const m = this.mesh;
    for (let v = 0; v < m.nv; v++) m.mask[v] = 1 - m.mask[v];
    m.markAllDirty();
    this.history.commit(m);
  }

  fillColor(rgb) {
    const m = this.mesh;
    for (let v = 0; v < m.nv; v++) {
      const mk = 1 - clamp(m.mask[v], 0, 1);
      const i = v * 3;
      m.colors[i] += (rgb[0] - m.colors[i]) * mk;
      m.colors[i + 1] += (rgb[1] - m.colors[i + 1]) * mk;
      m.colors[i + 2] += (rgb[2] - m.colors[i + 2]) * mk;
    }
    m.markAllDirty();
    this.history.commit(m);
  }

  /** 全体を数回ラプラシアン平滑化 */
  /** 保存データからメッシュを差し替える */
  loadGeometry(positions, indices, colors, mask) {
    const m = this.mesh;
    m.setGeometry(positions, indices, colors, mask);
    this._invalidateSeeds();
    this.levels.clear();
    this.history.reset(m);
  }

  smoothAll(iterations = 1, amount = 0.5) {
    const m = this.mesh;
    const P = m.positions, T = m.tris;
    const tmp = new Float32Array(m.nv * 3);
    for (let it = 0; it < iterations; it++) {
      for (let v = 0; v < m.nv; v++) {
        if (!m.isVertAlive(v)) continue;
        const r = m.ring[v];
        let sx = 0, sy = 0, sz = 0, c = 0;
        if (r) {
          for (let j = 0; j < r.length; j++) {
            const ti = r[j] * 3;
            for (let e = 0; e < 3; e++) {
              const u = T[ti + e];
              if (u === v) continue;
              const iu = u * 3;
              sx += P[iu]; sy += P[iu + 1]; sz += P[iu + 2]; c++;
            }
          }
        }
        const i = v * 3;
        if (c === 0) { tmp[i] = P[i]; tmp[i + 1] = P[i + 1]; tmp[i + 2] = P[i + 2]; continue; }
        const k = amount * (1 - clamp(m.mask[v], 0, 1));
        tmp[i] = P[i] + (sx / c - P[i]) * k;
        tmp[i + 1] = P[i + 1] + (sy / c - P[i + 1]) * k;
        tmp[i + 2] = P[i + 2] + (sz / c - P[i + 2]) * k;
      }
      P.set(tmp.subarray(0, m.nv * 3));
    }
    m.computeAllNormals();
    m.computeAllCurvature();
    m.markAllDirty();
    this.history.commit(m);
  }

  /**
   * ダイナメッシュ：ボクセル化 → 等値面抽出でトポロジを作り直す。
   * 自己交差や分離した部品が和集合として healing される。
   * @returns {object} 統計（頂点数・所要時間など）
   */
  async dynamesh(opts = {}) {
    const m = this.mesh;
    const r = await dynamesh(m, opts);
    if (r.positions.length === 0 || r.indices.length === 0) {
      return Object.assign({ failed: true }, r.stats);
    }
    m.setGeometry(r.positions, r.indices, r.colors);
    this._invalidateSeeds();
    this.levels.clear();          // 接続が変わるので分割レベルは破棄（ZBrush と同じ）
    this.history.commit(m);
    return r.stats;
  }

  _invalidateSeeds() {
    this.hoverSeed = -1;
    for (const ms of this.mirrors) { ms.seed = -1; ms.lockedVerts = null; ms.lockedCount = 0; }
  }

  // --- 分割レベル（SDiv） ------------------------------------------------

  divide() {
    const s = this.levels.divide(this.mesh);
    this._invalidateSeeds();
    this.history.commit(this.mesh);
    return s;
  }

  levelUp() {
    const s = this.levels.up(this.mesh);
    if (s) { this._invalidateSeeds(); this.history.commit(this.mesh); }
    return s;
  }

  levelDown() {
    const s = this.levels.down(this.mesh);
    if (s) { this._invalidateSeeds(); this.history.commit(this.mesh); }
    return s;
  }

  /** ストローク後などにレベルの整合性を確認する（トポロジが変わったら破棄される） */
  checkLevels() {
    return this.levels.validate(this.mesh);
  }

  /** 全体を目標エッジ長で均一化する（トポロジは組み替えない） */
  remeshUniform(targetLen) {
    const m = this.mesh;
    const bb = m.bounds();
    const center = V3.create(bb.center[0], bb.center[1], bb.center[2]);
    const radius = bb.radius * 4;
    const tris = [];
    for (let t = 0; t < m.nt; t++) if (m.isTriAlive(t)) tris.push(t);
    refineRegion(m, tris, center, radius, targetLen, {
      subdivide: true, decimate: true, maxVerts: this.state.maxVerts, maxNewPerStep: 400000,
    });
    m.compact();
    m.computeAllNormals();
    m.computeAllCurvature();
    this._invalidateSeeds();
    this.levels.clear();
    this.history.commit(m);
  }
}
