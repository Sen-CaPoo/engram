// 護欄（2.0.0 WP4b）的 Node 端：規則清單、測試一個指令、核可、停用或啟用規則、命中統計，以及開場訊息的後備提示。
// 比對本身是 plugin/hooks/lens/guard.mjs 的純函式（mod 與這裡共用同一份）；mod 在 Claude Code 裡實際擋下或提醒（plugin/hooks/guard.ts）。
//
// 資料位置：
// - vault/guardrails/rules.json：規則（會同步；不存在時用內建的預設規則）。不是記憶（不進索引、搜尋、健康檢查）。
//   2.0.0 WP9：只有記憶畢業會寫它（add／remove，一律是提醒類）；第一次建立時寫 defaults: true，內建規則照樣生效。
// - local/guardrails-overrides.json：這台電腦的覆寫（自己停用、被誤擋後暫時降成提醒、比對太慢被停用），優先於同步的規則。
// - local/guardrails-approved.json：規則檔來的 block 規則，在這台電腦核可過的內容雜湊；沒核可（或內容改過）就只當提醒。內建規則不需要核可。
// - local/usage/guardrails/<日期>.jsonl：命中紀錄（mod 寫入；只存規則 id、種類、時間與對話 id，不存指令原文）。
// - local/settings.json 的 guardrails：block（預設）｜hint｜off。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { E, EngramError, invariant } from './errors.mjs';
import { exists, readJson, readText, writeJson } from './fsx.mjs';
import {
  activeOverride, approvalState, compileRules, denyText, effectiveAction, evaluate, hintTexts, loadRules, normalizeMode, parseApprovals, parseOverrides, summaryLines, withApproval, withOverride,
} from '../../plugin/hooks/lens/guard.mjs';
import { DEFAULT_RULES, MAX_RULES } from '../../plugin/hooks/lens/guard.mjs';
import { loadAllow, scanWithAllow } from './secretallow.mjs';
import { commitPaths } from './vault.mjs';

const DAY_MS = 86_400_000;
const TOOLS = ['Bash', 'PowerShell'];

function files(ctx) {
  return {
    rules: path.join(ctx.vault, 'guardrails', 'rules.json'),
    overrides: path.join(ctx.local, 'guardrails-overrides.json'),
    approvals: path.join(ctx.local, 'guardrails-approved.json'),
    settings: path.join(ctx.local, 'settings.json'),
    usage: path.join(ctx.local, 'usage', 'guardrails'),
    marker: (sessionId) => path.join(ctx.local, 'cache', 'session', `${path.basename(String(sessionId))}.mod`),
  };
}

/** 規則（規則檔或預設）、這台電腦的覆寫、核可紀錄與設定 */
async function load(ctx) {
  const f = files(ctx);
  const loaded = loadRules(await readText(f.rules));
  const overrides = parseOverrides(await readText(f.overrides));
  const approvals = parseApprovals(await readText(f.approvals));
  const settings = (await readJson(f.settings, null)) ?? {};
  return { ...loaded, overrides, approvals, mode: normalizeMode(settings.guardrails), now: Date.now() };
}

const notFound = (id) => new EngramError(E.NOT_FOUND, `找不到規則：${String(id)}`, 'engram guardrails list 可以列出所有規則').withEn(`Rule not found: ${String(id)}`, 'engram guardrails list shows every rule');

/**
 * 處理同步衝突紀錄（第三輪審查 R4）：規則檔裡這幾條規則換成指定的版本（以 id 對應；檔案裡沒有就加在最後，rule 是 undefined 表示拿掉）。
 * entries：[{ id, rule }]。新的版本要通過規則檔來源的保守驗證、不能疑似含金鑰（和 add 同一套，不放寬）。
 * 不核可：核可記的是規則內容的雜湊，換了內容的擋下規則在這台核可之前只當提醒。
 * extra：要放進同一個 commit 的路徑（衝突紀錄的資料夾），engram undo 一次還原兩者。呼叫端持鎖。
 * beforeCommit：所有檢查都通過、寫入之後、commit 之前呼叫（呼叫端在這裡移除衝突紀錄：檢查沒過時紀錄留著）。
 */
