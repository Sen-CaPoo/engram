// 1.4.0 記憶品質：容易過時、[[連結]]、讀取統計、待你確認、核心準則建議、對話回顧（依 Anthropic〈Components of agent memory〉）。
// 全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { lastCheckedMs, uncheckedDays, volatility } from '../../src/core/volatile.mjs';
import { linksIn, rewriteLinks } from '../../src/core/links.mjs';
import { localDate, readsInRecord, refOfPath } from '../../src/core/usage.mjs';
import { blobSha, inReviewScope } from '../../src/core/review.mjs';
import { applySuggestions, suggestionsFor } from '../../src/core/coresuggest.mjs';
import { renderTranscript, splitTurns, toolLine } from '../../src/core/dream.mjs';
import { renderScopeIndex } from '../../src/core/normalize.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { isLink } from '../../src/core/fsx.mjs';
import { machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli, git } from './helpers.mjs';

const DAY = 86_400_000;
let root;
let m;
let eg;
let repo;
let pid;

const vaultFile = (ref) => path.join(eg.paths.vault, ...ref.split('/'));
const raw = (ref) => fs.readFileSync(vaultFile(ref), 'utf8');
const codes = async (code) => (await eg.health()).filter((f) => f.code === code);

/** 合成的 transcript：records 是 JSON 物件陣列，寫在這個專案的編碼資料夾 */
function writeTranscript(sessionId, records, { ageMs = 3 * 3600_000, cwd = repo } = {}) {
  const enc = encodeProjectPath(cwd);
  const dir = path.join(m.claudeHome, 'projects', enc);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const at = (i) => new Date(Date.now() - ageMs + i * 1000).toISOString();
  fs.writeFileSync(file, `${records.map((r, i) => JSON.stringify({ cwd, sessionId, timestamp: at(i), ...r })).join('\n')}\n`);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '家裡電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  repo = makeRepo(path.join(root, 'work', 'gateway'));
  pid = (await eg.identity.bind(repo, { create: { name: '閘道' } })).pid;
});
after(() => rmTmp(root));

describe('容易過時', () => {
  test('專案進度類、單機、寫著待辦／尚未的算；程式碼區塊裡的 TODO 不算', () => {
    assert.deepEqual(volatility({ type: 'project', scope: { kind: 'project' } }, '說明').reasons, ['type']);
    assert.deepEqual(volatility({ type: 'reference', scope: { kind: 'machine' } }, '路徑').reasons, ['machine']);
    assert.deepEqual(volatility({ type: 'feedback', scope: { kind: 'global' } }, '公司筆電尚未更新').reasons, ['marker']);
    assert.equal(volatility({ type: 'feedback', scope: { kind: 'global' } }, '範例：\n```\n// TODO later\n```\n').yes, false);
    assert.equal(volatility({ type: 'feedback', scope: { kind: 'global' } }, 'not yet verified').yes, true);
  });
  test('最後確認＝驗證日期與修改時間取較新的', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    assert.equal(uncheckedDays({ updatedAt: '2026-10-01T00:00:00Z' }, now), 37);
    assert.equal(uncheckedDays({ updatedAt: '2026-10-01T00:00:00Z', verified: '2026-11-05' }, now), 2);
    assert.equal(uncheckedDays({}, now), null);
    assert.ok(lastCheckedMs({ verified: '2026-11-05', updatedAt: '2026-10-01T00:00:00Z' }) > Date.parse('2026-11-04'));
  });
  test('記憶摘要帶 verified（格式不對當作沒有）', async () => {
    const r = await eg.memories.create({ scope: { kind: 'global' }, name: 'verified-demo', type: 'reference', description: '有驗證日期', body: '內容' });
    await eg.memories.write(r.ref, { frontmatter: { 'metadata.engram.verified': '2026-11-01' } });
    const s = (await eg.memories.list({ scope: 'global' })).find((x) => x.ref === r.ref);
    assert.equal(s.verified, '2026-11-01');
    await eg.memories.write(r.ref, { frontmatter: { 'metadata.engram.verified': 'yesterday' } });
    assert.equal((await eg.memories.list({ scope: 'global' })).find((x) => x.ref === r.ref).verified, null);
    await eg.memories.remove(r.ref);
  });
});

