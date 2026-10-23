// 管理介面 API：api.js 檔頭列出的每個端點都有實作，並在假引擎下回傳正確形狀、把參數正確轉給引擎。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createApi } from '../../src/agent/api.mjs';
import { createEventHub } from '../../src/agent/events.mjs';
import { createAgentInfo } from '../../src/agent/info.mjs';
import { createJobs } from '../../src/agent/jobs.mjs';
import { createAgentServer } from '../../src/agent/server.mjs';
import { createLogger } from '../../src/cli/log.mjs';
import { createFakeEngine } from './fake-engine.mjs';
import { mkTmp, request, rmTmp, useHomes } from './helpers.mjs';

const TOKEN = 'api-test-token';
const API_JS = fileURLToPath(new URL('../../src/ui/src/api.js', import.meta.url));

let root;
let paths;
let eg;
let api;
let jobs;
let events;
let server;
let port;

before(async () => {
  root = mkTmp();
  paths = useHomes(root);
  eg = createFakeEngine({ home: paths.home, claudeHome: process.env.CLAUDE_HOME });
  events = createEventHub();
  const log = createLogger(paths.logs, 'agent');
  jobs = createJobs({
    eg, paths, events, log,
    notifier: { notify: async () => true },
    runProbe: async () => ({ at: new Date().toISOString(), claudeVersion: '2.1.306', ok: true, checks: [] }),
    detectVersion: async () => '2.1.306',
  });
  const info = createAgentInfo({
    agent: { pid: process.pid, version: '0.1.0', startedAt: new Date().toISOString(), port: 4777 },
    jobs,
    schedulerStatus: async () => ({ installed: true, state: 'running', launcher: 'wscript', lastRunAt: null, lastResult: 0 }),
  });
  api = createApi({ eg, jobs, paths, info });
  server = createAgentServer({ token: TOKEN, api, events, uiDir: path.join(root, 'no-dist') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  log.warn('test', '一則警告');
  log.info('test', '一則資訊');
});
after(async () => {
  await jobs.stop();
  events.close();
  server.close();
  rmTmp(root);
});

function call(method, p, body) {
  const headers = { 'X-Engram-Token': TOKEN, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) };
  return request(port, { method, path: p, headers, body });
}
const lastCall = (name) => [...eg.calls].reverse().find((c) => c.name === name);
const keys = (o) => Object.keys(o).sort();
const ACTION = ['commit', 'ok', 'undo'];

test('api.js 檔頭列出的端點全部有實作', () => {
  const header = fs.readFileSync(API_JS, 'utf8').split('\n').filter((l) => /^\/\/\s+(GET|POST|PUT)\s+\/api\//.test(l));
  const listed = header.map((l) => {
    const [, method, p] = /^\/\/\s+(GET|POST|PUT)\s+(\/api\/[^\s?]+)/.exec(l);
    return `${method} ${p}`;
  });
  assert.ok(listed.length >= 30, `只解析到 ${listed.length} 個端點`);
  for (const r of listed) assert.ok(api.routes.includes(r), `缺少 ${r}`);
});

describe('狀態與記憶', () => {
  test('GET /api/status → StatusReport ＋ agent { paused, probe: { ok, failed[] } }', async () => {
    const r = await call('GET', '/api/status');
    assert.equal(r.status, 200);
    assert.deepEqual(keys(r.json), ['agent', 'counts', 'devices', 'inbox', 'machine', 'sync', 'vault']);
    assert.equal(r.json.agent.paused, false);
    assert.deepEqual(r.json.agent.probe, { ok: null, failed: [] });
  });

  test('GET /api/activity?days=7', async () => {
    const r = await call('GET', '/api/activity?days=7');
    assert.deepEqual(keys(r.json[0]), ['added', 'changed', 'date', 'removed']);
    assert.deepEqual(lastCall('activity').args[0], { days: 7 });
  });

  test('GET /api/memories：範圍字串轉成 Scope 物件', async () => {
    const r = await call('GET', '/api/memories?scope=project:acme-gateway-3fa9k&type=feedback&q=bom&sort=name');
    assert.deepEqual(keys(r.json[0]), ['description', 'findings', 'indexed', 'name', 'pinned', 'ref', 'scope', 'size', 'tags', 'type', 'updatedAt']);
    assert.deepEqual(lastCall('memories.list').args[0], { scope: { kind: 'project', pid: 'acme-gateway-3fa9k' }, type: 'feedback', q: 'bom', sort: 'name' });
    await call('GET', '/api/memories');
    assert.deepEqual(lastCall('memories.list').args[0], {});
  });

  test('GET /api/memory?ref= → Memory；缺 ref → 400；不存在 → 404', async () => {
    const r = await call('GET', '/api/memory?ref=global/powershell-bom.md');
    assert.deepEqual(keys(r.json), ['body', 'frontmatter', 'path', 'raw', 'ref', 'scope', 'updatedAt']);
    assert.equal((await call('GET', '/api/memory')).status, 400);
    const nf = await call('GET', '/api/memory?ref=global/none.md');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error.code, 'E_NOT_FOUND');
  });

  test('PUT /api/memory、move、merge、remove、restore → ActionResult', async () => {
    const ref = 'global/powershell-bom.md';
    let r = await call('PUT', `/api/memory?ref=${encodeURIComponent(ref)}`, { frontmatter: { description: '新說明' }, body: '新內文' });
    assert.deepEqual(keys(r.json), ACTION);
    assert.deepEqual(lastCall('memories.write').args, [ref, { frontmatter: { description: '新說明' }, body: '新內文', allowSecrets: false }]);
    // 使用者在介面確認「不是金鑰」才帶 allowSecrets（只接受 true，其他值一律當成沒有確認）
    await call('PUT', `/api/memory?ref=${encodeURIComponent(ref)}`, { raw: '內文', allowSecrets: true });
    assert.equal(lastCall('memories.write').args[1].allowSecrets, true);
    await call('PUT', `/api/memory?ref=${encodeURIComponent(ref)}`, { raw: '內文', allowSecrets: 'yes' });
    assert.equal(lastCall('memories.write').args[1].allowSecrets, false);
    r = await call('POST', '/api/memory/move', { ref, scope: 'machine:office-7k2q' });
    assert.deepEqual(keys(r.json), ACTION);
    assert.deepEqual(lastCall('memories.move').args, [ref, { kind: 'machine', mid: 'office-7k2q' }]);
    r = await call('POST', '/api/memory/move', { ref, scope: { kind: 'global' } });
    assert.deepEqual(lastCall('memories.move').args[1], { kind: 'global' });
    r = await call('POST', '/api/memory/merge', { refs: [ref, 'global/b.md'], into: ref, body: '合併' });
    assert.deepEqual(lastCall('memories.merge').args, [[ref, 'global/b.md'], { into: ref, body: '合併' }]);
    r = await call('POST', '/api/memory/remove', { ref });
    assert.deepEqual(keys(r.json), ACTION);
    r = await call('POST', '/api/memory/restore', { ref, rev: 'a1b2c3d' });
    assert.deepEqual(lastCall('memories.restore').args, [ref, { rev: 'a1b2c3d' }]);
    assert.equal((await call('POST', '/api/memory/move', { ref, scope: 'planet' })).status, 400);
  });

  test('POST /api/memory/pin：只改 metadata.engram.pinned；取消時移除該鍵', async () => {
    const ref = 'global/powershell-bom.md';
    let r = await call('POST', '/api/memory/pin', { ref, pinned: true });
    assert.deepEqual(keys(r.json), ACTION);
    assert.deepEqual(lastCall('memories.write').args, [ref, { frontmatter: { 'metadata.engram.pinned': true } }]);
    await call('POST', '/api/memory/pin', { ref, pinned: false });
    const fm = lastCall('memories.write').args[1].frontmatter;
    assert.ok('metadata.engram.pinned' in fm);
    assert.equal(fm['metadata.engram.pinned'], undefined);
    r = await call('POST', '/api/memory/pin', { ref: 'global/none.md', pinned: true });
    assert.equal(r.status, 404);
  });

  test('GET /api/search → Hit[]', async () => {
    const r = await call('GET', '/api/search?q=bom&limit=5');
    assert.deepEqual(keys(r.json[0]), ['description', 'name', 'ref', 'scope', 'score', 'snippet']);
    assert.deepEqual(lastCall('search').args, ['bom', { limit: 5 }]);
  });
});

describe('專案、綁定、健康檢查、衝突、歷史', () => {
  test('GET /api/projects → Project[]', async () => {
    const r = await call('GET', '/api/projects');
    assert.deepEqual(keys(r.json[0]), ['aliases', 'archived', 'counts', 'index', 'lastActivityAt', 'name', 'paths', 'pid', 'remotes']);
  });

  test('POST /api/projects/rename、link', async () => {
    assert.deepEqual(keys((await call('POST', '/api/projects/rename', { pid: 'p1', name: '新名稱' })).json), ACTION);
    assert.deepEqual(lastCall('projects.rename').args, ['p1', '新名稱']);
    await call('POST', '/api/projects/link', { from: 'p1', to: 'p2' });
    assert.deepEqual(lastCall('projects.link').args, ['p1', 'p2']);
    assert.equal((await call('POST', '/api/projects/link', { from: 'p1' })).status, 400);
  });

  test('POST /api/identity/bind（pid／create）與 unbind', async () => {
    let r = await call('POST', '/api/identity/bind', { dir: 'C:\\proj', pid: 'p1' });
    assert.equal(r.json.pid, 'p1');
    assert.deepEqual(lastCall('identity.bind').args.slice(0, 2), ['C:\\proj', { pid: 'p1' }]);
    r = await call('POST', '/api/identity/bind', { dir: 'C:\\proj', create: { name: '王品集團' } });
    assert.deepEqual(lastCall('identity.bind').args[1], { create: { name: '王品集團' } });
    r = await call('POST', '/api/identity/unbind', { dir: 'C:\\proj' });
    assert.equal(r.json.ok, true);
  });

  test('GET /api/findings → Finding[]；POST /api/apply 原樣轉回 needsUi', async () => {
    const f = await call('GET', '/api/findings');
    assert.deepEqual(keys(f.json[0]), ['code', 'detail', 'fix', 'id', 'pid', 'refs', 'severity', 'title']);
    const a = await call('POST', '/api/apply', { fix: { action: 'merge', args: { refs: ['x'] } } });
    assert.deepEqual(a.json, { ok: false, needsUi: true, action: 'merge', args: { refs: ['x'] } });
    const n = await call('POST', '/api/apply', { fix: { action: 'normalize', args: {} } });
    assert.deepEqual(keys(n.json), ACTION);
  });

  test('衝突、歷史與復原', async () => {
    const c = await call('GET', '/api/conflicts');
    assert.deepEqual(keys(c.json[0]), ['base', 'createdAt', 'id', 'kind', 'ours', 'ref', 'summary', 'theirs']);
    await call('POST', '/api/conflicts/resolve', { id: 'cf_1', choice: 'theirs' });
    assert.deepEqual(lastCall('conflicts.resolve').args, ['cf_1', { choice: 'theirs', body: undefined }]);
    const h = await call('GET', '/api/history?ref=global/powershell-bom.md&limit=5');
    assert.deepEqual(keys(h.json[0]), ['action', 'at', 'machine', 'message', 'refs', 'sha', 'undoable']);
    assert.deepEqual(lastCall('history').args[0], { ref: 'global/powershell-bom.md', limit: 5 });
    const u = await call('POST', '/api/undo', { sha: 'a1b2c3d' });
    assert.deepEqual(keys(u.json), ACTION);
  });
});

describe('核心準則', () => {
  test('GET /api/core：文字、行數、位元組與載入鏈（只展開管理區塊，最多 4 層）', async () => {
    const claudeHome = process.env.CLAUDE_HOME;
    const vault = paths.vault;
    const write = (f, t) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t);
    };
    write(path.join(claudeHome, 'CLAUDE.md'), [
      '# 我的準則',
      '@./personal-not-engram.md',
      '<!-- engram:begin · 由 Engram 管理 -->',
      '@~/.engram/vault/core/CORE.md',
      '@~/.engram/vault/machines/office-7k2q/INDEX.md',
      '<!-- engram:end -->',
      '',
    ].join('\n'));
    write(path.join(vault, 'core', 'CORE.md'), '# 核心準則\n寄信給 a@b.com\n```\n@not/imported.md\n```\n`@also/not.md`\n@../global/INDEX.md\n@rules/style.md\n');
    write(path.join(vault, 'global', 'INDEX.md'), '- [x](x.md)\n@deep1.md\n');
    write(path.join(vault, 'global', 'deep1.md'), '@deep2.md\n');
    write(path.join(vault, 'global', 'deep2.md'), '@deep3.md\n');
    write(path.join(vault, 'global', 'deep3.md'), 'end\n');
    write(path.join(vault, 'core', 'rules', 'style.md'), '規則\n');
    write(path.join(vault, 'machines', 'office-7k2q', 'INDEX.md'), '- 單機\n');

    const r = await call('GET', '/api/core');
    assert.equal(r.status, 200);
    assert.equal(r.json.text, '# 核心準則\n\n@../global/INDEX.md\n');
    assert.equal(r.json.lines, 3);
    assert.equal(r.json.bytes, Buffer.byteLength(r.json.text));
    const chain = r.json.chain.map((c) => [path.relative(root, c.path).replace(/\\/g, '/'), c.kind, c.depth]);
    assert.deepEqual(chain, [
      ['.claude/CLAUDE.md', 'user', 0],
      ['.engram/vault/core/CORE.md', 'core', 1],
      ['.engram/vault/global/INDEX.md', 'index', 2],
      ['.engram/vault/global/deep1.md', 'import', 3],
      ['.engram/vault/global/deep2.md', 'import', 4],
      ['.engram/vault/core/rules/style.md', 'rule', 2],
      ['.engram/vault/machines/office-7k2q/INDEX.md', 'index', 1],
    ]);
    const core = r.json.chain.find((c) => c.kind === 'core');
    assert.equal(core.isSelf, true);
    assert.equal(core.lines, 8);
    assert.equal(core.bytes, fs.statSync(path.join(vault, 'core', 'CORE.md')).size);
    assert.ok(r.json.chain.every((c) => ['path', 'kind', 'lines', 'bytes', 'depth'].every((k) => k in c)));
  });

  test('PUT /api/core', async () => {
    assert.deepEqual(keys((await call('PUT', '/api/core', { text: '# 新\n' })).json), ACTION);
    assert.deepEqual(lastCall('core.write').args, ['# 新\n']);
    assert.equal((await call('PUT', '/api/core', {})).status, 400);
  });
});

