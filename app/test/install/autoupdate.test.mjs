// R2 自動更新：發佈端（vault/release.json）與接收端（每天檢查、條件都符合才更新）。
// 用暫存資料夾建假的 git 遠端與兩份複本（發佈端、接收端），真的跑 git 與部署；doctor、通知、重啟常駐程式用假的。
// 不碰真實的遠端、~/.engram 與 ~/.claude。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, doctorVerdict, normalizeRepo, parseRelease, publishRelease, realDoctor, restartAndVerify, runAutoUpdate, updateStatus } from '../../install/autoupdate.mjs';
import { activeVersion, currentDir, deploy, listVersions } from '../../install/deploy.mjs';
import { runInstall, runUpdate } from '../../install/install.mjs';
import { run } from '../../src/cli/proc.mjs';
import * as engine from '../../src/core/index.mjs';
import { git, machinePaths, makeBareRemote, mkTmp, rmTmp } from '../core/helpers.mjs';

const FULL = (c) => c.repeat(40).slice(0, 40);

/** 一份假的 Engram repo：app/package.json 帶版本，每個版本一個 commit 與標籤 v<版本> */
function bump(dir, version, { annotated = false, tag = true, pkgVersion = version } = {}) {
  fs.mkdirSync(path.join(dir, 'app', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'package.json'), `${JSON.stringify({ name: 'engram', version: pkgVersion })}\n`);
  fs.writeFileSync(path.join(dir, 'app', 'bin', 'engram.mjs'), `// ${version}\n`);
  fs.writeFileSync(path.join(dir, 'app', 'src', 'x.mjs'), `export const v = '${version}';\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `release ${version}`);
  if (tag) git(dir, ...(annotated ? ['tag', '-a', `v${version}`, '-m', `v${version}`] : ['tag', `v${version}`]));
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/**
 * 發佈端與接收端：origin（假的遠端）、pub（發佈端複本）、recv（接收端的來源複本）、home（接收端的 Engram home，已部署 1.0.0）。
 * 發佈端之後可以用 bump + push 發新版；接收端一開始只有 1.0.0。
 */
async function scenario(t) {
  const root = mkTmp('engram-autoupd-');
  t.after(() => rmTmp(root));
  const origin = makeBareRemote(path.join(root, 'origin.git'));
  const pub = path.join(root, 'publisher');
  fs.mkdirSync(pub, { recursive: true });
  git(pub, 'init', '-q', '-b', 'main');
  git(pub, 'config', 'user.name', 'Test');
  git(pub, 'config', 'user.email', 't@example.com');
  git(pub, 'remote', 'add', 'origin', origin);
  const c100 = bump(pub, '1.0.0');
  git(pub, 'push', '-q', 'origin', 'main', '--tags');
  const recv = path.join(root, 'receiver');
  git(root, 'clone', '-q', origin, recv);
  git(recv, 'config', 'user.name', 'Test');
  git(recv, 'config', 'user.email', 't@example.com');

  const home = path.join(root, '.engram');
  fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
  fs.mkdirSync(path.join(home, 'local'), { recursive: true });
  const d = await deploy(home, path.join(recv, 'app'));
  const writeInstall = (extra = {}) => fs.writeFileSync(path.join(home, 'local', 'install.json'), JSON.stringify({ appDir: currentDir(home), sourceDir: path.join(recv, 'app'), dev: false, version: activeVersion(home), installedAt: new Date().toISOString(), ...extra }));
  writeInstall();
  const sc = {
    root, origin, pub, recv, home, c100, first: d.version, writeInstall,
    releaseFile: path.join(home, 'vault', 'release.json'),
    /** 發佈端發一個新版並推上遠端；回傳 commit */
    release(version, o = {}) {
      const sha = bump(pub, version, o);
      git(pub, 'push', '-q', 'origin', 'main', '--tags');
      return sha;
    },
    /** 把發佈資訊寫進接收端的記憶庫（模擬同步過來的 release.json） */
    publishToVault(version, commit, extra = {}) {
      fs.writeFileSync(sc.releaseFile, `${JSON.stringify({ version, commit, repo: normalizeRepo(origin), at: new Date().toISOString(), by: 'pc-pub', ...extra }, null, 2)}\n`);
    },
    recvHead: () => git(recv, 'rev-parse', 'HEAD').trim(),
    state: () => JSON.parse(fs.readFileSync(path.join(home, 'local', 'auto-update.json'), 'utf8')),
  };
  return sc;
}

/** 可以檢查呼叫的相依：git 呼叫記錄、通知、重啟、doctor */
function deps(sc, o = {}) {
  const calls = [];
  const notified = [];
  const restarts = [];
  const order = [];
  const d = {
    home: sc.home,
    git: async (args, opts) => { calls.push(args); return o.git ? o.git(args, opts) : run('git', args, opts); },
    // before 回傳基準（原樣交給 after），after 回傳判斷
    doctor: async ({ phase, baseline } = {}) => { order.push(`doctor:${phase}`); return phase === 'before' ? { marker: 'baseline', version: activeVersion(sc.home) } : o.doctor ? o.doctor({ baseline }) : { ok: true }; },
    notify: (n) => notified.push(n),
    restartAgent: (handoff) => { order.push('restart'); restarts.push(handoff); },
    busy: async () => null,
    now: () => Date.parse('2026-12-01T09:00:00Z'),
    ...(o.update ? { update: o.update } : {}),
    ...(o.deps ?? {}),
  };
  return { d, calls, notified, restarts, order };
}

describe('release.json 的解析（內容不可信）', () => {
  const ok = { version: '1.2.3', commit: 'a'.repeat(40), repo: 'github.com/example/engram', at: '2026-11-21T00:00:00.000Z', by: 'pc-a' };
  test('合格的內容原樣解出；壞的一律當作沒有發佈', () => {
    assert.deepEqual(parseRelease(JSON.stringify(ok)), ok);
    const bad = [
      '', 'not json', '[]', 'null', '"x"',
      { ...ok, version: '1.2' }, { ...ok, version: 'v1.2.3' }, { ...ok, version: '1.2.3-beta' }, { ...ok, version: 123 },
      { ...ok, commit: 'abc1234' }, { ...ok, commit: 'A'.repeat(40) }, { ...ok, commit: `${'a'.repeat(39)}; rm -rf /` }, { ...ok, commit: '--upload-pack=x'.padEnd(40, 'a') },
      { ...ok, repo: '' }, { ...ok, repo: 'has space' }, { ...ok, repo: 'x'.repeat(301) },
      { ...ok, at: 'yesterday' }, { ...ok, by: 'b'.repeat(81) }, { ...ok, by: 5 },
    ];
    for (const b of bad) assert.equal(parseRelease(typeof b === 'string' ? b : JSON.stringify(b)), null, JSON.stringify(b));
    // 多餘的欄位不帶出去
    assert.deepEqual(parseRelease(JSON.stringify({ ...ok, extra: '--exec=boom' })), ok);
  });

  test('版本比較只看 X.Y.Z，忽略 -commit 後綴；看不懂回傳 NaN', () => {
    assert.equal(compareVersions('1.7.0', '1.6.0-abc1234'), 1);
    assert.equal(compareVersions('1.6.0', '1.6.0-abc1234'), 0);
    assert.equal(compareVersions('1.5.9', '1.6.0'), -1);
    assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '不是字串比較');
    assert.ok(Number.isNaN(compareVersions('x', '1.0.0')));
    assert.ok(Number.isNaN(compareVersions('1.0.0', undefined)));
  });

  test('遠端網址的比較用形式：https 與 ssh 寫法相同、拿掉帳號與權杖', () => {
    assert.equal(normalizeRepo('https://github.com/Example/Engram.git'), 'github.com/example/engram');
    assert.equal(normalizeRepo('git@github.com:Example/Engram.git'), 'github.com/example/engram');
    assert.equal(normalizeRepo('https://user:ghp_secretsecretsecret@github.com/Example/Engram'), 'github.com/example/engram');
  });
});

describe('預設的 doctor：執行新部署的 bin/engram.mjs doctor --json', () => {
  /** 部署一份假的程式：bin/engram.mjs 依第一個參數與環境變數印出指定的 doctor 結果 */
  async function deployed(t, script) {
    const root = mkTmp('engram-doctor-');
    t.after(() => rmTmp(root));
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'engram', version: '9.9.9' }));
    fs.writeFileSync(path.join(src, 'bin', 'engram.mjs'), script);
    const home = path.join(root, '.engram');
    await deploy(home, src);
    return home;
  }
  const printer = (obj, code = 0) => `if (process.argv[2] !== 'doctor' || process.argv[3] !== '--json') process.exit(2);\nconsole.log(${JSON.stringify(JSON.stringify(obj))});\nprocess.exit(${code});\n`;

  const chk = (id, ok, label = id) => ({ id, ok, label });

  test('doctorVerdict：引擎要載得起來；更新前通過的檢查不能變成沒通過；環境有關的檢查（遠端、對話回顧資料夾）與更新前就沒通過的不算', () => {
    const base = { loaded: true, checks: [chk('git', true), chk('cli', true, 'Engram 指令檔'), chk('remote', true), chk('dream-dir', true), chk('tmp', false)] };
    assert.deepEqual(doctorVerdict(base, { loaded: true, checks: base.checks }), { ok: true, detail: '' });
    // 引擎載不起來
    const noEngine = doctorVerdict(base, { loaded: false, checks: [], detail: '引擎無法載入：找不到模組' });
    assert.equal(noEngine.ok, false);
    assert.match(noEngine.detail, /找不到模組/);
    assert.equal(doctorVerdict(base, null).ok, false);
    // 更新前通過、更新後沒通過
    const reg = doctorVerdict(base, { loaded: true, checks: [chk('git', true), chk('cli', false, 'Engram 指令檔'), chk('remote', true), chk('dream-dir', true), chk('tmp', false)] });
    assert.equal(reg.ok, false);
    assert.match(reg.detail, /Engram 指令檔/);
    // 網路剛好斷了、對話回顧資料夾權限沒補上：環境有關，不算新版壞掉
    assert.equal(doctorVerdict(base, { loaded: true, checks: [chk('git', true), chk('cli', true), chk('remote', false), chk('dream-dir', false), chk('tmp', false)] }).ok, true);
    // 更新前就沒通過的、新出現的檢查項目（沒有基準）都不算
    assert.equal(doctorVerdict(base, { loaded: true, checks: [...base.checks, chk('junction:C--x', false)] }).ok, true);
    // 沒有基準（更新前的 doctor 跑不起來）：只看引擎載得起來
    assert.equal(doctorVerdict(null, { loaded: true, checks: [chk('git', false)] }).ok, true);
    assert.equal(doctorVerdict({ loaded: false, checks: [] }, { loaded: true, checks: [chk('git', false)] }).ok, true);
  });

  test('realDoctor：before 回傳整理過的原始結果、after 和基準比較；輸出看不懂、程式當掉都算引擎載不起來', async (t) => {
    const ok = await deployed(t, printer({ ok: true, engine: { ok: true }, checks: [{ id: 'git', ok: true, label: 'git 執行檔' }, { id: 'remote', ok: false, label: '遠端連線' }], findings: [] }));
    const raw = await realDoctor({ home: ok, phase: 'before' });
    assert.deepEqual(raw, { loaded: true, checks: [chk('git', true, 'git 執行檔'), chk('remote', false, '遠端連線')], detail: '' });
    assert.deepEqual(await realDoctor({ home: ok, phase: 'after', baseline: raw }), { ok: true, detail: '' });
    assert.deepEqual(await realDoctor({ home: ok }), { ok: true, detail: '' }, '預設是 after、沒有基準');
    const worse = await deployed(t, printer({ ok: false, engine: { ok: true }, checks: [{ id: 'git', ok: false, label: 'git 執行檔' }] }, 1));
    const r1 = await realDoctor({ home: worse, phase: 'after', baseline: raw });
    assert.equal(r1.ok, false);
    assert.match(r1.detail, /git 執行檔/);
    const noEngine = await deployed(t, printer({ ok: false, engine: { ok: false, error: { message: '找不到模組' } }, checks: [] }, 1));
    const r2 = await realDoctor({ home: noEngine });
    assert.equal(r2.ok, false);
    assert.match(r2.detail, /找不到模組/);
    const garbage = await deployed(t, 'console.log("not json");\n');
    const r3 = await realDoctor({ home: garbage });
    assert.equal(r3.ok, false);
    assert.match(r3.detail, /沒有輸出可讀的結果/);
    const crash = await deployed(t, 'throw new Error("boom");\n');
    assert.equal((await realDoctor({ home: crash })).ok, false);
  });

  test('真正的 engram doctor：剛安裝好、沒有遠端的健康電腦（遠端與對話回顧資料夾的檢查是不通過的）也要判成通過', async (t) => {
    const root = mkTmp('engram-doctor-real-');
    t.after(() => rmTmp(root));
    const m = machinePaths(root, 'pc');
    fs.mkdirSync(m.claudeHome, { recursive: true });
    fs.writeFileSync(path.join(m.claudeHome, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    const env = { ENGRAM_HOME: process.env.ENGRAM_HOME, CLAUDE_HOME: process.env.CLAUDE_HOME };
    process.env.ENGRAM_HOME = m.home; process.env.CLAUDE_HOME = m.claudeHome;
    t.after(() => { for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
    const lines = [];
    const inst = await runInstall({ home: m.home, claudeHome: m.claudeHome, yes: true, schedule: false, plugin: false, cliLink: false, label: '測試電腦', engine }, { print: (s) => lines.push(s), confirm: async () => true });
    assert.equal(inst.ok, true, lines.join('\n'));
    const raw = await realDoctor({ home: m.home, phase: 'before' });
    assert.equal(raw.loaded, true, raw.detail);
    const failing = raw.checks.filter((c) => !c.ok).map((c) => c.id);
    assert.ok(failing.includes('remote'), `前置：沒有遠端時 doctor 的 remote 檢查本來就不通過（${failing.join(',')}）`);
    assert.ok(raw.checks.some((c) => c.id === 'git' && c.ok), 'git 檢查通過');
    assert.deepEqual(await realDoctor({ home: m.home, phase: 'after', baseline: null }), { ok: true, detail: '' });
    assert.deepEqual(await realDoctor({ home: m.home, phase: 'after', baseline: raw }), { ok: true, detail: '' });
  });
});

describe('發佈端 publishRelease', () => {
  test('HEAD 剛好是版本標籤、乾淨、版本比 release.json 新：寫進 vault/release.json（完整 commit、遠端的比較用形式、這台的代號）', async (t) => {
    const sc = await scenario(t);
    fs.mkdirSync(path.join(sc.home, 'vault', '.git'), { recursive: true });
    fs.writeFileSync(path.join(sc.home, 'local', 'machine.json'), JSON.stringify({ mid: 'pc-pub', label: '發佈的電腦' }));
    const r = await publishRelease({ home: sc.home, sourceDir: path.join(sc.pub, 'app'), now: () => Date.parse('2026-12-01T00:00:00Z') });
    assert.equal(r.published, true, r.reason);
    const j = JSON.parse(fs.readFileSync(sc.releaseFile, 'utf8'));
    assert.deepEqual(j, { version: '1.0.0', commit: sc.c100, repo: normalizeRepo(sc.origin), at: '2026-12-01T00:00:00.000Z', by: 'pc-pub' });
    assert.match(j.commit, /^[0-9a-f]{40}$/);
    assert.ok(!JSON.stringify(j).includes('發佈的電腦'), '只寫代號，不寫顯示名稱');
  });

  test('附註標籤也算；只會前進：版本相同或更舊都不重寫（at、by 不會互相改寫）；新的才覆蓋', async (t) => {
    const sc = await scenario(t);
    fs.mkdirSync(path.join(sc.home, 'vault', '.git'), { recursive: true });
    const pubApp = path.join(sc.pub, 'app');
    assert.equal((await publishRelease({ home: sc.home, sourceDir: pubApp })).published, true);
    const first = fs.readFileSync(sc.releaseFile, 'utf8');
    const again = await publishRelease({ home: sc.home, sourceDir: pubApp });
    assert.equal(again.published, false);
    assert.match(again.reason, /1\.0\.0/);
    assert.equal(fs.readFileSync(sc.releaseFile, 'utf8'), first);
    // 接收端更新到同一個版本之後也不會改寫
    assert.equal((await publishRelease({ home: sc.home, sourceDir: path.join(sc.recv, 'app') })).published, false);
    // 新版（附註標籤）：覆蓋
    const c110 = sc.release('1.1.0', { annotated: true });
    assert.equal((await publishRelease({ home: sc.home, sourceDir: pubApp })).published, true);
    assert.equal(JSON.parse(fs.readFileSync(sc.releaseFile, 'utf8')).commit, c110, '附註標籤要剝到 commit');
    // 退版（回到舊標籤）不寫
    git(sc.pub, 'checkout', '-q', 'v1.0.0');
    const back = await publishRelease({ home: sc.home, sourceDir: pubApp });
    assert.equal(back.published, false);
    assert.equal(JSON.parse(fs.readFileSync(sc.releaseFile, 'utf8')).version, '1.1.0');
  });

  test('不是剛好在版本標籤上、有未提交的變更、沒有記憶庫、不是 git 複本、沒有 origin：都不發佈（也不丟例外）', async (t) => {
    const sc = await scenario(t);
    const pubApp = path.join(sc.pub, 'app');
    const noVault = await publishRelease({ home: sc.home, sourceDir: pubApp });
    assert.equal(noVault.published, false, '沒有記憶庫（vault/.git）');
    fs.mkdirSync(path.join(sc.home, 'vault', '.git'), { recursive: true });
    // 標籤之後多一個 commit
    fs.writeFileSync(path.join(sc.pub, 'app', 'src', 'y.mjs'), 'export {};\n');
    git(sc.pub, 'add', '-A');
    git(sc.pub, 'commit', '-q', '-m', 'after tag');
    assert.match((await publishRelease({ home: sc.home, sourceDir: pubApp })).reason, /v1\.0\.0/);
    // 標籤在上面、但有未提交的變更
    git(sc.pub, 'reset', '-q', '--hard', 'v1.0.0');
    fs.writeFileSync(path.join(sc.pub, 'app', 'src', 'x.mjs'), '// dirty\n');
    assert.match((await publishRelease({ home: sc.home, sourceDir: pubApp })).reason, /未提交/);
    git(sc.pub, 'checkout', '-q', '--', '.');
    // 不是 git 複本
    const plain = path.join(sc.root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    assert.equal((await publishRelease({ home: sc.home, sourceDir: plain })).published, false);
    // 沒有 origin
    git(sc.pub, 'remote', 'remove', 'origin');
    assert.match((await publishRelease({ home: sc.home, sourceDir: pubApp })).reason, /origin/);
    assert.equal(fs.existsSync(sc.releaseFile), false);
    // 來源資料夾不存在
    assert.equal((await publishRelease({ home: sc.home, sourceDir: path.join(sc.root, 'nope') })).published, false);
  });

  test('遠端網址夾帶帳號與權杖：寫進去的是拿掉之後的形式，檔案裡沒有權杖', async (t) => {
    const sc = await scenario(t);
    fs.mkdirSync(path.join(sc.home, 'vault', '.git'), { recursive: true });
    const token = `ghp_${'Qw3Er5Ty7U'.repeat(4)}`;
    git(sc.pub, 'remote', 'set-url', 'origin', `https://octo:${token}@github.com/Example/Engram.git`);
    const r = await publishRelease({ home: sc.home, sourceDir: path.join(sc.pub, 'app') });
    assert.equal(r.published, true, r.reason);
    const text = fs.readFileSync(sc.releaseFile, 'utf8');
    assert.ok(!text.includes(token) && !text.includes('octo'));
    assert.equal(JSON.parse(text).repo, 'github.com/example/engram');
  });

  test('engram update 成功之後自動發佈；--rollback、publish: false 不發佈；發佈失敗不影響更新', async (t) => {
    const sc = await scenario(t);
    fs.mkdirSync(path.join(sc.home, 'vault', '.git'), { recursive: true });
    // 這台電腦的來源就是發佈端的複本（發佈端自己執行 engram update）
    sc.writeInstall({ sourceDir: path.join(sc.pub, 'app') });
    const lines = [];
    const io = { print: (s) => lines.push(s), confirm: async () => true };
    const r0 = await runUpdate({ home: sc.home, restartAgent: false, publish: false }, io);
    assert.equal(r0.ok, true);
    assert.equal(fs.existsSync(sc.releaseFile), false, 'publish: false 不發佈');
    const r1 = await runUpdate({ home: sc.home, restartAgent: false }, io);
    assert.equal(r1.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(sc.releaseFile, 'utf8')).version, '1.0.0');
    assert.ok(lines.some((l) => /已把 1\.0\.0 的版本資訊寫進記憶庫/.test(l)), lines.join('\n'));
    // 退回不發佈（先放一個比較新的版本，看會不會被蓋掉）
    const c110 = sc.release('1.1.0');
    await runUpdate({ home: sc.home, restartAgent: false }, io);
    assert.equal(JSON.parse(fs.readFileSync(sc.releaseFile, 'utf8')).commit, c110);
    await runUpdate({ home: sc.home, rollback: true, restartAgent: false }, io);
    assert.equal(JSON.parse(fs.readFileSync(sc.releaseFile, 'utf8')).version, '1.1.0');
    // 發佈失敗（release.json 的位置被資料夾占住）：更新照樣成功
    fs.rmSync(sc.releaseFile);
    fs.mkdirSync(sc.releaseFile);
    const r2 = await runUpdate({ home: sc.home, restartAgent: false }, io);
    assert.equal(r2.ok, true);
  });
});

