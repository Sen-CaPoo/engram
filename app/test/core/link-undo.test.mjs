// 第二輪審查 #1(b)(c)：專案合併（H34 的 link-projects）之後按還原，要把這台電腦資料夾的記憶連結、settings.local.json、
// additionalDirectories 一起回到合併前；做不到的部分在還原結果的 partial 明確回報。卡片要看得懂風險。
// 用真的 git 資料夾與真的綁定（junction）。全部合成資料，不碰真實的 ~/.engram 與 ~/.claude。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { junctionState } from '../../src/core/identity.mjs';
import { isJunctionReadAllowed } from '../../src/core/claudesettings.mjs';
import { resolveHomes } from '../../src/core/paths.mjs';
import { readRetired, retireBinding } from '../../src/core/retired.mjs';
import { ageTree, machinePaths, makeBareRemote, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root; let m; let eg; let homes;

const bindingsOf = (e) => JSON.parse(fs.readFileSync(path.join(e.paths.vault, 'machines', e.machine.id, 'bindings.json'), 'utf8'));
const viewOf = (e, dir) => Object.values(bindingsOf(e)).find((v) => v.path && path.resolve(v.path).toLowerCase() === path.resolve(dir).toLowerCase());
const memLinkOf = (home, dir, e) => path.join(home, 'projects', viewOf(e, dir).encoded, 'memory');
const settingsLocal = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
const additionalDirs = (claudeHome) => [...(JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).permissions?.additionalDirectories ?? [])].sort();
const h34 = async (e, fromPid) => (await e.health()).find((f) => f.code === 'H34' && f.fix.args.from === fromPid);

/** 兩個遠端相同的專案（甲 3 筆記憶、乙 1 筆）：乙會被建議併進甲 */
async function twoProjects(e, home, name, remote = `https://github.com/example/${name}.git`) {
  const a = makeRepo(path.join(root, 'work', `${name}-main`), { remote });
  const b = makeRepo(path.join(root, 'work', `${name}-copy`), { remote });
  const ra = await e.identity.bind(a, { create: { name: `${name} 主要` } });
  const rb = await e.identity.bind(b, { create: { name: `${name} 另一份` } });
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(e.paths.vault, 'projects', ra.pid, 'memory', `a${i}.md`), memoryText({ name: `a${i}`, description: `主要 ${i}` }));
  fs.writeFileSync(path.join(e.paths.vault, 'projects', rb.pid, 'memory', 'b0.md'), memoryText({ name: 'b0', description: '另一份 0' }));
  ageTree(e.paths.vault);
  assert.equal((await e.sync({ network: false })).ok, true);
  return { a, b, ra, rb };
}

before(async () => {
  root = mkTmp('engram-linkundo-');
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '測試電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  homes = resolveHomes(m);
});
after(() => rmTmp(root));

