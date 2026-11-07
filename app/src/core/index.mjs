// Engram 引擎入口。外殼（CLI、hooks、常駐程式、管理介面、匯入精靈）只透過這裡呼叫，不直接改 vault 檔案。
// API 定義見 40 號文件 §15。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { E, EngramError, invariant } from './errors.mjs';
import { exists, isLink, linkTarget, readJson, readText, safeWrite, setTempDir, writeJson } from './fsx.mjs';
import { git } from './git.mjs';
import { runHealth } from './health.mjs';
import { activity, history, undo } from './history.mjs';
import { bind, memoryPathFor, reconcile, resolveIdentity, splitCollision, unbind, junctionState } from './identity.mjs';
import { memoryRootFor, normalizeFsPath } from './paths.mjs';
import { withLock } from './lock.mjs';
import {
  createMemory, mergeMemories, moveMemory, publicSummary, readMemory, refreshIndex, removeMemory, restoreMemory, scanAllMemories, scopeOfRef,
  writeMemory,
} from './memories.mjs';
import { computeIndexBudget, indexStats, normalizeProjectIndex } from './normalize.mjs';
import { resolveHomes } from './paths.mjs';
import { SearchIndex } from './search.mjs';
import { sessionContext } from './session.mjs';
import { executeSweep, planSweep, rollbackImport } from './sweep.mjs';
import { listCollisionRenames, planCollisionRenames, renameCollisions, undoCollisionRenames } from './rename.mjs';
import { relinkRetired, retireBinding } from './retired.mjs';
import { confirmDeletions, restoreDeletions, sync } from './sync.mjs';
import { listConflicts, resolveConflict } from './conflicts.mjs';
import { allowJunctionRead, revokeAll, revokeJunctionRead } from './claudesettings.mjs';
import { addAllow, allowEntries, listAllowed, loadAllow, scanWithAllow } from './secretallow.mjs';
import { redactSecrets, secretHash } from './secrets.mjs';
import { guidelines } from './guidelines.mjs';
import { parseMemoryFile } from './frontmatter.mjs';
import { linkGraph, nameIndex, rewriteLinks } from './links.mjs';
import { loadUsage, localDetail, scanUsage, writeUsageSummary } from './usage.mjs';
import { baselineRefs, blobSha, blobText, markReviewed, needsBaseline, pendingReviews, pruneReviews, recordBaseline } from './review.mjs';
import { cleanupRuns, dreamStatus, ensureReadable, listRuns, markDreamed, prepareDream, readRun, resetDream, runText } from './dream.mjs';
import { applySuggestions, suggestionsFor } from './coresuggest.mjs';
import {
  allBindingViews, bindingsForPid, commitPaths, ENGINE_VERSION, initVault, listMachineIds, listProjectIds, loadTemplate, machineDir, projectMemoryDir,
  readBindings, readLocalMachine, readProject, readState, renderTemplate, writeBindings, writeProject,
} from './vault.mjs';

export { E, EngramError, ENGINE_VERSION };

