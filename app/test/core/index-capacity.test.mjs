// WP1 索引容量：P1 全域／單機索引的截斷保護、P7 專案 MEMORY.md 的容量自動處理。全部用合成資料。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { getField, parseMemoryFile } from '../../src/core/frontmatter.mjs';
import { normalizeMemoryIndexText, normalizeProjectIndex, renderScopeIndex, shortDescription } from '../../src/core/normalize.mjs';
import { git, machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const DAY = 86_400_000;
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const lineCount = (s) => s.replace(/\n+$/, '').split('\n').length;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

let root;
let m;
let eg;
let repo;
let pid;

before(async () => {
  root = mkTmp();
  m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '家裡電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
  repo = makeRepo(path.join(root, 'work', 'gateway'));
  pid = (await eg.identity.bind(repo, { create: { name: '閘道' } })).pid;
});
after(() => rmTmp(root));

/** 合成記憶檔：沒有 modified 的就不寫這個欄位（模擬 engram remember 舊版寫出的檔案） */
function memFile({ name, description, type = 'reference', modified, pinned }) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  type: ${type}\n${modified ? `  modified: ${modified}\n` : ''}${pinned ? '  engram:\n    pinned: true\n' : ''}---\n${name} 的內文。\n`;
}
function writeAll(dir, specs) {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of specs) fs.writeFileSync(path.join(dir, `${s.name}.md`), memFile(s));
}
const shownNames = (text) => [...text.matchAll(/^- \[([^\]]+)\]/gm)].map((x) => x[1]);
const pad = (i, n = 2) => String(i).padStart(n, '0');

describe('P1 全域／單機索引的截斷保護', () => {
  test('73 筆放不下：63 筆沒有 modified、feedback 與 user 排在字母序後段，仍全部列出', async () => {
    const dir = path.join(root, 'p1-a');
    const specs = [];
    for (let i = 1; i <= 54; i++) specs.push({ name: `ref-${pad(i)}`, description: `參考 ${i}` });
    for (let i = 1; i <= 4; i++) specs.push({ name: `tool-${i}`, description: `工具 ${i}`, type: 'project' });
    for (let i = 1; i <= 4; i++) specs.push({ name: `zz-fix-${i}`, description: `糾正 ${i}`, type: 'feedback' });
    specs.push({ name: 'zz-me', description: '關於使用者', type: 'user' });
    for (let i = 1; i <= 5; i++) specs.push({ name: `fresh-${i}`, description: `新 ${i}`, modified: new Date(Date.now() - i * 3_600_000).toISOString() });
    for (let i = 1; i <= 5; i++) specs.push({ name: `dated-${i}`, description: `舊 ${i}`, modified: `2026-01-0${i}T00:00:00.000Z` });
    assert.equal(specs.length, 73);
    assert.equal(specs.filter((s) => !s.modified).length, 63);
    writeAll(dir, specs);
    const text = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 60 });
    const shown = shownNames(text);
    for (const n of ['zz-fix-1', 'zz-fix-2', 'zz-fix-3', 'zz-fix-4', 'zz-me']) assert.ok(shown.includes(n), `${n} 要列出`);
    for (let i = 1; i <= 5; i++) assert.ok(shown.includes(`fresh-${i}`), `近 14 天的 fresh-${i} 要列出`);
    assert.equal(shown.length, 54);
    assert.match(text, /另有 19 筆未列出，可用 `engram search <關鍵字>` 查詢。/);
    assert.equal(await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 60 }), text, '冪等');
  });

  test('feedback／user 不參與截斷：超過預算也全部列出，其他類型先被擠掉', async () => {
    const dir = path.join(root, 'p1-b');
    const specs = [];
    for (let i = 1; i <= 5; i++) specs.push({ name: `fb-${i}`, description: `糾正 ${i}`, type: i % 2 ? 'feedback' : 'user', modified: '2026-01-01T00:00:00.000Z' });
    for (let i = 1; i <= 3; i++) specs.push({ name: `new-${i}`, description: `新 ${i}`, modified: new Date(Date.now() - i * 3_600_000).toISOString() });
    writeAll(dir, specs);
    // 預算 8 行：8 筆＋檔頭 4 行放不下 → 一般只能列 2 筆，但 5 筆 feedback／user 一定要在
    const text = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 8 });
    assert.deepEqual(shownNames(text).sort(), ['fb-1', 'fb-2', 'fb-3', 'fb-4', 'fb-5']);
    assert.match(text, /另有 3 筆未列出/);
  });

  test('釘選的仍排最前（顯示順序）', async () => {
    const dir = path.join(root, 'p1-c');
    writeAll(dir, [
      { name: 'aa', description: 'x', modified: '2026-03-01T00:00:00.000Z' },
      { name: 'bb', description: 'x', modified: '2026-02-01T00:00:00.000Z', pinned: true },
      { name: 'cc', description: 'x', type: 'feedback', modified: '2026-04-01T00:00:00.000Z' },
    ]);
    const text = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 60 });
    assert.deepEqual(shownNames(text), ['bb', 'cc', 'aa']);
  });

  describe('缺 modified 時用 git 首次加入的作者時間', () => {
    const base = () => path.join(root, 'gitcase');
    const vault = () => path.join(base(), 'vault');
    const gdir = () => path.join(vault(), 'global');
    const cacheFile = () => path.join(base(), 'local', 'cache', 'first-added.json');
    const gitAt = (iso, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: vault(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    });
    const add = (file, iso) => {
      fs.writeFileSync(path.join(gdir(), file), memFile({ name: file.replace(/\.md$/, ''), description: file }));
      gitAt(iso, 'add', '-A');
      gitAt(iso, 'commit', '-q', '-m', `add ${file}`);
    };
    const render = () => renderScopeIndex({ kind: 'global', dir: gdir(), userHome: root, budget: 8 });

    test('用首次提交時間挑選與排序（沒有 modified 的 5 筆，預算只放得下 2 筆）', async () => {
      fs.mkdirSync(gdir(), { recursive: true });
      git(vault(), 'init', '-q', '-b', 'main');
      git(vault(), 'config', 'user.name', 'Test');
      git(vault(), 'config', 'user.email', 't@example.com');
      add('a-old.md', '2026-01-01T00:00:00Z');
      add('b-old.md', '2026-01-02T00:00:00Z');
      add('c-old.md', '2026-01-03T00:00:00Z');
      add('d-mid.md', '2026-02-01T00:00:00Z');
      add('z-fresh.md', new Date(Date.now() - 2 * DAY).toISOString().replace(/\.\d+Z$/, 'Z'));
      const text = await render();
      // 沒有 git 後備時退化成檔名字母序（a-old、b-old）；有後備：近 14 天的 z-fresh 優先，再來是較新的 d-mid，顯示依時間新到舊
      assert.deepEqual(shownNames(text), ['z-fresh', 'd-mid']);
      assert.equal(await render(), text, '冪等');
    });

    test('結果以 HEAD 為鍵快取在 local/cache/；HEAD 沒變就不再呼叫 git，HEAD 變了就重算', async () => {
      const head = git(vault(), 'rev-parse', 'HEAD').trim();
      const cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      assert.equal(cache.head, head);
      // 竄改快取內容：若有用到快取（沒有再問 git），a-old 會被當成「近 14 天」而入選
      cache.dates['global/a-old.md'] = '2099-01-01T00:00:00.000Z';
      fs.writeFileSync(cacheFile(), JSON.stringify(cache));
      assert.deepEqual(shownNames(await render()), ['a-old', 'z-fresh']);
      // 新的 commit：HEAD 變了，重新問 git，竄改的值消失
      add('e-new.md', '2026-03-01T00:00:00Z');
      assert.deepEqual(shownNames(await render()), ['z-fresh', 'e-new']);
      assert.equal(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).head, git(vault(), 'rev-parse', 'HEAD').trim());
    });

    test('有 metadata.modified 的以 modified 為準，不看 git', async () => {
      // modified 是很久以前，但 git 提交時間是昨天：若誤用 git 時間，它會被當成近 14 天而入選
      fs.writeFileSync(path.join(gdir(), 'f-own.md'), memFile({ name: 'f-own', description: 'f', modified: '2026-01-01T00:00:00.000Z' }));
      const yesterday = new Date(Date.now() - DAY).toISOString().replace(/\.\d+Z$/, 'Z');
      gitAt(yesterday, 'add', '-A');
      gitAt(yesterday, 'commit', '-q', '-m', 'add f-own');
      assert.deepEqual(shownNames(await render()), ['z-fresh', 'e-new']);
    });
  });
});

describe('P1 新建記憶帶 metadata.modified', () => {
  const raw = (ref) => fs.readFileSync(path.join(eg.paths.vault, ...ref.split('/')), 'utf8');

  test('引擎（engram remember 的實作）新建的記憶帶 ISO 的 metadata.modified', async () => {
    const t0 = Date.now();
    const r = await eg.memories.create({ scope: { kind: 'global' }, name: 'cap-created', type: 'feedback', description: '測試用', body: '內文' });
    const mod = String(getField(parseMemoryFile(raw(r.ref)).data, 'metadata.modified'));
    assert.match(mod, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(mod) - t0) < 60_000);
    const s = (await eg.memories.list({ scope: 'global' })).find((x) => x.ref === r.ref);
    assert.equal(s.updatedAt, mod);
  });

  test('整份 text 寫入（記憶整理頁核可的內容）維持原樣、不補 modified：續做時靠內容比對認得做過的那一步', async () => {
    const text = '---\nname: x\ndescription: d\nmetadata:\n  type: reference\n---\n內文\n';
    const a = await eg.memories.create({ scope: { kind: 'global' }, name: 'cap-text-a', type: 'reference', description: 'd', text });
    assert.equal(raw(a.ref), text);
  });

  test('不為了補欄位去改寫既有記憶：既有沒有 modified 的檔案位元組不變', async () => {
    const file = path.join(eg.paths.vault, 'global', 'cap-legacy.md');
    const legacy = memFile({ name: 'cap-legacy', description: '舊版寫出的記憶' });
    fs.writeFileSync(file, legacy);
    await eg.memories.create({ scope: { kind: 'global' }, name: 'cap-another', type: 'reference', description: 'd', body: 'b' });
    await eg.normalize();
    assert.equal(fs.readFileSync(file, 'utf8'), legacy);
  });
});

describe('P7 shortDescription', () => {
  test('在第一個句號、分號、全形冒號或 90 個字元處截斷，截掉東西時結尾加「…」', () => {
    assert.equal(shortDescription('第一句。第二句'), '第一句…');
    assert.equal(shortDescription('甲；乙'), '甲…');
    assert.equal(shortDescription('標題：內容很長'), '標題…');
    assert.equal(shortDescription('Use this tool. Then that'), 'Use this tool…');
    assert.equal(shortDescription('a; b'), 'a…');
    assert.equal(shortDescription('version 22.1 is required'), 'version 22.1 is required', '數字中的點不算句號');
    assert.equal(shortDescription('沒有標點的一句話'), '沒有標點的一句話');
    assert.equal(shortDescription('完整的一句。'), '完整的一句', '句號在結尾：沒有截掉東西');
    assert.equal(shortDescription('甲'.repeat(95)), `${'甲'.repeat(90)}…`);
    assert.equal(shortDescription('甲'.repeat(90)), '甲'.repeat(90));
    assert.equal(shortDescription('  多餘\n空白  的說明  '), '多餘 空白 的說明');
    assert.equal(shortDescription(''), '');
  });
});

describe('P7 專案 MEMORY.md 的容量自動處理', () => {
  const entry = (i, over = {}) => ({
    file: `note-${pad(i)}.md`, name: `note-${pad(i)}`, description: `Item ${pad(i)} first sentence. ${'x'.repeat(250)}`, pinned: false, type: 'reference', modified: '', ...over,
  });
  const lineOf = (e) => `- [${e.name}](${e.file}) — ${e.description}`;
  const linkLines = (text) => text.split('\n').filter((l) => /^- \[[^\]]+\]\([^)]+\.md\)/.test(l));

  test('24.4KB 的索引：精簡後低於 80%、每筆記憶仍有一行、手寫的非連結行不變', () => {
    const files = Array.from({ length: 83 }, (_, i) => entry(i + 1));
    const hand = ['# 專案記憶索引', '', '手寫說明：請先讀 note-01，再看其他。', '## 工具（手寫的標題）'];
    const text = `${[hand[0], hand[1], ...files.slice(0, 40).map(lineOf), hand[2], hand[3], ...files.slice(40).map(lineOf)].join('\n')}\n`;
    assert.ok(bytes(text) > 24_000 && bytes(text) < 25_600, `假索引 ${bytes(text)} B`);
    const out = normalizeMemoryIndexText(text, files, { now: Date.now() });
    assert.ok(bytes(out) < 20_480, `精簡後 ${bytes(out)} B`);
    assert.doesNotMatch(out, /另有/);
    const lines = out.replace(/\n$/, '').split('\n');
    for (const h of hand) assert.ok(lines.includes(h), `手寫行不動：${h}`);
    assert.equal(linkLines(out).length, 83);
    for (const f of files) assert.ok(lines.includes(`- [${f.name}](${f.file}) — Item ${f.name.slice(5)} first sentence…`), `${f.file} 的說明縮成一句`);
    // 順序不變：手寫行仍在原來的位置
    assert.equal(lines.indexOf(hand[2]), 2 + 40);
  });

  test('已經夠短的行不動，沒有說明的連結行不動', () => {
    const files = Array.from({ length: 83 }, (_, i) => entry(i + 1));
    files[0].description = '短';
    files[1].description = '';
    const text = `${files.map(lineOf).join('\n')}\n`;
    const out = normalizeMemoryIndexText(text, files).split('\n');
    assert.equal(out[0], '- [note-01](note-01.md) — 短');
    assert.equal(out[1], '- [note-02](note-02.md) — ');
  });

  test('冪等：連續執行兩次結果一字不差', () => {
    const files = Array.from({ length: 83 }, (_, i) => entry(i + 1));
    const text = `${files.map(lineOf).join('\n')}\n`;
    const once = normalizeMemoryIndexText(text, files);
    assert.equal(normalizeMemoryIndexText(once, files), once);
  });

  test('行數到 160 行也進入精簡模式：說明已經很短、放不下時省略並加「另有 N 筆」', () => {
    const files = Array.from({ length: 170 }, (_, i) => entry(i + 1, { description: '短' }));
    const text = `${files.map(lineOf).join('\n')}\n`;
    const out = normalizeMemoryIndexText(text, files);
    assert.ok(lineCount(out) < 160, `${lineCount(out)} 行`);
    const kept = linkLines(out).length;
    assert.ok(kept >= 150 && kept < 170);
    assert.match(out, new RegExp(`- 另有 ${170 - kept} 筆未列出，可用 \`engram search <關鍵字>\` 查詢。\\n$`));
    assert.equal(normalizeMemoryIndexText(out, files), out, '冪等');
  });

  describe('超大索引：依「釘選 → feedback／user → 近 14 天 → 近 90 天讀取次數 → 修改時間」保留', () => {
    const long = (tag) => `${'甲'.repeat(95)}。${tag}`;
    const mk = () => {
      const recent = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
      const files = [];
      for (let i = 1; i <= 3; i++) files.push(entry(i, { file: `fb-${i}.md`, name: `fb-${i}`, type: 'feedback', modified: '2026-01-01T00:00:00.000Z' }));
      files.push(entry(0, { file: 'me-1.md', name: 'me-1', type: 'user', modified: '2026-01-01T00:00:00.000Z' }));
      files.push(entry(0, { file: 'pin-1.md', name: 'pin-1', pinned: true, modified: '2026-01-01T00:00:00.000Z' }));
      for (let i = 1; i <= 2; i++) files.push(entry(0, { file: `new-${i}.md`, name: `new-${i}`, modified: recent(i) }));
      for (let i = 1; i <= 3; i++) files.push(entry(0, { file: `hot-${i}.md`, name: `hot-${i}`, modified: '2026-01-01T00:00:00.000Z' }));
      for (let i = 1; i <= 90; i++) files.push(entry(0, { file: `old-${pad(i)}.md`, name: `old-${pad(i)}`, modified: `2026-02-${pad(1 + (i % 27))}T${pad(i % 24)}:00:00.000Z` }));
      for (const f of files) f.description = long(f.name);
      return files;
    };
    const reads = (file) => ({ 'hot-1.md': 30, 'hot-2.md': 20, 'hot-3.md': 10 }[file] ?? 0);
    const opts = { now: Date.now(), reads };
    const hand = '# 手寫標題';
    const build = (files) => `${[hand, ...files.map(lineOf)].join('\n')}\n`;

    test('保留放得下的、其餘不列，結尾「另有 N 筆」；結果低於 80%', () => {
      const files = mk();
      assert.equal(files.length, 100);
      const text = build(files);
      assert.ok(bytes(text) > 25_000, '輸入已經超過 25KB');
      const out = normalizeMemoryIndexText(text, files, opts);
      assert.ok(bytes(out) < 20_480, `${bytes(out)} B`);
      assert.ok(lineCount(out) < 160);
      const kept = linkLines(out).map((l) => /^- \[([^\]]+)\]/.exec(l)[1]);
      for (const n of ['pin-1', 'fb-1', 'fb-2', 'fb-3', 'me-1', 'new-1', 'new-2', 'hot-1', 'hot-2', 'hot-3']) assert.ok(kept.includes(n), `${n} 要保留`);
      assert.ok(kept.length < 100 && kept.length > 40, `保留 ${kept.length} 筆`);
      assert.match(out, new RegExp(`- 另有 ${100 - kept.length} 筆未列出，可用 \`engram search <關鍵字>\` 查詢。\\n$`));
      assert.ok(out.startsWith(`${hand}\n`), '手寫行不動');
      // 其餘依修改時間新到舊保留：留下的最舊一筆不比被省略的最新一筆舊
      const mod = new Map(files.map((f) => [f.name, f.modified]));
      const olds = files.filter((f) => f.name.startsWith('old-'));
      const keptOld = olds.filter((f) => kept.includes(f.name)).map((f) => f.modified).sort();
      const dropOld = olds.filter((f) => !kept.includes(f.name)).map((f) => f.modified).sort();
      assert.ok(dropOld.length > 0 && keptOld.length > 0);
      assert.ok(keptOld[0] >= dropOld[dropOld.length - 1], '依修改時間新到舊保留');
      void mod;
    });

    test('冪等；被省略的檔案不會被「補上沒列在索引的檔案」加回來', () => {
      const files = mk();
      const once = normalizeMemoryIndexText(build(files), files, opts);
      assert.equal(normalizeMemoryIndexText(once, files, opts), once);
      // 新增一筆很舊的記憶：進不了
      const older = entry(0, { file: 'old-00.md', name: 'old-00', modified: '2025-01-01T00:00:00.000Z', description: long('old-00') });
      const again = normalizeMemoryIndexText(once, [...files, older], opts);
      assert.doesNotMatch(again, /old-00\.md/);
      assert.equal(linkLines(again).length, linkLines(once).length);
      assert.match(again, /另有 \d+ 筆未列出/);
      // 新增一筆剛寫的記憶：近 14 天，進得去（擠掉排名最後的）
      const fresh = entry(0, { file: 'fresh-x.md', name: 'fresh-x', modified: new Date().toISOString(), description: long('fresh-x') });
      const withFresh = normalizeMemoryIndexText(once, [...files, fresh], opts);
      assert.match(withFresh, /fresh-x\.md/);
      assert.ok(bytes(withFresh) < 20_480);
      assert.equal(normalizeMemoryIndexText(withFresh, [...files, fresh], opts), withFresh);
    });

    test('進行中的對話（appendOnly）不精簡、不省略', () => {
      const files = mk();
      const text = build(files);
      assert.equal(normalizeMemoryIndexText(text, files, { ...opts, appendOnly: true }), text);
    });

    test('進行中的對話：索引已經在省略時，被省略的不會被「補上」加回來；剛寫的（近 14 天）仍補上', () => {
      const files = mk();
      const once = normalizeMemoryIndexText(build(files), files, opts);
      assert.match(once, /另有 \d+ 筆未列出/);
      assert.equal(normalizeMemoryIndexText(once, files, { ...opts, appendOnly: true }), once, '被省略的不加回來');
      const fresh = entry(0, { file: 'fresh-y.md', name: 'fresh-y', modified: new Date().toISOString(), description: long('fresh-y') });
      const added = normalizeMemoryIndexText(once, [...files, fresh], { ...opts, appendOnly: true });
      assert.ok(added.startsWith(once), '只附加、不動原有的行');
      assert.match(added.slice(once.length), /^- \[fresh-y\]\(fresh-y\.md\)/);
    });

    test('Claude 手寫的標題和重新產生的不一樣（連結文字、說明較長）：省略後再執行一次結果不變', () => {
      for (const pad of [0, 10, 25, 40, 55, 70]) {
        const files = mk();
        const text = `${[hand, ...files.map((f) => `- [${'題'.repeat(pad)}${f.name}](${f.file}) — ${f.description}`)].join('\n')}\n`;
        const once = normalizeMemoryIndexText(text, files, opts);
        assert.match(once, /另有 \d+ 筆未列出/);
        assert.ok(bytes(once) < 20_480);
        assert.equal(normalizeMemoryIndexText(once, files, opts), once, `標題多 ${pad} 個字`);
      }
    });
  });

  test('normalizeProjectIndex：只改索引那一行，記憶檔內文不動；第二次不再改', async () => {
    const dir = path.join(root, 'p7-dir');
    const specs = Array.from({ length: 80 }, (_, i) => ({ name: `note-${pad(i + 1)}`, description: `Item ${pad(i + 1)} first sentence. ${'x'.repeat(250)}`, modified: '2026-01-01T00:00:00.000Z' }));
    writeAll(dir, specs);
    const files = Array.from({ length: 80 }, (_, i) => entry(i + 1));
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), `# 索引\n${files.map(lineOf).join('\n')}\n`);
    const snap = () => Object.fromEntries(fs.readdirSync(dir).filter((f) => f !== 'MEMORY.md').map((f) => [f, sha(fs.readFileSync(path.join(dir, f), 'utf8'))]));
    const before1 = snap();
    assert.ok(fs.statSync(path.join(dir, 'MEMORY.md')).size > 20_480);
    const r = await normalizeProjectIndex(dir, { skipRecentMs: 0 });
    assert.equal(r.changed, true);
    const text = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    assert.ok(bytes(text) < 20_480);
    assert.equal(linkLines(text).length, 80);
    assert.match(text, /^# 索引\n- \[note-01\]\(note-01\.md\) — Item 01 first sentence…\n/);
    assert.deepEqual(snap(), before1, '記憶檔內文不動');
    assert.equal((await normalizeProjectIndex(dir, { skipRecentMs: 0 })).changed, false);
  });
});

