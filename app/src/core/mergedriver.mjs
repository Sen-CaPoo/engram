// mergedriver.mjs — git 的 engram-md 合併器。
// git 以 %O %A %B 傳入共同祖先、本機、對方三個暫存檔；結果必須寫回本機（%A）。
// 原則：永遠回傳 exitCode 0，工作目錄絕不留下衝突標記；無法安全合併時本機檔案一個位元組都不改，
// 並把對方版本隔離到 conflicts 資料夾，交給介面處理。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { normalizeEngramLocation, parseMemoryFile, replaceBody, setFields } from './frontmatter.mjs';
import { makeConflictId } from './ids.mjs';
import { redactSecrets } from './secrets.mjs';

/**
 * git 合併器入口。
 * @param {{ base: string, ours: string, theirs: string, path?: string, conflictsDir?: string, now?: Date, git?: string, cwd?: string }} opts
 *   base/ours/theirs 為檔案路徑（git 的 %O %A %B）；path 為 repo 內的路徑（%P）
 * @returns {Promise<{ exitCode: 0, result: 'clean'|'auto'|'quarantined', conflictId?: string }>}
 */
export async function mergeDriver({ base, ours, theirs, path = '', conflictsDir, now = new Date(), git = 'git', cwd = process.cwd() }) {
  const dirOf = () => resolveConflictsDir({ conflictsDir, git, cwd });
  let oursText = null;
  let theirsText = null;
  let baseText = null;
  try {
    oursText = await readFile(ours, 'utf8');
    theirsText = await readFile(theirs, 'utf8');
    baseText = await readOptional(base);
    if (oursText === theirsText) return { exitCode: 0, result: 'clean' };

    const po = parseMemoryFile(oursText);
    const pt = parseMemoryFile(theirsText);
    const pb = parseMemoryFile(baseText ?? '');
    const name = own(po.data, 'name') || own(pt.data, 'name') || nodePath.basename(path || ours);

    // ── 任何一方無法解析，或原本有 frontmatter 而某一方沒有：不合併，本機原封不動 ──
    const broken = [];
    if (po.errors.length || (pb.hasFrontmatter && !po.hasFrontmatter)) broken.push('ours');
    if (pt.errors.length || (pb.hasFrontmatter && !pt.hasFrontmatter)) broken.push('theirs');
    if (pb.errors.length) broken.push('base');
    if (broken.length) {
      const who = broken.includes('ours') ? '本機版本' : broken.includes('theirs') ? '對方版本' : '共同祖先';
      const whoEn = broken.includes('ours') ? "this computer's version" : broken.includes('theirs') ? "the other computer's version" : 'the common ancestor version';
      const conflictId = await quarantine(await dirOf(), now, {
        ref: path, oursText, theirsText, baseText,
        summary: `「${name}」的${who}無法解析，已保留本機版本，另一台的版本已隔離待處理`,
        summaryEn: `"${name}" could not be parsed in ${whoEn}. This computer's version was kept and the other computer's version was quarantined for review`,
        conflictedKeys: [],
        bodyConflict: false,
        unparsable: broken,
        parseErrors: { ours: po.errors, theirs: pt.errors, base: pb.errors },
      });
      return { exitCode: 0, result: 'quarantined', conflictId };
    }

    // ── frontmatter：先把舊格式的頂層 engram 搬到 metadata.engram，再逐鍵三方合併 ──
    const { merged, conflictedKeys } = mergeData(
      normalizeEngramLocation(pb.data), normalizeEngramLocation(po.data), normalizeEngramLocation(pt.data),
    );

    // ── 內文：統一換行後交給 git merge-file ──
    const bo = lf(po.body), bt = lf(pt.body), bb = lf(pb.body);
    let bodyLF = bo;
    let bodyConflict = false;
    let bodyMerged = false;
    if (bo !== bt) {
      if (bb === bo && baseText !== null) bodyLF = bt;
      else if (bb === bt && baseText !== null) bodyLF = bo;
      else {
        const r = await mergeFile(bo, bb, bt, git);
        if (r.conflicts === 0) { bodyLF = r.text; bodyMerged = true; }
        else bodyConflict = true;
      }
    }

    // ── 組出結果：從本機版本出發，只改動不同的鍵，再換上內文 ──
    const updates = diffUpdates(po.data, layoutLike(po.data, merged));
    let resultText = updates.length ? setFields(oursText, updates) : oursText;
    if (bodyLF !== bo) resultText = replaceBody(resultText, toEol(bodyLF, bodyEol(po.body, po.eol)));
    if (resultText !== oursText) await writeFile(ours, resultText, 'utf8');

    const realConflicts = conflictedKeys.filter((k) => !isTimeKey(k) && !isOursKey(k)).map((k) => k.join('.'));
    if (bodyConflict || realConflicts.length) {
      const what = [bodyConflict ? '內文' : '', realConflicts.length ? `欄位（${realConflicts.join('、')}）` : ''].filter(Boolean).join('與');
      const whatEn = [bodyConflict ? 'body' : '', realConflicts.length ? `fields: ${realConflicts.join(', ')}` : ''].filter(Boolean).join(' and ');
      const conflictId = await quarantine(await dirOf(), now, {
        ref: path, oursText, theirsText, baseText,
        summary: `「${name}」的${what}在兩台電腦都被修改，已保留本機版本，另一台的版本已隔離待處理`,
        summaryEn: `"${name}" was modified on both computers (${whatEn}). This computer's version was kept and the other computer's version was quarantined for review`,
        conflictedKeys: realConflicts,
        bodyConflict,
      });
      return { exitCode: 0, result: 'quarantined', conflictId };
    }
    return { exitCode: 0, result: bodyMerged ? 'auto' : 'clean' };
  } catch (err) {
    // 任何例外：本機檔案保持原樣，盡力隔離對方版本
    let conflictId;
    try {
      if (oursText !== null) {
        const current = await readOptional(ours);
        if (current !== oursText) await writeFile(ours, oursText, 'utf8');
      }
      const name = oursText ? own(parseMemoryFile(oursText).data, 'name') : '';
      conflictId = await quarantine(await dirOf(), now, {
        ref: path, oursText, theirsText, baseText,
        summary: `「${name || nodePath.basename(path || ours || '')}」自動合併失敗（${err?.message ?? err}），已保留本機版本，另一台的版本已隔離待處理`,
        summaryEn: `Automatic merge of "${name || nodePath.basename(path || ours || '')}" failed (${typeof err?.en === 'string' ? err.en : err?.en?.message ?? err?.message ?? err}). This computer's version was kept and the other computer's version was quarantined for review`,
        conflictedKeys: [],
        bodyConflict: false,
        error: String(err?.stack ?? err),
      });
    } catch { /* 隔離也失敗時不再拋出，避免 git 在工作目錄留下衝突標記 */ }
    return { exitCode: 0, result: 'quarantined', conflictId };
  }
}

