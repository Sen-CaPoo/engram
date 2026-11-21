// 自動駕駛：找出 Claude 在對話中寫進「每次都會載入」的內容時，使用者當時說了什麼（2.0.0 Q6）。
// 待你確認的判斷拿它比對「寫進去的內容」和「使用者的要求」是否相符：相符的不必再送第二次審核。
// - 只讀這台電腦的對話紀錄（寫入那筆記憶的 commit 是這台做的才找）；子代理的對話不算（它的「使用者」是主代理）。
// - 找法：寫入工具（Write／Edit／MultiEdit）的目標路徑是那個檔案，或 Bash／PowerShell 用 engram remember、
//   engram memory write、重新導向寫進那個檔案；時間在那次變更之前 24 小時內（之後 60 秒內也算，commit 可能比寫入早一點記下時間），
//   而且晚於這筆的上一次變更（只有產生目前這個版本的那次寫入才算：更早的寫入對應的是舊版本，套用它的要求會判斷錯）。
//   第二輪審查 N4：工具結果要成功（失敗的 Edit、被拒絕的權限不算）；Write 的內容就是目前的內容、Edit 改成的文字在目前的內容裡；
//   指令型的寫入只認記憶路徑在寫入目的地的位置（讀取再重新導向、複製出去不算）。
//   不看記憶的 metadata.originSessionId：它記的是建立那筆記憶的對話，不一定是最後改它的對話。
// - 取出寫入之前最近的幾則使用者訊息（遮蔽疑似金鑰、截短）。只放進送給判斷的提示詞，不寫進任何檔案（產品決定：不同步對話原文）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { cleanUserText } from '../core/dream.mjs';
import { blobSha } from '../core/review.mjs';
import { redactSecrets } from '../core/secrets.mjs';
import { listTranscriptFiles } from '../core/usage.mjs';
import { normPath } from '../../plugin/hooks/lens/model.mjs';

/** 取寫入之前最近幾則使用者訊息、每則最多幾個字 */
export const REQUEST_MESSAGES = 3;
const REQUEST_CHARS = 1500;
const BEFORE_MS = 24 * 3600_000;
// 第二輪審查 N4：真正的寫入一定早於 commit；commit 的時間只到秒、工具呼叫的時間可能稍晚一點記下，只多留 60 秒
const AFTER_MS = 60_000;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 指令裡把 path 當成寫入的目的地（第二輪審查 N4：讀取再重新導向、複製出去都不算）：重新導向（>、>>）、tee、
 * PowerShell 的 Set-Content／Add-Content／Out-File 之後；cp、mv、Copy-Item、Move-Item 的最後一個參數。
 * flat 是小寫、反斜線換成正斜線的指令。
 */
function writesPath(flat, p) {
  const v = esc(p);
  const end = String.raw`["']?(?=$|[\s|;&)])`;
  return new RegExp(String.raw`(?:(?:^|[^<>&0-9])>>?|\btee\b(?:\s+-a)?|\b(?:set-content|add-content|out-file)\b[^|;&\n]*?)\s*["']?${v}${end}`).test(flat)
    || new RegExp(String.raw`\b(?:cp|mv|copy-item|move-item)\b[^|;&\n]*\s["']?${v}["']?\s*(?:$|[|;&\n])`).test(flat);
}

/**
 * 寫入之後的內容是不是目前的版本（第二輪審查 N4）：Write 的內容就是目前的內容；Edit／MultiEdit 改成的文字都在目前的內容裡。
 * 指令型的寫入看不到寫進去的內容，只看工具結果成功。
 */
function producesCurrent(block, target) {
  const input = block?.input ?? {};
  const lf = (t) => String(t ?? '').replace(/\r\n/g, '\n');
  if (block?.name === 'Write') return typeof input.content === 'string' && blobSha(input.content) === target.sha;
  if (block?.name === 'Edit') return typeof input.new_string === 'string' && !!input.new_string.trim() && target.current.includes(lf(input.new_string));
  if (block?.name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.length > 0 && edits.every((e) => typeof e?.new_string === 'string' && (!e.new_string.trim() || target.current.includes(lf(e.new_string))));
  }
  return true;
}

const lower = (p) => normPath(p).toLowerCase();

/** 一則使用者訊息的文字（工具結果、Claude Code 自動加的提醒不算）；不是使用者打的字時 null */
function userText(o) {
  if (o?.type !== 'user' || o.isMeta || o.isCompactSummary || o.isSidechain) return null;
  const c = o.message?.content;
  const t = typeof c === 'string' ? cleanUserText(c) : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => cleanUserText(b.text)).filter(Boolean).join('\n') : '';
  return t || null;
}