describe('P7 健康檢查：索引位元組 80% 預警', () => {
  const idx = () => path.join(eg.paths.vault, 'projects', pid, 'memory', 'MEMORY.md');
  const h01 = async () => (await eg.health()).filter((f) => f.code === 'H01' && f.pid === pid);
  const write = (lines, size) => {
    fs.mkdirSync(path.dirname(idx()), { recursive: true });
    fs.writeFileSync(idx(), `${Array.from({ length: lines }, (_, i) => `- [n${i}](n${i}.md) — ${'x'.repeat(size)}`).join('\n')}\n`);
  };

  test('位元組到 20KB 就有 H01 預警（行數還遠低於 150 行），訊息說明目前位元組與上限', async () => {
    write(60, 250); // 約 15KB：沒有預警
    assert.equal((await h01()).length, 0);
    write(70, 290); // 約 21KB、70 行
    const cards = await h01();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].severity, 'low');
    assert.match(cards[0].detail, /70 行/);
    assert.match(cards[0].detail, /\d+\.\dKB/);
    assert.match(cards[0].detail, /25KB/);
    assert.match(cards[0].en.detail, /70 lines/);
    assert.match(cards[0].en.detail, /\d+\.\dKB/);
    assert.match(cards[0].en.detail, /25KB/);
    fs.rmSync(idx(), { force: true });
  });

  test('索引有「另有 N 筆未列出」那行時，沒列出的記憶是刻意省略的，H03 不報；沒有那行時照報', async () => {
    const dir = path.join(eg.paths.vault, 'projects', pid, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'zz-h03-a.md'), memFile({ name: 'zz-h03-a', description: 'a' }));
    fs.writeFileSync(path.join(dir, 'zz-h03-b.md'), memFile({ name: 'zz-h03-b', description: 'b' }));
    const refB = `projects/${pid}/memory/zz-h03-b.md`;
    const reported = async () => (await eg.health()).some((f) => f.code === 'H03' && f.refs.includes(refB));
    fs.writeFileSync(idx(), '- [a](zz-h03-a.md) — a\n');
    assert.equal(await reported(), true);
    fs.writeFileSync(idx(), '- [a](zz-h03-a.md) — a\n- 另有 1 筆未列出，可用 `engram search <關鍵字>` 查詢。\n');
    assert.equal(await reported(), false);
    for (const f of ['zz-h03-a.md', 'zz-h03-b.md']) fs.rmSync(path.join(dir, f), { force: true });
    fs.rmSync(idx(), { force: true });
  });
});
