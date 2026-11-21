// 環境健檢與兩台差異（2.0.0 R1、R5）。
// 只讀：只取名稱、版本、雜湊、數量與耗時，不取設定值、環境變數的值、對話內容；路徑一律把家目錄換成 ~。
// 判斷連結一律 lstat＋readlink 取目標、不穿越（經 SSH 的系統管理員工作階段穿越一般權限建立的連結會失敗）。
// 分工：
// - refreshEnv（每日的 env 工作、engram env）：掃設定、外掛、技能、CLAUDE.md 與近 30 天的對話紀錄，
//   算出環境指紋與發現，寫進本機快取 local/cache/env.json、env-findings.json。對話紀錄的統計很耗時，所以不放在健康檢查裡即時算。
// - 環境指紋 machines/<mid>/env.json（會同步）：內容有變才寫；寫入前先過疑似金鑰偵測。
// - 發現 H25–H33：健康檢查（runHealth）只讀快取（cachedEnvFindings）；envFindings 用即時的輕量檢查加上快取的統計重算。
// - 兩台差異：讀所有電腦同步來的 env.json。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readSettingsDoc, revokeJunctionRead, setSettingIfMissing } from './claudesettings.mjs';
import { retentionDays } from './dream.mjs';
import { E, EngramError, invariant } from './errors.mjs';
import { isLink, linkTarget, readJson, readText, sha1, stableJson, writeJson } from './fsx.mjs';
import { git } from './git.mjs';
import { normalizeFsPath, samePath } from './paths.mjs';
import { loadAllow, scanWithAllow } from './secretallow.mjs';
import { redactSecrets } from './secrets.mjs';
import { listTranscriptFiles, localDate } from './usage.mjs';
import { allBindingViews, commitPaths, ENGINE_VERSION, installedCommit, listMachineIds, machineDir, readBindings } from './vault.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 統計 hook 耗時的天數；超過這個中位數（毫秒）的同步 hook 才算「過慢」，至少要有 SLOW_HOOK_MIN_RUNS 次紀錄 */
export const HOOK_WINDOW_DAYS = 7;
export const SLOW_HOOK_MS = 500;
export const SLOW_HOOK_MIN_RUNS = 5;
/** 外掛使用情形的統計天數（沒有被呼叫過才算沒用過） */
export const USE_WINDOW_DAYS = 30;
/** 記憶庫零散物件的上限、gc.pid 過期的時間 */
export const LOOSE_OBJECTS_MAX = 2000;
export const GC_PID_STALE_MS = 12 * HOUR;
/** ~/.claude.json 指向不存在資料夾的專案條目要累積到這個數量才提醒（只有一兩個多半是剛刪掉的資料夾） */
export const STALE_PROJECTS_MIN = 10;
/** R5：沒有設定 cleanupPeriodDays 時，自動修正成這個天數（Claude Code 預設 30 天） */
export const CLEANUP_DAYS = 60;
const CMD_CHARS = 80;
/** Engram 自己的外掛在 hook 統計裡的來源名稱（外掛名稱@本機 marketplace；和 install/install.mjs 的 PLUGIN、MARKETPLACE 一致） */
const SELF_PLUGIN = 'engram@engram-local';
const HOOK_TOP = 30;
const CACHE_MAX_MS = 36 * HOUR;
const FINDINGS_MAX_MS = 3 * DAY;
export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

const fileOf = (ctx, name) => path.join(ctx.local, 'cache', name);
const settingsFile = (homes) => path.join(homes.claudeHome, 'settings.json');
/** Claude Code 的家目錄：~/.claude 的上一層（沙盒與真實環境都一樣；~/.claude.json 就放在那裡） */
const homeOf = (homes) => path.dirname(homes.claudeHome);

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uniq = (a) => [...new Set(a)];
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortStr = (a) => [...a].sort(cmpStr);
const byName = (a, b) => cmpStr(a.name, b.name);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dateOf = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒`);
const fmtMsEn = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtDur = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} 分鐘` : `${Math.round(ms / 1000)} 秒`);
const fmtDurEn = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

// ───────── 遮蔽 ─────────

/** 把家目錄（含正斜線、雙反斜線、Git Bash 的 /c/… 寫法）換成 ~ */
export function masker(homes) {
  const alts = [];
  for (const root of uniq([homes.userHome, homeOf(homes)].filter(Boolean).map((p) => normalizeFsPath(p)))) {
    if (root.length < 4 || path.parse(root).root === root) continue; // 磁碟根目錄不能整個換掉
    const fwd = root.replace(/\\/g, '/');
    const drive = /^([A-Za-z]):(.*)$/.exec(fwd);
    alts.push(root, fwd, root.replace(/\\/g, '\\\\'), ...(drive ? [`/${drive[1].toLowerCase()}${drive[2]}`] : []));
  }
  const re = alts.length ? new RegExp(`(?:${uniq(alts).sort((a, b) => b.length - a.length).map(esc).join('|')})(?![A-Za-z0-9_.-])`, 'gi') : null;
  return (s) => (re ? String(s ?? '').replace(re, '~') : String(s ?? ''));
}

/** mask：家目錄換成 ~；clean：再遮蔽疑似金鑰；cmd：一行、前 CMD_CHARS 個字元（先遮蔽再截斷，金鑰才不會被截成看不出來的片段） */
function cleaners(homes) {
  const mask = masker(homes);
  const clean = (s) => redactSecrets(mask(s)).text;
  return { mask, clean, cmd: (s) => clean(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, CMD_CHARS) };
}

/** 指紋裡每一個字串都再過一次遮蔽（名稱來自使用者的檔案系統與設定檔） */
function deepClean(v, clean) {
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return v.map((x) => deepClean(x, clean));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepClean(x, clean)]));
  return v;
}

// ───────── 不穿越連結的檔案檢查 ─────────

function lstatOk(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/** 路徑還在不在：連結只看連結本身與它的目標，不穿越（fs.existsSync／accessSync 會穿越） */
function presentNoFollow(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return false; }
  if (!st.isSymbolicLink()) return true;
  const t = linkTarget(p);
  return t ? lstatOk(t) : true;
}

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
};

// ───────── 讀設定、外掛、技能 ─────────

async function readSettings(homes) {
  const text = await readText(settingsFile(homes));
  if (text === null) return { present: false, data: {}, canonical: true };
  try {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    // canonical：排版是標準格式（Engram 逐位元寫入不會重排整個檔）；不是的話 H32 不自動修
    return { present: true, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}, canonical: (await readSettingsDoc(homes)).canonical === true };
  } catch { return { present: true, invalid: true, data: {}, canonical: false }; }
}

async function readEngineSettings(ctx) {
  return (await readJson(path.join(ctx.local, 'settings.json'), null)) ?? {};
}

/** { hooks: { <事件>: [{ matcher, hooks: [{ type, command, async }] }] } } → 一筆一個 hook */
export function hookEntries(hooks) {
  const out = [];
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
        if (!h || typeof h !== 'object') continue;
        out.push({
          event,
          matcher: typeof g.matcher === 'string' ? g.matcher : '',
          type: typeof h.type === 'string' ? h.type : 'command',
          mode: h.async === true || h.asyncRewake === true ? 'async' : 'sync',
          command: typeof h.command === 'string' ? h.command : '',
        });
      }
    }
  }
  return out;
}

