// 41 號 §11「選用：同步工作準則」：把使用者寫在 ~/.claude/CLAUDE.md 的個人準則搬進 vault/core/rules/user-guidelines.md，
// 由 CORE.md 匯入，讓每台電腦一致。預設不執行；採用前先預覽，採用後可逐位元還原。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError } from './errors.mjs';
import { readJson, readText, safeWrite, sha1, writeJson } from './fsx.mjs';
import { commitPaths } from './vault.mjs';

const BLOCK_RE = /<!-- engram:begin[\s\S]*?<!-- engram:end -->\n?/;
const CORE_LINE = '@rules/user-guidelines.md';
const MARK_BEGIN = '<!-- engram:guidelines:begin -->';
const MARK_END = '<!-- engram:guidelines:end -->';

function manifestPath(homes) { return path.join(homes.local, 'install-manifest.json'); }

/** 把 CLAUDE.md 拆成「Engram 區塊」與「其餘使用者內容」。 */
function split(text) {
  const m = BLOCK_RE.exec(text);
  const block = m ? m[0] : '';
  const rest = m ? text.slice(0, m.index) + text.slice(m.index + m[0].length) : text;
  return { block, rest };
}

export function guidelines(ctx) {
  const claudeMd = path.join(ctx.homes.claudeHome, 'CLAUDE.md');
  const rulesRef = 'core/rules/user-guidelines.md';
  const rulesPath = path.join(ctx.vault, 'core', 'rules', 'user-guidelines.md');
  const corePath = path.join(ctx.vault, 'core', 'CORE.md');

  async function preview() {
    const text = (await readText(claudeMd)) ?? '';
    const { rest } = split(text);
    const current = rest.replace(/\r\n/g, '\n');
    const proposed = current.replace(/^\n+/, '').replace(/\n*$/, '\n');
    const core = (await readText(corePath)) ?? '';
    return {
      current,
      proposed: current.trim() ? proposed : '',
      coreLine: CORE_LINE,
      lines: current.trim() ? proposed.replace(/\n$/, '').split('\n').length : 0,
      adopted: core.includes(MARK_BEGIN),
    };
  }

  async function adopt() {
    return ctx.locked('guidelines.adopt', async () => {
      const text = await readText(claudeMd);
      if (text === null) throw new EngramError(E.NOT_FOUND, '找不到 ~/.claude/CLAUDE.md');
      const { block, rest } = split(text);
      if (!block) throw new EngramError(E.INVALID, '~/.claude/CLAUDE.md 還沒有 Engram 區塊', '先完成安裝');
      if (!rest.trim()) throw new EngramError(E.INVALID, '沒有可以搬移的工作準則');
      const core = (await readText(corePath)) ?? '';
      if (core.includes(MARK_BEGIN)) throw new EngramError(E.INVALID, '工作準則已經同步過了');
      // 1. 備份原檔（逐位元）並記進安裝清單，uninstall 與 revert 依此還原
      const dir = path.join(ctx.homes.local, 'backups', 'claude-md');
      await fsp.mkdir(dir, { recursive: true });
      const backup = path.join(dir, `CLAUDE.${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
      await fsp.writeFile(backup, text, 'utf8');
      // 2. 寫入規則檔（原文照搬，換行統一為 LF）
      const proposed = rest.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n*$/, '\n');
      await safeWrite(rulesPath, proposed);
      // 3. CORE.md 加上匯入（放在「## 3.」之前；找不到就放檔尾）
      const insert = `${MARK_BEGIN}\n${CORE_LINE}\n${MARK_END}\n\n`;
      const at = core.search(/^## 3\./m);
      const nextCore = at >= 0 ? `${core.slice(0, at)}${insert}${core.slice(at)}` : `${core.replace(/\n*$/, '\n\n')}${insert}`;
      await safeWrite(corePath, nextCore);
      // 4. 本機 CLAUDE.md 只留 Engram 區塊（CAS：剛好被改過就放棄，並復原 vault）
      const ok = await safeWrite(claudeMd, block.endsWith('\n') ? block : `${block}\n`, { expectHash: sha1(text) });
      if (!ok) {
        await safeWrite(corePath, core);
        fs.rmSync(rulesPath, { force: true });
        throw new EngramError(E.CONFLICT, '~/.claude/CLAUDE.md 剛好被修改，已取消', '稍後再試');
      }
      const manifest = (await readJson(manifestPath(ctx.homes), null)) ?? {};
      manifest.guidelines = { adoptedAt: new Date().toISOString(), backup, originalSha1: sha1(text), mid: ctx.mid };
      await writeJson(manifestPath(ctx.homes), manifest);
      const commit = await commitPaths(ctx.vault, [rulesRef, 'core/CORE.md'], 'adopt user guidelines', { action: 'edit', refs: [rulesRef], mid: ctx.mid });
      return { ok: true, commit: commit ?? undefined, backup };
    });
  }

  async function revert() {
    return ctx.locked('guidelines.revert', async () => {
      const manifest = (await readJson(manifestPath(ctx.homes), null)) ?? {};
      const g = manifest.guidelines;
      if (!g?.backup || !fs.existsSync(g.backup)) throw new EngramError(E.NOT_FOUND, '找不到採用前的備份');
      const original = await readText(g.backup);
      // 還原本機 CLAUDE.md：原檔逐位元；若使用者之後又改了 Engram 區塊以外的地方，保留現況並把原內容附在前面
      const cur = (await readText(claudeMd)) ?? '';
      const { rest } = split(cur);
      const restored = rest.trim() ? `${split(original).rest.replace(/\n*$/, '\n')}${cur}` : original;
      await safeWrite(claudeMd, restored);
      // 移除 CORE.md 的匯入與規則檔
      const core = (await readText(corePath)) ?? '';
      const nextCore = core.replace(new RegExp(`${MARK_BEGIN}\\n[\\s\\S]*?${MARK_END}\\n\\n?`), '');
      if (nextCore !== core) await safeWrite(corePath, nextCore);
      fs.rmSync(rulesPath, { force: true });
      delete manifest.guidelines;
      await writeJson(manifestPath(ctx.homes), manifest);
      const commit = await commitPaths(ctx.vault, [rulesRef, 'core/CORE.md'], 'revert user guidelines', { action: 'edit', refs: [rulesRef], mid: ctx.mid });
      return { ok: true, commit: commit ?? undefined };
    });
  }

  return { preview, adopt, revert };
}
