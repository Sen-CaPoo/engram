// 環境健檢與兩台差異（2.0.0 R1、R5）：用沙盒的假 claudeHome 與假家目錄建各種情況。
// 指紋只有名稱、版本、雜湊、數量與耗時，不含家目錄、設定值與金鑰；每一種發現；自動修先備份、只動 Engram 的項目；兩台差異。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { init, open } from '../../src/core/index.mjs';
import { allowJunctionRead, revokeAll } from '../../src/core/claudesettings.mjs';
import { createJunction } from '../../src/core/fsx.mjs';
import { attributeHook, canonCommand, claudeMdInfo, compareVersions, gcCards, hookEntries, publishFingerprint } from '../../src/core/envhealth.mjs';
import { scanSecrets } from '../../src/core/secrets.mjs';
import { git, machinePaths, mkTmp, rmTmp, writeDriverCli } from './helpers.mjs';

const DAY = 86_400_000;
// 組出來的假金鑰（原始碼裡不放完整字串，避免被金鑰掃描擋下）
const FAKE_KEY = ['sk', 'ant', 'api03', 'Zq8Lm3Xv9Tn2Wb7Yc4Rd1Hf6Jg5Ks0PaEuIoQ'].join('-');
const NO_ENV = () => [];

/** 沙盒：一台假電腦（引擎、claudeHome、假家目錄都在暫存資料夾） */
async function sandbox(name = 'office') {
  const root = mkTmp();
  const m = machinePaths(root, name);
  await init({ ...m, machineLabel: '公司電腦', userName: 'Tester', cli: writeDriverCli(root) });
  const eg = await open(m);
  const claude = m.claudeHome;
  const put = (rel, body) => {
    const p = path.join(claude, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    return p;
  };
  const settingsPath = path.join(claude, 'settings.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const patchSettings = (fn) => { const s = readSettings(); fn(s); fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2)); };
  const installPlugin = ({ name, marketplace = 'mkt', version = '1.0.0', hooks, daysAgo = 60 }) => {
    const installPath = path.join(claude, 'plugins', 'cache', marketplace, name, version);
    fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    if (hooks) fs.writeFileSync(path.join(installPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks }));
    const f = path.join(claude, 'plugins', 'installed_plugins.json');
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { version: 2, plugins: {} };
    const at = new Date(Date.now() - daysAgo * DAY).toISOString();
    cur.plugins[`${name}@${marketplace}`] = [{ scope: 'user', installPath, version, installedAt: at, lastUpdated: at }];
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cur));
    return installPath;
  };
  const removePlugin = (key) => {
    const f = path.join(claude, 'plugins', 'installed_plugins.json');
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete cur.plugins[key];
    fs.writeFileSync(f, JSON.stringify(cur));
  };
  let n = 0;
  const transcript = (lines, { ageMs = 0 } = {}) => {
    const file = put(`projects/C--demo-proj/s-${++n}.jsonl`, `${lines.join('\n')}\n`);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
    return file;
  };
  const refresh = (o = {}) => eg.env.findings({ refresh: true, userEnvNames: NO_ENV, ...o });
  const codes = async (o) => (await refresh(o)).map((f) => f.code);
  return { root, m, eg, ctx: eg._ctx, claude, home: m.userHome, put, settingsPath, readSettings, patchSettings, installPlugin, removePlugin, transcript, refresh, codes, done: () => rmTmp(root) };
}

const hookLine = ({ event = 'PostToolUse', command, ms, at = Date.now() }) => JSON.stringify({ type: 'attachment', timestamp: new Date(at).toISOString(), attachment: { type: 'hook_success', hookEvent: event, hookName: `${event}:Bash`, command, durationMs: ms, exitCode: 0 } });
const toolLine = ({ name, input = {}, at = Date.now() }) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', id: 't1', name, input }] } });
const slashLine = ({ command, at = Date.now() }) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { content: `<command-name>${command}</command-name>` } });