/** plugins/installed_plugins.json ＋ 各外掛的 hooks/*.json */
export async function readPlugins(homes) {
  const j = await readJson(path.join(homes.claudeHome, 'plugins', 'installed_plugins.json'), null);
  const map = j?.plugins && typeof j.plugins === 'object' && !Array.isArray(j.plugins) ? j.plugins : {};
  const out = [];
  for (const key of sortStr(Object.keys(map))) {
    const list = Array.isArray(map[key]) ? map[key] : [];
    const it = list.find((x) => x?.scope === 'user') ?? list[0];
    if (!it || typeof it !== 'object') continue;
    const at = key.lastIndexOf('@');
    const hooks = [];
    if (typeof it.installPath === 'string') {
      const dir = path.join(it.installPath, 'hooks');
      for (const f of sortStr((await fsp.readdir(dir).catch(() => [])).filter((n) => /\.json$/i.test(n)))) {
        hooks.push(...hookEntries((await readJson(path.join(dir, f), null))?.hooks));
      }
    }
    out.push({
      key, name: at > 0 ? key.slice(0, at) : key, marketplace: at > 0 ? key.slice(at + 1) : '',
      version: typeof it.version === 'string' ? it.version : '', installedAt: typeof it.installedAt === 'string' ? it.installedAt : null,
      installPath: typeof it.installPath === 'string' ? it.installPath : null, hooks,
    });
  }
  return out;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILES = 3000;
const HASH_BYTES = 2 * 1024 * 1024;

/** 資料夾的內容雜湊：相對路徑與內容（超過 2 MB 的檔案只算大小）；不穿越資料夾內的連結 */
async function treeDigest(dir) {
  const files = [];
  const walk = async (d, rel) => {
    const entries = (await fsp.readdir(d, { withFileTypes: true }).catch(() => [])).sort(byName);
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(d, e.name), r); } else if (e.isFile()) files.push({ r, abs: path.join(d, e.name) });
    }
  };
  await walk(dir, '');
  const h = createHash('sha1');
  let modified = 0;
  let n = 0;
  for (const f of files) {
    const st = await fsp.stat(f.abs).catch(() => null);
    if (!st) continue;
    n++;
    modified = Math.max(modified, st.mtimeMs);
    h.update(`${f.r}\0`);
    h.update(st.size <= HASH_BYTES ? await fsp.readFile(f.abs).catch(() => '') : `size:${st.size}`);
    h.update('\0');
  }
  return { files: n, hash: h.digest('hex'), modified };
}

/** 使用者層級的技能、代理或指令：第一層的每個資料夾或檔案一筆（連結只記有連結，不穿越） */
async function listItems(dir) {
  const out = [];
  for (const e of (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).sort(byName)) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const name = e.isFile() ? e.name.replace(/\.md$/i, '') : e.name;
    if (e.isSymbolicLink()) out.push({ name, files: 0, hash: null, link: true, modified: null });
    else if (e.isDirectory()) { const d = await treeDigest(abs); out.push({ name, files: d.files, hash: d.hash, modified: dateOf(d.modified) }); } else if (e.isFile()) {
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) continue;
      out.push({ name, files: 1, hash: createHash('sha1').update(st.size <= HASH_BYTES ? await fsp.readFile(abs).catch(() => '') : `size:${st.size}`).digest('hex'), modified: dateOf(st.mtimeMs) });
    }
  }
  return out.sort(byName);
}

/**
 * CLAUDE.md 的標記區塊：<!-- NAME:START --> 到 <!-- NAME:END -->（START 也可以寫 BEGIN，標記裡可以有說明文字，Engram 自己的是 engram:begin）。
 * hash 是不含 Engram 自己那個區塊的雜湊（那個區塊每台電腦的電腦名稱都不同，不算兩台的差異）。
 */
export function claudeMdInfo(text, mtimeMs) {
  const blocks = [];
  const bodies = [];
  for (const m of text.matchAll(/<!--\s*([A-Za-z0-9_.@/-]+):(?:START|BEGIN)\b[^>]*?-->/gi)) {
    const name = m[1];
    if (blocks.some((b) => b.name === name)) continue;
    const rest = text.slice(m.index + m[0].length);
    const end = new RegExp(`<!--\\s*${esc(name)}:END\\b[^>]*?-->`, 'i').exec(rest);
    if (!end) continue;
    const body = text.slice(m.index, m.index + m[0].length + end.index + end[0].length);
    blocks.push({ name, bytes: Buffer.byteLength(body), hash: sha1(body) });
    bodies.push({ name, body });
  }
  let own = text;
  for (const b of bodies) if (b.name.toLowerCase() === 'engram') own = own.replace(b.body, '');
  return { bytes: Buffer.byteLength(text), hash: sha1(own), modified: dateOf(mtimeMs), blocks: blocks.sort(byName) };
}

/** 最近的對話紀錄裡記的 Claude Code 版本（"version":"2.1.x"）；沒有時回傳 null */
async function transcriptVersion(claudeHome) {
  const files = [];
  for (const f of await listTranscriptFiles(claudeHome)) {
    try { files.push({ f, t: fs.statSync(f).mtimeMs }); } catch { /* 被清掉了 */ }
  }
  for (const { f } of files.sort((a, b) => b.t - a.t).slice(0, 3)) {
    try {
      const fh = await fsp.open(f, 'r');
      try {
        const buf = Buffer.alloc(64 * 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const m = /"version":"(\d+\.\d+\.\d+[^"]*)"/.exec(buf.subarray(0, bytesRead).toString('utf8'));
        if (m) return m[1];
      } finally { await fh.close(); }
    } catch { /* 試下一個 */ }
  }
  return null;
}

/** 這台電腦目前安裝的 commit（machine.json 也記同一個值，解析放在 vault.mjs 的 installedCommit） */
const engramCommit = (ctx) => installedCommit(ctx.local);

// ───────── 對話紀錄的統計（hook 耗時、外掛使用） ─────────

const MARKERS = ['"hook_success"', 'mcp__plugin_', '"Skill"', '"subagent_type"', '<command-name>'].map((s) => Buffer.from(s));

/** 逐行讀檔，只解碼含任一標記的行（對話紀錄動輒數百 MB，其餘的行不必解碼） */
async function eachMarkedLine(file, onLine) {
  const hit = (b) => MARKERS.some((m) => b.includes(m));
  let rest = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file)) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let from = 0;
    let i;
    while ((i = buf.indexOf(10, from)) !== -1) {
      if (i > from && hit(buf.subarray(from, i))) onLine(buf.toString('utf8', from, i));
      from = i + 1;
    }
    rest = buf.subarray(from);
  }
  if (rest.length && hit(rest)) onLine(rest.toString('utf8'));
}

/**
 * 指令的比對用寫法：不分大小寫與斜線方向、去引號、${CLAUDE_PLUGIN_ROOT} 換成 root（沒有就是 <root>）、
 * 外掛快取資料夾的版本號換成 *（外掛更新後，舊的對話紀錄寫的是舊版本的路徑）
 */
export function canonCommand(s, root) {
  return String(s ?? '')
    .replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?|%CLAUDE_PLUGIN_ROOT%/gi, root ?? '<root>')
    .replace(/\\/g, '/').replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/(\/plugins\/cache\/[^/ ]+\/[^/ ]+\/)[^/ ]+/g, '$1*');
}

/** 設定檔與外掛登記的 hook：用來把對話紀錄裡的 hook 對回來源，才知道是同步還是背景、屬於哪個外掛 */
function hookRegistry(settingsHooks, plugins) {
  const reg = settingsHooks.map((h) => ({ source: 'settings', event: h.event, mode: h.mode, raw: canonCommand(h.command), exp: canonCommand(h.command), tail: null }));
  for (const p of plugins) {
    for (const h of p.hooks) {
      const ph = /\$\{?CLAUDE_PLUGIN_ROOT\}?|%CLAUDE_PLUGIN_ROOT%/i.exec(h.command);
      const tail = ph ? canonCommand(h.command.slice(ph.index + ph[0].length)) : null;
      reg.push({ source: p.key, event: h.event, mode: h.mode, raw: canonCommand(h.command), exp: canonCommand(h.command, p.installPath), tail: tail && tail.length >= 8 ? tail : null, segment: `/${p.marketplace}/${p.name}/`.toLowerCase() });
    }
  }
  return reg;
}

