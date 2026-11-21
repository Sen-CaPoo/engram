// 相容模式（2.0.0）：記憶庫裡還有「版本低於 2.0.0、而且近 7 天內有活動」的電腦時，兩台電腦都會寫的共用索引
// （global/INDEX.md 與各專案的 MEMORY.md）要和 1.6.0 產生的內容逐位元相同，不然兩台每一輪同步都互相改寫、commit 不停增加。
// 基準（oracle）是真正的 1.6.0 程式：從 git 標籤 v1.6.0 取出 app/src/core 與 app/plugin 放進暫存資料夾直接匯入，
// 用 1.6.0 的呼叫端傳的參數呼叫；標籤不存在（例如淺層複製）時這幾個測試略過。全部用合成資料，不會碰到真正的 ~/.engram 或 ~/.claude。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApi } from '../../src/agent/api.mjs';
import { init, open } from '../../src/core/index.mjs';
import { planScopeIndex } from '../../src/core/normalize.mjs';
import { readsForScope } from '../../src/core/usage.mjs';
import { ageTree, git, machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const DAY = 86_400_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAYER = /^- 另有 \d+ 筆參考類記憶不在索引，相關時會自動帶出，也可以用 `engram search <關鍵字>` 查詢。$/m;

let eg;
let vault;
let alpha;
let gamma;

/** 把 v1.6.0 的 app/src/core、app/plugin、app/package.json 取出來，匯入當時的 normalize.mjs；沒有標籤時 null */
async function loadOracle(dest) {
  try {
    execFileSync('git', ['cat-file', '-e', 'v1.6.0^{commit}'], { cwd: HERE, stdio: 'ignore' });
  } catch {
    return null; // 沒有標籤（淺層複製、不是 git 倉庫）：略過這幾個測試。標籤在、卻取不出來時要讓測試失敗，不能靜靜略過
  }
  const files = execFileSync('git', ['ls-tree', '-r', '--full-tree', '--name-only', 'v1.6.0', '--', 'app/src/core', 'app/plugin', 'app/package.json'], { cwd: HERE, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    const out = path.join(dest, ...f.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, execFileSync('git', ['cat-file', 'blob', `v1.6.0:${f}`], { cwd: HERE, maxBuffer: 64 * 1024 * 1024 }));
  }
  return import(pathToFileURL(path.join(dest, 'app', 'src', 'core', 'normalize.mjs')).href);
}

// 頂層 await：測試的 skip 選項在註冊時就要知道有沒有基準
const root = mkTmp();
const oracle = await loadOracle(path.join(root, 'v160')); // 1.6.0 的 normalize.mjs；沒有標籤時 null

const memFile = ({ name, description, type, modified, pinned, project }) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  type: ${type}\n${modified ? `  modified: ${modified}\n` : ''}${pinned || project ? `  engram:\n${pinned ? '    pinned: true\n' : ''}${project ? `    project: ${project}\n` : ''}` : ''}---\n${name} 的內文。\n`;
const writeMem = (dir, spec) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${spec.name}.md`), memFile(spec));
};
const pad = (i, n = 2) => String(i).padStart(n, '0');
const sameText = (a, b) => Buffer.from(a).equals(Buffer.from(b));

