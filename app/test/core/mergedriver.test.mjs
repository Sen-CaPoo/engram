// mergedriver.mjs 的測試：直接呼叫合併器，以及透過真正的 git merge 端對端驗證。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeDriver } from '../../src/core/mergedriver.mjs';
import { parseMemoryFile, setFields } from '../../src/core/frontmatter.mjs';
import { makeConflictId } from '../../src/core/ids.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_MODULE = resolve(HERE, '../../src/core/mergedriver.mjs');
const FIX = join(HERE, 'fixtures', 'frontmatter');
const read = (name) => readFileSync(join(FIX, name), 'utf8');
const toCRLF = (s) => s.replace(/\r?\n/g, '\r\n');
const NOW = new Date('2026-10-22T09:30:15Z'); // 衝突 id 一律用 UTC、精確到秒

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 在暫存資料夾寫入三方檔案後呼叫合併器。 */
async function runDriver(t, { base, ours, theirs, path = 'projects/demo/memory/x.md' }) {
  const dir = tempDir(t, 'engram-md-unit-');
  const files = { base: join(dir, 'base'), ours: join(dir, 'ours'), theirs: join(dir, 'theirs') };
  if (base !== null && base !== undefined) writeFileSync(files.base, base);
  writeFileSync(files.ours, ours);
  if (theirs !== null && theirs !== undefined) writeFileSync(files.theirs, theirs);
  const conflictsDir = join(dir, 'conflicts');
  const r = await mergeDriver({ ...files, path, conflictsDir, now: NOW });
  return { r, out: readFileSync(files.ours, 'utf8'), conflictsDir };
}

function readConflict(conflictsDir, id) {
  const dir = join(conflictsDir, id);
  return {
    meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')),
    files: readdirSync(dir).sort(),
    read: (f) => readFileSync(join(dir, f), 'utf8'),
  };
}

const withBody = (text, body) => {
  const p = parseMemoryFile(text);
  return text.slice(0, text.length - p.body.length) + body;
};

// ───────── 直接呼叫 ─────────

test('衝突紀錄的 meta.json 會被推送：frontmatter 錯誤那一行含金鑰時，解析錯誤與摘要都遮蔽', async (t) => {
  const SECRET = `ghp_${'Hh1Jj2Kk3L'.repeat(4)}`;
  const good = (body) => `---\nname: x\ndescription: "d"\nmetadata:\n  type: reference\n---\n\n${body}\n`;
  const { r, conflictsDir } = await runDriver(t, {
    base: good('v0'), theirs: good('theirs'),
    ours: `---\nname: x\ndescription: "d" ${SECRET}\nmetadata:\n  type: reference\n---\n\nours\n`,
  });
  assert.equal(r.result, 'quarantined');
  const raw = readFileSync(join(conflictsDir, r.conflictId, 'meta.json'), 'utf8');
  assert.ok(!raw.includes('ghp_'), 'meta.json 不可以含金鑰');
  assert.ok(readConflict(conflictsDir, r.conflictId).meta.parseErrors.ours.length > 0, '解析錯誤仍然記錄（已遮蔽）');
});

