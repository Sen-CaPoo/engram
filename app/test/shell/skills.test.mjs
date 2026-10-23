// 外掛技能（plugin/skills/*/SKILL.md）的一致性：frontmatter 合乎 Claude Code 的規格，
// 技能與介面提到的 engram 指令、子指令、選項與 /engram:<技能> 都真的存在（避免改了 CLI 後說明悄悄過時）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { GLOBAL_OPTIONS } from '../../src/cli/args.mjs';
import { COMMANDS } from '../../src/cli/main.mjs';
import { parseMemoryFile } from '../../src/core/frontmatter.mjs';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = path.join(APP, 'plugin', 'skills');
const skillDirs = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const read = (p) => fs.readFileSync(p, 'utf8');
const skills = skillDirs.map((dir) => ({ dir, file: path.join(SKILLS, dir, 'SKILL.md'), text: read(path.join(SKILLS, dir, 'SKILL.md')) }));

// 有子指令的指令：允許的子指令（其他指令的第二個字是一般參數）
const SUBCOMMANDS = {
  inbox: ['show', 'apply', 'dismiss', 'resolve'],
  memory: ['list', 'show', 'write', 'move', 'remove', 'merge'],
  core: ['write'],
  collisions: ['apply', 'undo'],
  import: ['plan', 'apply', 'undo'],
  schedule: ['install', 'remove', 'status'],
};

