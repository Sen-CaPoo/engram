// 這次操作在哪裡執行（2.0.0 第三輪審查 A）：CLI 用同一個判斷決定「這次確認的來源」，以及拒絕只能由使用者本人做的事
// （not-secret、guardrails approve、env approve）。

/**
 * 在 Claude Code 裡執行：CLAUDECODE 或 CLAUDE_CODE_ENTRYPOINT 存在（空字串也算）。
 * 這道防線擋的是照著技能或說明做事的 Claude「好心代勞」，不是刻意繞過的本機程式：同一個使用者的本機程式本來就能直接寫
 * 記憶庫的檔案、讀到管理介面的權杖再呼叫本機 API，這裡不防，也不另外檢查終端機（Git Bash 預設的 mintty 視窗裡 Node 也偵測不到
 * 終端機，會把使用者本人一起擋掉）。威脅模型與這道防線的範圍見 repo 根目錄的 SECURITY.md（第四輪審查 F-07）。
 */
export function inClaudeCode(ctx) {
  const env = ctx?.deps?.env ?? process.env;
  return Object.hasOwn(env, 'CLAUDECODE') || Object.hasOwn(env, 'CLAUDE_CODE_ENTRYPOINT');
}

/**
 * 這次確認的來源：在 Claude Code 裡是 claude（Claude 在對話裡做的，使用者同意過，但不算本人看過內容：不進待你確認，
 * 也不會成為自動駕駛必須遵守的偏好），否則是 user（使用者在自己的終端機執行）。
 * 所有會把內容記為已確認的 CLI 路徑都用它：remember／memory write --reviewed、holding adopt、tidy apply、inbox resolve、
 * import apply、inbox apply（第四輪審查 F-02）。
 */
export function confirmSource(ctx) {
  return inClaudeCode(ctx) ? 'claude' : 'user';
}

/** 在 Claude Code 裡寫入時附在輸出的說明（和技能的說明文字一致） */
export const CLAUDE_NOTE = '在對話裡存的內容不會自動成為自動駕駛必須遵守的規則：要讓自動駕駛遵守，請到管理介面「自動駕駛」頁的偏好區塊確認。';
