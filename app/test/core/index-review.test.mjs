// WP1 第一輪審查的修正：I3（只有「清單項目、連結在開頭」的行才是索引行）、M3（H01 預警門檻對齊）、
// M4（立即整理索引比照同步看進行中的對話）、M5（listed／omitted／indexed）、M8（釘選也永遠列出、H35）。全部用合成資料。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { computeIndexBudget, normalizeMemoryIndexText, renderScopeIndex } from '../../src/core/normalize.mjs';
import { addTranscript, age, machinePaths, makeRepo, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const pad = (i, n = 2) => String(i).padStart(n, '0');
const NOW = Date.parse('2026-11-21T00:00:00Z');

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

function memFile({ name, description, type = 'reference', modified, pinned }) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  type: ${type}\n${modified ? `  modified: ${modified}\n` : ''}${pinned ? '  engram:\n    pinned: true\n' : ''}---\n${name} 的內文。\n`;
}
function writeAll(dir, specs) {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of specs) fs.writeFileSync(path.join(dir, `${s.name}.md`), memFile(s));
}
const entry = (name, over = {}) => ({ file: `${name}.md`, name, description: `Item ${name} first sentence. ${'x'.repeat(230)}`, pinned: false, type: 'reference', modified: '', ...over });
const lineOf = (e) => `- [${e.name}](${e.file}) — ${e.description}`;
const filler = (n, over = {}) => Array.from({ length: n }, (_, i) => entry(`n-${pad(i, 3)}`, over));

describe('I3 只有「清單項目、連結在開頭」的行才是索引行', () => {
  test('精簡：含連結的手寫說明句原樣保留；它提到的記憶不算已列在索引（補一行並精簡）；粗體包住連結的清單項目照常精簡', () => {
    const conv = entry('conv', { description: 'Branch naming and release order. Long details.', type: 'project' });
    const bold = entry('bold', { description: `Bold item first. ${'y'.repeat(230)}` });
    const files = [...filler(90), conv, bold];
    const prose = 'Before any work, read [the conventions](conv.md): branch naming and release order are enforced by CI.';
    const text = `# Index\n\n${prose}\n\n${filler(90).map(lineOf).join('\n')}\n- **[bold](bold.md)** — ${bold.description}\n`;
    assert.ok(bytes(text) > 20_480);
    const out = normalizeMemoryIndexText(text, files, { now: NOW });
    const lines = out.replace(/\n$/, '').split('\n');
    assert.ok(lines.includes(prose), '手寫的說明句一字不動（不能把後半句換成 frontmatter 的說明）');
    assert.ok(lines.includes('- [conv](conv.md) — Branch naming and release order…'), '句子裡提到 conv.md 不算它已列在索引：補上一行');
    assert.ok(lines.includes('- **[bold](bold.md)** — Bold item first…'), '粗體包住連結的清單項目是索引行：精簡，保留粗體');
    assert.equal(normalizeMemoryIndexText(out, files, { now: NOW }), out, '冪等');
  });

  test('省略：含連結的手寫說明句不會被當成可省略的索引行刪掉（即使它指向排名最低的記憶）', () => {
    const recent = '2026-11-01T00:00:00.000Z';
    const files = [...filler(200, { description: 'd', modified: recent }), entry('release', { description: 'Release checklist.', modified: '2025-01-01T00:00:00.000Z' })];
    const prose = 'IMPORTANT: always read [the release checklist](release.md) before deploying; the user asked for this.';
    const text = `# Index\n${prose}\n${files.slice(0, 200).map(lineOf).join('\n')}\n`;
    const out = normalizeMemoryIndexText(text, files, { now: NOW });
    const lines = out.replace(/\n$/, '').split('\n');
    assert.ok(lines.includes(prose), '使用者要求的那句話還在');
    assert.ok(lines.length < 160 && /- 另有 \d+ 筆未列出/.test(out), '仍然進入省略模式');
    assert.ok(!lines.some((l) => l.startsWith('- [release]')), '排名最低的 release 被省略（索引行才會被省略）');
    assert.equal(normalizeMemoryIndexText(out, files, { now: NOW }), out, '冪等');
  });

  test('重複的連結：手寫句不參與去重，兩個清單項目才會合併成一行', () => {
    const files = [entry('a', { description: 'short' })];
    const text = '見 [a](a.md) 的說明。\n- [a](a.md) — short\n- [a](a.md) — short and longer\n';
    assert.equal(normalizeMemoryIndexText(text, files), '見 [a](a.md) 的說明。\n- [a](a.md) — short and longer\n');
  });
});