test('只有 modified 與 originSessionId 不同 → clean，取較新的一方', async (t) => {
  const base = read('demo-project-deploy.md');
  const ours = setFields(base, { 'metadata.modified': '2026-10-02T00:00:00.000Z', 'metadata.originSessionId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const theirs = setFields(base, { 'metadata.modified': '2026-10-03T00:00:00.000Z', 'metadata.originSessionId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const { r, out, conflictsDir } = await runDriver(t, { base, ours, theirs });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'clean');
  const p = parseMemoryFile(out);
  assert.equal(p.data.metadata.modified, '2026-10-03T00:00:00.000Z');
  assert.equal(p.data.metadata.originSessionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(existsSync(conflictsDir), false);
  // 反過來：本機較新
  const r2 = await runDriver(t, { base, ours: theirs, theirs: ours });
  assert.equal(parseMemoryFile(r2.out).data.metadata.originSessionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
});

test('不同段落各自修改 → auto，兩邊都保留', async (t) => {
  const base = read('sample-long-cjk.md');
  const ours = base.replace('先在測試環境執行', '先在本機與測試環境執行');
  const theirs = base.replace('不要跳過健康檢查。', '不要跳過健康檢查，也要記錄部署時間。');
  const { r, out } = await runDriver(t, { base, ours, theirs });
  assert.equal(r.result, 'auto');
  assert.ok(out.includes('先在本機與測試環境執行'));
  assert.ok(out.includes('也要記錄部署時間'));
  assert.ok(!out.includes('<<<<<<<'));
});

test('同一行兩邊都改 → quarantined，檔案保留本機版本且沒有衝突標記', async (t) => {
  const base = read('sample-long-cjk.md');
  const ours = base.replace('等待 30 秒後重試', '等待 60 秒後重試');
  const theirs = base.replace('等待 30 秒後重試', '改用健康檢查輪詢');
  const { r, out, conflictsDir } = await runDriver(t, { base, ours, theirs, path: 'projects/demo-3fa9k/memory/sample-long-cjk.md' });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'quarantined');
  assert.match(r.conflictId, /^cf_20261022T093015_[0-9a-hjkmnp-tv-z]{4}$/);
  assert.equal(out, ours);
  assert.ok(!out.includes('<<<<<<<') && !out.includes('>>>>>>>'));
  const c = readConflict(conflictsDir, r.conflictId);
  assert.deepEqual(c.files, ['base.md', 'meta.json', 'ours.md', 'theirs.md']);
  assert.equal(c.read('theirs.md'), theirs);
  assert.equal(c.read('ours.md'), ours);
  assert.equal(c.read('base.md'), base);
  assert.equal(c.meta.id, r.conflictId);
  assert.equal(c.meta.ref, 'projects/demo-3fa9k/memory/sample-long-cjk.md');
  assert.equal(c.meta.kind, 'content');
  assert.equal(c.meta.bodyConflict, true);
  assert.deepEqual(c.meta.conflictedKeys, []);
  assert.equal(c.meta.createdAt, NOW.toISOString());
  assert.match(c.meta.summary, /「sample-long-cjk」的內文在兩台電腦都被修改/);
  assert.match(c.meta.en.summary, /^"sample-long-cjk" was modified on both computers \(body\)\. /, '英文摘要');
});

test('非 harness 欄位兩邊都改 → quarantined，保留本機的值', async (t) => {
  const base = read('sample-tool-quirk.md');
  const ours = setFields(base, { description: '本機改的描述' });
  const theirs = setFields(base, { description: '另一台改的描述', 'metadata.engram.pinned': true });
  const { r, out, conflictsDir } = await runDriver(t, { base, ours, theirs });
  assert.equal(r.result, 'quarantined');
  const p = parseMemoryFile(out);
  assert.equal(p.data.description, '本機改的描述');
  assert.equal(p.data.metadata.engram.pinned, true, '對方單方面新增的欄位應合併進來');
  const c = readConflict(conflictsDir, r.conflictId);
  assert.deepEqual(c.meta.conflictedKeys, ['description']);
  assert.equal(c.meta.bodyConflict, false);
  assert.match(c.meta.summary, /欄位（description）/);
  assert.match(c.meta.en.summary, /^"sample-tool-quirk" was modified on both computers \(fields: description\)\. /, '英文摘要');
});

test('一邊加 metadata.engram、一邊改內文 → 兩者合併', async (t) => {
  const base = read('sample-reference-api.md');
  const ours = setFields(base, { 'metadata.engram.tags': ['api', 'billing'] });
  const theirs = base.replace('keep `max_results` small', 'keep `max_results` at 10 or less');
  const { r, out } = await runDriver(t, { base, ours, theirs });
  assert.equal(r.result, 'clean');
  const p = parseMemoryFile(out);
  assert.deepEqual(p.data.metadata.engram.tags, ['api', 'billing']);
  assert.ok(p.body.includes('at 10 or less'));
});

test('一邊刪除鍵、另一邊沒動 → 刪除生效，空的父物件一併移除', async (t) => {
  const base = read('sample-engram-meta.md');
  const ours = base;
  const theirs = setFields(base, { 'metadata.engram': undefined });
  const { r, out } = await runDriver(t, { base, ours, theirs });
  assert.equal(r.result, 'clean');
  const p = parseMemoryFile(out);
  assert.equal('engram' in p.data.metadata, false);
  assert.ok(!out.includes('engram:'));
});

test('中文內容：兩台各改不同段落', async (t) => {
  const base = read('sample-user-profile.md');
  const ours = base.replace('使用者偏好正體中文回覆', '使用者偏好正體中文回覆（簡潔）');
  const theirs = base.replace('目標:集中管理', '目標：集中管理');
  const { r, out } = await runDriver(t, { base, ours, theirs });
  assert.equal(r.result, 'auto');
  assert.ok(out.includes('（簡潔）'));
  assert.ok(out.includes('目標：集中管理'));
});

test('換行混用：本機 CRLF、對方 LF → 合併後維持本機的 CRLF', async (t) => {
  const baseLF = read('sample-long-cjk.md');
  const ours = toCRLF(baseLF.replace('先在測試環境執行', '先在本機執行'));
  const theirs = baseLF.replace('重新產生權杖', '重新產生權杖並更新設定');
  const { r, out } = await runDriver(t, { base: toCRLF(baseLF), ours, theirs });
  assert.equal(r.result, 'auto');
  assert.ok(out.includes('先在本機執行') && out.includes('並更新設定'));
  assert.ok(!/[^\r]\n/.test(out), '不應出現單獨的 LF');
});

test('沒有共同祖先（兩邊新增同一檔）且內容相同 → clean', async (t) => {
  const text = read('sample-wildcard-cert.md');
  const { r, out } = await runDriver(t, { base: null, ours: text, theirs: text });
  assert.equal(r.result, 'clean');
  assert.equal(out, text);
});

test('沒有共同祖先且內容不同 → quarantined', async (t) => {
  const a = read('sample-wildcard-cert.md');
  const b = withBody(a, '\n完全不同的內文。\n');
  const { r, out, conflictsDir } = await runDriver(t, { base: '', ours: a, theirs: b });
  assert.equal(r.result, 'quarantined');
  assert.equal(out, a);
  assert.deepEqual(readConflict(conflictsDir, r.conflictId).files, ['meta.json', 'ours.md', 'theirs.md']);
});

test('發生例外時本機檔案不變、exitCode 仍為 0', async (t) => {
  const dir = tempDir(t, 'engram-md-err-');
  const ours = join(dir, 'ours');
  const text = read('demo-project-deploy.md');
  writeFileSync(ours, text);
  const conflictsDir = join(dir, 'conflicts');
  const r = await mergeDriver({ base: join(dir, 'missing-base'), ours, theirs: join(dir, 'missing-theirs'), path: 'x.md', conflictsDir, now: NOW });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'quarantined');
  assert.equal(readFileSync(ours, 'utf8'), text);
  const c = readConflict(conflictsDir, r.conflictId);
  assert.match(c.meta.summary, /自動合併失敗/);
  assert.match(c.meta.en.summary, /^Automatic merge of ".+" failed \(.+\)\. This computer's version was kept/, '英文摘要');
  assert.ok(c.meta.error);
});

test('git 執行檔不存在時退回隔離，不留標記', async (t) => {
  const dir = tempDir(t, 'engram-md-nogit-');
  const base = read('sample-long-cjk.md');
  const ours = base.replace('先在測試環境執行', 'A');
  const theirs = base.replace('不要跳過健康檢查。', 'B');
  const files = { base: join(dir, 'b'), ours: join(dir, 'o'), theirs: join(dir, 't') };
  writeFileSync(files.base, base); writeFileSync(files.ours, ours); writeFileSync(files.theirs, theirs);
  const r = await mergeDriver({ ...files, path: 'x.md', conflictsDir: join(dir, 'c'), now: NOW, git: join(dir, 'no-such-git') });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'quarantined');
  assert.equal(readFileSync(files.ours, 'utf8'), ours);
});

// ───────── 端對端：真正的 git merge ─────────

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(t) {
  const root = tempDir(t, 'engram-md-e2e-');
  const repo = join(root, 'repo');
  const conflictsDir = join(root, 'conflicts');
  const drv = join(root, 'drv.mjs');
  writeFileSync(drv, [
    `import { mergeDriver } from ${JSON.stringify(pathToFileURL(DRIVER_MODULE).href)};`,
    'const [, , base, ours, theirs, path] = process.argv;',
    `const r = await mergeDriver({ base, ours, theirs, path, conflictsDir: ${JSON.stringify(conflictsDir)} });`,
    'process.exit(r.exitCode);',
    '',
  ].join('\n'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'Engram Test');
  git(repo, 'config', 'user.email', 'test@engram.local');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'merge.engram-md.name', 'Engram memory merge');
  git(repo, 'config', 'merge.engram-md.driver', `node "${drv.replace(/\\/g, '/')}" %O %A %B %P`);
  writeFileSync(join(repo, '.gitattributes'), '*.md merge=engram-md\n');
  return { repo, conflictsDir };
}

/** 建立 base → 分支 other 改成 theirs、main 改成 ours，再合併。 */
function mergeScenario(t, rel, base, ours, theirs) {
  const { repo, conflictsDir } = makeRepo(t);
  const file = join(repo, ...rel.split('/'));
  execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(dirname(file))}, { recursive: true })`]);
  writeFileSync(file, base);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'other');
  writeFileSync(file, theirs);
  git(repo, 'commit', '-q', '-am', 'theirs');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(file, ours);
  git(repo, 'commit', '-q', '-am', 'ours');
  git(repo, 'merge', '--no-edit', '-q', 'other');
  const status = git(repo, 'status', '--porcelain');
  return { out: readFileSync(file, 'utf8'), conflictsDir, status, repo };
}

test('e2e (a)：只有 harness 時間欄位不同 → 乾淨合併，較新者勝', (t) => {
  const base = read('demo-project-deploy.md');
  const ours = setFields(base, { 'metadata.modified': '2026-10-05T00:00:00.000Z', 'metadata.originSessionId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const theirs = setFields(base, { 'metadata.modified': '2026-10-04T00:00:00.000Z', 'metadata.originSessionId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const { out, status, conflictsDir } = mergeScenario(t, 'projects/demo/memory/demo-project-deploy.md', base, ours, theirs);
  assert.equal(status, '');
  const p = parseMemoryFile(out);
  assert.equal(p.data.metadata.modified, '2026-10-05T00:00:00.000Z');
  assert.equal(p.data.metadata.originSessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(existsSync(conflictsDir), false);
});

test('e2e (b)：不同段落 → 自動合併', (t) => {
  const base = read('sample-long-cjk.md');
  const ours = setFields(base.replace('先在測試環境執行', '先在本機與測試環境執行'), { 'metadata.modified': '2026-10-21T00:00:00.000Z' });
  const theirs = setFields(base.replace('權杖過期', '權杖過期或被撤銷'), { 'metadata.modified': '2026-10-21T05:00:00.000Z' });
  const { out, status } = mergeScenario(t, 'projects/demo/memory/sample-long-cjk.md', base, ours, theirs);
  assert.equal(status, '');
  assert.ok(out.includes('先在本機與測試環境執行'));
  assert.ok(out.includes('權杖過期或被撤銷'));
  assert.equal(parseMemoryFile(out).data.metadata.modified, '2026-10-21T05:00:00.000Z');
  assert.ok(!out.includes('<<<<<<<'));
});

test('e2e (c)：同一行 → 隔離對方版本，工作目錄是本機版本、沒有標記', (t) => {
  const base = read('sample-long-cjk.md');
  const ours = base.replace('等待 30 秒後重試', '等待 60 秒後重試');
  const theirs = base.replace('等待 30 秒後重試', '改用健康檢查輪詢');
  const rel = 'projects/demo-3fa9k/memory/sample-long-cjk.md';
  const { out, status, conflictsDir, repo } = mergeScenario(t, rel, base, ours, theirs);
  assert.equal(status, '');
  assert.equal(out, ours);
  assert.ok(!out.includes('<<<<<<<') && !out.includes('======='));
  const ids = readdirSync(conflictsDir);
  assert.equal(ids.length, 1);
  const c = readConflict(conflictsDir, ids[0]);
  assert.equal(c.meta.ref, rel);
  assert.equal(c.meta.bodyConflict, true);
  assert.equal(c.read('theirs.md'), theirs);
  assert.ok(git(repo, 'log', '--oneline').split('\n').filter(Boolean).length >= 4, '應產生合併 commit');
});

test('e2e (d)：中文檔名與中文內容', (t) => {
  const base = read('sample-user-profile.md');
  const ours = base.replace('技術名詞保留英文', '技術名詞與程式碼識別字保留英文');
  const theirs = base.replace('並追蹤同事的使用狀況', '並追蹤同事的使用狀況與回饋'); // 與本機修改隔一行，才不算相鄰衝突
  const { out, status } = mergeScenario(t, 'projects/p-8qw2mz7c/memory/範例使用者.md', base, ours, theirs);
  assert.equal(status, '');
  assert.ok(out.includes('程式碼識別字保留英文'));
  assert.ok(out.includes('使用狀況與回饋'));
});

test('e2e (e)：CRLF 檔案合併後仍為 CRLF', (t) => {
  const base = toCRLF(read('sample-long-cjk.md'));
  const ours = setFields(base.replace('先在測試環境執行', '先在本機執行'), { 'metadata.modified': '2026-10-21T00:00:00.000Z' });
  const theirs = setFields(base.replace('重新產生權杖', '重新產生權杖並通知同事'), { 'metadata.modified': '2026-10-22T00:00:00.000Z' });
  const { out, status } = mergeScenario(t, 'projects/demo/memory/crlf.md', base, ours, theirs);
  assert.equal(status, '');
  assert.ok(out.includes('先在本機執行') && out.includes('並通知同事'));
  assert.ok(!/[^\r]\n/.test(out), '不應出現單獨的 LF');
  assert.equal(parseMemoryFile(out).data.metadata.modified, '2026-10-22T00:00:00.000Z');
});

// ───────── claude-57 審查（R-27、BUG-4～10）的回歸測試 ─────────

const RV_BASE = `---
name: favorite-color
description: "The user's favorite color is teal"
metadata:
  node_type: memory
  type: user
  originSessionId: 11111111-1111-4111-8111-111111111111
  modified: 2026-10-20T00:00:00.000Z
  engram:
    pinned: false
    tags:
      - color
