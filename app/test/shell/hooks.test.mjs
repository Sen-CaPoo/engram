// hooks：輸出格式、1500 字元上限、ENGRAM_HEADLESS、常駐程式的啟動與通知、旗標檔、InstructionsLoaded 記錄格式。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileKind } from '../../src/hooks/loaded.mjs';
import { normalizeEvent, readStdinJson, runHook } from '../../src/hooks/index.mjs';
import { clip, CONTEXT_LIMIT } from '../../src/hooks/session.mjs';
import { createFakeEngine } from './fake-engine.mjs';
import { mkTmp, rmTmp, stdinFrom, useHomes } from './helpers.mjs';

let root;
let paths;
before(() => {
  root = mkTmp();
  paths = useHomes(root);
});
after(() => rmTmp(root));
beforeEach(() => {
  delete process.env.ENGRAM_HEADLESS;
  fs.rmSync(paths.local, { recursive: true, force: true });
});

const SELF = fileURLToPath(import.meta.url);
const NOW = Date.parse('2026-10-22T09:00:00.000Z');
const fresh = (over = {}) => ({ pid: 4242, port: 4777, token: 'tok', beatAt: new Date(NOW - 10_000).toISOString(), lastSyncAt: new Date(NOW - 60_000).toISOString(), ...over });

/** 組出 hook 依賴：假引擎、記錄 spawn 與對常駐程式的請求 */
function deps({ eg = createFakeEngine({ home: paths.home }), heartbeat = null, agentStatus = 200 } = {}) {
  const spawned = [];
  const requests = [];
  return {
    eg,
    spawned,
    requests,
    overrides: {
      paths,
      now: () => NOW,
      loadEngine: async () => eg,
      readHeartbeat: () => heartbeat,
      spawnNode: (args) => spawned.push(args),
      requestAgent: async (hb, method, p, body) => {
        requests.push({ method, path: p, body });
        return agentStatus ? { status: agentStatus, body: { started: true } } : null;
      },
    },
  };
}

const startInput = { session_id: 's-1', transcript_path: path.join('C:', 'x', 's-1.jsonl'), cwd: path.join('C:', 'proj'), hook_event_name: 'SessionStart', source: 'startup' };

