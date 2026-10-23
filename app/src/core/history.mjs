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
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new EngramError(E.INVALID, `不合法的版本：${sha}`);
  const info = (await history(ctx, { limit: 1000 })).find((c) => c.sha.startsWith(String(sha)));
  if (info?.action === 'rename-folder' && info.renameId) {
    if (!info.undoable) throw new EngramError(E.INVALID, '資料夾改名只能在改名的那台電腦還原', '');
    const { undoCollisionRenames } = await import('./rename.mjs');
    return undoCollisionRenames(ctx, info.renameId);
  }
  // 只查最近 1000 個變更：找不到紀錄時不知道它是不是匯入或綁定的一部分，一律拒絕（審查意見）
  if (!info) throw new EngramError(E.NOT_FOUND, `找不到版本 ${sha}，或它不在最近 1000 個變更裡`, '到管理介面的歷史頁面找要復原的版本');
  if (!info.undoable) {
    throw new EngramError(E.INVALID, info.importTag ? '這個變更屬於一次匯入，請從匯入頁面整批還原' : '這個變更不能單獨復原', info.importTag ? `rollbackImport('${info.importTag}')` : '', { importTag: info.importTag ?? null });
  }
  return ctx.locked('undo', async () => {
    const r = await git(['revert', '--no-edit', '--no-commit', sha], { cwd: ctx.vault, allowFail: true });
    if (r.code !== 0) {
      await git(['revert', '--abort'], { cwd: ctx.vault, allowFail: true });
      throw new EngramError(E.CONFLICT, '這次變更之後又有其他修改，無法自動復原', '到歷史頁面手動還原個別檔案', { stderr: r.stderr.slice(-500) });
    }
    const subj = (await git(['log', '-1', '--format=%s', sha], { cwd: ctx.vault })).stdout.trim().replace(/^engram\([^)]+\):\s*/, '');
    const msg = `engram(${ctx.mid}): undo ${subj}\n\nEngram-Action: undo\nEngram-Refs: ${sha}\n`;
    const staged = await git(['diff', '--cached', '--name-only'], { cwd: ctx.vault });
    if (!staged.stdout.trim()) return { ok: true };
    await git(['commit', '-q', '-F', '-'], { cwd: ctx.vault, input: msg });
    const head = (await git(['rev-parse', 'HEAD'], { cwd: ctx.vault })).stdout.trim();
    return { ok: true, commit: { sha: head, message: msg.split('\n')[0] }, undo: { sha: head } };
  });
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
