// ---------------------------------------------------------------------------
// io.js - OBJ / STL / PLY の書き出しと OBJ 読み込み
// 死んだ頂点・三角形はリマップして除外する。
// ---------------------------------------------------------------------------

import { weld } from './mesh.js';

function buildRemap(mesh) {
  const remap = new Int32Array(mesh.nv).fill(-1);
  let n = 0;
  for (let v = 0; v < mesh.nv; v++) if (mesh.vAlive[v]) remap[v] = n++;
  const tris = [];
  const T = mesh.tris;
  for (let t = 0; t < mesh.nt; t++) {
    const i = t * 3;
    const a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    const ra = remap[a], rb = remap[b], rc = remap[c];
    if (ra < 0 || rb < 0 || rc < 0) continue;
    tris.push(ra, rb, rc);
  }
  return { remap, count: n, tris };
}

/**
 * @param {object} opt
 *   quads: remesh.quadDominant() の出力を渡すと四角優勢の面リストで書き出す。
 *          ZRemesher の出力は四角なので、他のツールで開いたときの見た目を近づけられる。
 */
export function exportOBJ(mesh, { withColor = true, name = 'websculpt', quads = null } = {}) {
  const { remap, count, tris } = buildRemap(mesh);
  const P = mesh.positions, N = mesh.normals, C = mesh.colors;
  const out = [];
  out.push(`# WebSculpt export`);
  out.push(`# verts ${count} tris ${tris.length / 3}`);
  out.push(`o ${name}`);
  const f = (x) => (Math.round(x * 1e6) / 1e6);
  for (let v = 0; v < mesh.nv; v++) {
    if (remap[v] < 0) continue;
    const i = v * 3;
    if (withColor) {
      out.push(`v ${f(P[i])} ${f(P[i + 1])} ${f(P[i + 2])} ${f(C[i])} ${f(C[i + 1])} ${f(C[i + 2])}`);
    } else {
      out.push(`v ${f(P[i])} ${f(P[i + 1])} ${f(P[i + 2])}`);
    }
  }
  for (let v = 0; v < mesh.nv; v++) {
    if (remap[v] < 0) continue;
    const i = v * 3;
    out.push(`vn ${f(N[i])} ${f(N[i + 1])} ${f(N[i + 2])}`);
  }
  if (quads && quads.offsets && quads.offsets.length > 1) {
    // 四角優勢の面リストが渡されたらそれを書く（remesh.quadDominant の出力）。
    // 三角形も混ざるので、面ごとに頂点数が変わる形で出す。
    // 頂点番号はメッシュ側のものなので remap を通す。
    const F = quads.faces, O = quads.offsets;
    for (let k = 0; k + 1 < O.length; k++) {
      let line = 'f';
      let bad = false;
      for (let i = O[k]; i < O[k + 1]; i++) {
        const r = remap[F[i]];
        if (r < 0) { bad = true; break; }
        const n = r + 1;
        line += ' ' + n + '//' + n;
      }
      if (!bad) out.push(line);
    }
  } else {
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i] + 1, b = tris[i + 1] + 1, c = tris[i + 2] + 1;
      out.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
  }
  return out.join('\n') + '\n';
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

  // 原点中心・単位サイズに正規化（シンメトリ平面が原点前提のため）
  const P = g.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
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
