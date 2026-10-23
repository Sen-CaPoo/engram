// 開發期的介面檢查工具：用無頭 Edge（Chrome DevTools Protocol）開啟頁面、執行操作、截圖，並收集主控台錯誤。
//   node shot.mjs <plan.json> <輸出資料夾>
// plan.json：[{ "name": "inbox-conflict", "url": "file:///…#/inbox", "width": 1440, "height": 1000,
//              "scheme": "light"|"dark", "steps": ["document.querySelector('…').click()"], "wait": 800, "full": false }]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [planPath, outDir] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'engram-shot-'));
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break; } catch { /* 等瀏覽器啟動 */ }
  await sleep(200);
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') problems.push(`例外：${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) problems.push(`console.${msg.params.type}：${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log：${msg.params.entry.text}`);
});
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
const results = [];
for (const s of plan) {
  problems.length = 0;
  const values = [];
  await send('Emulation.setDeviceMetricsOverride', { width: s.width || 1440, height: s.height || 1000, deviceScaleFactor: 1, mobile: (s.width || 1440) < 600 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.scheme || 'light' }] });
  await send('Page.navigate', { url: s.url });
  await sleep(s.loadWait || 1200);
  await send('Page.reload', { ignoreCache: false });
  await sleep(s.loadWait || 1200);
  for (const js of s.steps || []) {
    const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) problems.push(`步驟失敗：${js.slice(0, 80)} → ${r.result.exceptionDetails.exception?.description}`);
    else if (r.result?.result?.value !== undefined) values.push(r.result.result.value);
    await sleep(s.stepWait || 500);
  }
  await sleep(s.wait || 400);
  const probe = await send('Runtime.evaluate', { expression: `JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.documentElement.scrollHeight })`, returnByValue: true });
  const dims = JSON.parse(probe.result.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!s.full, ...(s.full ? { clip: { x: 0, y: 0, width: s.width || 1440, height: Math.min(dims.h, 4000), scale: 1 } } : {}) });
  writeFileSync(join(outDir, `${s.name}.png`), Buffer.from(shot.result.data, 'base64'));
  results.push({ name: s.name, horizontalOverflow: dims.sw > dims.cw, problems: [...problems], ...(values.length ? { values } : {}) });
}
console.log(JSON.stringify(results, null, 2));
ws.close();
browser.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge 可能還鎖著暫存資料夾 */ }
