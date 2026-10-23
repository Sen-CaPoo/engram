// 英文對照：專案（views/projects.jsx）。鍵是中文原文，見 ../README.md。
const plural = (n, one, many) => (Number(n) === 1 ? one : many);

export default {
  // ── 篩選與等待接上的資料夾
  '篩選': 'Filter',
  '使用中': 'Active',
  '需要注意': 'Needs attention',
  '已封存': 'Archived',
  '專案用固定 ID 識別，資料夾搬家或改名都不影響記憶。': 'Projects are identified by a fixed ID, so moving or renaming a folder does not affect memories.',
  '等待接上的資料夾': 'Folders waiting to connect',
  'folders::{n} 個': ({ n }) => plural(n, '1 folder', '{n} folders'),
  '重新產生匯入計畫': 'Regenerate import plan',
  '已接上，下一次對話生效': 'Connected. Takes effect in your next conversation',
  '接上': 'Connect',
  '已認出是「{name}」，依你的設定等待確認。': 'Recognized as "{name}". Waiting for your confirmation, as set in your settings.',
  '匯入計畫產生後，這個資料夾又有新的或改過的記憶。請重新產生計畫並檢查，套用後才會接上。': 'This folder has new or changed memories since the import plan was generated. Regenerate the plan and review it; the folder is connected only after you apply it.',
  '對話結束後會自動接上；也可以現在接上。': 'It connects automatically when the conversation ends. You can also connect it now.',

  // ── 專案表格
  '展開': 'Expand',
  '收合「{name}」': 'Collapse "{name}"',
  '展開「{name}」': 'Expand "{name}"',
  '這台（{label}）的位置': 'Location on this computer ({label})',
  '其他電腦': 'Other computers',
  'col::記憶': 'Memories',
  'MEMORY.md 載入預算': 'MEMORY.md load budget',
  '最近活動': 'Last activity',
  '這裡沒有專案': 'No projects here',
  '所有專案都正常。': 'All projects look healthy.',
  '在任何資料夾開啟 Claude Code 並留下記憶，就會自動建立專案。': 'Open Claude Code in any folder and leave a memory there, and a project is created automatically.',
  '{n} 項發現': ({ n }) => plural(n, '1 finding', '{n} findings'),
  '原資料夾已不存在': 'The original folder no longer exists',
  '這台還沒開過': 'Not opened on this computer yet',
  ' 行': ' lines',

  // ── 綁定方式
  'Claude Code 預設的記憶資料夾以 junction 指向記憶庫；專案根目錄另有 settings.local.json，從子資料夾啟動也會用到 Engram 記憶': 'Claude Code\'s default memory folder points to the vault through a junction; the project root also has a settings.local.json, so Engram memories are used when you start from a subfolder too',
  '設定檔': 'Settings file',
  '以專案根目錄的 settings.local.json 指定記憶資料夾。這台電腦的權限模式不是 auto，所以不建立 junction；從子資料夾啟動 Claude Code 時不會用到 Engram 記憶': 'A settings.local.json in the project root sets the memory folder. This computer\'s permission mode is not auto, so no junction is created; Engram memories are not used when you start Claude Code from a subfolder',
  '設定檔（撞名）': 'Settings file (collision)',
  '以專案根目錄的 settings.local.json 指定記憶資料夾：這個資料夾的路徑編碼與其他資料夾相同（中文名稱撞名），所以不能用 junction': 'A settings.local.json in the project root sets the memory folder. This folder\'s encoded path is the same as another folder\'s (names with Chinese characters collide), so a junction cannot be used',
  '資料夾存在': 'Folder exists',
  '資料夾不見了': 'Folder missing',

  // ── 專案展開內容
  '查看 {n} 筆記憶': ({ n }) => plural(n, 'View 1 memory', 'View {n} memories'),
  '改名': 'Rename',
  '併入另一個專案': 'Merge into another project',
  '請 Claude 整理': 'Ask Claude to tidy up',
  '最後開啟 {when}': 'Last opened {when}',
  '編碼 {code}': 'encoded as {code}',
  '尚未在這台開過': 'Never opened on this computer',
  '不是 git 專案，以 .claude/engram.json 標記檔識別': 'Not a git project; identified by the .claude/engram.json marker file',
  '別名': 'Aliases',
  '索引': 'Index',
  'MEMORY.md 共 {lines} 行、{size}。Claude Code 每次只載入前 200 行或 25 KB。': ({ lines }) => `MEMORY.md is ${Number(lines) === 1 ? '1 line' : '{lines} lines'} ({size}). Claude Code loads only the first 200 lines or 25 KB each time.`,

  // ── 對話框
  '已改名': 'Renamed',
  '專案改名': 'Rename project',
  '只改顯示名稱。專案 ID、資料夾和綁定都不受影響。': 'Changes the display name only. The project ID, folder, and binding are not affected.',
  '已併入': 'Merged',
  '把「{name}」併入另一個專案': 'Merge "{name}" into another project',
  '適合同一個專案在兩台電腦被認成兩個的情況。記憶會搬到目標專案，原專案保留為別名，可以從歷史復原。': 'Use this when one project was recognized as two on different computers. Memories move to the target project, the original project is kept as an alias, and you can undo this from the history.',
  '併入': 'Merge',
  '目標專案': 'Target project',
  '{name}（{n} 筆）': ({ n }) => plural(n, '{name} (1 memory)', '{name} ({n} memories)'),
};