const globalDir = () => path.join(vault, 'global');
const globalIndexFile = () => path.join(globalDir(), 'INDEX.md');
const machineIndexFile = () => path.join(vault, 'machines', eg.machine.id, 'INDEX.md');
const memDirOf = (pid) => path.join(vault, 'projects', pid, 'memory');
const readText = (p) => fs.readFileSync(p, 'utf8');
const setMachine = (mid, value) => {
  const p = path.join(vault, 'machines', mid, 'machine.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
};
const removeMachine = (mid) => fs.rmSync(path.join(vault, 'machines', mid), { recursive: true, force: true });
const iso = (ms) => new Date(ms).toISOString();
const alphaListed = () => readText(path.join(memDirOf(alpha), 'MEMORY.md')).split('\n').filter((l) => /^- \[a-\d+\]/.test(l)).length;
const tidy = async () => { ageTree(vault); return eg.normalize(); };
const syncLocal = async () => { ageTree(vault); return eg.sync({ network: false }); };

/** 1.6.0 的呼叫端傳的參數（core/sync.mjs 的 tidy）：全域索引的預算與讀取次數 */
async function oracleGlobal() {
  const budget = await eg.indexBudget();
  return oracle.renderScopeIndex({ kind: 'global', dir: globalDir(), userHome: path.dirname(eg.paths.home), projectNames: new Map(), budget: budget.global, reads: await readsForScope(vault, 'global') });
}
/** 同一份 MEMORY.md 目前的內容，交給 1.6.0 的 normalizeProjectIndex 整理（在複本上做，回傳整理後的 MEMORY.md） */
async function oracleProject(pid, tag) {
  const copy = path.join(root, 'oracle-copy', `${tag}-${pid}`, 'memory');
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(memDirOf(pid), copy, { recursive: true });
  await oracle.normalizeProjectIndex(copy, { appendOnly: false, skipRecentMs: 0 });
  return readText(path.join(copy, 'MEMORY.md'));
}

before(async () => {
  const m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '新電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  vault = eg.paths.vault;
  // 全域 70 筆（超過 56 筆就會觸發取捨）：feedback 14 與 user 6 的 modified 最舊；6 筆沒有 modified（commit 之後 git 首次加入時間才有值）；釘選 1 筆
  for (let i = 1; i <= 14; i++) writeMem(globalDir(), { name: `g-fb-${pad(i)}`, description: `舊糾正 ${i}：很久以前寫的偏好`, type: 'feedback', modified: `2026-01-${pad(i)}T00:00:00.000Z` });
  for (let i = 1; i <= 6; i++) writeMem(globalDir(), { name: `g-us-${pad(i)}`, description: `使用者資訊 ${i}`, type: 'user', modified: `2026-01-${pad(i + 14)}T00:00:00.000Z` });
  for (let i = 1; i <= 30; i++) writeMem(globalDir(), { name: `g-pr-${pad(i)}`, description: `專案記憶 ${i}`, type: 'project', modified: `2026-08-${pad(i)}T00:00:00.000Z`, pinned: i === 30 });
  for (let i = 1; i <= 14; i++) writeMem(globalDir(), { name: `g-rf-${pad(i)}`, description: `參考 ${i}`, type: 'reference', modified: `2026-09-${pad(i)}T00:00:00.000Z` });
  for (let i = 1; i <= 6; i++) writeMem(globalDir(), { name: `g-rf-nomod-${pad(i)}`, description: `沒有 modified 的參考 ${i}`, type: 'reference' });
  // 這台電腦的單機記憶：有參考類，索引分層開著時會出現分層說明行
  for (let i = 1; i <= 3; i++) writeMem(path.join(vault, 'machines', eg.machine.id), { name: `m-rf-${i}`, description: `單機參考 ${i}`, type: 'reference', modified: `2026-09-0${i}T00:00:00.000Z` });
  // 專案 Alpha：175 筆，說明很長（超過 160 行的精簡門檻）；專案 Gamma：沒有 MEMORY.md、12 筆
  alpha = (await eg.identity.bind(makeRepo(path.join(root, 'work', 'alpha')), { create: { name: 'Alpha' } })).pid;
  for (let i = 1; i <= 175; i++) writeMem(memDirOf(alpha), { name: `a-${pad(i, 3)}`, description: `Alpha 第 ${i} 筆：${'這是一段很長的說明，用來讓索引超過精簡門檻。'.repeat(3)}第二句。`, type: ['project', 'reference', 'feedback', 'user'][i % 4], modified: `2026-0${(i % 9) + 1}-10T00:00:00.000Z` });
  gamma = (await eg.identity.bind(makeRepo(path.join(root, 'work', 'gamma')), { create: { name: 'Gamma' } })).pid;
  for (let i = 1; i <= 12; i++) writeMem(memDirOf(gamma), { name: `c-${pad(i)}`, description: `Gamma ${i}`, type: 'project', modified: `2026-05-${pad(i)}T00:00:00.000Z` });
  fs.rmSync(path.join(memDirOf(gamma), 'MEMORY.md'), { force: true });
  // 先用 2.0 的規則整理一輪（沒有舊版電腦）：專案索引會被縮短、省略，這是舊版電腦出現之前的狀態
  await syncLocal();
  await syncLocal();
});
after(() => rmTmp(root));

describe('normalize-legacy.mjs 是 1.6.0 的原樣', () => {
  test('函式與常數就是 v1.6.0 的 normalize.mjs 第 12–212 行（只差三個常數的 export）', { skip: !oracle && '沒有 v1.6.0 標籤' }, () => {
    const orig = execFileSync('git', ['show', 'v1.6.0:app/src/core/normalize.mjs'], { cwd: HERE, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').slice(11, 212).join('\n');
    const text = fs.readFileSync(fileURLToPath(new URL('../../src/core/normalize-legacy.mjs', import.meta.url)), 'utf8');
    const body = text.slice(text.indexOf('const PROJECT_INDEX')).replace(/\n$/, '');
    assert.equal(body, orig.replace(/^export const (PROJECT_INDEX|SCOPE_INDEX|INDEX_BUDGET) /gm, 'const $1 '));
  });
});

describe('資料集有效：沒有舊版電腦時 2.0 的輸出和 1.6.0 不一樣（三個差異都被觸發）', () => {
  test('相容模式沒有開；全域索引、Alpha 的 MEMORY.md 和 1.6.0 的輸出都不同', { skip: !oracle && '沒有 v1.6.0 標籤' }, async () => {
    assert.equal((await eg.status()).indexCompat.active, false);
    const g2 = readText(globalIndexFile());
    const g16 = await oracleGlobal();
    assert.notEqual(g2, g16);
    // 差異 1：全域超過預算時，2.0 永遠列出 feedback／user；1.6.0 依近期與修改時間，最舊的 feedback 被擠掉
    assert.match(g2, /\[g-fb-01\]/);
    assert.doesNotMatch(g16, /\[g-fb-01\]/);
    // 差異 2：沒有 metadata.modified 的記憶，2.0 用 git 首次加入的時間（近期）排在前面；1.6.0 當成最舊
    assert.match(g2, /\[g-rf-nomod-01\]/);
    assert.doesNotMatch(g16, /\[g-rf-nomod-01\]/);
    // 差異 3：專案 MEMORY.md 超過 160 行／20KB 時，2.0 縮短並省略；1.6.0 全部照列
    const a2 = readText(path.join(memDirOf(alpha), 'MEMORY.md'));
    assert.match(a2, /另有 \d+ 筆未列出/);
    const a16 = await oracleProject(alpha, 'ctrl');
    assert.notEqual(a2, a16);
    assert.equal(a16.split('\n').filter((l) => /^- \[a-\d+\]/.test(l)).length, 175);
  });
});

describe('相容模式：舊版電腦（1.6.0、近期有活動）在記憶庫裡', () => {
  before(() => setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '1.6.0', lastSeenAt: iso(Date.now() - 2 * DAY), lastSyncAt: iso(Date.now() - 2 * DAY) }));
  after(() => removeMachine('old-pc-0001'));

  test('eg.normalize()：全域索引與 Alpha、Gamma 的 MEMORY.md 逐位元等於 1.6.0 的輸出', { skip: !oracle && '沒有 v1.6.0 標籤' }, async () => {
    // 先備好 1.6.0 的結果（整理之前的狀態），再讓 2.0 整理
    ageTree(vault);
    const expectedAlpha = await oracleProject(alpha, 'n1');
    const expectedGamma = await oracleProject(gamma, 'n1');
    const expectedGlobal = await oracleGlobal();
    const r = await tidy();
    assert.equal(r.ok, true);
    assert.ok(sameText(readText(globalIndexFile()), expectedGlobal), '全域索引與 1.6.0 相同');
    assert.ok(sameText(readText(path.join(memDirOf(alpha), 'MEMORY.md')), expectedAlpha), 'Alpha MEMORY.md 與 1.6.0 相同');
    assert.ok(sameText(readText(path.join(memDirOf(gamma), 'MEMORY.md')), expectedGamma), 'Gamma（原本沒有 MEMORY.md）與 1.6.0 相同');
    assert.match(readText(globalIndexFile()), /^- 另有 \d+ 筆未列出，可用 `engram search <關鍵字>` 查詢。$/m, '全域索引照 1.6.0 的格式（有溢出說明行）');
    // 再整理一次：不再變（冪等），也不產生 commit
    const before = git(vault, 'rev-parse', 'HEAD');
    await tidy();
    assert.equal(git(vault, 'rev-parse', 'HEAD'), before);
    assert.ok(sameText(readText(globalIndexFile()), expectedGlobal));
  });

  test('同步（tidy）與寫入記憶（refreshIndex）走同一條規則：寫入新記憶後全域索引仍等於 1.6.0', { skip: !oracle && '沒有 v1.6.0 標籤' }, async () => {
    await eg.memories.create({ scope: { kind: 'global' }, name: 'g-added', type: 'reference', description: '相容模式下新增的全域記憶', body: '內容。' });
    assert.ok(sameText(readText(globalIndexFile()), await oracleGlobal()), '寫入記憶之後的索引（refreshIndex）');
    await syncLocal();
    assert.ok(sameText(readText(globalIndexFile()), await oracleGlobal()), '同步之後的索引（tidy）');
    for (const pid of [alpha, gamma]) {
      const cur = readText(path.join(memDirOf(pid), 'MEMORY.md'));
      assert.ok(sameText(cur, await oracleProject(pid, 'again')), `${pid} 再整理一次也不會變`);
    }
  });

  test('這台自己的單機索引不走舊版規則，但分層一律當成關閉（共用設定是 on 也一樣）', async () => {
    // 先拿掉舊版電腦，才能把共用的 indexLayers 切成 on；再放回去
    removeMachine('old-pc-0001');
    await eg.settings.set({ indexLayers: 'on' });
    await syncLocal();
    assert.match(readText(machineIndexFile()), LAYER, '沒有舊版電腦：分層生效');
    assert.match(readText(globalIndexFile()), LAYER);
    setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '1.6.0', lastSeenAt: iso(Date.now() - 2 * DAY) });
    await tidy();
    assert.doesNotMatch(readText(machineIndexFile()), LAYER, '相容模式：單機索引不分層');
    assert.doesNotMatch(readText(globalIndexFile()), LAYER, '相容模式：全域索引不分層');
    assert.equal((await eg.settings.get()).indexLayers, 'on', '共用設定本身沒被改（改回 observe 是常駐程式的工作）');
    assert.equal((await eg.recall.status()).effectiveLayers, 'off');
    await eg.settings.set({ indexLayers: 'observe' });
  });

  test('1.6.0 的行數預算與這一版算出來的一樣（相容模式沿用呼叫端傳的預算）', { skip: !oracle && '沒有 v1.6.0 標籤' }, async () => {
    assert.deepEqual(await eg.indexBudget(), await oracle.computeIndexBudget(vault));
  });

  test('舊版電腦超過 7 天沒有活動：下一次整理的輸出是 2.0 的規則（不是只有狀態變了）', async () => {
    await tidy();
    assert.doesNotMatch(readText(globalIndexFile()), /\[g-fb-01\]/, '7 天內有活動：1.6.0 的輸出');
    // 專案索引：1.6.0 不省略，175 筆全部列出（2.0 之前留下的「另有 N 筆未列出」那行 1.6.0 也不會清掉，所以數連結行，不看說明行）
    assert.equal(alphaListed(), 175, '7 天內有活動：Alpha 全部列出');
    setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '1.6.0', lastSeenAt: iso(Date.now() - 8 * DAY), lastSyncAt: iso(Date.now() - 8 * DAY) });
    await tidy();
    assert.match(readText(globalIndexFile()), /\[g-fb-01\]/, '全域索引：2.0 的規則');
    assert.ok(alphaListed() < 175, '專案索引：2.0 的自動縮短與省略（依排名省略一部分）');
    assert.match(readText(path.join(memDirOf(alpha), 'MEMORY.md')), /另有 \d+ 筆未列出/);
    // 又有活動（例如長假回來、同步了一次）：下一次整理再切回 1.6.0 的輸出
    setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '1.6.0', lastSeenAt: iso(Date.now() - 8 * DAY), lastSyncAt: iso(Date.now()) });
    await tidy();
    assert.doesNotMatch(readText(globalIndexFile()), /\[g-fb-01\]/);
    setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '1.6.0', lastSeenAt: iso(Date.now() - 2 * DAY), lastSyncAt: iso(Date.now() - 2 * DAY) });
  });

  test('專案索引裡有 decodeURI 讀不懂的連結（1.6.0 的 localTarget 會丟 URIError）：同步不會失敗，那個專案的索引這一輪不動', async () => {
    const f = path.join(memDirOf(gamma), 'MEMORY.md');
    const orig = readText(f);
    fs.writeFileSync(f, `${orig}- [壞連結](http://example.com/50%off)\n`);
    try {
      ageTree(vault);
      const r = await eg.sync({ network: false });
      assert.equal(r.ok, true, `同步要成功：${r.error?.message ?? ''}`);
      assert.match(readText(f), /50%off/, '那個專案的索引沒被動');
      assert.equal(((await tidy()).ok), true, 'eg.normalize() 也不會失敗');
    } finally {
      fs.writeFileSync(f, orig);
    }
  });

  test('舊版電腦升級（machine.json 的版本變成 2.0.0）之後，下一次整理就切換成 2.0 的規則', { skip: !oracle && '沒有 v1.6.0 標籤' }, async () => {
    await tidy();
    assert.ok(sameText(readText(globalIndexFile()), await oracleGlobal()), '升級前：1.6.0 的輸出');
    setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '2.0.0', lastSeenAt: iso(Date.now()) });
    await tidy();
    const g = readText(globalIndexFile());
    assert.notEqual(g, await oracleGlobal(), '升級後：不再是 1.6.0 的輸出');
    assert.match(g, /\[g-fb-01\]/, '2.0 的規則：feedback 永遠列出');
    assert.equal((await eg.status()).indexCompat.active, false);
    assert.match(readText(path.join(memDirOf(alpha), 'MEMORY.md')), /另有 \d+ 筆未列出/, '專案索引也切回 2.0 的自動縮短與省略');
    // 再回到 1.6.0（例如又有一台舊電腦出現）：下一次整理又切回去，內容還是 1.6.0 的
    setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '1.6.0', lastSeenAt: iso(Date.now()) });
    await tidy();
    assert.ok(sameText(readText(globalIndexFile()), await oracleGlobal()));
  });
});

