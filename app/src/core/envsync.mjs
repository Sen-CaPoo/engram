// 環境設定同步與瘦身（2.0.0 WP8：R3、R4、R6）。
// 讓兩台電腦的 Claude Code 環境（白名單內的設定、環境變數、自製技能、應該安裝的外掛清單）用同一份設定檔，
// 並且能看出哪些外掛沒在用、一鍵停用。
//
// 資料位置：
// - vault/env/profile.json：共用的環境設定檔 { v, env, settings, skills, plugins, updatedAt, by }（會同步）。
// - vault/env/skills/<名稱>/：profile.skills 列出的自製技能（會同步）。
// - vault/machines/<mid>/env-overrides.json：這台電腦的覆寫 { skip, env, settings }（會同步，只有這台讀）。
// - local/env/backups/<時間>/：每次套用前的備份（settings.json 原樣、被蓋過的技能檔案）。
// - local/install-manifest.json 的 envSync.applies：套用紀錄（解除安裝時依它還原）。
// - local/cache/env-plan.json：每日算出的 plan（介面與每週摘要讀）。
// vault/env 底下不是記憶：不進索引、搜尋、健康檢查。
//
// 安全原則：寧可拒絕，也不要把像金鑰的東西寫進會同步的 vault/。
// - 寫進 vault 之前一律先驗證（名稱、型別、疑似金鑰偵測）；guardStaged 只掃 .md，所以這裡是 JSON 與技能檔案唯一的關卡。
// - 從 vault 讀進來的內容（別台電腦同步來的）在 plan 與 apply 前重新驗證，不合格的不套用、列在 blocked。
// - settings.json 只動白名單的鍵、env 區塊與 enabledPlugins；沒被改到的部分逐位元不變（排版不是標準格式就拒絕，不重排）。
// - 這些內容會在每台電腦上變成「不經權限確認就生效」的設定，所以：statusLine（定期執行的指令）不在白名單；
//   會執行程式、改變執行環境或轉送請求的環境變數名稱一律拒絕（ENV_DENY_*）；
//   從記憶庫同步來的項目，沒有在這台電腦核可過（local/env/approved.json，不同步）就不套用，auto 也一樣（engram env approve）。
// - 技能複製不穿越連結；套用只蓋過、不刪本機檔案。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  canonicalJson, readInstallManifest, readSettingsDoc, removeSettingsFile, renderSettingsDoc, withInstallManifest, writeSettingsDoc, writeSettingsText,
} from './claudesettings.mjs';
import { compareVersions, masker, readCache, readPlugins, SECRET_NAME, unusedPlugins, USE_WINDOW_DAYS } from './envhealth.mjs';
import { E, EngramError } from './errors.mjs';
import { isLink, readJson, readText, removeJunction, sha1, stableJson, writeJson } from './fsx.mjs';
import { loadAllow, scanWithAllow } from './secretallow.mjs';
import { redactSecrets } from './secrets.mjs';
import { commitPaths, listMachineIds, machineDir } from './vault.mjs';

/**
 * settings.json 只同步這些鍵（其餘一律拒絕：hooks、permissions、env 區塊、enabledPlugins 都不在內）。
 * statusLine 不在內：它是會被定期執行的指令，等同一個 hook。
 */
export const SETTINGS_WHITELIST = Object.freeze(['model', 'effortLevel', 'language', 'theme', 'cleanupPeriodDays', 'autoUpdatesChannel', 'editorMode']);
/**
 * 環境變數名稱的拒絕清單（不分大小寫）：這些會讓 Claude Code 與它啟動的每個程序執行別人指定的程式、改變執行環境，或把請求（連同認證）送到別的主機。
 * 精確的名稱，加上前綴與後綴的樣式。原有的金鑰名稱規則（SECRET_NAME）另外照舊。
 */
export const ENV_DENY_NAMES = Object.freeze([
  'BASH_ENV', 'ENV', 'SHELL', 'COMSPEC', 'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
  'CLAUDE_ENV_FILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH',
]);
// 前綴：CLAUDE_CODE_SHELL* 是 Claude Code 用來指定或包住 shell 的變數（CLAUDE_CODE_SHELL、CLAUDE_CODE_SHELL_PREFIX…），SSL_CERT_* 指向憑證檔案或資料夾
export const ENV_DENY_PREFIXES = Object.freeze(['LD_', 'DYLD_', 'GIT_', 'NPM_CONFIG_', 'ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_', 'AZURE_CLIENT_', 'GOOGLE_APPLICATION_', 'SSL_CERT_', 'CLAUDE_CODE_SHELL']);
// 後綴：指向程式或位置（路徑、安裝位置、設定或憑證檔案、要執行的指令、shell 與前綴包裝），本來就不該跨電腦同步
export const ENV_DENY_SUFFIXES = Object.freeze([
  '_BASE_URL', '_PROXY', '_ENDPOINT',
  '_PATH', '_HOME', '_DIR', '_FILE', '_CMD', '_COMMAND', '_SHELL', '_PREFIX', '_EXEC', '_CA_CERTS', '_CERT', '_CERT_FILE',
]);
export function envNameDenied(key) {
  const k = String(key).toUpperCase();
  return ENV_DENY_NAMES.includes(k) || ENV_DENY_PREFIXES.some((p) => k.startsWith(p)) || ENV_DENY_SUFFIXES.some((s) => k.endsWith(s));
}
/** 技能複製的上限：單檔 1 MB、500 個檔案、合計 10 MB；.git 與 node_modules 不複製 */
export const SKILL_MAX_FILE_BYTES = 1024 * 1024;
const SKILL_MAX_FILES = 500;
const SKILL_MAX_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV_VALUE_MAX = 2000;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLUGIN_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONFLICT_MARK = /^(<<<<<<<|>>>>>>>)( |$)/m;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MODES = ['report', 'auto', 'off'];

const iso = (ms) => new Date(ms).toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const uniq = (a) => [...new Set(a)];
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort(cmpStr).map((k) => [k, o[k]]));
const clip = (s, n = 80) => redactSecrets(String(s ?? '')).text.slice(0, n);

function paths(ctx) {
  return {
    profile: path.join(ctx.vault, 'env', 'profile.json'),
    skills: path.join(ctx.vault, 'env', 'skills'),
    overrides: path.join(machineDir(ctx.vault, ctx.mid), 'env-overrides.json'),
    planCache: path.join(ctx.local, 'cache', 'env-plan.json'),
    backups: path.join(ctx.local, 'env', 'backups'),
    skillsHome: path.join(ctx.homes.claudeHome, 'skills'),
  };
}

// ───────── 驗證 ─────────

const bad = (reason, message, en, extra = {}) => ({ ok: false, reason, message, en: { message: en }, ...extra });
const OK = Object.freeze({ ok: true });

/** 文字裡疑似金鑰的種類（只回傳種類，不帶出值） */
function secretKinds(texts, allow) {
  const kinds = new Set();
  for (const t of texts) for (const h of scanWithAllow(t, 'env/profile.json', allow)) kinds.add(h.kind);
  return [...kinds].sort(cmpStr);
}

/**
 * 環境變數：名稱不可像金鑰（含 KEY、TOKEN、SECRET、PASSWORD 一律拒絕），也不可在拒絕清單（ENV_DENY_*：會執行程式、改變執行環境或轉送請求的名稱）；
 * 值最多 2,000 個字元的單行文字，要過疑似金鑰偵測。homeMask 有給時，值含這台電腦的家目錄路徑也拒絕
 */
export function checkEnvEntry(key, value, { allow = {}, homeMask } = {}) {
  if (typeof key !== 'string' || !ENV_NAME.test(key) || UNSAFE_KEYS.has(key)) return bad('name', '環境變數名稱只能是英數字與底線，而且不能以數字開頭', 'The name may only contain letters, digits and underscores, and cannot start with a digit');
  if (envNameDenied(key)) return bad('denied-name', `環境變數 ${key} 不會同步：它會改變 Claude Code 與它啟動的程式的執行環境，或指向程式與位置（執行別人指定的程式、改變路徑、轉送請求），本來就不該跨電腦，請在這台電腦自己設定`, `The environment variable ${key} is never synced: it changes the environment of Claude Code and every program it starts, or points to a program or a location (running programs someone else chose, changing paths, redirecting requests), which never belongs on another computer; set it on this computer yourself`);
  if (SECRET_NAME.test(key)) return bad('secret-name', '名稱含 KEY、TOKEN、SECRET 或 PASSWORD 的環境變數不會同步（金鑰請放在系統的憑證保管，或在每台電腦各自設定）', 'Variables whose name contains KEY, TOKEN, SECRET or PASSWORD are never synced (keep secrets in the system credential store, or set them on each computer separately)');
  if (typeof value !== 'string' || !value || value.length > ENV_VALUE_MAX || CONTROL.test(value)) return bad('value', `值必須是 1 到 ${ENV_VALUE_MAX} 個字元的單行文字`, `The value must be single-line text of 1 to ${ENV_VALUE_MAX} characters`);
  if (homeMask && homeMask(value) !== value) return bad('home-path', '值含這台電腦的家目錄路徑，換到別台電腦就不對了', "The value contains this computer's home folder path, which would be wrong on another computer");
  const kinds = secretKinds([`${key}=${value}`, value], allow);
  if (kinds.length) return bad('secret-value', `值疑似金鑰（${kinds.join('、')}），不會寫進記憶庫`, `The value looks like a secret (${kinds.join(', ')}), so it will not be written to the vault`, { kinds });
  return OK;
}

const str = (max, re) => (v) => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v) && (!re || re.test(v));
const WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SETTING_TYPES = {
  model: str(100, /^[A-Za-z0-9._:@[\]/-]+$/),
  effortLevel: str(32, WORD),
  language: str(64),
  theme: str(64),
  cleanupPeriodDays: (v) => Number.isInteger(v) && v >= 1 && v <= 3650,
  autoUpdatesChannel: str(32, WORD),
  editorMode: str(32, WORD),
};

/** settings.json 的鍵：只允許白名單、型別要對、不含家目錄、值要過疑似金鑰偵測 */
export function checkSettingEntry(key, value, { allow = {}, homeMask } = {}) {
  if (!SETTINGS_WHITELIST.includes(key)) return bad('not-allowed', `「${clip(key)}」不在可同步的設定裡（只有 ${SETTINGS_WHITELIST.join('、')}）`, `"${clip(key)}" is not a syncable setting (only ${SETTINGS_WHITELIST.join(', ')})`);
  if (!SETTING_TYPES[key](value)) return bad('type', `「${key}」的值格式不對`, `The value of "${key}" has the wrong type or format`);
  const json = JSON.stringify(value);
  if (homeMask && homeMask(json) !== json) return bad('home-path', `「${key}」的值含這台電腦的家目錄路徑，換到別台電腦就不對了`, `The value of "${key}" contains this computer's home folder path, which would be wrong on another computer`);
  const kinds = secretKinds([json, ...(typeof value === 'string' ? [`${key}=${value}`] : [])], allow);
  if (kinds.length) return bad('secret-value', `「${key}」的值疑似金鑰（${kinds.join('、')}），不會寫進記憶庫`, `The value of "${key}" looks like a secret (${kinds.join(', ')}), so it will not be written to the vault`, { kinds });
  return OK;
}

