// 管理介面的 HTTP 伺服器（ADR §08）：只綁 127.0.0.1；Host 白名單；寫入請求檢查 Origin 與 Sec-Fetch-Site；
// 只收 application/json；每次啟動產生隨機 token，/api/* 驗證 X-Engram-Token，SSE 驗證 ?t=。
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { toErrorInfo } from '../cli/errors.mjs';
import { APP_DIR } from '../cli/paths.mjs';

export const DEFAULT_UI_DIR = path.join(APP_DIR, 'src', 'ui', 'dist');
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 64; // 本機單一使用者，足夠管理介面與 hooks 同時使用（R-46）

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

// EngramError 的 code → HTTP 狀態碼；沒列出的一律 500
const STATUS_BY_CODE = { E_INVALID: 400, E_USAGE: 400, E_NOT_FOUND: 404, E_NOT_BOUND: 404, E_LOCKED: 409, E_CONFLICT: 409, E_NOT_IMPLEMENTED: 501 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const MISSING_UI_PAGE = `<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<title>Engram 憶跡</title>
<body style="font-family:'Microsoft JhengHei UI','Segoe UI',system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.8;color:#1f2937">
<h1 style="color:#0072CE;margin-bottom:.5rem">Engram 憶跡</h1>
<p>常駐程式正在執行，但找不到管理介面的檔案（app/src/ui/dist/）。</p>
<p>管理介面需要先建置；建置完成後重新整理這一頁即可。在這之前，命令列仍可正常使用，例如 <code>engram status</code>、<code>engram search</code>。</p>
</body>
</html>
`;

export class HttpError extends Error {
  constructor(status, code, message, hint = '') {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function sendError(res, err) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const info = toErrorInfo(err);
  sendJson(res, err?.status ?? STATUS_BY_CODE[info.code] ?? 500, { error: info });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'E_TOO_LARGE', '請求本文超過 1 MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'E_INVALID', '請求本文不是有效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{ token: string, api: { handle(method, pathname, query, body): Promise<any> }, events: object, uiDir?: string, log?: object }} opts
 */
export function createAgentServer({ token, api, events, uiDir = DEFAULT_UI_DIR, log }) {
  const tokenBuf = Buffer.from(token);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!err?.status && !String(err?.code ?? '').startsWith('E_')) log?.error('http', err);
      sendError(res, err);
    });
  });

  server.maxConnections = MAX_CONNECTIONS;

  const allowedHosts = () => {
    const port = server.address()?.port;
    return [`127.0.0.1:${port}`, `localhost:${port}`];
  };

  function tokenMatches(value) {
    if (typeof value !== 'string') return false;
    const buf = Buffer.from(value);
    return buf.length === tokenBuf.length && timingSafeEqual(buf, tokenBuf);
  }

  async function handle(req, res) {
    const hosts = allowedHosts();
    if (!hosts.includes(req.headers.host)) {
      throw new HttpError(403, 'E_FORBIDDEN', '不接受這個 Host', '請用 http://127.0.0.1:4777/ 開啟管理介面。');
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    // 跨站而來的請求一律拒絕：包含被其他網站嵌入或導向的頁面（R-44、R-46）
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'E_FORBIDDEN', '拒絕跨站請求');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    checkOrigin(req, hosts);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (!tokenMatches(url.searchParams.get('t'))) throw unauthorized();
      return events.subscribe(req, res, SECURITY_HEADERS);
    }
    if (!tokenMatches(req.headers['x-engram-token'])) throw unauthorized();
    if (req.method !== 'GET') checkWriteRequest(req, hosts);
    const body = req.method === 'GET' ? undefined : await readJsonBody(req);
    const result = await api.handle(req.method, url.pathname, url.searchParams, body);
    sendJson(res, 200, result ?? null);
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'E_METHOD', `不支援 ${req.method}`);
    const root = path.resolve(uiDir);
    const indexFile = path.join(root, 'index.html');
    if (!fs.existsSync(indexFile)) return send(res, 200, MISSING_UI_PAGE, { 'Content-Type': MIME['.html'] });

    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'E_INVALID', '網址格式不正確');
    }
    if (rel.includes(':')) throw new HttpError(404, 'E_NOT_FOUND', '找不到檔案');
    // 沒有副檔名的路徑都交給前端路由（單頁應用）
    const file = path.extname(rel) ? path.resolve(root, `.${rel}`) : indexFile;
    if (file !== indexFile && !file.startsWith(root + path.sep)) throw new HttpError(404, 'E_NOT_FOUND', '找不到檔案');
    if (file === indexFile) {
      const html = (await fsp.readFile(indexFile, 'utf8')).replace(
        /(<meta\s+name=["']engram-token["']\s+content=)["'][^"']*["']/i,
        `$1"${token}"`,
      );
      return send(res, 200, req.method === 'HEAD' ? undefined : html, { 'Content-Type': MIME['.html'] });
    }
    const data = await fsp.readFile(file).catch(() => null);
    if (!data) throw new HttpError(404, 'E_NOT_FOUND', '找不到檔案');
    send(res, 200, req.method === 'HEAD' ? undefined : data, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  }

  return server;
}

function unauthorized() {
  return new HttpError(401, 'E_UNAUTHORIZED', '缺少或錯誤的存取權杖', '重新整理管理介面；常駐程式每次啟動都會換新的權杖。');
}

/** 所有 /api 請求：只允許同源（或沒有 Origin，例如 hooks 與 CLI）。 */
function checkOrigin(req, hosts) {
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
    throw new HttpError(403, 'E_FORBIDDEN', '拒絕跨來源的請求');
  }
}

/** 寫入請求：另外限定方法與 Content-Type（只收 JSON）。 */
function checkWriteRequest(req, hosts) {
  if (req.method !== 'POST' && req.method !== 'PUT') throw new HttpError(405, 'E_METHOD', `不支援 ${req.method}`);
  checkOrigin(req, hosts);
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'E_MEDIA_TYPE', '只接受 Content-Type: application/json');
}