/** 指令裡 --name、--scope 的值 */
function optionOf(cmd, name) {
  const m = new RegExp(`--${name}(?:=|\\s+)("([^"]*)"|'([^']*)'|(\\S+))`).exec(cmd);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/**
 * 這個工具呼叫是不是寫入 target。target：{ ref, abs（小寫正斜線的絕對路徑）, scope: 'global'|'machine'|null, name }
 */
function writesTarget(block, target, home) {
  const input = block?.input ?? {};
  if (WRITE_TOOLS.has(block?.name)) {
    let p = normPath(String(input.file_path ?? ''));
    if (p === '~' || p.startsWith('~/')) p = normPath(home) + p.slice(1);
    return p.toLowerCase() === target.abs;
  }
  if (block?.name !== 'Bash' && block?.name !== 'PowerShell') return false;
  const cmd = String(input.command ?? '');
  const flat = cmd.replace(/\\/g, '/').toLowerCase();
  if (/\bengram(?:\.cmd)?\s+memory\s+write\s+/.test(flat) && flat.includes(target.ref.toLowerCase())) return true;
  if (target.scope && /\bengram(?:\.cmd)?\s+remember\b/.test(flat) && optionOf(cmd, 'name') === target.name && optionOf(cmd, 'scope') === target.scope) return true;
  // 用絕對路徑或 ~/ 開頭的路徑寫檔：路徑要在寫入目的地的位置
  const h = lower(home);
  const variants = [target.abs, target.abs.startsWith(`${h}/`) ? `~/${target.abs.slice(h.length + 1)}` : null].filter(Boolean);
  return variants.some((v) => writesPath(flat, v));
}

/**
 * 找出每一項寫入的那場對話與寫入之前的使用者訊息。
 * items：[{ ref, changedAt?, machine?, previousAt? }]（changedAt：最後一次變更的時間；machine：做那次變更的電腦；previousAt：再上一次變更的時間）
 * @returns {Promise<Map<string, { session: string, at: string, request: { at: string|null, text: string }[] }>>}
 */
export async function findWriteRequests(eg, items, { now = Date.now() } = {}) {
  const out = new Map();
  const vault = normPath(eg.paths.vault);
  const home = path.dirname(eg.paths.claudeHome);
  const targets = [];
  for (const it of items) {
    // 別台電腦做的變更：對話紀錄不在這台
    if (it.machine && it.machine !== eg.machine.id) continue;
    const anchor = Date.parse(it.changedAt ?? '') || now;
    const parts = String(it.ref).split('/');
    const scope = parts[0] === 'global' && parts.length === 2 ? 'global' : parts[0] === 'machines' && parts[1] === eg.machine.id && parts.length === 3 ? 'machine' : null;
    // 下限：24 小時內，而且晚於上一次變更（commit 的時間只到秒，多留 1 秒）
    const prev = Date.parse(it.previousAt ?? '');
    const from = Math.max(anchor - BEFORE_MS, Number.isFinite(prev) ? prev + 1000 : -Infinity);
    // 目前的內容：只認產生這個版本的那次寫入（第二輪審查 N4）
    const current = await fsp.readFile(path.join(eg.paths.vault, ...String(it.ref).split('/')), 'utf8').catch(() => null);
    if (current === null) continue;
    targets.push({ ref: it.ref, abs: `${vault}/${it.ref}`.toLowerCase(), scope, name: path.posix.basename(it.ref, '.md'), from, to: anchor + AFTER_MS, current: current.replace(/\r\n/g, '\n'), sha: blobSha(current) });
  }
  if (!targets.length) return out;
  const since = Math.min(...targets.map((t) => t.from));
  const files = (await listTranscriptFiles(eg.paths.claudeHome)).filter((f) => !/[\\/]subagents[\\/]/.test(f));
  const best = new Map();
  for (const file of files) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st || st.mtimeMs < since) continue;
    const sid = path.basename(file, '.jsonl');
    // 對話紀錄最後一次寫入早於這一項的時間範圍：不可能有那次寫入
    const mine = targets.filter((t) => st.mtimeMs >= t.from);
    if (!mine.length) continue;
    const users = [];
    // 寫入的工具呼叫等它的結果：成功（不是 is_error）才算數（第二輪審查 N4：失敗的 Edit、被拒絕的權限都不算）
    const pending = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const tool = line.includes('"tool_use"');
        const result = line.includes('"tool_use_id"');
        // 只解析可能有用的行：使用者打的字、工具呼叫與工具結果
        if (!tool && !result && !line.includes('"user"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.isSidechain) continue;
        const at = Date.parse(o.timestamp ?? '') || null;
        if (result && o.type === 'user' && Array.isArray(o.message?.content)) {
          for (const b of o.message.content) {
            if (b?.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
            const c = pending.get(b.tool_use_id);
            pending.delete(b.tool_use_id);
            if (b.is_error) continue;
            const prev = best.get(c.ref);
            if (!prev || c.ms >= prev.ms) best.set(c.ref, c);
          }
          continue;
        }
        const text = userText(o);
        if (text) { users.push({ at: at ? new Date(at).toISOString() : null, text }); if (users.length > REQUEST_MESSAGES) users.shift(); continue; }
        if (o.type !== 'assistant' || !Array.isArray(o.message?.content) || !at) continue;
        for (const b of o.message.content) {
          if (b?.type !== 'tool_use' || !b.id) continue;
          for (const t of mine) {
            if (at < t.from || at > t.to || !writesTarget(b, t, home) || !producesCurrent(b, t)) continue;
            if (users.length) pending.set(b.id, { ref: t.ref, ms: at, session: o.sessionId ?? sid, request: users.slice() });
          }
        }
      }
    } catch { /* 讀不到的對話紀錄略過 */ } finally { rl.close(); }
  }
  for (const [ref, b] of best) {
    out.set(ref, {
      session: String(b.session).slice(0, 80),
      at: new Date(b.ms).toISOString(),
      request: b.request.map((u) => {
        const t = redactSecrets(u.text).text;
        return { at: u.at, text: t.length > REQUEST_CHARS ? `${t.slice(0, REQUEST_CHARS)}…` : t };
      }),
    });
  }
  return out;
}
