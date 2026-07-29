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
import { STROKE_BY_ID, strokeDefaults, DEFAULT_STROKE } from './alpha.js';

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

/**
 * 決定論的な 0..1 の擬似乱数。ストロークのスプレーに使う。
 *
 * Math.random を使うと同じストロークを再生しても結果が変わり、
 * Undo → やり直しで形が変わってしまう。ダブ番号とストロークの種から
 * 決まるハッシュにしておけば、いつ何度実行しても同じ模様になる。
 * （alpha.js の spray と同じ方針。あちらは planDabs の中で自前に持っている）
 */
function hash01(n, seed) {
  let h = (n | 0) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
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
    // 直前の履歴を渡すと、接続が変わっていなければ tris などを共有してくれる
    this.states.push(mesh.snapshot(this.states[this.states.length - 1]));
    this.cur = this.states.length - 1;
    // 件数とメモリ量の両方で古い履歴を捨てる（最新 2 件は必ず残す）
    while (this.states.length > this.limit
      || (this.states.length > 2 && this.bytes() > this.byteLimit)) {
      this.states.shift();
      // 捨てた履歴が持っていた配列を後続が共有していることがある。共有されて
      // いる限り解放されないので、残った先頭を「持ち主」に付け替えないと
      // bytes() がそのぶんを数え落とす（実際には減っていないのに減ったと見える）。
      if (this.states.length) this.states[0].shared = [];
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
  /**
   * 履歴が実際に抱えているバイト数。
   * 前の履歴と共有している配列は数えない（1 本を複数の履歴が指しているだけなので、
   * 数えると実際の何倍にも見えて履歴が早く捨てられる）。
   */
  bytes() {
    let b = 0;
    for (const s of this.states) {
      const sh = s.shared || [];
      for (const k of ['positions', 'colors', 'mask', 'vAlive', 'tris']) {
        if (!sh.includes(k)) b += s[k].byteLength;
      }
    }
    return b;
  }

  /** 履歴の内訳（診断とテスト用） */
  info() {
    let sharedArrays = 0;
    for (const s of this.states) sharedArrays += (s.shared || []).length;
    return {
      states: this.states.length, cur: this.cur, sharedArrays,
      bytes: this.bytes(), limit: this.limit, byteLimit: this.byteLimit,
    };
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
    // 彫刻の差分を記録したい人（スカルプトレイヤー）を挿すための穴。
    // { before(mesh, verts, count), after(mesh, verts, count) } を持つオブジェクト。
    // sculptor が layers.js を直接 import すると依存が逆流するので、
    // 外から差してもらう形にしてある。
    this.recorder = null;
    this.morphHook = null;   // モーフブラシの実処理（tools が差す）

    // ブラシアルファ用のダブ接平面。ダブごとに作り直して brushes へ渡す。
    this._tanU = V3.create();
    this._tanV = V3.create();
    this._alphaRot = 0;
    this._dabSeq = 0;          // ストローク内のダブ番号（スプレーの乱数の種）
    this.strokeSeed = 0;
    this._spray = V3.create();
    this._sizeMul = 1;
    this._mirCenters = null;   // 全ミラーのダブ中心（担当分け用）
    this._mirCount = 1;
    this._mirIndex = 0;
    this._ownBuf = null;
    this._snapPos = null;      // ダブ開始時の座標（持ち分の判定用）
    this._snapStamp = null;
    this._snapId = 0;
    this._snapTouched = null;
    this._snapTouchedCount = 0;
    this._mirMat = null;       // ミラーの 3x3 行列 + 中心（不動点判定用）
    this._mirMatCount = 0;
    this._symEps = 1e-9;
    this._frameN0 = V3.create();   // ミラー 0 のブラシ向き
    this._frameC0 = V3.create();   // ミラー 0 の重心
    this._frameN = V3.create();
    this._frameC = V3.create();
    this._frameOK = false;
    this._useFrame = false;
    this._strokeId = DEFAULT_STROKE;
    this._strokeParams = strokeDefaults(DEFAULT_STROKE);

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
    this._dabSeq = 0;
    // ストロークごとの乱数の種。決定論にしたいので時計は使わず、
    // ストローク番号と開始位置から作る（同じ操作なら同じ模様になる）。
    this.strokeSeed = (this.engine.strokeId * 2654435761
      + Math.round(point[0] * 8191) * 40503
      + Math.round(point[1] * 8191) * 7919
      + Math.round(point[2] * 8191) * 104729) | 0;
    const sid = this.state.stroke || DEFAULT_STROKE;
    this._strokeId = STROKE_BY_ID.has(sid) ? sid : DEFAULT_STROKE;
    this._strokeParams = Object.assign(strokeDefaults(this._strokeId),
      (this.state.strokeParams && this.state.strokeParams[this._strokeId]) || {});
    this.engine.beginStroke();
    this.activeMirrors = this.buildActiveMirrors();
    this._buildMirrorMatrices();
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
    // スプレー系のストロークは、ダブごとに位置を接平面上でばらつかせ、
    // 半径にもゆらぎを入れる。ミラーより手前で 1 回だけ計算して、
    // ミラー先にも同じ散らしが写るようにする（左右対称を保つため）。
    const sp = this._strokeParams;
    let sPoint = point, sScale = scale;
    this._sizeMul = 1;
    if (sp && (sp.scatter > 0 || sp.sizeJitter > 0)) {
      this._updateDabFrame(this.mirrors[0], delta);
      const r = this.state.worldRadius;
      const seq = this._dabSeq;
      if (sp.scatter > 0) {
        const a = hash01(seq * 4 + 1, this.strokeSeed) * Math.PI * 2;
        const rr = Math.sqrt(hash01(seq * 4 + 2, this.strokeSeed)) * sp.scatter * r;
        const U = this._tanU, V = this._tanV;
        const ox = Math.cos(a) * rr, oy = Math.sin(a) * rr;
        V3.set(this._spray,
          point[0] + U[0] * ox + V[0] * oy,
          point[1] + U[1] * ox + V[1] * oy,
          point[2] + U[2] * ox + V[2] * oy);
        sPoint = this._spray;
      }
      if (sp.sizeJitter > 0) {
        // 0.35〜1.0 の範囲で縮める。大きくする方向へ振ると領域が広がって重くなる
        this._sizeMul = 1 - hash01(seq * 4 + 3, this.strokeSeed) * sp.sizeJitter * 0.65;
      }
    }
    // 担当分けのために、全ミラーのダブ中心を先に集めておく
    const nm = mirrors.length;
    if (!this._mirCenters || this._mirCenters.length < nm * 3) this._mirCenters = new Float32Array(nm * 3);
    const MC = this._mirCenters;
    this._mirCount = nm;
    for (let i = 0; i < nm; i++) {
      mirrorPoint(mirrors[i], sPoint, this._mp);
      MC[i * 3] = this._mp[0]; MC[i * 3 + 1] = this._mp[1]; MC[i * 3 + 2] = this._mp[2];
    }
    // ブラシの向き（平均法線）と重心は 1 枚目のミラーが求めたものを鏡像にして使う。
    // 2 枚目以降が自分で計算すると、1 枚目が既に動かした頂点まで平均に入って
    // 左右で値が変わり、頂点単位のずれがストロークごとに溜まっていた
    // （実測: 6 ストロークで 1.5e-3 → 7.1e-3）。
    this._frameOK = false;
    if (nm > 1) { this._snapId = (this._snapId || 0) + 1; this._snapTouchedCount = 0; }
    for (let i = 0; i < nm; i++) {
      const ms = this.mirrors[i];
      V3.set(this._mp, MC[i * 3], MC[i * 3 + 1], MC[i * 3 + 2]);
      mirrorVector(mirrors[i], delta, this._pt);
      this._mirIndex = i;
      if (nm > 1 && i > 0 && this._frameOK) {
        mirrorVector(mirrors[i], this._frameN0, this._frameN);
        mirrorPoint(mirrors[i], this._frameC0, this._frameC);
        this._useFrame = true;
      } else {
        this._useFrame = false;
      }
      this._dab(ms, this._mp, this._pt, first, sScale);
      // 1 枚目が実際にブラシを掛けたときのフレームを控える
      if (nm > 1 && i === 0) {
        const an = this.engine.avgN;
        if (an[0] || an[1] || an[2]) {
          V3.copy(this._frameN0, an);
          V3.copy(this._frameC0, this.engine.centroid);
          this._frameOK = true;
        }
      }
      V3.copy(ms.lastPoint, this._mp);
    }
    // 全ミラーを掛けたあとに、平面／軸の上の頂点を制約へ戻す
    this._enforceSymmetry();
    this.dabCount++;
    this._dabSeq++;
  }

  /**
   * ミラー領域が重なる部分の担当を決める。
   *
   * シンメトリ平面の近くを彫ると、その頂点は複数のミラーの領域に入る。
   * 素直に順番へ適用すると
   *   * 減衰が 2 回掛かって中心線付近だけ倍の深さになる
   *     （実測: 平面上に 1 ダブで変位 5.46e-2 → 1.08e-1 とちょうど 2 倍）
   *   * 1 つめのミラーが動かした結果を 2 つめが読むので、左右で結果が違う
   * という 2 つの問題が出る。
   *
   * そこで「その頂点にいちばん近いダブ中心を持つミラーが書き込む」ことにする。
   * 鏡像なら半空間の分割、ラジアルなら軸まわりの扇形の分割になり、
   * ミラー群の作用で担当セルが入れ替わるだけなので**構成として対称**になる。
   * 担当が重ならないので適用順にも依存しない。
   *
   * ただし「どれか 1 枚だけ」にすると、シンメトリ平面の**上**にある頂点が
   * 平面から押し出されてしまう。平面上の頂点は自分自身が鏡像なので、
   * 以前は 2 枚のミラーの X 成分が打ち消し合って平面上に留まっていたのが、
   * 1 枚だけにしたことで打ち消されなくなる（実測: 8 頂点が 3.6e-2 ずれた）。
   * そこで同距離のミラーには 1/枚数 ずつ持ち分を配る。こうすると
   *   * 合計の大きさは 1 ダブぶん（二重にならない）
   *   * 平面に垂直な成分は打ち消し合う（平面上に留まる）
   * の両方が成り立つ。ZBrush で継ぎ目が割れないのと同じ挙動になる。
   *
   * 平均法線と重心は担当外の頂点も入れて計算する（brushes 側で重みへ掛けるのは
   * その計算のあと）。半分だけで平均すると法線が平面側へ傾き、継ぎ目が折れる。
   *
   * @returns {Float32Array|null} 領域頂点ごとの持ち分 0..1。ミラーが 1 枚なら null
   */
  /**
   * ダブ開始時の座標を控える（持ち分の判定に使う）。
   * ミラーごとに、その領域のうちまだ控えていない頂点だけを記録する。
   * 全頂点ぶんの配列は capV × 3 で 260 万頂点なら 31MB になるので、
   * シンメトリが 2 枚以上のときだけ確保する。
   */
  _snapshotRegion(verts, count) {
    const m = this.mesh;
    if (!this._snapPos || this._snapPos.length < m.capV * 3) {
      this._snapPos = new Float32Array(m.capV * 3);
      this._snapStamp = new Int32Array(m.capV);
      this._snapId = 1;
    }
    if (!this._snapTouched || this._snapTouched.length < m.capV) {
      this._snapTouched = new Int32Array(m.capV);
    }
    const SP = this._snapPos, SS = this._snapStamp, sid = this._snapId, P = m.positions;
    const TL = this._snapTouched;
    let tn = this._snapTouchedCount;
    for (let k = 0; k < count; k++) {
      const v = verts[k];
      if (SS[v] === sid) continue;
      SS[v] = sid;
      const i = v * 3;
      SP[i] = P[i]; SP[i + 1] = P[i + 1]; SP[i + 2] = P[i + 2];
      if (tn < TL.length) TL[tn++] = v;
    }
    this._snapTouchedCount = tn;
  }

  /**
   * ミラーの線形部分を 3x3 行列にして控える（ストローク開始時に 1 回）。
   * 不動点判定はホットループなので、mirrorPoint の呼び出しではなく
   * ここで作った行列でインライン展開する。
   * 並びは 1 ミラーあたり 12 要素: m00..m22（行優先）, cx, cy, cz。
   */
  _buildMirrorMatrices() {
    const mirrors = this.activeMirrors;
    const nm = mirrors.length;
    if (!this._mirMat || this._mirMat.length < nm * 12) this._mirMat = new Float64Array(nm * 12);
    const M = this._mirMat;
    for (let j = 0; j < nm; j++) {
      const mir = mirrors[j];
      const s = mir.s, ang = mir.ang, ax = mir.axis;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      // R(ax, ang) の 3x3
      let r00 = 1, r01 = 0, r02 = 0, r10 = 0, r11 = 1, r12 = 0, r20 = 0, r21 = 0, r22 = 1;
      if (ang !== 0) {
        if (ax === 0) { r11 = cs; r12 = -sn; r21 = sn; r22 = cs; }
        else if (ax === 1) { r00 = cs; r02 = sn; r20 = -sn; r22 = cs; }
        else { r00 = cs; r01 = -sn; r10 = sn; r11 = cs; }
      }
      // M = R * diag(s)
      const o = j * 12;
      M[o] = r00 * s[0]; M[o + 1] = r01 * s[1]; M[o + 2] = r02 * s[2];
      M[o + 3] = r10 * s[0]; M[o + 4] = r11 * s[1]; M[o + 5] = r12 * s[2];
      M[o + 6] = r20 * s[0]; M[o + 7] = r21 * s[1]; M[o + 8] = r22 * s[2];
      M[o + 9] = mir.c[0]; M[o + 10] = mir.c[1]; M[o + 11] = mir.c[2];
    }
    this._mirMatCount = nm;
    // 不動点判定のしきい値。回転行列の sin(π) が 1.2e-16 なので厳密比較では
    // 180 度回転を含む群を取りこぼす。bounds() はここで 1 回だけ見る
    // （毎ダブ呼ぶと 260 万頂点で全体の 3 割を食っていた）。
    this._symEps = 1e-9 * Math.max(1, this.mesh.bounds().radius);
  }

  /**
   * ミラー群の不動点にある頂点を、その制約の上に留める。
   *
   * シンメトリ平面の上にある頂点は自分自身が鏡像なので、対称性から
   * 「平面に垂直な向きには動けない」。これは近似ではなく制約なので、
   * 明示的に課すのが正しい。
   *
   * 課さないと何が起きるか（実測）: 持ち分を 0.5 ずつ配っても、ミラー 1 の
   * 減衰重みはミラー 0 が動かした後の座標で計算されるため X が完全には
   * 打ち消されない（+1.32e-3 と -1.10e-3 で残差 2.18e-4）。すると次のダブでは
   * もう「同距離」と判定されず持ち分が 1.0 と 0.0 に割れて片側だけが動き、
   * 1 ストロークで 7.8e-3、6 ストロークで 9.1e-2 まで暴走していた。
   *
   * どの面／軸が不動点になるかを state のフラグから決めてはいけない。
   * 例えば「X ミラー + Y 軸まわり 4 分割」の群には Z 平面の鏡映も含まれる
   * （180 度回転 × X 反転 = Z 反転）。実測でその 8 頂点だけが 6.4e-2 ずれていた。
   * そこでミラー集合そのものを見て、
   *   「スナップショット位置を自分自身へ写すミラー」＝ その頂点の安定化部分群
   * を求め、その群にわたって現在位置を平均する。有限群の平均は不変部分空間への
   * 射影になるので、面・軸・それらの交わりを区別せず一様に正しく扱える。
   *
   * 対象はダブ開始時のスナップショットに入っている頂点だけ（このダブで
   * 触った可能性がある頂点）。全頂点を毎ダブ走査すると 260 万頂点で重すぎる。
   */
  _enforceSymmetry() {
    const nm = this._mirCount;
    if (nm <= 1) return;
    const SS = this._snapStamp, SP = this._snapPos, sid = this._snapId;
    if (!SS) return;
    const M = this._mirMat;
    if (!M || this._mirMatCount < nm) return;
    const P = this.mesh.positions;
    const verts = this._snapTouched;
    const n = this._snapTouchedCount;
    const eps = this._symEps;
    const eps2 = eps * eps;

    for (let k = 0; k < n; k++) {
      const v = verts[k];
      if (SS[v] !== sid) continue;
      const i = v * 3;
      const sx = SP[i], sy = SP[i + 1], sz = SP[i + 2];
      const cx = P[i], cy = P[i + 1], cz = P[i + 2];
      let cnt = 0;
      let ax = cx, ay = cy, az = cz;
      for (let j = 1; j < nm; j++) {
        const o = j * 12;
        const ox = M[o + 9], oy = M[o + 10], oz = M[o + 11];
        // スナップショット位置の像
        const dx = sx - ox, dy = sy - oy, dz = sz - oz;
        const bx = M[o] * dx + M[o + 1] * dy + M[o + 2] * dz + ox;
        const by = M[o + 3] * dx + M[o + 4] * dy + M[o + 5] * dz + oy;
        const bz = M[o + 6] * dx + M[o + 7] * dy + M[o + 8] * dz + oz;
        const ex = bx - sx, ey = by - sy, ez = bz - sz;
        if (ex * ex + ey * ey + ez * ez > eps2) continue;   // この頂点を動かすミラー
        // 不動にするミラー: 現在位置の像を足し込む
        const gx = cx - ox, gy = cy - oy, gz = cz - oz;
        ax += M[o] * gx + M[o + 1] * gy + M[o + 2] * gz + ox;
        ay += M[o + 3] * gx + M[o + 4] * gy + M[o + 5] * gz + oy;
        az += M[o + 6] * gx + M[o + 7] * gy + M[o + 8] * gz + oz;
        cnt++;
      }
      if (cnt === 0) continue;
      const inv = 1 / (cnt + 1);
      P[i] = ax * inv; P[i + 1] = ay * inv; P[i + 2] = az * inv;
    }
  }
  _ownership(verts, count, myIndex, radius) {
    const centers = this._mirCenters;
    const nm = this._mirCount;
    if (nm <= 1 || !centers) return null;
    let own = this._ownBuf;
    if (!own || own.length < count) own = this._ownBuf = new Float32Array(Math.max(1024, count * 2));
    const P = this.mesh.positions;
    // 距離の比較は「このダブを始めた時点」の座標で行う。現在の座標で比べると、
    // ミラー 0 が既に動かしたぶんだけ頂点が自分の側へ寄って見え、
    // ミラー 1 が「相手のほうが近い」と判断して持ち分 0 になる。
    // 実測ではそれで平面上の頂点の X が打ち消されず 7.8e-3 ずれていた。
    const SP = this._snapPos, SS = this._snapStamp, sid = this._snapId;
    const mx = centers[myIndex * 3], my = centers[myIndex * 3 + 1], mz = centers[myIndex * 3 + 2];
    // 「同距離」の判定はブラシ半径に対する相対許容差で行う。厳密等号だと、
    // 平面上の頂点の x が厳密な 0 ではない（1e-12 程度は乗っている）ために
    // 同距離を取りこぼし、平面から押し出されてしまう。
    // 距離差 |dA-dB| < eps*R を二乗距離の差に直すと |d-mine| < 2*eps*R^2。
    const tol = 2e-5 * radius * radius;
    for (let k = 0; k < count; k++) {
      const v = verts[k], i = v * 3;
      const snap = SS && SS[v] === sid;
      const px = snap ? SP[i] : P[i];
      const py = snap ? SP[i + 1] : P[i + 1];
      const pz = snap ? SP[i + 2] : P[i + 2];
      const mine = (px - mx) ** 2 + (py - my) ** 2 + (pz - mz) ** 2;
      // 自分より明確に近いミラーが 1 枚でもあれば担当外。
      // 同距離のミラーには 1/枚数 ずつ配る。
      let closer = 0, tied = 1;
      for (let j = 0; j < nm; j++) {
        if (j === myIndex) continue;
        const d = (px - centers[j * 3]) ** 2 + (py - centers[j * 3 + 1]) ** 2 + (pz - centers[j * 3 + 2]) ** 2;
        if (d < mine - tol) { closer++; break; }
        if (d <= mine + tol) tied++;
      }
      own[k] = closer > 0 ? 0 : 1 / tied;
    }
    return own;
  }

  /**
   * ダブの接平面の基底を作る。ブラシアルファはこの (U, V) 上でサンプルされる。
   *
   * 法線はシード頂点のものを使う（ブラシの平均法線は apply の中で初めて求まるので、
   * 掛ける前には使えない）。U はストローク方向に合わせる（ZBrush の Align to Stroke）か、
   * 合わせない設定なら法線から決まる安定した軸にする。
   */
  _updateDabFrame(ms, delta) {
    const st = this.state;
    const m = this.mesh;
    const U = this._tanU, V = this._tanV;
    const seed = ms.seed;
    let nx = 0, ny = 1, nz = 0;
    if (seed >= 0 && seed < m.nv) {
      const i = seed * 3;
      nx = m.normals[i]; ny = m.normals[i + 1]; nz = m.normals[i + 2];
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 1; nz = 0; }
    }
    // U の元になる方向
    let ux = 0, uy = 0, uz = 0;
    const align = st.alphaAlign !== false;
    if (align && delta && (delta[0] || delta[1] || delta[2])) {
      ux = delta[0]; uy = delta[1]; uz = delta[2];
    } else {
      // 法線と平行にならない軸を選ぶ（|n| の一番小さい成分の軸）
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      if (ax <= ay && ax <= az) { ux = 1; }
      else if (ay <= az) { uy = 1; }
      else { uz = 1; }
    }
    // 法線成分を抜いて接平面へ落とす
    const d = ux * nx + uy * ny + uz * nz;
    ux -= nx * d; uy -= ny * d; uz -= nz * d;
    let l = Math.hypot(ux, uy, uz);
    if (l < 1e-12) {
      // 退化したら別の軸でやり直す
      ux = ny; uy = nz; uz = nx;
      const d2 = ux * nx + uy * ny + uz * nz;
      ux -= nx * d2; uy -= ny * d2; uz -= nz * d2;
      l = Math.hypot(ux, uy, uz) || 1;
    }
    U[0] = ux / l; U[1] = uy / l; U[2] = uz / l;
    // V = n × U（右手系）
    V[0] = ny * U[2] - nz * U[1];
    V[1] = nz * U[0] - nx * U[2];
    V[2] = nx * U[1] - ny * U[0];

    // 回転。spin が有効なストロークではダブごとに擬似ランダムに回す。
    // Math.random は使わない（同じストロークが同じ結果になるようにする）。
    const sp = this._strokeParams;
    if (sp && sp.spin) {
      const h = hash01(this._dabSeq * 2 + 1, this.strokeSeed);
      this._alphaRot = h * Math.PI * 2;
    } else {
      this._alphaRot = 0;
    }
  }

  /**
   * ペイント色。colorSpray では明度と色相をダブごとに少し散らす。
   * ZBrush の ColorSpray 相当で、鱗や岩肌を塗るときに単調にならない。
   */
  _dabColor() {
    const st = this.state;
    const sp = this._strokeParams;
    const j = sp && sp.colorJitter ? sp.colorJitter : 0;
    if (j <= 0) return st.paintColor;
    const c = st.paintColor;
    const out = this._jitterColor || (this._jitterColor = [0, 0, 0]);
    const seq = this._dabSeq;
    for (let k = 0; k < 3; k++) {
      const h = hash01(seq * 8 + 5 + k, this.strokeSeed) * 2 - 1;
      out[k] = clamp(c[k] * (1 + h * j), 0, 1);
    }
    return out;
  }

  _dab(ms, point, delta, first, scale) {
    const m = this.mesh;
    const st = this.state;
    const brush = this.strokeBrush;
    // スプレー系はダブごとに半径が揺れる（_dabAll が決めた倍率を掛ける）
    const radius = st.worldRadius * (this._sizeMul || 1);
    if (radius <= 0) return;
    // アルファを使うなら接平面の基底を作る。使わないなら計算しない
    const alphaId = st.alpha || null;
    if (alphaId) this._updateDabFrame(ms, delta);

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
      const rec = this.recorder;
      if (this._mirCount > 1) this._snapshotRegion(ms.lockedVerts, ms.lockedCount);
      if (rec) rec.before(m, ms.lockedVerts, ms.lockedCount);
      this.engine.apply(m, {
        type: 'move',
        verts: ms.lockedVerts, count: ms.lockedCount,
        center: ms.center, radius,
        strength: (st.effStrength !== undefined ? st.effStrength : st.strength) * scale, dir: this.strokeDir,
        delta, color: st.paintColor, ignoreMask: false,
        focal: st.focalShift, toCamera: st.toCamera, backface: st.backfaceMask,
        alpha: alphaId, tangent: this._tanU, bitangent: this._tanV, alphaRotation: this._alphaRot,
        own: this._ownership(ms.lockedVerts, ms.lockedCount, this._mirIndex, radius),
        frameN: this._useFrame ? this._frameN : null, frameC: this._useFrame ? this._frameC : null,
      });
      if (rec) rec.after(m, ms.lockedVerts, ms.lockedCount);
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

    const rec = this.recorder;
    if (this._mirCount > 1) this._snapshotRegion(ms.verts, ms.count);
    if (rec) rec.before(m, ms.verts, ms.count);
    // モーフブラシは「記憶した形へ戻す」だけで、通常のブラシとは処理が違う。
    // morph.js を sculptor から直接 import すると依存が逆流するので、
    // recorder と同じく外から差してもらうフックにしてある。
    if (brush === 'morph') {
      const hook = this.morphHook;
      if (hook) hook(m, ms.verts, ms.count, point, radius, st);
      if (rec) rec.after(m, ms.verts, ms.count);
      this._updateNormals(ms.verts, ms.count, ms.tris, ms.triCount);
      return;
    }
    this.engine.apply(m, {
      type: brush,
      verts: ms.verts, count: ms.count,
      center: point, radius,
      strength: (st.effStrength !== undefined ? st.effStrength : st.strength) * scale, dir: this.strokeDir,
      delta, color: this._dabColor(),
      ignoreMask: brush === 'mask',
      focal: st.focalShift, toCamera: st.toCamera, backface: st.backfaceMask,
      alpha: alphaId, tangent: this._tanU, bitangent: this._tanV, alphaRotation: this._alphaRot,
      own: this._ownership(ms.verts, ms.count, this._mirIndex, radius),
      frameN: this._useFrame ? this._frameN : null, frameC: this._useFrame ? this._frameC : null,
    });

    if (rec) rec.after(m, ms.verts, ms.count);

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