describe('[[連結]]', () => {
  test('解析：去重、略過程式碼、支援別名', () => {
    assert.deepEqual(linksIn('見 [[a-b]]、[[a-b]] 與 [[c|別名]]；`[[code]]`\n```\n[[block]]\n```'), ['a-b', 'c']);
  });
  test('改寫：只改內文，保留別名；程式碼裡的不動；to 為 null 時只留文字', () => {
    const text = '---\nname: x\ndescription: 連到 [[old]]\n---\n見 [[old]] 與 [[Old|別名]]，`[[old]]` 不動。\n';
    const r = rewriteLinks(text, 'old', 'new');
    assert.equal(r.count, 2);
    assert.match(r.text, /description: 連到 \[\[old\]\]/, 'frontmatter 不動');
    assert.match(r.text, /見 \[\[new\]\] 與 \[\[new\|別名\]\]，`\[\[old\]\]` 不動/);
    assert.equal(rewriteLinks('a [[old|別名]] b [[old]]', 'old', null).text, 'a 別名 b old');
  });
  test('被合併的記憶：H21 一鍵改指向；被封存：拿掉連結；從沒存在過的名稱不提示', async () => {
    const a = (await eg.memories.create({ scope: { kind: 'global' }, name: 'ps-encoding', type: 'reference', description: '編碼一', body: 'A' })).ref;
    const b = (await eg.memories.create({ scope: { kind: 'global' }, name: 'ps-bom', type: 'reference', description: '編碼二', body: 'B' })).ref;
    const c = (await eg.memories.create({ scope: { kind: 'global' }, name: 'old-tool', type: 'reference', description: '舊工具', body: 'C' })).ref;
    const user1 = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'uses-links', type: 'project', description: '有連結', body: '參考 [[ps-bom]]、[[old-tool]] 與 [[future-topic]]。' })).ref;
    await eg.memories.merge([a, b], { into: a, text: 'A 與 B' });
    await eg.memories.remove(c);
    const h21 = await codes('H21');
    const relink = h21.find((f) => f.fix.action === 'relink');
    const unlink = h21.find((f) => f.fix.action === 'unlink');
    assert.equal(h21.length, 2, '從沒存在過的 [[future-topic]] 不提示');
    assert.deepEqual(relink.fix.args, { ref: user1, from: 'ps-bom', to: 'ps-encoding' });
    assert.ok(relink.en.title && relink.fix.en.label);
    await eg.apply(relink.fix);
    await eg.apply(unlink.fix);
    assert.match(raw(user1), /參考 \[\[ps-encoding\]\]、old-tool 與 \[\[future-topic\]\]。/);
    assert.equal((await codes('H21')).length, 0);
    await assert.rejects(eg.apply(relink.fix), /已經沒有/);
    const g = await eg.memories.links(a);
    assert.deepEqual(g.in, [{ ref: user1, name: 'uses-links' }]);
    const out = (await eg.memories.links(user1)).out;
    assert.deepEqual(out.map((x) => [x.name, x.ref]), [['ps-encoding', a], ['future-topic', null]]);
    await eg.memories.remove(user1);
    await eg.memories.remove(a);
  });
});

describe('讀取統計', () => {
  test('路徑轉 ref：vault、Claude Code 的記憶資料夾（依綁定）、索引不算', () => {
    const roots = { home: m.userHome.replace(/\\/g, '/'), vault: eg.paths.vault.replace(/\\/g, '/'), claudeHome: m.claudeHome.replace(/\\/g, '/') };
    const enc = encodeProjectPath(repo);
    const map = new Map([[enc.toLowerCase(), pid]]);
    assert.equal(refOfPath(path.join(eg.paths.vault, 'global', 'a.md'), roots, map), 'global/a.md');
    assert.equal(refOfPath(path.join(m.claudeHome, 'projects', enc, 'memory', 'b.md'), roots, map), `projects/${pid}/memory/b.md`);
    assert.equal(refOfPath(path.join(eg.paths.vault, 'global', 'INDEX.md'), roots, map), null);
    assert.equal(refOfPath(path.join(root, 'other.md'), roots, map), null);
    const rec = tool('t1', 'Bash', { command: `cat "${path.join(eg.paths.vault, 'global', 'a.md').replace(/\\/g, '/')}" && engram memory show global/b.md` });
    assert.deepEqual(readsInRecord({ ...rec, cwd: repo }, roots, map).sort(), ['global/a.md', 'global/b.md']);
  });

  test('增量掃描：同一個對話同一天只算一次；只讀新增的部分；每天寫一次同步摘要', async () => {
    const g = (await eg.memories.create({ scope: { kind: 'global' }, name: 'often-read', type: 'reference', description: '常讀', body: 'x' })).ref;
    const p = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'proj-read', type: 'project', description: '專案', body: 'y' })).ref;
    const gpath = vaultFile(g);
    const file = writeTranscript('sess-usage-1', [
      user('讀一下'),
      tool('r1', 'Read', { file_path: gpath }),
      tool('r2', 'Read', { file_path: gpath }),
      tool('r3', 'Read', { file_path: path.join(m.claudeHome, 'projects', encodeProjectPath(repo), 'memory', 'proj-read.md') }),
    ], { ageMs: 60 * 60_000 });
    let r = await eg.usage.refresh();
    assert.equal(r.written, true);
    let u = await eg.usage.get(g);
    assert.equal(u.reads, 1, '同一個對話同一天讀兩次只算一次');
    assert.deepEqual(u.projects, { [pid]: 1 });
    assert.equal((await eg.usage.get(p)).reads, 1);
    // 再加一行：只讀新增的部分
    fs.appendFileSync(file, `${JSON.stringify({ ...tool('r4', 'Read', { file_path: gpath }), cwd: repo, sessionId: 'sess-usage-2', timestamp: new Date().toISOString() })}\n`);
    r = await eg.usage.refresh({ commit: false });
    assert.ok(r.scannedBytes > 0 && r.scannedBytes < fs.statSync(file).size, '只讀新增的位元組');
    r = await eg.usage.refresh();
    assert.equal(r.written, false, '今天已經寫過摘要');
    r = await eg.usage.refresh({ force: true });
    u = await eg.usage.get(g);
    assert.equal(u.reads, 2);
    assert.equal(u.tracking, true);
    const summary = JSON.parse(fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'usage.json'), 'utf8'));
    assert.equal(summary.refs[g].reads, 2);
    const listed = (await eg.memories.list({ scope: 'global' })).find((x) => x.ref === g);
    assert.equal(listed.usage.reads, 2);
    const log = git(eg.paths.vault, 'log', '-1', '--format=%B');
    assert.match(log, /Engram-Action: usage/);
  });

  test('索引放不下時依讀取次數挑選；顯示順序仍依修改時間', async () => {
    const dir = path.join(root, 'idx');
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, n] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      fs.writeFileSync(path.join(dir, `${n}.md`), `---\nname: ${n}\ndescription: ${n}\nmetadata:\n  type: reference\n  modified: 2026-10-0${i + 1}T00:00:00.000Z\n---\n${n}\n`);
    }
    const reads = (f) => ({ 'a.md': 9, 'b.md': 0, 'c.md': 5, 'd.md': 0, 'e.md': 0 }[f]);
    // 預算 8 行：5 筆＋檔頭 4 行放不下 → 可列 8 − 6 = 2 筆
    const text = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 8, reads });
    const shown = [...text.matchAll(/^- \[(\w)\]/gm)].map((x) => x[1]);
    assert.deepEqual(shown, ['c', 'a'], '挑讀最多的 a、c；顯示依修改時間新到舊');
    assert.match(text, /另有 3 筆未列出/);
    const none = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 8 });
    assert.deepEqual([...none.matchAll(/^- \[(\w)\]/gm)].map((x) => x[1]), ['e', 'd'], '沒有統計時沿用修改時間（與 1.3.0 相同）');
    const all = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 60, reads });
    assert.equal([...all.matchAll(/^- \[/gm)].length, 5, '放得下時全部列出');
  });

  test('H22：統計涵蓋 60 天以上才判斷；沒被讀過的建議封存，只在一個專案讀的建議搬過去', async () => {
    const unused = (await eg.memories.create({ scope: { kind: 'global' }, name: 'never-read', type: 'reference', description: '沒人讀', body: 'z' })).ref;
    const single = (await eg.memories.create({ scope: { kind: 'global' }, name: 'single-proj', type: 'reference', description: '只在閘道', body: 'w' })).ref;
    // 修改時間設成很久以前（frontmatter 的 modified）
    for (const r of [unused, single]) await eg.memories.write(r, { frontmatter: { 'metadata.modified': '2026-01-01T00:00:00.000Z' } });
    const usageFile = path.join(eg.paths.vault, 'machines', eg.machine.id, 'usage.json');
    const today = localDate(Date.now());
    fs.writeFileSync(usageFile, JSON.stringify({ v: 1, since: localDate(Date.now() - 30 * DAY), window: 90, refs: { [single]: { reads: 4, days: 3, last: today, projects: { [pid]: 4 } } }, updated: today }));
    assert.equal((await codes('H22')).length, 0, '統計只涵蓋 30 天：不判斷');
    fs.writeFileSync(usageFile, JSON.stringify({ v: 1, since: localDate(Date.now() - 70 * DAY), window: 90, refs: { [single]: { reads: 4, days: 3, last: today, projects: { [pid]: 4 } } }, updated: today }));
    const h22 = await codes('H22');
    const a = h22.find((f) => f.refs[0] === unused);
    const b = h22.find((f) => f.refs[0] === single);
    assert.equal(a.fix.action, 'remove');
    assert.deepEqual(b.fix.args, { ref: single, scope: { kind: 'project', pid } });
    assert.ok(a.en.title && b.en.detail);
    await eg.memories.remove(unused);
    await eg.memories.remove(single);
  });
});

