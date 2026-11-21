// 同步引擎（40 號文件 §10）：收尾未完成的合併 → 本機整理 → 防護（正在寫入、大量刪除、密鑰）→ commit
// → fetch → merge（engram-md）→ 正規化 → 再過一次防護後 commit → push。
// 全程持鎖；網路錯誤不丟例外，寫進 local/state.json，由介面與 SessionStart 顯示。
// 不變式：未解決（unmerged）的路徑絕不 stage；被 stage 的內容不得含衝突標記或疑似金鑰（commitPaths guard）。
import fs from 'node:fs';
import path from 'node:path';
import { E, EngramError } from './errors.mjs';
import { engramMeta, setFields } from './frontmatter.mjs';
import { exists, modifiedWithin, readJson, readText, safeWrite, sha1, stableJson, writeJson } from './fsx.mjs';
import { classifyGitError, git, parseStatusZ } from './git.mjs';
import { quarantine } from './conflicts.mjs';
import { buildDiagnosis, healBlockedMerge, parseOverwriteBlockers, recoverHeal, SELF_HEAL_AFTER } from './heal.mjs';
import { mergeHoldingJson } from './holding.mjs';
import { mergeProfileJson, mergeRulesDetail } from './jsonmerge.mjs';
import { splitCollision } from './identity.mjs';
import { computeIndexBudget, indexLayersFor, normalizeProjectIndex, rebuildScopeIndex } from './normalize.mjs';
import { readsForScope } from './usage.mjs';
import { mergeSharedSettings, SHARED_SETTINGS } from './sharedsettings.mjs';
import { isSecretScanned, loadAllow, needsSecretScan, scanWithAllow } from './secretallow.mjs';
import { hasActiveSession, scanEncodedDir } from './transcripts.mjs';
import {
  allBindingViews, commitPaths, listProjectIds, machineDir, projectMemoryDir, readBindings, readState, touchMachine, updateState,
} from './vault.mjs';

export const RECENT_MS = 10_000;
const MASS_DELETE = { min: 3, ratio: 0.5 };
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const STALE_INDEX_LOCK_MS = 10 * 60_000;
const OVERWRITE_RE = /would be overwritten|untracked working tree files/i;
const OVERWRITE_MESSAGE = '本機有尚未提交的變更，這一輪暫不合併';

/** 本機有扣住的刪除或正在寫入的檔案，擋住這一輪的合併 */
function overwriteError(m, diagnosis) {
  return new EngramError(E.CONFLICT, OVERWRITE_MESSAGE, '處理收件匣中被扣住的刪除或疑似含有金鑰的檔案（H18、H13）；都沒有的話，稍後再同步', { stderr: m.stderr.slice(-500), ...(diagnosis ? { diagnosis } : {}) })
    .withEn('There are uncommitted local changes, so this round does not merge', 'Handle the held deletions or possible-secret files in the inbox (H18, H13); if there are none, sync again in a moment');
}

/** 「同一種錯誤」的鍵：錯誤碼加訊息（E_CONFLICT 底下有好幾種不同的原因） */
const issueKey = (e) => `${e.code}|${e.message}`;
const OVERWRITE_KEY = `${E.CONFLICT}|${OVERWRITE_MESSAGE}`;
/** 到上一輪為止，同一種錯誤已經連續失敗幾次（local/state.json 的 syncIssue） */
const streakOf = (state, key) => (state.syncIssue?.key === key ? state.syncIssue.count ?? 0 : 0);

/** 不是合併造成的失敗（例如推送被拒）連續 3 次：列出這一輪沒被提交的檔案與原因 */
async function diagnoseUncommitted(ctx) {
  try {
    return buildDiagnosis(await planCommit(ctx, { now: Date.now(), allow: await loadAllow(ctx.local) }));
  } catch {
    return null; // 診斷是輔助資訊：做不出來就不附
  }
}

function isMemoryFile(ref) {
  return /\.md$/i.test(ref) && !/(^|\/)(MEMORY|INDEX)\.md$/i.test(ref);
}

/** projects/<pid>/memory/<file>.md → pid */
function projectOf(ref) {
  const m = /^projects\/([^/]+)\/memory\/[^/]+$/.exec(ref);
  return m ? m[1] : null;
}

/** 暫停開關（local/paused.json，由常駐程式在相容性探測失敗時寫入）。 */
export async function readPaused(localDir) {
  return (await readJson(path.join(localDir, 'paused.json'), null)) ?? {};
}

/** 哪些專案目前有進行中的對話（任一綁定的編碼資料夾 30 分鐘內有 transcript 更新）。 */
export async function activeProjects(ctx) {
  const bindings = await readBindings(ctx.vault, ctx.mid);
  const active = new Set();
  for (const b of allBindingViews(bindings)) {
    const scan = await scanEncodedDir(ctx.homes.claudeHome, b.encoded);
    if (hasActiveSession(scan)) active.add(b.pid);
  }
  return active;
}

