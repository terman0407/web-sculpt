// ---------------------------------------------------------------------------
// ブラシアルファとストロークタイプ の E2E テスト（実ブラウザ）。
//   node test/alpha-stroke.mjs
//
// Node からは Worker も WebGPU も使えないので、モジュール単体テスト
// （test/*.test.mjs）ではこの経路を通せない。UI の生成と tools.js の配線が
// 本当に効いているかはここでしか分からない。
// ---------------------------------------------------------------------------
import { launch, waitFor } from './cdp.mjs';
const h = await launch('/index.html', { width: 1400, height: 950 });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.renderer && window.WebSculpt.tools)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  await cdp.eval('new Promise(r=>setTimeout(r,600))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));

  // UI: アルファのサムネイルが並んでいるか
  let r = await run(`return {
    alphas: document.querySelectorAll('#rightPanel .alphagrid .alpha').length,
    canvases: document.querySelectorAll('#rightPanel .alphagrid canvas').length,
    strokes: document.querySelectorAll('#rightPanel .segmented').length,
  };`);
  ok(r.alphas === 14, 'アルファのサムネイルが 14 個（なし + 13 種）並ぶ (' + r.alphas + ')');
  ok(r.canvases === 13, 'サムネイルが実際に描かれている (' + r.canvases + ')');

  // 彫刻の準備
  const setup = `const W=window.WebSculpt;
    W.state.dynTopo=false; W.app.newMesh('sphere');
    W.sculptor.divide(); W.sculptor.divide();
    W.state.worldRadius=0.3; W.state.strength=0.9; W.state.symmetry.x=false;
    W.state.backfaceMask=false;`;

  const strokeAndMeasure = (extra) => `${setup}
    ${extra}
    const m=W.mesh;
    const before=m.positions.slice(0,m.nv*3);
    const pt=new Float32Array([1,0,0]);
    W.sculptor.beginStroke('draw',pt,1);
    for(let k=1;k<=10;k++){pt.set([Math.cos(k*0.05),Math.sin(k*0.05)*0.3,0.25]);W.sculptor.addSample(pt);}
    W.sculptor.endStroke();
    let moved=0, total=0, mx=0;
    for(let v=0;v<m.nv;v++){ if(!m.vAlive[v])continue; const i=v*3;
      const d=Math.hypot(m.positions[i]-before[i],m.positions[i+1]-before[i+1],m.positions[i+2]-before[i+2]);
      if(d>1e-7) moved++; total+=d; if(d>mx)mx=d; }
    return { moved, total, mx, nan:[...m.positions.slice(0,600)].some(x=>!isFinite(x)) };`;

  // アルファなし
  const base = await run(strokeAndMeasure("W.state.alpha=''; W.state.stroke='dots';"));
  ok(base.moved > 100 && !base.nan, 'アルファなしで彫れる (' + base.moved + ' 頂点 / 総変位 ' + base.total.toFixed(3) + ')');

  // ring アルファ: 中心が抜けるので、同じストロークでも変位の分布が変わる
  const ring = await run(strokeAndMeasure("W.state.alpha='ring'; W.state.stroke='dots';"));
  ok(ring.moved > 50 && !ring.nan, 'ring アルファで彫れる (' + ring.moved + ' 頂点 / 総変位 ' + ring.total.toFixed(3) + ')');
  ok(Math.abs(ring.total - base.total) / base.total > 0.05,
    'アルファで結果が変わる (総変位 ' + base.total.toFixed(3) + ' → ' + ring.total.toFixed(3) + ')');

  // square アルファも別の結果
  const sq = await run(strokeAndMeasure("W.state.alpha='square'; W.state.stroke='dots';"));
  ok(Math.abs(sq.total - ring.total) / ring.total > 0.02,
    'アルファごとに違う結果になる (ring ' + ring.total.toFixed(3) + ' vs square ' + sq.total.toFixed(3) + ')');

  // スプレー: 散らしが効いて範囲が広がる
  const spray = await run(strokeAndMeasure("W.state.alpha=''; W.state.stroke='spray';"));
  ok(spray.moved > base.moved, 'スプレーで影響範囲が広がる (' + base.moved + ' → ' + spray.moved + ' 頂点)');

  // 決定論。スプレーの種にはストローク番号を混ぜてあるので、続けて 2 回
  // スプレーすると別の模様になる（ZBrush のスプレーとして正しい挙動）。
  // 再現性が要るのは「同じ種で同じストロークを流したら同じ結果」という性質。
  r = await run(`${setup}
    W.state.alpha='noise'; W.state.stroke='spray';
    const m=W.mesh;
    const once=(fixSeed)=>{ W.app.newMesh('sphere'); W.sculptor.divide(); W.sculptor.divide();
      W.sculptor.engine.strokeId=fixSeed;
      const pt=new Float32Array([1,0,0]);
      W.sculptor.beginStroke('draw',pt,1);
      for(let k=1;k<=10;k++){pt.set([Math.cos(k*0.05),Math.sin(k*0.05)*0.3,0.25]);W.sculptor.addSample(pt);}
      W.sculptor.endStroke();
      return m.positions.slice(0,m.nv*3); };
    const a=once(100), b=once(100), c=once(101);
    let same=0, other=0;
    for(let i=0;i<a.length;i++){ if(a[i]!==b[i]) same++; if(a[i]!==c[i]) other++; }
    return { same, other, n:a.length };`);
  ok(r.same === 0, '同じ種なら完全に同じ結果になる (差分 ' + r.same + ' / ' + r.n + ')');
  ok(r.other > 0, 'ストロークが変わればスプレーの模様も変わる (差分 ' + r.other + ')');

  // colorSpray: 色がばらつく
  r = await run(`${setup}
    W.state.alpha=''; W.state.stroke='colorSpray';
    W.state.strokeParams.colorSpray.colorJitter=0.6;
    W.state.paintColor=[0.5,0.3,0.2];
    const m=W.mesh;
    const before=m.colors.slice(0,m.nv*3);
    const pt=new Float32Array([1,0,0]);
    W.sculptor.beginStroke('paint',pt,1);
    for(let k=1;k<=12;k++){pt.set([Math.cos(k*0.05),Math.sin(k*0.05)*0.3,0.25]);W.sculptor.addSample(pt);}
    W.sculptor.endStroke();
    const vals=[];
    for(let v=0;v<m.nv;v++){ if(!m.vAlive[v])continue; const i=v*3;
      if(Math.abs(m.colors[i]-before[i])>1e-5) vals.push(m.colors[i]); }
    let mn=Infinity,mxx=-Infinity;
    for(const x of vals){ if(x<mn)mn=x; if(x>mxx)mxx=x; }
    return { n:vals.length, mn, mx:mxx, spread:mxx-mn };`);
  ok(r.n > 50, 'colorSpray で色が塗られる (' + r.n + ' 頂点)');
  ok(r.spread > 0.02, '色がダブごとにばらつく (幅 ' + r.spread.toFixed(3) + ')');

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ アルファ / ストローク 通過' : '\n❌ ' + fails + ' 件失敗');
process.exit(fails === 0 ? 0 : 1);