// ───────────────────────── 衝突資料夾位置 ─────────────────────────

/**
 * 依序：參數 → 環境變數 ENGRAM_CONFLICTS_DIR → git config engram.conflictsdir →
 * repo 根目錄有 engram.json（是 vault）時的 <repo>/conflicts → ~/.engram/vault/conflicts。
 */
async function resolveConflictsDir({ conflictsDir, git, cwd }) {
  if (conflictsDir) return conflictsDir;
  if (process.env.ENGRAM_CONFLICTS_DIR) return process.env.ENGRAM_CONFLICTS_DIR;
  let top = null;
  try {
    const t = await run(git, ['rev-parse', '--show-toplevel'], cwd);
    if (t.code === 0 && t.stdout.trim()) top = nodePath.resolve(t.stdout.trim());
  } catch { /* 不在 repo 裡 */ }
  try {
    const c = await run(git, ['config', '--get', 'engram.conflictsdir'], cwd);
    const v = c.code === 0 ? c.stdout.trim() : '';
    if (v) return nodePath.resolve(top ?? cwd, v.replace(/^~(?=[\\/]|$)/, os.homedir()));
  } catch { /* 沒有設定 */ }
  if (top && existsSync(nodePath.join(top, 'engram.json'))) return nodePath.join(top, 'conflicts');
  return nodePath.join(os.homedir(), '.engram', 'vault', 'conflicts');
}

