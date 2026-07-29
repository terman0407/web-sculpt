// ---------------------------------------------------------------------------
// 使い方ページの E2E テスト（実ブラウザ）。
//   node test/help.mjs           モジュール版
//   node test/help.mjs --file    単一ファイル版
//
// 一番大事なのは **腐っていないこと** の検証。ツール一覧はパレットの表から
// 生成しているので、パレットに項目を足したらヘルプにも自動で出る——という
// 前提が崩れていないかを、実際の表と描かれた DOM で突き合わせる。
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const args = process.argv.slice(2);
const useFile = args.includes('--file');
const h = await launch(useFile ? '/websculpt.html' : '/index.html',
  { width: 1400, height: 950, file: useFile });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.tools)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  await cdp.eval('new Promise(r=>setTimeout(r,700))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));
  const key = async (code, k) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent',
        { type, code, key: k, windowsVirtualKeyCode: 0, modifiers: 0 });
    }
    await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  };

  // --- 開く / 閉じる -------------------------------------------------------
  let r = await run(`return {
    exists: !!document.getElementById('help'),
    open: document.getElementById('help').classList.contains('show'),
    btn: [...document.querySelectorAll('#meshBar .btn')].some(b => /使い方/.test(b.textContent)),
  };`);
  ok(r.exists, '使い方ページの入れ物がある');
  ok(r.btn, '上部バーに「使い方」ボタンがある');
  ok(!r.open, '最初は閉じている');

  await key('F1', 'F1');
  r = await run(`return { open: document.getElementById('help').classList.contains('show') };`);
  ok(r.open, 'F1 で開く');

  // 開いている間は他のキーが効かないこと（裏で形が変わると読めない）
  r = await run(`const W = window.WebSculpt;
    const before = { brush: W.state.brush, dyn: W.state.dynTopo, tris: W.mesh.liveTris };
    return before;`);
  await key('KeyG', 'g');
  await key('Digit3', '3');
  const after = await run(`const W = window.WebSculpt;
    return { brush: W.state.brush, dyn: W.state.dynTopo, tris: W.mesh.liveTris };`);
  ok(after.dyn === r.dyn && after.brush === r.brush && after.tris === r.tris,
    `開いている間は他のキーが効かない (brush ${r.brush}→${after.brush} / dynTopo ${r.dyn}→${after.dyn})`);

  await key('Escape', 'Escape');
  r = await run(`return { open: document.getElementById('help').classList.contains('show') };`);
  ok(!r.open, 'Esc で閉じる');

  // 閉じたあとはキーが戻ること
  await key('KeyG', 'g');
  r = await run(`const W = window.WebSculpt; return { dyn: W.state.dynTopo };`);
  ok(r.dyn !== after.dyn, '閉じたあとはキーが効く');
  await key('KeyG', 'g');   // 元に戻す

  // --- 中身が実装とずれていないか -----------------------------------------
  // 描かれた DOM のテキストを集めて、各パレットの表の項目が全部入っているかを見る。
  r = await run(`const W = window.WebSculpt;
    W.ui.openHelp();
    const root = document.getElementById('help');
    const names = [...root.querySelectorAll('.help-name')].map(n => n.textContent);
    const text = root.textContent;
    const secs = [...root.querySelectorAll('.help-sec h2')].map(n => n.textContent);
    const navs = [...root.querySelectorAll('.help-navlink')].map(n => n.textContent);
    return { names, secs, navs, len: text.length,
      keyRows: root.querySelectorAll('.help-table.keys tr').length };`);
  ok(r.secs.length >= 15, `節が揃っている (${r.secs.length} 節)`);
  ok(r.navs.length === r.secs.length, `もくじと節の数が一致 (${r.navs.length} / ${r.secs.length})`);
  ok(r.len > 6000, `十分な分量がある (${r.len.toLocaleString()} 文字)`);
  ok(r.keyRows >= 15, `キー操作の表が出ている (${r.keyRows} 行)`);

  // パレットの表 vs ヘルプの一覧
  const drift = await run(`
    const tables = window.WebSculpt.ui.helpSources();
    const root = document.getElementById('help');
    const names = new Set([...root.querySelectorAll('.help-name')].map(n => n.textContent));
    const out = {};
    for (const [k, list] of Object.entries(tables)) {
      out[k] = { total: list.length, missing: list.filter(x => !names.has(x.jp)).map(x => x.jp) };
    }
    return out;`);
  for (const [k, v] of Object.entries(drift)) {
    ok(v.missing.length === 0,
      `${k} の ${v.total} 項目すべてがヘルプに出る${v.missing.length ? ' / 欠け: ' + v.missing.join(', ') : ''}`);
  }

  // キー操作の表が SHORTCUTS と一致しているか
  r = await run(`const W = window.WebSculpt;
    const list = W.app.shortcuts().filter(s => !s.hidden && s.group);
    const root = document.getElementById('help');
    const shown = root.querySelectorAll('.help-table.keys tr').length;
    const text = root.textContent;
    return { defined: list.length, shown,
      missing: list.filter(s => !text.includes(s.jp)).map(s => s.keys) };`);
  ok(r.missing.length === 0,
    `キー操作 ${r.defined} 件すべてが載っている${r.missing.length ? ' / 欠け: ' + r.missing.join(', ') : ''}`);

  // --- 絞り込み -----------------------------------------------------------
  r = await run(`const root = document.getElementById('help');
    const s = root.querySelector('.help-search');
    const count = () => [...root.querySelectorAll('.help-item')].filter(n => !n.classList.contains('hide')).length;
    const all = count();
    s.value = 'ピンチ';
    s.dispatchEvent(new Event('input'));
    const hit = count();
    const hitNames = [...root.querySelectorAll('.help-item')]
      .filter(n => !n.classList.contains('hide'))
      .map(n => n.querySelector('.help-name').textContent);
    const secsShown = [...root.querySelectorAll('.help-sec')].filter(n => !n.classList.contains('hide')).length;
    const navsShown = [...root.querySelectorAll('.help-navlink')].filter(n => !n.classList.contains('hide')).length;
    s.value = '';
    s.dispatchEvent(new Event('input'));
    return { all, hit, hitNames, secsShown, navsShown, back: count() };`);
  ok(r.hit > 0 && r.hit < r.all, `絞り込みが効く (${r.all} → ${r.hit} 件)`);
  ok(r.hitNames.includes('ピンチ'), `探した項目が残る (${r.hitNames.join(', ')})`);
  ok(r.navsShown === r.secsShown,
    `中身が消えた節はもくじからも消える (節 ${r.secsShown} / もくじ ${r.navsShown})`);
  ok(r.back === r.all, `検索を消すと元に戻る (${r.back} / ${r.all})`);

  // --- 見た目が破綻していないか -------------------------------------------
  // 横スクロールが出ると読めなくなる。表は自分の枠内でだけ横に流れること。
  r = await run(`const root = document.getElementById('help');
    const card = root.querySelector('.help-card');
    const main = root.querySelector('.help-main');
    return {
      cardOverflow: card.scrollWidth - card.clientWidth,
      mainOverflow: main.scrollWidth - main.clientWidth,
      scrollable: main.scrollHeight > main.clientHeight,
      navVisible: root.querySelector('.help-nav').clientWidth > 0,
    };`);
  ok(r.cardOverflow <= 1 && r.mainOverflow <= 1,
    `横に溢れていない (カード ${r.cardOverflow}px / 本文 ${r.mainOverflow}px)`);
  ok(r.scrollable, '本文が縦スクロールできる');
  ok(r.navVisible, 'もくじが見えている');

  // 閉じるボタン
  r = await run(`document.getElementById('help').querySelector('.help-close').click();
    return { open: document.getElementById('help').classList.contains('show') };`);
  ok(!r.open, '✕ ボタンで閉じる');

  // 背景クリックでも閉じる
  r = await run(`const W = window.WebSculpt;
    W.ui.openHelp();
    const root = document.getElementById('help');
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return { open: root.classList.contains('show') };`);
  ok(!r.open, '背景を押しても閉じる');

  // 狭い画面でも崩れないか
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.eval('new Promise(r=>setTimeout(r,250))');
  r = await run(`const W = window.WebSculpt;
    W.ui.openHelp();
    const root = document.getElementById('help');
    const card = root.querySelector('.help-card');
    const main = root.querySelector('.help-main');
    return { cardOverflow: card.scrollWidth - card.clientWidth,
      mainOverflow: main.scrollWidth - main.clientWidth,
      navRow: getComputedStyle(root.querySelector('.help-nav')).flexDirection };`);
  ok(r.cardOverflow <= 1 && r.mainOverflow <= 1,
    `狭い画面でも横に溢れない (${r.cardOverflow}px / ${r.mainOverflow}px)`);
  ok(r.navRow === 'row', 'もくじが横並びに切り替わる');
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ 使い方ページ 通過' : '\n❌ ' + fails + ' 件の失敗');
process.exit(fails === 0 ? 0 : 1);
