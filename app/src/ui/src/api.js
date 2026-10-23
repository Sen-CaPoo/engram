// 管理介面與常駐程式之間的 HTTP 契約。
// 這份檔案就是規格：常駐程式（app/src/agent）必須實作下列每一個端點，回傳型別與 40 號文件 §15 一致。
// 展示版（__DEMO__）改用 demo.js 的記憶體內實作，介面程式碼完全相同。
//
// 共通規則
// - 所有端點都在 /api 底下，只接受 JSON 本文；回應一律 JSON。
// - 每個請求帶 X-Engram-Token（常駐程式啟動時產生，注入在 index.html 的 <meta name="engram-token">）。
// - 錯誤回應：HTTP 4xx/5xx，本文 { error: { code, message, hint, en?: { message, hint } } }，code 沿用 EngramError（E_LOCKED、E_AUTH…）。
// - 多語系：給人看的文字是正體中文；有英文版時附在同一個物件的 en 欄位（例如 finding.en.title），介面依語言挑選。
// - SSE：GET /api/events?t=<token>，事件名稱 status | sync | change | finding | job | probe，data 為 JSON。
//
// 端點一覽（方法 路徑 → 回傳）
//   GET  /api/status                         → StatusReport ＋ { agent: { paused, probe: { ok, failed[] } } }
//                                              devices[].lastSyncAt、sync.held[{ ref, reason }]（UI-B1：判斷「真的都同步了」）
//   GET  /api/activity?days=30               → [{ date, added, changed, removed }]
//   GET  /api/memories?scope=&pid=&type=&q=&sort= → MemorySummary[]
//   GET  /api/memory?ref=                    → Memory
//   PUT  /api/memory?ref=      { frontmatter, body, allowSecrets? }   → ActionResult   （內容疑似含金鑰時 E_SECRET；使用者確認不是金鑰後帶 allowSecrets 重送）
//   PUT  /api/memory?ref=      { raw }                 → ActionResult   （frontmatter 格式有誤時，以原始碼模式寫入整份檔案；R-28）
//   POST /api/memory/move      { ref, scope }          → ActionResult
//   POST /api/memory/merge     { refs, into, body }    → ActionResult
//   POST /api/memory/remove    { ref }                 → ActionResult
//   POST /api/memory/restore   { ref, rev }            → ActionResult
//   POST /api/memory/pin       { ref, pinned }         → ActionResult   （寫入 metadata.engram.pinned）
//   GET  /api/search?q=&limit=               → Hit[]
//   GET  /api/projects                       → Project[]
//   POST /api/projects/rename  { pid, name }           → ActionResult
//   POST /api/projects/link    { from, to }            → ActionResult
//   POST /api/identity/bind    { dir, pid? , create? } → Binding
//   POST /api/identity/unbind  { dir }                 → ActionResult
//   GET  /api/identity/pending               → [{ path, pid, encoded, since, reason }]   （等待確認或對話結束後才接上的資料夾）
//   GET  /api/findings                       → Finding[]（不含已忽略或延後的項目）
//   POST /api/findings/dismiss { id, until? }          → { ok }      （until 省略＝永久忽略；M6）
//   GET  /api/secrets/preview?ref=           → { before, after, matches: [{ line, kind }] }   （M5：本機遮蔽，不經過模型）
//   POST /api/secrets/redact   { ref }                 → ActionResult
//   POST /api/secrets/allow    { ref, line }           → { ok }      （「這不是金鑰」）
//   POST /api/apply            { fix }                 → ActionResult（fix.action 例如 'reconcile-bindings'：依權限模式重新對齊綁定，R-52）
//   GET  /api/conflicts                      → Conflict[]
//   POST /api/conflicts/resolve { id, choice, body? }  → ActionResult
//   GET  /api/history?ref=&limit=            → Commit[]
//   POST /api/undo             { sha }                 → ActionResult   （資料夾改名的 commit 會整批還原那次改名，SW-4）
//   GET  /api/collisions                     → { plan: [{ path, encoded, others, binding, to, blocked }], history: [{ id, at, items, retired, undoneAt? }] }
//   POST /api/collisions/undo  { id }                  → ActionResult   （整批還原一次撞名資料夾改名）
//   GET  /api/core                           → { text, lines, bytes, chain: [{ path, kind, lines, bytes, depth, isSelf? }] }
//   PUT  /api/core             { text, allowSecrets? } → ActionResult
//   GET  /api/core/guidelines                → { current, proposed, coreLine, lines, adopted }   （41 號 §11 選用步驟）
//   POST /api/core/guidelines/adopt          → ActionResult
//   POST /api/core/guidelines/revert         → ActionResult
//   GET  /api/settings                       → { machineLabel, remote, syncIntervalMin, bindAuto: 'confident'|'ask'|'off', healthTime, paused }
//   PUT  /api/settings         { ...部分欄位 }         → 同上
//   POST /api/sync                           → { started: true }   （進度與結果經由 SSE 的 sync 事件）
//   GET  /api/loaded?session=latest          → { sessionId, at, cwd, pid, files: [{ path, kind, bytes, lines, loadReason, parent? }] } | null
//   GET  /api/claude-plugin                  → { state: 'ready'|'disabled'|'missing', plugin, commands[], skills: [{ name, command, description, argumentHint }] }
//                                              （「交給 Claude」引導用：外掛是否已啟用、修好的指令、可用的 /engram 技能）
//   GET  /api/agent                          → AgentInfo（見下）
//   POST /api/jobs/run         { id }                  → { started: true }
//   POST /api/jobs/toggle      { id, enabled }         → AgentInfo
//   GET  /api/logs?level=&limit=             → [{ at, level, src, msg }]
//   POST /api/import/plan                    → SweepPlan ＋ { applied, tag, lastImport }（不含 _srcDirs；每個來源附 rev 指紋）
//   POST /api/import/rehearse  { edits }               → { ok, ms, totals, accounting, restore, realUntouched, health[], steps[] }
//   POST /api/import/apply     { edits }               → { ok, tag, copied, skipped, bound, deferred[{ path, reason }], archived, backupOnly }
//       edits.revs 是規劃時各來源的 rev；有變更的來源延後（reason 'changed-since-plan'），全部延後時 tag 為 null
//   POST /api/import/undo      { tag }                 → { ok, unbound, reverted }
//   edits 格式見 app/src/migrate/plan.mjs：{ items: { "<encoded>/<file>": { action?, scope? } }, names: { "<encoded>": 名稱 } }
//   後端實作：app/src/migrate/index.mjs 的 planImport／rehearseImport／applyImport／undoImport
//
// AgentInfo = { pid, version, startedAt, port, claudeVersion, paused,
//               logonTask: { installed, state, launcher, lastRunAt },
//               jobs: [{ id, label, schedule, enabled, nextRunAt, lastRunAt, lastResult: { ok, ms, note } }],
//               probe: { at, claudeVersion, ok, checks: [{ id, label, ok, detail }] } }

