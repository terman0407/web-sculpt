// ---------------------------------------------------------------------------
// clip.js
// 平面で切る系の操作: Clip / Trim / Slice / Mirror and Weld
// （ZBrush の ClipCurve・Trim・Slice・Mirror and Weld のうち「平面」版）。
//
// 平面は { n: [x, y, z], d } で n·p + d = 0。n·p + d > 0 を「表」＝残る側とする。
//
// 設計上のポイント:
//  * トポロジを変える 3 つ（trim / slice / mirrorWeld）の三角形切断は
//    Sutherland–Hodgman の多角形クリップ 1 本に集約した。跨ぐケースは
//    (2表1裏) (1表2裏) (1表1裏1平面上) の 3 通りあり、個別に書くと巻き方向を
//    保つコードを 3 回書くことになる。巡回順に頂点を歩いて交点を挿し込む形なら
//    どのケースでも元の向きがそのまま残るので、法線が裏返る事故が起きない。
//  * 平面のごく近くにある頂点は先に平面上へスナップしてから符号を決める。
//    これをやらないと t≈0 の交点が元の頂点とほぼ同じ場所に生まれ、
//    面積ゼロの三角形と実質的な重複頂点が残る（切り口の輪郭も追えなくなる）。
//  * 交点は「無向辺 → 頂点」の Map で共有する。隣の三角形が同じ辺から別の頂点を
//    作ると、そこで切り口が裂けて 2 度と閉じられない。
//  * 切り口は輪郭ループを拾って重心へファンで張る。輪郭 L 本に対して
//    頂点 +1 / 三角形 +L なのでオイラー標数は +1 になり、円盤が球に戻る。
//  * 境界辺を探すとき「両端が平面上にある辺」だけを候補にする。全辺を Map に
//    入れると 200 万面で 600 万エントリになるので、切り口の周りだけに絞る。
//
// 既知の限界:
//  * 重心ファンは「輪郭が円盤を囲む」前提。切り口が円環になる切り方
//    （例: トーラスを赤道面で切る）では内側の輪郭も円盤として塞ぐので、
//    穴の部分が二重に覆われる。閉多様体・体積・向きは正しいが面が重なる。
//    正しく塞ぐには平面上での穴あき多角形の三角形分割が必要。
//  * clipPlane は裏側を平面へ潰すので、投影が一致する頂点は同じ位置に重なる
//    （ZBrush の Clip も同じ挙動）。潰れた面はゼロ面積になり得る。
//  * mirrorWeld は「切り口が全部平面上にある」＝入力が閉じていることを前提とする。
//    元から穴があるメッシュでは、その穴は閉じないまま鏡像化される。
//  * trim / slice / mirrorWeld はトポロジ操作なのでマスクを見ない（ZBrush の
//    Trim / Slice / Mirror and Weld も同じ）。マスクで形を守りたいときは
//    clipPlane を使う。
// ---------------------------------------------------------------------------

import { clamp } from './math.js';
import { RING_STRIDE } from './mesh.js';

// 無向/有向辺を 1 個の整数キーにまとめる基数。頂点上限（2e6）より大きい 2 のべきで、
// 積が 8388608^2 ≒ 7.0e13 < 2^53 に収まるので Map のキーとして正確に使える。
const KEY_BASE = 8388608;

function growI32(a, need) {
  if (a.length >= need) return a;
  const b = new Int32Array(Math.max(256, need, a.length * 2));
  b.set(a);
  return b;
}

// ---------------------------------------------------------------------------
// 平面のヘルパ
// ---------------------------------------------------------------------------

/** 'x' | 'y' | 'z' | 0 | 1 | 2 → 0..2（不正なら -1） */
export function axisIndex(axis) {
  if (typeof axis === 'number') return (axis === 0 || axis === 1 || axis === 2) ? axis : -1;
  if (typeof axis === 'string' && axis.length === 1) return 'xyz'.indexOf(axis.toLowerCase());
  return -1;
}

/** 点と法線から平面を作る（法線は正規化される） */
export function planeFromPointNormal(point, normal) {
  const l = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(l > 1e-20) || !Number.isFinite(l)) return null;
  const s = 1 / l;
  const n = [normal[0] * s, normal[1] * s, normal[2] * s];
  const d = -(n[0] * point[0] + n[1] * point[1] + n[2] * point[2]);
  // 点に NaN / Infinity が混ざった平面をそのまま返すと、切る側で全頂点の座標が
  // NaN になるまで気づけない。作れなかったことをここで伝える。
  if (!Number.isFinite(d)) return null;
  return { n, d };
}

/**
 * 座標軸に垂直な平面。keep > 0 なら軸の正側が表、keep < 0 なら負側が表。
 * n·p + d = keep * (p[axis] - offset) になる。
 */
export function planeFromAxis(axis, offset = 0, keep = 1) {
  const ax = axisIndex(axis);
  if (ax < 0 || !Number.isFinite(offset)) return null;
  const k = keep < 0 ? -1 : 1;
  const n = [0, 0, 0];
  n[ax] = k;
  return { n, d: -offset * k };
}

