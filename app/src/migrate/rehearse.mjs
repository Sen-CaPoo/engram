// 匯入演練：在隔離的沙盒裡完整跑一次「匯入 → 驗證 → 還原」，全程不碰真實的 ~/.claude 與 ~/.engram。
// 用途有二：匯入精靈在真正套用前先演練一次；以及 22 號匯入計畫的送審證據（claude-57 的要求）。
//
// 沙盒內容：
//   <sandbox>/.claude/projects/<編碼>/memory/**   真實記憶的完整複本
//   <sandbox>/.claude/projects/<編碼>/*.jsonl     對話紀錄只複製開頭 64 KB（引擎只讀開頭找 cwd 與 sessionId），保留原本的修改時間
//   <sandbox>/.engram/                            全新的 vault（沒有遠端）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { applyEdits } from './plan.mjs';
import { bindingSelfTest } from './selftest.mjs';

const HEAD_BYTES = 64 * 1024;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

const git = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: GIT_ENV, windowsHide: true, encoding: 'utf8' }).trim();
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 列出真實 ~/.claude/projects 底下所有記憶檔與其雜湊（junction 不列入，因為那已經是 Engram 管的）。 */
export function fingerprintLegacy(claudeHome) {
  const root = path.join(claudeHome, 'projects');
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const enc of fs.readdirSync(root)) {
    const mem = path.join(root, enc, 'memory');
    if (!fs.existsSync(mem) || isLink(mem)) continue;
    for (const f of fs.readdirSync(mem)) {
      const p = path.join(mem, f);
      if (fs.statSync(p).isFile()) out[`${enc}/${f}`] = sha256(p);
    }
  }
  return out;
}

/** 建立沙盒：完整複製記憶、截取對話紀錄開頭。回傳複製統計。 */
export function buildSandbox(realClaude, sandboxClaude) {
  const stats = { projects: 0, memoryFiles: 0, transcripts: 0, transcriptBytes: 0 };
  const src = path.join(realClaude, 'projects');
  fs.mkdirSync(path.join(sandboxClaude, 'projects'), { recursive: true });
  for (const name of ['CLAUDE.md', 'settings.json']) {
    const p = path.join(realClaude, name);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(sandboxClaude, name));
  }
  if (!fs.existsSync(src)) return stats;
  for (const enc of fs.readdirSync(src)) {
    const from = path.join(src, enc);
    if (!fs.statSync(from).isDirectory()) continue;
    const to = path.join(sandboxClaude, 'projects', enc);
    fs.mkdirSync(to, { recursive: true });
    stats.projects++;
    const mem = path.join(from, 'memory');
    if (fs.existsSync(mem) && !isLink(mem)) {
      fs.cpSync(mem, path.join(to, 'memory'), { recursive: true, preserveTimestamps: true });
      stats.memoryFiles += fs.readdirSync(mem).length;
    }
    for (const f of fs.readdirSync(from)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(from, f);
      const st = fs.statSync(p);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      fs.writeFileSync(path.join(to, f), buf);
      fs.utimesSync(path.join(to, f), st.atime, st.mtime);
      stats.transcripts++;
      stats.transcriptBytes += buf.length;
    }
  }
  return stats;
}

/**
 * 執行演練。
 * @param {{ engine: { init: Function, open: Function }, realClaude: string, sandbox: string, machineLabel?: string, edits?: object }} o
 *   edits：使用者在精靈裡做的調整（見 plan.mjs），演練時套用在沙盒重新產生的計畫上
 */
