// frontmatter.mjs 的測試：fixtures 全為合成資料，模仿 Claude Code 實際寫出的格式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_KEYS,
  engramMeta,
  flatten,
  getField,
  normalizeBody,
  normalizeEngramLocation,
  parseMemoryFile,
  replaceBody,
  semanticKey,
  setFields,
  stringifyFrontmatter,
  unflatten,
} from '../../src/core/frontmatter.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'frontmatter');
const read = (name) => readFileSync(join(FIX, name), 'utf8');
const ALL = readdirSync(FIX).filter((f) => f.endsWith('.md')).sort();
const WITH_FM = ALL.filter((f) => f !== 'sample-no-frontmatter.md');
// 仿 harness 格式（name/description/metadata 四欄位）的 fixtures
const HARNESS_LIKE = WITH_FM.filter((f) => !['sample-legacy-engram.md', 'sample-block-scalars.md'].includes(f));

const toCRLF = (s) => s.replace(/\r?\n/g, '\r\n');
const BOM = '\uFEFF';

/** 去掉指定路徑後的攤平資料，用來確認「其他欄位沒變」。 */
function flatExcept(data, paths) {
  const f = flatten(data);
  for (const k of Object.keys(f)) if (paths.some((p) => k === p || k.startsWith(p + '.'))) delete f[k];
  return f;
}

/** 決定性的偽亂數，讓屬性測試可重現。 */
function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('fixtures 至少 10 份，全部為合成資料', () => {
  assert.ok(ALL.length >= 10, `只有 ${ALL.length} 份 fixtures`);
  for (const f of ALL) {
    const t = read(f);
    assert.ok(!/C:\\\\?Users\\\\?Sen/i.test(t), `${f} 不應含真實路徑`);
  }
});

test('仿 harness 格式的 fixtures 都能完整解析', () => {
  for (const f of HARNESS_LIKE) {
    const p = parseMemoryFile(read(f));
    assert.equal(p.hasFrontmatter, true, f);
    assert.deepEqual(p.errors, [], f);
    assert.equal(p.data.name, f.replace(/\.md$/, ''), f);
    assert.equal(typeof p.data.description, 'string', f);
    assert.ok(p.data.description.length > 10, f);
    assert.ok(['user', 'feedback', 'project', 'reference'].includes(p.data.metadata.type), f);
    assert.equal(p.data.metadata.node_type, 'memory', f);
    assert.match(p.data.metadata.originSessionId, /^[0-9a-f-]{36}$/, f);
    assert.match(p.data.metadata.modified, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, f);
    assert.equal(typeof p.data.metadata.modified, 'string', 'ISO 時間戳應保留為字串');
    assert.equal(p.eol, '\n');
  }
});

test('雙引號描述中的跳脫反斜線正確解碼', () => {
  const p = parseMemoryFile(read('demo-project-deploy.md'));
  assert.equal(p.data.description, 'Demo app deployed 2026-10-01 to C:\\Users\\Someone\\Projects\\demo-app, staging mode; port/allowlist caveats');
});

test('「metadata: 」後有尾端空白仍視為巢狀物件', () => {
  const p = parseMemoryFile(read('sample-user-profile.md'));
  assert.equal(p.data.metadata.type, 'user');
  assert.match(p.data.description, /範例使用者（某公司）/);
});

test('以 * 開頭的引號描述、含單引號的內容', () => {
  const p = parseMemoryFile(read('sample-wildcard-cert.md'));
  assert.equal(p.data.description.startsWith("*.example.test Let's Encrypt"), true);
});

test('未加引號的中文描述（含全形標點）', () => {
  const p = parseMemoryFile(read('sample-tool-quirk.md'));
  assert.equal(p.data.description, '範例工具採 A 版＋純 Skill 整合；同名的 B 版外掛是不同產品，已於 2026-09-06 移除，勿再安裝');
});

test('metadata.engram 區塊（逐行列表、巢狀物件）', () => {
  const p = parseMemoryFile(read('sample-engram-meta.md'));
  assert.deepEqual(p.data.metadata.engram, {
    pinned: true,
    tags: ['windows', 'powershell'],
    project: 'demo-app-3fa9k',
    reviewedAt: '2026-10-22',
  });
  assert.equal(getField(p.data, 'metadata.engram.pinned'), true);
  assert.equal(getField(p.data, 'metadata.engram.missing'), undefined);
  assert.equal(getField(p.data, 'name.deeper'), undefined);
});

