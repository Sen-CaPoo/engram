// 情境召回（plugin/hooks/lens/recall.mjs）的純函式：斷詞、查詢詞、計分（門檻、同專案加權、已載入的不帶、不重複、最多 3 筆）、
// 建索引（大小上限、決定性）與讀索引的驗證。mod 的行為在 plugin/test/recall.test.ts（npm run test:lens）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BODY_CHARS,
  MAX_HITS,
  MIN_SCORE,
  MIN_TERMS,
  PROJECT_BOOST,
  RELATIVE_FLOOR,
  buildIndex,
  contextText,
  parseIndex,
  projectOf,
  queryTerms,
  recallMode,
  recalledIn,
  score,
  tokenize,
  usageLine,
} from '../../plugin/hooks/lens/recall.mjs';
import { tokenize as searchTokenize } from '../../src/core/search.mjs';
import { CORPUS, QUERIES } from './recall-fixture.mjs';

const { index } = buildIndex(CORPUS, { mid: 'm-test', roots: [{ path: 'C:\\Work\\bakery', pid: 'p-bakery' }, { path: 'C:/Work/library', pid: 'p-library' }] });

describe('斷詞', () => {
  test('core/search.mjs 轉匯出同一個函式（搜尋與召回的詞一致）', () => {
    assert.equal(searchTokenize, tokenize);
  });

  test('中英混合：英文小寫、camelCase 切開並保留整段、中文雙字組；mod 的測試用同一個字串比對（plugin/test/recall.test.ts）', () => {
    assert.deepEqual(tokenize('QuillMate 閘道的 cooldown 設定'), ['quill', 'mate', 'quillmate', '閘道', '道的', 'cooldown', '設定']);
  });
});

describe('查詢詞', () => {
  test('去掉重複、單一字元、含虛詞字的中文詞與口語', () => {
    assert.deepEqual(queryTerms('幫我看看 C 區的 Larkspur、Larkspur'), ['larkspur']);
    assert.deepEqual(queryTerms('用 bash 寫一個迴圈'), ['bash', '寫一', '個迴', '迴圈']);
    assert.deepEqual(queryTerms('ok please continue with the next step'), []);
  });

  test('訊息只取前 2,000 字', () => {
    assert.ok(!queryTerms(`${'測試'.repeat(1000)} 獨角獸`).includes('獨角'));
  });
});

