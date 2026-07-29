// ---------------------------------------------------------------------------
// io.js - OBJ / STL / PLY の書き出しと OBJ 読み込み
// 死んだ頂点・三角形はリマップして除外する。
// ---------------------------------------------------------------------------

import { weld } from './mesh.js';

function buildRemap(mesh) {
  const remap = new Int32Array(mesh.nv).fill(-1);
  let n = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) remap[v] = n++;
  // JS 配列の push だと 131 万面で 400 万回になる。生きている数は分かっているので
  // 先に確保して詰める。
  const tris = new Int32Array(mesh.liveTris * 3);
  const T = mesh.tris;
  let w = 0;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3;
    const a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    const ra = remap[a], rb = remap[b], rc = remap[c];
    if (ra < 0 || rb < 0 || rc < 0) continue;
    tris[w++] = ra; tris[w++] = rb; tris[w++] = rc;
  }
  return { remap, count: n, tris: tris.subarray(0, w) };
}

// --- ASCII を直接バイト列へ書くための道具 ----------------------------------
// OBJ は 1 面 1 行のテキストなので、行を JS 文字列で作って join すると
// 面数ぶんの文字列確保になる。131 万面で 400 万個の文字列を作って 80MB へ
// join していて 970ms、520 万面では 4.2 秒かかっていた。
// 数字を自分で 10 進へ落として Uint8Array に詰めれば確保は 1 回で済む。

/** 符号なし整数を 10 進で書く */
function putUint(b, w, n) {
  if (n === 0) { b[w++] = 48; return w; }
  const s = w;
  while (n > 0) { b[w++] = 48 + (n % 10); n = (n / 10) | 0; }
  for (let i = s, j = w - 1; i < j; i++, j--) { const t = b[i]; b[i] = b[j]; b[j] = t; }
  return w;
}

/**
 * 小数 6 桁までで書く（末尾の 0 は落とす）。
 * `Math.round(x * 1e6) / 1e6` を toString するのと同じ表現になる範囲を狙う。
 * 指数表記は使わないので、極端に大きい値は桁が並ぶだけで壊れはしない。
 */
function putFloat(b, w, x) {
  if (!isFinite(x)) x = 0;
  if (x < 0) { b[w++] = 45; x = -x; }        // '-'
  const n = Math.round(x * 1e6);
  const ip = Math.floor(n / 1e6);
  let fp = n - ip * 1e6;
  w = putUint(b, w, ip);
  if (fp > 0) {
    b[w++] = 46;                             // '.'
    // 末尾の 0 を落とすと桁数が減るので、先頭ゼロ埋めの桁数も一緒に減らす
    let width = 6;
    while (fp % 10 === 0) { fp /= 10; width--; }
    let digits = 0;
    for (let t = fp; t > 0; t = (t / 10) | 0) digits++;
    for (let k = digits; k < width; k++) b[w++] = 48;
    w = putUint(b, w, fp);
  }
  return w;
}

/** ASCII 文字列をそのまま詰める */
function putStr(b, w, s) {
  for (let i = 0; i < s.length; i++) b[w++] = s.charCodeAt(i) & 0x7f;
  return w;
}

/**
 * @param {object} opt
 *   quads: remesh.quadDominant() の出力を渡すと四角優勢の面リストで書き出す。
 *          ZRemesher の出力は四角なので、他のツールで開いたときの見た目を近づけられる。
 * @returns {Uint8Array} OBJ のバイト列（Blob へそのまま渡せる）
 */