test('舊格式：註解、單引號跳脫、行內陣列、各種純量', () => {
  const p = parseMemoryFile(read('sample-legacy-engram.md'));
  assert.deepEqual(p.errors, []);
  assert.equal(p.data.name, 'sample-legacy-engram');
  assert.equal(p.data.description, "It's a legacy file with a single-quoted description: colons and #hash inside quotes");
  assert.deepEqual(p.data.engram, { pinned: false, tags: ['alpha', 'beta gamma', 'delta'], note: 'plain value' });
  assert.equal(p.data.metadata.count, 42);
  assert.equal(p.data.metadata.ratio, 0.5);
  assert.equal(p.data.metadata.enabled, 'yes', 'YAML 1.2：yes 是字串');
  assert.equal(p.data.metadata.empty, null);
  assert.equal(p.data.metadata.nothing, null);
  assert.deepEqual(p.data.metadata.flow, {});
  assert.equal(p.body, 'Body starts right after the closing line without a blank line.\n');
});

test('區塊純量、雙引號跳脫、物件列表、緊湊列表', () => {
  const p = parseMemoryFile(read('sample-block-scalars.md'));
  assert.deepEqual(p.errors, []);
  assert.equal(p.data.description, 'This description is folded across two lines.');
  assert.equal(p.data.metadata.notes, 'line one\nline two\n\nline four after blank\n');
  assert.equal(p.data.metadata.escaped, 'tab\there 中文 "quoted" back\\slash');
  assert.deepEqual(p.data.metadata.items, [{ name: 'first', value: 1 }, { name: 'second', value: 2 }]);
  assert.deepEqual(p.data.metadata.compact, ['a', 'b']);
});

test('沒有 frontmatter 的檔案整份視為內文', () => {
  const t = read('sample-no-frontmatter.md');
  const p = parseMemoryFile(t);
  assert.equal(p.hasFrontmatter, false);
  assert.deepEqual(p.data, {});
  assert.equal(p.body, t);
});

test('CRLF 與 BOM 都能解析，並回報換行種類', () => {
  for (const f of HARNESS_LIKE) {
    const lfText = read(f);
    const crlf = BOM + toCRLF(lfText);
    const a = parseMemoryFile(lfText);
    const b = parseMemoryFile(crlf);
    assert.equal(b.eol, '\r\n', f);
    assert.deepEqual(b.data, a.data, f);
    assert.equal(normalizeBody(b.body), normalizeBody(a.body), f);
  }
});

test('setFields 沒有更新時原樣返回（含 CRLF 與 BOM）', () => {
  for (const f of ALL) {
    const t = read(f);
    assert.equal(setFields(t, {}), t, f);
    const v = BOM + toCRLF(t);
    assert.equal(setFields(v, {}), v, f);
  }
});

test('setFields 只改動目標那一行', () => {
  for (const f of HARNESS_LIKE) {
    const t = read(f);
    const out = setFields(t, { 'metadata.modified': '2030-01-01T00:00:00.000Z' });
    const a = t.split('\n'), b = out.split('\n');
    assert.equal(a.length, b.length, f);
    const diff = a.filter((line, i) => line !== b[i]);
    assert.equal(diff.length, 1, f);
    assert.equal(parseMemoryFile(out).data.metadata.modified, '2030-01-01T00:00:00.000Z');
  }
});

test('新增巢狀鍵後再刪除，回到一模一樣的位元組', () => {
  for (const f of HARNESS_LIKE) {
    for (const variant of [read(f), BOM + toCRLF(read(f))]) {
      const added = setFields(variant, { 'metadata.probe.pinned': true, 'metadata.probe.tags': ['alpha', 'b c'] });
      const p = parseMemoryFile(added);
      assert.deepEqual(p.data.metadata.probe, { pinned: true, tags: ['alpha', 'b c'] }, f);
      assert.deepEqual(flatExcept(p.data, ['metadata.probe']), flatten(parseMemoryFile(variant).data), f);
      assert.equal(p.body, parseMemoryFile(variant).body, f);
      if (variant.includes('\r\n')) assert.ok(!/[^\r]\n/.test(added), `${f}：不應出現單獨的 LF`);
      if (variant.startsWith(BOM)) assert.ok(added.startsWith(BOM), `${f}：BOM 應保留`);
      assert.equal(setFields(added, { 'metadata.probe': undefined }), variant, f);
    }
  }
  // 已有 metadata.engram 時，新增子鍵再刪除也要回到原樣
  const t = read('sample-engram-meta.md');
  const added = setFields(t, { 'metadata.engram.extra': 'x' });
  assert.equal(parseMemoryFile(added).data.metadata.engram.extra, 'x');
  assert.equal(setFields(added, { 'metadata.engram.extra': undefined }), t);
});

