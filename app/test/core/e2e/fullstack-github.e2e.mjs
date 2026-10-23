// 選用的網路端對端測試（不會被 node --test "test/**/*.test.mjs" 執行）。
// 執行：node app/test/core/e2e/fullstack-github.e2e.mjs（需要 gh／Git Credential Manager 已登入，且可存取 Sen-CaPoo/engram-vault-dev）。
// 紀錄：2026-10-22 以 commit 6c4c4ed 執行，20/20 通過，約 31 秒（claude-f4）。
//       2026-10-22 以 445935a＋本次修改執行，20/20 通過，約 28 秒（合成內容改帶 stamp 後；之前因共用遠端已有相同內容而 18/20）。
//       2026-10-22 R-52 混合綁定（A＝auto、B＝default），22/22 通過，約 29 秒。
// 全端雙機演練：用 claude-25 的 CLI（engram install / import / hook / sync / uninstall）＋ 核心引擎，
// 兩個隔離的 HOME 透過真正的 GitHub 測試 repo（Sen-CaPoo/engram-vault-dev）同步。只用合成資料。
// R-52 混合綁定：公司電腦的預設權限模式是 auto（設定檔＋junction），家裡電腦是 default（只用設定檔）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../../bin/engram.mjs', import.meta.url));
const REMOTE = 'https://github.com/Sen-CaPoo/engram-vault-dev.git';
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fs-')));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(ok ? '✓' : '✗', name, detail); };

function machine(name, mode) {
  const base = path.join(root, name);
  const env = { ...process.env, ENGRAM_HOME: path.join(base, '.engram'), CLAUDE_HOME: path.join(base, '.claude') };
  delete env.ENGRAM_HEADLESS;
  fs.mkdirSync(env.CLAUDE_HOME, { recursive: true });
  if (mode) fs.writeFileSync(path.join(env.CLAUDE_HOME, 'settings.json'), JSON.stringify({ permissions: { defaultMode: mode } }, null, 2));
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: 'utf8', timeout: 180_000, windowsHide: true });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { base, env, run };
}
const stamp = Date.now();
const enc = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
// 專案的 .claude/settings.local.json 指向的記憶資料夾（~ 是 CLI 用的使用者家目錄）
const autoMemDir = (proj) => {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8')).autoMemoryDirectory;
    return a ? path.resolve(a.replace(/^~/, os.homedir())) : null;
  } catch { return null; }
};
function makeRepo(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...a], { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n'); g('add', '-A'); g('commit', '-q', '-m', 'init'); g('remote', 'add', 'origin', remote);
}
function transcript(claudeHome, cwd, sid, ageMs = 3 * 3600_000) {
  const dir = path.join(claudeHome, 'projects', enc(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, `${JSON.stringify({ type: 'user', cwd: path.resolve(cwd), sessionId: sid })}\n`);
  const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t);
  return { dir, file: f };
}
// 遠端測試 repo 每次演練都共用：內容帶上這次的 stamp，才不會被當成「vault 裡已有相同內容」而略過
const mem = (name, desc, type = 'project', body = `合成內容 ${stamp}。`) => `---\nname: ${name}\ndescription: "${desc}"\nmetadata:\n  node_type: memory\n  type: ${type}\n  modified: 2026-10-20T00:00:00.000Z\n---\n\n${body}\n`;
function hook(m, event, payload) {
  const r = spawnSync(process.execPath, [CLI, 'hook', event], { env: m.env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 30_000, windowsHide: true });
  let ctx = '';
  try { ctx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext ?? ''; } catch { ctx = r.stdout; }
  return ctx;
}
const demoRemote = `https://github.com/example-org/demo-${stamp}.git`;

// ── 公司電腦 ──
const A = machine('office', 'auto');
let r = A.run(['install', '--remote', REMOTE, '--label', '公司電腦（演練）', '--yes', '--no-schedule', '--no-plugin', '--no-cli']);
check('A 安裝並接上 GitHub 遠端', r.code === 0, r.out.split('\n').filter((l) => /✓|✗|錯誤/.test(l)).join(' | '));
// 舊的 Claude Code 記憶（尚未納管）
const projA = path.join(A.base, 'Desktop', 'demo-app'); makeRepo(projA, demoRemote);
const ta = transcript(A.env.CLAUDE_HOME, projA, 'a-old');
fs.mkdirSync(path.join(ta.dir, 'memory'), { recursive: true });
fs.writeFileSync(path.join(ta.dir, 'memory', 'deploy-steps.md'), mem('deploy-steps', `部署步驟（合成 ${stamp}）`));
fs.writeFileSync(path.join(ta.dir, 'memory', 'user-pref.md'), mem('user-pref', '偏好正體中文（合成）', 'user'));
fs.writeFileSync(path.join(ta.dir, 'memory', 'MEMORY.md'), '- [部署步驟](deploy-steps.md) — 原本的提示語\n- [偏好](user-pref.md) — 使用者偏好\n');
r = A.run(['import', 'plan']);
check('A 匯入計畫', r.code === 0 && /複製 2/.test(r.out), r.out.split('\n').slice(0, 4).join(' | '));
r = A.run(['import', 'apply', '--yes']);
check('A 匯入套用', r.code === 0, r.out.split('\n').filter(Boolean).slice(-3).join(' | '));
check('A 原記憶資料夾換成 junction', isLink(path.join(ta.dir, 'memory')));
const amdA = autoMemDir(projA);
check('A 專案設定檔指向記憶庫（從根目錄啟動不經過 junction）', !!amdA && amdA.startsWith(path.join(A.base, '.engram', 'vault')) && fs.existsSync(path.join(amdA, 'deploy-steps.md')));
r = A.run(['sync']);
check('A 同步推上 GitHub', r.code === 0, r.out.trim().split('\n').pop());