/**
 * 對話紀錄的 hook 指令對回登記：完整相符優先；其次是 ${CLAUDE_PLUGIN_ROOT} 之後的路徑相符，而且指令路徑含「/市集/外掛名/」；
 * 對不上、或對到兩個以上不同來源（不能挑一個）的是「來源不明」。
 */
export function attributeHook(reg, event, command) {
  const c = canonCommand(command);
  const pool = reg.filter((r) => !event || r.event === event);
  let hits = pool.filter((r) => r.raw === c || r.exp === c);
  if (!hits.length && c.includes('/plugins/')) hits = pool.filter((r) => r.tail && c.endsWith(r.tail) && (!r.segment || c.includes(r.segment)));
  if (!hits.length || new Set(hits.map((r) => r.source)).size > 1) return { source: null, mode: 'unknown' };
  return { source: hits[0].source, mode: hits.some((r) => r.mode === 'sync') ? 'sync' : 'async' };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** 這筆 assistant／user 紀錄呼叫了哪些外掛（MCP 工具、技能、代理、斜線指令；hook 是自動執行的，不算「使用」） */
function pluginsUsed(o, names) {
  const hits = new Set();
  const byPrefix = (p) => { const n = names.find((x) => x.toLowerCase() === String(p).toLowerCase()); if (n) hits.add(n); };
  const content = o?.message?.content;
  if (o?.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (b.name.startsWith('mcp__plugin_')) {
        const n = names.find((x) => b.name.startsWith(`mcp__plugin_${x}_`));
        if (n) hits.add(n);
      } else if (b.name === 'Skill' && typeof b.input?.skill === 'string' && b.input.skill.includes(':')) byPrefix(b.input.skill.split(':')[0]);
      else if ((b.name === 'Task' || b.name === 'Agent') && typeof b.input?.subagent_type === 'string' && b.input.subagent_type.includes(':')) byPrefix(b.input.subagent_type.split(':')[0]);
    }
  } else if (o?.type === 'user') {
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
    for (const m of text.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) if (m[1].includes(':')) byPrefix(m[1].split(':')[0]);
  }
  return [...hits];
}

/** 掃近 USE_WINDOW_DAYS 天有更新的對話紀錄：近 HOOK_WINDOW_DAYS 天的 hook 耗時與近 USE_WINDOW_DAYS 天的外掛使用 */
async function scanTranscripts(ctx, { now, reg, pluginNames, cmd }) {
  const cutUse = now - USE_WINDOW_DAYS * DAY;
  const cutHook = now - HOOK_WINDOW_DAYS * DAY;
  const groups = new Map();
  const use = {};
  let files = 0;
  for (const file of await listTranscriptFiles(ctx.homes.claudeHome)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < cutUse) continue;
    files++;
    await eachMarkedLine(file, (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }
      const at = Date.parse(o?.timestamp ?? '') || st.mtimeMs;
      if (at < cutUse) return;
      const a = o?.attachment;
      if (o?.type === 'attachment' && a?.type === 'hook_success') {
        const ms = Number(a.durationMs);
        if (at < cutHook || !Number.isFinite(ms) || ms < 0) return;
        const event = String(a.hookEvent ?? String(a.hookName ?? '').split(':')[0] ?? '');
        const command = typeof a.command === 'string' ? a.command : '';
        const { source, mode } = attributeHook(reg, event, command);
        const key = `${event}\0${source ?? ''}\0${canonCommand(command)}`;
        const g = groups.get(key) ?? { event, source, mode, command: cmd(command), durations: [] };
        g.durations.push(ms);
        groups.set(key, g);
        return;
      }
      for (const p of pluginsUsed(o, pluginNames)) {
        const u = use[p] ?? { n: 0, last: null };
        u.n++;
        const d = dateOf(at);
        if (!u.last || d > u.last) u.last = d;
        use[p] = u;
      }
    }).catch(() => {}); // 讀到一半被 Claude Code 清掉
  }
  const hooks = [...groups.values()]
    .map((g) => ({ event: g.event, source: g.source, mode: g.mode, command: g.command, runs: g.durations.length, medianMs: Math.round(median(g.durations)), totalMs: Math.round(g.durations.reduce((s, x) => s + x, 0)) }))
    .sort((a, b) => b.totalMs - a.totalMs || cmpStr(a.event, b.event) || cmpStr(a.command, b.command))
    .slice(0, HOOK_TOP);
  return { hooks, use, files };
}

// ───────── 環境指紋 ─────────

/**
 * 算出環境指紋。內容只有名稱、版本、雜湊、數量與耗時；所有字串都已把家目錄換成 ~、遮蔽疑似金鑰。
 * 回傳 { fingerprint, pluginUse, files }：後兩者只放本機快取（不同步）。
 */
async function buildFingerprint(ctx, { now, claudeVersion }) {
  const { homes } = ctx;
  const { clean, cmd } = cleaners(homes);
  const st = await readSettings(homes);
  const data = st.data;
  const hookOf = (h) => ({ event: h.event, matcher: h.matcher, mode: h.mode, ...(h.type !== 'command' ? { type: h.type } : {}), command: cmd(h.command) });
  const sortHooks = (list) => list.sort((a, b) => cmpStr(a.event, b.event) || cmpStr(a.matcher, b.matcher) || cmpStr(a.command, b.command));
  const settingsHooks = hookEntries(data.hooks);
  const plugins = await readPlugins(homes);
  const enabled = data.enabledPlugins && typeof data.enabledPlugins === 'object' && !Array.isArray(data.enabledPlugins) ? data.enabledPlugins : {};
  const mdText = await readText(path.join(homes.claudeHome, 'CLAUDE.md'));
  const mdStat = mdText === null ? null : await fsp.stat(path.join(homes.claudeHome, 'CLAUDE.md')).catch(() => null);
  const scan = await scanTranscripts(ctx, { now, reg: hookRegistry(settingsHooks, plugins), pluginNames: plugins.map((p) => p.name), cmd });
  const cleanup = data.cleanupPeriodDays;

  const fingerprint = {
    v: 1,
    updated: localDate(now),
    claudeCode: { version: claudeVersion ?? (await transcriptVersion(homes.claudeHome)) ?? null },
    engram: { version: ENGINE_VERSION, commit: await engramCommit(ctx) },
    settings: {
      present: st.present,
      keys: sortStr(Object.keys(data)),
      envKeys: sortStr(Object.keys(data.env && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {})),
      enabledPlugins: Object.fromEntries(sortStr(Object.keys(enabled)).map((k) => [k, enabled[k] !== false])),
      hooks: sortHooks(settingsHooks.map(hookOf)),
      cleanupPeriodDays: typeof cleanup === 'number' && Number.isFinite(cleanup) ? cleanup : null,
    },
    plugins: plugins.map((p) => ({ name: p.name, marketplace: p.marketplace, version: p.version, hooks: sortHooks(p.hooks.map(hookOf)) })),
    skills: await listItems(path.join(homes.claudeHome, 'skills')),
    agents: await listItems(path.join(homes.claudeHome, 'agents')),
    commands: await listItems(path.join(homes.claudeHome, 'commands')),
    claudeMd: mdText === null ? null : claudeMdInfo(mdText, mdStat?.mtimeMs),
    hookStats: { windowDays: HOOK_WINDOW_DAYS, hooks: scan.hooks },
  };
  return { fingerprint: deepClean(fingerprint, clean), pluginUse: { windowDays: USE_WINDOW_DAYS, files: scan.files, byPlugin: scan.use }, files: scan.files };
}

// ───────── 發現（H25–H33） ─────────

function fid(code, refs) {
  return `${code}:${createHash('sha1').update(refs.join('|')).digest('hex').slice(0, 10)}`;
}

