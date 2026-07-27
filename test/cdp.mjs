// ---------------------------------------------------------------------------
// 依存パッケージなしの最小 Chrome DevTools Protocol クライアント。
// Node 22+ のグローバル fetch / WebSocket を利用する。
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

export async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(200);
  }
}

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('websocket error')));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** ページ内で式を評価して値を返す（Promise は await される） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 1200));
    }
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/**
 * ヘッドレス Chrome を起動して CDP を返す。
 * 既定では静的サーバ経由（http）。opts.file を立てると file:// で直接開く
 * （単一ファイル版 websculpt.html の検証用）。
 * @returns {{cdp: CDP, stop: () => Promise<void>, url: string, stderr: () => string}}
 */
export async function launch(pagePath, opts = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome / Edge が見つかりません（CHROME_PATH で指定可）');

  const port = 8123 + Math.floor(Math.random() * 500);
  const cdpPort = 9330 + Math.floor(Math.random() * 500);
  const width = opts.width || 1440;
  const height = opts.height || 900;

  const useFile = !!opts.file;
  // opts.baseUrl を渡すと既に立っているサーバ（serve.ps1 など）を使う
  const external = !useFile && !!opts.baseUrl;
  const server = (useFile || external) ? null
    : spawn(process.execPath, [join(ROOT, 'server.mjs'), String(port)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  const profile = mkdtempSync(join(tmpdir(), 'websculpt-cdp-'));
  const base = external ? opts.baseUrl.replace(/\/$/, '') : `http://localhost:${port}`;
  const url = useFile
    ? pathToFileURL(join(ROOT, pagePath.replace(/^[/\\]/, ''))).href
    : `${base}${pagePath}`;

  const flags = [
    opts.visible ? '--start-maximized' : '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // WebGPU は Chrome 113+ で既定有効。利用者の環境を再現するためフラグは渡さない
    // （opts.unsafeWebGPU を立てた場合のみ有効化する）
    ...(opts.unsafeWebGPU ? ['--enable-unsafe-webgpu'] : []),
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--mute-audio',
  ];
  if (opts.swiftshader) flags.push('--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader');
  flags.push(url);

  const browser = spawn(chrome, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  browser.stderr.on('data', d => { err += d.toString(); });

  if (!useFile) {
    await waitFor(async () => (await fetch(`${base}/index.html`)).ok, 10000, 'static server');
  }
  const prefix = useFile ? 'file:' : base;
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://localhost:${cdpPort}/json/list`)).json();
    return list.find(t => t.type === 'page' && t.url.startsWith(prefix));
  }, 30000, 'devtools target');

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  return {
    cdp, url,
    stderr: () => err,
    async stop() {
      cdp.close();
      try { browser.kill(); } catch { /* ignore */ }
      if (server) { try { server.kill(); } catch { /* ignore */ } }
      await sleep(400);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
