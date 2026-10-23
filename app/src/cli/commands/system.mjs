// 系統類指令：doctor、ui、agent、hook、schedule、merge-driver、install、uninstall、version。
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { agentState, isFresh, pingAgent, readHeartbeat } from '../../agent/heartbeat.mjs';
import { agentStartError, waitForAgent } from '../../agent/wait.mjs';
import { parsePositiveInt } from '../args.mjs';
import { CliError, toErrorInfo } from '../errors.mjs';
import { safeName } from '../fsutil.mjs';
import { createLogger } from '../log.mjs';
import { SEVERITY_LABEL } from '../output.mjs';
import { appVersion, BIN_PATH, DEFAULT_PORT, localPaths } from '../paths.mjs';
import { pausedFrom, runProbe } from '../probe/index.mjs';
import { spawnDetachedNode } from '../proc.mjs';
import { safeFinding } from './inbox.mjs';
import { redactText } from './safe.mjs';

const mark = (ok) => (ok ? '✓' : '✗');
const LAUNCHER_LABEL = { wscript: 'wscript（隱藏視窗）', conhost: 'conhost --headless', direct: '直接執行 node' };
const TASK_STATE_LABEL = { ready: '就緒', running: '執行中', disabled: '已停用', queued: '排隊中', unknown: '未知' };
const PAUSE_LABEL = { bind: '背景綁定', junction: 'junction 熱切換', normalize: '補回 metadata.engram 欄位' };

const scheduler = (ctx) => ctx.deps.scheduler ?? import('../../scheduler/task.mjs');

// ───────── doctor ─────────

export async function cmdDoctor(ctx) {
  const paths = localPaths();
  const data = { ok: true, engine: { ok: true }, checks: [], findings: [], agent: agentState(paths), logonTask: null, probe: null };
  try {
    const eg = await ctx.engine();
    const d = await eg.doctor();
    // 輸出會交給 Claude（安裝手冊要它執行 engram doctor）：卡片沿用收件匣的遮蔽；檢查項目可能帶遠端網址裡的權杖
    const safeCheck = (c) => ({ ...c, label: redactText(c.label), ...(c.detail != null ? { detail: redactText(c.detail) } : {}) });
    Object.assign(data, { ok: d.ok !== false, checks: (d.checks ?? []).map(safeCheck), findings: (d.findings ?? []).map(safeFinding) });
  } catch (err) {
    Object.assign(data, { ok: false, engine: { ok: false, error: toErrorInfo(err) } });
  }
  data.logonTask = await (await scheduler(ctx)).status().catch((err) => ({ installed: false, error: toErrorInfo(err) }));
  if (ctx.opts.probe) {
    data.probe = await (ctx.deps.runProbe ?? runProbe)();
    data.paused = pausedFrom(data.probe);
    if (!data.probe.ok) data.ok = false;
  }

  const lines = [];
  if (!data.engine.ok) lines.push(`✗ 引擎無法載入：${data.engine.error.message}`, `  建議：${data.engine.error.hint}`);
  for (const c of data.checks) lines.push(`${mark(c.ok)} ${c.label}${!c.ok && c.detail ? `：${c.detail}` : ''}`);
  const a = data.agent;
  lines.push(`${mark(a.running)} 常駐程式${a.running ? `：執行中（pid ${a.pid}，http://127.0.0.1:${a.port}/）` : '：沒有在執行（engram ui 會啟動它）'}`);
  const t = data.logonTask;
  lines.push(`${mark(t.installed)} 登入工作${t.installed ? `：已建立（${LAUNCHER_LABEL[t.launcher] ?? t.launcher ?? '未知啟動器'}，${TASK_STATE_LABEL[t.state] ?? t.state ?? '未知'}）` : '：尚未建立（engram schedule install）'}`);
  const visible = data.findings.filter((f) => f.severity !== 'auto');
  lines.push(visible.length ? `健康檢查：${visible.length} 項需要注意` : '健康檢查：沒有需要處理的問題');
  for (const f of visible) lines.push(`  [${SEVERITY_LABEL[f.severity] ?? f.severity}] ${f.code} ${f.title}${f.fix?.label ? ` → ${f.fix.label}` : ''}`);
  if (data.probe) {
    const p = data.probe;
    lines.push(`相容性探測（Claude Code ${p.claudeVersion ?? '版本未知'}）：${p.checks.filter((c) => c.ok).length}/${p.checks.length} 通過`);
    for (const c of p.checks) lines.push(`  ${mark(c.ok)} ${c.id} ${c.label}${c.ok ? '' : `\n      ${c.detail}`}`);
    if (data.paused.length) lines.push(`  已暫停的自動化：${data.paused.map((x) => PAUSE_LABEL[x] ?? x).join('、')}`);
  }
  ctx.out.result(data, lines);
  return data.ok ? 0 : 1;
}

// ───────── ui、agent ─────────

function openUrl(url) {
  const [cmd, args, extra] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true }]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {}];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...extra });
  child.on('error', () => {});
  child.unref();
}