describe('計分', () => {
  for (const c of QUERIES) {
    test(`校準：${c.q.split('\n')[0].slice(0, 30)}${c.none ? '（不帶）' : ''}`, () => {
      const hits = score(index, c.q, { pid: c.pid ?? null });
      if (c.none) assert.deepEqual(hits, [], `不該帶出：${hits.map((h) => `${h.ref}=${h.score}`).join(', ')}`);
      else assert.ok(hits.some((h) => h.ref === c.want), `應該帶出 ${c.want}，實際：${hits.map((h) => `${h.ref}=${h.score}`).join(', ') || '（無）'}`);
      for (const h of hits) assert.ok(h.score >= MIN_SCORE);
    });
  }

  test('已列在這次對話載入的索引裡的不帶；別的專案的記憶不帶；目前專案沒列在索引的照樣帶', () => {
    const docs = [
      { ref: 'global/a.md', path: '~/a.md', name: 'gamma-relay', desc: '中繼站 gamma relay 的重啟步驟', loaded: '*', body: '中繼站重啟' },
      { ref: 'projects/p1/memory/b.md', path: '~/b.md', name: 'delta-queue', desc: '佇列 delta queue 的重送設定', pid: 'p1', loaded: 'p1', body: '佇列重送' },
      { ref: 'projects/p1/memory/c.md', path: '~/c.md', name: 'sigma-cache', desc: '快取 sigma cache 的清除順序', pid: 'p1', loaded: null, body: '快取清除' },
    ];
    const ix = buildIndex(docs).index;
    assert.deepEqual(score(ix, 'gamma relay 中繼站怎麼重啟'), []);
    assert.deepEqual(score(ix, 'delta queue 佇列重送', { pid: 'p1' }), []);
    // 不同專案可能屬於不同的客戶或工作：p1 的記憶不會出現在 p2 的對話，也不會出現在沒有綁定專案的對話
    assert.deepEqual(score(ix, 'delta queue 佇列重送', { pid: 'p2' }), []);
    assert.deepEqual(score(ix, 'sigma cache 快取清除', { pid: 'p2' }), []);
    assert.deepEqual(score(ix, 'sigma cache 快取清除'), []);
    assert.deepEqual(score(ix, 'sigma cache 快取清除', { pid: 'p1' }).map((h) => h.ref), ['projects/p1/memory/c.md']);
  });

  /** 不相關的填充記憶：讓測試的詞夠罕見（記憶太少時每個詞都很常見，分數到不了門檻） */
  const fillers = (n) => Array.from({ length: n }, (_, i) => ({ ref: `global/f${String(i).padStart(2, '0')}.md`, path: `~/f${i}.md`, name: `f${i}`, desc: `別的事 ${i}`, loaded: null, body: `內容 ${i}` }));

  test('同專案加權：和全域記憶一樣相關時，目前專案的排前面，而且分數乘上加權', () => {
    const same = { name: 'deploy-window', desc: '部署時段：週三晚上十點', loaded: null, body: '部署時段固定。' };
    const docs = [
      { ref: 'global/deploy.md', path: '~/g.md', ...same },
      { ref: 'projects/p2/memory/deploy.md', path: '~/p2.md', pid: 'p2', ...same },
    ];
    const ix = buildIndex([...docs, ...fillers(10)]).index;
    const hits = score(ix, '部署時段是週三晚上嗎', { pid: 'p2' });
    assert.deepEqual(hits.map((h) => h.ref), ['projects/p2/memory/deploy.md', 'global/deploy.md']);
    assert.ok(Math.abs(hits[0].score / hits[1].score - PROJECT_BOOST) < 0.01);
  });

  test('同一場對話帶過的不重複', () => {
    const q = '烤箱溫度計好像不準，多久要校正一次？';
    assert.equal(score(index, q)[0].ref, 'global/oven-thermometer.md');
    assert.deepEqual(score(index, q, { exclude: new Set(['global/oven-thermometer.md']) }), []);
  });

  test(`門檻：只命中 ${MIN_TERMS - 1} 個詞、或分數低於 ${MIN_SCORE} 的不帶`, () => {
    assert.deepEqual(score(index, 'larkspur'), []);
    const docs = Array.from({ length: 12 }, (_, i) => ({ ref: `global/n${i}.md`, path: `~/n${i}.md`, name: `n${i}`, desc: `第 ${i} 筆`, loaded: null, body: i === 0 ? '紅茶 拿鐵' : `內容 ${i}` }));
    assert.deepEqual(score(buildIndex(docs).index, '紅茶拿鐵').map((h) => h.ref), [], '兩個詞都只在內文出現一次，還不夠');
  });

  test(`最多 ${MAX_HITS} 筆，而且低於最高分 ${RELATIVE_FLOOR} 倍的不帶`, () => {
    const docs = Array.from({ length: 4 }, (_, i) => ({ ref: `global/t${i}.md`, path: `~/t${i}.md`, name: `kappa-tunnel-${i}`, desc: 'kappa tunnel 的設定與重啟', loaded: null, body: 'kappa tunnel 設定' }));
    docs.push({ ref: 'global/weak.md', path: '~/weak.md', name: 'weak', desc: '只有內文提到 kappa 與 tunnel', loaded: null, body: `${'無關的內容。'.repeat(40)} kappa tunnel` });
    const ix = buildIndex([...docs, ...fillers(30)]).index;
    const hits = score(ix, 'kappa tunnel 的設定怎麼重啟');
    assert.equal(hits.length, MAX_HITS);
    assert.deepEqual(hits.map((h) => h.ref), ['global/t0.md', 'global/t1.md', 'global/t2.md'], '同分依 ref 排序');
    const all = score(ix, 'kappa tunnel 的設定怎麼重啟', { limit: 10 });
    assert.equal(all.length, 4, '只命中內文、分數低於最高分一半的那筆不帶');
    assert.ok(!all.some((h) => h.ref === 'global/weak.md'));
  });

  test('沒有索引、空的訊息、斷不出詞時不帶', () => {
    assert.deepEqual(score(null, '任何'), []);
    assert.deepEqual(score(index, ''), []);
    assert.deepEqual(score(index, '！？。，'), []);
  });

  test('索引裡的詞剛好是 Object 原型上的名稱（constructor、toString）也不會出錯', () => {
    const ix = buildIndex([{ ref: 'global/c.md', path: '~/c.md', name: 'constructor', desc: 'constructor toString', loaded: null, body: '' }]).index;
    assert.doesNotThrow(() => score(ix, 'constructor toString hasOwnProperty valueOf'));
    assert.doesNotThrow(() => score(index, 'constructor toString hasOwnProperty valueOf'));
  });
});