/** 文字中所有出現在行內程式碼或程式碼區塊裡的 engram 指令（一行一個，含選項） */
function engramCalls(text) {
  const spans = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1])
    .concat([...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
  const calls = [];
  for (const span of spans) {
    for (const line of span.split('\n')) {
      for (const m of line.matchAll(/(?:^|[\s(|;&])engram ([a-z][a-z-]*)([^#|;&]*)/g)) calls.push({ cmd: m[1], rest: m[2], line: line.trim() });
    }
  }
  return calls;
}

describe('外掛技能', () => {
  test('至少有 engram、inbox、tidy、save、recall 五個技能', () => {
    for (const name of ['engram', 'inbox', 'tidy', 'save', 'recall']) assert.ok(skillDirs.includes(name), `缺少技能 ${name}`);
  });

  for (const s of skills) {
    test(`${s.dir}：frontmatter（name 與資料夾相同、description 長度、allowed-tools 只開放 engram）`, () => {
      const p = parseMemoryFile(s.text);
      assert.ok(p.hasFrontmatter && !p.errors.length, `${s.dir} 的 frontmatter 有誤：${p.errors.join('；')}`);
      assert.equal(p.data.name, s.dir);
      const desc = String(p.data.description ?? '');
      assert.ok(desc.length >= 20 && desc.length <= 400, `${s.dir} 的 description 應在 20～400 字之間（Claude Code 上限 1,536 字，而且每個對話都會載入），目前 ${desc.length}`);
      if (s.dir !== 'engram') {
        const tools = String(p.data['allowed-tools'] ?? '');
        assert.ok(tools, `${s.dir} 要用 allowed-tools 預先允許 engram 指令，否則預設權限模式下每一步都會詢問`);
        const rules = tools.split(/\s+(?=[A-Z])/);
        // 只開放技能用得到的 engram 子指令（不可以是涵蓋 uninstall、update、import、collisions 的 engram *），以及沒有 Bash 時寫草稿用的 ~/.engram/local/drafts
        const SAFE = /^(Bash|PowerShell)\(engram (inbox|memory|memory show|memory list|core|search|remember|undo|status|projects|sync)( \*)?\)$/;
        for (const rule of rules) assert.ok(SAFE.test(rule) || rule === 'Edit(~/.engram/local/drafts/**)', `${s.dir} 只能預先允許技能需要的 engram 子指令與草稿資料夾：${rule}`);
        // Windows 上 Claude 可能改用 PowerShell 工具執行；兩種工具的規則要成對
        const norm = (t) => rules.filter((r) => r.startsWith(t)).map((r) => r.slice(t.length)).sort();
        assert.deepEqual(norm('PowerShell'), norm('Bash'), `${s.dir} 的 Bash 與 PowerShell 規則要一致`);
        assert.ok(s.text.split('\n').length < 500, `${s.dir} 的 SKILL.md 應少於 500 行`);
      }
    });

    test(`${s.dir}：提到的 engram 指令、子指令與選項都存在`, () => {
      const calls = engramCalls(s.text);
      if (s.dir !== 'recall') assert.ok(calls.length > 0, `${s.dir} 沒有提到任何 engram 指令`);
      for (const c of calls) {
        const def = COMMANDS[c.cmd];
        assert.ok(def, `${s.dir}：沒有這個指令 engram ${c.cmd}（${c.line}）`);
        const words = c.rest.trim().split(/\s+/).filter(Boolean);
        if (SUBCOMMANDS[c.cmd] && words[0] && !words[0].startsWith('-') && !words[0].startsWith('<') && !words[0].startsWith('[')) {
          assert.ok(SUBCOMMANDS[c.cmd].includes(words[0]), `${s.dir}：engram ${c.cmd} 沒有子指令 ${words[0]}（${c.line}）`);
        }
        for (const flag of c.rest.matchAll(/--([a-z][a-z-]*)/g)) {
          const ok = Object.hasOwn(def.options ?? {}, flag[1]) || Object.hasOwn(GLOBAL_OPTIONS, flag[1]);
          assert.ok(ok, `${s.dir}：engram ${c.cmd} 沒有選項 --${flag[1]}（${c.line}）`);
        }
      }
    });
  }

  test('技能與管理介面提到的 /engram:<技能> 都存在', () => {
    const uiDir = path.join(APP, 'src', 'ui', 'src');
    const uiFiles = fs.readdirSync(uiDir, { recursive: true }).filter((f) => /\.(jsx?|mjs)$/.test(f)).map((f) => path.join(uiDir, f));
    const sources = [...skills.map((s) => ({ where: `技能 ${s.dir}`, text: s.text })), ...uiFiles.map((f) => ({ where: path.relative(APP, f), text: read(f) }))];
    let seen = 0;
    for (const src of sources) {
      for (const m of src.text.matchAll(/\/engram:([a-z][a-z-]*)/g)) {
        seen++;
        assert.ok(skillDirs.includes(m[1]), `${src.where} 提到不存在的技能 /engram:${m[1]}`);
      }
    }
    assert.ok(seen > 0);
  });

  test('寫入類技能都要求先取得使用者同意', () => {
    for (const s of skills.filter((x) => ['inbox', 'tidy', 'save'].includes(x.dir))) {
      assert.match(s.text, /同意/, `${s.dir} 要寫明「使用者同意後才寫入」`);
      assert.match(s.text, /停下來等使用者回覆/, `${s.dir} 要在提出計畫後停下來`);
      assert.match(s.text, /用 \*\*Bash\*\* 工具執行/, `${s.dir} 要指定用 Bash 執行（heredoc 與中文編碼）`);
      assert.match(s.text, /--file ~\/\.engram\/local\/drafts\//, `${s.dir} 要說明只有 PowerShell 時改用 --file 草稿`);
      assert.match(String(parseMemoryFile(s.text).data['allowed-tools']), /Edit\(~\/\.engram\/local\/drafts\/\*\*\)/, `${s.dir} 要預先允許寫草稿`);
      assert.match(s.text, /E_SECRET[\s\S]*engram not-secret/, `${s.dir} 要說明疑似金鑰被拒絕時怎麼做（只有使用者確認才執行 engram not-secret）`);
      assert.doesNotMatch(String(parseMemoryFile(s.text).data['allowed-tools']), /not-secret/, `${s.dir} 不可以預先允許 engram not-secret：那是使用者的確認`);
    }
  });
});
