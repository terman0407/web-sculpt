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
import { RING_STRIDE } from './mesh.js';
import { BrushEngine, needsTopology, usesDelta } from './brushes.js';
import { refineRegion } from './dyntopo.js';
import { dynamesh } from './dynamesh.js';
import { SubdivLevels } from './subdiv.js';

// シンメトリの写像。ZBrush の Symmetry パネル相当で 3 種類を合成する:
//   * 平面ミラー   … 軸平面での反転（符号反転）
//   * ラジアル     … 軸まわりに N 回転コピー（Radial Symmetry）
//   * ローカル中心 … 原点ではなくモデル中心を基準にする（Local Symmetry）
// 「符号ベクトルの配列」だと回転が表せないので、写像そのものを記述にした。
//   p' = R(axis, ang) * (S ⊙ (p - c)) + c
export const MAX_MIRRORS = 64;

export function buildMirrors(sym, radial = null, center = null) {
  const cx = center ? center[0] : 0, cy = center ? center[1] : 0, cz = center ? center[2] : 0;
  // 1) 平面ミラー（符号の組み合わせ）
  let signs = [[1, 1, 1]];
  const axes = [[0, sym.x], [1, sym.y], [2, sym.z]];
  for (const [i, on] of axes) {
    if (!on) continue;
    const next = [];
    for (const m of signs) {
      next.push(m);
      const c = m.slice();
      c[i] = -c[i];
      next.push(c);
    }
    signs = next;
  }
  // 2) ラジアル（軸まわりの等分回転）
  const rc = radial && radial.on ? Math.max(1, Math.min(32, Math.round(radial.count || 1))) : 1;
  const rAxis = radial ? (radial.axis | 0) : 1;
  const out = [];
  for (let k = 0; k < rc && out.length < MAX_MIRRORS; k++) {
    const ang = rc > 1 ? (Math.PI * 2 * k) / rc : 0;
    for (const s of signs) {
      if (out.length >= MAX_MIRRORS) break;
      out.push({ s, ang, axis: rAxis, c: [cx, cy, cz], flip: s[0] * s[1] * s[2] < 0 });
    }
  }
  return out;
}

/** 軸 axis まわりに角 ang だけ回す（axis 成分は変えない） */
function rotAxis(axis, ang, x, y, z, out) {
  if (ang === 0) { out[0] = x; out[1] = y; out[2] = z; return out; }
  const cs = Math.cos(ang), sn = Math.sin(ang);
  if (axis === 0) { out[0] = x; out[1] = y * cs - z * sn; out[2] = y * sn + z * cs; }
  else if (axis === 1) { out[0] = x * cs + z * sn; out[1] = y; out[2] = -x * sn + z * cs; }
  else { out[0] = x * cs - y * sn; out[1] = x * sn + y * cs; out[2] = z; }
  return out;
}

/** 点をミラー先へ写す */
export function mirrorPoint(mir, p, out) {
  const s = mir.s, c = mir.c;
  rotAxis(mir.axis, mir.ang,
    (p[0] - c[0]) * s[0], (p[1] - c[1]) * s[1], (p[2] - c[2]) * s[2], out);
  out[0] += c[0]; out[1] += c[1]; out[2] += c[2];
  return out;
}