describe('H34 卡片要讓使用者看得懂風險', () => {
  test('列出兩個專案各自的名稱、路徑、記憶筆數與判斷依據，說明樣板與 fork 也會符合；遠端完全相同是 medium', async () => {
    const { a, b, rb } = await twoProjects(eg, m.claudeHome, 'card');
    const card = await h34(eg, rb.pid);
    assert.equal(card.severity, 'medium');
    for (const s of ['card 另一份', 'card 主要', b, a, '3 筆記憶', '1 筆記憶', '完全相同', '同一個樣板或 fork', '其他電腦要各自檢查', '不確定是同一個專案就不要合併']) assert.ok((card.title + card.detail).includes(s), `卡片文字要有「${s}」：${card.detail}`);
    for (const s of ['card 另一份', 'card 主要', 'same template or fork', '3 memories', 'do not merge']) assert.ok((card.en.title + card.en.detail).includes(s), `英文要有「${s}」：${card.en.detail}`);
    assert.equal(card.fix.action, 'link-projects');
  });

  test('只有根 commit 相同、遠端不同：降成 low，並註明很可能是不同的專案（同一個樣板或 fork）', async () => {
    // 同一個樣板 clone 出來的兩個專案：根 commit 相同、遠端不同（各自推到自己的 repo）
    const tpl = makeRepo(path.join(root, 'work', 'tpl-base'), { files: { 'README.md': '# template\n', 'tpl.txt': 'x\n' } });
    const x = path.join(root, 'work', 'tpl-x');
    const y = path.join(root, 'work', 'tpl-y');
    const { git } = await import('./helpers.mjs');
    git(root, 'clone', '-q', tpl, x);
    git(root, 'clone', '-q', tpl, y);
    git(x, 'remote', 'set-url', 'origin', 'https://github.com/example/client-x.git');
    git(y, 'remote', 'set-url', 'origin', 'https://github.com/example/client-y.git');
    const rx = await eg.identity.bind(x, { create: { name: '客戶甲' } });
    const ry = await eg.identity.bind(y, { create: { name: '客戶乙' } });
    fs.writeFileSync(path.join(eg.paths.vault, 'projects', rx.pid, 'memory', 'x0.md'), memoryText({ name: 'x0', description: '甲' }));
    ageTree(eg.paths.vault);
    await eg.sync({ network: false });
    const card = (await eg.health()).find((f) => f.code === 'H34' && [rx.pid, ry.pid].includes(f.fix.args.from));
    assert.ok(card, '同一個樣板的兩個專案會出卡片');
    assert.equal(card.severity, 'low');
    assert.match(card.detail, /很可能是不同的專案/);
    assert.match(card.detail, /根 commit 相同、遠端不同/);
    assert.match(card.en.detail, /probably different projects/);
  });

  test('fork（共用 upstream、各自有 origin）：不是 remote 理由，降成 low 並說明像 fork', async () => {
    const { git } = await import('./helpers.mjs');
    const o = makeRepo(path.join(root, 'work', 'fk-orig'), { remote: 'https://github.com/example/app.git' });
    const f = path.join(root, 'work', 'fk-fork');
    git(root, 'clone', '-q', o, f);
    git(f, 'remote', 'set-url', 'origin', 'https://github.com/someone/app.git');
    git(f, 'remote', 'add', 'upstream', 'https://github.com/example/app.git');
    const ro = await eg.identity.bind(o, { create: { name: 'fk 原專案' } });
    const rf = await eg.identity.bind(f, { create: { name: 'fk 我的 fork' } });
    for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(eg.paths.vault, 'projects', ro.pid, 'memory', `o${i}.md`), memoryText({ name: `o${i}`, description: '原' }));
    ageTree(eg.paths.vault);
    await eg.sync({ network: false });
    const card = (await eg.health()).find((f) => f.code === 'H34' && [ro.pid, rf.pid].includes(f.fix.args.from));
    assert.ok(card);
    assert.equal(card.severity, 'low');
    assert.match(card.detail, /共用某個 git 遠端，但各自還有不同的遠端/);
    assert.doesNotMatch(card.detail, /完全相同/);
  });
});

