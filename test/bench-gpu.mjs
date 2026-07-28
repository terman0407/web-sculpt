// ---------------------------------------------------------------------------
// 描画側のベンチマーク。ヘッドレス Chrome で実際に描画し、
// 設定ごとのフレーム時間を測る。
//   node test/bench-gpu.mjs
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const SIZES = [20000, 150000];

const HELPERS = `
window.__b = {
  // requestAnimationFrame の間隔から実フレーム時間を測る（描画を含む）
  async measure(frames) {
    // 数フレーム捨ててから計測する
    await new Promise(r => { let i = 0; const f = () => (++i >= 8 ? r(1) : requestAnimationFrame(f)); requestAnimationFrame(f); });
    return await new Promise(res => {
      const ts = [];
      let i = 0;
      const tick = (t) => {
        ts.push(t);
        if (++i > frames) {
          const d = [];
          for (let k = 1; k < ts.length; k++) d.push(ts[k] - ts[k - 1]);
          d.sort((a, b) => a - b);
          res({ median: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)], n: d.length });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  },
  // 目標頂点数まで彫って準備する
  grow(target) {
    const W = window.WebSculpt, { mesh, sculptor, state } = W;
    state.worldRadius = 0.25; state.strength = 0.7; state.detail = 0.6;
    state.dynTopo = true; state.maxVerts = 4000000;
    const pt = new Float32Array(3);
    let seed = 0, guard = 0;
    while (mesh.liveVerts < target && guard++ < 3000) {
      const at = (u) => {
        const th = seed * 0.7 + u * 1.6, ph = -0.8 + Math.sin(seed + u * 2.2) * 0.9;
        const dx = Math.cos(ph) * Math.cos(th), dy = Math.sin(ph), dz = Math.cos(ph) * Math.sin(th);
        pt[0] = dx; pt[1] = dy; pt[2] = dz; return pt;
      };
      sculptor.beginStroke('clay', at(0), 1);
      for (let k = 1; k <= 14; k++) sculptor.addSample(at(k / 14));
      sculptor.endStroke();
      seed++;
    }
    return mesh.liveVerts;
  },
};
'ok'`;

async function main() {
  const h = await launch('/index.html', { width: 1600, height: 1000 });
  const { cdp } = h;
  const rows = [];
  try {
    await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.renderer)'), 40000, 'boot');
    await cdp.eval(HELPERS);
    const info = await cdp.eval('JSON.stringify(WebSculpt.renderer.adapterInfo || {})');
    console.log('  GPU: ' + info);
    const rt = await cdp.eval(`WebSculpt.renderer.rtW + 'x' + WebSculpt.renderer.rtH`);
    console.log('  レンダーターゲット: ' + rt);

    const scenarios = [
      ['既定 (AO on)', 'WebSculpt.state.ao = true; WebSculpt.state.wireframe = false; WebSculpt.state.grid = true; WebSculpt.app.setRenderScale(1)'],
      ['AO off', 'WebSculpt.state.ao = false'],
      ['AO off + グリッド off', 'WebSculpt.state.grid = false'],
      ['AO on + グリッド off', 'WebSculpt.state.ao = true'],
      ['ワイヤフレーム on', 'WebSculpt.state.wireframe = true'],
      ['レンダースケール 0.7', 'WebSculpt.state.wireframe = false; WebSculpt.app.setRenderScale(0.7)'],
      ['レンダースケール 1.0 に戻す', 'WebSculpt.app.setRenderScale(1)'],
    ];

    for (const size of SIZES) {
      const nv = await cdp.eval(`window.__b.grow(${size})`);
      console.log(`\n  --- ${nv.toLocaleString()} 頂点 ---`);
      for (const [label, setup] of scenarios) {
        await cdp.eval(setup);
        const r = await cdp.eval('window.__b.measure(50)');
        const fps = 1000 / r.median;
        rows.push({ nv, label, median: r.median, fps });
        console.log(`    ${r.median.toFixed(2).padStart(7)} ms/frame  ${fps.toFixed(0).padStart(4)} fps  p95 ${r.p95.toFixed(1).padStart(6)}   ${label}`);
      }
      // 彫刻しながらのフレーム時間（CPU + GPU 合算の実使用に近い値）
      await cdp.eval(`WebSculpt.state.ao = true; WebSculpt.state.grid = true; WebSculpt.state.wireframe = false`);
      const live = await cdp.eval(`(async () => {
        const W = window.WebSculpt, { sculptor, state } = W;
        state.worldRadius = 0.25;
        const pt = new Float32Array(3);
        let seed = 900;
        let running = true;
        const step = () => {
          if (!running) return;
          const u = (performance.now() % 1000) / 1000;
          const th = seed * 0.7 + u * 1.6, ph = -0.8 + Math.sin(seed + u * 2.2) * 0.9;
          pt[0] = Math.cos(ph) * Math.cos(th); pt[1] = Math.sin(ph); pt[2] = Math.cos(ph) * Math.sin(th);
          if (!sculptor.stroking) sculptor.beginStroke('clay', pt, 1); else sculptor.addSample(pt);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        const r = await window.__b.measure(40);
        running = false; sculptor.endStroke();
        return r;
      })()`);
      console.log(`    ${live.median.toFixed(2).padStart(7)} ms/frame  ${(1000 / live.median).toFixed(0).padStart(4)} fps  p95 ${live.p95.toFixed(1).padStart(6)}   ★彫刻しながら`);
      rows.push({ nv, label: '彫刻しながら', median: live.median, fps: 1000 / live.median });
    }
  } catch (e) {
    console.error('ERR ' + (e.stack || e.message));
    process.exitCode = 1;
  } finally {
    await h.stop();
  }
}

main();