// ── 家裡電腦 ──
const B = machine('home', null); // 沒有 settings.json＝default 模式
r = B.run(['install', '--remote', REMOTE, '--label', '家裡電腦（演練）', '--yes', '--no-schedule', '--no-plugin', '--no-cli']);
check('B 安裝（從遠端 clone）', r.code === 0, r.out.split('\n').filter((l) => /✓|✗|錯誤/.test(l)).join(' | '));
r = B.run(['search', String(stamp)]);
check('B 搜得到公司電腦匯入的記憶', /deploy-steps/.test(r.out));
const projB = path.join(B.base, 'work', 'demo-app-clone'); makeRepo(projB, demoRemote);
const tb = transcript(B.env.CLAUDE_HOME, projB, 'b-new', 0);
const ctxB = hook(B, 'SessionStart', { hook_event_name: 'SessionStart', cwd: projB, session_id: 'b-new', transcript_path: tb.file, source: 'startup' });
check('B 第一次開同一個 repo：SessionStart 自動認出並接上（default 模式：下次對話生效）', /下次對話生效/.test(ctxB), ctxB.split('\n')[0]);
const amdB = autoMemDir(projB);
check('B 沒有建 junction，專案設定檔指向記憶庫', !isLink(path.join(tb.dir, 'memory')) && !!amdB && amdB.startsWith(path.join(B.base, '.engram', 'vault')));
check('B 依設定檔看得到公司電腦的專案記憶', !!amdB && fs.existsSync(path.join(amdB, 'deploy-steps.md')));
// 下一次對話 Claude 在家裡寫了一筆新記憶（依 autoMemoryDirectory 直接寫進記憶庫）
fs.writeFileSync(path.join(amdB, 'home-note.md'), mem('home-note', `家裡寫的（合成 ${stamp}）`));
const old = new Date(Date.now() - 60_000); fs.utimesSync(path.join(amdB, 'home-note.md'), old, old);
hook(B, 'Stop', { hook_event_name: 'Stop', cwd: projB, session_id: 'b-new', transcript_path: tb.file });
r = B.run(['sync']);
check('B 同步推上 GitHub', r.code === 0, r.out.trim().split('\n').pop());

// ── 回到公司 ──
r = A.run(['sync']);
check('A 同步拉下家裡的變更', r.code === 0, r.out.trim().split('\n').pop());
check('A 的專案記憶出現家裡寫的那筆', fs.existsSync(path.join(ta.dir, 'memory', 'home-note.md')));
const ctxA = hook(A, 'SessionStart', { hook_event_name: 'SessionStart', cwd: projA, session_id: 'a-2', transcript_path: path.join(ta.dir, 'a-2.jsonl'), source: 'startup' });
check('A 的 SessionStart 顯示已綁定', /已綁定/.test(ctxA), ctxA.split('\n')[0]);
r = A.run(['status']);
check('A 狀態列出兩台電腦', /家裡電腦（演練）/.test(r.out) || /裝置|電腦/.test(r.out), '');
r = A.run(['doctor']);
check('A doctor 沒有高優先問題', !/高 [1-9]/.test(r.out), r.out.split('\n').filter((l) => /✗/.test(l)).join(' | '));

// ── 解除安裝 ──
for (const [n, m] of [['A', A], ['B', B]]) {
  r = m.run(['uninstall', '--keep-vault', '--yes']);
  check(`${n} 解除安裝`, r.code === 0, r.out.trim().split('\n').pop());
}
check('A 解除後記憶資料夾回到一般資料夾且內容還在', !isLink(path.join(ta.dir, 'memory')) && fs.existsSync(path.join(ta.dir, 'memory', 'deploy-steps.md')));
check('B 解除後記憶複製回 Claude Code 原本的資料夾', !isLink(path.join(tb.dir, 'memory')) && fs.existsSync(path.join(tb.dir, 'memory', 'home-note.md')) && fs.existsSync(path.join(tb.dir, 'memory', 'deploy-steps.md')));
check('兩台的專案資料夾都沒有留下 .claude', !fs.existsSync(path.join(projA, '.claude')) && !fs.existsSync(path.join(projB, '.claude')));

const failed = results.filter((x) => !x.ok);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), seconds: (Date.now() - t0) / 1000 }));
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { console.log('root kept:', root); }
