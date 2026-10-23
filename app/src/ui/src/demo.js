// 展示模式：在瀏覽器記憶體內模擬常駐程式的 HTTP API，形狀與 api.js 契約、40 號 §15 型別完全一致。
// 資料來源：建置時由 tools/ui-build/demo-data.mjs 從開發者的記憶盤點產生（__DEMO_DATA__），沒有時用下方的少量範例。
// 英文展示版（build.mjs --demo-en）改用 demo-sample-en.mjs 的合成資料，介面預設英文。
// 與常駐程式相同，給人看的文字附 en 欄位（finding.en.title 等），介面依語言挑選。
import { setLang } from './i18n.js';
import { buildTidySample, tidyCounts } from './demo-tidy.js';

/* global __DEMO_DATA__ */
const RAW = typeof __DEMO_DATA__ !== 'undefined' && __DEMO_DATA__ ? __DEMO_DATA__ : fallbackData();
const EN_DATA = RAW.lang === 'en';

const NOW = Date.now();
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();
const minutesLater = (m) => new Date(NOW + m * 60000).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const sha = () => (0x9a3f21c + (seq++) * 7919).toString(16).slice(-7);

// ── 狀態 ─────────────────────────────────────────────
const self = RAW.self;
const other = RAW.other;
const projects = clone(RAW.projects);
const memories = clone(RAW.memories);
// 記憶整理的展示：合成的整理記錄，搬移目標是一個合成的專案
const TIDY_PID = 'order-system-x1y2z';
if (!projects.some((p) => p.pid === TIDY_PID)) {
  projects.push({ pid: TIDY_PID, name: EN_DATA ? 'Order system' : '訂單系統', aliases: [], remotes: ['github.com/example/order-system'], paths: {}, counts: { memories: 3, findings: 0 }, lastActivityAt: new Date(NOW - 26 * 3600000).toISOString(), archived: false, index: { lines: 4, bytes: 320 } });
}
let tidyRecords = buildTidySample({ en: EN_DATA, pid: TIDY_PID, now: NOW });
const tidyById = (id) => {
  const r = tidyRecords.find((x) => x.id === id);
  if (!r) throw Object.assign(new Error('找不到整理記錄'), { code: 'E_NOT_FOUND', en: { message: 'Tidy-up record not found' } });
  return r;
};
const tidySummary = () => {
  const n = (st) => tidyRecords.filter((r) => r.status === st).length;
  return { pending: n('pending'), ready: n('ready'), finishing: n('finishing'), total: tidyRecords.length };
};
const trash = [];
const undoers = new Map();
const listeners = new Set();
const emit = (name, data) => listeners.forEach((fn) => fn(name, data));

// 審查用的狀態變體：在網址加上 ?sync=never|offline|auth|error、&stale=1、&probe=fail、&agentdown=1
// &lang=en|zh-TW 指定介面語言（英文展示版預設英文）
const VARIANT = (() => { try { return Object.fromEntries(new URLSearchParams(location.search)); } catch { return {}; } })();
if (VARIANT.lang || EN_DATA) setLang(VARIANT.lang || 'en');
const SYNC_ERRORS = {
  offline: { code: 'E_OFFLINE', message: '連不到 GitHub', hint: '記憶先存在這台；恢復連線後會自動補同步。', en: { message: 'Cannot reach GitHub', hint: 'Memories are kept on this computer and sync automatically once you are back online.' } },
  auth: { code: 'E_AUTH', message: 'GitHub 登入已過期', hint: '執行 gh auth login 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 git -C "$HOME/.engram/vault" fetch，依提示在瀏覽器登入。', en: { message: 'Your GitHub sign-in has expired', hint: 'Run gh auth login to sign in to GitHub again. If git does not use GitHub CLI for credentials, run git -C "$HOME/.engram/vault" fetch in PowerShell or Git Bash instead and sign in through the browser when prompted.' } },
  error: { code: 'E_PUSH_PROTECTED', message: 'GitHub 拒絕推送：偵測到疑似金鑰', hint: '在收件匣的「疑似含有金鑰」卡片遮蔽後再同步。', ref: '', en: { message: 'GitHub rejected the push: possible secret detected', hint: 'Redact it from the "possible secret" card in the inbox, then sync again.' } },
};
let sync = VARIANT.sync === 'never'
  ? { state: 'never', lastSuccessAt: null, lastAttemptAt: null, ahead: 12, behind: 0 }
  : SYNC_ERRORS[VARIANT.sync]
    ? { state: VARIANT.sync, lastSuccessAt: minutesAgo(60 * 3), lastAttemptAt: minutesAgo(2), ahead: 2, behind: 0, error: SYNC_ERRORS[VARIANT.sync] }
    : { state: 'ok', lastSuccessAt: minutesAgo(4), lastAttemptAt: minutesAgo(4), ahead: 0, behind: 0 };
let coreText = EN_DATA ? CORE_TEXT_EN() : CORE_TEXT();
const REDACTED = EN_DATA ? '[redacted: stored in Windows Credential Manager]' : '［已遮蔽：存放在 Windows 認證管理員］';
let importState = { applied: false, tag: null };
let guidelinesAdopted = false;
let pendingList = projects.slice(0, 1).map((p) => ({ path: 'C:\\Users\\Demo\\Desktop\\' + (p.aliases?.[0] || p.name) + '-v2', pid: p.pid, encoded: 'C--Users-Demo-Desktop-example-v2', since: minutesAgo(35), reason: 'ask' }));
const settings = { machineLabel: RAW.self.label, remote: 'https://github.com/demo/engram-vault.git', syncIntervalMin: 10, bindAuto: 'confident', collisionRename: 'ask', healthTime: '09:30', paused: false };

const byRef = (ref) => memories.find((m) => m.ref === ref);
const projectName = (pid) => projects.find((p) => p.pid === pid)?.name || pid;

function refFor(scope, name) {
  const dir = scope.kind === 'global' ? 'global' : scope.kind === 'machine' ? `machines/${scope.mid}` : `projects/${scope.pid}/memory`;
  return `${dir}/${name}.md`;
}

function frontmatterOf(m) {
  return {
    name: m.name, description: m.description,
    metadata: { type: m.type, modified: m.updatedAt, ...(m.pinned ? { engram: { pinned: true } } : {}) },
  };
}

function rawOf(m) {
  const fm = frontmatterOf(m);
  const lines = ['---', `name: ${fm.name}`, `description: ${fm.description}`, 'metadata:', `  type: ${fm.metadata.type}`, `  modified: ${fm.metadata.modified}`];
  if (m.pinned) lines.push('  engram:', '    pinned: true');
  lines.push('---', '');
  return lines.join('\n') + m.body;
}

function action(message, refs, undo) {
  const s = sha();
  const c = { sha: s, at: new Date().toISOString(), machine: self.id, action: message.split(' ')[0], refs, message, undoable: !!undo };
  commits.unshift(c);
  if (undo) undoers.set(s, undo);
  sync = { ...sync, ahead: sync.ahead + 1 };
  emit('change', { refs });
  emit('status', null);
  return { ok: true, commit: { sha: s, message }, undo: undo ? { sha: s } : undefined };
}

