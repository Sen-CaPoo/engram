// R-52 混合綁定：每個綁定都寫 settings.local（從根目錄啟動不經過 junction），
// 預設權限模式是 auto／bypassPermissions 時才另外建 junction；模式改變時由 reconcile 收斂。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { encodeProjectPath } from '../../src/core/paths.mjs';
import { createJunction, isLink } from '../../src/core/fsx.mjs';
import { allowJunctionRead } from '../../src/core/claudesettings.mjs';
import { addTranscript, machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

let root;
let m;
let eg;

before(async () => {
  root = mkTmp('engram-hybrid-');
  const cli = writeDriverCli(root);
  m = machinePaths(root, 'pc');
  await init({ ...m, machineLabel: '測試電腦', cli });
  eg = await open(m);
});
after(() => rmTmp(root));

const userSettings = () => path.join(m.claudeHome, 'settings.json');
function setMode(mode) {
  const j = JSON.parse(fs.readFileSync(userSettings(), 'utf8'));
  j.permissions = { ...j.permissions, defaultMode: mode };
  fs.writeFileSync(userSettings(), JSON.stringify(j, null, 2));
}
const allowedDirs = () => (JSON.parse(fs.readFileSync(userSettings(), 'utf8')).permissions?.additionalDirectories ?? []).map((p) => p.toLowerCase());
const localSettings = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')); } catch { return null; } };
const memDirOf = (dir) => path.join(m.claudeHome, 'projects', encodeProjectPath(dir), 'memory');
const vaultMem = (pid) => path.join(eg.paths.vault, 'projects', pid, 'memory');
const excludeOf = (repo) => { try { return fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'); } catch { return null; } };
const bindingOf = (dir) => Object.values(JSON.parse(fs.readFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json'), 'utf8')))
  .find((b) => b.path.toLowerCase() === dir.toLowerCase());
const pointsToVault = (dir, pid) => {
  const a = localSettings(dir)?.autoMemoryDirectory;
  return !!a && path.resolve(a.replace(/^~/, m.userHome)).toLowerCase() === vaultMem(pid).toLowerCase();
};

describe('R-52 混合綁定', () => {
  test('auto：設定檔指向 vault，另外建 junction；解除後資料夾回到綁定前', async () => {
    setMode('auto');
    const repo = makeRepo(path.join(root, 'work', 'alpha'));
    addTranscript(m.claudeHome, repo);
    const ex = excludeOf(repo);
    const r = await eg.identity.bind(repo, { create: { name: 'alpha' } });
    assert.equal(r.method, 'junction');
    assert.ok(isLink(memDirOf(repo)), '建了 junction（補足子資料夾啟動）');
    assert.ok(pointsToVault(repo, r.pid), 'settings.local 直接指向 vault');
    assert.ok(allowedDirs().includes(memDirOf(repo).toLowerCase()), 'junction 路徑列入 additionalDirectories');
    await eg.identity.unbind(repo);
    assert.equal(isLink(memDirOf(repo)), false);
    assert.equal(fs.existsSync(path.join(repo, '.claude')), false, '綁定建立的 .claude 已移除');
    assert.equal(excludeOf(repo), ex, 'exclude 回到綁定前');
  });

  test('default：只用設定檔，不建 junction、不加 additionalDirectories；解除後記憶複製回原資料夾', async () => {
    setMode('default');
    const repo = makeRepo(path.join(root, 'work', 'beta'));
    addTranscript(m.claudeHome, repo);
    const ex = excludeOf(repo);
    const r = await eg.identity.bind(repo, { create: { name: 'beta' } });
    assert.equal(r.method, 'settings');
    assert.equal(isLink(memDirOf(repo)), false);
    assert.ok(pointsToVault(repo, r.pid));
    assert.ok(!allowedDirs().includes(memDirOf(repo).toLowerCase()));
    assert.equal(bindingOf(repo).collision, false, '標記為「權限模式」造成的設定檔綁定，不是撞名');
    assert.equal((await eg.projects.get(r.pid)).paths[eg.machine.id].collision, false, '專案 API 也帶出 collision，介面才能區分');
    // Claude 依設定檔直接寫進 vault
    fs.writeFileSync(path.join(vaultMem(r.pid), 'beta-note.md'), memoryText({ name: 'beta-note', description: '設定檔綁定時寫的' }));

    const atRoot = await eg.sessionContext({ cwd: repo });
    assert.match(atRoot.text, /專案：beta.*· 已綁定/);
    assert.doesNotMatch(atRoot.text, /設定檔備援|撞名|子資料夾/, '不是撞名，不顯示撞名警告');
    const sub = path.join(repo, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const atSub = await eg.sessionContext({ cwd: sub });
    assert.match(atSub.text, /從專案的子資料夾啟動/);
    assert.ok(!(await eg.health()).some((f) => f.fix?.action === 'reconcile-bindings'), '沒有 junction 就不提醒');

    await eg.identity.unbind(repo);
    assert.ok(fs.existsSync(path.join(memDirOf(repo), 'beta-note.md')), '記憶複製回 Claude Code 原本的資料夾');
    assert.equal(fs.existsSync(path.join(repo, '.claude')), false);
    assert.equal(excludeOf(repo), ex);
  });

  test('reconcile：auto 改成 acceptEdits 會拆掉 junction、改用設定檔；改回 auto 會補上 junction', async () => {
    setMode('auto');
    const repo = makeRepo(path.join(root, 'work', 'gamma'));
    addTranscript(m.claudeHome, repo);
    const r = await eg.identity.bind(repo, { create: { name: 'gamma' } });
    assert.equal(r.method, 'junction');
    fs.writeFileSync(path.join(vaultMem(r.pid), 'g.md'), memoryText({ name: 'g', description: 'gamma 的記憶' }));

    setMode('acceptEdits');
    const f = (await eg.health()).find((x) => x.code === 'H17' && x.fix?.action === 'reconcile-bindings');
    assert.ok(f, '健康檢查提醒並附上修正');
    assert.equal(f.en.title, 'Reading and writing memory will trigger permission prompts');
    assert.match(f.en.detail, /default permission mode is acceptEdits\. In this mode/);
    assert.equal(f.fix.en.label, 'Use settings-file links');
    const rc = await eg.apply(f.fix);
    assert.ok(rc.changed.some((c) => c.pid === r.pid && c.from === 'junction' && c.to === 'settings'));
    assert.equal(isLink(memDirOf(repo)), false);
    assert.ok(pointsToVault(repo, r.pid), '設定檔仍指向 vault');
    assert.ok(fs.existsSync(path.join(vaultMem(r.pid), 'g.md')), '記憶仍在 vault');
    assert.ok(!allowedDirs().includes(memDirOf(repo).toLowerCase()), 'additionalDirectories 一併撤銷');
    assert.ok(!(await eg.health()).some((x) => x.fix?.action === 'reconcile-bindings'));
    assert.equal((await eg.identity.reconcile()).changed.length, 0, '已收斂：再呼叫沒有變更');

    setMode('auto');
    const back = await eg.identity.reconcile();
    assert.ok(back.changed.some((c) => c.pid === r.pid && c.to === 'junction' && c.state === 'active'));
    assert.ok(isLink(memDirOf(repo)));
    assert.ok(fs.existsSync(path.join(memDirOf(repo), 'g.md')), '透過 junction 看得到 vault 的記憶');
    assert.ok(allowedDirs().includes(memDirOf(repo).toLowerCase()));
    assert.equal(bindingOf(repo).method, 'junction');

    await eg.identity.unbind(repo);
    assert.equal(fs.existsSync(path.join(repo, '.claude')), false, '往返之後足跡仍能清乾淨');
  });

  test('進行中的對話：reconcile 延後拆 junction，force 才立即處理', async () => {
    setMode('auto');
    const repo = makeRepo(path.join(root, 'work', 'delta'));
    addTranscript(m.claudeHome, repo);
    await eg.identity.bind(repo, { create: { name: 'delta' } });
    addTranscript(m.claudeHome, repo, { ageMs: 0 });
    setMode('default');
    const rc = await eg.identity.reconcile();
    assert.ok(rc.deferred.some((d) => d.path.toLowerCase() === repo.toLowerCase() && d.reason === 'active-session'));
    assert.ok(isLink(memDirOf(repo)), '對話進行中不動 junction');
    const forced = await eg.identity.reconcile({ force: true });
    assert.ok(forced.changed.some((c) => c.path.toLowerCase() === repo.toLowerCase() && c.to === 'settings'));
    assert.equal(isLink(memDirOf(repo)), false);
    await eg.identity.unbind(repo);
  });

  test('SessionStart（default 模式）：認出的新 clone 只寫設定檔並記下足跡，下次對話生效', async () => {
    setMode('default');
    const remote = 'https://github.com/example-org/hybrid-demo';
    const orig = makeRepo(path.join(root, 'work', 'epsilon'), { remote });
    addTranscript(m.claudeHome, orig);
    await eg.identity.bind(orig, { create: { name: 'epsilon' } });
    const clone = makeRepo(path.join(root, 'work2', 'epsilon-clone'), { remote });
    const t = addTranscript(m.claudeHome, clone, { ageMs: 0 });
    const ex = excludeOf(clone);
    const ctx = await eg.sessionContext({ cwd: clone, transcriptPath: t.file, sessionId: t.sessionId });
    assert.match(ctx.text, /專案：epsilon.*下次對話生效/);
    assert.doesNotMatch(ctx.text, /設定檔備援/);
    assert.equal(isLink(path.join(t.dir, 'memory')), false);
    const b = bindingOf(clone);
    assert.equal(b.method, 'settings');
    assert.equal(b.collision, false);
    assert.equal(b.footprint.settingsCreated, true, 'SessionStart 也記下足跡');
    assert.equal(b.footprint.claudeDirCreated, true);
    assert.ok(pointsToVault(clone, b.pid));
    assert.match(excludeOf(clone), /^\/\.claude\/settings\.local\.json$/m, '不啟動 git 也會加 exclude，避免設定檔進團隊 repo');
    await eg.identity.unbind(clone);
    assert.equal(fs.existsSync(path.join(clone, '.claude')), false);
    assert.equal(excludeOf(clone), ex, 'SessionStart 加的 exclude 也會移除');
    await eg.identity.unbind(orig);
  });

  test('相容性探測暫停 junction：auto 模式也只用設定檔，SessionStart 照常接上', async () => {
    setMode('auto');
    const paused = path.join(eg.paths.local, 'paused.json');
    fs.writeFileSync(paused, JSON.stringify({ junction: true }));
    try {
      const repo = makeRepo(path.join(root, 'work', 'zeta'));
      addTranscript(m.claudeHome, repo);
      const r = await eg.identity.bind(repo, { create: { name: 'zeta' } });
      assert.equal(r.method, 'settings');
      assert.equal(isLink(memDirOf(repo)), false);
      assert.ok(pointsToVault(repo, r.pid));
      const ctx = await eg.sessionContext({ cwd: repo });
      assert.doesNotMatch(ctx.text, /暫停/);
      await eg.identity.unbind(repo);
    } finally {
      fs.rmSync(paused, { force: true });
    }
  });

  test('專案層的 defaultMode 優先於使用者層（團隊 repo 的 .claude/settings.json）', async () => {
    setMode('auto');
    const repo = makeRepo(path.join(root, 'work', 'theta'));
    addTranscript(m.claudeHome, repo);
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const shared = path.join(repo, '.claude', 'settings.json');
    fs.writeFileSync(shared, JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
    const r = await eg.identity.bind(repo, { create: { name: 'theta' } });
    assert.equal(r.method, 'settings', '這個專案以 acceptEdits 為準，不建 junction');
    assert.equal(isLink(memDirOf(repo)), false);
    // 團隊改回 auto：reconcile 補上 junction
    fs.writeFileSync(shared, JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    const rc = await eg.identity.reconcile();
    assert.ok(rc.changed.some((c) => c.pid === r.pid && c.to === 'junction'));
    assert.ok(isLink(memDirOf(repo)));
    // 再改成 default：健康檢查提醒，reconcile 拆掉
    fs.writeFileSync(shared, JSON.stringify({ permissions: { defaultMode: 'default' } }));
    assert.ok((await eg.health()).some((f) => f.fix?.action === 'reconcile-bindings'));
    await eg.identity.reconcile();
    assert.equal(isLink(memDirOf(repo)), false);
    await eg.identity.unbind(repo);
    assert.ok(fs.existsSync(shared), '團隊的設定檔不受影響');
    assert.equal(localSettings(repo), null, 'Engram 建立的 settings.local.json 已移除');
  });

  test('舊版只有 junction 的綁定：reconcile 補上設定檔，解除時一併清除', async () => {
    setMode('auto');
    const repo = makeRepo(path.join(root, 'work', 'eta'));
    addTranscript(m.claudeHome, repo);
    const r = await eg.identity.bind(repo, { create: { name: 'eta' } });
    // 模擬 R-52 之前的綁定：沒有 settings.local，足跡也沒有設定檔的紀錄
    fs.rmSync(path.join(repo, '.claude'), { recursive: true, force: true });
    const file = path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json');
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const v of Object.values(all)) if (v.pid === r.pid) { v.footprint = {}; delete v.collision; }
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    const rc = await eg.identity.reconcile();
    assert.ok(rc.changed.some((c) => c.pid === r.pid && c.settings === 'written'));
    assert.ok(pointsToVault(repo, r.pid));
    assert.ok(isLink(memDirOf(repo)), 'junction 不受影響');
    await eg.identity.unbind(repo);
    assert.equal(fs.existsSync(path.join(repo, '.claude')), false);
  });
});

// R-54（E24／F36）：從 git 子資料夾啟動時，transcript 放在子資料夾的編碼，記憶用的是 repo 根目錄的編碼
describe('R-54 從 git 子資料夾啟動', () => {
  const subOf = (repo) => { const sub = path.join(repo, 'src'); fs.mkdirSync(sub, { recursive: true }); return sub; };

  test('第一次就從子資料夾開啟（claude-57 的重現）：綁定與 junction 落在 repo 根目錄的編碼', async () => {
    setMode('auto');
    const remote = 'https://github.com/example-org/shop-app.git';
    const clone1 = makeRepo(path.join(root, 'r54', 'shop-app'), { remote });
    addTranscript(m.claudeHome, clone1);
    const r = await eg.identity.bind(clone1, { create: { name: 'shop-app' } });
    const clone2 = makeRepo(path.join(root, 'r54', 'shop-app2'), { remote: 'git@github.com:example-org/shop-app.git' });
    const sub = subOf(clone2);
    const t = addTranscript(m.claudeHome, sub, { ageMs: 0 }); // 實際行為：transcript 在子資料夾的編碼
    const ctx = await eg.sessionContext({ cwd: sub, transcriptPath: t.file, sessionId: t.sessionId });
    assert.match(ctx.text, /剛完成綁定/);
    assert.ok(isLink(memDirOf(clone2)), 'junction 建在根目錄的編碼（Claude Code 實際用的記憶資料夾）');
    assert.equal(isLink(memDirOf(sub)), false, '子資料夾的編碼不建 junction');
    const b = bindingOf(clone2);
    assert.equal(b.encoded, encodeProjectPath(clone2));
    assert.equal(b.pid, r.pid);
    assert.ok(allowedDirs().includes(memDirOf(clone2).toLowerCase()));
    assert.ok(!allowedDirs().includes(memDirOf(sub).toLowerCase()));
    assert.ok(ctx.text.includes(`${encodeProjectPath(clone2)}/memory/MEMORY.md`), '提示 Claude 讀根目錄編碼的索引');
    await eg.identity.unbind(clone2);
    await eg.identity.unbind(clone1);
  });

  test('非 git 的子資料夾在 Claude Code 眼中是另一個專案：不會綁到上層', async () => {
    setMode('auto');
    const parent = path.join(root, 'r54', 'notes');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, 'a.txt'), 'x');
    addTranscript(m.claudeHome, parent);
    await eg.identity.bind(parent, { create: { name: 'notes' } });
    const sub = path.join(parent, 'drafts');
    fs.mkdirSync(sub);
    const t = addTranscript(m.claudeHome, sub, { ageMs: 0 });
    const ctx = await eg.sessionContext({ cwd: sub, transcriptPath: t.file, sessionId: t.sessionId });
    assert.doesNotMatch(ctx.text, /專案：notes/);
    assert.equal(isLink(memDirOf(sub)), false);
    assert.equal(fs.existsSync(path.join(sub, '.claude')), false);
    assert.equal(bindingOf(sub), undefined);
    await eg.identity.unbind(parent);
  });

  test('舊版放錯位置的綁定：健康檢查提醒，reconcile 拆掉錯的 junction、改回根目錄並收編子資料夾寫的記憶', async () => {
    setMode('auto');
    const repo = makeRepo(path.join(root, 'r54', 'legacy'));
    addTranscript(m.claudeHome, repo);
    const r = await eg.identity.bind(repo, { create: { name: 'legacy' } });
    const sub = subOf(repo);
    // 模擬舊版的結果：根目錄的記憶資料夾是一般資料夾（子資料夾開啟時寫了一筆），junction 與綁定在子資料夾的編碼
    fs.rmdirSync(memDirOf(repo));
    fs.mkdirSync(memDirOf(repo));
    fs.writeFileSync(path.join(memDirOf(repo), 'sub-note.md'), memoryText({ name: 'sub-note', description: '從子資料夾寫的' }));
    fs.mkdirSync(path.dirname(memDirOf(sub)), { recursive: true });
    createJunction(vaultMem(r.pid), memDirOf(sub));
    await allowJunctionRead(eg._ctx.homes, memDirOf(sub));
    const file = path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json');
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [k, v] = Object.entries(all).find(([, x]) => x.pid === r.pid);
    delete all[k];
    all[encodeProjectPath(sub)] = { ...v, encoded: encodeProjectPath(sub), method: 'junction' };
    fs.writeFileSync(file, JSON.stringify(all, null, 2));

    const f = (await eg.health()).find((x) => x.code === 'H17' && x.severity === 'high' && x.pid === r.pid);
    assert.match(f?.title ?? '', /建在錯誤的位置/);
    assert.match(f.en.title, /^The memory link for ".+" is in the wrong place$/);
    assert.equal(f.fix.en.label, 'Fix link location');
    const rc = await eg.apply(f.fix);
    assert.ok(rc.changed.some((c) => c.pid === r.pid && c.encoded?.to === encodeProjectPath(repo)));
    assert.equal(fs.existsSync(memDirOf(sub)), false, '放錯位置的 junction 已移除');
    assert.ok(!allowedDirs().includes(memDirOf(sub).toLowerCase()), '錯的 additionalDirectories 已撤銷');
    assert.ok(isLink(memDirOf(repo)), 'auto 模式在根目錄的編碼補上 junction');
    assert.ok(fs.existsSync(path.join(vaultMem(r.pid), 'sub-note.md')), '子資料夾開啟時寫的記憶收進 vault');
    const b = bindingOf(repo);
    assert.equal(b.encoded, encodeProjectPath(repo));
    assert.equal(b.method, 'junction');
    assert.ok(!(await eg.health()).some((x) => x.pid === r.pid && /錯誤的位置/.test(x.title)));
    await eg.identity.unbind(repo);
  });

  test('從子資料夾開著的對話也算「進行中」：reconcile 不會在對話中拆 junction', async () => {
    setMode('auto');
    const repo = makeRepo(path.join(root, 'r54', 'busy'));
    addTranscript(m.claudeHome, repo);
    await eg.identity.bind(repo, { create: { name: 'busy-sub' } });
    addTranscript(m.claudeHome, subOf(repo), { ageMs: 0 }); // 只有子資料夾的 transcript 是新的
    setMode('default');
    const rc = await eg.identity.reconcile();
    assert.ok(rc.deferred.some((d) => d.path.toLowerCase() === repo.toLowerCase() && d.reason === 'active-session'));
    assert.ok(isLink(memDirOf(repo)));
    await eg.identity.reconcile({ force: true });
    await eg.identity.unbind(repo);
  });

  test('只從子資料夾開過的專案：收編時由子資料夾的 transcript 認出記憶屬於哪個 repo', async () => {
    setMode('auto');
    const repo = makeRepo(path.join(root, 'r54', 'only-sub'));
    addTranscript(m.claudeHome, subOf(repo));
    fs.mkdirSync(memDirOf(repo), { recursive: true });
    fs.writeFileSync(path.join(memDirOf(repo), 'note.md'), memoryText({ name: 'only-sub-note', description: '只從子資料夾寫過' }));
    const plan = await eg.sweepLegacy({ dryRun: true });
    const s = plan.sources.find((x) => x.encoded === encodeProjectPath(repo));
    assert.ok(s, '根目錄編碼的記憶資料夾是收編來源');
    assert.equal(s.resolvedPath?.toLowerCase(), repo.toLowerCase());
    assert.equal(s.how, 'transcript-cwd');
    assert.ok(!plan.sources.some((x) => x.encoded === encodeProjectPath(path.join(repo, 'src'))), '只有 transcript 的子資料夾編碼不是來源');
  });
});
