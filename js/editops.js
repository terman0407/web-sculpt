// ---------------------------------------------------------------------------
// editops.js
// 編集メッシュに対するモデリング操作（段 2 / 段 3）。
//
// editmesh.js が「データ構造と選択」、こちらが「形を変える操作」。
//
// ここが Blender らしさの核。ループカットもエッジループ選択も
// **「四角を跨いで向かい合う辺へ渡っていく」歩き方**の上に載っている。
// だから最初にその歩き方（edgeRing / edgeLoop）を作り、その上に操作を積む。
//
// 面の巻き方（winding）は全部の操作で保つこと。逆にすると裏返った面ができて、
// 見た目は「黒い穴」になり原因が分かりにくい。各操作のコメントに、なぜその
// 順序なのかを立方体で確かめた結果として書いてある。
// ---------------------------------------------------------------------------

/** 頂点 a-b を結ぶ辺の番号。無ければ -1 */
export function edgeOf(em, a, b) {
  for (let i = em.vEdgeStart[a]; i < em.vEdgeStart[a + 1]; i++) {
    const e = em.vEdge[i];
    if (em.edgeA[e] === b || em.edgeB[e] === b) return e;
  }
  return -1;
}

/** 面 f の頂点ループの中で、辺 e が何番目の辺として現れるか。無ければ -1 */
function edgeSlotInFace(em, f, e) {
  const s = em.faceStart[f], n = em.faceSize(f);
  const a = em.edgeA[e], b = em.edgeB[e];
  for (let k = 0; k < n; k++) {
    const u = em.faceVerts[s + k], v = em.faceVerts[s + (k + 1) % n];
    if ((u === a && v === b) || (u === b && v === a)) return k;
  }
  return -1;
}

/** 四角 f の中で辺 e の向かい側にある辺。四角でなければ -1 */
export function oppositeEdgeInQuad(em, f, e) {
  if (f < 0 || em.faceSize(f) !== 4) return -1;
  const k = edgeSlotInFace(em, f, e);
  if (k < 0) return -1;
  const s = em.faceStart[f];
  return edgeOf(em, em.faceVerts[s + (k + 2) % 4], em.faceVerts[s + (k + 3) % 4]);
}

/**
 * エッジリング。辺 e から「四角を跨いで向かい側の辺へ」渡り続けた列。
 * ループカットが入る場所そのもの。
 *
 * 四角でない面に当たったらそこで止まる（三角形には向かい側の辺が無い）。
 * 一周して戻ってきたら閉じたリングとして終わる。
 *
 * @returns {{edges: number[], faces: number[], closed: boolean}}
 *   faces は渡った四角の列。
 */
export function edgeRing(em, e0) {
  const seen = new Set([e0]);
  const fwdE = [], backE = [], fwdF = [], backF = [];
  let closed = false;

  for (let dir = 0; dir < 2; dir++) {
    let cur = e0;
    let face = em.edgeFace[e0 * 2 + dir];
    const outE = dir === 0 ? fwdE : backE;
    const outF = dir === 0 ? fwdF : backF;
    for (let guard = 0; guard < 1000000; guard++) {
      if (face < 0 || em.faceSize(face) !== 4) break;
      const nxt = oppositeEdgeInQuad(em, face, cur);
      if (nxt < 0) break;
      outF.push(face);
      if (nxt === e0) { closed = true; break; }     // 一周した
      if (seen.has(nxt)) break;                     // 8 の字。ここで止める
      seen.add(nxt);
      outE.push(nxt);
      const f0 = em.edgeFace[nxt * 2], f1 = em.edgeFace[nxt * 2 + 1];
      face = f0 === face ? f1 : f0;
      cur = nxt;
    }
    if (closed) break;      // 閉じたなら反対方向は歩かなくてよい
  }
  backE.reverse(); backF.reverse();
  return {
    edges: [...backE, e0, ...fwdE],
    faces: closed ? fwdF : [...backF, ...fwdF],
    closed,
  };
}

/**
 * エッジループ。辺 e から「頂点を跨いで向かい側の辺へ」渡り続けた列。
 * リングと違って辺が一列に繋がる（Blender の Alt+クリック）。
 *
 * 「向かい側」と言えるのは、その頂点に辺が 4 本ある場合だけ（四角メッシュの
 * 普通の頂点）。いまの辺と面を共有しない辺がちょうど 1 本あればそれを採る。
 * 4 本でない頂点（極や境界）に来たらそこで止まる。
 */
export function edgeLoop(em, e0) {
  const seen = new Set([e0]);
  const parts = [[], []];
  let closed = false;

  const nextEdge = (v, e) => {
    if (em.vEdgeStart[v + 1] - em.vEdgeStart[v] !== 4) return -1;
    const f0 = em.edgeFace[e * 2], f1 = em.edgeFace[e * 2 + 1];
    let found = -1, count = 0;
    for (let i = em.vEdgeStart[v]; i < em.vEdgeStart[v + 1]; i++) {
      const c = em.vEdge[i];
      if (c === e) continue;
      const g0 = em.edgeFace[c * 2], g1 = em.edgeFace[c * 2 + 1];
      if (g0 === f0 || g0 === f1 || g1 === f0 || g1 === f1) continue;
      found = c; count++;
    }
    return count === 1 ? found : -1;
  };

  for (let dir = 0; dir < 2; dir++) {
    let cur = e0;
    let v = dir === 0 ? em.edgeB[e0] : em.edgeA[e0];
    const out = parts[dir];
    for (let guard = 0; guard < 1000000; guard++) {
      const nxt = nextEdge(v, cur);
      if (nxt < 0) break;
      if (nxt === e0) { closed = true; break; }
      if (seen.has(nxt)) break;
      seen.add(nxt);
      out.push(nxt);
      v = em.edgeA[nxt] === v ? em.edgeB[nxt] : em.edgeA[nxt];
      cur = nxt;
    }
    if (closed) break;
  }
  parts[1].reverse();
  return { edges: [...parts[1], e0, ...parts[0]], closed };
}

/**
 * 選択中の辺それぞれのループ / リングを選択に足す。
 * @param {string} kind 'loop' | 'ring'
 */
export function selectLoopOrRing(em, kind) {
  const seeds = [];
  for (let e = 0; e < em.ne; e++) if (em.selEdge[e]) seeds.push(e);
  if (seeds.length === 0) return { added: 0, seeds: 0 };
  let added = 0;
  for (const e of seeds) {
    const r = kind === 'ring' ? edgeRing(em, e) : edgeLoop(em, e);
    for (const x of r.edges) if (!em.selEdge[x]) { em.selEdge[x] = 1; added++; }
  }
  em.syncSelection('edge');
  return { added, seeds: seeds.length };
}