---

第一段：使用者喜歡青色。

中間段落：保持不變。

---

第二段：C:\\Users\\Someone\\x 與 https://x.example/#a 🎨
`;
const sub = (s, a, b) => { assert.ok(s.includes(a), `fixture 缺少：${a}`); return s.replace(a, b); };
const OURS_BODY_EDIT = (s) => sub(s, '中間段落：保持不變。', '中間段落：本機改了。');

/** R-27 共同斷言：本機原封不動、對方版本進隔離區、meta 標明哪一方無法解析。 */
async function assertRefused(t, { base = RV_BASE, ours, theirs, side }) {
  const { r, out, conflictsDir } = await runDriver(t, { base, ours, theirs });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'quarantined');
  assert.equal(out, ours, '本機必須一個位元組都不變');
  const c = readConflict(conflictsDir, r.conflictId);
  assert.equal(c.read('theirs.md'), theirs);
  if (base) assert.equal(c.read('base.md'), base);
  assert.ok(c.meta.unparsable.includes(side), JSON.stringify(c.meta.unparsable));
  assert.match(c.meta.summary, side === 'ours' ? /本機版本無法解析/ : /對方版本無法解析，已保留本機版本/);
  assert.match(c.meta.en.summary, side === 'ours' ? /could not be parsed in this computer's version\. / : /could not be parsed in the other computer's version\. /, '英文摘要');
  return c;
}

test('R-27 (g)：對方的描述引號未閉合 → 不合併，本機不變', async (t) => {
  const theirs = sub(sub(RV_BASE, `"The user's favorite color is teal"`, `"The user's favorite color is teal`), 'pinned: false', 'pinned: true');
  const c = await assertRefused(t, { ours: OURS_BODY_EDIT(RV_BASE), theirs, side: 'theirs' });
  assert.ok(c.meta.parseErrors.theirs.length > 0);
});

