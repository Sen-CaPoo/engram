// 歷史、復原與活動統計（全部從 git 計算，不另存資料）。
import { E, EngramError } from './errors.mjs';
import { git } from './git.mjs';

const US = '\x1f';
const RS = '\x1e';
// 匯入相關的 commit（sweep、bind、rollback 與帶 Engram-Import 的）不能單獨 revert：
// 只撤銷檔案、junction 卻還指著 vault，會讓記憶看起來消失。介面改連到匯入頁的安全還原（M13）。
const UNDOABLE = new Set(['create', 'edit', 'move', 'merge', 'remove', 'restore', 'resolve', 'autosave', 'link', 'confirm-deletions']);

function parseTrailers(body) {
  const action = /^Engram-Action:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null;
  const refs = [...body.matchAll(/^Engram-Refs:\s*(.+)$/gm)].map((m) => m[1].trim());
  const importTag = /^Engram-Import:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null;
  const renameId = /^Engram-Rename:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null;
  return { action, refs, importTag, renameId };
}

/**
 * @returns {Promise<{ sha, at, machine, action, refs, message, undoable }[]>}
 */
export async function history(ctx, { ref, limit = 50 } = {}) {
  const args = ['log', `-n${Math.max(1, Math.min(limit, 1000))}`, `--format=${RS}%H${US}%P${US}%aI${US}%s${US}%b`];
  if (ref) args.push('--follow', '--', ref);
  const r = await git(args, { cwd: ctx.vault, allowFail: true });
  if (r.code !== 0) return [];
  const out = [];
  for (const rec of r.stdout.split(RS)) {
    if (!rec.trim()) continue;
    const [sha, parents, at, subject, body = ''] = rec.split(US);
    const machine = /^engram\(([^)]+)\):/.exec(subject)?.[1] ?? null;
    const { action, refs, importTag, renameId } = parseTrailers(body);
    const isMerge = parents.trim().split(/\s+/).length > 1;
    // 資料夾改名（SW-4）不是 git revert 能還原的：只有改名那台電腦能整批還原（資料夾在那台）
    const renameUndo = action === 'rename-folder' && !!renameId && machine === ctx.mid;
    out.push({
      sha: sha.trim(),
      at,
      machine,
      action: action ?? (isMerge ? 'sync-merge' : null),
      refs,
      message: subject.replace(/^engram\([^)]+\):\s*/, ''),
      undoable: renameUndo || (!isMerge && !!action && UNDOABLE.has(action) && !importTag),
      ...(importTag ? { importTag } : {}),
      ...(renameId ? { renameId } : {}),
    });
  }
  return out;
}