// ── 健康檢查發現（規則式，見 40 號 §13） ─────────────────
const findings = [];
(function seedFindings() {
  // 依資料特徵挑範例（不寫死任何真實檔名），規則與 40 號 §13 的健康檢查相同
  const add = (f) => findings.push({ id: `f_${f.code}_${findings.length}`, ...f });
  const used = new Set();
  const pick = (pred) => { const m = memories.find((x) => !used.has(x.ref) && pred(x)); if (m) used.add(m.ref); return m; };
  const big = [...memories].sort((a, b) => b.size - a.size)[0];
  if (big && big.size > 8 * 1024) { used.add(big.ref); add({ code: 'H10', severity: 'medium', title: '單檔過大', detail: `${big.name}.md 有 ${Math.round(big.size / 1024)} KB。被讀取時會佔用大量上下文，建議請 Claude 拆成幾個主題檔。`, refs: [big.ref], en: { title: 'File too large', detail: `${big.name}.md is ${Math.round(big.size / 1024)} KB. Reading it takes up a lot of context; ask Claude to split it into a few topic files.` } }); }
  const groups = new Map();
  for (const m of memories) { const k = m.name.split('-')[0]; if (k.length >= 4) groups.set(k, [...(groups.get(k) || []), m]); }
  const dup = [...groups.entries()].find(([, ms]) => ms.length >= 2 && ms.length <= 4 && ms.every((m) => m.scope.kind === ms[0].scope.kind));
  if (dup) { const refs = dup[1].map((m) => m.ref); refs.forEach((r) => used.add(r)); add({ code: 'H07', severity: 'medium', title: `可能重複：${dup[0]} 主題有 ${refs.length} 筆`, detail: '這幾筆記憶的主題重疊。合併成一筆，Claude 讀取時比較不會混淆。', refs, fix: { action: 'merge', args: { refs }, label: '並排比對並合併', en: { label: 'Compare and merge' } }, en: { title: `Possible duplicates: ${refs.length} memories about ${dup[0]}`, detail: 'These memories overlap. Merging them into one keeps Claude from getting confused when it reads them.' } }); }
  const secret = pick((m) => m.scope.kind === 'project' && /(PAT|token|金鑰|密碼|DB|資料庫)/i.test(m.description));
  if (secret) secret.body += EN_DATA ? '\n\nRead-only token: `' + 'gh' + 'p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' + '` (sample, not a real secret)' : '\n\n查詢用的權杖：`' + 'gh' + 'p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' + '`（範例，非真實金鑰）';
  if (secret) add({ code: 'H13', severity: 'high', title: '疑似含有金鑰，已暫停同步這個檔案', detail: '內文出現類似個人存取權杖（ghp_…）的字串。這個檔案只留在本機，不會推送到 GitHub。建議改成只記「金鑰存放在哪裡」。', refs: [secret.ref], pid: secret.scope.pid, fix: { action: 'edit', args: { ref: secret.ref, lines: [7] }, label: '移除金鑰', en: { label: 'Remove secret' } }, en: { title: 'Possible secret: syncing of this file is paused', detail: 'The text contains something that looks like a personal access token (ghp_…). This file stays on this computer and is not pushed to GitHub. Record only where the secret is stored instead.' } });
  if (EN_DATA) add({ code: 'H06', severity: 'high', title: '資料夾名稱碰撞：多個資料夾共用同一份 Claude Code 紀錄', detail: 'C:\\Users\\Demo\\Desktop\\Client A → Client A-k3fz；C:\\Users\\Demo\\Desktop\\Client.A → Client.A-7qma。', refs: ['C--Users-Demo-Desktop-Client-A'], fix: { action: 'rename-collisions', args: { paths: ['C:\\Users\\Demo\\Desktop\\Client A', 'C:\\Users\\Demo\\Desktop\\Client.A'] }, label: '依命名規則改名', en: { label: 'Rename by naming rule' } }, en: { title: 'Folder name collision: several folders share one Claude Code history', detail: 'C:\\Users\\Demo\\Desktop\\Client A → Client A-k3fz; C:\\Users\\Demo\\Desktop\\Client.A → Client.A-7qma. Claude Code replaces spaces and symbols with "-", so these folders encode the same as Client-A (C--Users-Demo-Desktop-Client-A). Adding a 4-character code to the original name keeps them apart; the folders are rebound, old paths in your memories are updated, and the whole batch can be undone. Conversations from before the rename will not appear in the /resume list.' } });
  else add({ code: 'H06', severity: 'high', title: '資料夾名稱碰撞：多個資料夾共用同一份 Claude Code 紀錄', detail: 'C:\\Users\\Demo\\Desktop\\甲方專案 → 甲方專案-k3fz；C:\\Users\\Demo\\Desktop\\乙方專案 → 乙方專案-7qma。Claude Code 把中文與符號都換成「-」，這些資料夾與 丙方設計 編碼相同（C--Users-Demo-Desktop-----）。依命名規則在原名後加 4 碼代號即可分開；改名後重新綁定、記憶裡的舊路徑一併更新，可以整批還原。改名前的對話不會出現在 /resume 清單。', refs: ['C--Users-Demo-Desktop-----'], fix: { action: 'rename-collisions', args: { paths: ['C:\\Users\\Demo\\Desktop\\甲方專案', 'C:\\Users\\Demo\\Desktop\\乙方專案'] }, label: '依命名規則改名', en: { label: 'Rename by naming rule' } }, en: { title: 'Folder name collision: several folders share one Claude Code history', detail: 'C:\\Users\\Demo\\Desktop\\甲方專案 → 甲方專案-k3fz; C:\\Users\\Demo\\Desktop\\乙方專案 → 乙方專案-7qma. Claude Code replaces Chinese characters and symbols with "-", so these folders encode the same as 丙方設計 (C--Users-Demo-Desktop-----). Adding a 4-character code to the original name keeps them apart; the folders are rebound, old paths in your memories are updated, and the whole batch can be undone. Conversations from before the rename will not appear in the /resume list.' } });
  const pathy = pick((m) => m.scope.kind === 'project' && /[A-Z]:\\/.test(m.description));
  if (pathy) add({ code: 'H08', severity: 'medium', title: '專案記憶裡有本機路徑', detail: '說明中出現這台電腦的磁碟路徑，另一台電腦的路徑可能不同。路徑部分適合改成單機記憶。', refs: [pathy.ref], pid: pathy.scope.pid, fix: { action: 'move', args: { ref: pathy.ref, scope: { kind: 'machine', mid: self.id } }, label: '改為單機記憶', en: { label: 'Make it a machine memory' } }, en: { title: 'Local path in a project memory', detail: 'The description contains a disk path on this computer; the path may differ on your other computers. The path part fits better in a machine memory.' } });
  for (let i = 0; i < 2; i++) {
    const m = pick((x) => x.scope.kind === 'project' && x.type === 'feedback');
    if (m) add({ code: 'H09', severity: 'low', title: '這筆回饋可能適用所有專案', detail: `「${m.description.slice(0, 48)}…」看起來是你的工作習慣，不只屬於「${projectName(m.scope.pid)}」。升級為全域後，每個專案都看得到。`, refs: [m.ref], pid: m.scope.pid, fix: { action: 'move', args: { ref: m.ref, scope: { kind: 'global' } }, label: '升級為全域', en: { label: 'Make it global' } }, en: { title: 'This feedback may apply to every project', detail: `"${m.description.slice(0, 48)}…" looks like one of your working habits, not something specific to "${projectName(m.scope.pid)}". Make it global so every project sees it.` } });
  }
  const stale = [...memories].filter((m) => !used.has(m.ref)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  if (stale) { used.add(stale.ref); add({ code: 'H11', severity: 'low', title: '可能過時', detail: '超過 90 天沒有更新，所屬專案也很久沒開過。封存後不再出現在索引裡，需要時可以還原。', refs: [stale.ref], fix: { action: 'remove', args: { ref: stale.ref }, label: '封存（可從歷史還原）', en: { label: 'Archive (restorable from history)' } }, en: { title: 'Possibly outdated', detail: 'Not updated for more than 90 days, and its project has not been opened for a long time. Once archived it no longer appears in the index; you can restore it when needed.' } }); }
  add({ code: 'H05', severity: 'medium', title: '有 1 筆記憶還沒收編', detail: '這個資料夾在綁定生效前的那次對話裡寫了新記憶，還留在 Claude Code 的預設位置。收編後會複製進 vault，原檔保留到確認為止。', refs: ['~/.claude/projects/C--Users-Demo-Desktop-example/memory/new-note.md'], fix: { action: 'sweep', args: { encoded: 'C--Users-Demo-Desktop-example' }, label: '收編到 Engram', en: { label: 'Adopt into Engram' } }, en: { title: '1 memory has not been adopted yet', detail: 'This folder wrote a new memory in a conversation before its binding took effect, so it is still in the Claude Code default location. Adopting copies it into the vault; the original stays until you confirm.' } });
  for (const f of findings) {
    for (const r of f.refs) { const m = byRef(r); if (m) m.findings.push(f.code); }
    if (f.pid) { const p = projects.find((x) => x.pid === f.pid); if (p) p.counts.findings++; }
  }
})();

// ── 衝突（合成內容） ─────────────────────────────────
const conflictTarget = memories.find((m) => m.scope.kind === 'project' && !m.findings.length) || memories[0];
const BASE_TEXT = EN_DATA
  ? 'Database connection settings for the test environment:\n\n- Host: `db-test.internal`, port 5432\n- Connection timeout 10 seconds\n\n**How to apply:** Make sure the VPN is connected before running integration tests.'
  : '測試環境的資料庫連線設定：\n\n- 主機：`db-test.internal`，連接埠 5432\n- 連線逾時 10 秒\n\n**How to apply:** 跑整合測試前先確認 VPN 已連線。';
const TIMEOUT = EN_DATA ? ['Connection timeout 10 seconds', 'Connection timeout 30 seconds (the office network is slow)', 'Connection timeout 20 seconds, retry 3 times on failure'] : ['連線逾時 10 秒', '連線逾時 30 秒（公司網路較慢）', '連線逾時 20 秒，失敗時重試 3 次'];
const conflicts = conflictTarget ? [{
  id: 'cf_20261022T0912_k3m1', ref: conflictTarget.ref, kind: 'content', createdAt: minutesAgo(29),
  summary: '兩台電腦都改了「連線逾時」這一行。這台改成 30 秒，第二台改成 20 秒並補了重試次數。',
  en: { summary: 'Both computers changed the "connection timeout" line. This one changed it to 30 seconds; the other changed it to 20 seconds and added a retry count.' },
  base: BASE_TEXT,
  ours: BASE_TEXT.replace(TIMEOUT[0], TIMEOUT[1]),
  theirs: BASE_TEXT.replace(TIMEOUT[0], TIMEOUT[2]),
  otherMachine: other.label,
}] : [];

// ── 歷史 ─────────────────────────────────────────────
const commits = [];
(function seedCommits() {
  const recent = [...memories].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const push = (minutes, machine, act, refs, message, undoable = true) => commits.push({ sha: sha(), at: minutesAgo(minutes), machine, action: act, refs, message, undoable });
  push(4, self.id, 'sync', [], `merge origin/main（${other.label}：+1 ~2）`, false);
  push(29, self.id, 'conflict', conflictTarget ? [conflictTarget.ref] : [], '隔離衝突 cf_20261022T0912_k3m1，保留本機版本', false);
  push(52, other.id, 'autosave', recent.slice(0, 2).map((m) => m.ref), 'autosave +1 ~1 −0');
  push(130, self.id, 'move', recent.slice(2, 3).map((m) => m.ref), '升級為全域 ← 專案');
  push(260, self.id, 'autosave', recent.slice(3, 5).map((m) => m.ref), 'autosave +0 ~2 −0');
  push(60 * 20, other.id, 'merge', recent.slice(5, 6).map((m) => m.ref), `合併 2 → ${recent[5]?.ref ?? 'global/…'}`);
  push(60 * 26, self.id, 'import', [], '匯入既有記憶：73 筆 → 64 筆（略過 9 筆重複），還原點 engram-import-20261021', true);
  push(60 * 26 + 3, self.id, 'init', [], '初始化 vault', false);
})();

// ── 每日活動（依記憶的更新時間統計） ─────────────────────
function activity(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(NOW - i * 864e5);
    const key = d.toISOString().slice(0, 10);
    const added = memories.filter((m) => m.updatedAt.slice(0, 10) === key).length;
    const changed = (d.getDate() * 7) % 5 === 0 ? 2 : (d.getDate() % 3 === 0 ? 1 : 0);
    out.push({ date: key, added, changed, removed: d.getDate() % 11 === 0 ? 1 : 0 });
  }
  return out;
}