test('R-27 (g2)：對方是 0 位元組檔案 → 不合併，本機不變', async (t) => {
  await assertRefused(t, { ours: OURS_BODY_EDIT(RV_BASE), theirs: '', side: 'theirs' });
});

test('R-27：對方被截斷（沒有結尾分隔行）→ 不合併', async (t) => {
  const theirs = RV_BASE.slice(0, RV_BASE.indexOf('    pinned'));
  await assertRefused(t, { ours: OURS_BODY_EDIT(RV_BASE), theirs, side: 'theirs' });
  // 本機只有 harness 改了 modified 時也一樣
  await assertRefused(t, { ours: sub(RV_BASE, '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z'), theirs, side: 'theirs' });
});

test('R-27 (m3)：對方有一行 tab 縮排 → 不合併，不產生垃圾鍵', async (t) => {
  await assertRefused(t, { ours: OURS_BODY_EDIT(RV_BASE), theirs: sub(RV_BASE, '  type: user', '\ttype: user'), side: 'theirs' });
});

test('R-27 (m1、g4)：本機無法解析 → 不合併，本機不變（不會再加一個 frontmatter）', async (t) => {
  const unclosed = sub(sub(RV_BASE, `"The user's favorite color is teal"`, `"The user's favorite color is teal`), '中間段落：保持不變。', '中間段落（本機）。');
  const theirs = sub(sub(RV_BASE, '2026-10-20T00:00:00.000Z', '2026-10-22T00:00:00.000Z'), 'pinned: false', 'pinned: true');
  await assertRefused(t, { ours: unclosed, theirs, side: 'ours' });
  const noFence = RV_BASE.replace(/\n---\n\n第一段/, '\n\n第一段');
  await assertRefused(t, { ours: noFence, theirs, side: 'ours' });
});

