// 開場 hook 的快速路徑（2.0.0 WP4a S5）：常駐程式寫的 local/cache/session/state.json 與 core/sessioncache.mjs。
// 同一組案例比對兩條路徑：快速路徑的輸出（文字、綁定、MEMORY.md）要和完整路徑（sessionContext）一字不差；
// 快取過期、讀過的檔案變了、資料夾不在快取裡（沒綁定、撞名）就退回完整路徑。全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { fastSessionContext, SESSION_CACHE_MAX_AGE_MS, sessionCacheFile } from '../../src/core/sessioncache.mjs';
import { addTranscript, machinePaths, makeRepo, memoryText, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const T0 = Date.parse('2026-11-21T03:00:00.000Z');
const LATER = T0 + 5 * 60_000;
const MIN = 60_000;

let root;
let m;
let eg;
let homes;
let junctionRepo;
let settingsRepo;
let jpid;
let spid;

const local = (...p) => path.join(eg.paths.local, ...p);
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const state = (value) => writeJson(local('state.json'), value);

/** 完整路徑與快速路徑（先寫快取）各算一次 */
async function both(cwd, { sessionId = 'sess-1', now = LATER, writeAt = T0 } = {}) {
  await eg.sessionCache.write({ now: writeAt });
  const full = await eg.sessionContext({ cwd, sessionId, now });
  const fast = await fastSessionContext({ homes, cwd, sessionId, now });
  return { full, fast };
}

function assertSame({ full, fast }, label = '') {
  assert.ok(fast, `快速路徑應該可以用${label ? `（${label}）` : ''}`);
  assert.ok(full.text.length > 0);
  assert.equal(fast.text, full.text, label);
  assert.equal(fast.memoryIndex ?? null, full.memoryIndex ?? null, label);
  assert.deepEqual(fast.binding, full.binding, label);
}

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '工作室桌機', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  homes = { home: eg.paths.home, vault: eg.paths.vault, local: eg.paths.local, claudeHome: eg.paths.claudeHome, userHome: m.userHome };
  junctionRepo = makeRepo(path.join(root, 'work', 'bakery'));
  fs.mkdirSync(path.join(junctionRepo, 'src', 'deep'), { recursive: true });
  jpid = (await eg.identity.bind(junctionRepo, { create: { name: '烘焙坊' } })).pid;
  // 設定檔綁定：預設權限模式不是 auto 時不建 junction（R-52）
  fs.writeFileSync(path.join(m.claudeHome, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
  settingsRepo = makeRepo(path.join(root, 'work', 'library'));
  fs.mkdirSync(path.join(settingsRepo, 'lib'), { recursive: true });
  spid = (await eg.identity.bind(settingsRepo, { create: { name: '圖書館' } })).pid;
  // 單機記憶：4 筆與烘焙坊有關（開場只列 3 筆）、1 筆無關
  const mdir = path.join(eg.paths.vault, 'machines', eg.machine.id);
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(mdir, `bakery-${i}.md`), memoryText({ name: `bakery-${i}`, type: 'reference', description: `烘焙坊在這台的第 ${i} 件事`, extra: `  engram:\n    project: ${jpid}\n` }));
  fs.writeFileSync(path.join(mdir, 'general.md'), memoryText({ name: 'general', type: 'reference', description: '和專案無關' }));
  // Claude Code 自己的記憶資料夾有 MEMORY.md（junction 綁定時就是 vault 的專案資料夾）
  fs.writeFileSync(path.join(eg.paths.vault, 'projects', jpid, 'memory', 'MEMORY.md'), '- [a](a.md) — 說明\n');
  addTranscript(m.claudeHome, junctionRepo);
});
after(() => rmTmp(root));
beforeEach(() => {
  for (const f of ['state.json', 'paused.json', 'settings.json', path.join('cache', 'health.json')]) fs.rmSync(local(f), { force: true });
  fs.rmSync(local('cache', 'session'), { recursive: true, force: true });
  fs.rmSync(path.join(eg.paths.vault, 'conflicts'), { recursive: true, force: true });
});

