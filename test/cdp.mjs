// ---------------------------------------------------------------------------
// 依存パッケージなしの最小 Chrome DevTools Protocol クライアント。
// Node 22+ のグローバル fetch / WebSocket を利用する。
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
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

/**
 * Page.captureScreenshot の PNG を画素に戻す。
 *
 * **描画そのものを検証したいときに使う。** WebGPU のキャンバスは 2D の
 * drawImage で写しても空になるので（実測で全画素 0 が返った）、絵を比べるには
 * 合成後のスクリーンショットを取るしかない。依存パッケージは増やさない方針なので、
 * zlib だけで足りる範囲の PNG（8bit / 非インタレース / RGB か RGBA）を自分で解く。
 *
 * @param {string} base64 Page.captureScreenshot の data
 * @returns {{width: number, height: number, channels: number, data: Uint8Array}}
 */
export function decodePNG(base64) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG ではない');
  let p = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;                       // len + type + body + crc
  }
  if (depth !== 8) throw new Error(`8bit 以外の PNG は解けない (depth ${depth})`);
  if (interlace) throw new Error('インタレース PNG は解けない');
  const channels = colorType === 6 ? 4 : (colorType === 2 ? 3 : 0);
  if (!channels) throw new Error(`RGB / RGBA 以外は解けない (colorType ${colorType})`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = src; src += stride;
    const o = y * stride, prev = o - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[row + x];
      const a = x >= channels ? out[o + x - channels] : 0;   // 左
      const b = y > 0 ? out[prev + x] : 0;                   // 上
      const c = (x >= channels && y > 0) ? out[prev + x - channels] : 0;  // 左上
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          r = v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
          break;
        }
        default: throw new Error(`知らないフィルタ ${filter}`);
      }
      out[o + x] = r & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * PNG 2 枚の平均絶対差（0..255）。輝度で比べる。
 * 大きさが違うときは投げる（比べる意味がないので黙って 0 を返さない）。
 */
export function pngDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`大きさが違う (${a.width}x${a.height} / ${b.width}x${b.height})`);
  }
  const ca = a.channels, cb = b.channels;
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const ia = i * ca, ib = i * cb;
    const la = 0.299 * a.data[ia] + 0.587 * a.data[ia + 1] + 0.114 * a.data[ia + 2];
    const lb = 0.299 * b.data[ib] + 0.587 * b.data[ib + 1] + 0.114 * b.data[ib + 2];
    sum += Math.abs(la - lb);
  }
  return sum / n;
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