export async function cmdUi(ctx) {
  const paths = localPaths();
  let hb = readHeartbeat(paths);
  let started = false;
  if (!(isFresh(hb) && (await pingAgent(hb)))) {
    const since = Date.now();
    (ctx.deps.spawnNode ?? spawnDetachedNode)([BIN_PATH, 'agent']);
    started = true;
    hb = await waitForAgent(paths, ctx.deps.agentWaitMs ?? 10_000);
    if (!hb) {
      const why = await agentStartError(paths, since);
      throw new CliError('E_AGENT_DOWN', `常駐程式沒有在 10 秒內啟動${why ? `：${why}` : ''}`, `詳細紀錄在 ${paths.logs}`);
    }
  }
  const url = `http://127.0.0.1:${hb.port}/`;
  (ctx.deps.openUrl ?? openUrl)(url);
  ctx.out.result({ url, started }, started ? `已啟動常駐程式並開啟管理介面：${url}` : `已開啟管理介面：${url}`);
}

export async function cmdAgent(ctx) {
  const port = ctx.opts.port ? parsePositiveInt(ctx.opts.port, '--port', { max: 65535 }) : DEFAULT_PORT;
  const { startAgent } = await import('../../agent/index.mjs');
  let res;
  try {
    res = await startAgent({ port, echo: !ctx.opts.json && !!process.stderr.isTTY });
  } catch (err) {
    // 登入工作與 engram ui 都在背景啟動常駐程式、看不到錯誤輸出：寫進日誌，engram install／ui 才能說出原因
    createLogger(localPaths().logs, 'agent').error('agent', `啟動失敗：${err?.message ?? err}`);
    throw err;
  }
  if (res.alreadyRunning) {
    const { pid, port: p } = res.alreadyRunning;
    ctx.out.result({ alreadyRunning: true, pid, port: p }, `常駐程式已在執行（pid ${pid}，http://127.0.0.1:${p}/），不再啟動第二個。`);
    return 0;
  }
  ctx.out.result({ pid: process.pid, port: res.port }, `Engram 常駐程式已啟動：http://127.0.0.1:${res.port}/（按 Ctrl+C 結束）`);
  return null; // 保持執行
}

// ───────── hook、merge-driver（永遠 exit 0，不擋住呼叫端） ─────────

export async function cmdHook(ctx) {
  const { main, readStdinJson } = await import('../../hooks/index.mjs');
  const input = await readStdinJson(ctx.io.stdin);
  await main(ctx.args[0], input, { stdout: ctx.io.stdout });
  return 0;
}

