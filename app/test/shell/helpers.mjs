// 外殼測試共用工具：暫存資料夾、擷取輸出、模擬 stdin、HTTP 請求。
// 所有測試都把 ENGRAM_HOME／CLAUDE_HOME 指向暫存資料夾，不碰真正的 ~/.engram 與 ~/.claude。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { localPaths } from '../../src/cli/paths.mjs';

export function mkTmp(prefix = 'engram-shell-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows 偶爾鎖檔
  }
}

/** 把 ENGRAM_HOME／CLAUDE_HOME 指向 root 底下，回傳 localPaths() */
export function useHomes(root) {
  process.env.ENGRAM_HOME = path.join(root, '.engram');
  process.env.CLAUDE_HOME = path.join(root, '.claude');
  delete process.env.ENGRAM_HEADLESS;
  delete process.env.ENGRAM_CONFLICTS_DIR;
  return localPaths();
}

export function capture() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  });
  return { stream, get text() { return text; } };
}

export const stdinFrom = (text) => Readable.from([Buffer.from(text, 'utf8')]);

/** 原生 http 請求（可自訂 Host、Origin 等標頭） */
export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // 非 JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
