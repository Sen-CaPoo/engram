import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, SearchIndex } from '../../src/core/search.mjs';

test('tokenize：英文轉小寫，kebab 與 snake 以分隔符切開', () => {
  assert.deepEqual(tokenize('Line-Desktop_MCP v1.98.0'), ['line', 'desktop', 'mcp', 'v1', '98', '0']);
});

test('tokenize：camelCase 切開並保留整段複合詞', () => {
  assert.deepEqual(tokenize('autoMemoryDirectory'), ['auto', 'memory', 'directory', 'automemorydirectory']);
  assert.deepEqual(tokenize('HTTPServer'), ['http', 'server', 'httpserver']);
  assert.deepEqual(tokenize('LiteLLM'), ['lite', 'llm', 'litellm']);
});

test('tokenize：全形字元經 NFKC 正規化', () => {
  assert.deepEqual(tokenize('Ｆｕｌｌ１２'), ['full12']);
});

test('tokenize：中文產生雙字組，單字區段保留單字', () => {
  assert.deepEqual(tokenize('記憶管理'), ['記憶', '憶管', '管理']);
  assert.deepEqual(tokenize('記 a'), ['記', 'a']);
});

test('tokenize：三字以上的詞由 Intl.Segmenter 另外加入', () => {
  const toks = tokenize('資料庫');
  assert.ok(toks.includes('資料'));
  assert.ok(toks.includes('料庫'));
  assert.ok(toks.includes('資料庫'));
});

test('tokenize：中英混合與空字串', () => {
  assert.deepEqual(tokenize('LiteLLM閘道'), ['lite', 'llm', 'litellm', '閘道']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

function sample() {
  const ix = new SearchIndex();
  ix.add('a', { name: '專案記憶管理', description: '整理 Claude 的記憶', body: '內文' });
  ix.add('b', { name: 'redis 協調', body: '這裡提到記憶體與 LiteLLM 的 cooldown' });
  ix.add('c', { name: 'LiteLLM gateway', description: '閘道部署', tags: ['docker', 'litellm'] });
  ix.add('d', { name: 'PowerShell BOM', description: '中文腳本要加 BOM', body: 'UTF-8 with BOM' });
  return ix;
}

test('search：兩個字的中文詞可以命中較長詞', () => {
  const hits = sample().search('記憶');
  assert.equal(hits[0].id, 'a');
  assert.ok(hits.some((h) => h.id === 'b'));
});

test('search：雙字組查詢', () => {
  const hits = sample().search('憶管');
  assert.deepEqual(hits.map((h) => h.id), ['a']);
});

test('search：單一中文字展開成含該字的詞', () => {
  const ids = sample().search('憶').map((h) => h.id);
  assert.ok(ids.includes('a'));
  assert.ok(ids.includes('b'));
});

test('search：最後一個英文詞做前綴比對', () => {
  const ids = sample().search('lite').map((h) => h.id);
  assert.equal(ids[0], 'c');
  assert.ok(ids.includes('b'));
  assert.deepEqual(sample().search('powersh').map((h) => h.id), ['d']);
  // 只有最後一個詞展開
  assert.deepEqual(sample().search('powersh bom').map((h) => h.id), ['d']);
});

test('search：名稱命中排在只有內文命中之前', () => {
  const ix = new SearchIndex();
  ix.add('body-only', { name: 'x', body: 'docker docker' });
  ix.add('name-hit', { name: 'docker', body: 'y' });
  assert.deepEqual(ix.search('docker').map((h) => h.id), ['name-hit', 'body-only']);
});

test('search：命中較多查詢詞的文件排名較前', () => {
  const ix = new SearchIndex();
  ix.add('one', { body: 'redis' });
  ix.add('both', { body: 'redis cooldown' });
  assert.equal(ix.search('redis cooldown')[0].id, 'both');
});

test('search：回報命中的欄位', () => {
  const hit = sample().search('docker')[0];
  assert.equal(hit.id, 'c');
  assert.deepEqual(hit.fields, ['tags']);
});

test('search：add 同一個 id 會取代；remove 與 size', () => {
  const ix = sample();
  assert.equal(ix.size, 4);
  ix.add('d', { name: '全新內容' });
  assert.equal(ix.size, 4);
  assert.deepEqual(ix.search('powershell'), []);
  assert.deepEqual(ix.search('全新').map((h) => h.id), ['d']);
  ix.remove('d');
  ix.remove('不存在');
  assert.equal(ix.size, 3);
  assert.deepEqual(ix.search('全新'), []);
});

test('search：limit、空查詢、空索引', () => {
  const ix = sample();
  assert.equal(ix.search('記憶', { limit: 1 }).length, 1);
  assert.deepEqual(ix.search(''), []);
  assert.deepEqual(ix.search('、。'), []);
  assert.deepEqual(new SearchIndex().search('記憶'), []);
});

test('search：同分時依 id 排序，結果穩定', () => {
  const ix = new SearchIndex();
  ix.add('b', { body: 'same' });
  ix.add('a', { body: 'same' });
  assert.deepEqual(ix.search('same').map((h) => h.id), ['a', 'b']);
});

test('效能：1,000 筆約 2KB 的文件', () => {
  // 固定種子的亂數，避免測試結果飄動
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const zh = '專案記憶管理同步衝突電腦公司家裡設定檔案路徑資料夾索引正規化健康檢查收件匣全域單機綁定';
  const en = ['litellm', 'redis', 'docker', 'cooldown', 'junction', 'vault', 'sync', 'merge', 'memory', 'claude', 'gateway', 'token'];
  const make = () => {
    let s = '';
    while (s.length < 2000) {
      if (rand() < 0.5) {
        const start = Math.floor(rand() * (zh.length - 6));
        s += zh.slice(start, start + 2 + Math.floor(rand() * 5)) + '，';
      } else {
        s += en[Math.floor(rand() * en.length)] + Math.floor(rand() * 100) + ' ';
      }
    }
    return s;
  };
  const docs = Array.from({ length: 1000 }, (_, i) => ({ name: `memory-${i}`, description: make().slice(0, 120), body: make() }));
  const ix = new SearchIndex();
  const t0 = performance.now();
  docs.forEach((d, i) => ix.add(`m${i}`, d));
  const indexMs = performance.now() - t0;
  assert.ok(indexMs < 4500, `建立索引花了 ${indexMs.toFixed(0)}ms`);

  for (const q of ['記憶', '同步衝突', 'litellm', 'red', '收件匣 docker', '憶']) {
    const t1 = performance.now();
    const hits = ix.search(q);
    const ms = performance.now() - t1;
    assert.ok(hits.length > 0, `查詢「${q}」沒有結果`);
    assert.ok(ms < 150, `查詢「${q}」花了 ${ms.toFixed(1)}ms`);
  }
});