const skillNameBad = (name) => bad('name', `技能名稱不合法：${clip(name)}（只能是單一的資料夾名稱，由英數字、點、底線、連字號組成）`, `Invalid skill name: ${clip(name)} (it must be a single folder name made of letters, digits, dots, underscores and hyphens)`);
const checkSkillName = (name) => (typeof name === 'string' && SKILL_NAME.test(name) ? OK : skillNameBad(name));

const blockedEntry = (area, key, c) => ({ area, key: clip(key), reason: c.reason, ...(c.kinds ? { kinds: c.kinds } : {}), message: c.message, en: c.en });

/** 驗證失敗 → 錯誤（疑似金鑰是 E_SECRET，其餘 E_INVALID）；訊息不帶出值 */
function toError(c) {
  const secret = c.reason === 'secret-name' || c.reason === 'secret-value';
  return new EngramError(secret ? E.SECRET : E.INVALID, c.message, secret ? '金鑰請放在系統的憑證保管（例如 Windows 認證管理員），記憶庫與環境設定只記存放位置' : '', c.kinds ? { kinds: c.kinds } : undefined).withEn(c.en.message, secret ? 'Keep secrets in the system credential store (for example Windows Credential Manager); the vault and the environment profile only record where they are stored' : '');
}

// ───────── 讀設定檔與單機覆寫（重新驗證） ─────────

async function readDoc(file) {
  const text = await readText(file);
  if (text === null) return { present: false };
  try {
    const value = JSON.parse(text.replace(/^﻿/, ''));
    return isObj(value) ? { present: true, value } : { present: true, invalid: true };
  } catch { return { present: true, invalid: true }; }
}

/** 通過驗證的 env 或 settings 項目；沒通過的記進 blocked */
function sanitizeMap(area, raw, check, blocked) {
  const out = {};
  if (raw === undefined) return out;
  if (!isObj(raw)) { blocked.push({ area, key: area, reason: 'type', message: `${area} 不是物件`, en: { message: `${area} is not an object` } }); return out; }
  for (const [k, v] of Object.entries(raw)) {
    const c = check(k, v);
    if (c.ok) out[k] = v; else blocked.push(blockedEntry(area, k, c));
  }
  return out;
}

function sanitizePlugins(raw, blocked) {
  const out = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) { blocked.push({ area: 'plugin', key: 'plugins', reason: 'type', message: 'plugins 不是陣列', en: { message: 'plugins is not an array' } }); return out; }
  for (const p of raw) {
    const ok = isObj(p) && typeof p.name === 'string' && PLUGIN_PART.test(p.name) && typeof p.marketplace === 'string' && PLUGIN_PART.test(p.marketplace);
    if (ok) out.push({ name: p.name, marketplace: p.marketplace });
    else blocked.push({ area: 'plugin', key: clip(isObj(p) ? p.name : p), reason: 'name', message: `外掛項目不合法：${clip(isObj(p) ? p.name : p)}`, en: { message: `Invalid plugin entry: ${clip(isObj(p) ? p.name : p)}` } });
  }
  return out;
}

function sanitizeSkills(raw, blocked) {
  const out = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) { blocked.push({ area: 'skill', key: 'skills', reason: 'type', message: 'skills 不是陣列', en: { message: 'skills is not an array' } }); return out; }
  for (const n of raw) {
    const c = checkSkillName(n);
    if (c.ok) out.push(n); else blocked.push(blockedEntry('skill', n, c));
  }
  return uniq(out);
}

/** 讀 profile 與這台的覆寫，逐項重新驗證。回傳通過的內容與被拒絕的項目 */
async function loadState(ctx) {
  const allow = await loadAllow(ctx.local);
  const f = paths(ctx);
  const blocked = [];
  const pdoc = await readDoc(f.profile);
  const odoc = await readDoc(f.overrides);
  const profile = { v: 1, env: {}, settings: {}, skills: [], plugins: [], updatedAt: null, by: null };
  const overrides = { skip: [], env: {}, settings: {} };
  const info = { present: pdoc.present, ...(pdoc.invalid ? { problem: 'invalid' } : {}) };
  if (pdoc.present && !pdoc.invalid) {
    const raw = pdoc.value;
    profile.env = sanitizeMap('env', raw.env, (k, v) => checkEnvEntry(k, v, { allow }), blocked);
    profile.settings = sanitizeMap('setting', raw.settings, (k, v) => checkSettingEntry(k, v, { allow }), blocked);
    profile.skills = sanitizeSkills(raw.skills, blocked);
    profile.plugins = sanitizePlugins(raw.plugins, blocked);
    profile.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
    profile.by = typeof raw.by === 'string' ? raw.by : null;
  }
  const oinfo = { present: odoc.present, ...(odoc.invalid ? { problem: 'invalid' } : {}) };
  if (odoc.present && !odoc.invalid) {
    const raw = odoc.value;
    overrides.skip = Array.isArray(raw.skip) ? raw.skip.filter((s) => typeof s === 'string' && s.length <= 200) : [];
    overrides.env = sanitizeMap('env', raw.env, (k, v) => checkEnvEntry(k, v, { allow }), blocked);
    overrides.settings = sanitizeMap('setting', raw.settings, (k, v) => checkSettingEntry(k, v, { allow }), blocked);
  }
  return { allow, profile, overrides, info, oinfo, blocked };
}

/** profile 與覆寫合併：覆寫優先於 profile，skip 最優先。每一項是 { key, value, skip } */
function effective(st) {
  const { profile: p, overrides: o } = st;
  const skipped = (area, ...names) => o.skip.some((s) => names.some((n) => s === n || s === `${area}:${n}`));
  const env = { ...p.env, ...o.env };
  const settings = { ...p.settings, ...o.settings };
  return {
    settings: SETTINGS_WHITELIST.filter((k) => Object.hasOwn(settings, k)).map((key) => ({ key, value: settings[key], skip: skipped('setting', key) })),
    env: Object.keys(env).sort(cmpStr).map((key) => ({ key, value: env[key], skip: skipped('env', key) })),
    skills: [...p.skills].sort(cmpStr).map((key) => ({ key, skip: skipped('skill', key) })),
    plugins: [...p.plugins].sort((a, b) => cmpStr(`${a.name}@${a.marketplace}`, `${b.name}@${b.marketplace}`)).map((pl) => ({ ...pl, key: `${pl.name}@${pl.marketplace}`, skip: skipped('plugin', pl.name, `${pl.name}@${pl.marketplace}`) })),
  };
}

async function envSyncMode(ctx) {
  const s = (await readJson(path.join(ctx.local, 'settings.json'), null)) ?? {};
  return MODES.includes(s.envSync) ? s.envSync : 'report';
}

// ───────── 技能資料夾 ─────────

/** 技能資料夾內的內容雜湊用：文字檔不分 CRLF 與 LF（vault 的 .gitattributes 是 eol=lf，Windows 上的檔案常是 CRLF） */
function normSha(buf) {
  const b = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha1').update(b).digest('hex');
}

/**
 * 列出技能資料夾裡會同步的檔案：略過 .git、node_modules、超過 1 MB 的檔案與所有連結（不穿越）。
 * @returns {Promise<{ exists: boolean, link?: boolean, notDir?: boolean, files?: {rel,abs,size}[], skippedLarge?: string[], skippedLinks?: string[], tooMany?: boolean }>}
 */
async function collectSkill(dir) {
  const st = await fsp.lstat(dir).catch(() => null);
  if (!st) return { exists: false };
  if (st.isSymbolicLink()) return { exists: true, link: true };
  if (!st.isDirectory()) return { exists: true, notDir: true };
  const out = { exists: true, files: [], skippedLarge: [], skippedLinks: [], tooMany: false };
  let bytes = 0;
  const walk = async (d, rel) => {
    for (const e of (await fsp.readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => cmpStr(a.name, b.name))) {
      if (out.tooMany) return;
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isLink(abs)) { out.skippedLinks.push(r); continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(abs, r); continue; }
      if (!e.isFile()) continue;
      const size = (await fsp.stat(abs)).size;
      if (size > SKILL_MAX_FILE_BYTES) { out.skippedLarge.push(r); continue; }
      bytes += size;
      if (out.files.length >= SKILL_MAX_FILES || bytes > SKILL_MAX_BYTES) { out.tooMany = true; return; }
      out.files.push({ rel: r, abs, size });
    }
  };
  await walk(dir, '');
  return out;
}

/** root 本身、或它底下 rel 的路徑上已存在的任何一段是連結（寫進去會穿越到別的地方） */
async function pathHasLink(root, rel) {
  let cur = root;
  if ((await fsp.lstat(root).catch(() => null))?.isSymbolicLink()) return true;
  for (const seg of rel.split('/')) {
    cur = path.join(cur, seg);
    const st = await fsp.lstat(cur).catch(() => null);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/** 讀出技能每個檔案的內容與雜湊（檢查、比對、核可、複製都用同一份：雜湊的就是會被複製的位元組） */
async function loadSkill(files) {
  const out = [];
  for (const f of files) {
    const buf = await fsp.readFile(f.abs);
    out.push({ ...f, buf, sha: normSha(buf) });
  }
  return out;
}

/** 技能內容的雜湊：檔案路徑與（不分 CRLF／LF 的）內容；任何檔案改變、新增或刪除，雜湊就不同 */
const skillDigest = (loaded) => sha1(loaded.map((f) => `${f.rel}\0${f.sha}`).sort(cmpStr).join('\n'));

/** 技能檔案的內容檢查：疑似金鑰（所有檔案，不只 .md）與衝突標記。回傳有問題的檔案（只有檔名與種類） */
async function scanSkill(name, loaded, allow) {
  const out = [];
  for (const f of loaded) {
    const text = f.buf.toString('utf8');
    const kinds = uniq(scanWithAllow(text, `env/skills/${name}/${f.rel}`, allow).map((h) => h.kind)).sort(cmpStr);
    if (kinds.length) out.push({ rel: f.rel, kinds });
    else if (CONFLICT_MARK.test(text)) out.push({ rel: f.rel, kinds: ['conflict-marker'] });
  }
  return out;
}

/** vault 裡技能的副本和來源一致：只複製內容不同的檔案、刪掉來源已經沒有的（副本由 Engram 自己管） */
async function mirrorSkill(srcFiles, destDir) {
  const have = await collectSkill(destDir);
  const want = new Set(srcFiles.map((f) => f.rel));
  for (const f of have.files ?? []) if (!want.has(f.rel)) await fsp.rm(f.abs, { force: true });
  for (const f of srcFiles) {
    const dst = path.join(destDir, ...f.rel.split('/'));
    const buf = f.buf ?? await fsp.readFile(f.abs);
    const cur = await fsp.readFile(dst).catch(() => null);
    if (cur && cur.equals(buf)) continue;
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.writeFile(dst, buf);
  }
  // 清掉空的子資料夾
  const prune = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) if (e.isDirectory() && !isLink(path.join(d, e.name))) await prune(path.join(d, e.name));
    if (d !== destDir && !(await fsp.readdir(d).catch(() => ['x'])).length) await fsp.rmdir(d).catch(() => {});
  };
  await prune(destDir);
}

