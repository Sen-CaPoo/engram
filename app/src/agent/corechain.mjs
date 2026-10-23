// /api/core 的載入鏈：從 ~/.claude/CLAUDE.md 的 Engram 管理區塊出發，遞迴展開 @import（最多 4 層，F08），
// 列出每個檔案的 path、kind、lines、bytes、depth，讓介面顯示「每次對話實際會載入的核心準則」。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countLines } from '../cli/fsutil.mjs';

export const MAX_IMPORT_DEPTH = 4;
const BLOCK_RE = /<!--\s*engram:begin[\s\S]*?-->([\s\S]*?)<!--\s*engram:end\s*-->/;

/** 取出 @import 路徑；略過程式碼區塊與行內程式碼，也不把 email 之類的 @ 當成匯入。 */
export function findImports(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const clean = line.replace(/`[^`]*`/g, '');
    for (const m of clean.matchAll(/(?:^|\s)@(\S+)/g)) {
      const p = m[1];
      if (/^(~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(p) || p.includes('/') || /\.md$/i.test(p)) out.push(p);
    }
  }
  return out;
}

/** ~/.engram 與 ~/.claude 依 ENGRAM_HOME／CLAUDE_HOME 對應，讓測試環境與實際載入一致。 */
export function resolveImport(p, baseDir, { engramHome, claudeHome }) {
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('~/')) {
    const rest = s.slice(2);
    if (rest === '.engram' || rest.startsWith('.engram/')) return path.join(engramHome, rest.slice('.engram'.length));
    if (rest === '.claude' || rest.startsWith('.claude/')) return path.join(claudeHome, rest.slice('.claude'.length));
    return path.join(os.homedir(), rest);
  }
  return path.resolve(baseDir, s);
}

function kindOf(file) {
  const p = file.replace(/\\/g, '/');
  const name = p.split('/').pop();
  if (name === 'CORE.md') return 'core';
  if (name === 'INDEX.md') return 'index';
  if (p.includes('/rules/')) return 'rule';
  return 'import';
}

const readText = (file) => fsp.readFile(file, 'utf8').catch(() => null);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * @param {{ claudeHome: string, engramHome: string, corePath?: string }} homes
 * @returns {Promise<{ path, kind, lines, bytes, depth, exists, isSelf? }[]>}
 */
export async function buildCoreChain({ claudeHome, engramHome, corePath }) {
  const chain = [];
  const seen = new Set();
  const add = (file, text, depth, kind) => {
    const entry = { path: file, kind, lines: countLines(text ?? ''), bytes: text == null ? 0 : Buffer.byteLength(text), depth, exists: text != null };
    if (corePath && samePath(file, corePath)) entry.isSelf = true;
    chain.push(entry);
  };

  async function walk(imports, baseDir, depth) {
    if (depth > MAX_IMPORT_DEPTH) return;
    for (const imp of imports) {
      const file = resolveImport(imp, baseDir, { engramHome, claudeHome });
      const key = path.resolve(file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const text = await readText(file);
      add(file, text, depth, kindOf(file));
      if (text != null) await walk(findImports(text), path.dirname(file), depth + 1);
    }
  }

  const root = path.join(claudeHome, 'CLAUDE.md');
  const rootText = await readText(root);
  add(root, rootText, 0, 'user');
  seen.add(path.resolve(root).toLowerCase());
  // 只展開 Engram 管理區塊裡的匯入；使用者自己的內容不屬於核心準則
  const block = BLOCK_RE.exec(rootText ?? '')?.[1] ?? '';
  await walk(findImports(block), path.dirname(root), 1);
  return chain;
}