export async function writeRuleVersions(ctx, entries, { extra = [], beforeCommit = null } = {}) {
  const f = files(ctx);
  const text = await readText(f.rules);
  const cur = text === null ? null : loadRules(text);
  if (text === null || cur.problem) {
    throw new EngramError(E.INVALID, `規則檔${text === null ? '不存在' : `壞掉了（${cur.problem}）`}，沒有改`, '先修正或刪除 vault/guardrails/rules.json').withEn(`The rules file ${text === null ? 'does not exist' : 'is broken'}, so nothing was changed`, 'Fix or delete vault/guardrails/rules.json first');
  }
  const doc = JSON.parse(text.replace(/^﻿/, ''));
  // 第四輪審查 F-13：寫入的是驗證、正規化之後的規則（只留認得的欄位），不是紀錄裡的物件原樣
  const normalized = (id, rule) => {
    if (rule === undefined) return undefined;
    const c = compileRules([rule]);
    if (!c.entries.length) {
      throw new EngramError(E.INVALID, `規則 ${id} 沒有通過護欄的驗證：${c.skipped[0]?.reason ?? '沒有載入'}，沒有改`).withEn(`Rule ${id} did not pass the guardrail validation, so nothing was changed`);
    }
    const { silentFailure, ...r } = c.entries[0].rule;
    return silentFailure ? { ...r, silentFailure } : r;
  };
  const want = new Map(entries.map((e) => [e.id, normalized(e.id, e.rule)]));
  const rules = doc.rules.filter((r) => !want.has(r?.id) || want.get(r.id) !== undefined).map((r) => (want.has(r?.id) ? want.get(r.id) : r));
  for (const [id, rule] of want) if (rule !== undefined && !rules.some((r) => r?.id === id)) rules.push(rule);
  if (rules.length > MAX_RULES) throw new EngramError(E.INVALID, `規則檔會超過 ${MAX_RULES} 條規則，沒有改`).withEn(`The rules file would exceed ${MAX_RULES} rules, so nothing was changed`);
  const allow = await loadAllow(ctx.local);
  for (const rule of want.values()) {
    if (rule && [rule.pattern, rule.unless, rule.message, rule.messageEn, rule.source].some((t) => typeof t === 'string' && scanWithAllow(t, 'guardrails/rules.json', allow).length)) {
      throw new EngramError(E.SECRET, '規則的內容疑似含有金鑰，沒有改').withEn('The rule looks like it contains a secret, so nothing was changed');
    }
  }
  const out = { ...doc, rules };
  const loaded = loadRules(JSON.stringify(out));
  for (const [id, rule] of want) {
    if (rule === undefined || loaded.entries.some((e) => e.rule.id === id)) continue;
    const why = loaded.skipped.find((s) => s.id === id)?.reason ?? '沒有載入';
    throw new EngramError(E.INVALID, `規則 ${id} 沒有通過護欄的驗證：${why}，沒有改`).withEn(`Rule ${id} did not pass the guardrail validation, so nothing was changed`);
  }
  await writeJson(f.rules, out);
  if (beforeCommit) await beforeCommit();
  const commit = await commitPaths(ctx.vault, ['guardrails/rules.json', ...extra], `guardrail resolve ${[...want.keys()].join(' ')}`.slice(0, 200), { action: 'edit', refs: ['guardrails/rules.json'], mid: ctx.mid });
  return { changed: true, commit: commit ?? undefined };
}

/**
 * 開場訊息的後備提示（mod 沒有載入時）：這台電腦已知的指令寫法問題，最多 6 條、每條一句。
 * 這場對話的標記檔 local/cache/session/<session id>.mod 存在（mod 在 session.start 寫入），或設定為 off，就不需要。
 * 回傳 core/session.mjs 的 warning 格式 { priority, text }；優先序最低，放不下時最先被省略。
 * 標題不說「護欄沒有載入」：/clear 與對話內 /resume 換了 session id 卻不會再觸發 mod 的 session.start，
 * 指令型 hook 與 mod 的先後順序也沒有驗證過，mod 實際在運作時這段仍可能出現。
 */