test('刪除鍵；刪除不存在的鍵不會改動內容', () => {
  const t = read('demo-project-deploy.md');
  const out = setFields(t, { 'metadata.node_type': undefined });
  const p = parseMemoryFile(out);
  assert.equal('node_type' in p.data.metadata, false);
  assert.equal(p.data.metadata.type, 'project');
  assert.equal(setFields(t, { 'metadata.nope': undefined, 'nope.deeper': undefined }), t);
});

test('取代物件或列表時，整個巢狀區塊一起換掉', () => {
  const t = read('sample-engram-meta.md');
  const out = setFields(t, { 'metadata.engram.tags': ['only'], 'metadata.engram.project': undefined });
  const p = parseMemoryFile(out);
  assert.deepEqual(p.data.metadata.engram, { pinned: true, tags: ['only'], reviewedAt: '2026-10-22' });
  assert.ok(out.includes('    tags:\n      - only\n'));
  const out2 = setFields(t, { 'metadata.engram': { pinned: false } });
  assert.deepEqual(parseMemoryFile(out2).data.metadata.engram, { pinned: false });
  assert.equal(parseMemoryFile(out2).data.metadata.modified, '2026-10-22T01:30:00.000Z');
});

test('中間層是純量、空值或行內物件時改寫成物件', () => {
  const t = read('sample-legacy-engram.md');
  const out = setFields(t, { 'metadata.flow.a': 1, 'metadata.empty.b': 'x: y', 'name.sub': 'z' });
  const p = parseMemoryFile(out);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.data.metadata.flow, { a: 1 });
  assert.deepEqual(p.data.metadata.empty, { b: 'x: y' });
  assert.deepEqual(p.data.name, { sub: 'z' });
  // 註解與其他行保持原樣
  assert.ok(out.includes('# 舊格式：頂層 engram 區塊與行內陣列'));
  assert.ok(out.includes('  note: plain value # trailing comment'));
});

test('新增頂層鍵與多層父物件', () => {
  const t = read('sample-reference-api.md');
  const out = setFields(t, { 'extra.deep.value': 'v', top: 1 });
  const p = parseMemoryFile(out);
  assert.equal(p.data.extra.deep.value, 'v');
  assert.equal(p.data.top, 1);
  assert.equal(p.body, parseMemoryFile(t).body);
});

test('沒有 frontmatter 時 setFields 會建立一個', () => {
  const t = read('sample-no-frontmatter.md');
  const out = setFields(t, { name: 'new-memory', 'metadata.type': 'project', description: 'a: b' });
  const p = parseMemoryFile(out);
  assert.equal(p.hasFrontmatter, true);
  assert.equal(p.data.name, 'new-memory');
  assert.equal(p.data.description, 'a: b');
  assert.equal(p.data.metadata.type, 'project');
  assert.equal(normalizeBody(p.body), normalizeBody(t));
  assert.ok(out.startsWith('---\nname: new-memory\ndescription: "a: b"\nmetadata:\n  type: project\n---\n\n# Just a heading'));
  // CRLF 與 BOM
  const v = BOM + toCRLF(t);
  const out2 = setFields(v, { name: 'x' });
  assert.ok(out2.startsWith(BOM + '---\r\nname: x\r\n---\r\n\r\n'));
});

test('需要時才加引號，且來回一致', () => {
  const cases = {
    plain: 'hello world',
    cjk: '中文說明，含全形標點：沒問題',
    colon: 'a: b',
    trailingColon: 'ends with:',
    hash: 'x #y',
    leadingHash: '#tag',
    star: '*.example.test',
    dash: '- item',
    backslash: 'C:\\Users\\Someone',
    boolLike: 'true',
    nullLike: 'null',
    numLike: '123',
    floatLike: '1.5',
    yes: 'yes',
    empty: '',
    spaces: '  padded  ',
    newline: 'line1\nline2',
    quote: 'say "hi"',
    single: "it's",
    date: '2026-10-22',
    iso: '2026-10-22T01:30:00.000Z',
    url: 'https://example.test/a?b=c',
    braces: '{not: flow}',
  };
  const t = read('sample-reference-api.md');
  const updates = Object.fromEntries(Object.entries(cases).map(([k, v]) => [`metadata.q.${k}`, v]));
  const out = setFields(t, updates);
  const p = parseMemoryFile(out);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.data.metadata.q, cases);
  assert.ok(out.includes('    plain: hello world\n'));
  assert.ok(out.includes('    cjk: 中文說明，含全形標點：沒問題\n'));
  assert.ok(out.includes('    iso: 2026-10-22T01:30:00.000Z\n'));
  assert.ok(out.includes('    boolLike: "true"\n'));
  assert.ok(out.includes('    backslash: "C:\\\\Users\\\\Someone"\n'));
});