/**
 * 画面上の 2 点ドラッグから平面を作る。a, b はワールド上の 2 点、
 * viewDir はカメラの視線方向（目から奥へ）。
 *
 * 平面は a, b を通り視線に平行になる（＝画面上では 1 本の直線に見える）ので、
 * 呼び出し側はドラッグの始点/終点を適当な深さでアンプロジェクトして渡せばよい。
 * 表（残る側）は「ドラッグ方向に対して画面上の左側」。
 * 逆にしたいときは flipPlane() を通す。
 */
export function planeFromScreenLine(a, b, viewDir) {
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
  // n = e × viewDir。右手系で「画面右へドラッグ → 上側が表」になる向き。
  let nx = ey * viewDir[2] - ez * viewDir[1];
  let ny = ez * viewDir[0] - ex * viewDir[2];
  let nz = ex * viewDir[1] - ey * viewDir[0];
  const l = Math.hypot(nx, ny, nz);
  // ドラッグが短い / 視線と平行だと平面が決まらない（NaN もここで落ちる）
  if (!(l > 1e-12) || !Number.isFinite(l)) return null;
  const s = 1 / l;
  nx *= s; ny *= s; nz *= s;
  const d = -(nx * a[0] + ny * a[1] + nz * a[2]);
  if (!Number.isFinite(d)) return null;
  return { n: [nx, ny, nz], d };
}

/** 表裏を入れ替えた平面を返す（元は変更しない） */
export function flipPlane(plane) {
  return { n: [-plane.n[0], -plane.n[1], -plane.n[2]], d: -plane.d };
}

/** 符号付き距離。|n| = 1 の平面（このモジュールが作る平面）を前提とする。 */
export function planeDistance(plane, x, y, z) {
  return plane.n[0] * x + plane.n[1] * y + plane.n[2] * z + plane.d;
}

/**
 * 呼び出し側が手で組んだ平面でも壊れないように、単位法線に直してスカラで返す。
 *
 * 有限性を全部確かめてから返すこと。NaN が 1 つ混ざった平面を通すと、符号が
 * 表でも裏でもなくなって全頂点が「平面上」に分類され、スナップで座標が
 * 丸ごと NaN になる。しかも操作は「何も切らなかった」ように見えるので、
 * 呼び出し側は履歴を積まず、壊れたメッシュを取り消せなくなる。
 */
function unitPlane(plane) {
  if (!plane || !plane.n) return null;
  const n = plane.n;
  const nx = n[0], ny = n[1], nz = n[2], pd = plane.d;
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)
    || !Number.isFinite(pd)) return null;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-20) || !Number.isFinite(l)) return null;
  const s = 1 / l;
  const d = pd * s;
  if (!Number.isFinite(d)) return null;
  return { nx: nx * s, ny: ny * s, nz: nz * s, d };
}

/**
 * 「平面上」と見なす許容値。モデルのスケールに対して決めないと意味がない。
 * 半径の 1e-5 なら float32 の相対誤差（1e-7）より十分大きく、
 * スナップの移動量は見た目に出ない。
 */
function planeEps(mesh, opts) {
  if (opts && opts.eps > 0 && Number.isFinite(opts.eps)) return opts.eps;
  return Math.max(1e-12, mesh.bounds().radius * 1e-5);
}

// ---------------------------------------------------------------------------
// 共通の下請け
// ---------------------------------------------------------------------------

/**
 * 全頂点を表 / 裏 / 平面上に分類する。座標は一切動かさない。
 *
 * sign / onPlane は capV 長で確保する。死んだスロットは 0 のままにしておくので、
 * あとで交点用に再利用されても「平面上」として矛盾しない。
 * 「平面上」の頂点は onList にも控える。スナップ対象はここに全部いるので、
 * あとで座標を動かすときに nv 全体をもう一度舐める必要がない。
 */
function classify(mesh, pl, opts) {
  const nv = mesh.nv;
  const P = mesh.positions, A = mesh.vAlive;
  const nx = pl.nx, ny = pl.ny, nz = pl.nz, d = pl.d;
  const eps = planeEps(mesh, opts);
  const sign = new Float32Array(mesh.capV);
  const onPlane = new Uint8Array(mesh.capV);
  let onList = new Int32Array(256);
  let nFront = 0, nBack = 0, nOn = 0;
  for (let v = 0; v < nv; v++) {
    if (A[v] === 0) continue;
    const i = v * 3;
    const s = P[i] * nx + P[i + 1] * ny + P[i + 2] * nz + d;
    if (s > eps) { sign[v] = s; nFront++; }
    else if (s < -eps) { sign[v] = s; nBack++; }
    else {
      onPlane[v] = 1;
      onList = growI32(onList, nOn + 1);
      onList[nOn++] = v;
    }
  }
  return { sign, onPlane, onList, eps, nFront, nBack, nOn, snapped: 0 };
}