test('R-27：共同祖先無法解析也不合併', async (t) => {
  const base = sub(RV_BASE, '  type: user', '\ttype: user');
  const { r, out, conflictsDir } = await runDriver(t, { base, ours: OURS_BODY_EDIT(RV_BASE), theirs: sub(RV_BASE, '第一段', '第一段（對方）') });
  assert.equal(r.result, 'quarantined');
  assert.equal(out, OURS_BODY_EDIT(RV_BASE));
  assert.deepEqual(readConflict(conflictsDir, r.conflictId).meta.unparsable, ['base']);
});

test('兩邊內容完全相同 → clean，不寫檔、不隔離', async (t) => {
  const text = RV_BASE.replace('  type: user', '\ttype: user'); // 即使格式壞掉，兩邊相同就不需要合併
  const { r, out, conflictsDir } = await runDriver(t, { base: RV_BASE, ours: text, theirs: text });
  assert.equal(r.result, 'clean');
  assert.equal(out, text);
  assert.equal(existsSync(conflictsDir), false);
});

test('BUG-4：一邊是頂層 engram、一邊已被搬到 metadata.engram → 語意合併，不誤判衝突', async (t) => {
  const legacy = `---\nname: legacy\ndescription: d\nengram:\n  pinned: false\n  tags: [a, b]\nmetadata:\n  type: user\n  modified: 2026-10-20T00:00:00.000Z\n---\n\nbody\n`;
  const ours = `---\nname: legacy\ndescription: d\nmetadata:\n  type: user\n  modified: 2026-10-21T00:00:00.000Z\n  engram:\n    pinned: false\n    tags:\n      - a\n      - b\n  node_type: memory\n  originSessionId: 22222222-2222-4222-8222-222222222222\n---\n\nbody\n`;
  const theirs = legacy.replace('pinned: false', 'pinned: true');
  const { r, out } = await runDriver(t, { base: legacy, ours, theirs });
  assert.notEqual(r.result, 'quarantined');
  const p = parseMemoryFile(out);
  assert.equal(p.data.metadata.engram.pinned, true);
  assert.deepEqual(p.data.metadata.engram.tags, ['a', 'b']);
  assert.equal('engram' in p.data, false);
  // 本機仍是舊格式時，結果維持舊格式（改動最小）
  const r2 = await runDriver(t, { base: legacy, ours: legacy.replace('2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z'), theirs: ours.replace('pinned: false', 'pinned: true') });
  const p2 = parseMemoryFile(r2.out);
  assert.equal(p2.data.engram.pinned, true);
  assert.equal(hasOwnProp(p2.data.metadata, 'engram'), false);
});

const hasOwnProp = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);

test('BUG-5：值在下一行的描述被對方修改 → 套用，不會默默遺失', async (t) => {
  const mk = (desc) => `---\nname: n\ndescription:\n  ${desc}\nmetadata:\n  type: user\n---\n\npara1\n\npara2\n`;
  const base = mk('使用者偏好青色');
  const { r, out } = await runDriver(t, { base, ours: base.replace('para2', 'para2 本機'), theirs: mk('使用者偏好藍色') });
  assert.equal(r.result, 'clean');
  assert.equal(parseMemoryFile(out).data.description, '使用者偏好藍色');
  assert.ok(out.includes('para2 本機'));
});

test('BUG-9：本機 frontmatter 結尾沒有換行、對方加了內文 → 分隔行不黏住內文', async (t) => {
  const { out } = await runDriver(t, { base: '---\nname: a\ndescription: d\n---', ours: '---\nname: a\ndescription: d2\n---', theirs: '---\nname: a\ndescription: d\n---\nnew body\n' });
  const p = parseMemoryFile(out);
  assert.equal(p.hasFrontmatter, true);
  assert.equal(p.data.description, 'd2');
  assert.equal(p.body, 'new body\n');
  const { out: out2 } = await runDriver(t, { base: '---\nname: a\ndescription: d\n---', ours: '---\nname: a\ndescription: d2\n---', theirs: '---\nname: a\ndescription: d\n---\n\nnew body from theirs\n' });
  assert.ok(parseMemoryFile(out2).body.includes('new body from theirs'));
});

