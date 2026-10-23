// 真引擎整合測試：在暫存資料夾初始化兩台電腦（bare repo 代替 GitHub），確認
// ① HTTP 回應與 status()、projects.list()、memories.list()、health() 完全一致；② CLI、合併器、背景綁定、
// 核心準則載入鏈、常駐程式啟動與單一實例；③ 用真引擎量測 hook 冷啟動時間。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createApi } from '../../src/agent/api.mjs';
import { createEventHub } from '../../src/agent/events.mjs';
import { startAgent } from '../../src/agent/index.mjs';
import { createAgentInfo } from '../../src/agent/info.mjs';
import { createJobs } from '../../src/agent/jobs.mjs';
import { createPendingBinder, pendingBindings } from '../../src/agent/pending.mjs';
import { createAgentServer } from '../../src/agent/server.mjs';
import { createLogger } from '../../src/cli/log.mjs';
import { main } from '../../src/cli/main.mjs';
import { BIN_PATH, localPaths } from '../../src/cli/paths.mjs';
import { init, open } from '../../src/core/index.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { addTranscript, ageTree, machinePaths, makeBareRemote, makeRepo } from '../core/helpers.mjs';
import { capture, mkTmp, request, rmTmp } from './helpers.mjs';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const TOKEN = 'integration-token';
const strip = (x) => JSON.parse(JSON.stringify(x));

let root; let mA; let mB; let A; let B; let proj;
let server; let port; let jobs; let events; let paths;

/** 依 engram agent 的做法：git 合併器把衝突放在該台電腦的 vault/conflicts */
async function syncAs(eg) {
  ageTree(eg.paths.vault);
  process.env.ENGRAM_CONFLICTS_DIR = path.join(eg.paths.vault, 'conflicts');
  try {
    return await eg.sync();
  } finally {
    delete process.env.ENGRAM_CONFLICTS_DIR;
  }
}