/** 處理 SessionStart 記下的撞名（R-25）：沒有進行中的對話時，把 junction 換成設定檔備援。 */
async function processPendingSplits(ctx) {
  const st = await readState(ctx.local);
  for (const p of st.pendingSplits ?? []) {
    const r = await splitCollision(ctx, p.encoded).catch(() => ({ state: 'error' }));
    if (r.state === 'noop') {
      const cur = await readState(ctx.local);
      await updateState(ctx.local, { pendingSplits: (cur.pendingSplits ?? []).filter((x) => x.encoded !== p.encoded) });
    }
  }
}

/** 補回 Claude 改寫時丟掉的 metadata.engram（以本機快取為準）。 */
async function repairEngramMeta(ctx, now) {
  const cachePath = path.join(ctx.local, 'cache', 'meta.json');
  const cache = (await readJson(cachePath, {})) ?? {};
  const next = {};
  const repaired = [];
  for (const m of await ctx.scan()) {
    const abs = path.join(ctx.vault, ...m.ref.split('/'));
    const em = engramMeta(m._parsed.data);
    const bodyHash = sha1(m._parsed.body ?? '');
    const prev = cache[m.ref];
    if ((!em || !Object.keys(em).length) && prev?.meta && Object.keys(prev.meta).length && !modifiedWithin(abs, RECENT_MS, now)) {
      const meta = { ...prev.meta };
      if (prev.bodyHash !== bodyHash) {
        delete meta.reviewedAt; // 內文改過 → 重新進收件匣
        delete meta.verified; // 1.4.0：內文改過，之前的驗證日期不再代表現在的內容
      }
      const updates = Object.fromEntries(Object.entries(meta).map(([k, v]) => [`metadata.engram.${k}`, v]));
      const text = await readText(abs);
      // frontmatter 解析有錯誤時絕不自動改寫（R-28）；由健康檢查 H12 提示
      if (text !== null && Object.keys(updates).length && !m._parsed.errors?.length) {
        let fixed = null;
        try { fixed = setFields(text, updates); } catch { fixed = null; }
        const ok = fixed !== null && await safeWrite(abs, fixed, { expectHash: sha1(text) });
        if (ok) { repaired.push(m.ref); next[m.ref] = { meta, bodyHash }; continue; }
      }
    }
    next[m.ref] = { meta: em ?? {}, bodyHash };
  }
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await writeJson(cachePath, next);
  return repaired;
}

/**
 * 正規化所有專案索引並重建全域與本機索引。
 * @returns {Promise<Set<string>>} 這一輪由引擎自己寫入的路徑（不受「10 秒內修改」規則限制）
 */
async function tidy(ctx, { now = Date.now(), normalize = true } = {}) {
  const written = new Set();
  if (normalize) {
    const active = await activeProjects(ctx);
    for (const pid of await listProjectIds(ctx.vault)) {
      const r = await normalizeProjectIndex(projectMemoryDir(ctx.vault, pid), { appendOnly: active.has(pid), skipRecentMs: RECENT_MS, now });
      if (r.changed) written.add(`projects/${pid}/memory/MEMORY.md`);
    }
  }
  const projectNames = await ctx.projectNames();
  const budget = await computeIndexBudget(ctx.vault);
  const layers = await indexLayersFor(ctx.vault); // 2.0.0 P2：索引分層（所有電腦共用的設定）
  if ((await rebuildScopeIndex({ kind: 'global', dir: path.join(ctx.vault, 'global'), userHome: ctx.homes.userHome, projectNames, budget: budget.global, reads: await readsForScope(ctx.vault, 'global'), layers })).changed) written.add('global/INDEX.md');
  // 單一寫入者：只重建自己的單機索引
  if ((await rebuildScopeIndex({ kind: 'machine', dir: machineDir(ctx.vault, ctx.mid), userHome: ctx.homes.userHome, label: ctx.label, projectNames, budget: budget.machine, reads: await readsForScope(ctx.vault, `machines/${ctx.mid}`), layers })).changed) written.add(`machines/${ctx.mid}/INDEX.md`);
  return written;
}

/**
 * 決定這一輪要提交哪些路徑。
 * @returns {Promise<{ stage: string[], held: {pid, refs}[], recent: string[], secrets: {ref, kinds}[], unmerged: string[], items: object[] }>}
 */