export function exportOBJ(mesh, { withColor = true, name = 'websculpt', quads = null } = {}) {
  const { remap, count, tris } = buildRemap(mesh);
  const P = mesh.positions, N = mesh.normals, C = mesh.colors;

  // 行ごとの上限を見て、足りなくなったら倍にする。1 行の最大長を数え上げるより
  // 「1 行書く前に余裕があるか見る」ほうが、桁数の見積もり違いで壊れない。
  const LINE_MAX = 512;
  let cap = 4096 + count * (withColor ? 96 : 56) + count * 56
    + (quads ? quads.faces.length : tris.length) * 24;
  let b = new Uint8Array(cap);
  let w = 0;
  const room = () => {
    if (w + LINE_MAX <= b.length) return;
    const nb = new Uint8Array(Math.max(b.length * 2, w + LINE_MAX));
    nb.set(b.subarray(0, w));
    b = nb;
  };

  room(); w = putStr(b, w, '# WebSculpt export\n# verts ');
  w = putUint(b, w, count); w = putStr(b, w, ' tris ');
  w = putUint(b, w, tris.length / 3); w = putStr(b, w, '\no ');
  w = putStr(b, w, name); b[w++] = 10;

  for (let v = 0; v < mesh.nv; v++) {
    if (remap[v] < 0) continue;
    const i = v * 3;
    room();
    b[w++] = 118; b[w++] = 32;               // 'v '
    w = putFloat(b, w, P[i]); b[w++] = 32;
    w = putFloat(b, w, P[i + 1]); b[w++] = 32;
    w = putFloat(b, w, P[i + 2]);
    if (withColor) {
      b[w++] = 32; w = putFloat(b, w, C[i]);
      b[w++] = 32; w = putFloat(b, w, C[i + 1]);
      b[w++] = 32; w = putFloat(b, w, C[i + 2]);
    }
    b[w++] = 10;
  }
  for (let v = 0; v < mesh.nv; v++) {
    if (remap[v] < 0) continue;
    const i = v * 3;
    room();
    b[w++] = 118; b[w++] = 110; b[w++] = 32; // 'vn '
    w = putFloat(b, w, N[i]); b[w++] = 32;
    w = putFloat(b, w, N[i + 1]); b[w++] = 32;
    w = putFloat(b, w, N[i + 2]);
    b[w++] = 10;
  }

  if (quads && quads.offsets && quads.offsets.length > 1) {
    // 四角優勢の面リストが渡されたらそれを書く（remesh.quadDominant の出力）。
    // 三角形も混ざるので、面ごとに頂点数が変わる形で出す。
    // 頂点番号はメッシュ側のものなので remap を通す。
    const F = quads.faces, O = quads.offsets;
    for (let k = 0; k + 1 < O.length; k++) {
      const s = O[k], e = O[k + 1];
      let bad = false;
      for (let i = s; i < e; i++) if (remap[F[i]] < 0) { bad = true; break; }
      if (bad) continue;
      room();
      b[w++] = 102;                          // 'f'
      for (let i = s; i < e; i++) {
        const n = remap[F[i]] + 1;
        b[w++] = 32;
        w = putUint(b, w, n); b[w++] = 47; b[w++] = 47;
        w = putUint(b, w, n);
      }
      b[w++] = 10;
    }
  } else {
    for (let i = 0; i < tris.length; i += 3) {
      room();
      b[w++] = 102;                          // 'f'
      for (let k = 0; k < 3; k++) {
        const n = tris[i + k] + 1;
        b[w++] = 32;
        w = putUint(b, w, n); b[w++] = 47; b[w++] = 47;
        w = putUint(b, w, n);
      }
      b[w++] = 10;
    }
  }
  return b.subarray(0, w);
}

export function exportSTL(mesh) {
  const { tris } = buildRemap(mesh);
  const nt = tris.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const enc = new TextEncoder();
  const header = enc.encode('WebSculpt binary STL');
  new Uint8Array(buf, 0, Math.min(80, header.length)).set(header.subarray(0, 80));
  dv.setUint32(80, nt, true);

  // remap 済みインデックスから座標を引くために生きた頂点だけの配列を作る
  const pos = new Float32Array(mesh.liveVerts * 3);
  {
    let w = 0;
    for (let v = 0; v < mesh.nv; v++) {
      if (!mesh.vAlive[v]) continue;
      pos[w * 3] = mesh.positions[v * 3];
      pos[w * 3 + 1] = mesh.positions[v * 3 + 1];
      pos[w * 3 + 2] = mesh.positions[v * 3 + 2];
      w++;
    }
  }

  let o = 84;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, pos[a], true); dv.setFloat32(o + 16, pos[a + 1], true); dv.setFloat32(o + 20, pos[a + 2], true);
    dv.setFloat32(o + 24, pos[b], true); dv.setFloat32(o + 28, pos[b + 1], true); dv.setFloat32(o + 32, pos[b + 2], true);
    dv.setFloat32(o + 36, pos[c], true); dv.setFloat32(o + 40, pos[c + 1], true); dv.setFloat32(o + 44, pos[c + 2], true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return buf;
}