/** 卡片的格式與 core/health.mjs 的 finding 相同；有 fixLabel 的卡片可以按「修正」（交給 eg.env.fix，id 會在執行時重新比對） */
function card(code, severity, { title, detail, refs = [], key, fixLabel, fixLabelEn, en }) {
  const id = fid(code, key ? [key] : refs.length ? refs : [title]);
  return { id, code, severity, title, detail, refs, ...(fixLabel ? { fix: { action: 'env-fix', args: { id }, label: fixLabel, en: { label: fixLabelEn } } } : {}), en };
}

const shortList = (names, n = 5) => `${names.slice(0, n).join('、')}${names.length > n ? ` 等 ${names.length} 個` : ''}`;
const shortListEn = (names, n = 5) => `${names.slice(0, n).join(', ')}${names.length > n ? ` and ${names.length - n} more` : ''}`;

/**
 * H25：同步執行、中位數過慢的 hook，依來源（外掛或使用者設定）各一張。
 * 對不回登記（來源不明）的 hook 看不出是同步還是背景，次數與中位數都過門檻時另出一張低嚴重度的，標明無法確認。
 */
function slowHookCards(cache) {
  const all = (cache?.fingerprint?.hookStats?.hooks ?? []).filter((h) => h.runs >= SLOW_HOOK_MIN_RUNS && h.medianMs > SLOW_HOOK_MS);
  const slow = all.filter((h) => h.mode === 'sync');
  const unknown = all.filter((h) => h.mode === 'unknown');
  const out = [];
  if (unknown.length) {
    const total = unknown.reduce((s, h) => s + h.totalMs, 0);
    const name = (h) => `${h.event}「${h.command}」`;
    out.push(card('H25', 'low', {
      refs: ['env:hook:?'],
      title: `${unknown.length} 個來源不明的 hook 偏慢，無法確認是否同步執行`,
      detail: `${unknown.map((h) => `${name(h)} 每次約 ${fmtMs(h.medianMs)}（近 ${HOOK_WINDOW_DAYS} 天 ${h.runs} 次，累計 ${fmtDur(h.totalMs)}）`).join('；')}。這些 hook 在設定檔與外掛的登記裡找不到對應（可能是專案層的設定、外掛已更新或移除），所以看不出是同步還是背景執行；如果是同步的，每次操作都要多等這麼久（共 ${fmtDur(total)}）。`,
      en: {
        title: `${count(unknown.length, 'hook of unknown origin is', 'hooks of unknown origin are')} slow, and it cannot be confirmed whether they run synchronously`,
        detail: `${unknown.map((h) => `${h.event} "${h.command}" takes about ${fmtMsEn(h.medianMs)} each time (${count(h.runs, 'run', 'runs')} in the last ${HOOK_WINDOW_DAYS} days, ${fmtDurEn(h.totalMs)} in total)`).join('; ')}. They match nothing registered in the settings files or plugins (they may come from project settings, or a plugin was updated or removed), so it is unclear whether they run synchronously or in the background. If they are synchronous, every action waits this long (${fmtDurEn(total)} in total).`,
      },
    }));
  }
  for (const source of uniq(slow.map((h) => h.source ?? ''))) {
    // Engram 自己的 hook 不出這張卡片（卡片的建議是關閉遙測或停用外掛，對自己不適用）；耗時照樣列在環境指紋的統計裡
    if (source === SELF_PLUGIN) continue;
    const rows = slow.filter((h) => (h.source ?? '') === source);
    const label = source === 'settings' ? '~/.claude/settings.json 的 hook' : source;
    const labelEn = source === 'settings' ? 'The hooks in ~/.claude/settings.json' : source;
    const total = rows.reduce((s, h) => s + h.totalMs, 0);
    out.push(card('H25', 'medium', {
      refs: [`env:hook:${source}`],
      title: `「${label}」的同步 hook 讓每次操作變慢`,
      detail: `${rows.map((h) => `${h.event} 每次約 ${fmtMs(h.medianMs)}（近 ${HOOK_WINDOW_DAYS} 天 ${h.runs} 次，累計 ${fmtDur(h.totalMs)}）`).join('；')}。同步執行的 hook 會讓 Claude 等它跑完才繼續，近 ${HOOK_WINDOW_DAYS} 天共多等了 ${fmtDur(total)}。建議關閉該外掛的遙測、改成背景執行，或停用該外掛。`,
      en: {
        title: `A synchronous hook from "${labelEn}" slows down every action`,
        detail: `${rows.map((h) => `${h.event} takes about ${fmtMsEn(h.medianMs)} each time (${count(h.runs, 'run', 'runs')} in the last ${HOOK_WINDOW_DAYS} days, ${fmtDurEn(h.totalMs)} in total)`).join('; ')}. A synchronous hook makes Claude wait until it finishes, which added ${fmtDurEn(total)} over the last ${HOOK_WINDOW_DAYS} days. Turn off the plugin's telemetry, make the hook run in the background, or disable the plugin.`,
      },
    }));
  }
  return out;
}

/** 這台電腦 Engram 加進 additionalDirectories、但路徑已經不存在的項目（使用者自己加的不算） */
async function danglingDirs(ctx, settings) {
  if (settings.invalid) return [];
  const manifest = (await readJson(path.join(ctx.local, 'install-manifest.json'), null)) ?? {};
  const mine = Array.isArray(manifest.additionalDirectories) ? manifest.additionalDirectories.filter((p) => typeof p === 'string') : [];
  const list = Array.isArray(settings.data?.permissions?.additionalDirectories) ? settings.data.permissions.additionalDirectories.filter((p) => typeof p === 'string') : [];
  const home = homeOf(ctx.homes);
  const expand = (p) => (/^~(?:[\\/]|$)/.test(p) ? path.join(home, p.slice(1)) : p);
  return mine.filter((p) => list.some((x) => samePath(expand(x), p)) && !presentNoFollow(p));
}

async function staleDirCards(ctx, settings) {
  const dirs = await danglingDirs(ctx, settings);
  if (!dirs.length) return [];
  const { mask } = cleaners(ctx.homes);
  const names = dirs.map((p) => mask(p));
  return [card('H26', 'auto', {
    refs: ['env:additional-directories'],
    title: `Claude Code 的設定裡有 ${dirs.length} 個已不存在的路徑`,
    detail: `Engram 之前加進 permissions.additionalDirectories 的 ${shortList(names)} 已經不存在（例如專案解除綁定後留下的）。移除後不影響任何記憶；修改前會先備份 settings.json。`,
    fixLabel: '移除失效的路徑', fixLabelEn: 'Remove the dead paths',
    en: {
      title: `The Claude Code settings list ${count(dirs.length, 'path that no longer exists', 'paths that no longer exist')}`,
      detail: `${shortListEn(names)} in permissions.additionalDirectories (added by Engram earlier) no longer exist, for example links left behind after a project was unbound. Removing them does not affect any memory; settings.json is backed up first.`,
    },
  })];
}

/** H27：Claude Code 的記憶資料夾是指向這個記憶庫的連結，但這台電腦沒有對應的綁定紀錄 */
async function orphanLinkCards(ctx) {
  const root = path.join(ctx.homes.claudeHome, 'projects');
  const dirs = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const norm = (p) => (process.platform === 'win32' ? normalizeFsPath(p).toLowerCase() : normalizeFsPath(p));
  const projects = norm(path.join(ctx.vault, 'projects'));
  const views = allBindingViews(await readBindings(ctx.vault, ctx.mid));
  const orphans = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const mem = path.join(root, d.name, 'memory');
    if (!isLink(mem)) continue;
    const t = linkTarget(mem);
    if (!t) continue;
    const nt = norm(t);
    if (!nt.startsWith(`${projects}${path.sep}`) || path.basename(nt) !== 'memory') continue;
    if (!views.some((v) => v.encoded?.toLowerCase() === d.name.toLowerCase())) orphans.push(d.name);
  }
  if (!orphans.length) return [];
  orphans.sort(cmpStr);
  return [card('H27', 'medium', {
    refs: ['env:links'], key: `env:links:${orphans.join('|')}`,
    title: `${orphans.length} 個記憶連結在這台電腦沒有對應的綁定紀錄`,
    detail: `Claude Code 的記憶資料夾 ${shortList(orphans)} 是指向記憶庫的連結，但這台電腦的綁定紀錄裡沒有它們（可能是綁定被移除、或從別台複製過來）。寫進去的記憶仍會進到記憶庫，但 Engram 不會管理它。請確認後在對應的資料夾重新綁定，或拆掉連結。`,
    en: {
      title: `${count(orphans.length, 'memory link has', 'memory links have')} no binding record on this computer`,
      detail: `Claude Code's memory folders ${shortListEn(orphans)} are links into the vault, but this computer has no binding records for them (the binding may have been removed, or copied from another computer). Memories written there still land in the vault, but Engram does not manage them. Check them, then rebind the matching folders or remove the links.`,
    },
  })];
}

