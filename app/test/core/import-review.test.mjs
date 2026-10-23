// 第二台電腦匯入前的修正（40 號 v0.7.2）在對抗式審查中發現的情境：每一項都先在修正前的程式重現失敗。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { contentPathFor } from '../../src/core/sweep.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { isLink, linkTarget } from '../../src/core/fsx.mjs';
import { addTranscript, git, machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';
import { planImport, rehearseImport } from '../../src/migrate/index.mjs';

const mem = (dir, file, opts) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), memoryText(opts)); };
const failCommits = (vault) => {
  const hook = path.join(vault, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho injected >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  return () => fs.rmSync(hook, { force: true });
};

async function machine(prefix, label = '測試', { mode = 'auto' } = {}) {
  const root = mkTmp(prefix);
  const cli = writeDriverCli(root);
  const m = machinePaths(root, 'pc', { mode });
  await init({ ...m, machineLabel: label, cli });
  return { root, m, e: await open(m) };
}

describe('綁定中途失敗的撤銷', () => {
  test('重新綁定失敗時，資料夾原本就有的綁定（設定檔、junction、綁定表）原封不動', async () => {
    const { root, m, e } = await machine('engram-rb1-');
    try {
      const repo = makeRepo(path.join(m.userHome, 'Desktop', 'shop'));
      const t = addTranscript(m.claudeHome, repo);
      mem(path.join(t.dir, 'memory'), 'rule.md', { name: 'rule', description: '規則' });
      const first = await e.identity.bind(repo, {});
      assert.equal(first.method, 'junction');
      const settings = path.join(repo, '.claude', 'settings.local.json');
      const settingsBefore = fs.readFileSync(settings, 'utf8');
      const bindingsFile = path.join(e.paths.vault, 'machines', e.machine.id, 'bindings.json');
      const bindingsBefore = fs.readFileSync(bindingsFile, 'utf8');
      const memDir = path.join(t.dir, 'memory');
      const targetBefore = linkTarget(memDir);

      const restore = failCommits(e.paths.vault);
      await assert.rejects(e.identity.bind(repo, { pid: first.pid }));
      restore();
      assert.equal(fs.readFileSync(settings, 'utf8'), settingsBefore, '設定檔逐位元不變（仍指向 vault）');
      assert.equal(fs.readFileSync(bindingsFile, 'utf8'), bindingsBefore);
      assert.ok(isLink(memDir), 'junction 仍在');
      assert.equal(linkTarget(memDir), targetBefore);
      assert.equal(git(e.paths.vault, 'diff', '--cached', '--name-only').trim(), '', 'git index 沒有殘留');
    } finally { rmTmp(root); }
  });

  test('建立新專案的綁定在 commit 失敗後：資料夾與 vault 都回到綁定前，下一個 commit 不會帶出幽靈專案', async () => {
    const { root, m, e } = await machine('engram-rb2-');
    try {
      const dir = path.join(m.userHome, 'Desktop', 'notes');
      fs.mkdirSync(dir, { recursive: true });
      const restore = failCommits(e.paths.vault);
      await assert.rejects(e.identity.bind(dir, { create: { name: 'notes' } }));
      restore();
      assert.equal(fs.existsSync(path.join(dir, '.claude')), false, '標記檔、設定檔與 .claude 都移除');
      assert.equal(git(e.paths.vault, 'diff', '--cached', '--name-only').trim(), '', 'git index 沒有殘留');
      assert.equal((await e.projects.list()).length, 0);
      await e.memories.create({ scope: { kind: 'global' }, name: 'later', type: 'reference', description: '之後的記憶', body: 'x' });
      assert.doesNotMatch(git(e.paths.vault, 'show', '--name-only', '--format=', 'HEAD'), /projects\/|bindings\.json/, '下一個 commit 只含它自己');
    } finally { rmTmp(root); }
  });
});

describe('還原到匯入前', () => {
  test('同一個編碼資料夾拆成「孤兒（全域）」與「現存、接到既有專案」兩個來源：還原不會經由 junction 把孤兒的記憶寫進那個專案', async () => {
    const { root, m, e } = await machine('engram-rb3-');
    try {
      const remote = 'https://example.com/team/app.git';
      const desk = path.join(m.userHome, 'Desktop');
      // 既有專案：同一個 remote 的另一份 clone 先綁定
      const other = makeRepo(path.join(desk, 'clone-two'), { remote });
      const first = await e.identity.bind(other, {});
      // 現存的資料夾（四個字），對話紀錄只有它；同一個記憶資料夾裡另一筆寫的是已不存在的「乙方專案」
      const live = makeRepo(path.join(desk, '甲方專案'), { remote });
      const t = addTranscript(m.claudeHome, live);
      const memDir = path.join(t.dir, 'memory');
      mem(memDir, '0-b.md', { name: 'b-pref', description: '乙方偏好', type: 'user', body: `來自 ${path.join(desk, '乙方專案')}\\。` });
      mem(memDir, '1-a.md', { name: 'a-note', description: '甲方筆記' });
      const plan = await e.sweepLegacy({ dryRun: true });
      assert.equal(plan.sources.length, 2);
      assert.equal(plan.sources[0].resolvedPath.toLowerCase(), path.join(desk, '乙方專案').toLowerCase(), '測試前提：孤兒來源排在前面');
      assert.equal(plan.sources[1].target.pid, first.pid, '測試前提：現存資料夾接到既有專案');
      const r = await e.sweepLegacy({ dryRun: false, plan });
      assert.ok(isLink(memDir));
      await e.rollbackImport(r.restorePoint);
      assert.equal(isLink(memDir), false);
      assert.deepEqual(fs.readdirSync(memDir).filter((f) => f !== 'MEMORY.md').sort(), ['0-b.md', '1-a.md']);
      assert.doesNotMatch(git(e.paths.vault, 'ls-files', `projects/${first.pid}`), /0-b\.md|1-a\.md/, '既有專案沒有被寫進匯入的記憶');
      assert.equal(git(e.paths.vault, 'status', '--porcelain').trim(), '');
    } finally { rmTmp(root); }
  });

  test('演練與還原不會刪掉資料夾裡本來就有的標記檔（沒有綁定的來源）', async () => {
    const { root, m, e } = await machine('engram-rb4-');
    try {
      const dir = path.join(m.userHome, 'Desktop', 'kept');
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      const marker = path.join(dir, '.claude', 'engram.json');
      fs.writeFileSync(marker, '{"pid":"someone-else"}');
      const t = addTranscript(m.claudeHome, dir);
      mem(path.join(t.dir, 'memory'), 'k.md', { name: 'k', description: '保留' });
      const r = await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }), bindSources: false });
      await e.rollbackImport(r.restorePoint);
      assert.equal(fs.readFileSync(marker, 'utf8'), '{"pid":"someone-else"}');
    } finally { rmTmp(root); }
  });
});