/** バイナリ PLY（頂点カラー付き。ポリペイントを保持したいときはこれ） */
export function exportPLY(mesh) {
  const { remap, count, tris } = buildRemap(mesh);
  const nt = tris.length / 3;
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    'comment WebSculpt export\n' +
    `element vertex ${count}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property float nx\nproperty float ny\nproperty float nz\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
    `element face ${nt}\n` +
    'property list uchar int vertex_indices\n' +
    'end_header\n';
  const hb = new TextEncoder().encode(header);
  const vStride = 4 * 6 + 3;
  const fStride = 1 + 12;
  const buf = new ArrayBuffer(hb.length + count * vStride + nt * fStride);
  new Uint8Array(buf, 0, hb.length).set(hb);
  const dv = new DataView(buf);
  let o = hb.length;
  const clamp255 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  for (let v = 0; v < mesh.nv; v++) {
    if (remap[v] < 0) continue;
    const i = v * 3;
    dv.setFloat32(o, mesh.positions[i], true);
    dv.setFloat32(o + 4, mesh.positions[i + 1], true);
    dv.setFloat32(o + 8, mesh.positions[i + 2], true);
    dv.setFloat32(o + 12, mesh.normals[i], true);
    dv.setFloat32(o + 16, mesh.normals[i + 1], true);
    dv.setFloat32(o + 20, mesh.normals[i + 2], true);
    dv.setUint8(o + 24, clamp255(mesh.colors[i]));
    dv.setUint8(o + 25, clamp255(mesh.colors[i + 1]));
    dv.setUint8(o + 26, clamp255(mesh.colors[i + 2]));
    o += vStride;
  }
  for (let i = 0; i < tris.length; i += 3) {
    dv.setUint8(o, 3);
    dv.setInt32(o + 1, tris[i], true);
    dv.setInt32(o + 5, tris[i + 1], true);
    dv.setInt32(o + 9, tris[i + 2], true);
    o += fStride;
  }
  return buf;
}

/**
 * 読み込んだ形を原点中心・単位サイズにそろえる（シンメトリ平面が原点前提のため）。
 * 破壊的に書き換えて同じ g を返す。
 */
function normalizeImported(g) {
  const P = g.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i] < minX) minX = P[i]; if (P[i] > maxX) maxX = P[i];
    if (P[i + 1] < minY) minY = P[i + 1]; if (P[i + 1] > maxY) maxY = P[i + 1];
    if (P[i + 2] < minZ) minZ = P[i + 2]; if (P[i + 2] > maxZ) maxZ = P[i + 2];
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const s = 2 / ext;
  for (let i = 0; i < P.length; i += 3) {
    P[i] = (P[i] - cx) * s;
    P[i + 1] = (P[i + 1] - cy) * s;
    P[i + 2] = (P[i + 2] - cz) * s;
  }
  return g;
}

/**
 * **サイズの逆算でバイナリ STL と確定できるか。**
 * バイナリ STL は 80 バイトのヘッダ + 三角形数(u32) + 50 バイト × n なので、
 * ちょうど 84 + 50·n バイトになる。他の形式がこれに偶然一致することはまずない。
 *
 * 「先頭が solid ならアスキー」では判定できない。バイナリ STL の 80 バイト
 * ヘッダに "solid" と書く書き出し器が実在する。
 */
function isExactBinarySTL(buf) {
  if (!buf || buf.byteLength < 84) return false;
  const n = new DataView(buf).getUint32(80, true);
  return n > 0 && 84 + n * 50 === buf.byteLength;
}

/**
 * **STL であることが分かっている**バイト列が、バイナリかアスキーかを決める。
 * 形式の自動判別には使えない（STL 以外を渡すと「バイナリ」と答える）。
 * 判別には isExactBinarySTL を使うこと。
 */
function isBinarySTL(buf) {
  if (isExactBinarySTL(buf)) return true;
  // サイズがぴったりでない（末尾にゴミがある等）ときは中身の文字で決める。
  // 先頭 512 バイトに facet と vertex が両方あればアスキー。
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(new Uint8Array(buf, 0, Math.min(512, buf.byteLength)));
  return !(/\bfacet\b/i.test(head) && /\bvertex\b/i.test(head));
}

function parseBinarySTL(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const avail = Math.floor((buf.byteLength - 84) / 50);
  const nt = Math.min(n, avail);
  if (nt === 0) throw new Error('STL に三角形が入っていません。');
  const pos = new Float32Array(nt * 9);
  const idx = new Uint32Array(nt * 3);
  let o = 84, w = 0;
  for (let t = 0; t < nt; t++) {
    o += 12;                       // 面法線は使わない（頂点法線は後で作り直す）
    for (let k = 0; k < 9; k++) { pos[w++] = dv.getFloat32(o, true); o += 4; }
    o += 2;                        // 属性バイト数
    idx[t * 3] = t * 3; idx[t * 3 + 1] = t * 3 + 1; idx[t * 3 + 2] = t * 3 + 2;
  }
  return { positions: pos, indices: idx, tris: nt };
}

function parseAsciiSTL(text) {
  // "vertex x y z" を順に拾って 3 個ずつ 1 三角形にする。
  // facet / outer loop の入れ子は読み飛ばしてよい（頂点の順序だけが意味を持つ）。
  const re = /^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)/gim;
  const vals = [];
  let m;
  while ((m = re.exec(text))) {
    vals.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  const nt = Math.floor(vals.length / 9);
  if (nt === 0) throw new Error('STL に三角形が入っていません。');
  const pos = new Float32Array(vals.slice(0, nt * 9));
  const idx = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) idx[i] = i;
  return { positions: pos, indices: idx, tris: nt };
}

/**
 * STL を読み込む（バイナリ / アスキー両対応）。
 *
 * STL は「三角形の寄せ集め」で頂点の共有情報を持たないので、**溶接が必須**。
 * 溶接しないと 1 頂点が三角形ごとに複製された状態になり、彫刻すると面がバラバラに
 * 剥がれる（隣接が繋がっていないので ring も張れない）。
 *
 * @param {ArrayBuffer|Uint8Array|string} data
 */
export function importSTL(data) {
  let buf = null, text = null;
  if (typeof data === 'string') {
    text = data;
  } else {
    buf = data instanceof Uint8Array
      ? (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data.buffer : data.slice().buffer)
      : data;
  }
  const raw = text !== null
    ? parseAsciiSTL(text)
    : (isBinarySTL(buf) ? parseBinarySTL(buf)
      : parseAsciiSTL(new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf))));

  // 溶接のしきい値はモデルの大きさに対する相対値にする。STL は mm 単位で
  // 座標が数百になることが多く、固定の 1e-6 では同じ点が別頂点のまま残る。
  const P = raw.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i] < minX) minX = P[i]; if (P[i] > maxX) maxX = P[i];
    if (P[i + 1] < minY) minY = P[i + 1]; if (P[i + 1] > maxY) maxY = P[i + 1];
    if (P[i + 2] < minZ) minZ = P[i + 2]; if (P[i + 2] > maxZ) maxZ = P[i + 2];
  }
  const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const g = weld(P, raw.indices, ext * 1e-6);
  g.sourceTris = raw.tris;
  return normalizeImported(g);
}

/** OBJ を読み込む（法線 / UV は無視、N 角形は扇状に三角形化、頂点は溶接） */
export function importOBJ(text) {
  const pos = [];
  const idx = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.length < 2) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 118 /* v */ && line.charCodeAt(1) === 32) {
      const p = line.split(/\s+/);
      pos.push(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]));
    } else if (c0 === 102 /* f */ && (line.charCodeAt(1) === 32 || line.charCodeAt(1) === 9)) {
      const p = line.trim().split(/\s+/);
      const vi = [];
      for (let i = 1; i < p.length; i++) {
        const s = p[i].split('/')[0];
        let n = parseInt(s, 10);
        if (Number.isNaN(n)) continue;
        if (n < 0) n = pos.length / 3 + n; else n -= 1;
        vi.push(n);
      }
      for (let i = 1; i + 1 < vi.length; i++) idx.push(vi[0], vi[i], vi[i + 1]);
    }
  }
  if (pos.length === 0 || idx.length === 0) throw new Error('OBJ に有効な頂点 / 面が見つかりません。');
  const g = weld(new Float32Array(pos), new Uint32Array(idx), 1e-6);
  return normalizeImported(g);
}

/**
 * 拡張子とファイルの中身から形式を見分けて読み込む。
 * @param {string} name ファイル名（拡張子を見る）
 * @param {ArrayBuffer} buf 中身
 */
export function importMesh(name, buf) {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '');
  const kind = ext ? ext[1].toLowerCase() : '';
  if (kind === 'stl') return { kind: 'STL', geom: importSTL(buf) };
  if (kind === 'obj') {
    return { kind: 'OBJ', geom: importOBJ(new TextDecoder().decode(new Uint8Array(buf))) };
  }
  // 拡張子が無い / 知らない場合は中身で判断する。
  // バイナリ STL はサイズの逆算でほぼ確実に分かる。
  if (isExactBinarySTL(buf)) return { kind: 'STL', geom: importSTL(buf) };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf));
  // アスキー STL は facet と vertex の両方を持つ。OBJ には facet が無いので
  // これで分かれる（solid だけを見ると OBJ のコメント行に引っかかりうる）。
  if (/\bfacet\b/i.test(text) && /\bvertex\b/i.test(text)) {
    return { kind: 'STL', geom: importSTL(text) };
  }
  return { kind: 'OBJ', geom: importOBJ(text) };
}

export function download(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