/**
 * ループカット。選択した辺のエッジリングに沿って四角を割る。
 *
 * リングの各辺に中点（cuts 本なら等分点）を作り、跨いだ四角それぞれを
 * 「向かい合う 2 辺の分割点」で cuts+1 枚の四角に割る。Blender の Ctrl+R と同じ。
 *
 * 巻き方: 元の四角 (a,b,c,d) で a-b と c-d がリングの辺のとき、
 * 割った四角は (a, m0, m1, d) と (m0, b, c, m1)。どちらも元と同じ向きになる
 * （立方体で法線を確かめた）。
 *
 * @param {number} cuts 何本入れるか
 */
export function loopCut(em, cuts = 1) {
  const n = Math.max(1, Math.min(16, Math.round(cuts)));
  const seeds = [];
  for (let e = 0; e < em.ne; e++) if (em.selEdge[e]) seeds.push(e);
  if (seeds.length === 0) return { rings: 0, edges: 0, faces: 0, refused: 0 };

  // 同じリングを二度切らないように、処理済みの辺を覚えておく
  // **面を取り合うリングは同時に切れない。**
  // 直交する 2 リングは同じ四角を共有するので、その四角は 4 分割しないと
  // 辻褄が合わない（片方だけ割ると分割点が浮いて穴が開く。実測で境界辺 12 本、
  // オイラー標数 -2 になった）。先に取った側を通し、あとは断る。
  // Blender の Ctrl+R も 1 リングずつなので、これで挙動も揃う。
  const done = new Uint8Array(em.ne);
  const claimed = new Set();
  const rings = [];
  let refusedSeeds = 0;
  for (const e of seeds) {
    if (done[e]) continue;
    const r = edgeRing(em, e);
    for (const x of r.edges) done[x] = 1;
    if (r.faces.length === 0) { refusedSeeds++; continue; }
    let overlap = false;
    for (const f of r.faces) if (claimed.has(f)) { overlap = true; break; }
    if (overlap) { refusedSeeds++; continue; }
    for (const f of r.faces) claimed.add(f);
    rings.push(r);
  }
  if (rings.length === 0) return { rings: 0, edges: 0, faces: 0, refused: seeds.length };

  const P = Array.from(em.positions);
  const newV = new Map();               // 辺番号 → 分割点の配列（A→B 順）
  let nv = em.nv;
  const firstNew = nv;
  for (const r of rings) {
    for (const e of r.edges) {
      if (newV.has(e)) continue;
      const a = em.edgeA[e] * 3, b = em.edgeB[e] * 3;
      const list = [];
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        P.push(em.positions[a] + (em.positions[b] - em.positions[a]) * t);
        P.push(em.positions[a + 1] + (em.positions[b + 1] - em.positions[a + 1]) * t);
        P.push(em.positions[a + 2] + (em.positions[b + 2] - em.positions[a + 2]) * t);
        list.push(nv++);
      }
      newV.set(e, list);
    }
  }

  const kill = new Set();
  const add = [];
  for (const r of rings) {
    for (const f of r.faces) {
      if (kill.has(f)) continue;
      const s = em.faceStart[f];
      let k0 = -1, e0 = -1, e1 = -1;
      for (let k = 0; k < 4; k++) {
        const e = edgeOf(em, em.faceVerts[s + k], em.faceVerts[s + (k + 1) % 4]);
        if (e < 0 || !newV.has(e)) continue;
        const opp = edgeOf(em, em.faceVerts[s + (k + 2) % 4], em.faceVerts[s + (k + 3) % 4]);
        if (opp >= 0 && newV.has(opp)) { k0 = k; e0 = e; e1 = opp; break; }
      }
      if (k0 < 0) continue;
      const a = em.faceVerts[s + k0], b = em.faceVerts[s + (k0 + 1) % 4];
      const c = em.faceVerts[s + (k0 + 2) % 4], d = em.faceVerts[s + (k0 + 3) % 4];
      // e0 の分割点を a→b 向き、e1 の分割点を c→d 向きに並べる
      const m0 = em.edgeA[e0] === a ? newV.get(e0).slice() : newV.get(e0).slice().reverse();
      const m1 = em.edgeA[e1] === c ? newV.get(e1).slice() : newV.get(e1).slice().reverse();
      let prevL = a, prevR = d;
      for (let k = 0; k < n; k++) {
        add.push([prevL, m0[k], m1[n - 1 - k], prevR]);
        prevL = m0[k]; prevR = m1[n - 1 - k];
      }
      add.push([prevL, b, c, prevR]);
      kill.add(f);
    }
  }
  if (kill.size === 0) return { rings: 0, edges: 0, faces: 0, refused: seeds.length };

  em.positions = new Float32Array(P);
  em.nv = nv;
  em.selVert = new Uint8Array(nv);
  em._replaceFaces([...kill], add);
  em.rebuild();
  // 入れた辺（分割点どうしを結ぶもの）を選択にしておく。続けて動かせるように
  em.clearSelection();
  for (let e = 0; e < em.ne; e++) {
    if (em.edgeA[e] >= firstNew && em.edgeB[e] >= firstNew) em.selEdge[e] = 1;
  }
  em.syncSelection('edge');
  em.version++; em.topoVersion++;
  return { rings: rings.length, edges: newV.size, faces: kill.size, refused: refusedSeeds, cuts: n };
}

/**
 * 選択面の「隅」を、頂点ごと・扇ごとのまとまりに分ける。
 *
 * 隅 = （面, その面のループ中の 1 頂点）。faceVerts の添字がそのまま隅の識別子に
 * なるので、番号を振り直す必要がない。
 *
 * 同じ頂点の隅どうしを、**選択領域の内側の辺をまたいで**繋ぐ（Union-Find）。
 * こうすると「ある頂点のまわりで、選択面が辺を通って繋がっているかたまり」が
 * 1 つのまとまりになる。領域が辺では繋がらず頂点だけで触れ合っているとき
 * （砂時計形）は、同じ頂点にまとまりが 2 つできる。
 *
 * 押し出しと領域インセットは、どちらも「まとまりごとに新しい頂点を 1 個作る」。
 * 頂点ごとに 1 個で済ませると、砂時計の腰のところで辺に面が 4 枚集まって
 * 非多様体になる。
 *
 * @returns {{cid: Int32Array, cvert: Int32Array, nc: number, find: (x: number) => number}}
 *   cid[faceVerts の添字] → 隅の番号（選択外は -1）、cvert[隅] → 頂点、
 *   find(隅) → まとまりの代表
 */
