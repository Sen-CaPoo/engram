// 展示版的 2.0.0 新功能：保留區、環境健檢與兩台差異、環境設定同步、護欄、情境召回與索引分層、自動更新、每週摘要。
// 全部是合成資料（中文／英文各一套），形狀與後端相同：app/src/core/holding.mjs、envhealth.mjs、envsync.mjs、guardrails.mjs、
// recall.mjs、app/install/autoupdate.mjs；每週摘要依 api.js 檔頭的約定。demo.js 把 createV2Demo 回傳的方法併進 demoApi。
// 護欄直接用外掛的比對函式與內建規則（plugin/hooks/lens/guard.mjs，純函式），「試試看」的結果和真的一樣。
// 審查用的狀態變體：?holding=empty、?env=off、?envsync=none、?digest=empty、?layers=on、?guard=hint|off|skipped
import { DEFAULT_RULES, activeOverride, approvalState, compileRules, denyText, effectiveAction, evaluate, falseBlockUntil, hintTexts } from '../../../plugin/hooks/lens/guard.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message, enMessage, code = 'E_INVALID', hint = '', enHint = '') => Object.assign(new Error(message), { code, hint, en: { message: enMessage, hint: enHint } });
const hex = (seed, n = 40) => { let h = ''; let x = seed; while (h.length < n) { x = (x * 1103515245 + 12345) % 2147483648; h += x.toString(16); } return h.slice(0, n); };

// 護欄規則的英文：內建規則自己帶 messageEn（plugin/hooks/lens/guard.mjs 的 DEFAULT_RULES）；這條同步來的展示規則比照寫 messageEn，
// 介面用 ruleMessage(rule, lang) 挑選（後端的規則沒有 en 欄位）
const RULE_EN = {
  'git-push-force': 'Do not use git push --force on a shared branch. Use --force-with-lease instead, or ask the user first.',
};
const RULE_SOURCE_EN = {
  'bash-heredoc-triple-quote': 'How the Bash tool parses triple quotes in a heredoc (built-in rule)',
  'inline-script-double-backslash': 'The Bash tool collapses double backslashes in commands (built-in rule)',
  'inline-script-cjk': 'How the Bash tool handles CJK text in inline scripts and heredocs (built-in rule)',
  'powershell-command-shell-variable': 'bash expands $ inside double quotes first (built-in rule)',
  'msys-path-conversion': 'Git Bash (MSYS) converts path arguments automatically (built-in rule)',
  'rm-shell-variable': 'The Claude Code safety check on delete targets with shell variables (built-in rule)',
};

/**
 * @param {{ en: boolean, now: number, self: object, other: object, pid: string, variant: object, settings: object,
 *   rawOf: (m: object) => string, emit: Function, findMemory: (ref: string) => object|undefined, addMemory: (m: object) => void,
 *   addTidyRecord: (rec: object) => void, projectName: (pid: string) => string }} o
 */
