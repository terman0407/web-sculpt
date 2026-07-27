// ---------------------------------------------------------------------------
// ヘッドレス Chrome で test/gpu-check.html を実行し、WGSL コンパイルと
// WebGPU パイプラインの検証結果を取得する。依存パッケージなし。
//
//   node test/run-gpu-check.mjs [--visible] [--swiftshader]
// ---------------------------------------------------------------------------

import { launch, waitFor } from './cdp.mjs';

const VISIBLE = process.argv.includes('--visible');
const SWIFT = process.argv.includes('--swiftshader');

async function main() {
  let exitCode = 1;
  let h = null;
  try {
    h = await launch('/test/gpu-check.html', {
      width: 900, height: 700, visible: VISIBLE, swiftshader: SWIFT,
    });
    const { cdp } = h;

    const out = await waitFor(async () => {
      const v = await cdp.eval('window.__gpuCheck ? window.__gpuCheck : null');
      return v || null;
    }, 60000, 'runGpuCheck()');

    console.log('\n---- adapter ----');
    console.log(JSON.stringify(out.adapter, null, 2));
    console.log('\n---- steps ----');
    (out.steps || []).forEach(s => console.log('  ・' + s));
    console.log('\n---- shaders ----');
    for (const s of out.shaders || []) {
      const msgs = (s.messages || []).filter(m => !m.startsWith('info'));
      const bad = s.scopeError || msgs.some(m => m.startsWith('error'));
      console.log(`  ${bad ? 'FAIL' : 'ok  '} ${s.name}`);
      if (s.scopeError) console.log('        scopeError: ' + s.scopeError);
      msgs.forEach(m => console.log('        ' + m));
    }
    if (out.pick) {
      console.log('\n---- pick ----');
      console.log('  ' + JSON.stringify(out.pick));
    }
    console.log('\n---- errors ----');
    if (!out.errors || out.errors.length === 0) console.log('  なし');
    else out.errors.forEach(e => console.log('  ✗ ' + e));

    console.log('\n' + (out.ok ? '✅ GPU パス検証 通過' : '❌ GPU パス検証 失敗'));
    exitCode = out.ok ? 0 : 1;
  } catch (err) {
    console.error('\n実行エラー:', err.message);
    if (h) {
      const se = h.stderr();
      if (se) console.error('--- browser stderr ---\n' + se.slice(-3000));
    }
    exitCode = 3;
  } finally {
    if (h) await h.stop();
  }
  process.exit(exitCode);
}

main();