test('BUG-10：含點的鍵（v1.2）被對方修改 → 套用到同一個鍵，不產生巢狀', async (t) => {
  const base = `---\nname: a\nmetadata:\n  engram:\n    aliases:\n      v1.2: old\n---\n\npara1\n\npara2\n`;
  const { out } = await runDriver(t, { base, ours: base.replace('para1', 'para1 ours'), theirs: base.replace('v1.2: old', 'v1.2: new') });
  assert.deepEqual(parseMemoryFile(out).data.metadata.engram.aliases, { 'v1.2': 'new' });
  const { out: out2 } = await runDriver(t, { base, ours: base, theirs: base.replace('v1.2: old', 'v1.2: old\n      v2.0: added') });
  assert.deepEqual(parseMemoryFile(out2).data.metadata.engram.aliases, { 'v1.2': 'old', 'v2.0': 'added' });
});

test('對方新增 __proto__ 鍵 → 當成一般資料帶過來', async (t) => {
  const base = RV_BASE;
  const { out } = await runDriver(t, { base, ours: OURS_BODY_EDIT(base), theirs: sub(base, '  engram:\n', '  __proto__: x\n  engram:\n') });
  assert.ok(hasOwnProp(parseMemoryFile(out).data.metadata, '__proto__'));
});

test('內文結尾沒有換行時也能乾淨合併', async (t) => {
  const base = '---\nname: a\n---\n\np1\n\np2\n\np3 last';
  const { r, out } = await runDriver(t, { base, ours: base.replace('p1', 'p1 ours'), theirs: base.replace('p3 last', 'p3 last theirs') });
  assert.equal(r.result, 'auto');
  assert.equal(out, '---\nname: a\n---\n\np1 ours\n\np2\n\np3 last theirs');
});

test('描述兩邊都改 → 隔離，本機逐位元組保留（含原本的引號）', async (t) => {
  const ours = sub(RV_BASE, `"The user's favorite color is teal"`, `"The user's favorite color is navy"`);
  const theirs = sub(RV_BASE, `"The user's favorite color is teal"`, `"The user's favourite colour is teal"`);
  const { r, out } = await runDriver(t, { base: RV_BASE, ours, theirs });
  assert.equal(r.result, 'quarantined');
  assert.equal(out, ours);
});

test('對方的描述含「 #」→ 套用後讀回一致', async (t) => {
  const ours = sub(RV_BASE, '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
  const theirs = sub(sub(RV_BASE, `"The user's favorite color is teal"`, `"The user's favorite color is teal # not a comment"`), '2026-10-20T00:00:00.000Z', '2026-10-22T00:00:00.000Z');
  const { r, out } = await runDriver(t, { base: RV_BASE, ours, theirs });
  assert.equal(r.result, 'clean');
  assert.equal(parseMemoryFile(out).data.description, "The user's favorite color is teal # not a comment");
  assert.equal(parseMemoryFile(out).data.metadata.modified, '2026-10-22T00:00:00.000Z');
});

// ───────── BUG-6：衝突資料夾位置 ─────────

/** 在子程序裡呼叫合併器（不傳 conflictsDir），回傳 { r, home }。 */
function driverInSubprocess(t, { cwd, env = {}, home }) {
  const dir = tempDir(t, 'engram-md-loc-');
  writeFileSync(join(dir, 'b'), 'x\n'); writeFileSync(join(dir, 'o'), 'ours\n'); writeFileSync(join(dir, 't'), 'theirs\n');
  const code = `const { mergeDriver } = await import(${JSON.stringify(pathToFileURL(DRIVER_MODULE).href)});
const r = await mergeDriver({ base: ${JSON.stringify(join(dir, 'b'))}, ours: ${JSON.stringify(join(dir, 'o'))}, theirs: ${JSON.stringify(join(dir, 't'))}, path: 'projects/p/memory/x.md' });
console.log(JSON.stringify(r));`;
  const e = { ...process.env, USERPROFILE: home, HOME: home, ...env };
  if (!('ENGRAM_CONFLICTS_DIR' in env)) delete e.ENGRAM_CONFLICTS_DIR;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, env: e, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim());
}

