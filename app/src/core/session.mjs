// SessionStart 動態內容（41 號文件 §09）。純本機、不連網；任何例外都回傳空字串，不阻擋對話。
// 格式：≤ 12 行、≤ 1,200 字元。唯一的寫入：需要時綁定（設定檔＋可能的 junction，取鎖最多等 200ms）。
// 2.0.0 S5：已綁定的資料夾在常駐程式預先寫好的快取（writeSessionCache）裡；hook 先走不載入引擎的快速路徑（sessioncache.mjs），
// 快取不能用時才走這裡（完整路徑）。兩條路徑用同一個 renderSession 組文字。
import fs from 'node:fs';
import path from 'node:path';
import { allowJunctionRead } from './claudesettings.mjs';
import { createJunction, isEmptyDir, isLink, listMarkdown, readJson, readJsonSync, safeWrite } from './fsx.mjs';
import { guardrailFallback } from './guardrails.mjs';
import { CODE_FILES, codeVersion, installInfo, SESSION_CACHE_V, sessionCacheFile, signatures } from './sessioncache.mjs';
import { renderSession } from './sessiontext.mjs';
import {
  classifyEncodedBinding, junctionAllowed, junctionState, loadedMemoryIndex, memoryIndexCandidate, memoryPathFor, mergeFootprint, resolveIdentity, SETTINGS_LOCAL,
  writeSettingsBinding,
} from './identity.mjs';
import { readDirEntries } from './normalize.mjs';
import { encodeProjectPath, memoryRootFor, samePath, toTildePath } from './paths.mjs';
import {
  allBindingViews, bindingKey, findBindingByEncoded, findBindingByPath, machineDir, projectMemoryDir, readBindings, readLocalMachine, readProject, readState,
  updateState, writeBindings,
} from './vault.mjs';

// 文字的組法放在 sessiontext.mjs（純函式）：快速路徑（sessioncache.mjs）用同一份，輸出才會一字不差（2.0.0 S5）
export { relativeTime } from './sessiontext.mjs';

/**
 * 已綁定（這個路徑本身有綁定紀錄）時的專案說明、綁定狀態與警告。只讀不寫：完整路徑與常駐程式寫快取時共用。
 * @returns {Promise<{ projectPart: string, bindState: string, warnings: { priority: number, text: string }[] }>}
 */
async function boundPart(ctx, b, { fromSub }) {
  const warnings = [];
  let bindState;
  const project = await readProject(ctx.vault, b.pid);
  const projectPart = `專案：${project?.name ?? b.pid}（${b.pid}）`;
  if (b.method === 'settings' && b.collision === false) {
    bindState = '已綁定';
    if (fromSub) warnings.push({ priority: 3, text: '⚠ 這次從專案的子資料夾啟動，Claude Code 不會讀到 Engram 的設定：本次的記憶讀寫都在 Claude Code 原本的資料夾，\n  之後可以在 Engram 收件匣收進來。建議從專案根目錄開啟。' });
  } else if (b.method === 'settings') {
    bindState = '已綁定（設定檔備援）';
    warnings.push({ priority: 3, text: '⚠ 這個資料夾的名稱與其他資料夾在 Claude Code 內部撞名（中文字數相同）。Engram 已用設定檔把記憶分開，\n  但只在直接從這個資料夾啟動時有效。建議把資料夾改成英文名稱，Engram 介面可以協助。' });
  } else {
    const j = junctionState(ctx.homes, b.encoded, b.pid);
    if (j.state === 'ok') {
      bindState = '已綁定';
      if (fromSub) warnings.push({ priority: 7, text: '⚠ 這次從子資料夾啟動，記憶經由連結讀寫；對話中切到 acceptEdits 或 default 模式時，讀寫記憶會跳出詢問。\n  建議從專案根目錄開啟。' });
    } else if (b.state === 'pending' || j.state === 'dir') bindState = '等待切換';
    else {
      bindState = '綁定失效';
      warnings.push({ priority: 2, text: '⚠ 這個專案的記憶連結失效：本次寫入的記憶可能不會進入 Engram。請執行 engram doctor 修復。' });
    }
  }
  return { projectPart, bindState, warnings };
}

