// S4 專案生命週期：休眠（任何電腦都沒有綁定、最近 90 天沒有對話的跡象）與疑似同一個專案的合併建議（H34）。
// 全部用合成資料與沙盒引擎，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { DORMANT_DAYS, projectLifecycles } from '../../src/core/lifecycle.mjs';
import { retireBinding } from '../../src/core/retired.mjs';
import { dreamTargets } from '../../src/autopilot/tasks/dream.mjs';
import { planScopes } from '../../src/autopilot/tasks/curate.mjs';
import { localDate } from '../../src/core/usage.mjs';
import { ageTree, machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
let root; let m; let eg;

const vault = () => eg.paths.vault;
const projectFile = (pid) => path.join(vault(), 'projects', pid, 'project.json');
const memDir = (pid) => path.join(vault(), 'projects', pid, 'memory');
const readProjectJson = (pid) => JSON.parse(fs.readFileSync(projectFile(pid), 'utf8'));

/** 在記憶庫直接建一個專案（不經過綁定）：預設 120 天前建立、沒有任何跡象 */
function addProject(pid, { name = pid, remotes = [], rootCommits = [], createdAt = ago(120), mems = 0, archived = false, memBody } = {}) {
  fs.mkdirSync(memDir(pid), { recursive: true });
  fs.writeFileSync(projectFile(pid), `${JSON.stringify({ id: pid, name, aliases: [], remotes, rootCommits, archived, createdAt, updatedAt: createdAt }, null, 2)}\n`);
  for (let i = 0; i < mems; i++) {
    fs.writeFileSync(path.join(memDir(pid), `${pid}-m${i}.md`), memoryText({ name: `${pid}-m${i}`, description: `${name} 的第 ${i} 筆`, type: 'project', body: memBody ?? `${name} 第 ${i} 筆的內容。` }));
  }
}

/** 另一台電腦的綁定（直接寫進記憶庫，模擬同步過來的） */
function addMachineBindings(mid, pids) {
  const dir = path.join(vault(), 'machines', mid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ id: mid, label: `電腦 ${mid}`, hostname: `host-${mid}` }));
  const b = {};
  for (const pid of pids) b[`C--${mid}-${pid}`] = { pid, path: `C:\\work\\${mid}\\${pid}`, encoded: `C--${mid}-${pid}`, method: 'settings', state: 'active', boundAt: ago(10), lastOpenedAt: ago(1) };
  fs.writeFileSync(path.join(dir, 'bindings.json'), JSON.stringify(b));
}
const removeMachine = (mid) => fs.rmSync(path.join(vault(), 'machines', mid), { recursive: true, force: true });

const life = async (pid) => (await projectLifecycles(engineCtx())).get(pid);
// projectLifecycles 只需要 ctx 的 vault、local、mid：從引擎的路徑組出來
const engineCtx = () => ({ vault: vault(), local: eg.paths.local, mid: eg.machine.id, homes: { claudeHome: eg.paths.claudeHome } });

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '測試電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
});
after(() => rmTmp(root));