// ───────── 這台電腦的核可 ─────────
// 從記憶庫同步進來的環境變數、設定與技能，沒有在這台電腦核可過就不會被套用（auto 與手動 apply 都一樣）。
// 核可記在 local/env/approved.json（不同步）：每個 env、settings 項目與每個技能（資料夾內容）各自一個雜湊；內容一變，雜湊就不同、要重新核可。
// 這台自己用 env set、env export 寫出的內容視為已核可。判斷一律看內容的雜湊，不看 profile 裡的 by 欄位（那是寫檔的人決定的）。

const approvalsFile = (ctx) => path.join(ctx.local, 'env', 'approved.json');
const hashEnv = (key, value) => sha1(`env\0${key}\0${value}`);
const hashSetting = (key, value) => sha1(`setting\0${key}\0${canonicalJson(value)}`);

// exported.skills 是另一回事：這台上次匯出的技能內容（不管有沒有核可）。export 用它判斷記憶庫裡的版本是不是自己上次匯出的，不是核可。
async function readApprovals(ctx) {
  const raw = await readJson(approvalsFile(ctx), null);
  const pick = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string')) : {});
  return { env: pick(raw?.env), settings: pick(raw?.settings), skills: pick(raw?.skills), exported: { skills: pick(raw?.exported?.skills) } };
}

/** 記下核可：add 是 { env?: { 鍵: 雜湊 }, settings?: {…}, skills?: { 名稱: 雜湊 }, exportedSkills?: { 名稱: 雜湊 } }；沒有的類別不動 */
async function recordApprovals(ctx, add) {
  const cur = await readApprovals(ctx);
  await writeJson(approvalsFile(ctx), {
    v: 1,
    env: { ...cur.env, ...add.env },
    settings: { ...cur.settings, ...add.settings },
    skills: { ...cur.skills, ...add.skills },
    exported: { skills: { ...cur.exported.skills, ...add.exportedSkills } },
  });
}

// ───────── plan ─────────

const AREA_ZH = { setting: (k) => `設定「${k}」`, env: (k) => `環境變數「${k}」`, skill: (k) => `技能「${k}」`, plugin: (k) => `外掛「${k}」` };
const AREA_EN = { setting: (k) => `Setting "${k}"`, env: (k) => `Environment variable "${k}"`, skill: (k) => `Skill "${k}"`, plugin: (k) => `Plugin "${k}"` };
const item = (area, key, action, o = {}) => ({ area, key, action, ...o });

/** 項目的說明（中英） */
function describe(it, labels = {}) {
  const z = AREA_ZH[it.area](it.key);
  const e = AREA_EN[it.area](it.key);
  const n = it.files ?? 0;
  switch (it.action) {
    case 'add': return it.area === 'skill' ? [`${z}：新增（${n} 個檔案）`, `${e}: add (${n} files)`] : [`${z}：新增 ${it.to}`, `${e}: add ${it.to}`];
    case 'update': return it.area === 'skill' ? [`${z}：更新（${n} 個檔案）`, `${e}: update (${n} files)`] : [`${z}：${it.from} → ${it.to}`, `${e}: ${it.from} -> ${it.to}`];
    case 'restore': return [`${z}：環境設定檔已經沒有這項，這台多出來；apply 會還原成套用之前的樣子（${it.to ?? '沒有這項'}）`, `${e}: no longer in the environment profile, so it is left over on this computer; apply restores it to how it was before it was applied (${it.to ?? 'not set'})`];
    case 'skip': return it.reason === 'skills-link' ? [`${z}：~/.claude/skills 本身是連結，Engram 不穿越，這台不同步技能`, `${e}: ~/.claude/skills is itself a link, which Engram does not follow, so skills are not synced on this computer`] : it.reason === 'link' ? [`${z}：這台的資料夾是連結，不寫入`, `${e}: this computer's folder is a link, so nothing is written`] : it.reason === 'not-dir' ? [`${z}：這台的同名路徑不是資料夾，不寫入`, `${e}: a non-folder of the same name exists here, so nothing is written`] : [`${z}：這台電腦設定為略過`, `${e}: skipped on this computer`];
    case 'not-exported': return [`${z}：記憶庫裡還沒有這個技能的檔案（到有這個技能的電腦執行 engram env export --skill ${it.key}）`, `${e}: the vault has no files for this skill yet (run engram env export --skill ${it.key} on the computer that has it)`];
    case 'missing': return [`${z}：這台沒有安裝（Engram 不會自動安裝，請自行安裝）`, `${e}: not installed on this computer (Engram does not install plugins; install it yourself)`];
    case 'version': {
      const others = Object.entries(it.others).map(([l, v]) => `${l} ${v}`).join('、');
      const othersEn = Object.entries(it.others).map(([l, v]) => `${l} ${v}`).join(', ');
      const newer = it.newer ? (it.newer === labels.self ? '這台比較新' : `${labels[it.newer] ?? it.newer} 比較新`) : '';
      const newerEn = it.newer ? (it.newer === labels.self ? 'this computer is newer' : `${labels[it.newer] ?? it.newer} is newer`) : '';
      return [`${z}：版本不同（這台 ${it.local}；${others}）${newer ? `；${newer}` : ''}`, `${e}: different versions (this computer ${it.local}; ${othersEn})${newerEn ? `; ${newerEn}` : ''}`];
    }
    default: return [z, e];
  }
}

/** 等待這台核可的項目（approved === false）在說明後面標明 */
const finish = (it, labels) => {
  const [zh, en] = describe(it, labels);
  const wait = it.approved === false;
  return { ...it, summary: wait ? `${zh}（等待這台核可）` : zh, en: { summary: wait ? `${en} (waiting for approval on this computer)` : en } };
};

/** 別台電腦同步來的指紋裡的外掛版本：key（名稱@市集）→ [{ mid, label, version }] */
async function otherPlugins(ctx) {
  const out = new Map();
  const labels = {};
  for (const mid of await listMachineIds(ctx.vault)) {
    if (mid === ctx.mid) continue;
    const dir = machineDir(ctx.vault, mid);
    const fp = await readJson(path.join(dir, 'env.json'), null);
    const label = (await readJson(path.join(dir, 'machine.json'), null))?.label ?? mid;
    labels[mid] = label;
    if (!fp || fp.v !== 1 || !Array.isArray(fp.plugins)) continue;
    for (const p of fp.plugins) {
      if (!isObj(p) || typeof p.name !== 'string' || typeof p.version !== 'string' || !p.version) continue;
      const key = `${p.name}@${p.marketplace ?? ''}`;
      out.set(key, [...(out.get(key) ?? []), { mid, label, version: p.version }]);
    }
  }
  return { byKey: out, labels };
}

/** 版本最高的那台（有版本看不懂、或並列最高時回傳 null） */
function newestMid(entries) {
  let best = null;
  let tie = false;
  for (const e of entries) {
    if (!best) { best = e; continue; }
    const c = compareVersions(e.version, best.version);
    if (Number.isNaN(c)) return null;
    if (c > 0) { best = e; tie = false; } else if (c === 0) tie = true;
  }
  return tie ? null : best?.mid ?? null;
}

const FORMAT_PROBLEM = {
  invalid: { message: '~/.claude/settings.json 不是有效的 JSON，Engram 不會修改它', en: '~/.claude/settings.json is not valid JSON, so Engram will not modify it' },
  custom: { message: '~/.claude/settings.json 的排版不是標準格式（例如手排的緊湊陣列），套用會重排整個檔案，所以 Engram 不會修改它；請先把它存成標準的縮排格式，或自行修改', en: '~/.claude/settings.json is not in the standard layout (for example hand-formatted compact arrays), so applying would reformat the whole file and Engram will not modify it; save it in the standard indented layout first, or edit it yourself' },
};

