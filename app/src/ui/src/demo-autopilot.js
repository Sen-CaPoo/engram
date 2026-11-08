// 展示版的自動駕駛：合成的執行紀錄與整理記錄（中文／英文各一套），不讀任何真實記憶。
// 形狀與 app/src/autopilot（run.mjs 的 Run 與 autopilotStatus）相同；demo.js 用它模擬 /api/autopilot*。

const fm = (name, description, type, body) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

/** 與 app/src/autopilot/run.mjs 的 summarize 相同 */
export function summarizeRun(run) {
  const done = run.actions.filter((a) => a.status === 'done' && a.kind !== 'dismiss');
  const by = (k) => done.filter((a) => a.task === k).length;
  const cost = run.calls.reduce((n, c) => n + (c.costUsd ?? 0), 0);
  return {
    changes: done.length,
    dismissed: run.actions.filter((a) => a.kind === 'dismiss').length,
    rejected: run.rejected.length,
    failed: run.actions.filter((a) => a.status === 'failed').length,
    byTask: { curate: by('curate'), dream: by('dream'), cards: by('cards'), conflicts: by('conflicts'), secrets: by('secrets'), review: by('review') },
    calls: run.calls.length,
    costUsd: Math.round(cost * 10000) / 10000,
  };
}

const call = (label, ms, input, output, costUsd, model = 'sonnet') => ({ label, model, ms, input, output, costUsd, ok: true });

/**
 * 建立展示資料：四輪有結果的執行（一輪有項目已復原）、一輪失敗、一輪被中斷，以及它們建立的整理記錄。
 * @returns {{ runs: object[], tidyRecords: object[], feedback: object[], live: () => object }}
 */