test('BUG-6：衝突資料夾依序取 參數 → 環境變數 → git config → vault 的 conflicts → ~/.engram/vault/conflicts', (t) => {
  const root = tempDir(t, 'engram-md-where-');
  const home = join(root, 'home'); mkdirSync(home);
  const plain = join(root, 'not-a-repo'); mkdirSync(plain);
  // 1. 都沒有 → ~/.engram/vault/conflicts（不是 local）
  let r = driverInSubprocess(t, { cwd: plain, home });
  assert.ok(existsSync(join(home, '.engram', 'vault', 'conflicts', r.conflictId)));
  assert.ok(!existsSync(join(home, '.engram', 'local', 'conflicts')));
  // 2. repo 根目錄有 engram.json（是 vault）→ <repo>/conflicts
  const vault = join(root, 'vault 金庫'); mkdirSync(vault);
  execFileSync('git', ['init', '-q', vault]);
  writeFileSync(join(vault, 'engram.json'), '{}\n');
  mkdirSync(join(vault, 'projects'));
  r = driverInSubprocess(t, { cwd: join(vault, 'projects'), home });
  assert.ok(existsSync(join(vault, 'conflicts', r.conflictId)));
  // 3. git config engram.conflictsdir 優先於 vault 推斷（相對路徑以 repo 根目錄為準）
  execFileSync('git', ['-C', vault, 'config', 'engram.conflictsdir', 'custom/cf']);
  r = driverInSubprocess(t, { cwd: vault, home });
  assert.ok(existsSync(join(vault, 'custom', 'cf', r.conflictId)));
  // 4. 環境變數優先於 git config
  const envDir = join(root, 'env-cf');
  r = driverInSubprocess(t, { cwd: vault, home, env: { ENGRAM_CONFLICTS_DIR: envDir } });
  assert.ok(existsSync(join(envDir, r.conflictId)));
});

// ───────── BUG-7、BUG-8：衝突 id ─────────

test('BUG-8：衝突 id 用 UTC、精確到秒，與 ids.makeConflictId 一致', async (t) => {
  const now = new Date('2026-10-22T01:30:45Z');
  const dir = tempDir(t, 'engram-md-tz-');
  writeFileSync(join(dir, 'o'), 'a\n'); writeFileSync(join(dir, 'b'), 'b\n'); writeFileSync(join(dir, 't'), 'c\n');
  const r = await mergeDriver({ base: join(dir, 'b'), ours: join(dir, 'o'), theirs: join(dir, 't'), conflictsDir: join(dir, 'c'), now });
  assert.match(r.conflictId, /^cf_20261022T013045_[0-9a-z]{4}$/);
  assert.equal(r.conflictId.slice(0, 19), makeConflictId(now).slice(0, 19));
});

test('BUG-7：id 撞名時不覆蓋既有紀錄（亂數被固定也一樣）', (t) => {
  const dir = tempDir(t, 'engram-md-col-');
  const code = `import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
crypto.randomBytes = (n) => Buffer.alloc(n);
syncBuiltinESMExports();
const { mergeDriver } = await import(${JSON.stringify(pathToFileURL(DRIVER_MODULE).href)});
const dir = ${JSON.stringify(dir)};
const now = new Date('2026-10-22T09:30:00Z');
const ids = [];
for (const tag of ['A', 'B', 'C', 'D', 'E']) {
  const f = { base: join(dir, 'b' + tag), ours: join(dir, 'o' + tag), theirs: join(dir, 't' + tag) };
  writeFileSync(f.base, 'line\\n'); writeFileSync(f.ours, 'ours-' + tag + '\\n'); writeFileSync(f.theirs, 'THEIRS-' + tag + '\\n');
  const r = await mergeDriver({ ...f, path: tag + '.md', conflictsDir: join(dir, 'c'), now });
  ids.push(r.conflictId);
}
const kept = ids.map((id) => readFileSync(join(dir, 'c', id, 'theirs.md'), 'utf8').trim());
console.log(JSON.stringify({ ids, kept, dirs: readdirSync(join(dir, 'c')).length }));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const { ids, kept, dirs } = JSON.parse(res.stdout.trim());
  assert.equal(new Set(ids).size, 5);
  assert.equal(dirs, 5);
  assert.deepEqual(kept, ['THEIRS-A', 'THEIRS-B', 'THEIRS-C', 'THEIRS-D', 'THEIRS-E']);
});

// ───────── 端對端（真正的 git merge，路徑含中文與空白） ─────────

function makeVaultLike(t) {
  const root = tempDir(t, 'engram-md-e2e2-');
  const cliDir = join(root, '驅動 程式 dir');
  mkdirSync(cliDir, { recursive: true });
  const cli = join(cliDir, 'engram.mjs');
  writeFileSync(cli, [
    `import { mergeDriver } from ${JSON.stringify(pathToFileURL(DRIVER_MODULE).href)};`,
    'const [cmd, base, ours, theirs, ref] = process.argv.slice(2);',
    "if (cmd !== 'merge-driver') process.exit(2);",
    'const r = await mergeDriver({ base, ours, theirs, path: ref });',
    'process.exit(r.exitCode ?? 0);',
    '',
  ].join('\n'));
  const repo = join(root, 'vault 金庫');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const nodeExe = process.execPath.replace(/\\/g, '/');
  for (const [k, v] of [['core.autocrlf', 'false'], ['core.quotepath', 'false'], ['user.name', 'T'], ['user.email', 't@x'],
    ['merge.engram-md.driver', `"${nodeExe}" "${cli.replace(/\\/g, '/')}" merge-driver %O %A %B %P`]]) git(repo, 'config', k, v);
  writeFileSync(join(repo, '.gitattributes'), '* text=auto eol=lf\n*.md merge=engram-md\n');
  writeFileSync(join(repo, 'engram.json'), '{}\n');
  return repo;
}

function e2eScenario(t, files) {
  const repo = makeVaultLike(t);
  const put = (p, c) => { const f = join(repo, ...p.split('/')); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, c); };
  for (const [p, [b]] of Object.entries(files)) put(p, b);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'other');
  for (const [p, [, , th]] of Object.entries(files)) put(p, th);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'theirs');
  git(repo, 'checkout', '-q', 'main');
  for (const [p, [, o]] of Object.entries(files)) put(p, o);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'ours');
  const env = { ...process.env }; delete env.ENGRAM_CONFLICTS_DIR;
  const m = spawnSync('git', ['-c', 'core.quotepath=false', 'merge', '--no-ff', '--no-edit', 'other'], { cwd: repo, encoding: 'utf8', env });
  const cdir = join(repo, 'conflicts');
  const conflicts = existsSync(cdir) ? readdirSync(cdir).map((id) => JSON.parse(readFileSync(join(cdir, id, 'meta.json'), 'utf8'))) : [];
  return { repo, m, conflicts, read: (p) => readFileSync(join(repo, ...p.split('/')), 'utf8') };
}

test('e2e R-27：對方引號未閉合 → merge commit 保留本機 metadata，對方進 vault 的 conflicts', (t) => {
  const rel = 'projects/專案 A/memory/我的 記憶.md';
  const theirs = sub(sub(RV_BASE, `"The user's favorite color is teal"`, `"The user's favorite color is teal`), 'pinned: false', 'pinned: true');
  const s = e2eScenario(t, { [rel]: [RV_BASE, OURS_BODY_EDIT(RV_BASE), theirs] });
  assert.equal(s.m.status, 0, s.m.stderr);
  const committed = git(s.repo, 'show', `HEAD:${rel}`);
  assert.equal(committed, OURS_BODY_EDIT(RV_BASE));
  assert.equal(s.conflicts.length, 1);
  assert.equal(s.conflicts[0].ref, rel);
  assert.deepEqual(s.conflicts[0].unparsable, ['theirs']);
});