before(async () => {
  root = mkTmp('engram-int-');
  const remote = makeBareRemote(path.join(root, 'remote.git'));
  mA = machinePaths(root, 'office');
  mB = machinePaths(root, 'home');
  process.env.ENGRAM_HOME = mA.home;
  process.env.CLAUDE_HOME = mA.claudeHome;
  delete process.env.ENGRAM_HEADLESS;
  paths = localPaths();
  // cli 指向真正的 bin/engram.mjs：git 合併時會呼叫我們的 engram merge-driver
  await init({ ...mA, machineLabel: '公司電腦', userName: 'Tester', remote, cli: BIN_PATH });
  A = await open(mA);
  assert.equal((await syncAs(A)).ok, true);
  await init({ ...mB, machineLabel: '家裡電腦', remote, cli: BIN_PATH });
  B = await open(mB);
  assert.equal((await syncAs(B)).ok, true);
  await syncAs(A);

  await A.memories.create({ scope: { kind: 'global' }, name: 'answer-in-zh', type: 'feedback', description: '一律用正體中文回答', body: '回答使用正體中文。' });
  proj = makeRepo(path.join(mA.userHome, 'demo'), { remote: 'https://github.com/acme/demo.git' });
  await A.identity.bind(proj, { create: { name: 'Demo' } });
  await A.health();

  events = createEventHub();
  const log = createLogger(paths.logs, 'agent');
  jobs = createJobs({ eg: A, paths, events, log, notifier: { notify: async () => true }, runProbe: async () => null, detectVersion: async () => null });
  const info = createAgentInfo({ agent: { pid: process.pid, version: '0.1.0', startedAt: new Date().toISOString(), port: 0 }, jobs, schedulerStatus: async () => ({ installed: false }) });
  server = createAgentServer({ token: TOKEN, api: createApi({ eg: A, jobs, paths, info }), events, uiDir: path.join(root, 'no-dist') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  await jobs?.stop();
  events?.close();
  server?.close();
  rmTmp(root);
});

const get = (p) => request(port, { path: p, headers: { 'X-Engram-Token': TOKEN } });
const post = (p, body) => request(port, { method: 'POST', path: p, headers: { 'X-Engram-Token': TOKEN, 'Content-Type': 'application/json' }, body });

describe('HTTP 回應與引擎輸出完全一致', () => {
  test('GET /api/status ＝ status() ＋ agent', async () => {
    const r = await get('/api/status');
    assert.equal(r.status, 200);
    const { agent, tidy, ...rest } = r.json;
    assert.deepEqual(rest, strip(await A.status()));
    assert.deepEqual(tidy, { pending: 0, ready: 0, finishing: 0, total: 0 });
    assert.deepEqual(Object.keys(agent).sort(), ['paused', 'pausedAutomations', 'probe']);
    assert.equal(rest.devices.length, 2);
  });

  test('GET /api/projects ＝ projects.list()', async () => {
    const r = await get('/api/projects');
    assert.deepEqual(r.json, strip(await A.projects.list()));
    assert.equal(r.json[0].name, 'Demo');
  });

  test('GET /api/memories ＝ memories.list()；篩選範圍也一致', async () => {
    assert.deepEqual((await get('/api/memories')).json, strip(await A.memories.list()));
    assert.deepEqual((await get('/api/memories?scope=global')).json, strip(await A.memories.list({ scope: { kind: 'global' } })));
  });

  test('GET /api/findings ＝ health()', async () => {
    assert.deepEqual((await get('/api/findings')).json, strip(await A.health()));
  });

  test('POST /api/memory/pin 寫入 metadata.engram.pinned，記憶清單看得到', async () => {
    const r = await post('/api/memory/pin', { ref: 'global/answer-in-zh.md', pinned: true });
    assert.equal(r.json.ok, true);
    const text = fs.readFileSync(path.join(A.paths.vault, 'global', 'answer-in-zh.md'), 'utf8');
    assert.match(text, /metadata:[\s\S]*engram:\s*\n\s+pinned: true/);
    const list = (await get('/api/memories?scope=global')).json;
    assert.equal(list.find((m) => m.ref === 'global/answer-in-zh.md').pinned, true);
    await post('/api/memory/pin', { ref: 'global/answer-in-zh.md', pinned: false });
    assert.doesNotMatch(fs.readFileSync(path.join(A.paths.vault, 'global', 'answer-in-zh.md'), 'utf8'), /pinned/);
  });
});

describe('兩台電腦', () => {
  test('家裡電腦新增的記憶，經由常駐程式的同步工作出現在公司電腦', async () => {
    await B.memories.create({ scope: { kind: 'global' }, name: 'from-home', type: 'user', description: '家裡電腦寫的', body: '在家裡寫的記憶。' });
    await syncAs(B);
    ageTree(A.paths.vault);
    const res = await jobs.run('sync', 'manual');
    assert.equal(res.ok, true, res.note);
    const refs = (await get('/api/memories?scope=global')).json.map((m) => m.ref);
    assert.ok(refs.includes('global/from-home.md'));
  });

  test('兩邊同時改同一筆：git 呼叫 engram merge-driver，對方版本隔離到 vault/conflicts 並同步回來', async () => {
    await syncAs(B);
    const ref = 'global/answer-in-zh.md';
    const edit = (eg, body) => {
      const f = path.join(eg.paths.vault, 'global', 'answer-in-zh.md');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n[^\n]*\n?$/, `\n${body}\n`));
    };
    edit(A, '公司電腦的版本：回答使用正體中文，技術名詞保留原文。');
    edit(B, '家裡電腦的版本：一律正體中文，不要簡體。');
    await syncAs(A);
    const rb = await syncAs(B);
    assert.equal(rb.ok, true, JSON.stringify(rb.error));
    assert.equal(rb.conflicts.length, 1);
    const onB = fs.readFileSync(path.join(B.paths.vault, 'global', 'answer-in-zh.md'), 'utf8');
    assert.doesNotMatch(onB, /<<<<<<<|>>>>>>>/);
    assert.match(onB, /家裡電腦的版本/);
    await syncAs(A);
    const conflicts = (await get('/api/conflicts')).json;
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].ref, ref);
  });
});

