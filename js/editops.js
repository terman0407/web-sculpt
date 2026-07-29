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
 * @param {number} offset 法線方向に動かす量
 */
export function extrudeSelectedFaces(em, offset = 0) {
  const sel = [];
  for (let f = 0; f < em.nf; f++) if (em.faceAlive[f] && em.selFace[f]) sel.push(f);
  if (sel.length === 0) return { faces: 0, verts: 0, walls: 0 };
  const selSet = new Set(sel);

  const dup = new Map();
  const P = Array.from(em.positions);
  let nv = em.nv;
  for (const f of sel) {
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
      const v = em.faceVerts[i];
      if (dup.has(v)) continue;
      dup.set(v, nv++);
      P.push(em.positions[v * 3], em.positions[v * 3 + 1], em.positions[v * 3 + 2]);
    }
  }

  // 頂点ごとの法線（その頂点に触っている選択面の平均）と、領域全体の平均法線
  const vn = new Map();
  const nrm = new Float64Array(3);
  let ax = 0, ay = 0, az = 0;
  for (const f of sel) {
    em.faceNormal(f, nrm);
    ax += nrm[0]; ay += nrm[1]; az += nrm[2];
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) {
      const v = em.faceVerts[i];
      let a = vn.get(v);
      if (!a) { a = [0, 0, 0]; vn.set(v, a); }
      a[0] += nrm[0]; a[1] += nrm[1]; a[2] += nrm[2];
    }
  }
  {
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l;
  }
  if (offset !== 0) {
    for (const [v, nvi] of dup) {
      const a = vn.get(v) || [ax, ay, az];
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
    for (let i = em.faceStart[f]; i < em.faceStart[f + 1]; i++) loop.push(dup.get(em.faceVerts[i]));
    add.push(loop);
  }
  let walls = 0;
  for (const f of sel) {
    const s = em.faceStart[f], n = em.faceSize(f);
    for (let k = 0; k < n; k++) {
      const a = em.faceVerts[s + k], b = em.faceVerts[s + (k + 1) % n];
      const e = edgeOf(em, a, b);
      if (e < 0) continue;
      // 領域の縁 = 反対側の面が選択されていない（または境界）
      const f0 = em.edgeFace[e * 2], f1 = em.edgeFace[e * 2 + 1];
      const other = f0 === f ? f1 : f0;
      if (other >= 0 && selSet.has(other)) continue;
      add.push([a, b, dup.get(b), dup.get(a)]);
      walls++;
    }
  }

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
// ベベル（面取り）は入れていない。
//
// 一度書いてテストに落とした。難しいのは「ベベルする辺が集まる頂点」ではなく
// **辺の両端の頂点**。辺 (a,b) の両側 2 面を内側へ寄せて帯を張ると、a と b を
// 使っている「3 枚目の面」との間に隙間が残る（立方体では 1 頂点に 3 面ある）。
// 実測で境界辺 10 本・オイラー標数 0 になった。
//
// 正しくやるには端の頂点まわりの面を組み替えて角を塞ぐ必要があり、
// 「辺を独立したものに限る」という制限では回避できない（端は必ず存在する）。
// 中途半端に通すとメッシュが黙って壊れるので、出さないことにした。段 4 の課題。
// ---------------------------------------------------------------------------
