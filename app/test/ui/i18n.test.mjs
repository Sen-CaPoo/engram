// 管理介面多語系：每個中文字串都有英文、英文沒有多餘的鍵、參數一致、原始碼沒有漏掉沒包 t() 的中文。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import en, { PARTS } from '../../src/ui/src/locales/en/index.js';
import { t, local, N_, _setLangForTest } from '../../src/ui/src/i18n.js';
import { relTime, untilTime, since, humanizeCommit, undoText, SYNC_LABEL } from '../../src/ui/src/util.js';

const SRC = fileURLToPath(new URL('../../src/ui/src/', import.meta.url));
const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}[\p{Script=Han}\w\-.]*/gu;
// 展示資料是另一套（demo.js 依語言挑選），不在這裡檢查
const SKIP = new Set(['demo.js', 'demo-tidy.js']);

function sourceFiles(dir = SRC) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'locales') out.push(...sourceFiles(p)); continue; }
    if (/\.(js|jsx)$/.test(e.name) && !SKIP.has(e.name)) out.push(p);
  }
  return out;
}

const STR = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`;
const CALL = new RegExp(String.raw`\b(?:t|N_)\(\s*(${STR})`, 'g');
const unquote = (lit) => Function(`"use strict"; return (${lit});`)();
const placeholders = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

function stripComments(code) {
  return code
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;,{}()])\/\/.*$/gm, '$1');
}

const files = sourceFiles();
const keys = new Map(); // 鍵 → 出現的檔案
for (const f of files) {
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  for (const m of code.matchAll(CALL)) {
    const k = unquote(m[1]);
    if (!keys.has(k)) keys.set(k, []);
    keys.get(k).push(path.relative(SRC, f));
  }
}

describe('介面多語系', () => {
  test('找得到介面原始檔與翻譯鍵', () => {
    assert.ok(files.length >= 15, `只找到 ${files.length} 個原始檔`);
    assert.ok(keys.size >= 50, `只找到 ${keys.size} 個鍵`);
  });

  test('每個 t()／N_() 的中文都有英文對照', () => {
    const missing = [...keys].filter(([k]) => !Object.hasOwn(en, k)).map(([k, fs_]) => `${fs_[0]}：${k}`);
    assert.deepEqual(missing, [], `缺少英文：\n${missing.join('\n')}`);
  });

  test('英文對照沒有用不到的鍵', () => {
    const unused = Object.keys(en).filter((k) => !keys.has(k));
    assert.deepEqual(unused, [], `用不到的英文：\n${unused.join('\n')}`);
  });

  test('同一個鍵在不同檔案的英文相同', () => {
    const seen = new Map();
    const diff = [];
    for (const [part, dict] of Object.entries(PARTS)) {
      for (const [k, v] of Object.entries(dict)) {
        if (seen.has(k) && String(seen.get(k).v) !== String(v)) diff.push(`${k}（${seen.get(k).part} ↔ ${part}）`);
        else seen.set(k, { v, part });
      }
    }
    assert.deepEqual(diff, [], `英文不一致：\n${diff.join('\n')}`);
  });

  test('每份英文對照都已列入 index.js', () => {
    const dir = path.join(SRC, 'locales/en');
    const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js').map((f) => f.replace(/\.js$/, '')).sort();
    const listed = Object.keys(PARTS).sort();
    assert.deepEqual(listed, onDisk);
  });

  test('英文的參數與中文一致、沒有混入中文', () => {
    const bad = [];
    for (const [k, v] of Object.entries(en)) {
      const want = placeholders(k);
      // 中文原文用「」引起來的範例可以原樣保留
      const quoted = [...k.matchAll(/「([^」]*)」/g)].map((m) => m[1]).join('\n');
      const samples = typeof v === 'function'
        ? [0, 1, 2, 5].map((n) => v(Object.fromEntries([...want].map((p) => [p, p === 'n' ? n : `X`]))))
        : [v];
      for (const s of samples) {
        if (typeof s !== 'string') { bad.push(`${k}：英文不是字串`); continue; }
        const got = placeholders(s);
        const extra = [...got].filter((p) => !want.has(p));
        if (extra.length) bad.push(`${k}：英文多了參數 ${extra.join(', ')}`);
        if (typeof v !== 'function') {
          const lost = [...want].filter((p) => !got.has(p));
          if (lost.length) bad.push(`${k}：英文少了參數 ${lost.join(', ')}`);
        }
        for (const run of s.match(HAN_RUN) || []) if (!quoted.includes(run)) bad.push(`${k}：英文混入中文「${run}」`);
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test('原始碼的中文都經過 t()／N_()（註解與 i18n-ignore 除外）', () => {
    const leaks = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, 'utf8')).replace(CALL, '');
      code.split('\n').forEach((line, i) => {
        if (HAN.test(line) && !/i18n-ignore/.test(fs.readFileSync(f, 'utf8').split('\n')[i])) {
          leaks.push(`${path.relative(SRC, f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
    assert.deepEqual(leaks, [], `沒有經過 t() 的中文：\n${leaks.join('\n')}`);
  });

  // 區域變數或參數叫 t 會蓋掉 t()，執行時才會出錯（建置與上面的檢查都抓不到）
  test('有用 t() 的檔案裡沒有名為 t 的變數或參數', () => {
    const SHADOW = [
      /\b(?:const|let|var)\s+t\b\s*[=;,]/,
      /(?:^|[^\w.$])t\s*=>/,
      /\(\s*(?:[\w$]+\s*,\s*)*t\s*(?:,\s*[\w$]+\s*)*\)\s*=>/,
      /\bfunction\b[^(]*\(\s*(?:[^)]*,\s*)?t\s*(?:,[^)]*)?\)/,
      /\{\s*(?:[^{}]*,\s*)?t\s*(?:,[^{}]*)?\}\s*=/,
    ];
    const bad = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][./]*i18n\.js['"]/.test(code)) continue;
      code.replace(new RegExp(STR, 'g'), "''").split('\n').forEach((line, i) => {
        if (SHADOW.some((re) => re.test(line))) bad.push(`${path.relative(SRC, f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(bad, [], `會蓋掉 t() 的名稱：\n${bad.join('\n')}`);
  });

  test('鍵不能用樣板字串', () => {
    const bad = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of code.matchAll(/\b(?:t|N_)\(\s*`/g)) bad.push(`${path.relative(SRC, f)}：${code.slice(m.index, m.index + 60)}`);
    }
    assert.deepEqual(bad, []);
  });
});