/** ~/.claude.json 的專案條目（鍵是資料夾的絕對路徑）：只取鍵 */
async function claudeJsonProjects(ctx) {
  const file = path.join(homeOf(ctx.homes), '.claude.json');
  const text = await readText(file);
  if (text === null) return null;
  try {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    const projects = data?.projects && typeof data.projects === 'object' && !Array.isArray(data.projects) ? data.projects : {};
    return { file, text, data, keys: Object.keys(projects) };
  } catch { return null; }
}

async function staleProjectCards(ctx) {
  const cj = await claudeJsonProjects(ctx);
  if (!cj) return [];
  const missing = cj.keys.filter((k) => !presentNoFollow(k));
  if (missing.length < STALE_PROJECTS_MIN) return [];
  const pct = Math.round((missing.length / cj.keys.length) * 100);
  return [card('H28', 'low', {
    refs: ['env:claude-json'],
    title: `~/.claude.json 有 ${missing.length} 個專案條目指向不存在的資料夾`,
    detail: `共 ${cj.keys.length} 個專案條目，其中 ${missing.length} 個（${pct}%）的資料夾已經不在（外接硬碟暫時沒接上的資料夾也會算進來）。這些條目不影響使用，只是讓設定檔稍微大一點。Engram 不會自動清除：Claude Code 執行中會用記憶體裡的內容把整個檔案寫回去，從外面清理並不可靠；要清理的話，請在 Claude Code 沒有執行時自己處理。`,
    en: {
      title: `${count(missing.length, 'project entry in ~/.claude.json points', 'project entries in ~/.claude.json point')} to folders that do not exist`,
      detail: `${missing.length} of ${cj.keys.length} project entries (${pct}%) point to folders that are gone (a folder on an unplugged drive counts too). These entries do not affect anything; they only make the file a little bigger. Engram does not clean them up automatically: while Claude Code is running it writes its in-memory copy of the whole file back, so cleaning up from outside is unreliable. If you want to clean up, do it yourself while Claude Code is not running.`,
    },
  })];
}

/** 記憶庫 .git 裡零散物件的數量（git count-objects）；取不到回傳 0 */
async function looseObjects(ctx) {
  const r = await git(['count-objects', '-v'], { cwd: ctx.vault, allowFail: true, timeoutMs: 15_000 }).catch(() => null);
  return Number(/^count:\s*(\d+)/m.exec(r?.stdout ?? '')?.[1] ?? 0);
}

/** gc.pid 是不是過期的（超過 12 小時、而且裡面的程序已經不在）：git 的自動打包在逾時的指令裡被中斷時會留下 */
async function stalePid(ctx, now) {
  const file = path.join(ctx.vault, '.git', 'gc.pid');
  try {
    const st = fs.lstatSync(file);
    if (now - st.mtimeMs <= GC_PID_STALE_MS) return false;
    const pid = Number.parseInt((await readText(file)) ?? '', 10);
    return !(Number.isInteger(pid) && pid > 0 && processAlive(pid));
  } catch { return false; }
}

/** H29：只出發現（severity auto：背景的記憶庫打包工作會處理，這裡不動手） */
export function gcCards({ stalePid: stale, loose }) {
  if (!stale && loose <= LOOSE_OBJECTS_MAX) return [];
  const why = [stale ? '.git/gc.pid 已經過期（上一次打包被中斷）' : null, loose > LOOSE_OBJECTS_MAX ? `零散物件有 ${loose} 個（超過 ${LOOSE_OBJECTS_MAX}）` : null].filter(Boolean);
  const whyEn = [stale ? 'the .git/gc.pid file is stale (the last repack was interrupted)' : null, loose > LOOSE_OBJECTS_MAX ? `there are ${loose} loose objects (over ${LOOSE_OBJECTS_MAX})` : null].filter(Boolean);
  return [card('H29', 'auto', {
    refs: ['env:gc'],
    title: '記憶庫需要打包',
    detail: `${why.join('；')}。背景的「記憶庫打包」工作會在電腦閒置時處理，不需要你動手。`,
    en: { title: 'The memory vault needs repacking', detail: `${whyEn.join('; ')}. The background repack job handles it while the computer is idle; you do not need to do anything.` },
  })];
}

const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const related = (a, b) => { const x = normName(a); const y = normName(b); return x.length >= 3 && y.length >= 3 && (x === y || x.includes(y) || y.includes(x)); };

/** H30：已停用或已移除的外掛，在 CLAUDE.md 留有標記區塊（這是使用者的指示檔，只提醒） */
async function orphanBlockCards(ctx, settings, plugins, cache) {
  const text = await readText(path.join(ctx.homes.claudeHome, 'CLAUDE.md'));
  if (text === null || settings.invalid) return [];
  const enabled = settings.data.enabledPlugins && typeof settings.data.enabledPlugins === 'object' ? settings.data.enabledPlugins : {};
  const active = plugins.filter((p) => enabled[p.key] !== false).map((p) => p.name);
  const disabled = plugins.filter((p) => enabled[p.key] === false).map((p) => p.name);
  const gone = (cache?.seenPlugins ?? []).filter((n) => !plugins.some((p) => p.name === n));
  const rows = [];
  for (const b of claudeMdInfo(text).blocks) {
    if (active.some((n) => related(b.name, n))) continue;
    const off = disabled.find((n) => related(b.name, n));
    const removed = gone.find((n) => related(b.name, n));
    if (off || removed) rows.push({ block: b.name, plugin: off ?? removed, state: off ? 'disabled' : 'removed' });
  }
  if (!rows.length) return [];
  const zh = (r) => `${r.block}（外掛 ${r.plugin} ${r.state === 'disabled' ? '已停用' : '已移除'}）`;
  const en = (r) => `${r.block} (plugin ${r.plugin} is ${r.state})`;
  return [card('H30', 'low', {
    refs: ['env:claude-md-blocks'], key: `env:claude-md-blocks:${rows.map((r) => r.block).sort().join('|')}`,
    title: `~/.claude/CLAUDE.md 留有 ${rows.length} 個已停用或已移除外掛的區塊`,
    detail: `${rows.map(zh).join('；')}。這些區塊還會在每次對話載入；CLAUDE.md 是你的指示檔，Engram 不會自動改，請確認後自行刪除。`,
    en: {
      title: `~/.claude/CLAUDE.md still has ${count(rows.length, 'block', 'blocks')} from disabled or removed plugins`,
      detail: `${rows.map(en).join('; ')}. They are still loaded in every conversation. CLAUDE.md is your own instruction file, so Engram will not change it; delete them yourself after checking.`,
    },
  })];
}

const SECRET_DIR = /^(keys?|secrets?|credentials?|tokens?|private|certs?)$/i;
const SECRET_FILE = /^(?:.+[._-])?settings(?:[._-].+)?\.json$|^\.?env(?:\..+)?$/i;