/** 算出 plan 與實際要做的事（apply 用）。只讀。 */
async function computePlan(ctx, now) {
  const st = await loadState(ctx);
  const eff = effective(st);
  const f = paths(ctx);
  const doc = await readSettingsDoc(ctx.homes);
  const format = doc.invalid ? 'invalid' : doc.text === null ? 'missing' : doc.canonical ? 'ok' : 'custom';
  const mask = masker(ctx.homes);
  // 顯示：只遮蔽家目錄與疑似金鑰。要套用的值（to）完整顯示、不截斷（看的人才看得到整段）；這台原本的值（from）超過 2,000 字元時標明截斷
  const display = (v, max = 2000) => {
    const s = redactSecrets(mask(typeof v === 'string' ? v : JSON.stringify(v))).text;
    return s.length > max ? `${s.slice(0, max)}…（已截斷，共 ${s.length} 字元）` : s;
  };
  const { byKey: others, labels } = await otherPlugins(ctx);
  labels.self = ctx.mid;
  const approvals = await readApprovals(ctx);
  const blocked = [...st.blocked];
  const items = [];
  const work = { json: [], skills: [] };

  // settings 與 env：沒有在這台核可過（雜湊對不上）的項目只列出、標「等待這台核可」，不套用
  if (!doc.invalid) {
    for (const e of eff.settings) {
      if (e.skip) { items.push(item('setting', e.key, 'skip', { reason: 'skip' })); continue; }
      const has = Object.hasOwn(doc.data, e.key);
      if (has && canonicalJson(doc.data[e.key]) === canonicalJson(e.value)) continue;
      const hash = hashSetting(e.key, e.value);
      const approved = approvals.settings[e.key] === hash;
      items.push(item('setting', e.key, has ? 'update' : 'add', { from: has ? display(doc.data[e.key]) : null, to: display(e.value, Infinity), hash, approved }));
      if (approved) work.json.push({ path: [e.key], value: e.value });
    }
    for (const e of eff.env) {
      if (e.skip) { items.push(item('env', e.key, 'skip', { reason: 'skip' })); continue; }
      if (doc.data.env !== undefined && !isObj(doc.data.env)) { blocked.push({ area: 'env', key: e.key, reason: 'target-not-object', message: 'settings.json 的 env 不是物件，這一項不套用', en: { message: 'The env value in settings.json is not an object, so this entry is not applied' } }); continue; }
      const has = isObj(doc.data.env) && Object.hasOwn(doc.data.env, e.key);
      if (has && doc.data.env[e.key] === e.value) continue;
      const hash = hashEnv(e.key, e.value);
      const approved = approvals.env[e.key] === hash;
      items.push(item('env', e.key, has ? 'update' : 'add', { from: has ? display(doc.data.env[e.key]) : null, to: display(e.value, Infinity), hash, approved }));
      if (approved) work.json.push({ path: ['env', e.key], value: e.value });
    }

    // 已經套用到這台、但環境設定檔後來移除了的鍵（這台多出來）：apply 時還原成 Engram 第一次動它之前的樣子。
    // 只限 Engram 自己套用過、而且現在的值還是它設的（使用者後來改過的不動）。設定檔不見、損毀或覆寫檔損毀時不判斷，免得整批被當成「已移除」。
    // 技能不在內：已經安裝在這台的技能不會因為從設定檔移除而被動。這台略過（skip）的鍵不動；被擋下（blocked）的鍵仍算在設定檔裡。
    if (st.info.present && !st.info.problem && !st.oinfo.problem) {
      const inProfile = (area) => new Set([...(area === 'setting' ? eff.settings : eff.env).map((e) => e.key), ...st.blocked.filter((b) => b.area === area).map((b) => b.key)]);
      const known = { setting: inProfile('setting'), env: inProfile('env') };
      const skipped = (area, key) => st.overrides.skip.some((s) => s === key || s === `${area}:${key}`); // 這台設定為略過的，不管有沒有在設定檔裡，Engram 都不碰
      const man = await readInstallManifest(ctx.homes);
      for (const e of deriveLedger(man.envSync?.applies ?? []).json) {
        const area = e.path.length === 1 ? 'setting' : e.path[0] === 'env' ? 'env' : null;
        if (!area || e.expectAbsent || known[area].has(e.path.at(-1)) || skipped(area, e.path.at(-1))) continue;
        const cur = getAt(doc.data, e.path);
        if (!cur.has || canonicalJson(cur.value) !== canonicalJson(e.expect)) continue;
        if (e.had && canonicalJson(e.before) === canonicalJson(cur.value)) continue; // 已經是原本的樣子
        items.push(item(area, e.path.at(-1), 'restore', { from: display(cur.value), to: e.had ? display(e.before) : null }));
        work.json.push({ path: e.path, restore: { had: e.had, before: e.before, mapHad: e.mapHad } });
      }
    }
  }

  // 技能：~/.claude/skills 本身是連結時不穿越、不同步；沒有在這台核可過（資料夾內容的雜湊對不上）的技能只列出，不安裝
  const skillsLinked = !!(await fsp.lstat(f.skillsHome).catch(() => null))?.isSymbolicLink();
  for (const sk of eff.skills) {
    if (sk.skip) { items.push(item('skill', sk.key, 'skip', { reason: 'skip' })); continue; }
    if (skillsLinked) { items.push(item('skill', sk.key, 'skip', { reason: 'skills-link' })); continue; }
    const src = await collectSkill(path.join(f.skills, sk.key));
    if (!src.exists || src.link || src.notDir || !src.files.length) { items.push(item('skill', sk.key, 'not-exported')); continue; }
    const loaded = await loadSkill(src.files);
    // vault 裡的副本也重新檢查（可能是別台電腦或手動放進來的）：疑似金鑰或衝突標記就不套用
    const tainted = await scanSkill(sk.key, loaded, st.allow);
    if (tainted.length) {
      blocked.push({ area: 'skill', key: sk.key, reason: 'secret', files: tainted, message: `技能「${sk.key}」在記憶庫裡的副本疑似含有金鑰或衝突標記（${tainted.map((t) => `${t.rel}：${t.kinds.join('、')}`).join('；')}），不套用`, en: { message: `The vault copy of skill "${sk.key}" looks like it contains a secret or conflict markers (${tainted.map((t) => `${t.rel}: ${t.kinds.join(', ')}`).join('; ')}), so it is not applied` } });
      continue;
    }
    const dstRoot = path.join(f.skillsHome, sk.key);
    const dst = await fsp.lstat(dstRoot).catch(() => null);
    if (dst?.isSymbolicLink()) { items.push(item('skill', sk.key, 'skip', { reason: 'link' })); continue; }
    if (dst && !dst.isDirectory()) { items.push(item('skill', sk.key, 'skip', { reason: 'not-dir' })); continue; }
    const write = [];
    const linked = [];
    for (const file of loaded) {
      if (dst && await pathHasLink(dstRoot, file.rel)) { linked.push(file.rel); continue; }
      const cur = dst ? await fsp.readFile(path.join(dstRoot, ...file.rel.split('/'))).catch(() => null) : null;
      if (cur && normSha(cur) === file.sha) continue;
      write.push(file);
    }
    if (!write.length) continue;
    const hash = skillDigest(loaded);
    const approved = approvals.skills[sk.key] === hash;
    items.push(item('skill', sk.key, dst ? 'update' : 'add', { files: write.length, hash, approved, ...(linked.length ? { skippedLinks: linked } : {}) }));
    if (approved) work.skills.push({ name: sk.key, existed: !!dst, write });
  }

  // 外掛：只列清單與差異，不安裝
  const installed = await readPlugins(ctx.homes);
  const byInstalled = new Map(installed.map((p) => [p.key, p]));
  for (const pl of eff.plugins) {
    if (pl.skip) { items.push(item('plugin', pl.key, 'skip', { reason: 'skip' })); continue; }
    const local = byInstalled.get(pl.key);
    if (!local) { items.push(item('plugin', pl.key, 'missing')); continue; }
    const diff = (others.get(pl.key) ?? []).filter((o) => o.version !== local.version);
    if (!diff.length) continue;
    const newer = newestMid([{ mid: ctx.mid, version: local.version }, ...(others.get(pl.key) ?? [])]);
    items.push(item('plugin', pl.key, 'version', { local: local.version, others: Object.fromEntries(diff.map((o) => [o.label, o.version])), newer }));
  }

  // 近 30 天沒用過的外掛（R6）：沒有統計不是「沒有」，是「未知」
  const idle = await unusedPlugins(ctx, { data: doc.data ?? {}, invalid: !!doc.invalid }, installed, await readCache(ctx), now);
  const unused = { known: idle !== null, windowDays: USE_WINDOW_DAYS, plugins: (idle ?? []).map((p) => ({ key: p.key, name: p.name, installedAt: p.installedAt })) };

  const relevant = eff.settings.some((e) => !e.skip) || eff.env.some((e) => !e.skip) || work.json.length > 0;
  const problem = (format === 'invalid' || format === 'custom') && relevant ? { code: format === 'invalid' ? 'invalid' : 'format', message: FORMAT_PROBLEM[format].message, en: { message: FORMAT_PROBLEM[format].en } } : null;
  const plan = {
    v: 1,
    at: iso(now),
    envSync: await envSyncMode(ctx),
    profile: { ...st.info, updatedAt: st.profile.updatedAt, by: st.profile.by },
    overrides: st.oinfo,
    settingsFormat: format,
    ...(problem ? { problem } : {}),
    items: items.map((it) => finish(it, labels)),
    blocked,
    unused,
    // 目前在這台停用的外掛（settings.json 的 enabledPlugins 是 false 的，名稱@市集）：介面重新整理後仍看得到、可以再啟用
    disabledPlugins: isObj(doc.data?.enabledPlugins) ? Object.keys(doc.data.enabledPlugins).filter((k) => doc.data.enabledPlugins[k] === false).sort(cmpStr) : [],
    // changes：現在 apply 會做的變更（已核可的項目與還原）；pending：等待這台核可的項目（engram env approve）
    changes: work.json.length + work.skills.length,
    pending: items.filter((i) => i.approved === false).length,
  };
  return { plan, work, doc, format, problem };
}

/** engram env plan：套用後這台電腦會改什麼（只讀） */
export async function planEnv(ctx, { now = Date.now() } = {}) {
  return (await computePlan(ctx, now)).plan;
}

export async function cachedEnvPlan(ctx) {
  const c = await readJson(paths(ctx).planCache, null);
  return c && c.v === 1 && c.plan ? c : null;
}

// ───────── 寫入 settings.json 與技能（apply、plugin 開關） ─────────

const getAt = (data, p) => {
  let cur = data;
  for (const k of p) {
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return { has: false };
    cur = cur[k];
  }
  return { has: true, value: cur };
};
const setAt = (data, p, v) => {
  if (p.length === 1) { data[p[0]] = v; return; }
  if (!isObj(data[p[0]])) data[p[0]] = {}; // 還原一個被刪掉的鍵時，連同被整個刪掉的區塊（env 之類）一起補回來
  data[p[0]][p[1]] = v;
};

/** 還原一個 JSON 目標：had 就設回 before，否則刪除；刪到 env 之類的區塊空了、而且區塊原本不存在，連區塊一起刪 */
function restoreAt(data, p, had, before, mapHad) {
  if (had) { setAt(data, p, structuredClone(before)); return; }
  if (p.length === 1) { delete data[p[0]]; return; }
  delete data[p[0]][p[1]];
  if (mapHad === false && isObj(data[p[0]]) && !Object.keys(data[p[0]]).length) delete data[p[0]];
}

function formatError(format) {
  return new EngramError(E.INVALID, FORMAT_PROBLEM[format].message, '').withEn(FORMAT_PROBLEM[format].en);
}

/** 備份、寫 settings.json 與技能、記進安裝清單（經過安裝清單的鎖與雜湊比對）。呼叫端已經在 vault 鎖內，而且確認過 settings.json 可以動 */
function writeApply(ctx, o) {
  return withInstallManifest(ctx.homes, (man, save) => writeApplyIn(ctx, man, save, o));
}