describe('兩條路徑一字不差', () => {
  test('junction 綁定：從根目錄、從子資料夾；單機記憶只列 3 筆', async () => {
    const top = await both(junctionRepo);
    assertSame(top, '根目錄');
    assert.match(top.full.text, /專案：烘焙坊（/);
    assert.match(top.full.text, /本機與此專案相關的記憶/);
    assert.equal((top.full.text.match(/\[bakery-\d\]/g) ?? []).length, 3);
    assert.ok(top.full.memoryIndex, '有 MEMORY.md');
    const sub = await both(path.join(junctionRepo, 'src', 'deep'));
    assertSame(sub, '子資料夾');
    assert.match(sub.full.text, /這次從子資料夾啟動/);
  });

  test('設定檔綁定：從根目錄、從子資料夾', async () => {
    assertSame(await both(settingsRepo), '根目錄');
    const sub = await both(path.join(settingsRepo, 'lib'));
    assertSame(sub, '子資料夾');
    assert.match(sub.full.text, /Claude Code 不會讀到 Engram 的設定/);
  });

  test('同步的各種狀態：時間相關的文字用現在的時間重算', async () => {
    const cases = [
      { remote: 'https://example.com/v.git', sync: { state: 'ok', lastSuccessAt: new Date(T0 - 3 * MIN).toISOString() } },
      { remote: 'https://example.com/v.git', sync: { state: 'offline', lastSuccessAt: new Date(T0 - 50 * 60 * MIN).toISOString() } },
      { remote: 'https://example.com/v.git', sync: { state: 'error', lastSuccessAt: new Date(T0 - 2 * 60 * MIN).toISOString(), error: { code: 'E_CONFLICT' } } },
      { remote: 'https://example.com/v.git', sync: { state: 'error', error: { code: 'E_PUSH_PROTECTED' }, blockedBySecrets: ['a', 'b'] } },
      { remote: 'https://example.com/v.git', sync: { state: 'auth' } },
      { remote: 'https://example.com/v.git', sync: { state: 'syncing' } },
      { sync: { state: 'never' } },
      {
        remote: 'https://example.com/v.git',
        sync: { state: 'error', error: { code: 'E_CONFLICT' } },
        syncIssue: { since: new Date(T0 - 90 * MIN).toISOString(), offline: false, code: 'E_CONFLICT', message: '本機有尚未提交的變更', diagnosis: { blockers: [{ ref: 'global/a.md' }, { ref: 'global/b.md' }, { ref: 'global/c.md' }] } },
      },
    ];
    for (const value of cases) {
      state(value);
      const r = await both(junctionRepo);
      assertSame(r, JSON.stringify(value).slice(0, 60));
    }
    assert.match((await both(junctionRepo, { now: T0 + 14 * MIN })).fast.text, /同步已連續失敗 1 小時 44 分/, '持續時間用現在的時間算');
  });

  test('收件匣、衝突（含核心準則）、使用者暫停', async () => {
    writeJson(local('cache', 'health.json'), { inboxCount: 4 });
    assertSame(await both(junctionRepo), '收件匣');
    fs.rmSync(local('cache', 'health.json'));
    for (const [id, ref] of [['cf_1', 'core/CORE.md'], ['cf_2', 'global/x.md']]) writeJson(path.join(eg.paths.vault, 'conflicts', id, 'meta.json'), { ref });
    const r = await both(junctionRepo);
    assertSame(r, '衝突');
    assert.match(r.full.text, /核心準則 CORE\.md 在兩台電腦有衝突/);
    assert.match(r.full.text, /收件匣：2 項/);
    writeJson(local('paused.json'), { user: true });
    assertSame(await both(junctionRepo), '暫停');
  });

  test('護欄的後備提示：沒有標記檔時加上、有標記檔時不加、設定 off 時不加（每次即時算；用沒有單機記憶的專案，提示才放得下）', async () => {
    const r = await both(settingsRepo, { sessionId: 'no-marker' });
    assertSame(r, '沒有標記檔');
    assert.match(r.full.text, /已知的指令寫法問題/);
    writeJson(local('cache', 'session', 'with-marker.mod'), 'guard\n');
    const marked = await both(settingsRepo, { sessionId: 'with-marker' });
    assertSame(marked, '有標記檔');
    assert.doesNotMatch(marked.full.text, /已知的指令寫法問題/);
    // 設定改了不必重寫快取：後備提示是即時算的
    await eg.sessionCache.write({ now: T0 });
    writeJson(local('settings.json'), { guardrails: 'off' });
    const fast = await fastSessionContext({ homes, cwd: settingsRepo, sessionId: 'no-marker', now: LATER });
    assert.equal(fast.text, (await eg.sessionContext({ cwd: settingsRepo, sessionId: 'no-marker', now: LATER })).text);
    assert.doesNotMatch(fast.text, /已知的指令寫法問題/);
  });

  test('junction 失效時：狀態與警告也一樣；失效之後才發生就不用舊的快取', async () => {
    const target = path.join(eg.paths.vault, 'projects', jpid, 'memory');
    const backup = `${target}.bak`;
    await eg.sessionCache.write({ now: T0 });
    fs.renameSync(target, backup);
    try {
      assert.equal(await fastSessionContext({ homes, cwd: junctionRepo, now: LATER }), null);
      const r = await both(junctionRepo);
      assertSame(r, 'junction 失效');
      assert.match(r.full.text, /綁定失效/);
    } finally {
      fs.renameSync(backup, target);
    }
  });
});

