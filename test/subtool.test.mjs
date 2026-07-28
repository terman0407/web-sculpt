// ---------------------------------------------------------------------------
// サブツール（複数メッシュ）の単体テスト。
//   node test/subtool.test.mjs
// ---------------------------------------------------------------------------

import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { SubToolSet } from '../js/subtool.js';

let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.log('  FAIL: ' + m); } else console.log('  ok   ' + m); };
const head = (t) => console.log('\n== ' + t + ' ==');

const mkMesh = (kind = 'sphere') => {
  const g = PRIMITIVES[kind]();
  const m = new SculptMesh();
  m.setGeometry(g.positions, g.indices);
  return m;
};

/** 閉多様体かどうか（各辺がちょうど 2 面） */
const manifold = (m) => {
  const em = new Map();
  const T = m.tris;
  let degen = 0;
  for (let t = 0; t < m.nt; t++) {
    const i = t * 3, a = T[i], b = T[i + 1], c = T[i + 2];
    if (a === b && b === c) continue;
    if (a === b || b === c || c === a) { degen++; continue; }
    for (let e = 0; e < 3; e++) {
      const x = [a, b, c][e], y = [a, b, c][(e + 1) % 3];
      const k = x < y ? x + ':' + y : y + ':' + x;
      em.set(k, (em.get(k) || 0) + 1);
    }
  }
  let bad = 0, bnd = 0;
  for (const n of em.values()) { if (n === 1) bnd++; else if (n !== 2) bad++; }
  return { bad, bnd, degen, chi: m.liveVerts - em.size + m.liveTris };
};

head('基本操作');
{
  const set = new SubToolSet();
  set.adopt(mkMesh('sphere'), '球');
  ok(set.count === 1 && set.active === 0, `取り込みで 1 個になる (${set.count})`);
  ok(set.activeMesh.liveVerts === 2562, `アクティブメッシュが取れる (${set.activeMesh.liveVerts} 頂点)`);

  set.addPrimitive('cube');
  ok(set.count === 2 && set.active === 1, `追加してアクティブが移る (${set.count} 個 / active ${set.active})`);
  ok(set.activeMesh.liveTris === 1536 || set.activeMesh.liveTris > 0,
    `追加したメッシュが実体を持つ (${set.activeMesh.liveTris} 面)`);

  set.rename(1, '箱');
  ok(set.info()[1].name === '箱', '名前を変えられる');

  set.setVisible(1, false);
  ok(set.visibleTools().length === 1, `非表示にすると表示対象から外れる (${set.visibleTools().length})`);
  set.setVisible(1, true);

  set.solo = true;
  ok(set.visibleTools().length === 1 && set.visibleTools()[0] === set.activeTool,
    'ソロ表示はアクティブだけになる');
  set.solo = false;

  ok(set.inactiveVisible().length === 1, `非アクティブで表示中のものが数えられる (${set.inactiveVisible().length})`);

  // 並べ替え
  const idBefore = set.list[1].id;
  set.move(1, -1);
  ok(set.list[0].id === idBefore && set.active === 0, '並べ替えでアクティブが追従する');

  // 削除
  ok(set.remove(0) === true, '削除できる');
  ok(set.count === 1, `削除後に 1 個 (${set.count})`);
  ok(set.remove(0) === false, '最後の 1 個は削除できない');
}

head('複製');
{
  const set = new SubToolSet();
  set.adopt(mkMesh('sphere'));
  // 頂点を動かして、複製が独立していることを確かめる
  set.activeMesh.positions[0] = 5;
  const t = set.duplicate(0);
  ok(t !== null && set.count === 2, `複製できる (${set.count} 個)`);
  ok(set.list[1].mesh.liveVerts === set.list[0].mesh.liveVerts,
    `頂点数が一致 (${set.list[0].mesh.liveVerts} / ${set.list[1].mesh.liveVerts})`);
  const m0 = manifold(set.list[0].mesh), m1 = manifold(set.list[1].mesh);
  ok(m1.bad === 0 && m1.bnd === 0 && m1.chi === 2,
    `複製が閉多様体 (非多様体 ${m1.bad} / 境界 ${m1.bnd} / χ=${m1.chi})`);
  // 独立性: 一方を動かしても他方は変わらない
  const before = set.list[1].mesh.positions[3];
  set.list[0].mesh.positions[3] = 99;
  ok(set.list[1].mesh.positions[3] === before, '複製は元と独立している');
}