describe('相容模式的判斷條件', () => {
  const compat = async () => (await eg.status()).indexCompat;
  const now = () => Date.now();
  const cases = [
    ['1.6.0、1 天前有活動', { label: 'A1', engramVersion: '1.6.0', lastSeenAt: () => iso(now() - DAY) }, true],
    ['1.6.0、最後上線 30 天前但 2 天前同步過（長假回來）', { label: 'A2', engramVersion: '1.6.0', lastSeenAt: () => iso(now() - 30 * DAY), lastSyncAt: () => iso(now() - 2 * DAY) }, true],
    ['1.6.0、8 天沒有活動', { label: 'A3', engramVersion: '1.6.0', lastSeenAt: () => iso(now() - 8 * DAY), lastSyncAt: () => iso(now() - 9 * DAY) }, false],
    ['1.9.9（低於 2.0.0）、剛上線', { label: 'A4', engramVersion: '1.9.9', lastSeenAt: () => iso(now()) }, true],
    ['2.0.0、剛上線', { label: 'A5', engramVersion: '2.0.0', lastSeenAt: () => iso(now()) }, false],
    ['2.1.0-abc1234（帶 commit 後綴）', { label: 'A6', engramVersion: '2.1.0-abc1234', lastSeenAt: () => iso(now()) }, false],
    ['缺 engramVersion、剛上線：看不出版本，當成舊版', { label: 'A7', lastSeenAt: () => iso(now()) }, true],
    ['只有版本 1.6.0、沒有任何時間欄位：每一版登記電腦時都會寫最後上線時間，沒有的不會是真的在用的電腦，不算', { label: 'A8', engramVersion: '1.6.0' }, false],
    ['{}（沒有任何欄位）：不算（算進來的話相容模式會永遠開著）', {}, false],
    ['machine.json 讀不懂（不是 JSON）：同上', '{ this is not json', false],
    ['缺 engramVersion、但 40 天沒有活動：不算', { label: 'A9', lastSeenAt: () => iso(now() - 40 * DAY) }, false],
    // 第五輪審查 N-6：時間在未來的不算數（否則相容模式會一直開著）；另一個時間是正常的就照它算
    ['1.6.0、最後上線時間在十年後、沒有別的時間：不算', { label: 'A10', engramVersion: '1.6.0', lastSeenAt: () => iso(now() + 3650 * DAY) }, false],
    ['1.6.0、最後上線時間在十年後、但 2 天前同步過：算', { label: 'A11', engramVersion: '1.6.0', lastSeenAt: () => iso(now() + 3650 * DAY), lastSyncAt: () => iso(now() - 2 * DAY) }, true],
    ['時間不是字串（數字）：不算', { label: 'A12', engramVersion: '1.6.0', lastSeenAt: 1 }, false],
  ];
  for (const [title, spec, expected] of cases) {
    test(title, async () => {
      const value = typeof spec === 'string' ? spec : Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === 'function' ? v() : v]));
      setMachine('probe-pc-0002', value);
      try {
        const c = await compat();
        assert.equal(c.active, expected);
        if (expected) assert.deepEqual(c.machines.map((x) => x.mid), ['probe-pc-0002']);
        else assert.deepEqual(c.machines, []);
      } finally {
        removeMachine('probe-pc-0002');
      }
    });
  }

  test('同步來的 machine.json 不是檔案（被做成資料夾）：當成沒有這台，整理索引、寫入記憶與狀態都照常（第五輪審查 N-5）', async () => {
    const bad = path.join(vault, 'machines', 'probe-pc-0002', 'machine.json');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'x'), 'not a machine file');
    try {
      const c = await compat();
      assert.equal(c.active, false);
      assert.equal((await tidy()).ok, true);
      assert.equal((await syncLocal()).ok, true);
    } finally {
      removeMachine('probe-pc-0002');
    }
  });

  test('這台自己的 machine.json 還寫著舊版本（剛升級、心跳還沒更新）：不算', async () => {
    // 先讓全域索引變成 1.6.0 的樣子（有另一台舊版電腦），再拿掉那一台
    setMachine('old-pc-0004', { label: '舊桌機', engramVersion: '1.6.0', lastSeenAt: iso(now()) });
    await tidy();
    assert.doesNotMatch(readText(globalIndexFile()), /\[g-fb-01\]/);
    removeMachine('old-pc-0004');
    const p = path.join(vault, 'machines', eg.machine.id, 'machine.json');
    const orig = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(orig), engramVersion: '1.6.0', lastSeenAt: iso(now()) }));
    try {
      assert.equal((await compat()).active, false);
      // 產生索引的函式也不能把自己算進去：整理之後換成 2.0 的規則
      await tidy();
      assert.match(readText(globalIndexFile()), /\[g-fb-01\]/);
    } finally {
      fs.writeFileSync(p, orig);
    }
  });
});

