// SessionStart 動態內容（41 號文件 §09）。純本機、不連網；任何例外都回傳空字串，不阻擋對話。
// 格式：≤ 12 行、≤ 1,200 字元。唯一的寫入：需要時綁定（設定檔＋可能的 junction，取鎖最多等 200ms）。
import fs from 'node:fs';
import path from 'node:path';
import { allowJunctionRead } from './claudesettings.mjs';
import { createJunction, isEmptyDir, isLink, listMarkdown, readJson, readJsonSync } from './fsx.mjs';
import {
  classifyEncodedBinding, junctionAllowed, junctionState, loadedMemoryIndex, memoryPathFor, mergeFootprint, resolveIdentity, writeSettingsBinding,
} from './identity.mjs';
import { readDirEntries } from './normalize.mjs';
import { encodeProjectPath, memoryRootFor, samePath, toTildePath } from './paths.mjs';
import {
  bindingKey, findBindingByEncoded, findBindingByPath, machineDir, projectMemoryDir, readBindings, readProject, readState, updateState, writeBindings,
} from './vault.mjs';

const MAX_LINES = 12;
const MAX_CHARS = 1200;
const WRITE_LINE = '記憶寫入：專案 → 自動記憶（照常）；全域 → engram remember --scope global；單機 → engram remember --scope machine';

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!t) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '剛剛';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小時前`;
  return `${Math.round(h / 24)} 天前`;
}

function syncLine(state, now) {
  const s = state.sync ?? {};
  const last = relativeTime(s.lastSuccessAt, now);
  if (!state.remote && (!s.state || s.state === 'never' || s.state === 'ok') && !s.lastSuccessAt) return '同步：僅本機（尚未設定同步）';
  switch (s.state) {
    case 'syncing': return '同步：同步中';
    case 'offline': return `同步：離線${last ? `（最後成功 ${last}）` : ''}`;
    case 'auth': return '同步：需要重新登入 GitHub';
    case 'error': return s.error?.code === 'E_PUSH_PROTECTED' ? '同步：推送被 GitHub 擋下' : `同步：發生錯誤${last ? `（最後成功 ${last}）` : ''}`;
    default: return last ? `同步：最後同步 ${last}` : '同步：尚未同步';
  }
}

/** 依優先序組合，超過上限時從最低優先的警告開始刪。 */
function compose(head, warnings) {
  const sorted = [...warnings].sort((a, b) => a.priority - b.priority).slice(0, 3);
  for (;;) {
    const lines = [...head, ...sorted.flatMap((w) => w.text.split('\n'))];
    const text = lines.join('\n');
    if ((lines.length <= MAX_LINES && text.length <= MAX_CHARS) || !sorted.length) return text.slice(0, MAX_CHARS);
    sorted.pop();
  }
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
    const [bindings, state] = await Promise.all([readBindings(ctx.vault, ctx.mid), readState(ctx.local)]);
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
      const project = await readProject(ctx.vault, b.pid);
      projectPart = `專案：${project?.name ?? b.pid}（${b.pid}）`;
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

    // CORE.md 衝突、同步錯誤、密鑰擋下
    let conflictCount = 0;
    try {
      for (const id of fs.readdirSync(path.join(ctx.vault, 'conflicts')).filter((n) => n.startsWith('cf_'))) {
        conflictCount++;
        const meta = readJsonSync(path.join(ctx.vault, 'conflicts', id, 'meta.json'), {});
        if (meta?.ref === 'core/CORE.md') warnings.push({ priority: 1, text: '⚠ 核心準則 CORE.md 在兩台電腦有衝突（目前使用本機版本），請在 Engram 介面確認。' });
      }
    } catch { /* 沒有衝突 */ }
    if (state.sync?.state === 'auth') warnings.push({ priority: 5, text: '⚠ GitHub 登入已失效，記憶暫時不會同步到其他電腦。' });
    if (state.sync?.error?.code === 'E_PUSH_PROTECTED') warnings.push({ priority: 5, text: '⚠ GitHub 擋下了推送（疑似含有金鑰），記憶暫時不會同步。' });
    if (state.sync?.blockedBySecrets?.length) warnings.push({ priority: 6, text: `⚠ 有 ${state.sync.blockedBySecrets.length} 筆記憶疑似含有金鑰，未同步。記憶裡請只記「存放位置」。` });

    const health = (await readJson(path.join(ctx.local, 'cache', 'health.json'), null)) ?? {};
    const inbox = (health.inboxCount ?? 0) + (conflictCount && !health.inboxCount ? conflictCount : 0);

    const userPaused = ((await readJson(path.join(ctx.local, 'paused.json'), null)) ?? {}).user === true;
    const head = [
      // 全形括號後面不加空白，與「（mid）· 」一致
      `[Engram] ${ctx.label}（${ctx.mid}）· ${projectPart}${bindState ? `${/[）」]$/.test(projectPart) ? '' : ' '}· ${bindState}` : ''}`,
      WRITE_LINE,
      userPaused ? '同步：Engram 已暫停（不同步、不自動接上）' : syncLine(state, now),
    ];
    if (inbox > 0) head.push(`收件匣：${inbox} 項待整理（使用者沒有問起就不要提）`);
    // R-18：這台電腦上只與目前專案有關的單機記憶（最多 3 筆，優先序最低，超出預算時先被省略）
    if (b?.pid) {
      const entries = (await readDirEntries(machineDir(ctx.vault, ctx.mid))).filter((e) => e.project === b.pid).slice(0, 3);
      if (entries.length) {
        const lines = entries.map((e) => `  - [${e.name}](${toTildePath(path.join(machineDir(ctx.vault, ctx.mid), e.file), ctx.homes.userHome)}) — ${e.description}`);
        warnings.push({ priority: 9, text: `本機與此專案相關的記憶（需要時再讀）：\n${lines.join('\n')}` });
      }
    }
    const text = compose(head, warnings);

    let loadedFiles;
    if (sessionId) loadedFiles = (await readJson(path.join(ctx.local, 'loaded', `${sessionId}.json`), null)) ?? undefined;
    return { text, binding: b ? { encoded: b.encoded ?? encoded, pid: b.pid, method: b.method, state: bindState } : null, warnings: warnings.map((w) => w.text), loadedFiles, memoryIndex };
  } catch (err) {
    try {
      const log = path.join(ctx.local, 'logs', 'session.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, `${new Date().toISOString()} ${event} ${err?.stack ?? err}\n`);
    } catch { /* ignore */ }
    return { text: '', binding: null, warnings: [] };
  }
}
