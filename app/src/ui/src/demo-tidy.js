// 展示版的記憶整理：合成的整理記錄（中文／英文各一套），不讀任何真實記憶。
// 形狀與 app/src/tidy 的整理記錄相同；demo.js 用它模擬 /api/tidy*。

const fm = (name, description, type, body) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

const ZH = {
  request: '重點看重複的記憶',
  summary: '8 筆全域記憶裡，有 2 筆其實只跟單一專案有關、2 筆在講同一件事；建議搬移 1 筆、改寫 1 筆、合併 2 筆成 1 筆、封存 1 筆、新增 1 筆，其餘保留。',
  highlights: ['「使用者背景」類的身分資料已經寫在核心準則，剩下的內容只跟訂單系統有關，建議搬到那個專案', '報告格式偏好分散在兩筆，合併成一筆比較好找', '1 筆提到已經汰換的 VPN 工具，建議封存'],
  groups: { you: '你的背景', style: '交付風格', tools: '工具經驗' },
  items: [
    {
      ref: 'global/user-profile-office.md', group: 'you', action: 'move', type: 'user',
      title: '整筆搬到「訂單系統」專案',
      reason: '身分資料（公司、職稱、email）核心準則第 1 節已經有了；其餘內容（部署主機、客戶窗口、上線時程）只跟訂單系統有關。放在全域，其他專案也會套用這些前提。',
      before: fm('user-profile-office', '使用者在公司負責訂單系統，部署在內部主機', 'user', '- 公司：範例科技，職稱專案經理\n- 負責訂單系統：部署在內部主機 app-01，客戶窗口是採購部\n- 2026-11 底要上線第二階段'),
      ops: (pid) => [{ op: 'move', ref: 'global/user-profile-office.md', to: `project:${pid}` }],
    },
    {
      ref: 'global/team-lead-role.md', group: 'you', action: 'update', type: 'user',
      title: '補上目前負責的工作，刪掉過期的職稱',
      reason: '2026-09 之後已經不是小組長，現在主講內部 AI 分享；舊說法會讓 Claude 用錯誤的角色回答。',
      before: fm('team-lead-role', '使用者是開發小組長', 'user', '使用者是開發小組長，負責程式審查。\n\n偏好：\n- 回覆用條列\n- 程式碼附註解'),
      after: fm('team-lead-role', '使用者負責專案管理並主講內部 AI 分享', 'user', '使用者負責專案管理，並主講公司內部的 AI 技術分享（2026-09 起）。\n\n偏好：\n- 回覆用條列\n- 程式碼附註解\n- 簡報用單檔 HTML，每頁文字少'),
    },
    {
      ref: 'global/report-format.md', group: 'style', action: 'merge', type: 'feedback',
      title: '與「表格優先」合併成一筆',
      reason: '兩筆都在講「交付給人看的報告要怎麼呈現」，分開放容易只讀到其中一筆。合併後保留兩筆的所有規則與日期。',
      before: fm('report-format', '報告用單一 HTML 檔', 'feedback', '工具產出的報告做成單一 HTML 檔，結論放最上面。\n\n**Why:** 2026-10-08 看過 .txt 報告後覺得難讀。\n**How to apply:** 不引用外部資源。'),
      other: 'global/table-first.md',
      otherText: fm('table-first', '管理用文件先給表格', 'feedback', '管理用文件只要一張欄位明確的表格，不要多節報表。'),
      after: fm('report-format', '給人看的報告：單一 HTML 檔、結論在上、表格優先', 'feedback', '工具產出的報告做成單一 HTML 檔，結論放最上面。\n管理用文件只要一張欄位明確的表格，不要多節報表。\n\n**Why:** 2026-10-08 看過 .txt 報告後覺得難讀；2026-10-11 覺得五節報表過度複雜。\n**How to apply:** 不引用外部資源；先交付最小可用的表格。'),
    },
    {
      ref: 'global/old-vpn-client.md', group: 'tools', action: 'archive', type: 'reference',
      title: '封存：這個 VPN 工具已在 2026-08 汰換',
      reason: '內容是舊 VPN 用戶端的設定步驟；新電腦已經改用公司的零信任閘道，留著會讓 Claude 建議已經不能用的做法。封存後仍可從歷史復原。',
      before: fm('old-vpn-client', '舊 VPN 用戶端的連線設定', 'reference', '開啟舊 VPN 用戶端 → 匯入設定檔 → 輸入 OTP。'),
      ops: () => [{ op: 'remove', ref: 'global/old-vpn-client.md' }],
    },
    {
      ref: null, group: 'tools', action: 'create', type: 'reference', name: 'git-longpaths',
      title: '新增：git 長路徑設定',
      reason: '這個經驗原本夾在「使用者背景」裡，那一筆搬走之後其他專案就看不到了；它對每個專案都適用，所以抽出來放全域。',
      after: fm('git-longpaths', 'Windows 上 clone 大型 repo 前先設 core.longpaths', 'reference', 'Windows 上 git clone 大型 repo 需要 `core.longpaths true`，否則路徑過長的檔案會讓 checkout 整批失敗。'),
    },
    {
      ref: 'global/powershell-bom.md', group: 'tools', action: 'keep', type: 'feedback',
      title: '保留：跨專案通用，內容仍然正確',
      reason: '兩台電腦都是 Windows，這個經驗每個專案都用得到。',
      before: fm('powershell-bom', '含中文的 .ps1 要加 UTF-8 BOM', 'feedback', 'Windows PowerShell 5.1 讀沒有 BOM 的 .ps1 會用系統編碼，中文會變亂碼。'),
    },
    {
      ref: 'global/email-brevity.md', group: 'style', action: 'keep', type: 'feedback',
      title: '保留',
      reason: '仍然有效，說明清楚。',
      before: fm('email-brevity', '內部信要精簡：圖 > 表 > 文', 'feedback', '收件人都很忙，一封信應在一分鐘內看完。'),
    },
  ],
  kept: ['global/git-commit-style.md'],
};