export function createV2Demo(o) {
  const { en, now, self, other, pid, variant: V, settings, rawOf, emit } = o;
  const L = (zh, enText) => (en ? enText : zh);
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const day = (d) => new Date(now - d * 864e5).toISOString().slice(0, 10);
  let seq = 0;

  // ── 保留區 ─────────────────────────────────────────
  const mem = (ref, name, description, type, body, scope) => ({ ref, scope, name, description, type, size: body.length * 2, updatedAt: ago(60 * 30), pinned: false, tags: [], indexed: true, findings: [], body });
  const deployRef = 'global/deploy-window.md';
  const tempRef = 'global/temp-note.md';
  const dbA = `projects/${pid}/memory/db-notes.md`;
  const dbB = `projects/${pid}/memory/db-backup.md`;
  const sudoRef = 'global/no-sudo-npm.md';
  const outputRef = 'global/bash-output-limit.md';
  const before = {
    [sudoRef]: mem(sudoRef, 'no-sudo-npm', L('不要用 sudo 執行 npm', 'Never run npm with sudo'), 'feedback', L('不要用 sudo 執行 npm install；全域套件改用 nvm 管理的 Node 安裝。\n\n**Why:** 用 sudo 裝的套件權限不對，之後一般帳號無法更新。\n**How to apply:** 需要全域安裝時先確認 Node 是 nvm 裝的。\n', 'Never run npm install with sudo; install global packages with the Node managed by nvm.\n\n**Why:** Packages installed with sudo end up with the wrong owner, and the normal account cannot update them later.\n**How to apply:** Before a global install, make sure Node comes from nvm.\n'), { kind: 'global' }),
    [outputRef]: mem(outputRef, 'bash-output-limit', L('Bash 輸出上限調到 80000', 'Raise the Bash output limit to 80000'), 'reference', L('跑完整測試時輸出很長，Claude Code 的 BASH_MAX_OUTPUT_LENGTH 調到 80000 才看得到最後的摘要。\n', 'The full test run prints a lot; set BASH_MAX_OUTPUT_LENGTH to 80000 in Claude Code so the final summary is not cut off.\n'), { kind: 'global' }),
    [deployRef]: mem(deployRef, 'deploy-window', L('正式環境的部署時段', 'When to deploy to production'), 'feedback', L('正式環境每週二 21:00 之後部署，部署前先在群組公告。\n\n**Why:** 白天有客戶在線上下單。\n**How to apply:** 排部署時間時照這個時段。\n', 'Deploy to production on Tuesdays after 21:00 and announce it in the team chat first.\n\n**Why:** Customers place orders during the day.\n**How to apply:** Use this window when scheduling a deployment.\n'), { kind: 'global' }),
    [tempRef]: mem(tempRef, 'temp-note', L('暫存的連線備忘', 'A temporary connection note'), 'reference', L('測試資料庫只在公司網路內連得到。\n', 'The test database is only reachable from the office network.\n'), { kind: 'global' }),
    [dbA]: mem(dbA, 'db-notes', L('資料庫連線與備份', 'Database connection and backups'), 'project', L('測試資料庫：db-test.internal:5432。\n備份每天 02:00 執行。\n', 'Test database: db-test.internal:5432.\nBackups run daily at 02:00.\n'), { kind: 'project', pid }),
    [dbB]: mem(dbB, 'db-backup', L('資料庫備份的保留天數', 'How long database backups are kept'), 'project', L('備份保留 14 天，超過自動刪除。\n', 'Backups are kept for 14 days and then deleted automatically.\n'), { kind: 'project', pid }),
  };
  for (const m of Object.values(before)) if (!o.findMemory(m.ref)) o.addMemory(m);
  const rawWith = (ref, body, extra = {}) => rawOf({ ...(o.findMemory(ref) ?? before[ref]), ...extra, body });
  const fm = (name, description, type, body) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}`;
  // 記憶畢業：在原記憶的 frontmatter 記下去向（內文不動，與 graduate.mjs 的 markText 相同）
  const graduatedRaw = (ref, to) => { const m = before[ref]; return `---\nname: ${m.name}\ndescription: ${m.description}\nmetadata:\n  type: ${m.type}\n  engram:\n    graduated:\n      to: ${to}\n      at: ${day(1)}\n---\n\n${m.body}`; };
  const sudoRule = { id: 'mem-no-sudo-npm', tool: 'Bash', pattern: '(?:^|[\\s;&|(])sudo[ \\t]+npm\\b', flags: '', unless: '', action: 'hint', message: L('不要用 sudo 執行 npm；全域套件改用 nvm 管理的 Node 安裝。', 'Never run npm with sudo; install global packages with the Node managed by nvm.'), source: sudoRef, addedAt: day(1), by: 'autopilot' };

  const hold = (x) => ({ v: 1, machine: self.id, task: 'curate', pid: null, kind: 'rejected', ref: null, reason: '', why: '', action: 'update', category: 'update', risk: 'medium', scope: 'global', flags: [], ops: [], evidence: [], attempts: 0, status: 'held', lastReviewAt: null, local: false, secret: false, ...x });
  let holding = V.holding === 'empty' ? [] : [
    hold({
      id: 'hd-20261119-031522-k7m2', at: ago(60 * 26), run: 'ap-20261119-031002-q2w4', ref: deployRef,
      title: L('部署時段改成每週四晚上', 'Move the deployment window to Thursday evenings'),
      reason: L('最近兩場對話都在週四晚上部署，使用者也說「之後部署都改到週四晚上」。記憶還寫著週二。', 'The last two conversations both deployed on Thursday evening, and the user said "from now on, deploy on Thursday evenings". The memory still says Tuesday.'),
      why: L('審核員沒有同意：「改到週四晚上」有使用者的原話佐證，但「22:00 之後」這個時間只出現在 AI 的推論裡。核心事實有依據，細節沒有。', 'The reviewer did not agree: "move it to Thursday evenings" is backed by what the user said, but "after 22:00" only appears in the AI\'s inference. The core fact is supported; the detail is not.'),
      grounded: true, keep: [L('部署時段改到週四晚上（使用者 2026-11-18 說的）', 'The deployment window moved to Thursday evenings (the user said so on 2026-11-18)')], attempts: 1, lastReviewAt: ago(60 * 2), local: true,
      ops: [{ op: 'write', ref: deployRef, content: rawWith(deployRef, L('正式環境每週四 22:00 之後部署（2026-11-18 起，避開週五早上的報表），部署前先在群組公告。\n\n**Why:** 白天有客戶在線上下單；週五早上要出週報。\n**How to apply:** 排部署時間時照這個時段。\n', 'Deploy to production on Thursdays after 22:00 (since 2026-11-18, to stay clear of the Friday morning report) and announce it in the team chat first.\n\n**Why:** Customers place orders during the day, and the weekly report runs on Friday morning.\n**How to apply:** Use this window when scheduling a deployment.\n')) }],
      evidence: [{
        quote: L('之後部署都改到週四晚上，避開週五早上的報表', 'From now on, deploy on Thursday evenings so we stay clear of the Friday morning report'), session: '4b7e21c9', date: day(3), fromUser: true,
        context: L('……（前面在討論上週五報表延遲）\n使用者：之後部署都改到週四晚上，避開週五早上的報表\nClaude：好的，我會把部署排程改到週四晚上。需要固定幾點開始嗎？\n使用者：先這樣，時間再看。', '... (they had been discussing last Friday\'s late report)\nUser: From now on, deploy on Thursday evenings so we stay clear of the Friday morning report\nClaude: Got it, I will move the deployment schedule to Thursday evening. Should it start at a fixed time?\nUser: That\'s enough for now; we\'ll see about the time.'),
      }],
    }),
    hold({
      id: 'hd-20261119-032210-p3x8', at: ago(60 * 25), run: 'ap-20261119-031002-q2w4', kind: 'cross-scope', task: 'dream', pid, action: 'create', category: 'dream-create', scope: 'global', local: true,
      title: L('新增全域偏好：CSV 匯出一律加 UTF-8 BOM', 'Add a global preference: CSV exports always get a UTF-8 BOM'),
      reason: L('使用者在訂單系統的對話裡兩次要求 CSV 要加 BOM，Excel 才不會把中文開成亂碼；這是每個專案都適用的做法。', 'In the order system conversations the user asked twice for a BOM on CSV files so that Excel opens them correctly. This applies to every project.'),
      why: L('這是全域的事，但這一輪的對話回顧只處理「{project}」這個專案；之後整理全域記憶時會再審一次。', 'This belongs in global memory, but this run of the conversation review only covered the "{project}" project. It will be reviewed again when global memories are tidied.').replace('{project}', o.projectName(pid)),
      ops: [{ op: 'create', scope: 'global', content: fm('csv-utf8-bom', L('CSV 匯出一律加 UTF-8 BOM', 'CSV exports always get a UTF-8 BOM'), 'feedback', L('匯出 CSV 時一律加上 UTF-8 BOM，否則 Excel 會用系統編碼開啟，中文變成亂碼。\n\n**Why:** 使用者與客戶都用 Excel 直接開 CSV。\n**How to apply:** 任何專案產生 CSV 檔時都加 BOM。\n', 'Always add a UTF-8 BOM when exporting CSV; otherwise Excel opens the file in the system code page and non-English text turns into garbage.\n\n**Why:** The user and the clients open CSV files directly in Excel.\n**How to apply:** Add the BOM whenever any project writes a CSV file.\n')) }],
      evidence: [{ quote: L('CSV 記得加 BOM，不然客戶用 Excel 開又是亂碼', 'Remember the BOM on the CSV, or the client will see garbage in Excel again'), session: '9d02aa41', date: day(4), fromUser: true, context: L('使用者：CSV 記得加 BOM，不然客戶用 Excel 開又是亂碼\nClaude：已經在匯出時寫入 UTF-8 BOM（EF BB BF）。', 'User: Remember the BOM on the CSV, or the client will see garbage in Excel again\nClaude: The export now writes a UTF-8 BOM (EF BB BF).') }],
    }),
    hold({
      id: 'hd-20261118-221405-w9e1', at: ago(60 * 31), kind: 'reverted', task: 'review', ref: tempRef, scope: 'global',
      title: L('被退回的版本：temp-note', 'The version that was reverted: temp-note'),
      reason: L('Claude 在對話中寫進全域記憶的內容。', 'What Claude wrote into a global memory during a conversation.'),
      why: L('退回之前先存下來：這段設定只適用單一專案，寫在全域會影響每個專案。需要的話可以採用，把這個版本放回去。', 'Saved before it was reverted: this setting only applies to one project, and in global memory it would affect every project. Adopt it if you want this version back.'),
      ops: [{ op: 'write', ref: tempRef, content: rawWith(tempRef, L('測試資料庫只在公司網路內連得到。\n訂單系統的測試帳號固定用 qa-order-01。\n', 'The test database is only reachable from the office network.\nThe order system always uses the test account qa-order-01.\n')) }],
    }),
    hold({
      id: 'hd-20261117-030118-z2c5', at: ago(60 * 24 * 3 + 40), kind: 'rejected', task: 'curate', pid, ref: dbA, scope: `project:${pid}`, action: 'merge', category: 'merge', risk: 'high', attempts: 2, lastReviewAt: ago(60 * 26), local: true, secret: true,
      title: L('把兩筆資料庫筆記合併成一筆', 'Merge the two database notes into one'),
      reason: L('兩筆都在講同一個測試資料庫，分開放讓 Claude 常常只讀到其中一筆。', 'Both describe the same test database; kept apart, Claude often reads only one of them.'),
      why: L('審核員沒有同意：合併後少了「備份保留 14 天」這個數字（會遺失：保留天數）。', 'The reviewer did not agree: the merged text drops "backups are kept for 14 days" (would lose: the retention period).'),
      ops: [{ op: 'merge', refs: [dbA, dbB], into: dbA, content: rawWith(dbA, L('測試資料庫：db-test.internal:5432（唯讀帳號的權杖：‹已遮蔽：GitHub 個人存取權杖›）。\n備份每天 02:00 執行。\n', 'Test database: db-test.internal:5432 (read-only token: ‹redacted: GitHub personal access token›).\nBackups run daily at 02:00.\n')) }],
    }),
    // 記憶畢業的提案（與 app/src/autopilot/tasks/graduate.mjs 存進保留區的形狀相同）
    hold({
      id: 'hd-20261118-030744-g5r1', at: ago(60 * 24 + 50), run: 'ap-20261118-030102-m8n4', task: 'graduate', ref: sudoRef, action: 'graduate', category: 'guardrail', risk: 'medium',
      title: L('記憶畢業成護欄提醒：不要用 sudo 執行 npm', 'Graduate into a guardrail reminder: never run npm with sudo'),
      reason: L('這筆記憶寫的是一條指令寫法的規矩，變成護欄提醒之後，Claude 在下這類指令時就會看到，不必靠記得索引。', 'This memory is a rule about how to write a command. As a guardrail reminder, Claude sees it right when it runs such a command instead of having to remember the index.'),
      why: L('審核員沒有同意：樣式也會命中「sudo npm」出現在說明文字裡的指令，提醒可能太頻繁。', 'The reviewer did not agree: the pattern also matches commands that only mention "sudo npm" in a message, so the reminder may show up too often.'),
      graduate: { to: 'guardrail', ref: sudoRef, sha: 'a3f91c07b2d4', title: 'no-sudo-npm', rule: sudoRule },
      ops: [{ op: 'guardrail', content: JSON.stringify(sudoRule, null, 2) }, { op: 'graduate', ref: sudoRef, to: 'guardrail', content: graduatedRaw(sudoRef, 'guardrail') }],
    }),
    hold({
      id: 'hd-20261118-030751-e2v6', at: ago(60 * 24 + 49), run: 'ap-20261118-030102-m8n4', task: 'graduate', ref: outputRef, action: 'graduate', category: 'env', risk: 'high',
      title: L('記憶畢業成環境設定：Bash 輸出上限調到 80000', 'Graduate into an environment setting: raise the Bash output limit to 80000'),
      reason: L('這筆記憶記的是 Claude Code 的一個環境變數，放進環境設定之後每台電腦核可一次就會自動套用。', 'This memory records a Claude Code environment variable. In the environment settings, each computer applies it automatically after approving it once.'),
      why: L('環境設定檔已經有 BASH_MAX_OUTPUT_LENGTH，留給你決定要不要改', 'The environment profile already has BASH_MAX_OUTPUT_LENGTH, so the decision is left to you'),
      graduate: { to: 'env', ref: outputRef, sha: '5be20d9a4c11', title: 'bash-output-limit', env: { area: 'env', key: 'BASH_MAX_OUTPUT_LENGTH', value: '80000' } },
      ops: [{ op: 'env', content: JSON.stringify({ area: 'env', key: 'BASH_MAX_OUTPUT_LENGTH', value: '80000' }, null, 2) }, { op: 'graduate', ref: outputRef, to: 'env', content: graduatedRaw(outputRef, 'env') }],
    }),
    hold({
      id: 'hd-20261115-031540-a8b3', at: ago(60 * 24 * 6), status: 'adopted', adoptedAt: ago(60 * 24 * 5), kind: 'rejected', ref: 'global/weekly-sync.md',
      title: L('更新「團隊週會時間」', 'Update "team weekly meeting time"'), why: L('審核員沒有同意：只有一次提到。', 'The reviewer did not agree: it was mentioned only once.'),
      ops: [{ op: 'write', ref: 'global/weekly-sync.md', content: fm('weekly-sync', L('團隊週會時間', 'Team weekly meeting'), 'project', L('週會改到週一 10:00。\n', 'The weekly meeting moved to Monday 10:00.\n')) }],
    }),
    hold({
      id: 'hd-20261114-030212-c4d6', at: ago(60 * 24 * 7), status: 'dismissed', dismissedAt: ago(60 * 24 * 6), kind: 'rejected', ref: 'global/report-template.md', action: 'archive', category: 'archive', risk: 'high',
      title: L('封存「舊的報表範本」', 'Archive "old report template"'), why: L('審核員沒有同意：還有一個專案在用。', 'The reviewer did not agree: one project still uses it.'),
      ops: [{ op: 'remove', ref: 'global/report-template.md' }],
    }),
  ];
  // ?holding=core 的兩項：記憶畢業成核心準則的一行（採用的結果見 holdingAdopt）
  const coreDemo = new Map();
  if (V.holding === 'core') {
    const bulletsRef = 'global/answer-in-bullets.md';
    const coreItem = (id, title, titleEn, kind) => {
      coreDemo.set(id, kind);
      const line = L('回覆用條列，結論放在最前面。', 'Answer in bullet points, with the conclusion first.');
      return hold({
        id, at: ago(60 * 18), run: 'ap-20261120-030102-c1c1', task: 'graduate', ref: bulletsRef, action: 'graduate', category: 'core', risk: 'medium',
        title: L(title, titleEn), reason: L('這筆記憶寫的是每次對話都要遵守的做法，寫成核心準則的一行，Claude 每次都會看到。', 'This memory is a rule to follow in every conversation. As a line in the core rules, Claude sees it every time.'),
        why: L('審核員沒有同意：核心準則已經有一行很像的。', 'The reviewer did not agree: the core rules already have a similar line.'),
        graduate: { to: 'core', ref: bulletsRef, sha: hex(seq + 3, 12), title: 'answer-in-bullets', line },
        ops: [{ op: 'graduate', ref: bulletsRef, to: 'core', content: fm('answer-in-bullets', L('回覆用條列', 'Answer in bullet points'), 'feedback', `${line}\n`) }],
      });
    };
    holding.unshift(
      coreItem('hd-20261120-031012-c0a1', '記憶畢業成核心準則的一行：回覆用條列', 'Graduate into a core rules line: answer in bullet points', 'claude'),
      coreItem('hd-20261120-031013-c0b2', '記憶畢業成核心準則的一行：結論先寫', 'Graduate into a core rules line: conclusion first', 'rejected'),
    );
  }
  const tidyFor = (h, beforeText) => {
    const id = `${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${String(100000 + seq++).slice(1)}-hd${seq}`;
    const op = h.ops[0];
    return {
      v: 1, id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appliedAt: new Date().toISOString(), machine: self.id, scope: 'all', request: '', status: 'done',
      summary: L(`採用保留區的項目：${h.title}`, `Adopted from the holding area: ${h.title}`), highlights: [], kept: [], backup: 'C:\\Users\\you\\.engram\\local\\backups\\holding',
      texts: op.ref ? { [op.ref]: beforeText ?? '' } : {},
      items: [{ id: 'i1', group: null, description: '', base: 'demo', ref: op.op === 'create' ? null : op.ref, name: (op.ref ?? 'new-memory').split('/').pop().replace(/\.md$/, ''), scope: h.scope, type: 'project', action: h.action === 'create' ? 'create' : h.action, title: h.title, reason: h.reason, evidence: h.evidence.map((e) => ({ quote: e.quote, date: e.date, session: e.session })), ops: clone(h.ops), decision: 'accept', note: '', changed: [], result: { status: 'done', undo: [hex(seq, 8)], at: new Date().toISOString() } }],
    };
  };

  // ── 環境健檢 ───────────────────────────────────────
  const P = (name) => `${name}@example-market`;
  const fingerprint = {
    v: 1, updated: day(0),
    claudeCode: { version: '2.1.329' }, engram: { version: '2.0.0', commit: 'a1b2c3d' },
    settings: { present: true, keys: ['enabledPlugins', 'env', 'hooks', 'model', 'permissions'], envKeys: ['BASH_MAX_OUTPUT_LENGTH'], enabledPlugins: { 'engram@engram-local': true, [P('chart-helper')]: true, [P('slow-telemetry')]: true, [P('old-diagram')]: true, [P('legacy-formatter')]: false }, hooks: [], cleanupPeriodDays: null },
    plugins: ['engram@engram-local', P('chart-helper'), P('slow-telemetry'), P('old-diagram'), P('legacy-formatter')].map((k) => ({ name: k.split('@')[0], marketplace: k.split('@')[1], version: '1.0.0', hooks: [] })),
    skills: [{ name: 'release-notes', files: 2, hash: hex(3) }], agents: [], commands: [],
    claudeMd: { bytes: 2412, hash: hex(5), blocks: [{ name: 'engram' }] },
    hookStats: { windowDays: 7, hooks: [] },
  };
  const card = (id, code, severity, zh, enx, fix) => ({ id, code, severity, title: zh[0], detail: zh[1], refs: [], ...(fix ? { fix: { action: 'env-fix', args: { id }, label: fix[0], en: { label: fix[1] } } } : {}), en: { title: enx[0], detail: enx[1] } });
  let envFindings = [
    card('H25:7a1c90e2d4', 'H25', 'medium',
      ['「slow-telemetry@example-market」的同步 hook 讓每次操作變慢', 'PreToolUse 每次約 1.2 秒（近 7 天 412 次，累計 8 分 14 秒）。同步執行的 hook 會讓 Claude 等它跑完才繼續，近 7 天共多等了 8 分 14 秒。建議關閉該外掛的遙測、改成背景執行，或停用該外掛。'],
      ['A synchronous hook from "slow-telemetry@example-market" slows down every action', 'PreToolUse takes about 1.2 s each time (412 runs in the last 7 days, 8 min 14 s in total). A synchronous hook makes Claude wait until it finishes, which added 8 min 14 s over the last 7 days. Turn off the plugin\'s telemetry, make the hook run in the background, or disable the plugin.']),
    card('H31:3e8b51f0a7', 'H31', 'medium',
      ['~/.claude 底下有 1 個檔案或資料夾疑似存放明文金鑰', 'settings.local-backup.json。明文金鑰留在設定檔裡，備份、截圖或分享設定時容易外洩；建議改放環境變數或系統的憑證保管。Engram 不會讀取或改動這些檔案的內容。'],
      ['1 file or folder under ~/.claude may hold plaintext secrets', 'settings.local-backup.json. Plaintext keys in settings files leak easily through backups, screenshots or shared settings; keep them in environment variables or the system credential store instead. Engram does not read or change the content of these files.']),
    card('H32:c41d2f8e90', 'H32', 'low',
      ['沒有設定對話紀錄的保留天數', 'Claude Code 預設在 30 天後清除對話紀錄；自動駕駛的對話回顧晚一點就失去驗證記憶的依據。建議在 settings.json 設定 cleanupPeriodDays 為 60（只新增這個設定，其他部分逐位元不變，解除安裝時會還原）。自動駕駛開啟時 Engram 會自己設。'],
      ['The conversation retention period is not set', 'Claude Code deletes conversation transcripts after 30 days by default, so a conversation review that comes late loses the source it checks memories against. Setting cleanupPeriodDays to 60 in settings.json is recommended (only this setting is added, everything else stays byte for byte, and uninstalling restores it). Engram sets it by itself when autopilot is on.'],
      ['設成 60 天', 'Set it to 60 days']),
    card('H26:91f0b2c3d4', 'H26', 'auto',
      ['Claude Code 的設定裡有 2 個已不存在的路徑', 'Engram 之前加進 permissions.additionalDirectories 的 ~/Desktop/old-site/memory、~/Work/demo-app/memory 已經不存在（例如專案解除綁定後留下的）。移除後不影響任何記憶；修改前會先備份 settings.json。'],
      ['The Claude Code settings list 2 paths that no longer exist', '~/Desktop/old-site/memory, ~/Work/demo-app/memory in permissions.additionalDirectories (added by Engram earlier) no longer exist, for example links left behind after a project was unbound. Removing them does not affect any memory; settings.json is backed up first.'],
      ['移除失效的路徑', 'Remove the dead paths']),
    card('H33:5d6e7f8091', 'H33', 'low',
      ['1 個外掛近 30 天沒有被使用過', 'old-diagram@example-market：近 30 天的對話紀錄裡沒有呼叫它的工具、技能、代理或指令。沒在用的外掛仍會載入、佔用上下文；可以考慮停用（Engram 不會自動停用）。'],
      ['1 plugin was not used in the last 30 days', 'old-diagram@example-market: no tool, skill, agent or command of it was called in the last 30 days of conversations. Unused plugins are still loaded and take up context; consider disabling it (Engram will not disable it for you).']),
    card('H29:0a9b8c7d6e', 'H29', 'auto',
      ['記憶庫需要打包', '零散物件有 2,340 個（超過 2000）。背景的「記憶庫打包」工作會在電腦閒置時處理，不需要你動手。'],
      ['The memory vault needs repacking', 'there are 2,340 loose objects (over 2000). The background repack job handles it while the computer is idle; you do not need to do anything.']),
  ];
  const diff = {
    machines: [{ mid: self.id, label: self.label, self: true, updated: day(0), hasEnv: true }, { mid: other.id, label: other.label, self: false, updated: day(1), hasEnv: true }],
    compared: 2,
    items: [
      ['claude-code', 'Claude Code', 'version', '2.1.329', '2.1.322', self.id],
      ['engram', 'Engram', 'version', '2.0.0', '1.6.0', self.id],
      ['plugin', P('chart-helper'), 'version', '1.4.0', '1.2.1', self.id],
      ['plugin', P('slow-telemetry'), 'missing', '0.9.0', null, null],
      ['plugin', P('pdf-tools'), 'missing', null, '2.3.0', null],
      ['skill', 'release-notes', 'hash', hex(3), hex(4), other.id],
      ['skill', 'meeting-summary', 'missing', null, hex(6), null],
      ['claude-md', 'CLAUDE.md', 'hash', hex(5), hex(7), self.id],
      ['setting-key', 'cleanupPeriodDays', 'missing', null, 'present', null],
      ['env-key', 'BASH_MAX_OUTPUT_LENGTH', 'missing', 'present', null, null],
    ].map(([area, key, kind, a, b, newer]) => ({ area, key, kind, values: { [self.id]: a, [other.id]: b }, newer, summary: `${key}`, en: { summary: `${key}` } })),
  };

  // ── 環境設定同步 ───────────────────────────────────
  const profileDoc = V.envsync === 'none' ? { present: false, problem: null, profile: { v: 1, env: {}, settings: {}, skills: [], plugins: [], updatedAt: null, by: null }, overrides: { present: false, problem: null, skip: [], env: {}, settings: {} }, blocked: [], whitelist: ['model', 'effortLevel', 'language', 'theme', 'cleanupPeriodDays', 'autoUpdatesChannel', 'editorMode'] } : {
    present: true, problem: null,
    profile: {
      v: 1, env: { BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_OUTPUT_LENGTH: '60000', PAGER_STYLE: 'plain --no-color --wrap=120 --tab-width=4' },
      settings: { cleanupPeriodDays: 60, effortLevel: 'high', model: 'opus' },
      skills: ['meeting-summary', 'release-notes'],
      plugins: [{ name: 'chart-helper', marketplace: 'example-market' }, { name: 'engram', marketplace: 'engram-local' }, { name: 'pdf-tools', marketplace: 'example-market' }],
      updatedAt: ago(60 * 20), by: other.id,
    },
    overrides: { present: false, problem: null, skip: [], env: {}, settings: {} },
    blocked: [
      { area: 'setting', key: 'statusLine', reason: 'not-allowed', message: '不在可以同步的設定白名單裡（statusLine 會定期執行指令）', en: { message: 'not on the list of settings that can sync (statusLine runs a command periodically)' } },
      { area: 'env', key: 'NODE_OPTIONS', reason: 'denied-name', message: '這個環境變數會改變程式的執行方式，不會同步', en: { message: 'this environment variable changes how programs run, so it is not synced' } },
      { area: 'env', key: 'SEARCH_API_KEY', reason: 'secret-name', message: '名稱像金鑰（含 KEY、TOKEN、SECRET、PASSWORD），不會同步', en: { message: 'the name looks like a secret (contains KEY, TOKEN, SECRET or PASSWORD), so it is not synced' } },
    ],
    whitelist: ['model', 'effortLevel', 'language', 'theme', 'cleanupPeriodDays', 'autoUpdatesChannel', 'editorMode'],
  };
  const it = (area, key, action, x = {}) => ({ area, key, action, ...x, summary: `${area}:${key}`, en: { summary: `${area}:${key}` } });
  let planItems = V.envsync === 'none' ? [] : [
    it('setting', 'cleanupPeriodDays', 'add', { from: null, to: '60', hash: hex(11), approved: true }),
    it('setting', 'model', 'update', { from: 'sonnet', to: 'opus', hash: hex(12), approved: false }),
    it('env', 'BASH_DEFAULT_TIMEOUT_MS', 'add', { from: null, to: '600000', hash: hex(13), approved: false }),
    it('env', 'PAGER_STYLE', 'add', { from: null, to: 'plain --no-color --wrap=120 --tab-width=4', hash: hex(14), approved: false }),
    it('skill', 'meeting-summary', 'add', { files: 3, hash: hex(15), approved: false }),
    it('plugin', P('pdf-tools'), 'missing'),
    it('plugin', P('chart-helper'), 'version', { local: '1.4.0', others: { [other.label]: '1.2.1' }, newer: self.id }),
  ];
  let unused = [{ key: P('old-diagram'), name: 'old-diagram', installedAt: ago(60 * 24 * 80) }];
  // settings.json 的 enabledPlugins（目前的值；環境指紋裡的是每天檢查時的快照）
  const plugins = { ...fingerprint.settings.enabledPlugins };
  let applies = [];
  const plan = () => {
    const changes = planItems.filter((i) => ['add', 'update', 'restore'].includes(i.action) && i.approved !== false).length;
    return {
      v: 1, at: new Date().toISOString(), envSync: settings.envSync ?? 'report',
      profile: { present: profileDoc.present, updatedAt: profileDoc.profile.updatedAt, by: profileDoc.profile.by }, overrides: { present: false }, settingsFormat: 'ok',
      items: clone(planItems), blocked: clone(profileDoc.blocked), unused: { known: true, windowDays: 30, plugins: clone(unused) },
      disabledPlugins: Object.keys(plugins).filter((k) => plugins[k] === false).sort(),
      changes, pending: planItems.filter((i) => i.approved === false).length,
    };
  };

  // ── 護欄 ─────────────────────────────────────────
  const synced = {
    id: 'git-push-force', tool: 'Bash', pattern: /(?:^|[\s;&|(])git[ \t]+push\b[^\n|;&]*[ \t](?:--force|-f)(?=\s|$)/.source, flags: '', unless: /--force-with-lease/.source, action: 'block',
    message: '不要對共用分支用 git push --force，請改用 --force-with-lease，或先問使用者。', messageEn: RULE_EN['git-push-force'], source: L(`從「${other.label}」同步來的規則`, `A rule synced from "${other.label}"`), addedAt: day(2), by: other.id,
  };
  // 規則檔：內建的 6 條，加上一條從另一台同步來、還沒在這台核可的擋下規則（核可之前只當提醒，與 core/guardrails.mjs 相同）
  // ?guard=skipped：規則檔裡還有兩條寫壞的規則（沒有載入的原因來自 guard.mjs 的 compileRules，與實際相同）
  const broken = V.guard === 'skipped' ? [
    { id: 'npm-publish-hint', tool: 'Bash', pattern: 'npm publish(', action: 'hint', message: 'npm publish' },
    { id: 'git-push-force', tool: 'Bash', pattern: 'a', action: 'hint', message: 'git push' },
  ] : [];
  const { entries, skipped } = compileRules([...DEFAULT_RULES, synced, ...broken]);
  let approvals = {};
  // [命中, 擋下, 提醒, 誤擋, 擋對, 太慢]
  const usage = { 'inline-script-double-backslash': [9, 9, 0, 0, 6, 0], 'inline-script-cjk': [14, 0, 14, 0, 0, 0], 'powershell-command-shell-variable': [3, 3, 0, 1, 1, 0], 'msys-path-conversion': [5, 0, 5, 0, 0, 0], 'rm-shell-variable': [2, 0, 2, 0, 0, 0] };
  const demotedAt = now - 4 * 864e5;
  let overrides = { 'powershell-command-shell-variable': { action: 'hint', at: new Date(demotedAt).toISOString(), reason: 'falseBlock', until: falseBlockUntil(new Date(demotedAt).toISOString()) } };
  if (V.guard === 'hint' || V.guard === 'off') settings.guardrails = V.guard;
  const guardMode = () => settings.guardrails ?? 'block';
  const ruleOut = (entry) => {
    const { rule } = entry;
    const [hits, blocks, hints, falseBlocks, confirmed, slow] = usage[rule.id] ?? [0, 0, 0, 0, 0, 0];
    const approval = approvalState(entry, approvals);
    return {
      ...rule, effective: effectiveAction(rule, { mode: guardMode(), overrides, now: Date.now(), unapproved: approval === 'pending' }), approval,
      override: activeOverride(overrides, rule.id, Date.now()), hits, blocks, hints, falseBlocks, confirmed, slow,
      ...(en && RULE_SOURCE_EN[rule.id] ? { en: { source: RULE_SOURCE_EN[rule.id] } } : {}),
    };
  };

  // ── 偏好區塊的候選：常用、但目前內容還沒由使用者本人確認的其他記憶（形狀與 app/src/autopilot/prompts.mjs 的 confirmCandidates 相同） ──
  // 記憶本身要在記憶庫裡（「看全文」讀得到）：展示資料已經有同名的就用它的，沒有就補上（內容與展示資料相同）。
  // 記憶畢業判斷適合寫進核心準則或成為護欄規則的（graduation: 'core'｜'guardrail'）排最前面。
  const candMem = (name, type, scope, description, body) => ({ ...mem(`${scope.kind === 'machine' ? `machines/${self.id}` : 'global'}/${name}.md`, name, description, type, body, scope), updatedAt: ago(60 * 24 * 12) });
  const candidatesAll = [
    [candMem('review-checklist', 'reference', { kind: 'global' }, L('送出程式碼審查之前要檢查的項目', 'What to check before asking for a code review'), L('- 測試已新增或更新\n- 差異裡沒有金鑰或本機路徑\n- 資料庫遷移有退回的做法\n- 介面變更附上截圖', '- Tests added or updated\n- No secrets or local paths in the diff\n- Migration has a rollback\n- Screenshots for UI changes')), 'claude', 0, 0, 'core'],
    [candMem('node-install-path', 'reference', { kind: 'machine', mid: self.id }, L('Node.js 22 用 fnm 安裝，全域套件放在 fnm 資料夾', 'Node.js 22 is installed with fnm; global packages live in the fnm folder'), L('Node.js 22 用 fnm 安裝。全域 npm 套件在 `%LOCALAPPDATA%\\fnm_multishells` 底下。', 'Node.js 22 via fnm. Global npm packages are under `%LOCALAPPDATA%\\fnm_multishells`.')), 'none', 14, 6],
    [candMem('proxy-settings', 'reference', { kind: 'machine', mid: self.id }, L('git 與 npm 使用的公司網路代理', 'Office network proxy for git and npm'), L('git 與 npm 透過公司代理 `http://proxy.acme.local:8080` 連線。', 'git and npm use the office proxy `http://proxy.acme.local:8080`.')), 'request', 9, 4, 'guardrail'],
    [candMem('disk-layout', 'reference', { kind: 'machine', mid: self.id }, L('C 槽是系統 SSD，大型專案與 Docker 資料放 D 槽', 'C: is the system SSD; large repos and Docker data live on D:'), L('大型專案與 Docker 資料放在 D 槽，節省 C 槽的空間。', 'Keep large repositories and Docker data on D: to save space on C:.')), 'autopilot', 3, 1],
  ].map(([m, source, reads, recalled, core], i) => {
    const have = o.findMemory(m.ref);
    if (!have) o.addMemory(m);
    const x = have ?? m;
    return { ref: x.ref, sha: hex(40 + i, 40), name: x.name, description: x.description, type: x.type, scope: x.scope.kind, source, reads, recalled, ...(core ? { graduation: core } : {}) };
  }).sort((a, b) => (b.graduation ? 1 : 0) - (a.graduation ? 1 : 0) || (b.reads + b.recalled) - (a.reads + a.recalled) || a.ref.localeCompare(b.ref)); // 排序與 confirmCandidates 相同
  // 還沒採用的偏好裡，記憶畢業想寫進核心準則或成為護欄規則的（graduation: 'core'｜'guardrail'）
  const prefPendingAll = [
    { ref: 'global/meeting-notes-format.md', sha: 'demo2', name: 'meeting-notes-format', description: L('會議紀錄：決議在前、待辦在後', 'Meeting notes: decisions first, then action items'), type: 'feedback', source: 'autopilot', graduation: 'core' },
    { ref: 'global/lint-before-commit.md', sha: 'demo1', name: 'lint-before-commit', description: L('提交前先跑 lint 與單元測試', 'Run lint and unit tests before committing'), type: 'feedback', source: 'claude', graduation: 'guardrail' },
  ];

  // ── 每週摘要 ───────────────────────────────────────
  const monday =(d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  // 摘要是整理「已經過完的一週」：最新的一份是上一週
  const thisWeek = monday(now - 7 * 864e5);
  const weeks = [thisWeek, monday(now - 14 * 864e5), monday(now - 21 * 864e5)];
  const digestOf = (week) => {
    const i = weeks.indexOf(week);
    if (i < 0) return null;
    const base = { week, generatedAt: new Date(Date.parse(`${week}T00:00:00Z`) + 7 * 864e5 + 2 * 3600e3).toISOString(), previous: weeks.filter((w) => w < week) };
    if (i > 0) {
      return { ...base, learned: { created: [{ ref: 'global/git-commit-style.md', title: L('提交訊息用祈使句', 'Commit messages use the imperative mood') }], updated: [] }, graduated: [], holding: { held: 2, withCore: 0 }, preferences: { used: 3, pending: 1 }, guardrails: { blocked: 4, hinted: 9, falseBlocks: 0 }, recall: { surfaced: 15, opened: 4 }, env: { findings: [] }, autopilot: { runs: 7, costUsd: 2.41, stopped: [] } };
    }
    return {
      ...base,
      learned: {
        created: [
          { ref: `projects/${pid}/memory/report-csv-only.md`, title: L('報表一律輸出 CSV（客戶決定）', 'Reports are always CSV (client decision)') },
          { ref: 'global/meeting-notes-format.md', title: L('會議紀錄：決議在前、待辦在後', 'Meeting notes: decisions first, then action items') },
          { ref: 'global/docker-memory.md', title: L('跑整合測試前把 Docker Desktop 的記憶體調到 8 GB', 'Give Docker Desktop 8 GB of memory before running integration tests') },
        ],
        updated: [
          { ref: `projects/${pid}/memory/deploy-notes.md`, title: L('部署方式與主機', 'How to deploy and which hosts') },
          { ref: 'global/team-lead-role.md', title: L('使用者轉任產品設計，負責介面規格', 'The user moved to product design and owns the UI specs') },
        ],
      },
      graduated: [
        { ref: 'global/no-force-push.md', title: L('共用分支不要 force push', 'Never force-push a shared branch'), to: 'guardrail' },
        { ref: 'global/answer-in-bullets.md', title: L('回覆用條列', 'Answer in bullet points'), to: 'core' },
        { ref: 'global/conversation-retention.md', title: L('對話紀錄保留 60 天', 'Keep conversations for 60 days'), to: 'env' },
        { ref: 'global/october-launch.md', title: L('10 月上線的待辦', 'October launch to-dos'), to: 'archive' },
      ],
      holding: { held: holding.filter((h) => h.status === 'held').length, withCore: holding.filter((h) => h.status === 'held' && h.grounded).length },
      // 第三輪審查 B：graduation 是記憶畢業的現況（needsConfirm＝要你確認才能寫進核心準則的筆數，包含還沒採用的偏好與候選裡標了 core 的）；
      // preferences.candidates 是偏好區塊候選的筆數。更早的週沒有這兩個欄位
      graduation: { candidates: 6, needsConfirm: [...prefPendingAll, ...candidatesAll].filter((x) => x.graduation).length, unconfirmed: 3 },
      preferences: { used: 4, pending: prefPendingAll.length, candidates: candidatesAll.length },
      guardrails: { blocked: 12, hinted: 21, falseBlocks: 1 },
      recall: { surfaced: 22, opened: 9 },
      env: { findings: envFindings.filter((f) => f.severity !== 'auto').slice(0, 3).map((f) => ({ code: f.code, title: en ? f.en.title : f.title })) },
      autopilot: { runs: 6, costUsd: 3.12, stopped: [{ at: ago(60 * 24 * 5 + 30), reason: 'busy' }, { at: ago(60 * 24 * 2 + 90), reason: 'limit' }] },
    };
  };

  // ── 情境召回、索引分層、自動更新、自動駕駛遵守的偏好 ─────
  if (V.layers === 'on') { settings.indexLayers = 'on'; settings.recall = 'on'; }
  const prefConfirmed = new Set();

  // ── 索引相容模式（第四輪審查；與 app/src/core/indexcompat.mjs 的 indexCompat 相同的形狀與說明）──
  // 記憶庫裡有「版本低於 2.0.0、近 7 天內有活動」的電腦時，共用的索引照舊版產生。展示版預設沒有（active: false）；?compat=on 讓另一台電腦是 1.6.0
  const compatMachines = V.compat === 'on' ? [{ mid: other.id, label: other.label, version: '1.6.0', lastActiveAt: ago(52) }] : [];
  const indexCompat = () => {
    if (!compatMachines.length) return { active: false, since: '2.0.0', machines: [] };
    const list = compatMachines.map((m) => `${m.label}（${m.version}）`).join('、');
    const listEn = compatMachines.map((m) => `${m.label} (${m.version})`).join(', ');
    return {
      active: true, since: '2.0.0', machines: clone(compatMachines),
      message: `索引目前是相容模式：${list} 還是舊版的 Engram（低於 2.0.0），共用的索引（全域 INDEX.md 與各專案的 MEMORY.md）暫時照舊版的方式產生，兩邊才不會輪流改寫。那幾台更新 Engram 之後會自動切換，不需要做任何事。`,
      en: { message: `Index compatibility mode is on: ${listEn} still run an older Engram (below 2.0.0), so the shared indexes (global INDEX.md and each project's MEMORY.md) are written the old way for now, which keeps the computers from rewriting each other's files. Once those computers are updated, it switches back by itself; there is nothing to do.` },
    };
  };

  const api = {
    async holding(f = {}) { await wait(80); return clone(holding.filter((h) => !f.status || h.status === f.status)); },
    async holdingAdopt(id) {
      await wait(300);
      const h = holding.find((x) => x.id === id);
      if (!h) throw fail(`保留區沒有這一項：${id}`, `No such item in the holding area: ${id}`, 'E_NOT_FOUND');
      if (h.status !== 'held') throw fail('這一項已經處理過了', `This item has already been ${h.status}`);
      // 展示：合併的那一項模擬「記憶在存進保留區之後被改過」
      if (h.action === 'merge') {
        throw fail(`「${h.title}」相關的記憶在存進保留區之後被修改過（或已經不在、已經有同名的），沒有採用；這一項留在保留區：${dbA} 在讀取之後被修改過`, `The memories behind "${h.title}" changed after it was held (or were removed, or a memory with that name now exists), so it was not adopted; it stays in the holding area`, 'E_CONFLICT', '看過目前的記憶後，需要的話把保留區裡的內容手動寫進去，或忽略這一項', 'Check the current memory, copy the held content in by hand if you still want it, or dismiss the item');
      }
      // ?holding=core：記憶畢業成核心準則的一行。來源記憶還沒由使用者本人確認時被拒絕、項目留著（與 autopilot/tasks/graduate.mjs 的 applyGraduation 相同的說明）；
      // 另一項模擬「在 Claude Code 裡採用」：核心準則改了、不記確認，回 coreUnconfirmed（從管理介面採用通常不會有）
      if (h.graduate?.to === 'core' && coreDemo.has(h.id)) {
        if (coreDemo.get(h.id) === 'rejected') {
          throw fail(`「${h.graduate.title}」目前的內容還沒由你本人確認，不能寫進核心準則；這一項留在保留區`, `The current content of "${h.graduate.title}" has not been confirmed by you, so it cannot go into the core rules; it stays in the holding area`, 'E_INVALID', '請先到管理介面「自動駕駛」頁的偏好區塊確認那筆記憶，再採用這一項', 'Confirm that memory first in the preference section of the Autopilot page in the dashboard, then adopt this item');
        }
        Object.assign(h, { status: 'adopted', adoptedAt: new Date().toISOString() });
        emit('change', { refs: [h.graduate.ref] });
        emit('autopilot', null);
        return { ok: true, id, record: null, item: null, undo: [], graduate: { to: 'core', ref: h.graduate.ref, title: h.graduate.title, at: new Date().toISOString(), line: h.graduate.line, shas: [hex(seq++, 40)], coreUnconfirmed: true }, coreUnconfirmed: true };
      }
      // 記憶畢業的提案：交給記憶畢業的流程，不建立整理記錄（與 core/holding.mjs 的 adoptLocked 相同的回傳）
      if (h.graduate) {
        Object.assign(h, { status: 'adopted', adoptedAt: new Date().toISOString() });
        emit('change', { refs: [h.graduate.ref] });
        emit('autopilot', null);
        return { ok: true, id, record: null, item: null, undo: [], graduate: { to: h.graduate.to, ref: h.graduate.ref, title: h.graduate.title, at: new Date().toISOString(), shas: [hex(seq++, 40)] } };
      }
      const op = h.ops[0];
      const cur = op.ref ? o.findMemory(op.ref) : null;
      const beforeText = cur ? rawOf(cur) : '';
      const bodyOf = (text) => text.replace(/^---[\s\S]*?\n---\n?/, '').replace(/^\n/, '');
      if (op.op === 'write' && cur) { cur.body = bodyOf(op.content); cur.updatedAt = new Date().toISOString(); }
      if (op.op === 'create') {
        const name = /^name:\s*(.+)$/m.exec(op.content)?.[1] ?? 'new-memory';
        const description = /^description:\s*(.+)$/m.exec(op.content)?.[1] ?? '';
        o.addMemory({ ...mem(`global/${name}.md`, name, description, 'feedback', bodyOf(op.content), { kind: 'global' }), updatedAt: new Date().toISOString() });
      }
      const rec = tidyFor(h, beforeText);
      o.addTidyRecord(rec);
      Object.assign(h, { status: 'adopted', adoptedAt: new Date().toISOString(), record: rec.id });
      emit('change', { refs: op.ref ? [op.ref] : [] });
      emit('autopilot', null);
      return { ok: true, id, record: rec.id, item: 'i1', undo: rec.items[0].result.undo };
    },
    async holdingDismiss(id) {
      await wait(150);
      const h = holding.find((x) => x.id === id);
      if (!h || h.status !== 'held') throw fail('這一項已經處理過了', 'This item has already been handled');
      Object.assign(h, { status: 'dismissed', dismissedAt: new Date().toISOString() });
      emit('autopilot', null);
      return { ok: true, item: clone(h) };
    },

    async env() {
      await wait(V.env === 'slow' ? 2500 : 120);
      return { envHealth: settings.envHealth ?? 'on', fingerprint: clone(fingerprint), findings: settings.envHealth === 'off' ? [] : clone(envFindings) };
    },
    async envDiff() { await wait(100); return clone(diff); },
    async envFix(id) {
      await wait(250);
      const f = envFindings.find((x) => x.id === id);
      if (!f) throw fail('這張卡片已經不存在，可能已經處理過了', 'This card no longer exists; it may already have been handled', 'E_NOT_FOUND', '重新整理收件匣', 'Refresh the inbox');
      if (!f.fix) throw fail('這一項只能提醒，沒有可以自動修正的動作', 'This item is a reminder only; there is nothing to fix automatically');
      envFindings = envFindings.filter((x) => x.id !== id);
      emit('finding', null);
      return f.code === 'H32' ? { ok: true, code: 'H32', changed: true, days: 60, backup: 'C:\\Users\\you\\.engram\\local\\env\\backups\\demo' } : { ok: true, code: f.code, removed: 2, backup: 'C:\\Users\\you\\.engram\\local\\env\\backups\\demo' };
    },
    async envProfile() { await wait(90); return clone(profileDoc); },
    async envPlan() { await wait(140); return plan(); },
    async envApprove(name, hash) {
      await wait(150);
      const waiting = planItems.filter((i) => i.approved === false);
      const picks = name === undefined ? waiting : waiting.filter((i) => name === i.key || name === `${i.area}:${i.key}`);
      if (!picks.length) throw fail(`沒有等待核可的項目：${name}`, `No item is waiting for approval: ${name}`, 'E_NOT_FOUND');
      if (hash && picks.some((i) => i.hash !== hash)) throw fail('內容在你看過之後又變了，沒有核可', 'The content changed after you looked at it, so it was not approved', 'E_CONFLICT');
      for (const i of picks) i.approved = true;
      emit('change', {});
      return { ok: true, count: picks.length, approved: picks.map((i) => ({ area: i.area, key: i.key, hash: i.hash })) };
    },
    async envApply() {
      await wait(400);
      const done = planItems.filter((i) => ['add', 'update', 'restore'].includes(i.action) && i.approved !== false);
      if (!done.length) return { ok: true, applied: 0, pending: planItems.filter((i) => i.approved === false).length, items: [] };
      planItems = planItems.filter((i) => !done.includes(i));
      applies.push({ id: `apply-${seq++}`, kind: 'apply', items: done });
      emit('change', {});
      return { ok: true, id: applies.at(-1).id, applied: done.length, pending: planItems.filter((i) => i.approved === false).length, backup: 'C:\\Users\\you\\.engram\\local\\env\\backups\\demo', items: clone(done) };
    },
    async envUndo() {
      await wait(300);
      const last = applies.pop();
      if (!last) throw fail('沒有可以還原的環境設定套用', 'There is no environment change to undo', 'E_NOT_FOUND');
      if (last.kind === 'apply') planItems = [...last.items, ...planItems];
      if (last.kind === 'plugin') {
        plugins[last.key] = !last.enabled;
        if (last.enabled === false) unused = [...unused, last.entry].filter(Boolean);
      }
      emit('change', {});
      return { ok: true, id: last.id, kind: last.kind, restored: last.kind === 'apply' ? last.items.length : 1, kept: [] };
    },
    async envProfileAction(action, name) {
      await wait(150);
      const pf = profileDoc.profile;
      const ov = profileDoc.overrides;
      const same = (i, item) => item === i.key || item === `${i.area}:${i.key}`;
      if (action === 'skip' || action === 'unskip') {
        const skip = action === 'skip';
        if (ov.skip.includes(name) === skip) return { ok: true, changed: false, item: name, skip };
        ov.skip = skip ? [...ov.skip, name] : ov.skip.filter((s) => s !== name);
        ov.present = true;
        planItems = planItems.map((i) => (!same(i, name) ? i : skip ? { ...it(i.area, i.key, 'skip', { reason: 'skip' }), was: i } : i.was ?? i));
        emit('change', {});
        return { ok: true, changed: true, item: name, skip };
      }
      const setting = name.startsWith('setting:');
      const key = setting ? name.slice(8) : name;
      const area = action === 'remove-skill' ? 'skill' : action === 'remove-plugin' ? 'plugin' : setting ? 'setting' : 'env';
      if (area === 'setting') delete pf.settings[key];
      else if (area === 'env') delete pf.env[key];
      else if (area === 'skill') pf.skills = pf.skills.filter((s) => s !== key);
      else pf.plugins = pf.plugins.filter((p) => `${p.name}@${p.marketplace}` !== key && p.name !== key);
      planItems = planItems.filter((i) => !(i.area === area && (i.key === key || i.key.split('@')[0] === key)));
      pf.updatedAt = new Date().toISOString();
      pf.by = self.id;
      emit('change', {});
      return { ok: true, changed: true, key, area };
    },
    async envPlugin(name, enabled) {
      await wait(200);
      // 和真的一樣：改的是 settings.json，環境指紋（GET /api/env）是每天的快取，不會跟著變
      const key = name.includes('@') ? name : Object.keys(plugins).find((k) => k.split('@')[0] === name);
      if (!key || !(key in plugins)) throw fail(`找不到外掛：${name}`, `Plugin not found: ${name}`, 'E_NOT_FOUND');
      if (plugins[key] === enabled) return { ok: true, changed: false, key, enabled };
      plugins[key] = enabled;
      const entry = unused.find((p) => p.key === key);
      if (!enabled) unused = unused.filter((p) => p.key !== key);
      applies.push({ id: `plugin-${seq++}`, kind: 'plugin', key, enabled, entry });
      emit('change', {});
      return { ok: true, changed: true, key, enabled, id: applies.at(-1).id, backup: 'C:\\Users\\you\\.engram\\local\\env\\backups\\demo' };
    },

    async guardrails() {
      await wait(100);
      const rules = entries.map(ruleOut);
      const totals = { hits: 0, blocks: 0, falseBlocks: 0, confirmed: 0, slow: 0 };
      for (const r of rules) { totals.hits += r.hits; totals.blocks += r.blocks; totals.falseBlocks += r.falseBlocks; totals.confirmed += r.confirmed; totals.slow += r.slow; }
      return { mode: guardMode(), source: 'file', defaults: true, rules, skipped: clone(skipped), days: 30, totals };
    },
    async guardrailsTest(command, tool = 'Bash') {
      await wait(120);
      if (!String(command ?? '').trim()) throw fail('請提供要測試的指令', 'Provide the command to test');
      const hits = evaluate(entries, tool, command, { mode: guardMode(), overrides, approvals, now: Date.now() });
      const blocked = hits.some((h) => h.action === 'block');
      // 和 core/guardrails.mjs 的 test 相同：命中只有中文的 message（介面用規則清單的 messageEn 顯示英文）
      return { mode: guardMode(), tool, verdict: blocked ? 'block' : hits.length ? 'hint' : 'pass', matches: hits.map(({ id, action, declared, message }) => ({ id, action, declared, message })), ...(blocked ? { deny: denyText(hits) } : {}), hints: hintTexts(hits) };
    },
    async guardrailsDisable(id) {
      await wait(120);
      if (!entries.some((e) => e.rule.id === id)) throw fail(`找不到規則：${id}`, `Rule not found: ${id}`, 'E_NOT_FOUND');
      const changed = overrides[id]?.action !== 'off';
      overrides = { ...overrides, [id]: { action: 'off', at: new Date().toISOString(), reason: 'manual' } };
      return { ok: true, id, changed };
    },
    async guardrailsEnable(id) {
      await wait(120);
      if (!overrides[id]) return { ok: true, id, changed: false };
      const { [id]: _, ...rest } = overrides;
      overrides = rest;
      return { ok: true, id, changed: true };
    },
    async guardrailsApprove(id) {
      await wait(120);
      const entry = entries.find((e) => e.rule.id === id);
      if (!entry) throw fail(`找不到規則：${id}`, `Rule not found: ${id}`, 'E_NOT_FOUND');
      const state = approvalState(entry, approvals);
      const { rule } = entry;
      const shown = { id: rule.id, tool: rule.tool, pattern: rule.pattern, flags: rule.flags, unless: rule.unless, message: rule.message };
      if (state !== 'pending') return { ok: true, id, changed: false, approval: state, rule: shown };
      approvals = { ...approvals, [id]: { hash: entry.hash, at: new Date().toISOString() } };
      return { ok: true, id, changed: true, approval: 'approved', rule: shown };
    },

    async recall() {
      await wait(90);
      const layers = settings.indexLayers ?? 'observe';
      return {
        recall: layers === 'on' || settings.recall !== 'off' ? 'on' : 'off', recallForced: layers === 'on', indexLayers: layers, effectiveLayers: layers === 'on' ? 'on' : 'off', indexLayersUpdatedAt: null,
        index: { bytes: 184320, builtAt: ago(42) }, indexCompat: indexCompat(),
        observe: { days: 30, scopes: { global: { bytes: { off: 11480, on: 4120 }, reference: 38 }, machine: { bytes: { off: 2960, on: 1210 }, reference: 9 } }, recalled: 64, opened: 23 },
      };
    },
    async update() {
      await wait(80);
      return {
        autoUpdate: settings.autoUpdate ?? 'on', local: '2.0.0', dev: false,
        release: { version: '2.0.0', commit: 'a1b2c3d', repo: 'https://github.com/example/engram.git', at: ago(60 * 24 * 2), by: other.id },
        last: { at: ago(60 * 3), status: 'current', code: 'current', reason: '已經是最新版', en: { reason: 'Already up to date' } },
      };
    },
    // 自動駕駛遵守的偏好（端點還在實作中；?prefs=none 模擬還沒有這個端點）
    async autopilotPreferences() {
      await wait(90);
      if (V.prefs === 'none') return null;
      return {
        // 形狀與 app/src/autopilot/prompts.mjs 的 preferenceItems 相同：source 是代碼（介面換成文字）
        used: [
          { ref: 'core/CORE.md', name: 'CORE.md', description: '', type: 'core', source: 'baseline' },
          { ref: 'global/answer-in-bullets.md', name: 'answer-in-bullets', description: L('回覆用條列', 'Answer in bullet points'), type: 'feedback', source: 'user' },
          { ref: 'global/team-lead-role.md', name: 'team-lead-role', description: L('使用者轉任產品設計，負責介面規格', 'The user moved to product design and owns the UI specs'), type: 'user', source: 'user', version: 'previous' },
          { ref: 'global/code-comments.md', name: 'code-comments', description: L('註解寫為什麼，不寫做了什麼', 'Comments explain why, not what'), type: 'feedback', source: 'baseline' },
        ],
        pending: clone(prefPendingAll).filter((x) => !prefConfirmed.has(x.ref)),
        candidates: clone(candidatesAll).filter((x) => !prefConfirmed.has(x.ref)),
      };
    },
    async digest(week) {
      await wait(120);
      if (V.digest === 'empty') return null;
      return clone(digestOf(week || thisWeek));
    },
  };

  /** 設定的檢查（與 app/src/core/recall.mjs 的 checkRecallSettings 相同的規則；展示版的另一台電腦是舊版，模擬「還有電腦沒有升級」） */
  function checkSettings(patch) {
    const recall = patch.recall ?? (settings.recall === 'off' ? 'off' : 'on');
    const layers = patch.indexLayers ?? settings.indexLayers ?? 'observe';
    if (recall === 'off' && layers === 'on') {
      if (patch.indexLayers === 'on') throw fail('這台電腦的情境召回關閉時不能開啟索引分層：分層後參考類記憶不在索引裡，要靠情境召回在相關時帶出', 'Index layers cannot be turned on while context recall is off on this computer: with layers on, reference memories are left out of the index and only reach Claude through recall', 'E_INVALID', '先把 recall 設成 on（或和 indexLayers 一起改）', 'Set recall to on first (or change it together with indexLayers)');
      throw fail('索引分層（所有電腦共用）開著時，情境召回會強制開啟，不能關閉：參考類記憶不在索引裡，關掉召回 Claude 就看不到它們', 'Context recall is forced on while index layers (shared by all computers) are on, so it cannot be turned off: reference memories are left out of the index, and without recall Claude would not see them', 'E_INVALID', '先把 indexLayers 改成 observe 或 off，再關閉 recall', 'Set indexLayers to observe or off first, then turn recall off');
    }
    if (patch.indexLayers === 'on' && settings.indexLayers !== 'on') {
      throw fail(`還有電腦沒有升級到 2.0.0：${other.label}（1.6.0）。舊版讀不懂共用的索引分層設定，會照舊產生完整的索引，和這一版互相改寫`, `Some computers have not been updated to 2.0.0: ${other.label} (1.6.0). Older versions do not understand the shared index layers setting and keep writing the full index, so the computers would keep rewriting each other's index`, 'E_INVALID', '先更新那幾台電腦的 Engram（engram update），同步之後再開啟', 'Update Engram on those computers first (engram update), sync, then turn it on');
    }
  }

  return { api, checkSettings, indexCompat, markConfirmed: (refs) => refs.forEach((r) => prefConfirmed.add(r)) };
}
