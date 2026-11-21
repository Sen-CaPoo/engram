// 情境召回（2.0.0 P3）與索引分層（P2）的 Node 端：建 local/cache/recall.json、並行觀察的統計。
// 計分是 plugin/hooks/lens/recall.mjs 的純函式（mod、指令型後備與這裡共用）；這裡只負責收集記憶、判斷每筆記憶在哪些對話會被載入。
//
// 資料位置（都只在這台電腦、不同步）：
// - local/cache/recall.json：索引。記憶有變動（存檔、同步之後）由常駐程式重建；內容先遮蔽疑似金鑰、內文只取前 4,000 字，檔案控制在 2 MB 以內。
// - local/usage/recall/<日期>.jsonl：帶出紀錄（mod 與指令型後備寫入；一行一筆：時間、對話 id、ref、分數）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildIndex, USAGE_FILE_RE } from '../../plugin/hooks/lens/recall.mjs';
import { E, EngramError, invariant } from './errors.mjs';
import { exists, mtimeMs, readJson, readText, safeWrite, sha1, writeJson } from './fsx.mjs';
import { indexCompat, INDEX_COMPAT_WITHIN_MS, layersMinVersion, olderMachines } from './indexcompat.mjs';
import { computeIndexBudget, planScopeIndex, PROJECT_INDEX, readIndexLayers, SCOPE_INDEX } from './normalize.mjs';
import { toTildePath } from './paths.mjs';
import { redactSecrets } from './secrets.mjs';
import { INDEX_LAYERS, readSharedSettings, SHARED_SETTINGS, sharedSettingsFile } from './sharedsettings.mjs';
import { readsForScope } from './usage.mjs';
import { allBindingViews, commitPaths, machineDir, readBindings } from './vault.mjs';

const DAY = 86_400_000;
// Claude Code 只載入 MEMORY.md 的前 200 行或 25KB；之後的行不算「已載入」
const LOADED_LIMIT = { lines: 200, bytes: 25 * 1024 };
// 索引裡「列出一筆記憶」的行：清單項目，而且連結在項目開頭（`- [名稱](檔名.md) — 說明`，允許粗體包住連結）。
// 手寫的說明句裡提到某個記憶檔不算列出。不用記憶清單的 indexed：索引有「另有 N 筆未列出」時它把被省略的也算進去，
// 而被省略的正是情境召回最該帶出的
const ITEM_LINK_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|__)?\[[^\]]*\]\(([^)\s]+)\)/;

export const recallFile = (local) => path.join(local, 'cache', 'recall.json');
export const recallUsageDir = (local) => path.join(local, 'usage', 'recall');

/**
 * 實際生效的情境召回與索引分層。local 是這台的 local/settings.json（recall 只在這台），shared 是所有電腦共用的
 * vault/settings.json（indexLayers，core/sharedsettings.mjs）。共用的 indexLayers 是 on 時，每一台的情境召回都強制開啟
 * （不然那台的索引沒有參考類記憶、又不會被帶出）：recall 回傳 on，recallForced 是 true。
 */
export function recallSettings(local = {}, shared = {}) {
  const indexLayers = INDEX_LAYERS.includes(shared?.indexLayers) ? shared.indexLayers : 'observe';
  const recallForced = indexLayers === 'on';
  return { recall: recallForced || local?.recall !== 'off' ? 'on' : 'off', recallForced, indexLayers };
}

/**
 * 共用的 indexLayers 是 on、卻有最近 7 天有活動的舊版電腦（例如超過 30 天沒開、切換時沒被檢查到的筆電回來了）：
 * 舊版讀不懂共用設定，會照舊產生完整索引。把共用的 indexLayers 改回 observe、重建索引並 commit（同 setSharedIndexLayers）。
 * 同一時間索引也進入相容模式（core/normalize.mjs，只要有近 7 天有活動的舊版電腦就會，不論這個設定是什麼），
 * 所以兩台不會互相改寫；那幾台更新之後索引自動切換，分層則要在設定頁再開啟。
 * 常駐程式在網路同步之後呼叫，有改回時通知使用者。
 * @returns {Promise<{ reverted: { mid: string, label: string, version: string|null, lastActiveAt: string|null }[] }>}
 */
