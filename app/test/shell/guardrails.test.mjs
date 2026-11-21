// engram guardrails（列出、測試、停用與啟用）與 GET /api/guardrails、PUT /api/settings 的 guardrails。
// 用真的引擎（暫存資料夾裡的假 Engram），不會碰到真正的 ~/.engram 或 ~/.claude。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApi } from '../../src/agent/api.mjs';
import { COMMANDS, helpText, main } from '../../src/cli/main.mjs';
import { init, open } from '../../src/core/index.mjs';
import { machinePaths, mkTmp as mkCoreTmp, rmTmp as rmCoreTmp, writeDriverCli } from '../core/helpers.mjs';
import { capture, stdinFrom } from './helpers.mjs';

let root;
let eg;

const BLOCKED = String.raw`node -e 'console.log("C:\\temp")'`;
const rulesFile = () => path.join(eg.paths.vault, 'guardrails', 'rules.json');
const customRule = (over = {}) => ({ id: 'my-rule', tool: 'Bash', pattern: 'danger', flags: '', unless: '', action: 'block', message: '不要這樣寫。', source: '測試', addedAt: '2026-11-20', by: 'tester', ...over });
const writeRules = (rules) => {
  fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
  fs.writeFileSync(rulesFile(), JSON.stringify({ v: 1, rules }));
};
const reset = () => {
  for (const f of [rulesFile(), path.join(eg.paths.local, 'guardrails-overrides.json'), path.join(eg.paths.local, 'guardrails-approved.json'), path.join(eg.paths.local, 'settings.json')]) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(eg.paths.local, 'usage'), { recursive: true, force: true });
};

before(async () => {
  root = mkCoreTmp();
  const m = machinePaths(root, 'home');
  await init({ ...m, machineLabel: '家裡電腦', userName: 'Tester', cli: writeDriverCli(root) });
  eg = await open(m);
});
after(() => rmCoreTmp(root));

// env：預設是乾淨的環境（測試本身可能就跑在 Claude Code 裡，process.env 帶著 CLAUDECODE）
async function engram(argv, { stdin, env = {} } = {}) {
  const out = capture();
  const err = capture();
  const code = await main(argv, { loadEngine: async () => eg, stdout: out.stream, stderr: err.stream, stdin: stdin ?? { isTTY: true }, env });
  return { code, out: out.text, err: err.text };
}

