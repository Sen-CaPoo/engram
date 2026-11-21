// 自動更新（2.0.0 R2）：發佈的那台電腦在 vault/release.json 告訴另一台該更新到哪個 commit，另一台的常駐程式每天檢查一次。
// release.json 是跟著記憶庫同步的檔案，內容不可信：接收端逐項驗證，任何一項不符就不更新、並留下原因。
// - 發佈端（publishRelease）：engram update 成功之後，來源是 git 複本、HEAD 剛好是版本標籤 v<版本>、而且版本比 release.json 新才寫（只前進、不退版）。
// - 接收端（runAutoUpdate）：設定 autoUpdate 開啟、版本比本機新、來源資料夾是乾淨的 git 複本、遠端網址相符、
//   那個 commit 帶有對應的版本標籤、而且是快轉，才 merge --ff-only 並走既有的更新流程；更新後跑新版的 doctor，失敗就退回。
// 外部動作（git、更新、doctor、通知、重啟常駐程式）全部是可注入的相依，測試用假的。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_ENV, run } from '../src/cli/proc.mjs';
import { E } from '../src/core/errors.mjs';
import { classifyGitError, git as coreGit } from '../src/core/git.mjs';
import { normalizeRemote } from '../src/core/paths.mjs';
import { redactSecrets, scanSecrets } from '../src/core/secrets.mjs';
import { activeVersion, currentDir, listVersions } from './deploy.mjs';

export const RELEASE_FILE = 'release.json';
const SEMVER = /^\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 120_000;
const TAG_REF = 'refs/engram-autoupdate/tag'; // 暫時放發佈標籤的 ref（不碰本機 refs/tags）
const MAX_DEFER_STREAK = 5; // 同一個原因連續延後這麼多次就通知一次，之後每天只試一次
const AGENT_START_TIMEOUT_MS = 60_000; // 重啟之後等新版常駐程式回報心跳的時限
const MERGE_TIMEOUT_MS = 60_000;
const DOCTOR_TIMEOUT_MS = 90_000;
const stateFile = (home) => path.join(home, 'local', 'auto-update.json');
const backupDir = (home) => path.join(home, 'local', 'backup');

// ───────── 共用：版本與 release.json ─────────

/** 'X.Y.Z' 或 'X.Y.Z-commit' → [x, y, z]；看不懂回傳 null */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 比版本大小（只看 X.Y.Z，忽略 -commit 後綴）：-1、0、1；任一邊看不懂回傳 NaN */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** 遠端網址的比較用形式（https 與 ssh 寫法視為同一個、拿掉帳號與權杖、小寫）；也是寫進 release.json 的形式 */
export const normalizeRepo = (url) => normalizeRemote(url);

/**
 * 解析 release.json：每個欄位都驗證，任何一項不合格就當作沒有發佈（回傳 null）。
 * commit 一定是完整的 40 碼十六進位、版本一定是 X.Y.Z：之後會原樣交給 git，不接受別的字元。
 * @returns {{ version: string, commit: string, repo: string, at: string, by: string } | null}
 */
export function parseRelease(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const { version, commit, repo, at, by } = j;
  if (typeof version !== 'string' || !SEMVER.test(version)) return null;
  if (typeof commit !== 'string' || !FULL_SHA.test(commit)) return null;
  if (typeof repo !== 'string' || !repo || repo.length > 300 || /[\s\0]/.test(repo)) return null;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  if (typeof by !== 'string' || by.length > 80) return null;
  return { version, commit, repo, at, by };
}

async function readRelease(vaultDir) {
  try { return parseRelease(await fsp.readFile(path.join(vaultDir, RELEASE_FILE), 'utf8')); } catch { return null; }
}

// ───────── 外部動作（預設實作） ─────────

/**
 * 在指定資料夾執行 git；回傳 { code, stdout, stderr, timedOut }。逾時或找不到 git 時 code 為 -1。
 * 用引擎的 git 包裝（core/git.mjs）：逾時會終止整棵程序樹，Scoop 之類的 shim 不會讓卡住的 fetch 留下來拖住常駐程式。
 */