test('非字串值：布林、數字、null、日期、物件列表', () => {
  const t = read('sample-reference-api.md');
  const d = new Date('2026-10-22T00:00:00.000Z');
  const out = setFields(t, {
    'x.b': false, 'x.n': 7, 'x.f': 0.25, 'x.z': null, 'x.d': d,
    'x.list': [{ name: 'a', value: 1 }, 'plain', ['nested', 'flow']],
    'x.emptyList': [], 'x.emptyObj': {},
  });
  const p = parseMemoryFile(out);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.data.x, {
    b: false, n: 7, f: 0.25, z: null, d: '2026-10-22T00:00:00.000Z',
    list: [{ name: 'a', value: 1 }, 'plain', ['nested', 'flow']],
    emptyList: [], emptyObj: {},
  });
});

test('stringifyFrontmatter：欄位順序與可解析性', () => {
  const data = {
    metadata: { type: 'feedback', engram: { tags: ['a'] } },
    extra: 'x',
    description: 'desc: with colon',
    name: 'brand-new',
  };
  const fm = stringifyFrontmatter(data);
  assert.ok(fm.startsWith('---\nname: brand-new\ndescription: "desc: with colon"\nmetadata:\n'));
  assert.ok(fm.endsWith('---\n'));
  const p = parseMemoryFile(fm + '\nbody\n');
  assert.deepEqual(p.data, { name: 'brand-new', description: 'desc: with colon', metadata: { type: 'feedback', engram: { tags: ['a'] } }, extra: 'x' });
});

test('normalizeBody 與 semanticKey 不受換行、行尾空白、harness 欄位影響', () => {
  const t = read('sample-long-cjk.md');
  const a = parseMemoryFile(t);
  const noisy = setFields(BOM + toCRLF(t).replace(/。\r\n/g, '。   \r\n') + '\r\n\r\n\r\n', {
    'metadata.modified': '2031-01-01T00:00:00.000Z',
    'metadata.originSessionId': '99999999-9999-4999-8999-999999999999',
    'metadata.node_type': 'other',
  });
  const b = parseMemoryFile(noisy);
  assert.equal(semanticKey(b), semanticKey(a));
  assert.equal(normalizeBody('a  \r\n\r\n\r\n\r\nb\n'), 'a\n\nb');
  const changed = parseMemoryFile(setFields(t, { description: '不同的描述' }));
  assert.notEqual(semanticKey(changed), semanticKey(a));
  assert.deepEqual([...HARNESS_KEYS], ['metadata.node_type', 'metadata.originSessionId', 'metadata.modified']);
});

test('engramMeta 合併頂層與 metadata.engram，後者優先', () => {
  const legacy = parseMemoryFile(read('sample-legacy-engram.md'));
  assert.deepEqual(engramMeta(legacy.data), { pinned: false, tags: ['alpha', 'beta gamma', 'delta'], note: 'plain value' });
  const both = parseMemoryFile(setFields(read('sample-legacy-engram.md'), { 'metadata.engram.pinned': true, 'metadata.engram.project': 'p-1' }));
  assert.deepEqual(engramMeta(both.data), { pinned: true, tags: ['alpha', 'beta gamma', 'delta'], note: 'plain value', project: 'p-1' });
  assert.deepEqual(engramMeta({}), {});
  assert.deepEqual(engramMeta(null), {});
});

test('flatten 與 unflatten 互為反向', () => {
  for (const f of WITH_FM) {
    const { data } = parseMemoryFile(read(f));
    assert.deepEqual(unflatten(flatten(data)), data, f);
  }
  assert.deepEqual(flatten({ a: { b: 1, c: { d: [1, 2] } }, e: {} }), { 'a.b': 1, 'a.c.d': [1, 2], e: {} });
});