describe('H16 每次載入的內容', () => {
  test('位元組 20KB 以上為低、超過 25KB 為中', async () => {
    const core = await eg.core.read();
    const fill = (kb) => `${core.text}\n<!-- ${'填'.repeat(Math.ceil((kb * 1024) / 3))} -->\n`;
    await eg.core.write(fill(18));
    let h = (await codes('H16')).find((f) => f.fix?.action === 'open-tidy');
    assert.equal(h.severity, 'low');
    await eg.core.write(fill(26));
    h = (await codes('H16')).find((f) => f.fix?.action === 'open-tidy');
    assert.equal(h.severity, 'medium');
    await eg.core.write(core.text);
    assert.equal((await codes('H16')).length, 0);
  });
});

describe('待你確認的寫入（H23）', () => {
  test('範圍：全域、這台的單機、核心準則；索引與專案不算', () => {
    assert.ok(inReviewScope('global/a.md', 'pc'));
    assert.ok(inReviewScope('machines/pc/a.md', 'pc'));
    assert.ok(!inReviewScope('machines/other/a.md', 'pc'));
    assert.ok(inReviewScope('core/CORE.md', 'pc'));
    assert.ok(inReviewScope('core/rules/x.md', 'pc'));
    assert.ok(!inReviewScope('global/INDEX.md', 'pc'));
    assert.ok(!inReviewScope('projects/p/memory/a.md', 'pc'));
    assert.equal(blobSha('a\r\nb\n'), blobSha('a\nb\n'), 'CRLF 與 LF 同一個 blob');
    assert.equal(blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a', '與 git hash-object 相同');
  });

  test('起點之後：Claude 寫入的要確認；介面與 --reviewed 的不用；確認、退回、新增的退回＝封存', async () => {
    assert.equal((await codes('H23')).length, 0, '起點建立前不判斷');
    await eg.review.baseline();
    assert.equal((await codes('H23')).length, 0, '現有內容都記為確認過');
    const claude = (await eg.memories.create({ scope: { kind: 'global' }, name: 'claude-wrote', type: 'feedback', description: 'Claude 寫的', body: '一' })).ref;
    const ui = (await eg.memories.create({ scope: { kind: 'global' }, name: 'user-approved', type: 'feedback', description: '使用者同意', body: '二', reviewed: true })).ref;
    const proj = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'proj-only', type: 'project', description: '專案', body: '三' })).ref;
    let h = await codes('H23');
    assert.equal(h.length, 1);
    assert.deepEqual(h[0].refs, [claude], '只有 Claude 寫的全域記憶');
    assert.equal(h[0].fix.action, 'open-review');
    let list = await eg.review.list();
    assert.equal(list[0].kind, 'new');
    // 確認時內容剛好又變了：不算
    const staleSha = list[0].sha;
    await eg.memories.write(claude, { body: '一（改）\n' });
    let r = await eg.review.confirm([{ ref: claude, sha: staleSha }]);
    assert.deepEqual(r.stale, [claude]);
    list = await eg.review.list();
    r = await eg.review.confirm([{ ref: claude, sha: list[0].sha }]);
    assert.deepEqual(r.confirmed, [claude]);
    assert.equal((await codes('H23')).length, 0);
    // Claude 再改一次 → 變成 changed，previous 是確認過的版本
    await eg.memories.write(claude, { body: '被誘導改成錯的\n' });
    list = await eg.review.list();
    assert.equal(list[0].kind, 'changed');
    assert.match(list[0].previous, /一（改）/);
    await eg.review.revert(claude);
    assert.match(raw(claude), /一（改）/, '退回確認過的版本');
    assert.equal((await codes('H23')).length, 0);
    // 新增的退回＝封存
    const fresh = (await eg.memories.create({ scope: { kind: 'global' }, name: 'claude-new', type: 'feedback', description: '新的', body: '四' })).ref;
    await eg.review.revert(fresh);
    assert.equal(fs.existsSync(vaultFile(fresh)), false);
    // 設定關掉時不提示
    const again = (await eg.memories.create({ scope: { kind: 'global' }, name: 'claude-again', type: 'feedback', description: '又一筆', body: '五' })).ref;
    await eg.settings.set({ reviewWrites: 'off' });
    assert.equal((await codes('H23')).length, 0);
    await eg.settings.set({ reviewWrites: 'on' });
    assert.equal((await codes('H23')).length, 1);
    for (const x of [claude, ui, proj, again]) await eg.memories.remove(x);
    assert.equal((await codes('H23')).length, 0, '刪掉後不再列出');
  });

  test('Engram 自己做的改動（電腦清單）延續原本的確認狀態；Claude 改過還沒確認的不會因此變成確認過', async () => {
    await eg.review.baseline();
    assert.equal((await eg.review.list()).length, 0);
    await eg.machine.rename('改名後的電腦');
    assert.equal((await eg.review.list()).some((x) => x.ref === 'core/CORE.md'), false, '電腦清單由 Engram 維護，不必確認');
    const core = (await eg.core.read()).text;
    await eg.core.write(`${core}\n<!-- Claude 加的 -->\n`);
    await eg.machine.rename('又改名的電腦');
    assert.equal((await eg.review.list()).some((x) => x.ref === 'core/CORE.md'), true, 'Claude 改過還沒確認：仍然要確認');
    await eg.core.write(core.replace(/改名後的電腦/g, '又改名的電腦'), { reviewed: true });
    await eg.machine.rename('家裡電腦');
  });

  test('確認紀錄每筆一檔：單獨復原較早的變更不會和之後其他記憶的確認紀錄衝突', async () => {
    const a = (await eg.memories.create({ scope: { kind: 'global' }, name: 'undo-a', type: 'feedback', description: 'A', body: 'a1', reviewed: true })).ref;
    const b = (await eg.memories.create({ scope: { kind: 'global' }, name: 'undo-b', type: 'feedback', description: 'B', body: 'b1', reviewed: true })).ref;
    const ra = await eg.memories.write(a, { body: 'a2\n', reviewed: true });
    await eg.memories.write(b, { body: 'b2\n', reviewed: true });
    await eg.undo(ra.undo.sha);
    assert.match(raw(a), /a1/);
    assert.equal((await eg.review.list()).some((x) => x.ref === a), false, '復原後的內容（a1）當初確認過');
    await eg.memories.remove(a);
    await eg.memories.remove(b);
  });
});

