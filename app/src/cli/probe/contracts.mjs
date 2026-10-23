// 相容性探測的 7 個契約（移植自 claude-57 的 review/probe-reference.mjs，對應 90 號 E1–E9）。
// 每個契約都在暫存資料夾用 `claude -p --model haiku` 實際跑一次，檢查 Engram 依賴、但官方未載明的行為。
// run(t) 回傳 { ok, detail, en?: { detail } }；t 提供暫存資料夾工具與 claude 執行器（測試時注入假的）。
// 每個契約的 en.label 與 en.detail 是管理介面切到英文時顯示的版本；原始輸出（沒有中文的部分）原樣保留。
import fs from 'node:fs';
import path from 'node:path';

const ASK_MEMDIR = 'Your system prompt describes a persistent auto-memory directory. Output ONLY its exact absolute path as written in your system prompt, nothing else. If none is described, output NONE.';

const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const saysPath = (out, p) => norm(out).includes(norm(p));
const brief = (s, n) => String(s ?? '').trim().slice(0, n);

export const CONTRACTS = [
  {
    id: 'C1',
    label: '從資料夾根目錄啟動時，settings.local.json 的 autoMemoryDirectory 會生效（撞名資料夾的備援）',
    en: { label: 'When launched from the folder root, autoMemoryDirectory in settings.local.json takes effect (the fallback for colliding folders)' },
    async run(t) {
      const proj = t.mk('c1');
      const mem = t.mk('c1-mem');
      t.settingsLocal(proj, { autoMemoryDirectory: mem });
      const out = await t.claude(proj, ASK_MEMDIR);
      return { ok: saysPath(out, mem), detail: brief(out, 300), en: { detail: brief(out, 300) } };
    },
  },
  {
    id: 'C2',
    label: '從 git 子資料夾啟動時，記憶目錄仍是 repo 根目錄的編碼資料夾（junction 綁定的前提）',
    en: { label: 'When launched from a git subfolder, the memory directory is still the encoded folder of the repo root (the premise for junction binding)' },
    async run(t) {
      const proj = t.mk('c2');
      t.mk('c2', 'sub');
      t.gitInit(proj);
      const expected = path.join(t.claudeHome, 'projects', t.encode(t.gitRoot(proj) ?? proj), 'memory');
      const out = await t.claude(path.join(proj, 'sub'), ASK_MEMDIR);
      return { ok: saysPath(out, expected), detail: `預期 ${expected} · 實際 ${brief(out, 240)}`, en: { detail: `Expected ${expected} · Actual ${brief(out, 240)}` } };
    },
  },
  {
    id: 'C3',
    label: '透過 junction 寫入記憶：檔案落在 junction 目標，MEMORY.md 照常更新，沒有權限提示',
    en: { label: 'Writing memory through a junction: the file lands in the junction target, MEMORY.md updates as usual, and there is no permission prompt' },
    async run(t) {
      const proj = t.mk('c3');
      t.mk('c3', 'sub');
      const vault = t.mk('c3-vault');
      t.gitInit(proj);
      const encDir = path.join(t.claudeHome, 'projects', t.encode(t.gitRoot(proj) ?? proj));
      fs.mkdirSync(encDir, { recursive: true });
      fs.symlinkSync(vault, path.join(encDir, 'memory'), 'junction');
      // 與正式環境相同的設定（R-24）：把 junction 路徑本身列入 additionalDirectories。
      // 探測只載入 local 層（R-49），寫在啟動的資料夾，不依賴使用者自己的權限設定
      t.settingsLocal(path.join(proj, 'sub'), { permissions: { additionalDirectories: [path.join(encDir, 'memory')] } });
      const out = await t.claude(
        path.join(proj, 'sub'),
        'Please remember for future conversations: my favorite color is teal. Save it to your auto memory following your memory instructions, then reply DONE or the exact error.',
        // 用使用者自己的預設權限模式：透過 junction 寫入會被 Claude Code 當成敏感檔案詢問，能否通過取決於這個模式
        { tools: true, mode: t.userMode },
      );
      const files = fs.readdirSync(vault);
      const ok = files.includes('MEMORY.md') && files.some((f) => f !== 'MEMORY.md' && f.endsWith('.md'));
      return { ok, detail: `vault 檔案：${files.join(', ') || '（無）'} · 回覆：${brief(out, 400)}`, en: { detail: `Vault files: ${files.join(', ') || '(none)'} · Reply: ${brief(out, 400)}` } };
    },
  },
  {
    id: 'C4',
    label: 'MEMORY.md 在 SessionStart hook 之前讀入（因此正規化不能放在 SessionStart）',
    en: { label: 'MEMORY.md is read in before the SessionStart hook (so normalization cannot go in SessionStart)' },
    async run(t) {
      const proj = t.mk('c4');
      const mem = t.mk('c4-mem');
      t.write(path.join(mem, 'MEMORY.md'), '- [old](old.md) — TOKEN-OLD-1111\n');
      const target = path.join(mem, 'MEMORY.md').replace(/\\/g, '/');
      t.settingsLocal(proj, {
        autoMemoryDirectory: mem,
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `printf -- '- [new](new.md) — TOKEN-NEW-2222\\n' > '${target}'` }] }] },
      });
      const out = await t.claude(proj, 'Look at the MEMORY.md index contents already in your context (do not use tools). Output ONLY the TOKEN-... string you see, or NONE.');
      const hookRan = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8').includes('TOKEN-NEW');
      return { ok: hookRan && out.includes('TOKEN-OLD'), detail: `hook 有執行=${hookRan} · 看到：${brief(out, 80)}`, en: { detail: `Hook ran=${hookRan} · Saw: ${brief(out, 80)}` } };
    },
  },
  {
    id: 'C5',
    label: '寫入時 frontmatter 的頂層自訂欄位會被搬到 metadata 底下（解析器必須兩處都讀）',
    en: { label: 'On write, custom top-level frontmatter fields are moved under metadata (the parser must read both places)' },
    async run(t) {
      const proj = t.mk('c5');
      const mem = t.mk('c5-mem');
      t.settingsLocal(proj, { autoMemoryDirectory: mem });
      t.write(path.join(mem, 'feedback-indent.md'), '---\nname: feedback-indent\ndescription: User prefers tabs\nengram:\n  pinned: true\nmetadata:\n  type: feedback\n---\n\nThe user prefers tabs.\n');
      t.write(path.join(mem, 'MEMORY.md'), '- [Indent](feedback-indent.md) — user prefers tabs\n');
      await t.claude(proj, 'Correction: I now prefer 2-space indentation instead of tabs. Update the existing memory (no duplicate), then reply DONE.', { tools: true });
      const after = fs.readFileSync(path.join(mem, 'feedback-indent.md'), 'utf8');
      const fm = after.split('---')[1] ?? '';
      const moved = /\nmetadata:[\s\S]*\n\s+engram:/.test(fm) && !/\nengram:/.test(fm);
      const kept = /\nengram:/.test(fm);
      // 兩種結果引擎都能處理；只有欄位完全消失才算失敗
      const detail = moved ? '已搬到 metadata 底下（2.1.306 的行為）' : kept ? '仍在頂層（行為改變，僅供參考）' : 'engram 區塊遺失';
      const detailEn = moved ? 'Moved under metadata (the 2.1.306 behavior)' : kept ? 'Still at the top level (behavior changed, for reference only)' : 'The engram block is missing';
      return { ok: moved || kept, detail, en: { detail: detailEn } };
    },
  },
  {
    id: 'C6',
    label: 'SessionStart 的 additionalContext 會出現在模型上下文（動態內容的前提）',
    en: { label: 'additionalContext from SessionStart appears in the model context (the premise for dynamic content)' },
    async run(t) {
      const proj = t.mk('c6');
      const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ENGRAM-CTX-7319' } });
      t.settingsLocal(proj, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `printf '%s' '${payload}'` }] }] } });
      const out = await t.claude(proj, 'Is there a string starting with ENGRAM-CTX- in your context? Output it exactly, or NONE.');
      return { ok: out.includes('ENGRAM-CTX-7319'), detail: brief(out, 120), en: { detail: brief(out, 120) } };
    },
  },
  {
    id: 'C7',
    label: '執行環境把 junction 判定為 symlink（Claude Code 的清理流程因此會略過它）',
    en: { label: 'The runtime reports a junction as a symlink (so the Claude Code cleanup skips it)' },
    async run(t) {
      // 用 Node 判定；Claude Code 是 Bun 執行檔，2.1.306 實測兩者一致
      const dir = t.mk('c7');
      const target = t.mk('c7-target');
      fs.symlinkSync(target, path.join(dir, 'memory'), 'junction');
      const d = fs.readdirSync(dir, { withFileTypes: true }).find((x) => x.name === 'memory');
      const detail = `isSymbolicLink=${d.isSymbolicLink()} isDirectory=${d.isDirectory()}`;
      return { ok: d.isSymbolicLink() && !d.isDirectory(), detail, en: { detail } };
    },
  },
];
