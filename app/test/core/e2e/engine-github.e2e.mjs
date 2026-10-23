// 選用的網路端對端測試（引擎層，兩台模擬電腦透過 GitHub 私人 repo 同步）。
// 執行：node app/test/core/e2e/engine-github.e2e.mjs
// 紀錄：2026-10-22 以 commit 8c9f0e0 執行，通過，約 31 秒（claude-f4）。
//       2026-10-22 以 445935a＋本次修改執行，通過，約 29 秒。
// 端對端：兩台模擬電腦透過真正的 GitHub 私人 repo（Sen-CaPoo/engram-vault-dev）同步。
// 全部在暫存資料夾，記憶內容是合成的。用使用者既有的 git 認證（Git Credential Manager）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');
const { init, open } = await import(pathToFileURL(`${APP}/src/core/index.mjs`).href);
const REMOTE = 'https://github.com/Sen-CaPoo/engram-vault-dev.git';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-gh-')));
const drv = path.join(root, 'cli.mjs');
fs.writeFileSync(drv, `import { mergeDriver } from ${JSON.stringify(pathToFileURL(`${APP}/src/core/mergedriver.mjs`).href)};
const [c, b, o, t, p] = process.argv.slice(2); const r = await mergeDriver({ base: b, ours: o, theirs: t, path: p, conflictsDir: process.env.ENGRAM_CONFLICTS_DIR }); process.exit(r.exitCode ?? 0);`);
const mk = (n) => { const base = path.join(root, n); fs.mkdirSync(base, { recursive: true }); return { home: path.join(base, '.engram'), claudeHome: path.join(base, '.claude'), userHome: base }; };
const age = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === '.git') continue; const p = path.join(dir, e.name); if (e.isDirectory()) age(p); else { const t = new Date(Date.now() - 60_000); fs.utimesSync(p, t, t); } } };
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const mA = mk('office'); const mB = mk('home');
const a = await init({ ...mA, machineLabel: '公司電腦（測試）', remote: REMOTE, cli: drv });
log('A init', a.created ? '建立新 vault' : '從遠端 clone');
const A = await open(mA);
let r = await A.sync(); log('A sync', JSON.stringify({ ok: r.ok, state: r.state, pushed: r.pushed, err: r.error?.code }));
const b = await init({ ...mB, machineLabel: '家裡電腦（測試）', remote: REMOTE, cli: drv });
log('B init', b.created ? '建立新 vault' : '從遠端 clone');
const B = await open(mB);
r = await B.sync(); log('B sync', JSON.stringify({ ok: r.ok, state: r.state, pushed: r.pushed }));
await A.sync();

const stamp = new Date().toISOString();
await A.memories.create({ scope: { kind: 'global' }, name: `e2e-${Date.now()}`, type: 'reference', description: `端對端測試 ${stamp}`, body: '由公司電腦寫入。' });
age(A.paths.vault);
r = await A.sync(); log('A 寫入並同步', JSON.stringify({ ok: r.ok, pushed: r.pushed }));
r = await B.sync(); log('B 拉取', JSON.stringify({ ok: r.ok, pulled: r.pulled }));
const seen = (await B.memories.list({ scope: 'global' })).some((m) => m.description.includes(stamp));
log('B 看到公司電腦的記憶：', seen);
const st = await B.status();
log('B 裝置清單：', st.devices.map((d) => d.label).join('、'), '| 同步狀態：', st.sync.state);
console.log(JSON.stringify({ ok: seen && st.sync.state === 'ok', seconds: (Date.now() - t0) / 1000 }));
fs.rmSync(root, { recursive: true, force: true });