export async function rehearse({ engine, realClaude, sandbox, machineLabel = '演練電腦', edits, swept = null }) {
  const t0 = Date.now();
  const report = { startedAt: new Date().toISOString(), sandbox, steps: [] };
  const step = (name, data) => { report.steps.push({ name, ms: Date.now() - t0, ...data }); };

  const before = fingerprintLegacy(realClaude);
  step('真實記憶指紋', { files: Object.keys(before).length });

  const sandboxClaude = path.join(sandbox, '.claude');
  const home = path.join(sandbox, '.engram');
  step('建立沙盒', buildSandbox(realClaude, sandboxClaude));
  const sandboxBefore = fingerprintLegacy(sandboxClaude);

  await engine.init({ home, claudeHome: sandboxClaude, machineLabel });
  const eg = await engine.open({ home, claudeHome: sandboxClaude });
  const vault = eg.paths.vault;
  const preHead = git(vault, ['rev-parse', 'HEAD']);
  step('建立 vault', { vault, preHead });
  // 這台電腦已經收編過哪些檔案（不含匯入紀錄）：計畫會跳過已收編、沒變的檔案，演練要和精靈看到的計畫一致
  if (swept && Object.keys(swept).length) fs.writeFileSync(path.join(eg.paths.local, 'sweep.json'), JSON.stringify(swept, null, 2));

  const plan = applyEdits(await eg.sweepLegacy({ dryRun: true }), edits);
  report.plan = { totals: plan.totals, sources: plan.sources };
  step('產生計畫', plan.totals);

  const result = await eg.sweepLegacy({ dryRun: false, plan, bindSources: false });
  report.result = { copied: result.copied, skipped: result.skipped, sources: result.sources, commits: result.commits.length };
  step('套用計畫（不綁定，不碰任何專案資料夾）', report.result);

  // 驗證一：每一筆都有去處
  const vaultFiles = git(vault, ['ls-files', 'global', 'machines', 'projects']).split('\n').filter((f) => f.endsWith('.md') && !/(^|\/)(MEMORY|INDEX)\.md$/.test(f));
  const planned = plan.sources.flatMap((s) => s.items);
  const skipped = (i) => i.action === 'skip-same' || i.action === 'superseded';
  report.accounting = {
    planned: planned.length,
    copyPlanned: planned.filter((i) => !skipped(i)).length,
    skipPlanned: planned.filter(skipped).length,
    vaultMemoryFiles: vaultFiles.length,
    byScope: {
      global: vaultFiles.filter((f) => f.startsWith('global/')).length,
      machine: vaultFiles.filter((f) => f.startsWith('machines/')).length,
      project: vaultFiles.filter((f) => f.startsWith('projects/')).length,
    },
  };
  report.accounting.ok = report.accounting.vaultMemoryFiles === report.accounting.copyPlanned;
  step('驗證：每筆都有去處', report.accounting);

  const findings = await eg.health();
  report.health = findings.filter((f) => f.severity !== 'auto').map((f) => ({ code: f.code, severity: f.severity, title: f.title, refs: f.refs?.length ?? 0 }));
  step('匯入後健康檢查', { findings: report.health.length });

  // 驗證二：還原演練，與正式的「還原到匯入前」同一套程式（eg.rollbackImport，R-51）；
  // vault 要與還原點零差異，沙盒裡的原始記憶也要與匯入前逐檔一致
  const rb = await eg.rollbackImport(result.restorePoint);
  const diff = git(vault, ['diff', '--stat', result.restorePoint, 'HEAD', '--', 'global', 'machines', 'projects']);
  const sandboxAfter = fingerprintLegacy(sandboxClaude);
  const legacyChanged = Object.keys({ ...sandboxBefore, ...sandboxAfter }).filter((k) => sandboxBefore[k] !== sandboxAfter[k]);
  report.restore = { ok: rb?.ok !== false && diff === '' && legacyChanged.length === 0, via: 'rollbackImport', reverted: result.commits.length, remainingDiff: diff, legacyChanged };
  step('還原演練（一鍵還原）', report.restore);

  // 驗證三：真實記憶完全沒被動到
  const after = fingerprintLegacy(realClaude);
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  report.realUntouched = { ok: changed.length === 0, changed };
  step('真實記憶未被修改', report.realUntouched);

  // 驗證四：綁定還原的自我測試（合成資料）；真實資料的演練不綁定，所以 junction 與設定檔綁定的還原在這裡驗證
  const selfDir = path.join(sandbox, 'selftest');
  fs.mkdirSync(selfDir, { recursive: true });
  report.selfTest = await bindingSelfTest({ engine, sandbox: selfDir });
  step('綁定還原自我測試（合成資料）', { ok: report.selfTest.ok, checks: report.selfTest.checks.length });

  report.ok = report.accounting.ok && report.restore.ok && report.realUntouched.ok && report.selfTest.ok;
  report.finishedAt = new Date().toISOString();
  report.ms = Date.now() - t0;
  return report;
}
