// ---------------------------------------------------------------------------
// 仕上げレンダリング（BPR 相当）と STL 読み込みの E2E テスト（実ブラウザ）。
//   node test/render.mjs           モジュール版
//   node test/render.mjs --file    単一ファイル版
//
// レンダリングは GPU の結果を PNG にして返すので、**絵が実際に変わっているか**を
// ピクセルで見る。影を入れたら暗い所が増える、輪郭線を入れたら暗い縁ができる、
// 透明背景なら α=0 の画素がある——という形で確かめる。
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const args = process.argv.slice(2);
const useFile = args.includes('--file');
const h = await launch(useFile ? '/websculpt.html' : '/index.html',
  { width: 900, height: 700, file: useFile });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.tools)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  await cdp.eval('new Promise(r=>setTimeout(r,800))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));
  const runA = async (code) => JSON.parse(await cdp.eval('(async () => JSON.stringify(await (async () => { ' + code + ' })()))()', 300000));

  // PNG の Blob を受け取って画素の統計を返すヘルパをページに置く
  await cdp.eval(`window.__stat = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    let dark = 0, opaque = 0, transparent = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
      sum += l;
      if (l < 40) dark++;
      if (d[i+3] > 250) opaque++; else if (d[i+3] < 5) transparent++;
    }
    const n = d.length / 4;
    return { w: bmp.width, h: bmp.height, n, dark, opaque, transparent, mean: sum / n };
  };`);

  // 彫った形を用意する（平らな球だと影も輪郭も出にくい）
  await runA(`const W = window.WebSculpt;
    W.state.dynTopo = false;
    W.app.newMesh('sphere');
    W.sculptor.divide(); W.sculptor.divide();
    W.state.worldRadius = 0.35; W.state.strength = 1.0;
    W.state.symmetry.x = false;
    const pt = new Float32Array(3);
    for (let s = 0; s < 5; s++) {
      const at = (u) => {
        const th = s * 1.1 + u * 1.2, ph = -0.6 + Math.sin(s + u * 2) * 0.7;
        pt[0] = Math.cos(ph) * Math.cos(th); pt[1] = Math.sin(ph); pt[2] = Math.cos(ph) * Math.sin(th);
        return pt;
      };
      W.sculptor.beginStroke(s % 2 ? 'clay' : 'crease', at(0), 1);
      for (let k = 1; k <= 10; k++) W.sculptor.addSample(at(k / 10));
      W.sculptor.endStroke();
    }
    return { tris: W.mesh.liveTris };`);

  // --- 基本: レンダリングして PNG が返るか -------------------------------
  let r = await runA(`const W = window.WebSculpt;
    const res = await W.app.renderStill({ download: false, scale: 1, shadow: 0, outline: 0 });
    if (!res) return { failed: true };
    const st = await window.__stat(res.blob);
    return { ms: res.ms, w: res.width, h: res.height, scale: res.scale,
      type: res.blob.type, bytes: res.blob.size, st };`);
  ok(!r.failed, 'レンダリングが返る');
  ok(r.type === 'image/png' && r.bytes > 1000, `PNG が出る (${r.type} / ${(r.bytes / 1024).toFixed(0)}KB)`);
  ok(r.st.w === r.w && r.st.h === r.h,
    `画像の大きさが合う (${r.st.w}×${r.st.h} = ${r.w}×${r.h})`);
  ok(r.st.mean > 5 && r.st.mean < 250, `真っ黒でも真っ白でもない (平均輝度 ${r.st.mean.toFixed(1)})`);
  const base = r.st;
  console.log(`       ${r.w}×${r.h} / ${r.ms}ms / 平均輝度 ${base.mean.toFixed(1)}`);

  // --- ビューポートが壊れていないか ---------------------------------------
  // 解像度を一時的に上げて戻すので、戻し損なうと以降の表示が壊れる。
  r = await runA(`const W = window.WebSculpt;
    const before = [W.renderer.rtW, W.renderer.rtH];
    await W.app.renderStill({ download: false, scale: 2 });
    await new Promise(rr => requestAnimationFrame(() => requestAnimationFrame(rr)));
    return { before, after: [W.renderer.rtW, W.renderer.rtH],
      errs: (window.__errs || []).length };`);
  ok(r.before[0] === r.after[0] && r.before[1] === r.after[1],
    `レンダリング後に解像度が戻る (${r.before} → ${r.after})`);
  ok(r.errs === 0, 'レンダリング中に例外が出ない');

  // --- 影が絵を変えるか ---------------------------------------------------
  r = await runA(`const W = window.WebSculpt;
    const a = await W.app.renderStill({ download: false, scale: 1, shadow: 0, outline: 0 });
    const b = await W.app.renderStill({ download: false, scale: 1, shadow: 1, outline: 0, ambient: 0.25 });
    return { off: await window.__stat(a.blob), on: await window.__stat(b.blob) };`);
  ok(r.on.mean < r.off.mean * 0.97,
    `影を入れると暗くなる (平均輝度 ${r.off.mean.toFixed(1)} → ${r.on.mean.toFixed(1)})`);
  ok(r.on.dark > r.off.dark,
    `暗い画素が増える (${r.off.dark.toLocaleString()} → ${r.on.dark.toLocaleString()})`);

  // 光の向きを変えたら絵が変わること（影が本当に光源に追従しているか）
  r = await runA(`const W = window.WebSculpt;
    const shot = async (az) => {
      W.state.bprLightAz = az;
      const res = await W.app.renderStill({ download: false, scale: 1, shadow: 1, outline: 0, ambient: 0.25 });
      const bmp = await createImageBitmap(res.blob);
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      cv.getContext('2d').drawImage(bmp, 0, 0);
      return cv.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const a = await shot(-60), b = await shot(120);
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 12) diff++;
    W.state.bprLightAz = -40;
    return { diff, n: a.length / 4 };`);
  ok(r.diff / r.n > 0.05,
    `光の向きで絵が変わる (${(r.diff / r.n * 100).toFixed(1)}% の画素が変化)`);

  // --- 輪郭線 -------------------------------------------------------------
  r = await runA(`const W = window.WebSculpt;
    const a = await W.app.renderStill({ download: false, scale: 1, shadow: 0, outline: 0 });
    const b = await W.app.renderStill({ download: false, scale: 1, shadow: 0, outline: 2, outlineStrength: 1 });
    return { off: await window.__stat(a.blob), on: await window.__stat(b.blob) };`);
  ok(r.on.dark > r.off.dark,
    `輪郭線で暗い画素が増える (${r.off.dark.toLocaleString()} → ${r.on.dark.toLocaleString()})`);

  // --- AO サンプル数 ------------------------------------------------------
  // 8 と 64 で絵が変わること（uniform でループ回数が本当に変わっているか）
  r = await runA(`const W = window.WebSculpt;
    const px = async (n) => {
      const res = await W.app.renderStill({ download: false, scale: 1, shadow: 0, outline: 0, aoSamples: n });
      const bmp = await createImageBitmap(res.blob);
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      cv.getContext('2d').drawImage(bmp, 0, 0);
      return cv.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const a = await px(8), b = await px(64);
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 6) diff++;
    return { diff, n: a.length / 4 };`);
  ok(r.diff > 0, `AO サンプル数が効く (${r.diff.toLocaleString()} 画素が変化)`);

  // --- スーパーサンプリング -----------------------------------------------
  r = await runA(`const W = window.WebSculpt;
    const a = await W.app.renderStill({ download: false, scale: 1, shadow: 0.8, outline: 0 });
    const b = await W.app.renderStill({ download: false, scale: 4, shadow: 0.8, outline: 0 });
    return { a: { ...await window.__stat(a.blob), at: a.renderedAt, sc: a.scale, ms: a.ms },
      b: { ...await window.__stat(b.blob), at: b.renderedAt, sc: b.scale, ms: b.ms } };`);
  ok(r.a.w === r.b.w && r.a.h === r.b.h,
    `倍率を変えても出力サイズは同じ (${r.a.w}×${r.a.h} / ${r.b.w}×${r.b.h})`);
  ok(r.b.at[0] === r.b.w * r.b.sc,
    `実際に ${r.b.sc} 倍で描いている (${r.b.at[0]}×${r.b.at[1]})`);
  console.log(`       1x ${r.a.ms}ms / ${r.b.sc}x ${r.b.ms}ms`);

  // --- 透明背景 -----------------------------------------------------------
  r = await runA(`const W = window.WebSculpt;
    const a = await W.app.renderStill({ download: false, scale: 1, transparent: false });
    const b = await W.app.renderStill({ download: false, scale: 1, transparent: true });
    return { opaque: await window.__stat(a.blob), clear: await window.__stat(b.blob) };`);
  ok(r.opaque.transparent === 0, `通常は全画素が不透明 (透明 ${r.opaque.transparent})`);
  ok(r.clear.transparent > r.clear.n * 0.1,
    `透明背景で背景が抜ける (${(r.clear.transparent / r.clear.n * 100).toFixed(0)}% が透明)`);
  ok(r.clear.opaque > r.clear.n * 0.05,
    `モデル自体は不透明のまま (${(r.clear.opaque / r.clear.n * 100).toFixed(0)}%)`);

  // --- プレビュー ---------------------------------------------------------
  r = await runA(`const W = window.WebSculpt;
    const wait = () => new Promise(rr => setTimeout(rr, 400));
    const before = W.ui.renderPreviewIsOpen();
    W.ui.openRenderPreview();
    await wait();
    const src1 = W.ui.renderPreviewSrc();
    const shown = getComputedStyle(document.getElementById('rpv')).opacity;
    // 設定を動かすと描き直されること
    W.state.bprLightAz = 90;
    document.getElementById('rpv') && W.ui.openRenderPreview();
    await wait();
    const src2 = W.ui.renderPreviewSrc();
    const info = document.getElementById('rpvInfo').textContent;
    W.ui.closeRenderPreview();
    await wait();
    return { before, open: W.ui.renderPreviewIsOpen(), shown: parseFloat(shown),
      src1, src2, info, closedSrc: W.ui.renderPreviewSrc() };`);
  ok(r.before === false, 'プレビューは最初は閉じている');
  ok(r.shown > 0.9, `開くと表示される (opacity ${r.shown})`);
  ok(/^blob:/.test(r.src1), `プレビュー画像が入る (${r.src1.slice(0, 24)}…)`);
  ok(r.src1 !== r.src2, '設定を変えると描き直される');
  ok(/\d+×\d+ \/ \d+ms/.test(r.info), `情報が出る (${r.info}）`);
  ok(r.open === false && r.closedSrc === '',
    '閉じると画像が外れる（Blob URL を解放している）');

  // --- UI の配線 ----------------------------------------------------------
  r = await run(`return {
    sec: [...document.querySelectorAll('#rightPanel .sec-head')].map(h => h.textContent.replace('▾','').trim()),
  };`);
  ok(r.sec.includes('レンダリング'), 'レンダリングのセクションがある');
  r = await run(`return {
    prev: [...document.querySelectorAll('#rightPanel .btn')].some(b => /プレビュー/.test(b.textContent)),
    save: [...document.querySelectorAll('#rightPanel .btn')].some(b => /PNG 保存/.test(b.textContent)),
  };`);
  ok(r.prev && r.save, 'プレビュー / PNG 保存のボタンがある');

  // --- STL の読み込み（配線）---------------------------------------------
  // ファイル選択ダイアログは出せないので、io の関数を直に叩いて配線を見る。
  r = await runA(`const W = window.WebSculpt;
    W.app.newMesh('cube');
    const stl = window.__io.exportSTL(W.mesh);
    const before = { verts: W.mesh.liveVerts, tris: W.mesh.liveTris };
    const g = window.__io.importSTL(stl);
    W.mesh.setGeometry(g.positions, g.indices);
    W.sculptor.setMesh(W.mesh);
    W.tools.onMeshReplaced();
    // 溶接できていないと ring が張れないので、彫っても形が変わらない or 崩れる
    W.state.worldRadius = 0.4; W.state.strength = 1.0; W.state.dynTopo = false;
    const snap = W.mesh.positions.slice(0, W.mesh.nv * 3);
    const pt = new Float32Array([0, 0, 1.2]);
    W.sculptor.beginStroke('clay', pt, 1);
    for (let k = 1; k <= 6; k++) { pt.set([k * 0.03, 0, 1.2]); W.sculptor.addSample(pt); }
    W.sculptor.endStroke();
    let moved = 0;
    for (let i = 0; i < snap.length; i++) if (Math.abs(W.mesh.positions[i] - snap[i]) > 1e-5) moved++;
    // 閉多様体か（溶接に失敗すると全部が境界辺になる）
    const em = new Map(); const T = W.mesh.tris;
    for (let t = 0; t < W.mesh.nt; t++) { const i=t*3,a=T[i],b=T[i+1],c=T[i+2]; if(a===b&&b===c)continue;
      const vv=[a,b,c];
      for(let e=0;e<3;e++){const x=vv[e],y=vv[(e+1)%3];const k=x<y?x+':'+y:y+':'+x;em.set(k,(em.get(k)||0)+1);}}
    let bnd=0,bad=0; for(const n of em.values()){if(n===1)bnd++;else if(n!==2)bad++;}
    return { before, after: { verts: W.mesh.liveVerts, tris: W.mesh.liveTris }, moved, bnd, bad,
      sourceTris: g.sourceTris };`);
  ok(r.after.tris === r.before.tris,
    `STL の面数が保たれる (${r.before.tris} → ${r.after.tris})`);
  ok(r.after.verts === r.before.verts,
    `溶接されている (${r.after.verts} 頂点 / 溶接なしなら ${r.sourceTris * 3})`);
  ok(r.bnd === 0 && r.bad === 0, `閉多様体を保つ (境界 ${r.bnd} / 非多様体 ${r.bad})`);
  ok(r.moved > 0, `読み込んだ STL を彫れる (${r.moved} 成分が動いた)`);

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ レンダリング / STL 通過' : '\n❌ ' + fails + ' 件の失敗');
process.exit(fails === 0 ? 0 : 1);