async function planCommit(ctx, { now, engineWritten = new Set(), holdDeletions = true, allow = {} }) {
  const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: ctx.vault });
  const items = parseStatusZ(st.stdout);
  const stage = [];
  const recent = [];
  const secrets = [];
  const unmerged = [];
  const deletionsByPid = new Map();
  for (const it of items) {
    const ref = it.path.replace(/\\/g, '/');
    if (UNMERGED.has(`${it.x}${it.y}`)) { unmerged.push(ref); continue; } // R-31：絕不 stage 未解決的路徑
    const deleted = it.x === 'D' || it.y === 'D';
    const abs = path.join(ctx.vault, ...ref.split('/'));
    // INDEX.md 只有引擎會寫；其他檔案若是引擎這一輪寫的也不算「正在被 Claude 修改」
    const engineOwned = engineWritten.has(ref) || /(^|\/)INDEX\.md$/i.test(ref);
    if (!deleted && !engineOwned && modifiedWithin(abs, RECENT_MS, now)) { recent.push(ref); continue; }
    if (deleted) {
      const pid = projectOf(ref);
      if (holdDeletions && pid && isMemoryFile(ref)) {
        if (!deletionsByPid.has(pid)) deletionsByPid.set(pid, []);
        deletionsByPid.get(pid).push(ref);
        continue;
      }
      stage.push(ref);
      if (it.from) stage.push(it.from);
      continue;
    }
    // 密鑰關卡：所有 Markdown，包括衝突隔離區（隔離的本機版本可能正是被擋下的那份，M6）；
    // 另外 env/、holding/、guardrails/ 底下的所有文字檔（環境設定檔、技能檔案、保留區項目、護欄規則：不是記憶，但會同步）
    if (isSecretScanned(ref)) {
      let text = null;
      try { text = await readText(abs); } catch { recent.push(ref); continue; }
      const hits = text && needsSecretScan(ref, text) ? scanWithAllow(text, ref, allow) : [];
      if (hits.length) { secrets.push({ ref, kinds: [...new Set(hits.map((h) => h.kind))] }); continue; }
    }
    stage.push(ref);
    if (it.from) stage.push(it.from);
  }
  // 大量刪除防護（R-15）：只扣住，不還原工作目錄
  const held = [];
  for (const [pid, refs] of deletionsByPid) {
    const tracked = await git(['ls-files', '--', `projects/${pid}/memory/`], { cwd: ctx.vault });
    const total = tracked.stdout.split('\n').filter((p) => p && isMemoryFile(p)).length;
    if (refs.length >= MASS_DELETE.min && refs.length >= total * MASS_DELETE.ratio) held.push({ pid, refs, at: new Date(now).toISOString() });
    else stage.push(...refs);
  }
  return { stage, held, recent, secrets, unmerged, items };
}

function countChanges(stage, statusItems) {
  const map = new Map(statusItems.map((i) => [i.path, i]));
  let a = 0; let m = 0; let d = 0;
  for (const p of stage) {
    const it = map.get(p);
    if (!it) continue;
    if (it.x === '?' || it.x === 'A') a++;
    else if (it.x === 'D' || it.y === 'D') d++;
    else m++;
  }
  return { a, m, d };
}

/** project.json 結構化合併：陣列取聯集，純量取 updatedAt 較新的一方。 */
function mergeProjectJson(ours, theirs) {
  try {
    const a = JSON.parse(ours);
    const b = JSON.parse(theirs);
    const newer = String(b.updatedAt ?? '') > String(a.updatedAt ?? '') ? b : a;
    const out = { ...a, ...b, ...newer };
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (Array.isArray(a[k]) || Array.isArray(b[k])) out[k] = [...new Set([...(a[k] ?? []), ...(b[k] ?? [])])].sort();
    }
    return stableJson(out);
  } catch { return null; }
}

/**
 * release.json（自動更新的發佈資訊，R2）合併：兩台電腦都發佈過時留版本較新的（版本相同留 at 較晚的）；其中一邊讀不懂就留另一邊。
 * 只會前進、不會退版，所以兩台電腦各自合併都得到同一份，不會留下衝突。回傳贏的那一份的原文；兩邊都讀不懂回傳 null（交給一般的衝突處理）。
 */
function mergeReleaseJson(ours, theirs) {
  const read = (text) => {
    try {
      const j = JSON.parse(text);
      const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(j?.version));
      return v ? { text, v: v.slice(1).map(Number), at: Date.parse(j.at) || 0 } : null;
    } catch { return null; }
  };
  const a = read(ours);
  const b = read(theirs);
  if (!a || !b) return (a ?? b)?.text ?? null;
  for (let i = 0; i < 3; i++) if (a.v[i] !== b.v[i]) return (b.v[i] > a.v[i] ? b : a).text;
  return (b.at > a.at ? b : a).text;
}