describe('收編計畫', () => {
  test('內文路徑：git 子資料夾、只差在英數符號的路徑不會蓋掉對話紀錄的判斷', async () => {
    const { root, m, e } = await machine('engram-cp1-');
    try {
      const desk = path.join(m.userHome, 'Desktop');
      makeRepo(path.join(desk, 'engram'));
      fs.mkdirSync(path.join(desk, 'engram', 'app', 'src'), { recursive: true });
      const appRepo = makeRepo(path.join(desk, 'engram-app'));
      assert.equal(encodeProjectPath(appRepo), encodeProjectPath(path.join(desk, 'engram', 'app')), '測試前提：編碼相同');
      const t1 = addTranscript(m.claudeHome, appRepo);
      mem(path.join(t1.dir, 'memory'), 'types.md', { name: 'types', description: '型別', body: `參考 ${path.join(desk, 'engram', 'app', 'src', 'types.ts')} 的寫法。` });
      assert.equal(contentPathFor(`${path.join(desk, 'engram', 'app', 'src', 'types.ts')}`, encodeProjectPath(appRepo), m.userHome), null, 'git 子資料夾不算');
      // 只有對話紀錄的資料夾存在；內文提到的是只差在符號、已不存在的路徑
      const ab = path.join(desk, 'a-b');
      fs.mkdirSync(ab, { recursive: true });
      const t2 = addTranscript(m.claudeHome, ab);
      mem(path.join(t2.dir, 'memory'), 'ab.md', { name: 'ab', description: 'ab', body: `舊稿在 ${path.join(desk, 'a_b', 'old.md')}。` });

      const plan = await e.sweepLegacy({ dryRun: true });
      const of = (file) => plan.sources.find((s) => s.items.some((i) => i.file === file));
      assert.equal(of('types.md').resolvedPath.toLowerCase(), appRepo.toLowerCase());
      assert.equal(of('types.md').how, 'transcript-cwd');
      assert.equal(of('ab.md').resolvedPath.toLowerCase(), ab.toLowerCase());
      assert.ok(!fs.existsSync(path.join(desk, 'engram', '.claude')), '不相干的 repo 沒有被碰到');
    } finally { rmTmp(root); }
  });

  test('內文路徑的寫法：中文字緊接磁碟代號、Git Bash 的 /c/…', () => {
    const home = 'C:\\Users\\Someone';
    const enc = encodeProjectPath('C:\\Users\\Someone\\Desktop\\甲方報告');
    assert.equal(contentPathFor('簡報放在C:\\Users\\Someone\\Desktop\\甲方報告\\a.html', enc, home)?.toLowerCase(), 'c:\\users\\someone\\desktop\\甲方報告');
    assert.equal(contentPathFor('cd /c/Users/Someone/Desktop/甲方報告/src', enc, home)?.toLowerCase(), 'c:\\users\\someone\\desktop\\甲方報告');
  });

  test('已經收編、內容沒變的記憶不再列入計畫；改過的才列入', async () => {
    const { root, m, e } = await machine('engram-cp2-');
    try {
      const desk = path.join(m.userHome, 'Desktop');
      // 孤兒來源（不會綁定，原資料夾保留）＋撞名資料夾（只用設定檔，原資料夾保留）
      const enc = encodeProjectPath(path.join(desk, 'Gone'));
      mem(path.join(m.claudeHome, 'projects', enc, 'memory'), 'gone.md', { name: 'gone', description: '孤兒' });
      const a = path.join(desk, '甲方專案');
      const b = path.join(desk, '乙方專案');
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      const ta = addTranscript(m.claudeHome, a, { sessionId: 'sa' });
      addTranscript(m.claudeHome, b, { sessionId: 'sb' });
      mem(path.join(ta.dir, 'memory'), 'a.md', { name: 'a', description: '甲方', originSessionId: 'sa' });
      const first = await e.sweepLegacy({ dryRun: true });
      assert.equal(first.sources.length, 2);
      await e.sweepLegacy({ dryRun: false, plan: first });
      assert.deepEqual((await e.sweepLegacy({ dryRun: true })).sources, [], '匯入後再產生計畫：沒有東西要匯入');
      mem(path.join(ta.dir, 'memory'), 'a2.md', { name: 'a2', description: '之後才寫', originSessionId: 'sa' });
      const again = await e.sweepLegacy({ dryRun: true });
      assert.deepEqual(again.sources.flatMap((s) => s.items.map((i) => i.file)), ['a2.md']);
    } finally { rmTmp(root); }
  });
});