function cornerGroups(em, sel, selSet) {
  const cid = new Int32Array(em.faceVerts.length).fill(-1);
  let nc = 0;
  for (const f of sel) for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) cid[i] = nc++;
  const cvert = new Int32Array(nc);
  for (const f of sel) for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) cvert[cid[i]] = em.faceVerts[i];
  const parent = new Int32Array(nc);
  for (let c = 0; c < nc; c++) parent[c] = c;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };

  for (const f of sel) {
    const s = em.faceStart[f], n = em.faceSize(f);
    for (let k = 0; k < n; k++) {
      const ia = s + k, ib = s + (k + 1) % n;
      const a = em.faceVerts[ia], b = em.faceVerts[ib];
      const e = edgeOf(em, a, b);
      if (e < 0) continue;
      const f0 = em.edgeFace[e * 2], f1 = em.edgeFace[e * 2 + 1];
      const g = f0 === f ? f1 : f0;
      if (g < 0 || !selSet.has(g)) continue;
      const gs = em.faceStart[g], gn = em.faceSize(g);
      for (let j = 0; j < gn; j++) {
        const u = em.faceVerts[gs + j];
        if (u !== a && u !== b) continue;
        const x = find(cid[u === a ? ia : ib]), y = find(cid[gs + j]);
        if (x !== y) parent[y] = x;
      }
    }
  }
  return { cid, cvert, nc, find };
}

/** 選択領域の縁の辺（反対側の面が選択されていない辺）を、面ごとの隅の対で返す */
function regionRim(em, sel, selSet) {
  const rim = [];
  for (const f of sel) {
    const s = em.faceStart[f], n = em.faceSize(f);
    for (let k = 0; k < n; k++) {
      const ia = s + k, ib = s + (k + 1) % n;
      const e = edgeOf(em, em.faceVerts[ia], em.faceVerts[ib]);
      if (e < 0) continue;
      const f0 = em.edgeFace[e * 2], f1 = em.edgeFace[e * 2 + 1];
      const other = f0 === f ? f1 : f0;
      if (other >= 0 && selSet.has(other)) continue;
      rim.push([f, ia, ib]);
    }
  }
  return rim;
}

/**
 * 選択した面を押し出す。
 *
 * 選択領域の頂点を複製して選択面をそちらへ繋ぎ替え、領域の縁に側面の四角を張る。
 *
 * 巻き方: 選択面のループに現れる辺の向き (a→b) に対して側面は **(a, b, b', a')**。
 * 立方体の z=-1 面（法線 -Z）でこれを確かめた。逆順の (a, a', b', b) にすると
 * 側面の法線が内向きになり、絵では「黒い穴」に見える（最初それで間違えた）。
 *
 * 動かす向きは **頂点ごとの法線**（その頂点に触っている選択面の平均）を使う。
 * 領域の平均法線ひとつで動かすと、向きの違う面をまとめて選んだときに
 * 平均が打ち消し合って動かない（実測で複製した頂点が元の位置に重なった）。
 *
 * 複製は「頂点ごと」ではなく **「頂点のまわりで、選択辺を通って繋がる面のまとまり
 * ごと」**。ある頂点で選択領域が辺では繋がらず頂点だけで触れ合っているとき
 * （砂時計形）、複製を 1 個で済ませるとその縦の辺に壁が 4 枚集まって非多様体になる。
 * まとまりごとに分ければ、それぞれが自分の縦辺を持つので辺は 2 面のままになる。
 * 立方体の全辺をベベルして帯をまとめて押し出す流れがちょうどこれに当たる
 * （帯は互いに辺を共有せず、24 個の扇頂点をそれぞれ 2 枚で分け合っている。
 *  以前は非多様体辺が 48 本出ていた）。
 * 普通の（辺で繋がった）領域ではまとまりが 1 つになるので結果は変わらない。
 *
 * @param {number} offset 法線方向に動かす量
 */
export function extrudeSelectedFaces(em, offset = 0) {
  const sel = [];
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f] && em.selFace[f]) sel.push(f);
  if (sel.length === 0) return { faces: 0, verts: 0, walls: 0 };
  const selSet = new Set(sel);
  const { cid, cvert, find } = cornerGroups(em, sel, selSet);

  // まとまりごとに 1 個ずつ複製する
  const P = Array.from(em.positions);
  let nv = em.nv;
  const dup = new Map();            // まとまりの代表 → 新頂点
  for (const f of sel) {
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
      const r = find(cid[i]);
      if (dup.has(r)) continue;
      const v = cvert[r];
      dup.set(r, nv++);
      P.push(em.positions[v * 3], em.positions[v * 3 + 1], em.positions[v * 3 + 2]);
    }
  }
  const dupAt = (i) => dup.get(find(cid[i]));

  // まとまりごとの法線（そこに触っている選択面の平均）と、領域全体の平均法線
  const vn = new Map();
  const nrm = new Float64Array(3);
  let ax = 0, ay = 0, az = 0;
  for (const f of sel) {
    em.faceNormal(f, nrm);
    ax += nrm[0]; ay += nrm[1]; az += nrm[2];
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
      const r = find(cid[i]);
      let a = vn.get(r);
      if (!a) { a = [0, 0, 0]; vn.set(r, a); }
      a[0] += nrm[0]; a[1] += nrm[1]; a[2] += nrm[2];
    }
  }
  {
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l;
  }
  if (offset !== 0) {
    for (const [r, nvi] of dup) {
      const a = vn.get(r) || [ax, ay, az];
      const l = Math.hypot(a[0], a[1], a[2]);
      // 法線が打ち消し合った頂点だけ、領域の平均法線で逃がす
      const dx = l > 1e-6 ? a[0] / l : ax;
      const dy = l > 1e-6 ? a[1] / l : ay;
      const dz = l > 1e-6 ? a[2] / l : az;
      P[nvi * 3] += dx * offset;
      P[nvi * 3 + 1] += dy * offset;
      P[nvi * 3 + 2] += dz * offset;
    }
  }

  const add = [];
  for (const f of sel) {
    const loop = [];
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) loop.push(dupAt(i));
    add.push(loop);
  }
  const rim = regionRim(em, sel, selSet);
  for (const [, ia, ib] of rim) {
    add.push([em.faceVerts[ia], em.faceVerts[ib], dupAt(ib), dupAt(ia)]);
  }
  const walls = rim.length;

  em.positions = new Float32Array(P);
  em.nv = nv;
  em.selVert = new Uint8Array(nv);
  em._replaceFaces(sel, add);
  em.rebuild();
  // 押し出した面（複製側だけで構成された面）を選択にしておく
  em.clearSelection();
  const dupSet = new Set(dup.values());
  for (let f = 0; f < em.nf; f++) {
    if (!em.faceAlive[f]) continue;
    let all = true;
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
      if (!dupSet.has(em.faceVerts[i])) { all = false; break; }
    }
    if (all) em.selFace[f] = 1;
  }
  em.syncSelection('face');
  em.version++; em.topoVersion++;
  return { faces: sel.length, verts: dup.size, walls, normal: [ax, ay, az] };
}