export async function guardSharedLayers(ctx, { now = Date.now() } = {}) {
  if ((await readSharedSettings(ctx.vault)).indexLayers !== 'on') return { reverted: [] };
  const old = await olderMachines(ctx.vault, { now, withinMs: INDEX_COMPAT_WITHIN_MS, selfMid: ctx.mid });
  if (!old.length) return { reverted: [] };
  await setSharedIndexLayers(ctx, 'observe', { now });
  return { reverted: old };
}

/**
 * 改設定前的檢查。recall 是這台的設定；indexLayers 是所有電腦共用的設定。
 * - 值要合法；
 * - 這台的情境召回關閉時不能開啟索引分層（先開 recall，或一起改）；
 * - 共用的索引分層開著時，這台不能關閉情境召回（會被強制開啟）；
 * - 切到 on 之前，所有電腦（30 天內有開過的）都要升級到這一版：舊版讀不懂共用的設定，會和新版互相改寫索引。
 */
export async function checkRecallSettings(ctx, patch, { now = Date.now() } = {}) {
  if (patch.recall !== undefined) invariant(['on', 'off'].includes(patch.recall), "recall 必須是 'on' 或 'off'", undefined, { message: "recall must be 'on' or 'off'" });
  if (patch.indexLayers !== undefined) invariant(INDEX_LAYERS.includes(patch.indexLayers), "indexLayers 必須是 'observe'、'on' 或 'off'", undefined, { message: "indexLayers must be 'observe', 'on' or 'off'" });
  const local = (await readJson(path.join(ctx.local, 'settings.json'), null)) ?? {};
  const shared = await readSharedSettings(ctx.vault);
  const recall = patch.recall ?? (local.recall === 'off' ? 'off' : 'on');
  const indexLayers = patch.indexLayers ?? shared.indexLayers;
  if (recall === 'off' && indexLayers === 'on') {
    if (patch.indexLayers === 'on') {
      throw new EngramError(E.INVALID, '這台電腦的情境召回關閉時不能開啟索引分層：分層後參考類記憶不在索引裡，要靠情境召回在相關時帶出', '先把 recall 設成 on（或和 indexLayers 一起改）')
        .withEn('Index layers cannot be turned on while context recall is off on this computer: with layers on, reference memories are left out of the index and only reach Claude through recall', 'Set recall to on first (or change it together with indexLayers)');
    }
    throw new EngramError(E.INVALID, '索引分層（所有電腦共用）開著時，情境召回會強制開啟，不能關閉：參考類記憶不在索引裡，關掉召回 Claude 就看不到它們', '先把 indexLayers 改成 observe 或 off，再關閉 recall')
      .withEn('Context recall is forced on while index layers (shared by all computers) are on, so it cannot be turned off: reference memories are left out of the index, and without recall Claude would not see them', 'Set indexLayers to observe or off first, then turn recall off');
  }
  if (patch.indexLayers === 'on' && shared.indexLayers !== 'on') {
    // 30 天沒開的電腦（例如已經不用的舊電腦）不算，同 usage.mjs 的 readsForScope；之後回來的由 guardSharedLayers 處理
    const old = await olderMachines(ctx.vault, { now, withinMs: 30 * DAY, selfMid: ctx.mid });
    if (old.length) {
      const list = old.map((m) => `${m.label}（${m.version ?? '版本不明'}）`).join('、');
      const listEn = old.map((m) => `${m.label} (${m.version ?? 'unknown version'})`).join(', ');
      throw new EngramError(E.INVALID, `還有電腦沒有升級到 ${layersMinVersion()}：${list}。舊版讀不懂共用的索引分層設定，會照舊產生完整的索引，和這一版互相改寫`, '先更新那幾台電腦的 Engram（engram update），同步之後再開啟', { machines: old })
        .withEn(`Some computers have not been updated to ${layersMinVersion()}: ${listEn}. Older versions do not understand the shared index layers setting and keep writing the full index, so the computers would keep rewriting each other's index`, 'Update Engram on those computers first (engram update), sync, then turn it on');
    }
  }
}

