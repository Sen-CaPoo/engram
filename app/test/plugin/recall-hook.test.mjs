// 情境召回的指令型後備（plugin/hooks/recall-hook.mjs，經由 run.mjs prompt-submit）：輸出格式、有標記檔就不輸出、
// 斜線指令與背景對話不處理、同一場對話不重複、不讀安裝清單也不載入引擎。全部在暫存資料夾，不碰真正的 ~/.engram。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../../plugin/hooks/lens/recall.mjs';
import { promptSubmit } from '../../plugin/hooks/recall-hook.mjs';
import { mkTmp, rmTmp } from '../core/helpers.mjs';
import { CORPUS } from './recall-fixture.mjs';

const RUN = fileURLToPath(new URL('../../plugin/hooks/run.mjs', import.meta.url));
const NOW = Date.parse('2026-11-21T03:00:00.000Z');
const ASK = '烤箱溫度計好像不準，多久要校正一次？';

let root;
let home;
let local;
const usage = (day = '2026-11-21') => path.join(local, 'usage', 'recall', `${day}.jsonl`);
const put = (rel, text) => {
  const p = path.join(local, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const run = (input, o = {}) => promptSubmit({ session_id: 's1', cwd: 'C:/work/other', ...input }, { home, now: NOW, env: {}, ...o });

before(() => {
  root = mkTmp('engram-recall-hook-');
  home = path.join(root, '.engram');
  local = path.join(home, 'local');
});
after(() => rmTmp(root));
beforeEach(() => {
  fs.rmSync(local, { recursive: true, force: true });
  put('cache/recall.json', buildIndex(CORPUS, { mid: 'm-test', roots: [{ path: 'C:/work/bakery', pid: 'p-bakery' }] }).text);
});

describe('輸出', () => {
  test('hookSpecificOutput.additionalContext：和 mod 同一份計分與文字', () => {
    const out = JSON.parse(run({ prompt: ASK }));
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /^\[Engram 情境召回\]/);
    assert.match(out.hookSpecificOutput.additionalContext, /\[oven-thermometer\]\(~\/\.engram\/vault\/global\/oven-thermometer\.md\)/);
  });

  test('帶出紀錄寫進今天（UTC）的檔，同一場對話不重複；昨天帶過的也算', () => {
    assert.ok(run({ prompt: ASK }));
    const rows = fs.readFileSync(usage(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.session, r.ref]), [['s1', 'global/oven-thermometer.md']]);
    assert.equal(run({ prompt: ASK }), null);
    assert.ok(run({ prompt: ASK, session_id: 's2' }), '別場對話照樣帶');

    put('usage/recall/2026-11-20.jsonl', `${JSON.stringify({ at: 'x', session: 's3', ref: 'global/oven-thermometer.md', score: 5 })}\n`);
    assert.equal(run({ prompt: ASK, session_id: 's3' }), null);
  });

  test('mod 寫的紀錄（<日期>.<程序代號>.jsonl）也算：mod 曾經帶過的，後備不再帶', () => {
    put('usage/recall/2026-11-21.a1b2c3d4.jsonl', `${JSON.stringify({ at: 'x', session: 's5', ref: 'global/oven-thermometer.md', score: 5 })}\n`);
    assert.equal(run({ prompt: ASK, session_id: 's5' }), null);
    assert.ok(run({ prompt: ASK, session_id: 's6' }), '別場對話照樣帶');
  });

  test('目前專案（cwd 對到綁定的資料夾）已載入的記憶不帶；別的專案的對話也不帶這個專案的記憶', () => {
    const ask = '隔天取貨的訂單幾點截止？晚上八點之後排到哪一天';
    assert.equal(run({ prompt: ask, cwd: 'C:\\work\\bakery\\src' }), null);
    assert.equal(run({ prompt: ask, cwd: 'C:/work/other' }), null);
  });
});

describe('不輸出', () => {
  test('這場對話有 mod 的標記檔（mod 已經帶過了）', () => {
    put('cache/session/s1.mod', 'guard\n');
    assert.equal(run({ prompt: ASK }), null);
    assert.ok(!fs.existsSync(usage()));
  });

  test('斜線指令、空白訊息、不是使用者送出的（source）', () => {
    assert.equal(run({ prompt: '/review 烤箱溫度計校正一次' }), null);
    assert.equal(run({ prompt: '/engram:save 烤箱溫度計校正' }), null);
    assert.equal(run({ prompt: '   ' }), null);
    assert.equal(run({ prompt: ASK, source: 'system' }), null);
    assert.equal(run({ prompt: ASK, source: 'loop_wakeup' }), null);
    assert.ok(run({ prompt: ASK, source: 'sdk' }), 'claude -p 也處理');
  });

  test('路徑開頭的訊息不是斜線指令', () => {
    assert.ok(run({ prompt: '/c/Users/demo 底下的烤箱溫度計多久要校正一次' }));
  });

  test('設定 recall 是 off、ENGRAM_HEADLESS=1、沒有索引或索引壞掉', () => {
    put('settings.json', JSON.stringify({ recall: 'off' }));
    assert.equal(run({ prompt: ASK }), null);
    // 所有電腦共用的索引分層是 on：這台的 recall: off 被強制開啟
    const shared = path.join(home, 'vault', 'settings.json');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, JSON.stringify({ v: 1, indexLayers: 'on' }));
    assert.ok(run({ prompt: ASK, session_id: 'forced' }));
    fs.rmSync(shared);
    fs.rmSync(path.join(local, 'settings.json'));
    assert.equal(run({ prompt: ASK }, { env: { ENGRAM_HEADLESS: '1' } }), null);
    put('cache/recall.json', '{oops');
    assert.equal(run({ prompt: ASK }), null);
    fs.rmSync(path.join(local, 'cache', 'recall.json'));
    assert.equal(run({ prompt: ASK }), null);
  });
});

describe('run.mjs prompt-submit', () => {
  function runHook(input, env = {}) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const e = { ...process.env, ENGRAM_HOME: home, ...env };
      if (!('ENGRAM_HEADLESS' in env)) delete e.ENGRAM_HEADLESS;
      const child = spawn(process.execPath, [RUN, 'prompt-submit'], { env: e, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out, ms: performance.now() - t0 }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's9', cwd: root, prompt: ASK, ...input }));
    });
  }

  test('不讀安裝清單、不載入引擎：安裝清單指向不存在的程式也照常輸出，不記成 Engram 載入失敗', async (t) => {
    put('install.json', JSON.stringify({ appDir: path.join(root, 'missing-app') }));
    const r = await runHook({});
    assert.equal(r.code, 0);
    assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /oven-thermometer/);
    assert.ok(!fs.existsSync(path.join(local, 'hooks-bootstrap-failures.json')));
    t.diagnostic(`run.mjs prompt-submit：${r.ms.toFixed(0)} ms`);
  });

  test('有標記檔就不輸出；ENGRAM_HEADLESS=1 不輸出；壞掉的 stdin 安靜結束', async () => {
    put('cache/session/s9.mod', 'guard\n');
    assert.equal((await runHook({})).out, '');
    fs.rmSync(path.join(local, 'cache', 'session'), { recursive: true });
    assert.equal((await runHook({}, { ENGRAM_HEADLESS: '1' })).out, '');
    const bad = await new Promise((resolve) => {
      const child = spawn(process.execPath, [RUN, 'prompt-submit'], { env: { ...process.env, ENGRAM_HOME: home }, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
      child.stdin.end('{not json');
    });
    assert.deepEqual(bad, { code: 0, out: '' });
  });
});