/**
 * 「平面上」と判定された頂点を実際に平面へ吸わせる。
 *
 * classify から分けてあるのは、早期リターンする経路（平面が交差しない /
 * 全部裏で拒否 / 既にスライス済み）で座標を動かさないため。changed = false を
 * 返しながら形が変わると、呼び出し側は履歴を積まないので取り消せない変更が残る。
 * 呼ぶのは「実際に切ると決めたあと」だけ。
 *
 * スナップ自体の役目は切り口を平らにすること。交点が既存頂点と重なるのを防ぐ
 * のは classify の eps バンド（sign = 0 扱い）側の仕事なので、ここを呼ぶのが
 * 切断ループの直前でも結果は変わらない。
 */
function snapToPlane(mesh, pl, cl) {
  const P = mesh.positions;
  const nx = pl.nx, ny = pl.ny, nz = pl.nz, d = pl.d;
  const list = cl.onList, n = cl.nOn;
  let snapped = 0;
  for (let k = 0; k < n; k++) {
    const i = list[k] * 3;
    const s = P[i] * nx + P[i + 1] * ny + P[i + 2] * nz + d;
    if (s === 0) continue;
    P[i] -= nx * s; P[i + 1] -= ny * s; P[i + 2] -= nz * s;
    mesh.markVert(list[k]);
    snapped++;
  }
  cl.snapped = snapped;
  return snapped;
}

/** reserve() で capV が伸びたら分類配列も合わせる（伸びなければ何もしない） */
function growClass(cl, capV) {
  if (cl.sign.length >= capV) return;
  const s = new Float32Array(capV); s.set(cl.sign); cl.sign = s;
  const o = new Uint8Array(capV); o.set(cl.onPlane); cl.onPlane = o;
}

/** 辺 (a,b) と平面の交点頂点。辺ごとに 1 個だけ作って両側の三角形で共有する。 */
function cutVertex(mesh, map, cl, a, b) {
  const key = a < b ? a * KEY_BASE + b : b * KEY_BASE + a;
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const sign = cl.sign;
  const sa = sign[a], sb = sign[b];
  // 符号が逆なので分母は 0 にならない。それでも念のため 0..1 に収める。
  let t = sa / (sa - sb);
  if (!(t > 0)) t = 0; else if (!(t < 1)) t = 1;
  const v = mesh.addVertexOnEdge(a, b, t);
  if (v >= 0 && v < cl.sign.length) { cl.sign[v] = 0; cl.onPlane[v] = 1; }
  map.set(key, v);
  return v;
}

/**
 * 三角形 tris[i..i+2] を半空間 side * sign >= 0 でクリップした多角形を out に詰める。
 * 巡回順に歩いて「内側の頂点」と「符号が変わる辺の交点」を並べるだけなので、
 * 元の巻き方向がそのまま残る。返り値は多角形の頂点数（0, 1, 2 なら面にならない）。
 * 三角形 1 枚に対する交点は最大 2 個なので out は 5 要素あれば足りる。
 */
function clipTriangle(mesh, map, cl, i, side, out) {
  const T = mesh.tris, sign = cl.sign;
  let n = 0;
  for (let e = 0; e < 3; e++) {
    const a = T[i + e];
    const b = T[i + (e === 2 ? 0 : e + 1)];
    const sa = sign[a] * side, sb = sign[b] * side;
    if (sa >= 0) out[n++] = a;
    if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) out[n++] = cutVertex(mesh, map, cl, a, b);
  }
  return n;
}

/**
 * verts とその 1-ring の法線・曲率を直す。切り口の周りだけで済むので、
 * 数百万頂点でも全体再計算（数十 ms）を避けられる。
 * @returns {number} 更新した頂点数
 */
function refreshAround(mesh, verts, count) {
  if (count <= 0) return 0;
  const nv = mesh.nv;
  const T = mesh.tris, RC = mesh.ringCount, RD = mesh.ringData, REX = mesh.ringExt;
  const A = mesh.vAlive;
  const seen = new Uint8Array(nv);
  let set = new Int32Array(Math.max(1024, count * 4));
  let n = 0;
  for (let k = 0; k < count; k++) {
    const v = verts[k];
    if (v < 0 || v >= nv || A[v] === 0) continue;
    if (seen[v] === 0) { seen[v] = 1; set = growI32(set, n + 1); set[n++] = v; }
    const rc = RC[v];
    if (rc === 0) continue;
    const inline = rc <= RING_STRIDE;
    const rb = inline ? v * RING_STRIDE : 0;
    const rex = inline ? null : REX[v];
    set = growI32(set, n + rc * 3);
    for (let j = 0; j < rc; j++) {
      const ti = (inline ? RD[rb + j] : rex[j]) * 3;
      let u = T[ti];
      if (seen[u] === 0) { seen[u] = 1; set[n++] = u; }
      u = T[ti + 1];
      if (seen[u] === 0) { seen[u] = 1; set[n++] = u; }
      u = T[ti + 2];
      if (seen[u] === 0) { seen[u] = 1; set[n++] = u; }
    }
  }
  if (n === 0) return 0;
  mesh.computeNormalsFor(set, n);
  mesh.computeCurvatureFor(set, n);
  mesh.smoothCurvatureFor(set, n);
  for (let k = 0; k < n; k++) mesh.markVert(set[k]);
  return n;
}