describe('SessionStart', () => {
  test('輸出 hookSpecificOutput.additionalContext（JSON 格式正確）', async () => {
    const d = deps({ heartbeat: fresh() });
    const out = await runHook('session-start', startInput, d.overrides);
    const json = JSON.parse(out);
    assert.deepEqual(Object.keys(json), ['hookSpecificOutput']);
    assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(json.hookSpecificOutput.additionalContext, d.eg.contextText);
    assert.deepEqual(d.eg.calls.find((c) => c.name === 'sessionContext').args[0], {
      cwd: startInput.cwd, event: 'startup', transcriptPath: startInput.transcript_path, sessionId: 's-1',
    });
  });

  test('additionalContext 截到 1500 字元', async () => {
    const d = deps({ heartbeat: fresh() });
    d.eg.contextText = '記'.repeat(4000);
    const ctx = JSON.parse(await runHook('session-start', startInput, d.overrides)).hookSpecificOutput.additionalContext;
    assert.equal(ctx.length, CONTEXT_LIMIT);
    assert.ok(ctx.endsWith('…'));
  });

  test('截斷不切開代理對', () => {
    const s = `${'a'.repeat(1498)}😀😀`;
    const c = clip(s, 1500);
    assert.ok(c.length <= 1500);
    const beforeEllipsis = c.charCodeAt(c.length - 2);
    assert.ok(!(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff), '省略號前不能是落單的高位代理');
  });

  test('引擎回傳空字串時不輸出', async () => {
    const d = deps({ heartbeat: fresh() });
    d.eg.contextText = '';
    assert.equal(await runHook('session-start', startInput, d.overrides), null);
  });

  test('心跳過期 → 在背景啟動常駐程式，不送請求', async () => {
    const d = deps({ heartbeat: fresh({ beatAt: new Date(NOW - 91_000).toISOString() }) });
    await runHook('session-start', startInput, d.overrides);
    assert.equal(d.spawned.length, 1);
    assert.match(d.spawned[0][0], /engram\.mjs$/);
    assert.deepEqual(d.spawned[0].slice(1), ['agent']);
    assert.equal(d.requests.length, 0);
  });

  test('沒有心跳檔 → 啟動常駐程式', async () => {
    const d = deps({ heartbeat: null });
    await runHook('session-start', startInput, d.overrides);
    assert.equal(d.spawned.length, 1);
  });

  test('常駐程式在跑、超過 10 分鐘沒同步 → POST /api/sync', async () => {
    const d = deps({ heartbeat: fresh({ lastSyncAt: new Date(NOW - 11 * 60_000).toISOString() }) });
    await runHook('session-start', startInput, d.overrides);
    assert.equal(d.spawned.length, 0);
    assert.deepEqual(d.requests, [{ method: 'POST', path: '/api/sync', body: { reason: 'session-start' } }]);
  });

  test('常駐程式在跑、最近同步過 → 什麼都不做', async () => {
    const d = deps({ heartbeat: fresh() });
    await runHook('session-start', startInput, d.overrides);
    assert.equal(d.spawned.length + d.requests.length, 0);
  });

  test('引擎失敗：不輸出、寫日誌；連續失敗兩次後提醒', async () => {
    const d = deps({ heartbeat: fresh() });
    d.overrides.loadEngine = async () => { throw Object.assign(new Error('無法載入 Engram 引擎'), { code: 'E_ENGINE_MISSING' }); };
    assert.equal(await runHook('session-start', startInput, d.overrides), null);
    const logs = fs.readdirSync(paths.logs).filter((n) => /^hooks-\d{4}-\d{2}-\d{2}\.log$/.test(n));
    assert.equal(logs.length, 1);
    const line = JSON.parse(fs.readFileSync(path.join(paths.logs, logs[0]), 'utf8').trim().split('\n').pop());
    assert.deepEqual(Object.keys(line), ['at', 'level', 'src', 'msg']);
    assert.equal(line.level, 'error');
    assert.match(line.msg, /E_ENGINE_MISSING/);

    const second = JSON.parse(await runHook('session-start', startInput, d.overrides));
    assert.match(second.hookSpecificOutput.additionalContext, /連續失敗 2 次/);

    // 引擎恢復後：這一次附上提醒，之後歸零
    d.overrides.loadEngine = async () => d.eg;
    const ok = JSON.parse(await runHook('session-start', startInput, d.overrides)).hookSpecificOutput.additionalContext;
    assert.match(ok, /^\[Engram\]/);
    assert.match(ok, /連續失敗 2 次/);
    const again = JSON.parse(await runHook('session-start', startInput, d.overrides)).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(again, /連續失敗/);
  });
});

describe('ENGRAM_HEADLESS=1', () => {
  test('所有 hook 都不做事：不輸出、不寫檔、不啟動程序', async () => {
    process.env.ENGRAM_HEADLESS = '1';
    const d = deps({ heartbeat: null });
    for (const ev of ['session-start', 'stop', 'session-end', 'post-compact', 'instructions-loaded']) {
      assert.equal(await runHook(ev, { ...startInput, file_path: SELF }, d.overrides), null);
    }
    assert.equal(d.eg.calls.length, 0);
    assert.equal(d.spawned.length + d.requests.length, 0);
    assert.equal(fs.existsSync(paths.local), false);
  });
});