describe('讓使用者知道：status、GET /api/status、GET /api/recall', () => {
  test('相容模式時 indexCompat 列出是哪幾台、版本，附中英文說明；升級之後消失', async () => {
    setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '1.6.0', lastSeenAt: iso(Date.now() - DAY) });
    setMachine('old-pc-0003', { id: 'old-pc-0003', label: '門市桌機', lastSeenAt: iso(Date.now()) });
    try {
      const api = createApi({ eg, jobs: {}, paths: { local: eg.paths.local, home: eg.paths.home, vault }, info: { statusSummary: () => ({}) } });
      const st = await api.handle('GET', '/api/status', new URLSearchParams(), {});
      const c = st.indexCompat;
      assert.equal(c.active, true);
      assert.equal(c.since, '2.0.0');
      assert.deepEqual(c.machines.map((x) => [x.mid, x.label, x.version]), [['old-pc-0001', '舊筆電', '1.6.0'], ['old-pc-0003', '門市桌機', null]]);
      assert.ok(c.machines.every((x) => typeof x.lastActiveAt === 'string'));
      assert.match(c.message, /相容模式/);
      assert.match(c.message, /舊筆電（1\.6\.0）/);
      assert.match(c.message, /門市桌機（版本不明）/);
      assert.match(c.message, /更新.*自動切換/);
      assert.match(c.en.message, /compatibility mode/i);
      assert.match(c.en.message, /舊筆電 \(1\.6\.0\)/);
      assert.match(c.en.message, /門市桌機 \(unknown version\)/);
      assert.match(c.en.message, /switches? .*automatically|by itself/i);
      const rc = await api.handle('GET', '/api/recall', new URLSearchParams(), {});
      assert.equal(rc.effectiveLayers, 'off');
      assert.deepEqual(rc.indexCompat, c);
      setMachine('old-pc-0001', { id: 'old-pc-0001', label: '舊筆電', engramVersion: '2.0.0', lastSeenAt: iso(Date.now()) });
      setMachine('old-pc-0003', { id: 'old-pc-0003', label: '門市桌機', engramVersion: '2.0.0', lastSeenAt: iso(Date.now()) });
      const after = (await api.handle('GET', '/api/status', new URLSearchParams(), {})).indexCompat;
      assert.deepEqual([after.active, after.machines, after.message], [false, [], undefined]);
    } finally {
      removeMachine('old-pc-0001');
      removeMachine('old-pc-0003');
    }
  });
});
