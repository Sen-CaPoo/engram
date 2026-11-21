// 量測 SessionStart hook 的時間花在哪（2.0.0 S5）。不進 npm test：node tools/bench-session-start.mjs [次數，預設 20]
// 在暫存資料夾建一個有一定規模的假 Engram（全域 70 筆、單機 15 筆、專案 40 筆），用外掛的 hooks/run.mjs 啟動新的 node 程序，
// 分別量：Node 本身啟動、外殼模組載入、引擎模組載入、open()、sessionContext()（和 run.mjs 一樣開 V8 編譯快取），
// 以及完整路徑與快速路徑各 N 次的整體時間（輸出寫出來的時間與程序結束的時間分開列：Claude Code 等的是程序結束）。
// 不會碰到真正的 ~/.engram 或 ~/.claude。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { init, open } from '../src/core/index.mjs';
import { addTranscript, ageTree, machinePaths, makeRepo, memoryText, mkTmp, rmTmp } from '../test/core/helpers.mjs';

const APP = fileURLToPath(new URL('../', import.meta.url));
const RUN = path.join(APP, 'plugin', 'hooks', 'run.mjs');
const N = Number(process.argv[2]) || 20;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (xs) => `中位數 ${median(xs).toFixed(0)} ms（最小 ${Math.min(...xs).toFixed(0)}、最大 ${Math.max(...xs).toFixed(0)}，${xs.length} 次）`;

function spawnTimed(args, { env, input } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, args, { env, windowsHide: true });
    let out = '';
    let err = '';
    let firstOut = null;
    child.stdout.on('data', (d) => {
      firstOut ??= performance.now() - t0;
      out += d;
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err, ms: performance.now() - t0, firstOut }));
    child.stdin.end(input ?? '');
  });
}

async function repeat(n, fn) {
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(await fn(i));
  return xs;
}

