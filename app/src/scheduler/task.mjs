// 唯一的工作排程器工作 \Engram\Agent：登入時啟動常駐程式、失敗自動重啟、使用電池時也執行（ADR §07）。
// 以 schtasks.exe /Create /XML 匯入（XML 需為 UTF-16 LE 加 BOM）。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../cli/errors.mjs';
import { writeFileAtomic } from '../cli/fsutil.mjs';
import { APP_DIR } from '../cli/paths.mjs';
import { run } from '../cli/proc.mjs';

export const TASK_NAME = '\\Engram\\Agent';
export const LAUNCHERS = Object.freeze(['wscript', 'conhost', 'direct']);

// launch-hidden.js（純 WSH JScript，不含 VBScript）：wscript.exe //B //Nologo launch-hidden.js <node.exe> <engram.mjs> agent
// 以 WScript.Shell.Run(命令, 0, true) 啟動：視窗樣式 0＝隱藏，不閃主控台；bWaitOnReturn=true＝等待 node 結束，
// 工作會一直保持「執行中」；常駐程式以非 0 結束時，WScript.Quit 把結束碼傳回，RestartOnFailure 才會觸發。
// 該檔刻意只用 ASCII、不寫註解：WSH 以系統字碼頁（CP950）讀 .js，UTF-8 中文會吃掉換行，整支腳本變成什麼都不做（已實測）。

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function currentUserId(env = process.env) {
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME || os.userInfo().username;
}

/**
 * 依啟動器決定要執行的程式與參數。
 * - wscript（預設）：WSH 的 JScript 以視窗樣式 0 啟動 node，完全不閃主控台；淘汰的是 VBScript 引擎，不是 JScript。
 * - conhost：conhost.exe --headless，備案。
 * - direct：直接執行 node.exe，最後手段（可能閃出主控台）。
 */
export function buildAction({ launcher = 'wscript', nodePath = process.execPath, appDir = APP_DIR, systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const bin = path.join(appDir, 'bin', 'engram.mjs');
  switch (launcher) {
    case 'wscript':
      return {
        command: path.join(systemRoot, 'System32', 'wscript.exe'),
        args: `//B //Nologo "${path.join(appDir, 'src', 'scheduler', 'launch-hidden.js')}" "${nodePath}" "${bin}" agent`,
      };
    case 'conhost':
      return { command: path.join(systemRoot, 'System32', 'conhost.exe'), args: `--headless "${nodePath}" "${bin}" agent` };
    case 'direct':
      return { command: nodePath, args: `"${bin}" agent` };
    default:
      throw new CliError('E_USAGE', `不認得的啟動器：${launcher}`, `可用的啟動器：${LAUNCHERS.join('、')}。`);
  }
}

/** 產生工作排程器 XML（純函式，方便測試）。 */
export function buildTaskXml({ userId = currentUserId(), launcher = 'wscript', nodePath, appDir = APP_DIR, systemRoot } = {}) {
  const action = buildAction({ launcher, nodePath, appDir, systemRoot });
  const user = escapeXml(userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Engram 憶跡常駐程式：登入時啟動，提供管理介面（http://127.0.0.1:4777/）與背景同步。</Description>
    <URI>${escapeXml(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(action.command)}</Command>
      <Arguments>${escapeXml(action.args)}</Arguments>
      <WorkingDirectory>${escapeXml(appDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks /XML 要求 UTF-16 LE 加 BOM；換行統一為 CRLF。 */
export function encodeTaskXml(xml) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml.replace(/\r?\n/g, '\r\n'), 'utf16le')]);
}

export const createArgs = (xmlFile) => ['/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F'];
export const deleteArgs = () => ['/Delete', '/TN', TASK_NAME, '/F'];
export const queryArgs = () => ['/Query', '/TN', TASK_NAME, '/XML'];

/** 從工作 XML 的 <Command> 判斷啟動器 */
export function launcherFromXml(xml) {
  const cmd = /<Command>([^<]*)<\/Command>/i.exec(xml)?.[1]?.toLowerCase() ?? '';
  if (cmd.includes('wscript')) return 'wscript';
  if (cmd.includes('conhost')) return 'conhost';
  return cmd ? 'direct' : null;
}

export async function install({ launcher = 'wscript', appDir, exec = run } = {}) {
  const xml = buildTaskXml(appDir ? { launcher, appDir } : { launcher }); // 啟動器不正確時在這裡就丟 E_USAGE
  const file = path.join(os.tmpdir(), `engram-agent-task-${process.pid}.xml`);
  await writeFileAtomic(file, encodeTaskXml(xml));
  try {
    const r = await exec('schtasks.exe', createArgs(file), { encoding: 'latin1' });
    if (r.code !== 0) {
      throw new CliError('E_SCHTASKS', `建立登入工作失敗（schtasks 結束碼 ${r.code}）`, '確認可以使用工作排程器；公司電腦可能被群組原則限制。也可以改用 --launcher conhost 再試一次。');
    }
  } finally {
    await fsp.rm(file, { force: true });
  }
  return { ok: true, task: TASK_NAME, launcher };
}

export async function remove({ exec = run } = {}) {
  const r = await exec('schtasks.exe', deleteArgs(), { encoding: 'latin1' });
  return { ok: r.code === 0, task: TASK_NAME, removed: r.code === 0 };
}

// 查狀態用 PowerShell 的 ScheduledTasks 模組：輸出不受系統語系影響（schtasks 的欄位與日期是在地化的）
const INFO_SCRIPT = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$t=Get-ScheduledTask -TaskPath '\\Engram\\' -TaskName 'Agent'
$i=$t | Get-ScheduledTaskInfo
$last=$null; if($i.LastRunTime -and $i.LastRunTime.Year -gt 2000){$last=$i.LastRunTime.ToUniversalTime().ToString('o')}
[pscustomobject]@{state=[string]$t.State; lastRunAt=$last; lastResult=$i.LastTaskResult} | ConvertTo-Json -Compress`;

const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** 查詢登入工作：{ installed, state, launcher, lastRunAt, lastResult }。查不到時 installed=false。 */
export async function status({ exec = run } = {}) {
  const none = { installed: false, state: null, launcher: null, lastRunAt: null, lastResult: null };
  const q = await exec('schtasks.exe', queryArgs(), { encoding: 'latin1', timeoutMs: 10_000 }).catch(() => null);
  if (!q || q.code !== 0) return none;
  const result = { ...none, installed: true, state: 'unknown', launcher: launcherFromXml(q.stdout) };
  const ps = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(INFO_SCRIPT)], { timeoutMs: 15_000 }).catch(() => null);
  try {
    const info = JSON.parse(ps?.stdout ?? '');
    result.state = String(info.state ?? 'unknown').toLowerCase();
    result.lastRunAt = info.lastRunAt ?? null;
    result.lastResult = info.lastResult ?? null;
  } catch {
    // PowerShell 不可用時只回報已安裝
  }
  return result;
}
