// ---------------------------------------------------------------------------
// モーフブラシ の E2E テスト（実ブラウザ）。
//   node test/morph-brush.mjs
//
// Node からは Worker も WebGPU も使えないので、モジュール単体テスト
// （test/*.test.mjs）ではこの経路を通せない。UI の生成と tools.js の配線が
// 本当に効いているかはここでしか分からない。
// ---------------------------------------------------------------------------
import { launch, waitFor } from './cdp.mjs';
const h = await launch('/index.html', { width: 1200, height: 850 });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.tools)'), 60000, 'boot');
  await cdp.eval('new Promise(r=>setTimeout(r,500))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));

  let r = await run(`return {
    brushes: document.querySelectorAll('#brushList .brush').length,
    hasMorph: [...document.querySelectorAll('#brushList .brush')].some(b => b.textContent.includes('モーフ')),
  };`);
  ok(r.hasMorph, 'ブラシパレットにモーフがある (' + r.brushes + ' 個)');

  r = await run(`const W=window.WebSculpt, m=W.mesh;
    W.state.dynTopo=false; W.app.newMesh('sphere'); W.sculptor.divide(); W.sculptor.divide();
    W.state.worldRadius=0.3; W.state.strength=1; W.state.symmetry.x=false; W.state.backfaceMask=false;
    W.tools.morphStore();
    const stored=m.positions.slice(0,m.nv*3);
    const pt=new Float32Array([1,0,0]);
    W.sculptor.beginStroke('draw',pt,1);
    for(let k=1;k<=12;k++){pt.set([Math.cos(k*0.05),Math.sin(k*0.05)*0.3,0.25]);W.sculptor.addSample(pt);}
    W.sculptor.endStroke();
    let before=0; for(let i=0;i<stored.length;i++) before+=Math.abs(m.positions[i]-stored[i]);
    // モーフブラシで一部だけ戻す
    const pt2=new Float32Array([1,0,0]);
    W.sculptor.beginStroke('morph',pt2,1);
    for(let k=1;k<=6;k++){pt2.set([Math.cos(k*0.03),Math.sin(k*0.03)*0.2,0.2]);W.sculptor.addSample(pt2);}
    W.sculptor.endStroke();
    let after=0; for(let i=0;i<stored.length;i++) after+=Math.abs(m.positions[i]-stored[i]);
    return { before, after, nan:[...m.positions.slice(0,600)].some(x=>!isFinite(x)) };`);
  ok(r.before > 1, '彫刻でモーフから離れた (差分 ' + r.before.toFixed(3) + ')');
  ok(r.after < r.before * 0.95 && !r.nan,
    'モーフブラシで塗った所が戻る (' + r.before.toFixed(3) + ' → ' + r.after.toFixed(3) + ')');

  // 記憶が無い状態でモーフブラシを使っても壊れない
  r = await run(`const W=window.WebSculpt, m=W.mesh;
    W.app.newMesh('sphere'); W.sculptor.divide();
    W.tools.morph.clear();
    const before=m.positions.slice(0,m.nv*3);
    const pt=new Float32Array([1,0,0]);
    W.sculptor.beginStroke('morph',pt,1);
    for(let k=1;k<=6;k++){pt.set([Math.cos(k*0.05),0,0.2]);W.sculptor.addSample(pt);}
    W.sculptor.endStroke();
    let d=0; for(let i=0;i<before.length;i++) d+=Math.abs(m.positions[i]-before[i]);
    return { d, nan:[...m.positions.slice(0,600)].some(x=>!isFinite(x)) };`);
  ok(r.d === 0 && !r.nan, '記憶が無ければ何も起きない（壊れない）');

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) { console.error('ERR', e.message); fails++; }
finally { await h.stop(); }
console.log(fails === 0 ? '\n✅ モーフブラシ 通過' : '\n❌ ' + fails + ' 件失敗');
process.exit(fails === 0 ? 0 : 1);