// ── 常駐程式與排程 ───────────────────────────────────
const at0930 = (() => { const d = new Date(NOW); d.setHours(9, 30, 0, 0); if (d.getTime() > NOW) d.setDate(d.getDate() - 1); return d; })();
const lastHealth = at0930.toISOString();
const nextHealth = new Date(at0930.getTime() + 864e5).toISOString();
const jobs = [
  { id: 'sync', label: '背景同步', schedule: '每 10 分鐘，睡眠恢復後立即補跑', en: { label: 'Background sync', schedule: 'Every 10 minutes; runs right away after the computer wakes up' }, enabled: true, nextRunAt: minutesLater(6), lastRunAt: minutesAgo(4), lastResult: { ok: true, ms: 1840, note: '拉取 3 個變更，推送 1 個', en: { note: 'Pulled 3 changes, pushed 1' } } },
  { id: 'watch', label: '檔案監看', schedule: 'vault 有變更且安靜 30 秒後做本機 commit', en: { label: 'File watcher', schedule: 'Commits locally after the vault changes and stays quiet for 30 seconds' }, enabled: true, nextRunAt: null, lastRunAt: minutesAgo(52), lastResult: { ok: true, ms: 120, note: 'autosave +1 ~1' } },
  { id: 'health', label: '健康檢查', schedule: '每天 09:30；錯過時在啟動後補跑', en: { label: 'Health check', schedule: 'Daily at 09:30; runs after startup if missed' }, enabled: true, nextRunAt: nextHealth, lastRunAt: lastHealth, lastResult: { ok: true, ms: 412, note: '發現 2 項高、4 項中、3 項低', en: { note: 'Found 2 high, 4 medium, 3 low' } } },
  { id: 'probe', label: '相容性探測', schedule: 'Claude Code 改版時；會用你的 Claude 額度跑 6 次 Haiku 小測試（約 3 萬 token／次）', en: { label: 'Compatibility probe', schedule: 'When Claude Code is updated; runs 6 small Haiku tests on your Claude usage (about 30k tokens each)' }, enabled: true, nextRunAt: null, lastRunAt: minutesAgo(60 * 4), lastResult: VARIANT.probe === 'fail' ? { ok: false, ms: 7410, note: 'C3 未通過（Claude Code 2.1.307）；已暫停 junction 綁定', en: { note: 'C3 failed (Claude Code 2.1.307); junction binding paused' } } : { ok: true, ms: 6230, note: '7 項全部通過（Claude Code 2.1.306）', en: { note: 'All 7 passed (Claude Code 2.1.306)' } } },
  { id: 'curate', label: '每週整理建議', schedule: '每週一 10:00，以 claude -p 產生建議（只寫入收件匣）', en: { label: 'Weekly tidy suggestions', schedule: 'Mondays at 10:00; suggestions from claude -p (written to the inbox only)' }, enabled: false, nextRunAt: null, lastRunAt: null, lastResult: null },
];
const probe = {
  at: minutesAgo(60 * 4), claudeVersion: VARIANT.probe === 'fail' ? '2.1.307' : '2.1.306', ok: VARIANT.probe !== 'fail',
  // 與 app/src/cli/probe/contracts.mjs 相同的契約；?probe=fail 模擬 C3（junction 寫入被詢問權限）失敗
  checks: [
    ['C1', '從資料夾根目錄啟動時，settings.local.json 的 autoMemoryDirectory 會生效（撞名資料夾的備援）', 'Started from the folder root, autoMemoryDirectory in settings.local.json takes effect (fallback for colliding folders)'],
    ['C2', '從 git 子資料夾啟動時，記憶目錄仍是 repo 根目錄的編碼資料夾（junction 綁定的前提）', 'Started from a git subfolder, the memory folder is still the encoded folder of the repo root (required for junction binding)'],
    ['C3', '透過 junction 寫入記憶：檔案落在 junction 目標，MEMORY.md 照常更新，沒有權限提示', 'Writing memories through a junction: files land in the junction target, MEMORY.md updates as usual, no permission prompt'],
    ['C4', 'MEMORY.md 在 SessionStart hook 之前讀入（因此正規化不能放在 SessionStart）', 'MEMORY.md is read before the SessionStart hook (so normalization cannot run in SessionStart)'],
    ['C5', '寫入時 frontmatter 的頂層自訂欄位會被搬到 metadata 底下（解析器必須兩處都讀）', 'On write, custom top-level frontmatter fields are moved under metadata (the parser must read both)'],
    ['C6', 'SessionStart 的 additionalContext 會出現在模型上下文（動態內容的前提）', 'SessionStart additionalContext appears in the model context (required for dynamic content)'],
    ['C7', '執行環境把 junction 判定為 symlink（Claude Code 的清理流程因此會略過它）', 'The runtime treats junctions as symlinks (so Claude Code cleanup skips them)'],
  ].map(([id, label, labelEn]) => {
    const failed = VARIANT.probe === 'fail' && id === 'C3';
    return { id, label, ok: !failed, detail: failed ? '透過 junction 寫入記憶時被要求權限（Claude Code 2.1.307，權限模式 auto）' : '', en: { label: labelEn, detail: failed ? 'Writing a memory through a junction asked for permission (Claude Code 2.1.307, permission mode auto)' : '' } };
  }),
};
const agentInfo = () => ({
  pid: 18244, version: '1.1.0', startedAt: minutesAgo(60 * 9 + 12), port: 4777, claudeVersion: VARIANT.probe === 'fail' ? '2.1.307' : '2.1.306', paused: VARIANT.probe === 'fail',
  logonTask: { installed: true, state: 'running', launcher: 'wscript', lastRunAt: minutesAgo(60 * 9 + 12) },
  jobs: clone(jobs), probe: clone(probe),
});
const logs = [
  [4, 'info', 'sync', '同步完成：拉取 3、推送 1，用時 1.8 秒'],
  [4, 'info', 'sync', 'fetch origin（github.com/demo/engram-vault）'],
  [29, 'warn', 'merge', `內容衝突：${conflictTarget?.ref}，已保留本機版本並隔離對方版本`],
  [52, 'info', 'watch', 'autosave +1 ~1 −0'],
  [60 * 2, 'info', 'hook', `SessionStart（${projects[0]?.name ?? '範例專案'}）注入 612 字元，用時 148 ms`],
  [60 * 2, 'info', 'hook', 'InstructionsLoaded 記錄 5 個檔案'],
  [60 * 3, 'warn', 'sync', 'fetch 逾時（20 秒），可能是網路不穩，10 分鐘後重試'],
  [60 * 4, 'info', 'probe', '相容性探測 9/9 通過（Claude Code 2.1.306）'],
  [60 * 9, 'info', 'agent', '常駐程式啟動，連接埠 4777（登入工作，wscript 啟動器）'],
].map(([m, level, src, msg]) => ({ at: minutesAgo(m), level, src, msg }))
  .concat([{ at: lastHealth, level: 'info', src: 'health', msg: '健康檢查完成：高 2、中 4、低 3' }])
  .sort((a, b) => b.at.localeCompare(a.at));