// ───────────────────────── frontmatter 合併 ─────────────────────────

const isTimeKey = (p) => p.length === 2 && p[0] === 'metadata' && (p[1] === 'modified' || p[1] === 'originSessionId');
const isOursKey = (p) => p.length === 2 && p[0] === 'metadata' && p[1] === 'node_type';

/**
 * 逐鍵三方合併（遞迴到巢狀物件；陣列與純量視為葉）。路徑一律用陣列，含點的鍵不會被拆開。
 * @returns {{ merged: object, conflictedKeys: string[][] }}
 */
function mergeData(base, ours, theirs) {
  const conflictedKeys = [];
  const newerTheirs = isNewer(get(theirs, ['metadata', 'modified']), get(ours, ['metadata', 'modified']));
  const walk = (b, o, t, prefix) => {
    const out = {};
    for (const k of unique([...keys0(o), ...keys0(t), ...keys0(b)])) {
      const p = [...prefix, k];
      const vb = own(b, k), vo = own(o, k), vt = own(t, k);
      let v;
      if (eq(vo, vt)) v = vo;
      else if (eq(vb, vo)) v = vt;
      else if (eq(vb, vt)) v = vo;
      else if (isObj(vo) && isObj(vt)) v = walk(isObj(vb) ? vb : {}, vo, vt, p);
      else if (isTimeKey(p)) { v = newerTheirs ? vt : vo; conflictedKeys.push(p); }
      else { v = vo; conflictedKeys.push(p); }
      if (v !== undefined) safeAssign(out, k, v);
    }
    return out;
  };
  return { merged: walk(isObj(base) ? base : {}, isObj(ours) ? ours : {}, isObj(theirs) ? theirs : {}, []), conflictedKeys };
}

/** 本機仍是舊格式（只有頂層 engram）時，把合併結果的 metadata.engram 放回頂層，讓改動最小。 */
function layoutLike(oursRaw, merged) {
  const oursMeta = own(oursRaw, 'metadata');
  if (!isObj(own(oursRaw, 'engram')) || hasOwn(oursMeta, 'engram')) return merged;
  const meta = own(merged, 'metadata');
  if (!isObj(own(meta, 'engram'))) return merged;
  const out = structuredClone(merged);
  safeAssign(out, 'engram', out.metadata.engram);
  delete out.metadata.engram;
  if (!Object.keys(out.metadata).length && !hasOwn(oursRaw, 'metadata')) delete out.metadata;
  return out;
}

/** 比較 merged 與本機原始資料，產生 setFields 用的最小更新集合（[路徑陣列, 值]）。 */
function diffUpdates(ours, merged, prefix = [], out = []) {
  const o = isObj(ours) ? ours : {};
  const m = isObj(merged) ? merged : {};
  for (const k of unique([...Object.keys(o), ...Object.keys(m)])) {
    const p = [...prefix, k];
    if (!hasOwn(m, k)) { out.push([p, undefined]); continue; }
    if (!hasOwn(o, k)) { out.push([p, m[k]]); continue; }
    if (isObj(o[k]) && isObj(m[k]) && Object.keys(o[k]).length && Object.keys(m[k]).length) diffUpdates(o[k], m[k], p, out);
    else if (!eq(o[k], m[k])) out.push([p, m[k]]);
  }
  return out;
}

function isNewer(a, b) {
  const ta = Date.parse(a ?? ''), tb = Date.parse(b ?? '');
  return (Number.isNaN(ta) ? -Infinity : ta) > (Number.isNaN(tb) ? -Infinity : tb);
}

// ───────────────────────── 內文合併 ─────────────────────────