/**
 * 寫共用的索引分層（vault/settings.json），立刻重建全域與這台的單機索引，一起 commit（之後照一般的同步流程推送）。
 * 值沒變就不動。呼叫前先用 checkRecallSettings 檢查。
 */
export async function setSharedIndexLayers(ctx, value, { now = Date.now() } = {}) {
  return ctx.locked('settings.indexLayers', async () => {
    const cur = await readSharedSettings(ctx.vault);
    if (cur.indexLayers === value && exists(sharedSettingsFile(ctx.vault))) return { changed: false };
    await writeJson(sharedSettingsFile(ctx.vault), { v: 1, indexLayers: value, updatedAt: new Date(now).toISOString(), by: ctx.mid });
    const { refreshIndex } = await import('./memories.mjs');
    const idx = [...await refreshIndex(ctx, { kind: 'global' }), ...await refreshIndex(ctx, { kind: 'machine', mid: ctx.mid })];
    await commitPaths(ctx.vault, [SHARED_SETTINGS, ...idx], `settings: indexLayers → ${value}`, { action: 'edit', mid: ctx.mid });
    return { changed: true };
  });
}

const oneLine = (s, max) => {
  const t = redactSecrets(String(s ?? '')).text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** 索引檔實際被載入的部分裡，真的列出（ITEM_LINK_RE）的記憶檔名（小寫） */
function linkedFiles(text, { loadedOnly = false } = {}) {
  const out = new Set();
  if (!text) return out;
  let bytes = 0;
  let lines = 0;
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (loadedOnly) {
      bytes += Buffer.byteLength(`${line}\n`);
      if (++lines > LOADED_LIMIT.lines || bytes > LOADED_LIMIT.bytes) break;
    }
    const m = ITEM_LINK_RE.exec(line);
    if (!m) continue;
    let target = m[1];
    try { target = decodeURI(target); } catch { /* 保留原樣 */ }
    const file = target.split(/[\\/]/).pop();
    if (file && /\.md$/i.test(file)) out.add(file.toLowerCase());
  }
  return out;
}

/** 這台電腦綁定的專案資料夾（mod 用 cwd 找出目前的專案） */
async function bindingRoots(ctx) {
  const roots = [];
  for (const v of allBindingViews(await readBindings(ctx.vault, ctx.mid))) if (v?.path && v?.pid) roots.push({ path: v.path, pid: v.pid });
  return roots;
}

/**
 * 收集要放進索引的記憶：全域、所有專案、這台電腦的單機記憶（其他電腦的單機記憶不帶）。
 * loaded：'*' 每場對話都載入（全域或這台電腦的 INDEX.md 有列）；'<pid>' 只在那個專案載入（MEMORY.md 載入的部分有列，
 * 或標了 engram.project、會由開場訊息列出的前 3 筆單機記憶）；null 沒有列在任何會載入的地方。
 */