describe('合併之後還原：記憶連結、settings.local.json、additionalDirectories 一起回到合併前', () => {
  test('有綁定的 from：apply → undo 之後綁定紀錄、記憶連結、settings.local.json 都回到 from，之後在那個資料夾寫的記憶回到原專案', async () => {
    const { a, b, ra, rb } = await twoProjects(eg, m.claudeHome, 'undo');
    const memLink = memLinkOf(m.claudeHome, b, eg);
    const before = { settings: settingsLocal(b).autoMemoryDirectory, dirs: additionalDirs(m.claudeHome), read: await isJunctionReadAllowed(homes, memLink) };
    assert.match(fs.readlinkSync(memLink), new RegExp(`${rb.pid}[\\\\/]memory$`), '前置：合併前連結指向另一份');
    assert.match(before.settings, new RegExp(rb.pid));
    assert.equal(before.read, true);

    const card = await h34(eg, rb.pid);
    const r = await eg.apply(card.fix);
    assert.equal(r.ok, true);
    // 合併之後連結指向目標（甲）
    assert.match(fs.readlinkSync(memLink), new RegExp(`${ra.pid}[\\\\/]memory$`));
    assert.match(settingsLocal(b).autoMemoryDirectory, new RegExp(ra.pid));

    const u = await eg.undo(r.undo.sha);
    assert.equal(u.ok, true);
    assert.equal(u.partial, undefined, '全部還原了就沒有 partial');
    assert.deepEqual(u.realigned.map((p) => path.resolve(p).toLowerCase()), [path.resolve(b).toLowerCase()], '回報接回去的資料夾');
    // 綁定紀錄
    assert.equal(viewOf(eg, b).pid, rb.pid);
    assert.equal(viewOf(eg, a).pid, ra.pid, '另一個專案的綁定不受影響');
    // 記憶連結、settings.local.json、additionalDirectories
    assert.match(fs.readlinkSync(memLink), new RegExp(`${rb.pid}[\\\\/]memory$`));
    assert.equal(junctionState(homes, viewOf(eg, b).encoded, rb.pid).state, 'ok');
    assert.equal(settingsLocal(b).autoMemoryDirectory, before.settings);
    assert.deepEqual(additionalDirs(m.claudeHome), before.dirs);
    assert.equal(await isJunctionReadAllowed(homes, memLink), true);
    // 專案登記與記憶
    assert.equal((await eg.projects.list()).find((p) => p.pid === rb.pid)?.pid, rb.pid, '被合併的專案又列出來了');
    assert.ok(fs.existsSync(path.join(eg.paths.vault, 'projects', rb.pid, 'memory', 'b0.md')));
    // 還原之後在那個資料夾寫的記憶回到原專案（不是目標專案）
    fs.writeFileSync(path.join(memLink, 'after-undo.md'), memoryText({ name: 'after-undo', description: '還原後寫的' }));
    assert.ok(fs.existsSync(path.join(eg.paths.vault, 'projects', rb.pid, 'memory', 'after-undo.md')), '寫進原專案');
    assert.ok(!fs.existsSync(path.join(eg.paths.vault, 'projects', ra.pid, 'memory', 'after-undo.md')), '沒有落進目標專案');
    assert.notEqual((await eg.sessionContext({ cwd: b })).binding.state, '綁定失效');
    assert.deepEqual((await eg.health()).filter((f) => f.code === 'H17'), [], '沒有記憶連結失效的卡片');
  });

  test('資料夾後來不見了：還原成功但 partial 明確回報沒接回去的路徑', async () => {
    const { b, rb } = await twoProjects(eg, m.claudeHome, 'gone', 'https://github.com/example/gone.git');
    const r = await eg.apply((await h34(eg, rb.pid)).fix);
    fs.rmSync(b, { recursive: true, force: true });
    const u = await eg.undo(r.undo.sha);
    assert.equal(u.ok, true);
    assert.deepEqual(u.realigned, []);
    assert.equal(u.partial.length, 1);
    assert.equal(u.partial[0].kind, 'folder-missing');
    assert.equal(path.resolve(u.partial[0].path).toLowerCase(), path.resolve(b).toLowerCase());
    assert.match(u.partial[0].message, /沒有重新接上/);
    assert.match(u.partial[0].en, /not reconnected/);
  });

  test('H17 的 rebind 在連結指向這個記憶庫裡別的專案時帶 force，修得好（另一台電腦還原了合併、這台的連結還指著目標）', async () => {
    const { b, ra, rb } = await twoProjects(eg, m.claudeHome, 'h17', 'https://github.com/example/h17.git');
    await eg.apply((await h34(eg, rb.pid)).fix);
    // 模擬另一台電腦還原了合併：同步下來的綁定紀錄與專案登記回到合併前，但這台資料夾的連結還指向目標
    const bf = path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json');
    const all = JSON.parse(fs.readFileSync(bf, 'utf8'));
    for (const v of Object.values(all)) if (path.resolve(v.path).toLowerCase() === path.resolve(b).toLowerCase()) v.pid = rb.pid;
    fs.writeFileSync(bf, JSON.stringify(all));
    const pj = path.join(eg.paths.vault, 'projects', rb.pid, 'project.json');
    const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
    delete p.mergedInto;
    fs.writeFileSync(pj, JSON.stringify(p));
    const memLink = memLinkOf(m.claudeHome, b, eg);
    assert.match(fs.readlinkSync(memLink), new RegExp(`${ra.pid}[\\\\/]memory$`), '前置：連結還指向目標');
    const card = (await eg.health()).find((f) => f.code === 'H17' && f.fix?.action === 'rebind' && path.resolve(f.fix.args.dir).toLowerCase() === path.resolve(b).toLowerCase());
    assert.ok(card, '出現記憶連結失效的卡片');
    assert.equal(card.fix.args.force, true, '連結指向別的 Engram 專案：帶 force');
    await eg.apply(card.fix);
    assert.match(fs.readlinkSync(memLink), new RegExp(`${rb.pid}[\\\\/]memory$`));
    assert.match(settingsLocal(b).autoMemoryDirectory, new RegExp(rb.pid));
    assert.deepEqual((await eg.health()).filter((f) => f.code === 'H17'), []);
  });
});

