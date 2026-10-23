// engram install：在這台電腦安裝 Engram。
// 原則（ADR-001 §10）：每一個會寫到使用者環境的步驟都先列出、取得同意，並記錄在 local/install-steps.json，
// 讓 engram uninstall 可以逐項還原。可以重複執行：已完成的步驟會略過。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APP_DIR, BIN_PATH, engramHome, claudeHome as defaultClaudeHome, appVersion, localPaths } from '../src/cli/paths.mjs';
import { run, spawnDetachedNode } from '../src/cli/proc.mjs';
import { deploy, rollback, activeVersion, appRoot, currentDir } from './deploy.mjs';
import { userPermissionMode } from '../src/cli/probe/index.mjs';
import { agentStartError, waitForAgent } from '../src/agent/wait.mjs';

export const MARKETPLACE = 'engram-local';
export const PLUGIN = 'engram';
export const VAULT_REPO = 'engram-vault';
const CLI_PKG = 'engram'; // package.json 的 name：npm 全域指令的名稱
const BEGIN = '<!-- engram:begin';

const stepsFile = (home) => path.join(home, 'local', 'install-steps.json');

/** 讓 claude CLI 操作指定的 Claude 設定資料夾（測試或沙盒時與預設不同）。 */
export function claudeEnv(claudeHome) {
  const isDefault = path.resolve(claudeHome).toLowerCase() === path.resolve(defaultClaudeHome()).toLowerCase();
  return isDefault ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };
}

export async function readSteps(home = engramHome()) {
  try { return JSON.parse(await fsp.readFile(stepsFile(home), 'utf8')); } catch { return null; }
}

async function writeSteps(home, rec) {
  await fsp.mkdir(path.dirname(stepsFile(home)), { recursive: true });
  const f = stepsFile(home);
  await fsp.writeFile(`${f}.tmp`, JSON.stringify(rec, null, 2));
  await fsp.rename(`${f}.tmp`, f);
}

async function backup(home, file) {
  const dir = path.join(home, 'local', 'backup');
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${path.basename(file)}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fsp.copyFile(file, dest);
  return dest;
}

/** 這個 Node.js 附帶的 npm（直接用 node 執行 npm-cli.js：Windows 上不能不經 shell 執行 npm.cmd）。 */
export function npmCliPath(nodePath = process.execPath) {
  const p = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(p) ? p : null;
}