/**
 * 選択した面をインセットする（**面ごと**）。
 *
 * 各面の頂点を重心へ寄せた内側のループを作り、元の縁と内側の間に四角の輪を張る。
 * Blender の Shift+I（面ごと）に相当する。領域まとめてのインセットではないので、
 * 隣り合う面を同時にインセットすると境目に細い四角の帯ができる。
 * 1 枚だけ選んでいるときは Blender の I と同じ結果になる。
 *
 * 巻き方: 内側の面は元と同じ順序、輪は (vk, vk+1, ring[k+1], ring[k])。
 * 平面の正方形で確かめると、どちらも元の法線と同じ向きになる。
 *
 * @param {number} amount 0..1。重心へ寄せる割合
 */
export function insetSelectedFaces(em, amount = 0.2) {
  const t = Math.max(0.001, Math.min(0.95, amount));
  const sel = [];
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f] && em.selFace[f]) sel.push(f);
  if (sel.length === 0) return { faces: 0, verts: 0 };

  const P = Array.from(em.positions);
  let nv = em.nv;
  const add = [];
  const innerSets = [];
  const c = new Float64Array(3);
  for (const f of sel) {
    em.faceCenter(f, c);
    const s = em.faceStart[f], n = em.faceSize(f);
    const ring = [];
    for (let k = 0; k < n; k++) {
      const i = em.faceVerts[s + k] * 3;
      P.push(em.positions[i] + (c[0] - em.positions[i]) * t);
      P.push(em.positions[i + 1] + (c[1] - em.positions[i + 1]) * t);
      P.push(em.positions[i + 2] + (c[2] - em.positions[i + 2]) * t);
      ring.push(nv++);
    }
    add.push(ring.slice());
    innerSets.push(new Set(ring));
    for (let k = 0; k < n; k++) {
      add.push([
        em.faceVerts[s + k], em.faceVerts[s + (k + 1) % n],
        ring[(k + 1) % n], ring[k],
      ]);
    }
  }
  const newVerts = nv - em.nv;

  em.positions = new Float32Array(P);
  em.nv = nv;
  em.selVert = new Uint8Array(nv);
  em._replaceFaces(sel, add);
  em.rebuild();
  // 内側の面を選択にしておく（続けて押し出せるように）
  em.clearSelection();
  for (let f = 0; f < em.nf; f++) {
    if (!em.faceAlive[f]) continue;
    const n = em.faceSize(f);
    for (const set of innerSets) {
      if (set.size !== n) continue;
      let all = true;
      for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
        if (!set.has(em.faceVerts[i])) { all = false; break; }
      }
      if (all) { em.selFace[f] = 1; break; }
    }
  }
  em.syncSelection('face');
  em.version++; em.topoVersion++;
  return { faces: sel.length, verts: newVerts };
}

/**
 * 選択した面を**領域まとめて**インセットする（Blender の I）。
 *
 * `insetSelectedFaces`（Shift+I 相当）が面 1 枚ずつ縮めるのに対して、こちらは
 * 選択領域を 1 つの塊として扱う。**領域の縁の頂点だけ**を内側へ寄せた新頂点に
 * 置き換え、領域の内側の頂点はそのまま使う。だから隣り合う面の境目に帯ができない。
 *
 * 内側へ寄せる向きは、その頂点に触っている**選択面の重心の平均**へ向かう方向。
 * 面ごとインセットが「その面の重心へ寄せる」のと同じ考え方で、選択が 1 枚のときは
 * 面ごとインセットと同じ結果になる。領域全体の重心へ寄せる方式は、大きい領域や
 * 凹んだ領域で遠い側が中心へ吸い寄せられて潰れるので採らない。
 *
 * 巻き方は面ごとインセットと同じ (a, b, inner(b), inner(a))。
 *
 * 縁が無いとき（閉じた形を全部選んだとき）は、縮める先が無いので理由を出して断る。
 *
 * @param {number} amount 0..1。重心へ寄せる割合
 */
export function insetRegion(em, amount = 0.2) {
  const t = Math.max(0.001, Math.min(0.95, amount));
  const sel = [];
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f] && em.selFace[f]) sel.push(f);
  if (sel.length === 0) return { faces: 0, verts: 0, band: 0, reason: '面が選択されていません' };
  const selSet = new Set(sel);
  const { cid, cvert, find } = cornerGroups(em, sel, selSet);

  const rim = regionRim(em, sel, selSet);
  if (rim.length === 0) {
    return {
      faces: 0, verts: 0, band: 0,
      reason: '選択領域に縁がありません（閉じた形を全部選ぶと内側へ寄せる先がありません）。'
        + '一部だけ選んでから実行してください',
    };
  }
  // 縁に触っているまとまりだけが新頂点を持つ。内側の頂点は動かさない
  const needs = new Set();
  for (const [, ia, ib] of rim) { needs.add(find(cid[ia])); needs.add(find(cid[ib])); }

  // まとまりごとに「触っている選択面の重心の平均」を出す
  const acc = new Map();
  const c = new Float64Array(3);
  for (const f of sel) {
    em.faceCenter(f, c);
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
      const r = find(cid[i]);
      if (!needs.has(r)) continue;
      let a = acc.get(r);
      if (!a) { a = [0, 0, 0, 0]; acc.set(r, a); }
      a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; a[3]++;
    }
  }
  const P = Array.from(em.positions);
  let nv = em.nv;
  const inner = new Map();          // まとまりの代表 → 内側の新頂点
  for (const [r, a] of acc) {
    const i3 = cvert[r] * 3;
    const inv = 1 / a[3];
    const ox = em.positions[i3], oy = em.positions[i3 + 1], oz = em.positions[i3 + 2];
    P.push(ox + (a[0] * inv - ox) * t, oy + (a[1] * inv - oy) * t, oz + (a[2] * inv - oz) * t);
    inner.set(r, nv++);
  }

  const add = [];
  for (const f of sel) {
    const loop = [];
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
      const w = inner.get(find(cid[i]));
      loop.push(w === undefined ? em.faceVerts[i] : w);
    }
    add.push(loop);
  }
  for (const [, ia, ib] of rim) {
    add.push([em.faceVerts[ia], em.faceVerts[ib], inner.get(find(cid[ib])), inner.get(find(cid[ia]))]);
  }

  // _replaceFaces は「生き残り → add」の順に並べるので、縮めた面は先頭 sel.length 枚
  let survivors = 0;
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f] && !selSet.has(f)) survivors++;

  em.positions = new Float32Array(P);
  em.nv = nv;
  em.selVert = new Uint8Array(nv);
  em._replaceFaces(sel, add);
  em.rebuild();
  // 縮めた領域を選択にしておく（続けて押し出せば凹みになる）
  em.clearSelection();
  for (let i = 0; i < sel.length; i++) {
    const f = survivors + i;
    if (f < em.nf && em.faceAlive[f]) em.selFace[f] = 1;
  }
  em.syncSelection('face');
  em.version++; em.topoVersion++;
  return { faces: sel.length, verts: inner.size, band: rim.length, reason: '' };
}

