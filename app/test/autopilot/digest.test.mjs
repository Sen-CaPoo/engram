// 每週摘要（2.0.0 WP9 Q8）：local/autopilot/digest/<週一日期>.json、GET /api/digest、eg.digest、engram autopilot digest。
// 自己的沙盒；git 歷史用調過時間的 commit 模擬上一週的內容。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { init, open } from '../../src/core/index.mjs';
import { createApi } from '../../src/agent/api.mjs';
import { createJobs } from '../../src/agent/jobs.mjs';
import { main } from '../../src/cli/main.mjs';
import { DIGEST_KEEP_WEEKS, parseWeek, weekOf } from '../../src/autopilot/digest.mjs';
import { updateMachineState, writeRun } from '../../src/autopilot/state.mjs';
import { machinePaths, mkTmp, rmTmp, writeDriverCli } from '../core/helpers.mjs';
import { capture } from '../shell/helpers.mjs';

const DAY = 86_400_000;
const FAKE_KEY = ['sk', 'ant', 'api03', 'Zq8Lm3Xv9Tn2Wb7Yc4Rd1Hf6Jg5Ks0PaEuIoQ'].join('-');
const KEYS = ['week', 'generatedAt', 'learned', 'graduated', 'graduation', 'holding', 'preferences', 'guardrails', 'recall', 'env', 'autopilot', 'previous'];

let root;
let eg;
const NOW = Date.now();
const WEEK = weekOf(NOW);
const R = parseWeek(WEEK);
const LAST = weekOf(R.start - DAY);
/** 這一週裡的時間（週一中午之後 h 小時，不超過現在） */
const inWeek = (h = 1) => Math.min(NOW - 1000, R.start + 12 * 3_600_000 + h * 3_600_000);
const vf = (ref) => path.join(eg.paths.vault, ...ref.split('/'));
/** 用指定的時間 commit（作者與提交時間都是那個時間） */
const commitAt = (ms, msg, files) => {
  const iso = new Date(ms).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-A', '--', ...files], { cwd: eg.paths.vault, env });
  execFileSync('git', ['-c', 'core.autocrlf=false', 'commit', '-q', '-m', msg], { cwd: eg.paths.vault, env });
};
const mem = (name, body, extra = '') => `---\nname: ${name}\ndescription: ${name} desc\nmetadata:\n  type: reference\n${extra}---\n\n${body}\n`;
const jsonl = (dir, rows) => {
  const d = path.join(eg.paths.local, 'usage', dir);
  fs.mkdirSync(d, { recursive: true });
  for (const r of rows) fs.appendFileSync(path.join(d, `${r.at.slice(0, 10)}.jsonl`), `${JSON.stringify(r)}\n`);
};

before(async () => {
  root = mkTmp();
  const m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: 'test-pc', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  // 這一週之前就有的兩筆（兩週前提交）
  for (const n of ['old-body', 'old-pin']) fs.writeFileSync(vf(`global/${n}.md`), mem(n, `${n} 原本的內文。`));
  commitAt(R.start - 14 * DAY, 'manual: old notes', ['global']);
});
after(() => rmTmp(root));

describe('週的日期', () => {
  test('weekOf：本地時間的週一；parseWeek：只接受真的週一，其餘（含路徑字元）一律不接受', () => {
    assert.equal(weekOf(new Date(2026, 10, 18, 12).getTime()), '2026-11-16');
    assert.equal(weekOf(new Date(2026, 10, 22, 23, 59).getTime()), '2026-11-16');
    assert.equal(weekOf(new Date(2026, 10, 23, 0, 0).getTime()), '2026-11-23');
    assert.equal(parseWeek('2026-11-16').end - parseWeek('2026-11-16').start, 7 * DAY);
    for (const bad of ['2026-11-17', '2026-13-02', '2026-02-30', '../../x', '2026-11-16/..', '', null, undefined]) assert.equal(parseWeek(bad), null, String(bad));
  });
});