/**
 * 解決合併器以外的衝突。寫入失敗（檔案被占用）就丟 E_LOCKED，由呼叫端 abort 這次合併（R-32）。
 * @returns {Promise<{ ids: string[], written: string[] }>}
 */
/**
 * 合併中另一邊最後改這個檔的電腦（第四輪審查 F-01）：合併基準之後、另一邊（MERGE_HEAD）的非合併 commit 裡最近一個改了 p 的，
 * 從它的標題 engram(<mid>): … 取出電腦代號。找不到（沒有 MERGE_HEAD、標題不是 Engram 寫的、是這台自己的）時 null：
 * 紀錄只知道記下紀錄的那台，其他電腦看到時當成第三台、用電腦名稱描述，不猜。
 */
async function otherSideMachine(ctx, p) {
  const base = await git(['merge-base', 'HEAD', 'MERGE_HEAD'], { cwd: ctx.vault, allowFail: true });
  const range = base.code === 0 && base.stdout.trim() ? `${base.stdout.trim()}..MERGE_HEAD` : 'MERGE_HEAD';
  // 第五輪審查 N-2：三台以上時，最後改這個檔的那台不一定是改了衝突那個鍵的那台。範圍內改過這個檔的 commit 全部出自同一台才採用，
  // 否則不猜（留空：其他電腦都當成第三台，用「記下紀錄的那台／另一台電腦」描述）
  const r = await git(['log', '--no-merges', '--format=%s', range, '--', p], { cwd: ctx.vault, allowFail: true });
  if (r.code !== 0) return null;
  const mids = new Set();
  for (const subject of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const m = /^engram\(([a-z0-9][a-z0-9-]{0,63})\):/.exec(subject);
    if (!m) return null; // 有不是 Engram 寫的 commit：看不出是誰改的
    mids.add(m[1]);
  }
  const [only] = mids;
  return mids.size === 1 && only !== ctx.mid ? only : null;
}

async function resolveUnmerged(ctx) {
  const r = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: ctx.vault, allowFail: true });
  const paths = r.stdout.split('\0').filter(Boolean);
  const ids = [];
  const written = [];
  const write = async (abs, text) => {
    const ok = await safeWrite(abs, text);
    if (!ok) throw new EngramError(E.LOCKED, '解決衝突時檔案正被使用，這一輪先不合併', '稍後會自動重試').withEn('A file was in use while resolving conflicts, so this round skips merging', 'It will retry automatically soon');
  };
  for (const p of paths) {
    const ls = await git(['ls-files', '-u', '-z', '--', p], { cwd: ctx.vault });
    const stages = new Set(ls.stdout.split('\0').filter(Boolean).map((l) => l.split(/\s+/)[2]));
    const show = async (n) => {
      const s = await git(['show', `:${n}:${p}`], { cwd: ctx.vault, allowFail: true });
      return s.code === 0 ? s.stdout : null;
    };
    const base = stages.has('1') ? await show(1) : null;
    const ours = stages.has('2') ? await show(2) : null;
    const theirs = stages.has('3') ? await show(3) : null;
    const abs = path.join(ctx.vault, ...p.split('/'));
    if (ours !== null && theirs !== null) {
      // 2.0.0 WP4a：共用設定 settings.json 兩台同時改時留 updatedAt 較新的；保留區的項目（審查 F8）：已採用或已忽略優先、同為保留中取較新的
      // 第二輪審查 R4：護欄規則檔以規則 id 聯集；環境設定檔逐鍵合併，兩邊都改而值不同時留較新的、另一邊的值記進衝突隔離區
      // 第三輪審查 R4：護欄規則檔兩邊都改了同一條規則時，輸的那一條也記進衝突隔離區（之前只留較新的，另一邊悄悄消失）
      const profile = p === 'env/profile.json' ? mergeProfileJson(ours, theirs, base) : p === 'guardrails/rules.json' ? mergeRulesDetail(ours, theirs, base) : null;
      const merged = /(^|\/)project\.json$/.test(p) ? mergeProjectJson(ours, theirs) : p === 'release.json' ? mergeReleaseJson(ours, theirs) : p === SHARED_SETTINGS ? mergeSharedSettings(ours, theirs)
        : /^holding\/hd-[^/]+\.json$/.test(p) ? mergeHoldingJson(ours, theirs)
        : profile ? profile.text : null;
      if (merged !== null) {
        await write(abs, merged);
        if (profile?.losers.length) {
          const rules = p === 'guardrails/rules.json';
          const keys = profile.losers.map((x) => (rules ? x.id : `${x.area === 'setting' ? 'setting:' : ''}${x.key}`)).join('、');
          // 收件匣的對話框沿用一般的四個選項：說明只有兩個適用（resolveConflict 對另外兩個回報錯誤）。
          // 第四輪審查 F-01：說明會同步到每台，不寫「這台／對方」（在另一台、第三台看會說反），選項的說法由 listConflicts 依觀點給
          const zh = rules
            ? `兩台電腦都改了護欄規則 ${keys}，已留較新的那一條；兩個版本都在這裡，處理時選要用哪一邊的版本（兩者都保留與手動合併不適用）`
            : `兩台電腦都改了環境設定檔的 ${keys}，已留較新的那一邊的值；兩個版本都在這裡，處理時選要用哪一邊的值（兩者都保留與手動合併不適用）`;
          const en = rules
            ? `Both computers changed the guardrail rule ${keys}; the newer one was kept and both versions are here. Choose which side's version to use (keeping both or merging by hand does not apply)`
            : `Both computers changed ${keys} in the environment profile; the newer value was kept and both versions are here. Choose which side's value to use (keeping both or merging by hand does not apply)`;
          // 第四輪審查 F-01：記下是哪台記的（ours.md 是它的版本）與另一邊最後改這個檔的那台，處理時依觀點換算
          ids.push(await quarantine(ctx.vault, { ref: p, kind: 'content', ours, theirs, base, summary: zh, summaryEn: en, recordedOn: ctx.mid, otherMachine: await otherSideMachine(ctx, p) }));
        }
      }
      else {
        // 內容衝突但合併器沒處理（例如非 Markdown）：保留本機版本，隔離對方
        await write(abs, ours);
        ids.push(await quarantine(ctx.vault, { ref: p, kind: 'content', ours, theirs, base, summary: `${p} 兩邊都有修改，已保留本機版本`, summaryEn: `${p} was modified on both computers; this computer's version was kept` }));
      }
    } else if (ours !== null) {
      await write(abs, ours);
      ids.push(await quarantine(ctx.vault, { ref: p, kind: 'modify-delete', ours, theirs: null, base, summary: '另一台電腦刪除了這筆記憶，但這台有修改，已保留', summaryEn: 'The other computer deleted this memory, but this computer modified it, so it was kept' }));
    } else if (theirs !== null) {
      await write(abs, theirs);
      ids.push(await quarantine(ctx.vault, { ref: p, kind: 'modify-delete', ours: null, theirs, base, summary: '這台電腦刪除了這筆記憶，但另一台有修改，已保留修改後的版本', summaryEn: 'This computer deleted this memory, but the other computer modified it, so the modified version was kept' }));
    }
    written.push(p);
  }
  return { ids, written };
}

