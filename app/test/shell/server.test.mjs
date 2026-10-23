// 常駐程式 HTTP 安全規則：Host 白名單、token、跨站寫入、Content-Type、錯誤格式、安全標頭、靜態檔與 SSE。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createEventHub } from '../../src/agent/events.mjs';
import { createAgentServer } from '../../src/agent/server.mjs';
import { mkTmp, request, rmTmp, useHomes } from './helpers.mjs';

const TOKEN = 'test-token-0123456789abcdefghijklmn';
let root;
let uiDir;
let server;
let port;
let events;
const seen = [];

// 最小的 API：記下呼叫，依路徑丟出各種引擎錯誤
const api = {
  async handle(method, pathname, query, body) {
    seen.push({ method, pathname, body });
    if (pathname === '/api/fail/not-found') throw Object.assign(new Error('找不到記憶'), { code: 'E_NOT_FOUND', hint: '確認 ref' });
    if (pathname === '/api/fail/locked') throw Object.assign(new Error('鎖被占用'), { code: 'E_LOCKED' });
    if (pathname === '/api/fail/invalid') throw Object.assign(new Error('參數錯誤'), { code: 'E_INVALID' });
    if (pathname === '/api/fail/boom') throw new Error('意外錯誤');
    return { ok: true, method, body: body ?? null };
  },
};

async function start(dir, hub = createEventHub({ keepAliveMs: 50 })) {
  const s = createAgentServer({ token: TOKEN, api, events: hub, uiDir: dir });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return s;
}