/** 和目前資料夾無關的狀態：衝突（含核心準則）、同步狀態、收件匣數量、使用者暫停。格式見 sessiontext.mjs 的 renderSession。 */
async function gatherShared(ctx) {
  let conflictCount = 0;
  let coreConflicts = 0;
  try {
    for (const id of fs.readdirSync(path.join(ctx.vault, 'conflicts')).filter((n) => n.startsWith('cf_'))) {
      conflictCount++;
      const meta = readJsonSync(path.join(ctx.vault, 'conflicts', id, 'meta.json'), {});
      if (meta?.ref === 'core/CORE.md') coreConflicts++;
    }
  } catch { /* 沒有衝突 */ }
  const state = await readState(ctx.local);
  const health = (await readJson(path.join(ctx.local, 'cache', 'health.json'), null)) ?? {};
  const userPaused = ((await readJson(path.join(ctx.local, 'paused.json'), null)) ?? {}).user === true;
  return {
    conflictCount,
    coreConflicts,
    inboxCount: health.inboxCount ?? 0,
    userPaused,
    state: { remote: state.remote ?? null, sync: state.sync ?? null, syncIssue: state.syncIssue ?? null },
  };
}

/**
 * R-18：這台電腦上只與目前專案有關的單機記憶（最多 3 筆，優先序最低，超出預算時先被省略）。
 * all：readDirEntries 讀好的單機記憶（寫快取時每個專案共用一份，不必每個專案重讀、重掃金鑰）
 */
async function machineWarning(ctx, pid, all) {
  const entries = (all ?? (await readDirEntries(machineDir(ctx.vault, ctx.mid)))).filter((e) => e.project === pid).slice(0, 3);
  if (!entries.length) return null;
  const lines = entries.map((e) => `  - [${e.name}](${toTildePath(path.join(machineDir(ctx.vault, ctx.mid), e.file), ctx.homes.userHome)}) — ${e.description}`);
  return { priority: 9, text: `本機與此專案相關的記憶（需要時再讀）：\n${lines.join('\n')}` };
}

/** 只寫設定檔、junction 與綁定紀錄，不呼叫 git（commit 交給下一次同步）。 */
async function quickBind(ctx, args) {
  try {
    return await ctx.locked('session.bind', () => quickBindLocked(ctx, args), { waitMs: 200 });
  } catch (err) {
    if (err?.code === 'E_LOCKED') return 'locked';
    throw err;
  }
}

async function quickBindLocked(ctx, { encoded, pid, root, method, collision }) {
  // R-52：一律寫設定檔（含足跡與 exclude，不啟動 git）；下一次從專案根目錄啟動就直接指向 vault
  const footprint = await writeSettingsBinding(ctx, root, pid, { noGit: true });
  let outcome = 'linked';
  if (method === 'junction') {
    const memPath = memoryPathFor(ctx.homes, encoded);
    if (!isLink(memPath)) {
      // 原資料夾有內容：交給常駐程式在對話結束後複製、備份再切換
      if (fs.existsSync(memPath) && !isEmptyDir(memPath)) outcome = 'deferred';
      else {
        if (fs.existsSync(memPath)) fs.rmdirSync(memPath);
        fs.mkdirSync(projectMemoryDir(ctx.vault, pid), { recursive: true });
        createJunction(projectMemoryDir(ctx.vault, pid), memPath);
      }
    }
    if (outcome === 'linked') await allowJunctionRead(ctx.homes, memPath).catch(() => {}); // R-24；失敗時由 doctor 補上
  }
  const bindings = await readBindings(ctx.vault, ctx.mid);
  const prevFootprint = Object.values(bindings).find((v) => v?.path && samePath(v.path, root))?.footprint;
  bindings[bindingKey(encoded, method, root)] = {
    pid, path: root, encoded, method, collision: !!collision,
    state: outcome === 'deferred' ? 'pending' : 'active',
    ...(outcome === 'deferred' ? { reason: 'has-content' } : {}),
    footprint: mergeFootprint(prevFootprint, footprint),
    boundAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
  };
  await writeBindings(ctx.vault, ctx.mid, bindings);
  return outcome;
}

/** 記錄待轉換的撞名，由同步時（沒有進行中的對話）處理。 */
async function queueSplit(ctx, encoded, roots) {
  const st = await readState(ctx.local);
  const list = (st.pendingSplits ?? []).filter((p) => p.encoded.toLowerCase() !== encoded.toLowerCase());
  list.push({ encoded, roots, at: new Date().toISOString() });
  await updateState(ctx.local, { pendingSplits: list });
}