/** 復原某次變更（git revert）。 */
export async function undo(ctx, sha) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new EngramError(E.INVALID, `不合法的版本：${sha}`).withEn(`Invalid version: ${sha}`);
  const info = (await history(ctx, { limit: 1000 })).find((c) => c.sha.startsWith(String(sha)));
  if (info?.action === 'rename-folder' && info.renameId) {
    if (!info.undoable) throw new EngramError(E.INVALID, '資料夾改名只能在改名的那台電腦還原', '').withEn('A folder rename can only be undone on the computer that did the rename');
    const { undoCollisionRenames } = await import('./rename.mjs');
    return undoCollisionRenames(ctx, info.renameId);
  }
  // 只查最近 1000 個變更：找不到紀錄時不知道它是不是匯入或綁定的一部分，一律拒絕（審查意見）
  if (!info) throw new EngramError(E.NOT_FOUND, `找不到版本 ${sha}，或它不在最近 1000 個變更裡`, '到管理介面的歷史頁面找要復原的版本').withEn(`Version ${sha} was not found, or it is not among the last 1000 changes`, 'Find the version to undo under Change history in Devices & sync');
  if (!info.undoable) {
    throw new EngramError(E.INVALID, info.importTag ? '這個變更屬於一次匯入，請從匯入頁面整批還原' : '這個變更不能單獨復原', info.importTag ? `rollbackImport('${info.importTag}')` : '', { importTag: info.importTag ?? null }).withEn(info.importTag ? 'This change is part of an import. Restore the whole import from the Import page' : 'This change cannot be undone on its own', info.importTag ? `rollbackImport('${info.importTag}')` : '');
  }
  return ctx.locked('undo', async () => {
    const r = await git(['revert', '--no-edit', '--no-commit', sha], { cwd: ctx.vault, allowFail: true });
    if (r.code !== 0) {
      await git(['revert', '--abort'], { cwd: ctx.vault, allowFail: true });
      throw new EngramError(E.CONFLICT, '這次變更之後又有其他修改，無法自動復原', '到歷史頁面手動還原個別檔案', { stderr: r.stderr.slice(-500) }).withEn('Other changes were made after this one, so it cannot be undone automatically', 'Restore individual files by hand from each memory\'s History in the Library');
    }
    const subj = (await git(['log', '-1', '--format=%s', sha], { cwd: ctx.vault })).stdout.trim().replace(/^engram\([^)]+\):\s*/, '');
    const msg = `engram(${ctx.mid}): undo ${subj}\n\nEngram-Action: undo\nEngram-Refs: ${sha}\n`;
    const staged = await git(['diff', '--cached', '--name-only'], { cwd: ctx.vault });
    if (!staged.stdout.trim()) return { ok: true };
    await git(['commit', '-q', '-F', '-'], { cwd: ctx.vault, input: msg });
    const head = (await git(['rev-parse', 'HEAD'], { cwd: ctx.vault })).stdout.trim();
    const result = { ok: true, commit: { sha: head, message: msg.split('\n')[0] }, undo: { sha: head } };
    // 專案合併（link）改的不只是記憶庫：這台電腦資料夾的記憶連結（junction）與 settings.local.json 也改指向合併的目標，git 退不回去
    if (info.action === 'link') Object.assign(result, await realignAfterLinkUndo(ctx, info));
    return result;
  });
}

/**
 * 還原專案合併之後，把這台電腦原本綁定在被合併專案（from）的資料夾接回去：綁定紀錄已經由 git 還原，
 * 這裡把記憶連結與 settings.local.json 的 autoMemoryDirectory 改指回 from（additionalDirectories 是記憶連結本身的路徑，兩個方向都不變）。
 * 合併時一併改到目標專案的「已移除的舊綁定」（對話回顧用，local/）也改回原專案（retiredRestored 是改回幾筆）。
 * 做不到的部分放在回傳的 partial：資料夾不見了、重新綁定失敗、舊綁定找不回來，或這次合併是另一台電腦做的（那台電腦的資料夾與舊綁定在那台，這裡碰不到）。
 * @returns {Promise<{ realigned: string[], retiredRestored?: number, partial?: { kind: string, path?: string, machine?: string, message: string, en: string }[] }>}
 */
