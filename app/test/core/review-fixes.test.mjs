// 1.4.0 獨立審查後的修正：verify 只存日期、確認紀錄只新增不改寫、一鍵動作不會把沒看過的內容確認掉、
// 起點不洗掉別台的待確認、讀取統計的容錯與混合版本、新記憶留在索引、對話回顧的 skipped／重複／撤銷／接續。
// 全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { renderScopeIndex } from '../../src/core/normalize.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { baselineRefs, reviewKey } from '../../src/core/review.mjs';
import { loadUsage, readsForScope } from '../../src/core/usage.mjs';
import { createFromPlan, resolveSkipped } from '../../src/tidy/plan.mjs';
import { applyRecord } from '../../src/tidy/apply.mjs';
import { markReady, setDecisions } from '../../src/tidy/store.mjs';
import { machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const DAY = 86_400_000;
let root;
let m;
let eg;
let repo;
let pid;
let n = 0;

const vaultFile = (ref) => path.join(eg.paths.vault, ...ref.split('/'));
const raw = (ref) => fs.readFileSync(vaultFile(ref), 'utf8');
const rev = (ref) => crypto.createHash('sha1').update(raw(ref), 'utf8').digest('hex').slice(0, 10);
const pendingRefs = async () => (await eg.review.list()).map((x) => x.ref);

function plan(obj, files = {}) {
  const dir = path.join(root, 'plans', `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(obj));
  return path.join(dir, 'plan.json');
}

async function acceptAll(rec) {
  await setDecisions(eg.paths.local, rec.id, Object.fromEntries(rec.items.map((it) => [it.id, { decision: 'accept' }])));
  await markReady(eg.paths.local, rec.id);
  return applyRecord(eg, rec.id);
}

const transcriptDir = () => path.join(m.claudeHome, 'projects', encodeProjectPath(repo));
function writeTranscript(sessionId, records, { ageMs }) {
  fs.mkdirSync(transcriptDir(), { recursive: true });
  const file = path.join(transcriptDir(), `${sessionId}.jsonl`);
  const base = Date.now() - ageMs;
  fs.writeFileSync(file, `${records.map((r, i) => JSON.stringify({ cwd: repo, sessionId, timestamp: new Date(base + i * 1000).toISOString(), ...r })).join('\n')}\n`);
  const t = new Date(base + records.length * 1000);
  fs.utimesSync(file, t, t);
  return file;
}
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const readTool = (file) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `r${++n}`, name: 'Read', input: { file_path: file } }] } });

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '家裡電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  repo = makeRepo(path.join(root, 'work', 'shop'));
  pid = (await eg.identity.bind(repo, { create: { name: '商店' } })).pid;
  await eg.review.baseline();
});
after(() => rmTmp(root));

describe('verify（確認仍正確）', () => {
  test('只存日期（證據最新的那天）、不存內容；不能和改寫同一項；執行時用當下內容，沒確認過的維持待確認', async () => {
    const g = (await eg.memories.create({ scope: { kind: 'global' }, name: 'claude-fact', type: 'reference', description: 'Claude 寫的', body: '事實。' })).ref;
    await assert.rejects(createFromPlan(eg, plan(
      { scope: 'global', summary: 's', items: [{ ref: g, action: 'update', title: 't', reason: 'r', ops: [{ op: 'write', ref: g, base: rev(g), file: 'g.md' }, { op: 'verify', ref: g }] }] },
      { 'g.md': raw(g).replace('事實。', '事實（改）。') },
    )), /verify 只能用在/);
    const rec = await createFromPlan(eg, plan({ scope: 'global', summary: 's', items: [{ ref: g, action: 'verify', title: 't', reason: 'r', evidence: [{ date: '2026-10-01', quote: 'a' }, { date: '2026-10-20', quote: 'b' }], ops: [{ op: 'verify', ref: g, base: rev(g) }] }] }));
    assert.deepEqual(rec.items[0].ops[0], { op: 'verify', ref: g, base: rev(g), date: '2026-10-20' }, '沒有 content');
    const r = await acceptAll(rec);
    assert.equal(r.record.items[0].result.status, 'done');
    assert.match(raw(g), /verified: ['"]?2026-10-20/);
    assert.match(raw(g), /事實。/);
    assert.ok((await pendingRefs()).includes(g), 'Claude 寫的全域記憶沒有因為 verify 被確認掉');
    await eg.memories.remove(g);
  });

  test('疑似含金鑰的記憶不能 verify；已經記過同一天（或更新）的不必再記', async () => {
    const leaky = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'leaky', type: 'reference', description: '含權杖', body: `token: ${['gh', 'p_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('')}`, allowSecrets: false }).catch(() => null))?.ref;
    if (leaky) {
      await assert.rejects(createFromPlan(eg, plan({ scope: `project:${pid}`, summary: 's', items: [{ ref: leaky, action: 'verify', title: 't', reason: 'r', ops: [{ op: 'verify', ref: leaky, base: rev(leaky) }] }] })), /疑似含有金鑰/);
      fs.rmSync(vaultFile(leaky));
    }
    const p = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'checked', type: 'project', description: 'd', body: 'b' })).ref;
    await eg.memories.write(p, { frontmatter: { 'metadata.engram.verified': '2026-11-05' } });
    await assert.rejects(createFromPlan(eg, plan({ scope: `project:${pid}`, summary: 's', items: [{ ref: p, action: 'verify', title: 't', reason: 'r', ops: [{ op: 'verify', ref: p, base: rev(p), date: '2026-11-01' }] }] })), /已經記過 2026-11-05/);
    await eg.memories.remove(p);
  });
});