describe('常駐程式、工作、日誌、載入記錄', () => {
  test('POST /api/sync → { started: true }，並在背景執行同步', async () => {
    const r = await call('POST', '/api/sync');
    assert.deepEqual(r.json, { started: true });
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(lastCall('sync').args[0], { network: true });
  });

  test('GET /api/loaded：沒有記錄時 null；有時回傳最新一筆', async () => {
    assert.equal((await call('GET', '/api/loaded?session=latest')).json, null);
    fs.mkdirSync(paths.loaded, { recursive: true });
    const rec = (id) => ({ sessionId: id, at: new Date().toISOString(), cwd: 'C:\\proj', pid: 'p1', files: [{ path: 'C:\\x.md', kind: 'user', bytes: 1, lines: 1, loadReason: 'session_start' }] });
    fs.writeFileSync(path.join(paths.loaded, 'old.json'), JSON.stringify(rec('old')));
    const t = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(paths.loaded, 'old.json'), t, t);
    fs.writeFileSync(path.join(paths.loaded, 'new.json'), JSON.stringify(rec('new')));
    const latest = await call('GET', '/api/loaded?session=latest');
    assert.equal(latest.json.sessionId, 'new');
    assert.deepEqual(keys(latest.json), ['at', 'cwd', 'files', 'pid', 'sessionId']);
    assert.equal((await call('GET', '/api/loaded?session=old')).json.sessionId, 'old');
  });

  test('GET /api/agent → AgentInfo', async () => {
    const r = await call('GET', '/api/agent');
    assert.deepEqual(keys(r.json), ['claudeVersion', 'jobs', 'logonTask', 'pausedAutomations', 'paused', 'pid', 'port', 'probe', 'startedAt', 'version'].sort());
    assert.deepEqual(keys(r.json.logonTask), ['installed', 'lastResult', 'lastRunAt', 'launcher', 'state']);
    assert.deepEqual(r.json.jobs.map((j) => j.id), ['sync', 'watch', 'health', 'probe', 'bind', 'rename', 'curate']);
    for (const j of r.json.jobs) assert.deepEqual(keys(j), ['enabled', 'id', 'label', 'lastResult', 'lastRunAt', 'nextRunAt', 'running', 'schedule']);
  });

  test('POST /api/jobs/run 與 /api/jobs/toggle（啟用狀態寫入 agent-jobs.json）', async () => {
    assert.deepEqual((await call('POST', '/api/jobs/run', { id: 'health' })).json, { started: true });
    assert.equal((await call('POST', '/api/jobs/run', { id: 'nope' })).status, 404);
    const r = await call('POST', '/api/jobs/toggle', { id: 'curate', enabled: true });
    assert.equal(r.json.jobs.find((j) => j.id === 'curate').enabled, true);
    await jobs.flush();
    const saved = JSON.parse(fs.readFileSync(paths.jobsFile, 'utf8'));
    assert.equal(saved.jobs.curate.enabled, true);
  });

  test('GET /api/logs?level=warn → 只含 warn 以上，每筆 { at, level, src, msg }', async () => {
    const r = await call('GET', '/api/logs?level=warn&limit=50');
    assert.ok(r.json.length >= 1);
    for (const e of r.json) {
      assert.deepEqual(keys(e), ['at', 'level', 'msg', 'src']);
      assert.ok(['warn', 'error'].includes(e.level));
    }
    const all = await call('GET', '/api/logs?limit=1');
    assert.equal(all.json.length, 1);
  });

  test('匯入：plan 交給 app/src/migrate；還原找不到紀錄 → 404', async () => {
    const plan = await call('POST', '/api/import/plan', {});
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    assert.equal(plan.json.applied, false);
    const undo = await call('POST', '/api/import/undo', { tag: 'engram-import-none' });
    assert.equal(undo.status, 404);
    assert.equal((await call('POST', '/api/import/undo', {})).status, 400);
  });

  test('不存在的端點 → 404', async () => {
    assert.equal((await call('GET', '/api/nope')).status, 404);
  });
});