describe('第二輪審查', () => {
  test('綁定到既有專案、複製記憶後 commit 失敗：專案的 MEMORY.md、原記憶資料夾、exclude 都回到綁定前', async () => {
    const { root, m, e } = await machine('engram-r2a-');
    try {
      const desk = path.join(m.userHome, 'Desktop');
      const base = makeRepo(path.join(desk, 'base'));
      const tb = addTranscript(m.claudeHome, base);
      mem(path.join(tb.dir, 'memory'), 'b.md', { name: 'b', description: '既有' });
      const first = await e.identity.bind(base, {});
      const idx = path.join(e.paths.vault, 'projects', first.pid, 'memory', 'MEMORY.md');
      const idxBefore = fs.readFileSync(idx, 'utf8');
      const x = makeRepo(path.join(desk, 'x'));
      fs.rmSync(path.join(x, '.git', 'info', 'exclude'), { force: true });
      const tx = addTranscript(m.claudeHome, x);
      const xmem = path.join(tx.dir, 'memory');
      mem(xmem, 'xmem.md', { name: 'xmem', description: '要複製的' });
      const restore = failCommits(e.paths.vault);
      await assert.rejects(e.identity.bind(x, { pid: first.pid }));
      restore();
      assert.equal(fs.readFileSync(idx, 'utf8'), idxBefore, '專案索引逐位元不變');
      assert.equal(fs.existsSync(path.join(e.paths.vault, 'projects', first.pid, 'memory', 'xmem.md')), false);
      assert.equal(isLink(xmem), false);
      assert.deepEqual(fs.readdirSync(xmem), ['xmem.md']);
      assert.equal(fs.existsSync(path.join(x, '.git', 'info', 'exclude')), false, '原本沒有 exclude 檔，撤銷後也沒有');
      assert.equal(git(e.paths.vault, 'status', '--porcelain').trim(), '', 'vault 乾淨');
    } finally { rmTmp(root); }
  });

  test('增量匯入：已收編的記憶照樣提供歸屬證據，之後才寫、沒寫路徑的記憶跟著歸到同一個（封存）專案', async () => {
    const { root, m, e } = await machine('engram-r2b-');
    try {
      const spec = path.join(m.userHome, 'Desktop', 'Spec_舊版規格');
      const dir = path.join(m.claudeHome, 'projects', encodeProjectPath(spec), 'memory');
      mem(dir, 'spec.md', { name: 'spec', description: '規格', body: `工作目錄 ${spec}\\。` });
      mem(dir, 'spec-style.md', { name: 'spec-style', description: '寫法' });
      await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }) });
      const archived = (await e.projects.list()).find((p) => p.name === 'Spec_舊版規格');
      assert.ok(archived);
      mem(dir, 'spec-new.md', { name: 'spec-new', description: '之後才寫' });
      const plan = await e.sweepLegacy({ dryRun: true });
      assert.equal(plan.sources.length, 1);
      assert.equal(plan.sources[0].resolvedPath.toLowerCase(), spec.toLowerCase());
      assert.equal(plan.sources[0].target.pid, archived.pid, '歸到第一次匯入建立的那個專案');
    } finally { rmTmp(root); }
  });

  test('還原後一次匯入，不會拆掉前一次匯入建立的綁定（預設權限模式，設定檔綁定）', async () => {
    const { root, m, e } = await machine('engram-r2c-', '測試', { mode: null });
    try {
      const notes = path.join(m.userHome, 'Desktop', 'notes');
      fs.mkdirSync(notes, { recursive: true });
      const t = addTranscript(m.claudeHome, notes);
      mem(path.join(t.dir, 'memory'), 'n1.md', { name: 'n1', description: '第一次' });
      await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }) });
      const settings = path.join(notes, '.claude', 'settings.local.json');
      const settingsBefore = fs.readFileSync(settings, 'utf8');
      const bindingsFile = path.join(e.paths.vault, 'machines', e.machine.id, 'bindings.json');
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(bindingsFile, 'utf8'))).length, 1);
      // 從子資料夾啟動之類的情況，原記憶資料夾又多了一筆 → 第二次匯入
      mem(path.join(t.dir, 'memory'), 'n2.md', { name: 'n2', description: '第二次' });
      const plan2 = await e.sweepLegacy({ dryRun: true });
      assert.equal(plan2.sources[0].target.boundPid, plan2.sources[0].target.pid, '計畫標出「早就綁定」，精靈的將綁定數不計入');
      const second = await e.sweepLegacy({ dryRun: false, plan: plan2 });
      await e.rollbackImport(second.restorePoint);
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(bindingsFile, 'utf8'))).length, 1, '第一次的綁定還在');
      assert.equal(fs.readFileSync(settings, 'utf8'), settingsBefore, '設定檔仍指向 vault');
    } finally { rmTmp(root); }
  });

  test('還原不會把既有專案裡（另一台電腦寫的）記憶倒進這台的原記憶資料夾', async () => {
    const { root, m, e } = await machine('engram-r2d-');
    try {
      const remote = 'https://example.com/team/shared.git';
      const desk = path.join(m.userHome, 'Desktop');
      const other = makeRepo(path.join(desk, 'clone-one'), { remote });
      const first = await e.identity.bind(other, {});
      await e.memories.create({ scope: { kind: 'project', pid: first.pid }, name: 'from-machine1', type: 'project', description: '另一台寫的', body: 'x' });
      const repo = makeRepo(path.join(desk, 'clone-two'), { remote });
      const t = addTranscript(m.claudeHome, repo);
      const memDir = path.join(t.dir, 'memory');
      mem(memDir, 'local.md', { name: 'local', description: '這台的' });
      const r = await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }) });
      await e.rollbackImport(r.restorePoint);
      assert.deepEqual(fs.readdirSync(memDir).filter((f) => f !== 'MEMORY.md'), ['local.md']);
    } finally { rmTmp(root); }
  });

  test('沒有對話紀錄時，內文路徑和真正存在的同編碼資料夾只差在符號（site-v2 與 site.v2）：不靠內文決定', async () => {
    const { root, m, e } = await machine('engram-r2e-');
    try {
      const desk = path.join(m.userHome, 'Desktop');
      const a = makeRepo(path.join(desk, 'site-v2'));
      makeRepo(path.join(desk, 'site.v2'));
      mem(path.join(m.claudeHome, 'projects', encodeProjectPath(a), 'memory'), 'b.md', { name: 'b', description: 'b', body: `參考 ${path.join(desk, 'site.v2', 'x.html')}。` });
      const plan = await e.sweepLegacy({ dryRun: true });
      assert.equal(plan.sources[0].resolvedPath, null, '兩個資料夾在 Claude Code 裡本來就撞名，列為無法判斷');
    } finally { rmTmp(root); }
  });

  test('內文提到的資料夾已不存在、磁碟上只有一個只差在符號的資料夾：仍以內文為準（孤兒來源），不綁到那個資料夾', async () => {
    const { root, m, e } = await machine('engram-r3a-');
    try {
      const desk = path.join(m.userHome, 'Desktop');
      const gone = path.join(desk, 'my-app');
      const other = makeRepo(path.join(desk, 'my_app'));
      assert.equal(encodeProjectPath(gone), encodeProjectPath(other));
      mem(path.join(m.claudeHome, 'projects', encodeProjectPath(gone), 'memory'), 'w.md', { name: 'w', description: 'w', body: `工作目錄 ${gone}\\。` });
      const plan = await e.sweepLegacy({ dryRun: true });
      assert.equal(plan.sources[0].resolvedPath.toLowerCase(), gone.toLowerCase());
      assert.equal(plan.sources[0].exists, false);
      assert.equal(plan.sources[0].how, 'content-path');
    } finally { rmTmp(root); }
  });

  test('演練與精靈的計畫一致：已收編的檔案兩邊都不列入', async () => {
    const { root, m, e } = await machine('engram-r2f-');
    try {
      const enc = encodeProjectPath(path.join(m.userHome, 'Desktop', 'Gone'));
      mem(path.join(m.claudeHome, 'projects', enc, 'memory'), 'gone.md', { name: 'gone', description: '孤兒' });
      await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }) });
      const p = await planImport(e);
      const r = await rehearseImport(e, {});
      assert.equal(r.totals.memories, p.totals.memories);
      assert.equal(p.totals.memories, 0);
    } finally { rmTmp(root); }
  });
});