describe('確認紀錄', () => {
  test('只新增不改寫：同一筆記憶確認兩次後，單獨復原較早那次也不衝突；退回要帶目前的版本、退回最近一次確認的版本', async () => {
    const a = (await eg.memories.create({ scope: { kind: 'global' }, name: 'twice', type: 'feedback', description: 'A', body: 'line1\n\nline2\n\nline3\n\nline4\n\nline5\n', reviewed: true })).ref;
    const r1 = await eg.memories.write(a, { text: raw(a).replace('line1', 'LINE1'), reviewed: true });
    await eg.memories.write(a, { text: raw(a).replace('line5', 'LINE5'), reviewed: true });
    await eg.undo(r1.undo.sha);
    assert.match(raw(a), /line1[\s\S]*LINE5/);
    await eg.memories.write(a, { body: 'Claude 改的\n' });
    const item = (await eg.review.list()).find((x) => x.ref === a);
    await assert.rejects(eg.review.revert(a, '0'.repeat(40)), /檢視之後又被修改/);
    await eg.review.revert(a, item.sha);
    // 復原後的組合（line1＋LINE5）沒人確認過；退回的是最近一次確認的版本（LINE1＋LINE5），不是更早的
    assert.match(raw(a), /LINE1[\s\S]*LINE5/);
    await eg.memories.remove(a);
  });

  test('釘選與收件匣（CLI）的一鍵搬移不會把沒看過的內容確認掉；--reviewed 在內容沒變時也會補記', async () => {
    const g = (await eg.memories.create({ scope: { kind: 'global' }, name: 'pin-me', type: 'feedback', description: 'p', body: 'x' })).ref;
    await eg.memories.write(g, { frontmatter: { 'metadata.engram.pinned': true }, carryReviewed: true });
    assert.ok((await pendingRefs()).includes(g), '釘選不會確認 Claude 寫的內容');
    await eg.memories.write(g, { text: raw(g), reviewed: true });
    assert.ok(!(await pendingRefs()).includes(g), '內容沒變、帶 reviewed：補記確認');
    const p = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'to-global', type: 'feedback', description: 'q', body: 'y' })).ref;
    const moved = await eg.apply({ action: 'move', args: { ref: p, scope: { kind: 'global' } } });
    assert.ok((await pendingRefs()).includes(moved.ref), '搬進全域後要確認');
    await eg.memories.remove(g);
    await eg.memories.remove(moved.ref);
  });

  test('起點：其他電腦已經有確認紀錄時，只處理這台的單機記憶（不把別台的待確認洗掉）', async () => {
    const dir = path.join(eg.paths.vault, 'machines', 'other-pc');
    fs.mkdirSync(path.join(dir, 'reviewed'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviewed', `${reviewKey('global/x.md')}-${'a'.repeat(12)}.json`), JSON.stringify({ ref: 'global/x.md', sha: 'a'.repeat(40), at: '2026-11-01T00:00:00Z' }));
    const refs = await baselineRefs({ vault: eg.paths.vault, mid: eg.machine.id });
    assert.ok(refs.length >= 0 && refs.every((x) => x.startsWith(`machines/${eg.machine.id}/`)));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('讀取統計與索引', () => {
  test('別台的摘要格式壞掉不影響寫入；有電腦還沒升級到 1.4.0 時不用統計挑索引', async () => {
    const bad = path.join(eg.paths.vault, 'machines', 'old-pc');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'usage.json'), JSON.stringify({ v: 1, since: '2026-01-01', refs: { 'global/a.md': null, 'global/b.md': 'x' } }));
    fs.writeFileSync(path.join(bad, 'machine.json'), JSON.stringify({ label: '舊版', engramVersion: '1.3.0-51caefb' }));
    await loadUsage(eg.paths.vault);
    const r = await eg.memories.create({ scope: { kind: 'global' }, name: 'still-writes', type: 'reference', description: 'd', body: 'b' });
    assert.ok(r.ref);
    assert.equal(await readsForScope(eg.paths.vault, 'global'), undefined);
    // 30 天以上沒開的舊電腦（已經不用了）不會改寫索引，不必等它升級
    fs.writeFileSync(path.join(bad, 'machine.json'), JSON.stringify({ label: '舊版', engramVersion: '1.3.0-51caefb', lastSeenAt: new Date(Date.now() - 45 * DAY).toISOString() }));
    assert.equal(typeof (await readsForScope(eg.paths.vault, 'global')), 'function', '退役的電腦不擋');
    fs.writeFileSync(path.join(bad, 'machine.json'), JSON.stringify({ label: '舊版', engramVersion: '1.3.0-51caefb', lastSeenAt: new Date(Date.now() - 2 * DAY).toISOString() }));
    assert.equal(await readsForScope(eg.paths.vault, 'global'), undefined, '最近還在用的舊版電腦要等它升級');
    fs.rmSync(bad, { recursive: true, force: true });
    assert.equal(typeof (await readsForScope(eg.paths.vault, 'global')), 'function', '都升級後才用統計');
    await eg.memories.remove(r.ref);
  });

  test('不存在的檔名、萬用字元不算讀取', async () => {
    writeTranscript('ghost', [readTool(path.join(eg.paths.vault, 'global', 'does-not-exist.md')), readTool(path.join(eg.paths.vault, 'global', '*.md'))], { ageMs: 60_000 });
    await eg.usage.refresh({ commit: false });
    const reads = JSON.parse(fs.readFileSync(path.join(eg.paths.local, 'usage', 'reads.json'), 'utf8'));
    assert.deepEqual(Object.keys(reads.refs).filter((r) => /does-not-exist|\*/.test(r)), []);
    fs.rmSync(path.join(transcriptDir(), 'ghost.jsonl'));
  });

  test('索引放不下時，近 14 天新增或修改的記憶優先留下（新記憶還沒人讀過）', async () => {
    const dir = path.join(root, 'idx');
    fs.mkdirSync(dir, { recursive: true });
    const files = { old1: '2026-01-01T00:00:00.000Z', old2: '2026-01-02T00:00:00.000Z', old3: '2026-01-03T00:00:00.000Z', newbie: new Date().toISOString(), old4: '2026-01-04T00:00:00.000Z' };
    for (const [k, mod] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${k}.md`), `---\nname: ${k}\ndescription: ${k}\nmetadata:\n  type: reference\n  modified: ${mod}\n---\n${k}\n`);
    const reads = (f) => ({ 'old1.md': 9, 'old2.md': 8, 'old3.md': 7, 'newbie.md': 0, 'old4.md': 6 }[f]);
    const text = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 8, reads });
    assert.deepEqual([...text.matchAll(/^- \[(\w+)\]/gm)].map((x) => x[1]), ['newbie', 'old1']);
  });
});

describe('對話回顧', () => {
  test('沒分析到的不記為已回顧、全部沒分析到要擋；引句對照；只處理這個專案；同一個回顧只能一份記錄；撤銷；接續的對話只看新的部分；完成後刪掉匯出的文字', async () => {
    const mem = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'ci-notes', type: 'project', description: 'CI', body: 'CI 尚未設定。' })).ref;
    writeTranscript('rv-a', [user('CI 設好了，用 GitHub Actions'), said('好')], { ageMs: 3 * DAY });
    writeTranscript('rv-b', [user('另一個對話'), said('嗯')], { ageMs: 2 * DAY });
    const run = await eg.dream.prepare({ pid });
    assert.deepEqual(run.sessions.map((s) => s.sid), ['rv-a', 'rv-b']);
    assert.match(resolveSkipped(['rv-a', 'rv-b'], run).errs.join(), /所有對話都沒分析到/);
    const item = { ref: mem, action: 'verify', title: 't', reason: 'r', evidence: [{ date: '2026-11-01', quote: 'CI 設好了，用 GitHub   Actions' }, { quote: '編造的引句' }], ops: [{ op: 'verify', ref: mem, base: rev(mem) }] };
    await assert.rejects(createFromPlan(eg, plan({ scope: `project:${pid}`, dream: run.id, summary: 's', items: [{ ref: 'core/CORE.md', action: 'update', title: 't', reason: 'r', ops: [{ op: 'core', base: 'x', file: 'c.md' }] }] }, { 'c.md': '# x\n' })), /不改核心準則/);
    const rec = await createFromPlan(eg, plan({ scope: `project:${pid}`, dream: run.id, summary: 's', skipped: ['rv-b'], items: [item] }));
    assert.equal(rec.items[0].evidence[0].unmatched, undefined, '空白不同也對得上');
    assert.equal(rec.items[0].evidence[1].unmatched, true, '找不到的引句標出來');
    assert.equal(rec.dream.skipped, 1);
    assert.equal((await eg.dream.status(pid)).pending, 1, 'rv-b 沒分析到，下次再回顧');
    assert.equal(fs.existsSync(path.join(run.dir, 'sessions')), false, '完成後刪掉匯出的文字');
    await assert.rejects(createFromPlan(eg, plan({ scope: `project:${pid}`, dream: run.id, summary: 's', items: [item] })), /已經建立過整理記錄|找不到/);
    await eg.dream.reset(run.id);
    assert.equal((await eg.dream.status(pid)).pending, 2, '撤銷後兩個都要再回顧');
    const run2 = await eg.dream.prepare({ pid });
    await eg.dream.done(run2.id);
    const fa = path.join(transcriptDir(), 'rv-a.jsonl');
    fs.appendFileSync(fa, `${JSON.stringify({ ...user('後來改用 GitLab CI 了'), cwd: repo, sessionId: 'rv-a', timestamp: new Date(Date.now() - 600_000).toISOString() })}\n`);
    const later = new Date(Date.now() - 300_000);
    fs.utimesSync(fa, later, later);
    const run3 = await eg.dream.prepare({ pid });
    assert.deepEqual(run3.sessions.map((s) => s.sid), ['rv-a']);
    const txt = fs.readFileSync(path.join(run3.dir, ...run3.sessions[0].files[0].split('/')), 'utf8');
    assert.match(txt, /後來改用 GitLab CI/);
    assert.doesNotMatch(txt, /用 GitHub Actions/, '上次回顧過的部分不再匯出');
    assert.match(txt, /接著聊的部分/);
    await eg.dream.done(run3.id);
    await eg.memories.remove(mem);
  });

  test('回顧資料夾已經清掉（記錄放了 14 天以上）也撤銷得了；沒有要撤銷的對話時回報 0', async () => {
    writeTranscript('rv-c', [user('第三個對話'), said('好')], { ageMs: 1 * DAY });
    const run = await eg.dream.prepare({ pid });
    assert.ok(run.sessions.some((s) => s.sid === 'rv-c'));
    await eg.dream.done(run.id);
    const before = (await eg.dream.status(pid)).pending;
    fs.rmSync(run.dir, { recursive: true, force: true });
    const r = await eg.dream.reset(run.id);
    assert.equal(r.sessions, run.sessions.length);
    assert.equal(r.pid, pid);
    assert.equal((await eg.dream.status(pid)).pending, before + run.sessions.length, '撤銷後再列入');
    assert.equal((await eg.dream.reset(run.id)).sessions, 0, '重複撤銷無妨');
    await assert.rejects(eg.dream.reset('../x'), /不合法的回顧編號/);
  });
});

describe('第二輪審查', () => {
  test('新增的項目帶了既有記憶的 ref 要擋（否則選「封存」會封存那筆既有記憶）', async () => {
    const g = (await eg.memories.create({ scope: { kind: 'global' }, name: 'existing-one', type: 'reference', description: 'd', body: 'b' })).ref;
    await assert.rejects(createFromPlan(eg, plan(
      { scope: 'global', summary: 's', items: [{ ref: g, action: 'create', title: '新增', reason: 'r', ops: [{ op: 'create', scope: 'global', file: 'n.md' }] }] },
      { 'n.md': '---\nname: brand-new\ndescription: d\nmetadata:\n  type: reference\n---\n\nb\n' },
    )), /新增記憶的項目不要寫 ref/);
    assert.ok(fs.existsSync(vaultFile(g)));
    await eg.memories.remove(g);
  });

  test('「上一版」是使用者最後看到的版本：改回較早確認過的版本後 Claude 又改，退回到那一版', async () => {
    const a = (await eg.memories.create({ scope: { kind: 'global' }, name: 'back-and-forth', type: 'feedback', description: 'd', body: 'V1\n', reviewed: true })).ref;
    const v1 = raw(a);
    await eg.memories.write(a, { body: 'V2\n', reviewed: true });
    await eg.memories.write(a, { text: v1, reviewed: true });
    await eg.memories.write(a, { body: 'V3（Claude）\n' });
    const item = (await eg.review.list()).find((x) => x.ref === a);
    assert.match(item.previous, /V1/);
    await eg.review.revert(a, item.sha);
    assert.match(raw(a), /V1/);
    await eg.memories.remove(a);
  });

  test('封存後從歷史還原確認過的版本，不必再確認；每筆記憶這台最多留 20 個確認過的版本（獨立的 commit 淘汰）', async () => {
    const a = (await eg.memories.create({ scope: { kind: 'global' }, name: 'restore-me', type: 'feedback', description: 'd', body: 'v0\n', reviewed: true })).ref;
    const dir = path.join(eg.paths.vault, 'machines', eg.machine.id, 'reviewed');
    const mineOf = () => fs.readdirSync(dir).filter((n) => n.startsWith(reviewKey(a))).length;
    await eg.memories.remove(a);
    assert.equal(mineOf(), 1, '封存時不刪確認紀錄');
    await eg.memories.restore(a);
    assert.ok(fs.existsSync(vaultFile(a)));
    assert.ok(!(await pendingRefs()).includes(a), '從歷史還原的是確認過的版本');
    for (let i = 1; i <= 23; i++) await eg.memories.write(a, { body: `v${i}\n`, reviewed: true });
    assert.equal(mineOf(), 24, '編輯的 commit 不刪紀錄（復原編輯時才不會和淘汰衝突）');
    const pr = await eg.review.prune();
    assert.equal(pr.removed, 4);
    assert.equal(mineOf(), 20);
    assert.ok(!(await pendingRefs()).includes(a), '目前的版本仍算確認過');
    assert.equal((await eg.review.prune()).removed, 0);
    await eg.memories.remove(a);
  });

  test('兩台電腦的修改合併出來的版本確認過後，Claude 又改（還沒 commit）：上一版是合併的版本', async () => {
    const { execFileSync } = await import('node:child_process');
    const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: eg.paths.vault, encoding: 'utf8' });
    const a = (await eg.memories.create({ scope: { kind: 'global' }, name: 'merged-one', type: 'feedback', description: 'd', body: 'L1\n\nL2\n\nL3\n', reviewed: true })).ref;
    const branch = g('rev-parse', '--abbrev-ref', 'HEAD').trim();
    g('checkout', '-q', '-b', 'side');
    fs.writeFileSync(vaultFile(a), raw(a).replace('L3', 'L3（另一台）'));
    g('commit', '-q', '-am', 'side');
    g('checkout', '-q', branch);
    fs.writeFileSync(vaultFile(a), raw(a).replace('L1', 'L1（這台）'));
    g('commit', '-q', '-am', 'main');
    g('merge', '-q', '--no-edit', 'side');
    g('branch', '-q', '-D', 'side');
    assert.match(raw(a), /L1（這台）[\s\S]*L3（另一台）/);
    const merged = raw(a);
    await eg.memories.write(a, { text: merged, reviewed: true });
    fs.writeFileSync(vaultFile(a), merged.replace('L2', 'L2（Claude 改的）'));
    const item = (await eg.review.list()).find((x) => x.ref === a);
    assert.equal(item.previous.replace(/\r\n/g, '\n'), merged.replace(/\r\n/g, '\n'));
    fs.writeFileSync(vaultFile(a), merged);
    await eg.memories.remove(a);
  });

  test('封存後又用同一個名稱新增（不論有沒有 commit）：算新增，不是修改', async () => {
    const a = (await eg.memories.create({ scope: { kind: 'global' }, name: 'reborn', type: 'feedback', description: 'd', body: '舊的內容\n', reviewed: true })).ref;
    await eg.memories.remove(a);
    fs.mkdirSync(path.dirname(vaultFile(a)), { recursive: true });
    fs.writeFileSync(vaultFile(a), '---\nname: reborn\ndescription: d\nmetadata:\n  type: feedback\n---\n\n全新的內容\n');
    let item = (await eg.review.list()).find((x) => x.ref === a);
    assert.equal(item.kind, 'new', '還沒 commit');
    fs.rmSync(vaultFile(a));
    const b = (await eg.memories.create({ scope: { kind: 'global' }, name: 'reborn', type: 'feedback', description: 'd', body: '另一個全新的內容\n' })).ref;
    assert.equal(b, a);
    item = (await eg.review.list()).find((x) => x.ref === a);
    assert.equal(item.kind, 'new', '已經 commit');
    await eg.review.revert(a, item.sha);
    assert.equal(fs.existsSync(vaultFile(a)), false, '退回新增的＝封存，不會把舊的內容寫回來');
  });

  test('匯出對話時先遮蔽再折行：金鑰剛好跨在折行處也不會留下片段', async () => {
    const { renderTranscript } = await import('../../src/core/dream.mjs');
    const { redactSecrets } = await import('../../src/core/secrets.mjs');
    const secret = ['gh', 'p_', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'].join('');
    const dir = path.join(root, 'wrap-redact');
    fs.mkdirSync(dir, { recursive: true });
    for (let pos = 1470; pos <= 1500; pos++) {
      const pattern = `${'x'.repeat(pos)} ${secret} ${'y'.repeat(60)}`;
      const f = path.join(dir, `g${pos}.jsonl`);
      fs.writeFileSync(f, `${JSON.stringify({ type: 'assistant', cwd: dir, sessionId: 's1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern } }] } })}\n`);
      const r = await renderTranscript(f, {});
      const body = redactSecrets(r.turns.join('\n\n')).text.replace(/\n/g, '');
      assert.doesNotMatch(body, /aB3dE5g|jK9mN1p|T5vW7yZ|C1dE3fG5/, `位置 ${pos}`);
    }
  });

  test('verify：不存在的日期要擋；證據比記憶的最後修改還早時證明不了目前的內容', async () => {
    const p = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'dated', type: 'project', description: 'd', body: 'b' })).ref;
    await eg.memories.write(p, { frontmatter: { 'metadata.modified': '2026-10-15T08:00:00.000Z' } });
    const one = (extra) => plan({ scope: `project:${pid}`, summary: 's', items: [{ ref: p, action: 'verify', title: 't', reason: 'r', ops: [{ op: 'verify', ref: p, base: rev(p) }], ...extra }] });
    await assert.rejects(createFromPlan(eg, one({ evidence: [{ date: '2026-02-31', quote: 'q' }] })), /存在的日期/);
    await assert.rejects(createFromPlan(eg, one({ evidence: [{ date: '2026-00-10', quote: 'q' }] })), /存在的日期/);
    await assert.rejects(createFromPlan(eg, one({ evidence: [{ date: '2026-10-01', quote: 'q' }] })), /早於 .* 的最後修改（2026-10-15）/);
    const rec = await createFromPlan(eg, one({ evidence: [{ date: '2026-10-20', quote: 'q' }] }));
    assert.equal(rec.items[0].ops[0].date, '2026-10-20');
    await eg.memories.remove(p);
  });

  test('同一個回顧重複記為已回顧時，撤銷仍回到上一次回顧（接續的對話不會整段重來）', async () => {
    writeTranscript('rv-d', [user('第四個對話'), said('好')], { ageMs: 2 * DAY });
    const r1 = await eg.dream.prepare({ pid });
    await eg.dream.done(r1.id);
    const fd = path.join(transcriptDir(), 'rv-d.jsonl');
    fs.appendFileSync(fd, `${JSON.stringify({ ...user('接著聊'), cwd: repo, sessionId: 'rv-d', timestamp: new Date(Date.now() - 600_000).toISOString() })}\n`);
    const later = new Date(Date.now() - 300_000); // 2 分鐘內有更新的對話視為還在進行，不回顧
    fs.utimesSync(fd, later, later);
    const r2 = await eg.dream.prepare({ pid });
    assert.deepEqual(r2.sessions.map((s) => s.sid), ['rv-d']);
    await eg.dream.done(r2.id);
    await eg.dream.done(r2.id);
    await eg.dream.reset(r2.id);
    const st = JSON.parse(fs.readFileSync(path.join(eg.paths.local, 'dream', 'state.json'), 'utf8'));
    assert.equal(st.projects[pid].sessions['rv-d']?.run, r1.id, '回到第一次回顧，不是整個刪掉');
    const r3 = await eg.dream.prepare({ pid });
    const txt = fs.readFileSync(path.join(r3.dir, ...r3.sessions[0].files[0].split('/')), 'utf8');
    assert.doesNotMatch(txt, /第四個對話/, '第一次回顧過的部分不再匯出');
    await eg.dream.done(r3.id);
  });

  test('引句跨過匯出時的折行也對得上', async () => {
    const long = `開頭${'甲'.repeat(1490)}關鍵的一句話在這裡${'乙'.repeat(200)}`;
    writeTranscript('rv-e', [user(long), said('好')], { ageMs: 1 * DAY });
    const run = await eg.dream.prepare({ pid });
    const mem = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'wrap-check', type: 'project', description: 'd', body: '尚未確認。' })).ref;
    const rec = await createFromPlan(eg, plan({ scope: `project:${pid}`, dream: run.id, summary: 's', items: [{ ref: mem, action: 'update', title: 't', reason: 'r', evidence: [{ quote: `${'甲'.repeat(5)}關鍵的一句話在這裡` }], ops: [{ op: 'write', ref: mem, base: rev(mem), file: 'w.md' }] }] }, { 'w.md': raw(mem).replace('尚未確認。', '已確認。') }));
    assert.equal(rec.items[0].evidence[0].unmatched, undefined);
    await eg.memories.remove(mem);
  });
});
