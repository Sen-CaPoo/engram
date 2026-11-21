// P6 成效量測換口徑（2.0.0 WP6）：讀取統計除了直接打開，也計入 engram search 列出、情境召回帶出、護欄命中，
// 以及「帶出之後有沒有被打開」。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { localDate } from '../../src/core/usage.mjs';
import { main } from '../../src/cli/main.mjs';
import { machinePaths, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';
import { capture } from '../shell/helpers.mjs';

let root; let m; let eg;
const appendLines = (dir, day, rows) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${day}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
};

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: 'T', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
});
after(() => rmTmp(root));

test('同步摘要加上 recalled、searched、guarded 與帶出之後被打開的次數；eg.usage.get 一併回傳；沒有讀取紀錄的記憶也列', async () => {
  const g = (await eg.memories.create({ scope: { kind: 'global' }, name: 'pnpm-store', type: 'reference', description: 'pnpm 的快取位置', body: 'pnpm 的快取在 D:\\pnpm-store。' })).ref;
  const quiet = (await eg.memories.create({ scope: { kind: 'global' }, name: 'only-recalled', type: 'reference', description: '只被帶出過', body: 'x' })).ref;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  // 對話 s-open 打開了這筆記憶（直接讀取）；s-skip 沒有
  const dir = path.join(m.claudeHome, 'projects', encodeProjectPath(path.join(root, 'work', 'misc')));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's-open.jsonl'), `${JSON.stringify({ type: 'assistant', sessionId: 's-open', cwd: path.join(root, 'work', 'misc'), timestamp: iso(now - 60_000), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(eg.paths.vault, 'global', 'pnpm-store.md') } }] } })}\n`);
  // 情境召回帶出（WP4a 的紀錄：一行一筆 { at, session, ref, score }）
  appendLines(path.join(eg.paths.local, 'usage', 'recall'), localDate(now), [
    { at: iso(now - 120_000), session: 's-open', ref: g, score: 3.2 },
    { at: iso(now - 120_000), session: 's-skip', ref: g, score: 2.1 },
    { at: iso(now - 120_000), session: 's-skip', ref: quiet, score: 1.5 },
    { at: iso(now - 200 * 86_400_000), session: 's-old', ref: g, score: 1 },
    'not json',
  ]);
  // 護欄命中：規則的 source 是記憶的 ref 才算那筆記憶；內建規則不算任何記憶；誤擋、確認不算命中
  fs.mkdirSync(path.join(eg.paths.vault, 'guardrails'), { recursive: true });
  fs.writeFileSync(path.join(eg.paths.vault, 'guardrails', 'rules.json'), JSON.stringify({ v: 1, rules: [
    { id: 'pnpm-path', tool: 'Bash', pattern: 'npm\\s+cache', action: 'hint', message: '這台用 pnpm 的快取', source: g, addedAt: '2026-11-20', by: 'autopilot' },
    { id: 'pnpm-name', tool: 'Bash', pattern: 'yarn\\s+cache', action: 'hint', message: '這台用 pnpm', source: 'pnpm-store', addedAt: '2026-11-20', by: 'autopilot' },
    { id: 'builtin-like', tool: 'Bash', pattern: 'rm\\s+-rf', action: 'block', message: 'x', source: '內建規則', addedAt: '2026-11-20', by: 'engram' },
  ] }));
  appendLines(path.join(eg.paths.local, 'usage', 'guardrails'), iso(now).slice(0, 10), [
    { at: iso(now - 60_000), session: 's-open', rule: 'pnpm-path', kind: 'hint' },
    { at: iso(now - 50_000), session: 's-open', rule: 'pnpm-name', kind: 'block' },
    { at: iso(now - 40_000), session: 's-open', rule: 'pnpm-name', kind: 'falseBlock' },
    { at: iso(now - 30_000), session: 's-open', rule: 'builtin-like', kind: 'block' },
  ]);
  // engram search 列出這筆記憶
  const o = capture();
  const e = capture();
  const code = await main(['search', 'pnpm', '快取', '--json'], { loadEngine: async () => eg, stdout: o.stream, stderr: e.stream, stdin: { isTTY: true }, cwd: root, env: {}, spawnNode: () => {}, agentWaitMs: 50 });
  assert.equal(code, 0);
  assert.ok(JSON.parse(o.text).some((h) => h.ref === g));
  await eg.usage.refresh({ force: true });
  const summary = JSON.parse(fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'usage.json'), 'utf8'));
  assert.deepEqual([summary.refs[g].reads, summary.refs[g].recalled, summary.refs[g].recallOpened, summary.refs[g].searched, summary.refs[g].guarded], [1, 2, 1, 1, 2]);
  assert.deepEqual([summary.refs[quiet].reads, summary.refs[quiet].recalled], [0, 1], '沒有讀取紀錄、但被帶出過的也列');
  const u = await eg.usage.get(g);
  assert.deepEqual([u.reads, u.recalled, u.searched, u.guarded, u.recallOpened, u.openRate], [1, 2, 1, 2, 1, 0.5]);
  const t = await eg.usage.totals();
  assert.deepEqual([t.recalled, t.recallOpened, t.openRate], [3, 1, 0.333]);
});

test('舊資料沒有這些欄位時視為 0；沒有被帶出過的比例是 null', async () => {
  const f = path.join(eg.paths.vault, 'machines', eg.machine.id, 'usage.json');
  fs.writeFileSync(f, JSON.stringify({ v: 1, since: '2026-10-01', window: 90, refs: { 'global/pnpm-store.md': { reads: 4, days: 2, last: '2026-11-01', projects: {} } } }));
  const u = await eg.usage.get('global/pnpm-store.md');
  assert.deepEqual([u.reads, u.recalled, u.searched, u.guarded, u.recallOpened, u.openRate], [4, 0, 0, 0, 0, null]);
});