describe('M3 H01 的行數預警門檻和精簡門檻一致', () => {
  const idx = () => path.join(eg.paths.vault, 'projects', pid, 'memory', 'MEMORY.md');
  const h01 = async () => (await eg.health()).filter((f) => f.code === 'H01' && f.pid === pid);
  const lines = (n, tail = []) => `${[...Array.from({ length: n }, (_, i) => `- [n${i}](n${i}.md) — x`), ...tail].join('\n')}\n`;
  const OMIT = '- 另有 12 筆未列出，可用 `engram search <關鍵字>` 查詢。';

  test('省略模式穩定在 150～159 行：不出「接近上限」卡片；到 160 行才預警', async () => {
    fs.mkdirSync(path.dirname(idx()), { recursive: true });
    fs.writeFileSync(idx(), lines(158, [OMIT])); // 159 行：Engram 已自動處理，使用者沒有可做的事
    assert.equal((await h01()).length, 0);
    fs.writeFileSync(idx(), lines(160));
    assert.equal((await h01()).length, 1);
    fs.rmSync(idx(), { force: true });
  });
});

describe('M4 立即整理索引（eg.normalize）比照同步：進行中的對話不精簡', () => {
  test('進行中的專案只附加、不改寫；對話結束後才精簡', async () => {
    const repo2 = makeRepo(path.join(root, 'work', 'portal'));
    const pid2 = (await eg.identity.bind(repo2, { create: { name: '入口' } })).pid;
    const dir = path.join(eg.paths.vault, 'projects', pid2, 'memory');
    const files = Array.from({ length: 83 }, (_, i) => entry(`note-${pad(i + 1)}`));
    writeAll(dir, files.map((f) => ({ name: f.name, description: f.description, modified: '2026-01-01T00:00:00.000Z' })));
    const index = path.join(dir, 'MEMORY.md');
    const original = `${files.map(lineOf).join('\n')}\n`;
    fs.writeFileSync(index, original);
    age(index, 120_000); // 10 秒內改過的索引本來就不碰
    const t = addTranscript(m.claudeHome, repo2, { ageMs: 60_000 }); // 1 分鐘前還有對話紀錄寫入：進行中
    await eg.normalize();
    assert.equal(fs.readFileSync(index, 'utf8'), original, '進行中的對話：不精簡');
    const old = new Date(Date.now() - 3 * 3_600_000);
    fs.utimesSync(t.file, old, old); // 對話結束
    await eg.normalize();
    assert.ok(bytes(fs.readFileSync(index, 'utf8')) < 20_480, '沒有進行中的對話：精簡');
  });
});

describe('M5 memories.list()：listed、omitted、indexed', () => {
  const dir = () => path.join(eg.paths.vault, 'projects', pid, 'memory');
  const idx = () => path.join(dir(), 'MEMORY.md');
  const names = ['zz-m5-a', 'zz-m5-b', 'zz-m5-c'];
  const OMIT = '- 另有 2 筆未列出，可用 `engram search <關鍵字>` 查詢。';
  const state = async () => Object.fromEntries((await eg.memories.list({ scope: { kind: 'project', pid } })).filter((x) => names.some((n) => x.ref.endsWith(`/${n}.md`)))
    .map((x) => [path.posix.basename(x.ref, '.md'), { listed: x.listed, omitted: x.omitted, indexed: x.indexed }]));
  const h03 = async () => (await eg.health()).filter((f) => f.code === 'H03').flatMap((f) => f.refs).filter((r) => names.some((n) => r.endsWith(`/${n}.md`))).map((r) => path.posix.basename(r, '.md')).sort();

  test('有一行才算 listed（手寫句裡提到不算）；索引有「另有 N 筆」時沒列出的是 omitted；indexed 是兩者之一；H03 只報「沒列出也沒被省略」的', async () => {
    writeAll(dir(), names.map((name) => ({ name, description: name })));
    fs.writeFileSync(idx(), '- [a](zz-m5-a.md) — a\n看 [b](zz-m5-b.md) 了解細節\n');
    assert.deepEqual(await state(), {
      'zz-m5-a': { listed: true, omitted: false, indexed: true },
      'zz-m5-b': { listed: false, omitted: false, indexed: false },
      'zz-m5-c': { listed: false, omitted: false, indexed: false },
    });
    assert.deepEqual(await h03(), ['zz-m5-b', 'zz-m5-c']);
    fs.writeFileSync(idx(), `- [a](zz-m5-a.md) — a\n看 [b](zz-m5-b.md) 了解細節\n${OMIT}\n`);
    assert.deepEqual(await state(), {
      'zz-m5-a': { listed: true, omitted: false, indexed: true },
      'zz-m5-b': { listed: false, omitted: true, indexed: true },
      'zz-m5-c': { listed: false, omitted: true, indexed: true },
    });
    assert.deepEqual(await h03(), []);
    for (const n of names) fs.rmSync(path.join(dir(), `${n}.md`), { force: true });
    fs.rmSync(idx(), { force: true });
  });
});