describe('純函式', () => {
  test('claudeMdInfo：標記區塊（START／BEGIN、標記內可有說明）、沒有結尾的不算、雜湊不含 Engram 自己的區塊', () => {
    const text = '# 我的準則\n\n<!-- ALPHA:START -->\n甲\n<!-- ALPHA:END -->\n\n<!-- beta:begin 由外掛管理 -->\n乙\n<!-- beta:END -->\n\n<!-- GAMMA:START -->\n沒有結尾\n';
    const info = claudeMdInfo(text, Date.parse('2026-11-01T00:00:00Z'));
    assert.deepEqual(info.blocks.map((b) => b.name), ['ALPHA', 'beta']);
    assert.equal(info.bytes, Buffer.byteLength(text));
    assert.equal(info.modified, '2026-11-01');
    const a = claudeMdInfo('x\n<!-- engram:begin · 由 Engram 管理（公司電腦 a） -->\n@a\n<!-- engram:end -->\n').hash;
    const b = claudeMdInfo('x\n<!-- engram:begin · 由 Engram 管理（家裡電腦 b） -->\n@b\n<!-- engram:end -->\n').hash;
    assert.equal(a, b, 'Engram 區塊每台電腦的電腦名稱不同，不算差異');
    assert.notEqual(a, claudeMdInfo('y\n<!-- engram:begin -->\n@a\n<!-- engram:end -->\n').hash, '其他內容不同就是不同');
  });

  test('hookEntries：事件、比對條件、同步或背景', () => {
    const list = hookEntries({
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh' }, { type: 'command', command: 'b.sh', async: true }] }],
      Stop: [{ hooks: [{ type: 'prompt' }] }],
      Bad: 'nope',
    });
    assert.deepEqual(list.map((h) => [h.event, h.matcher, h.mode, h.type, h.command]), [
      ['PostToolUse', 'Bash', 'sync', 'command', 'a.sh'], ['PostToolUse', 'Bash', 'async', 'command', 'b.sh'], ['Stop', '', 'sync', 'prompt', ''],
    ]);
    assert.deepEqual(hookEntries(null), []);
  });

  test('canonCommand 與 attributeHook：展開後的路徑、原樣的 ${CLAUDE_PLUGIN_ROOT}、外掛換版本後的路徑都對得回去；對不上是來源不明', () => {
    const root = 'C:\\h\\.claude\\plugins\\cache\\mkt\\tele\\1.0.0';
    const cfg = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/send-telemetry.js"';
    const reg = [
      { source: 'tele@mkt', event: 'PostToolUse', mode: 'sync', raw: canonCommand(cfg), exp: canonCommand(cfg, root), tail: canonCommand('/hooks/send-telemetry.js"'), segment: '/mkt/tele/' },
      { source: 'settings', event: 'Stop', mode: 'async', raw: canonCommand('echo done'), exp: canonCommand('echo done'), tail: null },
    ];
    const expanded = 'node "C:\\h\\.claude\\plugins\\cache\\mkt\\tele\\1.0.0\\hooks\\send-telemetry.js"';
    assert.deepEqual(attributeHook(reg, 'PostToolUse', expanded), { source: 'tele@mkt', mode: 'sync' });
    assert.deepEqual(attributeHook(reg, 'PostToolUse', cfg), { source: 'tele@mkt', mode: 'sync' }, '紀錄裡是原樣的樣板');
    assert.deepEqual(attributeHook(reg, 'PostToolUse', expanded.replace('1.0.0', '1.1.0').replace('1.0.0', '1.1.0')), { source: 'tele@mkt', mode: 'sync' }, '外掛更新後，舊紀錄是舊版本的路徑');
    assert.deepEqual(attributeHook(reg, 'Stop', 'echo done'), { source: 'settings', mode: 'async' });
    assert.deepEqual(attributeHook(reg, 'SessionStart', expanded), { source: null, mode: 'unknown' }, '事件不同');
    assert.deepEqual(attributeHook(reg, 'PostToolUse', 'python other.py'), { source: null, mode: 'unknown' });
    // 只有結尾相符不夠：路徑要含「/市集/外掛名/」；對到兩個以上來源就不挑一個
    assert.deepEqual(attributeHook(reg, 'PostToolUse', 'node "C:\\h\\.claude\\plugins\\cache\\other\\thing\\1.0.0\\hooks\\send-telemetry.js"'), { source: null, mode: 'unknown' });
    const twin = [...reg, { ...reg[0], source: 'tele2@mkt', segment: '/mkt/tele/' }];
    assert.deepEqual(attributeHook(twin, 'PostToolUse', expanded), { source: null, mode: 'unknown' });
  });

  test('compareVersions', () => {
    assert.equal(compareVersions('2.1.329', '2.1.322'), 1);
    assert.equal(compareVersions('1.6.0-abc1234', '1.6.0'), 0);
    assert.equal(compareVersions('1.5.9', '1.6.0'), -1);
    assert.ok(Number.isNaN(compareVersions('（沒有版本）', '1.0.0')));
  });

  test('gcCards：gc.pid 過期或零散物件超過 2,000 個才出發現，只出發現（auto、沒有 fix）', () => {
    assert.deepEqual(gcCards({ stalePid: false, loose: 2000 }), []);
    for (const input of [{ stalePid: true, loose: 10 }, { stalePid: false, loose: 2001 }]) {
      const [c] = gcCards(input);
      assert.equal(c.code, 'H29');
      assert.equal(c.severity, 'auto');
      assert.equal(c.fix, undefined);
      assert.ok(c.en.title && c.en.detail);
    }
    assert.match(gcCards({ stalePid: true, loose: 2500 })[0].detail, /gc\.pid.*2500/);
  });
});

