// ---------------------------------------------------------------------------
// 依存ゼロの静的ファイルサーバ。ES モジュールは file:// から読めないため必要。
//   node server.mjs [port]
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.obj': 'text/plain; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    const rel = normalize(p).replace(/^([/\\])+/, '');
    const full = join(ROOT, rel);
    // ディレクトリトラバーサル防止
    if (!full.startsWith(ROOT + sep) && full !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const st = await stat(full);
    if (!st.isFile()) { res.writeHead(404).end('Not found'); return; }
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      // 将来 SharedArrayBuffer / マルチスレッド化する場合に備えて
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  WebSculpt  →  http://localhost:${PORT}/\n`);
  console.log('  終了するには Ctrl+C\n');
});