test('e2e R-27：對方是 0 位元組 → 工作目錄保留本機 frontmatter', (t) => {
  const rel = 'projects/p/memory/x.md';
  const s = e2eScenario(t, { [rel]: [RV_BASE, OURS_BODY_EDIT(RV_BASE), ''] });
  assert.equal(parseMemoryFile(s.read(rel)).data.name, 'favorite-color');
  assert.equal(s.conflicts.length, 1);
});

test('e2e BUG-4：本機被搬成 metadata.engram、對方改了頂層 pinned → 合併為 true、不隔離', (t) => {
  const rel = 'projects/p/memory/x.md';
  const legacy = RV_BASE.replace('metadata:\n', 'engram:\n  pinned: false\n  tags:\n    - color\nmetadata:\n').replace('  engram:\n    pinned: false\n    tags:\n      - color\n', '');
  const ours = sub(RV_BASE, '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
  const theirs = legacy.replace('  pinned: false', '  pinned: true');
  const s = e2eScenario(t, { [rel]: [legacy, ours, theirs] });
  assert.equal(s.m.status, 0, s.m.stderr);
  assert.equal(parseMemoryFile(s.read(rel)).data.metadata.engram.pinned, true);
  assert.equal(s.conflicts.length, 0);
});

test('e2e BUG-7：同一次合併 6 個檔案衝突 → 6 筆獨立的衝突紀錄', (t) => {
  const o = sub(RV_BASE, '第一段：使用者喜歡青色。', '第一段：本機版。');
  const th = sub(RV_BASE, '第一段：使用者喜歡青色。', '第一段：對方版。');
  const files = {};
  for (let i = 0; i < 6; i++) files[`projects/p/memory/f${i}.md`] = [RV_BASE, o.replace('本機版', '本機版' + i), th.replace('對方版', '對方版' + i)];
  const s = e2eScenario(t, files);
  assert.equal(s.m.status, 0, s.m.stderr);
  assert.equal(s.conflicts.length, 6);
  assert.equal(new Set(s.conflicts.map((c) => c.ref)).size, 6);
  assert.equal(new Set(s.conflicts.map((c) => c.id)).size, 6);
});

test('e2e：兩邊各自新增同一檔、只差 harness 欄位 → 乾淨合併，較新者勝', (t) => {
  const repo = makeVaultLike(t);
  const mk = (mod, sid) => `---\nname: n\ndescription: d\nmetadata:\n  type: user\n  originSessionId: ${sid}\n  modified: ${mod}\n---\n\nbody\n`;
  writeFileSync(join(repo, 'README'), 'r\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'checkout', '-qb', 'other'); writeFileSync(join(repo, 'm.md'), mk('2026-10-22T00:00:00.000Z', 'b')); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 't');
  git(repo, 'checkout', '-q', 'main'); writeFileSync(join(repo, 'm.md'), mk('2026-10-21T00:00:00.000Z', 'a')); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'o');
  const env = { ...process.env }; delete env.ENGRAM_CONFLICTS_DIR;
  const m = spawnSync('git', ['merge', '--no-edit', 'other'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(m.status, 0, m.stderr);
  const p = parseMemoryFile(readFileSync(join(repo, 'm.md'), 'utf8'));
  assert.equal(p.data.metadata.modified, '2026-10-22T00:00:00.000Z');
  assert.equal(p.data.metadata.originSessionId, 'b');
  assert.equal(existsSync(join(repo, 'conflicts')), false);
});