async function collect(ctx) {
  const mems = await ctx.scan();
  const read = async (p) => (await readText(p)) ?? '';
  const globalListed = linkedFiles(await read(path.join(ctx.vault, 'global', SCOPE_INDEX)));
  const machineListed = linkedFiles(await read(path.join(machineDir(ctx.vault, ctx.mid), SCOPE_INDEX)));
  const projectListed = new Map();
  // 開場訊息列出的「與此專案相關的單機記憶」：依檔名排序的前 3 筆（同 core/session.mjs）
  const sessionListed = new Map();
  const tagged = mems.filter((m) => m.scope?.kind === 'machine' && m.scope.mid === ctx.mid && m.project).sort((a, b) => (a.ref < b.ref ? -1 : 1));
  for (const m of tagged) {
    const list = sessionListed.get(m.project) ?? [];
    if (list.length < 3) list.push(m.ref);
    sessionListed.set(m.project, list);
  }
  const entries = [];
  for (const m of mems) {
    const kind = m.scope?.kind;
    if (kind === 'machine' && m.scope.mid !== ctx.mid) continue;
    const file = m.ref.split('/').pop().toLowerCase();
    let pid = null;
    let loaded = null;
    if (kind === 'global') loaded = globalListed.has(file) ? '*' : null;
    else if (kind === 'machine') {
      pid = m.project ?? null;
      if (pid) loaded = sessionListed.get(pid)?.includes(m.ref) ? pid : null;
      else loaded = machineListed.has(file) ? '*' : null;
    } else if (kind === 'project') {
      pid = m.scope.pid;
      if (!projectListed.has(pid)) projectListed.set(pid, linkedFiles(await read(path.join(ctx.vault, 'projects', pid, 'memory', PROJECT_INDEX)), { loadedOnly: true }));
      loaded = projectListed.get(pid).has(file) ? pid : null;
    } else continue;
    entries.push({
      ref: m.ref,
      path: toTildePath(path.join(ctx.vault, ...m.ref.split('/')), ctx.homes.userHome),
      name: oneLine(m.name || file.replace(/\.md$/i, ''), 80),
      desc: oneLine(m.description, 160),
      type: m.type ?? '',
      pid,
      loaded,
      tags: (m.tags ?? []).map((t) => oneLine(t, 40)),
      body: redactSecrets(String(m._parsed?.body ?? '')).text,
    });
  }
  return entries;
}