describe('建索引', () => {
  test('倒排表、文件長度與綁定的資料夾；同樣的輸入得到一字不差的檔案', () => {
    const a = buildIndex(CORPUS, { mid: 'm-test', builtAt: '2026-11-21T00:00:00.000Z' });
    const b = buildIndex([...CORPUS].reverse(), { mid: 'm-test', builtAt: '2026-11-21T00:00:00.000Z' });
    assert.equal(a.text, b.text);
    assert.equal(a.index.n, CORPUS.length);
    assert.ok(a.index.avgdl > 0);
    assert.ok(Array.isArray(a.index.terms.larkspur));
    assert.equal(a.cap, null);
  });

  test(`內文只取前 ${BODY_CHARS} 字`, () => {
    const ix = buildIndex([{ ref: 'global/long.md', path: '~/l.md', name: 'long', desc: '', loaded: null, body: `${'甲乙'.repeat(BODY_CHARS / 2)}丙丁戊己` }]).index;
    assert.ok(ix.terms['甲乙']);
    assert.equal(ix.terms['丙丁'], undefined);
  });

  test('超過大小上限時，每筆只留最有鑑別力的詞，直到放得下', () => {
    const docs = Array.from({ length: 30 }, (_, i) => ({ ref: `global/b${i}.md`, path: `~/b${i}.md`, name: `b${i}`, desc: '', loaded: null, body: Array.from({ length: 400 }, (_, k) => `w${i}x${k}`).join(' ') }));
    const full = buildIndex(docs);
    const small = buildIndex(docs, { maxBytes: Math.floor(full.bytes / 3) });
    assert.ok(small.bytes <= Math.floor(full.bytes / 3), `${small.bytes}`);
    assert.ok(small.cap > 0 && small.cap < 400);
    assert.equal(small.index.n, 30, '每筆記憶都還在');
  });

  test('roots 正規化成小寫、正斜線；projectOf 取最長的前綴', () => {
    assert.deepEqual(index.roots, [{ path: 'c:/work/bakery', pid: 'p-bakery' }, { path: 'c:/work/library', pid: 'p-library' }]);
    assert.equal(projectOf(index, 'C:\\Work\\bakery\\src'), 'p-bakery');
    assert.equal(projectOf(index, '/c/Work/library'), 'p-library');
    assert.equal(projectOf(index, 'C:/Work/bakery-old'), null);
    const nested = buildIndex([], { roots: [{ path: 'C:/a', pid: 'outer' }, { path: 'C:/a/b', pid: 'inner' }] }).index;
    assert.equal(projectOf(nested, 'C:/a/b/c'), 'inner');
  });

  test('parseIndex：版本不符、壞掉的 JSON、欄位不對都當作沒有索引', () => {
    assert.equal(parseIndex('{oops'), null);
    assert.equal(parseIndex(JSON.stringify({ v: 99, docs: [], terms: {}, n: 0 })), null);
    assert.equal(parseIndex(JSON.stringify({ v: 1, docs: [{}], terms: {}, n: 2, avgdl: 1 })), null);
    assert.equal(parseIndex(JSON.stringify({ v: 1, docs: [], terms: [], n: 0 })), null);
    assert.equal(parseIndex(buildIndex(CORPUS).text).n, CORPUS.length);
    assert.equal(parseIndex(buildIndex([]).text).n, 0);
  });
});

describe('輸出與紀錄', () => {
  test('附加的文字：每筆一行（名稱、說明、路徑），沒有命中時沒有文字', () => {
    const text = contextText([{ ref: 'global/a.md', path: '~/.engram/vault/global/a.md', name: 'a', desc: '說明', score: 5 }]);
    assert.match(text, /^\[Engram 情境召回\]/);
    assert.match(text, /\n- \[a\]\(~\/\.engram\/vault\/global\/a\.md\) — 說明$/);
    assert.equal(contextText([]), null);
  });

  test('帶出紀錄：一行一筆；recalledIn 只取這場對話的', () => {
    const text = [usageLine({ at: 't', session: 's1', ref: 'global/a.md', score: 4 }), usageLine({ at: 't', session: 's2', ref: 'global/b.md', score: 4 }), 'not json\n'].join('');
    assert.deepEqual([...recalledIn(text, 's1')], ['global/a.md']);
    assert.deepEqual([...recalledIn(text, '')], []);
  });

  test('設定 recall：只有明確寫 off 才關閉；所有電腦共用的索引分層是 on 時強制開啟', () => {
    assert.equal(recallMode(JSON.stringify({ recall: 'off' }), JSON.stringify({ v: 1, indexLayers: 'on' })), 'on');
    assert.equal(recallMode(JSON.stringify({ recall: 'off' }), JSON.stringify({ v: 1, indexLayers: 'observe' })), 'off');
    assert.equal(recallMode(JSON.stringify({ recall: 'off' }), '{oops'), 'off');
    assert.equal(recallMode(JSON.stringify({ recall: 'off' })), 'off');
    assert.equal(recallMode(JSON.stringify({ recall: 'on' })), 'on');
    assert.equal(recallMode('{oops'), 'on');
    assert.equal(recallMode(null), 'on');
  });
});