describe('M8 全域與單機索引：釘選與 feedback／user 都永遠列出', () => {
  test('feedback 把預算用完時，釘選的仍在索引裡、剛寫的其他類型被擠掉；顯示仍是釘選在最前', async () => {
    const dir = path.join(root, 'm8-scope');
    const specs = [];
    for (let i = 1; i <= 60; i++) specs.push({ name: `fb-${pad(i)}`, description: `糾正 ${i}`, type: 'feedback', modified: '2026-01-01T00:00:00.000Z' });
    specs.push({ name: 'pinned-ref', description: '釘選的', pinned: true, modified: '2026-01-01T00:00:00.000Z' });
    specs.push({ name: 'just-written', description: '剛寫的', modified: new Date().toISOString() });
    writeAll(dir, specs);
    const text = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 60 });
    const shown = [...text.matchAll(/^- \[([^\]]+)\]/gm)].map((x) => x[1]);
    assert.equal(shown[0], 'pinned-ref', '顯示順序：釘選在最前');
    assert.equal(shown.length, 61, '60 筆 feedback 加釘選的，超過行數預算也全部列出');
    assert.ok(!shown.includes('just-written'));
    assert.match(text, /另有 1 筆未列出/);
  });

  test('釘選的其他類型也不參與截斷（先於 feedback／user 保留，其餘依序擠掉）', async () => {
    const dir = path.join(root, 'm8-scope2');
    writeAll(dir, [
      ...[1, 2, 3].map((i) => ({ name: `pin-${i}`, description: 'p', pinned: true, modified: '2026-01-01T00:00:00.000Z' })),
      ...[1, 2].map((i) => ({ name: `fb-${i}`, description: 'f', type: 'feedback', modified: '2026-01-01T00:00:00.000Z' })),
      ...[1, 2, 3, 4, 5].map((i) => ({ name: `other-${i}`, description: 'o', modified: new Date().toISOString() })),
    ]);
    // 預算 8 行：10 筆放不下 → 可列 2 筆，但永遠列出的有 5 筆
    const text = await renderScopeIndex({ kind: 'global', dir, userHome: root, budget: 8 });
    assert.deepEqual([...text.matchAll(/^- \[([^\]]+)\]/gm)].map((x) => x[1]).sort(), ['fb-1', 'fb-2', 'pin-1', 'pin-2', 'pin-3']);
    assert.match(text, /另有 5 筆未列出/);
  });

  test('H35：永遠列出的記憶用完預算、其他類型一筆都列不進去時出卡片（說明筆數與預算）；沒用完就沒有', async () => {
    const root2 = mkTmp();
    try {
      const m2 = machinePaths(root2, 'home');
      await init({ ...m2, machineLabel: '家裡電腦', userName: 'Tester', cli: writeDriverCli(root2) });
      const eg2 = await open(m2);
      const gdir = path.join(eg2.paths.vault, 'global');
      const budget = (await computeIndexBudget(eg2.paths.vault)).global;
      const slots = budget - 6;
      const h35 = async () => (await eg2.health()).filter((f) => f.code === 'H35');
      writeAll(gdir, [...Array.from({ length: slots - 4 }, (_, i) => ({ name: `fb-${pad(i, 3)}`, description: 'f', type: 'feedback', modified: '2026-01-01T00:00:00.000Z' })),
        ...Array.from({ length: 6 }, (_, i) => ({ name: `ref-${i}`, description: 'r', modified: '2026-01-01T00:00:00.000Z' }))]);
      assert.equal((await h35()).length, 0, '永遠列出的還沒用完預算');
      writeAll(gdir, Array.from({ length: 6 }, (_, i) => ({ name: `pin-${i}`, description: 'p', pinned: true, modified: '2026-01-01T00:00:00.000Z' })));
      const cards = await h35();
      const perm = slots - 4 + 6; // 永遠列出的：feedback 加釘選的
      assert.equal(cards.length, 1);
      assert.deepEqual(cards[0].refs, ['global/INDEX.md']);
      assert.equal(cards[0].severity, 'medium');
      assert.equal(cards[0].fix, undefined, '要使用者自己決定：沒有一鍵修正');
      assert.match(cards[0].detail, new RegExp(`預算是 ${slots} 筆`));
      assert.match(cards[0].detail, new RegExp(`有 ${perm} 筆永遠列出`));
      assert.match(cards[0].detail, /取消釘選或封存/);
      assert.match(cards[0].en.detail, new RegExp(`is ${slots} memories`));
      assert.match(cards[0].en.detail, new RegExp(`${perm} memories`));
      // 相容模式（有舊版電腦還在用）：全域索引照 1.6.0 的規則產生，沒有「永遠列出」，這張卡片的說法不成立，不出
      const oldDir = path.join(eg2.paths.vault, 'machines', 'old-pc-0001');
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'machine.json'), JSON.stringify({ id: 'old-pc-0001', label: '舊筆電', engramVersion: '1.6.0', lastSeenAt: new Date().toISOString() }));
      assert.equal((await h35()).length, 0, '相容模式下不出全域的 H35');
      fs.rmSync(oldDir, { recursive: true, force: true });
      assert.equal((await h35()).length, 1, '舊版電腦不在了就恢復');
      // 全部都是永遠列出的：沒有被擠掉的其他類型，不出卡片
      for (let i = 0; i < 6; i++) fs.rmSync(path.join(gdir, `ref-${i}.md`), { force: true });
      assert.equal((await h35()).length, 0);
    } finally { rmTmp(root2); }
  });
});