const loadedRecord = () => {
  const lp = [...projects].sort((a, b) => b.counts.memories - a.counts.memories)[0];
  return {
    sessionId: '7d1c2a9e-4b6f-4e1a-9a52-0c7b3f1e2d44', at: minutesAgo(60 * 2), cwd: lp?.paths?.[self.id]?.path || '', pid: lp?.pid,
    files: [
      { path: 'C:\\Users\\Demo\\.claude\\CLAUDE.md', kind: 'user', bytes: 2412, lines: 58, loadReason: 'session_start' },
      { path: 'C:\\Users\\Demo\\.engram\\vault\\core\\CORE.md', kind: 'import', bytes: 4180, lines: 71, loadReason: 'include', parent: 'C:\\Users\\Demo\\.claude\\CLAUDE.md' },
      { path: 'C:\\Users\\Demo\\.engram\\vault\\global\\INDEX.md', kind: 'import', bytes: 1630, lines: 12, loadReason: 'include', parent: 'C:\\Users\\Demo\\.engram\\vault\\core\\CORE.md' },
      { path: `C:\\Users\\Demo\\.engram\\vault\\machines\\${self.id}\\INDEX.md`, kind: 'import', bytes: 1290, lines: 13, loadReason: 'include', parent: 'C:\\Users\\Demo\\.claude\\CLAUDE.md' },
      { path: `C:\\Users\\Demo\\.engram\\vault\\projects\\${lp?.pid}\\memory\\MEMORY.md`, kind: 'memory-index', bytes: lp?.index?.bytes || 1800, lines: lp?.index?.lines || 13, loadReason: 'session_start' },
    ],
  };
};