/** H31：~/.claude 底下疑似含明文金鑰的設定檔、金鑰資料夾，與使用者層級環境變數裡名稱像金鑰的項目（只列名稱，只提醒） */
async function secretCards(ctx, cache) {
  const out = [];
  const allow = await loadAllow(ctx.local);
  const files = [];
  const dirs = [];
  for (const e of await fsp.readdir(ctx.homes.claudeHome, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && SECRET_DIR.test(e.name)) dirs.push(`${e.name}/`);
    if (!e.isFile() || !SECRET_FILE.test(e.name)) continue;
    const abs = path.join(ctx.homes.claudeHome, e.name);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || st.size > 1024 * 1024) continue;
    const kinds = uniq(scanWithAllow((await readText(abs).catch(() => null)) ?? '', `~/.claude/${e.name}`, allow).map((h) => h.kind));
    if (kinds.length) files.push(`${e.name}`);
  }
  if (files.length || dirs.length) {
    const names = [...files, ...dirs].sort(cmpStr);
    out.push(card('H31', 'medium', {
      refs: ['env:secret-files'], key: `env:secret-files:${names.join('|')}`,
      title: `~/.claude 底下有 ${names.length} 個檔案或資料夾疑似存放明文金鑰`,
      detail: `${shortList(names)}。明文金鑰留在設定檔裡，備份、截圖或分享設定時容易外洩；建議改放環境變數或系統的憑證保管。Engram 不會讀取或改動這些檔案的內容。`,
      en: {
        title: `${count(names.length, 'file or folder', 'files or folders')} under ~/.claude may hold plaintext secrets`,
        detail: `${shortListEn(names)}. Plaintext keys in settings files leak easily through backups, screenshots or shared settings; keep them in environment variables or the system credential store instead. Engram does not read or change the content of these files.`,
      },
    }));
  }
  const envNames = (cache?.secretEnvNames ?? []).filter((n) => typeof n === 'string');
  if (envNames.length) {
    out.push(card('H31', 'low', {
      refs: ['env:secret-env'], key: `env:secret-env:${envNames.join('|')}`,
      title: `使用者層級環境變數有 ${envNames.length} 個名稱像金鑰的項目`,
      detail: `${shortList(envNames)}（只列名稱，不讀取值）。環境變數裡的金鑰會被每個程式讀到；確認是你要的，沒有用到的可以移除。`,
      en: {
        title: `${count(envNames.length, 'user-level environment variable has', 'user-level environment variables have')} a key-like name`,
        detail: `${shortListEn(envNames)} (names only; the values are never read). Every program can read a key kept in an environment variable. Check that you want them, and remove the ones you do not use.`,
      },
    }));
  }
  return out;
}

/** R5：沒有設定 cleanupPeriodDays（Claude Code 的對話紀錄 30 天後清除，回顧來不及就失去來源） */
function cleanupCards(settings) {
  if (settings.invalid || Object.hasOwn(settings.data, 'cleanupPeriodDays')) return [];
  // 排版不是標準格式（例如手排的緊湊陣列）時，Engram 寫入會重排整個檔，所以不自動修、也不提供按鈕，只提醒
  if (!settings.canonical) {
    return [card('H32', 'low', {
      refs: ['env:cleanup-period'],
      title: '沒有設定對話紀錄的保留天數',
      detail: `Claude Code 預設在 30 天後清除對話紀錄；自動駕駛的對話回顧晚一點就失去驗證記憶的依據。建議在 settings.json 設定 cleanupPeriodDays 為 ${CLEANUP_DAYS}。這個檔案的排版不是標準格式（例如手排的緊湊陣列），Engram 不會重排整個檔，所以不會自動設定，請自己加上這一行。`,
      en: {
        title: 'The conversation retention period is not set',
        detail: `Claude Code deletes conversation transcripts after 30 days by default, so a conversation review that comes late loses the source it checks memories against. Setting cleanupPeriodDays to ${CLEANUP_DAYS} in settings.json is recommended. This file is not in the standard layout (for example hand-formatted compact arrays) and Engram will not reformat the whole file, so it will not set the value for you; add the line yourself.`,
      },
    })];
  }
  return [card('H32', 'low', {
    refs: ['env:cleanup-period'],
    title: '沒有設定對話紀錄的保留天數',
    detail: `Claude Code 預設在 30 天後清除對話紀錄；自動駕駛的對話回顧晚一點就失去驗證記憶的依據。建議在 settings.json 設定 cleanupPeriodDays 為 ${CLEANUP_DAYS}（只新增這個設定，其他部分逐位元不變，解除安裝時會還原）。自動駕駛開啟時 Engram 會自己設。`,
    fixLabel: `設成 ${CLEANUP_DAYS} 天`, fixLabelEn: `Set it to ${CLEANUP_DAYS} days`,
    en: {
      title: 'The conversation retention period is not set',
      detail: `Claude Code deletes conversation transcripts after 30 days by default, so a conversation review that comes late loses the source it checks memories against. Setting cleanupPeriodDays to ${CLEANUP_DAYS} in settings.json is recommended (only this setting is added, everything else stays byte for byte, and uninstalling restores it). Engram sets it by itself when autopilot is on.`,
    },
  })];
}

/**
 * 近 30 天沒有被呼叫過的外掛（H33 與 WP8 的 plan 共用）。有註冊 hook 的外掛靠 hook 運作，不需要被呼叫，不算；停用的、剛裝不到 30 天的也不算。
 * 統計不足以判斷（沒有快取、沒有對話紀錄、對話紀錄留不到 30 天）時回傳 null，和「沒有」不同。
 */
export async function unusedPlugins(ctx, settings, plugins, cache, now) {
  const use = cache?.pluginUse;
  if (!use || !use.files || settings.invalid) return null;
  if ((await retentionDays(ctx.homes.claudeHome)) < USE_WINDOW_DAYS) return null; // 對話紀錄留不到 30 天，看不出沒用過
  const enabled = settings.data.enabledPlugins && typeof settings.data.enabledPlugins === 'object' ? settings.data.enabledPlugins : {};
  return plugins.filter((p) => {
    const installed = Date.parse(p.installedAt ?? '');
    return enabled[p.key] !== false && !p.hooks.length && Number.isFinite(installed) && now - installed >= USE_WINDOW_DAYS * DAY && !use.byPlugin?.[p.name]?.n;
  });
}

async function unusedPluginCards(ctx, settings, plugins, cache, now) {
  const idle = await unusedPlugins(ctx, settings, plugins, cache, now);
  if (!idle?.length) return [];
  const names = idle.map((p) => p.key);
  return [card('H33', 'low', {
    refs: names.map((k) => `plugin:${k}`), key: `env:unused-plugins:${names.join('|')}`,
    title: `${idle.length} 個外掛近 ${USE_WINDOW_DAYS} 天沒有被使用過`,
    detail: `${shortList(names)}：近 ${USE_WINDOW_DAYS} 天的對話紀錄裡沒有呼叫它們的工具、技能、代理或指令。沒在用的外掛仍會載入、佔用上下文；可以考慮停用（Engram 不會自動停用）。`,
    en: {
      title: `${count(idle.length, 'plugin was', 'plugins were')} not used in the last ${USE_WINDOW_DAYS} days`,
      detail: `${shortListEn(names)}: no tool, skill, agent or command of ${idle.length === 1 ? 'it was' : 'them were'} called in the last ${USE_WINDOW_DAYS} days of conversations. Unused plugins are still loaded and take up context; consider disabling them (Engram will not disable them for you).`,
    },
  })];
}

/** 即時的輕量檢查（設定、連結、檔案）加上快取的統計（hook 耗時、外掛使用、使用者環境變數） */
async function computeFindings(ctx, { now, cache }) {
  const settings = await readSettings(ctx.homes);
  const plugins = await readPlugins(ctx.homes);
  return [
    ...slowHookCards(cache),
    ...await staleDirCards(ctx, settings),
    ...await orphanLinkCards(ctx),
    ...await staleProjectCards(ctx),
    ...gcCards({ stalePid: await stalePid(ctx, now), loose: await looseObjects(ctx) }),
    ...await orphanBlockCards(ctx, settings, plugins, cache),
    ...await secretCards(ctx, cache),
    ...cleanupCards(settings),
    ...await unusedPluginCards(ctx, settings, plugins, cache, now),
  ];
}

