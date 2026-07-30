// ---------------------------------------------------------------------------
// 面の陰影（スムース / フラット / 自動スムース）の E2E テスト（実ブラウザ）。
//   node test/shading.mjs           モジュール版
//   node test/shading.mjs --file    単一ファイル版
//
// 描画側で法線を切り替える仕掛けなので、**実際に絵が変わること**を画素で見る。
// 「設定は入ったが絵は同じ」を通してしまうと、直したつもりで直っていない。
//   * 立方体: スムース ≠ フラット（丸く見える → 面が見える）
//   * 球:     スムース ≠ フラット（なめらか → 面が見える）
//   * 立方体: 自動 ≈ フラット（90° の角は全部立つ）、かつ ≠ スムース
//   * 球:     自動 ≈ スムース（角が無いので全部なめらか）、かつ ≠ フラット
// ---------------------------------------------------------------------------

import { launch, waitFor, decodePNG, pngDiff } from './cdp.mjs';

const args = process.argv.slice(2);
const useFile = args.includes('--file');
const h = await launch(useFile ? '/websculpt.html' : '/index.html',
  { width: 900, height: 700, file: useFile });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const head = (t) => console.log('\n== ' + t + ' ==');
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.tools)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  await cdp.eval('new Promise(r=>setTimeout(r,900))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));
  const frames = (n = 4) => cdp.eval(
    `new Promise(r=>{let i=0;const t=()=>{if(++i>=${n})r(1);else requestAnimationFrame(t)};requestAnimationFrame(t)})`);

  // WebGPU のキャンバスは 2D の drawImage で写しても空になるので、
  // 合成後のスクリーンショットを取って画素を比べる（cdp.mjs の decodePNG）。
  // 右パネルが入ると差が薄まるので、キャンバスの中央だけを切り出す。
  const clip = await run(`const r = document.getElementById('gpu').getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.2), y: Math.round(r.top + r.height * 0.2),
      width: Math.round(r.width * 0.6), height: Math.round(r.height * 0.6) };`);
  const grab = async () => {
    const r = await cdp.send('Page.captureScreenshot',
      { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
    return decodePNG(r.data);
  };
  const diff = pngDiff;

  /**
   * 形と陰影を設定して 1 枚撮る。
   *
   * カメラは形ごとに決め打ちで置く:
   *   * 引いた絵だと 1 三角形が数 px になり、面の見え方の違いが平均差に埋もれる
   *   * 立方体は**稜線が画面に入る角度**でないと差が出ない（面の真ん中は平らなので、
   *     スムースでもフラットでも同じ法線になる。最初これで全部 0 になった）
   */
  const setup = async (kind, shading, angle = 30) => {
    const view = kind === 'cube'
      ? { dist: 2.4, yaw: 0.62, pitch: 0.48 }      // 角を正面に置いて 3 面と稜線を入れる
      : { dist: 1.5, yaw: 0.3, pitch: 0.2 };
    await run(`const W = window.WebSculpt;
      W.state.dynTopo = false;
      if (W.__shapeKind !== '${kind}') { W.app.newMesh('${kind}'); W.__shapeKind = '${kind}'; }
      W.state.shading = '${shading}';
      W.state.autoSmoothAngle = ${angle};
      W.state.wireframe = false;
      W.state.grid = false;
      W.app.frameCamera();
      W.camera.distance = W.camera.modelRadius * ${view.dist};
      W.camera.yaw = ${view.yaw};
      W.camera.pitch = ${view.pitch};
      return 1;`);
    await frames(6);
    return grab();
  };

  // --- 設定がユニフォームへ届いているか -----------------------------------
  head('ユニフォームへの受け渡し');
  {
    await setup('cube', 'auto', 45);
    const r = await run(`const W = window.WebSculpt;
      const U = W.renderer.uniformData;
      // UO.shade = 148（行列6 + vec4×13 のあと）
      return { mode: U[148], cosT: U[149], floats: U.length };`);
    ok(r.floats === 6 * 16 + 14 * 4, `ユニフォームの長さが増えている (${r.floats})`);
    ok(r.mode === 2, `自動スムースで mode = 2 (${r.mode})`);
    ok(Math.abs(r.cosT - Math.cos(45 * Math.PI / 180)) < 1e-5,
      `しきい値が cos(45°) で入る (${r.cosT})`);
    const r2 = await run(`const W = window.WebSculpt;
      W.state.shading = 'flat';
      return 1;`);
    await frames(3);
    const r3 = await run(`return { mode: window.WebSculpt.renderer.uniformData[148] };`);
    ok(r3.mode === 1, `フラットで mode = 1 (${r3.mode})`);
  }

  // --- 立方体 -------------------------------------------------------------
  head('立方体（角がきつい形）');
  {
    const smooth = await setup('cube', 'smooth');
    const flat = await setup('cube', 'flat');
    const auto = await setup('cube', 'auto', 30);
    const dSF = diff(smooth, flat), dSA = diff(smooth, auto), dFA = diff(flat, auto);
    ok(dSF > 1.5, `スムースとフラットで絵が変わる (平均差 ${dSF.toFixed(2)})`);
    ok(dSA > 1.5, `スムースと自動で絵が変わる (平均差 ${dSA.toFixed(2)})`);
    ok(dFA < dSA,
      `自動はスムースよりフラットに近い（90° の稜線は立つ）(自動↔フラット ${dFA.toFixed(2)}`
      + ` < 自動↔スムース ${dSA.toFixed(2)}）`);
    console.log(`       立方体: スムース↔フラット ${dSF.toFixed(2)}`
      + ` / スムース↔自動 ${dSA.toFixed(2)} / フラット↔自動 ${dFA.toFixed(2)}`);
  }

  // --- 球 -----------------------------------------------------------------
  head('球（角が無い形）');
  {
    const smooth = await setup('sphere', 'smooth');
    const flat = await setup('sphere', 'flat');
    const auto = await setup('sphere', 'auto', 30);
    const dSF = diff(smooth, flat), dSA = diff(smooth, auto), dFA = diff(flat, auto);
    ok(dSF > 1.0, `スムースとフラットで絵が変わる (平均差 ${dSF.toFixed(2)})`);
    ok(dSA < dSF * 0.2,
      `自動はスムースのまま（角が無い形では切り替わらない）(自動↔スムース ${dSA.toFixed(2)}`
      + ` << スムース↔フラット ${dSF.toFixed(2)}）`);
    ok(dFA > dSA, `自動はフラットとは違う (${dFA.toFixed(2)} > ${dSA.toFixed(2)})`);
    console.log(`       球: スムース↔フラット ${dSF.toFixed(2)}`
      + ` / スムース↔自動 ${dSA.toFixed(2)} / フラット↔自動 ${dFA.toFixed(2)}`);
  }

  // --- 同じ設定なら同じ絵（比較の土台が信用できるか）----------------------
  head('同じ設定を 2 回撮って同じになるか');
  {
    const a = await setup('sphere', 'smooth');
    const b = await setup('sphere', 'smooth');
    const d = diff(a, b);
    ok(d < 0.35, `同じ設定なら絵も同じ (平均差 ${d.toFixed(3)})`);
  }

  // --- 切り替えても形は変わらない（描画側だけの話であること）--------------
  head('形とポリゴン数は変わらない');
  {
    const r = await run(`const W = window.WebSculpt;
      W.state.shading = 'smooth';
      const a = { nv: W.mesh.liveVerts, nt: W.mesh.liveTris,
        p: W.mesh.positions[0], n: W.mesh.normals[0] };
      W.state.shading = 'flat';
      const b = { nv: W.mesh.liveVerts, nt: W.mesh.liveTris,
        p: W.mesh.positions[0], n: W.mesh.normals[0] };
      W.state.shading = 'auto';
      const c = { nv: W.mesh.liveVerts, nt: W.mesh.liveTris,
        p: W.mesh.positions[0], n: W.mesh.normals[0] };
      return { a, b, c };`);
    ok(r.a.nv === r.b.nv && r.b.nv === r.c.nv && r.a.nt === r.c.nt,
      `頂点数と三角形数が変わらない (${r.a.nv}/${r.a.nt} → ${r.c.nv}/${r.c.nt})`);
    ok(r.a.p === r.c.p && r.a.n === r.c.n, '座標と法線の配列を書き換えていない');
  }

  // --- UI と設定の保存 ----------------------------------------------------
  head('UI');
  {
    const r = await run(`const W = window.WebSculpt;
      const segs = [...document.querySelectorAll('#rightPanel .segmented')];
      const has = segs.some(s => [...s.querySelectorAll('.seg')]
        .map(b => b.textContent).join(',') === 'スムース,フラット,自動');
      const labels = [...document.querySelectorAll('#rightPanel label')].map(l => l.textContent);
      return { has, angle: labels.some(t => /自動スムースの角度/.test(t)) };`);
    ok(r.has, '〔スムース / フラット / 自動〕の切り替えが UI にある');
    ok(r.angle, '自動スムースの角度スライダーがある');
    const s = await run(`const W = window.WebSculpt;
      W.state.shading = 'flat'; W.state.autoSmoothAngle = 37;
      W.app.saveSettingsNow();
      const raw = JSON.parse(localStorage.getItem('websculpt.settings.v1') || '{}');
      return { shading: raw.shading, angle: raw.autoSmoothAngle };`);
    ok(s.shading === 'flat' && s.angle === 37,
      `設定が保存される (${s.shading} / ${s.angle})`);
  }

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ 面の陰影 E2E 通過' : `\n❌ ${fails} 件の失敗`);
process.exit(fails === 0 ? 0 : 1);
