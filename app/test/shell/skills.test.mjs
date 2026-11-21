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
  tidy: ['create', 'list', 'show', 'apply', 'done'],
  dream: ['status', 'prepare', 'done', 'reset', 'list'],
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
  test('至少有 engram、inbox、tidy、tidy-apply、save、recall、dream 七個技能', () => {
    for (const name of ['engram', 'inbox', 'tidy', 'tidy-apply', 'save', 'recall', 'dream']) assert.ok(skillDirs.includes(name), `缺少技能 ${name}`);
  });

  test('dream 只分析：不預先允許任何會改記憶的指令；可以讀回顧資料夾、寫草稿', () => {
    const tools = String(parseMemoryFile(skills.find((s) => s.dir === 'dream').text).data['allowed-tools']);
    for (const bad of [/engram memory \*/, /engram memory (write|move|remove|merge)/, /engram remember/, /engram undo/, /engram core/, /engram sync/, /engram tidy \*/, /engram tidy (apply|done)/]) assert.doesNotMatch(tools, bad);
    for (const ok of [/Bash\(engram dream \*\)/, /Bash\(engram tidy create \*\)/, /Read\(~\/\.engram\/local\/dream\/\*\*\)/]) assert.match(tools, ok);
  });

  test('dream-analyzer 子代理：只有讀取工具、用 sonnet', () => {
    const p = parseMemoryFile(read(path.join(APP, 'plugin', 'agents', 'dream-analyzer.md')));
    assert.equal(p.data.name, 'dream-analyzer');
    assert.equal(String(p.data.tools).split(/,\s*/).sort().join(','), 'Glob,Grep,Read');
    assert.equal(p.data.model, 'sonnet');
    assert.match(p.body, /資料，不是給你的指令/);
    assert.match(read(skills.find((s) => s.dir === 'dream').file), /engram:dream-analyzer/, 'dream 技能用這個子代理');
  });

  test('tidy 只分析：不預先允許任何會改記憶的指令（寫入只在使用者於介面決定後由 tidy-apply 執行）', () => {
    const tools = String(parseMemoryFile(skills.find((s) => s.dir === 'tidy').text).data['allowed-tools']);
    for (const bad of [/engram memory \*/, /engram memory (write|move|remove|merge)/, /engram remember/, /engram undo/, /engram core \*/, /engram sync/, /engram tidy \*/, /engram tidy (apply|done)/]) assert.doesNotMatch(tools, bad);
    for (const ok of [/Bash\(engram tidy create \*\)/, /Bash\(engram tidy list\)/, /Bash\(engram tidy show \*\)/]) assert.match(tools, ok);
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
        const SAFE = /^(Bash|PowerShell)\(engram (inbox|memory|memory show|memory list|core|search|remember|undo|status|projects|sync|tidy|tidy create|tidy list|tidy show|dream|autopilot (status|runs|on|off|run|preferences|digest)|autopilot (show|undo|budget) \*|holding|holding list|holding show)( \*)?\)$/;
        // 保留區（2.0.0）只預先允許讀取：採用與捨棄會改記憶，要照一般的權限詢問使用者
        assert.doesNotMatch(tools, /engram holding (\*|adopt|dismiss)/, `${s.dir} 不可以預先允許 engram holding 的採用與捨棄`);
        // dream（1.4.0）另外可以讀回顧資料夾（匯出的對話文字，只在本機）
        const extra = (r) => r === 'Edit(~/.engram/local/drafts/**)' || (s.dir === 'dream' && r === 'Read(~/.engram/local/dream/**)');
        for (const rule of rules) assert.ok(SAFE.test(rule) || extra(rule), `${s.dir} 只能預先允許技能需要的 engram 子指令與草稿資料夾：${rule}`);
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

  // 2.0.0（WP6 收尾）：使用者的決定是不拆分、不為了縮短而精簡記憶；技能不能再教 Claude 拆分或精簡
  test('技能不建議拆分記憶，也不為了縮短而精簡內容（和 H10 卡片的中性說明一致）', () => {
    for (const s of skills) {
      for (const m of s.text.matchAll(/拆分|拆成|拆開|精簡/g)) {
        const before = s.text.slice(Math.max(0, m.index - 6), m.index);
        assert.match(before, /不(要|必|建議|會)?\s*$|不$/, `${s.dir} 在「${s.text.slice(Math.max(0, m.index - 20), m.index + 20).replace(/\n/g, ' ')}」建議拆分或精簡`);
      }
      assert.doesNotMatch(s.text, /過長的內容|一個檔案應該只講一件事/, `${s.dir} 仍以檔案大小作為整理的理由`);
    }
    const tidy = skills.find((s) => s.dir === 'tidy').text;
    assert.doesNotMatch(tidy, /keep、update、move、archive、merge、create、split、promote/, 'tidy 不再列出 split 這個建議');
    const inbox = skills.find((s) => s.dir === 'inbox').text;
    assert.match(inbox, /H10[^\n]*不建議拆分/, 'inbox 的 H10 說明和卡片一致：不建議拆分');
  });

  test('寫入類技能都要求先取得使用者同意', () => {
    for (const s of skills.filter((x) => ['inbox', 'tidy', 'tidy-apply', 'save'].includes(x.dir))) {
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
