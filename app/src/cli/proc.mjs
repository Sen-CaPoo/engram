// 子程序工具。所有子程序一律 windowsHide；背景程序帶上不跳認證視窗的 git 環境變數（R-10）。
import { spawn } from 'node:child_process';

/** 背景執行時避免 git 或 Git Credential Manager 跳出互動視窗 */
export const BACKGROUND_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
});

/**
 * 執行外部指令並收集輸出；結束碼非 0 不視為例外（由呼叫端判斷）。
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function run(cmd, args = [], { cwd, env, input, timeoutMs = 30_000, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString(encoding),
        stderr: Buffer.concat(err).toString(encoding),
        timedOut,
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** 以脫離、隱藏、不接 stdio 的方式啟動 node 子程序，啟動後立即放手（F30）。 */
export function spawnDetachedNode(args, { env = process.env } = {}) {
  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...env, ...BACKGROUND_ENV },
  });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}
