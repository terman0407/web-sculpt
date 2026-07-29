// ---------------------------------------------------------------------------
// リメッシュ（ZRemesher 相当）の E2E テスト（実ブラウザ）。
//   node test/remesh-e2e.mjs
//
// アルゴリズムは test/remesh.test.mjs で見ているので、ここは配線を見る:
// UI から実行できるか、実行後も彫刻できるか、四角優勢の OBJ が出るか。
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const h = await launch('/index.html', { width: 1400, height: 950 });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.tools)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  await cdp.eval('new Promise(r=>setTimeout(r,700))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));
  const runA = async (code) => JSON.parse(await cdp.eval('(async () => JSON.stringify(await (async () => { ' + code + ' })()))()'));

  let r = await run(`return {
    secs: [...document.querySelectorAll('#rightPanel .sec-head')].map(h => h.textContent.replace('▾','').trim()),
  };`);
  ok(r.secs.includes('リメッシュ'), 'リメッシュのセクションがある');

  // 実行して目標面数に近づくか
  r = await runA(`const W = window.WebSculpt;
    W.state.dynTopo = false;
    W.app.newMesh('sphere');
    W.sculptor.divide(); W.sculptor.divide();
    const before = W.mesh.liveTris;
    W.state.remeshTris = 6000;
    W.state.remeshAdaptive = 0.5;
    W.state.remeshIterations = 5;
    await W.app.remeshAdaptive();
    const m = W.mesh;
    // 閉多様体か
    const em = new Map(); const T = m.tris;
    for (let t = 0; t < m.nt; t++) { const i=t*3,a=T[i],b=T[i+1],c=T[i+2]; if(a===b&&b===c)continue;
      const vv=[a,b,c];
      for(let e=0;e<3;e++){const x=vv[e],y=vv[(e+1)%3];const k=x<y?x+':'+y:y+':'+x;em.set(k,(em.get(k)||0)+1);}}
    let bad=0,bnd=0; for(const n of em.values()){if(n===1)bnd++;else if(n!==2)bad++;}
    let nan = 0;
    for (let v = 0; v < m.nv; v++) { if (!m.vAlive[v]) continue;
      for (let k = 0; k < 3; k++) if (!isFinite(m.positions[v*3+k])) nan++; }
    return { before, after: m.liveTris, bad, bnd, chi: m.liveVerts - em.size + m.liveTris, nan };`);
  ok(Math.abs(r.after - 6000) / 6000 < 0.15,
    `目標 6000 面に近づく (${r.before} → ${r.after})`);
  ok(r.bad === 0 && r.bnd === 0 && r.chi === 2,
    `閉多様体 χ=2 を保つ (非多様体 ${r.bad} / 境界 ${r.bnd} / χ=${r.chi})`);
  ok(r.nan === 0, `NaN が無い (${r.nan})`);

  // リメッシュ後も彫刻できる
  r = await run(`const W = window.WebSculpt, m = W.mesh;
    W.state.symmetry.x = false; W.state.backfaceMask = false;
    W.state.worldRadius = 0.3; W.state.strength = 0.9;
    const before = m.positions.slice(0, m.nv*3);
    const pt = new Float32Array([1, 0, 0]);
    W.sculptor.beginStroke('clay', pt, 1);
    for (let k = 1; k <= 8; k++) { pt.set([Math.cos(k*0.06), Math.sin(k*0.06)*0.3, 0.25]); W.sculptor.addSample(pt); }
    W.sculptor.endStroke();
    let d = 0;
    for (let i = 0; i < before.length; i++) d += Math.abs(m.positions[i] - before[i]);
    return { d };`);
  ok(r.d > 1e-3, `リメッシュ後も彫刻できる (変位 ${r.d.toFixed(3)})`);

  // 四角優勢化
  r = await run(`const W = window.WebSculpt;
    const q = W.tools.quadStats();
    return { quads: q.quads, tris: q.tris, ratio: q.ratio, total: W.mesh.liveTris };`);
  ok(r.quads > 0 && r.ratio > 0.75,
    `四角優勢化が効く (四角 ${r.quads} + 三角 ${r.tris} / 四角化率 ${(r.ratio * 100).toFixed(1)}%)`);
  ok(r.quads * 2 + r.tris === r.total, `面数の帳尻が合う (${r.quads * 2 + r.tris} / ${r.total})`);

  // 曲率適応の有無で結果が変わる
  r = await runA(`const W = window.WebSculpt;
    const once = async (adaptive) => {
      W.app.newMesh('cube');
      W.sculptor.divide(); W.sculptor.divide();
      W.state.remeshTris = 5000; W.state.remeshAdaptive = adaptive; W.state.remeshIterations = 6;
      await W.app.remeshAdaptive();
      const m = W.mesh, P = m.positions, T = m.tris;
      const rows = [];
      for (let t = 0; t < m.nt; t++) { const i=t*3,a=T[i],b=T[i+1],c=T[i+2]; if(a===b&&b===c)continue;
        for (const [x,y] of [[a,b],[b,c],[c,a]]) { const ix=x*3, iy=y*3;
          const d = Math.hypot(P[ix]-P[iy], P[ix+1]-P[iy+1], P[ix+2]-P[iy+2]);
          rows.push({ d, k: (Math.abs(m.curv[x]) + Math.abs(m.curv[y])) * 0.5 }); } }
      rows.sort((p,q) => q.k - p.k);
      const third = Math.max(1, Math.floor(rows.length/3));
      const mean = (arr) => arr.reduce((s,x)=>s+x.d,0)/arr.length;
      return mean(rows.slice(0,third)) / mean(rows.slice(-third));
    };
    const off = await once(0);
    const on = await once(0.8);
    return { off, on };`);
  ok(r.on < r.off,
    `曲率適応で鋭い所が相対的に細かくなる (辺長比 ${r.off.toFixed(3)} → ${r.on.toFixed(3)})`);

  // --- ワーカー実行 --------------------------------------------------------
  // ここは Node のテストでは絶対に通らない経路（Worker が無い）。
  // 並列ダイナメッシュでポリペイントが壊れたときの原因が「ワーカー経路を
  // 誰も試していなかった」ことだったので、必ずブラウザで踏んでおく。
  r = await runA(`const W = window.WebSculpt;
    W.state.dynTopo = false;
    W.app.newMesh('sphere');
    for (let i = 0; i < 3; i++) W.sculptor.divide();
    // 頂点色を付けて、ワーカー往復で色が保たれるかも見る
    const m0 = W.mesh;
    for (let v = 0; v < m0.nv; v++) {
      if (!m0.vAlive[v]) continue;
      const y = m0.positions[v*3+1];
      m0.colors[v*3] = y > 0 ? 1 : 0; m0.colors[v*3+1] = 0.25; m0.colors[v*3+2] = y > 0 ? 0 : 1;
    }
    W.state.remeshTris = 8000; W.state.remeshAdaptive = 0.5; W.state.remeshIterations = 5;
    const prog = [];
    const used = await W.tools.applyRemeshAsync(p => prog.push(p));
    const m = W.mesh;
    // 色が転写されているか（上が赤、下が青のまま？）
    let up = 0, upRed = 0, dn = 0, dnBlue = 0;
    for (let v = 0; v < m.nv; v++) {
      if (!m.vAlive[v]) continue;
      const y = m.positions[v*3+1];
      if (y > 0.3) { up++; if (m.colors[v*3] > m.colors[v*3+2]) upRed++; }
      else if (y < -0.3) { dn++; if (m.colors[v*3+2] > m.colors[v*3]) dnBlue++; }
    }
    // 閉多様体か
    const em = new Map(); const T = m.tris;
    for (let t = 0; t < m.nt; t++) { const i=t*3,a=T[i],b=T[i+1],c=T[i+2]; if(a===b&&b===c)continue;
      const vv=[a,b,c];
      for(let e=0;e<3;e++){const x=vv[e],y=vv[(e+1)%3];const k=x<y?x+':'+y:y+':'+x;em.set(k,(em.get(k)||0)+1);}}
    let bad=0,bnd=0; for(const n of em.values()){if(n===1)bnd++;else if(n!==2)bad++;}
    return { used, info: W.tools.remeshWorkerInfo(), nprog: prog.length,
      wasm: window.__wasmState ? window.__wasmState() : '(未公開)',
      stages: [...new Set(prog.map(p => p.stage))],
      tris: m.liveTris, bad, bnd, chi: m.liveVerts - em.size + m.liveTris,
      upRatio: up ? upRed / up : 0, dnRatio: dn ? dnBlue / dn : 0 };`);
  ok(r.used === true, `ワーカーで実行される (state=${r.info.state} ${r.info.error || ''})`);
  ok(r.wasm === 'ready', `メインスレッドで WASM カーネルが有効 (${r.wasm})`);
  ok(r.info.wasm === true, 'ワーカー側でも WASM カーネルが有効');
  ok(r.nprog >= 4, `進捗が届く (${r.nprog} 回 / ${r.stages.join(',')})`);
  ok(Math.abs(r.tris - 8000) / 8000 < 0.15, `ワーカーでも目標面数に近づく (${r.tris})`);
  ok(r.bad === 0 && r.bnd === 0 && r.chi === 2,
    `ワーカーの結果も閉多様体 χ=2 (非多様体 ${r.bad} / 境界 ${r.bnd} / χ=${r.chi})`);
  ok(r.upRatio > 0.95 && r.dnRatio > 0.95,
    `頂点色がワーカー往復で保たれる (上 ${(r.upRatio*100).toFixed(1)}% / 下 ${(r.dnRatio*100).toFixed(1)}%)`);

  // ワーカーで走っている間、メインスレッドが止まらないこと。
  // 「250 万ポリゴンのリメッシュでハングする」という報告そのものの検証。
  r = await runA(`const W = window.WebSculpt;
    W.state.dynTopo = false;
    W.app.newMesh('sphere');
    for (let i = 0; i < 4; i++) W.sculptor.divide();
    W.state.remeshTris = 20000; W.state.remeshIterations = 5;
    let frames = 0, stop = false;
    const tick = () => { frames++; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    const used = await W.app.remeshAdaptive();
    const ms = performance.now() - t0;
    stop = true;
    return { used, ms, frames, tris: W.mesh.liveTris };`);
  ok(r.ms > 150, `検証に足る長さの処理になっている (${r.ms.toFixed(0)}ms / ${r.tris} 面)`);
  // 止まっていれば 0〜2 フレームしか進まない。10fps 以上出ていれば動いている。
  ok(r.frames / (r.ms / 1000) > 10,
    `処理中も画面が動く (${r.frames} フレーム / ${r.ms.toFixed(0)}ms = ${(r.frames/(r.ms/1000)).toFixed(0)}fps)`);

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ リメッシュ E2E 通過' : '\n❌ ' + fails + ' 件の失敗');
process.exit(fails === 0 ? 0 : 1);
