// 衝突隔離區 vault/conflicts/<id>/（R-07：會同步）。格式與 mergedriver.mjs 相同：
// ours.md、theirs.md、base.md（可能沒有）、meta.json { id, ref, kind, createdAt, summary, ... }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError, invariant } from './errors.mjs';
import { parseMemoryFile, setFields } from './frontmatter.mjs';
import { exists, readJson, readText, safeWrite, stableJson } from './fsx.mjs';
import { makeConflictId, uniqueFileName } from './ids.mjs';
import { fromRef, toRef } from './paths.mjs';
import { assertNoNewSecrets } from './secretallow.mjs';
import { redactSecrets } from './secrets.mjs';
import { commitPaths } from './vault.mjs';

export function conflictsDir(vaultDir) {
  return path.join(vaultDir, 'conflicts');
}

/**
 * 建立一筆衝突紀錄（合併器以外的情況：修改與刪除衝突、非 Markdown 檔等）。
 * summaryEn：summary 的英文版，存在 meta.en.summary（管理介面切到英文時顯示）；沒有傳 summary 時兩者都用預設。
 */
export async function quarantine(vaultDir, { ref, kind = 'content', ours = null, theirs = null, base = null, summary, summaryEn, by }) {
  await fsp.mkdir(conflictsDir(vaultDir), { recursive: true });
  // 獨占建立資料夾；id 碰撞（EEXIST）就換一個，絕不覆蓋既有紀錄（BUG-7）
  let id; let dir;
  for (let i = 0; ; i++) {
    id = makeConflictId();
    dir = path.join(conflictsDir(vaultDir), id);
    try { await fsp.mkdir(dir); break; } catch (err) { if (err.code !== 'EEXIST' || i > 20) throw err; }
  }
  if (ours !== null) await safeWrite(path.join(dir, 'ours.md'), ours);
  if (theirs !== null) await safeWrite(path.join(dir, 'theirs.md'), theirs);
  if (base !== null) await safeWrite(path.join(dir, 'base.md'), base);
  const en = summary === undefined || summary === null ? `${ref} was modified differently on two computers` : summaryEn;
  // meta.json 會跟著 vault 推送：摘要先遮蔽疑似金鑰
  const safe = (t) => redactSecrets(String(t)).text;
  await safeWrite(path.join(dir, 'meta.json'), stableJson({
    id, ref, kind, createdAt: new Date().toISOString(), summary: safe(summary ?? `${ref} 在兩台電腦有不同的修改`), ...(en ? { en: { summary: safe(en) } } : {}), ...(by ? { by } : {}),
  }));
  return id;
}

/** @returns {Promise<{ id, ref, kind, createdAt, ours, theirs, base, summary, en?: { summary } }[]>} 舊的紀錄沒有 en */
export async function listConflicts(vaultDir) {
  let ids = [];
  try { ids = (await fsp.readdir(conflictsDir(vaultDir), { withFileTypes: true })).filter((d) => d.isDirectory() && d.name.startsWith('cf_')).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const id of ids.sort()) {
    const dir = path.join(conflictsDir(vaultDir), id);
    const meta = (await readJson(path.join(dir, 'meta.json'), null)) ?? { id };
    out.push({
      id,
      ref: meta.ref ?? null,
      kind: meta.kind ?? 'content',
      createdAt: meta.createdAt ?? null,
      ours: await readText(path.join(dir, 'ours.md')),
      theirs: await readText(path.join(dir, 'theirs.md')),
      base: await readText(path.join(dir, 'base.md')),
      summary: meta.summary ?? '',
      ...(typeof meta.en?.summary === 'string' && meta.en.summary ? { en: { summary: meta.en.summary } } : {}),
    });
  }
  return out;
}

/**
 * 處理衝突。choice：'ours' 保留目前檔案；'theirs' 改用對方版本；'both' 對方版本另存一筆；'manual' 寫入 body。
 */
export async function resolveConflict(ctx, id, { choice, body } = {}) {
  invariant(['ours', 'theirs', 'both', 'manual'].includes(choice), 'choice 必須是 ours、theirs、both 或 manual', undefined, { message: 'choice must be ours, theirs, both, or manual' });
  // R-45：id 會用來組路徑並遞迴刪除，必須是 cf_ 開頭的單一資料夾名稱，而且就在 conflicts/ 底下
  invariant(typeof id === 'string' && /^cf_[0-9A-Za-z_]+$/.test(id), '不合法的衝突 id', undefined, { message: 'Invalid conflict id' });
  return ctx.locked('conflicts.resolve', async () => {
    const root = conflictsDir(ctx.vault);
    const dir = path.resolve(root, id);
    invariant(path.dirname(dir) === path.resolve(root), '不合法的衝突 id', undefined, { message: 'Invalid conflict id' });
    if (!exists(dir)) throw new EngramError(E.NOT_FOUND, `找不到衝突：${id}`).withEn(`Conflict not found: ${id}`);
    const meta = (await readJson(path.join(dir, 'meta.json'), null)) ?? {};
    // meta.ref 來自同步的檔案，同樣要驗證是記憶檔或核心準則
    const { scopeOfRef: refScope } = await import('./memories.mjs');
    const ref = meta.ref && (meta.ref === 'core/CORE.md' || refScope(meta.ref) || /^projects\/[a-z0-9][a-z0-9-]*\/project\.json$/.test(meta.ref)) ? meta.ref : null;
    const theirs = await readText(path.join(dir, 'theirs.md'));
    const touched = [toRef(ctx.vault, dir)];
    let resultRef = ref;
    if (ref && choice !== 'ours') {
      const abs = fromRef(ctx.vault, ref);
      if (choice === 'theirs') {
        if (theirs === null) await fsp.rm(abs, { force: true }); // 對方是刪除
        else await safeWrite(abs, theirs);
        touched.push(ref);
      } else if (choice === 'manual') {
        invariant(typeof body === 'string', '手動合併需要提供 body', undefined, { message: 'Manual merge requires a body' });
        await assertNoNewSecrets(ctx.local, ref, body, { before: await readText(abs), what: '合併後的內容' });
        await safeWrite(abs, body);
        touched.push(ref);
      } else if (choice === 'both' && theirs !== null) {
        const destDir = path.dirname(abs);
        const file = uniqueFileName(path.basename(abs), (f) => exists(path.join(destDir, f)));
        const name = file.replace(/\.md$/i, '');
        let text = theirs;
        // 對方版本無法解析時（R-28），保留原文另存，不嘗試改名欄位
        try { if (parseMemoryFile(theirs).hasFrontmatter) text = setFields(theirs, { name }); } catch { text = theirs; }
        await safeWrite(path.join(destDir, file), text);
        resultRef = toRef(ctx.vault, path.join(destDir, file));
        touched.push(resultRef);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (ref) {
      const { scopeOfRef, refreshIndex } = await import('./memories.mjs');
      const scope = scopeOfRef(ref);
      if (scope) touched.push(...await refreshIndex(ctx, scope));
    }
    const commit = await commitPaths(ctx.vault, touched, `resolve ${id} (${choice})`, { action: 'resolve', refs: ref ? [ref] : [], mid: ctx.mid });
    return { ok: true, ref: resultRef, commit: commit ?? undefined, undo: commit ? { sha: commit.sha } : undefined };
  });
}