describe('核心準則建議（H24）', () => {
  test('舊範本找得到位置、還沒加過才建議；加入後不再出現；新範本已經包含', async () => {
    const cur = (await eg.core.read()).text;
    assert.deepEqual(suggestionsFor(cur), [], '新安裝的範本已經包含建議');
    const old = cur.replace(/\n\n記憶是寫給之後的對話用的：[^\n]*/, '').replace(/\n- 寫下規則或做法時，註明怎麼確認的[^\n]*/, '');
    assert.notEqual(old, cur);
    assert.deepEqual(suggestionsFor(old).map((s) => s.id), ['memory-purpose', 'verify-note']);
    assert.equal(applySuggestions(old, ['memory-purpose', 'verify-note']), cur, '加回去之後與新範本一字不差');
    await eg.core.write(old);
    const h = await codes('H24');
    assert.equal(h.length, 1);
    assert.equal(h[0].fix.action, 'open-core');
    await eg.core.applySuggestions(['verify-note']);
    assert.deepEqual((await eg.core.suggestions()).map((s) => s.id), ['memory-purpose']);
    await eg.core.applySuggestions(['memory-purpose']);
    assert.equal((await codes('H24')).length, 0);
    await assert.rejects(eg.core.applySuggestions(['memory-purpose']), /已經加過/);
    assert.equal((await eg.core.read()).text, cur);
  });
  test('使用者改過那一段（找不到位置）時不建議', () => {
    assert.deepEqual(suggestionsFor('# 我的準則\n\n## 記憶\n- 隨便寫\n'), []);
  });
});