async function realignAfterLinkUndo(ctx, info) {
  const fromPid = info.refs.map((r) => /^projects\/([^/]+)$/.exec(r)?.[1]).find(Boolean); // link 的 Engram-Refs：第一個 projects/ 是 from
  const realigned = [];
  const partial = [];
  if (info.machine && info.machine !== ctx.mid) {
    partial.push({
      kind: 'other-machine', machine: info.machine,
      message: `這次合併是電腦「${info.machine}」做的：那台電腦資料夾的記憶連結與 settings.local.json 還指向合併的目標，要在那台電腦同步之後修正（收件匣的「重新建立連結」）；那台電腦上已移除的舊綁定（對話回顧用）如果在合併時改到了目標專案，也留在那台電腦，這裡改不到`,
      en: `This merge was done on computer "${info.machine}": the memory links and settings.local.json of that computer's folders still point at the merge target; fix them on that computer after it syncs (the "Recreate link" card in the inbox). Removed old bindings (used by conversation review) that the merge moved to the target project also stay on that computer and cannot be changed from here`,
    });
    return { realigned, partial };
  }
  // 已移除的舊綁定（對話回顧用，local/，不在 git 裡）：合併時改到目標專案，這裡改回原專案；找不回來的筆數放進 partial
  const { undoLinkRelink } = await import('./retired.mjs');
  const retired = await undoLinkRelink(ctx.local, info.sha).catch(() => null);
  if (retired?.missing > 0) {
    partial.push({
      kind: 'retired-bindings',
      message: `有 ${retired.missing} 筆已移除的舊綁定（對話回顧用）找不回來（可能已經被清掉），沒有改回原專案`,
      en: `${retired.missing} removed old binding${retired.missing === 1 ? '' : 's'} (used by conversation review) could not be found any more (they may have been cleared), so ${retired.missing === 1 ? 'it was' : 'they were'} not moved back to the original project`,
    });
  }
  const extra = retired ? { retiredRestored: retired.restored } : {};
  if (!fromPid) return { realigned, ...extra, ...(partial.length ? { partial } : {}) };
  const { bind } = await import('./identity.mjs');
  const { allBindingViews, readBindings } = await import('./vault.mjs');
  const { exists } = await import('./fsx.mjs');
  for (const b of allBindingViews(await readBindings(ctx.vault, ctx.mid))) {
    if (b.pid !== fromPid) continue;
    if (!b.path || !exists(b.path)) {
      partial.push({ kind: 'folder-missing', path: b.path ?? null, message: `資料夾已經不存在，沒有重新接上：${b.path ?? ''}`, en: `The folder no longer exists, so it was not reconnected: ${b.path ?? ''}` });
      continue;
    }
    try {
      await bind(ctx, b.path, { pid: fromPid }, { mode: 'safe', force: true });
      realigned.push(b.path);
    } catch (err) {
      partial.push({ kind: 'bind-failed', path: b.path, message: `重新接上失敗：${b.path}（${err?.message ?? err}）`, en: `Reconnecting failed: ${b.path} (${err?.en?.message ?? err?.message ?? err})` });
    }
  }
  return { realigned, ...extra, ...(partial.length ? { partial } : {}) };
}

function isMemoryPath(p) {
  return /\.md$/i.test(p) && !/(^|\/)(MEMORY|INDEX|CORE)\.md$/i.test(p)
    && (/^global\/[^/]+$/.test(p) || /^projects\/[^/]+\/memory\/[^/]+$/.test(p) || /^machines\/[^/]+\/[^/]+$/.test(p));
}

function localDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 每日新增、修改、刪除的記憶數（總覽的活動圖）。 */
export async function activity(ctx, { days = 30 } = {}) {
  const n = Math.max(1, Math.min(days, 366));
  const since = new Date(Date.now() - n * 86_400_000);
  const r = await git(['log', `--since=${since.toISOString()}`, '--no-merges', `--format=${RS}%aI`, '--name-status'], { cwd: ctx.vault, allowFail: true });
  const map = new Map();
  for (let i = n - 1; i >= 0; i--) map.set(localDate(new Date(Date.now() - i * 86_400_000).toISOString()), { added: 0, changed: 0, removed: 0 });
  if (r.code === 0) {
    for (const rec of r.stdout.split(RS)) {
      const lines = rec.split('\n').filter(Boolean);
      if (!lines.length) continue;
      const day = localDate(lines[0]);
      const bucket = map.get(day);
      if (!bucket) continue;
      for (const l of lines.slice(1)) {
        const [status, a, b] = l.split('\t');
        const p = b ?? a;
        if (!p || !isMemoryPath(p)) continue;
        if (status.startsWith('A')) bucket.added++;
        else if (status.startsWith('D')) bucket.removed++;
        else bucket.changed++;
      }
    }
  }
  return [...map.entries()].map(([date, v]) => ({ date, ...v }));
}