describe('S4 休眠', () => {
  test('有綁定的專案永遠不休眠（即使建立很久、沒有任何跡象）', async () => {
    const repo = makeRepo(path.join(root, 'work', 'alive'));
    const { pid } = await eg.identity.bind(repo, { create: { name: '使用中' } });
    const p = readProjectJson(pid);
    fs.writeFileSync(projectFile(pid), JSON.stringify({ ...p, createdAt: ago(400), updatedAt: ago(400) }));
    const l = await life(pid);
    assert.equal(l.dormant, false);
    assert.deepEqual(l.boundOn, [eg.machine.id]);
    assert.equal((await eg.projects.get(pid)).dormant, false);
  });

  test('另一台電腦有綁定也算有綁定', async () => {
    addProject('elsewhere-bound');
    assert.equal((await life('elsewhere-bound')).dormant, true, '前置：沒有綁定就休眠');
    addMachineBindings('other', ['elsewhere-bound']);
    const l = await life('elsewhere-bound');
    assert.equal(l.dormant, false);
    assert.deepEqual(l.boundOn, ['other']);
    removeMachine('other');
    assert.equal((await life('elsewhere-bound')).dormant, true);
  });

  test('沒有綁定：90 天沒有任何跡象才休眠；新建立的專案、最近退役的舊綁定、最近被讀過記憶都不休眠', async () => {
    addProject('ancient');
    addProject('fresh', { createdAt: ago(10) });
    addProject('almost', { createdAt: ago(DORMANT_DAYS - 2) });
    addProject('edge', { createdAt: ago(DORMANT_DAYS + 1) });
    const all = await projectLifecycles(engineCtx());
    assert.equal(all.get('ancient').dormant, true);
    assert.equal(all.get('fresh').dormant, false);
    assert.equal(all.get('almost').dormant, false);
    assert.equal(all.get('edge').dormant, true);
    assert.ok(Date.now() - Date.parse(all.get('ancient').lastActiveAt) >= 119 * DAY, 'lastActiveAt 是最晚的跡象（這裡是建立時間）');

    // 這台電腦最近退役過它的舊綁定（例如 H04 移除舊綁定）
    addProject('retired-recently');
    await retireBinding(eg.paths.local, { key: 'C--gone', pid: 'retired-recently', encoded: 'C--gone' }, { now: Date.now() - 10 * DAY });
    assert.equal((await life('retired-recently')).dormant, false);
    addProject('retired-long-ago');
    await retireBinding(eg.paths.local, { key: 'C--gone2', pid: 'retired-long-ago', encoded: 'C--gone2' }, { now: Date.now() - 100 * DAY });
    assert.equal((await life('retired-long-ago')).dormant, true);

    // 各台電腦同步來的讀取統計：這個專案的記憶最近被讀過（有對話讀了它）
    addProject('read-recently', { mems: 1 });
    fs.mkdirSync(path.join(vault(), 'machines', 'other'), { recursive: true });
    fs.writeFileSync(path.join(vault(), 'machines', 'other', 'usage.json'), JSON.stringify({ since: localDate(Date.now() - 30 * DAY), refs: { 'projects/read-recently/memory/read-recently-m0.md': { reads: 2, days: 1, last: localDate(Date.now() - 20 * DAY), projects: { 'read-recently': 2 } } } }));
    assert.equal((await life('read-recently')).dormant, false);
    fs.writeFileSync(path.join(vault(), 'machines', 'other', 'usage.json'), JSON.stringify({ since: localDate(Date.now() - 200 * DAY), refs: { 'projects/read-recently/memory/read-recently-m0.md': { reads: 2, days: 1, last: localDate(Date.now() - 150 * DAY), projects: {} } } }));
    assert.equal((await life('read-recently')).dormant, true, '讀取統計在 90 天以前就不算');
    removeMachine('other');
  });

  test('專案檔連建立時間都沒有（舊資料、手動建立）：無從證明 90 天沒有對話，不休眠', async () => {
    fs.mkdirSync(memDir('no-dates'), { recursive: true });
    fs.writeFileSync(projectFile('no-dates'), JSON.stringify({ id: 'no-dates', name: 'no-dates', aliases: [], remotes: [], rootCommits: [], archived: false }));
    const l = await life('no-dates');
    assert.equal(l.dormant, false);
    assert.equal(l.lastActiveAt, null);
  });

  test('eg.projects.list／get 帶 dormant；includeDormant: false 不含休眠的；記憶照常列出與搜尋', async () => {
    addProject('sleepy', { mems: 2, name: '沉睡專案', memBody: '關於夢遊鸚鵡的紀錄。' });
    const all = await eg.projects.list();
    const sleepy = all.find((p) => p.pid === 'sleepy');
    assert.equal(sleepy.dormant, true);
    assert.equal(typeof sleepy.lastActiveAt, 'string');
    assert.equal(all.find((p) => p.name === '使用中').dormant, false);
    assert.equal('lastActiveAt' in all.find((p) => p.name === '使用中'), false, '有綁定的專案沒有 lastActiveAt');
    assert.ok(!(await eg.projects.list({ includeDormant: false })).some((p) => p.pid === 'sleepy'));
    assert.equal((await eg.projects.get('sleepy')).dormant, true);
    assert.equal((await eg.memories.list({ pid: 'sleepy' })).length, 2, '記憶完整保留');
    assert.ok((await eg.search('夢遊鸚鵡')).some((h) => /^projects\/sleepy\//.test(h.ref)), '照常搜尋');
  });

  test('重新綁定就恢復；專案檔沒有被改（休眠是算出來的）', async () => {
    const before = fs.readFileSync(projectFile('sleepy'), 'utf8');
    assert.equal((await life('sleepy')).dormant, true);
    assert.equal(fs.readFileSync(projectFile('sleepy'), 'utf8'), before, '算休眠不改專案檔');
    const repo = makeRepo(path.join(root, 'work', 'revive'));
    await eg.identity.bind(repo, { pid: 'sleepy' });
    assert.equal((await life('sleepy')).dormant, false);
    assert.equal((await eg.projects.get('sleepy')).dormant, false);
  });
});

describe('S4 休眠專案不參與健康檢查', () => {
  const token = `ghp_${'Zx3Cv5Bn7M'.repeat(4)}`;
  const forRef = async (ref) => (await eg.health()).filter((f) => f.refs.includes(ref));

  test('整理類的檢查（檔案過大）不出卡片；金鑰（H13）照出；重新綁定後整理類檢查恢復', async () => {
    addProject('napping');
    fs.writeFileSync(path.join(memDir('napping'), 'big-one.md'), memoryText({ name: 'big-one', description: '很大的一筆', type: 'project', body: 'x'.repeat(21_000) }));
    fs.writeFileSync(path.join(memDir('napping'), 'has-secret.md'), memoryText({ name: 'has-secret', description: '含金鑰', type: 'project', body: `token: ${token}` }));
    assert.equal((await life('napping')).dormant, true);
    const bigRef = 'projects/napping/memory/big-one.md';
    const secretRef = 'projects/napping/memory/has-secret.md';
    assert.deepEqual((await forRef(bigRef)).map((f) => f.code), [], '休眠專案的記憶不出整理類卡片');
    assert.deepEqual((await forRef(secretRef)).map((f) => f.code), ['H13'], '金鑰檢查是安全類，休眠也要做');
    // 對照：同樣的檔案在使用中的專案會出 H10
    const repo = makeRepo(path.join(root, 'work', 'wake'));
    await eg.identity.bind(repo, { pid: 'napping' });
    assert.equal((await life('napping')).dormant, false);
    assert.ok((await forRef(bigRef)).some((f) => f.code === 'H10'), '恢復之後照常檢查');
  });

  test('休眠專案的索引超過上限也不出 H01', async () => {
    addProject('long-index');
    const lines = Array.from({ length: 210 }, (_, i) => `- [記憶 ${i}](m${i}.md) — 說明 ${i}`).join('\n');
    fs.writeFileSync(path.join(memDir('long-index'), 'MEMORY.md'), `${lines}\n`);
    assert.equal((await eg.health()).some((f) => f.code === 'H01' && f.pid === 'long-index'), false);
  });
});

describe('S4 自動駕駛不處理休眠的專案', () => {
  test('planScopes 不整理休眠的專案；使用中的專案照常列入', async () => {
    addProject('dormant-scope', { mems: 1 });
    addProject('live-scope', { createdAt: ago(5), mems: 1 });
    const scopes = await planScopes({ eg, mid: eg.machine.id, findings: [], now: Date.now() });
    const keys = scopes.map((s) => s.key);
    assert.ok(!keys.includes('project:dormant-scope'), keys.join(','));
    assert.ok(keys.includes('project:live-scope'), keys.join(','));
  });

  test('dreamTargets 不回顧休眠的專案（即使引擎仍回報有還沒回顧的對話）', async () => {
    const bindings = path.join(vault(), 'machines', eg.machine.id, 'bindings.json');
    const saved = fs.readFileSync(bindings, 'utf8');
    try {
      fs.writeFileSync(bindings, JSON.stringify({
        'C--a': { pid: 'pa', path: 'C:\\a', encoded: 'C--a', method: 'settings', state: 'active', boundAt: ago(5) },
        'C--b': { pid: 'pb', path: 'C:\\b', encoded: 'C--b', method: 'settings', state: 'active', boundAt: ago(5) },
      }));
      const fake = {
        paths: { vault: vault() },
        machine: { id: eg.machine.id },
        dream: { status: async () => ({ pending: 2, expiresInDays: 5 }) },
        projects: { list: async () => [{ pid: 'pa', name: 'A', dormant: true }, { pid: 'pb', name: 'B', dormant: false }] },
      };
      assert.deepEqual((await dreamTargets({ eg: fake })).map((t) => t.pid), ['pb']);
    } finally {
      fs.writeFileSync(bindings, saved);
    }
  });
});

describe('S4 H34：疑似同一個專案的多個代號', () => {
  const REMOTE = 'github.com/example/demo-app';
  const cards = async () => (await eg.health()).filter((f) => f.code === 'H34');
  const pairOf = (f) => `${f.fix.args.from}>${f.fix.args.to}`;

  test('相同的 git 遠端：記憶多的留下，另一個建議合併過去；沒有共同遠端或根 commit 的不建議', async () => {
    addProject('dup-a', { name: '示範應用', remotes: [REMOTE], mems: 3, createdAt: ago(30) });
    addProject('dup-b', { name: '示範應用（舊代號）', remotes: [REMOTE], mems: 1, createdAt: ago(60) });
    addProject('unrelated', { remotes: ['github.com/example/other'], mems: 1, createdAt: ago(30) });
    const c = (await cards()).filter((f) => /^dup-/.test(f.fix.args.from));
    assert.equal(c.length, 1);
    assert.equal(pairOf(c[0]), 'dup-b>dup-a');
    assert.equal(c[0].severity, 'medium', '遠端完全相同：把握最高');
    assert.equal(c[0].fix.action, 'link-projects');
    assert.equal(c[0].pid, 'dup-b');
    assert.match(c[0].title, /示範應用（舊代號）.*示範應用/);
    assert.match(c[0].detail, /git 遠端完全相同/);
    assert.match(c[0].en.title, /may be the same project/);
    assert.ok(!(await cards()).some((f) => /unrelated/.test(JSON.stringify(f.fix))));
    // 兩次算出來的卡片一樣（id 穩定，忽略才有效）
    assert.equal((await cards()).find((f) => f.fix.args.from === 'dup-b').id, c[0].id);
  });

  test('只有根 commit 相同：也建議，但說明 fork 不是同一個專案', async () => {
    addProject('fork-a', { rootCommits: ['a'.repeat(40)], mems: 2, createdAt: ago(30) });
    addProject('fork-b', { rootCommits: ['a'.repeat(40)], mems: 1, createdAt: ago(30) });
    const c = (await cards()).find((f) => f.fix.args.from === 'fork-b');
    assert.equal(c.fix.args.to, 'fork-a');
    assert.equal(c.severity, 'low');
    assert.match(c.detail, /根 commit 相同、遠端不同.*很可能是不同的專案/);
    assert.match(c.detail, /同一個樣板或 fork/);
  });

  test('被越多台電腦綁定的專案優先留下；from 在別台電腦也有綁定時不建議（link 只會改這台的綁定）', async () => {
    addProject('bound-a', { remotes: ['github.com/example/bound'], mems: 1 });
    addProject('bound-b', { remotes: ['github.com/example/bound'], mems: 5 });
    // 記憶多的 bound-b 原本會留下；bound-a 被兩台電腦綁定 → 改成留下 bound-a
    addMachineBindings('pc1', ['bound-a']);
    addMachineBindings('pc2', ['bound-a']);
    let c = (await cards()).filter((f) => /^bound-/.test(f.fix.args.from));
    assert.deepEqual(c.map(pairOf), ['bound-b>bound-a']);
    // bound-b 也被別台電腦（pc3）綁定：它是 from，別台有綁定 → 這台不建議（那台自己會看到）
    addMachineBindings('pc3', ['bound-b']);
    c = (await cards()).filter((f) => /^bound-/.test(f.fix.args.from));
    assert.deepEqual(c, []);
    for (const mid of ['pc1', 'pc2', 'pc3']) removeMachine(mid);
  });

  test('已經合併過的、封存的都不干擾；休眠的專案仍會被建議合併', async () => {
    addProject('arch-a', { remotes: ['github.com/example/arch'], mems: 2, archived: true });
    addProject('arch-b', { remotes: ['github.com/example/arch'], mems: 2 });
    const c = (await cards()).find((f) => /^arch-/.test(f.fix.args.from));
    assert.equal(pairOf(c), 'arch-a>arch-b', '沒有封存的優先留下');
    assert.equal((await life('arch-a')).dormant, true, '兩個都在休眠，仍然建議合併');
  });

  test('eg.apply link-projects：只接受引擎算出來的建議；合併之後記憶搬到目標、卡片消失、可以還原', async () => {
    const card = (await cards()).find((f) => f.fix.args.from === 'dup-b');
    // 手動建的專案要先存檔（commit）：還原是退回 link 的那個 commit，沒存過的檔案會跟著消失
    ageTree(vault());
    assert.equal((await eg.sync({ network: false })).ok, true);
    await assert.rejects(eg.apply({ action: 'link-projects', args: { from: 'dup-a', to: 'dup-b' } }), (e) => e.code === 'E_INVALID', '方向相反不接受');
    await assert.rejects(eg.apply({ action: 'link-projects', args: { from: 'unrelated', to: 'dup-a' } }), (e) => e.code === 'E_INVALID');
    await assert.rejects(eg.apply({ action: 'link-projects', args: { from: '../x', to: 'dup-a' } }), (e) => e.code === 'E_INVALID' || e.code === 'E_NOT_FOUND');
    const r = await eg.apply(card.fix);
    assert.equal(r.ok, true);
    assert.equal(readProjectJson('dup-b').mergedInto, 'dup-a');
    assert.equal((await eg.memories.list({ pid: 'dup-a' })).length, 4, '記憶合併進目標專案');
    assert.ok(!(await cards()).some((f) => f.fix.args.from === 'dup-b'));
    assert.ok(!(await eg.projects.list()).some((p) => p.pid === 'dup-b'), '被合併的專案不再列出');
    assert.ok(r.undo?.sha, '可以還原');
    await eg.undo(r.undo.sha);
    assert.equal(readProjectJson('dup-b').mergedInto, undefined);
    assert.ok((await cards()).some((f) => f.fix.args.from === 'dup-b'), '還原之後建議回來');
  });
});
