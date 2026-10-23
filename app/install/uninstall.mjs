// engram uninstall：依 local/install-steps.json 逐項還原到安裝前。
// 預設保留記憶庫（vault 是你的記憶）；加上 --purge 並再次確認，才會連 ~/.engram 一起刪除。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { engramHome, claudeHome as defaultClaudeHome, localPaths } from '../src/cli/paths.mjs';
import { run } from '../src/cli/proc.mjs';
import { readSteps, claudeEnv, npmCliPath } from './install.mjs';
import { removeApp } from './deploy.mjs';

const BEGIN = '<!-- engram:begin';
const END = '<!-- engram:end -->';

/** 從 CLAUDE.md 移除 Engram 管理區塊。檔案末尾正好是當初附加的內容時逐字移除，確保與安裝前完全相同。 */
export function stripBlock(text, appended) {
  if (appended && text.endsWith(appended)) return text.slice(0, -appended.length);
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END, start);
  if (start < 0 || end < 0) return text;
  let before = text.slice(0, start);
  const after = text.slice(end + END.length).replace(/^\r?\n/, '');
  if (before.endsWith('\n\n')) before = before.slice(0, -1);
  return before + after;
}

export function describeUninstall(rec, { purge }) {
  const lines = [];
  for (const s of [...rec.steps].reverse()) {
    if (s.kind === 'logon-task') lines.push(`停止常駐程式，刪除登入工作 ${s.name}`);
    if (s.kind === 'cli-link') lines.push('移除一般終端機的 engram 指令（npm 全域連結）');
    if (s.kind === 'plugin') lines.push(`移除 Claude Code 外掛 ${s.name}`);
    if (s.kind === 'marketplace') lines.push(`移除外掛來源 ${s.name}`);
    if (s.kind === 'claude-md') lines.push(`從 ${s.path} 移除 Engram 管理區塊（其餘內容不動）`);
  }
  lines.push('解除這台電腦的所有專案綁定：junction 換回一般資料夾並放回記憶檔，撤銷 Engram 加入的 additionalDirectories');
  lines.push(purge ? '刪除整個 ~/.engram（包含記憶庫）' : '保留記憶庫 ~/.engram/vault（之後重新安裝可直接沿用）');
  return lines;
}

/**
 * @param {{ home?, claudeHome?, purge?, yes?, dryRun?, engine? }} opts
 * @param {{ print: (s: string) => void, confirm: (q: string) => Promise<boolean> }} io
 */