export function buildAutopilotSample({ en = false, pid = 'order-system-x1y2z', now = Date.now(), self }) {
  const L = (zh, enText) => (en ? enText : zh);
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const budget = (used) => { const remaining = Math.round((200 - used) * 10000) / 10000; return { monthly: 200, used, remaining, run: remaining }; };

  // ── 整理記錄（自動駕駛建立並已自動執行） ──
  const R1 = 'ap-20261107-031207-k4m2';
  const REC_A = '20261107-031840-ap01';
  const REC_B = '20261107-032530-ap02';
  const teamBefore = fm('team-lead-role', L('使用者是開發小組長', 'The user is a development team lead'), 'user', L('使用者是開發小組長，負責程式審查。\n\n偏好：\n- 回覆用條列\n- 程式碼附註解', 'The user is a development team lead and does code reviews.\n\nPreferences:\n- Answers as bullet points\n- Comment the code'));
  const teamAfter = fm('team-lead-role', L('使用者負責專案管理並主講內部 AI 分享', 'The user manages projects and presents the internal AI talks'), 'user', L('使用者負責專案管理，並主講公司內部的 AI 技術分享（2026-09 起）。\n\n偏好：\n- 回覆用條列\n- 程式碼附註解', 'The user manages projects and presents the company\'s internal AI talks (since 2026-09).\n\nPreferences:\n- Answers as bullet points\n- Comment the code'));
  const vpnBefore = fm('old-vpn-client', L('舊 VPN 用戶端的連線設定', 'Connection settings for the old VPN client'), 'reference', L('開啟舊 VPN 用戶端 → 匯入設定檔 → 輸入 OTP。', 'Open the old VPN client → import the profile → enter the OTP.'));
  const deployRef = `projects/${pid}/memory/deploy-notes.md`;
  const csvRef = `projects/${pid}/memory/report-csv-only.md`;
  const deployBefore = fm('deploy-notes', L('部署方式與主機', 'How to deploy and which hosts'), 'project', L('部署：npm run deploy（會先跑測試）。\n部署主機：app-01、app-02、app-03。', 'Deploy: npm run deploy (runs the tests first).\nHosts: app-01, app-02, app-03.'));
  const deployAfter = fm('deploy-notes', L('部署方式與主機', 'How to deploy and which hosts'), 'project', L('部署：npm run release（2026-11-02 起；之前是 npm run deploy）。會先跑測試與版本號檢查。\n部署主機：app-01、app-02、app-03。', 'Deploy: npm run release (since 2026-11-02; previously npm run deploy). Runs the tests and a version check first.\nHosts: app-01, app-02, app-03.'));
  const csvAfter = fm('report-csv-only', L('報表一律輸出 CSV（客戶決定）', 'Reports are always CSV (client decision)'), 'project', L('客戶在 2026-11-03 的會議決定：報表一律輸出 CSV，欄位名稱用英文代碼，不再提供 Excel。\n\n**Why:** 客戶的下游系統只吃 CSV。\n**How to apply:** 新的報表功能預設 CSV；遇到要做 Excel 的需求先確認。', 'At the 2026-11-03 meeting the client decided: reports are always CSV with English column codes; no more Excel.\n\n**Why:** The client\'s downstream system only reads CSV.\n**How to apply:** New report features default to CSV; confirm before building anything in Excel.'));

  const item = (id, x) => ({ id, group: null, description: '', base: 'demo', decision: 'accept', note: '', changed: [], ...x });
  const recA = {
    v: 1, id: REC_A, createdAt: ago(60 * 5 - 6), updatedAt: ago(60 * 5 - 7), appliedAt: ago(60 * 5 - 7), machine: self.id, scope: 'global', request: '', status: 'done',
    summary: L('2 筆全域記憶：1 筆職稱已過期、1 筆講的 VPN 工具已汰換；改寫 1 筆、封存 1 筆。', 'Two global memories: one title is out of date and one describes a retired VPN tool. Rewrote 1 and archived 1.'),
    highlights: [], kept: [], backup: 'C:\\Users\\Demo\\.engram\\local\\backups\\2026-11-07T03-18-41-300Z-tidy-ap01',
    kind: 'autopilot', autopilot: { run: R1, task: 'curate' },
    texts: { 'global/team-lead-role.md': teamBefore, 'global/old-vpn-client.md': vpnBefore },
    items: [
      item('i1', {
        ref: 'global/team-lead-role.md', name: 'team-lead-role', scope: 'global', type: 'user', action: 'update',
        title: L('補上目前負責的工作，刪掉過期的職稱', 'Add the current role and drop the outdated title'),
        reason: L('2026-09 之後已經不是小組長，現在主講內部 AI 分享；舊說法會讓 Claude 用錯誤的角色回答。', 'Since 2026-09 the user is no longer a team lead and now presents the internal AI talks. The old wording makes Claude answer from the wrong role.'),
        ops: [{ op: 'write', ref: 'global/team-lead-role.md', content: teamAfter }],
        result: { status: 'done', undo: ['d4c3b2a1'], at: ago(60 * 5 - 7) },
        autopilot: { risk: 'medium', category: 'update', cards: [], review: { verdict: 'approve', reason: L('新的說法有 2026-09 的對話為證，原本的偏好設定一項都沒有少。', 'The new wording is backed by the 2026-09 conversations, and none of the original preferences were lost.') } },
      }),
      item('i2', {
        ref: 'global/old-vpn-client.md', name: 'old-vpn-client', scope: 'global', type: 'reference', action: 'archive',
        title: L('封存：這個 VPN 工具已在 2026-08 汰換', 'Archive: this VPN tool was retired in 2026-08'),
        reason: L('內容是舊 VPN 用戶端的設定步驟；新電腦已經改用公司的零信任閘道，留著會讓 Claude 建議已經不能用的做法。', 'It describes setting up the old VPN client. The computers now use the company zero-trust gateway, so keeping it would make Claude suggest something that no longer works.'),
        ops: [{ op: 'remove', ref: 'global/old-vpn-client.md' }],
        result: { status: 'done', undo: ['9a8b7c6d'], at: ago(60 * 5 - 7) },
        autopilot: { risk: 'high', category: 'archive', cards: [], review: { verdict: 'approve', reason: L('使用者自己在對話裡說過這個工具已經停用，封存後仍可從歷史復原。', 'The user said in a conversation that this tool is no longer used, and an archived memory can still be restored from history.') } },
      }),
    ],
  };
  const recB = {
    v: 1, id: REC_B, createdAt: ago(60 * 5 - 14), updatedAt: ago(60 * 5 - 15), appliedAt: ago(60 * 5 - 15), machine: self.id, scope: `project:${pid}`, request: '', status: 'done',
    summary: L('回顧了這台電腦 4 個對話：1 筆部署指令已過時、1 件客戶決定還沒有人記下來。', 'Reviewed 4 conversations on this computer: one deploy command is out of date and one client decision was never recorded.'),
    highlights: [], kept: [], backup: 'C:\\Users\\Demo\\.engram\\local\\backups\\2026-11-07T03-25-31-500Z-tidy-ap02',
    kind: 'autopilot', autopilot: { run: R1, task: 'dream', dream: true },
    dream: { id: 'dr-20261107-032200-w5e1', sessions: 4, from: '2026-11-02T02:10:00.000Z', to: '2026-11-06T09:40:00.000Z', remaining: 0 },
    texts: { [deployRef]: deployBefore },
    items: [
      item('i1', {
        ref: deployRef, name: 'deploy-notes', scope: `project:${pid}`, type: 'project', action: 'update',
        title: L('部署指令已改成 npm run release', 'The deploy command is now npm run release'),
        reason: L('11/02 的對話把部署腳本改名，之後兩次部署都用 npm run release 成功；記憶還寫著 npm run deploy。保留一句舊說法的紀錄。', 'On 11/02 the deploy script was renamed, and both deployments after that used npm run release successfully. The memory still says npm run deploy. The old wording is kept in one sentence.'),
        evidence: [
          { session: '7c2e91ab', date: '2026-11-02', quote: L('把 package.json 的 deploy 改名成 release，順便加上版本號檢查', 'Rename deploy to release in package.json and add a version check'), contradicts: true },
          { session: 'a41f0d3c', date: '2026-11-05', quote: L('npm run release 跑完了，三台主機都更新成功', 'npm run release finished; all three hosts are updated') },
        ],
        ops: [{ op: 'write', ref: deployRef, content: deployAfter }],
        result: { status: 'done', undo: ['2f6e8d1c'], at: ago(60 * 5 - 15) },
        autopilot: { risk: 'medium', category: 'dream-update', cards: [], review: { verdict: 'approve', reason: L('兩段對話都直接支持這個改動，沒有遺失原本的主機清單。', 'Both conversations support the change directly, and the host list is intact.') } },
      }),
      item('i2', {
        ref: null, name: 'report-csv-only', scope: `project:${pid}`, type: 'project', action: 'create',
        title: L('新增：報表一律輸出 CSV（客戶 11/03 決定）', 'Add: reports are always CSV (client decision on 11/03)'),
        reason: L('11/03 的對話記錄了客戶會議的決定，之後的報表功能都要照這個做，但還沒有任何記憶寫下來。', 'The 11/03 conversation recorded the decision from the client meeting. Every report feature should follow it, but no memory has it yet.'),
        evidence: [{ session: 'c5a7e210', date: '2026-11-03', quote: L('客戶說報表不要 Excel 了，一律給 CSV，欄位用英文代碼', 'The client no longer wants Excel; always CSV, with English column codes') }],
        ops: [{ op: 'create', scope: `project:${pid}`, ref: csvRef, name: 'report-csv-only', type: 'project', content: csvAfter }],
        result: { status: 'done', undo: ['5b0a3e9f'], at: ago(60 * 5 - 15) },
        autopilot: { risk: 'medium', category: 'dream-create', cards: [], review: { verdict: 'approve', reason: L('這是客戶親口說的決定，記成事實不是推測。', 'This is a decision the client stated directly, so recording it as a fact is not a guess.') } },
      }),
    ],
  };

  // ── 執行紀錄 ──
  const wrap = (x) => ({ v: 1, machine: self.id, endedAt: null, skipped: [], notes: [], calls: [], records: [], rejected: [], ...x });
  const act = (x) => ({ status: 'done', undo: [], ...x });

  const run1 = wrap({
    id: R1, reason: 'schedule', startedAt: ago(60 * 5 + 6), endedAt: ago(60 * 5 - 18), status: 'done', budget: budget(4.31),
    records: [REC_A, REC_B],
    actions: [
      act({ task: 'secrets', kind: 'vault', card: 'f_H13_1', code: 'H13', refs: [`projects/${pid}/memory/vendor-api.md`], category: 'vault', undo: ['3a91c0e4'],
        title: L(`金鑰移到本機保管區：projects/${pid}/memory/vendor-api.md`, `Secret moved to the local vault: projects/${pid}/memory/vendor-api.md`),
        reason: L('存成 vendor-api-token；記憶改寫成只記存放位置（用 engram secret get <名稱> 取出）', 'Stored as vendor-api-token; the memory now records only where it is kept (retrieve it with engram secret get <name>)') }),
      act({ task: 'secrets', kind: 'not-secret', card: 'f_H13_2', code: 'H13', refs: [`projects/${pid}/memory/api-notes.md`], category: 'not-secret',
        title: L(`標記不是金鑰：projects/${pid}/memory/api-notes.md 第 14 行`, `Marked as not a secret: projects/${pid}/memory/api-notes.md line 14`),
        reason: L('那一行是文件裡公開的範例字串，不是真正的金鑰。', 'That line is a public sample string from the documentation, not a real secret.') }),
      act({ task: 'cards', kind: 'rename', code: 'H06', category: undefined,
        title: L('依命名規則改名 2 個撞名的資料夾', 'Renamed 2 colliding folders by the naming rule'),
        reason: 'Client A → Client A-k3fz、Client.A → Client.A-7qma' }),
      act({ task: 'cards', kind: 'card', card: 'f_H08_3', code: 'H08', refs: [`projects/${pid}/memory/server-paths.md`], category: 'card-H08', undo: ['b72e4d10'],
        title: L('改為單機記憶：專案記憶裡有本機路徑', 'Make it a machine memory: local path in a project memory'),
        reason: L('說明裡的磁碟路徑只在這台電腦成立，另一台的路徑不同；整筆搬到單機記憶最單純。', 'The disk path in the description only exists on this computer, and the other one differs. Moving the whole memory to machine scope is the simplest fix.') }),
      act({ task: 'cards', kind: 'card', card: 'f_H24_4', code: 'H24', category: 'card-H24', undo: ['c81d5a72'],
        title: L('加入核心準則的建議更新', 'Added the suggested core rules update'),
        reason: L('Engram 內建的記憶寫入協定更新', 'Update to the memory-writing protocol built into Engram') }),
      act({ task: 'cards', kind: 'dismiss', card: 'f_H10_5', code: 'H10',
        title: L('不處理：單檔過大', 'Not handling: file too large'),
        reason: L('這筆是使用者釘選的參考資料，內容本來就長，拆開反而不好找。', 'This is a pinned reference memory that is long by nature; splitting it would make it harder to find.') }),
      act({ task: 'cards', kind: 'dismiss', card: 'f_H03_6', code: 'H03',
        title: L('不處理：說明太短', 'Not handling: description too short'),
        reason: L('標題已經足以判斷用途，加長說明沒有幫助。', 'The title is enough to tell what it is for; a longer description would not help.') }),
      act({ task: 'conflicts', kind: 'conflict', card: 'f_H15_7', code: 'H15', refs: ['global/powershell-bom.md'], category: 'conflict-both', undo: ['c0d8e2f5'],
        title: L('處理衝突：global/powershell-bom.md（兩個版本都留下）', 'Resolved conflict: global/powershell-bom.md (kept both versions)'),
        reason: L('兩台電腦各補了不同的實測日期，內容不互相矛盾，兩邊的事實都保留。', 'Each computer added a different test date and the content does not contradict itself, so both sets of facts are kept.'),
        review: { verdict: 'approve', reason: L('兩個版本的事實都保留，沒有遺失資訊。', 'Both versions\' facts are kept and nothing is lost.') } }),
      act({ task: 'review', kind: 'confirm', refs: ['global/meeting-notes-format.md'], code: 'H23', category: 'confirm',
        title: L('代你確認：meeting-notes-format', 'Confirmed for you: meeting-notes-format'),
        reason: L('只是新增一個會議紀錄格式偏好，沒有指令性的內容，也沒有跟既有的準則衝突。', 'It only adds a meeting-notes format preference, contains no instructions, and does not conflict with existing rules.') }),
      act({ task: 'review', kind: 'revert', refs: ['global/temp-note.md'], code: 'H23', category: 'revert', undo: ['5e6f7a8b'],
        title: L('退回 Claude 寫入的內容：temp-note', 'Reverted what Claude wrote: temp-note'),
        reason: L('Claude 把只適用單一專案的設定寫進全域，其他專案也會被影響（程式偵測到：含路徑）。', 'Claude wrote a setting that only applies to one project into global memory, which would affect every other project (detected: contains a path).') }),
      act({ task: 'curate', scope: 'global', kind: 'tidy', record: REC_A, item: 'i1', action: 'update', category: 'update', risk: 'medium', refs: ['global/team-lead-role.md'], undo: ['d4c3b2a1'],
        title: recA.items[0].title, reason: recA.items[0].reason, review: recA.items[0].autopilot.review }),
      act({ task: 'curate', scope: 'global', kind: 'tidy', record: REC_A, item: 'i2', action: 'archive', category: 'archive', risk: 'high', refs: ['global/old-vpn-client.md'], undo: ['9a8b7c6d'],
        title: recA.items[1].title, reason: recA.items[1].reason, review: recA.items[1].autopilot.review }),
      act({ task: 'dream', pid, kind: 'tidy', record: REC_B, item: 'i1', action: 'update', category: 'dream-update', risk: 'medium', refs: [deployRef], undo: ['2f6e8d1c'],
        title: recB.items[0].title, reason: recB.items[0].reason, review: recB.items[0].autopilot.review }),
      act({ task: 'dream', pid, kind: 'tidy', record: REC_B, item: 'i2', action: 'create', category: 'dream-create', risk: 'medium', refs: [csvRef], undo: ['5b0a3e9f'],
        title: recB.items[1].title, reason: recB.items[1].reason, review: recB.items[1].autopilot.review }),
    ],
    rejected: [
      { task: 'curate', scope: 'global', action: 'move', category: 'move', risk: 'high', refs: ['global/user-profile-office.md'],
        title: L('把「使用者背景」整筆搬到訂單系統', 'Move the whole "user background" memory to the order system'),
        reason: L('其餘內容只跟訂單系統有關，放在全域其他專案也會套用。', 'The rest only concerns the order system; kept in global, every other project would assume it too.'),
        why: L('審核員沒有同意：搬走之後，其他專案會失去「公司與職稱」這項還用得到的事實（會遺失：公司與職稱）', 'The reviewer did not agree: after the move, other projects would lose a fact they still need, the company and title (would lose: company and title)') },
      { task: 'curate', scope: 'global', action: 'merge', category: 'merge', risk: 'high', refs: ['global/report-format.md', 'global/table-first.md'],
        title: L('把「報告格式」與「表格優先」合併成一筆', 'Merge "report format" and "tables first" into one memory'),
        why: L('「merge」類的處理被你復原過多次，暫停中', 'Handling of "merge" was undone by you several times and is paused') },
      { task: 'dream', pid, action: 'archive', category: 'archive', risk: 'high', refs: [`projects/${pid}/memory/release-checklist-oct.md`],
        title: L('封存：10 月的上線清單已全部完成', 'Archive: the October launch checklist is done'),
        why: L('超過這一輪最多改動的記憶筆數，下一輪再處理', 'Over the most memories one run may change; will be handled in the next run'), deferred: true },
      { task: 'cards', title: L('解決同步衝突：global/core-notes.md', 'Resolve sync conflict: global/core-notes.md'),
        why: L('這個修正要在介面操作', 'This fix has to be done in the dashboard') },
    ],
    notes: [{ task: 'run', note: L('暫停中的類別（被你復原過多次）：merge', 'Paused categories (undone by you several times): merge') }],
    calls: [
      call('secrets', 8200, 5210, 640, 0.071), call('cards', 9400, 7320, 910, 0.094), call('conflicts', 7100, 4800, 520, 0.062),
      call('review', 6800, 4100, 380, 0.049, 'haiku'), call('curate:global', 31200, 38800, 2900, 0.261), call('review:curate:global', 12400, 9800, 640, 0.083, 'haiku'),
      call('dream:order-system', 44800, 52100, 3600, 0.318), call('review:dream:order-system', 11900, 8700, 520, 0.072, 'haiku'),
    ],
  });
  run1.summary = summarizeRun(run1);

  const run2 = wrap({
    id: 'ap-20261106-020504-p7x9', reason: 'schedule', startedAt: ago(60 * 29), endedAt: ago(60 * 29 - 4), status: 'done', budget: budget(3.49),
    actions: [
      act({ task: 'cards', kind: 'card', card: 'f_H07_1', code: 'H07', refs: [`projects/${pid}/memory/db-notes.md`, `projects/${pid}/memory/db-backup.md`], category: 'card-H07', undo: ['e19b4c20'],
        undone: ago(60 * 20),
        title: L('並排比對並合併：可能重複：db 主題有 2 筆', 'Compare and merge: possible duplicates: 2 memories about db'),
        reason: L('兩筆都在講資料庫備份，內容只有細節不同，合併後保留兩邊的所有數字。', 'Both are about database backups and differ only in details; the merge keeps every number from both.') }),
      act({ task: 'cards', kind: 'dismiss', card: 'f_H10_2', code: 'H10',
        title: L('不處理：單檔過大', 'Not handling: file too large'),
        reason: L('使用者釘選的參考資料，不拆。', 'A pinned reference memory; not splitting it.') }),
      act({ task: 'review', kind: 'confirm', refs: ['global/git-commit-style.md'], code: 'H23', category: 'confirm',
        title: L('代你確認：git-commit-style', 'Confirmed for you: git-commit-style'),
        reason: L('只補了一個範例，沒有改變原本的規則。', 'It only added an example and did not change the existing rule.') }),
    ],
    rejected: [{ task: 'curate', scope: 'global', action: 'update', category: 'update', risk: 'medium', refs: ['global/email-brevity.md'],
      title: L('把「內部信要精簡」改寫得更短', 'Rewrite "internal email: keep it short" more briefly'),
      why: L('審核員沒有同意：改寫後少了「圖 > 表 > 文」的優先順序（會遺失：呈現優先順序）', 'The reviewer did not agree: the rewrite drops the "visuals > tables > text" order (would lose: presentation priority)') }],
    calls: [call('cards', 8800, 6100, 700, 0.083), call('review', 6400, 3900, 320, 0.044, 'haiku'), call('curate:global', 24100, 31000, 1900, 0.188)],
  });
  run2.summary = summarizeRun(run2);

  const run3 = wrap({
    id: 'ap-20261105-104530-r2d6', reason: 'manual', startedAt: ago(60 * 53), endedAt: ago(60 * 53 - 3), status: 'failed', budget: budget(3.07),
    error: { code: 'E_CLAUDE_LIMIT', message: L('已達 Claude 的用量上限，這一輪提前結束', 'Claude\'s usage limit was reached, so this run ended early') },
    actions: [act({ task: 'cards', kind: 'card', card: 'f_H05_1', code: 'H05', category: 'card-H05', undo: ['7d3a9e15'],
      title: L('改為全域記憶：只有一台電腦有的通用經驗', 'Make it global: a general lesson that only one computer has'),
      reason: L('這則經驗與專案無關，另一台電腦也用得到。', 'The lesson has nothing to do with a project and the other computer can use it too.') })],
    skipped: [{ task: 'curate', why: L('E_CLAUDE_LIMIT：已達 Claude 的用量上限（5 小時額度）', 'E_CLAUDE_LIMIT: Claude\'s usage limit (5-hour quota) was reached') }],
    calls: [call('cards', 8200, 5400, 610, 0.077)],
  });
  run3.summary = summarizeRun(run3);

  const run4 = wrap({
    id: 'ap-20261104-031512-m3c8', reason: 'enable', startedAt: ago(60 * 76), endedAt: ago(60 * 76 - 9), status: 'done', budget: budget(2.89),
    actions: [
      act({ task: 'secrets', kind: 'vault', card: 'f_H13_9', code: 'H13', refs: [`projects/${pid}/memory/db-notes.md`], category: 'vault', undo: ['0a1b2c3d'],
        title: L(`金鑰移到本機保管區：projects/${pid}/memory/db-notes.md`, `Secret moved to the local vault: projects/${pid}/memory/db-notes.md`),
        reason: L('存成 db-readonly-password；記憶改寫成只記存放位置。', 'Stored as db-readonly-password; the memory now records only where it is kept.') }),
      act({ task: 'conflicts', kind: 'conflict', card: 'f_H15_2', code: 'H15', refs: ['global/user-guidelines.md'], category: 'conflict-ours', undo: ['4e5f6a7b'],
        undone: ago(60 * 70),
        title: L('處理衝突：global/user-guidelines.md（保留目前的版本）', 'Resolved conflict: global/user-guidelines.md (kept the current version)'),
        reason: L('另一個版本只是舊的一份，目前的版本包含之後新增的兩條準則。', 'The other version is just an older copy; the current version includes two rules added later.'),
        review: { verdict: 'approve', reason: L('目前的版本是另一個版本的超集合，沒有遺失任何一條。', 'The current version is a superset of the other, so no rule is lost.') } }),
    ],
    rejected: [
      { task: 'curate', scope: 'global', action: 'archive', category: 'archive', risk: 'high', title: L('封存：舊的偏好備忘', 'Archive: an old preference note'),
        why: L('審核員沒有同意：內容仍被別的記憶引用（會遺失：被連結的偏好）', 'The reviewer did not agree: another memory still links to it (would lose: the linked preference)') },
      { task: 'curate', scope: 'global', action: 'merge', category: 'merge', risk: 'high', title: L('合併兩筆說明文件的偏好', 'Merge two documentation preferences'),
        why: L('要寫進全域或單機，但證據裡沒有使用者自己說的話', 'It would be written to global or machine scope, but the evidence has nothing the user said themselves') },
    ],
    notes: [{ task: 'run', note: L('開始前同步失敗，先用本機的內容處理：連不到 GitHub', 'Sync before the run failed, so it worked from the local copy: cannot reach GitHub') }],
    calls: [call('secrets', 7900, 4900, 580, 0.066), call('conflicts', 6600, 4400, 480, 0.058), call('curate:global', 28800, 35200, 2500, 0.231)],
  });
  run4.summary = summarizeRun(run4);

  const run5 = wrap({ id: 'ap-20261102-221840-b9v1', reason: 'schedule', startedAt: ago(60 * 24 * 5 + 40), status: 'interrupted', budget: budget(2.1), actions: [] });
  run5.summary = null;

  const feedback = [
    { at: ago(60 * 24 * 20), category: 'merge', ref: 'global/report-format.md', title: L('把「報告格式」與「表格優先」合併成一筆', 'Merged "report format" and "tables first" into one memory'), reason: '', mid: self.id },
    { at: ago(60 * 24 * 9), category: 'merge', ref: 'global/git-commit-style.md', title: L('合併兩筆 git 習慣', 'Merged two git habit memories'), reason: '', mid: self.id },
    { at: ago(60 * 20), category: 'card-H07', ref: `projects/${pid}/memory/db-notes.md`, title: L('並排比對並合併：可能重複：db 主題有 2 筆', 'Compare and merge: possible duplicates: 2 memories about db'), reason: '', mid: self.id },
  ];

  /** 「立即執行」的模擬：分兩段加入結果，最後收尾 */
  const live = () => ({
    stages: [
      [act({ task: 'cards', kind: 'card', card: 'f_H09_1', code: 'H09', category: 'card-H09', undo: ['aa11bb22'],
        title: L('修正格式：說明欄位缺少', 'Fix formatting: missing description'),
        reason: L('補上一句說明，內容一字不改。', 'Added one line of description without changing the body.') })],
      [act({ task: 'curate', scope: 'global', kind: 'tidy', record: REC_A, item: 'i1', action: 'update', category: 'update', risk: 'low', refs: ['global/team-lead-role.md'], undo: ['cc33dd44'],
        title: L('確認仍正確：team-lead-role', 'Verified still correct: team-lead-role'),
        reason: L('記下驗證日期，內容不變。', 'Recorded the verification date; the content is unchanged.'),
        review: { verdict: 'approve', reason: L('只改了驗證日期。', 'Only the verification date changed.') } })],
    ],
    calls: [call('cards', 8100, 5200, 600, 0.074), call('curate:global', 22000, 28000, 1500, 0.166)],
    notes: [],
  });

  return { runs: [run1, run2, run3, run4, run5], tidyRecords: [recB, recA], feedback, live };
}
