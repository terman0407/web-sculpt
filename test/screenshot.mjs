// ---------------------------------------------------------------------------
// 実際の index.html をヘッドレスで開き、プログラム的に彫刻してからスクリーンショットを
// 保存する。描画結果の目視確認用。
//   node test/screenshot.mjs [出力ディレクトリ]
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep, waitFor, ROOT } from './cdp.mjs';

const OUT = process.argv[2] || join(ROOT, 'test', 'shots');
mkdirSync(OUT, { recursive: true });

// ページ内で実行するヘルパ群
const HELPERS = `
window.__t = {
  frames(n) {
    return new Promise(res => {
      let i = 0;
      const tick = () => { if (++i >= n) res(true); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  },
  // 球面上の測地線に沿ってストロークする
  async stroke(brush, opts) {
    const W = window.WebSculpt;
    const { mesh, sculptor, state } = W;
    const o = Object.assign({ lat: 0.3, lon: 0.0, len: 1.0, dir: 1, radius: 0.18, strength: 0.6, samples: 26 }, opts);
    state.worldRadius = o.radius;
    state.strength = o.strength;
    const pt = new Float32Array(3);
    const at = (u) => {
      const lon = o.lon + u * o.len;
      const lat = o.lat + (o.latEnd !== undefined ? (o.latEnd - o.lat) * u : 0);
      // 現在の形状に沿うよう、方向ベクトル上で最も遠い頂点の距離を使う
      const dx = Math.cos(lat) * Math.cos(lon), dy = Math.sin(lat), dz = Math.cos(lat) * Math.sin(lon);
      let best = 1;
      const P = mesh.positions;
      let bestDot = -1;
      for (let v = 0; v < mesh.nv; v += 7) {
        if (!mesh.vAlive[v]) continue;
        const i = v * 3;
        const l = Math.hypot(P[i], P[i+1], P[i+2]) || 1;
        const d = (P[i]*dx + P[i+1]*dy + P[i+2]*dz) / l;
        if (d > bestDot) { bestDot = d; best = l; }
      }
      pt[0] = dx * best; pt[1] = dy * best; pt[2] = dz * best;
      return pt;
    };
    sculptor.beginStroke(brush, at(0), o.dir);
    for (let k = 1; k <= o.samples; k++) sculptor.addSample(at(k / o.samples));
    sculptor.endStroke();
    await this.frames(2);
    return { verts: mesh.liveVerts, tris: mesh.liveTris };
  },
};
'ready'`;

async function shot(cdp, name, label) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = join(OUT, name);
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log(`  saved ${name}  (${label})`);
}