/** 三角形を 1 枚も持たなくなった頂点を回収する（裏側の頂点は全部これになる） */
function removeOrphans(mesh) {
  const A = mesh.vAlive, RC = mesh.ringCount;
  let removed = 0;
  for (let v = 0; v < mesh.nv; v++) {
    if (A[v] === 1 && RC[v] === 0) { mesh.removeVertex(v); removed++; }
  }
  return removed;
}

/**
 * 「両端が平面上にある境界辺」を輪郭ループとして拾い、重心へファンを張って塞ぐ。
 * 平面上に無い境界辺（元から開いていたメッシュの穴）は触らない。
 * @returns {object} { loops, added, addedTris, centers }
 */
function capPlanarHoles(mesh, cl) {
  const out = { loops: 0, added: 0, addedTris: 0, centers: [] };
  const onPlane = cl.onPlane;
  const nOn = onPlane.length;
  const nt = mesh.nt;
  const T = mesh.tris;

  // --- 候補となる有向辺（両端が平面上）を集める ---------------------------
  let ea = new Int32Array(256), eb = new Int32Array(256);
  let ne = 0;
  const seenDir = new Map();
  for (let t = 0; t < nt; t++) {
    const i = t * 3;
    const v0 = T[i], v1 = T[i + 1], v2 = T[i + 2];
    if (v0 === v1 && v1 === v2) continue;
    for (let e = 0; e < 3; e++) {
      const a = e === 0 ? v0 : (e === 1 ? v1 : v2);
      const b = e === 0 ? v1 : (e === 1 ? v2 : v0);
      if (a >= nOn || b >= nOn || onPlane[a] === 0 || onPlane[b] === 0) continue;
      ea = growI32(ea, ne + 1); eb = growI32(eb, ne + 1);
      ea[ne] = a; eb[ne] = b; ne++;
      const k = a * KEY_BASE + b;
      seenDir.set(k, (seenDir.get(k) || 0) + 1);
    }
  }
  if (ne === 0) return out;

  // 逆向きが存在しない有向辺だけが境界。平面上に乗っている内部辺
  // （平面と接している面や slice 済みの辺）はここで落ちる。
  const bA = new Int32Array(ne), bB = new Int32Array(ne);
  let bn = 0;
  for (let k = 0; k < ne; k++) {
    const a = ea[k], b = eb[k];
    if (seenDir.get(b * KEY_BASE + a)) continue;
    bA[bn] = a; bB[bn] = b; bn++;
  }
  if (bn < 3) return out;

  // --- 有向辺を繋いで輪郭を作る ------------------------------------------
  // 「頂点 → そこから出る境界辺」を単方向リストで持つ。ピンチ点（同じ頂点から
  // 境界辺が 2 本出る）でも辺を 1 本ずつ消費していけば複数の輪郭に分かれる。
  const head = new Map();
  const link = new Int32Array(bn);
  for (let k = 0; k < bn; k++) {
    const a = bA[k];
    link[k] = head.has(a) ? head.get(a) : -1;
    head.set(a, k);
  }
  const used = new Uint8Array(bn);
  let loop = new Int32Array(256);

  for (let k0 = 0; k0 < bn; k0++) {
    if (used[k0]) continue;
    const start = bA[k0];
    let ln = 0, e = k0, closed = false;
    for (let step = 0; step <= bn; step++) {
      used[e] = 1;
      loop = growI32(loop, ln + 1);
      loop[ln++] = e;
      const v = bB[e];
      if (v === start) { closed = true; break; }
      let next = -1;
      for (let j = head.has(v) ? head.get(v) : -1; j >= 0; j = link[j]) {
        if (used[j] === 0) { next = j; break; }
      }
      if (next < 0) break;
      e = next;
    }
    // 閉じなかった輪郭（非多様体な入力）は塞がない。塞ぐと余計に壊れる。
    if (!closed || ln < 3) continue;

    // 重心と、色 / マスクの平均。addVertex の前に計算しておく
    // （addVertex で配列が作り直される可能性があるため）。
    const P = mesh.positions, C = mesh.colors, MK = mesh.mask;
    let cx = 0, cy = 0, cz = 0, cr = 0, cg = 0, cb = 0, cm = 0;
    for (let k = 0; k < ln; k++) {
      const v = bA[loop[k]], i = v * 3;
      cx += P[i]; cy += P[i + 1]; cz += P[i + 2];
      cr += C[i]; cg += C[i + 1]; cb += C[i + 2];
      cm += MK[v];
    }
    const inv = 1 / ln;
    const cv = mesh.addVertex(cx * inv, cy * inv, cz * inv,
      cr * inv, cg * inv, cb * inv, cm * inv);
    out.centers.push(cv);
    out.added++;
    // 既存の面が a→b と巻いているので、穴側は b→a に巻かないと法線が裏返る
    for (let k = 0; k < ln; k++) {
      const idx = loop[k];
      mesh.addTriangle(bB[idx], bA[idx], cv);
      out.addedTris++;
    }
    out.loops++;
  }
  return out;
}