describe('t() 與 local()', () => {
  test('中文模式：原文、代入參數、去掉情境', () => {
    _setLangForTest('zh-TW');
    assert.equal(t('立即同步'), '立即同步');
    assert.equal(t('{n} 分鐘前', { n: 3 }), '3 分鐘前');
    assert.equal(t('nav::專案'), '專案');
    assert.equal(N_('nav::專案'), 'nav::專案');
  });

  test('英文模式：對照、單複數、元素參數回傳陣列', () => {
    _setLangForTest('en');
    try {
      assert.equal(t('立即同步'), 'Sync now');
      assert.equal(t('nav::專案'), 'Projects');
      assert.equal(t('專案'), 'Project');
      assert.equal(t('{n} 天前', { n: 1 }), '1 day ago');
      assert.equal(t('{n} 天前', { n: 4 }), '4 days ago');
      const el = { type: 'code' };
      assert.deepEqual(t('也可以在終端機執行 {agent} 手動啟動，或執行 {doctor} 檢查原因。', { agent: el, doctor: el }),
        ['You can also run ', el, ' in a terminal to start it manually, or run ', el, ' to find out what is wrong.']);
      assert.equal(t('沒有對照的新字串 {x}', { x: 1 }), '沒有對照的新字串 1');
    } finally { _setLangForTest('zh-TW'); }
  });

  test('時間與變更紀錄的文字在兩種語言都能產生', () => {
    const now = new Date('2026-10-23T12:00:00').getTime();
    const at = (min) => new Date(now - min * 60000).toISOString();
    _setLangForTest('zh-TW');
    assert.equal(relTime(at(0.2), now), '剛剛');
    assert.equal(relTime(at(5), now), '5 分鐘前');
    assert.equal(relTime(at(26 * 60), now), '昨天 10:00');
    assert.equal(since(at(3 * 1440), now), '3 天');
    assert.deepEqual(humanizeCommit({ action: 'autosave', message: 'autosave +1 ~2 −0' }), { title: '自動儲存', detail: '新增 1 筆、修改 2 筆' });
    _setLangForTest('en');
    try {
      assert.equal(relTime(at(0.2), now), 'just now');
      assert.equal(relTime(at(5), now), '5 min ago');
      assert.equal(relTime(at(60), now), '1 hour ago');
      assert.equal(relTime(at(26 * 60), now), 'yesterday 10:00');
      assert.equal(relTime(at(3 * 1440), now), '3 days ago');
      assert.equal(untilTime(new Date(now + 10 * 60000).toISOString(), now), 'in 10 min');
      assert.equal(since(at(1440 * 3), now), '3 days');
      assert.deepEqual(humanizeCommit({ action: 'autosave', message: 'autosave +1 ~2 −0' }), { title: 'Autosave', detail: '1 added, 2 modified' });
      assert.equal(undoText({ notes: ['x'], en: { notes: ['y'] } }, 'Undone'), 'Undone. Note: y');
      // git 訊息是中文原文：英文介面只留翻譯過的標題
      assert.deepEqual(humanizeCommit({ action: 'conflict', message: 'engram(conflict): 隔離衝突 cf_1，保留本機版本' }), { title: 'Quarantine sync conflict', detail: '' });
      assert.deepEqual(humanizeCommit({ action: 'conflict', message: 'engram(conflict): quarantine cf_1' }), { title: 'Quarantine sync conflict', detail: 'quarantine cf_1' });
    } finally { _setLangForTest('zh-TW'); }
  });

  test('鍵不是字串時回傳空白，不會丟例外（標籤表查不到）', () => {
    for (const lang of ['zh-TW', 'en']) {
      _setLangForTest(lang);
      assert.equal(t(undefined), '');
      assert.equal(t(null), '');
    }
    _setLangForTest('zh-TW');
  });

  test('同步狀態標籤涵蓋引擎會寫入的每一種狀態（含另一個程序寫入中的 busy）', () => {
    for (const state of ['ok', 'syncing', 'busy', 'offline', 'auth', 'error', 'never']) assert.ok(SYNC_LABEL[state], state);
    _setLangForTest('en');
    try { assert.equal(t(SYNC_LABEL.busy), 'Syncing'); } finally { _setLangForTest('zh-TW'); }
  });

  test('local() 依語言挑選常駐程式附的英文', () => {
    const f = { title: '索引過長', en: { title: 'Index too long' }, detail: '只有中文' };
    _setLangForTest('en');
    try {
      assert.equal(local(f, 'title'), 'Index too long');
      assert.equal(local(f, 'detail'), '只有中文');
      assert.equal(local(null, 'title'), null);
    } finally { _setLangForTest('zh-TW'); }
    assert.equal(local(f, 'title'), '索引過長');
  });
});