const CORE_RULE_REF = /^core\/rules\/[^/\\:*?"<>|]+\.md$/;
export { mergeDriver } from './mergedriver.mjs';

/**
 * 初始化（安裝精靈用）：建立或 clone vault、登記本機。
 * @param {{ home?: string, claudeHome?: string, remote?: string, machineLabel?: string, userName?: string, cli?: string }} opts
 */
export async function init(opts = {}) {
  const homes = resolveHomes(opts);
  const r = await initVault({ homes, remote: opts.remote, machineLabel: opts.machineLabel, userName: opts.userName, cli: opts.cli });
  const eg = await open(opts);
  await eg._updateEnvironments();
  return { machine: { id: r.machine.mid, label: r.machine.label, hostname: os.hostname() }, vault: homes.vault, created: r.created };
}

/**
 * 開啟引擎。
 * @param {{ home?: string, claudeHome?: string }} [opts]
 */
export async function open(opts = {}) {
  const homes = resolveHomes(opts);
  const local = readLocalMachine(homes.local);
  if (!local?.mid || !exists(path.join(homes.vault, '.git'))) {
    throw new EngramError(E.NOT_FOUND, '這台電腦還沒有設定 Engram', '執行 engram install 完成首次設定', { home: homes.home }).withEn('Engram has not been set up on this computer yet', 'Run engram install to finish the first-time setup');
  }
  fs.mkdirSync(path.join(homes.local, 'tmp'), { recursive: true });
  setTempDir(path.join(homes.local, 'tmp'));
  const lockPath = path.join(homes.local, 'engram.lock');
  let searchCache = null;

  /** 引擎內部 context（各模組共用）。 */
  const ctx = {
    homes,
    vault: homes.vault,
    local: homes.local,
    mid: local.mid,
    label: local.label,
    locked: (op, fn, o) => withLock(lockPath, op, fn, o),
    scan: () => scanAllMemories(homes.vault),
    async projectNames() {
      const m = new Map();
      for (const pid of await listProjectIds(homes.vault)) m.set(pid, (await readProject(homes.vault, pid))?.name ?? pid);
      return m;
    },
    async machineLabel(mid) {
      return (await readJson(path.join(machineDir(homes.vault, mid), 'machine.json'), null))?.label ?? mid;
    },
    history: (o) => history(ctx, o),
  };

  async function readDismissed() {
    return (await readJson(path.join(homes.local, 'dismissed.json'), {})) ?? {};
  }

  async function healthCache() {
    return (await readJson(path.join(homes.local, 'cache', 'health.json'), null)) ?? null;
  }

  async function allBindings() {
    const out = {};
    for (const mid of await listMachineIds(homes.vault)) out[mid] = await readBindings(homes.vault, mid);
    return out;
  }

  async function projectObject(pid, { bindingsByMid, cache }) {
    const p = await readProject(homes.vault, pid);
    if (!p) return null;
    const memDir = projectMemoryDir(homes.vault, pid);
    const files = (await fsp.readdir(memDir).catch(() => [])).filter((n) => /\.md$/i.test(n) && !/^MEMORY\.md$/i.test(n));
    const paths = {};
    for (const [mid, b] of Object.entries(bindingsByMid)) {
      const list = bindingsForPid(b, pid).sort((x, y) => String(y.lastOpenedAt ?? '').localeCompare(String(x.lastOpenedAt ?? '')));
      if (!list.length) continue;
      const top = list[0];
      paths[mid] = { path: top.path, exists: mid === ctx.mid ? exists(top.path) : null, lastOpenedAt: top.lastOpenedAt ?? null, method: top.method, collision: top.collision, encoded: top.encoded };
    }
    let lastActivityAt = null;
    for (const f of files) {
      try {
        const t = fs.statSync(path.join(memDir, f)).mtime.toISOString();
        if (!lastActivityAt || t > lastActivityAt) lastActivityAt = t;
      } catch { /* ignore */ }
    }
    const findings = (cache?.findings ?? []).filter((f) => f.pid === pid).length;
    return {
      pid: p.id, name: p.name, aliases: p.aliases ?? [], remotes: p.remotes ?? [], paths,
      counts: { memories: files.length, findings },
      index: await indexStats(path.join(memDir, 'MEMORY.md')),
      lastActivityAt, archived: !!p.archived, mergedInto: p.mergedInto ?? undefined,
    };
  }

  async function buildSearch() {
    const mems = await ctx.scan();
    const sig = mems.map((m) => `${m.ref}:${m.size}:${m.updatedAt}`).join('|');
    if (searchCache?.sig === sig) return searchCache;
    const idx = new SearchIndex();
    const byRef = new Map();
    for (const m of mems) {
      idx.add(m.ref, { name: m.name, description: m.description, body: m._parsed.body ?? '', tags: m.tags });
      byRef.set(m.ref, m);
    }
    searchCache = { sig, idx, byRef };
    return searchCache;
  }

  /** 遮蔽與「不是金鑰」的對象：記憶檔或核心準則 */
  async function secretTargetText(ref) {
    if (scopeOfRef(ref)) return (await readMemory(ctx, ref)).raw;
    invariant(ref === 'core/CORE.md' || CORE_RULE_REF.test(String(ref)), `不是記憶或核心準則：${String(ref).slice(0, 80)}`, undefined, { message: `Not a memory or the core rules: ${String(ref).slice(0, 80)}` });
    const raw = await readText(path.join(homes.vault, ...ref.split('/')));
    if (raw === null) throw new EngramError(E.NOT_FOUND, `找不到：${ref}`).withEn(`Not found: ${ref}`);
    return raw;
  }

  function snippet(body, query) {
    const text = String(body ?? '').replace(/\s+/g, ' ').trim();
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    let at = -1;
    for (const t of terms) { at = text.toLowerCase().indexOf(t); if (at >= 0) break; }
    if (at < 0) return text.slice(0, 100);
    const start = Math.max(0, at - 40);
    return `${start ? '…' : ''}${text.slice(start, at + 80)}${at + 80 < text.length ? '…' : ''}`;
  }

  async function commitIndexes(subject) {
    const st = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: homes.vault });
    const paths = st.stdout.split('\n').map((l) => l.slice(3).trim()).filter((p) => /(MEMORY|INDEX)\.md$/i.test(p));
    return commitPaths(homes.vault, paths, subject, { action: 'tidy', mid: ctx.mid });
  }

  const machineInfo = { id: local.mid, label: local.label, hostname: os.hostname() };
  /** 改這台電腦的顯示名稱：本機與 vault 的 machine.json、git 作者名稱、CORE.md 電腦清單、單機索引標題一併更新。 */
  Object.defineProperty(machineInfo, 'rename', {
    enumerable: false,
    value: async (label) => {
      invariant(label && String(label).trim(), '請提供名稱', undefined, { message: 'Provide a name' });
      const name = String(label).trim();
      await ctx.locked('machine.rename', async () => {
        const lp = path.join(homes.local, 'machine.json');
        await writeJson(lp, { ...(await readJson(lp, {})), label: name });
        const vp = path.join(machineDir(homes.vault, ctx.mid), 'machine.json');
        await writeJson(vp, { ...(await readJson(vp, {})), label: name });
        await git(['config', '--local', 'user.name', `Engram · ${name}`], { cwd: homes.vault });
        ctx.label = name;
        machineInfo.label = name;
        const idx = await refreshIndex(ctx, { kind: 'machine', mid: ctx.mid });
        await commitPaths(homes.vault, [`machines/${ctx.mid}/machine.json`, ...idx], `rename machine → ${name}`, { action: 'edit', mid: ctx.mid });
        await eg._updateEnvironments();
      });
      return { ok: true, label: name };
    },
  });

  const eg = {
    version: ENGINE_VERSION,
    machine: machineInfo,

    /**
     * 每台電腦各自的引擎設定（local/settings.json）。bindAuto：'confident'（預設）｜'ask'｜'off'（40 號 §08）。
     * collisionRename：撞名資料夾依命名規則改名（SW-4）'ask'（預設，收件匣一鍵改）｜'auto'（常駐程式在安全時自動改）｜'off'。
     * 預設詢問：改名會影響 Engram 以外的東西（捷徑、編輯器、/resume 清單），新安裝的人先看過建議再決定。
     */
    settings: {
      async get() {
        const s = (await readJson(path.join(homes.local, 'settings.json'), null)) ?? {};
        return {
          bindAuto: ['confident', 'ask', 'off'].includes(s.bindAuto) ? s.bindAuto : 'confident',
          collisionRename: ['auto', 'ask', 'off'].includes(s.collisionRename) ? s.collisionRename : 'ask',
          // 1.4.0：Claude 寫入每次都會載入的內容（全域、單機、核心準則）時，在收件匣請你確認（H23）
          reviewWrites: s.reviewWrites === 'off' ? 'off' : 'on',
          // 1.5.0：自動駕駛（AI 自主判斷並處理收件匣、整理、對話回顧）。autopilotBudget：每月上限（API 牌價的美元）
          autopilot: s.autopilot === 'on' ? 'on' : 'off',
          autopilotBudget: Number.isFinite(s.autopilotBudget) && s.autopilotBudget > 0 ? s.autopilotBudget : 30,
        };
      },
      async set(patch = {}) {
        if (patch.bindAuto !== undefined) invariant(['confident', 'ask', 'off'].includes(patch.bindAuto), "bindAuto 必須是 'confident'、'ask' 或 'off'", undefined, { message: "bindAuto must be 'confident', 'ask' or 'off'" });
        if (patch.collisionRename !== undefined) invariant(['auto', 'ask', 'off'].includes(patch.collisionRename), "collisionRename 必須是 'auto'、'ask' 或 'off'", undefined, { message: "collisionRename must be 'auto', 'ask' or 'off'" });
        if (patch.reviewWrites !== undefined) invariant(['on', 'off'].includes(patch.reviewWrites), "reviewWrites 必須是 'on' 或 'off'", undefined, { message: "reviewWrites must be 'on' or 'off'" });
        if (patch.autopilot !== undefined) invariant(['on', 'off'].includes(patch.autopilot), "autopilot 必須是 'on' 或 'off'", undefined, { message: "autopilot must be 'on' or 'off'" });
        if (patch.autopilotBudget !== undefined) invariant(Number.isFinite(patch.autopilotBudget) && patch.autopilotBudget >= 1 && patch.autopilotBudget <= 1000, 'autopilotBudget 必須是 1 到 1000 的數字（美元）', undefined, { message: 'autopilotBudget must be a number from 1 to 1000 (US dollars)' });
        const p = path.join(homes.local, 'settings.json');
        const next = { ...((await readJson(p, null)) ?? {}), ...patch };
        await writeJson(p, next);
        return eg.settings.get();
      },
    },
    paths: { home: homes.home, vault: homes.vault, local: homes.local, claudeHome: homes.claudeHome },

    async status() {
      const state = await readState(homes.local);
      const cache = await healthCache();
      const mems = await ctx.scan();
      const head = await git(['rev-parse', '--short', 'HEAD'], { cwd: homes.vault, allowFail: true });
      const remote = await git(['remote', 'get-url', 'origin'], { cwd: homes.vault, allowFail: true });
      const devices = [];
      for (const mid of await listMachineIds(homes.vault)) {
        const m = await readJson(path.join(machineDir(homes.vault, mid), 'machine.json'), {});
        const isSelf = mid === ctx.mid;
        devices.push({
          id: mid, label: m.label ?? mid, lastSeenAt: m.lastSeenAt ?? null,
          // 自己用本機最準確的時間；其他電腦用它寫在 machine.json 的時間（最多每 6 小時更新一次）
          lastSyncAt: isSelf ? (state.sync?.lastSuccessAt ?? m.lastSyncAt ?? null) : (m.lastSyncAt ?? null),
          engramVersion: m.engramVersion ?? null, isSelf,
        });
      }
      const conflicts = (await listConflicts(homes.vault)).length;
      const sev = { high: 0, medium: 0, low: 0 };
      for (const f of cache?.findings ?? []) if (sev[f.severity] !== undefined) sev[f.severity]++;
      return {
        machine: eg.machine,
        vault: { path: homes.vault, remote: remote.code === 0 ? remote.stdout.trim() : null, branch: 'main', head: head.code === 0 ? head.stdout.trim() : null },
        sync: {
          state: state.sync?.state ?? (remote.code === 0 ? 'never' : 'never'),
          lastSuccessAt: state.sync?.lastSuccessAt ?? null,
          lastAttemptAt: state.sync?.lastAttemptAt ?? null,
          ahead: state.sync?.ahead ?? 0,
          behind: state.sync?.behind ?? 0,
          // 被密鑰關卡擋下、沒有推送的檔案；被扣住的大量刪除另列
          held: (state.heldFiles ?? []).map((h) => ({ ref: h.ref, reason: h.reason })),
          heldDeletions: (state.heldDeletions ?? []).map((h) => ({ pid: h.pid, count: h.refs.length })),
          ...(state.sync?.error ? { error: state.sync.error } : {}),
        },
        counts: {
          global: mems.filter((m) => m.scope?.kind === 'global').length,
          projects: (await listProjectIds(homes.vault)).length,
          projectMemories: mems.filter((m) => m.scope?.kind === 'project').length,
          machine: mems.filter((m) => m.scope?.kind === 'machine' && m.scope.mid === ctx.mid).length,
          total: mems.length,
        },
        inbox: { conflicts, findings: sev, checkedAt: cache?.at ?? null },
        devices,
      };
    },

    sessionContext: (input) => sessionContext(ctx, input),
    activity: (o) => activity(ctx, o),

    projects: {
      async list({ includeArchived = true } = {}) {
        const bindingsByMid = await allBindings();
        const cache = await healthCache();
        const out = [];
        for (const pid of await listProjectIds(homes.vault)) {
          const p = await projectObject(pid, { bindingsByMid, cache });
          if (p && !p.mergedInto && (includeArchived || !p.archived)) out.push(p);
        }
        return out.sort((a, b) => String(b.lastActivityAt ?? '').localeCompare(String(a.lastActivityAt ?? '')));
      },
      async get(pid) {
        const p = await projectObject(pid, { bindingsByMid: await allBindings(), cache: await healthCache() });
        if (!p) throw new EngramError(E.NOT_FOUND, `找不到專案：${pid}`).withEn(`Project not found: ${pid}`);
        return p;
      },
      async rename(pid, name) {
        invariant(name && String(name).trim(), '請提供名稱', undefined, { message: 'Provide a name' });
        return ctx.locked('projects.rename', async () => {
          const p = await readProject(homes.vault, pid);
          if (!p) throw new EngramError(E.NOT_FOUND, `找不到專案：${pid}`).withEn(`Project not found: ${pid}`);
          p.name = String(name).trim();
          await writeProject(homes.vault, p);
          const commit = await commitPaths(homes.vault, [`projects/${pid}/project.json`], `rename ${pid} → ${p.name}`, { action: 'edit', mid: ctx.mid });
          return { ok: true, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
        });
      },
      async link(fromPid, toPid) {
        invariant(fromPid !== toPid, '不能連結到自己', undefined, { message: 'A project cannot be linked to itself' });
        return ctx.locked('projects.link', async () => {
          const from = await readProject(homes.vault, fromPid);
          const to = await readProject(homes.vault, toPid);
          if (!from || !to) throw new EngramError(E.NOT_FOUND, '找不到專案').withEn('Project not found');
          const src = projectMemoryDir(homes.vault, fromPid);
          const dest = projectMemoryDir(homes.vault, toPid);
          const { copyMemoriesInto } = await import('./identity.mjs');
          await copyMemoriesInto(src, dest);
          for (const n of await fsp.readdir(src).catch(() => [])) if (/\.md$/i.test(n)) await fsp.rm(path.join(src, n), { force: true });
          to.aliases = [...new Set([...(to.aliases ?? []), from.name, ...(from.aliases ?? [])])];
          to.remotes = [...new Set([...(to.remotes ?? []), ...(from.remotes ?? [])])].sort();
          to.rootCommits = [...new Set([...(to.rootCommits ?? []), ...(from.rootCommits ?? [])])].sort();
          from.mergedInto = toPid;
          await writeProject(homes.vault, to);
          await writeProject(homes.vault, from);
          await normalizeProjectIndex(dest, { skipRecentMs: 0 });
          // 本機的綁定改指向目標專案
          const bindings = await readBindings(homes.vault, ctx.mid);
          const relink = [];
          for (const [enc, b] of Object.entries(bindings)) if (b.pid === fromPid) { bindings[enc] = { ...b, pid: toPid }; relink.push(b.path); }
          await writeBindings(homes.vault, ctx.mid, bindings);
          // 1.4.1：已移除的舊綁定（對話回顧用）也改到合併後的專案
          await relinkRetired(ctx.local, fromPid, toPid);
          const commit = await commitPaths(homes.vault, [`projects/${fromPid}`, `projects/${toPid}`, `machines/${ctx.mid}/bindings.json`], `link ${fromPid} → ${toPid}`, { action: 'link', mid: ctx.mid });
          for (const p of relink) if (exists(p)) await bind(ctx, p, { pid: toPid }, { mode: 'safe', force: true }).catch(() => {});
          return { ok: true, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
        });
      },
    },

    identity: {
      resolve: (dir) => resolveIdentity(ctx, dir),
      bind: (dir, target, o) => bind(ctx, dir, target, o),
      unbind: (dir) => unbind(ctx, dir),
      /** 依目前的預設權限模式收斂所有綁定（R-52）：常駐程式定期呼叫；不需要時只讀檔。 */
      reconcile: (o) => reconcile(ctx, o),
      /** 等待切換成 junction 的綁定（常駐程式在對話結束後處理）。 */
      async pending() {
        return allBindingViews(await readBindings(homes.vault, ctx.mid))
          .filter((b) => b.state === 'pending')
          .map((b) => ({ path: b.path, pid: b.pid, encoded: b.encoded, since: b.boundAt ?? null, reason: b.reason ?? null }));
      },
    },

    memories: {
      async list({ scope, pid, type, q, sort = 'updated' } = {}) {
        let mems = await ctx.scan();
        if (scope) mems = mems.filter((m) => m.scope?.kind === (typeof scope === 'string' ? scope : scope.kind) && (!scope.pid || m.scope.pid === scope.pid) && (!scope.mid || m.scope.mid === scope.mid));
        if (pid) mems = mems.filter((m) => m.scope?.pid === pid);
        if (type) mems = mems.filter((m) => m.type === type);
        if (q) {
          const s = await buildSearch();
          const hits = new Set(s.idx.search(q, { limit: 500 }).map((h) => h.id));
          mems = mems.filter((m) => hits.has(m.ref));
        }
        const cache = await healthCache();
        const byRef = new Map();
        for (const f of cache?.findings ?? []) for (const r of f.refs ?? []) { if (!byRef.has(r)) byRef.set(r, new Set()); byRef.get(r).add(f.code); }
        const usage = await loadUsage(homes.vault);
        const readsOf = (ref) => usage.refs.get(ref)?.reads ?? 0;
        const cmp = {
          updated: (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
          name: (a, b) => a.name.localeCompare(b.name),
          size: (a, b) => b.size - a.size,
          reads: (a, b) => readsOf(b.ref) - readsOf(a.ref) || a.name.localeCompare(b.name),
        }[sort] ?? (() => 0);
        // 讀取統計（1.4.0）：近 90 天所有電腦合計；統計還沒開始時 usage 為 null
        return mems.sort(cmp).map((m) => {
          const u = usage.refs.get(m.ref);
          return { ...publicSummary(m), findings: [...(byRef.get(m.ref) ?? [])], usage: usage.machines ? { reads: u?.reads ?? 0, last: u?.last ?? null } : null };
        });
      },
      async read(ref, o) {
        const mem = await readMemory(ctx, ref, o);
        // 介面遮蔽顯示用：疑似金鑰在 raw 中的位置（排除使用者標記「不是金鑰」的）
        const allow = await loadAllow(homes.local);
        mem.secretRanges = scanWithAllow(mem.raw, ref, allow).map(({ line, column, offset, length, kind }) => ({ line, column, offset, length, kind }));
        return mem;
      },
      /** [[名稱]] 連結關係（1.4.0）：連到誰、被誰連結 */
      async links(ref) {
        return linkGraph(await ctx.scan(), ref);
      },
      create: (input) => createMemory(ctx, input),
      write: (ref, input) => writeMemory(ctx, ref, input),
      move: (ref, scope, o) => moveMemory(ctx, ref, scope, { reviewed: !!o?.reviewed }),
      merge: (refs, o) => mergeMemories(ctx, refs, { into: o?.into, text: o?.text ?? o?.body, reviewed: !!o?.reviewed }),
      remove: (ref) => removeMemory(ctx, ref),
      restore: (ref, o) => restoreMemory(ctx, ref, { rev: o?.rev, reviewed: !!o?.reviewed }),
    },

    /** 對話回顧（1.4.0，/engram:dream）：挑出還沒回顧的對話、轉成文字；分析由使用者的 Claude Code 進行。 */
    dream: {
      status: (pid, o) => dreamStatus(ctx, pid, o),
      prepare: (o) => prepareDream(ctx, o),
      read: (id) => readRun(ctx, id),
      done: (id, o) => markDreamed(ctx, id, o),
      /** 撤銷一次回顧的「已回顧」記號（刪掉還沒決定的回顧記錄時） */
      reset: (id) => resetDream(ctx, id),
      /** 匯出的對話文字（整理計畫對照引句用） */
      text: (id) => runText(ctx, id),
      list: () => listRuns(ctx),
      /** 讓回顧用的子代理讀取匯出的文字時不跳權限詢問（加進 additionalDirectories；常駐程式每天確認一次） */
      ensureReadable: () => ensureReadable(ctx),
      /** 超過 14 天的回顧資料夾（放著沒完成的）清掉 */
      cleanup: () => cleanupRuns(homes.local),
    },

    /** 讀取統計（1.4.0）：從這台電腦的對話紀錄增量計算，摘要每天同步一次。 */
    usage: {
      /** 掃描新的對話紀錄；commit 時寫入這台電腦的同步摘要（每天最多一次），放不下的索引依新統計重建。 */
      async refresh({ commit = true, force = false, now = Date.now() } = {}) {
        const r = await scanUsage(ctx, { now });
        if (!commit) return r;
        return ctx.locked('usage', async () => {
          const rel = await writeUsageSummary(ctx, { now, force });
          if (!rel) return { ...r, written: false };
          const idx = [...await refreshIndex(ctx, { kind: 'global' }), ...await refreshIndex(ctx, { kind: 'machine', mid: ctx.mid })];
          const commitInfo = await commitPaths(homes.vault, [rel, ...idx], 'usage summary', { action: 'usage', mid: ctx.mid });
          return { ...r, written: true, commit: commitInfo ?? undefined };
        });
      },
      /** 單一記憶：所有電腦合計（近 90 天）與這台電腦每天的次數 */
      async get(ref) {
        const u = await loadUsage(homes.vault);
        const e = u.refs.get(ref) ?? null;
        return {
          tracking: u.machines > 0,
          since: u.since,
          reads: e?.reads ?? 0,
          last: e?.last ?? null,
          projects: e?.projects ?? {},
          byMachine: e?.byMachine ?? {},
          daily: await localDetail(ctx, ref),
        };
      },
    },

    async search(query, { limit = 20 } = {}) {
      if (!String(query ?? '').trim()) return [];
      const s = await buildSearch();
      // M5：結果會交給 Claude（engram search）。說明與內文先在本機遮蔽疑似金鑰，再從遮蔽後的內文取摘要
      // （先取摘要再遮蔽的話，被摘要邊界切斷的金鑰會偵測不到）。不套用「不是金鑰」清單：那份清單的行號以整份檔案計算，寧可多遮
      const safe = (t) => redactSecrets(String(t ?? '')).text;
      return s.idx.search(query, { limit }).map((h) => {
        const m = s.byRef.get(h.id);
        return { ref: h.id, scope: m?.scope ?? null, name: safe(m?.name), description: safe(m?.description), snippet: snippet(safe(m?._parsed?.body), query), score: Number(h.score.toFixed(4)) };
      });
    },

    async normalize() {
      return ctx.locked('normalize', async () => {
        for (const pid of await listProjectIds(homes.vault)) await normalizeProjectIndex(projectMemoryDir(homes.vault, pid), { skipRecentMs: 10_000 });
        await refreshIndex(ctx, { kind: 'global' });
        await refreshIndex(ctx, { kind: 'machine', mid: ctx.mid });
        const commit = await commitIndexes('normalize indexes');
        return { ok: true, commit: commit ?? undefined };
      });
    },

    sweepLegacy: async ({ dryRun = true, plan, encoded, bindSources } = {}) => {
      if (dryRun) return planSweep(ctx, { encoded });
      return executeSweep(ctx, plan ?? await planSweep(ctx, { encoded }), { bindSources });
    },
    /** 一鍵還原一次匯入（restorePoint 為 sweepLegacy 執行結果中的 tag）。 */
    rollbackImport: (tag) => rollbackImport(ctx, tag),
    /** 索引預算（41 號 §02）：匯入預覽顯示「哪些記憶不會出現在索引上」用。 */
    indexBudget: () => computeIndexBudget(homes.vault, ctx.mid),

    sync: (o) => sync(ctx, o),

    /**
     * 待你確認的寫入（1.4.0，H23）：Claude 改了每次都會載入的內容（全域、這台的單機記憶、核心準則），使用者還沒看過。
     * 介面的寫入、記憶整理、save 技能（--reviewed）會自動記為確認過。
     */
    review: {
      /** 起點：這台電腦第一次執行時，現有內容全部記為確認過（只做一次） */
      async baseline() {
        if (!(await needsBaseline(ctx))) return { ok: true, skipped: true };
        return ctx.locked('review.baseline', async () => {
          if (!(await needsBaseline(ctx))) return { ok: true, skipped: true };
          const rv = await markReviewed(ctx, await baselineRefs(ctx));
          const commit = rv.length ? await commitPaths(homes.vault, rv, 'review baseline', { action: 'review', mid: ctx.mid }) : null;
          await recordBaseline(ctx);
          return { ok: true, commit: commit ?? undefined };
        });
      },
      /** 每筆記憶這台只留最近 20 個確認過的版本（常駐程式每日健康檢查時做，獨立的 commit，不能復原也不必復原） */
      async prune() {
        return ctx.locked('review.prune', async () => {
          const removed = await pruneReviews(ctx);
          const commit = removed.length ? await commitPaths(homes.vault, removed, `review prune ${removed.length}`, { action: 'review', mid: ctx.mid }) : null;
          return { ok: true, removed: removed.length, commit: commit ?? undefined };
        });
      },
      /** 還沒確認的內容，附目前與上次確認的版本（疑似金鑰已遮蔽） */
      async list() {
        await eg.review.baseline();
        const allow = await loadAllow(homes.local);
        const out = [];
        for (const p of await pendingReviews(ctx)) {
          const raw = (await readText(path.join(homes.vault, ...p.ref.split('/')))) ?? '';
          const prevRaw = p.previous ? await blobText(homes.vault, p.previous) : null;
          const red = (t) => redactSecrets(t, allowEntries(allow, p.ref)).text;
          const fm = /^core\//.test(p.ref) ? {} : (parseMemoryFile(raw).data ?? {});
          const last = (await history(ctx, { ref: p.ref, limit: 1 }).catch(() => []))[0] ?? null;
          out.push({
            ref: p.ref,
            kind: p.previous ? 'changed' : 'new',
            sha: p.sha,
            name: /^core\//.test(p.ref) ? path.posix.basename(p.ref) : String(fm.name ?? path.posix.basename(p.ref, '.md')),
            description: red(String(fm.description ?? '')),
            current: red(raw),
            previous: prevRaw === null ? null : red(prevRaw),
            previousMissing: !!p.previous && prevRaw === null,
            changedAt: last?.at ?? null,
            machine: last?.machine ?? null,
          });
        }
        return out;
      },
      /** 確認：items 帶當時看到的 sha，內容剛好又變了的不算（回傳在 stale） */
      async confirm(items) {
        invariant(Array.isArray(items) && items.length, '沒有要確認的項目', undefined, { message: 'Nothing to confirm' });
        return ctx.locked('review.confirm', async () => {
          const ok = [];
          const stale = [];
          for (const it of items) {
            const ref = String(it?.ref ?? '');
            const raw = /^(global|machines|core)\//.test(ref) && !ref.split('/').includes('..') ? await readText(path.join(homes.vault, ...ref.split('/'))) : null;
            if (raw !== null && blobSha(raw) === String(it?.sha ?? '')) ok.push(ref); else stale.push(ref);
          }
          const rv = await markReviewed(ctx, ok);
          const commit = rv.length ? await commitPaths(homes.vault, rv, `review ${ok.length}`, { action: 'review', refs: ok, mid: ctx.mid }) : null;
          return { ok: true, confirmed: ok, stale, commit: commit ?? undefined };
        });
      },
      /** 退回：改回最近一次確認的版本；新增的封存（可從歷史還原）。sha：使用者看到的版本，內容之後又變了就不退回 */
      async revert(ref, sha) {
        const p = (await pendingReviews(ctx)).find((x) => x.ref === ref);
        invariant(p, `「${ref}」不需要確認`, '重新整理清單', { message: `"${ref}" does not need review`, hint: 'Refresh the list' });
        if (sha !== undefined && sha !== null && sha !== '' && String(sha) !== p.sha) throw new EngramError(E.CONFLICT, `「${ref}」在你檢視之後又被修改，沒有退回`, '重新整理清單再看一次').withEn(`"${ref}" changed after you looked at it, so it was not reverted`, 'Refresh the list and look again');
        if (!p.previous) {
          invariant(!/^core\//.test(ref), '核心準則沒有確認過的版本可以退回', '請改用編輯', { message: 'There is no reviewed version of the core rules to go back to', hint: 'Edit it instead' });
          return removeMemory(ctx, ref);
        }
        const prev = await blobText(homes.vault, p.previous);
        invariant(prev !== null, '找不到確認過的版本', '請改用編輯或歷史還原', { message: 'The reviewed version could not be found', hint: 'Edit it, or restore it from its history' });
        if (ref === 'core/CORE.md') return eg.core.write(prev, { reviewed: true });
        if (CORE_RULE_REF.test(ref)) {
          return ctx.locked('review.revert', async () => {
            await safeWrite(path.join(homes.vault, ...ref.split('/')), prev);
            const rv = await markReviewed(ctx, [ref]);
            const commit = await commitPaths(homes.vault, [ref, ...rv], `edit ${ref}`, { action: 'edit', refs: [ref], mid: ctx.mid });
            return { ok: true, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
          });
        }
        return writeMemory(ctx, ref, { text: prev, reviewed: true });
      },
    },

    async health({ includeDismissed = false } = {}) {
      // 確認紀錄的起點不在這裡建立（會產生 commit）：由常駐程式的每日健康檢查與「待確認」清單建立，起點建立前 H23 不判斷
      const mems = await ctx.scan();
      const all = await runHealth(ctx, { memories: mems });
      const dismissed = await readDismissed();
      const now = Date.now();
      const hidden = (f) => { const d = dismissed[f.id]; return d && (!d.until || Date.parse(d.until) > now); };
      const findings = all.filter((f) => !hidden(f));
      const inboxCount = findings.filter((f) => f.severity !== 'auto').length;
      await fsp.mkdir(path.join(homes.local, 'cache'), { recursive: true });
      await writeJson(path.join(homes.local, 'cache', 'health.json'), { at: new Date().toISOString(), inboxCount, findings });
      return includeDismissed ? all.map((f) => (hidden(f) ? { ...f, dismissed: dismissed[f.id] } : f)) : findings;
    },

    /** 健康卡片的「忽略」與「稍後」（M6）：記在 local/dismissed.json；doctor 照常列出。 */
    findings: {
      async dismiss(id, { until } = {}) {
        invariant(id, '缺少 finding id', undefined, { message: 'Missing finding id' });
        const d = await readDismissed();
        d[id] = { at: new Date().toISOString(), until: until ? new Date(until).toISOString() : null };
        await writeJson(path.join(homes.local, 'dismissed.json'), d);
        return { ok: true };
      },
      async restore(id) {
        const d = await readDismissed();
        delete d[id];
        await writeJson(path.join(homes.local, 'dismissed.json'), d);
        return { ok: true };
      },
    },

    /** 本機遮蔽金鑰（M5）：不經過模型，避免把金鑰送到 API。對象是記憶檔或核心準則（core/CORE.md、core/rules/*.md）。 */
    secrets: {
      async preview(ref) {
        const raw = await secretTargetText(ref);
        const { text, matches } = redactSecrets(raw, allowEntries(await loadAllow(homes.local), ref));
        return { before: raw, after: text, matches };
      },
      async redact(ref) {
        const p = await eg.secrets.preview(ref);
        if (!p.matches.length) return { ok: true };
        if (ref === 'core/CORE.md') return eg.core.write(p.after, { carryReviewed: true });
        if (CORE_RULE_REF.test(ref)) {
          return ctx.locked('secrets.redact', async () => {
            await safeWrite(path.join(homes.vault, ...ref.split('/')), p.after);
            const { carryReviewed } = await import('./review.mjs');
            const rv = await carryReviewed(ctx, new Map([[ref, p.before]]));
            const commit = await commitPaths(homes.vault, [ref, ...rv], `edit ${ref}`, { action: 'edit', refs: [ref], mid: ctx.mid });
            return { ok: true, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
          });
        }
        // 遮蔽是機械式的改寫：改之前確認過才算確認過（Claude 寫進來的其他內容不會因此被確認掉）
        return writeMemory(ctx, ref, { text: p.after, carryReviewed: true });
      },
      /** 「這不是金鑰」（介面的按鈕、engram not-secret <ref> --line）：清單檔與這個檔案放在同一個 commit，另一台電腦同時收到兩者 */
      async allow(ref, line) {
        const raw = await secretTargetText(ref);
        const hits = scanWithAllow(raw, ref, await loadAllow(homes.local)).filter((h) => h.line === Number(line));
        invariant(hits.length, `第 ${line} 行沒有疑似金鑰`, undefined, { message: `No possible secret on line ${line}` });
        return ctx.locked('secrets.allow', async () => {
          const added = [];
          for (const h of hits) added.push(await addAllow(homes.local, ref, { preview: h.preview, hash: secretHash(raw.slice(h.offset, h.offset + h.length)) }));
          // 只 commit 清單檔：記憶本身交給下一次同步的自動存檔（照常套用「10 秒內改過的不提交」），清單會先到或同時到另一台電腦
          const commit = await commitPaths(homes.vault, [...new Set(added)], `not-secret ${ref}`, { action: 'allow', refs: [ref], mid: ctx.mid });
          return { ok: true, allowed: hits.length, commit: commit ?? undefined };
        });
      },
      /** 「不是金鑰」清單：列出與移除（標錯時撤銷；移除後這個值會重新被當成金鑰） */
      listAllowed: () => listAllowed(homes.local),
      async removeAllowed(hash) {
        invariant(/^[0-9a-f]{32}$/.test(String(hash)), '雜湊格式不正確', undefined, { message: 'The hash format is invalid' });
        return ctx.locked('secrets.allow', async () => {
          const rel = `not-secrets/${hash}`;
          if (!exists(path.join(homes.vault, ...rel.split('/')))) throw new EngramError(E.NOT_FOUND, `清單裡沒有 ${hash}`).withEn(`${hash} is not in the list`);
          await fsp.rm(path.join(homes.vault, ...rel.split('/')), { force: true });
          const commit = await commitPaths(homes.vault, [rel], 'remove not-secret', { action: 'allow', mid: ctx.mid });
          return { ok: true, commit: commit ?? undefined };
        });
      },
      /** 使用者確認某個值不是金鑰（engram not-secret --value）：之後任何檔案裡的這個值都不再當成金鑰 */
      async allowValue(value) {
        invariant(typeof value === 'string' && value.length >= 6 && value.length <= 4096 && !/[\r\n]/.test(value), '值必須是 6 個字元以上、只有一行的文字', undefined, { message: 'The value must be single-line text of at least 6 characters' });
        // 只收真的會被判定為疑似金鑰的值（寫在 token: 後面、或本身就是），一般單字不需要也不該進清單
        const { scanSecrets } = await import('./secrets.mjs');
        const flagged = [value, `token: ${value}`].some((t) => scanSecrets(t).some((h) => t.slice(h.offset, h.offset + h.length) === value));
        invariant(flagged, '這個值不會被判定為疑似金鑰，不需要加入清單', '只有被 Engram 判定為疑似金鑰、而你確定不是的值才需要加入', { message: 'This value would not be flagged as a possible secret, so it does not need to be added to the list', hint: 'Only values that Engram flags as possible secrets and that you are sure are not secrets need to be added' });
        return ctx.locked('secrets.allow', async () => {
          const rel = await addAllow(homes.local, null, { preview: `${value.slice(0, 4)}…(${value.length})`, hash: secretHash(value) });
          const commit = await commitPaths(homes.vault, [rel], 'not-secret value', { action: 'allow', mid: ctx.mid });
          return { ok: true, commit: commit ?? undefined };
        });
      },
    },

    /** reviewed：目前沒有呼叫端帶 true。收件匣的一鍵動作（管理介面或 /engram:inbox）不代表使用者讀過全文，搬移後的內容不會被記為確認過 */
    async apply(fix, { reviewed = false } = {}) {
      invariant(fix && fix.action, '缺少 fix.action', undefined, { message: 'Missing fix.action' });
      const a = fix.args ?? {};
      // R-45：args 可能來自介面的請求，路徑類參數一律對照引擎自己的紀錄，不接受任意路徑
      const bindingsNow = async () => allBindingViews(await readBindings(homes.vault, ctx.mid));
      const encodedOk = (e) => typeof e === 'string' && /^[A-Za-z0-9-]{1,200}$/.test(e);
      switch (fix.action) {
        case 'normalize': return eg.normalize();
        case 'sync': return eg.sync();
        case 'move': return eg.memories.move(a.ref, a.scope, { reviewed });
        case 'remove': return eg.memories.remove(a.ref);
        case 'rebind': {
          const b = (await bindingsNow()).find((v) => v.path && a.dir && v.path.toLowerCase() === String(a.dir).toLowerCase());
          invariant(b, '這個資料夾沒有綁定紀錄', undefined, { message: 'This folder has no binding record' });
          return eg.identity.bind(b.path, { pid: b.pid }, { mode: 'safe', force: !!a.force });
        }
        case 'sweep': {
          invariant(encodedOk(a.encoded) && exists(path.join(homes.claudeHome, 'projects', a.encoded)), '不合法的來源', undefined, { message: 'Invalid source' });
          const plan = await planSweep(ctx, { encoded: a.encoded });
          // 1.4.1：一鍵收編（H05）沒有人看過計畫，記憶一律留在專案範圍。
          // 匯入精靈的範圍建議（user 型→全域、提到主機名稱→單機）只是猜測；要不要升級或搬到單機交給收件匣的 H08／H09
          for (const src of plan.sources) {
            for (const it of src.items) {
              if ((it.scope ?? 'project') === 'project') continue;
              it.scope = 'project';
              it.reason = '一鍵收編一律先放在專案，收件匣會建議是否升級全域或移到單機';
              it.en = { reason: 'One-click adoption keeps memories in the project; the inbox will suggest whether to promote them or move them to a machine' };
            }
          }
          if (a.pid !== undefined) {
            // 收編到既有專案（H05 的候選）：只接受這個資料夾目前的候選，不接受任意專案
            invariant(typeof a.pid === 'string', '不合法的專案', undefined, { message: 'Invalid project' });
            invariant(plan.sources.length === 1, '這個記憶資料夾有好幾個資料夾在用，不能一鍵收編到既有專案', '改用管理介面的「匯入」逐一指定每個來源的專案', { message: 'Several folders share this memory folder, so it cannot be adopted into an existing project in one click', hint: 'Use Import in the dashboard to choose the project for each source' });
            const src = plan.sources[0];
            const cand = src.exists && src.target?.isNew ? src.suggestions.find((x) => x.kind === 'project' && x.pid === a.pid) : null;
            invariant(cand, `「${a.pid}」不是這個資料夾的候選專案`, '重新整理收件匣', { message: `"${a.pid}" is not a candidate project for this folder`, hint: 'Refresh the inbox' });
            src.target = { pid: a.pid, name: cand.name, isNew: false, archived: false };
          }
          return eg.sweepLegacy({ dryRun: false, plan });
        }
        case 'allow-read': {
          // 只允許「確實存在的 junction 綁定」的記憶資料夾；可傳 encoded（建議）或舊的 path
          const views = (await bindingsNow()).filter((v) => v.method === 'junction');
          const enc = a.encoded ?? views.find((v) => a.path && memoryPathFor(homes, v.encoded).toLowerCase() === String(a.path).toLowerCase())?.encoded;
          invariant(encodedOk(enc) && views.some((v) => v.encoded.toLowerCase() === enc.toLowerCase()), '只能允許已綁定專案的記憶資料夾', undefined, { message: 'Only the memory folders of bound projects can be allowed' });
          await allowJunctionRead(homes, memoryPathFor(homes, enc));
          return { ok: true };
        }
        case 'split': {
          invariant(encodedOk(a.encoded) && (await bindingsNow()).some((v) => v.encoded.toLowerCase() === a.encoded.toLowerCase()), '找不到這個綁定', undefined, { message: 'Binding not found' });
          return splitCollision(ctx, a.encoded, { force: !!a.force });
        }
        case 'reassign': {
          // H19：把撞名期間寫錯地方的記憶移到它真正所屬的資料夾（必要時建立專案並以設定檔備援綁定）
          // root 必須是 Claude Code 真的開過的資料夾（transcript 的 cwd），不接受任意路徑
          const { scanAll, sessionIndex } = await import('./transcripts.mjs');
          const roots = [...new Set([...sessionIndex(await scanAll(homes.claudeHome)).values()].map((c) => memoryRootFor(c).root.toLowerCase()))];
          invariant(a.root && roots.includes(memoryRootFor(String(a.root)).root.toLowerCase()), '這個資料夾沒有 Claude Code 的對話紀錄', undefined, { message: 'This folder has no Claude Code conversations' });
          const res = await resolveIdentity(ctx, a.root);
          const target = res.pid ?? null;
          const b = await bind(ctx, a.root, target ? { pid: target } : { create: { name: path.basename(a.root) } }, { mode: 'safe' });
          return eg.memories.move(a.ref, { kind: 'project', pid: b.pid }, { reviewed });
        }
        case 'reconcile-bindings': return reconcile(ctx, { force: !!a.force });
        case 'rename-collisions': {
          // 只接受引擎自己盤點出來、可以改名的資料夾（R-45：不接受任意路徑）
          const plan = await planCollisionRenames(ctx);
          const paths = (Array.isArray(a.paths) ? a.paths : []).filter((p) => plan.some((it) => it.to && !it.blocked && it.path.toLowerCase() === String(p).toLowerCase()));
          invariant(paths.length, '這些資料夾目前不需要或不能改名，請重新整理收件匣', undefined, { message: 'These folders do not need renaming or cannot be renamed right now. Refresh the inbox' });
          return renameCollisions(ctx, { paths });
        }
        case 'relink':
        case 'unlink': {
          // H21：改寫指向被合併或封存記憶的連結。只改內文裡的 [[from]]；to 必須是目前存在的記憶
          invariant(typeof a.from === 'string' && a.from.trim(), '缺少連結名稱', undefined, { message: 'Missing the link name' });
          const mems = await ctx.scan();
          if (fix.action === 'relink') invariant(typeof a.to === 'string' && nameIndex(mems).has(a.to.trim().toLowerCase()), `找不到記憶：${a.to}`, undefined, { message: `Memory not found: ${a.to}` });
          const mem = await readMemory(ctx, a.ref);
          const r = rewriteLinks(mem.raw, a.from.trim(), fix.action === 'relink' ? a.to.trim() : null);
          invariant(r.count > 0, `「${a.ref}」裡已經沒有 [[${a.from}]] 連結`, '重新整理收件匣', { message: `"${a.ref}" no longer has a [[${a.from}]] link`, hint: 'Refresh the inbox' });
          return writeMemory(ctx, a.ref, { text: r.text, carryReviewed: true });
        }
        case 'restore-deletions': return restoreDeletions(ctx, a.pid);
        case 'confirm-deletions': return confirmDeletions(ctx, a.pid);
        case 'forget-binding': return ctx.locked('forget-binding', async () => {
          const b = await readBindings(homes.vault, ctx.mid);
          invariant(typeof a.encoded === 'string' && Object.hasOwn(b, a.encoded), '找不到這個綁定', undefined, { message: 'Binding not found' });
          // 1.4.1：舊資料夾的對話紀錄還在，記下來讓對話回顧（H20）仍能找到它們
          const old = b[a.encoded];
          await retireBinding(ctx.local, { key: a.encoded, pid: old?.pid, encoded: old?.encoded ?? a.encoded.split('@')[0], path: old?.path ?? null, boundAt: old?.boundAt ?? null }, { claudeHome: homes.claudeHome });
          // 1.4.1：拆掉舊編碼位置的 junction（比照撞名改名）。留著的話，之後在同一個路徑或編碼相同的
          // 另一個資料夾開 Claude Code，記憶會寫進這個已經不用的專案，重新綁定也會被拒絕。
          // junction 綁定的 key 就是編碼，這個位置的連結屬於這筆綁定；仍只拆指向 vault 專案記憶資料夾的，
          // 而且資料夾要確實不在了（介面送來的卡片可能過期，例如外接硬碟又接回來）
          let linkRemoved = false;
          if (old?.method === 'junction' && old.path && !exists(old.path)) {
            const mp = memoryPathFor(homes, old.encoded ?? a.encoded);
            try {
              const t = isLink(mp) ? normalizeFsPath(linkTarget(mp)).toLowerCase() : null;
              const projectsDir = normalizeFsPath(path.join(homes.vault, 'projects')).toLowerCase();
              if (t && path.basename(t) === 'memory' && normalizeFsPath(path.dirname(path.dirname(t))).toLowerCase() === projectsDir) {
                fs.rmdirSync(mp);
                linkRemoved = true;
                await revokeJunctionRead(homes, mp).catch(() => {});
              }
            } catch { /* 拆不掉不影響移除綁定 */ }
          }
          delete b[a.encoded];
          await writeBindings(homes.vault, ctx.mid, b);
          const commit = await commitPaths(homes.vault, [`machines/${ctx.mid}/bindings.json`], `forget binding ${a.encoded}`, { action: 'unbind', mid: ctx.mid });
          return { ok: true, commit: commit ?? undefined, linkRemoved };
        });
        default:
          // merge、edit、open-* 需要使用者在介面上操作
          return { ok: false, needsUi: true, action: fix.action, args: a };
      }
    },

    history: (o) => history(ctx, o),
    undo: (sha) => undo(ctx, sha),

    /** 撞名資料夾依命名規則改名（SW-4，40 號 §08）。 */
    collisions: {
      plan: () => planCollisionRenames(ctx),
      apply: (o) => renameCollisions(ctx, o),
      undo: (id) => undoCollisionRenames(ctx, id),
      list: () => listCollisionRenames(ctx),
    },

    conflicts: {
      list: () => listConflicts(homes.vault),
      resolve: (id, o) => resolveConflict(ctx, id, o),
    },

    core: {
      /** 41 號 §11 選用步驟：把 ~/.claude/CLAUDE.md 裡的個人工作準則搬進同步的 core/rules/user-guidelines.md。 */
      guidelines: guidelines(ctx),
      async read() {
        const p = path.join(homes.vault, 'core', 'CORE.md');
        return { path: p, text: (await readText(p)) ?? '', stats: await indexStats(p) };
      },
      /** 1.4.0 的建議更新（H24）：找得到原本範本的位置、而且還沒加過的才列 */
      async suggestions() {
        return suggestionsFor((await readText(path.join(homes.vault, 'core', 'CORE.md'))) ?? '');
      },
      /** 使用者在介面按「加入」：插入選定的建議（記為確認過，可用 engram undo 復原） */
      async applySuggestions(ids) {
        invariant(Array.isArray(ids) && ids.length, '沒有選擇要加入的建議', undefined, { message: 'No suggestions were selected' });
        const cur = (await readText(path.join(homes.vault, 'core', 'CORE.md'))) ?? '';
        const next = applySuggestions(cur, ids.map(String));
        invariant(next !== null, '這些建議已經加過，或核心準則裡找不到原本的位置', '重新整理頁面', { message: 'These suggestions were already added, or the core rules no longer have the original place for them', hint: 'Refresh the page' });
        // 只插入使用者看過的那幾句：其他部分原本確認過才算確認過；寫入時比對讀取時的內容，避免連按兩次互相覆蓋
        return eg.core.write(next, { carryReviewed: true, expect: cur });
      },
      async write(markdown, { allowSecrets = false, reviewed = false, carryReviewed = false, expect } = {}) {
        invariant(typeof markdown === 'string', '內容必須是文字', undefined, { message: 'The content must be text' });
        return ctx.locked('core.write', async () => {
          if (typeof expect === 'string' && ((await readText(path.join(homes.vault, 'core', 'CORE.md'))) ?? '') !== expect) {
            throw new EngramError(E.CONFLICT, '核心準則剛被修改，這次沒有寫入', '重新整理頁面再試一次').withEn('The core rules were just changed, so nothing was written', 'Refresh the page and try again');
          }
          const { assertNoNewSecrets } = await import('./secretallow.mjs');
          const allowed = await assertNoNewSecrets(homes.local, 'core/CORE.md', markdown.replace(/\r\n/g, '\n'), { before: await readText(path.join(homes.vault, 'core', 'CORE.md')), allowSecrets, what: '核心準則' });
          const before = await readText(path.join(homes.vault, 'core', 'CORE.md'));
          await safeWrite(path.join(homes.vault, 'core', 'CORE.md'), markdown.replace(/\r\n/g, '\n'));
          const rv = reviewed ? await markReviewed(ctx, ['core/CORE.md'])
            : carryReviewed ? await (await import('./review.mjs')).carryReviewed(ctx, new Map([['core/CORE.md', before]])) : [];
          const commit = await commitPaths(homes.vault, ['core/CORE.md', ...allowed, ...rv], 'edit core/CORE.md', { action: 'edit', refs: ['core/CORE.md'], mid: ctx.mid });
          return { ok: true, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
        });
      },
    },

    /** 這台電腦 ~/.claude/CLAUDE.md 要附加的管理區塊（安裝程式使用）。 */
    async claudeMdBlock() {
      const tpl = (await loadTemplate('claude-md.template.md')) ?? '';
      return renderTemplate(tpl, { generated_at: new Date().toISOString().slice(0, 10), machine_label: ctx.label, mid: ctx.mid }).replace(/\n*$/, '\n');
    },

    /** 深度檢查：健康檢查 ＋ 環境（git、合併器設定、遠端、junction、暫存資料夾）。 */
    async doctor({ network = true } = {}) {
      const checks = [];
      const add = (id, ok, label, detail = '') => checks.push({ id, ok, label, detail });
      const gv = await git(['--version'], { cwd: homes.vault, allowFail: true }).catch(() => ({ code: -1, stdout: '' }));
      add('git', gv.code === 0, 'git 執行檔', gv.stdout.trim());
      const drv = await git(['config', '--get', 'merge.engram-md.driver'], { cwd: homes.vault, allowFail: true });
      add('merge-driver', drv.code === 0 && /merge-driver/.test(drv.stdout), '記憶合併器設定', drv.stdout.trim());
      const cli = /"([^"]+engram\.mjs)"/.exec(drv.stdout)?.[1];
      add('cli', !!cli && exists(cli), 'Engram 指令檔', cli ?? '未設定');
      const attrs = await readText(path.join(homes.vault, '.gitattributes'));
      add('gitattributes', !!attrs && attrs.includes('merge=engram-md'), '.gitattributes 合併規則');
      try { const t = path.join(homes.local, 'tmp', '.probe'); fs.writeFileSync(t, 'x'); fs.rmSync(t); add('tmp', true, '暫存資料夾可寫入'); } catch (e) { add('tmp', false, '暫存資料夾可寫入', e.message); }
      // 1.4.0：對話回顧的子代理要能讀 local/dream（常駐程式啟動時加入；這裡順手補上，新對話才生效）
      const dreamDir = path.join(homes.local, 'dream');
      const { isJunctionReadAllowed } = await import('./claudesettings.mjs');
      const dreamOk = exists(dreamDir) && (await isJunctionReadAllowed(homes, dreamDir).catch(() => false));
      add('dream-dir', dreamOk, '對話回顧資料夾可讓 Claude 讀取', dreamOk ? dreamDir : '還沒加入 Claude Code 的 permissions.additionalDirectories：常駐程式啟動時會自動加入（engram agent 或重新登入）');
      const bindings = await readBindings(homes.vault, ctx.mid);
      for (const b of allBindingViews(bindings)) {
        if (b.method !== 'junction') continue;
        const j = junctionState(homes, b.encoded, b.pid);
        add(`junction:${b.encoded}`, j.state === 'ok', `記憶連結：${b.path}`, j.state);
      }
      if (network) {
        const remote = await git(['remote', 'get-url', 'origin'], { cwd: homes.vault, allowFail: true });
        if (remote.code === 0) {
          const ls = await git(['ls-remote', '--heads', 'origin'], { cwd: homes.vault, allowFail: true, timeoutMs: 15_000 });
          add('remote', ls.code === 0, `遠端連線：${remote.stdout.trim()}`, ls.code === 0 ? '' : ls.stderr.trim().slice(-300));
        } else add('remote', false, '遠端連線', '尚未設定遠端（只在本機運作）');
      }
      const findings = await eg.health({ includeDismissed: true });
      return { ok: checks.every((c) => c.ok) && !findings.some((f) => f.severity === 'high' && !f.dismissed), checks, findings };
    },

    /** 更新 CORE.md 的 engram:environments 區塊（電腦清單）。 */
    async _updateEnvironments() {
      return ctx.locked('core.environments', async () => {
        const p = path.join(homes.vault, 'core', 'CORE.md');
        const text = await readText(p);
        if (text === null) return { ok: false };
        const lines = [];
        for (const mid of await listMachineIds(homes.vault)) {
          const m = await readJson(path.join(machineDir(homes.vault, mid), 'machine.json'), {});
          lines.push(`- ${m.label ?? mid}（${mid}）`);
        }
        const re = /(<!-- engram:environments:begin -->\n)([\s\S]*?)(<!-- engram:environments:end -->)/;
        if (!re.test(text)) return { ok: false };
        const next = text.replace(re, `$1${lines.join('\n')}\n$3`);
        if (next === text) return { ok: true };
        await safeWrite(p, next);
        // 電腦清單由 Engram 維護：改之前確認過的核心準則，改之後也算確認過（不會因為加了一台電腦就跳出「待你確認」）
        const { carryReviewed } = await import('./review.mjs');
        const rv = await carryReviewed(ctx, new Map([['core/CORE.md', text]]));
        const commit = await commitPaths(homes.vault, ['core/CORE.md', ...rv], 'update environments', { action: 'tidy', mid: ctx.mid });
        return { ok: true, commit: commit ?? undefined };
      });
    },

    /**
     * 解除安裝前的本機還原：解除這台電腦所有綁定（junction 換回一般資料夾並複製記憶回去），
     * 移除 Engram 加進 ~/.claude/settings.json 的 additionalDirectories。vault 本身保留不刪。
     * ~/.claude/CLAUDE.md 的管理區塊由安裝程式移除。
     */
    async releaseMachine() {
      // 撤銷筆數以開始前的安裝清單為準（unbind 會逐一撤銷自己的那一筆）
      const before = ((await readJson(path.join(homes.local, 'install-manifest.json'), null))?.additionalDirectories ?? []).length;
      const bindings = await readBindings(homes.vault, ctx.mid);
      const released = [];
      for (const b of Object.values(bindings)) {
        try { await unbind(ctx, b.path); released.push(b.path); } catch { /* 已不存在的資料夾略過 */ }
      }
      await revokeAll(homes);
      const after = ((await readJson(path.join(homes.local, 'install-manifest.json'), null))?.additionalDirectories ?? []).length;
      return { ok: true, released, revokedPaths: before - after };
    },

    /** 內部用（測試與常駐程式）。 */
    _ctx: ctx,
  };
  return eg;
}
