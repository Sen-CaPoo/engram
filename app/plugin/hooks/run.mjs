// Engram 外掛的 hook 進入點（薄 shim）：依安裝清單找到 Engram 程式，交給 app/src/hooks 處理。
// 用法：node "${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs" <event>
// 任何錯誤都 exit 0，絕不擋住 Claude Code；但載入失敗會寫進日誌並累計，SessionStart 時提醒（R-43）。
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const home = process.env.ENGRAM_HOME || path.join(os.homedir(), '.engram');
const local = path.join(home, 'local');

// V8 編譯快取：每次 hook 都是新的 node 程序，快取能省下約兩成的啟動時間（E16）
try { module.enableCompileCache?.(path.join(local, 'cache', 'v8')); } catch { /* 舊版 Node 沒有這個功能 */ }

async function readStdin(timeoutMs = 3000) {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.once('end', () => {
      clearTimeout(timer);
      resolve();
    });
    process.stdin.once('error', resolve);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse((text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) || '{}');
  } catch {
    return {};
  }
}

/** 載入 Engram 失敗時：寫日誌、累計次數；SessionStart 輸出一行提醒，讓使用者知道 Engram 停擺了 */
function bootstrapFailed(event, err) {
  let count = 1;
  try {
    fs.mkdirSync(path.join(local, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(local, 'logs', 'hooks-bootstrap.log'), `${JSON.stringify({ at: new Date().toISOString(), event, error: String(err?.stack ?? err) })}\n`);
    const f = path.join(local, 'hooks-bootstrap-failures.json');
    count = (JSON.parse(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '{"count":0}').count ?? 0) + 1;
    fs.writeFileSync(f, JSON.stringify({ count, at: new Date().toISOString(), message: String(err?.message ?? err) }));
  } catch { /* 連日誌都寫不了時，至少還有下面的提醒 */ }
  if (event === 'session-start' || event === 'SessionStart') {
    const msg = `⚠ Engram 沒有啟動（已連續 ${count} 次）：${String(err?.message ?? err).slice(0, 160)}。記憶仍照常讀寫，但不會同步。請在終端機執行 engram doctor，或用 engram update --rollback 切回上一版。`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } }));
  }
}

const event = process.argv[2];
let installed = null;
try {
  installed = JSON.parse(fs.readFileSync(path.join(local, 'install.json'), 'utf8'));
} catch {
  // 沒有安裝 Engram：什麼都不做
}
if (installed?.appDir) {
  try {
    const entry = path.join(installed.appDir, 'src', 'hooks', 'index.mjs');
    if (!fs.existsSync(entry)) throw new Error(`找不到 Engram 程式：${entry}`);
    const hooks = await import(pathToFileURL(entry).href);
    await hooks.main(event, await readStdin());
    fs.rmSync(path.join(local, 'hooks-bootstrap-failures.json'), { force: true });
  } catch (err) {
    bootstrapFailed(event, err);
  }
}
process.exit(0);