/** 平面上の頂点 + 追加した頂点を集めて法線 / 曲率を直す */
function refreshPlanar(mesh, cl, centers) {
  const onPlane = cl.onPlane;
  const A = mesh.vAlive;
  const lim = Math.min(mesh.nv, onPlane.length);
  let list = new Int32Array(Math.max(256, cl.nOn + centers.length + 16));
  let n = 0;
  for (let v = 0; v < lim; v++) {
    if (onPlane[v] === 1 && A[v] === 1) { list = growI32(list, n + 1); list[n++] = v; }
  }
  for (let k = 0; k < centers.length; k++) {
    const v = centers[k];
    if (v < mesh.nv && A[v] === 1) { list = growI32(list, n + 1); list[n++] = v; }
  }
  return refreshAround(mesh, list, n);
}

// ---------------------------------------------------------------------------
// Clip: 平面の裏側を平面上へ射影する（トポロジは変えない）
// ---------------------------------------------------------------------------

/**
 * 平面の裏側にある頂点を平面上へ射影する。ZBrush の ClipCurve と同じで
 * トポロジは変わらない（面が平面上に潰れて平らな断面に見える）。
 *
 * @param {SculptMesh} mesh
 * @param {object} plane { n: [x,y,z], d }
 * @param {object} opts
 *   falloff    : > 0 でソフトクリップ。平面から深さ falloff までは射影量を
 *                smoothstep で絞る（＝平面のすぐ手前は緩く動かす）。
 *                0（既定）なら完全に平面へ落とすハードクリップ。
 *   strength   : 0..1 の全体倍率（既定 1）
 *   ignoreMask : true でマスクを無視する
 * @returns {object} { changed, moved, back, maxMove, refreshed }
 */
export function clipPlane(mesh, plane, opts = {}) {
  const res = { changed: false, moved: 0, back: 0, maxMove: 0, refreshed: 0 };
  const pl = unitPlane(plane);
  if (!pl || mesh.nv === 0) return res;

  // clamp(NaN) は NaN のままなので、そのまま倍率に使うと全頂点の座標が NaN になる。
  // 空スライダの parseFloat など NaN は簡単に混ざるので「動かさない」に倒す。
  const strength = opts.strength === undefined ? 1 : clamp(Number(opts.strength), 0, 1);
  if (!(strength > 0)) return res;
  // ソフトクリップ:
  //   「平面から離れるほど動かす量を緩める」を素直に書くと、深い所が平らに
  //   ならないうえに平面上の折れ目もそのまま残る（射影量の傾きが s=0 で不連続）。
  //   そこで帯の中で射影量を smoothstep で立ち上げる形にした。深さ falloff 以上は
  //   きっちり平面へ落ち、平面のすぐ手前だけ緩むので、鋭い稜線が丸い肩になる。
  //   代償として深さ 0.26*falloff ぶんだけ平面の裏に薄く残る。
  const w = (opts.falloff > 0 && Number.isFinite(opts.falloff)) ? opts.falloff : 0;
  const invW = w > 0 ? 1 / w : 0;
  const useMask = opts.ignoreMask !== true;

  const nv = mesh.nv;
  const P = mesh.positions, A = mesh.vAlive, MK = mesh.mask;
  const nx = pl.nx, ny = pl.ny, nz = pl.nz, d = pl.d;
  const list = new Int32Array(Math.max(64, mesh.liveVerts));
  let n = 0, back = 0, maxMove = 0;

  for (let v = 0; v < nv; v++) {
    if (A[v] === 0) continue;
    const i = v * 3;
    const s = P[i] * nx + P[i + 1] * ny + P[i + 2] * nz + d;
    if (s >= 0) continue;              // 表側は一切触らない
    back++;
    let f = strength;
    if (w > 0) {
      const u = -s * invW;
      if (u < 1) f *= u * u * (3 - 2 * u);
    }
    if (useMask) {
      // マスクの規約: 1 = 完全に保護されて動かない
      const mk = MK[v];
      f *= 1 - (mk < 0 ? 0 : (mk > 1 ? 1 : mk));
    }
    if (f <= 0) continue;
    const mv = -s * f;                 // 平面へ向かう移動量（s < 0 なので正）
    P[i] += nx * mv; P[i + 1] += ny * mv; P[i + 2] += nz * mv;
    list[n++] = v;
    if (mv > maxMove) maxMove = mv;
  }

  res.back = back; res.moved = n; res.maxMove = maxMove;
  if (n === 0) return res;
  res.changed = true;
  // 面の繋がりは変わらないので topoVersion は上げない（ワイヤフレームは再構築不要）
  res.refreshed = refreshAround(mesh, list, n);
  mesh.geomVersion++;
  return res;
}

