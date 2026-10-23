// 英文對照：總覽（views/overview.jsx）。鍵是中文原文，見 ../README.md。
const plural = (n, one, many) => (Number(n) === 1 ? one : many);

export default {
  // ── 同步狀態（syncVerdict）
  'Claude Code 更新後有行為改變，自動化已暫停': 'Claude Code changed behavior after an update, so automation is paused',
  '還沒有完成第一次同步': 'The first sync has not finished yet',
  '記憶都在這台的 vault 裡；設定 GitHub 遠端並完成第一次同步後，其他電腦才看得到。': 'All your memories are in this computer\'s vault. Other computers will see them once you set a GitHub remote and finish the first sync.',
  '需要重新登入 GitHub 才能同步': 'Sign in to GitHub again to sync',
  '執行 gh auth login 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 git -C "$HOME/.engram/vault" fetch，依提示在瀏覽器登入。': 'Run gh auth login to sign in to GitHub again. If git does not use GitHub CLI for credentials, run git -C "$HOME/.engram/vault" fetch in PowerShell or Git Bash instead and sign in through the browser when prompted.',
  '目前連不到 GitHub': 'Cannot reach GitHub right now',
  '記憶先存在這台，恢復連線後會自動補同步。上次成功是 {when}。': 'Your memories are kept on this computer and sync automatically once the connection is back. Last success: {when}.',
  '同步失敗：{reason}': 'Sync failed: {reason}',
  '原因不明': 'unknown reason',
  '有 {n} 個檔案疑似含有金鑰，只留在這台、沒有推送。': ({ n }) => plural(n, '1 file contains a possible secret. It stays on this computer and was not pushed.', '{n} files contain possible secrets. They stay on this computer and were not pushed.'),
  '「{label}」已經 {since}沒有同步，那台的記憶可能不是最新的。': '"{label}" has not synced for {since}. Its memories may be out of date.',
  '有 {n} 個變更等待推送，常駐程式會在幾分鐘內處理。': ({ n }) => plural(n, '1 change is waiting to be pushed. The agent will handle it within a few minutes.', '{n} changes are waiting to be pushed. The agent will handle them within a few minutes.'),
  '有 {n} 件事需要你處理': ({ n }) => plural(n, '1 item needs your attention', '{n} items need your attention'),
  '有檔案沒有同步': 'Some files were not synced',
  '有電腦很久沒有同步': 'A computer has not synced for a long time',
  '正在同步…': 'Syncing…',
  '所有電腦的記憶都是最新的': 'Memories on all your computers are up to date',
  '這台電腦的記憶已同步到 GitHub': 'This computer\'s memories are synced to GitHub',

  // ── 頁首與橫幅
  '相容性探測失敗': 'Compatibility probe failed',
  '查看探測結果': 'View probe results',
  'Engram 依賴的 Claude Code 行為有 {n} 項不符合預期。同步照常進行，但綁定、正規化與收編先暫停，避免改壞檔案。': ({ n }) => plural(n, '1 Claude Code behavior that Engram relies on is not as expected. Sync continues as normal, but binding, normalizing, and adopting are paused to avoid damaging files.', '{n} Claude Code behaviors that Engram relies on are not as expected. Sync continues as normal, but binding, normalizing, and adopting are paused to avoid damaging files.'),
  '上次同步 {when} · 這台是「{label}」 · vault 共 {n} 筆記憶': ({ n }) => plural(n, 'Last synced {when} · This computer is "{label}" · 1 memory in the vault', 'Last synced {when} · This computer is "{label}" · {n} memories in the vault'),
  '開啟收件匣': 'Open inbox',
  '設定同步': 'Set up sync',

  // ── 需要你處理
  '需要你處理': 'Needs your attention',
  '{n} 項': ({ n }) => plural(n, '1 item', '{n} items'),
  '目前沒有': 'None right now',
  '同步衝突：{name}': 'Sync conflict: {name}',
  '已{label}': '{label}: done',
  '沒有待處理的事': 'Nothing needs attention',
  '新的衝突或健康檢查發現會出現在這裡。': 'New conflicts and health check findings will show up here.',

  // ── 最近的記憶、活動
  '最近記住的事': 'Recent memories',
  '近 30 天的記憶活動': 'Memory activity, last 30 days',
  '依 vault 的變更紀錄統計': 'Counted from the vault change history',
  '修改 {n} 次': ({ n }) => plural(n, '1 edit', '{n} edits'),
  '今天': 'Today',
  '近 30 天新增 {added} 筆、修改 {changed} 次': ({ changed }) => `Last 30 days: {added} added, ${Number(changed) === 1 ? '1 edit' : '{changed} edits'}`,
  '{label}：新增 {added}、修改 {changed}': ({ changed }) => `{label}: {added} added, ${Number(changed) === 1 ? '1 edit' : '{changed} edits'}`,

  // ── 裝置與同步軌跡
  '裝置與同步軌跡': 'Devices & sync trail',
  '過去 24 小時': 'Last 24 hours',
  '最後同步 {when}': 'Last synced {when}',
  '上線 {when}': 'Last online {when}',
  '過去 24 小時有 {n} 次變更或同步': ({ n }) => plural(n, '1 change or sync in the last 24 hours', '{n} changes or syncs in the last 24 hours'),
  '現在': 'Now',
  '本機變更': 'Local change',

  // ── 記憶分布
  '記憶分布': 'Memory distribution',
  '每個專案都看得到': 'Visible in every project',
  '分屬 {n} 個專案': ({ n }) => plural(n, 'Across 1 project', 'Across {n} projects'),
  '只在所屬的電腦載入': 'Loaded only on its own computer',
  '{label} {n} 筆': ({ n }) => plural(n, '{label}: 1 memory', '{label}: {n} memories'),

  // ── 最近一次對話載入了什麼
  '最近一次對話載入了什麼': 'What the last conversation loaded',
  '使用者準則': 'User guidelines',
  '專案準則': 'Project guidelines',
  '本機準則': 'Local guidelines',
  'kind::規則': 'Rule',
  '記憶索引': 'Memory index',
  '還沒有紀錄': 'No record yet',
  '下一次開啟 Claude Code 後，這裡會列出那次對話實際載入的準則與記憶檔。': 'After you next open Claude Code, this lists the rules and memory files that conversation actually loaded.',
  '{n} 行 · {size}': ({ n }) => plural(n, '1 line · {size}', '{n} lines · {size}'),
  '由 {name} 匯入': 'Imported from {name}',
  '開工時共載入 {lines} 行、約 {size}（估計 {tokens} tokens）。': ({ lines }) => `Loaded ${Number(lines) === 1 ? '1 line' : '{lines} lines'} at startup, about {size} (an estimated {tokens} tokens).`,
  '專案 MEMORY.md（超過 200 行的部分不會載入）': 'Project MEMORY.md (lines past 200 are not loaded)',
  ' 行': ' lines',
  // 時間軸刻度空間有限，用縮寫
  'tick::{n} 小時前': '{n}h ago',
};
