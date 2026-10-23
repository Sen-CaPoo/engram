// R-12：在完全隔離的假電腦上跑「安裝 → 匯入 → 解除安裝」，前後逐檔比對。
// 不建立工作排程器工作（schedule:false），也不碰真實的 ~/.claude、~/.engram。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planImport, applyImport } from '../../src/migrate/index.mjs';
import { runInstall } from '../../install/install.mjs';
import { runUninstall, stripBlock } from '../../install/uninstall.mjs';
import * as engine from '../../src/core/index.mjs';
import { mkTmp, rmTmp, machinePaths, makeRepo, addTranscript, memoryText } from '../core/helpers.mjs';

const quietIo = { print: () => {}, confirm: async () => true };

/** 列出資料夾內所有檔案的雜湊（junction 視為資料夾內容，略過 .git）。 */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(root, p).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function diff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}

test('移除區塊時逐字還原', () => {
  const orig = '# 我的準則\n\n- 用正體中文\n';
  const appended = '\n<!-- engram:begin · x -->\n@a\n<!-- engram:end -->\n';
  assert.equal(stripBlock(orig + appended, appended), orig);
  assert.equal(stripBlock(`${orig}\n<!-- engram:begin · y -->\n@b\n<!-- engram:end -->\n尾巴\n`, '不相符'), `${orig}尾巴\n`);
});

test('安裝 → 匯入 → 解除安裝：Claude 設定與專案資料夾逐檔一致', async (t) => {
  const root = mkTmp('engram-roundtrip-');
  t.after(() => rmTmp(root));
  const m = machinePaths(root, 'pc');
  // 使用者原本就有的設定與準則
  fs.mkdirSync(m.claudeHome, { recursive: true });
  fs.writeFileSync(path.join(m.claudeHome, 'CLAUDE.md'), '# 我的準則\n\n- 一律用正體中文\n');
  fs.writeFileSync(path.join(m.claudeHome, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto', allow: ['Bash(git status)'] }, hooks: { UserPromptSubmit: [] } }, null, 2));
  // 兩個專案：一個 git、一個一般資料夾，各有既有記憶
  const app = makeRepo(path.join(m.userHome, 'Desktop', 'shop-app'), { remote: 'https://github.com/example/shop-app.git' });
  const notes = path.join(m.userHome, 'Desktop', 'notes');
  fs.mkdirSync(notes, { recursive: true });
  for (const [dir, name] of [[app, 'db-choice'], [notes, 'reading-list']]) {
    const tr = addTranscript(m.claudeHome, dir);
    const mem = path.join(tr.dir, 'memory');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, `${name}.md`), memoryText({ name, description: `${name} 的說明`, type: 'project' }));
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), `- [${name}](${name}.md) — ${name} 的說明\n`);
  }
  const beforeClaude = snapshot(m.claudeHome);
  const beforeProjects = snapshot(path.join(m.userHome, 'Desktop'));

  const env = { ENGRAM_HOME: process.env.ENGRAM_HOME, CLAUDE_HOME: process.env.CLAUDE_HOME };
  process.env.ENGRAM_HOME = m.home; process.env.CLAUDE_HOME = m.claudeHome;
  t.after(() => { for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  const inst = await runInstall({ home: m.home, claudeHome: m.claudeHome, yes: true, schedule: false, plugin: false, label: '測試電腦', engine }, quietIo);
  assert.equal(inst.ok, true);
  assert.match(fs.readFileSync(path.join(m.claudeHome, 'CLAUDE.md'), 'utf8'), /engram:begin/);

  const eg = await engine.open({ home: m.home, claudeHome: m.claudeHome, userHome: m.userHome });
  await planImport(eg);
  const applied = await applyImport(eg, {});
  assert.equal(applied.ok, true);
  assert.ok(applied.bound >= 1, '至少要綁定一個資料夾');

  const un = await runUninstall({ home: m.home, claudeHome: m.claudeHome, yes: true, engine }, quietIo);
  assert.equal(un.ok, true);

  const claudeDiff = diff(beforeClaude, snapshot(m.claudeHome));
  const projectDiff = diff(beforeProjects, snapshot(path.join(m.userHome, 'Desktop')));
  assert.deepEqual(claudeDiff, [], `~/.claude 有差異：\n${claudeDiff.join('\n')}`);
  assert.deepEqual(projectDiff, [], `專案資料夾有差異：\n${projectDiff.join('\n')}`);
});