describe('CLI 使用真引擎', () => {
  async function engram(argv, cwd = proj) {
    const out = capture();
    const err = capture();
    const code = await main(argv, { stdout: out.stream, stderr: err.stream, stdin: { isTTY: true }, cwd });
    return { code, out: out.text, err: err.text };
  }

  test('remember → search → status → sync --local', async () => {
    const r = await engram(['remember', '--scope', 'machine', '--name', 'office-proxy', '--type', 'reference', '--description', '公司代理設定', '--body', '代理設定在 IT 入口網站。']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `已記住：machines/${A.machine.id}/office-proxy.md（單機 ${A.machine.id}）`);
    const s = await engram(['search', '代理', '--json']);
    assert.ok(JSON.parse(s.out).some((h) => h.ref.endsWith('office-proxy.md')));
    const st = await engram(['status']);
    assert.equal(st.code, 0, st.err);
    assert.match(st.out, /公司電腦/);
    assert.match(st.out, /已綁定/);
    const sy = await engram(['sync', '--local']);
    assert.equal(sy.code, 0, sy.err);
    assert.match(sy.out, /已完成本機存檔/);
  });

  test('remember --scope project 依目前資料夾寫進綁定的專案', async () => {
    const r = await engram(['remember', '--scope', 'project', '--name', 'deploy-steps', '--type', 'project', '--description', '部署步驟', '--body', '先跑測試再部署。']);
    assert.equal(r.code, 0, r.err);
    const pid = (await A.identity.resolve(proj)).pid;
    assert.ok(fs.existsSync(path.join(A.paths.vault, 'projects', pid, 'memory', 'deploy-steps.md')));
  });

  test('merge-driver：無法合併時保留本機版本、隔離對方版本、exit 0', () => {
    const dir = path.join(root, 'md');
    fs.mkdirSync(dir, { recursive: true });
    const fm = '---\nname: x\ndescription: d\nmetadata:\n  type: user\n---\n';
    fs.writeFileSync(path.join(dir, 'O'), `${fm}原本\n`);
    fs.writeFileSync(path.join(dir, 'A'), `${fm}本機改的\n`);
    fs.writeFileSync(path.join(dir, 'B'), `${fm}對方改的\n`);
    const conf = path.join(dir, 'conflicts');
    const r = spawnSync(process.execPath, [BIN_PATH, 'merge-driver', path.join(dir, 'O'), path.join(dir, 'A'), path.join(dir, 'B'), 'global/x.md'], {
      env: { ...process.env, ENGRAM_CONFLICTS_DIR: conf }, windowsHide: true, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'A'), 'utf8'), `${fm}本機改的\n`);
    assert.equal(fs.readdirSync(conf).filter((n) => n.startsWith('cf_')).length, 1);
  });
});

describe('背景綁定與核心準則', () => {
  test('記憶資料夾有內容且對話進行中 → pending；對話結束 30 分鐘後由常駐程式切換成 junction', async () => {
    const dir = makeRepo(path.join(mA.userHome, 'legacy'), { remote: 'https://github.com/acme/legacy.git' });
    const enc = encodeProjectPath(dir);
    const mem = path.join(mA.claudeHome, 'projects', enc, 'memory');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, 'old-note.md'), '---\nname: old-note\ndescription: 舊記憶\nmetadata:\n  type: project\n---\n舊的內容。\n');
    const t = addTranscript(mA.claudeHome, dir, { ageMs: 60_000 });
    const res = await A.identity.bind(dir, { create: { name: 'Legacy' } });
    assert.equal(res.state, 'pending');
    assert.equal((await pendingBindings(A)).length, 1);

    const binder = createPendingBinder({ eg: A });
    assert.equal((await binder.run()).waiting[0].reason, 'active-session');
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(t.file, old, old);
    const r = await binder.run();
    assert.equal(r.done.length, 1, JSON.stringify(r));
    assert.equal(fs.lstatSync(mem).isSymbolicLink(), true);
    assert.equal((await pendingBindings(A)).length, 0);
    assert.ok(fs.existsSync(path.join(A.paths.vault, 'projects', res.pid, 'memory', 'old-note.md')));
  });

  test('GET /api/core：從 ~/.claude/CLAUDE.md 的管理區塊展開載入鏈', async () => {
    fs.mkdirSync(mA.claudeHome, { recursive: true });
    fs.writeFileSync(path.join(mA.claudeHome, 'CLAUDE.md'), `# 我的準則\n\n${await A.claudeMdBlock()}`);
    const r = await get('/api/core');
    assert.equal(r.status, 200);
    assert.equal(r.json.text, (await A.core.read()).text);
    const chain = r.json.chain.map((c) => [path.relative(mA.userHome, c.path).replace(/\\/g, '/'), c.kind, c.depth]);
    assert.deepEqual(chain.slice(0, 3), [
      ['.claude/CLAUDE.md', 'user', 0],
      ['.engram/vault/core/CORE.md', 'core', 1],
      ['.engram/vault/global/INDEX.md', 'index', 2],
    ]);
    assert.ok(chain.some(([p, kind, depth]) => p === `.engram/vault/machines/${A.machine.id}/INDEX.md` && kind === 'index' && depth === 1));
    assert.equal(r.json.chain[1].isSelf, true);
  });
});