/** 決定要不要重建：記憶檔、索引檔與綁定的修改時間與大小 */
async function sourceSignature(ctx) {
  const parts = [];
  const add = async (dir, rel) => {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const n of names.filter((x) => /\.md$/i.test(x)).sort()) {
      try {
        const st = fs.statSync(path.join(dir, n));
        parts.push(`${rel}/${n}:${st.size}:${Math.round(st.mtimeMs)}`);
      } catch { /* 剛被刪掉 */ }
    }
  };
  await add(path.join(ctx.vault, 'global'), 'global');
  await add(machineDir(ctx.vault, ctx.mid), `machines/${ctx.mid}`);
  let pids = [];
  try { pids = (await fsp.readdir(path.join(ctx.vault, 'projects'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { /* 沒有專案 */ }
  for (const pid of pids) await add(path.join(ctx.vault, 'projects', pid, 'memory'), `projects/${pid}/memory`);
  parts.push(`bindings:${mtimeMs(path.join(machineDir(ctx.vault, ctx.mid), 'bindings.json'))}`);
  return sha1(parts.join('\n'));
}

/**
 * @param {object} ctx  引擎內部 context
 */
export function recall(ctx) {
  let lastSig = null;

  /**
   * 重建 local/cache/recall.json。記憶、索引與綁定都沒變（而且檔案還在）時不重建。
   * @returns {Promise<{ rebuilt: boolean, docs?: number, bytes?: number, cap?: number|null }>}
   */
  async function rebuild({ force = false, now = Date.now() } = {}) {
    const file = recallFile(ctx.local);
    const sig = await sourceSignature(ctx);
    if (!force && sig === lastSig && fs.existsSync(file)) return { rebuilt: false };
    const entries = await collect(ctx);
    const { text, bytes, cap, index } = buildIndex(entries, { mid: ctx.mid, roots: await bindingRoots(ctx), builtAt: new Date(now).toISOString() });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (!(await safeWrite(file, text))) return { rebuilt: false };
    lastSig = sig;
    return { rebuilt: true, docs: index.n, bytes, cap };
  }

  /** 近 days 天的帶出紀錄：[{ at, session, ref, score }] */
  async function usage({ days = 30, now = Date.now() } = {}) {
    const dir = recallUsageDir(ctx.local);
    // 檔名是 UTC 的日期（mod 用 $.clock.now() 的 ISO 時間取日期），和護欄的命中紀錄一樣
    const since = new Date(now - (days - 1) * DAY).toISOString().slice(0, 10);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { /* 還沒有紀錄 */ }
    const rows = [];
    // <日期>.jsonl（指令型後備）與 <日期>.<程序代號>.jsonl（mod，每個程序各寫自己的檔）都算
    for (const n of names.filter((x) => USAGE_FILE_RE.test(x) && x.slice(0, 10) >= since).sort()) {
      for (const line of ((await readText(path.join(dir, n))) ?? '').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (typeof r?.ref === 'string' && typeof r?.session === 'string') rows.push(r);
        } catch { /* 壞掉的行略過 */ }
      }
    }
    return rows;
  }

  /**
   * 帶出之後有沒有被打開：同一場對話裡讀過那筆記憶（讀取統計 local/usage/reads.json 的 seen 記著「對話 + ref」）。
   * 讀取統計由每天的健康檢查更新，所以最近一天的數字可能偏低。
   */
  async function openedCount(rows) {
    const reads = (await readJson(path.join(ctx.local, 'usage', 'reads.json'), null)) ?? {};
    const seen = new Set();
    for (const list of Object.values(reads.seen ?? {})) for (const k of Array.isArray(list) ? list : []) seen.add(k);
    let opened = 0;
    for (const p of new Set(rows.map((r) => `${r.session}\u0000${r.ref}`))) if (seen.has(p)) opened++;
    return opened;
  }

  return {
    rebuild,
    /** 共用的索引分層開著、有舊版電腦回來時改回 observe（常駐程式在網路同步之後呼叫） */
    guardLayers: (o) => guardSharedLayers(ctx, o),
    usage,

    /**
     * 情境召回與索引分層的狀態（P2 的並行觀察；設定頁用 GET /api/recall）：目前的設定、索引檔，
     * 全域與這台電腦的 INDEX.md 在兩種模式（off：照舊；on：只列規則層）下的位元組與參考類筆數，
     * 以及近 days 天帶出的次數（recalled）與其中之後被打開的次數（opened）。這是決定要不要切換的依據，不會自動切換。
     */
    async status({ days = 30, now = Date.now() } = {}) {
      const settings = (await readJson(path.join(ctx.local, 'settings.json'), null)) ?? {};
      const shared = await readSharedSettings(ctx.vault);
      const projectNames = await ctx.projectNames();
      const budgets = await computeIndexBudget(ctx.vault);
      const scopes = {};
      for (const [kind, dir, scopeRef] of [['global', path.join(ctx.vault, 'global'), 'global'], ['machine', machineDir(ctx.vault, ctx.mid), `machines/${ctx.mid}`]]) {
        const label = kind === 'machine' ? await ctx.machineLabel(ctx.mid) : undefined;
        const reads = await readsForScope(ctx.vault, scopeRef);
        const plan = (layers) => planScopeIndex({ kind, dir, userHome: ctx.homes.userHome, label, projectNames, budget: budgets[kind], reads, layers });
        const off = await plan('off');
        const on = await plan('on');
        scopes[kind] = { bytes: { off: Buffer.byteLength(off.text), on: Buffer.byteLength(on.text) }, reference: off.reference };
      }
      const rows = await usage({ days, now });
      const st = await fsp.stat(recallFile(ctx.local)).catch(() => null);
      // 相容模式（有近 7 天有活動的舊版電腦）時索引不分層，不論共用設定是什麼
      const compat = await indexCompat(ctx.vault, { now, selfMid: ctx.mid });
      return {
        ...recallSettings(settings, shared),
        effectiveLayers: compat.active ? 'off' : readIndexLayers(shared),
        indexCompat: compat,
        indexLayersUpdatedAt: shared.updatedAt,
        index: st ? { bytes: st.size, builtAt: new Date(st.mtimeMs).toISOString() } : null,
        observe: { days, scopes, recalled: rows.length, opened: await openedCount(rows) },
      };
    },
  };
}