async function hasMergeInProgress(ctx) {
  const r = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: ctx.vault, allowFail: true });
  return r.code === 0;
}

/**
 * 收尾上一輪沒做完的合併（程序在合併途中被終止，R-31）。
 * 有未解決的路徑就照一般規則解決；解決失敗就 abort，讓工作目錄回到合併前。
 */
async function finishInterruptedMerge(ctx, env) {
  if (!(await hasMergeInProgress(ctx))) {
    const u = await git(['ls-files', '-u'], { cwd: ctx.vault, allowFail: true });
    if (!u.stdout.trim()) return { recovered: false, ids: [] };
  }
  try {
    const { ids, written } = await resolveUnmerged(ctx);
    for (const p of written) await git(['add', '-A', '--', p], { cwd: ctx.vault });
    if (await hasMergeInProgress(ctx)) await git(['commit', '-q', '--no-edit'], { cwd: ctx.vault, env });
    return { recovered: true, ids };
  } catch (err) {
    await git(['merge', '--abort'], { cwd: ctx.vault, allowFail: true });
    throw err;
  }
}

/** 殘留過久的 .git/index.lock（例如我們自己逾時終止了 git）→ 清除（M8）。 */
function clearStaleIndexLock(ctx) {
  const p = path.join(ctx.vault, '.git', 'index.lock');
  try {
    const age = Date.now() - fs.statSync(p).mtimeMs;
    if (age > STALE_INDEX_LOCK_MS) { fs.rmSync(p, { force: true }); return true; }
  } catch { /* 不存在 */ }
  return false;
}

async function remoteUrl(ctx) {
  const r = await git(['remote', 'get-url', 'origin'], { cwd: ctx.vault, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

async function aheadBehind(ctx) {
  const has = await git(['rev-parse', '--verify', '-q', 'refs/remotes/origin/main'], { cwd: ctx.vault, allowFail: true });
  if (has.code !== 0) return { ahead: null, behind: 0, remoteBranch: false };
  const r = await git(['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main'], { cwd: ctx.vault, allowFail: true });
  const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0, remoteBranch: true };
}

/** 衝突隔離區裡這一輪新寫的檔案（合併器或 resolveUnmerged 產生），視為引擎寫入。 */
async function conflictPaths(ctx) {
  const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'conflicts/'], { cwd: ctx.vault });
  return parseStatusZ(st.stdout).map((i) => i.path);
}