const EN = {
  request: 'Focus on duplicates',
  summary: 'Of 8 global memories, 2 are really about a single project and 2 say the same thing. Suggested: move 1, rewrite 1, merge 2 into 1, archive 1, add 1, and keep the rest.',
  highlights: ['The identity details in the "user background" memory are already in the core rules; the rest only concerns the order system, so move it to that project', 'Report-format preferences are split across two memories; one merged memory is easier to find', 'One memory describes a VPN tool that was retired; archive it'],
  groups: { you: 'About you', style: 'Delivery style', tools: 'Tool experience' },
  items: [
    {
      ref: 'global/user-profile-office.md', group: 'you', action: 'move', type: 'user',
      title: 'Move the whole memory to the "Order system" project',
      reason: 'The identity details (company, title, email) are already in section 1 of the core rules. The rest (deployment host, client contact, launch timeline) only concerns the order system. Kept in global, every other project would assume these too.',
      before: fm('user-profile-office', 'The user runs the order system, deployed on an internal host', 'user', '- Company: Example Tech, project manager\n- Owns the order system: deployed on internal host app-01; client contact is Purchasing\n- Phase 2 launches at the end of 2026-11'),
      ops: (pid) => [{ op: 'move', ref: 'global/user-profile-office.md', to: `project:${pid}` }],
    },
    {
      ref: 'global/team-lead-role.md', group: 'you', action: 'update', type: 'user',
      title: 'Add the current role and drop the outdated title',
      reason: 'Since 2026-09 the user is no longer a team lead and now presents the internal AI talks. The old wording makes Claude answer from the wrong role.',
      before: fm('team-lead-role', 'The user is a development team lead', 'user', 'The user is a development team lead and does code reviews.\n\nPreferences:\n- Answers as bullet points\n- Comment the code'),
      after: fm('team-lead-role', 'The user manages projects and presents the internal AI talks', 'user', 'The user manages projects and presents the company\'s internal AI talks (since 2026-09).\n\nPreferences:\n- Answers as bullet points\n- Comment the code\n- Slides as a single HTML file, little text per slide'),
    },
    {
      ref: 'global/report-format.md', group: 'style', action: 'merge', type: 'feedback',
      title: 'Merge with "tables first" into one memory',
      reason: 'Both describe how reports for people should look; kept apart, Claude may read only one. The merge keeps every rule and date from both.',
      before: fm('report-format', 'Reports as a single HTML file', 'feedback', 'Reports produced by tools are a single HTML file with the conclusion at the top.\n\n**Why:** 2026-10-08, the .txt report was hard to read.\n**How to apply:** No external resources.'),
      other: 'global/table-first.md',
      otherText: fm('table-first', 'Management documents: table first', 'feedback', 'Management documents need one table with clear columns, not a multi-section report.'),
      after: fm('report-format', 'Reports for people: one HTML file, conclusion first, tables first', 'feedback', 'Reports produced by tools are a single HTML file with the conclusion at the top.\nManagement documents need one table with clear columns, not a multi-section report.\n\n**Why:** 2026-10-08, the .txt report was hard to read; 2026-10-11, a five-section report was overkill.\n**How to apply:** No external resources; deliver the smallest useful table first.'),
    },
    {
      ref: 'global/old-vpn-client.md', group: 'tools', action: 'archive', type: 'reference',
      title: 'Archive: this VPN tool was retired in 2026-08',
      reason: 'It describes setting up the old VPN client. The computers now use the company zero-trust gateway, so keeping it would make Claude suggest something that no longer works. Archived memories can be restored from history.',
      before: fm('old-vpn-client', 'Connection settings for the old VPN client', 'reference', 'Open the old VPN client → import the profile → enter the OTP.'),
      ops: () => [{ op: 'remove', ref: 'global/old-vpn-client.md' }],
    },
    {
      ref: null, group: 'tools', action: 'create', type: 'reference', name: 'git-longpaths',
      title: 'Add: git long paths setting',
      reason: 'This tip was buried in the "user background" memory. Once that memory moves, other projects would lose it, and it applies to every project, so it gets its own global memory.',
      after: fm('git-longpaths', 'Set core.longpaths before cloning large repos on Windows', 'reference', 'On Windows, cloning a large repo needs `core.longpaths true`; otherwise files with long paths make the whole checkout fail.'),
    },
    {
      ref: 'global/powershell-bom.md', group: 'tools', action: 'keep', type: 'feedback',
      title: 'Keep: useful for every project and still correct',
      reason: 'Both computers run Windows, so every project benefits from this.',
      before: fm('powershell-bom', 'Chinese text in .ps1 needs a UTF-8 BOM', 'feedback', 'Windows PowerShell 5.1 reads .ps1 files without a BOM in the system code page, which garbles Chinese text.'),
    },
    {
      ref: 'global/email-brevity.md', group: 'style', action: 'keep', type: 'feedback',
      title: 'Keep',
      reason: 'Still valid and clearly described.',
      before: fm('email-brevity', 'Internal email: visuals > tables > text', 'feedback', 'Recipients are busy; an email should take under a minute to read.'),
    },
  ],
  kept: ['global/git-commit-style.md'],
};