test('壞掉的輸入：parseMemoryFile 不丟例外並回報錯誤；結構性錯誤時 setFields 拒絕（E_INVALID）', () => {
  const structural = [
    '---\nname: x\n',                          // 沒有結尾
    '---\n- a\n- b\n---\nbody',                 // 頂層是列表
    '---\n\tname: tab\n---\n',                 // tab 縮排
    '---\n: no key\njust text\n---\n',          // 無法解析的行
    '---\na:\n    b: 1\n  c: 2\n---\n',         // 縮排不一致
    '---\na: x\n  b: y\n---\n',                 // 純量後出現更深的鍵值
  ];
  for (const t of structural) {
    const p = parseMemoryFile(t);
    assert.equal(typeof p.body, 'string');
    assert.ok(p.errors.length > 0, `應回報錯誤：${JSON.stringify(t)}`);
    assert.throws(() => setFields(t, { 'metadata.x': 1 }), (err) => err.code === 'E_INVALID', JSON.stringify(t));
    assert.equal(setFields(t, {}), t, '沒有更新時仍原樣返回');
  }
  // 單行內的錯誤：回報，但修改只影響目標行
  for (const t of ['---\nname: "unterminated\nother: 1\n---\n', '---\nlist: [a, b\nother: 1\n---\n']) {
    const p = parseMemoryFile(t);
    assert.ok(p.errors.length > 0);
    assert.equal(p.data.other, 1, '後面的行不能被吞掉');
    const out = setFields(t, { other: 2 });
    assert.equal(parseMemoryFile(out).data.other, 2);
    assert.equal(out.split('\n')[1], t.split('\n')[1], '壞掉的那一行保持原樣');
  }
  for (const t of ['', null]) {
    assert.deepEqual(parseMemoryFile(t).errors, []);
    assert.doesNotThrow(() => setFields(t ?? '', { 'metadata.x': 1 }));
  }
});

// ───────── claude-57 審查（R-28、BUG-5、9～13）的回歸測試 ─────────

const UNCLOSED = `---
name: favorite-color
description: "The user's favorite color is teal
metadata:
  node_type: memory
  type: user
  modified: 2026-10-22T01:02:03.456Z
  engram:
    pinned: true
---

body
`;

test('R-28：未閉合的引號只影響那一行，setFields 不會刪掉或重複其他區塊', () => {
  const p = parseMemoryFile(UNCLOSED);
  assert.ok(p.errors.some((e) => /沒有閉合/.test(e)));
  assert.equal(p.data.metadata.type, 'user');
  assert.equal(p.data.metadata.engram.pinned, true);
  const out = setFields(UNCLOSED, { description: 'fixed description' });
  for (const k of ['node_type', 'type: user', 'modified', 'pinned']) assert.ok(out.includes(k), `不應遺失 ${k}`);
  assert.deepEqual(parseMemoryFile(out).errors, [], '修正壞掉的那一行後就沒有錯誤');
  const out2 = setFields(UNCLOSED, { 'metadata.modified': '2026-10-23T00:00:00.000Z' });
  const q = parseMemoryFile(out2);
  assert.equal((out2.match(/^metadata:/gm) || []).length, 1, '不能插入第二個 metadata 區塊');
  assert.equal(q.data.metadata.type, 'user');
  assert.equal(q.data.metadata.engram.pinned, true);
  assert.equal(q.data.metadata.modified, '2026-10-23T00:00:00.000Z');
  const single = UNCLOSED.replace(`"The user's favorite color is teal`, `'The users favorite color is teal`);
  assert.ok(setFields(single, { description: 'x' }).includes('pinned: true'));
});

test('R-28：結構性錯誤時 setFields 丟出 E_INVALID 且附上錯誤清單', () => {
  const t = '---\nmetadata:\n\ttype: user\n---\n';
  assert.throws(() => setFields(t, { 'metadata.type': 'x' }), (err) => err.code === 'E_INVALID' && Array.isArray(err.details?.errors) && err.details.errors.length > 0);
  assert.throws(() => setFields('---\nname: x\n', { name: 'y' }), (err) => err.code === 'E_INVALID', '沒有結尾分隔行時不可在前面再加一個 frontmatter');
  // 管理介面英文模式：錯誤清單的診斷訊息一併翻成英文
  assert.throws(() => setFields(t, { 'metadata.type': 'x' }), (err) => err.en?.message === 'The frontmatter is malformed, so the change was refused: Line 2 is indented with a tab' && /raw mode/.test(err.en.hint));
  assert.throws(() => setFields('---\nname: x\n', { name: 'y' }), (err) => /closing --- line/.test(err.en?.message) && !/[一-鿿]/.test(err.en.message));
});