/**
 * 選択した面を 4 分割する（四角 → 四角 4 枚。n-gon → 四角 n 枚）。
 *
 * 辺の中点は隣の面と**共有する**。共有しないと同じ位置に頂点が 2 個できて、
 * 見た目は同じでも繋がっていないメッシュになる（あとで押し出すと裂ける）。
 *
 * 一部だけを細分化したときは、**隣の未選択面にも中点を差し込んで n-gon にする**。
 * これをやらないと隣の面は元の辺 (a,b) を使い続け、細分化した側は (a,m) と (m,b)
 * を使うので、同じ場所に「1 面しか付いていない辺」が並ぶ（T 字接合 = 割れ目）。
 * 実測で境界辺が 24 本できた。
 */
export function subdivideSelectedFaces(em) {
  const sel = [];
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f] && em.selFace[f]) sel.push(f);
  if (sel.length === 0) return { faces: 0, verts: 0 };
  const selSet = new Set(sel);

  const P = Array.from(em.positions);
  let nv = em.nv;
  const mid = new Map();
  const midOf = (e) => {
    let m = mid.get(e);
    if (m !== undefined) return m;
    const a = em.edgeA[e] * 3, b = em.edgeB[e] * 3;
    P.push((em.positions[a] + em.positions[b]) * 0.5);
    P.push((em.positions[a + 1] + em.positions[b + 1]) * 0.5);
    P.push((em.positions[a + 2] + em.positions[b + 2]) * 0.5);
    m = nv++;
    mid.set(e, m);
    return m;
  };

  const add = [];
  const c = new Float64Array(3);
  for (const f of sel) {
    const s = em.faceStart[f], n = em.faceSize(f);
    em.faceCenter(f, c);
    P.push(c[0], c[1], c[2]);
    const ctr = nv++;
    const ms = [];
    let bad = false;
    for (let k = 0; k < n; k++) {
      const e = edgeOf(em, em.faceVerts[s + k], em.faceVerts[s + (k + 1) % n]);
      if (e < 0) { bad = true; break; }
      ms.push(midOf(e));
    }
    if (bad) continue;
    // 各角に「前の中点 → 角 → 次の中点 → 中心」の四角。元の巻き方が保たれる
    for (let k = 0; k < n; k++) {
      add.push([ms[(k + n - 1) % n], em.faceVerts[s + k], ms[k], ctr]);
    }
  }
  const newVerts = nv - em.nv;

  // 隣の未選択面に中点を差し込む（T 字接合を作らない）
  const patch = [];
  for (let f = 0; f < em.nf; f++) {
    if (!em.faceAlive[f] || selSet.has(f)) continue;
    const s = em.faceStart[f], n = em.faceSize(f);
    let touched = false;
    const loop = [];
    for (let k = 0; k < n; k++) {
      const u = em.faceVerts[s + k], v = em.faceVerts[s + (k + 1) % n];
      loop.push(u);
      const e = edgeOf(em, u, v);
      if (e < 0) continue;
      const m = mid.get(e);
      if (m !== undefined) { loop.push(m); touched = true; }
    }
    if (touched) patch.push({ f, loop });
  }
  for (const p of patch) add.push(p.loop);

  em.positions = new Float32Array(P);
  em.nv = nv;
  em.selVert = new Uint8Array(nv);
  em._replaceFaces([...sel, ...patch.map(p => p.f)], add);
  em.rebuild();
  em.clearSelection();
  em.version++; em.topoVersion++;
  return { faces: sel.length, verts: newVerts };
}

// ---------------------------------------------------------------------------
// ベベル（面取り）
//
// 一度「辺の両側 2 面を内側へ寄せて帯を張る」だけで書いて失敗した。辺 (a,b) の
// 両端の頂点を使っている 3 枚目の面との間に隙間が残る（立方体では 1 頂点に 3 面）。
// 実測で境界辺 10 本・オイラー標数 0。**帯を張るだけでは駄目で、頂点を分割する
// 必要がある。**
//
// 正しい手順:
//   1. 頂点まわりの面を回転順に並べる（扇）
//   2. ベベルする辺のところで扇を区切る。k 本のベベル辺があれば k 個の区間になる
//   3. 区間ごとに新しい頂点を 1 個作る（= 頂点の分割）
//   4. 各面は、自分が属する区間の新頂点を使うように作り直す
//   5. ベベル辺ごとに、両側の新頂点 4 個で帯を 1 枚張る
//   6. **ベベル辺が 3 本以上集まる頂点には「角の面」を 1 枚張る**（前回抜けていた処理）
// ---------------------------------------------------------------------------

/** 面 f のループで、頂点 v の次に来る頂点への辺（出ていく辺） */
function outEdgeAt(em, f, v) {
  const s = em.faceStart[f], n = em.faceSize(f);
  for (let k = 0; k < n; k++) {
    if (em.faceVerts[s + k] !== v) continue;
    return edgeOf(em, v, em.faceVerts[s + (k + 1) % n]);
  }
  return -1;
}