async function writeApplyIn(ctx, man, save, { kind, doc, json, skills, now }) {
  const f = paths(ctx);
  // 備份資料夾以時間命名；同一毫秒已經有別人用過就加序號（失敗時只會刪掉自己建的這一個）
  await fsp.mkdir(f.backups, { recursive: true });
  let id = iso(now).replace(/[:.]/g, '-');
  let backup = path.join(f.backups, id);
  for (let n = 2; ; n++) {
    try { await fsp.mkdir(backup); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      id = `${iso(now).replace(/[:.]/g, '-')}-${n}`;
      backup = path.join(f.backups, id);
    }
  }
  man.envSync ??= {};
  man.envSync.applies ??= [];
  const rec = { id, at: iso(now), kind, backup, targets: [] };
  try {
    if (json.length) {
      if (doc.text !== null) await fsp.writeFile(path.join(backup, 'settings.json'), doc.text, 'utf8');
      const data = structuredClone(doc.data);
      const targets = [];
      for (const it of json) {
        const map = it.path.length === 2;
        const mapHad = map ? isObj(data[it.path[0]]) : undefined;
        const cur = getAt(data, it.path);
        const was = { t: 'json', path: it.path, had: cur.has, ...(cur.has ? { before: structuredClone(cur.value) } : {}), ...(map ? { mapHad } : {}) };
        if (it.restore) {
          // 環境設定檔已經沒有這項：還原成 Engram 第一次動它之前的樣子（原本沒有就刪掉）
          restoreAt(data, it.path, it.restore.had, it.restore.before, it.restore.mapHad);
          targets.push({ ...was, ...(it.restore.had ? { after: structuredClone(it.restore.before) } : { del: true }) });
        } else {
          if (map && !mapHad) data[it.path[0]] = {};
          setAt(data, it.path, structuredClone(it.value));
          targets.push({ ...was, after: structuredClone(it.value) });
        }
      }
      man.original ??= doc.text === null ? { missing: true } : { text: doc.text }; // 第一次修改前的原樣（和 update() 共用同一個欄位）
      const out = await writeSettingsDoc(ctx.homes, doc, data);
      rec.settings = { existed: doc.text !== null, hashAfter: sha1(out) };
      rec.targets.push(...targets);
    }
    for (const sk of skills) {
      const dstRoot = path.join(f.skillsHome, sk.name);
      if (!sk.existed) rec.targets.push({ t: 'dir', skill: sk.name });
      for (const file of sk.write) {
        const dst = path.join(dstRoot, ...file.rel.split('/'));
        const had = !!(await fsp.lstat(dst).catch(() => null));
        let kept = null;
        if (had) {
          kept = path.join(backup, 'skills', sk.name, ...file.rel.split('/'));
          await fsp.mkdir(path.dirname(kept), { recursive: true });
          await fsp.copyFile(dst, kept);
        }
        // 複製的就是核可時雜湊的那份位元組：寫入前重新讀一次、雜湊對不上（核可之後被改過）就不裝
        const buf = await fsp.readFile(file.abs);
        if (normSha(buf) !== file.sha) throw new EngramError(E.CONFLICT, `技能「${sk.name}」的 ${file.rel} 在核可之後被改過，沒有安裝`, '重新執行 engram env plan 看新的內容，確認後再核可').withEn(`${file.rel} of skill "${sk.name}" changed after it was approved, so it was not installed`, 'Run engram env plan to see the new content, then approve it again');
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.writeFile(dst, buf);
        rec.targets.push({ t: 'file', skill: sk.name, rel: file.rel, had, backup: kept, sha: file.sha });
      }
    }
  } finally {
    if (rec.targets.length) {
      man.envSync.applies.push(rec);
      await save();
    } else {
      await fsp.rm(backup, { recursive: true, force: true });
    }
  }
  return rec;
}

/** engram env apply：把 profile（加上這台的覆寫）合併寫進 ~/.claude/settings.json 與 ~/.claude/skills/，先備份、記進安裝清單 */
export async function applyEnv(ctx, { now = Date.now() } = {}) {
  return ctx.locked('env.apply', async () => {
    const { plan, work, doc, format, problem } = await computePlan(ctx, now);
    // settings.json 不是有效的 JSON（而且 profile 有要套用的設定）、或排版不是標準格式而且真的有要改的，就拒絕、什麼都不動
    if (format === 'invalid' ? problem : format === 'custom' && work.json.length) throw formatError(format);
    // 只套用已核可的項目（與還原）；有幾項還在等這台核可一併回報
    if (!plan.changes) return { ok: true, applied: 0, pending: plan.pending, items: [] };
    const rec = await writeApply(ctx, { kind: 'apply', doc, json: work.json, skills: work.skills, now });
    return {
      ok: true, id: rec.id, applied: plan.changes, pending: plan.pending, backup: rec.backup,
      items: plan.items.filter((i) => (i.action === 'restore' || ((i.action === 'add' || i.action === 'update') && i.approved !== false)) && i.area !== 'plugin'),
    };
  });
}

/**
 * engram env approve [項目]：核可目前 plan 裡等待核可的項目（沒有指定就是全部）。核可記在這台電腦的 local/env/approved.json（不同步）。
 * 項目寫成名稱，或 env:／setting:／skill: 加名稱；也可以是 { item, hash }：hash 是 plan 顯示該項目時附的雜湊，
 * 內容在你看過之後又變了（同步每 10 分鐘一次）就拒絕（E_CONFLICT），不會核可你沒看過的內容。
 * 被擋下的項目（blocked）不在 plan.items 裡，不能核可。
 * @param {undefined|string|{ item: string, hash?: string }|Array<string|{ item: string, hash?: string }>} items
 */
export async function approveEnv(ctx, items, { now = Date.now() } = {}) {
  const want = items === undefined || items === null ? null : (Array.isArray(items) ? items : [items]).map((w) => (typeof w === 'string' ? { item: w } : w));
  if (want?.some((w) => !isObj(w) || typeof w.item !== 'string' || !w.item.trim())) throw new EngramError(E.INVALID, '要核可的項目寫法不對').withEn('Invalid item to approve');
  return ctx.locked('env.approve', async () => {
    const { plan } = await computePlan(ctx, now);
    const waiting = plan.items.filter((i) => i.approved === false);
    const known = plan.items.filter((i) => i.approved !== undefined);
    const picks = [];
    if (!want) picks.push(...waiting);
    else {
      for (const w of want) {
        const same = (i) => w.item === i.key || w.item === `${i.area}:${i.key}`;
        const hit = waiting.filter(same);
        if (!hit.length && !known.some(same)) throw new EngramError(E.NOT_FOUND, `沒有等待核可的項目：${clip(w.item)}`, '用 engram env plan 看有哪些項目等待核可').withEn(`No item is waiting for approval: ${clip(w.item)}`, 'Run engram env plan to see which items are waiting');
        for (const i of hit) {
          if (w.hash !== undefined && w.hash !== i.hash) throw new EngramError(E.CONFLICT, `${clip(i.key)} 的內容在你看過之後又變了，沒有核可`, '重新執行 engram env plan 看新的內容').withEn(`The content of ${clip(i.key)} changed after you looked at it, so it was not approved`, 'Run engram env plan to see the new content');
          if (!picks.includes(i)) picks.push(i);
        }
      }
    }
    const add = { env: {}, settings: {}, skills: {} };
    for (const i of picks) add[{ env: 'env', setting: 'settings', skill: 'skills' }[i.area]][i.key] = i.hash;
    if (picks.length) await recordApprovals(ctx, add);
    // 回報核可了什麼：完整的值（說明裡本來就是完整的），不帶「等待核可」的標記
    return { ok: true, count: picks.length, approved: picks.map((i) => { const [zh, en] = describe(i); return { area: i.area, key: i.key, hash: i.hash, summary: zh, en: { summary: en } }; }) };
  });
}

/** engram env disable-plugin／enable-plugin：改 enabledPlugins（先備份、可還原） */
export async function setPluginEnabled(ctx, name, enabled, { now = Date.now() } = {}) {
  if (typeof enabled !== 'boolean') throw new EngramError(E.INVALID, 'enabled 必須是 true 或 false').withEn('enabled must be true or false');
  if (typeof name !== 'string' || !name.trim()) throw new EngramError(E.INVALID, '要指定外掛名稱').withEn('A plugin name is required');
  return ctx.locked('env.plugin', async () => {
    const doc = await readSettingsDoc(ctx.homes);
    if (doc.invalid) throw formatError('invalid');
    if (!doc.canonical) throw formatError('custom');
    const ep = doc.data.enabledPlugins;
    if (ep !== undefined && !isObj(ep)) throw new EngramError(E.INVALID, 'settings.json 的 enabledPlugins 不是物件，Engram 不會修改它').withEn('enabledPlugins in settings.json is not an object, so Engram will not modify it');
    const installed = await readPlugins(ctx.homes);
    const want = name.trim();
    const known = uniq([...installed.map((p) => p.key), ...Object.keys(ep ?? {})]);
    const matches = want.includes('@') ? known.filter((k) => k === want) : known.filter((k) => k.slice(0, k.lastIndexOf('@')) === want);
    if (!matches.length) throw new EngramError(E.NOT_FOUND, `找不到外掛：${clip(want)}`, '用 engram env plan 看已安裝的外掛名稱').withEn(`Plugin not found: ${clip(want)}`, 'Run engram env plan to see the installed plugin names');
    if (matches.length > 1) throw new EngramError(E.INVALID, `有 ${matches.length} 個同名的外掛，請寫完整名稱：${matches.join('、')}`).withEn(`${matches.length} plugins share this name; write the full name: ${matches.join(', ')}`);
    const [key] = matches;
    if ((ep?.[key] !== false) === enabled) return { ok: true, changed: false, key, enabled };
    const rec = await writeApply(ctx, { kind: 'plugin', doc, json: [{ path: ['enabledPlugins', key], value: enabled }], skills: [], now });
    return { ok: true, changed: true, key, enabled, id: rec.id, backup: rec.backup };
  });
}

// ───────── undo 與解除安裝 ─────────

/**
 * 還原一批目標。items.json：{ key, path, had, before, mapHad, expect }；items.files：{ key, skill, rel, had, backup, expect }；items.dirs：技能名稱。
 * 只還原「現在的值還是 Engram 套用的值」的目標，之後被改過的保留（回報在 kept）。
 * exact：{ hashAfter, backupDir, existed } 檔案自套用後完全沒變時，直接寫回備份的原樣（連非標準的排版都逐位元一致）。
 * rewriteNonCanonical（解除安裝用）：settings.json 排版不是標準格式時，先把整個檔備份成 settings.json.engram-backup-<時間>（放在 ~/.claude 旁邊，
 * 不會被 --purge 一起刪掉），再用 JSON 重寫整個檔來移除 Engram 套用的值；沒有開的話（單次 undo）就拒絕、維持原狀。
 * 中途出錯不會丟掉已經做完的進度：回傳 restored、kept 與 error，呼叫端把做完的目標從套用紀錄拿掉、沒做完的留著。
 */
async function restoreTargets(ctx, man, items, exact, opts = {}) {
  const acc = { restored: [], kept: [], formatBlocked: null, settingsBackup: null };
  try { await restoreInto(acc, ctx, man, items, exact, opts); } catch (error) { acc.error = error; }
  return acc;
}