/**
 * @param {object} ctx
 * @param {{ cwd: string, event?: string, transcriptPath?: string, sessionId?: string, now?: number }} input
 * @returns {Promise<{ text: string, binding: object|null, warnings: string[], loadedFiles?: object, memoryIndex?: string|null }>}
 */
export async function sessionContext(ctx, { cwd, event = 'startup', transcriptPath, sessionId, now = Date.now() } = {}) {
  try {
    const { root } = memoryRootFor(cwd ?? process.cwd());
    // 從 git 子資料夾啟動時，Claude Code 不讀根目錄的 settings.local.json，只能靠 junction（R-52）
    const fromSub = !samePath(path.resolve(cwd ?? process.cwd()), root);
    // 記憶資料夾一律用 repo 根目錄的編碼（R-54／F36：子資料夾啟動時 transcript 放在子資料夾的編碼，記憶不是）。
    // 只有從根目錄啟動、路徑長到官方加了 hash 時，才用 transcript 的資料夾名稱。
    const encoded = encodeProjectPath(root) ?? (transcriptPath && !fromSub ? path.basename(path.dirname(transcriptPath)) : null);
    // Claude Code 這次實際載入的 MEMORY.md（交給 hooks 補記；載入它時不觸發 InstructionsLoaded）。
    // 要在下面綁定改寫設定檔之前算：Claude Code 啟動時就讀過設定，新的綁定下一次對話才生效
    let memoryIndex = null;
    try {
      memoryIndex = loadedMemoryIndex(ctx.homes, { root, encoded, fromSub });
    } catch { /* 算不出來就不補記，不影響狀態文字 */ }
    const bindings = await readBindings(ctx.vault, ctx.mid);
    const warnings = [];
    let projectPart;
    let bindState = null;

    // 先找「這個路徑本身」的綁定；找不到再看同一個編碼底下有沒有別人的綁定（可能是搬家，也可能是撞名）
    let b = findBindingByPath(bindings, root);
    if (!b) {
      const byEnc = encoded ? findBindingByEncoded(bindings, encoded) : null;
      if (byEnc) {
        const kind = await classifyEncodedBinding(ctx, byEnc, root);
        if (kind === 'same') b = byEnc;
        else if (kind === 'moved') {
          bindings[byEnc.key] = { ...bindings[byEnc.key], path: root, lastOpenedAt: new Date().toISOString() };
          await writeBindings(ctx.vault, ctx.mid, bindings).catch(() => {});
          b = { ...byEnc, path: root };
        } else {
          // R-25：撞名（或身分不明），絕不改寫原綁定，也不讓 Claude 以為自己在對方的專案
          const other = await readProject(ctx.vault, byEnc.pid);
          const here = path.basename(root);
          projectPart = `此資料夾與已綁定的「${other?.name ?? byEnc.pid}」在 Claude Code 內部撞名`;
          if (byEnc.method === 'junction') {
            warnings.push({ priority: 0, text: `⚠ 本資料夾「${here}」與已綁定的「${other?.name ?? byEnc.pid}」在 Claude Code 內部撞名（中文字數相同），這次對話載入的是「${other?.name ?? byEnc.pid}」的記憶。\n  請不要引用這些記憶，也不要寫入記憶；Engram 會在對話結束後把兩者分開。` });
            await queueSplit(ctx, byEnc.encoded, [byEnc.path, root]).catch(() => {});
          } else {
            warnings.push({ priority: 0, text: `⚠ 本資料夾「${here}」與「${other?.name ?? byEnc.pid}」在 Claude Code 內部撞名。這次對話的記憶會寫在 Claude Code 的共用資料夾，\n  Engram 會在對話結束後依來源分開。建議把資料夾改成英文名稱。` });
          }
        }
      }
    }

    if (b) {
      const part = await boundPart(ctx, b, { fromSub });
      projectPart = part.projectPart;
      bindState = part.bindState;
      warnings.push(...part.warnings);
    } else if (!projectPart) {
      const res = await resolveIdentity(ctx, root, { withRootCommits: false });
      const paused = (await readJson(path.join(ctx.local, 'paused.json'), null)) ?? {};
      const bindAuto = ((await readJson(path.join(ctx.local, 'settings.json'), null)) ?? {}).bindAuto ?? 'confident';
      const recognized = res.pid && (res.confidence === 'certain' || res.confidence === 'high') && encoded;
      if (recognized && (paused.user || bindAuto !== 'confident')) {
        // 使用者暫停，或設定為「先問我」／「關閉」：只認出身分，不自動接上
        // （相容性探測暫停的是 junction：照常用設定檔綁定，junction 由 junctionAllowed 擋下）
        const project = await readProject(ctx.vault, res.pid);
        projectPart = `專案：${project?.name ?? res.pid}（${res.pid}）`;
        bindState = paused.user ? '已認出身分（自動接上暫停中）' : bindAuto === 'ask' ? '已認出身分（等待在 Engram 介面確認接上）' : '已認出身分（自動接上已關閉）';
      } else if (recognized) {
        const project = await readProject(ctx.vault, res.pid);
        projectPart = `專案：${project?.name ?? res.pid}（${res.pid}）`;
        const collision = !!res.collision;
        const method = !collision && (await junctionAllowed(ctx, root)) ? 'junction' : 'settings';
        const outcome = await quickBind(ctx, { encoded, pid: res.pid, root, method, collision });
        if (outcome === 'locked') bindState = '等待切換';
        else if (method === 'settings') bindState = collision ? '下次對話生效（設定檔備援）' : '下次對話生效';
        else bindState = outcome === 'linked' ? '剛完成綁定' : '等待切換';
        b = { encoded, pid: res.pid, path: root, method, collision };
        if (bindState === '剛完成綁定') {
          const count = (await listMarkdown(projectMemoryDir(ctx.vault, res.pid), { exclude: ['MEMORY.md'] })).length;
          const idx = toTildePath(path.join(memoryPathFor(ctx.homes, encoded), 'MEMORY.md'), ctx.homes.userHome);
          warnings.push({ priority: 4, text: `⚠ 這個專案剛接上 Engram。本次對話開頭載入的是舊的記憶索引${count ? `；Engram 已累積 ${count} 筆記憶` : ''}，\n  需要時先讀 ${idx}。之後寫入的記憶會自動同步。` });
        } else if (bindState === '下次對話生效') {
          warnings.push({ priority: 4, text: '⚠ 這個專案剛接上 Engram，下一次對話起生效。這次對話寫的記憶會先留在 Claude Code 原本的資料夾，\n  之後可以在 Engram 收件匣收進來。' });
        } else if (outcome === 'deferred' || outcome === 'locked') {
          warnings.push({ priority: 4, text: '⚠ 這個專案已認出身分，對話結束後會自動接上 Engram；本次寫入的記憶會在接上時一併收進來。' });
        }
      } else {
        projectPart = '此資料夾尚未納入 Engram（產生記憶後會自動納入）';
      }
    }

    // CORE.md 衝突、同步錯誤、密鑰擋下、收件匣（和資料夾無關的部分）
    const shared = await gatherShared(ctx);
    // 2.0.0 WP4b：護欄的 mod 沒有載入（沒有這場對話的標記檔）時，補上這台電腦已知的指令寫法問題；優先序最低，放不下就省略
    const guard = await guardrailFallback(ctx, { sessionId }).catch(() => null);
    const rendered = renderSession({
      label: ctx.label, mid: ctx.mid, projectPart, bindState, bindingWarnings: warnings, shared,
      machineWarning: b?.pid ? await machineWarning(ctx, b.pid) : null, guard, now,
    });
    const text = rendered.text;

    let loadedFiles;
    if (sessionId) loadedFiles = (await readJson(path.join(ctx.local, 'loaded', `${sessionId}.json`), null)) ?? undefined;
    return { text, binding: b ? { encoded: b.encoded ?? encoded, pid: b.pid, method: b.method, state: bindState } : null, warnings: rendered.warnings.map((w) => w.text), loadedFiles, memoryIndex };
  } catch (err) {
    try {
      const log = path.join(ctx.local, 'logs', 'session.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, `${new Date().toISOString()} ${event} ${err?.stack ?? err}\n`);
    } catch { /* ignore */ }
    return { text: '', binding: null, warnings: [] };
  }
}

/** 記憶庫 HEAD 指到的位置（.git/HEAD、分支的 ref、packed-refs）：被扣住的單機記憶要讀 HEAD 的版本，commit 之後就不用舊的快取 */
function gitRefFiles(vault) {
  const gitDir = path.join(vault, '.git');
  const files = [path.join(gitDir, 'HEAD'), path.join(gitDir, 'packed-refs')];
  try {
    const ref = /^ref:\s*(\S+)/.exec(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'))?.[1];
    if (ref) files.push(path.join(gitDir, ...ref.split('/')));
  } catch { /* 讀不到 HEAD：簽章是 '-'，照樣比對 */ }
  return files;
}

/**
 * 2.0.0 S5：開場 hook 的快速路徑用的快取 local/cache/session/state.json（常駐程式在存檔、同步之後與每隔幾分鐘寫一次）。
 * 只放「這台電腦已綁定、從那個路徑開啟時不需要任何寫入」的資料夾；從根目錄與從子資料夾開啟各算一份。
 * 先記下要讀的檔案的簽章、再讀內容：讀的途中有檔案被改，簽章對不上，快速路徑就不會用這份快取。
 * @returns {Promise<{ roots: number }>}
 */
export async function writeSessionCache(ctx, { now = Date.now() } = {}) {
  const mdir = machineDir(ctx.vault, ctx.mid);
  let machineFiles = [];
  try { machineFiles = fs.readdirSync(mdir).filter((n) => /\.md$/i.test(n)).map((n) => path.join(mdir, n)); } catch { /* 沒有單機記憶 */ }
  const sources = signatures([
    path.join(ctx.local, 'state.json'), path.join(ctx.local, 'cache', 'health.json'), path.join(ctx.local, 'paused.json'), path.join(ctx.local, 'machine.json'),
    path.join(ctx.vault, 'conflicts'), path.join(mdir, 'bindings.json'), mdir, ...machineFiles, ...gitRefFiles(ctx.vault), ...CODE_FILES,
    // 單機記憶疑似含金鑰時，列不列出來要看「不是金鑰」清單（core/secretallow.mjs）
    path.join(ctx.local, 'secret-allow.json'), path.join(ctx.vault, 'not-secrets'),
    // 更新 Engram 會改寫安裝清單：之後第一次開場就不用舊程式寫的快取（內容另外比對 installInfo）
    path.join(ctx.local, 'install.json'),
  ]);
  const label = readLocalMachine(ctx.local)?.label ?? ctx.label;
  const bindings = await readBindings(ctx.vault, ctx.mid);
  const machineEntries = await readDirEntries(mdir);
  const roots = [];
  for (const view of allBindingViews(bindings)) {
    const root = view?.path;
    if (!root || !view.pid) continue;
    // 路徑長到官方加了 hash：編碼要看這次的 transcript，交給完整路徑
    const encoded = encodeProjectPath(root);
    if (!encoded) continue;
    // 同一個路徑有兩筆綁定時，用 sessionContext 會找到的那一筆
    const b = findBindingByPath(bindings, root);
    if (!b || b.key !== view.key) continue;
    const files = [path.join(ctx.vault, 'projects', b.pid, 'project.json'), path.join(root, SETTINGS_LOCAL)];
    for (const fromSub of [false, true]) {
      const c = memoryIndexCandidate(ctx.homes, { root, encoded, fromSub });
      if (c) files.push(c);
    }
    if (b.method !== 'settings') files.push(memoryPathFor(ctx.homes, b.encoded), projectMemoryDir(ctx.vault, b.pid));
    const entry = { root, encoded, sources: signatures(files), binding: { encoded: b.encoded ?? encoded, pid: b.pid, method: b.method } };
    for (const [key, fromSub] of [['top', false], ['sub', true]]) {
      let memoryIndex = null;
      try { memoryIndex = loadedMemoryIndex(ctx.homes, { root, encoded, fromSub }); } catch { /* 同 sessionContext：算不出來就不補記 */ }
      entry[key] = { ...(await boundPart(ctx, b, { fromSub })), memoryIndex };
    }
    entry.machineWarning = await machineWarning(ctx, b.pid, machineEntries);
    roots.push(entry);
  }
  const homes = { home: ctx.homes.home, claudeHome: ctx.homes.claudeHome, userHome: ctx.homes.userHome };
  const cache = { v: SESSION_CACHE_V, at: new Date(now).toISOString(), engine: codeVersion(), install: installInfo(ctx.local), homes, mid: ctx.mid, label, shared: await gatherShared(ctx), roots, sources };
  const file = sessionCacheFile(ctx.local);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await safeWrite(file, JSON.stringify(cache));
  return { roots: roots.length };
}