describe('engram guardrails', () => {
  test('有說明與用法，列在說明的「護欄」群組，位置參數有上限', () => {
    assert.ok(COMMANDS.guardrails);
    assert.match(COMMANDS.guardrails.summary, /[一-鿿]/);
    assert.match(helpText(), /護欄\n {2}guardrails \[list\]/);
    assert.match(helpText('guardrails'), /用法：engram guardrails/);
  });

  test('預設就是 list：6 條規則、目前實際的動作與近 30 天的命中', async () => {
    reset();
    const r = await engram(['guardrails']);
    assert.equal(r.code, 0);
    assert.match(r.out, /內建的預設規則/);
    for (const id of ['bash-heredoc-triple-quote', 'inline-script-double-backslash', 'inline-script-cjk', 'powershell-command-shell-variable', 'msys-path-conversion', 'rm-shell-variable']) assert.match(r.out, new RegExp(id));
    assert.match(r.out, /inline-script-double-backslash｜擋下｜Bash｜近 30 天命中 0、誤擋 0、擋對 0/);
    assert.match(r.out, /rm-shell-variable｜提醒｜Bash/);
    assert.equal((await engram(['guardrails', 'list'])).out, r.out);
  });

  test('--json 輸出規則清單與統計', async () => {
    reset();
    const r = await engram(['guardrails', 'list', '--json']);
    const j = JSON.parse(r.out);
    assert.equal(j.mode, 'block');
    assert.equal(j.source, 'default');
    assert.equal(j.rules.length, 6);
    assert.deepEqual(j.totals, { hits: 0, blocks: 0, falseBlocks: 0, confirmed: 0, slow: 0 });
    assert.ok(j.rules.every((x) => x.approval === 'builtin'));
    assert.ok(j.rules.every((x) => typeof x.hits === 'number' && typeof x.confirmed === 'number' && 'effective' in x));
  });

  test('test：擋下、提醒、沒命中三種結果', async () => {
    reset();
    const blocked = await engram(['guardrails', 'test', BLOCKED]);
    assert.equal(blocked.code, 0);
    assert.match(blocked.out, /會擋下/);
    assert.match(blocked.out, /inline-script-double-backslash｜擋下/);
    assert.match(blocked.out, /寫檔工具/);
    assert.match((await engram(['guardrails', 'test', 'rm -rf $DIR'])).out, /不會擋，但會在結果後附提醒[\s\S]*rm-shell-variable｜提醒/);
    assert.match((await engram(['guardrails', 'test', 'git status'])).out, /沒有命中任何規則/);
    const json = JSON.parse((await engram(['guardrails', 'test', BLOCKED, '--json'])).out);
    assert.equal(json.verdict, 'block');
    assert.equal(json.matches[0].id, 'inline-script-double-backslash');
  });

  test('test：沒有參數時從標準輸入讀（多行的指令）；什麼都沒有就是用法錯誤', async () => {
    reset();
    const heredoc = ["python - <<'EOF'", "x = '''hi'''", 'EOF', ''].join('\n');
    const r = await engram(['guardrails', 'test'], { stdin: stdinFrom(heredoc) });
    assert.match(r.out, /bash-heredoc-triple-quote/);
    const none = await engram(['guardrails', 'test']);
    assert.equal(none.code, 2);
    assert.match(none.err, /E_USAGE/);
  });

  test('設定為 hint 時 test 說明目前的設定與規則本來的動作', async () => {
    reset();
    await eg.settings.set({ guardrails: 'hint' });
    const r = await engram(['guardrails', 'test', BLOCKED]);
    assert.match(r.out, /不會擋，但會在結果後附提醒（目前設定是 hint）/);
    assert.match(r.out, /提醒（規則本來是擋下）/);
    reset();
  });

  test('disable／enable：只動這台電腦；清單標示已停用', async () => {
    reset();
    const off = await engram(['guardrails', 'disable', 'inline-script-double-backslash']);
    assert.equal(off.code, 0);
    assert.match(off.out, /已在這台電腦停用/);
    assert.match((await engram(['guardrails', 'test', BLOCKED])).out, /沒有命中任何規則/);
    assert.match((await engram(['guardrails'])).out, /inline-script-double-backslash｜停用｜Bash｜.*這台電腦已停用/);
    assert.match((await engram(['guardrails', 'disable', 'inline-script-double-backslash'])).out, /本來就是停用/);

    const on = await engram(['guardrails', 'enable', 'inline-script-double-backslash']);
    assert.match(on.out, /已在這台電腦恢復/);
    assert.match((await engram(['guardrails', 'test', BLOCKED])).out, /會擋下/);
    assert.match((await engram(['guardrails', 'enable', 'inline-script-double-backslash'])).out, /沒有被停用或降級/);
  });

  test('被誤擋自動降級的規則在清單裡有標示，enable 可以恢復', async () => {
    reset();
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString();
    fs.writeFileSync(path.join(eg.paths.local, 'guardrails-overrides.json'), JSON.stringify({ v: 1, rules: { 'inline-script-double-backslash': { action: 'hint', reason: 'falseBlock', until } } }));
    assert.match((await engram(['guardrails'])).out, new RegExp(`inline-script-double-backslash｜提醒｜.*已降成提醒（被誤擋後自動降級，${until.slice(0, 10)} 自動恢復）`));
    await engram(['guardrails', 'enable', 'inline-script-double-backslash']);
    assert.match((await engram(['guardrails'])).out, /inline-script-double-backslash｜擋下/);
  });

  test('比對太慢被停用的規則在清單裡標示原因', async () => {
    reset();
    fs.writeFileSync(path.join(eg.paths.local, 'guardrails-overrides.json'), JSON.stringify({ v: 1, rules: { 'rm-shell-variable': { action: 'off', reason: 'slow' } } }));
    assert.match((await engram(['guardrails'])).out, /rm-shell-variable｜停用｜Bash｜.*這台電腦已停用（比對太慢）/);
    reset();
  });

  test('approve：同步來的擋下規則要核可才真的擋下；清單顯示核可狀態；規則內容改過要重新核可', async () => {
    reset();
    writeRules([customRule()]);
    const before = await engram(['guardrails']);
    assert.match(before.out, /my-rule｜提醒｜Bash｜.*待核可（沒核可之前只當提醒）/);
    assert.match((await engram(['guardrails', 'test', 'run danger'])).out, /不會擋，但會在結果後附提醒[\s\S]*規則本來是擋下/);

    const ok = await engram(['guardrails', 'approve', 'my-rule']);
    assert.equal(ok.code, 0);
    assert.match(ok.out, /已在這台電腦核可「my-rule」，之後會真的擋下/);
    assert.match(ok.out, /範圍：Bash/);
    assert.match(ok.out, /樣式：danger/);
    assert.match(ok.out, /訊息：不要這樣寫。/);
    assert.match((await engram(['guardrails'])).out, /my-rule｜擋下｜Bash｜.*已核可/);
    assert.match((await engram(['guardrails', 'test', 'run danger'])).out, /會擋下/);
    assert.match((await engram(['guardrails', 'approve', 'my-rule'])).out, /已經核可過這份內容/);
    const json = JSON.parse((await engram(['guardrails', 'approve', 'my-rule', '--json'])).out);
    assert.deepEqual([json.ok, json.changed, json.approval], [true, false, 'approved']);

    writeRules([customRule({ message: '改過的訊息。' })]);
    assert.match((await engram(['guardrails'])).out, /my-rule｜提醒｜Bash｜.*待核可/);
    reset();
  });

  test('approve 是使用者本人的確認：在 Claude Code 裡（CLAUDECODE、CLAUDE_CODE_ENTRYPOINT）不能執行，什麼都不寫', async () => {
    reset();
    writeRules([customRule()]);
    for (const env of [{ CLAUDECODE: '1' }, { CLAUDECODE: '' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }]) {
      const r = await engram(['guardrails', 'approve', 'my-rule'], { env });
      assert.equal(r.code, 1, JSON.stringify(env));
      assert.match(r.err, /要由你本人確認，不能在 Claude Code 裡執行（E_CONFIRM）/);
      assert.match(r.err, /自己的終端機/);
      assert.equal(fs.existsSync(path.join(eg.paths.local, 'guardrails-approved.json')), false, '沒有寫核可紀錄');
    }
    // 其他子指令不受限制（停用、啟用、測試、列出）
    assert.equal((await engram(['guardrails', 'test', 'run danger'], { env: { CLAUDECODE: '1' } })).code, 0);
    assert.equal((await engram(['guardrails'], { env: { CLAUDECODE: '1' } })).code, 0);
    // 使用者自己的終端機：照常
    assert.equal((await engram(['guardrails', 'approve', 'my-rule'], { env: {} })).code, 0);
    reset();
  });

  test('defaults: true 的規則檔：清單先列內建的 6 條、再列檔案的規則；核可只對檔案的規則；略過的規則說明原因', async () => {
    reset();
    fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
    fs.writeFileSync(rulesFile(), JSON.stringify({ v: 1, defaults: true, rules: [customRule(), customRule({ id: 'too-slow', pattern: '.*a.*b.*c' })] }));
    const list = (await engram(['guardrails'])).out;
    assert.match(list, /規則來源：內建的預設規則＋vault\/guardrails\/rules\.json/);
    assert.ok(list.indexOf('bash-heredoc-triple-quote') < list.indexOf('my-rule'), '內建的在前');
    assert.match(list, /inline-script-double-backslash｜擋下｜Bash｜/);
    assert.match(list, /my-rule｜提醒｜Bash｜.*待核可/);
    assert.match(list, /too-slow：.*大範圍字元/);
    assert.match((await engram(['guardrails', 'approve', 'inline-script-double-backslash'])).out, /不需要核可（內建規則）/);
    assert.match((await engram(['guardrails', 'approve', 'my-rule'])).out, /已在這台電腦核可「my-rule」/);
    assert.match((await engram(['guardrails', 'test', 'run danger'])).out, /會擋下/);
    assert.match((await engram(['guardrails', 'test', BLOCKED])).out, /會擋下/, '內建的照擋');
    const json = JSON.parse((await engram(['guardrails', 'list', '--json'])).out);
    assert.equal(json.defaults, true);
    assert.equal(json.rules.length, 7);
    reset();
  });

  test('approve：內建規則與提醒類的規則不需要核可', async () => {
    reset();
    assert.match((await engram(['guardrails', 'approve', 'rm-shell-variable'])).out, /不需要核可（內建規則）/);
    writeRules([customRule({ action: 'hint' })]);
    assert.match((await engram(['guardrails', 'approve', 'my-rule'])).out, /不需要核可（只有擋下的規則需要核可/);
    reset();
  });

  test('錯誤：沒有規則 id、不存在的 id、多餘的參數、看不懂的子指令', async () => {
    reset();
    const noId = await engram(['guardrails', 'disable']);
    assert.equal(noId.code, 2);
    assert.match(noId.err, /要指定規則 id/);
    const noApproveId = await engram(['guardrails', 'approve']);
    assert.equal(noApproveId.code, 2);
    assert.equal((await engram(['guardrails', 'approve', 'nope'])).code, 1);
    const unknown = await engram(['guardrails', 'disable', 'nope']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /找不到規則：nope（E_NOT_FOUND）/);
    const extra = await engram(['guardrails', 'test', 'a', 'b']);
    assert.equal(extra.code, 2);
    assert.match(extra.err, /多了用不到的參數：b/);
    const bad = await engram(['guardrails', 'fly']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /看不懂的子指令：fly/);
  });
});

