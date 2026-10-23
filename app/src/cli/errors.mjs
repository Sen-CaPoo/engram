// 外殼的錯誤型別與錯誤訊息格式。引擎丟的 EngramError 也有 code／hint，兩者用同一套方式顯示。

export class CliError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
  }
}

// 引擎沒有附建議時，依錯誤碼補一句「接下來怎麼做」
const DEFAULT_HINTS = {
  E_LOCKED: '另一個 Engram 程序正在寫入，稍後再試一次。',
  E_NOT_BOUND: '先在專案資料夾執行 engram bind。',
  E_OFFLINE: '檢查網路連線；連上後常駐程式會自動再同步。',
  E_AUTH: '執行 gh auth login 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 git -C "$HOME/.engram/vault" fetch，依提示在瀏覽器登入。',
  E_PROXY: '確認 git 的 http.proxy 設定是否正確。',
  E_PUSH_PROTECTED: '有檔案被 GitHub 推送保護擋下，執行 engram ui 查看是哪個檔案。',
  E_NOT_FOUND: '確認名稱或路徑是否正確。',
  E_INVALID: '檢查輸入的參數。',
  E_USAGE: '執行 engram help 查看用法。',
  E_ENGINE_MISSING: '確認 app/src/core/ 完整，或重新安裝 Engram。',
  E_AGENT_DOWN: '執行 engram agent 在前景啟動常駐程式，查看錯誤訊息。',
  E_NOT_IMPLEMENTED: '這個功能還沒完成。',
  E_SECRET: '記憶裡只記金鑰存放在哪裡、怎麼取得；確定不是金鑰時，執行 engram not-secret 記入「不是金鑰」清單後再試一次。',
};

/** 任何錯誤 → { code, message, hint } */
export function toErrorInfo(err) {
  const code = err?.code && String(err.code).startsWith('E_') ? err.code : 'E_INTERNAL';
  const message = err?.message || String(err);
  const hint = err?.hint || DEFAULT_HINTS[code] || '執行 engram doctor 檢查環境；詳細記錄在 ~/.engram/local/logs/。';
  return { code, message, hint };
}