head('まとめる（Merge）');
{
  const set = new SubToolSet();
  set.adopt(mkMesh('sphere'), 'A');
  set.addPrimitive('cube');
  // 箱をずらして重ならないようにする
  const cm = set.list[1].mesh;
  for (let v = 0; v < cm.nv; v++) cm.positions[v * 3] += 3;
  const v0 = set.list[0].mesh.liveVerts, v1 = cm.liveVerts;
  const t0 = set.list[0].mesh.liveTris, t1 = cm.liveTris;
  const r = set.mergeVisible();
  ok(r !== null, 'まとめられる');
  ok(set.count === 1, `1 個になる (${set.count})`);
  ok(set.activeMesh.liveVerts === v0 + v1,
    `頂点数が合計になる (${v0} + ${v1} = ${set.activeMesh.liveVerts})`);
  ok(set.activeMesh.liveTris === t0 + t1,
    `面数が合計になる (${t0} + ${t1} = ${set.activeMesh.liveTris})`);
  const mf = manifold(set.activeMesh);
  ok(mf.bad === 0 && mf.bnd === 0 && mf.degen === 0,
    `まとめた結果が閉多様体 (非多様体 ${mf.bad} / 境界 ${mf.bnd} / 退化 ${mf.degen})`);
  ok(mf.chi === 4, `2 つの閉曲面なので χ=4 (${mf.chi})`);
  // 両方の形が残っているか（x の範囲で見る）
  let minX = Infinity, maxX = -Infinity;
  const P = set.activeMesh.positions;
  for (let v = 0; v < set.activeMesh.nv; v++) {
    if (!set.activeMesh.vAlive[v]) continue;
    const x = P[v * 3];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  // cube の半径は 0.87 なので +3 して 3.87 まで伸びる
  ok(minX < -0.9 && maxX > 3.5, `両方の形が残っている (x ∈ [${minX.toFixed(2)}, ${maxX.toFixed(2)}])`);
}

head('連結成分で分ける（Split To Parts）');
{
  const set = new SubToolSet();
  set.adopt(mkMesh('sphere'), 'A');
  set.addPrimitive('cube');
  const cm = set.list[1].mesh;
  for (let v = 0; v < cm.nv; v++) cm.positions[v * 3] += 3;
  set.mergeVisible();
  const total = set.activeMesh.liveVerts;
  const r = set.splitToParts(0);
  ok(r && r.made === 2, `2 つに分かれる (${r ? r.made : 'null'})`);
  ok(set.count === 2, `サブツールが 2 個 (${set.count})`);
  const sum = set.list[0].mesh.liveVerts + set.list[1].mesh.liveVerts;
  ok(sum === total, `頂点数が保たれる (${total} → ${sum})`);
  for (let i = 0; i < 2; i++) {
    const mf = manifold(set.list[i].mesh);
    ok(mf.bad === 0 && mf.bnd === 0 && mf.chi === 2,
      `分けた ${i + 1} 個目が閉多様体 χ=2 (${mf.chi})`);
  }
  // 1 つの塊しかないものは分けない
  const one = new SubToolSet();
  one.adopt(mkMesh('sphere'));
  const r2 = one.splitToParts(0);
  ok(r2 && r2.made === 0, `1 つの塊は分けない (${r2 ? r2.reason : ''})`);
}

head('マスクで分ける（Split Masked）');
{
  const set = new SubToolSet();
  set.adopt(mkMesh('sphere'));
  const m = set.activeMesh;
  for (let v = 0; v < m.nv; v++) m.mask[v] = m.positions[v * 3 + 1] > 0 ? 1 : 0;
  const total = m.liveTris;
  const r = set.splitMasked(0);
  ok(r && r.made === 2, `2 つに分かれる (${r ? r.made : 'null'})`);
  const sum = set.list[0].mesh.liveTris + set.list[1].mesh.liveTris;
  ok(sum === total, `面数が保たれる (${total} → ${sum})`);
  // 分けた側は境界を持つ（切り口が開いている）
  const mf = manifold(set.list[0].mesh);
  ok(mf.bnd > 0, `切り出した側に境界がある (${mf.bnd} 辺)`);
  ok(mf.bad === 0 && mf.degen === 0, `非多様体辺も退化三角形もない (${mf.bad} / ${mf.degen})`);
  // マスクが全体／空なら分けない
  const s2 = new SubToolSet();
  s2.adopt(mkMesh('sphere'));
  const r2 = s2.splitMasked(0);
  ok(r2 && r2.made === 0, `マスクが空なら分けない (${r2 ? r2.reason : ''})`);
}

head('バウンディングとピック');
{
  const set = new SubToolSet();
  set.adopt(mkMesh('sphere'), 'A');
  set.addPrimitive('sphere');
  const bm = set.list[1].mesh;
  for (let v = 0; v < bm.nv; v++) bm.positions[v * 3] += 5;
  const b = set.bounds();
  ok(b.min[0] < -0.9 && b.max[0] > 5.9, `全体のバウンディングが両方を覆う (x ∈ [${b.min[0].toFixed(2)}, ${b.max[0].toFixed(2)}])`);
  ok(set.pickTool([1, 0, 0]) === set.list[0], '原点側の点は 1 個目を指す');
  ok(set.pickTool([6, 0, 0]) === set.list[1], '離れた点は 2 個目を指す');
  set.setVisible(1, false);
  ok(set.pickTool([6, 0, 0]) === set.list[0], '非表示のものは指さない');
  // ソロ中はアクティブだけ
  set.setVisible(1, true);
  set.select(0);
  set.solo = true;
  ok(set.pickTool([6, 0, 0]) === set.list[0], 'ソロ中はアクティブだけを指す');
}

head('メモリ');
{
  const set = new SubToolSet();
  set.adopt(mkMesh('sphere'));
  const b1 = set.bytes();
  set.addPrimitive('sphere');
  const b2 = set.bytes();
  ok(b2 > b1, `サブツールを増やすとメモリも増える (${(b1 / 1048576).toFixed(1)}MB → ${(b2 / 1048576).toFixed(1)}MB)`);
}

console.log('\n' + (failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`));
process.exit(failures === 0 ? 0 : 1);