describe('接收端 runAutoUpdate：條件都符合才更新', () => {
  test('更新成功：快轉、部署新版、doctor 通過、通知一次、最後一步才重啟常駐程式；備份安裝紀錄；再跑一次是最新版', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const { d, notified, restarts, order } = deps(sc);
    const r = await runAutoUpdate(d);
    assert.equal(r.status, 'updated', r.reason);
    assert.equal(sc.recvHead(), c110, '來源資料夾快轉到發佈的 commit');
    assert.equal(activeVersion(sc.home), `1.1.0-${c110.slice(0, 7)}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sc.home, 'local', 'install.json'), 'utf8')).version, activeVersion(sc.home), 'install.json 記新版本');
    assert.equal(fs.readFileSync(path.join(currentDir(sc.home), 'bin', 'engram.mjs'), 'utf8'), '// 1.1.0\n');
    assert.ok(listVersions(sc.home).some((v) => v.name === sc.first), '舊版保留，才退得回去');
    assert.ok(r.backup && fs.existsSync(r.backup), '更新前備份安裝紀錄');
    assert.deepEqual(order, ['doctor:before', 'doctor:after', 'restart'], '更新前先跑 doctor 記基準；通過之後才重啟，而且重啟是最後一步');
    assert.equal(restarts.length, 1);
    // 重啟交接給 restartAndVerify：新版常駐程式確認起來之後才通知「已自動更新」，所以這裡還沒有通知
    assert.deepEqual(restarts[0], { home: sc.home, release: { version: '1.1.0', commit: c110 }, before: sc.first, version: '1.1.0' });
    assert.equal(notified.length, 0, '「已自動更新」要等新版常駐程式確認起來才通知');
    const st = sc.state();
    assert.equal(st.last.status, 'updated');
    assert.equal(st.failedCommit ?? null, null);
    // 隔天：版本已經一樣，不動、不通知
    const again = deps(sc);
    const r2 = await runAutoUpdate(again.d);
    assert.equal(r2.status, 'current');
    assert.equal(again.calls.length, 0, '沒有新版就完全不碰 git');
    assert.equal(again.notified.length + again.restarts.length, 0);
  });

  test('doctor：更新前（舊程式）先跑一次記基準，更新後（新部署的程式）再跑一次並拿到那份基準', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    let seen = null;
    let baseline = null;
    const { d } = deps(sc, { doctor: ({ baseline: b }) => { seen = activeVersion(sc.home); baseline = b; return { ok: true }; } });
    await runAutoUpdate(d);
    assert.equal(seen, `1.1.0-${c110.slice(0, 7)}`, 'after 呼叫時 current 已經指向新版');
    assert.deepEqual(baseline, { marker: 'baseline', version: sc.first }, 'before 是在更新前（還在舊版）呼叫的，結果原樣交給 after');
  });

  test('更新前的 doctor 丟例外：沒有基準，只看新版的引擎載不載得起來，照常更新', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    let seenBaseline;
    const { d } = deps(sc, { deps: { doctor: async ({ phase, baseline }) => { if (phase === 'before') throw new Error('舊版的 doctor 跑不起來'); seenBaseline = baseline; return { ok: true }; } } });
    const r = await runAutoUpdate(d);
    assert.equal(r.status, 'updated', r.reason);
    assert.equal(seenBaseline, null);
  });

  test('設定關閉、沒有 release.json、內容不合格式：不更新、不碰 git；內容不合格式會說明', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    const a = deps(sc);
    assert.equal((await runAutoUpdate({ ...a.d, autoUpdate: 'off' })).code, 'off');
    assert.equal((await runAutoUpdate(a.d)).code, 'none');
    fs.writeFileSync(sc.releaseFile, JSON.stringify({ version: '1.1.0', commit: 'abc1234', repo: normalizeRepo(sc.origin), at: new Date().toISOString(), by: 'x' }));
    const bad = await runAutoUpdate(a.d);
    assert.equal(bad.code, 'invalid');
    assert.match(bad.reason, /不合格式/);
    assert.equal(a.calls.length, 0);
    assert.equal(sc.recvHead(), sc.c100);
    assert.notEqual(c110, sc.c100);
  });

  test('版本不比本機新（相同、更舊）：不更新；本機版本看不懂也不更新', async (t) => {
    const sc = await scenario(t);
    for (const v of ['1.0.0', '0.9.0']) {
      sc.publishToVault(v, sc.c100);
      const a = deps(sc);
      assert.equal((await runAutoUpdate(a.d)).status, 'current', v);
      assert.equal(a.calls.length, 0);
    }
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    sc.writeInstall({ version: 'garbage' });
    assert.equal((await runAutoUpdate(deps(sc).d)).status, 'current');
    assert.equal(sc.recvHead(), sc.c100);
  });

  test('開發模式、沒有安裝紀錄：不更新', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    sc.writeInstall({ dev: true });
    assert.equal((await runAutoUpdate(deps(sc).d)).code, 'dev');
    fs.rmSync(path.join(sc.home, 'local', 'install.json'));
    assert.equal((await runAutoUpdate(deps(sc).d)).code, 'not-installed');
    assert.equal(sc.recvHead(), sc.c100);
  });

  test('有對話進行中或自動駕駛正在跑：延後（不碰 git、不改任何東西、不通知）', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const a = deps(sc, { deps: { busy: async () => '有對話進行中' } });
    const r = await runAutoUpdate(a.d);
    assert.equal(r.status, 'deferred');
    assert.equal(r.code, 'busy');
    assert.match(r.reason, /有對話進行中/);
    assert.equal(a.calls.length, 0);
    assert.equal(sc.recvHead(), sc.c100);
    assert.equal(activeVersion(sc.home), sc.first);
    assert.equal(a.notified.length, 0);
  });

  test('來源資料夾有未提交的變更（含沒追蹤的檔案）：不更新並說明', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    fs.writeFileSync(path.join(sc.recv, 'app', 'src', 'x.mjs'), '// local edit\n');
    const r = await runAutoUpdate(deps(sc).d);
    assert.equal(r.code, 'dirty');
    assert.equal(r.status, 'refused');
    git(sc.recv, 'checkout', '-q', '--', '.');
    fs.writeFileSync(path.join(sc.recv, 'scratch.txt'), 'untracked');
    assert.equal((await runAutoUpdate(deps(sc).d)).code, 'dirty');
    assert.equal(sc.recvHead(), sc.c100);
    assert.equal(fs.readFileSync(path.join(sc.recv, 'scratch.txt'), 'utf8'), 'untracked', '使用者的檔案原封不動');
  });

  test('遠端網址不符、來源不是 git 複本、來源資料夾不見：不更新', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110, { repo: 'github.com/someone-else/engram' });
    const r = await runAutoUpdate(deps(sc).d);
    assert.equal(r.code, 'repo-mismatch');
    assert.equal(sc.recvHead(), sc.c100);
    // https 與 ssh 寫法不同但是同一個遠端：相符（這裡把接收端的 origin 改成帳號形式）
    sc.publishToVault('1.1.0', c110);
    git(sc.recv, 'remote', 'set-url', 'origin', sc.origin.replace(/\\/g, '/'));
    assert.equal((await runAutoUpdate(deps(sc, { doctor: () => ({ ok: true }) }).d)).status, 'updated');
    // 來源資料夾搬走 / 不是 git
    const sc2 = await scenario(t);
    const c2 = sc2.release('1.1.0');
    sc2.publishToVault('1.1.0', c2);
    sc2.writeInstall({ sourceDir: path.join(sc2.root, 'gone', 'app') });
    assert.equal((await runAutoUpdate(deps(sc2).d)).code, 'no-source');
    const plain = path.join(sc2.root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    sc2.writeInstall({ sourceDir: plain });
    assert.equal((await runAutoUpdate(deps(sc2).d)).code, 'not-git');
  });

  test('不是快轉（來源有自己的 commit、或已經超前）：不更新，來源資料夾完全沒動', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    // 來源有自己的 commit（分岔）
    fs.writeFileSync(path.join(sc.recv, 'local-change.txt'), 'mine');
    git(sc.recv, 'add', '-A');
    git(sc.recv, 'commit', '-q', '-m', 'local only');
    const mine = sc.recvHead();
    const r = await runAutoUpdate(deps(sc).d);
    assert.equal(r.code, 'not-fast-forward');
    assert.equal(sc.recvHead(), mine);
    assert.equal(activeVersion(sc.home), sc.first);
    // 已經超前（發佈的 commit 是目前 HEAD 的祖先）也不退版
    git(sc.recv, 'reset', '-q', '--hard', 'origin/main');
    sc.release('1.2.0');
    git(sc.recv, 'pull', '-q', '--ff-only');
    const head = sc.recvHead();
    assert.equal((await runAutoUpdate(deps(sc).d)).code, 'not-fast-forward');
    assert.equal(sc.recvHead(), head);
  });

  test('標籤不符：沒有標籤、標籤指到別的 commit、遠端沒有那個 commit、package.json 版本不符，都不更新', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0', { tag: false });
    sc.publishToVault('1.1.0', c110);
    const none = await runAutoUpdate(deps(sc).d);
    assert.equal(none.code, 'tag-mismatch', '那個 commit 沒有版本標籤');
    // 標籤存在但指到別的 commit
    git(sc.pub, 'tag', 'v1.1.0', sc.c100);
    git(sc.pub, 'push', '-q', 'origin', 'v1.1.0');
    assert.equal((await runAutoUpdate(deps(sc).d)).code, 'tag-mismatch');
    // 發佈資訊指定的 commit 遠端根本沒有：標籤指到別處，一樣不更新（commit-missing 只是標籤對得上卻沒有 commit 時的保險）
    sc.publishToVault('1.1.0', FULL('b'));
    assert.equal((await runAutoUpdate(deps(sc).d)).code, 'tag-mismatch');
    // 標籤對、但 package.json 的版本和發佈的不一樣
    const sc2 = await scenario(t);
    const bad = sc2.release('1.1.0', { pkgVersion: '1.0.5' });
    sc2.publishToVault('1.1.0', bad);
    const r = await runAutoUpdate(deps(sc2).d);
    assert.equal(r.code, 'version-mismatch');
    for (const s of [sc, sc2]) { assert.equal(s.recvHead(), s.c100); assert.equal(activeVersion(s.home), s.first); }
  });

  test('附註標籤也能通過（剝到 commit 比對）', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0', { annotated: true });
    sc.publishToVault('1.1.0', c110);
    assert.equal((await runAutoUpdate(deps(sc).d)).status, 'updated');
  });

  test('連不上遠端：稍後再試，不算失敗（不退回、不通知、不改任何東西）', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    fs.rmSync(sc.origin, { recursive: true, force: true });
    const a = deps(sc);
    const r = await runAutoUpdate(a.d);
    assert.equal(r.status, 'deferred');
    assert.equal(r.code, 'offline');
    assert.equal(a.notified.length, 0);
    assert.equal(sc.recvHead(), sc.c100);
    assert.equal(sc.state().failedCommit ?? null, null);
  });

  test('doctor 沒通過：退回上一個版本、通知一次；同一個發佈不再重試，下一個發佈才再試', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const a = deps(sc, { doctor: () => ({ ok: false, detail: '引擎無法載入' }) });
    const r = await runAutoUpdate(a.d);
    assert.equal(r.status, 'failed');
    assert.equal(r.code, 'doctor-failed');
    assert.equal(r.rolledBack, true);
    assert.equal(activeVersion(sc.home), sc.first, '退回原本的版本');
    assert.equal(fs.readFileSync(path.join(currentDir(sc.home), 'bin', 'engram.mjs'), 'utf8'), '// 1.0.0\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(sc.home, 'local', 'install.json'), 'utf8')).version, sc.first);
    assert.equal(a.restarts.length, 0, '失敗不重啟（常駐程式還在跑舊版）');
    assert.equal(a.notified.length, 1);
    assert.match(a.notified[0].body, /失敗.*已退回/);
    assert.equal(sc.state().failedCommit, c110);
    // 隔天：同一個發佈不再試（不重複部署、退回、通知）
    const b = deps(sc);
    const r2 = await runAutoUpdate(b.d);
    assert.equal(r2.code, 'known-failed');
    assert.match(r2.reason, /doctor/);
    assert.equal(b.calls.length, 0);
    assert.equal(b.notified.length, 0);
    // 下一個發佈：再試，這次成功
    const c120 = sc.release('1.2.0');
    sc.publishToVault('1.2.0', c120);
    const c = deps(sc);
    assert.equal((await runAutoUpdate(c.d)).status, 'updated');
    assert.equal(sc.state().failedCommit ?? null, null);
  });

  test('doctor 丟例外、更新流程回報失敗：都退回（版本沒切換就不退回）；git merge 失敗：不部署', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const thrown = await runAutoUpdate(deps(sc, { doctor: () => { throw new Error('boom'); } }).d);
    assert.equal(thrown.code, 'doctor-failed');
    assert.equal(activeVersion(sc.home), sc.first);

    // 更新流程在切換版本之前就失敗（例如來源資料夾找不到 package.json）：沒有東西要退回
    const sc2 = await scenario(t);
    const c2 = sc2.release('1.1.0');
    sc2.publishToVault('1.1.0', c2);
    const calls = [];
    const r = await runAutoUpdate(deps(sc2, { update: async (o) => { calls.push(o); return { ok: false, lines: ['找不到 Engram 程式資料夾'] }; } }).d);
    assert.equal(r.code, 'update-failed');
    assert.equal(r.rolledBack, false);
    assert.equal(calls.length, 1, '版本沒有切換，不呼叫退回');
    assert.equal(calls[0].restartAgent, false);
    assert.equal(calls[0].publish, false);

    // merge 失敗：模擬 git 回報失敗
    const sc3 = await scenario(t);
    const c3 = sc3.release('1.1.0');
    sc3.publishToVault('1.1.0', c3);
    const upd = [];
    const m = await runAutoUpdate(deps(sc3, {
      git: (args, opts) => (args[0] === 'merge' && args[1] === '--ff-only' ? { code: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.', timedOut: false } : run('git', args, opts)),
      update: async (o) => { upd.push(o); return { ok: true }; },
    }).d);
    assert.equal(m.code, 'merge-failed');
    assert.equal(upd.length, 0, 'merge 沒成功就不部署');
    assert.equal(activeVersion(sc3.home), sc3.first);
  });

  test('更新流程切換了版本之後失敗：退回到更新前的那個版本（不是別的舊版）', async (t) => {
    const sc = await scenario(t);
    // 先有三個版本：1.0.0 → 1.0.5 → 目前 1.0.5，再更新到 1.1.0 失敗：要退回 1.0.5，不是更舊的 1.0.0
    const c105 = sc.release('1.0.5');
    git(sc.recv, 'pull', '-q', '--ff-only');
    await new Promise((r) => setTimeout(r, 30));
    await deploy(sc.home, path.join(sc.recv, 'app'));
    sc.writeInstall();
    const before = activeVersion(sc.home);
    assert.equal(before, `1.0.5-${c105.slice(0, 7)}`);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const a = deps(sc, { doctor: () => ({ ok: false, detail: 'x' }) });
    const r = await runAutoUpdate(a.d);
    assert.equal(r.rolledBack, true);
    assert.equal(activeVersion(sc.home), before);
  });

  test('更新前的版本修改時間最舊（之前手動退回過）：部署新版時 prune 不能把它刪掉，失敗時才退得回去', async (t) => {
    const sc = await scenario(t);
    const pause = () => new Promise((r) => setTimeout(r, 40));
    const A = sc.first;
    sc.release('1.0.5');
    git(sc.recv, 'pull', '-q', '--ff-only');
    await pause();
    await deploy(sc.home, path.join(sc.recv, 'app'));
    sc.release('1.0.6');
    git(sc.recv, 'pull', '-q', '--ff-only');
    await pause();
    const c = await deploy(sc.home, path.join(sc.recv, 'app'));
    // 手動退回到最舊的 A：A 成為使用中的版本，修改時間卻最舊
    sc.writeInstall();
    const io = { print() {}, confirm: async () => true };
    assert.equal((await runUpdate({ home: sc.home, rollback: true, rollbackTo: A, restartAgent: false }, io)).ok, true);
    assert.equal(activeVersion(sc.home), A);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const r = await runAutoUpdate(deps(sc, { doctor: () => ({ ok: false, detail: 'x' }) }).d);
    assert.equal(r.status, 'failed');
    assert.equal(r.rolledBack, true, '更新前的 A 沒有被 prune 刪掉');
    assert.equal(activeVersion(sc.home), A);
    assert.ok(listVersions(sc.home).some((v) => v.name === c.version), '其他版本照常依修改時間保留');
  });

  test('沒有可以退回的舊版本（目前使用中的版本資料夾不見了）：不更新', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    fs.rmSync(path.join(sc.home, 'app', sc.first), { recursive: true, force: true });
    const r = await runAutoUpdate(deps(sc).d);
    assert.equal(r.code, 'no-rollback');
    assert.equal(sc.recvHead(), sc.c100, '還沒動來源資料夾');
  });

  // ───────── 第二輪審查 #2：只取需要的標籤與 commit ─────────

  test('遠端移動過一個舊標籤（重打 v1.0.0 後強制推送）：照常更新，不更新本機既有的標籤，也不抓其他標籤', async (t) => {
    const sc = await scenario(t);
    // 發佈端把 v1.0.0 重新打在另一個 commit 上並強制推送；接收端 clone 時抓過舊的 v1.0.0
    fs.writeFileSync(path.join(sc.pub, 'NOTE.md'), 'fix\n');
    git(sc.pub, 'add', '-A');
    git(sc.pub, 'commit', '-q', '-m', 'retag');
    git(sc.pub, 'tag', '-f', 'v1.0.0');
    git(sc.pub, 'push', '-q', '-f', 'origin', 'main', '--tags');
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const localTag = git(sc.recv, 'rev-parse', 'v1.0.0').trim();
    assert.equal(localTag, sc.c100);
    const a = deps(sc);
    const r = await runAutoUpdate(a.d);
    assert.equal(r.status, 'updated', r.reason);
    assert.equal(sc.recvHead(), c110);
    assert.equal(git(sc.recv, 'rev-parse', 'v1.0.0').trim(), localTag, '本機既有的標籤原封不動');
    assert.equal(git(sc.recv, 'tag', '-l', 'v1.1.0').trim(), '', '也沒有把新標籤抓成本機標籤');
    assert.ok(!a.calls.some((c) => c.includes('--tags')), '不抓全部標籤');
    const fetch = a.calls.find((c) => c[0] === 'fetch');
    assert.ok(fetch.includes('+refs/tags/v1.1.0:refs/engram-autoupdate/tag'), `只取那一個標籤、放到暫時的 ref：${fetch.join(' ')}`);
    assert.equal(git(sc.recv, 'for-each-ref', 'refs/engram-autoupdate').trim(), '', '暫時的 ref 用完就清掉');
    // 對照：舊做法（fetch --tags）在這個遠端會因為標籤衝突失敗
    assert.notEqual((await run('git', ['fetch', '--tags', 'origin'], { cwd: sc.recv })).code, 0);
  });

  test('連線失敗與遠端拒絕分開：連不上才稍後再試；拿不到標籤、標籤指到別處、認證被拒是不更新並通知一次', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0', { tag: false });
    sc.publishToVault('1.1.0', c110);
    // 遠端沒有這個版本的標籤：不是網路問題 → 不更新並通知，隔天同一個原因不再通知
    const a = deps(sc);
    const r1 = await runAutoUpdate(a.d);
    assert.equal(r1.status, 'refused');
    assert.equal(r1.code, 'tag-mismatch');
    assert.match(r1.reason, /v1\.1\.0/);
    assert.equal(a.notified.length, 1);
    assert.match(a.notified[0].body, /標籤/);
    assert.equal(sc.state().last.code, 'tag-mismatch');
    const b = deps(sc);
    assert.equal((await runAutoUpdate(b.d)).code, 'tag-mismatch');
    assert.equal(b.notified.length, 0, '同一個發佈、同一個原因只通知一次');
    // 標籤指到別的 commit
    git(sc.pub, 'tag', 'v1.1.0', sc.c100);
    git(sc.pub, 'push', '-q', 'origin', 'v1.1.0');
    const c = deps(sc);
    assert.equal((await runAutoUpdate(c.d)).code, 'tag-mismatch');
    assert.equal(c.notified.length, 1, '原因的細節不同（指到別處）：再通知一次');

    // 認證被拒（非網路）：refused / fetch-failed，通知一次；錯誤訊息裡的帳號與權杖不會出現在原因與通知
    const token = `ghp_${'Qw3Er5Ty7U'.repeat(4)}`;
    const denied = deps(sc, { git: (args, opts) => (args[0] === 'fetch' ? { code: 128, stdout: '', stderr: `remote: Permission to example/engram.git denied.\nfatal: unable to access 'https://octo:${token}@github.com/example/engram.git/': The requested URL returned error: 403`, timedOut: false } : run('git', args, opts)) });
    const r4 = await runAutoUpdate(denied.d);
    assert.equal(r4.status, 'refused');
    assert.equal(r4.code, 'fetch-failed');
    assert.equal(denied.notified.length, 1);
    const shown = JSON.stringify([r4, denied.notified, sc.state()]);
    assert.ok(!shown.includes(token) && !shown.includes('octo'), '原因與通知裡沒有帳號或權杖');

    // 真的連不上：deferred / offline，不通知（細節同樣不帶權杖）
    const down = deps(sc, { git: (args, opts) => (args[0] === 'fetch' ? { code: 128, stdout: '', stderr: `fatal: unable to access 'https://octo:${token}@github.com/example/engram.git/': Could not resolve host: github.com`, timedOut: false } : run('git', args, opts)) });
    const r5 = await runAutoUpdate(down.d);
    assert.equal(r5.status, 'deferred');
    assert.equal(r5.code, 'offline');
    assert.equal(down.notified.length, 0);
    assert.ok(!JSON.stringify([r5, sc.state()]).includes(token));
    // 逾時也算連不上
    const slow = deps(sc, { git: (args, opts) => (args[0] === 'fetch' ? { code: -1, stdout: '', stderr: '', timedOut: true } : run('git', args, opts)) });
    assert.equal((await runAutoUpdate(slow.d)).code, 'offline');
    assert.equal(sc.recvHead(), sc.c100);
  });

  // ───────── 第二輪審查 #4：連續延後有上限 ─────────

  test('連續延後 5 次通知一次，之後每天只試一次（giveUpToday）；換成別的原因或有別的結果就重算', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const a = deps(sc, { deps: { busy: async () => '有對話進行中' } });
      const r = await runAutoUpdate(a.d);
      rows.push([r.streak, !!r.giveUpToday, a.notified.length]);
    }
    assert.deepEqual(rows, [[1, false, 0], [2, false, 0], [3, false, 0], [4, false, 0], [5, true, 1], [6, true, 0], [7, true, 0]]);
    // 通知內容說明原因與之後的做法
    const fifth = deps(sc, { deps: { busy: async () => '有對話進行中' } });
    await runAutoUpdate(fifth.d);
    assert.equal(fifth.notified.length, 0);
    // 換成別的原因（連不上遠端）：從 1 重算
    fs.renameSync(sc.origin, `${sc.origin}-gone`);
    const off = deps(sc);
    const r = await runAutoUpdate(off.d);
    assert.equal(r.code, 'offline');
    assert.equal(r.streak, 1);
    assert.equal(r.giveUpToday, false);
    fs.renameSync(`${sc.origin}-gone`, sc.origin);
    assert.equal(sc.state().streak.code, 'offline');
    // 不是延後的結果（這裡是條件不符）清掉計數
    git(sc.recv, 'config', 'remote.origin.url', 'https://github.com/someone-else/engram.git');
    const mismatch = await runAutoUpdate(deps(sc).d);
    assert.equal(mismatch.code, 'repo-mismatch');
    assert.equal(sc.state().streak ?? null, null);
  });

  test('第 5 次連續延後的通知帶原因，同一個原因不會再通知', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const all = [];
    for (let i = 0; i < 8; i++) {
      const a = deps(sc, { deps: { busy: async () => '有對話進行中' } });
      await runAutoUpdate(a.d);
      all.push(...a.notified);
    }
    assert.equal(all.length, 1);
    assert.match(all[0].body, /連續 5 次/);
    assert.match(all[0].body, /有對話進行中/);
    assert.match(all[0].body, /每天只試一次/);
  });

  test('updateStatus：設定、本機版本、發佈資訊、最近一次的結果', async (t) => {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    await runAutoUpdate(deps(sc, { deps: { busy: async () => '有對話進行中' } }).d);
    const s = await updateStatus({ home: sc.home, autoUpdate: 'on' });
    assert.equal(s.autoUpdate, 'on');
    assert.equal(s.local, sc.first);
    assert.equal(s.release.version, '1.1.0');
    assert.equal(s.last.code, 'busy');
    assert.equal(s.last.status, 'deferred');
  });

  test('英文介面：最近一次的結果（GET /api/update 的 last）有 en.reason，原因與細節都是英文（延後、更新失敗、同一個發佈不再試）', async (t) => {
    const han = /\p{Script=Han}/u;
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    await runAutoUpdate(deps(sc, { deps: { busy: async () => ({ zh: '有對話進行中', en: 'a conversation is in progress' }) } }).d);
    const s1 = await updateStatus({ home: sc.home, autoUpdate: 'on' });
    assert.match(s1.last.reason, /有對話進行中/);
    assert.equal(s1.last.en.reason, 'A conversation is in progress or autopilot is running; trying again later: a conversation is in progress');
    const r = await runAutoUpdate(deps(sc, { doctor: () => ({ ok: false, detail: '更新前通過、現在沒通過：記憶庫', detailEn: 'Passed before the update but fails now: vault' }) }).d);
    assert.equal(r.code, 'doctor-failed');
    assert.ok(!han.test(r.en.reason), r.en.reason);
    assert.ok(!han.test(sc.state().last.en.reason), '存下來的最近一次結果也是英文');
    const r2 = await runAutoUpdate(deps(sc).d);
    assert.equal(r2.code, 'known-failed');
    assert.ok(!han.test(r2.en.reason), r2.en.reason);
    assert.match(r2.en.reason, /post-update check/);
    assert.equal(doctorVerdict(null, { loaded: false, detail: '引擎無法載入', detailEn: 'The engine could not load' }).detailEn, 'The engine could not load');
    assert.ok(!han.test(doctorVerdict({ checks: [{ id: 'x', ok: true, label: 'x' }] }, { loaded: true, checks: [{ id: 'x', ok: false, label: 'x' }] }).detailEn));
  });
});

// ───────── 第二輪審查 #3：重啟之後要確認新版常駐程式起得來，起不來就退回、啟動舊版並通知 ─────────

describe('restartAndVerify：新版常駐程式有沒有起得來', () => {
  /** 走完 runAutoUpdate（假的重啟只記下交接資料），回傳交接資料；這時 current 已經是新版、舊版還在 */
  async function handedOff(t) {
    const sc = await scenario(t);
    const c110 = sc.release('1.1.0');
    sc.publishToVault('1.1.0', c110);
    const a = deps(sc);
    const r = await runAutoUpdate(a.d);
    assert.equal(r.status, 'updated', r.reason);
    return { sc, c110, handoff: a.restarts[0] };
  }

  /** 假的程序動作：記下順序，心跳依序回傳 beats（用完之後一直回傳最後一個）；時間靠 sleep 往前走 */
  function proc(sc, handoff, { beats = [], update } = {}) {
    const log = [];
    const notified = [];
    let now = 0;
    const queue = [...beats];
    const d = {
      ...handoff,
      stopAgent: async () => log.push('stop'),
      spawnAgent: (bin) => { log.push(`spawn:${fs.readFileSync(bin, 'utf8').trim()}`); return 4242; },
      killProcess: (pid) => log.push(`kill:${pid}`),
      readHeartbeat: () => (queue.length > 1 ? queue.shift() : queue[0] ?? null),
      sleep: async (ms) => { now += ms; },
      now: () => now,
      // 通知是非同步的（真的通知器要啟動 PowerShell）：結束程序前要等它送出去
      notify: (n) => { notified.push(n); return new Promise((r) => setTimeout(() => { log.push('notified'); r(true); }, 20)); },
      exit: (code) => log.push(`exit:${code}`),
      selfPid: 100,
      ...(update ? { update } : {}),
    };
    return { d, log, notified, elapsed: () => now };
  }

  test('新版常駐程式在時限內回報了新版本：記成功、通知「已自動更新」一次、結束舊程序；不退回', async (t) => {
    const { sc, c110, handoff } = await handedOff(t);
    const p = proc(sc, handoff, { beats: [null, { pid: 555, version: '1.0.0' }, { pid: 222, version: '1.1.0' }] });
    const r = await restartAndVerify(p.d);
    assert.equal(r.ok, true);
    assert.deepEqual(p.log, ['stop', 'spawn:// 1.1.0', 'notified', 'exit:0'], '先停舊的、啟動新版、確認之後通知、通知送出去才結束');
    assert.equal(p.notified.length, 1);
    assert.match(p.notified[0].body, /已自動更新到 Engram 1\.1\.0/);
    assert.equal(activeVersion(sc.home), `1.1.0-${c110.slice(0, 7)}`, '沒有退回');
    assert.equal(sc.state().failedCommit ?? null, null);
    assert.equal(sc.state().notified, `update:${c110}:updated`);
  });

  test('新版常駐程式起不來（一直沒有心跳、或心跳還是舊版本）：退回上一版、殺掉卡住的新程序、啟動舊版常駐程式、通知失敗；同一個發佈不再重試', async (t) => {
    const { sc, c110, handoff } = await handedOff(t);
    const p = proc(sc, handoff, { beats: [null, { pid: 555, version: '1.0.0' }] }); // 只有舊版本的心跳（不是新版自己回報的）
    const r = await restartAndVerify(p.d);
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.deepEqual(p.log, ['stop', 'spawn:// 1.1.0', 'kill:4242', 'spawn:// 1.0.0', 'notified', 'exit:0'], '退回之後先啟動舊版的程式，通知送出去才結束');
    assert.ok(p.elapsed() >= 60_000, `等滿 60 秒才放棄（${p.elapsed()} ms）`);
    assert.equal(activeVersion(sc.home), sc.first, '退回到更新前的版本');
    assert.equal(JSON.parse(fs.readFileSync(path.join(sc.home, 'local', 'install.json'), 'utf8')).version, sc.first);
    assert.equal(p.notified.length, 1);
    assert.match(p.notified[0].body, /常駐程式.*沒有.*啟動/);
    assert.match(p.notified[0].body, /已退回/);
    const st = sc.state();
    assert.equal(st.failedCommit, c110);
    assert.equal(st.last.status, 'failed');
    assert.equal(st.last.code, 'agent-failed');
    // 隔天：同一個發佈不再試
    const again = deps(sc);
    assert.equal((await runAutoUpdate(again.d)).code, 'known-failed');
    assert.equal(again.calls.length, 0);
  });

  test('退回也失敗：通知要使用者執行 engram update --rollback，還是啟動目前的程式', async (t) => {
    const { sc, handoff } = await handedOff(t);
    const p = proc(sc, handoff, { beats: [null], update: async () => ({ ok: false }) });
    const r = await restartAndVerify(p.d);
    assert.equal(r.rolledBack, false);
    assert.match(p.notified[0].body, /沒能退回/);
    assert.match(p.notified[0].body, /engram update --rollback/);
    assert.equal(p.log.at(-1), 'exit:0');
    assert.equal(p.log.filter((l) => l.startsWith('spawn:')).length, 2, '仍然嘗試啟動常駐程式');
  });

  test('stopAgent 丟例外也不會卡住：照樣啟動新版、等心跳', async (t) => {
    const { sc, handoff } = await handedOff(t);
    const p = proc(sc, handoff, { beats: [{ pid: 222, version: '1.1.0' }] });
    p.d.stopAgent = async () => { throw new Error('停不下來'); };
    assert.equal((await restartAndVerify(p.d)).ok, true);
  });
});