describe('摘要的內容', () => {
  let heldIds = [];
  test('準備這一週的資料', async () => {
    // 新增、內文有改、只改 frontmatter（釘選）
    await eg.memories.create({ scope: { kind: 'global' }, name: 'new-note', type: 'feedback', description: '這週新增的', body: '這週新增的內容。\n\n**Why:** x\n**How to apply:** y' });
    await eg.memories.write('global/old-body.md', { body: 'old-body 改過的內文（2026-11-20）。' });
    await eg.memories.write('global/old-pin.md', { frontmatter: { 'metadata.engram.pinned': true } });
    // 保留區：一件核心事實有依據；另一件帶對話引句（摘要不能出現原文）
    heldIds = [
      (await eg.holding.add({ task: 'curate', kind: 'rejected', title: '保留的提案一', reason: 'x', why: '核心事實有依據', action: 'create', grounded: true, keep: ['重點'], ops: [{ op: 'create', scope: 'global', content: mem('held-one', 'b') }] })).id,
      (await eg.holding.add({ task: 'dream', kind: 'rejected', title: '保留的提案二', reason: 'x', why: 'y', action: 'create', ops: [{ op: 'create', scope: 'global', content: mem('held-two', 'b') }], evidence: [{ quote: '使用者在對話裡說的一句原話，不能出現在摘要裡', fromUser: true }] })).id,
    ];
    // 護欄與召回的命中紀錄：這一週的與上一週的
    const at = (ms) => new Date(ms).toISOString();
    jsonl('guardrails', [
      { at: at(inWeek(1)), session: 's1', rule: 'r1', kind: 'block' },
      { at: at(inWeek(2)), session: 's1', rule: 'r1', kind: 'block' },
      { at: at(inWeek(3)), session: 's1', rule: 'r2', kind: 'hint' },
      { at: at(inWeek(4)), session: 's1', rule: 'r1', kind: 'falseBlock' },
      { at: at(R.start - 2 * DAY), session: 's0', rule: 'r1', kind: 'block' },
    ]);
    jsonl('recall', [
      { at: at(inWeek(1)), session: 's1', ref: 'global/new-note.md', score: 1 },
      { at: at(inWeek(2)), session: 's1', ref: 'global/new-note.md', score: 1 },
      { at: at(inWeek(3)), session: 's2', ref: 'global/old-body.md', score: 1 },
      { at: at(R.start - DAY), session: 's0', ref: 'global/old-body.md', score: 1 },
    ]);
    fs.mkdirSync(path.join(eg.paths.local, 'usage'), { recursive: true });
    fs.writeFileSync(path.join(eg.paths.local, 'usage', 'reads.json'), JSON.stringify({ v: 1, refs: {}, seen: { [new Date(inWeek(1)).toISOString().slice(0, 10)]: ['s1\u0000global/new-note.md'] } }));
    // 自動駕駛的執行紀錄：這一週兩輪（其中一輪撞到用量上限）、上一週一輪
    const run = (id, ms, summary) => writeRun(eg.paths.local, { v: 1, id, startedAt: new Date(ms).toISOString(), endedAt: new Date(ms + 60_000).toISOString(), status: 'done', actions: [], rejected: [], skipped: [], notes: [], calls: [], summary });
    await run('ap-20260101-000001-aaaa', inWeek(1), { costUsd: 0.25, stopped: null });
    await run('ap-20260101-000002-bbbb', inWeek(2), { costUsd: 0.5, stopped: 'limit' });
    await run('ap-20260101-000004-dddd', inWeek(3), { costUsd: 0.25, stopped: 'busy' });
    await run('ap-20260101-000003-cccc', R.start - DAY, { costUsd: 9, stopped: 'auth' });
    // 畢業的項目（同步的狀態檔；標題夾帶疑似金鑰時要遮蔽）
    await updateMachineState(eg, (s) => { s.graduate = { at: new Date(inWeek(1)).toISOString(), seen: {}, items: [{ ref: 'global/old-body.md', title: `old-body ${FAKE_KEY}`, to: 'guardrail', at: new Date(inWeek(1)).toISOString() }, { ref: 'global/gone.md', title: 'gone', to: 'archive', at: new Date(R.start - DAY).toISOString() }] }; return s; });
    // 環境健檢的發現（快取）
    fs.mkdirSync(path.join(eg.paths.local, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(eg.paths.local, 'cache', 'env-findings.json'), JSON.stringify({ v: 1, at: new Date().toISOString(), findings: [{ id: 'H26:abc', code: 'H26', title: '同步執行的 hook 太慢', severity: 'medium' }] }));
  });

  test('這一週（還沒結束）：即時算出、格式和約定的一樣、不存檔；不帶週的是最近一份定稿（上一週）', async () => {
    const r0 = await eg.digest.refresh({ now: NOW }); // 記下環境發現第一次出現的時間；上一週（已經結束）定稿
    assert.deepEqual([r0.week, r0.created, r0.notified], [LAST, true, false]);
    assert.equal((await eg.digest.get(undefined, { now: NOW })).week, LAST, '最近一週：存下來的最新一份');
    const d = await eg.digest.get(WEEK, { now: NOW });
    assert.deepEqual(Object.keys(d).sort(), [...KEYS].sort());
    assert.equal(d.week, WEEK);
    assert.ok(d.learned.created.some((x) => x.ref === 'global/new-note.md' && x.title === 'new-note'), JSON.stringify(d.learned));
    assert.deepEqual(d.learned.updated.map((x) => x.ref), ['global/old-body.md'], '只改 frontmatter（釘選）的不算更新');
    assert.ok(!d.learned.created.some((x) => /old-/.test(x.ref)), '之前就有的不算新增');
    assert.deepEqual(d.graduated, [{ ref: 'global/old-body.md', title: d.graduated[0].title, to: 'guardrail' }]);
    assert.ok(!d.graduated[0].title.includes(FAKE_KEY), '標題遮蔽疑似金鑰');
    assert.deepEqual(d.holding, { held: 2, withCore: 1 });
    assert.deepEqual(d.guardrails, { blocked: 2, hinted: 1, falseBlocks: 1 });
    assert.deepEqual(d.recall, { surfaced: 3, opened: 1 });
    assert.deepEqual(d.env, { findings: [{ code: 'H26', title: '同步執行的 hook 太慢' }] });
    assert.equal(d.autopilot.runs, 3);
    assert.equal(d.autopilot.costUsd, 1);
    assert.deepEqual(d.autopilot.stopped.map((x) => x.reason), ['limit', 'busy'], 'Claude 暫時忙碌（busy）也記進去');
    assert.deepEqual(d.previous, [LAST]);
    // 上一週的資料（定稿）：只有上一週的命中與執行紀錄
    const p = await eg.digest.get(LAST, { now: NOW });
    assert.deepEqual([p.guardrails.blocked, p.recall.surfaced, p.autopilot.runs, p.autopilot.costUsd], [1, 1, 1, 9]);
    assert.deepEqual(p.autopilot.stopped.map((x) => x.reason), ['auth']);
    assert.deepEqual(p.graduated.map((x) => x.to), ['archive']);
    assert.deepEqual([p.learned.created.length, p.learned.updated.length], [0, 0]);
    const text = JSON.stringify(d);
    for (const s of ['不能出現在摘要裡', '保留的提案', FAKE_KEY]) assert.ok(!text.includes(s), s);
    assert.ok(!fs.existsSync(path.join(eg.paths.local, 'autopilot', 'digest', `${WEEK}.json`)), '這一週還沒結束：不存檔');
  });

  test('週結束之後：refresh 產生並存檔（定稿），自動駕駛開啟時通知一則；再呼叫不重複通知', async () => {
    await eg.settings.set({ autopilot: 'on' });
    const sent = [];
    const notifier = { notify: (n) => { sent.push(n); return true; } };
    const later = NOW + 7 * DAY;
    // 沒有通知器的呼叫（例如在終端機跑 engram autopilot run --wait）：產生摘要，但不把這一週記為通知過
    const silent = await eg.digest.refresh({ now: later });
    assert.deepEqual([silent.week, silent.created, silent.notified], [WEEK, true, false]);
    const r = await eg.digest.refresh({ notifier, now: later + 60_000 });
    assert.deepEqual([r.week, r.created, r.notified], [WEEK, false, true], '已經定稿；這次有通知器才通知');
    const file = path.join(eg.paths.local, 'autopilot', 'digest', `${WEEK}.json`);
    assert.ok(fs.existsSync(file));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].page, 'digest');
    assert.match(sent[0].body, /學到 2 件、保留區有 2 件待你看、護欄擋下 2 次/);
    const again = await eg.digest.refresh({ notifier, now: later + 3_600_000 });
    assert.deepEqual([again.created, again.notified], [false, false]);
    assert.equal(sent.length, 1, '每週一則');
    // 最近一週＝存下來的最新一份
    const d = await eg.digest.get(undefined, { now: later });
    assert.equal(d.week, WEEK);
    assert.equal(d.guardrails.blocked, 2);
    assert.deepEqual(await eg.digest.list(), [WEEK, LAST]);
  });

  test('自動駕駛關閉：照樣產生摘要，但不通知', async () => {
    await eg.settings.set({ autopilot: 'off' });
    const sent = [];
    const later = NOW + 14 * DAY;
    const r = await eg.digest.refresh({ notifier: { notify: (n) => sent.push(n) }, now: later });
    assert.equal(r.created, true);
    assert.equal(r.notified, false);
    assert.equal(sent.length, 0);
    const next = weekOf(NOW + 7 * DAY);
    const d = await eg.digest.get(next, { now: later });
    assert.equal(d.week, next);
    assert.deepEqual(d.previous, [WEEK, LAST], '更早有摘要的週');
  });

  test('週的參數：格式不對 → E_INVALID；更早而沒有摘要的 → E_NOT_FOUND；只保留最近 12 週', async () => {
    await assert.rejects(eg.digest.get('2026-11-17'), (err) => err.code === 'E_INVALID');
    await assert.rejects(eg.digest.get('../../etc'), (err) => err.code === 'E_INVALID');
    await assert.rejects(eg.digest.get('2020-01-06', { now: NOW }), (err) => err.code === 'E_NOT_FOUND');
    const dir = path.join(eg.paths.local, 'autopilot', 'digest');
    for (let i = 3; i < 3 + DIGEST_KEEP_WEEKS; i++) {
      const w = weekOf(R.start - i * 7 * DAY);
      fs.writeFileSync(path.join(dir, `${w}.json`), JSON.stringify({ week: w, generatedAt: new Date().toISOString() }));
    }
    await eg.digest.refresh({ now: NOW + 21 * DAY });
    const weeks = await eg.digest.list();
    assert.equal(weeks.length, DIGEST_KEEP_WEEKS);
    assert.equal(weeks[0], weekOf(NOW + 14 * DAY), '最新的留著');
  });

  test('GET /api/digest（?week=）與 engram autopilot digest（--json）', async () => {
    const api = createApi({ eg, jobs: { run() {}, toggle() {} }, paths: { local: eg.paths.local, vault: eg.paths.vault, home: eg.paths.home }, info: { statusSummary: () => ({}) } });
    const d = await api.handle('GET', '/api/digest', new URLSearchParams(`week=${WEEK}`), {});
    assert.equal(d.week, WEEK);
    assert.deepEqual(Object.keys(d).sort(), [...KEYS].sort());
    const latest = await api.handle('GET', '/api/digest', new URLSearchParams(), {});
    assert.ok(latest.week >= WEEK);
    const out = capture();
    const code = await main(['autopilot', 'digest', WEEK, '--json'], { loadEngine: async () => eg, stdout: out.stream, stderr: capture().stream, stdin: { isTTY: true }, cwd: root, env: {} });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.text).week, WEEK);
    const txt = capture();
    await main(['autopilot', 'digest', WEEK], { loadEngine: async () => eg, stdout: txt.stream, stderr: capture().stream, stdin: { isTTY: true }, cwd: root, env: {} });
    assert.match(txt.text, /每週摘要/);
    assert.match(txt.text, /護欄：擋下 2 次/);
  });

  test('cleanup holding', async () => { for (const id of heldIds) await eg.holding.dismiss(id).catch(() => {}); });
});

describe('常駐程式', () => {
  test('每天的健康檢查之後產生每週摘要（自動駕駛關閉時也一樣），帶通知器', async () => {
    const tmp = path.join(root, 'jobs-digest');
    fs.mkdirSync(tmp, { recursive: true });
    const calls = [];
    const fakeEg = { settings: { get: async () => ({ autopilot: 'off' }) }, status: async () => ({}), paths: { vault: tmp, claudeHome: tmp }, health: async () => [], digest: { refresh: async (o) => { calls.push(o); return {}; } } };
    const notifier = { notify() {} };
    const jobs = createJobs({
      eg: fakeEg, paths: { jobsFile: path.join(tmp, 'agent-jobs.json'), dirty: path.join(tmp, 'dirty'), vault: tmp },
      events: { emit() {} }, log: { info() {}, warn() {}, error() {}, debug() {} }, notifier,
      runProbe: async () => ({ checks: [] }), detectVersion: async () => null, isIdle: async () => true,
    });
    const r = await jobs.run('health', 'manual');
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].notifier, notifier);
    await jobs.stop();
  });
});