/**
 * 執行一次同步。
 * @param {{ network?: boolean, timeoutMs?: number, normalize?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, state: string, committed: number, pulled: number, pushed: boolean, conflicts: string[],
 *   held: object[], skipped: { recent: string[], secrets: object[] }, error?: object }>}
 */
export async function sync(ctx, { network = true, timeoutMs = 20_000, normalize } = {}) {
  const result = { ok: true, state: 'ok', committed: 0, pulled: 0, pushed: false, conflicts: [], held: [], skipped: { recent: [], secrets: [] } };
  try {
    return await ctx.locked('sync', () => syncLocked(ctx, result, { network, timeoutMs, normalize }), { waitMs: 3_000 });
  } catch (err) {
    if (err?.code === E.LOCKED) return { ...result, ok: false, state: 'locked', error: err.toJSON?.() ?? { code: err.code, message: err.message } };
    throw err;
  }
}

async function syncLocked(ctx, result, { network, timeoutMs, normalize }) {
  const startedAt = new Date().toISOString();
  let prevState = {};
  let diagnosis = null; // S2：同一種非離線錯誤連續 3 次後的診斷（也含自動修復的結果）
  try {
    prevState = await readState(ctx.local);
    const paused = await readPaused(ctx.local);
    if (paused.user) return { ...result, state: 'paused' }; // 使用者在介面按了「暫停 Engram」
    const doNormalize = normalize ?? !paused.normalize;
    await updateState(ctx.local, { sync: { ...(prevState.sync ?? {}), state: 'syncing', lastAttemptAt: startedAt } });
    const env = { ENGRAM_CONFLICTS_DIR: path.join(ctx.vault, 'conflicts') };

    clearStaleIndexLock(ctx);
    const rec = await finishInterruptedMerge(ctx, env);
    result.conflicts.push(...rec.ids);
    // 上一輪暫時移開被扣住的檔案時被終止（或放回失敗）：先放回原位，後面的 tidy 與 commit 才不會把它當成刪除。
    // 這段期間原位的檔案被改過的話，目前的內容已先另存到 local/backup，這裡記在 state.json 的 syncHeal 並回報給常駐程式寫日誌
    const healed = await recoverHeal(ctx);
    if (healed.preserved?.length) {
      result.healRecovered = { files: healed.files, preserved: healed.preserved };
      await updateState(ctx.local, { syncHeal: { at: new Date().toISOString(), recovered: healed.files, preserved: healed.preserved } });
    }

    const now = Date.now();
    await processPendingSplits(ctx);
    const repaired = doNormalize ? await repairEngramMeta(ctx, now) : [];
    const engineWritten = await tidy(ctx, { now, normalize: doNormalize });
    for (const r of repaired) engineWritten.add(r);
    for (const p of await conflictPaths(ctx)) engineWritten.add(p);

    // 1. 本機 commit
    const allow = await loadAllow(ctx.local);
    const plan = await planCommit(ctx, { now, engineWritten, allow });
    if (plan.unmerged.length) throw new EngramError(E.CONFLICT, '還有未解決的合併衝突，這一輪不提交', '執行 engram doctor', { unmerged: plan.unmerged }).withEn('There are unresolved merge conflicts, so this round does not commit', 'Run engram doctor');
    result.held = plan.held;
    result.skipped = { recent: plan.recent, secrets: plan.secrets };
    // 心跳（machine.json 的最後上線、最後同步時間）不單獨成為 commit（S3）：這一輪本來就有其他變更要提交時順帶更新，
    // 否則超過 24 小時才單獨寫一次。lastSyncAt 用上一次已經成功的同步時間（這一輪的 push 還沒成功）
    const heartbeatRef = `machines/${ctx.mid}/machine.json`;
    const heartbeat = await touchMachine(ctx.homes, ctx.mid, {
      piggyback: plan.stage.some((p) => p !== heartbeatRef),
      lastSyncAt: prevState.sync?.lastSuccessAt ?? null,
    });
    if (heartbeat && !plan.stage.includes(heartbeatRef)) plan.stage.push(heartbeatRef);
    if (plan.stage.length) {
      const c = countChanges(plan.stage, plan.items);
      const commit = await commitPaths(ctx.vault, plan.stage, `autosave +${c.a} ~${c.m} −${c.d}`, { action: 'autosave', mid: ctx.mid, guard: true, allow });
      if (commit) result.committed++;
    }

    // 2. 網路
    const remote = network ? await remoteUrl(ctx) : null;
    let syncState = { state: remote ? 'ok' : (network ? 'never' : (prevState.sync?.state === 'never' ? 'never' : 'ok')) };
    if (remote) {
      for (let round = 0; round < 3; round++) {
        await git(['fetch', '--prune', 'origin'], { cwd: ctx.vault, timeoutMs });
        const ab = await aheadBehind(ctx);
        if (ab.behind > 0) {
          const head = (await git(['rev-parse', 'HEAD'], { cwd: ctx.vault })).stdout.trim();
          // 本機沒有自己的 commit、只是落後時快轉：一律 --no-ff 的話，兩台電腦輪流同步會無限互相產生空的合併 commit
          const args = ab.ahead === 0 ? ['merge', '--ff-only', 'refs/remotes/origin/main'] : ['merge', '--no-ff', '--no-edit', '--allow-unrelated-histories', 'refs/remotes/origin/main'];
          const runMerge = () => git(args, { cwd: ctx.vault, env, allowFail: true, timeoutMs: 120_000 });
          // merge 沒成功之後的處理：被擋住就丟錯、有衝突就解決並 commit，解不了就 abort
          const finishMerge = async (m) => {
            if (m.code === 0) return;
            if (OVERWRITE_RE.test(m.stderr + m.stdout)) throw overwriteError(m, diagnosis);
            if (!(await hasMergeInProgress(ctx))) throw classifyGitError(m, ['merge']);
            try {
              const { ids, written } = await resolveUnmerged(ctx);
              result.conflicts.push(...ids);
              for (const p of written) await git(['add', '-A', '--', p], { cwd: ctx.vault });
              const left = await git(['ls-files', '-u'], { cwd: ctx.vault });
              if (left.stdout.trim()) throw new EngramError(E.CONFLICT, '合併後仍有未解決的路徑', '', { left: left.stdout.slice(0, 500) }).withEn('Some paths are still unresolved after the merge');
              await git(['commit', '-q', '--no-edit'], { cwd: ctx.vault, env });
            } catch (err) {
              await git(['merge', '--abort'], { cwd: ctx.vault, allowFail: true });
              throw err;
            }
          };
          let m = await runMerge();
          // 同一種「被未提交的檔案擋住」連續第 3 次：診斷；擋住的全是被扣住的檔案就自動修復（S2）
          if (m.code !== 0 && OVERWRITE_RE.test(m.stderr + m.stdout) && streakOf(prevState, OVERWRITE_KEY) + 1 >= SELF_HEAL_AFTER) {
            const h = await healBlockedMerge(ctx, { blockers: parseOverwriteBlockers(m.stderr + m.stdout), plan, headBefore: head, theirsRef: 'refs/remotes/origin/main', merge: async () => finishMerge(await runMerge()) });
            diagnosis = h.diagnosis;
            if (h.merged) m = null;
          }
          if (m) await finishMerge(m);
          const pulled = await git(['rev-list', '--count', `${head}..HEAD`], { cwd: ctx.vault });
          // 合併時扣掉合併 commit 本身；快轉沒有合併 commit
          result.pulled += Math.max(0, Number(pulled.stdout.trim()) - (ab.ahead === 0 ? 0 : 1));
          // 合併器寫入的衝突紀錄
          const fresh = await git(['diff', '--name-only', '--diff-filter=A', `${head}..HEAD`, '--', 'conflicts/'], { cwd: ctx.vault, allowFail: true });
          for (const f of fresh.stdout.split('\n')) { const id = /^conflicts\/(cf_[^/]+)\/meta\.json$/.exec(f)?.[1]; if (id && !result.conflicts.includes(id)) result.conflicts.push(id); }
          const cps = await conflictPaths(ctx);
          for (const p of cps) { const id = /conflicts\/(cf_[^/]+)\//.exec(p)?.[1]; if (id && !result.conflicts.includes(id)) result.conflicts.push(id); }
          // 合併後整理，並且再過一次同樣的防護後才提交（M6）
          const written2 = await tidy(ctx, { normalize: doNormalize });
          for (const p of cps) written2.add(p);
          const plan2 = await planCommit(ctx, { now: Date.now(), engineWritten: written2, allow });
          const tidyStage = plan2.stage.filter((p) => written2.has(p) || p.startsWith('conflicts/'));
          if (tidyStage.length) await commitPaths(ctx.vault, tidyStage, 'sync tidy', { action: 'tidy', mid: ctx.mid, guard: true, allow });
        }
        const ab2 = await aheadBehind(ctx);
        if (!ab2.remoteBranch || ab2.ahead > 0) {
          const p = await git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.vault, timeoutMs, allowFail: true });
          if (p.code !== 0) {
            const err = classifyGitError(p, ['push']);
            if (err.code === E.CONFLICT && round < 2) continue; // 遠端剛好又更新：再來一輪
            throw err;
          }
          result.pushed = true;
          await git(['fetch', 'origin'], { cwd: ctx.vault, timeoutMs, allowFail: true });
        }
        break;
      }
      const ab3 = await aheadBehind(ctx);
      syncState = { state: 'ok', ahead: ab3.ahead ?? 0, behind: ab3.behind ?? 0 };
    }

    const held = plan.secrets.map((s) => ({ ref: s.ref, reason: 'secret', kinds: s.kinds }));
    if (plan.secrets.length) syncState.blockedBySecrets = plan.secrets.map((s) => s.ref);
    await updateState(ctx.local, {
      remote: remote ?? prevState.remote ?? null,
      heldDeletions: plan.held,
      heldFiles: held,
      sync: { ...syncState, lastAttemptAt: startedAt, lastSuccessAt: remote ? new Date().toISOString() : (prevState.sync?.lastSuccessAt ?? null), error: null },
      // 連續失敗的記錄只有「網路同步成功」才清掉：只做本機存檔成功，不代表同步好了
      ...(network ? { syncIssue: null } : {}),
      ...(diagnosis?.healed?.length ? { syncHeal: { at: new Date().toISOString(), files: diagnosis.healed, ...(diagnosis.preserved ? { preserved: diagnosis.preserved } : {}) } } : {}),
    });
    if (diagnosis?.healed?.length) result.diagnosis = diagnosis;
    result.state = syncState.state;
    return result;
  } catch (err) {
    const e = err instanceof EngramError ? err : new EngramError(E.GIT, err.message).withEn(err.message);
    const stateName = { [E.OFFLINE]: 'offline', [E.AUTH]: 'auth', [E.PROXY]: 'offline', [E.PUSH_PROTECTED]: 'error', [E.LOCKED]: 'busy' }[e.code] ?? 'error';
    // 連續失敗的記錄（S2）：同一種錯誤連續出現才累計。別人正在寫入（E_LOCKED）不是同步失敗，不計
    let issue;
    if (e.code !== E.LOCKED) {
      const key = issueKey(e);
      const prev = prevState.syncIssue?.key === key ? prevState.syncIssue : null;
      const count = (prev?.count ?? 0) + 1;
      const offline = stateName === 'offline';
      if (!offline && count >= SELF_HEAL_AFTER && !diagnosis) diagnosis = await diagnoseUncommitted(ctx);
      const at = new Date().toISOString();
      issue = { key, code: e.code, message: e.message, count, since: prev?.since ?? at, at, offline, ...(diagnosis ? { diagnosis } : {}) };
    }
    await updateState(ctx.local, {
      sync: { ...(prevState.sync ?? {}), state: stateName, lastAttemptAt: startedAt, lastSuccessAt: prevState.sync?.lastSuccessAt ?? null, error: e.toJSON() },
      ...(issue ? { syncIssue: issue } : {}),
    }).catch(() => {});
    return { ...result, ok: false, state: stateName, error: e.toJSON(), ...(diagnosis ? { diagnosis } : {}) };
  }
}