// 對話回顧（1.4.0）：拿對話紀錄驗證專案記憶的展示記錄
const DREAM_ZH = {
  summary: '回顧了這台電腦 6 個對話（10/28～11/06）：2 筆記憶已經過時、1 筆說得太肯定、2 筆被對話證實，另外有 1 件事值得記下來。',
  highlights: ['部署指令在 11/02 改成 npm run release，記憶還寫著舊的 npm run deploy', '「API 每分鐘上限 60 次」是當時的推測，對話裡沒有驗證過', '11/03 會議決定報表一律輸出 CSV，還沒有任何記憶記下'],
  groups: { changed: '已經改變的事', unsure: '說得太肯定', fresh: '新的記憶', same: '與對話一致' },
  items: [
    { name: 'deploy-notes', group: 'changed', action: 'update', type: 'project', title: '部署指令已改成 npm run release',
      reason: '11/02 的對話把部署腳本改名，之後兩次部署都用 npm run release 成功；記憶還寫著 npm run deploy，照著做會找不到指令。保留一句舊說法的紀錄。',
      evidence: [{ session: '7c2e91ab', date: '2026-11-02', quote: '把 package.json 的 deploy 改名成 release，順便加上版本號檢查', contradicts: true }, { session: 'a41f0d3c', date: '2026-11-05', quote: 'npm run release 跑完了，三台主機都更新成功' }],
      before: '部署：npm run deploy（會先跑測試）。\n部署主機：app-01、app-02、app-03。',
      after: '部署：npm run release（2026-11-02 起；之前是 npm run deploy）。會先跑測試與版本號檢查。\n部署主機：app-01、app-02、app-03。' },
    { name: 'release-checklist-oct', group: 'changed', action: 'archive', type: 'project', title: '封存：10 月的上線清單已全部完成',
      reason: '記憶是 10 月第二階段上線的待辦清單；11/04 的對話逐項確認都完成了，留著會讓 Claude 以為還有事沒做。',
      evidence: [{ session: 'e09b44d2', date: '2026-11-04', quote: '清單上最後兩項（備份排程、監控告警）也都設好了，第二階段結案' }],
      before: '第二階段上線待辦：\n- [ ] 備份排程\n- [ ] 監控告警' },
    { name: 'api-rate-limit', group: 'unsure', action: 'update', type: 'reference', title: '「每分鐘 60 次」改成推測，並註明還沒驗證',
      reason: '這筆寫得很肯定，但 10/29 的對話裡是 Claude 依錯誤訊息推測的，之後沒有查到文件或實測。改成實際的確定程度，免得之後被當成事實。',
      evidence: [{ session: '3b8d1f60', date: '2026-10-29', quote: '看起來像是每分鐘 60 次的限制，不過文件沒寫，我先照這個假設調整重試間隔' }],
      before: '供應商 API 每分鐘上限 60 次。',
      after: '供應商 API 每分鐘上限推測是 60 次（2026-10-29 依 429 錯誤推測，尚未查到文件或實測確認）。' },
    { name: 'report-csv-only', group: 'fresh', action: 'create', type: 'project', title: '新增：報表一律輸出 CSV（客戶 11/03 決定）',
      reason: '11/03 的對話記錄了客戶會議的決定，之後的報表功能都要照這個做，但還沒有任何記憶寫下來；對話紀錄 30 天後就會被清除。',
      evidence: [{ session: 'c5a7e210', date: '2026-11-03', quote: '客戶說報表不要 Excel 了，一律給 CSV，欄位用英文代碼' }],
      after: '客戶在 2026-11-03 的會議決定：報表一律輸出 CSV，欄位名稱用英文代碼，不再提供 Excel。\n\n**Why:** 客戶的下游系統只吃 CSV。\n**How to apply:** 新的報表功能預設 CSV；遇到要做 Excel 的需求先確認。' },
    { name: 'api-auth', group: 'same', action: 'verify', type: 'reference', title: '仍然正確',
      reason: '11/05 照這筆的步驟換發權杖，一次成功。',
      evidence: [{ session: 'a41f0d3c', date: '2026-11-05', quote: '照記憶裡的步驟到後台重新產生權杖，存到認證管理員，測試呼叫 200' }],
      before: '權杖在供應商後台產生，存在 Windows 認證管理員的「vendor-api」。' },
    { name: 'db-backup', group: 'same', action: 'verify', type: 'project', title: '仍然正確',
      reason: '11/04 檢查備份時，路徑與排程都和記憶相同。',
      evidence: [{ session: 'e09b44d2', date: '2026-11-04', quote: '備份在 D:\\backup\\db，每天 02:00，最近七天都有檔案' }],
      before: '資料庫每天 02:00 備份到 D:\\backup\\db，保留 14 天。' },
  ],
};
const DREAM_EN = {
  summary: 'Reviewed 6 conversations on this computer (10/28–11/06): 2 memories are out of date, 1 is too confident, 2 were confirmed by the conversations, and 1 thing is worth remembering.',
  highlights: ['The deploy command changed to npm run release on 11/02; the memory still says npm run deploy', '"60 requests per minute" was a guess at the time and was never verified', 'The 11/03 meeting decided reports are always CSV; no memory records it yet'],
  groups: { changed: 'What changed', unsure: 'Too confident', fresh: 'New memories', same: 'Matches the conversations' },
  items: [
    { name: 'deploy-notes', group: 'changed', action: 'update', type: 'project', title: 'The deploy command is now npm run release',
      reason: 'On 11/02 the deploy script was renamed, and both deployments after that used npm run release successfully. The memory still says npm run deploy, which no longer exists. The old wording is kept in one sentence.',
      evidence: [{ session: '7c2e91ab', date: '2026-11-02', quote: 'Rename deploy to release in package.json and add a version check', contradicts: true }, { session: 'a41f0d3c', date: '2026-11-05', quote: 'npm run release finished; all three hosts are updated' }],
      before: 'Deploy: npm run deploy (runs the tests first).\nHosts: app-01, app-02, app-03.',
      after: 'Deploy: npm run release (since 2026-11-02; previously npm run deploy). Runs the tests and a version check first.\nHosts: app-01, app-02, app-03.' },
    { name: 'release-checklist-oct', group: 'changed', action: 'archive', type: 'project', title: 'Archive: the October launch checklist is done',
      reason: 'This memory is the to-do list for the phase 2 launch in October. The 11/04 conversation confirmed every item is done; keeping it would make Claude think work is still open.',
      evidence: [{ session: 'e09b44d2', date: '2026-11-04', quote: 'The last two items (backup schedule, monitoring alerts) are set up too; phase 2 is closed' }],
      before: 'Phase 2 launch to-do:\n- [ ] Backup schedule\n- [ ] Monitoring alerts' },
    { name: 'api-rate-limit', group: 'unsure', action: 'update', type: 'reference', title: 'Mark "60 per minute" as a guess that is not verified',
      reason: 'The memory states this as fact, but in the 10/29 conversation Claude guessed it from an error message and never found docs or tested it. Reword it to match how sure we really are.',
      evidence: [{ session: '3b8d1f60', date: '2026-10-29', quote: "It looks like a 60-per-minute limit, though the docs don't say; I'll tune the retry interval on that assumption" }],
      before: 'The vendor API allows 60 requests per minute.',
      after: 'The vendor API limit is probably 60 requests per minute (guessed from a 429 error on 2026-10-29; not confirmed by docs or testing).' },
    { name: 'report-csv-only', group: 'fresh', action: 'create', type: 'project', title: 'Add: reports are always CSV (client decision on 11/03)',
      reason: 'The 11/03 conversation recorded the decision from the client meeting. Every report feature should follow it, but no memory has it yet, and the conversation will be deleted after 30 days.',
      evidence: [{ session: 'c5a7e210', date: '2026-11-03', quote: 'The client no longer wants Excel; always CSV, with English column codes' }],
      after: 'At the 2026-11-03 meeting the client decided: reports are always CSV with English column codes; no more Excel.\n\n**Why:** The client\'s downstream system only reads CSV.\n**How to apply:** New report features default to CSV; confirm before building anything in Excel.' },
    { name: 'api-auth', group: 'same', action: 'verify', type: 'reference', title: 'Still correct',
      reason: 'On 11/05 the token was renewed by following these steps, first time.',
      evidence: [{ session: 'a41f0d3c', date: '2026-11-05', quote: 'Regenerated the token in the vendor console per the memory, stored it in Credential Manager, test call returned 200' }],
      before: 'Tokens are generated in the vendor console and stored in Windows Credential Manager under "vendor-api".' },
    { name: 'db-backup', group: 'same', action: 'verify', type: 'project', title: 'Still correct',
      reason: 'When the backups were checked on 11/04, the path and schedule matched this memory.',
      evidence: [{ session: 'e09b44d2', date: '2026-11-04', quote: 'Backups are in D:\\backup\\db at 02:00 daily; the last seven days are all there' }],
      before: 'The database is backed up daily at 02:00 to D:\\backup\\db and kept for 14 days.' },
  ],
};