// ---------------------------------------------------------------------------
// Trim: 平面の裏側を実際に切り落として切り口を塞ぐ
// ---------------------------------------------------------------------------

/**
 * 平面の裏側を切り落とし、切り口を三角形で塞ぐ（穴を残さない）。
 *
 * @param {SculptMesh} mesh
 * @param {object} plane { n: [x,y,z], d }
 * @param {object} opts
 *   cap : false で切り口を塞がない（mirrorWeld が使う）
 *   eps : 平面上と見なす距離（既定はモデル半径の 1e-5）
 * @returns {object} { changed, removed, removedTris, added, addedTris,
 *                     cutVerts, loops, snapped, refused }
 */
export function trimPlane(mesh, plane, opts = {}) {
  const res = {
    changed: false, removed: 0, removedTris: 0, added: 0, addedTris: 0,
    cutVerts: 0, loops: 0, snapped: 0, refreshed: 0,
  };
  const pl = unitPlane(plane);
  if (!pl || mesh.nv === 0) return res;
  const doCap = opts.cap !== false;

  const cl = classify(mesh, pl, opts);
  if (cl.nBack === 0) return res;                                  // 裏側に何もない
  if (cl.nFront === 0) { res.refused = 'all-back'; return res; }    // 全部消えるので拒否

  // --- 跨ぐ / 捨てる三角形を数える ---------------------------------------
  // 実際に切る前に容量を確保しておく。途中で配列が作り直されると、
  // ローカルに持った tris / positions が古い配列を指してしまう。
  const nt0 = mesh.nt;
  let nCross = 0, nDrop = 0;
  {
    const T = mesh.tris, sign = cl.sign;
    for (let t = 0; t < nt0; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      const sa = sign[a], sb = sign[b], sc = sign[c];
      const nb = (sa < 0 ? 1 : 0) + (sb < 0 ? 1 : 0) + (sc < 0 ? 1 : 0);
      if (nb === 0) continue;
      const nf = (sa > 0 ? 1 : 0) + (sb > 0 ? 1 : 0) + (sc > 0 ? 1 : 0);
      if (nf === 0) nDrop++; else nCross++;
    }
  }
  if (nCross === 0 && nDrop === 0) return res;
  // 跨ぐ三角形 1 枚が作る交点は最大 2 個、増える三角形は最大 1 枚
  mesh.reserve(mesh.nv + nCross * 2 + 4, mesh.nt + nCross + 4);
  growClass(cl, mesh.capV);
  res.snapped = snapToPlane(mesh, pl, cl);   // ここから先は必ず切る（= changed になる）

  // --- 切断 --------------------------------------------------------------
  {
    const map = new Map();
    const poly = new Int32Array(5);
    const T = mesh.tris, sign = cl.sign;
    for (let t = 0; t < nt0; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      const sa = sign[a], sb = sign[b], sc = sign[c];
      const nb = (sa < 0 ? 1 : 0) + (sb < 0 ? 1 : 0) + (sc < 0 ? 1 : 0);
      if (nb === 0) continue;                       // 表側 / 平面上だけ → そのまま
      const nf = (sa > 0 ? 1 : 0) + (sb > 0 ? 1 : 0) + (sc > 0 ? 1 : 0);
      if (nf === 0) { mesh.removeTriangle(t); res.removedTris++; continue; }
      const np = clipTriangle(mesh, map, cl, i, 1, poly);
      // 表側は 3 or 4 角形。1 枚目は元のスロットを使い回して残りをファンで足す。
      // 新しい面は削除で空いたスロットに入ることがあるが、その頂点は
      // すべて sign >= 0 なので、このループが後で拾っても nb === 0 で素通りする。
      if (np < 3) { mesh.removeTriangle(t); res.removedTris++; continue; }
      mesh.setTriangle(t, poly[0], poly[1], poly[2]);
      for (let k = 3; k < np; k++) { mesh.addTriangle(poly[0], poly[k - 1], poly[k]); res.addedTris++; }
    }
    res.cutVerts = map.size;
    res.added += map.size;
  }

  // --- 切り口を塞ぐ ------------------------------------------------------
  let centers = [];
  if (doCap) {
    const cap = capPlanarHoles(mesh, cl);
    res.loops = cap.loops;
    res.added += cap.added;
    res.addedTris += cap.addedTris;
    centers = cap.centers;
  }

  res.removed = removeOrphans(mesh);
  res.changed = true;
  // ring は setTriangle / addTriangle / removeTriangle が差分で維持しており、
  // topoVersion もそこで上がっている。よって rebuildRings() は不要。
  res.refreshed = refreshPlanar(mesh, cl, centers);
  mesh.geomVersion++;
  mesh.markAllDirty();
  return res;
}