before(async () => {
  root = mkTmp();
  useHomes(root);
  uiDir = path.join(root, 'dist');
  fs.mkdirSync(path.join(uiDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><head><meta name="engram-token" content=""><title>Engram</title></head><body></body>');
  fs.writeFileSync(path.join(uiDir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  events = createEventHub({ keepAliveMs: 50 });
  server = await start(uiDir, events);
  port = server.address().port;
});
after(() => {
  events.close();
  server.close();
  rmTmp(root);
});

const auth = { 'X-Engram-Token': TOKEN };
const json = { ...auth, 'Content-Type': 'application/json' };

describe('Host 白名單', () => {
  test('錯的 Host → 403', async () => {
    for (const host of ['evil.example:80', `127.0.0.1:${port + 1}`, `attacker.localhost:${port}`, '127.0.0.1']) {
      const r = await request(port, { path: '/api/status', headers: { ...auth, Host: host } });
      assert.equal(r.status, 403, host);
      assert.equal(r.json.error.code, 'E_FORBIDDEN');
      assert.equal(r.json.error.en.message, 'This Host is not accepted');
    }
  });

  test('靜態頁面也檢查 Host（防 DNS rebinding）', async () => {
    assert.equal((await request(port, { path: '/', headers: { Host: `evil.example:${port}` } })).status, 403);
  });

  test('127.0.0.1:<port> 與 localhost:<port> 都接受', async () => {
    assert.equal((await request(port, { path: '/api/status', headers: auth })).status, 200);
    assert.equal((await request(port, { path: '/api/status', headers: { ...auth, Host: `localhost:${port}` } })).status, 200);
  });
});

describe('token', () => {
  test('缺 token → 401', async () => {
    const r = await request(port, { path: '/api/status' });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'E_UNAUTHORIZED');
    assert.ok(r.json.error.hint);
    // 管理介面切到英文時顯示 en（HttpError.withEn）
    assert.equal(r.json.error.en.message, 'The access token is missing or invalid');
    assert.ok(r.json.error.en.hint);
  });

  test('錯的 token（含長度不同）→ 401', async () => {
    for (const t of ['x', `${TOKEN.slice(0, -1)}X`, `${TOKEN}extra`, '']) {
      assert.equal((await request(port, { path: '/api/status', headers: { 'X-Engram-Token': t } })).status, 401, t);
    }
  });

  test('SSE 以 ?t= 驗證', async () => {
    assert.equal((await request(port, { path: '/api/events' })).status, 401);
    assert.equal((await request(port, { path: '/api/events?t=wrong' })).status, 401);
  });
});

describe('寫入請求', () => {
  test('跨站 POST 被拒（Sec-Fetch-Site: cross-site）', async () => {
    const r = await request(port, { method: 'POST', path: '/api/sync', headers: { ...json, 'Sec-Fetch-Site': 'cross-site' }, body: {} });
    assert.equal(r.status, 403);
  });

  test('不同來源的 Origin 被拒；同源或沒有 Origin 可以', async () => {
    for (const origin of ['http://evil.example', `http://127.0.0.1:${port + 1}`, 'null', `https://127.0.0.1:${port}`]) {
      assert.equal((await request(port, { method: 'POST', path: '/api/sync', headers: { ...json, Origin: origin }, body: {} })).status, 403, origin);
    }
    assert.equal((await request(port, { method: 'POST', path: '/api/sync', headers: { ...json, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }, body: {} })).status, 200);
    assert.equal((await request(port, { method: 'POST', path: '/api/sync', headers: { ...json, Origin: `http://localhost:${port}` }, body: {} })).status, 200);
    assert.equal((await request(port, { method: 'POST', path: '/api/sync', headers: json, body: {} })).status, 200);
  });

  test('非 JSON → 415', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
      const headers = { ...auth, ...(type ? { 'Content-Type': type } : {}) };
      const r = await request(port, { method: 'POST', path: '/api/sync', headers, body: 'a=1' });
      assert.equal(r.status, 415, String(type));
      assert.equal(r.json.error.code, 'E_MEDIA_TYPE');
    }
    assert.equal((await request(port, { method: 'PUT', path: '/api/core', headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' }, body: { text: 'x' } })).status, 200);
  });

  test('本文不是 JSON → 400；空本文可以', async () => {
    assert.equal((await request(port, { method: 'POST', path: '/api/sync', headers: json, body: '{oops' })).status, 400);
    const r = await request(port, { method: 'POST', path: '/api/sync', headers: json });
    assert.equal(r.status, 200);
    assert.equal(r.json.body, null);
  });

  test('本文超過 1 MB → 413', async () => {
    const r = await request(port, { method: 'POST', path: '/api/sync', headers: json, body: JSON.stringify({ x: 'a'.repeat(1024 * 1024 + 10) }) }).catch((e) => ({ status: 413, err: e }));
    assert.equal(r.status, 413);
  });

  test('不支援的方法 → 405', async () => {
    assert.equal((await request(port, { method: 'DELETE', path: '/api/memory', headers: json })).status, 405);
  });
});

describe('錯誤格式與狀態碼', () => {
  test('E_NOT_FOUND→404、E_LOCKED→409、E_INVALID→400、其他→500，本文 { error: { code, message, hint, en? } }', async () => {
    const cases = [['/api/fail/not-found', 404, 'E_NOT_FOUND'], ['/api/fail/locked', 409, 'E_LOCKED'], ['/api/fail/invalid', 400, 'E_INVALID'], ['/api/fail/boom', 500, 'E_INTERNAL']];
    for (const [p, status, code] of cases) {
      const r = await request(port, { path: p, headers: auth });
      assert.equal(r.status, status, p);
      assert.deepEqual(Object.keys(r.json.error).filter((k) => k !== 'en').sort(), ['code', 'hint', 'message']);
      if (r.json.error.en) assert.deepEqual(Object.keys(r.json.error.en).filter((k) => !['message', 'hint'].includes(k)), [], '英文版只有 message、hint');
      assert.equal(r.json.error.code, code);
    }
  });
});

describe('安全標頭與靜態檔', () => {
  const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

  test('API 回應帶安全標頭', async () => {
    const r = await request(port, { path: '/api/status', headers: auth });
    assert.equal(r.headers['content-security-policy'], CSP);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.match(r.headers['content-type'], /^application\/json/);
  });

  test('index.html 送出時注入 token，且不快取', async () => {
    const r = await request(port, { path: '/' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(`<meta name="engram-token" content="${TOKEN}">`));
    assert.equal(r.headers['content-security-policy'], CSP);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('前端路由（沒有副檔名）一律回 index.html', async () => {
    const r = await request(port, { path: '/inbox' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(TOKEN));
  });

  test('靜態檔帶正確的 MIME；不存在 → 404；不能穿越到 dist 外', async () => {
    const js = await request(port, { path: '/assets/app.js' });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^text\/javascript/);
    assert.equal(js.headers['x-content-type-options'], 'nosniff');
    assert.equal((await request(port, { path: '/assets/none.js' })).status, 404);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt']) {
      const r = await request(port, { path: p });
      assert.notEqual(r.text, 'secret', p);
      assert.ok([400, 404].includes(r.status) || (r.status === 200 && r.text.includes(TOKEN)), `${p} → ${r.status}`);
    }
  });

  test('dist 不存在時回傳中文說明頁', async () => {
    const s = await start(path.join(root, 'no-dist'));
    const p = s.address().port;
    const r = await request(p, { path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.text, /找不到管理介面的檔案/);
    // 中文在前、英文在後
    assert.match(r.text, /dashboard files \(app\/src\/ui\/dist\/\) were not found/);
    assert.ok(r.text.indexOf('找不到管理介面的檔案') < r.text.indexOf('were not found'));
    assert.match(r.headers['content-type'], /^text\/html/);
    s.close();
  });
});

describe('SSE', () => {
  test('推送事件與 25 秒保活註解（測試縮短為 50ms）', async () => {
    const chunks = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/api/events?t=${TOKEN}`, headers: { Host: `127.0.0.1:${port}` } });
    const res = await new Promise((r) => req.on('response', r));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/event-stream/);
    res.on('data', (c) => chunks.push(c.toString()));
    await new Promise((r) => setTimeout(r, 30));
    events.emit('sync', { state: 'start', reason: 'manual' });
    await new Promise((r) => setTimeout(r, 120));
    req.destroy();
    const text = chunks.join('');
    assert.match(text, /event: sync\ndata: \{"state":"start","reason":"manual"\}\n\n/);
    assert.match(text, /: keep-alive\n\n/);
    assert.throws(() => events.emit('unknown', {}));
  });
});

describe('R-44／R-46：防止嵌入與跨站讀取', () => {
  test('所有回應都禁止被其他網站以 iframe 嵌入', async () => {
    for (const p of ['/', '/assets/app.js', '/api/status']) {
      const r = await request(port, { path: p, headers: auth });
      assert.equal(r.headers['x-frame-options'], 'DENY', p);
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/, p);
    }
  });

  test('跨站而來的頁面與 API 讀取一律 403', async () => {
    assert.equal((await request(port, { path: '/', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
    assert.equal((await request(port, { path: '/api/status', headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await request(port, { path: '/', headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  });

  test('GET 與 SSE 也檢查 Origin', async () => {
    assert.equal((await request(port, { path: '/api/status', headers: { ...auth, Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await request(port, { path: `/api/events?t=${TOKEN}`, headers: { Origin: 'null' } })).status, 403);
  });

  test('拒絕 NTFS 資料流名稱的路徑', async () => {
    assert.equal((await request(port, { path: '/assets/app.js::$DATA' })).status, 404);
  });
});
