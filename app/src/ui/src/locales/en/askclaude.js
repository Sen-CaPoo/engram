// 英文對照：交給 Claude（askclaude.jsx）。鍵是中文原文，見 ../README.md。
export default {
  '複製': 'Copy',
  '{label}：{text}': '{label}: {text}',
  '已複製': 'Copied',
  '無法確認 Claude Code 外掛的狀態（{message}）。如果 Claude Code 說找不到指令，請執行 {cmd}。': 'Cannot determine the status of the Claude Code plugin ({message}). If Claude Code says it cannot find a command, run {cmd}.',
  'Engram 外掛已啟用': 'Engram plugin enabled',
  '已經開著的 Claude Code 對話要先執行 {cmd}（或開一個新對話）才看得到新指令。': 'Conversations that are already open need to run {cmd} (or you can start a new conversation) before the new commands show up.',
  'Claude Code 的 Engram 外掛被停用了': 'The Engram plugin is disabled in Claude Code',
  '這台電腦的 Claude Code 還沒有安裝 Engram 外掛': 'Claude Code on this computer does not have the Engram plugin installed yet',
  '在終端機依序執行下面的指令，然後開一個新的 Claude Code 對話：': 'Run the following commands in a terminal, in order, then start a new Claude Code conversation:',
  '交給你自己的 Claude Code 處理：Claude 讀過內容、列出計畫後，直接處理有把握的項目；每一步都可以用 engram undo 復原。': 'Hand this to your own Claude Code: Claude reads the content, lists a plan, and then handles the items it is confident about directly. Every step can be undone with engram undo.',
  '交給你自己的 Claude Code 處理：Claude 會先讀內容、提出計畫，你同意後才會改；每一步都可以用 engram undo 復原。': 'Hand this to your own Claude Code: Claude reads the content and proposes a plan first, and only makes changes after you approve. Every step can be undone with engram undo.',
  '關閉': 'Close',
  '複製指令': 'Copy command',
  '處理方式': 'Approach',
  '開啟 Claude Code（在任何資料夾都可以；整理某個專案時，在那個專案的資料夾開啟最好）。': 'Open Claude Code (any folder works; when tidying a specific project, it is best to open it in that project\'s folder).',
  '貼上上面的指令並送出。': 'Paste the command above and send it.',
  'Claude 會列出計畫表並處理有把握的項目，最後回報結果與復原指令；留給你決定的項目會另外列出。': 'Claude lists a plan table and handles the items it is confident about, then reports the results and the undo command. Items left for you to decide are listed separately.',
  '看 Claude 提出的計畫表，回覆要執行哪些項目；你沒有同意的不會動。': 'Review the plan table Claude proposes and reply with which items to carry out. Anything you do not approve is left alone.',
  '其他可以在 Claude Code 使用的 Engram 指令': 'Other Engram commands you can use in Claude Code',
  '交給 Claude': 'Ask Claude',
  '在 Claude Code 執行 {cmd}': 'Run {cmd} in Claude Code',
};

// 外掛技能的英文說明（鍵是技能名稱）：技能的中文說明來自 app/plugin/skills/*/SKILL.md，英文模式改用這張表；沒有列在這裡的技能用伺服器附的文字
export const SKILLS = {
  inbox: { description: 'Triage the Engram inbox with AI', argumentHint: '[card id | code, e.g. H09 | auto]' },
  tidy: { description: 'Deep-tidy Engram memories with AI', argumentHint: '[project pid | global | machine | core | memory ref]' },
  save: { description: 'Save what is worth remembering from this conversation into Engram', argumentHint: '[what to remember; omit to review the whole conversation]' },
  recall: { description: 'Find relevant experience, decisions, and pitfalls across all Engram scopes and summarize them with sources', argumentHint: '<topic or question>' },
  engram: { description: 'Use Engram to manage memories synced across computers', argumentHint: '' },
};