test('重複的鍵只是提醒：讀取與修改都以最後一個為準', () => {
  const t = '---\nname: a\nname: b\n---\n';
  const p = parseMemoryFile(t);
  assert.equal(p.data.name, 'b');
  assert.deepEqual(p.errors, []);
  assert.equal(p.warnings.length, 1);
  assert.equal(setFields(t, { name: 'c' }), '---\nname: a\nname: c\n---\n');
});

test('BUG-5：值從下一行開始的純量（純文字與引號）', () => {
  const mk = (desc) => `---\nname: n\ndescription:\n  ${desc}\nmetadata:\n  type: user\n---\n\npara1\n`;
  assert.equal(parseMemoryFile(mk('使用者偏好青色')).data.description, '使用者偏好青色');
  assert.equal(parseMemoryFile(mk('"The user\'s favorite color is teal"')).data.description, "The user's favorite color is teal");
  const p = parseMemoryFile(mk('第一行\n  第二行'));
  assert.equal(p.data.description, '第一行 第二行');
  assert.equal(p.data.metadata.type, 'user');
  const out = setFields(mk('使用者偏好青色'), { description: '使用者偏好藍色' });
  assert.ok(out.includes('description: 使用者偏好藍色\nmetadata:'));
  assert.ok(!out.includes('青色'));
});

test('BUG-9：結尾分隔行沒有換行時，換內文不會黏在一起', () => {
  assert.equal(replaceBody('---\nname: a\n---', 'new body\n'), '---\nname: a\n---\nnew body\n');
  assert.equal(replaceBody('---\r\nname: a\r\n---', 'x'), '---\r\nname: a\r\n---\r\nx');
  assert.equal(replaceBody('---\nname: a\n---', ''), '---\nname: a\n---');
  assert.equal(replaceBody('---\nname: a\n---\n\nold\n', '\nnew\n'), '---\nname: a\n---\n\nnew\n');
  assert.equal(replaceBody('\uFEFFplain', 'x'), '\uFEFFx');
  const p = parseMemoryFile(replaceBody('---\nname: a\ndescription: d2\n---', 'new body\n'));
  assert.equal(p.data.description, 'd2');
  assert.equal(p.body, 'new body\n');
});

test('BUG-10：含點的鍵不會被拆成巢狀', () => {
  const t = '---\nname: x\nmetadata:\n  engram:\n    aliases:\n      v1.2: old\n---\nbody\n';
  const p = parseMemoryFile(t);
  assert.equal(p.data.metadata.engram.aliases['v1.2'], 'old');
  assert.equal(getField(p.data, 'metadata.engram.aliases.v1.2'), 'old');
  assert.equal(getField(p.data, 'metadata.engram.aliases.v1\\.2'), 'old');
  assert.equal(getField(p.data, ['metadata', 'engram', 'aliases', 'v1.2']), 'old');
  const out = setFields(t, { 'metadata.engram.aliases.v1.2': 'new' });
  assert.deepEqual(parseMemoryFile(out).data.metadata.engram.aliases, { 'v1.2': 'new' });
  const out2 = setFields(t, [[['metadata', 'engram', 'aliases', 'v2.0'], 'added']]);
  assert.deepEqual(parseMemoryFile(out2).data.metadata.engram.aliases, { 'v1.2': 'old', 'v2.0': 'added' });
  const out3 = setFields(t, { 'metadata.engram.aliases.v3\\.1': 'esc' });
  assert.equal(parseMemoryFile(out3).data.metadata.engram.aliases['v3.1'], 'esc');
  const flat = flatten(p.data);
  assert.ok(Object.prototype.hasOwnProperty.call(flat, 'metadata.engram.aliases.v1\\.2'));
  assert.deepEqual(unflatten(flat), p.data);
});

test('BUG-11：換行混用時，新插入的行跟隨 frontmatter 的多數換行（預設 LF）', () => {
  const t = '---\nname: a\nmetadata:\n  type: user\n---\n\r\n正文 line1\r\nline2\r\nline3\r\n';
  const fmOf = (s) => s.slice(0, s.indexOf('\n---\n') + 5);
  const out = setFields(t, { 'metadata.modified': '2026-10-23T00:00:00.000Z', 'metadata.engram.reviewedAt': '2026-10-22' });
  assert.ok(!fmOf(out).includes('\r'), JSON.stringify(out));
  assert.equal(parseMemoryFile(out).body, parseMemoryFile(t).body);
  const crlf = t.replace(/\r?\n/g, '\r\n');
  assert.ok(!/[^\r]\n/.test(setFields(crlf, { 'metadata.x': 1 })));
});