function statusReport() {
  const counts = { global: 0, projects: projects.filter((p) => !p.archived).length, projectMemories: 0, machine: 0, total: memories.length };
  for (const m of memories) {
    if (m.scope.kind === 'global') counts.global++;
    else if (m.scope.kind === 'machine') counts.machine++;
    else counts.projectMemories++;
  }
  const f = { high: 0, medium: 0, low: 0 };
  for (const x of findings) if (f[x.severity] != null) f[x.severity]++;
  return {
    machine: self,
    vault: { path: 'C:\\Users\\Demo\\.engram\\vault', remote: 'github.com/demo/engram-vault', branch: 'main', head: commits[0]?.sha },
    sync: { ...sync, held: findings.filter((x) => x.code === 'H13').map((x) => ({ ref: x.refs[0], reason: '疑似含有金鑰' })) },
    counts,
    inbox: { conflicts: conflicts.length, findings: f },
    devices: [
      { id: self.id, label: self.label, lastSeenAt: new Date().toISOString(), lastSyncAt: sync.lastSuccessAt, engramVersion: '1.1.0', isSelf: true },
      VARIANT.stale
        ? { id: other.id, label: other.label, lastSeenAt: minutesAgo(60 * 24 * 9), lastSyncAt: minutesAgo(60 * 24 * 9), engramVersion: '1.1.0', isSelf: false }
        : { id: other.id, label: other.label, lastSeenAt: minutesAgo(52), lastSyncAt: minutesAgo(52), engramVersion: '1.1.0', isSelf: false },
    ],
    agent: { paused: VARIANT.probe === 'fail', probe: { ok: probe.ok, failed: probe.checks.filter((c) => !c.ok).map((c) => c.id) } },
    tidy: tidySummary(),
  };
}

function summary(m) {
  const { body, sourceProject, ...rest } = m;
  return clone(rest);
}

function filterMemories(f = {}) {
  let list = memories;
  if (f.scope === 'global') list = list.filter((m) => m.scope.kind === 'global');
  else if (f.scope?.startsWith('project:')) list = list.filter((m) => m.scope.kind === 'project' && m.scope.pid === f.scope.slice(8));
  else if (f.scope?.startsWith('machine:')) list = list.filter((m) => m.scope.kind === 'machine' && m.scope.mid === f.scope.slice(8));
  if (f.type) list = list.filter((m) => m.type === f.type);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((m) => `${m.name} ${m.description} ${m.body}`.toLowerCase().includes(q));
  }
  const sort = f.sort || 'updated';
  list = [...list].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? b.size - a.size : b.updatedAt.localeCompare(a.updatedAt)));
  list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return list.map(summary);
}

function moveMem(m, scope) {
  const prev = { scope: m.scope, ref: m.ref };
  if (m.scope.kind === 'project') { const p = projects.find((x) => x.pid === m.scope.pid); if (p) p.counts.memories--; }
  m.scope = scope;
  m.ref = refFor(scope, m.name);
  if (scope.kind === 'project') { const p = projects.find((x) => x.pid === scope.pid); if (p) p.counts.memories++; }
  return prev;
}

function dropFinding(id) {
  const i = findings.findIndex((f) => f.id === id);
  if (i < 0) return null;
  const [f] = findings.splice(i, 1);
  for (const r of f.refs) { const m = byRef(r); if (m) m.findings = m.findings.filter((c) => c !== f.code); }
  return f;
}