describe('對話回顧', () => {
  test('對話紀錄 → 精簡文字：略過 sidechain 與系統提醒、問答的回覆較長、工具摘要', async () => {
    const file = writeTranscript('render-1', [
      { type: 'ai-title', aiTitle: '部署討論' },
      user('部署改用 npm run release 吧<system-reminder>內部提醒</system-reminder>'),
      said('好，我改成 npm run release。'),
      tool('q1', 'AskUserQuestion', { questions: [{ question: '要推送嗎？', options: [{ label: '要' }, { label: '不要' }] }] }),
      result('q1', `User has answered: 要${'。'.repeat(500)}`),
      tool('b1', 'Bash', { command: 'npm run release' }),
      result('b1', 'x'.repeat(1000)),
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '子代理的內容' }] } },
    ]);
    const r = await renderTranscript(file);
    const text = r.turns.join('\n\n');
    assert.equal(r.title, '部署討論');
    assert.match(text, /【使用者 \d{4}-\d{2}-\d{2} \d{2}:\d{2}】\n部署改用 npm run release 吧/);
    assert.doesNotMatch(text, /內部提醒|子代理的內容/);
    assert.match(text, /→ AskUserQuestion：要推送嗎？［要／不要］/);
    assert.match(text, /← User has answered: 要。{400}/, '問答的回覆保留較長');
    assert.match(text, /← x{300}…（後略 700 字）/);
    assert.equal(toolLine('Read', { file_path: 'C:/a.md' }), 'Read C:/a.md');
    const parts = splitTurns(['a'.repeat(50), 'b'.repeat(50), `${'c'.repeat(30)}\n${'d'.repeat(30)}\n${'e'.repeat(30)}`], 70);
    assert.equal(parts.length, 4);
    assert.match(parts[3][0], /^（接上一段，同一個回合）/);
  });

  test('prepare：由舊到新、排除目前的對話與進行中的、遮蔽金鑰；建立整理記錄後記為已回顧，resume 變長的再列入', async () => {
    const mem = (await eg.memories.create({ scope: { kind: 'project', pid }, name: 'deploy-notes', type: 'project', description: '部署方式', body: '部署用 npm run deploy。尚未設定 CI。' })).ref;
    const secret = ['gh', 'p_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
    writeTranscript('old-1', [user(`改用 npm run release，token: ${secret}`), said('好')], { ageMs: 26 * DAY });
    writeTranscript('mid-2', [user('CI 設好了'), said('確認 CI 已設定')], { ageMs: 5 * DAY });
    writeTranscript('current-3', [user('現在這個對話'), said('嗯')], { ageMs: 3 * DAY });
    writeTranscript('active-4', [user('還在進行'), said('嗯')], { ageMs: 10_000 });
    let st = await eg.dream.status(pid, { exclude: 'current-3' });
    // 未回顧：old-1、mid-2，加上讀取統計測試留下的 sess-usage-1；current-3（目前的對話）與 active-4（進行中）不算
    assert.equal(st.pending, 3);
    assert.ok(st.expiresInDays <= 4, '最早的 26 天前，30 天保留');
    const run = await eg.dream.prepare({ pid, exclude: 'current-3', max: 1 });
    assert.deepEqual(run.sessions.map((s) => s.sid), ['old-1'], '由舊到新、只取 1 個');
    assert.equal(run.remaining, 2);
    const text = fs.readFileSync(path.join(run.dir, ...run.sessions[0].files[0].split('/')), 'utf8');
    assert.doesNotMatch(text, new RegExp(secret), '疑似金鑰已遮蔽');
    assert.match(text, /改用 npm run release/);
    const memText = fs.readFileSync(path.join(run.dir, 'memories.md'), 'utf8');
    assert.match(memText, new RegExp(`## ${mem.replace(/\//g, '\\/')}`));
    assert.match(memText, /容易過時/);
    const row = run.memories.find((x) => x.ref === mem);
    assert.equal(row.rev, (await import('../../src/cli/commands/safe.mjs')).revOf(raw(mem)));
    // additionalDirectories 加入回顧資料夾（沙盒的 Claude 設定）
    const settings = JSON.parse(fs.readFileSync(path.join(m.claudeHome, 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.additionalDirectories.some((p) => /dream$/.test(p.replace(/[\\/]+$/, ''))));
    // 整理計畫帶 dream：驗證 verify 與 evidence，建立後記為已回顧
    const { createFromPlan } = await import('../../src/tidy/plan.mjs');
    const { applyRecord } = await import('../../src/tidy/apply.mjs');
    const { setDecisions, markReady } = await import('../../src/tidy/store.mjs');
    const { revOf } = await import('../../src/cli/commands/safe.mjs');
    const dir = path.join(root, 'plans', 'dream1');
    fs.mkdirSync(dir, { recursive: true });
    const plan = (over = {}) => {
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({
        scope: `project:${pid}`, dream: run.id, summary: '回顧了 1 個對話',
        items: [{ ref: mem, group: '與對話一致', action: 'verify', title: '仍正確', reason: '對話照做成功', evidence: [{ session: 'old-1', date: '2026-10-12', quote: '改用 npm run release' }], ops: [{ op: 'verify', ref: mem, base: revOf(raw(mem)) }] }],
        ...over,
      }));
      return path.join(dir, 'plan.json');
    };
    await assert.rejects(createFromPlan(eg, plan({ scope: 'global' })), /scope 要寫 project:/);
    await assert.rejects(createFromPlan(eg, plan({ dream: 'dr-20990101-000000-zzzz' })), /找不到回顧/);
    const rec = await createFromPlan(eg, plan());
    assert.equal(rec.kind, 'dream');
    assert.equal(rec.dream.id, run.id);
    assert.equal(rec.items[0].evidence[0].quote, '改用 npm run release');
    st = await eg.dream.status(pid, { exclude: 'current-3' });
    assert.equal(st.pending, run.pendingTotal - 1, 'old-1 記為已回顧');
    await setDecisions(eg.paths.local, rec.id, { i1: { decision: 'accept' } });
    await markReady(eg.paths.local, rec.id);
    await applyRecord(eg, rec.id);
    assert.match(raw(mem), /verified: ['"]?\d{4}-\d{2}-\d{2}/, '記下驗證日期');
    assert.match(raw(mem), /部署用 npm run deploy。尚未設定 CI。/, '內容不變');
    // resume 之後變長：再列入
    const f1 = path.join(m.claudeHome, 'projects', encodeProjectPath(repo), 'old-1.jsonl');
    fs.appendFileSync(f1, `${JSON.stringify({ ...user('再補一句'), cwd: repo, sessionId: 'old-1', timestamp: new Date().toISOString() })}\n`);
    const later = new Date(Date.now() - 600_000);
    fs.utimesSync(f1, later, later);
    st = await eg.dream.status(pid, { exclude: 'current-3' });
    assert.equal(st.pending, run.pendingTotal, 'old-1 變長後又算未回顧');
    // done：沒有建議時只記錄
    const run2 = await eg.dream.prepare({ pid, exclude: 'current-3' });
    await eg.dream.done(run2.id);
    assert.equal((await eg.dream.status(pid, { exclude: 'current-3' })).pending, 0);
    assert.ok((await eg.dream.list()).some((x) => x.id === run2.id));
    await eg.memories.remove(mem);
  });

  test('H20：未回顧的對話 7 天內會被清除時提示；保留天數依 cleanupPeriodDays', async () => {
    writeTranscript('expiring-9', [user('一段新的對話'), said('好')], { ageMs: 25 * DAY });
    let h = (await codes('H20')).find((f) => f.pid === pid);
    assert.ok(h, '25 天前的對話、保留 30 天 → 5 天後清除');
    assert.equal(h.fix.action, 'open-dream');
    assert.deepEqual(h.fix.args, { pid });
    const sp = path.join(m.claudeHome, 'settings.json');
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    fs.writeFileSync(sp, JSON.stringify({ ...s, cleanupPeriodDays: 90 }));
    h = (await codes('H20')).find((f) => f.pid === pid);
    assert.equal(h, undefined, '保留 90 天：還早，不提示');
    fs.writeFileSync(sp, JSON.stringify(s));
  });

  // 1.4.1：2026-11-07 套用 H04「移除舊綁定」後，舊資料夾的對話（還沒被 Claude Code 清除）就回顧不到了
  test('H04 移除舊綁定後，舊資料夾在移除之前的對話仍算這個專案', async () => {
    const oldRepo = makeRepo(path.join(root, 'work', 'old-place'));
    const pidOld = (await eg.identity.bind(oldRepo, { create: { name: '搬家前' } })).pid;
    writeTranscript('moved-1', [user('舊位置的第一段對話'), said('好')], { ageMs: 20 * DAY, cwd: oldRepo });
    writeTranscript('moved-2', [user('舊位置的第二段對話'), said('好')], { ageMs: 2 * DAY, cwd: oldRepo });
    assert.equal((await eg.dream.status(pidOld)).pending, 2);
    fs.rmSync(oldRepo, { recursive: true, force: true });
    const h04 = (await codes('H04')).find((f) => f.pid === pidOld);
    assert.ok(h04, '資料夾不見了 → H04');
    assert.equal(h04.fix.action, 'forget-binding');
    await eg.apply(h04.fix);
    assert.equal((await codes('H04')).find((f) => f.pid === pidOld), undefined, '綁定已移除');
    const st = await eg.dream.status(pidOld);
    assert.equal(st.pending, 2, '移除綁定後仍找得到舊資料夾的對話');
    const run = await eg.dream.prepare({ pid: pidOld });
    assert.deepEqual(run.sessions.map((s) => s.sid), ['moved-1', 'moved-2']);
    await eg.dream.reset(run.id);
    // 綁定移除之後才寫進同一個編碼資料夾的對話，不屬於已經不存在的舊資料夾
    const rf = path.join(eg.paths.local, 'retired-bindings.json');
    const saved = fs.readFileSync(rf, 'utf8');
    const j = JSON.parse(saved);
    const entry = j.bindings.find((b) => b.pid === pidOld);
    assert.ok(entry && entry.encoded === encodeProjectPath(oldRepo));
    entry.retiredAt = new Date(Date.now() - 10 * DAY).toISOString();
    fs.writeFileSync(rf, JSON.stringify(j));
    assert.equal((await eg.dream.status(pidOld)).pending, 1, '只算移除之前（10 天前）就寫好的 moved-1');
    fs.writeFileSync(rf, saved);
    // 別的專案不會撿到這些對話
    assert.ok(!(await eg.dream.prepare({ pid })).sessions.some((s) => /^moved-/.test(s.sid)));
  });

  test('同一個路徑重新綁定給新專案：移除之前的對話只算舊專案；合併專案時退役紀錄跟著改', async () => {
    const dir = path.join(root, 'work', 'reuse-place');
    makeRepo(dir);
    const pA = (await eg.identity.bind(dir, { create: { name: '重用前' } })).pid;
    writeTranscript('reuse-old', [user('舊專案時期的對話'), said('好')], { ageMs: 6 * DAY, cwd: dir });
    const memLink = path.join(m.claudeHome, 'projects', encodeProjectPath(dir), 'memory');
    assert.equal(isLink(memLink), true, '綁定時建立了指向 vault 的 junction');
    fs.rmSync(dir, { recursive: true, force: true });
    await eg.apply((await codes('H04')).find((f) => f.pid === pA).fix);
    // 留著的話，同一個路徑之後再開 Claude Code 會把記憶寫進舊專案，重新綁定也會被拒絕
    assert.equal(isLink(memLink), false, '移除舊綁定時一併拆掉指向這個專案的 junction');
    assert.ok(fs.existsSync(path.join(m.claudeHome, 'projects', encodeProjectPath(dir), 'reuse-old.jsonl')), '對話紀錄不動');
    // 退役時間調成 3 天前，才能分出「移除之前」與「之後」的對話
    const rf = path.join(eg.paths.local, 'retired-bindings.json');
    const j = JSON.parse(fs.readFileSync(rf, 'utf8'));
    j.bindings.find((b) => b.pid === pA).retiredAt = new Date(Date.now() - 3 * DAY).toISOString();
    fs.writeFileSync(rf, JSON.stringify(j));
    makeRepo(dir);
    const pB = (await eg.identity.bind(dir, { create: { name: '重用後' } })).pid;
    writeTranscript('reuse-new', [user('新專案的對話'), said('好')], { ageMs: 1 * DAY, cwd: dir });
    let a = await eg.dream.prepare({ pid: pA });
    assert.deepEqual(a.sessions.map((s) => s.sid), ['reuse-old']);
    await eg.dream.reset(a.id);
    const b = await eg.dream.prepare({ pid: pB });
    assert.deepEqual(b.sessions.map((s) => s.sid), ['reuse-new'], '移除之前的對話屬於舊專案，新專案不重複算');
    await eg.dream.reset(b.id);
    // 舊專案併入另一個專案：退役紀錄改到合併後的專案，舊對話仍有專案認領
    const pC = (await eg.identity.bind(makeRepo(path.join(root, 'work', 'merge-target')), { create: { name: '合併目標' } })).pid;
    await eg.projects.link(pA, pC);
    assert.ok(JSON.parse(fs.readFileSync(rf, 'utf8')).bindings.every((x) => x.pid !== pA), '不再指向已合併的專案');
    a = await eg.dream.prepare({ pid: pC });
    assert.ok(a.sessions.some((s) => s.sid === 'reuse-old'));
    await eg.dream.reset(a.id);
  });

  test('退役紀錄：同一個綁定再移除以最新為準；舊資料夾已經沒有對話紀錄的項目順便清掉', async () => {
    const { readRetired, retireBinding } = await import('../../src/core/retired.mjs');
    const local = path.join(root, 'retired-local');
    const claudeHome = path.join(root, 'retired-claude');
    fs.mkdirSync(path.join(claudeHome, 'projects', 'C--keep'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'projects', 'C--keep', 's.jsonl'), '{}\n');
    await retireBinding(local, { key: 'C--keep', pid: 'p1', encoded: 'C--keep' }, { now: Date.parse('2026-11-01T00:00:00Z') });
    await retireBinding(local, { key: 'C--gone', pid: 'p2', encoded: 'C--gone' }, { now: Date.parse('2026-11-02T00:00:00Z') });
    assert.equal((await readRetired(local)).length, 2);
    await retireBinding(local, { key: 'C--keep', pid: 'p1', encoded: 'C--keep' }, { now: Date.parse('2026-11-03T00:00:00Z'), claudeHome });
    const list = await readRetired(local);
    assert.deepEqual(list.map((b) => [b.key, b.retiredAt]), [['C--keep', '2026-11-03T00:00:00.000Z']], 'C--gone 沒有對話紀錄了 → 清掉；C--keep 以最新為準');
    assert.equal(await retireBinding(local, { key: 'x', pid: '', encoded: 'C--x' }), null, '沒有 pid 不記');
    fs.writeFileSync(path.join(local, 'retired-bindings.json'), '{"bindings":[{"pid":"p","encoded":"e","retiredAt":"not-a-date"},null,"x"]}');
    assert.deepEqual(await readRetired(local), [], '壞掉的項目略過');
    // 同一個 key 先後屬於不同專案：分開保存
    await retireBinding(local, { key: 'C--reuse', pid: 'p1', encoded: 'C--reuse' }, { now: Date.parse('2026-11-01T00:00:00Z') });
    await retireBinding(local, { key: 'C--reuse', pid: 'p2', encoded: 'C--reuse' }, { now: Date.parse('2026-11-05T00:00:00Z') });
    assert.deepEqual((await readRetired(local)).map((b) => b.pid).sort(), ['p1', 'p2']);
  });

  // 1.4.1 第二輪審查：撞名的兩個專案並存時，其中一個移除舊綁定，另一個還在用的專案不能失去歷史對話
  test('對話歸屬的時間區間：撞名並存、路徑先後重用、同專案又綁回來', async () => {
    const { inWindows, sessionWindows } = await import('../../src/core/retired.mjs');
    const D = (s) => Date.parse(`2026-11-${s}T00:00:00Z`);
    const at = (d) => ({ mtimeMs: D(d) });
    const rows = (...xs) => xs.map(([pid, d]) => ({ pid, encoded: 'C--E', retiredAt: new Date(D(d)).toISOString() }));
    // 撞名並存：Q 從 10/01 就綁著，P 在 11/07 移除 → Q 仍擁有全部對話；P 擁有 11/07 之前的
    let r = rows(['P', '07']);
    const q = sessionWindows(r, 'Q', 'c--e', Date.parse('2026-10-01T00:00:00Z'));
    assert.ok(inWindows(at('02'), q) && inWindows(at('06'), q) && inWindows(at('08'), q));
    assert.ok(inWindows(at('02'), sessionWindows(r, 'P', 'C--E', undefined)));
    assert.ok(!inWindows(at('08'), sessionWindows(r, 'P', 'C--E', undefined)));
    // 路徑先後重用：P 11/03 移除 → Q 之後綁定、11/06 移除 → R 現在綁著
    r = rows(['P', '03'], ['Q', '06']);
    const p = sessionWindows(r, 'P', 'C--E', undefined);
    const q2 = sessionWindows(r, 'Q', 'C--E', undefined);
    const rr = sessionWindows(r, 'R', 'C--E', D('06') + 3600_000);
    assert.deepEqual(['02', '04', '07'].map((d) => [inWindows(at(d), p), inWindows(at(d), q2), inWindows(at(d), rr)]), [[true, false, false], [false, true, false], [false, false, true]]);
    // 同一個專案移除後又綁回來：兩段都算
    r = rows(['P', '03']);
    const back = sessionWindows(r, 'P', 'C--E', D('05'));
    assert.ok(inWindows(at('02'), back) && inWindows(at('06'), back));
    // 綁定時間不知道：全部都算（維持 1.4.0 的行為）
    assert.ok(inWindows(at('02'), sessionWindows(rows(['P', '07']), 'Q', 'C--E', -Infinity)));
    // 第三輪審查：撞名並存的兩個專案在同一次整理裡先後移除（相差 2 秒）→ 兩邊都保有移除前的全部對話
    const both = [
      { pid: 'P', encoded: 'C--E', boundAt: '2026-10-01T00:00:00.000Z', retiredAt: '2026-11-07T00:00:00.000Z' },
      { pid: 'Q', encoded: 'C--E', boundAt: '2026-10-02T00:00:00.000Z', retiredAt: '2026-11-07T00:00:02.000Z' },
    ];
    for (const who of ['P', 'Q']) {
      const w = sessionWindows(both, who, 'C--E', undefined);
      assert.ok(['02', '05', '06'].every((d) => inWindows(at(d), w)), `${who} 保有移除前的對話`);
    }
    // 路徑先後重用（有綁定時間）：Q 在 P 移除之後才綁定 → 只擁有之後的
    const seq = [
      { pid: 'P', encoded: 'C--E', boundAt: '2026-10-01T00:00:00.000Z', retiredAt: '2026-11-03T00:00:00.000Z' },
      { pid: 'Q', encoded: 'C--E', boundAt: '2026-11-04T00:00:00.000Z', retiredAt: '2026-11-06T00:00:00.000Z' },
    ];
    assert.deepEqual(['02', '05'].map((d) => [inWindows(at(d), sessionWindows(seq, 'P', 'C--E', undefined)), inWindows(at(d), sessionWindows(seq, 'Q', 'C--E', undefined))]), [[true, false], [false, true]]);
    // GRACE：移除後 60 秒內的寫入仍算舊專案；mtime 缺漏不算任何專案
    const g = sessionWindows(rows(['P', '07']), 'P', 'C--E', undefined);
    assert.ok(inWindows({ mtimeMs: D('07') + 59_000 }, g) && !inWindows({ mtimeMs: D('07') + 61_000 }, g));
    assert.ok(!inWindows({}, g) && !inWindows(null, g));
  });

  test('退役紀錄：同一個專案移除後又綁回來再移除，兩段分開保存', async () => {
    const { readRetired, retireBinding } = await import('../../src/core/retired.mjs');
    const local = path.join(root, 'retired-local-2');
    await retireBinding(local, { key: 'C--R', pid: 'P', encoded: 'C--R', boundAt: '2026-10-01T00:00:00.000Z' }, { now: Date.parse('2026-11-01T00:00:00Z') });
    await retireBinding(local, { key: 'C--R', pid: 'P', encoded: 'C--R', boundAt: '2026-11-04T00:00:00.000Z' }, { now: Date.parse('2026-11-05T00:00:00Z') });
    await retireBinding(local, { key: 'C--R', pid: 'P', encoded: 'C--R', boundAt: '2026-11-04T00:00:00.000Z' }, { now: Date.parse('2026-11-06T00:00:00Z') });
    const list = await readRetired(local);
    assert.deepEqual(list.map((b) => [b.boundAt, b.retiredAt]), [['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'], ['2026-11-04T00:00:00.000Z', '2026-11-06T00:00:00.000Z']], '同一筆綁定以最新為準，不同次綁定分開');
  });

  test('同一個資料夾換綁定方式時，綁定時間沿用第一次的', async () => {
    const dir = makeRepo(path.join(root, 'work', 'switch-method'));
    const p = (await eg.identity.bind(dir, { create: { name: '換方式' } })).pid;
    const bf = path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json');
    const enc = encodeProjectPath(dir);
    const all = JSON.parse(fs.readFileSync(bf, 'utf8'));
    // 模擬之前是設定檔綁定（key 不同），綁定時間是 30 天前
    const entry = all[enc];
    delete all[enc];
    all[`${enc}@abcdef12`] = { ...entry, method: 'settings', boundAt: '2026-10-01T00:00:00.000Z' };
    fs.writeFileSync(bf, JSON.stringify(all));
    await eg.identity.bind(dir, { pid: p });
    const now = JSON.parse(fs.readFileSync(bf, 'utf8'));
    const cur = Object.values(now).find((b) => b.pid === p && b.path && path.resolve(b.path).toLowerCase() === path.resolve(dir).toLowerCase());
    assert.equal(cur.boundAt, '2026-10-01T00:00:00.000Z');
    assert.equal(Object.values(now).filter((b) => b.pid === p).length, 1, '舊的那筆移除');
  });

  test('卡片過期（資料夾其實還在）時移除綁定不拆 junction', async () => {
    const dir = makeRepo(path.join(root, 'work', 'still-here'));
    await eg.identity.bind(dir, { create: { name: '還在' } });
    const enc = encodeProjectPath(dir);
    const memLink = path.join(m.claudeHome, 'projects', enc, 'memory');
    assert.equal(isLink(memLink), true);
    const r = await eg.apply({ action: 'forget-binding', args: { encoded: enc } });
    assert.equal(r.linkRemoved, false);
    assert.equal(isLink(memLink), true, '資料夾還在：連結不動');
  });
});
