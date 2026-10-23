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
import { splitCollision } from './identity.mjs';
import { computeIndexBudget, normalizeProjectIndex, rebuildScopeIndex } from './normalize.mjs';
import { loadAllow, scanWithAllow } from './secretallow.mjs';
import { hasActiveSession, scanEncodedDir } from './transcripts.mjs';
import {
  allBindingViews, commitPaths, listProjectIds, machineDir, projectMemoryDir, readBindings, readState, touchMachine, updateState,
} from './vault.mjs';

export const RECENT_MS = 10_000;
const MASS_DELETE = { min: 3, ratio: 0.5 };
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const STALE_INDEX_LOCK_MS = 10 * 60_000;

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
      if (prev.bodyHash !== bodyHash) delete meta.reviewedAt; // 內文改過 → 重新進收件匣
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
  if ((await rebuildScopeIndex({ kind: 'global', dir: path.join(ctx.vault, 'global'), userHome: ctx.homes.userHome, projectNames, budget: budget.global })).changed) written.add('global/INDEX.md');
  // 單一寫入者：只重建自己的單機索引
  if ((await rebuildScopeIndex({ kind: 'machine', dir: machineDir(ctx.vault, ctx.mid), userHome: ctx.homes.userHome, label: ctx.label, projectNames, budget: budget.machine })).changed) written.add(`machines/${ctx.mid}/INDEX.md`);
  if (await touchMachine(ctx.homes, ctx.mid)) written.add(`machines/${ctx.mid}/machine.json`);
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
    // 密鑰關卡：所有 Markdown，包括衝突隔離區（隔離的本機版本可能正是被擋下的那份，M6）
    if (/\.md$/i.test(ref)) {
      let text = null;
      try { text = await readText(abs); } catch { recent.push(ref); continue; }
      const hits = text ? scanWithAllow(text, ref, allow) : [];
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
 * 解決合併器以外的衝突。寫入失敗（檔案被占用）就丟 E_LOCKED，由呼叫端 abort 這次合併（R-32）。
 * @returns {Promise<{ ids: string[], written: string[] }>}
 */
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
      const merged = /(^|\/)project\.json$/.test(p) ? mergeProjectJson(ours, theirs) : null;
      if (merged !== null) await write(abs, merged);
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
          const m = await git(args, { cwd: ctx.vault, env, allowFail: true, timeoutMs: 120_000 });
          if (m.code !== 0) {
            if (/would be overwritten|untracked working tree files/i.test(m.stderr + m.stdout)) {
              // 本機有扣住的刪除或正在寫入的檔案，這一輪先不合併
              throw new EngramError(E.CONFLICT, '本機有尚未提交的變更，這一輪暫不合併', '處理收件匣中被扣住的刪除或疑似含有金鑰的檔案（H18、H13）；都沒有的話，稍後再同步', { stderr: m.stderr.slice(-500) })
                .withEn('There are uncommitted local changes, so this round does not merge', 'Handle the held deletions or possible-secret files in the inbox (H18, H13); if there are none, sync again in a moment');
            }
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
          }
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
    });
    // 每台電腦最後一次成功同步的時間（給其他電腦的總覽看，寫在自己的 machines/<mid>/）
    if (remote) await recordLastSync(ctx);
    result.state = syncState.state;
    return result;
  } catch (err) {
    const e = err instanceof EngramError ? err : new EngramError(E.GIT, err.message).withEn(err.message);
    const stateName = { [E.OFFLINE]: 'offline', [E.AUTH]: 'auth', [E.PROXY]: 'offline', [E.PUSH_PROTECTED]: 'error', [E.LOCKED]: 'busy' }[e.code] ?? 'error';
    await updateState(ctx.local, {
      sync: { ...(prevState.sync ?? {}), state: stateName, lastAttemptAt: startedAt, lastSuccessAt: prevState.sync?.lastSuccessAt ?? null, error: e.toJSON() },
    }).catch(() => {});
    return { ...result, ok: false, state: stateName, error: e.toJSON() };
  }
}

/** 本機最後一次成功同步的時間寫進 local/state.json（不 commit，避免每次同步都多一個 commit）；
 *  machine.json 的 lastSyncAt 跟著 lastSeenAt 的節奏（最多 6 小時一次）更新。 */
async function recordLastSync(ctx) {
  const p = path.join(machineDir(ctx.vault, ctx.mid), 'machine.json');
  const m = await readJson(p, null);
  if (!m) return;
  const last = Date.parse(m.lastSyncAt ?? 0) || 0;
  if (Date.now() - last < 6 * 3600_000) return;
  m.lastSyncAt = new Date().toISOString();
  await writeJson(p, m);
  await commitPaths(ctx.vault, [`machines/${ctx.mid}/machine.json`], 'heartbeat', { action: 'tidy', mid: ctx.mid });
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