/** npm 全域資料夾裡的 engram 實際指向哪裡；沒有時回傳 null。 */
function globalCliTarget(prefix) {
  try { return fs.realpathSync(path.join(prefix, 'node_modules', CLI_PKG)); } catch { return null; }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (p, dir) => { const r = path.relative(path.resolve(dir), path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };
/** 這支程式本身是不是 ~/.engram/app 底下部署的複本（終端機的 engram 與 Claude Code 外掛都執行複本）。 */
const runningFromDeployed = (home) => fs.existsSync(appRoot(home)) && isInside(APP_DIR, fs.realpathSync(appRoot(home)));

/** 用 npm 把 engram 連結成全域指令（cmd、PowerShell、Git Bash 都有入口）；目標是部署的程式資料夾。 */
export function linkCli(exec, npmCli, appDir) {
  return exec(process.execPath, [npmCli, 'install', '-g', '--no-audit', '--no-fund', appDir], { timeoutMs: 120_000 });
}

/**
 * 自動判斷記憶庫（第一台或第二台）：GitHub 上已有 <帳號>/engram-vault 就接上，沒有就建立。
 * @returns {Promise<{ login, url, exists } | { error: string }>}
 */
export async function findVaultRepo(exec = run) {
  const who = await exec('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 30_000 });
  const login = who.code === 0 ? who.stdout.trim() : '';
  if (!login) return { error: (who.stderr || who.stdout).trim() || '無法取得 GitHub 帳號' };
  const url = `https://github.com/${login}/${VAULT_REPO}.git`;
  const view = await exec('gh', ['repo', 'view', `${login}/${VAULT_REPO}`, '--json', 'name'], { timeoutMs: 30_000 });
  if (view.code === 0) return { login, url, exists: true };
  // 只有「找不到這個 repo」才當成第一台；連線失敗不能誤判成要建立新的記憶庫
  if (/could not resolve to a repository/i.test(view.stderr)) return { login, url, exists: false };
  return { error: view.stderr.trim() || `無法查詢 ${login}/${VAULT_REPO}` };
}

/** 安裝前檢查：版本、工具、既有狀態。 */
export async function preflight({ home, claudeHome, remote, createRemote, autoRemote, cliLink, plugin, run: exec = run }) {
  const facts = { node: process.versions.node, nodeOk: Number(process.versions.node.split('.')[0]) >= 22 };
  const git = await exec('git', ['--version']).catch(() => null);
  facts.git = git?.code === 0 ? git.stdout.trim() : null;
  const claude = await exec('claude', ['--version']).catch(() => null);
  facts.claude = claude?.code === 0 ? claude.stdout.trim() : null;
  const gh = await exec('gh', ['auth', 'status']).catch(() => null);
  facts.gh = gh ? gh.code === 0 : false;
  facts.vaultExists = fs.existsSync(path.join(home, 'vault', '.git'));
  // 一般終端機的 engram 指令：需要 npm；已有別的 engram 時不覆蓋
  if (cliLink) {
    facts.npmCli = npmCliPath();
    const prefix = facts.npmCli ? await exec(process.execPath, [facts.npmCli, 'prefix', '-g']).catch(() => null) : null;
    facts.npmPrefix = prefix?.code === 0 ? prefix.stdout.trim() : null;
    if (!facts.npmPrefix) facts.npmCli = null;
    const target = facts.npmPrefix && globalCliTarget(facts.npmPrefix);
    if (target && !isInside(target, path.join(home, 'app')) && !samePath(target, APP_DIR)) facts.cliConflict = target;
  }
  facts.claudeMd = path.join(claudeHome, 'CLAUDE.md');
  facts.claudeMdHasBlock = fs.existsSync(facts.claudeMd) && fs.readFileSync(facts.claudeMd, 'utf8').includes(BEGIN);
  facts.permissionMode = userPermissionMode(claudeHome) ?? null;
  facts.problems = [];
  facts.warnings = [];
  // R-52：設定檔綁定在任何權限模式都能用；junction 只在 auto／bypassPermissions 建立（其他模式下透過 junction 寫入記憶會被詢問）
  if (!['auto', 'bypassPermissions'].includes(facts.permissionMode)) {
    facts.warnings.push(`你的 Claude Code 預設權限模式是「${facts.permissionMode ?? '未設定（每次詢問）'}」。Engram 會用專案根目錄的設定檔接上記憶，從專案根目錄啟動 Claude Code 不受影響；但從子資料夾啟動時不會用到 Engram 記憶。如果希望子資料夾也適用，可以把 ${path.join(claudeHome, 'settings.json')} 的 permissions.defaultMode 設為 auto，Engram 會自動補上 junction。`);
  }
  if (!facts.nodeOk) facts.problems.push(`Node.js 版本太舊（${facts.node}），需要 22 以上。`);
  if (!facts.git) facts.problems.push('找不到 git。請先安裝 Git for Windows。');
  // 外掛要用 claude 指令安裝；Windows 上不經 shell 只找得到 claude.exe，npm 安裝的 claude.cmd 會在改寫 CLAUDE.md 之後才失敗
  if (plugin !== false && !facts.claude) {
    facts.problems.push('無法執行 Claude Code（claude --version 沒有成功）。Engram 需要用官方安裝程式安裝的 Claude Code（claude.exe）才能安裝外掛；用 npm 安裝的 claude.cmd 無法使用。請在 PowerShell 執行 irm https://claude.ai/install.ps1 | iex，開一個新的終端機後再安裝 Engram。');
  }
  // 需要 gh 的情況在任何寫入之前就先擋下，不要裝到一半才失敗
  if (!facts.vaultExists && !remote && (createRemote || autoRemote) && !facts.gh) {
    facts.problems.push('需要已登入的 GitHub CLI 才能找到或建立你的記憶庫：請先執行 gh auth login。也可以用 --remote <網址> 指定記憶庫，或 --local 只在這台電腦使用。');
  }
  if (!facts.vaultExists && !remote && !createRemote && autoRemote && facts.gh) {
    facts.vaultRepo = await findVaultRepo(exec);
    if (facts.vaultRepo.error) facts.problems.push(`無法查詢你 GitHub 上的記憶庫：${facts.vaultRepo.error}`);
  }
  if (cliLink && !facts.npmCli) facts.warnings.push('找不到 npm，略過「一般終端機也能輸入 engram」；在 Claude Code 裡仍可使用 engram。');
  else if (cliLink && facts.cliConflict) facts.warnings.push(`npm 全域已經有另一個 engram（${facts.cliConflict}），不覆蓋它；終端機請改用 node "${path.join(home, 'app', 'current', 'bin', 'engram.mjs')}"。`);
  else if (cliLink && !(process.env.PATH ?? '').split(path.delimiter).some((d) => d && samePath(d, facts.npmPrefix))) {
    facts.warnings.push(`npm 的全域資料夾 ${facts.npmPrefix} 不在 PATH 上，終端機可能找不到 engram 指令。`);
  }
  return facts;
}

/** 列出這次安裝會做的事（給使用者確認）。 */
export function describePlan(opts, facts) {
  const lines = [];
  if (!facts.vaultExists) {
    if (opts.remote && facts.vaultRepo?.exists) lines.push(`接上你 GitHub 上既有的記憶庫 ${opts.remote}（另一台電腦已經在用），下載到 ${path.join(opts.home, 'vault')}`);
    else if (opts.remote) lines.push(`從 ${opts.remote} 取得你的記憶庫到 ${path.join(opts.home, 'vault')}`);
    else if (opts.createRemote) lines.push(`在 ${path.join(opts.home, 'vault')} 建立記憶庫，並用 gh 在你的 GitHub 建立私人 repo「engram-vault」`);
    else lines.push(`在 ${path.join(opts.home, 'vault')} 建立記憶庫（之後可再設定 GitHub 同步）`);
  } else lines.push('記憶庫已存在，沿用');
  if (opts.dev) lines.push(`開發模式：直接使用工作樹 ${APP_DIR}（修改會立即影響 Claude Code）`);
  else if (runningFromDeployed(opts.home)) lines.push(`沿用已部署的程式 ${currentDir(opts.home)}（要換新版請用 engram update）`);
  else lines.push(`把程式複製到 ${path.join(opts.home, 'app')}（版本化，日後用 engram update 升級）`);
  lines.push(`寫入 ${path.join(opts.home, 'local', 'install.json')}（記錄程式位置）`);
  if (!facts.claudeMdHasBlock) lines.push(`在 ${facts.claudeMd} 的末尾加一段 Engram 管理區塊（兩行 import）；原本的內容不動，修改前先備份`);
  if (opts.plugin !== false) lines.push('安裝 Claude Code 外掛 engram（hooks、/engram 技能、engram 指令），範圍：使用者');
  if (opts.cliLink && facts.npmCli && !facts.cliConflict) lines.push(`讓一般終端機（PowerShell、命令提示字元、Git Bash）也能直接輸入 engram：用 npm 在 ${facts.npmPrefix} 建立全域指令`);
  if (opts.schedule !== false) lines.push(`建立 Windows 登入工作 \\Engram\\Agent（啟動器：${opts.launcher || 'wscript'}），並立即啟動常駐程式`);
  return lines;
}

/**
 * 執行安裝。
 * @param {{ home?, claudeHome?, remote?, createRemote?, label?, launcher?, yes?, dryRun?, schedule?, plugin?, engine? }} opts
 * @param {{ print: (s: string) => void, confirm: (q: string) => Promise<boolean> }} io
 */
export async function runInstall(opts = {}, io) {
  const home = opts.home ?? engramHome();
  const claudeHome = opts.claudeHome ?? defaultClaudeHome();
  const o = { ...opts, home, claudeHome };
  const exec = o.run ?? run;
  const facts = await preflight(o);
  if (facts.vaultRepo?.exists) o.remote = facts.vaultRepo.url;
  else if (facts.vaultRepo && !facts.vaultRepo.error) o.createRemote = true;
  if (facts.problems.length) {
    for (const p of facts.problems) io.print(`✗ ${p}`);
    return { ok: false, facts };
  }
  io.print('Engram 安裝計畫：');
  describePlan(o, facts).forEach((l, i) => io.print(`  ${i + 1}. ${l}`));
  for (const w of facts.warnings ?? []) io.print(`! ${w}`);
  if (o.dryRun) return { ok: true, dryRun: true, facts };
  if (!o.yes && !(await io.confirm('要開始安裝嗎？'))) return { ok: false, cancelled: true };

  const engine = o.engine ?? await import('../src/core/index.mjs');
  const rec = (await readSteps(home)) ?? { version: appVersion(), appDir: APP_DIR, installedAt: new Date().toISOString(), steps: [] };
  const has = (kind) => rec.steps.some((s) => s.kind === kind);
  const record = async (step) => { rec.steps.push({ ...step, at: new Date().toISOString() }); await writeSteps(home, rec); };

  // 0. 程式本身：預設部署一份版本化的複本，避免開發中的工作樹直接影響日常使用（R-43）。
  //    從部署的複本執行時（例如在終端機輸入 engram install）沿用現有部署：複本不是 git 工作樹，再部署一次會產生 -local 版本
  const fromDeployed = !o.dev && runningFromDeployed(home);
  const prevInfo = JSON.parse(await fsp.readFile(path.join(home, 'local', 'install.json'), 'utf8').catch(() => 'null'));
  let appDir = APP_DIR;
  if (fromDeployed) appDir = currentDir(home);
  else if (!o.dev) {
    const d = await deploy(home, APP_DIR);
    appDir = d.appDir;
    io.print(`✓ 已部署 Engram ${d.version} 到 ${d.versionDir}`);
  }
  if (!has('app')) await record({ kind: 'app', dev: !!o.dev, appDir });
  const binPath = path.join(appDir, 'bin', 'engram.mjs');
  rec.appDir = appDir;

  // 1. 記憶庫
  if (!facts.vaultExists) {
    let remote = o.remote;
    if (!remote && o.createRemote) {
      const r = await exec('gh', ['repo', 'create', VAULT_REPO, '--private', '--description', 'Engram 憶跡：個人 Claude Code 記憶庫'], { timeoutMs: 60_000 });
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) throw Object.assign(new Error(`無法建立 GitHub repo：${r.stderr.trim()}`), { code: 'E_GH', hint: '確認已執行 gh auth login，或改用 --remote 指定既有的空 repo。' });
      const who = await exec('gh', ['api', 'user', '--jq', '.login']);
      remote = `https://github.com/${who.stdout.trim()}/engram-vault.git`;
    }
    const r = await engine.init({ home, claudeHome, remote, machineLabel: o.label || os.hostname(), cli: binPath });
    await record({ kind: 'vault', created: !!r.created, remote: remote ?? null });
    io.print(`✓ 記憶庫：${r.vault}${remote ? `（遠端 ${remote}）` : ''}`);
  }

  // 2. 程式位置
  const installJson = path.join(home, 'local', 'install.json');
  await fsp.mkdir(path.dirname(installJson), { recursive: true });
  // sourceDir 是 engram update 的預設來源，一定要是原始程式資料夾，不能是部署的複本
  const sourceDir = fromDeployed ? (prevInfo?.sourceDir ?? APP_DIR) : APP_DIR;
  await fsp.writeFile(installJson, JSON.stringify({ appDir, sourceDir, dev: !!o.dev, nodePath: process.execPath, version: activeVersion(home) ?? appVersion(), installedAt: rec.installedAt }, null, 2));
  // 純文字的程式位置：外掛的 bin/engram 用 bash 直接讀，不必多啟動一次 node
  await fsp.writeFile(path.join(home, 'local', 'app-dir'), appDir);
  if (!has('install-json')) await record({ kind: 'install-json', path: installJson });

  // 3. ~/.claude/CLAUDE.md 管理區塊
  const eg = await engine.open({ home, claudeHome });
  const claudeMd = path.join(claudeHome, 'CLAUDE.md');
  const current = fs.existsSync(claudeMd) ? await fsp.readFile(claudeMd, 'utf8') : null;
  if (!current?.includes(BEGIN)) {
    const block = (await eg.claudeMdBlock()).trim();
    const appended = `${current && !current.endsWith('\n') ? '\n' : ''}\n${block}\n`;
    const bak = current !== null ? await backup(home, claudeMd) : null;
    await fsp.mkdir(claudeHome, { recursive: true });
    await fsp.writeFile(claudeMd, (current ?? '') + appended);
    await record({ kind: 'claude-md', path: claudeMd, appended, createdFile: current === null, backup: bak });
    io.print(`✓ 已在 ${claudeMd} 末尾加入 Engram 管理區塊${bak ? `（備份：${bak}）` : ''}`);
  }

  // 4. Claude Code 外掛（以部署的程式資料夾當 marketplace；engram update 切換版本後 /reload-plugins 即生效）
  if (o.plugin !== false) {
    if (!has('marketplace')) {
      const r = await run('claude', ['plugin', 'marketplace', 'add', appDir], { env: claudeEnv(claudeHome), timeoutMs: 60_000 });
      if (r.code !== 0 && !/already/i.test(r.stdout + r.stderr)) throw Object.assign(new Error(`無法加入外掛來源：${(r.stderr || r.stdout).trim()}`), { code: 'E_PLUGIN' });
      await record({ kind: 'marketplace', name: MARKETPLACE, path: appDir });
    }
    if (!has('plugin')) {
      const r = await run('claude', ['plugin', 'install', `${PLUGIN}@${MARKETPLACE}`, '--scope', 'user'], { env: claudeEnv(claudeHome), timeoutMs: 60_000 });
      if (r.code !== 0 && !/already/i.test(r.stdout + r.stderr)) throw Object.assign(new Error(`無法安裝外掛：${(r.stderr || r.stdout).trim()}`), { code: 'E_PLUGIN' });
      await record({ kind: 'plugin', name: `${PLUGIN}@${MARKETPLACE}`, scope: 'user' });
      io.print('✓ 已安裝 Claude Code 外掛 engram（新開的對話生效；已開啟的對話可執行 /reload-plugins）');
    }
  }

  // 5. 一般終端機的 engram 指令（npm 全域連結）。npm 會把 current 解析成實際的版本資料夾，所以每次部署後都重新連結
  if (o.cliLink && facts.npmCli && !facts.cliConflict) {
    const r = await linkCli(exec, facts.npmCli, appDir);
    if (r.code === 0) {
      if (!has('cli-link')) await record({ kind: 'cli-link', name: CLI_PKG, prefix: facts.npmPrefix });
      io.print('✓ 新開的終端機可以直接輸入 engram');
    } else io.print(`! 無法建立終端機的 engram 指令（${(r.stderr || r.stdout).trim().split('\n').pop()}）；在 Claude Code 裡仍可使用 engram，終端機可改用 node "${binPath}"`);
  }

  // 6. 登入工作與常駐程式：確認常駐程式真的開始服務，起不來時說出原因（例如連接埠被其他程式占用）
  let agent = null;
  if (o.schedule !== false) {
    const task = await import('../src/scheduler/task.mjs');
    await task.install({ launcher: o.launcher || 'wscript', appDir });
    if (!has('logon-task')) await record({ kind: 'logon-task', name: task.TASK_NAME, launcher: o.launcher || 'wscript' });
    const paths = localPaths(home);
    const since = Date.now();
    spawnDetachedNode([binPath, 'agent']);
    agent = await waitForAgent(paths, o.agentWaitMs ?? 15_000);
    if (agent) io.print(`✓ 已建立登入工作 ${task.TASK_NAME}，常駐程式已啟動（PID ${agent.pid}，http://127.0.0.1:${agent.port}/）`);
    else {
      const why = await agentStartError(paths, since);
      io.print(`✓ 已建立登入工作 ${task.TASK_NAME}`);
      io.print(`! 常駐程式沒有啟動成功${why ? `：${why}` : ''}。排除原因後執行 engram ui 會再啟動它；紀錄在 ${paths.logs}`);
    }
  }

  io.print('');
  io.print('安裝完成。下一步：');
  io.print('  · 執行 engram ui 開啟管理介面（建議在 Edge 安裝成應用程式）');
  io.print('  · 到「匯入既有記憶」先跑沙盒演練，確認後再套用');
  return { ok: true, steps: rec.steps.length, appDir, ...(o.schedule !== false ? { agentStarted: !!agent } : {}) };
}

/**
 * engram update：把來源（預設是安裝時的工作樹）部署成新版本並切換；--rollback 切回上一版。
 * 切換後重新啟動常駐程式；已開啟的 Claude Code 對話執行 /reload-plugins 即可使用新版。
 * @param {{ home?, from?, rollback?: boolean, restartAgent?: boolean }} opts
 */
export async function runUpdate(opts = {}, io) {
  const home = opts.home ?? engramHome();
  const installJson = path.join(home, 'local', 'install.json');
  const info = JSON.parse(await fsp.readFile(installJson, 'utf8').catch(() => 'null'));
  if (!info) { io.print('這台電腦還沒有安裝 Engram，請先執行 engram install。'); return { ok: false }; }
  if (info.dev) { io.print(`開發模式直接使用工作樹 ${info.appDir}，不需要更新。`); return { ok: true, dev: true }; }
  const from = opts.from ?? info.sourceDir ?? APP_DIR;
  const fromCopy = (() => { try { return isInside(fs.realpathSync(from), fs.realpathSync(appRoot(home))); } catch { return false; } })();
  if (!opts.rollback && fromCopy) {
    io.print(`✗ 記錄的原始程式位置 ${from} 是部署的複本，從這裡更新不會拿到新版。請用 --from 指定 Engram 程式資料夾裡的 app，例如 engram update --from "<Engram 資料夾>\\app"。`);
    return { ok: false };
  }
  const r = opts.rollback ? await rollback(home) : await deploy(home, from);
  await fsp.writeFile(installJson, JSON.stringify({ ...info, version: activeVersion(home), updatedAt: new Date().toISOString() }, null, 2));
  io.print(opts.rollback ? `✓ 已切回 ${r.version}（原本是 ${r.previous}）` : `✓ 已更新到 ${r.version}${r.previous ? `（原本是 ${r.previous}）` : ''}`);
  // npm 全域指令指向實際的版本資料夾，換版後要重新連結
  const npmCli = (await readSteps(home))?.steps?.some((s) => s.kind === 'cli-link') ? npmCliPath() : null;
  if (npmCli) {
    const l = await linkCli(opts.run ?? run, npmCli, info.appDir);
    io.print(l.code === 0 ? '✓ 已更新終端機的 engram 指令' : `! 無法更新終端機的 engram 指令：${(l.stderr || l.stdout).trim().split('\n').pop()}`);
  }
  if (opts.restartAgent !== false) {
    const hb = JSON.parse(await fsp.readFile(path.join(home, 'local', 'agent.json'), 'utf8').catch(() => 'null'));
    if (hb?.pid) { try { process.kill(hb.pid); } catch { /* 已經結束 */ } }
    spawnDetachedNode([path.join(info.appDir, 'bin', 'engram.mjs'), 'agent']);
    io.print('✓ 已重新啟動常駐程式');
  }
  io.print('已開啟的 Claude Code 對話請執行 /reload-plugins；新開的對話會直接使用新版。');
  return { ok: true, ...r };
}