const DEMO = typeof __DEMO__ !== 'undefined' && __DEMO__;
// 展示模式才載入 demo.js；正式版建置時這段會被整個移除
const demoApi = DEMO ? (await import('./demo.js')).demoApi : null;

function token() {
  return document.querySelector('meta[name="engram-token"]')?.content || '';
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code || 'E_HTTP';
    this.hint = body?.error?.hint || '';
    if (body?.error?.en) this.en = body.error.en;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Engram-Token': token() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: {
      code: 'E_AGENT_DOWN', message: '連不到 Engram 常駐程式', hint: '在終端機執行 engram agent，或重新登入 Windows 讓它自動啟動。', // i18n-ignore
      en: { message: 'Cannot reach the Engram agent', hint: 'Run engram agent in a terminal, or sign in to Windows again so it starts automatically.' },
    } });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

const httpApi = {
  status: () => request('GET', '/api/status'),
  activity: (days = 30) => request('GET', `/api/activity${qs({ days })}`),
  memories: (f = {}) => request('GET', `/api/memories${qs(f)}`),
  memory: (ref) => request('GET', `/api/memory${qs({ ref })}`),
  writeMemory: (ref, frontmatter, body, allowSecrets) => request('PUT', `/api/memory${qs({ ref })}`, { frontmatter, body, allowSecrets }),
  writeMemoryRaw: (ref, raw, allowSecrets) => request('PUT', `/api/memory${qs({ ref })}`, { raw, allowSecrets }),
  moveMemory: (ref, scope) => request('POST', '/api/memory/move', { ref, scope }),
  mergeMemories: (refs, into, body) => request('POST', '/api/memory/merge', { refs, into, body }),
  removeMemory: (ref) => request('POST', '/api/memory/remove', { ref }),
  restoreMemory: (ref, rev) => request('POST', '/api/memory/restore', { ref, rev }),
  pinMemory: (ref, pinned) => request('POST', '/api/memory/pin', { ref, pinned }),
  search: (q, limit = 20) => request('GET', `/api/search${qs({ q, limit })}`),
  projects: () => request('GET', '/api/projects'),
  renameProject: (pid, name) => request('POST', '/api/projects/rename', { pid, name }),
  linkProjects: (from, to) => request('POST', '/api/projects/link', { from, to }),
  bind: (dir, opts) => request('POST', '/api/identity/bind', { dir, ...opts }),
  unbind: (dir) => request('POST', '/api/identity/unbind', { dir }),
  pendingBinds: () => request('GET', '/api/identity/pending'),
  findings: () => request('GET', '/api/findings'),
  dismissFinding: (id, until) => request('POST', '/api/findings/dismiss', { id, until }),
  secretPreview: (ref) => request('GET', `/api/secrets/preview${qs({ ref })}`),
  secretRedact: (ref) => request('POST', '/api/secrets/redact', { ref }),
  secretAllow: (ref, line) => request('POST', '/api/secrets/allow', { ref, line }),
  apply: (fix) => request('POST', '/api/apply', { fix }),
  conflicts: () => request('GET', '/api/conflicts'),
  resolveConflict: (id, choice, body) => request('POST', '/api/conflicts/resolve', { id, choice, body }),
  history: (f = {}) => request('GET', `/api/history${qs(f)}`),
  undo: (sha) => request('POST', '/api/undo', { sha }),
  collisions: () => request('GET', '/api/collisions'),
  collisionsUndo: (id) => request('POST', '/api/collisions/undo', { id }),
  core: () => request('GET', '/api/core'),
  writeCore: (text, allowSecrets) => request('PUT', '/api/core', { text, allowSecrets }),
  guidelines: () => request('GET', '/api/core/guidelines'),
  adoptGuidelines: () => request('POST', '/api/core/guidelines/adopt'),
  revertGuidelines: () => request('POST', '/api/core/guidelines/revert'),
  settings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('PUT', '/api/settings', patch),
  sync: () => request('POST', '/api/sync'),
  loaded: () => request('GET', '/api/loaded?session=latest'),
  claudePlugin: () => request('GET', '/api/claude-plugin'),
  agent: () => request('GET', '/api/agent'),
  runJob: (id) => request('POST', '/api/jobs/run', { id }),
  toggleJob: (id, enabled) => request('POST', '/api/jobs/toggle', { id, enabled }),
  logs: (f = {}) => request('GET', `/api/logs${qs(f)}`),
  importPlan: () => request('POST', '/api/import/plan'),
  importRehearse: (edits) => request('POST', '/api/import/rehearse', { edits }),
  importApply: (edits) => request('POST', '/api/import/apply', { edits }),
  importUndo: (tag) => request('POST', '/api/import/undo', { tag }),
  subscribe(onEvent) {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(token())}`);
    const names = ['status', 'sync', 'change', 'finding', 'job', 'probe'];
    for (const n of names) es.addEventListener(n, (e) => onEvent(n, JSON.parse(e.data || 'null')));
    return () => es.close();
  },
  isDemo: false,
};

export const api = DEMO ? demoApi : httpApi;
export { ApiError };