async function main() {
  const h = await launch('/index.html', { width: 1440, height: 900 });
  const { cdp } = h;
  try {
    await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.renderer && window.WebSculpt.sculptor)'), 40000, 'app boot');
    const fatal = await cdp.eval("document.getElementById('fatal').style.display");
    if (fatal === 'flex') {
      const msg = await cdp.eval("document.getElementById('fatalMsg').textContent + ' / ' + document.getElementById('fatalDetail').textContent");
      throw new Error('起動時エラー画面: ' + msg);
    }
    await cdp.eval(HELPERS);
    await cdp.eval('window.__t.frames(6)');

    await shot(cdp, '01-initial.png', '初期状態（球 + MatCap + SSAO）');

    // 彫刻: 目の窪み風のストロークを何本か
    let info = await cdp.eval(`window.__t.stroke('clay', { lat: 0.35, lon: -0.5, len: 1.0, latEnd: 0.35, radius: 0.20, strength: 0.75, dir: 1 })`);
    console.log('  clay  ->', JSON.stringify(info));
    info = await cdp.eval(`window.__t.stroke('crease', { lat: -0.1, lon: -0.3, len: 0.9, latEnd: -0.5, radius: 0.10, strength: 0.8, dir: 1 })`);
    console.log('  crease->', JSON.stringify(info));
    info = await cdp.eval(`window.__t.stroke('draw', { lat: 0.75, lon: 0.1, len: 0.5, radius: 0.22, strength: 0.9, dir: 1 })`);
    console.log('  draw  ->', JSON.stringify(info));
    info = await cdp.eval(`window.__t.stroke('inflate', { lat: -0.6, lon: 0.4, len: 0.6, radius: 0.18, strength: 0.7, dir: 1 })`);
    console.log('  infl  ->', JSON.stringify(info));

    await cdp.eval('window.__t.frames(4)');
    await shot(cdp, '02-sculpted.png', '彫刻後（動的トポロジ + X ミラー）');

    await cdp.eval('window.WebSculpt.state.wireframe = true; window.__t.frames(20)');
    await shot(cdp, '03-wireframe.png', 'ワイヤフレームで動的トポロジを確認');

    await cdp.eval('window.WebSculpt.state.wireframe = false; window.WebSculpt.state.material = 1; window.__t.frames(4)');
    await shot(cdp, '04-clay-material.png', 'ホワイトクレイ');

    await cdp.eval('window.WebSculpt.state.material = 4; window.WebSculpt.app.setBackground("grey"); window.__t.frames(4)');
    await shot(cdp, '05-chrome-grey.png', 'クローム + グレー背景');

    // ポリペイント
    await cdp.eval(`
      window.WebSculpt.state.material = 1;
      window.WebSculpt.app.setBackground('dark');
      window.WebSculpt.state.paintColor = [0.55, 0.08, 0.06];
      window.__t.stroke('paint', { lat: 0.3, lon: -0.4, len: 1.1, radius: 0.3, strength: 1.0 })`);
    await cdp.eval(`
      window.WebSculpt.state.paintColor = [0.05, 0.25, 0.45];
      window.__t.stroke('paint', { lat: -0.5, lon: 0.2, len: 0.9, radius: 0.25, strength: 1.0 })`);
    await cdp.eval('window.__t.frames(4)');
    await shot(cdp, '06-polypaint.png', 'ポリペイント');

    // マスク表示
    await cdp.eval(`window.__t.stroke('mask', { lat: 0.1, lon: 1.2, len: 0.8, radius: 0.3, strength: 1.0 })`);
    await cdp.eval('window.__t.frames(4)');
    await shot(cdp, '07-mask.png', 'マスク表示');

    // AO 無効との比較
    await cdp.eval('window.WebSculpt.state.ao = false; window.__t.frames(4)');
    await shot(cdp, '08-no-ao.png', 'AO オフ（比較用）');

    await cdp.eval('window.WebSculpt.state.ao = true; window.WebSculpt.state.debugView = 1; window.__t.frames(4)');
    await shot(cdp, '09-ao-only.png', 'SSAO 単独表示');

    await cdp.eval('window.WebSculpt.state.debugView = 0; window.WebSculpt.state.material = 5; window.__t.frames(4)');
    await shot(cdp, '10-darkstone.png', 'ダークストーン');

    // ---- ダイナメッシュ: 引き伸ばして密度が偏ったメッシュを作り直す ----
    await cdp.eval(`
      window.WebSculpt.app.newMesh('sphere');
      window.WebSculpt.state.material = 1;
      window.WebSculpt.state.debugView = 0;
      window.WebSculpt.state.symmetry.x = true;
      window.__t.frames(4)`);
    // 細いブラシで強く引き出し、局所的に高密度な突起を作る
    await cdp.eval(`window.__t.stroke('draw', { lat: 0.5, lon: -0.9, len: 0.18, radius: 0.26, strength: 1.0, samples: 44 })`);
    await cdp.eval(`window.__t.stroke('draw', { lat: -0.25, lon: 0.5, len: 0.18, radius: 0.22, strength: 1.0, samples: 44 })`);
    await cdp.eval(`window.__t.stroke('crease', { lat: 0.05, lon: -0.1, len: 0.9, latEnd: -0.3, radius: 0.09, strength: 0.9, samples: 40 })`);
    await cdp.eval('window.WebSculpt.state.wireframe = true; window.__t.frames(20)');
    await shot(cdp, '17-before-dynamesh.png', 'ダイナメッシュ前（伸ばした部分だけ高密度）');

    const st1 = await cdp.eval('JSON.stringify({v: WebSculpt.mesh.liveVerts, t: WebSculpt.mesh.liveTris})');
    await cdp.eval('window.WebSculpt.state.dynaResolution = 120; window.WebSculpt.state.dynaSmooth = 1');
    await cdp.eval('window.WebSculpt.app.dynamesh()');
    await cdp.eval('window.__t.frames(30)');
    const st2 = await cdp.eval('JSON.stringify({v: WebSculpt.mesh.liveVerts, t: WebSculpt.mesh.liveTris})');
    console.log('  dynamesh ' + st1 + ' -> ' + st2);
    await shot(cdp, '18-after-dynamesh.png', 'ダイナメッシュ後（均一なトポロジに再構築）');
    await cdp.eval('window.WebSculpt.state.wireframe = false; window.__t.frames(4)');
    await shot(cdp, '19-after-dynamesh-shaded.png', 'ダイナメッシュ後（シェーディング）');

    const stats = await cdp.eval(`JSON.stringify({
      verts: WebSculpt.mesh.liveVerts, tris: WebSculpt.mesh.liveTris,
      rt: WebSculpt.renderer.rtW + 'x' + WebSculpt.renderer.rtH,
      stats: document.getElementById('stats').textContent,
    })`);
    console.log('\n  ' + stats);

    const errs = await cdp.eval(`JSON.stringify(window.__pageErrors || [])`);
    console.log('  page errors: ' + errs);

    console.log('\n✅ スクリーンショットを ' + OUT + ' に保存しました');
  } catch (e) {
    console.error('\n❌ ' + e.message);
    const se = h.stderr();
    if (se) console.error('--- browser stderr ---\n' + se.slice(-2500));
    process.exitCode = 1;
  } finally {
    await h.stop();
  }
}

main();