async function realGit(args, { cwd, timeoutMs = 30_000 } = {}) {
  try {
    return await coreGit(args, { cwd, timeoutMs, allowFail: true });
  } catch (err) {
    return { code: -1, stdout: '', stderr: String(err?.message ?? err), timedOut: false };
  }
}

/** git 輸出的最後一行，放進原因與通知前先拿掉網址裡的帳號與權杖、遮蔽疑似金鑰 */
function safeDetail(text, max = 200) {
  const line = String(text ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  return redactSecrets(line.replace(/\/\/[^/@\s'"]+@/g, '//')).text.slice(0, max);
}

/**
 * fetch 失敗的種類：'offline'（連不上遠端：稍後再試）、'no-tag'（遠端沒有那個標籤）、'rejected'（其他，例如認證被拒）。
 * 連線失敗與逾時沿用引擎對 git 錯誤的分類（core/git.mjs 的 classifyGitError）。
 */
function fetchFailureKind(res) {
  if (res.timedOut || res.code === -1) return 'offline';
  const s = `${res.stderr}\n${res.stdout}`;
  if (/couldn't find remote ref/i.test(s)) return 'no-tag';
  const e = classifyGitError(res, ['fetch']);
  if (e.code === E.OFFLINE || e.code === E.PROXY) return 'offline';
  if (e.code === E.GIT && /Could not read from remote repository|does not appear to be a git repository/i.test(s)) return 'offline'; // 遠端位址讀不到（網路、位址）：和連不上同樣處理
  return 'rejected';
}

async function realUpdate(opts) {
  const { runUpdate } = await import('./install.mjs');
  const lines = [];
  const r = await runUpdate(opts, { print: (s) => lines.push(s), confirm: async () => true });
  return { ...r, lines };
}

// engram doctor 的檢查裡和環境有關、不代表新版壞掉的：遠端連線（網路、沒設遠端的記憶庫）與對話回顧資料夾的權限（常駐程式重新啟動時才會補上）
const ENV_CHECKS = new Set(['remote', 'dream-dir']);

/** 執行目前 current 指向的程式的 doctor --json，只整理結果、不下判斷：{ loaded: 引擎載得起來, checks: [{ id, ok, label }], detail } */
export async function runDoctor({ home }) {
  const bin = path.join(currentDir(home), 'bin', 'engram.mjs');
  let r;
  try { r = await run(process.execPath, [bin, 'doctor', '--json'], { timeoutMs: DOCTOR_TIMEOUT_MS, env: { ...process.env, ...BACKGROUND_ENV } }); } catch (err) { return { loaded: false, checks: [], detail: String(err?.message ?? err) }; }
  if (r.timedOut) return { loaded: false, checks: [], detail: 'doctor 逾時', detailEn: 'doctor timed out' };
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 不是 JSON */ }
  if (!j || typeof j !== 'object') return { loaded: false, checks: [], detail: `doctor 沒有輸出可讀的結果（結束碼 ${r.code}）：${(r.stderr || r.stdout).trim().slice(0, 200)}`, detailEn: `doctor did not print a readable result (exit code ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
  const checks = (Array.isArray(j.checks) ? j.checks : []).map((c) => ({ id: String(c.id ?? c.label ?? ''), ok: c.ok !== false, label: String(c.label ?? c.id ?? '') }));
  const loaded = j.engine?.ok !== false;
  return { loaded, checks, detail: loaded ? '' : `引擎無法載入：${j.engine?.error?.message ?? ''}`, ...(loaded ? {} : { detailEn: `The engine could not load: ${j.engine?.error?.message ?? ''}` }) };
}

/**
 * 更新之後的 doctor 要不要算通過。doctor 的檢查有些和環境有關（遠端連線、沒有遠端的記憶庫、對話回顧資料夾的權限、高等級的健康檢查卡片），
 * 健康的電腦上也可能不通過，不能拿來判斷新版有沒有壞：只看「引擎載得起來」，以及「更新前通過的檢查（排除環境有關的）更新後沒有變成不通過」。
 * 沒有更新前的結果（baseline 是 null）時只看引擎載得起來。
 */
export function doctorVerdict(baseline, after) {
  if (!after?.loaded) return { ok: false, detail: after?.detail || '引擎無法載入', detailEn: after?.detailEn || after?.detail || 'The engine could not load' };
  const was = new Map((baseline?.checks ?? []).map((c) => [c.id, c.ok]));
  const regressed = (after.checks ?? []).filter((c) => !c.ok && was.get(c.id) === true && !ENV_CHECKS.has(c.id)).map((c) => c.label || c.id);
  return regressed.length ? { ok: false, detail: `更新前通過、現在沒通過：${regressed.join('、')}`, detailEn: `Passed before the update but fails now: ${regressed.join(', ')}` } : { ok: true, detail: '' };
}

/**
 * 預設的 doctor 相依。phase 'before'：更新前（舊程式）先跑一次記下基準；phase 'after'：更新後（新部署的程式，不能用目前執行中的舊程式檢查）
 * 再跑一次，和基準比較（doctorVerdict）。
 */
export async function realDoctor({ home, phase = 'after', baseline = null }) {
  const raw = await runDoctor({ home });
  return phase === 'before' ? raw : doctorVerdict(baseline, raw);
}

// ───────── 發佈端 ─────────

/**
 * engram update 成功之後呼叫：來源是 git 複本、乾淨、HEAD 剛好是版本標籤 v<版本>，而且版本比 release.json 新，才寫 release.json。
 * 版本相同（包含接收端自己更新到同一個版本）不重寫，兩台電腦才不會互相改寫 at／by。永遠不丟例外：失敗不影響更新本身。
 * @returns {Promise<{ published: boolean, reason?: string, release?: object }>}
 */
export async function publishRelease({ home, sourceDir, git = realGit, now = Date.now } = {}) {
  const skip = (reason) => ({ published: false, reason });
  try {
    const vaultDir = path.join(home, 'vault');
    if (!fs.existsSync(path.join(vaultDir, '.git'))) return skip('這台電腦沒有記憶庫');
    const version = JSON.parse(await fsp.readFile(path.join(sourceDir, 'package.json'), 'utf8')).version;
    if (!SEMVER.test(String(version))) return skip(`版本號格式不對：${version}`);
    const g = async (args) => git(args, { cwd: sourceDir });
    const top = await g(['rev-parse', '--show-toplevel']);
    if (top.code !== 0) return skip('來源不是 git 複本');
    if ((await g(['status', '--porcelain', '--', '.'])).stdout.trim()) return skip('來源有未提交的變更');
    const head = (await g(['rev-parse', 'HEAD'])).stdout.trim();
    const tag = (await g(['rev-parse', '--verify', '-q', `refs/tags/v${version}^{commit}`])).stdout.trim();
    if (!FULL_SHA.test(head) || tag !== head) return skip(`HEAD 不是版本標籤 v${version}`);
    const remote = normalizeRepo((await g(['remote', 'get-url', 'origin'])).stdout.trim());
    if (!remote) return skip('來源沒有 origin 遠端');
    const existing = await readRelease(vaultDir);
    if (existing && !(compareVersions(version, existing.version) > 0)) return skip(`release.json 已經是 ${existing.version}，不重複發佈、也不退版`);
    let by = 'unknown';
    try { by = JSON.parse(await fsp.readFile(path.join(home, 'local', 'machine.json'), 'utf8')).mid ?? by; } catch { /* 沒有就用 unknown */ }
    const release = { version, commit: head, repo: remote, at: new Date(now()).toISOString(), by };
    const text = `${JSON.stringify(release, null, 2)}\n`;
    // 寫進記憶庫的內容一律先過疑似金鑰偵測（遠端網址可能夾帶權杖；normalizeRepo 已經拿掉帳號，這裡再擋一次）
    if (scanSecrets(text).length) return skip('內容疑似含有金鑰，沒有寫進記憶庫');
    const dest = path.join(vaultDir, RELEASE_FILE);
    await fsp.writeFile(`${dest}.tmp`, text);
    await fsp.rename(`${dest}.tmp`, dest);
    return { published: true, release };
  } catch (err) {
    return skip(`發佈失敗：${err?.message ?? err}`);
  }
}

// ───────── 接收端 ─────────

const MESSAGES = {
  off: ['已關閉（設定）', 'Turned off (setting)'],
  none: ['記憶庫裡沒有發佈資訊', 'No release has been published in the vault'],
  invalid: ['release.json 的內容不合格式（版本、commit 或遠端網址有誤），當作沒有發佈', 'release.json is malformed (version, commit or repository is invalid) and was treated as no release'],
  current: ['已經是最新版', 'Already up to date'],
  dev: ['開發模式直接使用工作樹，不自動更新', 'Development mode uses the working tree directly, so no automatic update'],
  'not-installed': ['找不到安裝紀錄（local/install.json）', 'No installation record found (local/install.json)'],
  'known-failed': ['這個發佈上次更新失敗，等下一個發佈再試', 'The last update to this release failed; waiting for the next release'],
  busy: ['有對話進行中或自動駕駛正在執行，稍後再試', 'A conversation is in progress or autopilot is running; trying again later'],
  'no-source': ['找不到來源資料夾', 'The source folder was not found'],
  'not-git': ['來源資料夾不是 git 複本', 'The source folder is not a git clone'],
  dirty: ['來源資料夾有未提交的變更，不自動更新', 'The source folder has uncommitted changes, so no automatic update'],
  'repo-mismatch': ['來源資料夾的遠端網址和發佈的不相符', "The source folder's remote does not match the published repository"],
  offline: ['連不上遠端，稍後再試', 'Could not reach the remote; trying again later'],
  'commit-missing': ['遠端沒有發佈資訊指定的那個 commit', 'The remote does not have the commit named by the release'],
  'tag-mismatch': ['那個 commit 沒有對應的版本標籤', 'That commit does not carry the matching version tag'],
  'version-mismatch': ['那個 commit 的 package.json 版本和發佈的不符', "That commit's package.json version does not match the release"],
  'not-fast-forward': ['不是快轉（來源資料夾的 HEAD 不在發佈的 commit 之前），不更新', 'Not a fast-forward (the source HEAD is not an ancestor of the release commit), so no update'],
  'fetch-failed': ['抓取遠端失敗（不是連線問題，例如認證被拒）', 'Fetching from the remote failed (not a connection problem, for example authentication was refused)'],
  'agent-failed': ['新版常駐程式沒有在 60 秒內啟動', 'The new agent did not start within 60 seconds'],
  'no-rollback': ['沒有可以退回的舊版本，不自動更新', 'There is no previous version to roll back to, so no automatic update'],
  'merge-failed': ['git merge --ff-only 失敗，沒有更新', 'git merge --ff-only failed; nothing was updated'],
  'update-failed': ['更新流程失敗', 'The update failed'],
  'doctor-failed': ['更新後的檢查（doctor）沒有通過', 'The post-update check (doctor) did not pass'],
  updated: ['已自動更新', 'Updated automatically'],
};

async function readState(home) {
  try {
    const j = JSON.parse(await fsp.readFile(stateFile(home), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

async function writeState(home, state) {
  await fsp.mkdir(path.dirname(stateFile(home)), { recursive: true });
  await fsp.writeFile(`${stateFile(home)}.tmp`, JSON.stringify(state, null, 2));
  await fsp.rename(`${stateFile(home)}.tmp`, stateFile(home));
}

async function readInstall(home) {
  try { return JSON.parse(await fsp.readFile(path.join(home, 'local', 'install.json'), 'utf8')); } catch { return null; }
}

/** 給介面與日誌看的狀態：設定、本機版本、記憶庫裡的發佈資訊、最近一次的結果 */
export async function updateStatus({ home, autoUpdate = 'on' }) {
  const info = await readInstall(home);
  return {
    autoUpdate,
    local: info?.version ?? null,
    dev: !!info?.dev,
    release: await readRelease(path.join(home, 'vault')),
    last: (await readState(home)).last ?? null,
  };
}

/**
 * 接收端：檢查一次，條件都符合才更新。回傳 { status, code, reason, en: { reason }, ... }。
 * status：'updated'（已更新）、'failed'（更新失敗並已退回）、'refused'（條件不符、不更新）、'deferred'（稍後再試）、
 *   'current'（沒有新版）、'off'、'none'。
 * 依賴（deps）都可以注入：
 *   git(args, { cwd, timeoutMs })、update(opts)、busy() → 原因字串或 null、notify({ key, title, body, page })、restartAgent()、now()、
 *   doctor({ home, phase, baseline })：phase 'before' 在更新前呼叫（回傳值原樣交給 'after' 當 baseline），'after' 在更新後呼叫並回傳 { ok, detail }
 * @param {{ home: string, autoUpdate?: 'on'|'off', busy?: Function, git?: Function, update?: Function, doctor?: Function, notify?: Function, restartAgent?: Function, now?: () => number }} deps
 */
export async function runAutoUpdate({ home, autoUpdate = 'on', busy = async () => null, git = realGit, update = realUpdate, doctor = realDoctor, notify = () => {}, restartAgent = () => {}, now = Date.now }) {
  const vaultDir = path.join(home, 'vault');
  const state = await readState(home);
  // detailEn：細節的英文版（2.0.0：英文介面不再直接看到中文的細節）；沒有時沿用 detail（例如 git 的錯誤訊息本來就是英文）
  const result = (status, code, { detailEn, ...extra } = {}) => {
    const [zh, en] = MESSAGES[code];
    const dEn = detailEn ?? extra.detail;
    return { status, code, reason: extra.detail ? `${zh}：${extra.detail}` : zh, en: { reason: dEn ? `${en}: ${dEn}` : en }, ...extra };
  };
  // 條件不符、失敗、成功都記在本機狀態（最近一次的結果）：介面與日誌用；沒有新版這類每天都一樣的結果也記，方便看出有在檢查
  const finish = async (res, release) => {
    // 連續延後（同一個原因）的次數：第 5 次通知一次，之後每天只試一次（giveUpToday：排程不再 30 分鐘或 2 小時重試）；有別的結果就重算
    if (res.status === 'deferred') {
      state.streak = { code: res.code, count: (state.streak?.code === res.code ? state.streak.count : 0) + 1 };
      res.streak = state.streak.count;
      res.giveUpToday = res.streak >= MAX_DEFER_STREAK;
      if (res.streak === MAX_DEFER_STREAK && release) notifyOnce(state, release, `retry:${res.code}`, notify, { body: `自動更新連續 ${MAX_DEFER_STREAK} 次沒能開始（${res.reason}），之後每天只試一次。` });
    } else state.streak = null;
    state.last = { at: new Date(now()).toISOString(), status: res.status, code: res.code, reason: res.reason, en: { reason: res.en.reason }, ...(release ? { version: release.version, commit: release.commit } : {}) };
    await writeState(home, state).catch(() => {});
    return res;
  };

  if (autoUpdate !== 'on') return finish(result('off', 'off'));
  const text = await fsp.readFile(path.join(vaultDir, RELEASE_FILE), 'utf8').catch(() => null);
  if (text === null) return finish(result('none', 'none'));
  const release = parseRelease(text);
  if (!release) return finish(result('none', 'invalid'));
  const refuse = (code, extra) => finish(result('refused', code, extra), release);
  // 遠端那邊的問題（拿不到標籤、標籤指到別處、認證被拒、版本對不上）：不更新，並通知一次（同一個發佈、同一個原因），不是稍後再試
  const refuseRemote = (code, extra = {}) => {
    const res = result('refused', code, extra);
    notifyOnce(state, release, `refused:${code}:${extra.detail ?? ''}`, notify, { body: `自動更新到 ${release.version} 沒有進行：${res.reason}。` });
    return finish(res, release);
  };

  const info = await readInstall(home);
  if (!info) return refuse('not-installed');
  if (info.dev) return refuse('dev');
  const cmp = compareVersions(release.version, info.version);
  if (!(cmp > 0)) return finish(result('current', 'current'), release); // 版本看不懂（NaN）也不更新
  if (state.failedCommit === release.commit) return refuse('known-failed', { detail: state.failureReason || undefined, detailEn: state.failureReasonEn || undefined });

  // busy() 回傳原因（字串，或 { zh, en }）；沒有英文時英文介面沿用原文
  const why = await busy();
  if (why) return finish(result('deferred', 'busy', typeof why === 'string' ? { detail: why } : { detail: why.zh, detailEn: why.en }), release);

  // 來源資料夾：乾淨的 git 複本、遠端網址相符
  const sourceDir = info.sourceDir;
  if (!sourceDir || !fs.existsSync(path.join(sourceDir, 'package.json'))) return refuse('no-source', { detail: sourceDir ?? undefined });
  const g = (args, o = {}) => git(args, { cwd: sourceDir, ...o });
  const top = await g(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return refuse('not-git');
  const topDir = top.stdout.trim();
  const dirty = (await git(['status', '--porcelain'], { cwd: topDir })).stdout.split('\n').filter(Boolean);
  if (dirty.length) return refuse('dirty', { detail: `${dirty.length} 個項目`, detailEn: `${dirty.length} ${dirty.length === 1 ? 'item' : 'items'}` });
  if (normalizeRepo((await git(['remote', 'get-url', 'origin'], { cwd: topDir })).stdout.trim()) !== release.repo) return refuse('repo-mismatch');

  // 只取需要的東西：那一個版本標籤（連同它指到的 commit 與歷史），放到暫時的 ref 再比對。不抓全部標籤、不更新本機既有的標籤：
  // 遠端任何一個別的標籤被移動過（重打標籤、強制推送）都不影響更新。連不上是網路問題，不算更新失敗（不退回、不通知，稍後再試）；
  // 其他的失敗（遠端沒有這個標籤、認證被拒…）是遠端那邊的問題，不更新並通知一次
  const tagName = `v${release.version}`;
  const fetched = await git(['fetch', '--no-tags', 'origin', `+refs/tags/${tagName}:${TAG_REF}`], { cwd: topDir, timeoutMs: FETCH_TIMEOUT_MS });
  if (fetched.code !== 0) {
    const kind = fetchFailureKind(fetched);
    if (kind === 'offline') return finish(result('deferred', 'offline', fetched.timedOut ? { detail: '逾時', detailEn: 'timed out' } : { detail: safeDetail(fetched.stderr) }), release);
    if (kind === 'no-tag') return refuseRemote('tag-mismatch', { detail: `遠端沒有 ${tagName} 標籤`, detailEn: `the remote has no ${tagName} tag` });
    return refuseRemote('fetch-failed', { detail: safeDetail(fetched.stderr || fetched.stdout) });
  }
  // 版本標籤（附註標籤要剝到 commit）必須剛好指到發佈的 commit，而且那個 commit 的 package.json 版本一致
  const tag = (await git(['rev-parse', '--verify', '-q', `${TAG_REF}^{commit}`], { cwd: topDir })).stdout.trim();
  await git(['update-ref', '-d', TAG_REF], { cwd: topDir }); // 暫時的 ref 用完就清掉（清不掉也不影響）
  if (tag !== release.commit) return refuseRemote('tag-mismatch', { detail: `${tagName} 指到別的 commit（${tag.slice(0, 7) || '讀不到'}）`, detailEn: `${tagName} points to another commit (${tag.slice(0, 7) || 'unreadable'})` });
  if ((await git(['cat-file', '-e', `${release.commit}^{commit}`], { cwd: topDir })).code !== 0) return refuseRemote('commit-missing'); // 標籤對得上卻沒有這個 commit：理論上不會發生，保險用
  const prefix = (await g(['rev-parse', '--show-prefix'])).stdout.trim();
  const pkg = await git(['show', `${release.commit}:${prefix}package.json`], { cwd: topDir });
  let pkgVersion = null;
  try { pkgVersion = JSON.parse(pkg.stdout).version; } catch { /* 讀不到就當作不符 */ }
  if (pkgVersion !== release.version) return refuseRemote('version-mismatch', { detail: String(pkgVersion ?? '讀不到').slice(0, 40), detailEn: String(pkgVersion ?? 'unreadable').slice(0, 40) });
  // 只接受快轉：先確認，被拒絕時完全沒有動到來源資料夾
  const head = (await git(['rev-parse', 'HEAD'], { cwd: topDir })).stdout.trim();
  if (head !== release.commit && (await git(['merge-base', '--is-ancestor', head, release.commit], { cwd: topDir })).code !== 0) return refuse('not-fast-forward');

  // 退回的目標：目前使用中的版本資料夾（deploy 會保留舊版）；找不到就不更新
  const before = activeVersion(home);
  if (!before || !listVersions(home).some((v) => v.name === before)) return refuse('no-rollback');
  const backup = await backupInstall(home, now);
  // 更新前（舊程式）先跑一次 doctor 記下基準：更新後只看有沒有變差，不被環境有關的檢查（遠端連線、沒設遠端的記憶庫…）誤判成更新失敗
  const baseline = await doctor({ home, phase: 'before' }).catch(() => null);

  const fail = async (code, detail, detailEn) => {
    // 只有版本真的被切換了才退回；來源資料夾的 HEAD 不退（它是乾淨的快轉結果，下次 engram update 也會用到它）
    let rolledBack = false;
    if (activeVersion(home) !== before) {
      const r = await update({ home, rollback: true, rollbackTo: before, restartAgent: false, publish: false }).catch((err) => ({ ok: false, error: err }));
      rolledBack = r?.ok !== false && activeVersion(home) === before;
    }
    state.failedCommit = release.commit;
    state.failureReason = `${MESSAGES[code][0]}${detail ? `：${detail}` : ''}`;
    state.failureReasonEn = `${MESSAGES[code][1]}${detail ? `: ${detailEn ?? detail}` : ''}`;
    const res = result('failed', code, { detail, detailEn, rolledBack, backup, version: release.version, commit: release.commit });
    notifyOnce(state, release, 'failed', notify, {
      body: rolledBack ? `自動更新到 ${release.version} 失敗，已退回原本的版本（${res.reason}）。` : `自動更新到 ${release.version} 失敗，而且沒能退回原本的版本，請執行 engram update --rollback（${res.reason}）。`,
    });
    return finish(res, release);
  };

  if (head !== release.commit) {
    const m = await git(['merge', '--ff-only', release.commit], { cwd: topDir, timeoutMs: MERGE_TIMEOUT_MS });
    if (m.code !== 0) return fail('merge-failed', safeDetail(m.stderr || m.stdout));
  }
  let u;
  try { u = await update({ home, restartAgent: false, publish: false }); } catch (err) { u = { ok: false, error: err }; }
  if (u?.ok === false) return fail('update-failed', safeDetail(u.error?.message ?? (u.lines ?? []).slice(-1)[0]));
  const d = await doctor({ home, phase: 'after', baseline }).catch((err) => ({ ok: false, detail: String(err?.message ?? err) }));
  if (!d?.ok) return fail('doctor-failed', d?.detail, d?.detailEn);

  state.failedCommit = null;
  state.failureReason = null;
  state.failureReasonEn = null;
  const res = result('updated', 'updated', { detail: `${info.version} → ${activeVersion(home)}`, version: release.version, commit: release.commit, backup });
  await finish(res, release);
  // 最後一步：把重啟交給 restartAgent（它在這個工作結束之後停掉舊的常駐程式、啟動新版，並呼叫 restartAndVerify 確認新版常駐程式起得來；
  // 起得來才通知「已自動更新」，起不來就退回）。其他事都要在這之前做完
  restartAgent({ home, release: { version: release.version, commit: release.commit }, before, version: release.version });
  return res;
}

/**
 * 新版常駐程式有沒有起得來（在舊的常駐程式裡執行，這時舊程式與新程式都還在磁碟上，舊程式的程式碼已經載入記憶體，不受新版壞掉影響）：
 * 停掉舊的常駐程式 → 啟動新版 → 在時限內（預設 60 秒）等新程序的心跳回報新版本。
 * - 起得來：通知「已自動更新」一次，結束舊程序。
 * - 起不來：殺掉卡住的新程序、退回更新前的版本、啟動舊版常駐程式、通知（同一個發佈記為失敗、不再重試），結束舊程序。
 * 程序層面的動作（停止、啟動、讀心跳、結束）都是可注入的相依，測試用假的。
 * @param {{ home: string, release: { version: string, commit: string }, before: string, version: string, stopAgent: () => Promise<void>, spawnAgent: (bin: string) => number, readHeartbeat: () => ({ pid?: number, version?: string }|null), killProcess?: (pid: number) => void, update?: Function, notify?: Function, exit?: (code: number) => void, sleep?: Function, now?: () => number, timeoutMs?: number, pollMs?: number, selfPid?: number, log?: Function }} deps
 */
export async function restartAndVerify({ home, release, before, version, stopAgent, spawnAgent, readHeartbeat, killProcess = () => {}, update = realUpdate, notify = () => {}, exit = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = AGENT_START_TIMEOUT_MS, pollMs = 1000, selfPid = process.pid, log = () => {} }) {
  const state = await readState(home);
  const binOf = () => path.join(currentDir(home), 'bin', 'engram.mjs');
  try { await stopAgent(); } catch (err) { log(`停止舊的常駐程式時發生錯誤，仍然繼續：${err?.message ?? err}`); }
  const pid = spawnAgent(binOf());
  const deadline = now() + timeoutMs;
  let up = false;
  for (;;) {
    // 新程序自己回報的心跳才算：版本是新版、而且不是這個（舊）程序
    const hb = readHeartbeat();
    if (hb && hb.version === version && hb.pid !== selfPid) { up = true; break; }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  if (up) {
    const sent = notifyOnce(state, release, 'updated', notify, { body: `已自動更新到 Engram ${release.version}。已開啟的 Claude Code 對話請執行 /reload-plugins。` });
    await writeState(home, state).catch(() => {});
    await sent; // 通知送出去之後才結束這個程序
    exit(0);
    return { ok: true };
  }
  try { killProcess(pid); } catch { /* 已經結束 */ }
  const r = await update({ home, rollback: true, rollbackTo: before, restartAgent: false, publish: false }).catch((err) => ({ ok: false, error: err }));
  const rolledBack = r?.ok !== false && activeVersion(home) === before;
  const [zh, en] = MESSAGES['agent-failed'];
  state.failedCommit = release.commit;
  state.failureReason = zh;
  state.failureReasonEn = en;
  state.last = { at: new Date(now()).toISOString(), status: 'failed', code: 'agent-failed', reason: zh, en: { reason: en }, version: release.version, commit: release.commit };
  const sent = notifyOnce(state, release, 'failed', notify, {
    body: rolledBack ? `自動更新到 ${release.version} 失敗：${zh}，已退回原本的版本並重新啟動常駐程式。` : `自動更新到 ${release.version} 失敗：${zh}，而且沒能退回原本的版本，請執行 engram update --rollback。`,
  });
  await writeState(home, state).catch(() => {});
  spawnAgent(binOf()); // 退回之後 current 是舊版（退回失敗時還是新版，仍然試著啟動）；先啟動常駐程式，再等通知送出去
  await sent;
  exit(0);
  return { ok: false, rolledBack };
}

/** 同一個發佈、同一種結果只通知一次（記在狀態檔；重試不會重複通知） */
function notifyOnce(state, release, outcome, notify, { body }) {
  const key = `update:${release.commit}:${outcome}`;
  if (state.notified === key) return Promise.resolve(false);
  state.notified = key;
  // 回傳通知的 Promise：之後馬上要結束程序的呼叫端（restartAndVerify）要等它送出去，不然通知會被一起結束掉
  return Promise.resolve(notify({ key, title: 'Engram 憶跡', body, page: 'schedule' })).catch(() => false);
}

/** 更新前的獨立備份：安裝紀錄（install.json）複製到 local/backup/；程式本身靠 deploy 保留的舊版資料夾 */
async function backupInstall(home, now) {
  try {
    const src = path.join(home, 'local', 'install.json');
    await fsp.mkdir(backupDir(home), { recursive: true });
    const dest = path.join(backupDir(home), `install.json.${new Date(now()).toISOString().replace(/[:.]/g, '-')}`);
    await fsp.copyFile(src, dest);
    return dest;
  } catch { return null; }
}