describe('已移除的舊綁定（對話回顧用，local/retired-bindings.json）跟著合併與還原（第三輪審查 D）', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const pidOf = async (enc) => (await readRetired(eg.paths.local)).find((x) => x.encoded === enc)?.pid;

  test('合併時改到目標、還原時改回原專案；本來就屬於目標的、別的專案的舊綁定不受影響', async () => {
    const { ra, rb } = await twoProjects(eg, m.claudeHome, 'retired');
    await retireBinding(eg.paths.local, { key: 'C--old-b', pid: rb.pid, encoded: 'C--old-b', path: 'C:\\old\\b', boundAt: at });
    await retireBinding(eg.paths.local, { key: 'C--old-a', pid: ra.pid, encoded: 'C--old-a', path: 'C:\\old\\a', boundAt: at });
    await retireBinding(eg.paths.local, { key: 'C--old-x', pid: 'someone-else-00000', encoded: 'C--old-x', boundAt: at });
    const r = await eg.apply((await h34(eg, rb.pid)).fix);
    assert.equal(await pidOf('C--old-b'), ra.pid, '合併時舊綁定改到目標（對話回顧才找得到那個資料夾的對話）');
    const u = await eg.undo(r.undo.sha);
    assert.equal(u.ok, true);
    assert.equal(await pidOf('C--old-b'), rb.pid, '還原之後舊綁定回到原專案');
    assert.equal(await pidOf('C--old-a'), ra.pid, '本來就屬於目標的不動');
    assert.equal(await pidOf('C--old-x'), 'someone-else-00000', '別的專案的不動');
    assert.equal(u.retiredRestored, 1);
    assert.equal(u.partial, undefined, '全部還原了就沒有 partial');
  });

  test('沒有舊綁定的合併：還原結果沒有 retiredRestored；沒有紀錄的舊合併也不會出錯', async () => {
    const { rb } = await twoProjects(eg, m.claudeHome, 'noretired');
    const r = await eg.apply((await h34(eg, rb.pid)).fix);
    const u = await eg.undo(r.undo.sha);
    assert.equal(u.ok, true);
    assert.equal('retiredRestored' in u, false);
    assert.equal(u.partial, undefined);
  });

  test('舊綁定在合併之後被清掉：還原成功，但 partial 明確回報有幾筆舊綁定沒改回去', async () => {
    const { rb } = await twoProjects(eg, m.claudeHome, 'retired2');
    await retireBinding(eg.paths.local, { key: 'C--old-c', pid: rb.pid, encoded: 'C--old-c', boundAt: at });
    await retireBinding(eg.paths.local, { key: 'C--old-d', pid: rb.pid, encoded: 'C--old-d', boundAt: at });
    const r = await eg.apply((await h34(eg, rb.pid)).fix);
    // 合併之後其中一筆被清掉（Claude Code 清理了舊資料夾的對話、或又被移除）
    const file = path.join(eg.paths.local, 'retired-bindings.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...j, bindings: j.bindings.filter((b) => b.encoded !== 'C--old-d') }));
    const u = await eg.undo(r.undo.sha);
    assert.equal(u.ok, true);
    assert.equal(await pidOf('C--old-c'), rb.pid, '還在的那筆改回去了');
    assert.equal(u.retiredRestored, 1);
    const p = u.partial.find((x) => x.kind === 'retired-bindings');
    assert.ok(p, JSON.stringify(u.partial));
    assert.match(p.message, /1 筆已移除的舊綁定/);
    assert.match(p.en, /1 removed old binding/);
  });
});