/** ベクトル（ドラッグ差分など）をミラー先へ写す。平行移動は掛けない */
export function mirrorVector(mir, v, out) {
  const s = mir.s;
  return rotAxis(mir.axis, mir.ang, v[0] * s[0], v[1] * s[1], v[2] * s[2], out);
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
  const RC = mesh.ringCount, RD = mesh.ringData;
  for (let s = 0; s < maxSteps; s++) {
    const rc = RC[cur];
    if (rc === 0) return cur;
    const base = rc <= RING_STRIDE ? cur * RING_STRIDE : -1;
    const ex = base < 0 ? mesh.ringExt[cur] : null;
    let next = -1, nd = cd;
    for (let j = 0; j < rc; j++) {
      const ti = (ex ? ex[j] : RD[base + j]) * 3;
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
    // verts / tris は Sculptor が持つ共有スクラッチ配列を指す。
    // 次に _gather を呼ぶまでしか有効でない（_dab はミラーごとに
    // 収集 → 適用 → 法線更新まで完結するので、これで足りる）。
    this.verts = null;
    this.tris = null;
    this.count = 0;
    this.triCount = 0;
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
    // 領域は 1 ダブで数万頂点になる。ここを JS 配列 + push で持つと
    // 1 ダブあたり十数万回の push になり、それ自体が数 ms かかっていた。
    // すべて Int32Array + 件数カウンタに置き換えてある。
    this.gTris = new Int32Array(0);   // _gather が集めた三角形
    this.normalSet = new Int32Array(0);
    this.normalCount = 0;
    this.curvSet = new Int32Array(0);
    this.curvCount = 0;
    this.curvPending = new Int32Array(0);   // フレーム末にまとめて曲率を直す頂点
    this.curvPendCount = 0;
    this.cvStamp = new Int32Array(0);
    this.cvStampId = 1;
    this._movedVerts = [];      // dyntopo のコラプスで位置が動いた頂点（数十個なので配列のまま）
    this.nStamp = new Int32Array(0);
    this.levels = new SubdivLevels();

    this.mirrors = [];
    for (let i = 0; i < 8; i++) this.mirrors.push(new MirrorState());
    this.activeMirrors = buildMirrors({ x: false, y: false, z: false });

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
    this._avgDabMs = 0;         // 1 ダブの実測コスト（EMA）
    this._walk = V3.create();

    this.history.reset(mesh);
  }

  /**
   * いまの state からミラー写像の一覧を作る。
   * ローカルシンメトリはモデルの中心を基準にするので bounds を見る
   * （毎ダブではなくストローク開始時に 1 回だけ呼ばれる）。
   */
  buildActiveMirrors() {
    const st = this.state;
    let center = null;
    if (st.localSymmetry) center = this.mesh.bounds().center;
    return buildMirrors(st.symmetry, st.radial, center);
  }

  setMesh(mesh) {
    this.mesh = mesh;
    this.history.reset(mesh);
    this.stroking = false;
    this.hoverSeed = -1;
    this._avgDabMs = 0;
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

  /** list を count 件入る大きさまで広げる（内容は保持する） */
  static _grow(list, count) {
    if (list.length >= count) return list;
    const a = new Int32Array(Math.max(1024, count, list.length * 2));
    a.set(list);
    return a;
  }

  /**
   * ブラシ球内の連結頂点と、それに接する三角形を収集。
   *
   * 頂点リストは BFS のキューそのもの（取り出した順 = 収集順）なので、
   * 別配列に積み直さずキューを ms.verts として使い回す。
   */
  _gather(ms, center, radius) {
    const m = this.mesh;
    this._ensureStamps();
    const id = ++this.stamp;
    const vS = this.vStamp, tS = this.tStamp, q = this.queue;
    const P = m.positions, T = m.tris;
    const RC = m.ringCount, RD = m.ringData, REX = m.ringExt;
    const qlen = q.length;
    let TR = this.gTris;
    ms.verts = q; ms.tris = TR;
    ms.count = 0; ms.triCount = 0;

    const cx = center[0], cy = center[1], cz = center[2];
    const r2 = radius * radius;
    let head = 0, tail = 0, nt = 0;

    const seed = ms.seed;
    if (seed < 0 || seed >= m.nv || !m.isVertAlive(seed)) return;
    vS[seed] = id;
    q[tail++] = seed;

    while (head < tail) {
      const v = q[head++];
      const rc = RC[v];
      if (rc === 0) continue;
      const inline = rc <= RING_STRIDE;
      const rbase = inline ? v * RING_STRIDE : 0;
      const rex = inline ? null : REX[v];
      if (nt + rc > TR.length) { TR = Sculptor._grow(TR, nt + rc); this.gTris = TR; ms.tris = TR; }
      for (let j = 0; j < rc; j++) {
        const t = inline ? RD[rbase + j] : rex[j];
        if (tS[t] !== id) { tS[t] = id; TR[nt++] = t; }
        const ti = t * 3;
        // 3 頂点は毎回全部見るのでループを展開する
        let u = T[ti];
        if (vS[u] !== id) {
          vS[u] = id;
          const ui = u * 3;
          const dx = P[ui] - cx, dy = P[ui + 1] - cy, dz = P[ui + 2] - cz;
          if (dx * dx + dy * dy + dz * dz <= r2 && tail < qlen) q[tail++] = u;
        }
        u = T[ti + 1];
        if (vS[u] !== id) {
          vS[u] = id;
          const ui = u * 3;
          const dx = P[ui] - cx, dy = P[ui + 1] - cy, dz = P[ui + 2] - cz;
          if (dx * dx + dy * dy + dz * dz <= r2 && tail < qlen) q[tail++] = u;
        }
        u = T[ti + 2];
        if (vS[u] !== id) {
          vS[u] = id;
          const ui = u * 3;
          const dx = P[ui] - cx, dy = P[ui + 1] - cy, dz = P[ui + 2] - cz;
          if (dx * dx + dy * dy + dz * dz <= r2 && tail < qlen) q[tail++] = u;
        }
      }
    }
    ms.count = tail;
    ms.triCount = nt;
  }

  /**
   * 移動した頂点とその近傍の法線と曲率を再計算する。
   * 曲率は 1-ring 平均に依存するので、法線より 1 段広い範囲を更新する。
   */
  /**
   * @param verts 動いた頂点
   * @param count 有効数
   * @param tris  verts に接する三角形（_gather が集めたものをそのまま渡す）。
   *              渡すと ring を辿り直さずに済むぶん大幅に速い。
   */
  _updateNormals(verts, count, tris = null, triCount = 0) {
    const m = this.mesh;
    this._ensureStamps();
    const T = m.tris;

    // 1 段目: 移動頂点 + その 1-ring（法線の更新範囲）
    const id1 = ++this.stamp;
    const nS = this.nStamp;
    // tris 経路の上限は count + triCount*3 で確定するので先に確保しておく
    // （以降は境界確認が要らない）。ring 経路は上限が読めないので途中で広げる。
    const bound = tris ? count + triCount * 3 : count + 64;
    let set = this.normalSet;
    if (set.length < bound) { set = new Int32Array(Math.max(1024, bound)); this.normalSet = set; }
    let ns = 0;
    if (tris) {
      // 「verts に接する三角形の全頂点」= verts + その 1-ring。
      // 三角形リストを 1 回舐めるだけで済み、ring の間接参照が消える。
      for (let k = 0; k < count; k++) {
        const v = verts[k];
        if (nS[v] !== id1) { nS[v] = id1; set[ns++] = v; }
      }
      for (let k = 0; k < triCount; k++) {
        const ti = tris[k] * 3;
        let u = T[ti];
        if (nS[u] !== id1) { nS[u] = id1; set[ns++] = u; }
        u = T[ti + 1];
        if (nS[u] !== id1) { nS[u] = id1; set[ns++] = u; }
        u = T[ti + 2];
        if (nS[u] !== id1) { nS[u] = id1; set[ns++] = u; }
      }
    } else {
      const RC = m.ringCount, RD = m.ringData, REX = m.ringExt;
      for (let k = 0; k < count; k++) {
        const v = verts[k];
        if (nS[v] !== id1) { nS[v] = id1; set[ns++] = v; }
        const rc = RC[v];
        if (rc === 0) continue;
        const inline = rc <= RING_STRIDE;
        const rb = inline ? v * RING_STRIDE : 0;
        const rex = inline ? null : REX[v];
        if (ns + rc * 3 > set.length) { set = Sculptor._grow(set, ns + rc * 3); this.normalSet = set; }
        for (let j = 0; j < rc; j++) {
          const ti = (inline ? RD[rb + j] : rex[j]) * 3;
          let u = T[ti];
          if (nS[u] !== id1) { nS[u] = id1; set[ns++] = u; }
          u = T[ti + 1];
          if (nS[u] !== id1) { nS[u] = id1; set[ns++] = u; }
          u = T[ti + 2];
          if (nS[u] !== id1) { nS[u] = id1; set[ns++] = u; }
        }
      }
    }
    this.normalCount = ns;
    // 面法線を 1 面 1 回だけ計算する版も試したが、そのための三角形集合を
    // 作るコストのほうが上回ったので頂点ごとの計算のままにしてある。
    m.computeNormalsFor(set, ns);

    // 曲率は見た目（キャビティ陰影）にしか使わず、彫刻の挙動には影響しない。
    // 1 フレームに何十ダブも打たれるので、ここでは「後で計算する頂点」を
    // 積むだけにして、実際の計算はフレーム末に 1 回だけ行う。
    const cs = this.cvStamp, cid = this.cvStampId;
    let pend = this.curvPending, pn = this.curvPendCount;
    if (pn + ns > pend.length) { pend = Sculptor._grow(pend, pn + ns); this.curvPending = pend; }
    for (let k = 0; k < ns; k++) {
      const v = set[k];
      if (cs[v] !== cid) { cs[v] = cid; pend[pn++] = v; }
    }
    this.curvPendCount = pn;
  }

  /**
   * 溜まっていた曲率の再計算をまとめて行う。毎フレーム 1 回、描画前に呼ぶ。
   * @returns {number} 更新した頂点数
   */
  flushCurvature() {
    const pend = this.curvPending;
    const pn = this.curvPendCount;
    if (pn === 0) return 0;
    const m = this.mesh;
    this._ensureStamps();

    // pend には既に「動いた頂点 + その 1-ring」が入っている（_updateNormals が
    // 法線更新の対象として積んだもの）。ここでさらに 1-ring 広げると集合が 3 倍に
    // 膨らみ、高密度では 1 フレーム 30ms 近くかかる。曲率は陰影にしか効かず、
    // 境界のわずかな誤差は次のダブで上書きされるので広げない。
    const id = ++this.stamp;
    const nS = this.nStamp;
    let cset = this.curvSet;
    if (cset.length < pn) { cset = new Int32Array(Math.max(1024, pn)); this.curvSet = cset; }
    let cn = 0;
    for (let k = 0; k < pn; k++) {
      const v = pend[k];
      if (v >= m.nv || !m.isVertAlive(v)) continue;
      if (nS[v] !== id) { nS[v] = id; cset[cn++] = v; }
    }
    this.curvPendCount = 0;
    this.curvCount = cn;
    this.cvStampId++;
    if (cn === 0) return 0;
    m.computeCurvatureFor(cset, cn);
    m.smoothCurvatureFor(cset, cn);
    for (let k = 0; k < cn; k++) m.markVert(cset[k]);
    return cn;
  }

  /** メッシュを差し替えたときなど、溜まっている曲率更新を捨てる */
  dropPendingCurvature() {
    this.curvPendCount = 0;
    this.cvStampId++;
  }

  /**
   * 目標エッジ長（world）。ブラシ半径に比例させることで、
   * 「ブラシの見た目の大きさに対して一定のポリゴン密度」になる（Sculptris Pro 方式）。
   * detail 0 → ブラシ直径あたり約 9 分割、detail 1 → 約 44 分割。
   */
  /**
   * point に近い頂点を返す。まず候補（前回のシード）から 1-ring 降下し、
   * 遠すぎるときだけ全走査に落とす。260 万頂点だと全走査は 1 回 45ms かかるので、
   * ストローク開始のたびに走らせると無視できないヒッチになる。
   */
  _seedNear(point, hint) {
    const m = this.mesh;
    if (m.liveVerts === 0) return -1;
    if (hint >= 0 && hint < m.nv && m.isVertAlive(hint)) {
      const s = descend(m, hint, point);
      if (s >= 0) {
        const i = s * 3, P = m.positions;
        const d = Math.hypot(P[i] - point[0], P[i + 1] - point[1], P[i + 2] - point[2]);
        const tol = Math.max(this.state.worldRadius, this.targetEdgeLength(this.state.worldRadius) * 4);
        if (d <= tol) return s;
      }
    }
    return nearestVertexBrute(m, point);
  }

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
    this.activeMirrors = this.buildActiveMirrors();
    // ラジアルシンメトリでミラー数が増えるので、足りなければ足す
    while (this.mirrors.length < this.activeMirrors.length) this.mirrors.push(new MirrorState());

    for (let i = 0; i < this.activeMirrors.length; i++) {
      const ms = this.mirrors[i];
      mirrorPoint(this.activeMirrors[i], point, this._mp);
      // 全頂点走査は 260 万頂点で 1 ミラーあたり 45ms かかる。
      // ホバー中に追従させているシードから降下すれば通常はそれで足りる。
      ms.seed = this._seedNear(this._mp, i === 0 ? this.hoverSeed : this.mirrors[i].seed);
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

    // ダブ間隔。0.16R だと通常のドラッグ速度で 3 フレームに 1 回しか置かれず、
    // ストロークが「点を並べた」ように見える。細かくして、そのぶん 1 ダブの
    // 強さを間隔に比例させると、総量を変えずに連続的な当たりになる。
    const spacingFrac = (this.state.dabSpacing > 0 ? this.state.dabSpacing : 0.16);
    const budgetMs = this.state.strokeBudgetMs > 0 ? this.state.strokeBudgetMs : 12;
    // 1 ダブの実測コストが予算を超える密度では、間隔そのものを広げる。
    // そうしないと「毎フレーム 1 ダブ = 毎フレーム数十 ms」で固まってしまう。
    // 軽い状況では係数 1 のままなので、設定した細かい間隔がそのまま効く。
    const load = this._avgDabMs > 0.05 ? Math.max(1, this._avgDabMs / budgetMs) : 1;
    const spacing = Math.max(radius * spacingFrac * load, 1e-6);
    V3.sub(this._delta, point, ms0.lastPoint);
    let dist = V3.len(this._delta);
    if (dist < spacing) {
      if (usesDelta(brush)) return;
      // 動いていなくても圧を掛け続けたいブラシ（塗り系）は薄く継続
      if (brush === 'paint' || brush === 'mask' || brush === 'smooth') {
        V3.set(this._delta, 0, 0, 0);
        this._dabAll(point, this._delta, false, 0.35 * spacingFrac / 0.16);
      }
      return;
    }

    // カーソルが大きく飛んだフレームで何十ダブも打つとフレームが数百 ms 固まる。
    // 上限本数に加えて時間予算でも打ち切り、1 フレームの作業量を有界にする。
    // 打ち切った場合も lastPoint は進めた所までなので、次フレームで続きから再開する。
    let steps = Math.min(64, Math.max(1, Math.floor(dist / spacing)));

    // 1 ダブの実測コストから、このフレームで打てる本数を見積もって上限にする。
    // 高密度では 1 ダブ数十 ms かかるので、間隔だけ細かくすると毎フレーム
    // 数百 ms 固まってしまう。逆に軽い状況では細かい間隔がそのまま通る。
    if (this._avgDabMs > 0.05) {
      const affordable = Math.max(1, Math.floor(budgetMs / this._avgDabMs));
      if (steps > affordable) steps = affordable;
    }

    // 1 ダブの強さは「実際に進んだ距離」に比例させる。こうすると間隔を変えても
    // 本数が制限されても、ストローク全体で置かれる量がほぼ一定になる。
    const dabScale = clamp((dist / steps) / (radius * 0.16), 0.05, 4);

    const step = this._step, p = this._walk;
    V3.scale(step, this._delta, 1 / steps);
    V3.copy(p, ms0.lastPoint);
    const budget = budgetMs;
    const tStart = performance.now();
    let done = 0;
    for (let s = 0; s < steps; s++) {
      V3.add(p, p, step);
      this._dabAll(p, step, false, dabScale);
      done++;
      // 1 ダブが数十 ms かかることがあるので、間引かず毎回見る
      if (performance.now() - tStart > budget) break;
    }
    // 実測コストを指数移動平均で覚えておく（次フレームの本数見積もりに使う）
    if (done > 0) {
      const per = (performance.now() - tStart) / done;
      this._avgDabMs = this._avgDabMs > 0 ? this._avgDabMs * 0.7 + per * 0.3 : per;
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
      const ms = this.mirrors[i];
      mirrorPoint(mirrors[i], point, this._mp);
      mirrorVector(mirrors[i], delta, this._pt);
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
        ms.lockedVerts = ms.verts.slice(0, ms.count);
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
      const ch = refineRegion(m, ms.tris, ms.triCount, point, radius, target, {
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
      this._updateNormals(ms.verts, ms.count, ms.tris, ms.triCount);
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
        const rc = m.ringCount[v];
        const rb = rc <= RING_STRIDE ? v * RING_STRIDE : -1;
        const rex = rb < 0 ? m.ringExt[v] : null;
        let sx = 0, sy = 0, sz = 0, c = 0;
        {
          for (let j = 0; j < rc; j++) {
            const ti = (rex ? rex[j] : m.ringData[rb + j]) * 3;
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
    const tris = new Int32Array(m.liveTris);
    let nTris = 0;
    for (let t = 0; t < m.nt; t++) if (m.isTriAlive(t)) tris[nTris++] = t;
    refineRegion(m, tris, nTris, center, radius, targetLen, {
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