describe('Stop、SessionEnd、PostCompact', () => {
  test('Stop：以對話紀錄的編碼資料夾寫入旗標檔 local/dirty/<encoded>，不載入引擎（E17）', async () => {
    const d = deps();
    let loaded = 0;
    const overrides = { ...d.overrides, loadEngine: async () => { loaded++; throw new Error('Stop 不應載入引擎'); } };
    const transcript = path.join('C:', 'Users', 'Sen', '.claude', 'projects', 'C--Users-Sen-Desktop-Acme-Gateway', 's-1.jsonl');
    assert.equal(await runHook('Stop', { session_id: 's-1', cwd: startInput.cwd, transcript_path: transcript }, overrides), null);
    assert.equal(loaded, 0);
    const flag = JSON.parse(fs.readFileSync(path.join(paths.dirty, 'C--Users-Sen-Desktop-Acme-Gateway'), 'utf8'));
    assert.deepEqual(flag, { cwd: startInput.cwd, sessionId: 's-1', at: new Date(NOW).toISOString() });
  });

  test('SessionEnd：常駐程式在跑 → 通知同步（附 sessionId），不 spawn', async () => {
    const d = deps({ heartbeat: fresh() });
    await runHook('session-end', { session_id: 's-1', reason: 'prompt_input_exit' }, d.overrides);
    assert.deepEqual(d.requests, [{ method: 'POST', path: '/api/sync', body: { reason: 'session-end', sessionId: 's-1' } }]);
    assert.equal(d.spawned.length, 0);
  });

  test('SessionEnd：常駐程式不在或沒回應 → spawn engram sync --local --debounce 30s', async () => {
    for (const d of [deps({ heartbeat: null }), deps({ heartbeat: fresh(), agentStatus: 0 })]) {
      await runHook('session-end', { session_id: 's-1' }, d.overrides);
      assert.equal(d.spawned.length, 1);
      assert.deepEqual(d.spawned[0].slice(1), ['sync', '--local', '--debounce', '30s', '--quiet']);
    }
  });

  test('PostCompact 不輸出（2.1.306 不支援 PostCompact 的 additionalContext）', async () => {
    const d = deps({ heartbeat: fresh() });
    assert.equal(await runHook('PostCompact', { trigger: 'auto' }, d.overrides), null);
  });

  test('事件名稱兩種寫法都接受；不認得的事件安靜略過', async () => {
    assert.equal(normalizeEvent('InstructionsLoaded'), 'instructions-loaded');
    assert.equal(normalizeEvent('session-end'), 'session-end');
    assert.equal(await runHook('Notification', {}, deps().overrides), null);
  });
});