function buildDream({ en, pid, ago }) {
  const D = en ? DREAM_EN : DREAM_ZH;
  const texts = {};
  const items = D.items.map((x, i) => {
    const ref = `projects/${pid}/memory/${x.name}.md`;
    const desc = (en ? {
      'deploy-notes': 'How to deploy and which hosts', 'release-checklist-oct': 'Phase 2 launch checklist (October)', 'api-rate-limit': 'Vendor API rate limit',
      'report-csv-only': 'Reports are always CSV (client decision)', 'api-auth': 'Where the vendor API token comes from', 'db-backup': 'Database backup schedule and location',
    } : {
      'deploy-notes': '部署方式與主機', 'release-checklist-oct': '第二階段上線清單（10 月）', 'api-rate-limit': '供應商 API 的呼叫上限',
      'report-csv-only': '報表一律輸出 CSV（客戶決定）', 'api-auth': '供應商 API 權杖的取得方式', 'db-backup': '資料庫備份的排程與位置',
    })[x.name] ?? x.title;
    const before = x.before !== undefined ? fm(x.name, desc, x.type, x.before) : null;
    if (before) texts[ref] = before;
    let ops = [];
    if (x.action === 'update') ops = [{ op: 'write', ref, base: 'demo', content: fm(x.name, desc, x.type, x.after) }];
    else if (x.action === 'archive') ops = [{ op: 'remove', ref, base: 'demo' }];
    else if (x.action === 'create') ops = [{ op: 'create', scope: `project:${pid}`, ref, name: x.name, type: x.type, content: fm(x.name, desc, x.type, x.after) }];
    else if (x.action === 'verify') ops = [{ op: 'verify', ref, base: 'demo', date: x.evidence?.map((e) => e.date).sort().slice(-1)[0] ?? '2026-11-07' }];
    return {
      id: `i${i + 1}`, ref: x.action === 'create' ? null : ref, name: x.name, scope: `project:${pid}`, type: x.type, description: '',
      group: D.groups[x.group], action: x.action, title: x.title, reason: x.reason, evidence: x.evidence, base: 'demo', ops,
      decision: null, note: '', result: null, changed: [],
    };
  });
  return {
    v: 1, id: '20261107-091530-d7r2', createdAt: ago(3), updatedAt: ago(3), machine: 'demo', scope: `project:${pid}`, request: '',
    summary: D.summary, highlights: D.highlights, status: 'pending', items, kept: [], texts,
    kind: 'dream', dream: { id: 'dr-20261107-091200-q8w3', sessions: 6, from: '2026-10-28T02:10:00.000Z', to: '2026-11-06T09:40:00.000Z', remaining: 0 },
  };
}