describe('退回完整路徑', () => {
  test('沒有快取、格式不對、超過 15 分鐘、時間在未來', async () => {
    assert.equal(await fastSessionContext({ homes, cwd: junctionRepo, now: LATER }), null);
    writeJson(sessionCacheFile(eg.paths.local), '{oops');
    assert.equal(await fastSessionContext({ homes, cwd: junctionRepo, now: LATER }), null);
    await eg.sessionCache.write({ now: T0 });
    assert.ok(await fastSessionContext({ homes, cwd: junctionRepo, now: T0 + SESSION_CACHE_MAX_AGE_MS }));
    assert.equal(await fastSessionContext({ homes, cwd: junctionRepo, now: T0 + SESSION_CACHE_MAX_AGE_MS + 1 }), null);
    assert.equal(await fastSessionContext({ homes, cwd: junctionRepo, now: T0 - MIN }), null);
  });

  test('寫快取時讀過的檔案變了：同步狀態、收件匣、衝突、單機記憶、專案名稱、綁定、settings.local.json', async () => {
    const changes = [
      () => state({ sync: { state: 'syncing' } }),
      () => writeJson(local('cache', 'health.json'), { inboxCount: 1 }),
      () => writeJson(path.join(eg.paths.vault, 'conflicts', 'cf_9', 'meta.json'), { ref: 'global/y.md' }),
      () => fs.appendFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'bakery-0.md'), '\n補一行。\n'),
      () => fs.writeFileSync(path.join(eg.paths.vault, 'machines', eg.machine.id, 'new-one.md'), memoryText({ name: 'new-one', description: '新的' })),
      () => {
        const p = path.join(eg.paths.vault, 'projects', jpid, 'project.json');
        writeJson(p, { ...JSON.parse(fs.readFileSync(p, 'utf8')), name: '烘焙坊（改名）' });
      },
      () => {
        const p = path.join(eg.paths.vault, 'machines', eg.machine.id, 'bindings.json');
        fs.writeFileSync(p, `${fs.readFileSync(p, 'utf8')}\n`);
      },
      () => writeJson(path.join(settingsRepo, '.claude', 'settings.local.json'), { ...JSON.parse(fs.readFileSync(path.join(settingsRepo, '.claude', 'settings.local.json'), 'utf8')), extra: 1 }),
    ];
    for (const [i, change] of changes.entries()) {
      await eg.sessionCache.write({ now: T0 });
      const cwd = i === changes.length - 1 ? settingsRepo : junctionRepo;
      assert.ok(await fastSessionContext({ homes, cwd, now: LATER }), `第 ${i} 個改變之前可以用`);
      await new Promise((r) => setTimeout(r, 20)); // 修改時間要真的不一樣
      change();
      assert.equal(await fastSessionContext({ homes, cwd, now: LATER }), null, `第 ${i} 個改變之後不用快取`);
    }
  });

  test('資料夾不在快取裡：沒有綁定、撞名、專案資料夾外面', async () => {
    await eg.sessionCache.write({ now: T0 });
    const loose = makeRepo(path.join(root, 'work', 'loose'));
    assert.equal(await fastSessionContext({ homes, cwd: loose, now: LATER }), null);
    assert.equal(await fastSessionContext({ homes, cwd: root, now: LATER }), null);
    // 撞名：和烘焙坊的編碼相同的另一個資料夾（work\bakery 與 work-bakery 編碼都是 …-work-bakery）
    const twin = makeRepo(path.join(root, 'work-bakery'));
    assert.equal(await fastSessionContext({ homes, cwd: twin, now: LATER }), null);
  });

  test('更新 Engram 之後（local/install.json 的版本或 commit 變了）第一次開場就走完整路徑；舊程式寫的快取不用', async () => {
    const install = local('install.json');
    writeJson(install, { appDir: path.join(root, 'app-current'), version: '1.6.0-aaaaaaa', commit: 'aaaaaaa' });
    await eg.sessionCache.write({ now: T0 });
    assert.ok(await fastSessionContext({ homes, cwd: junctionRepo, now: LATER }), '同一版：可以用');
    // 部署新版：install.json 換成新的版本與 commit（修改時間與大小故意維持一樣，只靠內容判斷）
    const st = fs.statSync(install);
    writeJson(install, { appDir: path.join(root, 'app-current'), version: '1.6.0-bbbbbbb', commit: 'bbbbbbb' });
    fs.utimesSync(install, st.atime, st.mtime);
    assert.equal(await fastSessionContext({ homes, cwd: junctionRepo, now: LATER }), null);
    // 寫快取之後才有 install.json（第一次安裝）也一樣
    fs.rmSync(install);
    await eg.sessionCache.write({ now: T0 });
    writeJson(install, { appDir: path.join(root, 'app-current'), version: '1.6.0-ccccccc' });
    assert.equal(await fastSessionContext({ homes, cwd: junctionRepo, now: LATER }), null);
    fs.rmSync(install);
  });

  test('家目錄不同（路徑的 ~ 寫法會不同）、快取版本不同', async () => {
    await eg.sessionCache.write({ now: T0 });
    assert.equal(await fastSessionContext({ homes: { ...homes, userHome: path.join(root, 'someone-else') }, cwd: junctionRepo, now: LATER }), null);
    const cache = JSON.parse(fs.readFileSync(sessionCacheFile(eg.paths.local), 'utf8'));
    writeJson(sessionCacheFile(eg.paths.local), { ...cache, v: 99 });
    assert.equal(await fastSessionContext({ homes, cwd: junctionRepo, now: LATER }), null);
  });
});