describe('InstructionsLoaded', () => {
  test('kind 對應', () => {
    assert.equal(fileKind({ file_path: 'C:\\Users\\Sen\\.claude\\CLAUDE.md', memory_type: 'User' }), 'user');
    assert.equal(fileKind({ file_path: 'C:\\proj\\CLAUDE.md', memory_type: 'Project' }), 'project');
    assert.equal(fileKind({ file_path: 'C:\\proj\\CLAUDE.local.md', memory_type: 'Local' }), 'local');
    assert.equal(fileKind({ file_path: 'C:\\proj\\.claude\\rules\\style.md', memory_type: 'Project' }), 'rule');
    assert.equal(fileKind({ file_path: 'C:\\Users\\Sen\\.engram\\vault\\core\\CORE.md', memory_type: 'User', parent_file_path: 'C:\\Users\\Sen\\.claude\\CLAUDE.md' }), 'import');
    assert.equal(fileKind({ file_path: 'C:\\Users\\Sen\\.claude\\projects\\x\\memory\\MEMORY.md', memory_type: 'Project' }), 'memory-index');
  });

  test('附加到 local/loaded/<sessionId>.json，格式照 LoadedFiles', async () => {
    const d = deps();
    const dir = path.join(root, 'files');
    fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
    const a = path.join(dir, 'CLAUDE.md');
    const b = path.join(dir, 'rules', 'x.md');
    fs.writeFileSync(a, '第一行\n第二行\n');
    fs.writeFileSync(b, 'one\ntwo\nthree');
    await runHook('instructions-loaded', { session_id: 'sess-9', cwd: startInput.cwd, file_path: a, memory_type: 'User', load_reason: 'session_start' }, d.overrides);
    await runHook('instructions-loaded', { session_id: 'sess-9', cwd: startInput.cwd, file_path: b, memory_type: 'Project', load_reason: 'include', parent_file_path: a }, d.overrides);
    const rec = JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-9.json'), 'utf8'));
    assert.deepEqual(Object.keys(rec), ['sessionId', 'at', 'cwd', 'pid', 'files']);
    assert.equal(rec.sessionId, 'sess-9');
    assert.equal(rec.pid, 'acme-gateway-3fa9k');
    assert.equal(rec.at, new Date(NOW).toISOString());
    assert.deepEqual(rec.files[0], { path: a, kind: 'user', bytes: Buffer.byteLength('第一行\n第二行\n'), lines: 2, loadReason: 'session_start' });
    assert.deepEqual(rec.files[1], { path: b, kind: 'import', bytes: 13, lines: 3, loadReason: 'include', parent: a });
  });

  test('同一個對話同時觸發多次也不會遺失記錄', async () => {
    const d = deps();
    const files = Array.from({ length: 8 }, (_, i) => {
      const f = path.join(root, `c${i}.md`);
      fs.writeFileSync(f, `${i}\n`);
      return f;
    });
    await Promise.all(files.map((f) => runHook('instructions-loaded', { session_id: 'sess-par', cwd: startInput.cwd, file_path: f, memory_type: 'Project', load_reason: 'session_start' }, d.overrides)));
    const rec = JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-par.json'), 'utf8'));
    assert.equal(rec.files.length, 8);
  });

  test('回歸（2026-10-23）：SessionStart 補記專案的 MEMORY.md（Claude Code 載入它時不觸發 InstructionsLoaded）', async () => {
    const d = deps({ heartbeat: fresh() });
    const dir = path.join(root, 'mem');
    fs.mkdirSync(dir, { recursive: true });
    const index = path.join(dir, 'MEMORY.md');
    fs.writeFileSync(index, '- [a](a.md) — x\n- [b](b.md) — y\n');
    const claudeMd = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '規則\n');
    d.eg.sessionContext = async () => ({ text: 'ctx', binding: { pid: 'p-mem' }, warnings: [], memoryIndex: index });
    await runHook('instructions-loaded', { session_id: 'sess-mem', cwd: startInput.cwd, file_path: claudeMd, memory_type: 'User', load_reason: 'session_start' }, d.overrides);
    await runHook('session-start', { ...startInput, session_id: 'sess-mem' }, d.overrides);
    const rec = JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-mem.json'), 'utf8'));
    assert.deepEqual(rec.files.map((f) => f.kind), ['user', 'memory-index']);
    assert.deepEqual(rec.files[1], { path: index, kind: 'memory-index', bytes: Buffer.byteLength('- [a](a.md) — x\n- [b](b.md) — y\n'), lines: 2, loadReason: 'session_start' });

    // 壓縮後重新載入：同一筆更新，不重複
    await runHook('session-start', { ...startInput, session_id: 'sess-mem', source: 'compact' }, d.overrides);
    const again = JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-mem.json'), 'utf8'));
    assert.equal(again.files.filter((f) => f.kind === 'memory-index').length, 1);
    assert.equal(again.files.find((f) => f.kind === 'memory-index').loadReason, 'compact');
  });

  test('沒有 MEMORY.md 時 SessionStart 不建立記錄；pid 取自綁定', async () => {
    const d = deps({ heartbeat: fresh() });
    d.eg.sessionContext = async () => ({ text: 'ctx', binding: null, warnings: [], memoryIndex: null });
    await runHook('session-start', { ...startInput, session_id: 'sess-none' }, d.overrides);
    assert.equal(fs.existsSync(path.join(paths.loaded, 'sess-none.json')), false);

    const index = path.join(root, 'mem2', 'MEMORY.md');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, '- [a](a.md)\n');
    d.eg.sessionContext = async () => ({ text: 'ctx', binding: { pid: 'p-bound' }, warnings: [], memoryIndex: index });
    await runHook('session-start', { ...startInput, session_id: 'sess-pid' }, d.overrides);
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-pid.json'), 'utf8')).pid, 'p-bound');
  });

  test('SessionStart 先建立了沒有 pid 的記錄時，之後的 InstructionsLoaded 會補上 pid', async () => {
    const d = deps({ heartbeat: fresh() });
    const index = path.join(root, 'mem3', 'MEMORY.md');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, '- [a](a.md)\n');
    d.eg.sessionContext = async () => ({ text: 'ctx', binding: null, warnings: [], memoryIndex: index });
    await runHook('session-start', { ...startInput, session_id: 'sess-late' }, d.overrides);
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-late.json'), 'utf8')).pid, null);
    await runHook('instructions-loaded', { session_id: 'sess-late', cwd: startInput.cwd, file_path: SELF, memory_type: 'User', load_reason: 'session_start' }, d.overrides);
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-late.json'), 'utf8')).pid, 'acme-gateway-3fa9k');
  });

  test('超過載入上限的 MEMORY.md 只記實際載入的部分（前 200 行或 25KB）', async () => {
    const d = deps({ heartbeat: fresh() });
    const index = path.join(root, 'mem4', 'MEMORY.md');
    fs.mkdirSync(path.dirname(index), { recursive: true });
    const lines = Array.from({ length: 300 }, (_, i) => `- [m${i}](m${i}.md) — ${i}`);
    fs.writeFileSync(index, `${lines.join('\n')}\n`);
    d.eg.sessionContext = async () => ({ text: 'ctx', binding: null, warnings: [], memoryIndex: index });
    await runHook('session-start', { ...startInput, session_id: 'sess-big' }, d.overrides);
    const entry = JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-big.json'), 'utf8')).files[0];
    assert.equal(entry.lines, 200);
    assert.equal(entry.bytes, Buffer.byteLength(`${lines.slice(0, 200).join('\n')}\n`));

    const wide = path.join(root, 'mem5', 'MEMORY.md');
    fs.mkdirSync(path.dirname(wide), { recursive: true });
    fs.writeFileSync(wide, `${Array.from({ length: 50 }, (_, i) => `- [m${i}](m${i}.md) — ${'說明'.repeat(200)}`).join('\n')}\n`);
    d.eg.sessionContext = async () => ({ text: 'ctx', binding: null, warnings: [], memoryIndex: wide });
    await runHook('session-start', { ...startInput, session_id: 'sess-wide' }, d.overrides);
    const w = JSON.parse(fs.readFileSync(path.join(paths.loaded, 'sess-wide.json'), 'utf8')).files[0];
    assert.ok(w.bytes <= 25 * 1024 && w.lines < 50, `bytes=${w.bytes} lines=${w.lines}`);
  });

  test('sessionId 不能拿來穿越資料夾', async () => {
    const d = deps();
    await runHook('instructions-loaded', { session_id: '../../evil', cwd: startInput.cwd, file_path: SELF, memory_type: 'User' }, d.overrides);
    assert.equal(fs.readdirSync(paths.loaded).filter((n) => n.endsWith('.json')).length, 1);
    assert.equal(fs.existsSync(path.join(root, 'evil.json')), false);
    assert.equal(fs.existsSync(path.join(paths.home, 'evil.json')), false);
  });
});

describe('stdin', () => {
  test('讀取 JSON（含 BOM）；壞掉的 JSON 回傳空物件', async () => {
    assert.deepEqual(await readStdinJson(stdinFrom(`${String.fromCharCode(0xfeff)}{"a":1}`)), { a: 1 });
    assert.deepEqual(await readStdinJson(stdinFrom('{oops')), {});
    assert.deepEqual(await readStdinJson({ isTTY: true }), {});
  });
});