export async function guardrailFallback(ctx, { sessionId } = {}) {
  const f = files(ctx);
  const settings = (await readJson(f.settings, null)) ?? {};
  const mode = normalizeMode(settings.guardrails);
  if (mode === 'off') return null;
  if (sessionId && exists(f.marker(sessionId))) return null;
  const { entries } = loadRules(await readText(f.rules));
  const lines = summaryLines(entries, { mode, overrides: parseOverrides(await readText(f.overrides)) });
  if (!lines.length) return null;
  return { priority: 10, text: `這台電腦已知的指令寫法問題（請自己避開）：\n${lines.join('\n')}` };
}

export function guardrails(ctx) {
  const f = files(ctx);

  /**
   * 規則清單：每條規則加上目前實際的動作、核可狀態與這台電腦有效的覆寫（已到期的不算）。
   * approval：builtin（內建）｜approved（規則檔來的 block 規則，已核可）｜pending（還沒核可或內容改過，只當提醒）｜not-needed（提醒類）
   */
  async function list() {
    const g = await load(ctx);
    return {
      mode: g.mode,
      source: g.source,
      ...(g.defaults ? { defaults: true } : {}),
      // problem、skipped 的 reason 都有英文版（en.problem、skipped[].en.reason）；規則有 messageEn 時一起列出
      ...(g.problem ? { problem: g.problem, ...(g.en?.problem ? { en: { problem: g.en.problem } } : {}) } : {}),
      rules: g.entries.map((entry) => {
        const approval = approvalState(entry, g.approvals);
        return {
          ...entry.rule,
          effective: effectiveAction(entry.rule, { mode: g.mode, overrides: g.overrides, now: g.now, unapproved: approval === 'pending' }),
          approval,
          override: activeOverride(g.overrides, entry.rule.id, g.now),
        };
      }),
      skipped: g.skipped,
    };
  }

  /**
   * 近 days 天（含今天）的命中次數，依規則 id 彙整：{ hits（擋下加提醒）, blocks, hints, falseBlocks, confirmed, slow }。
   * falseBlocks：被擋下的指令重送後成功（誤擋）；confirmed：重送後工具回報錯誤（規則擋對了）；slow：規則比對太慢被停用。各自獨立計數。
   */
  async function usage({ days = 30, now = Date.now() } = {}) {
    const since = new Date(now - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    const per = {};
    let names = [];
    try {
      names = await fsp.readdir(f.usage);
    } catch { /* 還沒有任何紀錄 */ }
    for (const name of names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= since).sort()) {
      const text = (await readText(path.join(f.usage, name)).catch(() => null)) ?? '';
      for (const line of text.split('\n')) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (typeof row?.rule !== 'string') continue;
        const c = (per[row.rule] ??= { hits: 0, blocks: 0, hints: 0, falseBlocks: 0, confirmed: 0, slow: 0 });
        if (row.kind === 'block') { c.hits++; c.blocks++; } else if (row.kind === 'hint') { c.hits++; c.hints++; } else if (row.kind === 'falseBlock') c.falseBlocks++; else if (row.kind === 'confirmed') c.confirmed++; else if (row.kind === 'slow') c.slow++;
      }
    }
    return per;
  }

  return {
    list,

    /** 規則清單加上近 30 天的命中數、誤擋數、擋對數（GET /api/guardrails） */
    async status({ days = 30, now } = {}) {
      const [l, per] = await Promise.all([list(), usage({ days, now })]);
      const totals = { hits: 0, blocks: 0, falseBlocks: 0, confirmed: 0, slow: 0 };
      for (const c of Object.values(per)) { totals.hits += c.hits; totals.blocks += c.blocks; totals.falseBlocks += c.falseBlocks; totals.confirmed += c.confirmed; totals.slow += c.slow; }
      return {
        ...l,
        days,
        totals,
        rules: l.rules.map((r) => ({ ...r, hits: per[r.id]?.hits ?? 0, blocks: per[r.id]?.blocks ?? 0, hints: per[r.id]?.hints ?? 0, falseBlocks: per[r.id]?.falseBlocks ?? 0, confirmed: per[r.id]?.confirmed ?? 0, slow: per[r.id]?.slow ?? 0 })),
      };
    },

    /** 測試一個指令會怎樣（不執行、不寫紀錄）：verdict 是 block、hint 或 pass */
    async test(command, { tool = 'Bash' } = {}) {
      invariant(typeof command === 'string' && command.trim(), '請提供要測試的指令', undefined, { message: 'Provide the command to test' });
      invariant(TOOLS.includes(tool), 'tool 必須是 Bash 或 PowerShell', undefined, { message: 'tool must be Bash or PowerShell' });
      const g = await load(ctx);
      const hits = evaluate(g.entries, tool, command, { mode: g.mode, overrides: g.overrides, approvals: g.approvals, now: g.now });
      const blocked = hits.some((h) => h.action === 'block');
      return {
        mode: g.mode,
        tool,
        verdict: blocked ? 'block' : hits.length ? 'hint' : 'pass',
        matches: hits.map(({ id, action, declared, message }) => ({ id, action, declared, message })),
        ...(blocked ? { deny: denyText(hits) } : {}),
        hints: hintTexts(hits),
      };
    },

    /**
     * 在這台電腦核可一條規則檔來的 block 規則：記下目前這份內容的雜湊，之後才真的擋下；規則內容被改過就要重新核可。
     * 內建規則與提醒類的規則不需要核可（回傳 changed: false）。回傳規則的樣式與訊息，讓使用者看清楚核可的是什麼。
     */
    async approve(id) {
      const g = await load(ctx);
      const entry = g.entries.find((e) => e.rule.id === id);
      if (!entry) throw notFound(id);
      const approval = approvalState(entry, g.approvals);
      const { rule } = entry;
      const shown = { id: rule.id, tool: rule.tool, pattern: rule.pattern, flags: rule.flags, unless: rule.unless, message: rule.message };
      if (approval !== 'pending') return { ok: true, id, changed: false, approval, rule: shown };
      await writeJson(f.approvals, { v: 1, rules: withApproval(g.approvals, id, { hash: entry.hash, at: new Date().toISOString() }) });
      return { ok: true, id, changed: true, approval: 'approved', rule: shown };
    },

    /**
     * 記憶畢業（2.0.0 WP9）：在規則檔加一條規則。一律是提醒（hint）：同步來的擋下類規則要在每台核可，提醒類不必，
     * 所以自動加上去的規則不擋下任何指令。id、source、addedAt、by 由呼叫端給。
     * 規則檔不存在時建立 { v: 1, defaults: true, rules: [] }（內建規則照樣生效）；存在但壞掉時不覆蓋。
     * 寫入前把整份新內容交給 loadRules：新規則一定要通過規則檔來源的保守驗證（不放寬），同 id、超過上限、疑似金鑰都拒絕。
     * commit 的動作是 edit（記憶畢業的復原用 remove，不用 git revert：連續加的規則在 JSON 裡相鄰，revert 會衝突）。
     */
    async add(rule) {
      invariant(rule && typeof rule === 'object' && typeof rule.id === 'string', '規則的格式不對', undefined, { message: 'The rule is malformed' });
      const next = { id: rule.id, tool: rule.tool, pattern: rule.pattern, flags: rule.flags ?? '', unless: rule.unless ?? '', action: 'hint', message: rule.message, source: rule.source ?? '', addedAt: rule.addedAt ?? '', by: rule.by ?? '' };
      return ctx.locked('guardrails.add', async () => {
        const text = await readText(f.rules);
        let doc = { v: 1, defaults: true, rules: [] };
        if (text !== null) {
          const cur = loadRules(text);
          if (cur.problem) throw new EngramError(E.INVALID, `規則檔壞掉了，沒有加入規則：${cur.problem}`, '先修正或刪除 vault/guardrails/rules.json').withEn('The rules file is broken, so no rule was added', 'Fix or delete vault/guardrails/rules.json first');
          doc = JSON.parse(text.replace(/^﻿/, ''));
        }
        const taken = new Set([...doc.rules.map((r) => r?.id), ...(doc.defaults === true ? DEFAULT_RULES.map((r) => r.id) : [])]);
        if (taken.has(next.id)) throw new EngramError(E.CONFLICT, `已經有 id 是 ${next.id} 的規則`).withEn(`A rule with the id ${next.id} already exists`);
        if (doc.rules.length >= MAX_RULES) throw new EngramError(E.INVALID, `規則檔已經有 ${MAX_RULES} 條規則，沒有加入`).withEn(`The rules file already has ${MAX_RULES} rules, so no rule was added`);
        const allow = await loadAllow(ctx.local);
        if ([next.pattern, next.unless, next.message, next.source].some((t) => typeof t === 'string' && scanWithAllow(t, 'guardrails/rules.json', allow).length)) {
          throw new EngramError(E.SECRET, '規則的內容疑似含有金鑰，沒有加入').withEn('The rule looks like it contains a secret, so it was not added');
        }
        const out = { ...doc, rules: [...doc.rules, next] };
        const loaded = loadRules(JSON.stringify(out));
        if (!loaded.entries.some((e) => e.rule.id === next.id)) {
          const why = loaded.skipped.find((s) => s.id === next.id)?.reason ?? '沒有載入';
          throw new EngramError(E.INVALID, `規則沒有通過護欄的驗證：${why}`, '規則的樣式要避開可能讓比對卡住的寫法').withEn(`The rule did not pass the guardrail validation: ${why}`, 'Avoid patterns that could make matching hang');
        }
        await fsp.mkdir(path.dirname(f.rules), { recursive: true });
        await writeJson(f.rules, out);
        const commit = await commitPaths(ctx.vault, ['guardrails/rules.json'], `guardrail add ${next.id}`, { action: 'edit', refs: ['guardrails/rules.json'], mid: ctx.mid });
        return { ok: true, id: next.id, created: text === null, commit: commit ?? undefined };
      });
    },

    /** 從規則檔拿掉一條規則（記憶畢業的復原）；不在了就不動。內建規則不在檔案裡，不受影響 */
    async remove(id) {
      return ctx.locked('guardrails.remove', async () => {
        const text = await readText(f.rules);
        if (text === null || loadRules(text).problem) return { ok: true, id, changed: false };
        const doc = JSON.parse(text.replace(/^﻿/, ''));
        const rules = doc.rules.filter((r) => r?.id !== id);
        if (rules.length === doc.rules.length) return { ok: true, id, changed: false };
        await writeJson(f.rules, { ...doc, rules });
        const commit = await commitPaths(ctx.vault, ['guardrails/rules.json'], `guardrail remove ${id}`, { action: 'edit', refs: ['guardrails/rules.json'], mid: ctx.mid });
        return { ok: true, id, changed: true, commit: commit ?? undefined };
      });
    },

    /** 在這台電腦停用一條規則（只寫本機，不影響其他電腦） */
    async disable(id) {
      const g = await load(ctx);
      if (!g.entries.some((e) => e.rule.id === id)) throw notFound(id);
      await writeJson(f.overrides, { v: 1, rules: withOverride(g.overrides, id, { action: 'off', at: new Date().toISOString(), reason: 'manual' }) });
      return { ok: true, id, changed: g.overrides[id]?.action !== 'off' };
    },

    /** 在這台電腦重新啟用一條規則：拿掉本機覆寫，回到同步規則本來的動作（被誤擋降成提醒、比對太慢被停用的規則也一併恢復） */
    async enable(id) {
      const g = await load(ctx);
      const known = g.entries.some((e) => e.rule.id === id);
      if (!known && !g.overrides[id]) throw notFound(id);
      if (!g.overrides[id]) return { ok: true, id, changed: false };
      await writeJson(f.overrides, { v: 1, rules: withOverride(g.overrides, id, null) });
      return { ok: true, id, changed: true };
    },

    usage,
  };
}