describe('API', () => {
  const api = () => createApi({ eg, jobs: {}, paths: { local: eg.paths.local, home: eg.paths.home, vault: eg.paths.vault }, info: {} });
  const none = new URLSearchParams();

  test('GET /api/guardrails：規則、目前設定、近 30 天的命中數與誤擋數', async () => {
    reset();
    const a = api();
    assert.ok(a.routes.includes('GET /api/guardrails'));
    const day = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(eg.paths.local, 'usage', 'guardrails'), { recursive: true });
    fs.writeFileSync(path.join(eg.paths.local, 'usage', 'guardrails', `${day}.jsonl`), [
      { rule: 'rm-shell-variable', kind: 'hint' },
      { rule: 'inline-script-double-backslash', kind: 'block' },
      { rule: 'inline-script-double-backslash', kind: 'falseBlock' },
      { rule: 'inline-script-double-backslash', kind: 'confirmed' },
    ].map((r) => `${JSON.stringify({ at: new Date().toISOString(), session: 's', ...r })}\n`).join(''));
    const r = await a.handle('GET', '/api/guardrails', none, {});
    assert.equal(r.mode, 'block');
    assert.equal(r.days, 30);
    assert.equal(r.rules.length, 6);
    assert.deepEqual(r.totals, { hits: 2, blocks: 1, falseBlocks: 1, confirmed: 1, slow: 0 });
    const rule = r.rules.find((x) => x.id === 'inline-script-double-backslash');
    assert.deepEqual([rule.hits, rule.blocks, rule.falseBlocks, rule.confirmed, rule.effective], [1, 1, 1, 1, 'block']);
    reset();
  });

  test('POST /api/guardrails/approve：核可同步來的擋下規則；缺 id 回 400；不存在回錯誤', async () => {
    reset();
    writeRules([customRule()]);
    const a = api();
    assert.ok(a.routes.includes('POST /api/guardrails/approve'));
    assert.equal((await a.handle('GET', '/api/guardrails', none, {})).rules[0].approval, 'pending');
    const r = await a.handle('POST', '/api/guardrails/approve', none, { id: 'my-rule' });
    assert.deepEqual([r.ok, r.changed, r.approval, r.rule.pattern], [true, true, 'approved', 'danger']);
    const after = (await a.handle('GET', '/api/guardrails', none, {})).rules[0];
    assert.deepEqual([after.approval, after.effective], ['approved', 'block']);
    await assert.rejects(a.handle('POST', '/api/guardrails/approve', none, {}), (e) => e.status === 400);
    await assert.rejects(a.handle('POST', '/api/guardrails/approve', none, { id: 'nope' }), (e) => e.code === 'E_NOT_FOUND');
    reset();
  });

  test('引擎沒有護欄（舊版）時回 501，不讓整個請求失敗', async () => {
    const old = createApi({ eg: { paths: eg.paths }, jobs: {}, paths: { local: eg.paths.local }, info: {} });
    await assert.rejects(old.handle('GET', '/api/guardrails', none, {}), (e) => e.status === 501);
    await assert.rejects(old.handle('POST', '/api/guardrails/approve', none, { id: 'x' }), (e) => e.status === 501);
  });

  test('PUT /api/settings 可以改 guardrails；不合法的值被拒絕', async () => {
    reset();
    const a = api();
    await a.handle('PUT', '/api/settings', none, { guardrails: 'hint' });
    assert.equal((await eg.settings.get()).guardrails, 'hint');
    assert.equal((await a.handle('GET', '/api/guardrails', none, {})).mode, 'hint');
    await assert.rejects(a.handle('PUT', '/api/settings', none, { guardrails: 'nope' }), (e) => e.code === 'E_INVALID');
    assert.equal((await eg.settings.get()).guardrails, 'hint');
    reset();
  });

  test('POST /api/guardrails/test：擋下、沒命中、指定 PowerShell；缺少指令或工具不對時拒絕', async () => {
    reset();
    const a = api();
    const r = await a.handle('POST', '/api/guardrails/test', none, { command: BLOCKED });
    assert.equal(r.verdict, 'block');
    assert.ok(r.matches.some((m) => m.id === 'inline-script-double-backslash' && m.action === 'block'));
    assert.equal((await a.handle('POST', '/api/guardrails/test', none, { command: 'git status' })).verdict, 'pass');
    assert.equal((await a.handle('POST', '/api/guardrails/test', none, { command: 'Get-ChildItem', tool: 'PowerShell' })).tool, 'PowerShell');
    await assert.rejects(a.handle('POST', '/api/guardrails/test', none, {}), (e) => e.status === 400);
    await assert.rejects(a.handle('POST', '/api/guardrails/test', none, { command: 'ls', tool: 'cmd' }), (e) => e.code === 'E_INVALID');
    reset();
  });

  test('POST /api/guardrails/disable、/enable：只動這台電腦；不存在的規則回 E_NOT_FOUND', async () => {
    reset();
    const a = api();
    const d = await a.handle('POST', '/api/guardrails/disable', none, { id: 'inline-script-double-backslash' });
    assert.deepEqual([d.ok, d.changed], [true, true]);
    const st = await a.handle('GET', '/api/guardrails', none, {});
    assert.equal(st.rules.find((x) => x.id === 'inline-script-double-backslash').effective, 'off');
    assert.equal((await a.handle('POST', '/api/guardrails/test', none, { command: BLOCKED })).verdict, 'pass');
    const e = await a.handle('POST', '/api/guardrails/enable', none, { id: 'inline-script-double-backslash' });
    assert.deepEqual([e.ok, e.changed], [true, true]);
    assert.equal((await a.handle('GET', '/api/guardrails', none, {})).rules.find((x) => x.id === 'inline-script-double-backslash').effective, 'block');
    await assert.rejects(a.handle('POST', '/api/guardrails/disable', none, { id: 'no-such-rule' }), (err) => err.code === 'E_NOT_FOUND');
    await assert.rejects(a.handle('POST', '/api/guardrails/enable', none, {}), (err) => err.status === 400);
    reset();
  });
});