export async function runUninstall(opts = {}, io) {
  const home = opts.home ?? engramHome();
  const claudeHome = opts.claudeHome ?? defaultClaudeHome();
  const rec = await readSteps(home);
  if (!rec) { io.print('這台電腦沒有 Engram 的安裝紀錄，不需要移除。'); return { ok: true, nothing: true }; }

  io.print('Engram 移除計畫：');
  describeUninstall(rec, opts).forEach((l, i) => io.print(`  ${i + 1}. ${l}`));
  if (opts.dryRun) return { ok: true, dryRun: true };
  if (!opts.yes && !(await io.confirm('要開始移除嗎？'))) return { ok: false, cancelled: true };

  const done = [];
  const env = claudeEnv(claudeHome);
  const has = (kind) => rec.steps.find((s) => s.kind === kind);

  // 1. 常駐程式與登入工作
  const hb = (() => { try { return JSON.parse(fs.readFileSync(localPaths(home).agentFile, 'utf8')); } catch { return null; } })();
  if (hb?.pid) { try { process.kill(hb.pid); done.push('stop-agent'); } catch { /* 已經結束 */ } }
  if (has('logon-task')) {
    const task = await import('../src/scheduler/task.mjs');
    await task.remove().catch(() => {});
    done.push('logon-task');
  }

  // 2. 終端機的 engram 指令：只移除指向 Engram 程式資料夾的那一個（使用者之後自己換掉的不動）
  if (has('cli-link')) {
    const exec = opts.run ?? run;
    const npmCli = npmCliPath();
    const prefix = npmCli ? (await exec(process.execPath, [npmCli, 'prefix', '-g']).catch(() => null))?.stdout?.trim() : null;
    let target = null;
    try { target = prefix ? fs.realpathSync(path.join(prefix, 'node_modules', has('cli-link').name)) : null; } catch { /* 已經不在 */ }
    const rel = target ? path.relative(path.join(home, 'app'), target) : '..';
    const ours = !rel.startsWith('..') && !path.isAbsolute(rel);
    if (ours) await exec(process.execPath, [npmCli, 'uninstall', '-g', has('cli-link').name], { timeoutMs: 120_000 }).catch(() => null);
    done.push('cli-link');
  }

  // 3. 外掛與來源
  if (has('plugin')) {
    await run('claude', ['plugin', 'uninstall', has('plugin').name, '--scope', 'user'], { env, timeoutMs: 60_000 }).catch(() => null);
    done.push('plugin');
  }
  if (has('marketplace')) {
    await run('claude', ['plugin', 'marketplace', 'remove', has('marketplace').name], { env, timeoutMs: 60_000 }).catch(() => null);
    done.push('marketplace');
  }

  // 4. 解除綁定（junction → 實體資料夾）與撤銷 additionalDirectories
  if (fs.existsSync(path.join(home, 'vault', '.git'))) {
    const engine = opts.engine ?? await import('../src/core/index.mjs');
    const eg = await engine.open({ home, claudeHome });
    const r = await eg.releaseMachine();
    io.print(`✓ 已解除 ${r.released.length} 個綁定，撤銷 ${r.revokedPaths?.length ?? 0} 筆 additionalDirectories`);
    done.push('release-machine');
  }

  // 5. 工作準則若曾同步進 vault（41 號 §11），先逐字放回 ~/.claude/CLAUDE.md，否則它只會留在 vault 裡
  if (fs.existsSync(path.join(home, 'vault', '.git'))) {
    const engine = opts.engine ?? await import('../src/core/index.mjs');
    const eg = await engine.open({ home, claudeHome });
    const g = await eg.core?.guidelines?.preview?.().catch(() => null);
    if (g?.adopted) { await eg.core.guidelines.revert(); io.print('✓ 已把工作準則放回 ~/.claude/CLAUDE.md'); done.push('guidelines'); }
  }

  // 6. CLAUDE.md 管理區塊
  const md = has('claude-md');
  if (md && fs.existsSync(md.path)) {
    const text = await fsp.readFile(md.path, 'utf8');
    const next = stripBlock(text, md.appended);
    if (md.createdFile && next.trim() === '') await fsp.rm(md.path);
    else if (next !== text) await fsp.writeFile(md.path, next);
    io.print(`✓ 已從 ${md.path} 移除 Engram 管理區塊`);
    done.push('claude-md');
  }

  // 7. 部署的程式複本（開發模式沒有複本，不動工作樹）
  if (has('app') && !has('app').dev) { await removeApp(home); done.push('app'); }
  await fsp.rm(path.join(home, 'local', 'app-dir'), { force: true });

  // 8. 本機紀錄或整個 ~/.engram
  if (opts.purge) {
    const sure = opts.yes || await io.confirm(`確定要刪除 ${home}（包含記憶庫）嗎？GitHub 上的 engram-vault 不受影響。`);
    if (sure) { await fsp.rm(home, { recursive: true, force: true, maxRetries: 3 }); done.push('purge'); io.print(`✓ 已刪除 ${home}`); }
  } else {
    await fsp.rm(path.join(home, 'local', 'install.json'), { force: true });
    rec.uninstalledAt = new Date().toISOString();
    rec.steps = [];
    await fsp.writeFile(path.join(home, 'local', 'install-steps.json'), JSON.stringify(rec, null, 2));
    io.print(`記憶庫保留在 ${path.join(home, 'vault')}。`);
  }
  io.print('移除完成。');
  return { ok: true, done, host: os.hostname() };
}