/** 使用者確認「真的要刪」：提交這些刪除。 */
export async function confirmDeletions(ctx, pid) {
  return ctx.locked('confirm-deletions', async () => {
    const st = await readState(ctx.local);
    const held = (st.heldDeletions ?? []).find((h) => h.pid === pid);
    if (!held) return { ok: true };
    const stillDeleted = held.refs.filter((r) => !exists(path.join(ctx.vault, ...r.split('/'))));
    const commit = await commitPaths(ctx.vault, stillDeleted, `remove ${stillDeleted.length} memories (confirmed)`, { action: 'confirm-deletions', refs: stillDeleted, mid: ctx.mid });
    await updateState(ctx.local, { heldDeletions: (st.heldDeletions ?? []).filter((h) => h.pid !== pid) });
    return { ok: true, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
  });
}

/** 使用者選「還原」：從 HEAD 取回被扣住的刪除；工作目錄裡已重新出現的檔案（Claude 事後寫回）不覆蓋（R-34）。 */
export async function restoreDeletions(ctx, pid) {
  return ctx.locked('restore-deletions', async () => {
    const st = await readState(ctx.local);
    const held = (st.heldDeletions ?? []).find((h) => h.pid === pid);
    if (!held) return { ok: true };
    const missing = held.refs.filter((r) => !exists(path.join(ctx.vault, ...r.split('/'))));
    if (missing.length) await git(['checkout', 'HEAD', '--', ...missing], { cwd: ctx.vault });
    await updateState(ctx.local, { heldDeletions: (st.heldDeletions ?? []).filter((h) => h.pid !== pid) });
    return { ok: true, restored: missing.length, kept: held.refs.length - missing.length };
  });
}