describe('還原點名稱', () => {
  test('同一秒內的兩次匯入有不同的還原點；還原第二次不會動到第一次', async (t) => {
    const { root, m, e } = await machine('engram-tag-', '測試', { mode: null });
    try {
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T15:12:10.000Z') }); // 時間凍結在同一秒
      const notes = path.join(m.userHome, 'Desktop', 'notes');
      fs.mkdirSync(notes, { recursive: true });
      const tr = addTranscript(m.claudeHome, notes);
      mem(path.join(tr.dir, 'memory'), 'n1.md', { name: 'n1', description: '第一次' });
      const first = await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }) });
      mem(path.join(tr.dir, 'memory'), 'n2.md', { name: 'n2', description: '第二次' });
      const second = await e.sweepLegacy({ dryRun: false, plan: await e.sweepLegacy({ dryRun: true }) });
      assert.notEqual(second.restorePoint, first.restorePoint);
      await e.rollbackImport(second.restorePoint);
      const bindings = JSON.parse(fs.readFileSync(path.join(e.paths.vault, 'machines', e.machine.id, 'bindings.json'), 'utf8'));
      assert.equal(Object.keys(bindings).length, 1, '第一次匯入的綁定還在');
      assert.ok(fs.existsSync(path.join(e.paths.vault, 'global')) && (await e.memories.list({})).some((x) => x.name === 'n1'), '第一次匯入的記憶還在');
      assert.ok(!(await e.memories.list({})).some((x) => x.name === 'n2'), '第二次匯入的記憶已還原');
    } finally { t.mock.timers.reset(); rmTmp(root); }
  });
});