/** git 合併器：engram merge-driver %O %A %B %P（40 號 §11）。結果寫回 %A；無法合併時引擎隔離對方版本。 */
export async function cmdMergeDriver(ctx) {
  const [base, ours, theirs, ref = ''] = ctx.args;
  const paths = localPaths();
  // 常駐程式會設定 ENGRAM_CONFLICTS_DIR；手動在 vault 執行 git 時退回 vault/conflicts
  const conflictsDir = process.env.ENGRAM_CONFLICTS_DIR || path.join(paths.vault, 'conflicts');
  try {
    const { mergeDriver } = await import('../../core/mergedriver.mjs');
    const r = await mergeDriver({ base, ours, theirs, path: ref, conflictsDir });
    return r?.exitCode ?? 0;
  } catch (err) {
    // 合併器無法載入：保留本機版本（%A 不動），對方版本另存一份，避免工作目錄留下衝突標記
    createLogger(paths.logs, 'cli').error('merge-driver', err);
    const dest = path.join(paths.local, 'merge-fallback', `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName(ref)}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true }).then(() => fsp.copyFile(theirs, dest)).catch(() => {});
    return 0;
  }
}

// ───────── schedule ─────────

export async function cmdSchedule(ctx) {
  const sub = ctx.args[0];
  const sched = await scheduler(ctx);
  if (sub === 'install') {
    const launcher = ctx.opts.launcher ?? 'wscript';
    if (!sched.LAUNCHERS.includes(launcher)) throw new CliError('E_USAGE', `不認得的啟動器：${launcher}`, '可用的啟動器：wscript、conhost、direct。');
    const r = await sched.install({ launcher });
    ctx.out.result(r, `已建立登入工作 ${sched.TASK_NAME}（${LAUNCHER_LABEL[launcher]}）。下次登入 Windows 時會自動啟動常駐程式。`);
    return 0;
  }
  if (sub === 'remove') {
    const r = await sched.remove();
    ctx.out.result(r, r.removed ? `已移除登入工作 ${sched.TASK_NAME}。` : '沒有找到登入工作（可能已經移除）。');
    return 0;
  }
  if (sub === 'status') {
    const st = await sched.status();
    ctx.out.result(st, st.installed
      ? `登入工作 ${sched.TASK_NAME}：已建立 · ${TASK_STATE_LABEL[st.state] ?? st.state ?? '狀態未知'} · ${LAUNCHER_LABEL[st.launcher] ?? st.launcher ?? '未知啟動器'} · 上次執行 ${st.lastRunAt ?? '—'}`
      : '尚未建立登入工作。建議執行 engram schedule install。');
    return 0;
  }
  throw new CliError('E_USAGE', '請指定 install、remove 或 status', '例如：engram schedule status');
}

// ───────── install、uninstall（實作在 app/install/，這裡只負責分派） ─────────

/** 安裝程式用的輸出與確認：--json 時不印過程，只在最後印結果；非互動終端機一律視為不同意。 */
function installerIo(ctx) {
  const { stdout, stderr, stdin } = ctx.io;
  return {
    print: (line) => {
      if (!ctx.out.json) stdout.write(`${line}\n`);
    },
    async confirm(question) {
      if (!stdin?.isTTY) return false;
      const rl = readline.createInterface({ input: stdin, output: stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question}（y/N）`)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

async function installerFn(file, name) {
  let mod = null;
  try {
    mod = await import(`../../../install/${file}`);
  } catch {
    // 尚未安裝
  }
  if (typeof mod?.[name] !== 'function') throw new CliError('E_NOT_IMPLEMENTED', `找不到安裝程式（app/install/${file}）`, '確認 Engram 程式完整，或重新下載。');
  return mod[name];
}

async function runInstaller(ctx, file, name, opts) {
  const res = await (await installerFn(file, name))(opts, installerIo(ctx));
  if (ctx.out.json) ctx.out.result(res);
  return res?.ok === false ? 1 : 0;
}

export function cmdInstall(ctx) {
  const o = ctx.opts;
  return runInstaller(ctx, 'install.mjs', 'runInstall', {
    remote: o.remote,
    createRemote: !!o['create-remote'],
    // 沒有指定記憶庫位置時自動判斷：GitHub 上已有 engram-vault 就接上（第二台），沒有就建立（第一台）
    autoRemote: !o.remote && !o['create-remote'] && !o.local,
    label: o.label,
    launcher: o.launcher,
    yes: !!o.yes,
    dryRun: !!o['dry-run'],
    schedule: !o['no-schedule'],
    plugin: !o['no-plugin'],
    cliLink: !o['no-cli'],
    dev: !!o.dev,
  });
}

export function cmdUpdate(ctx) {
  const o = ctx.opts;
  return runInstaller(ctx, 'install.mjs', 'runUpdate', { rollback: !!o.rollback, from: o.from });
}

export function cmdUninstall(ctx) {
  const o = ctx.opts;
  return runInstaller(ctx, 'uninstall.mjs', 'runUninstall', { purge: !!o.purge && !o['keep-vault'], dryRun: !!o['dry-run'], yes: !!o.yes });
}

// ───────── version ─────────

export async function cmdVersion(ctx) {
  ctx.out.result({ version: appVersion(), node: process.version }, `engram ${appVersion()}（Node ${process.version}）`);
}