// ───────── 快取與更新 ─────────

export async function readCache(ctx) {
  const c = await readJson(fileOf(ctx, 'env.json'), null);
  return c && typeof c === 'object' && c.v === 1 && c.fingerprint ? c : null;
}

async function writeFindingsCache(ctx, findings, now) {
  await fsp.mkdir(path.dirname(fileOf(ctx, 'env-findings.json')), { recursive: true });
  await writeJson(fileOf(ctx, 'env-findings.json'), { v: 1, at: new Date(now).toISOString(), findings });
}

/** 健康檢查用：只讀快取，過期（超過 3 天沒更新）就當作沒有 */
export async function cachedEnvFindings(ctx, now = Date.now()) {
  const c = await readJson(fileOf(ctx, 'env-findings.json'), null);
  if (!c || !Array.isArray(c.findings) || !(now - Date.parse(c.at) < FINDINGS_MAX_MS)) return [];
  return c.findings.filter((f) => f && typeof f.id === 'string' && typeof f.code === 'string');
}

/** 使用者層級環境變數的名稱（只取名稱）：Windows 讀 HKCU\Environment，其他系統用目前程序的環境 */
async function readUserEnvNames() {
  if (process.platform !== 'win32') return Object.keys(process.env);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Environment'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve([...String(stdout).matchAll(/^\s+(\S+)\s+REG_\w+/gm)].map((m) => m[1]));
    });
  });
}

/**
 * 重新掃描：算環境指紋與發現，寫進本機快取。耗時（要掃近 30 天的對話紀錄），由每日的 env 工作與 engram env 呼叫。
 * @param {{ now?: number, claudeVersion?: string|null, userEnvNames?: () => Promise<string[]>|string[] }} [o]
 */
export async function refreshEnv(ctx, { now = Date.now(), claudeVersion, userEnvNames = readUserEnvNames } = {}) {
  const built = await buildFingerprint(ctx, { now, claudeVersion });
  const prev = await readCache(ctx);
  const names = await Promise.resolve(userEnvNames()).catch(() => []);
  const installed = (await readPlugins(ctx.homes)).map((p) => p.name);
  const cache = {
    v: 1, at: new Date(now).toISOString(), fingerprint: built.fingerprint, pluginUse: built.pluginUse,
    secretEnvNames: sortStr(uniq(names.filter((n) => typeof n === 'string' && SECRET_NAME.test(n)))),
    seenPlugins: sortStr(uniq([...(prev?.seenPlugins ?? []), ...installed])),
  };
  await fsp.mkdir(path.dirname(fileOf(ctx, 'env.json')), { recursive: true });
  await writeJson(fileOf(ctx, 'env.json'), cache);
  const findings = await computeFindings(ctx, { now, cache });
  await writeFindingsCache(ctx, findings, now);
  return { fingerprint: built.fingerprint, findings };
}

/** 環境指紋：快取（36 小時內）有就直接回傳；refresh 或快取過期才重新掃描 */
export async function envFingerprint(ctx, o = {}) {
  const now = o.now ?? Date.now();
  const cache = await readCache(ctx);
  if (!o.refresh && cache && now - Date.parse(cache.at) < CACHE_MAX_MS) return cache.fingerprint;
  return (await refreshEnv(ctx, { ...o, now })).fingerprint;
}

/** 發現：沒有快取或 refresh 時完整重掃；否則用即時的輕量檢查加快取的統計重算，並更新健康檢查讀的快取 */
export async function envFindings(ctx, o = {}) {
  const now = o.now ?? Date.now();
  const cache = await readCache(ctx);
  if (o.refresh || !cache) return (await refreshEnv(ctx, { ...o, now })).findings;
  const findings = await computeFindings(ctx, { now, cache });
  await writeFindingsCache(ctx, findings, now);
  return findings;
}

// ───────── 同步的指紋（machines/<mid>/env.json） ─────────

/** 內容有變才寫（比對時排除 updated）；寫入前過疑似金鑰偵測，偵測到就不寫進記憶庫 */
export async function publishFingerprint(ctx, fp) {
  const rel = `machines/${ctx.mid}/env.json`;
  const abs = path.join(machineDir(ctx.vault, ctx.mid), 'env.json');
  const hits = scanWithAllow(stableJson(fp), rel, await loadAllow(ctx.local));
  if (hits.length) return { written: false, blocked: uniq(hits.map((h) => h.kind)) };
  const cur = await readJson(abs, null);
  if (cur && JSON.stringify({ ...cur, updated: null }) === JSON.stringify({ ...fp, updated: null })) return { written: false };
  return ctx.locked('env', async () => {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await writeJson(abs, fp);
    const commit = await commitPaths(ctx.vault, [rel], 'env fingerprint', { action: 'env', mid: ctx.mid });
    return { written: true, commit: commit ?? undefined };
  });
}

// ───────── 自動修 ─────────

/** 修改前把檔案備份到 local/env/backups/<時間>/（WP8 的環境設定套用也放在這裡） */
async function backupFiles(ctx, files, now) {
  const dir = path.join(ctx.local, 'env', 'backups', new Date(now).toISOString().replace(/[:.]/g, '-'));
  await fsp.mkdir(dir, { recursive: true });
  for (const f of files) await fsp.copyFile(f, path.join(dir, path.basename(f))).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  return dir;
}

async function fixStaleDirs(ctx, now) {
  const settings = await readSettings(ctx.homes);
  const dirs = await danglingDirs(ctx, settings);
  const backup = await backupFiles(ctx, [settingsFile(ctx.homes)], now);
  for (const p of dirs) await revokeJunctionRead(ctx.homes, p); // 只動 Engram 加的項目（安裝清單裡的）
  return { removed: dirs.length, backup };
}

async function fixCleanupPeriod(ctx, now) {
  const backup = await backupFiles(ctx, [settingsFile(ctx.homes)], now);
  const changed = await setSettingIfMissing(ctx.homes, 'cleanupPeriodDays', CLEANUP_DAYS); // 記進安裝清單，解除安裝時還原
  return { changed, days: CLEANUP_DAYS, backup };
}

/**
 * 修正一張環境健檢的卡片。id 對照「現在重新算出來」的發現（不接受任意路徑，R-45）；只有帶 fix 的卡片能修，
 * 其中 H26 只動 Engram 自己加的項目、H29 交給背景的記憶庫打包工作。每一項都會先備份。
 * H28（~/.claude.json 的失效專案條目）只報告：Claude Code 執行中會用記憶體裡的內容整個寫回，從外面清理不可靠。
 * @param {{ now?: number }} [o]
 */
export async function fixEnv(ctx, id, { now = Date.now() } = {}) {
  invariant(typeof id === 'string' && id, '缺少卡片 id', undefined, { message: 'Missing the finding id' });
  const f = (await computeFindings(ctx, { now, cache: await readCache(ctx) })).find((x) => x.id === id);
  if (!f) throw new EngramError(E.NOT_FOUND, '這張卡片已經不存在，可能已經處理過了', '重新整理收件匣').withEn('This card no longer exists; it may already have been handled', 'Refresh the inbox');
  if (f.code === 'H29') return { ok: false, delegated: 'gc', code: f.code, note: '記憶庫打包由背景的 gc 工作處理', en: { note: 'The vault repack is handled by the background gc job' } };
  invariant(f.fix, '這一項只能提醒，沒有可以自動修正的動作', undefined, { message: 'This item is a reminder only; there is nothing to fix automatically' });
  const r = f.code === 'H26' ? await fixStaleDirs(ctx, now) : f.code === 'H32' ? await fixCleanupPeriod(ctx, now) : null;
  invariant(r, `不支援修正：${f.code}`, undefined, { message: `Cannot fix ${f.code}` });
  await writeFindingsCache(ctx, await computeFindings(ctx, { now, cache: await readCache(ctx) }), now);
  return { ok: true, code: f.code, ...r };
}