describe('審查修正後新增的端點', () => {
  test('PUT /api/memory { raw } → 以原始碼模式寫入整份檔案', async () => {
    const r = await call('PUT', '/api/memory?ref=global/powershell-bom.md', { raw: '---\nname: x\n---\n內文\n' });
    assert.equal(r.status, 200);
    assert.deepEqual(lastCall('memories.write').args[1], { text: '---\nname: x\n---\n內文\n', allowSecrets: false });
  });

  test('POST /api/findings/dismiss：忽略或延後', async () => {
    const r = await call('POST', '/api/findings/dismiss', { id: 'f1', until: '2026-10-29T00:00:00.000Z' });
    assert.equal(r.status, 200);
    assert.deepEqual(lastCall('findings.dismiss').args, ['f1', { until: '2026-10-29T00:00:00.000Z' }]);
  });

  test('金鑰：預覽、遮蔽、標記不是金鑰', async () => {
    const p = await call('GET', '/api/secrets/preview?ref=projects/x/memory/a.md');
    assert.deepEqual(keys(p.json), ['after', 'before', 'matches']);
    assert.equal((await call('POST', '/api/secrets/redact', { ref: 'projects/x/memory/a.md' })).status, 200);
    await call('POST', '/api/secrets/allow', { ref: 'projects/x/memory/a.md', line: 3 });
    assert.deepEqual(lastCall('secrets.allow').args, ['projects/x/memory/a.md', 3]);
  });

  test('工作準則：預覽、同步、改回', async () => {
    const g = await call('GET', '/api/core/guidelines');
    assert.equal(g.json.coreLine, '@rules/user-guidelines.md');
    assert.equal((await call('POST', '/api/core/guidelines/adopt', {})).status, 200);
    assert.equal((await call('POST', '/api/core/guidelines/revert', {})).status, 200);
  });

  test('GET /api/collisions、POST /api/collisions/undo（SW-4）；引擎不支援時回 501', async () => {
    const plan = [{ path: 'C:/Users/x/Desktop/甲方報告', encoded: 'C--Users-x-Desktop-----', others: [], binding: null, to: 'C:/Users/x/Desktop/甲方報告-k3fz', blocked: null }];
    const history = [{ id: 'rn-1', at: '2026-10-22T00:00:00.000Z', items: [], retired: [] }];
    const eg2 = { ...eg, collisions: { plan: async () => plan, list: async () => history, undo: async (id) => ({ ok: true, id, restored: [] }) } };
    const api2 = createApi({ eg: eg2, jobs, paths, info: { statusSummary: () => ({}) } });
    assert.deepEqual(await api2.handle('GET', '/api/collisions', new URLSearchParams(), {}), { plan, history });
    const u = await api2.handle('POST', '/api/collisions/undo', new URLSearchParams(), { id: 'rn-1' });
    assert.equal(u.ok, true);
    const api3 = createApi({ eg: { ...eg, collisions: undefined }, jobs, paths, info: { statusSummary: () => ({}) } });
    await assert.rejects(api3.handle('GET', '/api/collisions', new URLSearchParams(), {}), (err) => err.status === 501);
  });

  test('GET／PUT /api/settings：本機設定由常駐程式保存，名稱與自動綁定交給引擎', async () => {
    const { createSettings } = await import('../../src/agent/settings.mjs');
    const settings = createSettings(paths);
    const api2 = createApi({ eg, jobs, paths, info: { statusSummary: () => ({}) }, settings });
    const got = await api2.handle('GET', '/api/settings', new URLSearchParams(), {});
    assert.deepEqual(keys(got), ['bindAuto', 'collisionRename', 'healthTime', 'machineLabel', 'paused', 'remote', 'syncIntervalMin']);
    const put = await api2.handle('PUT', '/api/settings', new URLSearchParams(), { syncIntervalMin: 15, healthTime: '08:45', paused: true, machineLabel: '家裡電腦', bindAuto: 'ask' });
    assert.equal(put.syncIntervalMin, 15);
    assert.equal(put.healthTime, '08:45');
    assert.equal(put.paused, true);
    assert.deepEqual(lastCall('machine.rename').args, ['家裡電腦']);
    assert.deepEqual(lastCall('settings.set').args, [{ bindAuto: 'ask' }]);
    await api2.handle('PUT', '/api/settings', new URLSearchParams(), { collisionRename: 'ask' });
    assert.deepEqual(lastCall('settings.set').args, [{ collisionRename: 'ask' }]);
    const pausedFile = JSON.parse(fs.readFileSync(path.join(paths.local, 'paused.json'), 'utf8'));
    assert.deepEqual(pausedFile, { user: true, junction: true, normalize: true });
    await assert.rejects(() => api2.handle('PUT', '/api/settings', new URLSearchParams(), { syncIntervalMin: 7 }), /5、10、15 或 30/);
  });
});
