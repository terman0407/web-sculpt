// ---------------------------------------------------------------------------
// build.mjs
// 全モジュール + CSS を 1 枚の自己完結 HTML（websculpt.html）にまとめる。
// 出力はクラシックスクリプトなので file:// から直接開ける（= サーバ不要）。
//
//   node build.mjs
//
// ※ ソースを編集したときだけ必要。配布物としては生成済みの websculpt.html を
//    ダブルクリックするだけで動くので、利用者に Node は要らない。
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const ENTRY = 'main.js';
// import { ... } from './x.js';   （複数行にまたがる場合も含む）
const IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/([\w.-]+)['"]\s*;?[ \t]*$/gm;
// import * as NS from './x.js';
const NS_IMPORT_RE = /^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]\.\/([\w.-]+)['"]\s*;?[ \t]*$/gm;
// export [async] function|const|class NAME
const EXPORT_RE = /^export\s+((?:async\s+)?function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm;
// 想定外の export 形（export default / export { ... } / export * ）を検出する
const BAD_EXPORT_RE = /^export\s+(?!(?:async\s+)?function\s|const\s|class\s|let\s|var\s)/gm;
const BAD_IMPORT_RE = /^import\s+(?!\{|\*\s*as\s)/gm;

const cache = new Map();

function loadModule(name) {
  if (cache.has(name)) return cache.get(name);
  const src = readFileSync(join(ROOT, 'js', name), 'utf8');

  const bad = src.match(BAD_EXPORT_RE);
  if (bad) throw new Error(`${name}: 未対応の export 形式があります（${bad[0].trim()}…）`);
  const badI = src.match(BAD_IMPORT_RE);
  if (badI) throw new Error(`${name}: 未対応の import 形式があります（${badI[0].trim()}…）`);

  const deps = [];
  let body = src.replace(NS_IMPORT_RE, (_m, ns, dep) => {
    deps.push(dep);
    return `const ${ns} = __M['${dep}'];`;
  });
  body = body.replace(IMPORT_RE, (_m, names, dep) => {
    deps.push(dep);
    // `A as B` → `A: B`（分割代入の形に合わせる）
    const bind = names.split(',').map(s => s.trim()).filter(Boolean)
      .map(s => s.replace(/\s+as\s+/, ': ')).join(', ');
    return `const { ${bind} } = __M['${dep}'];`;
  });

  const exports = [];
  body = body.replace(EXPORT_RE, (_m, kind, id) => {
    exports.push(id);
    return `${kind} ${id}`;
  });

  const mod = { name, deps: [...new Set(deps)], exports, body };
  cache.set(name, mod);
  for (const d of mod.deps) loadModule(d);
  return mod;
}

function topoSort(entry) {
  const order = [];
  const state = new Map();   // 0 = 訪問中, 1 = 完了
  const visit = (name, stack) => {
    const s = state.get(name);
    if (s === 1) return;
    if (s === 0) throw new Error(`循環参照: ${[...stack, name].join(' → ')}`);
    state.set(name, 0);
    for (const d of cache.get(name).deps) visit(d, [...stack, name]);
    state.set(name, 1);
    order.push(name);
  };
  visit(entry, []);
  return order;
}

// --- 依存グラフを構築 -------------------------------------------------------
loadModule(ENTRY);
const order = topoSort(ENTRY);

// import されている名前が実際に export されているかを検証
for (const name of order) {
  const mod = cache.get(name);
  for (const dep of mod.deps) {
    const target = cache.get(dep);
    const re = new RegExp(`const \\{ ([^}]*) \\} = __M\\['${dep.replace('.', '\\.')}'\\]`, 'g');
    let m;
    while ((m = re.exec(mod.body))) {
      for (const b of m[1].split(',')) {
        const id = b.split(':')[0].trim();
        if (id && !target.exports.includes(id)) {
          throw new Error(`${name} が ${dep} から未 export の "${id}" を import しています`);
        }
      }
    }
  }
}

// --- スクリプト本体を生成 ---------------------------------------------------
const parts = [];
parts.push(`/* WebSculpt — 単一ファイルビルド（自動生成: build.mjs / 編集しないでください） */`);
parts.push(`(function () {`);
parts.push(`'use strict';`);
parts.push(`const __M = Object.create(null);`);
for (const name of order) {
  const mod = cache.get(name);
  const ret = mod.exports.length
    ? `  return { ${mod.exports.join(', ')} };`
    : `  return {};`;
  parts.push(``);
  parts.push(`/* ===== ${name} ===== */`);
  parts.push(`__M['${name}'] = (function () {`);
  parts.push(mod.body.trimEnd());
  parts.push(ret);
  parts.push(`})();`);
}
parts.push(`})();`);
const script = parts.join('\n');
let scriptWasm = script;

// --- 単一ファイル版では wasm を base64 で埋め込む ---------------------------
// fetch を使わずに済むので file:// からでも WASM 経路が有効になる。
{
  const wasmPath = join(ROOT, 'wasm', 'dynafield.wasm');
  let b64 = '';
  try {
    b64 = readFileSync(wasmPath).toString('base64');
  } catch {
    console.warn('  wasm/dynafield.wasm が無いので単一ファイル版は JS フォールバックになります');
  }
  if (b64) {
    const marker = "const WASM_B64 = '';";
    if (!script.includes(marker)) throw new Error('WASM_B64 のマーカーが見つかりません');
    scriptWasm = script.replace(marker, () => `const WASM_B64 = '${b64}';`);
    console.log(`  wasm を埋め込み: ${(b64.length / 1024).toFixed(0)} KB (base64)`);
  }
}

// --- HTML を組み立て -------------------------------------------------------
const css = readFileSync(join(ROOT, 'css', 'style.css'), 'utf8');
let html = readFileSync(join(ROOT, 'index.html'), 'utf8');

// 差し替えは必ず「関数の replacement」で行う。文字列で渡すと、埋め込む
// 生成コード側の $& / $` / $' / $1 が置換パターンとして解釈され、消したはずの
// タグや周辺の HTML が黙って混ざる。いまのソースには該当する並びが無いが、
// 気付きにくい壊れ方をするので形で防いでおく。
html = html.replace(
  /^[ \t]*<link rel="stylesheet"[^>]*>[ \t]*$/m,
  () => `<style>\n${css.trimEnd()}\n</style>`,
);
if (html.includes('<link rel="stylesheet"')) throw new Error('CSS の差し替えに失敗しました');

html = html.replace(
  /^[ \t]*<script type="module"[^>]*><\/script>[ \t]*$/m,
  () => `<script>\n${scriptWasm}\n</script>`,
);
// タグの形で見る。素の 'type="module"' で見ると、埋め込んだスクリプト側に
// この文字列（querySelector のセレクタ）があるだけで誤検出する。
if (/<script\s+type="module"/.test(html)) throw new Error('スクリプトの差し替えに失敗しました');

// file:// でも動く単一ファイルであることを明記
html = html.replace(
  /^<!DOCTYPE html>$/m,
  `<!DOCTYPE html>\n<!-- WebSculpt 単一ファイル版 — このファイルをブラウザで開くだけで動きます（サーバ不要）。\n     ソースは js/ 以下のモジュール版。編集後に \`node build.mjs\` で再生成します。 -->`,
);

// 単一ファイル版では file:// を弾くガードが邪魔になるので無効化する
const guard = `  if (location.protocol === 'file:') {`;
if (!script.includes(guard.trim())) throw new Error('file:// ガードが見つかりません');
html = html.replace(
  /  if \(location\.protocol === 'file:'\) \{[\s\S]*?\n  \}\n/,
  `  // （単一ファイル版では file:// でも動くためガードは不要）\n`,
);

writeFileSync(join(ROOT, 'websculpt.html'), html, 'utf8');

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`websculpt.html を生成しました  ${kb} KB`);
console.log(`  モジュール順: ${order.join(' → ')}`);
