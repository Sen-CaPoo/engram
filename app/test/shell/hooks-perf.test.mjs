// hook 冷啟動時間：以外掛的 hooks/run.mjs 實際啟動新的 node 程序（含讀 install.json、載入 hooks 與引擎）。
// 引擎換成假引擎：把 app 複製到暫存資料夾，core/index.mjs 改為匯出假引擎的 open()。量測值會印在測試輸出。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { mkTmp, rmTmp } from './helpers.mjs';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const RUN = path.join(APP, 'plugin', 'hooks', 'run.mjs');
const RUNS = 7;

let root;
let home;
let server;
let posts = 0;

function runHookProcess(event, input, env) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [RUN, event], { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, ms: performance.now() - t0 }));
    child.stdin.end(JSON.stringify(input));
  });
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};
const fmt = ({ min, median, max }) => `最小 ${min.toFixed(0)} ms · 中位數 ${median.toFixed(0)} ms · 最大 ${max.toFixed(0)} ms`;

before(async () => {
  root = mkTmp('engram-perf-');
  const copy = path.join(root, 'app');
  for (const rel of ['bin', 'src/cli', 'src/hooks', 'src/agent', 'package.json']) {
    fs.cpSync(path.join(APP, rel), path.join(copy, rel), { recursive: true });
  }
  fs.mkdirSync(path.join(copy, 'src', 'core'), { recursive: true });
  fs.copyFileSync(path.join(APP, 'test', 'shell', 'fake-engine.mjs'), path.join(copy, 'src', 'core', 'fake-engine.mjs'));
  fs.writeFileSync(path.join(copy, 'src', 'core', 'index.mjs'), "export { open } from './fake-engine.mjs';\n");

  home = path.join(root, '.engram');
  fs.mkdirSync(path.join(home, 'local'), { recursive: true });
  fs.writeFileSync(path.join(home, 'local', 'install.json'), JSON.stringify({ appDir: copy }));

  // 假的常駐程式：只回應 /api/sync
  server = http.createServer((req, res) => {
    if (req.url === '/api/sync') posts++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"started":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(() => {
  server.close();
  rmTmp(root);
});

function heartbeat(lastSyncAgoMs) {
  fs.writeFileSync(path.join(home, 'local', 'agent.json'), JSON.stringify({
    pid: 999_999, port: server.address().port, token: 'perf', startedAt: new Date().toISOString(),
    beatAt: new Date().toISOString(), version: '0.1.0', lastSyncAt: new Date(Date.now() - lastSyncAgoMs).toISOString(),
  }));
}

function env() {
  const e = { ...process.env, ENGRAM_HOME: home, CLAUDE_HOME: path.join(root, '.claude') };
  delete e.ENGRAM_HEADLESS;
  return e;
}

const input = { session_id: 'perf-1', transcript_path: path.join('C:', 'x', 'perf-1.jsonl'), cwd: APP, hook_event_name: 'SessionStart', source: 'startup' };

test('SessionStart 冷啟動（假引擎、常駐程式在跑、不需同步）', async (t) => {
  heartbeat(60_000);
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await runHookProcess('session-start', input, env());
    assert.equal(r.code, 0);
    const json = JSON.parse(r.out);
    assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(json.hookSpecificOutput.additionalContext, /^\[Engram\]/);
    times.push(r.ms);
  }
  const s = stats(times);
  t.diagnostic(`SessionStart 冷啟動（${RUNS} 次）：${fmt(s)}`);
  console.log(`[perf] SessionStart 冷啟動（${RUNS} 次）：${fmt(s)}`);
  assert.ok(s.median < 1000, `中位數 ${s.median} ms 過慢`);
});

test('SessionStart 冷啟動（超過 10 分鐘沒同步 → 通知常駐程式）', async (t) => {
  heartbeat(11 * 60_000);
  posts = 0;
  const times = [];
  for (let i = 0; i < RUNS; i++) times.push((await runHookProcess('session-start', input, env())).ms);
  assert.equal(posts, RUNS);
  const s = stats(times);
  t.diagnostic(`SessionStart＋POST /api/sync（${RUNS} 次）：${fmt(s)}`);
  console.log(`[perf] SessionStart＋POST /api/sync（${RUNS} 次）：${fmt(s)}`);
});

test('SessionEnd 冷啟動（通知常駐程式後返回）', async (t) => {
  heartbeat(60_000);
  posts = 0;
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await runHookProcess('session-end', { session_id: 'perf-1', reason: 'other' }, env());
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    times.push(r.ms);
  }
  assert.equal(posts, RUNS);
  const s = stats(times);
  t.diagnostic(`SessionEnd 冷啟動（${RUNS} 次）：${fmt(s)}`);
  console.log(`[perf] SessionEnd 冷啟動（${RUNS} 次）：${fmt(s)}`);
});

test('沒有安裝清單時 run.mjs 靜默結束（exit 0、無輸出）', async () => {
  const e = { ...env(), ENGRAM_HOME: path.join(root, 'not-installed') };
  const r = await runHookProcess('session-start', input, e);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});