const root = mkTmp('engram-bench-');
try {
  const m = machinePaths(root, 'pc');
  await init({ ...m, machineLabel: '量測電腦' });
  const eg = await open(m);
  const proj = makeRepo(path.join(root, 'work', 'demo-app'));
  const tr = addTranscript(m.claudeHome, proj, { ageMs: 0 });

  // 一定規模的假記憶
  const vault = eg.paths.vault;
  const write = (dir, i, prefix, type, extra = '') => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${prefix}-${String(i).padStart(3, '0')}.md`), memoryText({
      name: `${prefix}-${i}`, type, description: `測試用的${prefix}記憶第 ${i} 筆：說明這件事怎麼做、為什麼`,
      body: `${'這是一段測試用的內文，描述某個工具的設定步驟與踩過的坑。'.repeat(20)}\n`, extra,
    }));
  };
  for (let i = 0; i < 70; i++) write(path.join(vault, 'global'), i, 'global', i % 5 === 0 ? 'feedback' : 'reference');
  await eg.identity.bind(proj, { create: { name: 'Demo' } });
  const pid = (await eg.sessionContext({ cwd: proj, sessionId: 'bench-bind', transcriptPath: tr.file })).binding?.pid;
  if (!pid) throw new Error('沒有綁定成功');
  for (let i = 0; i < 40; i++) write(path.join(vault, 'projects', pid, 'memory'), i, 'proj', 'project');
  for (let i = 0; i < 15; i++) write(path.join(vault, 'machines', eg.machine.id), i, 'machine', 'reference', i < 3 ? `  engram:\n    project: ${pid}\n` : '');
  ageTree(vault);
  await eg.sync({ network: false });

  const home = m.home;
  const local = path.join(home, 'local');
  fs.writeFileSync(path.join(local, 'install.json'), JSON.stringify({ appDir: APP }));
  // 常駐程式在跑、剛同步過：hook 不會啟動常駐程式，也不會送請求
  const beat = () => fs.writeFileSync(path.join(local, 'agent.json'), JSON.stringify({ pid: 999_999, port: 9, token: 'x', beatAt: new Date().toISOString(), lastSyncAt: new Date().toISOString() }));
  beat();
  const env = { ...process.env, ENGRAM_HOME: home, CLAUDE_HOME: m.claudeHome };
  delete env.ENGRAM_HEADLESS;
  const input = JSON.stringify({ session_id: tr.sessionId, transcript_path: tr.file, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });

  // 量測用的小腳本（在暫存資料夾）；和 run.mjs 一樣開 V8 編譯快取
  const probe = path.join(root, 'probe.mjs');
  fs.writeFileSync(probe, `
import module from 'node:module';
import { performance } from 'node:perf_hooks';
const [what, app, cwd, sid, tp, cacheDir] = process.argv.slice(2);
try { module.enableCompileCache?.(cacheDir); } catch {}
const u = (p) => new URL(p, 'file:///' + app.replace(/\\\\/g, '/').replace(/\\/+$/, '') + '/').href;
const t = {};
let t0 = performance.now();
await import(u('src/hooks/index.mjs')); t.shell = performance.now() - t0; t0 = performance.now();
const core = await import(u('src/core/index.mjs')); t.engine = performance.now() - t0;
t0 = performance.now();
const eg = await core.open({ home: process.env.ENGRAM_HOME, claudeHome: process.env.CLAUDE_HOME }); t.open = performance.now() - t0;
t0 = performance.now();
await eg.sessionContext({ cwd, sessionId: sid, transcriptPath: tp }); t.context = performance.now() - t0;
process.stdout.write(JSON.stringify(t));
`);
  const v8 = path.join(local, 'cache', 'v8');

  console.log(`SessionStart 量測（${N} 次；假 Engram：全域 70、單機 15、專案 40 筆；V8 編譯快取開啟）`);
  const bare = await repeat(N, () => spawnTimed(['-e', ''], { env }).then((r) => r.ms));
  console.log(`  Node 啟動（node -e ""）：${fmt(bare)}`);

  const parts = { shell: [], engine: [], open: [], context: [] };
  for (let i = 0; i < N + 1; i++) {
    const r = await spawnTimed([probe, 'context', APP, proj, `bench-${i}`, tr.file, v8], { env });
    if (i === 0) continue; // 第一次在建編譯快取
    const t = JSON.parse(r.out || '{}');
    for (const k of Object.keys(parts)) if (t[k] !== undefined) parts[k].push(t[k]);
  }
  console.log(`  外殼模組載入（hooks/index.mjs）：${fmt(parts.shell)}`);
  console.log(`  引擎模組載入（core/index.mjs）：${fmt(parts.engine)}`);
  console.log(`  open()：${fmt(parts.open)}`);
  console.log(`  sessionContext()：${fmt(parts.context)}`);

  const cache = path.join(local, 'cache', 'session', 'state.json');
  const runHook = async () => {
    beat();
    const r = await spawnTimed([RUN, 'session-start'], { env, input });
    if (r.code !== 0 || !r.out) throw new Error(`hook 失敗：${r.err || r.out}`);
    return r;
  };
  const report = (label, rs) => {
    console.log(`  ${label}，輸出寫出：${fmt(rs.map((r) => r.firstOut))}`);
    console.log(`  ${label}，程序結束：${fmt(rs.map((r) => r.ms))}`);
  };
  // 完整路徑：沒有預先寫好的快取
  await runHook();
  const full = await repeat(N, async () => { fs.rmSync(cache, { force: true }); return runHook(); });
  report('整個 hook，完整路徑', full);
  fs.rmSync(cache, { force: true });
  const fullText = (await runHook()).out;

  // 快速路徑：常駐程式預先寫好的快取（引擎有提供時）
  // 寫快取的是常駐程式：和 hook 一樣用 ENGRAM_HOME、CLAUDE_HOME 開引擎（家目錄是這台電腦真的家目錄，路徑的 ~ 寫法才會一樣）
  const agentEngine = await open({ home: m.home, claudeHome: m.claudeHome });
  if (typeof agentEngine.sessionCache?.write === 'function') {
    await agentEngine.sessionCache.write();
    const fast = await repeat(N, () => runHook());
    report('整個 hook，快速路徑', fast);
    const fastText = (await runHook()).out;
    console.log(`  兩條路徑的輸出${fastText === fullText ? '一字不差' : '不同！'}`);
    if (fastText !== fullText) console.log({ fullText, fastText });
  } else {
    console.log('  （引擎還沒有快速路徑的快取）');
  }
} finally {
  rmTmp(root);
}