describe('另一台電腦做的合併：這台還原時 partial 回報，那台同步後用卡片修好', () => {
  test('B 還原 A 做的合併：partial 是 other-machine；A 同步之後 H17 卡片帶 force，套用後連結回到原專案', async () => {
    const r2 = mkTmp('engram-linkundo-2-');
    try {
      const remote = makeBareRemote(path.join(r2, 'remote.git'));
      const cli = writeDriverCli(r2);
      const mA = machinePaths(r2, 'office');
      const mB = machinePaths(r2, 'home');
      await init({ ...mA, machineLabel: '公司電腦', remote, cli });
      const A = await open(mA);
      assert.equal((await A.sync()).ok, true);
      await init({ ...mB, machineLabel: '家裡電腦', remote, cli });
      const B = await open(mB);
      assert.equal((await B.sync()).ok, true);
      await A.sync();

      const a = makeRepo(path.join(r2, 'work', 'x-main'), { remote: 'https://github.com/example/x.git' });
      const b = makeRepo(path.join(r2, 'work', 'x-copy'), { remote: 'https://github.com/example/x.git' });
      const ra = await A.identity.bind(a, { create: { name: 'X 主要' } });
      const rb = await A.identity.bind(b, { create: { name: 'X 另一份' } });
      for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(A.paths.vault, 'projects', ra.pid, 'memory', `a${i}.md`), memoryText({ name: `a${i}`, description: `主要 ${i}` }));
      fs.writeFileSync(path.join(A.paths.vault, 'projects', rb.pid, 'memory', 'b0.md'), memoryText({ name: 'b0', description: '另一份' }));
      ageTree(A.paths.vault);
      assert.equal((await A.sync()).ok, true);
      const card = (await A.health()).find((f) => f.code === 'H34' && f.fix.args.from === rb.pid);
      const linked = await A.apply(card.fix);
      ageTree(A.paths.vault);
      assert.equal((await A.sync()).ok, true);

      ageTree(B.paths.vault);
      assert.equal((await B.sync()).ok, true);
      const u = await B.undo(linked.undo.sha);
      assert.equal(u.ok, true);
      assert.equal(u.partial.length, 1);
      assert.equal(u.partial[0].kind, 'other-machine');
      assert.match(u.partial[0].message, /已移除的舊綁定/, '那台電腦上的舊綁定也留在那台電腦，要說清楚');
      assert.equal(u.partial[0].machine, A.machine.id);
      assert.deepEqual(u.realigned, []);
      ageTree(B.paths.vault);
      assert.equal((await B.sync()).ok, true);

      ageTree(A.paths.vault);
      assert.equal((await A.sync()).ok, true);
      const link = path.join(mA.claudeHome, 'projects', viewOf(A, b).encoded, 'memory');
      assert.match(fs.readlinkSync(link), new RegExp(`${ra.pid}[\\\\/]memory$`), '前置：A 的連結還指向目標');
      const fix = (await A.health()).find((f) => f.code === 'H17' && f.fix?.action === 'rebind')?.fix;
      assert.equal(fix?.args.force, true);
      await A.apply(fix);
      assert.match(fs.readlinkSync(link), new RegExp(`${rb.pid}[\\\\/]memory$`));
      assert.match(settingsLocal(b).autoMemoryDirectory, new RegExp(rb.pid));
    } finally {
      rmTmp(r2);
    }
  });
});