describe('常駐程式', () => {
  test('啟動寫心跳（含 token）；第二個實例偵測到後退出；停止時刪除心跳', async () => {
    const opts = {
      port: 0, engine: A, paths, uiDir: path.join(root, 'no-dist'), handleSignals: false,
      schedulerStatus: async () => ({ installed: false }), notifier: { notify: async () => true },
      runProbe: async () => ({ at: new Date().toISOString(), claudeVersion: null, ok: true, checks: [] }), detectVersion: async () => null,
    };
    const agent = await startAgent(opts);
    try {
      const hb = JSON.parse(fs.readFileSync(paths.agentFile, 'utf8'));
      assert.deepEqual(Object.keys(hb).sort(), ['beatAt', 'lastSyncAt', 'pid', 'port', 'startedAt', 'token', 'version']);
      assert.equal(hb.port, agent.port);
      assert.match(hb.token, /^[A-Za-z0-9_-]{32}$/);
      const info = await request(agent.port, { path: '/api/agent', headers: { 'X-Engram-Token': hb.token } });
      assert.equal(info.status, 200);
      // 心跳的 pid 改成別的程序，模擬「另一個常駐程式正在執行」
      fs.writeFileSync(paths.agentFile, JSON.stringify({ ...hb, pid: hb.pid + 1 }));
      const second = await startAgent(opts);
      assert.ok(second.alreadyRunning);
      fs.writeFileSync(paths.agentFile, JSON.stringify(hb));
    } finally {
      await agent.stop();
    }
    assert.equal(fs.existsSync(paths.agentFile), false);
  });
});

describe('hook 冷啟動（真引擎）', () => {
  function runHook(event, input) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const env = { ...process.env, ENGRAM_HOME: mA.home, CLAUDE_HOME: mA.claudeHome };
      delete env.ENGRAM_HEADLESS;
      const child = spawn(process.execPath, [path.join(APP, 'plugin', 'hooks', 'run.mjs'), event], { env, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out, ms: performance.now() - t0 }));
      child.stdin.end(JSON.stringify(input));
    });
  }

  test('SessionStart：已綁定的專案，常駐程式在跑（不 spawn、不連網）', async (t) => {
    fs.writeFileSync(path.join(A.paths.local, 'install.json'), JSON.stringify({ appDir: APP }));
    // 心跳是新的、剛同步過：hook 不會啟動常駐程式，也不會送請求
    fs.writeFileSync(paths.agentFile, JSON.stringify({ pid: 999_999, port: 9, token: 'x', beatAt: new Date().toISOString(), lastSyncAt: new Date().toISOString() }));
    const tr = addTranscript(mA.claudeHome, proj, { ageMs: 0 });
    const input = { session_id: tr.sessionId, transcript_path: tr.file, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' };
    const times = [];
    let last;
    for (let i = 0; i < 5; i++) {
      last = await runHook('session-start', input);
      assert.equal(last.code, 0);
      times.push(last.ms);
    }
    const ctx = JSON.parse(last.out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /^\[Engram\] 公司電腦/);
    assert.match(ctx, /Demo/);
    assert.ok(ctx.length <= 1500);
    times.sort((a, b) => a - b);
    const msg = `SessionStart 冷啟動（真引擎，5 次）：最小 ${times[0].toFixed(0)} ms · 中位數 ${times[2].toFixed(0)} ms · 最大 ${times[4].toFixed(0)} ms`;
    t.diagnostic(msg);
    console.log(`[perf] ${msg}`);

    const stop = await runHook('stop', { session_id: tr.sessionId, cwd: proj, transcript_path: tr.file });
    assert.equal(stop.code, 0);
    assert.ok(fs.existsSync(path.join(paths.dirty, tr.enc)));
    fs.rmSync(paths.agentFile, { force: true });
  });
});