// ── API ─────────────────────────────────────────────
export const demoApi = {
  isDemo: true,
  async status() {
    await wait(80);
    if (VARIANT.agentdown) throw Object.assign(new Error('連不到 Engram 常駐程式'), { code: 'E_AGENT_DOWN', hint: '', en: { message: 'Cannot reach the Engram agent' } });
    return statusReport();
  },
  async activity(days = 30) { await wait(60); return activity(days); },
  async memories(f) { await wait(90); return filterMemories(f); },
  async memory(ref) {
    await wait(60);
    const m = byRef(ref);
    if (!m) throw Object.assign(new Error('找不到這筆記憶'), { code: 'E_NOT_FOUND', en: { message: 'Memory not found' } });
    return { ...summary(m), frontmatter: frontmatterOf(m), body: m.body, raw: rawOf(m), path: `C:\\Users\\Demo\\.engram\\vault\\${m.ref.replace(/\//g, '\\')}`, history: commits.filter((c) => c.refs.includes(ref)).slice(0, 5) };
  },
  async writeMemoryRaw(ref, raw) {
    await wait(120);
    const m = byRef(ref);
    const prev = { body: m.body, updatedAt: m.updatedAt };
    m.body = raw.replace(/^---[\s\S]*?\n---\n?/, ''); m.updatedAt = new Date().toISOString();
    return action(`編輯 ${m.ref}`, [m.ref], () => Object.assign(m, prev));
  },
  async writeMemory(ref, frontmatter, body) {
    await wait(120);
    const m = byRef(ref);
    const prev = { body: m.body, description: m.description, updatedAt: m.updatedAt };
    m.body = body; m.description = frontmatter?.description ?? m.description; m.updatedAt = new Date().toISOString();
    return action(`編輯 ${m.ref}`, [m.ref], () => Object.assign(m, prev));
  },
  async moveMemory(ref, scope) {
    await wait(140);
    const m = byRef(ref);
    const prev = moveMem(m, scope);
    const label = scope.kind === 'global' ? '全域' : scope.kind === 'machine' ? '單機' : '專案';
    return action(`移到${label} ← ${prev.ref}`, [m.ref, prev.ref], () => moveMem(m, prev.scope));
  },
  async mergeMemories(refs, into, body) {
    await wait(160);
    const target = byRef(into);
    const removed = refs.filter((r) => r !== into).map((r) => memories.splice(memories.indexOf(byRef(r)), 1)[0]);
    const prevBody = target.body;
    target.body = body ?? target.body;
    return action(`合併 ${refs.length} → ${into}`, refs, () => { memories.push(...removed); target.body = prevBody; });
  },
  async removeMemory(ref) {
    await wait(100);
    const i = memories.findIndex((m) => m.ref === ref);
    const [m] = memories.splice(i, 1);
    trash.unshift({ ...m, removedAt: new Date().toISOString() });
    return action(`刪除 ${ref}`, [ref], () => { memories.splice(i, 0, m); trash.shift(); });
  },
  async restoreMemory(ref) {
    await wait(100);
    const i = trash.findIndex((m) => m.ref === ref);
    if (i >= 0) memories.push(trash.splice(i, 1)[0]);
    return action(`還原 ${ref}`, [ref]);
  },
  async pinMemory(ref, pinned) {
    await wait(80);
    const m = byRef(ref);
    m.pinned = pinned;
    return action(`${pinned ? '釘選' : '取消釘選'} ${ref}`, [ref], () => { m.pinned = !pinned; });
  },
  async search(q, limit = 20) {
    await wait(50);
    const ql = q.toLowerCase();
    return memories.filter((m) => `${m.name} ${m.description} ${m.body}`.toLowerCase().includes(ql)).slice(0, limit)
      .map((m) => ({ ref: m.ref, scope: m.scope, name: m.name, description: m.description, snippet: m.description, score: 1 }));
  },
  async projects() { await wait(90); return clone(projects); },
  async renameProject(pid, name) {
    await wait(100);
    const p = projects.find((x) => x.pid === pid);
    const prev = p.name; p.name = name;
    return action(`專案改名 ${prev} → ${name}`, [], () => { p.name = prev; });
  },
  async linkProjects(from, to) { await wait(150); return action(`連結專案 ${from} → ${to}`, []); },
  async bind(dir, opts) { await wait(150); pendingList = pendingList.filter((b) => b.path !== dir); emit('change', {}); return { dir, pid: opts?.pid, method: 'junction' }; },
  async pendingBinds() { await wait(60); return clone(pendingList); },
  async unbind() { await wait(100); return { ok: true }; },
  async findings() { await wait(80); return clone(findings); },
  async dismissFinding(id, until) {
    await wait(100);
    const f = dropFinding(id);
    return action(until ? `延後提醒 ${f?.code}` : `忽略 ${f?.code}`, f?.refs || [], () => { if (f) findings.push(f); });
  },
  async secretPreview(ref) {
    await wait(120);
    const m = byRef(ref);
    const re = /ghp_[A-Za-z0-9]{20,}/g;
    const lines = m.body.split('\n');
    const matches = lines.flatMap((l, i) => (re.test(l) ? [{ line: i + 1, kind: EN_DATA ? 'GitHub personal access token' : 'GitHub 個人存取權杖' }] : []));
    return { before: m.body, after: m.body.replace(re, REDACTED), matches };
  },
  async secretRedact(ref) {
    await wait(150);
    const m = byRef(ref);
    const prev = m.body;
    m.body = m.body.replace(/ghp_[A-Za-z0-9]{20,}/g, REDACTED);
    const f = findings.find((x) => x.code === 'H13' && x.refs.includes(ref));
    if (f) dropFinding(f.id);
    return action(`遮蔽金鑰 ${ref}`, [ref], () => { m.body = prev; if (f) findings.push(f); });
  },
  async secretAllow(ref) {
    await wait(100);
    const f = findings.find((x) => x.code === 'H13' && x.refs.includes(ref));
    if (f) dropFinding(f.id);
    return { ok: true };
  },
  async apply(fix) {
    await wait(220);
    const f = findings.find((x) => x.fix === fix || (x.fix && x.fix.action === fix.action && JSON.stringify(x.fix.args) === JSON.stringify(fix.args)));
    if (fix.action === 'move') {
      const m = byRef(fix.args.ref);
      const prev = moveMem(m, fix.args.scope);
      if (f) dropFinding(f.id);
      return action(`${fix.args.scope.kind === 'global' ? '升級為全域' : '改為單機'} ← ${prev.ref}`, [m.ref], () => { moveMem(m, prev.scope); if (f) findings.push(f); });
    }
    if (f) dropFinding(f.id);
    return action(`處理 ${f?.code || fix.action}`, f?.refs || [], () => { if (f) findings.push(f); });
  },
  async conflicts() { await wait(70); return clone(conflicts); },
  async resolveConflict(id, choice, body) {
    await wait(200);
    const i = conflicts.findIndex((c) => c.id === id);
    const [c] = conflicts.splice(i, 1);
    const m = byRef(c.ref);
    if (m) m.body = choice === 'theirs' ? c.theirs : choice === 'manual' ? body : c.ours;
    const label = { ours: '保留這台的版本', theirs: '改用對方的版本', both: '兩者都保留', manual: '手動合併' }[choice];
    return action(`解決衝突：${label}`, [c.ref], () => conflicts.splice(i, 0, c));
  },
  async history(f = {}) { await wait(80); return clone((f.ref ? commits.filter((c) => c.refs.includes(f.ref)) : commits).slice(0, f.limit || 50)); },
  async undo(s) {
    await wait(150);
    const fn = undoers.get(s);
    if (!fn) throw Object.assign(new Error('這個動作無法復原'), { code: 'E_INVALID', en: { message: 'This action cannot be undone' } });
    fn(); undoers.delete(s);
    const c = commits.find((x) => x.sha === s); if (c) c.undoable = false;
    return action(`復原 ${s}`, c?.refs || []);
  },
  async collisions() { await wait(80); return { plan: [], history: [] }; },
  async collisionsUndo() { await wait(120); return { ok: true }; },
  async core() {
    await wait(70);
    const lines = coreText.split('\n').length;
    const bytes = new TextEncoder().encode(coreText).length;
    return {
      text: coreText, lines, bytes,
      chain: [
        { path: '~/.claude/CLAUDE.md', kind: 'user', lines: 58, bytes: 2412, depth: 0, note: '你的手寫準則＋Engram 管理區塊', en: { note: 'Your own guidelines + the Engram block' } },
        { path: '~/.engram/vault/core/CORE.md', kind: 'import', lines, bytes, depth: 1 },
        { path: '~/.engram/vault/global/INDEX.md', kind: 'import', lines: 12, bytes: 1630, depth: 2 },
        { path: `~/.engram/vault/machines/${self.id}/INDEX.md`, kind: 'import', lines: 13, bytes: 1290, depth: 1, isSelf: true },
      ],
    };
  },
  async writeCore(text) {
    await wait(140);
    const prev = coreText; coreText = text;
    return action('編輯 core/CORE.md', ['core/CORE.md'], () => { coreText = prev; });
  },
  async sync() {
    sync = { ...sync, state: 'syncing', lastAttemptAt: new Date().toISOString() };
    emit('sync', { phase: 'start' }); emit('status', null);
    setTimeout(() => {
      sync = { state: 'ok', lastSuccessAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), ahead: 0, behind: 0 };
      commits.unshift({ sha: sha(), at: new Date().toISOString(), machine: self.id, action: 'sync', refs: [], message: 'push origin/main', undoable: false });
      jobs[0].lastRunAt = new Date().toISOString(); jobs[0].lastResult = { ok: true, ms: 1620, note: '已是最新，推送 0 個' };
      emit('sync', { phase: 'done', ok: true }); emit('status', null);
    }, 1600);
    return { started: true };
  },
  async loaded() { await wait(60); return loadedRecord(); },
  async agent() { await wait(70); return agentInfo(); },
  // ?plugin=missing 或 ?plugin=disabled 可以看到安裝引導
  async claudePlugin() {
    await wait(60);
    const state = ['missing', 'disabled'].includes(VARIANT.plugin) ? VARIANT.plugin : 'ready';
    const commands = state === 'ready' ? [] : state === 'disabled' ? ['claude plugin enable engram@engram-local'] : ['claude plugin marketplace add "C:\\Users\\demo\\.engram\\app\\current"', 'claude plugin install engram@engram-local --scope user'];
    const skills = [
      { name: 'inbox', command: '/engram:inbox', argumentHint: '[卡片 id | 代碼，例如 H09]', description: '用 AI 整理 Engram 收件匣' },
      { name: 'tidy', command: '/engram:tidy', argumentHint: '<global | machine | project:<pid> | core | all | 記憶 ref> [補充說明]', description: '請 Claude 分析記憶並提出整理建議' },
      { name: 'tidy-apply', command: '/engram:tidy-apply', argumentHint: '<整理記錄 id>', description: '照你在記憶整理頁的決定執行' },
      { name: 'save', command: '/engram:save', argumentHint: '[要記住的事；省略時回顧整段對話]', description: '把這次對話裡值得長期記住的事存進 Engram' },
      { name: 'recall', command: '/engram:recall', argumentHint: '<主題或問題>', description: '從所有範圍找出相關的經驗' },
    ];
    return { state, plugin: 'engram@engram-local', commands, skills };
  },
  async runJob(id) {
    const j = jobs.find((x) => x.id === id);
    if (id === 'sync') return demoApi.sync();
    setTimeout(() => { j.lastRunAt = new Date().toISOString(); j.lastResult = { ok: true, ms: 380, note: '手動執行完成' }; emit('job', { id }); }, 900);
    return { started: true };
  },
  async toggleJob(id, enabled) { await wait(80); jobs.find((x) => x.id === id).enabled = enabled; return agentInfo(); },
  async logs(f = {}) { await wait(60); return clone(f.level ? logs.filter((l) => l.level === f.level) : logs); },
  async importPlan() {
    await wait(500);
    // 展示「同一個專案」建議：已不存在的來源，若名稱與另一個仍存在的來源相同，就建議共用
    const loose = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
    const sources = RAW.plan.sources.map((src) => {
      if (src.exists) return src;
      const twin = RAW.plan.sources.find((o) => o.exists && o !== src && loose(o.target.name) === loose(src.target.name));
      return twin ? { ...src, suggestions: [{ kind: 'source', sameAs: `${twin.encoded}|${twin.resolvedPath}`, name: twin.target.name, path: twin.resolvedPath, reason: `名稱與這次匯入的 ${twin.resolvedPath} 相同`, en: { reason: `Same name as ${twin.resolvedPath} in this import` } }] } : src;
    });
    return clone({ ...RAW.plan, sources, budget: { core: 71, rules: 0, available: 129, global: 60, machine: 30, fits: true }, applied: importState.applied, tag: importState.tag });
  },
  async importRehearse(edits) {
    await wait(2200);
    const t = RAW.plan.totals;
    const nSkip = Object.values(edits?.items || {}).filter((e) => e.action === 'skip-same').length;
    const copy = t.copy - nSkip;
    return {
      ok: true, ms: 15580, at: new Date().toISOString(), totals: t,
      accounting: { ok: true, planned: t.memories, copyPlanned: copy, skipPlanned: t.memories - copy, vaultMemoryFiles: copy, byScope: { global: t.global, machine: t.machine, project: copy - t.global - t.machine } },
      restore: { ok: true, via: 'rollbackImport', reverted: t.sources, remainingDiff: '', legacyChanged: [] },
      selfTest: { ok: true, ms: 5900, checks: [['甲方設定檔綁定', 'Settings-file binding (client A)'], ['乙方設定檔綁定', 'Settings-file binding (client B)'], ['共用資料夾不換成 junction', 'Shared folder is not turned into a junction'], ['git 專案 junction', 'Junction for the git project'], ['一鍵還原完成', 'One-click restore completed'], ['換回實體資料夾', 'Turned back into a real folder'], ['匯入後的修改保留', 'Changes made after import are kept'], ['新記憶放回', 'New memories are put back'], ['settings.json 一致', 'settings.json matches'], ['甲方資料夾一致', 'Client A folder matches'], ['乙方資料夾一致', 'Client B folder matches'], ['git 專案資料夾一致', 'Git project folder matches']].map(([name, nameEn]) => ({ name, ok: true, detail: '', en: { name: nameEn } })) },
      realUntouched: { ok: true, changed: 0 },
      health: [{ code: 'H07', severity: 'medium', title: '可能重複：同主題 3 筆', refs: 3 }, { code: 'H10', severity: 'medium', title: '單檔過大', refs: 1 }],
      steps: [],
    };
  },
  async importApply() {
    await wait(1400);
    importState = { applied: true, tag: 'engram-import-20261022-0941' };
    const t = RAW.plan.totals;
    // ?import=deferred：模擬一個來源在規劃後被修改（SW-2）、一個來源正有對話在使用
    const live = RAW.plan.sources.filter((s) => s.resolvedPath && !s.target.archived).map((s) => s.resolvedPath);
    const deferred = VARIANT.import === 'deferred' ? [{ path: live[0], reason: 'changed-since-plan' }, { path: live[1], reason: 'active-session' }].filter((d) => d.path) : [];
    return { ok: true, tag: importState.tag, restorePoint: importState.tag, copied: t.copy, skipped: t.skip, bound: projects.filter((p) => !p.archived).length - deferred.length, archived: projects.filter((p) => p.archived).length, backupOnly: t.skip, deferred };
  },
  async guidelines() {
    await wait(120);
    return {
      adopted: guidelinesAdopted,
      current: '# CLAUDE.md\n\n## 1. Think Before Coding\n- State your assumptions explicitly.\n\n## 2. Simplicity First\n- Minimum code that solves the problem.\n',
      proposed: EN_DATA ? '# Working guidelines (moved from ~/.claude/CLAUDE.md, shared by both computers)\n\n## 1. Think Before Coding\n- State your assumptions explicitly.\n\n## 2. Simplicity First\n- Minimum code that solves the problem.\n' : '# 工作準則（由 ~/.claude/CLAUDE.md 搬入，兩台電腦共用）\n\n## 1. Think Before Coding\n- State your assumptions explicitly.\n\n## 2. Simplicity First\n- Minimum code that solves the problem.\n',
      coreLine: '@rules/user-guidelines.md', lines: 63,
    };
  },
  async adoptGuidelines() { await wait(400); guidelinesAdopted = true; return action('同步工作準則', ['core/rules/user-guidelines.md'], () => { guidelinesAdopted = false; }); },
  async revertGuidelines() { await wait(300); guidelinesAdopted = false; return { ok: true }; },
  async settings() { await wait(80); return clone(settings); },
  async saveSettings(patch) { await wait(150); Object.assign(settings, patch); if (patch.machineLabel) self.label = patch.machineLabel; emit('status', null); return clone(settings); },
  async importUndo() { await wait(600); importState = { applied: false, tag: null }; return { ok: true }; },
  // 記憶整理：與 app/src/tidy 的規則相同（決定只能在待決定或已產生指令時修改；依備註調整一定要有備註）
  async tidyList() {
    await wait(70);
    return tidyRecords.map((r) => ({ id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt, appliedAt: r.appliedAt ?? null, scope: r.scope, request: r.request, summary: r.summary, status: r.status, counts: tidyCounts(r) }));
  },
  async tidyRecord(id) {
    await wait(90);
    const r = tidyById(id);
    return clone({ ...r, counts: tidyCounts(r), command: ['ready', 'applying', 'finishing'].includes(r.status) ? `/engram:tidy-apply ${r.id}` : null });
  },
  async tidyDecide(id, changes) {
    await wait(120);
    const r = tidyById(id);
    if (!['pending', 'ready'].includes(r.status)) throw Object.assign(new Error('這份整理記錄已經執行過，不能再修改決定'), { code: 'E_INVALID', en: { message: 'This tidy-up record has already been carried out, so its decisions can no longer change' } });
    for (const [itemId, ch] of Object.entries(changes || {})) {
      const it = r.items.find((x) => x.id === itemId);
      if (!it) continue;
      if (ch.decision !== undefined) it.decision = ch.decision;
      if (ch.note !== undefined) it.note = ch.note;
    }
    r.updatedAt = new Date().toISOString();
    emit('tidy', null);
    return { ok: true };
  },
  async tidyReady(id) {
    await wait(150);
    const r = tidyById(id);
    const missing = r.items.filter((it) => it.decision === 'custom' && !String(it.note || '').trim());
    if (missing.length) throw Object.assign(new Error(`「依備註調整」的項目要寫備註：${missing.map((it) => it.name).join('、')}`), { code: 'E_INVALID', en: { message: `Items set to "Adjust per note" need a note: ${missing.map((it) => it.name).join(', ')}` } });
    for (const it of r.items) if (!it.decision) it.decision = 'keep';
    r.status = 'ready';
    emit('tidy', null);
    emit('status', null);
    return { ok: true, command: `/engram:tidy-apply ${r.id}`, counts: tidyCounts(r) };
  },
  async tidyUndo(id, itemId) {
    await wait(300);
    const it = tidyById(id).items.find((x) => x.id === itemId);
    it.result = { ...it.result, status: 'undone', undoneAt: new Date().toISOString() };
    emit('tidy', null);
    return { ok: true, reverted: [sha()] };
  },
  async tidyDelete(id) {
    await wait(100);
    tidyRecords = tidyRecords.filter((r) => r.id !== id);
    emit('tidy', null);
    emit('status', null);
    return { ok: true };
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

function CORE_TEXT() {
  return `# 核心準則

> 由 Engram 管理，兩台電腦共用。修改請在 Engram 介面進行。

## 溝通
- 一律用正體中文溝通；技術名詞與程式識別字保留原文。
- 主要環境：Windows 11、Git Bash。

## 工作方式
1. **先想清楚再動手**：說出假設；有多種解讀時列出來，不要默默選一個。
2. **簡單優先**：只寫解決問題所需的最少程式碼，不加沒被要求的功能。
3. **精準修改**：只改必須改的地方，維持既有風格。
4. **目標導向**：把任務轉成可驗證的成功條件，驗證通過才算完成。

## 記憶寫入協定
- 一件事一個檔案，寫之前先用 \`engram search\` 確認沒有重複。
- 日期一律寫絕對日期（2026-10-22），不寫「昨天」「上週」。
- 範圍判斷：
  - 只跟這個專案有關 → 照官方自動記憶寫入（專案範圍）
  - 每個專案都適用的偏好與經驗 → \`engram remember --scope global\`
  - 只跟這台電腦有關（路徑、安裝、網路、硬碟）→ \`engram remember --scope machine\`
- 不記錄金鑰或密碼的值，只記「存放在哪裡」。

## 記憶索引
@../global/INDEX.md
`;
}

function CORE_TEXT_EN() {
  return `# Core rules

> Managed by Engram and shared by both computers. Edit it in the Engram dashboard.

## Communication
- Lead with the answer; keep replies short.
- Main environment: Windows 11, Git Bash.

## How to work
1. **Think before coding**: state assumptions; when there are several readings, list them instead of picking one silently.
2. **Simplicity first**: write the minimum code that solves the problem; no features nobody asked for.
3. **Surgical changes**: touch only what you must and keep the existing style.
4. **Goal-driven**: turn tasks into verifiable success criteria; done means verified.

## Memory protocol
- One topic per file; run \`engram search\` first to avoid duplicates.
- Always write absolute dates (2026-10-22), never "yesterday" or "last week".
- Scope:
  - Only about this project → write it as a regular auto memory (project scope)
  - Preferences and lessons for every project → \`engram remember --scope global\`
  - Only about this computer (paths, installs, network, disks) → \`engram remember --scope machine\`
- Never record secret values; record where they are stored.

## Memory index
@../global/INDEX.md
`;
}

function fallbackData() {
  const self = { id: 'demo-pc-0001', label: '這台電腦', hostname: 'DEMO-PC' };
  const other = { id: 'demo-nb-0002', label: '另一台電腦', hostname: 'DEMO-NB' };
  const pid = 'sample-app-a1b2c';
  return {
    self, other,
    projects: [{ pid, name: '範例專案', aliases: [], remotes: ['github.com/example/sample-app'], paths: { [self.id]: { path: 'C:\\Work\\sample-app', exists: true, lastOpenedAt: new Date().toISOString(), method: 'junction' } }, counts: { memories: 1, findings: 0 }, lastActivityAt: new Date().toISOString(), archived: false, index: { lines: 3, bytes: 240 } }],
    memories: [
      { ref: 'global/sample-preference.md', scope: { kind: 'global' }, name: 'sample-preference', description: '範例：回覆一律使用正體中文', type: 'feedback', size: 420, updatedAt: new Date().toISOString(), pinned: false, tags: [], indexed: true, findings: [], body: '回覆一律使用正體中文。' },
      { ref: `projects/${pid}/memory/sample-decision.md`, scope: { kind: 'project', pid }, name: 'sample-decision', description: '範例：資料庫採用 SQLite', type: 'project', size: 520, updatedAt: new Date().toISOString(), pinned: false, tags: [], indexed: true, findings: [], body: '開發環境使用 SQLite，正式環境再評估。' },
    ],
    plan: { sources: [], totals: { sources: 0, memories: 0, copy: 0, skip: 0, global: 0, machine: 0, archived: 0, unknown: 0 } },
  };
}