describe('環境指紋', () => {
  test('內容：版本、設定鍵與 env 鍵名、外掛與 hook、技能代理指令、CLAUDE.md；不含家目錄、設定值、金鑰', async () => {
    const s = await sandbox();
    try {
      assert.ok(scanSecrets(FAKE_KEY).length, '前提：假金鑰會被偵測到');
      s.installPlugin({ name: 'alpha', version: '1.2.0', hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/log.js"', async: true }] }] } });
      s.patchSettings((c) => {
        c.theme = 'dark';
        c.cleanupPeriodDays = 45;
        c.env = { FOO_MODE: 'private-setting-value-123', MY_API_KEY: FAKE_KEY };
        c.enabledPlugins = { 'alpha@mkt': true, 'beta@mkt': false };
        c.hooks = { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${s.home}\\tools\\log.js" --token=${FAKE_KEY}`, async: true }] }] };
      });
      s.put('skills/s-one/SKILL.md', '# 技能一\n');
      s.put('skills/s-one/extra/notes.txt', '備註');
      s.put('skills/s-two/SKILL.md', '# 技能二\n');
      fs.mkdirSync(path.join(s.root, 'elsewhere'), { recursive: true });
      createJunction(path.join(s.root, 'elsewhere'), path.join(s.claude, 'skills', 's-linked'));
      s.put('agents/helper.md', '# 代理');
      s.put('commands/hello.md', '# 指令');
      s.put('CLAUDE.md', `# 準則\n<!-- XYZ:START -->\n內容\n<!-- XYZ:END -->\n${await s.eg.claudeMdBlock()}`);

      const fp = await s.eg.env.fingerprint({ refresh: true, claudeVersion: '2.1.329', userEnvNames: NO_ENV });
      assert.equal(fp.v, 1);
      assert.equal(fp.claudeCode.version, '2.1.329');
      assert.equal(fp.engram.version, s.eg.version);
      assert.deepEqual(fp.settings.keys, ['cleanupPeriodDays', 'enabledPlugins', 'env', 'hooks', 'permissions', 'theme']);
      assert.deepEqual(fp.settings.envKeys, ['FOO_MODE', 'MY_API_KEY'], '只有鍵名');
      assert.deepEqual(fp.settings.enabledPlugins, { 'alpha@mkt': true, 'beta@mkt': false });
      assert.equal(fp.settings.cleanupPeriodDays, 45);
      assert.equal(fp.settings.hooks.length, 1);
      assert.equal(fp.settings.hooks[0].event, 'PostToolUse');
      assert.equal(fp.settings.hooks[0].matcher, 'Bash');
      assert.equal(fp.settings.hooks[0].mode, 'async');
      assert.ok(fp.settings.hooks[0].command.startsWith('node "~\\tools\\log.js"'), `家目錄換成 ~：${fp.settings.hooks[0].command}`);
      assert.ok(fp.settings.hooks[0].command.length <= 80);
      assert.deepEqual(fp.plugins.map((p) => [p.name, p.marketplace, p.version]), [['alpha', 'mkt', '1.2.0']]);
      assert.deepEqual(fp.plugins[0].hooks.map((h) => [h.event, h.matcher, h.mode]), [['PostToolUse', '*', 'async']]);
      const skills = Object.fromEntries(fp.skills.map((x) => [x.name, x]));
      assert.deepEqual(Object.keys(skills).sort(), ['s-linked', 's-one', 's-two']);
      assert.equal(skills['s-one'].files, 2);
      assert.match(skills['s-one'].hash, /^[0-9a-f]{40}$/);
      assert.notEqual(skills['s-one'].hash, skills['s-two'].hash);
      assert.deepEqual([skills['s-linked'].link, skills['s-linked'].hash], [true, null], '連結不穿越，只記有連結');
      assert.deepEqual(fp.agents.map((x) => [x.name, x.files]), [['helper', 1]]);
      assert.deepEqual(fp.commands.map((x) => [x.name, x.files]), [['hello', 1]]);
      assert.deepEqual(fp.claudeMd.blocks.map((b) => b.name), ['XYZ', 'engram']);

      const text = JSON.stringify(fp);
      for (const bad of [s.home, s.home.replace(/\\/g, '/'), JSON.stringify(s.home).slice(1, -1), s.root, 'private-setting-value-123', FAKE_KEY]) {
        assert.ok(!text.includes(bad), `指紋不該含 ${bad.slice(0, 30)}`);
      }
      assert.deepEqual(scanSecrets(text), [], '整份指紋沒有疑似金鑰');
      assert.ok(fp.settings.hooks[0].command.includes('已遮蔽'), '指令裡的假金鑰被遮蔽');
    } finally { s.done(); }
  });

  test('hook 耗時：近 7 天的次數、中位數、總耗時；對回外掛與同步／背景；超過 7 天的不算；來源不明的保留', async () => {
    const s = await sandbox();
    try {
      const root = s.installPlugin({ name: 'tele', hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/send.js"' }] }] } });
      const cmd = `node "${path.join(root, 'hooks', 'send.js')}"`;
      s.transcript([
        ...[1200, 1300, 1100, 1250, 1150, 1400].map((ms) => hookLine({ command: cmd, ms })),
        hookLine({ command: cmd, ms: 9000, at: Date.now() - 10 * DAY }),
        hookLine({ event: 'SessionStart', command: 'python mystery.py', ms: 80 }),
        'not json {"hook_success"',
      ]);
      const fp = await s.eg.env.fingerprint({ refresh: true, claudeVersion: '2.1.329', userEnvNames: NO_ENV });
      assert.equal(fp.hookStats.windowDays, 7);
      const tele = fp.hookStats.hooks.find((h) => h.source === 'tele@mkt');
      assert.deepEqual([tele.event, tele.mode, tele.runs, tele.medianMs, tele.totalMs], ['PostToolUse', 'sync', 6, 1225, 7400]);
      assert.ok(tele.command.startsWith('node "~'), `指令遮蔽家目錄：${tele.command}`);
      const unknown = fp.hookStats.hooks.find((h) => h.source === null);
      assert.deepEqual([unknown.event, unknown.mode, unknown.runs], ['SessionStart', 'unknown', 1]);
    } finally { s.done(); }
  });

  test('Claude Code 版本：沒有指定時讀最近的對話紀錄裡的 version', async () => {
    const s = await sandbox();
    try {
      s.transcript([JSON.stringify({ type: 'user', version: '2.1.322', cwd: 'C:/demo', message: { content: 'hi' } })]);
      assert.equal((await s.eg.env.fingerprint({ refresh: true, userEnvNames: NO_ENV })).claudeCode.version, '2.1.322');
    } finally { s.done(); }
  });

  test('快取：36 小時內直接回傳，refresh 才重新掃描', async () => {
    const s = await sandbox();
    try {
      const a = await s.eg.env.fingerprint({ claudeVersion: '2.1.1', userEnvNames: NO_ENV });
      s.put('skills/new-skill/SKILL.md', '# x');
      assert.deepEqual(await s.eg.env.fingerprint(), a, '沒有 refresh 用快取');
      assert.ok((await s.eg.env.fingerprint({ refresh: true, userEnvNames: NO_ENV })).skills.some((x) => x.name === 'new-skill'));
    } finally { s.done(); }
  });
});

describe('同步的指紋（machines/<mid>/env.json）', () => {
  test('run：內容有變才寫並 commit，沒變不寫；改了技能再寫；檔案不含家目錄', async () => {
    const s = await sandbox();
    try {
      s.put('skills/s-one/SKILL.md', '# 一');
      const rel = `machines/${s.eg.machine.id}/env.json`;
      const commits = () => git(s.eg.paths.vault, 'log', '--format=%s', '--', rel).split('\n').filter(Boolean);
      const r1 = await s.eg.env.run({ claudeVersion: '2.1.329', userEnvNames: NO_ENV });
      assert.equal(r1.written, true);
      assert.equal(commits().length, 1);
      assert.match(commits()[0], /env fingerprint/);
      const raw = fs.readFileSync(path.join(s.eg.paths.vault, ...rel.split('/')), 'utf8');
      assert.ok(!raw.includes(s.home) && !raw.includes(s.root));
      assert.equal(JSON.parse(raw).claudeCode.version, '2.1.329');
      const r2 = await s.eg.env.run({ claudeVersion: '2.1.329', userEnvNames: NO_ENV });
      assert.equal(r2.written, false, '內容沒變不寫');
      assert.equal(commits().length, 1);
      s.put('skills/s-one/SKILL.md', '# 一（改過）');
      assert.equal((await s.eg.env.run({ claudeVersion: '2.1.329', userEnvNames: NO_ENV })).written, true);
      assert.equal(commits().length, 2);
    } finally { s.done(); }
  });

  test('publishFingerprint：偵測到疑似金鑰就不寫進記憶庫', async () => {
    const s = await sandbox();
    try {
      const rel = `machines/${s.eg.machine.id}/env.json`;
      const r = await publishFingerprint(s.ctx, { v: 1, updated: '2026-11-20', note: `api_key: ${FAKE_KEY}` });
      assert.equal(r.written, false);
      assert.ok(r.blocked.length);
      assert.ok(!fs.existsSync(path.join(s.eg.paths.vault, ...rel.split('/'))));
      assert.equal(git(s.eg.paths.vault, 'log', '--format=%s', '--', rel).trim(), '');
    } finally { s.done(); }
  });

  test('envHealth 為 off 時 run 不做事', async () => {
    const s = await sandbox();
    try {
      await s.eg.settings.set({ envHealth: 'off' });
      assert.deepEqual(await s.eg.env.run({ userEnvNames: NO_ENV }), { ok: true, skipped: 'off' });
      assert.ok(!fs.existsSync(path.join(s.eg.paths.vault, 'machines', s.eg.machine.id, 'env.json')));
    } finally { s.done(); }
  });
});

describe('發現與自動修', () => {
  test('H25：同步 hook 近 7 天中位數超過 500 毫秒（列出外掛、事件、累計時間）；背景的、不到 500、次數太少的不算；來源不明的另出一張低嚴重度、標明無法確認', async () => {
    const s = await sandbox();
    try {
      const slow = s.installPlugin({ name: 'tele', hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/send.js"' }] }] } });
      const bg = s.installPlugin({ name: 'quiet', hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/bg.js"', async: true }] }] } });
      const fast = s.installPlugin({ name: 'speedy', hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/f.js"' }] }] } });
      const few = s.installPlugin({ name: 'rare', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/r.js"' }] }] } });
      // Engram 自己的 hook 再慢也不出卡片（建議是關閉遙測或停用外掛，對自己不適用）
      const self = s.installPlugin({ name: 'engram', marketplace: 'engram-local', hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs" x' }] }] } });
      const c = (root, f) => `node "${path.join(root, 'hooks', f)}"`;
      s.transcript([
        ...Array.from({ length: 6 }, () => hookLine({ command: `${c(self, 'run.mjs')} x`, ms: 900 })),
        ...Array.from({ length: 6 }, () => hookLine({ command: c(slow, 'send.js'), ms: 1200 })),
        ...Array.from({ length: 6 }, () => hookLine({ command: c(bg, 'bg.js'), ms: 2000 })),
        ...Array.from({ length: 6 }, () => hookLine({ command: c(fast, 'f.js'), ms: 300 })),
        ...Array.from({ length: 3 }, () => hookLine({ event: 'Stop', command: c(few, 'r.js'), ms: 5000 })),
        ...Array.from({ length: 8 }, () => hookLine({ command: 'python mystery.py', ms: 3000 })),
      ]);
      const list = (await s.refresh()).filter((f) => f.code === 'H25');
      assert.equal(list.length, 2);
      const unknown = list.find((x) => x.severity === 'low');
      assert.match(unknown.title, /1 個來源不明的 hook 偏慢，無法確認是否同步執行/);
      assert.match(unknown.detail, /python mystery\.py/);
      assert.match(unknown.en.title, /unknown origin/);
      assert.doesNotMatch(unknown.detail, /tele@mkt|quiet|speedy|rare/);
      const f = list.find((x) => x.severity === 'medium');
      assert.equal(f.fix, undefined, '只建議，沒有自動修');
      assert.match(f.title, /tele@mkt/);
      assert.match(f.detail, /PostToolUse 每次約 1\.2 秒/);
      assert.match(f.detail, /累計 7 秒/);
      assert.match(f.en.title, /tele@mkt/);
      assert.match(f.en.detail, /1\.2 s/);
    } finally { s.done(); }
  });

  test('H26：只移除 Engram 加的、已不存在的路徑；先備份 settings.json；使用者自己加的不動；id 要對得上', async () => {
    const s = await sandbox();
    try {
      const alive = path.join(s.claude, 'projects', 'C--alive', 'memory');
      const dead = path.join(s.claude, 'projects', 'C--dead', 'memory');
      fs.mkdirSync(alive, { recursive: true });
      fs.mkdirSync(dead, { recursive: true });
      await allowJunctionRead(s.ctx.homes, alive);
      await allowJunctionRead(s.ctx.homes, dead);
      const mine = path.join(s.root, 'users-own-missing-dir');
      s.patchSettings((c) => { c.permissions.additionalDirectories.push(mine, '~/also-missing'); });
      assert.deepEqual((await s.refresh()).filter((f) => f.code === 'H26'), [], '都還在，沒有發現');
      fs.rmSync(dead, { recursive: true });
      const [f] = (await s.refresh()).filter((x) => x.code === 'H26');
      assert.equal(f.severity, 'auto');
      assert.equal(f.fix.action, 'env-fix');
      assert.ok(f.detail.includes('C--dead') && !f.detail.includes('users-own-missing-dir') && !f.detail.includes(s.root), '只列 Engram 加的，家目錄換成 ~');
      const before = fs.readFileSync(s.settingsPath, 'utf8');
      await assert.rejects(s.eg.apply({ action: 'env-fix', args: { id: 'H26:0000000000' } }), (e) => e.code === 'E_NOT_FOUND');
      const r = await s.eg.apply(f.fix);
      assert.equal(r.ok, true);
      assert.equal(r.removed, 1);
      assert.equal(fs.readFileSync(path.join(r.backup, 'settings.json'), 'utf8'), before, '修改前的內容原樣備份');
      const list = s.readSettings().permissions.additionalDirectories;
      assert.ok(list.some((p) => p.includes('C--alive')));
      assert.ok(!list.some((p) => p.includes('C--dead')));
      assert.ok(list.includes(mine) && list.includes('~/also-missing'), '使用者自己的項目保留');
      assert.deepEqual((await s.eg.env.findings()).filter((x) => x.code === 'H26'), []);
    } finally { s.done(); }
  });

  test('H27：記憶連結指向這個記憶庫、但這台沒有綁定紀錄；有綁定、或連結指向別處的不算', async () => {
    const s = await sandbox();
    try {
      const target = path.join(s.eg.paths.vault, 'projects', 'demo-1', 'memory');
      fs.mkdirSync(target, { recursive: true });
      const other = path.join(s.root, 'not-the-vault');
      fs.mkdirSync(other, { recursive: true });
      createJunction(target, path.join(s.claude, 'projects', 'C--orphan', 'memory'));
      createJunction(other, path.join(s.claude, 'projects', 'C--elsewhere', 'memory'));
      const [f] = (await s.refresh()).filter((x) => x.code === 'H27');
      assert.equal(f.severity, 'medium');
      assert.equal(f.fix, undefined);
      assert.match(f.detail, /C--orphan/);
      assert.doesNotMatch(f.detail, /C--elsewhere/);
      const bf = path.join(s.eg.paths.vault, 'machines', s.eg.machine.id, 'bindings.json');
      fs.writeFileSync(bf, JSON.stringify({ 'C--orphan': { pid: 'demo-1', path: 'C:\\orphan', encoded: 'C--orphan', method: 'junction', state: 'active' } }));
      assert.deepEqual((await s.refresh()).filter((x) => x.code === 'H27'), []);
    } finally { s.done(); }
  });

  test('H28：~/.claude.json 的專案條目指向不存在的資料夾（報數量與比例）；只報告、不提供修正，檔案一個位元組都不動（Claude Code 執行中會整個寫回）', async () => {
    const s = await sandbox();
    try {
      const file = path.join(path.dirname(s.claude), '.claude.json');
      const real = Array.from({ length: 3 }, (_, i) => { const p = path.join(s.root, `real-${i}`); fs.mkdirSync(p); return p; });
      const gone = Array.from({ length: 12 }, (_, i) => path.join(s.root, `gone-${i}`));
      const projects = Object.fromEntries([...real, ...gone].map((p, i) => [p.replace(/\\/g, '/'), { allowedTools: [], n: i }]));
      const text = `${JSON.stringify({ numStartups: 7, userID: 'abc', projects, tips: { a: 1 } }, null, 2)}\n`;
      fs.writeFileSync(file, text);
      const [f] = (await s.refresh()).filter((x) => x.code === 'H28');
      assert.equal(f.severity, 'low');
      assert.match(f.title, /12 個專案條目/);
      assert.match(f.detail, /15 個專案條目，其中 12 個（80%）/);
      assert.match(f.detail, /不影響使用/);
      assert.match(f.en.detail, /do not affect anything/);
      assert.ok(!f.detail.includes(s.root), '只報數量與比例');
      assert.equal(f.fix, undefined, '沒有修正按鈕');
      for (const o of [undefined, { isIdle: async () => true }]) {
        await assert.rejects(s.eg.env.fix(f.id, o), (e) => e.code === 'E_INVALID' && /只能提醒/.test(e.message));
      }
      const run = await s.eg.env.run({ userEnvNames: NO_ENV, isIdle: async () => true });
      assert.ok(!(run.fixed ?? []).includes('H28'));
      assert.equal(fs.readFileSync(file, 'utf8'), text, '怎麼都不會動它');
      assert.ok((await s.eg.env.findings()).some((x) => x.code === 'H28'), '卡片留給使用者看');
    } finally { s.done(); }
  });

  test('H28：少於 10 個不提醒', async () => {
    const s = await sandbox();
    try {
      fs.writeFileSync(path.join(path.dirname(s.claude), '.claude.json'), JSON.stringify({ projects: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [path.join(s.root, `gone-${i}`), {}])) }));
      assert.ok(!(await s.codes()).includes('H28'));
    } finally { s.done(); }
  });

  test('H29：gc.pid 過期（超過 12 小時、程序已不在）才出發現；交給 gc 工作，fix 只回報委派', async () => {
    const s = await sandbox();
    try {
      const pidFile = path.join(s.eg.paths.vault, '.git', 'gc.pid');
      assert.ok(!(await s.codes()).includes('H29'));
      fs.writeFileSync(pidFile, '99999999 someone');
      assert.ok(!(await s.codes()).includes('H29'), '剛寫的不算過期');
      const old = new Date(Date.now() - 13 * 3_600_000);
      fs.utimesSync(pidFile, old, old);
      const [f] = (await s.refresh()).filter((x) => x.code === 'H29');
      assert.equal(f.severity, 'auto');
      assert.equal(f.fix, undefined);
      const r = await s.eg.env.fix(f.id);
      assert.deepEqual([r.ok, r.delegated], [false, 'gc']);
      fs.writeFileSync(pidFile, `${process.pid} someone`);
      fs.utimesSync(pidFile, old, old);
      assert.ok(!(await s.codes()).includes('H29'), '程序還在就不是過期的');
    } finally { s.done(); }
  });

  test('H30：已停用或已移除的外掛在 CLAUDE.md 留有標記區塊（只提醒）；外掛啟用中不算', async () => {
    const s = await sandbox();
    try {
      s.installPlugin({ name: 'alpha-tool' });
      s.installPlugin({ name: 'gamma' });
      s.put('CLAUDE.md', '<!-- ALPHA-TOOL:START -->\n甲\n<!-- ALPHA-TOOL:END -->\n<!-- GAMMA:START -->\n丙\n<!-- GAMMA:END -->\n');
      assert.ok(!(await s.codes()).includes('H30'), '都啟用中');
      s.patchSettings((c) => { c.enabledPlugins = { 'alpha-tool@mkt': false }; });
      let [f] = (await s.refresh()).filter((x) => x.code === 'H30');
      assert.equal(f.severity, 'low');
      assert.equal(f.fix, undefined);
      assert.match(f.detail, /ALPHA-TOOL（外掛 alpha-tool 已停用）/);
      assert.doesNotMatch(f.detail, /GAMMA/);
      s.patchSettings((c) => { c.enabledPlugins = {}; });
      assert.ok(!(await s.codes()).includes('H30'));
      s.removePlugin('gamma@mkt');
      [f] = (await s.refresh()).filter((x) => x.code === 'H30');
      assert.match(f.detail, /GAMMA（外掛 gamma 已移除）/, '曾經裝過、現在不見了');
    } finally { s.done(); }
  });

  test('H31：~/.claude 裡含明文金鑰的設定檔與金鑰資料夾、名稱像金鑰的使用者環境變數（只列名稱）；Claude Code 自己的憑證檔不算', async () => {
    const s = await sandbox();
    try {
      assert.ok(!(await s.codes()).includes('H31'));
      s.put('settings.work.json', { env: { ANTHROPIC_AUTH_TOKEN: FAKE_KEY } });
      s.put('.credentials.json', { claudeAiOauth: { accessToken: FAKE_KEY } });
      s.put('keys/note.txt', 'x');
      const list = (await s.refresh({ userEnvNames: () => ['PATH', 'MY_SERVICE_TOKEN', 'HOME', 'db_password'] })).filter((x) => x.code === 'H31');
      assert.equal(list.length, 2);
      const files = list.find((x) => x.refs[0] === 'env:secret-files');
      const names = list.find((x) => x.refs[0] === 'env:secret-env');
      assert.equal(files.severity, 'medium');
      assert.match(files.detail, /settings\.work\.json/);
      assert.match(files.detail, /keys\//);
      assert.doesNotMatch(files.detail, /credentials/);
      assert.match(names.detail, /MY_SERVICE_TOKEN/);
      assert.match(names.detail, /db_password/);
      assert.doesNotMatch(names.detail, /PATH|HOME/);
      for (const f of list) {
        assert.equal(f.fix, undefined, '只提醒');
        assert.ok(!JSON.stringify(f).includes(FAKE_KEY), '不含金鑰');
      }
    } finally { s.done(); }
  });

  test('H32：沒有設定 cleanupPeriodDays → 一鍵設成 60（先備份、只新增這個鍵）；解除安裝逐位元還原；已經有設定就沒有發現', async () => {
    const s = await sandbox();
    try {
      const original = fs.readFileSync(s.settingsPath, 'utf8');
      const [f] = (await s.refresh()).filter((x) => x.code === 'H32');
      assert.equal(f.severity, 'low');
      assert.equal(f.fix.args.id, f.id);
      const r = await s.eg.env.fix(f.id);
      assert.deepEqual([r.ok, r.changed, r.days], [true, true, 60]);
      assert.equal(fs.readFileSync(path.join(r.backup, 'settings.json'), 'utf8'), original);
      assert.deepEqual(s.readSettings(), { ...JSON.parse(original), cleanupPeriodDays: 60 });
      assert.ok(!(await s.codes()).includes('H32'));
      const manifest = JSON.parse(fs.readFileSync(path.join(s.eg.paths.local, 'install-manifest.json'), 'utf8'));
      assert.deepEqual(manifest.settingKeys, [{ key: 'cleanupPeriodDays', value: 60 }], '記進安裝清單');
      await revokeAll(s.ctx.homes);
      assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), original, '解除安裝後與原本一字不差');
    } finally { s.done(); }
  });

  test('H32（R-F）：自動修用逐位元寫入：BOM、CRLF、4 空格縮排、鍵的順序都維持，只在最後多一個 cleanupPeriodDays；解除安裝逐位元還原', async () => {
    const s = await sandbox();
    try {
      const original = `﻿${JSON.stringify({ theme: 'light', permissions: { allow: ['Bash(ls)'] } }, null, 4).replace(/\n/g, '\r\n')}\r\n`;
      fs.writeFileSync(s.settingsPath, original);
      await s.eg.settings.set({ autopilot: 'on' });
      const r = await s.eg.env.run({ claudeVersion: '2.1.329', userEnvNames: NO_ENV, isIdle: async () => true });
      assert.deepEqual(r.fixed, ['H32']);
      const expected = `﻿${JSON.stringify({ theme: 'light', permissions: { allow: ['Bash(ls)'] }, cleanupPeriodDays: 60 }, null, 4).replace(/\n/g, '\r\n')}\r\n`;
      assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), expected);
      await revokeAll(s.ctx.homes);
      assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), original);
    } finally { s.done(); }
  });

  test('H32：排版不是標準格式（手排的緊湊陣列）時不自動修、也沒有修正按鈕，只出卡片；檔案不動', async () => {
    const s = await sandbox();
    try {
      const hand = '{\n  "permissions": { "allow": ["Bash(ls)", "Bash(pwd)"] }\n}\n';
      fs.writeFileSync(s.settingsPath, hand);
      await s.eg.settings.set({ autopilot: 'on' });
      const r = await s.eg.env.run({ claudeVersion: '2.1.329', userEnvNames: NO_ENV, isIdle: async () => true });
      assert.deepEqual(r.fixed, []);
      const [f] = (await s.eg.env.findings({ refresh: true, userEnvNames: NO_ENV })).filter((x) => x.code === 'H32');
      assert.equal(f.fix, undefined);
      assert.match(f.detail, /排版不是標準格式/);
      assert.match(f.en.detail, /not in the standard layout/);
      await assert.rejects(s.eg.env.fix(f.id), (e) => e.code === 'E_INVALID');
      assert.equal(fs.readFileSync(s.settingsPath, 'utf8'), hand);
    } finally { s.done(); }
  });

  test('H32：使用者設過的值不覆蓋；run 只在自動駕駛開啟時自動設定', async () => {
    const s = await sandbox();
    try {
      await s.eg.env.run({ userEnvNames: NO_ENV });
      assert.equal(s.readSettings().cleanupPeriodDays, undefined, '自動駕駛關閉：不自動設');
      await s.eg.settings.set({ autopilot: 'on' });
      const r = await s.eg.env.run({ userEnvNames: NO_ENV });
      assert.deepEqual(r.fixed, ['H32']);
      assert.equal(s.readSettings().cleanupPeriodDays, 60);
      s.patchSettings((c) => { c.cleanupPeriodDays = 90; });
      assert.ok(!(await s.codes()).includes('H32'));
      await assert.rejects(s.eg.env.fix('H32:0000000000'), (e) => e.code === 'E_NOT_FOUND');
      await revokeAll(s.ctx.homes);
      assert.equal(s.readSettings().cleanupPeriodDays, 90, '使用者後來改過的值，解除安裝不動');
    } finally { s.done(); }
  });

  test('H33：近 30 天沒被使用過的外掛（只提醒）；用過、剛裝的、停用的、有 hook 的、對話紀錄留不到 30 天的不算', async () => {
    const s = await sandbox();
    try {
      s.installPlugin({ name: 'idle-one', daysAgo: 90 });
      s.installPlugin({ name: 'used-mcp', daysAgo: 90 });
      s.installPlugin({ name: 'used-skill', daysAgo: 90 });
      s.installPlugin({ name: 'used-slash', daysAgo: 90 });
      s.installPlugin({ name: 'new-one', daysAgo: 5 });
      s.installPlugin({ name: 'off-one', daysAgo: 90 });
      s.installPlugin({ name: 'hooked', daysAgo: 90, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
      s.patchSettings((c) => { c.enabledPlugins = { 'off-one@mkt': false }; });
      s.transcript([
        toolLine({ name: 'mcp__plugin_used-mcp_server__do_it' }),
        toolLine({ name: 'Skill', input: { skill: 'used-skill:run' } }),
        slashLine({ command: '/used-slash:go' }),
        toolLine({ name: 'Skill', input: { skill: 'plain-skill' } }),
      ]);
      const [f] = (await s.refresh()).filter((x) => x.code === 'H33');
      assert.equal(f.severity, 'low');
      assert.equal(f.fix, undefined);
      assert.deepEqual(f.refs, ['plugin:idle-one@mkt']);
      assert.match(f.detail, /idle-one@mkt/);
      s.patchSettings((c) => { c.cleanupPeriodDays = 7; });
      assert.ok(!(await s.codes()).includes('H33'), '對話紀錄只留 7 天，看不出 30 天沒用過');
      s.patchSettings((c) => { c.cleanupPeriodDays = 60; });
      fs.rmSync(path.join(s.claude, 'projects'), { recursive: true });
      assert.ok(!(await s.codes()).includes('H33'), '沒有任何對話紀錄時不判斷');
    } finally { s.done(); }
  });

  test('健康檢查只讀快取（沒掃描前沒有環境卡片），併入 eg.health()；envHealth 為 off 時不併入', async () => {
    const s = await sandbox();
    try {
      assert.ok(!(await s.eg.health()).some((f) => f.code === 'H32'), '還沒掃描過：不即時算');
      await s.refresh();
      const h = (await s.eg.health()).filter((f) => f.code === 'H32');
      assert.equal(h.length, 1);
      assert.equal(h[0].fix.action, 'env-fix');
      await s.eg.settings.set({ envHealth: 'off' });
      assert.ok(!(await s.eg.health()).some((f) => f.code === 'H32'));
      await s.eg.settings.set({ envHealth: 'on' });
      await s.eg.findings.dismiss(h[0].id);
      assert.ok(!(await s.eg.health()).some((f) => f.code === 'H32'), '忽略沿用既有機制');
    } finally { s.done(); }
  });

  test('設定 envHealth：預設 on，只接受 on 或 off', async () => {
    const s = await sandbox();
    try {
      assert.equal((await s.eg.settings.get()).envHealth, 'on');
      assert.equal((await s.eg.settings.set({ envHealth: 'off' })).envHealth, 'off');
      await assert.rejects(s.eg.settings.set({ envHealth: 'maybe' }), (e) => e.code === 'E_INVALID' && /envHealth/.test(e.en.message));
    } finally { s.done(); }
  });
});

describe('兩台差異', () => {
  const fp = (o = {}) => ({
    v: 1, updated: '2026-11-20', claudeCode: { version: o.claude ?? '2.1.329' }, engram: { version: o.engram ?? '1.6.0', commit: null },
    settings: { present: true, keys: o.keys ?? ['env', 'theme'], envKeys: o.envKeys ?? ['A_MODE'], enabledPlugins: {}, hooks: [], cleanupPeriodDays: null },
    plugins: o.plugins ?? [{ name: 'alpha', marketplace: 'mkt', version: '1.2.0', hooks: [] }],
    skills: o.skills ?? [{ name: 's1', files: 1, hash: 'a'.repeat(40), modified: '2026-11-01' }],
    agents: [], commands: [],
    claudeMd: o.claudeMd ?? { bytes: 10, hash: 'h1', modified: '2026-11-01', blocks: [{ name: 'engram', bytes: 5, hash: 'e1' }, { name: 'XYZ', bytes: 5, hash: 'x1' }] },
    hookStats: { windowDays: 7, hooks: [] },
  });
  const writeMachine = (s, mid, label, data) => {
    const dir = path.join(s.eg.paths.vault, 'machines', mid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ id: mid, label }));
    if (data) fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify(data));
  };

  test('版本、外掛、技能、CLAUDE.md、標記區塊、設定鍵、env 鍵名：哪裡不一樣、哪一邊比較新', async () => {
    const s = await sandbox();
    try {
      const self = s.eg.machine.id;
      writeMachine(s, self, '公司電腦', fp());
      fs.writeFileSync(path.join(s.eg.paths.vault, 'machines', self, 'env.json'), JSON.stringify(fp()));
      writeMachine(s, 'laptop-1', '筆電', fp({
        claude: '2.1.322', engram: '1.6.1',
        plugins: [{ name: 'alpha', marketplace: 'mkt', version: '1.3.0', hooks: [] }, { name: 'beta', marketplace: 'mkt', version: '0.1.0', hooks: [] }],
        skills: [{ name: 's1', files: 1, hash: 'b'.repeat(40), modified: '2026-11-10' }, { name: 's2', files: 1, hash: 'c'.repeat(40), modified: '2026-11-10' }],
        claudeMd: { bytes: 12, hash: 'h2', modified: '2026-11-12', blocks: [{ name: 'engram', bytes: 5, hash: 'DIFFERENT-LABEL' }, { name: 'XYZ', bytes: 6, hash: 'x2' }, { name: 'OTHER', bytes: 3, hash: 'o1' }] },
        keys: ['env', 'model'], envKeys: ['A_MODE', 'B_MODE'],
      }));
      writeMachine(s, 'old-pc', '舊電腦', null);
      const d = await s.eg.env.diff();
      assert.equal(d.compared, 2);
      assert.deepEqual(d.machines.map((m) => [m.mid, m.label, m.hasEnv]), [[self, '公司電腦', true], ['laptop-1', '筆電', true], ['old-pc', '舊電腦', false]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
      const by = Object.fromEntries(d.items.map((i) => [`${i.area}:${i.key}`, i]));
      assert.deepEqual(Object.keys(by).sort(), [
        'claude-code:Claude Code', 'claude-md-block:OTHER', 'claude-md-block:XYZ', 'claude-md:CLAUDE.md', 'engram:Engram', 'env-key:B_MODE',
        'plugin:alpha@mkt', 'plugin:beta@mkt', 'setting-key:model', 'setting-key:theme', 'skill:s1', 'skill:s2',
      ].sort());
      assert.equal(by['claude-code:Claude Code'].newer, self);
      assert.equal(by['claude-code:Claude Code'].kind, 'version');
      assert.equal(by['engram:Engram'].newer, 'laptop-1');
      assert.equal(by['plugin:alpha@mkt'].newer, 'laptop-1');
      assert.equal(by['plugin:beta@mkt'].kind, 'missing');
      assert.deepEqual(by['plugin:beta@mkt'].values, { [self]: null, 'laptop-1': '0.1.0' });
      assert.equal(by['skill:s1'].kind, 'hash');
      assert.equal(by['skill:s1'].newer, 'laptop-1', '沒有版本號就比修改日期');
      assert.equal(by['skill:s2'].kind, 'missing');
      assert.equal(by['claude-md:CLAUDE.md'].newer, 'laptop-1');
      assert.equal(by['claude-md-block:XYZ'].kind, 'hash');
      assert.equal(by['claude-md-block:OTHER'].kind, 'missing');
      assert.ok(!Object.keys(by).includes('claude-md-block:engram'), 'Engram 自己的區塊不算差異');
      assert.match(by['plugin:alpha@mkt'].summary, /外掛「alpha@mkt」版本不同.*公司電腦：1\.2\.0.*筆電：1\.3\.0.*筆電 比較新|外掛「alpha@mkt」版本不同.*筆電：1\.3\.0.*公司電腦：1\.2\.0.*筆電 比較新/);
      assert.match(by['plugin:alpha@mkt'].en.summary, /Plugin "alpha@mkt" has different versions.*newer/);
    } finally { s.done(); }
  });

  test('兩台完全一致時沒有差異；只有一台有指紋時不比較', async () => {
    const s = await sandbox();
    try {
      const self = s.eg.machine.id;
      writeMachine(s, self, '公司電腦', fp());
      assert.deepEqual((await s.eg.env.diff()).items, []);
      assert.equal((await s.eg.env.diff()).compared, 1);
      writeMachine(s, 'laptop-1', '筆電', fp({ claudeMd: { bytes: 99, hash: 'h1', modified: '2026-11-01', blocks: [{ name: 'engram', bytes: 5, hash: 'other-label' }, { name: 'XYZ', bytes: 5, hash: 'x1' }] } }));
      const d = await s.eg.env.diff();
      assert.equal(d.compared, 2);
      assert.deepEqual(d.items, []);
    } finally { s.done(); }
  });
});