/** 建立展示用的整理記錄：一份對話回顧（專案）、一份待你決定（全域）、一份已完成（專案） */
export function buildTidySample({ en = false, pid = 'order-system-x1y2z', now = Date.now() } = {}) {
  const S = en ? EN : ZH;
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const texts = {};
  const items = S.items.map((x, i) => {
    let ops = [];
    if (x.action === 'update') ops = [{ op: 'write', ref: x.ref, content: x.after }];
    else if (x.action === 'merge') ops = [{ op: 'merge', refs: [x.ref, x.other], into: x.ref, content: x.after }];
    else if (x.action === 'create') ops = [{ op: 'create', scope: 'global', ref: `global/${x.name}.md`, name: x.name, type: x.type, content: x.after }];
    else if (x.ops) ops = x.ops(pid);
    if (x.ref) texts[x.ref] = x.before;
    if (x.other) texts[x.other] = x.otherText;
    return {
      id: `i${i + 1}`, ref: x.ref, name: x.ref ? x.ref.split('/').pop().replace(/\.md$/, '') : x.name, scope: 'global', type: x.type,
      description: '', group: S.groups[x.group], action: x.action, title: x.title, reason: x.reason, base: 'demo', ops,
      decision: null, note: '', result: null, changed: [],
    };
  });
  // 展示一部分已經決定的樣子
  items[0].decision = 'accept';
  items[1].decision = 'accept';
  items[3].decision = 'archive';
  items[2].decision = 'custom';
  items[2].note = en ? 'Merge them, but keep the description short' : '合併沒問題，但說明再短一點';
  const pending = { v: 1, id: '20261024-143012-k3p9', createdAt: ago(6), updatedAt: ago(2), machine: 'demo', scope: 'global', request: S.request, summary: S.summary, highlights: S.highlights, status: 'pending', items, kept: S.kept, texts };

  const doneItems = [
    { id: 'i1', ref: `projects/${pid}/memory/deploy-steps.md`, name: 'deploy-steps', scope: `project:${pid}`, type: 'project', group: null, action: 'update', title: en ? 'Update the deployment steps for the new host' : '依新主機更新部署步驟', reason: en ? 'The host changed on 2026-10-15.' : '2026-10-15 換了主機。', base: 'demo', ops: [], decision: 'accept', note: '', result: { status: 'done', undo: ['3f9a2c1d4e'], at: ago(60 * 26) }, changed: [] },
    { id: 'i2', ref: `projects/${pid}/memory/old-schema.md`, name: 'old-schema', scope: `project:${pid}`, type: 'project', group: null, action: 'archive', title: en ? 'Archive the replaced schema notes' : '封存已被取代的資料表筆記', reason: en ? 'Replaced by schema-v2.' : '已由 schema-v2 取代。', base: 'demo', ops: [], decision: 'accept', note: '', result: { status: 'done', undo: ['8b1e7a0c2d'], at: ago(60 * 26) }, changed: [] },
    { id: 'i3', ref: `projects/${pid}/memory/api-notes.md`, name: 'api-notes', scope: `project:${pid}`, type: 'reference', group: null, action: 'keep', title: en ? 'Keep' : '保留', reason: en ? 'Still valid.' : '仍然有效。', base: 'demo', ops: [], decision: 'keep', note: '', result: { status: 'kept', at: ago(60 * 26) }, changed: [] },
  ];
  const done = { v: 1, id: '20261023-091544-m2x7', createdAt: ago(60 * 27), updatedAt: ago(60 * 26), appliedAt: ago(60 * 26), machine: 'demo', scope: `project:${pid}`, request: '', summary: en ? 'Two of the project\'s memories were outdated; one rewritten and one archived.' : '專案裡有 2 筆過時；改寫 1 筆、封存 1 筆。', highlights: [], status: 'done', items: doneItems, kept: [], texts: {}, backup: 'C:\\Users\\Demo\\.engram\\local\\backups\\2026-10-23T01-15-44-120Z-tidy-20261023-091544-m2x7' };
  return [buildDream({ en, pid, ago }), pending, done];
}

/** 與 app/src/tidy/store.mjs 的 counts 相同 */
export function tidyCounts(rec) {
  const c = { items: rec.items.length, suggested: 0, decided: 0, accept: 0, keep: 0, archive: 0, custom: 0, done: 0, kept: 0, failed: 0, skipped: 0, undone: 0, waiting: 0 };
  for (const it of rec.items) {
    if (it.action !== 'keep' && it.action !== 'verify') c.suggested++;
    if (it.decision) { c.decided++; c[it.decision]++; }
    const r = it.result?.status;
    if (r === 'needs-claude') c.waiting++;
    else if (r && Object.hasOwn(c, r)) c[r]++;
  }
  return c;
}