/**
 * 每日的 env 工作：重新掃描、內容有變就寫進記憶庫、自動修該自動修的（H26；自動駕駛開啟時的 H32）。
 * 設定 envHealth 為 off 時不做。
 * @param {{ now?: number, claudeVersion?: string|null, userEnvNames?: Function, isIdle?: Function }} [o]
 */
export async function runEnv(ctx, o = {}) {
  const now = o.now ?? Date.now();
  const settings = await readEngineSettings(ctx);
  if (settings.envHealth === 'off') return { ok: true, skipped: 'off' };
  const r = await refreshEnv(ctx, { now, claudeVersion: o.claudeVersion, userEnvNames: o.userEnvNames });
  const pub = await publishFingerprint(ctx, r.fingerprint);
  const fixed = [];
  const failed = [];
  for (const f of r.findings) {
    if (!f.fix || !(f.code === 'H26' || (f.code === 'H32' && settings.autopilot === 'on'))) continue;
    try { await fixEnv(ctx, f.id, { now, isIdle: o.isIdle }); fixed.push(f.code); } catch (err) { failed.push({ code: f.code, message: String(err?.message ?? err).slice(0, 200) }); }
  }
  const findings = fixed.length ? await envFindings(ctx, { now }) : r.findings;
  return { ok: true, ...pub, findings: findings.length, fixed, ...(failed.length ? { failed } : {}) };
}

// ───────── 兩台差異 ─────────

/** '2.1.329'、'1.6.0-abc1234' → 比大小（-1、0、1）；看不懂時回傳 NaN */
export function compareVersions(a, b) {
  const pa = String(a ?? '').split('-')[0].split('.').map(Number);
  const pb = String(b ?? '').split('-')[0].split('.').map(Number);
  if (pa.length < 2 || pb.length < 2 || [...pa, ...pb].some((x) => !Number.isFinite(x))) return Number.NaN;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 哪一台比較新：版本號大的；沒有版本號就比修改日期；看不出來是 null。values：{ mid: 值 } */
function newerOf(values, how) {
  const have = Object.entries(values).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (have.length < 2) return null;
  const rank = (a, b) => (how === 'version' ? compareVersions(a, b) : cmpStr(a ?? '', b ?? ''));
  let best = have[0];
  let tie = false;
  for (const e of have.slice(1)) {
    const c = rank(e[1], best[1]);
    if (Number.isNaN(c)) return null;
    if (c > 0) { best = e; tie = false; } else if (c === 0) tie = true;
  }
  return tie ? null : best[0];
}

/**
 * 讀所有電腦同步來的 env.json，列出哪些不一樣、哪一邊比較新（依版本或修改日期）。
 * 比較：Claude Code 與 Engram 的版本、外掛的有無與版本、技能的有無與雜湊、CLAUDE.md 的雜湊與標記區塊、設定鍵與 env 鍵名。
 * @returns {Promise<{ machines: { mid, label, self, updated }[], compared: number, items: { area, key, kind, values, newer, summary, en }[] }>}
 */
export async function diffEnv(ctx) {
  const machines = [];
  const fps = new Map();
  for (const mid of await listMachineIds(ctx.vault)) {
    const dir = machineDir(ctx.vault, mid);
    const fp = await readJson(path.join(dir, 'env.json'), null);
    const label = (await readJson(path.join(dir, 'machine.json'), null))?.label ?? mid;
    const ok = fp && typeof fp === 'object' && fp.v === 1;
    machines.push({ mid, label, self: mid === ctx.mid, updated: ok ? fp.updated ?? null : null, hasEnv: !!ok });
    if (ok) fps.set(mid, fp);
  }
  const mids = [...fps.keys()];
  const items = [];
  const label = (mid) => machines.find((m) => m.mid === mid)?.label ?? mid;
  const lab = (values) => Object.entries(values).map(([m, v]) => `${label(m)}：${v ?? '沒有'}`).join('，');
  const labEn = (values) => Object.entries(values).map(([m, v]) => `${label(m)}: ${v ?? 'none'}`).join(', ');
  /** extract(fp) → Map(key → 值)；這台沒有的鍵就不放。kind：兩台都有但值不同時的種類；order：沒有版本號時用來比新舊的值（修改日期） */
  const compare = (area, extract, { kind, how, areaZh, areaEn, order }) => {
    const per = new Map(mids.map((m) => [m, extract(fps.get(m))]));
    for (const key of sortStr(uniq([...per.values()].flatMap((x) => [...x.keys()])))) {
      const values = Object.fromEntries(mids.map((m) => [m, per.get(m).get(key) ?? null]));
      const present = Object.values(values).filter((v) => v !== null);
      const allThere = present.length === mids.length;
      if (allThere && present.every((v) => v === present[0])) continue;
      const newer = allThere ? newerOf(order ? Object.fromEntries(mids.map((m) => [m, order(fps.get(m), key)])) : values, how) : null;
      items.push({
        area, key, kind: allThere ? kind : 'missing', values, newer,
        summary: `${areaZh}「${key}」${allThere ? (kind === 'version' ? '版本不同' : '內容不同') : '只有部分電腦有'}：${lab(values)}${newer ? `；${label(newer)} 比較新` : ''}`,
        en: { summary: `${areaEn} "${key}" ${allThere ? (kind === 'version' ? 'has different versions' : 'differs') : 'is only on some computers'}: ${labEn(values)}${newer ? `; ${label(newer)} is newer` : ''}` },
      });
    }
  };
  const one = (key, value) => new Map(value === null || value === undefined || value === '' ? [] : [[key, value]]);
  const modifiedOf = (list) => (fp, key) => (fp[list] ?? []).find((s) => s.name === key)?.modified ?? null;
  const mdModified = (fp) => fp.claudeMd?.modified ?? null;
  compare('claude-code', (fp) => one('Claude Code', fp.claudeCode?.version), { kind: 'version', how: 'version', areaZh: '', areaEn: '' });
  compare('engram', (fp) => one('Engram', fp.engram?.version), { kind: 'version', how: 'version', areaZh: '', areaEn: '' });
  compare('plugin', (fp) => new Map((fp.plugins ?? []).map((p) => [`${p.name}@${p.marketplace}`, p.version || '（沒有版本）'])), { kind: 'version', how: 'version', areaZh: '外掛', areaEn: 'Plugin' });
  compare('skill', (fp) => new Map((fp.skills ?? []).filter((s) => s.hash).map((s) => [s.name, s.hash])), { kind: 'hash', how: 'date', order: modifiedOf('skills'), areaZh: '技能', areaEn: 'Skill' });
  compare('claude-md', (fp) => one('CLAUDE.md', fp.claudeMd?.hash), { kind: 'hash', how: 'date', order: mdModified, areaZh: '', areaEn: '' });
  compare('claude-md-block', (fp) => new Map((fp.claudeMd?.blocks ?? []).map((b) => [b.name, b.name.toLowerCase() === 'engram' ? 'present' : b.hash])), { kind: 'hash', how: 'date', order: mdModified, areaZh: 'CLAUDE.md 標記區塊', areaEn: 'CLAUDE.md block' });
  compare('setting-key', (fp) => new Map((fp.settings?.keys ?? []).map((k) => [k, 'present'])), { kind: 'hash', how: 'date', areaZh: 'settings.json 設定鍵', areaEn: 'settings.json key' });
  compare('env-key', (fp) => new Map((fp.settings?.envKeys ?? []).map((k) => [k, 'present'])), { kind: 'hash', how: 'date', areaZh: 'settings.json 的 env 鍵名', areaEn: 'settings.json env key' });
  return { machines, compared: mids.length, items };
}