// ---------------------------------------------------------------------------
// Slice: 切らずに平面上へ辺を作る
// ---------------------------------------------------------------------------

/**
 * 平面に沿って辺を作るだけ（ZBrush の Slice）。形は変えず、
 * 平面を跨ぐ三角形を交点で割って両側に分ける。ポリグループの境界を作る用途。
 *
 * @returns {object} { changed, added, addedTris, cutVerts, snapped }
 */
export function slicePlane(mesh, plane, opts = {}) {
  const res = { changed: false, added: 0, addedTris: 0, cutVerts: 0, snapped: 0, refreshed: 0 };
  const pl = unitPlane(plane);
  if (!pl || mesh.nv === 0) return res;

  const cl = classify(mesh, pl, opts);
  if (cl.nFront === 0 || cl.nBack === 0) return res;

  const nt0 = mesh.nt;
  let nCross = 0;
  {
    const T = mesh.tris, sign = cl.sign;
    for (let t = 0; t < nt0; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      const sa = sign[a], sb = sign[b], sc = sign[c];
      const nb = (sa < 0 ? 1 : 0) + (sb < 0 ? 1 : 0) + (sc < 0 ? 1 : 0);
      if (nb === 0) continue;
      const nf = (sa > 0 ? 1 : 0) + (sb > 0 ? 1 : 0) + (sc > 0 ? 1 : 0);
      if (nf > 0) nCross++;
    }
  }
  // 既に平面上に辺が通っている（= 跨ぐ面がない）なら何もしない。
  // 同じ平面で 2 回スライスしても増えないのはこの経路のおかげ。
  if (nCross === 0) return res;
  // 跨ぐ 1 枚が 3 枚になるので +2、交点は最大 2 個
  mesh.reserve(mesh.nv + nCross * 2 + 4, mesh.nt + nCross * 2 + 4);
  growClass(cl, mesh.capV);
  res.snapped = snapToPlane(mesh, pl, cl);   // ここから先は必ず切る（= changed になる）

  const map = new Map();
  const polyF = new Int32Array(5), polyB = new Int32Array(5);
  const T = mesh.tris, sign = cl.sign;
  for (let t = 0; t < nt0; t++) {
    const i = t * 3;
    const a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    const sa = sign[a], sb = sign[b], sc = sign[c];
    const nb = (sa < 0 ? 1 : 0) + (sb < 0 ? 1 : 0) + (sc < 0 ? 1 : 0);
    if (nb === 0) continue;
    const nf = (sa > 0 ? 1 : 0) + (sb > 0 ? 1 : 0) + (sc > 0 ? 1 : 0);
    if (nf === 0) continue;
    // 両側を先に切り出す（setTriangle で元の三角形を壊す前に読む必要がある）
    const cf = clipTriangle(mesh, map, cl, i, 1, polyF);
    const cbk = clipTriangle(mesh, map, cl, i, -1, polyB);
    if (cf < 3 || cbk < 3) continue;
    mesh.setTriangle(t, polyF[0], polyF[1], polyF[2]);
    for (let k = 3; k < cf; k++) { mesh.addTriangle(polyF[0], polyF[k - 1], polyF[k]); res.addedTris++; }
    for (let k = 2; k < cbk; k++) { mesh.addTriangle(polyB[0], polyB[k - 1], polyB[k]); res.addedTris++; }
  }
  res.cutVerts = map.size;
  res.added = map.size;
  res.changed = true;
  res.refreshed = refreshPlanar(mesh, cl, []);
  // 接続は変わった（topoVersion は addTriangle 側で上がる）。見た目の形は同じだが
  // スナップで平面上の頂点が eps ぶん動いているので geomVersion も進める。
  mesh.geomVersion++;
  mesh.markAllDirty();
  return res;
}

// ---------------------------------------------------------------------------
// Mirror and Weld
// ---------------------------------------------------------------------------

/**
 * 指定軸の平面で片側を捨て、残った側を鏡像コピーして接合部を溶接する。
 *
 * 溶接は「平面上の頂点を両側で共有する」形で行う。複製してから位置一致で
 * 溶接し直すと、一瞬でも同じ場所に 2 個並ぶぶん重複頂点と非多様体辺が残る。
 *
 * @param {SculptMesh} mesh
 * @param {string|number} axis 'x' | 'y' | 'z'（または 0/1/2）
 * @param {object} opts
 *   keep   : +1（既定）で軸の正側を残す。-1 で負側。
 *   offset : 鏡の位置（既定 0）
 *   eps    : 平面上と見なす距離
 * @returns {object} { changed, removed, removedTris, welded, added, addedTris,
 *                     trim, refused }
 *   refused = 'all-back'        : 残す側に何も残らない（trim が拒否した）
 *   refused = 'no-intersection' : 鏡がメッシュから離れている
 */
