// 英文對照：裝置與同步（views/devices.jsx）。鍵是中文原文，見 ../README.md。
const plural = (n, one, many) => (Number(n) === 1 ? one : many);

export default {
  // ── 同步錯誤
  'GitHub 登入已過期': 'GitHub sign-in expired',
  '登入後重試': 'Retry after signing in',
  '執行 {login} 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 {fetch}，依提示在瀏覽器登入。完成後按「登入後重試」。這段時間記憶照常存在這台。': 'Run {login} to sign in to GitHub again. If git does not use GitHub CLI for credentials, run {fetch} in PowerShell or Git Bash instead and sign in through the browser when prompted. When you are done, press "Retry after signing in". Your memories stay safe on this computer in the meantime.',
  '目前連不到 GitHub': 'Cannot reach GitHub right now',
  '立即重試': 'Retry now',
  '記憶照常寫入這台的 vault，恢復連線後會自動補同步。{hint}': 'Memories keep being written to this computer\'s vault and sync automatically once you are back online. {hint}',
  '看起來是公司網路的代理設定，請確認 git 的 http.proxy。': 'This looks like a proxy setting on your company network. Check git\'s http.proxy.',
  'GitHub 拒絕推送：偵測到疑似金鑰': 'GitHub rejected the push: possible secret detected',
  '到收件匣處理': 'Resolve in inbox',
  '檔案 {ref} 被擋下。在收件匣的「疑似含有金鑰」卡片遮蔽後，其他檔案會照常推送。': 'The file {ref} was blocked. After you redact it in the inbox card that says it "may contain a secret or password", your other files will push as usual.',
  '在收件匣的「疑似含有金鑰」卡片遮蔽後，其他檔案會照常推送。': 'After you redact it in the inbox card that says it "may contain a secret or password", your other files will push as usual.',
  '同步失敗：{message}': 'Sync failed: {message}',
  '原因不明': 'unknown reason',
  '看日誌': 'View logs',
  '可以到「排程與紀錄」查看日誌，或在終端機執行 engram doctor 檢查。': 'You can check the logs under "Schedule & logs", or run engram doctor in a terminal.',

  // ── 裝置
  '有 {n} 個檔案沒有推送': ({ n }) => plural(n, '1 file was not pushed', '{n} files were not pushed'),
  '{files} 疑似含有金鑰，只留在這台。': 'Possible secret in {files}. Kept on this computer only.',
  '最後同步 {when}': 'Last synced {when}',
  '電腦 ID': 'Computer ID',
  'Engram 版本': 'Engram version',
  '同步狀態': 'Sync status',
  '上次成功': 'Last success',
  '等待推送': 'Waiting to push',
  '{n} 個變更': ({ n }) => plural(n, '1 change', '{n} changes'),
  '其他電腦的新變更': 'New changes from other computers',
  'changes::{n} 個': ({ n }) => plural(n, '1 change', '{n} changes'),
  '最後同步': 'Last synced',
  '最後上線': 'Last online',
  '寫入範圍': 'Writes to',
  '只寫自己的 {dir} 與記憶檔，不會互相覆蓋': 'Writes only to its own {dir} and its memory files, so computers never overwrite each other',
  '同步設定': 'Sync settings',

  // ── 同步遠端
  '同步遠端': 'Sync remote',
  'GitHub 私人 repo': 'Private GitHub repo',
  '遠端': 'Remote',
  '分支': 'Branch',
  '目前版本': 'Current version',
  '規則': 'Rules',
  '只用 main 分支，不 rebase、不 force push，歷史只增不改。疑似含金鑰的檔案不會推送。': 'Uses the main branch only, with no rebase and no force push, so history only grows and is never rewritten. Files that may contain secrets are not pushed.',

  // ── 變更紀錄
  '變更紀錄': 'Change history',
  '每個變更都可以追溯；大部分可以單獨復原': 'Every change is traceable, and most can be undone individually',
  '依電腦篩選': 'Filter by computer',
  '全部': 'All',
  '沒有紀錄': 'No records',
  '時間': 'Time',
  '電腦': 'Computer',
  '{names} 等 {n} 個檔案': '{names} and others ({n} files)',
  '到匯入頁還原': 'Restore on the Import page',
  '復原這個變更？': 'Undo this change?',
  '「{title}」（{device} · {when}）會被撤銷，並產生一筆新的紀錄同步到其他電腦；之後仍可再復原。': 'This reverts "{title}" ({device} · {when}) and creates a new record that syncs to your other computers. You can undo it again later.',
  '已復原這個變更': 'Change undone',
};