/**
 * 頂点 v のまわりの面を回転順に並べる。
 *
 * 各面 f について「v から出ていく辺」を取り、その辺のもう片方の面へ渡る。
 * これを繰り返すと扇を一定の向きに回れる。
 *
 * @returns {{faces: number[], seps: number[], closed: boolean}|null}
 *   faces[i] と faces[i+1] の間の辺が seps[i]（閉じているなら seps は faces と同じ長さ）。
 *   境界がある・非多様体で一周できない場合は null。
 */
function vertexFan(em, v) {
  const start = em.vFaceStart[v], end = em.vFaceStart[v + 1];
  const total = end - start;
  if (total === 0) return null;
  const f0 = em.vFace[start];
  const faces = [f0], seps = [];
  let f = f0;
  for (let guard = 0; guard < total + 2; guard++) {
    const e = outEdgeAt(em, f, v);
    if (e < 0) return null;
    const g0 = em.edgeFace[e * 2], g1 = em.edgeFace[e * 2 + 1];
    if (g0 < 0 || g1 < 0) return null;          // 境界。扇が閉じない
    const nxt = g0 === f ? g1 : g0;
    seps.push(e);
    if (nxt === f0) {
      // 一周した。拾った面の数が v の隣接面の数と合っていなければ非多様体
      return faces.length === total ? { faces, seps, closed: true } : null;
    }
    if (faces.includes(nxt)) return null;       // 8 の字。扱わない
    faces.push(nxt);
    f = nxt;
  }
  return null;
}

/**
 * 選択した辺をベベルする（面取り）。
 *
 * **すべての端の頂点で「ベベルする辺が 2 本以上集まっている」ことを要求する。**
 * 1 本しか集まらない頂点（= 帯がそこで途切れる）は、扇を 1 か所で切っても区間が
 * 1 つしかできないため、帯の両側に別々の頂点を割り当てられない。無理に通すと
 * 潰れた面ができる。閉じたエッジループや立方体の全辺のような「通り抜ける」選択なら
 * どの頂点でも 2 本以上になるので、実用上はこれで足りる
 * （〔エッジループ〕で選んでから使うのが普通の流れ）。
 *
 * 断るときは reason に理由を入れて返す。黙って壊すことはしない。
 *
 * 新頂点の位置は「その区間に属する面の重心の平均」へ amount だけ寄せた点。
 * 辺方向に一定距離ずらす方式より自己交差しにくく、面の大きさに自然に追従する。
 *
 * @param {number} amount 0..0.5 くらい。区間の重心へ寄せる割合
 */
