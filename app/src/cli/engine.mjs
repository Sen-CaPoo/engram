// 引擎載入器：外殼（CLI、hooks、常駐程式）一律透過這裡取得引擎（40 號 §15）。
import path from 'node:path';
import { CliError } from './errors.mjs';

/**
 * 載入 app/src/core/index.mjs 並呼叫 open()。
 * 引擎不存在或匯入失敗時丟出 E_ENGINE_MISSING；open() 本身的 EngramError 原樣往外丟。
 */
export async function loadEngine(opts = {}) {
  let mod;
  try {
    mod = await import('../core/index.mjs');
  } catch (err) {
    throw engineMissing(err);
  }
  if (typeof mod.open !== 'function') throw engineMissing();
  const eg = await mod.open({ home: process.env.ENGRAM_HOME, claudeHome: process.env.CLAUDE_HOME, ...opts });
  // git 經由 engram merge-driver 隔離衝突時，放在 vault/conflicts（會同步，40 號 v0.4）。
  // 引擎呼叫的 git 繼承本程序的環境變數，所以在這裡設定一次即可。
  if (eg?.paths?.vault && !process.env.ENGRAM_CONFLICTS_DIR) {
    process.env.ENGRAM_CONFLICTS_DIR = path.join(eg.paths.vault, 'conflicts');
  }
  return eg;
}

function engineMissing(cause) {
  return new CliError(
    'E_ENGINE_MISSING',
    `無法載入 Engram 引擎${cause ? `：${cause.message}` : ''}`,
    '確認 app/src/core/ 完整，或重新安裝 Engram。',
  );
}