async function restoreInto(acc, ctx, man, items, exact, { stopOnFormat = false, rewriteNonCanonical = false }) {
  const { restored, kept } = acc;
  if (items.json.length) {
    const doc = await readSettingsDoc(ctx.homes);
    const backupText = exact ? await readText(path.join(exact.backupDir, 'settings.json')).catch(() => null) : null;
    if (doc.invalid) { acc.formatBlocked = 'invalid'; for (const it of items.json) kept.push({ key: it.key, reason: 'invalid' }); } else if (exact && doc.text !== null && sha1(doc.text) === exact.hashAfter && (exact.existed ? backupText !== null : true)) {
      if (exact.existed) await writeSettingsText(ctx.homes, backupText, doc.text); else await removeSettingsFile(ctx.homes);
      for (const it of items.json) restored.push(it.key);
    } else if (!doc.canonical && !rewriteNonCanonical) {
      acc.formatBlocked = 'custom';
      for (const it of items.json) kept.push({ key: it.key, reason: 'format' });
    } else {
      const data = structuredClone(doc.data);
      let dirty = false;
      for (const it of items.json) {
        const cur = getAt(data, it.path);
        if (it.expectAbsent) {
          // 當初是「刪掉」這個鍵（環境設定檔移除後還原成原本沒有）：現在還是沒有才還原；已經是原本的樣子就不用動
          if (cur.has) { kept.push({ key: it.key, reason: 'changed' }); continue; }
          if (it.had) { restoreAt(data, it.path, true, it.before, it.mapHad); dirty = true; }
          restored.push(it.key);
          continue;
        }
        if (!cur.has || canonicalJson(cur.value) !== canonicalJson(it.expect)) { kept.push({ key: it.key, reason: 'changed' }); continue; }
        restoreAt(data, it.path, it.had, it.before, it.mapHad);
        dirty = true;
        restored.push(it.key);
      }
      if (dirty) {
        const orig = man.original;
        // 排版不是標準格式：整個檔會被重寫，先備份（放在 ~/.claude 旁邊，--purge 刪 ~/.engram 時不受影響）
        if (!doc.canonical && doc.text !== null) {
          acc.settingsBackup = path.join(ctx.homes.claudeHome, `settings.json.engram-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
          await fsp.writeFile(acc.settingsBackup, doc.text, 'utf8');
        }
        if (orig?.missing && canonicalJson(data) === canonicalJson({})) await removeSettingsFile(ctx.homes);
        else {
          let out = renderSettingsDoc(doc, data);
          if (typeof orig?.text === 'string') {
            try { if (canonicalJson(JSON.parse(orig.text.replace(/^﻿/, ''))) === canonicalJson(data)) out = orig.text; } catch { /* 原檔不是 JSON 不會走到這裡 */ }
          }
          await writeSettingsText(ctx.homes, out, doc.text);
        }
      }
    }
  }
  if (acc.formatBlocked && stopOnFormat) return; // 單次 undo：settings.json 動不了就整個不做，紀錄留著
  const f = paths(ctx);
  const skillsLinked = !!(await fsp.lstat(f.skillsHome).catch(() => null))?.isSymbolicLink(); // ~/.claude/skills 本身是連結：不穿越
  for (const it of items.files) {
    const root = path.join(f.skillsHome, it.skill);
    const dst = path.join(root, ...it.rel.split('/'));
    if (skillsLinked || await pathHasLink(root, it.rel)) { kept.push({ key: it.key, reason: 'link' }); continue; }
    const cur = await fsp.readFile(dst).catch(() => null);
    if (!cur || normSha(cur) !== it.expect) { kept.push({ key: it.key, reason: 'changed' }); continue; }
    if (it.had) {
      if (!it.backup || !(await fsp.lstat(it.backup).catch(() => null))) { kept.push({ key: it.key, reason: 'backup-missing' }); continue; }
      await fsp.copyFile(it.backup, dst);
    } else {
      await fsp.rm(dst, { force: true });
      for (let d = path.dirname(dst); d !== root && d.startsWith(root); d = path.dirname(d)) { // 空掉的子資料夾一起收掉
        if ((await fsp.readdir(d).catch(() => ['x'])).length) break;
        await fsp.rmdir(d).catch(() => {});
      }
    }
    restored.push(it.key);
  }
  for (const name of items.dirs) {
    const root = path.join(f.skillsHome, name);
    if (!(await fsp.lstat(root).catch(() => null))?.isDirectory() || isLink(root)) continue;
    if (!(await fsp.readdir(root)).length) await fsp.rmdir(root).catch(() => {}); // 這個資料夾是 Engram 建的，裡面沒有別的東西才移除
  }
}

const jsonKey = (p) => (p.length === 1 ? `setting:${p[0]}` : p[0] === 'env' ? `env:${p[1]}` : p[0] === 'enabledPlugins' ? `plugin:${p[1]}` : p.join('.'));
const targetKey = (t) => (t.t === 'json' ? jsonKey(t.path) : t.t === 'file' ? `skill:${t.skill}/${t.rel}` : `dir:${t.skill}`);

/**
 * 把「真的還原了」或「確定已被使用者改掉」（kept 的原因是 changed）的目標從套用紀錄拿掉；
 * 還沒還原的（排版不標準、連結、找不到備份、中途出錯…）留著，之後還能再試。only：只處理這一筆紀錄（單次 undo）。
 * 技能資料夾（dir）的紀錄在那個技能已經沒有檔案目標時才拿掉；沒有目標的紀錄整筆移除。
 */
function pruneApplies(applies, r, only) {
  const done = new Set([...r.restored, ...r.kept.filter((k) => k.reason === 'changed').map((k) => k.key)]);
  for (const rec of only ? [only] : applies) rec.targets = rec.targets.filter((t) => t.t === 'dir' || !done.has(targetKey(t)));
  const live = new Set(applies.flatMap((rec) => rec.targets.filter((t) => t.t === 'file').map((t) => t.skill)));
  for (const rec of applies) rec.targets = rec.targets.filter((t) => t.t !== 'dir' || live.has(t.skill));
  return applies.filter((rec) => rec.targets.length);
}

const errorInfo = (err) => ({ code: err?.code ?? 'E_UNKNOWN', message: String(err?.message ?? err).slice(0, 300), ...(err?.en ? { en: err.en } : {}) });

/** engram env undo：還原最近一次套用（或外掛開關）。之後被改過的值不動；沒能還原的目標留在紀錄裡 */
export async function undoEnv(ctx) {
  return ctx.locked('env.undo', () => withInstallManifest(ctx.homes, async (man, save) => {
    const applies = man.envSync?.applies ?? [];
    const rec = applies.at(-1);
    if (!rec) throw new EngramError(E.NOT_FOUND, '沒有可以還原的環境設定套用').withEn('There is no environment change to undo');
    const items = { json: [], files: [], dirs: [] };
    for (const t of rec.targets) {
      if (t.t === 'json') items.json.push({ key: jsonKey(t.path), path: t.path, had: t.had, before: t.before, mapHad: t.mapHad, expect: t.after, expectAbsent: !!t.del });
      else if (t.t === 'file') items.files.push({ key: `skill:${t.skill}/${t.rel}`, skill: t.skill, rel: t.rel, had: t.had, backup: t.backup, expect: t.sha });
      else if (t.t === 'dir') items.dirs.push(t.skill);
    }
    const r = await restoreTargets(ctx, man, items, rec.settings ? { hashAfter: rec.settings.hashAfter, existed: rec.settings.existed, backupDir: rec.backup } : null, { stopOnFormat: true });
    if (r.formatBlocked && !r.error) throw formatError(r.formatBlocked);
    man.envSync.applies = pruneApplies(applies, r, rec);
    await save();
    if (r.error) throw r.error; // 做完的進度已經從紀錄拿掉，沒做完的留著
    return { ok: true, id: rec.id, kind: rec.kind, restored: r.restored.length, kept: r.kept };
  }));
}

/**
 * 套用紀錄（由舊到新）→ 每個目標「第一次被動之前」的樣子與「最後一次被設成」的值。
 * 解除安裝依它還原；plan 也用它找出「環境設定檔後來移除了、但這台還留著」的鍵。
 * 回傳 restoreTargets 的 items 格式。
 */
function deriveLedger(applies) {
  const json = new Map();
  const files = new Map();
  const dirs = new Set();
  const mapOrigin = new Map();
  for (const rec of applies) {
    for (const t of rec.targets) {
      if (t.t === 'json') {
        if (t.path.length === 2 && !mapOrigin.has(t.path[0])) mapOrigin.set(t.path[0], t.mapHad);
        const k = t.path.join('\0');
        const e = json.get(k);
        const last = { expect: t.after, expectAbsent: !!t.del };
        json.set(k, e ? { ...e, ...last } : { key: jsonKey(t.path), path: t.path, had: t.had, before: t.before, ...last });
      } else if (t.t === 'file') {
        const k = `${t.skill}\0${t.rel}`;
        const e = files.get(k);
        files.set(k, e ? { ...e, expect: t.sha } : { key: `skill:${t.skill}/${t.rel}`, skill: t.skill, rel: t.rel, had: t.had, backup: t.backup, expect: t.sha });
      } else if (t.t === 'dir') dirs.add(t.skill);
    }
  }
  return { json: [...json.values()].map((e) => ({ ...e, mapHad: e.path.length === 2 ? mapOrigin.get(e.path[0]) : undefined })), files: [...files.values()], dirs: [...dirs] };
}

/**
 * 解除安裝：還原所有套用，回到 Engram 第一次動它之前的樣子。每個目標用「第一次動它之前」的值、
 * 只在現在的值還是最後一次 Engram 設的值時才還原（使用者後來改的不動）。要在 revokeAll 之前執行。
 * 只把真的還原（或確定已被使用者改掉）的目標從紀錄拿掉，其餘留著；沒還原的項目與原因（kept）、中途的錯誤（error）、
 * 排版不標準時重寫前的備份位置（settingsBackup）都回傳，呼叫端要讓使用者看到。
 * @returns {Promise<{ restored: number, kept: { key: string, reason: string }[], error?: object, settingsBackup?: string }>}
 */
export async function undoAllEnv(ctx) {
  return ctx.locked('env.uninstall', () => withInstallManifest(ctx.homes, async (man, save) => {
    const applies = man.envSync?.applies ?? [];
    if (!applies.length) return { restored: 0, kept: [] };
    const r = await restoreTargets(ctx, man, deriveLedger(applies), null, { rewriteNonCanonical: true });
    man.envSync.applies = pruneApplies(applies, r);
    await save();
    return { restored: r.restored.length, kept: r.kept, ...(r.settingsBackup ? { settingsBackup: r.settingsBackup } : {}), ...(r.error ? { error: errorInfo(r.error) } : {}) };
  }));
}

// ───────── profile 與 export ─────────

async function readEnvProfile(ctx) {
  const st = await loadState(ctx);
  return {
    present: st.info.present,
    problem: st.info.problem ?? null,
    profile: st.profile,
    overrides: { present: st.oinfo.present, problem: st.oinfo.problem ?? null, ...st.overrides },
    blocked: st.blocked,
    whitelist: [...SETTINGS_WHITELIST],
  };
}

/** 讀現有的 profile 準備改寫：損毀的不能悄悄蓋掉 */
async function profileForWrite(ctx) {
  const st = await loadState(ctx);
  if (st.info.problem) throw new EngramError(E.INVALID, 'vault/env/profile.json 損毀（不是有效的 JSON 物件），Engram 不會蓋掉它', '請先修正或刪除這個檔案').withEn('vault/env/profile.json is corrupted (not a valid JSON object), so Engram will not overwrite it', 'Fix or delete the file first');
  return st;
}

/**
 * 寫 profile 並 commit（連同 extra 路徑）。整份序列化後再掃一次疑似金鑰，有就不寫。
 * beforeCommit：所有檢查都通過、寫入之後、commit 之前呼叫（處理衝突紀錄時在這裡才移除紀錄：檢查沒過時紀錄留著）
 */
async function saveProfile(ctx, profile, st, { now, extra = [], force = false, action = 'env', beforeCommit = null }) {
  const norm = (p) => ({
    v: 1,
    env: sortObj(p.env),
    settings: sortObj(p.settings),
    skills: uniq(p.skills).sort(cmpStr),
    plugins: [...p.plugins].sort((a, b) => cmpStr(`${a.name}@${a.marketplace}`, `${b.name}@${b.marketplace}`)),
  });
  const out = { ...norm(profile), updatedAt: iso(now), by: ctx.mid };
  const f = paths(ctx);
  // updatedAt 與 by 不算內容；force：要移除的項目可能是驗證沒過、本來就不在 st.profile 裡的（照樣要從檔案清掉）
  const changed = force || !st.info.present || JSON.stringify(norm(profile)) !== JSON.stringify(norm(st.profile));
  const kinds = secretKinds([stableJson(out)], st.allow);
  if (kinds.length) throw toError(bad('secret-value', `設定檔內容疑似含有金鑰（${kinds.join('、')}），不會寫進記憶庫`, `The profile content looks like it contains a secret (${kinds.join(', ')}), so it will not be written to the vault`, { kinds }));
  if (changed) await writeJson(f.profile, out);
  if (beforeCommit) await beforeCommit();
  const commit = await commitPaths(ctx.vault, [...(changed ? ['env/profile.json'] : []), ...extra], 'env profile', { action, mid: ctx.mid });
  return { changed, commit: commit ?? undefined };
}

/**
 * 記憶畢業（2.0.0 WP9）：在 profile 加一項環境變數（area: 'env'）或白名單的設定（area: 'setting'）。
 * 和 env set 走同一組檢查（名稱、拒絕清單、白名單、型別、家目錄、疑似金鑰），但**不核可**：每台電腦（包括這台）的 plan
 * 都會顯示「等待這台核可」，核可之前不會套用。已經有同一個鍵：值相同就不動，不同就拒絕（不蓋掉別人設的值）。
 */
export async function addProfileEntry(ctx, { area, key, value }, { now = Date.now() } = {}) {
  const setting = area === 'setting';
  const c = (setting ? checkSettingEntry : checkEnvEntry)(key, value, { allow: await loadAllow(ctx.local), homeMask: masker(ctx.homes) });
  if (!c.ok) throw toError(c);
  return ctx.locked('env.add', async () => {
    const st = await profileForWrite(ctx);
    const map = setting ? st.profile.settings : st.profile.env;
    if (Object.hasOwn(map, key)) {
      if (canonicalJson(map[key]) === canonicalJson(value)) return { ok: true, key, changed: false };
      throw new EngramError(E.CONFLICT, `環境設定檔已經有 ${clip(key)}（值不同），沒有寫入`, '看過之後自己決定要用哪個值').withEn(`The environment profile already has ${clip(key)} with a different value, so nothing was written`, 'Look at both and decide which value to keep');
    }
    const next = setting ? { ...st.profile, settings: { ...st.profile.settings, [key]: value } } : { ...st.profile, env: { ...st.profile.env, [key]: value } };
    // action edit：可以用 engram undo 復原（env set 的 commit 是 env，不能單獨復原）
    const r = await saveProfile(ctx, next, st, { now, action: 'edit' });
    return { ok: true, key, ...r };
  });
}

/** 記憶畢業的復原：profile 裡這個鍵的值還是當初加的那個時才拿掉（之後被改過就不動） */
export async function removeProfileEntry(ctx, { area, key, value }, { now = Date.now() } = {}) {
  const setting = area === 'setting';
  return ctx.locked('env.remove', async () => {
    const st = await profileForWrite(ctx);
    const map = setting ? st.profile.settings : st.profile.env;
    if (!Object.hasOwn(map, key) || canonicalJson(map[key]) !== canonicalJson(value)) return { ok: true, key, changed: false };
    const rest = { ...map };
    delete rest[key];
    const r = await saveProfile(ctx, setting ? { ...st.profile, settings: rest } : { ...st.profile, env: rest }, st, { now, action: 'edit' });
    return { ok: true, key, ...r };
  });
}

/**
 * 處理同步衝突紀錄（第三輪審查 R4）：把 profile 裡幾個鍵改成指定的值（value 是 undefined 表示拿掉）。entries：[{ area: 'env'|'setting', key, value }]。
 * 和 env set 走同一組檢查；不核可（核可記的是鍵＋值的雜湊：這台沒核可過這個值就是未核可，核可之前不會套用）。
 * extra：要放進同一個 commit 的路徑（衝突紀錄的資料夾），engram undo 一次還原兩者。commit 的動作是 edit（可以復原）。
 * beforeCommit：所有檢查都通過之後、commit 之前呼叫（呼叫端在這裡移除衝突紀錄）。
 */
export async function writeProfileValues(ctx, entries, { now = Date.now(), extra = [], beforeCommit = null } = {}) {
  const allow = await loadAllow(ctx.local);
  const homeMask = masker(ctx.homes);
  for (const e of entries) {
    if (e.value === undefined) continue;
    const c = (e.area === 'setting' ? checkSettingEntry : checkEnvEntry)(e.key, e.value, { allow, homeMask });
    if (!c.ok) throw toError(c);
  }
  return ctx.locked('env.resolve', async () => {
    const st = await profileForWrite(ctx);
    const env = { ...st.profile.env };
    const settings = { ...st.profile.settings };
    for (const e of entries) {
      const map = e.area === 'setting' ? settings : env;
      if (e.value === undefined) delete map[e.key]; else map[e.key] = e.value;
    }
    return saveProfile(ctx, { ...st.profile, env, settings }, st, { now, extra, action: 'edit', beforeCommit });
  });
}

/**
 * engram env set <鍵>=<值>：把環境變數寫進 profile.env。
 * approve（預設 true）：這台自己寫出的視為已核可。在 Claude Code 裡執行（CLI 偵測到 CLAUDECODE）時要帶 false，
 * 否則 Claude 可以自己寫、自己套用；寫出的內容要使用者在自己的終端機或管理介面核可。
 */
export async function setEnvVar(ctx, key, value, { now = Date.now(), approve = true } = {}) {
  const mask = masker(ctx.homes);
  const c = checkEnvEntry(key, value, { allow: await loadAllow(ctx.local), homeMask: mask });
  if (!c.ok) throw toError(c);
  return ctx.locked('env.set', async () => {
    const st = await profileForWrite(ctx);
    const r = await saveProfile(ctx, { ...st.profile, env: { ...st.profile.env, [key]: value } }, st, { now });
    // 這台自己寫出的這一項視為已核可（只這一個鍵與值：profile 裡別台寫的項目不會因為這次改寫就被核可）
    if (approve) await recordApprovals(ctx, { env: { [key]: hashEnv(key, value) } });
    return { ok: true, key, approved: !!approve, ...r };
  });
}

const notFound = (zh, en, hint = '', hintEn = '') => new EngramError(E.NOT_FOUND, zh, hint).withEn(en, hintEn);

/** profile.json 原始檔的內容（沒有或損毀時回傳空物件）：要移除的項目可能是驗證沒過、不在 st.profile 裡的 */
async function rawProfile(ctx) {
  const d = await readDoc(paths(ctx).profile);
  return d.present && !d.invalid ? d.value : {};
}

/**
 * engram env unset <鍵>：從 profile.env 移除一個環境變數。寫成 setting:<鍵> 則移除 profile.settings 的那一個設定。
 * 已經套用到某台電腦的值不會馬上動：下一次 plan 會把它列為「這台多出來」，apply 時還原成套用之前的樣子。
 */
export async function unsetEnvVar(ctx, name, { now = Date.now() } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new EngramError(E.INVALID, '要指定環境變數的名稱').withEn('The name of an environment variable is required');
  const setting = name.startsWith('setting:');
  const key = setting ? name.slice('setting:'.length) : name;
  return ctx.locked('env.unset', async () => {
    const st = await profileForWrite(ctx);
    const raw = await rawProfile(ctx);
    const area = setting ? 'settings' : 'env';
    if (!isObj(raw[area]) || !Object.hasOwn(raw[area], key)) {
      throw notFound(`環境設定檔裡沒有${setting ? '設定' : '環境變數'} ${clip(key)}`, `The environment profile has no ${setting ? 'setting' : 'environment variable'} named ${clip(key)}`, '用 engram env plan 看環境設定檔的內容', 'Run engram env plan to see what the profile contains');
    }
    const next = { ...st.profile, [area]: { ...st.profile[area] } };
    delete next[area][key];
    const r = await saveProfile(ctx, next, st, { now, force: true });
    return { ok: true, key, area: setting ? 'setting' : 'env', ...r };
  });
}

/** engram env remove-skill <名稱>：從 profile.skills 移除，並刪掉 vault/env/skills/<名稱>/。不動任何一台電腦上已經安裝的技能 */
export async function removeProfileSkill(ctx, name, { now = Date.now() } = {}) {
  const c = checkSkillName(name);
  if (!c.ok) throw toError(c);
  return ctx.locked('env.remove-skill', async () => {
    const st = await profileForWrite(ctx);
    const raw = await rawProfile(ctx);
    const dir = path.join(paths(ctx).skills, name);
    const hasDir = !!(await fsp.lstat(dir).catch(() => null));
    if (!(Array.isArray(raw.skills) && raw.skills.includes(name)) && !hasDir) throw notFound(`環境設定檔裡沒有技能 ${name}`, `The environment profile has no skill named ${name}`);
    if (hasDir) { if (isLink(dir)) removeJunction(dir); else await fsp.rm(dir, { recursive: true, force: true }); }
    const r = await saveProfile(ctx, { ...st.profile, skills: st.profile.skills.filter((n) => n !== name) }, st, { now, force: true, extra: [`env/skills/${name}`] });
    return { ok: true, name, removedFiles: hasDir, ...r };
  });
}

/** engram env remove-plugin <名稱>：從 profile.plugins（應該安裝的清單）移除。名稱可以只寫外掛名，同名但不同市集時要寫完整的 名稱@市集 */
export async function removeProfilePlugin(ctx, name, { now = Date.now() } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new EngramError(E.INVALID, '要指定外掛名稱').withEn('A plugin name is required');
  const want = name.trim();
  return ctx.locked('env.remove-plugin', async () => {
    const st = await profileForWrite(ctx);
    const keyOf = (p) => `${p.name}@${p.marketplace}`;
    const matches = st.profile.plugins.filter((p) => (want.includes('@') ? keyOf(p) === want : p.name === want));
    if (!matches.length) throw notFound(`環境設定檔的外掛清單裡沒有 ${clip(want)}`, `The plugin list of the environment profile has no ${clip(want)}`);
    if (matches.length > 1) throw new EngramError(E.INVALID, `有 ${matches.length} 個同名的外掛，請寫完整名稱：${matches.map(keyOf).join('、')}`).withEn(`${matches.length} plugins share this name; write the full name: ${matches.map(keyOf).join(', ')}`);
    const [hit] = matches;
    const r = await saveProfile(ctx, { ...st.profile, plugins: st.profile.plugins.filter((p) => p !== hit) }, st, { now, force: true });
    return { ok: true, key: keyOf(hit), ...r };
  });
}

/** 單機覆寫的 skip 項目：裸名稱，或 env:／setting:／skill:／plugin: 加名稱（外掛可以是 名稱@市集） */
const SKIP_ITEM = /^(?:(?:env|setting|skill|plugin):)?[A-Za-z0-9_][A-Za-z0-9._@-]{0,127}$/;

/** engram env skip／unskip <項目>：改這台電腦的 machines/<mid>/env-overrides.json 的 skip（其他欄位原樣保留）。已經是那個狀態就不動 */
export async function setEnvSkip(ctx, itemName, skip) {
  if (typeof itemName !== 'string' || !SKIP_ITEM.test(itemName)) {
    throw new EngramError(E.INVALID, `項目的寫法不對：${clip(itemName)}`, '寫成名稱（例如 model、MY_FLAG），或加上 env:、setting:、skill:、plugin: 前綴').withEn(`Invalid item: ${clip(itemName)}`, 'Write a name (for example model or MY_FLAG), or add the env:, setting:, skill: or plugin: prefix');
  }
  return ctx.locked('env.skip', async () => {
    const f = paths(ctx);
    const d = await readDoc(f.overrides);
    if (d.invalid) throw new EngramError(E.INVALID, `${path.basename(f.overrides)} 損毀（不是有效的 JSON 物件），Engram 不會蓋掉它`, '請先修正或刪除這個檔案').withEn(`${path.basename(f.overrides)} is corrupted (not a valid JSON object), so Engram will not overwrite it`, 'Fix or delete the file first');
    const { skip: rawSkip, env, settings, ...rest } = d.present ? d.value : {};
    const list = Array.isArray(rawSkip) ? rawSkip.filter((s) => typeof s === 'string') : [];
    if (list.includes(itemName) === skip) return { ok: true, changed: false, item: itemName, skip };
    const out = { skip: skip ? [...list, itemName] : list.filter((s) => s !== itemName), env: env ?? {}, settings: settings ?? {}, ...rest };
    const kinds = secretKinds([stableJson(out)], await loadAllow(ctx.local));
    if (kinds.length) throw toError(bad('secret-value', `${path.basename(f.overrides)} 的內容疑似含有金鑰（${kinds.join('、')}），不會提交；請先處理它`, `The content of ${path.basename(f.overrides)} looks like it contains a secret (${kinds.join(', ')}), so it will not be committed; deal with it first`, { kinds }));
    await writeJson(f.overrides, out);
    const commit = await commitPaths(ctx.vault, [`machines/${ctx.mid}/env-overrides.json`], 'env overrides', { action: 'env', mid: ctx.mid });
    return { ok: true, changed: true, item: itemName, skip, commit: commit ?? undefined };
  });
}

/**
 * engram env export：把這台白名單內的設定、啟用中的外掛清單與指定的技能寫進 profile。
 * 只加入與更新，不刪除（profile 裡已有、這台沒有的照舊保留；要移除用 unset、remove-skill、remove-plugin）；
 * settings.json 的 env 區塊不會被匯出（環境變數只能用 env set 寫入）。
 * 技能：只處理 skills 指定的（--skill），不會動 profile 裡其他技能；內容疑似含金鑰的整個技能不同步並回報。
 * 記憶庫裡該技能的版本如果不是這台上次匯出或核可的那一版（別台改過），不覆蓋、列在 skills.conflicts；force 才覆蓋。
 * 這台自己匯出的設定與技能視為已核可（local/env/approved.json）；approve: false（在 Claude Code 裡執行時 CLI 會帶）則不核可，要使用者在自己的終端機或管理介面核可。
 * 匯出的技能版本不論有沒有核可都記成「這台上次匯出的」，下次匯出才不會把自己的版本當成別台改過的。
 */
export async function exportEnv(ctx, { skills = [], force = false, approve = true, now = Date.now() } = {}) {
  const names = uniq((Array.isArray(skills) ? skills : [skills]).map(String));
  for (const n of names) { const c = checkSkillName(n); if (!c.ok) throw toError(c); }
  return ctx.locked('env.export', async () => {
    const st = await profileForWrite(ctx);
    const f = paths(ctx);
    const mask = masker(ctx.homes);
    const doc = await readSettingsDoc(ctx.homes);
    const blocked = [];
    const settingsOut = {};
    if (!doc.invalid) {
      for (const k of SETTINGS_WHITELIST) {
        if (!Object.hasOwn(doc.data, k)) continue;
        const c = checkSettingEntry(k, doc.data[k], { allow: st.allow, homeMask: mask });
        if (c.ok) settingsOut[k] = doc.data[k]; else blocked.push(blockedEntry('setting', k, c));
      }
    }
    const enabled = isObj(doc.data?.enabledPlugins) ? doc.data.enabledPlugins : {};
    const pluginsOut = (await readPlugins(ctx.homes)).filter((p) => p.marketplace && PLUGIN_PART.test(p.name) && PLUGIN_PART.test(p.marketplace) && enabled[p.key] !== false).map((p) => ({ name: p.name, marketplace: p.marketplace }));

    // 技能：只處理指定的（--skill）。記憶庫裡的版本如果不是這台上次匯出或核可的那一版（代表別台改過），不覆蓋、回報衝突；--force 才覆蓋
    const approvals = await readApprovals(ctx);
    const skillsLinked = !!(await fsp.lstat(f.skillsHome).catch(() => null))?.isSymbolicLink();
    const synced = [];
    const skillBlocked = [];
    const conflicts = [];
    const extra = [];
    const skillApprovals = {};
    for (const name of [...names].sort(cmpStr)) {
      const col = skillsLinked ? { exists: true, skillsLink: true } : await collectSkill(path.join(f.skillsHome, name));
      const fail = (reason, files) => skillBlocked.push({ name, reason, ...(files ? { files } : {}) });
      if (!col.exists) { fail('missing'); continue; }
      if (col.skillsLink) { fail('skills-link'); continue; }
      if (col.link) { fail('link'); continue; }
      if (col.notDir) { fail('not-dir'); continue; }
      if (col.tooMany) { fail('too-large'); continue; }
      const loaded = await loadSkill(col.files);
      const bads = await scanSkill(name, loaded, st.allow);
      if (bads.length) { fail(bads.every((b) => b.kinds.includes('conflict-marker')) ? 'conflict-marker' : 'secret', bads); continue; }
      const digest = skillDigest(loaded);
      const destDir = path.join(f.skills, name);
      const have = await collectSkill(destDir);
      if (have.link || have.notDir) { fail('vault-link'); continue; }
      if (have.exists && have.files.length) {
        const vaultDigest = skillDigest(await loadSkill(have.files));
        if (vaultDigest !== digest && vaultDigest !== approvals.skills[name] && vaultDigest !== approvals.exported.skills[name] && !force) {
          conflicts.push({ name, reason: 'changed-elsewhere' }); // 記憶庫的版本是別台改過的（不是這台上次匯出或核可的）
          continue;
        }
      }
      await mirrorSkill(loaded, destDir);
      extra.push(`env/skills/${name}`);
      skillApprovals[name] = digest; // 這台自己匯出的內容視為已核可
      synced.push({ name, files: loaded.length, skippedLarge: col.skippedLarge, skippedLinks: col.skippedLinks });
    }

    const byKey = new Map([...st.profile.plugins, ...pluginsOut].map((p) => [`${p.name}@${p.marketplace}`, p]));
    const next = {
      ...st.profile,
      settings: { ...st.profile.settings, ...settingsOut },
      plugins: [...byKey.values()],
      skills: uniq([...st.profile.skills, ...synced.map((s) => s.name)]),
    };
    const r = await saveProfile(ctx, next, st, { now, extra });
    // 這台自己匯出的設定與技能視為已核可：只記這次寫出的那幾項（profile 裡別台寫的項目不會因為這次改寫就被核可）
    await recordApprovals(ctx, {
      ...(approve ? { settings: Object.fromEntries(Object.entries(settingsOut).map(([k, v]) => [k, hashSetting(k, v)])), skills: skillApprovals } : {}),
      exportedSkills: skillApprovals,
    });
    return {
      ok: true, approved: !!approve, ...r,
      settings: Object.keys(settingsOut), plugins: pluginsOut.length, blocked,
      ...(doc.invalid ? { settingsProblem: 'invalid' } : {}),
      skills: { synced, blocked: skillBlocked, conflicts },
    };
  });
}

// ───────── 每日的 plan ─────────

/**
 * 每日 env 工作的一步：算出 plan 存成快取（供介面與每週摘要讀）。report（預設）不寫入 ~/.claude；
 * auto 才在沒有對話進行中時自動套用（對話進行中標記 deferred，由呼叫端稍後重試）；off 什麼都不做。
 * @param {{ now?: number, isIdle?: () => Promise<boolean> }} [o]
 */
export async function runEnvSync(ctx, { now = Date.now(), isIdle } = {}) {
  const mode = await envSyncMode(ctx);
  if (mode === 'off') return { ok: true, skipped: 'off', mode };
  const f = paths(ctx);
  const plan = await planEnv(ctx, { now });
  await writeJson(f.planCache, { v: 1, at: iso(now), plan });
  // changes：已核可、現在可以套用的變更；pending：等待這台核可的項目（auto 也不會套用它們）
  const out = { ok: true, mode, changes: plan.changes, pending: plan.pending, applied: false };
  if (mode !== 'auto' || !plan.changes) return out;
  const idle = isIdle ?? (async () => (await import('../agent/jobs.mjs')).claudeIdle(ctx.homes.claudeHome));
  if (!(await idle())) return { ...out, deferred: true };
  try {
    const r = await applyEnv(ctx, { now });
    await writeJson(f.planCache, { v: 1, at: iso(now), plan: await planEnv(ctx, { now }) });
    return { ...out, applied: r.applied > 0, pending: r.pending, result: { id: r.id, applied: r.applied, backup: r.backup } };
  } catch (err) {
    return { ...out, ok: false, failed: errorInfo(err) };
  }
}

export { readEnvProfile };