test('BUG-12：YAML 相容性——折疊區塊、跳脫、註解', () => {
  const V = (fm) => parseMemoryFile(`---\n${fm}\n---\nbody\n`);
  const cases = [
    ['d: >\n  a\n    b\n  c', 'a\n  b\nc\n'],
    ['d: >\n  a\n  b\n\n  c', 'a b\nc\n'],
    ['d: |\n  line1\n  line2\nx: 1', 'line1\nline2\n'],
    ['d: |-\n  line1\n  line2', 'line1\nline2'],
    ['d: aaa\n  bbb', 'aaa bbb'],
    ['d: "aaa\n  bbb"', 'aaa bbb'],
    ['d: "使用者偏好\\\n  正體中文"', '使用者偏好正體中文'],
    ['d: "a\n\n  b"', 'a\nb'],
    ['d: "\\U0001F3A8"', '🎨'],
    ['d: "\\N\\_\\L\\P"', '\u0085\u00A0\u2028\u2029'],
    ["d: user's color # c", "user's color"],
    ['d: https://x.com/a#b', 'https://x.com/a#b'],
    ['d: hello world # note', 'hello world'],
    ['d: a:b c: d', 'a:b c: d'],
    ['d: 007', 7],
    ['d: [a, "b, c", \'d\']', ['a', 'b, c', 'd']],
    ['d: "x" # trailing comment', 'x'],
  ];
  for (const [fm, exp] of cases) {
    const p = V(fm);
    assert.deepEqual(p.data.d, exp, fm);
    assert.deepEqual(p.errors, [], fm);
  }
});

test('BUG-13：看起來像數字、布林或 null 的字串一律加引號寫出', () => {
  const forms = ['0x1F', '1e5', '.inf', '-.Inf', '.nan', '0o17', '0b101', '1_000', '1.0', '+12', '190:20:30',
    'yes', 'No', 'ON', 'off', 'y', 'N', 'True', 'FALSE', 'null', 'Null', '~', '=', '<<', '123', ''];
  for (const s of forms) {
    const out = setFields('---\nname: n\n---\n', { d: s });
    const line = out.split('\n')[2];
    assert.match(line, /^d: "/, `${s} 應加引號：${line}`);
    assert.equal(parseMemoryFile(out).data.d, s);
  }
  for (const s of ['hello', '2026-10-22', '2026-10-22T01:30:00.000Z', 'v1.2.3', '中文', 'a-b', 'C3PO']) {
    const out = setFields('---\nname: n\n---\n', { d: s });
    assert.equal(out.split('\n')[2], `d: ${s}`, `${s} 不需要引號`);
  }
  const tricky = ["The user's favorite", 'a #', 'end:', '? x', '`x`', '%x', '@x', '|x', '>x', '!x', '&x', '*x', '[x]', '{x}',
    ' lead', 'trail ', 'a\tb', 'line1\nline2', 'a\u2028b', '\u0085', '"q"', "'s'", '中文：冒號', '🎨'];
  for (const s of tricky) {
    const out = setFields('---\nname: n\n---\n', { d: s });
    assert.equal(parseMemoryFile(out).data.d, s, JSON.stringify(s));
  }
});

test('__proto__ 等原型鍵當成一般資料，不會污染原型', () => {
  const t = '---\nmetadata:\n  __proto__: x\n  type: user\n---\n';
  const p = parseMemoryFile(t);
  assert.ok(Object.prototype.hasOwnProperty.call(p.data.metadata, '__proto__'));
  assert.equal(p.data.metadata.type, 'user');
  const out = setFields('---\nname: a\n---\n', { 'metadata.__proto__.polluted': true });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(parseMemoryFile(out).data.metadata, '__proto__'), true);
});