export function bevelSelectedEdges(em, amount = 0.2) {
  const t = Math.max(0.01, Math.min(0.49, amount));
  const sel = [];
  for (let e = 0; e < em.ne; e++) if (em.selEdge[e]) sel.push(e);
  if (sel.length === 0) return { edges: 0, verts: 0, faces: 0, refused: 0, reason: '辺が選択されていません' };

  // 境界・非多様体の辺は扱えない
  const bev = [];
  let refused = 0;
  for (const e of sel) {
    const f0 = em.edgeFace[e * 2], f1 = em.edgeFace[e * 2 + 1];
    if (f0 < 0 || f1 < 0 || f0 === f1) { refused++; continue; }
    bev.push(e);
  }
  if (bev.length === 0) {
    return { edges: 0, verts: 0, faces: 0, refused, reason: '境界の辺はベベルできません' };
  }
  const isBev = new Uint8Array(em.ne);
  for (const e of bev) isBev[e] = 1;

  // 端の頂点ごとにベベル辺の本数を数える
  const kAt = new Int32Array(em.nv);
  for (const e of bev) { kAt[em.edgeA[e]]++; kAt[em.edgeB[e]]++; }
  const affected = [];
  for (let v = 0; v < em.nv; v++) if (kAt[v] > 0) affected.push(v);

  const lone = affected.filter(v => kAt[v] === 1);
  if (lone.length) {
    return {
      edges: 0, verts: 0, faces: 0, refused: bev.length,
      reason: `ベベル辺が 1 本しか集まらない頂点が ${lone.length} 個あります。`
        + '帯がそこで途切れるので処理できません。〔エッジループ〕で辺を繋がった形に'
        + '選んでから実行してください',
    };
  }

  // 扇を作る。境界や非多様体が混ざっていたら断る
  const fans = new Map();
  for (const v of affected) {
    const fan = vertexFan(em, v);
    if (!fan) {
      return {
        edges: 0, verts: 0, faces: 0, refused: bev.length,
        reason: `頂点 ${v} のまわりが一周していません（境界か非多様体）。ベベルできません`,
      };
    }
    fans.set(v, fan);
  }

  // 区間へ切る。faces[i] と faces[i+1] の間が seps[i]
  const P = Array.from(em.positions);
  let nv = em.nv;
  // corner[(v,f)] → 新頂点
  const newAt = new Map();
  const key = (v, f) => v * 1048576 + f;
  // 角の面を張るための、区間の新頂点（扇の回転順）
  const cornerRings = new Map();
  const c = new Float64Array(3);

  for (const v of affected) {
    const { faces, seps } = fans.get(v);
    const m = faces.length;
    // 区間の開始位置（seps[i] がベベル辺なら faces[i+1] が新しい区間の先頭）
    const starts = [];
    for (let i = 0; i < m; i++) if (isBev[seps[i]]) starts.push((i + 1) % m);
    // kAt[v] >= 2 を保証しているので starts.length >= 2
    const ring = [];
    const i3 = v * 3;
    const ox = em.positions[i3], oy = em.positions[i3 + 1], oz = em.positions[i3 + 2];
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s];
      const to = starts[(s + 1) % starts.length];
      // from から to の直前までが 1 区間
      const arc = [];
      let i = from;
      for (let guard = 0; guard <= m; guard++) {
        arc.push(faces[i]);
        i = (i + 1) % m;
        if (i === to) break;
      }
      // 区間の面の重心の平均へ寄せる
      let ax = 0, ay = 0, az = 0;
      for (const f of arc) { em.faceCenter(f, c); ax += c[0]; ay += c[1]; az += c[2]; }
      const inv = 1 / arc.length;
      ax = ox + (ax * inv - ox) * t;
      ay = oy + (ay * inv - oy) * t;
      az = oz + (az * inv - oz) * t;
      // **1 区間目は元の頂点スロットを使い回す。** 全部を新規にすると元の頂点が
      // どの面からも参照されない孤児として残り、頂点数が水増しされる
      // （立方体の全辺ベベルで 24 のはずが 32 になり、オイラー標数が 10 に見えた。
      //  面と辺は正しかったので、位相ではなく数え方の問題だった）。
      let id;
      if (s === 0) {
        id = v;
        P[i3] = ax; P[i3 + 1] = ay; P[i3 + 2] = az;
      } else {
        P.push(ax, ay, az);
        id = nv++;
      }
      ring.push(id);
      for (const f of arc) newAt.set(key(v, f), id);
    }
    cornerRings.set(v, ring);
  }
  const newVerts = nv - em.nv;

  // 影響を受ける頂点を使っている面を作り直す
  const kill = new Set();
  const add = [];
  const touched = new Set();
  for (const v of affected) for (const f of fans.get(v).faces) touched.add(f);
  for (const f of touched) {
    const s = em.faceStart[f], n = em.faceSize(f);
    const loop = [];
    for (let k = 0; k < n; k++) {
      const u = em.faceVerts[s + k];
      const r = newAt.get(key(u, f));
      loop.push(r === undefined ? u : r);
    }
    add.push(loop);
    kill.add(f);
  }

  // ベベル辺ごとの帯。
  // f0 のループに a→b の向きで現れるなら (b0, a0, a1, b1)。
  // 立方体の全辺ベベルで法線を計算して確かめた（下・前の辺の帯が (0,-1,-1) 方向を
  // 向く = 外向き）。逆順にすると帯が裏返る。
  let bands = 0;
  const bandFirst = add.length;     // add の中で帯が始まる位置
  for (const e of bev) {
    const a = em.edgeA[e], b = em.edgeB[e];
    const f0 = em.edgeFace[e * 2], f1 = em.edgeFace[e * 2 + 1];
    const a0 = newAt.get(key(a, f0)), b0 = newAt.get(key(b, f0));
    const a1 = newAt.get(key(a, f1)), b1 = newAt.get(key(b, f1));
    if (a0 === undefined || b0 === undefined || a1 === undefined || b1 === undefined) continue;
    if (a0 === a1 || b0 === b1) continue;      // 潰れる（起きないはずだが念のため）
    const s0 = em.faceStart[f0], n0 = em.faceSize(f0);
    let aFirst = false;
    for (let k = 0; k < n0; k++) {
      const u = em.faceVerts[s0 + k], w = em.faceVerts[s0 + (k + 1) % n0];
      if (u === a && w === b) { aFirst = true; break; }
      if (u === b && w === a) { aFirst = false; break; }
    }
    add.push(aFirst ? [b0, a0, a1, b1] : [a0, b0, b1, a1]);
    bands++;
  }

  // ベベル辺が 3 本以上集まる頂点には角の面を張る。
  // 巻き方は頂点法線（まわりの面の平均）と突き合わせて決める。扇を回る向きが
  // 外向きになるかは形によって変わるので、計算して合わせるのが確実。
  let corners = 0;
  const fn = new Float64Array(3);
  for (const v of affected) {
    if (kAt[v] < 3) continue;
    const ring = cornerRings.get(v);
    if (ring.length < 3) continue;
    let nx = 0, ny = 0, nz = 0;
    for (const f of fans.get(v).faces) { em.faceNormal(f, fn); nx += fn[0]; ny += fn[1]; nz += fn[2]; }
    // ring の巻き方を Newell で見て、頂点法線と逆なら反転する
    let gx = 0, gy = 0, gz = 0;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k] * 3, q = ring[(k + 1) % ring.length] * 3;
      gx += (P[p + 1] - P[q + 1]) * (P[p + 2] + P[q + 2]);
      gy += (P[p + 2] - P[q + 2]) * (P[p] + P[q]);
      gz += (P[p] - P[q]) * (P[p + 1] + P[q + 1]);
    }
    add.push(gx * nx + gy * ny + gz * nz >= 0 ? ring.slice() : ring.slice().reverse());
    corners++;
  }

  // _replaceFaces は「生き残った面を元の順で並べたあと、add を順に足す」ので、
  // add[i] の新しい面番号は（生き残り数 + i）になる。帯を選択に残すのに使う。
  // 「新しい頂点だけで出来ている面」で判定する方法は使えない: 1 区間目は元の
  // 頂点スロットを使い回すので、帯にも古い番号が混ざる。
  let survivors = 0;
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f] && !kill.has(f)) survivors++;

  em.positions = new Float32Array(P);
  em.nv = nv;
  em.selVert = new Uint8Array(nv);
  em._replaceFaces([...kill], add);
  em.rebuild();
  // 張った帯を選択にしておく（続けて動かせるように）
  em.clearSelection();
  for (let i = 0; i < bands; i++) {
    const f = survivors + bandFirst + i;
    if (f < em.nf && em.faceAlive[f]) em.selFace[f] = 1;
  }
  em.syncSelection('face');
  em.version++; em.topoVersion++;
  return { edges: bev.length, verts: newVerts, faces: bands, corners, refused, reason: '' };
}

// ---------------------------------------------------------------------------
// ブリッジ（Bridge Edge Loops）
//
// **穴の縁（境界のループ）2 つ**を四角の帯で繋ぐ。面を消して開けた 2 つの穴を
// 繋いで筒にする、離れた 2 つの形を繋ぐ、という使い方をする。
//
// 面の上を通る（境界でない）エッジループ同士のブリッジは扱わない。その場合は
// 間の面をどう捨てるかを決める必要があり、選び方で結果が変わって黙って壊れやすい。
// 「面を削除して穴を開けてからブリッジ」の手順なら、何が起きるか目で見て分かる。
// ---------------------------------------------------------------------------

/**
 * 選択された境界辺を、頂点で繋いで閉じたループに分ける。
 * どの頂点にもちょうど 2 本集まっていることを要求する（枝分かれは扱えない）。
 */
