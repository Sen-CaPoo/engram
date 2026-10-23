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

/** 建立展示用的整理記錄：一份待你決定（全域），一份已完成（專案） */
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
  return [pending, done];
}

/** 與 app/src/tidy/store.mjs 的 counts 相同 */
export function tidyCounts(rec) {
  const c = { items: rec.items.length, suggested: 0, decided: 0, accept: 0, keep: 0, archive: 0, custom: 0, done: 0, kept: 0, failed: 0, skipped: 0, undone: 0, waiting: 0 };
  for (const it of rec.items) {
    if (it.action !== 'keep') c.suggested++;
    if (it.decision) { c.decided++; c[it.decision]++; }
    const r = it.result?.status;
    if (r === 'needs-claude') c.waiting++;
    else if (r && Object.hasOwn(c, r)) c[r]++;
  }
  return c;
}