export function mirrorWeld(mesh, axis, opts = {}) {
  const res = {
    changed: false, removed: 0, removedTris: 0, welded: 0, added: 0, addedTris: 0,
  };
  const ax = axisIndex(axis);
  if (ax < 0 || mesh.nv === 0) return res;
  const keep = (opts.keep !== undefined && opts.keep < 0) ? -1 : 1;
  // NaN は falsy なので || 0 で 0 になるが、Infinity は素通りしてしまう
  const offset = Number.isFinite(opts.offset) ? opts.offset : 0;
  const eps = planeEps(mesh, opts);

  // 鏡がメッシュの外側にあると trim が 1 枚も削らず、鏡像は溶接点 0 個の
  // 「離れた複製」になる（頂点も面も 2 倍になったうえで塊が 2 つ浮く）。
  // 事故以外の使い道がないので手前で拒否する。片側だけのモデルを鏡像化する
  // 正当な使い方では接合面の頂点が平面上にいるので、この判定は通る。
  {
    const P = mesh.positions, A = mesh.vAlive, nv = mesh.nv;
    let touches = false;
    for (let v = 0; v < nv; v++) {
      if (A[v] === 0) continue;
      if (keep * (P[v * 3 + ax] - offset) <= eps) { touches = true; break; }
    }
    if (!touches) { res.refused = 'no-intersection'; return res; }
  }

  // 捨てる側は塞がない。鏡像側がその穴をそのまま閉じるので、
  // 塞いでしまうと接合部に不要な蓋が挟まる。
  const tr = trimPlane(mesh, planeFromAxis(ax, offset, keep), { cap: false, eps });
  if (tr.refused) { res.refused = tr.refused; return res; }
  res.removed = tr.removed;
  res.removedTris = tr.removedTris;
  res.trim = tr;

  // float32 に丸めた鏡の位置。平面上の頂点をこの値にぴったり合わせておけば
  // 鏡像座標 2*off - c が自分自身に戻り、共有しても座標がずれない。
  const off = Math.fround(offset);
  const nv0 = mesh.nv, nt0 = mesh.nt;
  mesh.reserve(nv0 + mesh.liveVerts + 4, nt0 + mesh.liveTris + 4);

  const mapV = new Int32Array(nv0).fill(-1);
  // 元の頂点 ID を先に控える。addVertex は捨てた頂点のスロットを再利用するので、
  // 走査しながら足すと「鏡像として生き返ったスロット」をもう一度鏡像化してしまう
  // （実際に頂点が 1.4 倍に増え、同じ位置に 2 個並んだ）。
  const srcV = new Int32Array(mesh.liveVerts);
  let nsv = 0;
  {
    const A = mesh.vAlive;
    for (let v = 0; v < nv0; v++) if (A[v] === 1) srcV[nsv++] = v;
  }
  {
    const P = mesh.positions, C = mesh.colors, MK = mesh.mask;
    for (let k = 0; k < nsv; k++) {
      const v = srcV[k];
      const i = v * 3;
      const c = P[i + ax];
      if (c >= off - eps && c <= off + eps) {
        P[i + ax] = off;                 // ぴったり平面上へ（これが溶接点になる）
        mapV[v] = v;
        res.welded++;
        continue;
      }
      const x = ax === 0 ? off * 2 - P[i] : P[i];
      const y = ax === 1 ? off * 2 - P[i + 1] : P[i + 1];
      const z = ax === 2 ? off * 2 - P[i + 2] : P[i + 2];
      mapV[v] = mesh.addVertex(x, y, z, C[i], C[i + 1], C[i + 2], MK[v]);
      res.added++;
    }
  }

  // 面を足しながら走査すると、削除で空いたスロットに入った鏡像面を
  // もう一度鏡像化してしまう。生きている面の ID を先に控える。
  const src = new Int32Array(mesh.liveTris);
  let ns = 0;
  {
    const T = mesh.tris;
    for (let t = 0; t < nt0; t++) {
      const i = t * 3;
      if (T[i] === T[i + 1] && T[i + 1] === T[i + 2]) continue;
      src[ns++] = t;
    }
  }
  {
    const T = mesh.tris;
    for (let k = 0; k < ns; k++) {
      const i = src[k] * 3;
      const a = mapV[T[i]], b = mapV[T[i + 1]], c = mapV[T[i + 2]];
      if (a < 0 || b < 0 || c < 0) continue;
      // 鏡像変換は向きを反転させるので、巻き方向も逆にしないと法線が内を向く
      mesh.addTriangle(c, b, a);
      res.addedTris++;
    }
  }

  res.changed = res.added > 0 || res.addedTris > 0 || tr.changed;
  if (!res.changed) return res;
  // メッシュの半分が新しい頂点なので、部分更新より全体再計算のほうが速く単純。
  // ring は addTriangle が維持しているので rebuildRings() は不要。
  mesh.computeAllNormals();
  mesh.computeAllCurvature();
  mesh.geomVersion++;
  mesh.markAllDirty();
  return res;
}