/** 呼叫 git merge-file，回傳合併文字與衝突數。 */
async function mergeFile(ours, base, theirs, git) {
  const tmp = await mkdtemp(nodePath.join(os.tmpdir(), 'engram-merge-'));
  try {
    const fo = nodePath.join(tmp, 'ours'), fb = nodePath.join(tmp, 'base'), ft = nodePath.join(tmp, 'theirs');
    await Promise.all([writeFile(fo, ours, 'utf8'), writeFile(fb, base, 'utf8'), writeFile(ft, theirs, 'utf8')]);
    const { code, stdout, stderr } = await run(git, ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', 'merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', fo, fb, ft]);
    if (code === null || code < 0 || code > 127) throw Object.assign(new Error(`git merge-file 失敗（${code}）：${stderr.trim()}`), { en: `git merge-file failed (${code}): ${stderr.trim()}` });
    return { text: stdout, conflicts: code };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function run(cmd, args, cwd, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    const out = [], err = [];
    // 逾時就終止並當成失敗，由呼叫端退回「保留本機版本＋隔離對方」
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } reject(Object.assign(new Error('git merge-file 逾時'), { en: 'git merge-file timed out' })); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

// ───────────────────────── 隔離區 ─────────────────────────

/** 以獨占方式建立衝突資料夾；id 撞名時換一個（亂數相同時改加流水號），絕不覆蓋既有紀錄。 */
async function quarantine(dir, now, { ref, oursText, theirsText, baseText, summary, summaryEn, conflictedKeys, bodyConflict, error, unparsable, parseErrors }) {
  await mkdir(dir, { recursive: true });
  let id;
  let target;
  for (let attempt = 0; ; attempt++) {
    id = makeConflictId(now) + (attempt >= 3 ? `-${attempt}` : '');
    target = nodePath.join(dir, id);
    try { await mkdir(target); break; } catch (err) {
      if (err?.code !== 'EEXIST' || attempt >= 1000) throw err;
    }
  }
  const writes = [];
  if (oursText !== null && oursText !== undefined) writes.push(writeFile(nodePath.join(target, 'ours.md'), oursText, 'utf8'));
  if (theirsText !== null && theirsText !== undefined) writes.push(writeFile(nodePath.join(target, 'theirs.md'), theirsText, 'utf8'));
  if (baseText) writes.push(writeFile(nodePath.join(target, 'base.md'), baseText, 'utf8'));
  // meta.json 會跟著 vault 推送（同步時的金鑰檢查只看 .md）：摘要、錯誤與解析錯誤可能附上含金鑰的原文那一行，寫入前遮蔽
  const safe = (t) => (t == null ? t : redactSecrets(String(t)).text);
  const meta = { id, ref, kind: 'content', createdAt: now.toISOString(), summary: safe(summary), ...(summaryEn ? { en: { summary: safe(summaryEn) } } : {}), conflictedKeys, bodyConflict };
  if (unparsable) meta.unparsable = unparsable;
  if (parseErrors) meta.parseErrors = Object.fromEntries(Object.entries(parseErrors).map(([side, list]) => [side, Array.isArray(list) ? list.map(safe) : list]));
  if (error) meta.error = safe(error);
  writes.push(writeFile(nodePath.join(target, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8'));
  await Promise.all(writes);
  return id;
}

// ───────────────────────── 小工具 ─────────────────────────

async function readOptional(file) {
  if (!file) return null;
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

const lf = (s) => String(s ?? '').replace(/\r\n?/g, '\n');
const toEol = (s, eol) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (obj, k) => isObj(obj) && Object.prototype.hasOwnProperty.call(obj, k);
const own = (obj, k) => (hasOwn(obj, k) ? obj[k] : undefined);
const keys0 = (v) => (isObj(v) ? Object.keys(v) : []);
const unique = (arr) => [...new Set(arr)];
const get = (obj, parts) => parts.reduce((cur, k) => own(cur, k), obj);

function safeAssign(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** 內文的多數決換行字元；內文沒有換行時沿用整份檔案的。 */
function bodyEol(body, fallback) {
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lfOnly = (body.match(/(^|[^\r])\n/g) ?? []).length;
  if (!crlf && !lfOnly) return fallback;
  return crlf > lfOnly ? '\r\n' : '\n';
}

function eq(a, b) {
  return stable(a) === stable(b);
}

function stable(v) {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