test('結構邊界：4 格縮排、註解後插入、--- 水平線、... 結尾、分隔行尾端空白', () => {
  assert.equal(setFields('---\nmetadata:\n    type: user\n---\n', { 'metadata.engram.tags': ['a'] }),
    '---\nmetadata:\n    type: user\n    engram:\n        tags:\n            - a\n---\n');
  const d = parseMemoryFile(setFields('---\nmetadata:\n  type: user\n\n  # trailing comment\nother: 1\n---\n', { 'metadata.engram.pinned': true }));
  assert.equal(d.data.metadata.engram.pinned, true);
  assert.equal(d.data.other, 1);
  assert.equal(parseMemoryFile('---\nname: a\n---\n---\n\ntext\n---\n').body, '---\n\ntext\n---\n');
  assert.equal(parseMemoryFile('---\nname: a\n...\nbody\n').data.name, 'a');
  assert.equal(setFields('---  \nname: a\n---   \nbody\n', { name: 'b' }), '---  \nname: b\n---   \nbody\n');
  const seq = parseMemoryFile('---\nmetadata:\n  links:\n    - title: a: b\n      url: https://x/#y\n    - title: c\n---\n');
  assert.deepEqual(seq.data.metadata.links, [{ title: 'a: b', url: 'https://x/#y' }, { title: 'c' }]);
});

test('效能：2000 個鍵的 frontmatter 做 200 次修改在 2 秒內', () => {
  let fm = '---\nmetadata:\n';
  for (let i = 0; i < 2000; i++) fm += `  k${i}: v${i}\n`;
  fm += '---\nbody\n';
  const upd = {};
  for (let i = 0; i < 200; i++) upd[`metadata.k${i}`] = 'z';
  const t0 = Date.now();
  const out = setFields(fm, upd);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(parseMemoryFile(out).data.metadata.k199, 'z');
});

test('normalizeEngramLocation：頂層 engram 搬到 metadata.engram（後者優先）', () => {
  const data = { name: 'n', engram: { pinned: true, tags: ['a'] }, metadata: { type: 'user', engram: { tags: ['b'] } } };
  assert.deepEqual(normalizeEngramLocation(data), { name: 'n', metadata: { type: 'user', engram: { pinned: true, tags: ['b'] } } });
  assert.deepEqual(normalizeEngramLocation({ engram: { pinned: false } }), { metadata: { engram: { pinned: false } } });
  const untouched = { name: 'x', metadata: { type: 'user' } };
  assert.equal(normalizeEngramLocation(untouched), untouched);
  assert.deepEqual(data.engram, { pinned: true, tags: ['a'] }, '不修改輸入');
});

test('屬性測試：隨機更新後，被更新的鍵反映新值、其他欄位與內文不變', () => {
  const rnd = prng(20261022);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const paths = ['name', 'description', 'metadata.type', 'metadata.modified', 'metadata.engram.pinned', 'metadata.engram.tags', 'metadata.engram.project', 'extra.flag', 'metadata.engram.deep.x'];
  const values = [true, false, 0, 42, 'plain', '中文值', 'a: b', 'C:\\x', ['t1', 't2'], [], null, undefined];
  for (let round = 0; round < 300; round++) {
    const f = pick(HARNESS_LIKE.concat(['sample-legacy-engram.md', 'sample-block-scalars.md']));
    const base = rnd() < 0.5 ? read(f) : BOM + toCRLF(read(f));
    const updates = {};
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) updates[pick(paths)] = pick(values);
    // 同一批更新中不能同時改父鍵與子鍵
    const keys = Object.keys(updates);
    if (keys.some((a) => keys.some((b) => a !== b && b.startsWith(a + '.')))) continue;
    const before = parseMemoryFile(base);
    const out = setFields(base, updates);
    const after = parseMemoryFile(out);
    assert.deepEqual(after.errors, [], `${f} ${JSON.stringify(updates)}`);
    for (const [p, v] of Object.entries(updates)) {
      const got = getField(after.data, p);
      if (v === undefined) assert.equal(got, undefined, `${p} 應被刪除`);
      else assert.deepEqual(got, v, `${f} ${p}`);
    }
    // 其他欄位：除了被更新路徑的祖先與後代外都不變
    const touched = Object.keys(updates);
    const affected = (k) => touched.some((p) => k === p || k.startsWith(p + '.') || p.startsWith(k + '.'));
    const fa = flatten(after.data), fb = flatten(before.data);
    for (const k of Object.keys(fb)) if (!affected(k)) assert.deepEqual(fa[k], fb[k], `${f} ${k} 不應改變`);
    assert.equal(after.body, before.body);
    if (base.includes('\r\n')) assert.ok(!/[^\r]\n/.test(out));
  }
});