function selectedBoundaryLoops(em) {
  const sel = [];
  let interior = 0;
  for (let e = 0; e < em.ne; e++) {
    if (!em.selEdge[e]) continue;
    if (em.edgeFace[e * 2 + 1] >= 0) { interior++; continue; }
    sel.push(e);
  }
  if (sel.length === 0) return { loops: [], interior, reason: '' };

  const at = new Map();
  for (const e of sel) {
    for (const v of [em.edgeA[e], em.edgeB[e]]) {
      let a = at.get(v);
      if (!a) { a = []; at.set(v, a); }
      a.push(e);
    }
  }
  for (const [v, a] of at) {
    if (a.length !== 2) {
      return {
        loops: [], interior,
        reason: `頂点 ${v} に選択された境界辺が ${a.length} 本集まっています`
          + '（ループは 1 頂点につき 2 本でないと辿れません）',
      };
    }
  }

  const used = new Set();
  const loops = [];
  for (const e0 of sel) {
    if (used.has(e0)) continue;
    const verts = [];
    let e = e0, v = em.edgeA[e0];
    for (let guard = 0; guard <= sel.length; guard++) {
      verts.push(v);
      used.add(e);
      const w = em.edgeA[e] === v ? em.edgeB[e] : em.edgeA[e];
      const pair = at.get(w);
      const nxt = pair[0] === e ? pair[1] : pair[0];
      if (nxt === e0) break;          // 一周した
      e = nxt; v = w;
    }
    if (verts.length >= 3) loops.push(verts);
  }
  return { loops, interior, reason: '' };
}

/**
 * ループの並び順を「隣の面が辺を辿る向きと逆」に揃える。
 *
 * 辺を共有する 2 面は、その辺を必ず逆向きに辿る。だからループ側を隣の面と逆向きに
 * 並べておけば、そのまま (a_i, a_i+1, ...) と書いた四角が隣の面と噛み合う。
 * 巻き方が揃ったメッシュなら 1 本調べれば全体で成り立つ。
 */
function orientBoundaryLoop(em, verts) {
  const e = edgeOf(em, verts[0], verts[1]);
  if (e < 0) return verts;
  const f = em.edgeFace[e * 2];
  const s = em.faceStart[f], n = em.faceSize(f);
  for (let k = 0; k < n; k++) {
    if (em.faceVerts[s + k] === verts[0] && em.faceVerts[s + (k + 1) % n] === verts[1]) {
      verts.reverse();                // 面と同じ向きだったので逆にする
      break;
    }
  }
  return verts;
}

/**
 * 選択した 2 つの穴の縁を四角の帯で繋ぐ（Blender の Bridge Edge Loops）。
 *
 * 頂点数が同じ 2 つの閉じた境界ループを要求する。数が違うループを繋ぐには
 * 三角で辻褄を合わせる必要があり、どこに寄せるかで結果が変わるので断る。
 *
 * 対応の付け方:
 *   * 向きは巻き方から決める。両方のループを「隣の面と逆向き」に揃えたうえで、
 *     B は A と**逆に**辿る。こうすると帯の四角が両側の面と噛み合う
 *     （A 側の辺を A の並び順で、B 側の辺を B の並び順で辿ることになる）。
 *   * 回転のずれ（どの頂点同士を繋ぐか）は距離で決める。捻れた帯にならないように
 *     全対応の距離和が最小になるずれを選ぶ。ループが大きいときは総当りが重いので
 *     a_0 に一番近い頂点を選ぶだけにする。
 *
 * 繋ぐと桁（縦の辺）が新しくできるが、そこに**既に 2 面が付いた辺がある**場合は
 * 非多様体になるので断る（立方体の向かい合う 2 面を消して繋ぐと、側面の辺が
 * ちょうどそれに当たる）。
 */
export function bridgeEdgeLoops(em) {
  const { loops, interior, reason } = selectedBoundaryLoops(em);
  if (reason) return { loops: 0, faces: 0, reason };
  if (loops.length !== 2) {
    return {
      loops: loops.length, faces: 0,
      reason: loops.length === 0
        ? '穴の縁（境界の辺）が選択されていません。'
          + (interior > 0
            ? `選択されている ${interior} 本はどれも面に挟まれた辺です。`
              + '〔面を削除〕で穴を開けてから、その縁を選んでください'
            : '〔面を削除〕で穴を開けてから、その縁を選んでください')
        : `境界のループが ${loops.length} 個あります。ブリッジは 2 個で使います`,
    };
  }
  const [A, B] = loops;
  const n = A.length;
  if (B.length !== n) {
    return {
      loops: 2, faces: 0,
      reason: `2 つのループの頂点数が違います（${n} と ${B.length}）。`
        + '同じ数にしてから実行してください（ループカットや細分化で数を合わせられます）',
    };
  }
  const shared = new Set(A);
  for (const v of B) {
    if (shared.has(v)) {
      return { loops: 2, faces: 0, reason: `2 つのループが頂点 ${v} を共有しています。離れた縁同士で使います` };
    }
  }
  orientBoundaryLoop(em, A);
  orientBoundaryLoop(em, B);

  // B は A と逆向きに辿る。partner(A[i]) = B[(s - i) mod n]
  const p = em.positions;
  const d2 = (a, b) => {
    const i = a * 3, j = b * 3;
    const dx = p[i] - p[j], dy = p[i + 1] - p[j + 1], dz = p[i + 2] - p[j + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  const mod = (x) => ((x % n) + n) % n;
  let best = 0;
  if (n <= 256) {
    let bestSum = Infinity;
    for (let s = 0; s < n; s++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += d2(A[i], B[mod(s - i)]);
      if (sum < bestSum) { bestSum = sum; best = s; }
    }
  } else {
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      const d = d2(A[0], B[j]);
      if (d < bestD) { bestD = d; best = j; }
    }
  }

  // 桁になる辺が既に埋まっていないか先に見る
  for (let i = 0; i < n; i++) {
    const e = edgeOf(em, A[i], B[mod(best - i)]);
    if (e >= 0 && em.edgeFace[e * 2 + 1] >= 0) {
      return {
        loops: 2, faces: 0,
        reason: `頂点 ${A[i]} と ${B[mod(best - i)]} の間には既に 2 面が付いた辺があります。`
          + 'ここを繋ぐと非多様体になるので断ります（向かい合う 2 面を消した立方体などが'
          + 'これに当たります。間に段を入れるか、離れた穴同士で使ってください）',
      };
    }
  }

  const add = [];
  for (let i = 0; i < n; i++) {
    add.push([A[i], A[(i + 1) % n], B[mod(best - i - 1)], B[mod(best - i)]]);
  }
  let survivors = 0;
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f]) survivors++;

  em._replaceFaces([], add);
  em.rebuild();
  // 張った帯を選択にしておく
  em.clearSelection();
  for (let i = 0; i < add.length; i++) {
    const f = survivors + i;
    if (f < em.nf && em.faceAlive[f]) em.selFace[f] = 1;
  }
  em.syncSelection('face');
  em.version++; em.topoVersion++;
  return { loops: 2, faces: add.length, verts: n, reason: '' };
}
