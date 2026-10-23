// 管理介面建置：把 app/src/ui/src 打包成 app/src/ui/dist（commit 進 repo，使用者端不需要建置）。
//   node build.mjs           正式版 → app/src/ui/dist/
//   node build.mjs --watch   開發時持續建置
//   node build.mjs --demo    單檔展示版（內建展示資料，點兩下就能開）→ 專案根目錄 23_介面原型_展示版.html
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoData } from './demo-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../..');
const rootDir = resolve(appDir, '..');
const uiDir = join(appDir, 'src/ui');
const outDir = join(uiDir, 'dist');
const args = new Set(process.argv.slice(2));

const common = {
  entryPoints: [join(uiDir, 'src/main.jsx')],
  bundle: true,
  format: 'esm',
  target: ['chrome120', 'edge120'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
  nodePaths: [join(here, 'node_modules')], // 原始碼在 app/src/ui，相依套件只裝在這個建置工具資料夾
};

async function buildApp() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const opts = { ...common, outdir: outDir, entryNames: 'app', chunkNames: 'chunks/[name]-[hash]', splitting: true, minify: true, sourcemap: false, define: { __DEMO__: 'false' } };
  if (args.has('--watch')) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  } else {
    await esbuild.build(opts);
  }
  for (const f of ['index.html', 'manifest.webmanifest', 'icon.svg', 'sw.js']) cpSync(join(uiDir, 'public', f), join(outDir, f));
}

async function buildDemo() {
  const data = buildDemoData(rootDir);
  const res = await esbuild.build({
    ...common, write: false, outdir: 'demo-out', entryNames: 'app', minify: true,
    define: { __DEMO__: 'true', __DEMO_DATA__: JSON.stringify(data) },
  });
  const js = res.outputFiles.find((f) => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
  const css = res.outputFiles.find((f) => f.path.endsWith('.css')).text.replace(/<\/style/gi, '<\\/style');
  const icon = readFileSync(join(uiDir, 'public/icon.svg'), 'utf8');
  const html = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0072CE">
<title>Engram 憶跡 · 介面原型</title>
<!-- 展示版：由 app/tools/ui-build/build.mjs --demo 產生，資料來自 ${data ? data.generatedFrom : '內建範例'}。請勿手改。 -->
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script type="module">${js}</script>
</body>
</html>
`;
  const out = join(rootDir, '23_介面原型_展示版.html');
  writeFileSync(out, html);
  console.log(`展示版已輸出：${out}（${(html.length / 1024).toFixed(0)} KB，${data ? `${data.memories.length} 筆記憶、${data.projects.length} 個專案` : '內建範例資料'}）`);
}

if (args.has('--demo')) await buildDemo();
else await buildApp();