describe('健康檢查', () => {
  test('H07：不同電腦各自的單機記憶同名或內容相同不算重複；單機記憶與共用範圍重複仍要提示', async () => {
    const { root, e } = await machine('engram-h07-');
    try {
      const vault = e.paths.vault;
      fs.mkdirSync(path.join(vault, 'machines', 'home-pc0001'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'machines', 'home-pc0001', 'machine.json'), JSON.stringify({ id: 'home-pc0001', label: '家裡電腦', hostname: 'HOMEBOX' }));
      fs.writeFileSync(path.join(vault, 'machines', 'home-pc0001', 'bench-env.md'), memoryText({ name: 'bench-env', description: '跑 benchmark 的環境', body: 'LibreOffice 在 C:\\LO' }));
      git(vault, 'add', '-A');
      git(vault, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--no-verify', '-m', 'engram(home-pc0001): autosave');
      await e.memories.create({ scope: { kind: 'machine' }, name: 'bench-env', type: 'project', description: '跑 benchmark 的環境', body: 'LibreOffice 在 C:\\LO' });
      let h07 = (await e.health()).filter((f) => f.code === 'H07');
      assert.deepEqual(h07, [], '兩台電腦各一份，不是重複');
      await e.memories.create({ scope: { kind: 'global' }, name: 'bench-env', type: 'project', description: '跑 benchmark 的環境', body: 'LibreOffice 在 C:\\LO' });
      h07 = (await e.health()).filter((f) => f.code === 'H07');
      assert.ok(h07.length >= 1, '單機記憶與全域重複仍要提示');
    } finally { rmTmp(root); }
  });
});

describe('別台電腦的單機記憶', () => {
  test('匯入計畫：這台的環境記憶與別台的單機記憶同名或相同，不算重複或舊版本', async () => {
    const { root, m, e } = await machine('engram-mach-');
    try {
      const vault = e.paths.vault;
      const hd = path.join(vault, 'machines', 'home-pc0001');
      fs.mkdirSync(hd, { recursive: true });
      fs.writeFileSync(path.join(hd, 'machine.json'), JSON.stringify({ id: 'home-pc0001', label: '家裡電腦', hostname: 'HOMEBOX' }));
      const env = { name: 'bench-env', description: '跑 benchmark 的環境', body: '這台電腦的 LibreOffice 安裝在 C:\\LO。' };
      const same = { name: 'same-env', description: '工具路徑', body: '這台電腦的工具安裝在 C:\\Tools。' };
      fs.writeFileSync(path.join(hd, 'bench-env.md'), memoryText({ ...env, body: '這台電腦的 LibreOffice 安裝在 D:\\LO。' }));
      fs.writeFileSync(path.join(hd, 'same-env.md'), memoryText(same));
      git(vault, 'add', '-A');
      git(vault, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--no-verify', '-m', 'engram(home-pc0001): autosave');
      const dir = path.join(m.userHome, 'Desktop', 'bench');
      fs.mkdirSync(dir, { recursive: true });
      const t = addTranscript(m.claudeHome, dir);
      mem(path.join(t.dir, 'memory'), 'bench-env.md', env);
      mem(path.join(t.dir, 'memory'), 'same-env.md', same);
      const plan = await e.sweepLegacy({ dryRun: true });
      const items = plan.sources.flatMap((s) => s.items);
      for (const f of ['bench-env.md', 'same-env.md']) {
        const it = items.find((i) => i.file === f);
        assert.equal(it.action, 'copy', `${f}：${it.action}（${it.dupOf ?? ''}）`);
        assert.equal(it.scope, 'machine');
      }
    } finally { rmTmp(root); }
  });

  test('H07：同一台的兩筆重複＋別台的一筆，只列出同一台的兩筆（合併不會併掉別台的那份）', async () => {
    const { root, e } = await machine('engram-h07b-');
    try {
      const vault = e.paths.vault;
      fs.mkdirSync(path.join(vault, 'machines', 'home-pc0001'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'machines', 'home-pc0001', 'machine.json'), JSON.stringify({ id: 'home-pc0001', label: '家裡電腦', hostname: 'HOMEBOX' }));
      fs.writeFileSync(path.join(vault, 'machines', 'home-pc0001', 'bench-env.md'), memoryText({ name: 'bench-env', description: '環境', body: 'C:\\LO' }));
      git(vault, 'add', '-A');
      git(vault, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--no-verify', '-m', 'engram(home-pc0001): autosave');
      await e.memories.create({ scope: { kind: 'machine' }, name: 'bench-env', type: 'project', description: '環境', body: 'C:\\LO' });
      await e.memories.create({ scope: { kind: 'machine' }, name: 'bench-env', type: 'project', description: '環境', body: 'C:\\LO' });
      const h07 = (await e.health()).filter((f) => f.code === 'H07');
      assert.ok(h07.length >= 1);
      for (const f of h07) assert.ok(f.refs.every((r) => r.startsWith(`machines/${e.machine.id}/`)), JSON.stringify(f.refs));
    } finally { rmTmp(root); }
  });
});
