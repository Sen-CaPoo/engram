// 自動駕駛：記憶畢業（2.0.0 WP9 P5）。有些記憶其實是規則或設定，換成更直接的形態更有效：
//   keep（維持）、core（核心準則的一行）、guardrail（一條護欄提醒規則）、env（環境設定檔的一項）、archive（封存一次性的進度）。
// - 每 7 天最多一次（看所有電腦同步的紀錄 machines/<mid>/autopilot.json 的 graduate.at），每次最多看 20 筆，
//   被讀取與被情境召回帶出最多的優先。候選只有全域與這台的單機記憶，而且目前內容有確認紀錄（第三輪審查 B：任何來源都算，
//   完全沒確認的不算）。第四輪審查 F-05：候選分兩批、各自一次呼叫，提示詞裡只放那一批：使用者或起點確認的一批可以畢業成
//   核心準則、護欄規則、環境設定或封存；其他來源（claude、request、autopilot）的一批只能畢業成未核可的環境設定或封存，
//   想寫進核心準則或成為護欄規則的記在 graduate.waiting（值是內容雜湊前 12 碼加 :core 或 :guardrail），使用者確認之後再判斷。
//   看過的內容（ref＋內容雜湊）記在 graduate.seen，內容沒變就不再看（不必每週重複判斷同一批，也不會因為多判斷幾次而碰巧通過）。
// - 除了 keep，每個提案都走既有的 screen（護欄與審核員；記憶畢業一律送審）。被拒的進保留區（task: graduate，只由使用者決定）。
// - 護欄規則一律是提醒（hint）、id 與 source（來源記憶的 ref）由程式填；樣式要通過 guard.mjs 對規則檔來源的保守驗證，
//   通不過就把提案送進保留區並註明原因（不放寬驗證）。環境設定走 env set 的同一組檢查，不核可（每台都要核可才會套用）。
//   核心準則受既有的限制：有還沒確認的版本、保留區有核心準則的提案、或這一輪已經改過核心準則時不提出；一輪最多一行。
// - 原記憶內文不動，只在 frontmatter 的 metadata.engram.graduated（to、at）記下去向（archive 除外），用 carryReviewed 寫入：
//   原本確認過的，改完仍算確認過（來源也延續），不會被「待你確認」再審一次，也不會從偏好區塊掉出去。
// - 復原（自動駕駛頁）：拿掉那條規則、那一項設定（值沒被改過時）、核心準則的那一行，再拿掉去向；封存用 git revert 還原。
//   不用 git revert 復原規則與設定：同一輪連續加的規則在 JSON 裡相鄰，revert 會衝突。
import path from 'node:path';
import { localDate, readJson, writeJsonAtomic } from '../../cli/fsutil.mjs';
import { E, EngramError } from '../../core/errors.mjs';
import { engramMeta, parseMemoryFile, setFields } from '../../core/frontmatter.mjs';
import { blobSha, reviewedIndex } from '../../core/review.mjs';
import { loadUsage } from '../../core/usage.mjs';
import { CORE_REF } from '../../tidy/plan.mjs';
import { compileRules } from '../../../plugin/hooks/lens/guard.mjs';
import { SETTINGS_WHITELIST, checkEnvEntry, checkSettingEntry } from '../../core/envsync.mjs';
import { masker } from '../../core/envhealth.mjs';
import { loadAllow } from '../../core/secretallow.mjs';
import { instructionFlags } from '../guard.mjs';
import { holdItem, memoryNamesOf, screen, snap } from '../pipeline.mjs';
import { GRADUATE_LINE_MAX, GRADUATE_SCHEMA, GUARD_MESSAGE_MAX, graduatePrompt } from '../prompts.mjs';
import { allMachineStates, graduateMarks, updateMachineState, waitingSha } from '../state.mjs';
import { coreUnsettled } from './curate.mjs';

const DAY = 86_400_000;
export const GRADUATE_EVERY_MS = 7 * DAY;
export const GRADUATE_MAX = 20;
/** 核心準則裡放畢業規則的段落（沒有就在「全域記憶索引」那一段之前新增） */
export const GRADUATED_HEADING = '## 從記憶畢業的規則';
const LINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha12 = (text) => blobSha(text).slice(0, 12);

/** 核心準則加上一行（放在「從記憶畢業的規則」段落的最後；已經有同一行就不動） */
export function insertCoreLine(text, line) {
  const bullet = `- ${line}`;
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n*$/, '').split('\n');
  if (lines.some((l) => l.trim() === bullet)) return `${lines.join('\n')}\n`;
  const h = lines.findIndex((l) => l.trim() === GRADUATED_HEADING);
  if (h >= 0) {
    let end = lines.findIndex((l, i) => i > h && /^#{1,2}\s/.test(l));
    if (end < 0) end = lines.length;
    while (end > h + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, bullet);
  } else {
    // 引用全域索引的那一行（@ 開頭）所在的段落之前；找不到就放在最後
    const imp = lines.findIndex((l) => /^@\S/.test(l.trim()));
    let sec = -1;
    for (let i = imp; i >= 0; i--) if (/^##\s/.test(lines[i])) { sec = i; break; }
    if (sec >= 0) lines.splice(sec, 0, GRADUATED_HEADING, '', bullet, '');
    else lines.push('', GRADUATED_HEADING, '', bullet);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 核心準則拿掉那一行（復原用）；沒有那一行時原樣回傳。段落因此變空時連標題一起拿掉，
 * 回到加這一行之前的樣子（removeCoreLine(insertCoreLine(x, l), l) === x，x 以換行結尾時）。
 */
export function removeCoreLine(text, line) {
  const bullet = `- ${line}`;
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.trim() === bullet);
  if (i < 0) return String(text ?? '');
  lines.splice(i, 1);
  const h = lines.findIndex((l) => l.trim() === GRADUATED_HEADING);
  if (h >= 0) {
    let end = lines.findIndex((l, k) => k > h && /^#{1,2}\s/.test(l));
    if (end < 0) end = lines.length;
    if (lines.slice(h + 1, end).every((l) => !l.trim())) {
      // 空的段落：標題與它後面的空行拿掉；放在檔尾的（insertCoreLine 在最後新增的）連前面那一行空行也拿掉
      const atEnd = end === lines.length;
      lines.splice(atEnd && h > 0 && !lines[h - 1].trim() ? h - 1 : h, atEnd && h > 0 && !lines[h - 1].trim() ? end - h + 1 : end - h);
    }
  }
  const out = lines.join('\n');
  return String(text ?? '').endsWith('\n') && !out.endsWith('\n') ? `${out}\n` : out;
}

/** 去向記在 frontmatter（內文不動） */
const markText = (raw, to, date) => setFields(raw, { 'metadata.engram.graduated.to': to, 'metadata.engram.graduated.at': date });

/** 這筆記憶是不是已經畢業過（frontmatter 有去向） */
function graduatedAlready(raw) {
  const g = engramMeta(parseMemoryFile(raw).data ?? {}).graduated;
  return !!(g && typeof g === 'object' && g.to);
}

/** 規則 id：mem-<記憶名稱>，和現有的重複時加上 -2、-3… */
function ruleId(name, taken) {
  const base = `mem-${String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 60);
  let id = LINE_ID.test(base) ? base : 'mem-rule';
  for (let k = 2; taken.has(id); k++) id = `${base.slice(0, 56)}-${k}`;
  return id;
}

/**
 * 記憶畢業要寫進去的內容的結構檢查（第四輪審查 F-03：產生提案與採用時共用同一套）。回傳不合格的原因，合格時 null。
 * - core：一行、GRADUATE_LINE_MAX 字以內、不含本機遮蔽的標記、不以 @ 或 # 開頭（核心準則裡會變成匯入或標題）。
 * - guardrail：只能是提醒類，訊息 GUARD_MESSAGE_MAX 字以內，要通過規則檔來源的保守驗證（和 mod 載入規則檔同一套）。
 * - env：和 env set 同一組檢查（拒絕清單、白名單、型別、家目錄、疑似金鑰）。
 * 不重跑 instructionFlags：程式偵測到可疑處而存進保留區的提案，本來就是留給使用者看過之後決定的。
 */
export function graduateTargetProblem(g, { allow = {}, homeMask } = {}) {
  if (g?.to === 'core') {
    const line = typeof g.line === 'string' ? g.line : '';
    // 第五輪審查 N-4：@路徑 寫在句子中間也是匯入語法（Claude Code 會把那個檔案載入每一場對話），所以整行都不能有 @ 接著文字
    if (!line.trim() || /[\r\n]/.test(line) || line.length > GRADUATE_LINE_MAX || line.includes('‹已遮蔽') || /^#/.test(line.trim()) || /(^|\s)@\S/.test(line)) {
      return `核心準則的那一行格式不對（要是一行、${GRADUATE_LINE_MAX} 字以內，不以 # 開頭，也不能有 @ 開頭的字）`;
    }
    return null;
  }
  if (g?.to === 'guardrail') {
    const rule = g.rule && typeof g.rule === 'object' ? g.rule : {};
    if (rule.action !== 'hint') return '記憶畢業的護欄規則只能是提醒';
    if (String(rule.message ?? '').length > GUARD_MESSAGE_MAX) return `訊息超過 ${GUARD_MESSAGE_MAX} 字`;
    const check = compileRules([rule]);
    return check.entries.length ? null : `護欄規則沒有通過驗證：${check.skipped[0]?.reason ?? '沒有載入'}`;
  }
  if (g?.to === 'env') {
    const e = g.env && typeof g.env === 'object' ? g.env : {};
    const c = (e.area === 'setting' ? checkSettingEntry : checkEnvEntry)(String(e.key ?? ''), e.value, { allow, homeMask });
    return c.ok ? null : `環境設定沒有通過檢查：${c.message}`;
  }
  return null;
}

/**
 * 執行一個畢業（自動駕駛通過 screen 之後、或使用者從保留區採用時）。g：{ to, ref, sha, title?, line?, rule?, env? }。
 * by：autopilot（審核員同意過）、user（使用者在管理介面或自己的終端機採用）或 claude（在 Claude Code 裡用 engram holding adopt 採用）。
 * 原記憶在判斷之後被改過（sha 不同）時不執行（E_CONFLICT）。
 * 第四輪審查：寫進去的內容採用時重新檢查一次（F-03，同步來的保留區檔案可能被改過）；寫進核心準則時，來源記憶目前的內容要是
 * 使用者或起點確認的（F-04，不論在哪裡採用）；在 Claude Code 裡（by: claude）寫的核心準則不記確認，留在「待你確認」。
 * 回傳復原用的資訊：{ to, ref, title, at, line?, ruleId?, env?, shas: [commit], coreUnconfirmed? }
 */
export async function applyGraduation(eg, g, { by = 'autopilot', now = Date.now() } = {}) {
  const raw = (await eg.memories.read(g.ref).catch(() => null))?.raw ?? null;
  if (raw === null) throw new EngramError(E.NOT_FOUND, `「${g.title ?? g.ref}」的記憶已經不在了，沒有畢業`).withEn(`The memory behind "${g.title ?? g.ref}" no longer exists, so it was not graduated`);
  if (g.sha && sha12(raw) !== String(g.sha).slice(0, 12)) {
    throw new EngramError(E.CONFLICT, `「${g.title ?? g.ref}」在判斷之後被修改過，沒有畢業`, '看過目前的內容後再決定').withEn(`"${g.title ?? g.ref}" changed after it was judged, so it was not graduated`, 'Check the current content and decide again');
  }
  const problem = graduateTargetProblem(g, { allow: await loadAllow(eg.paths.local), homeMask: masker({ userHome: eg.paths.home ? path.dirname(eg.paths.home) : '', claudeHome: eg.paths.claudeHome }) });
  if (problem) throw new EngramError(E.INVALID, `「${g.title ?? g.ref}」不能畢業：${problem}；這一項留在保留區`).withEn(`"${g.title ?? g.ref}" cannot be graduated: its content did not pass the check; it stays in the holding area`);
  if (g.to === 'core') {
    const idx = await reviewedIndex(eg.paths.vault);
    const off = (await eg.settings?.get?.().catch(() => null))?.reviewWrites === 'off';
    if (!off && !idx.get(g.ref)?.trusted.has(blobSha(raw))) {
      throw new EngramError(E.INVALID, `「${g.title ?? g.ref}」目前的內容還沒由你本人確認，不能寫進核心準則；這一項留在保留區`, '請先到管理介面「自動駕駛」頁的偏好區塊確認那筆記憶，再採用這一項').withEn(`The current content of "${g.title ?? g.ref}" has not been confirmed by you, so it cannot go into the core rules; it stays in the holding area`, 'Confirm that memory first in the preference section of the Autopilot page in the dashboard, then adopt this item');
    }
  }
  const date = localDate(new Date(now));
  const shas = [];
  const info = { to: g.to, ref: g.ref, title: g.title ?? path.posix.basename(g.ref, '.md'), at: new Date(now).toISOString() };
  if (g.to === 'archive') {
    if (engramMeta(parseMemoryFile(raw).data ?? {}).pinned === true) throw new EngramError(E.INVALID, '釘選的記憶不封存').withEn('Pinned memories are not archived');
    const r = await eg.memories.remove(g.ref);
    if (r?.commit?.sha) shas.push(r.commit.sha);
    return { ...info, shas };
  }
  if (g.to === 'core') {
    const cur = (await eg.core.read()).text ?? '';
    const next = insertCoreLine(cur, g.line);
    if (next !== cur) {
      // 第四輪審查 F-04：在 Claude Code 裡採用的不記確認（和 engram core write 一致），核心準則留在待你確認
      const r = await eg.core.write(next, { expect: cur, reviewed: by === 'claude' ? false : by === 'user' ? 'user' : 'autopilot' });
      if (r?.commit?.sha) shas.push(r.commit.sha);
      if (by === 'claude') info.coreUnconfirmed = true;
    }
    info.line = g.line;
  } else if (g.to === 'guardrail') {
    const r = await eg.guardrails.add(g.rule);
    if (r?.commit?.sha) shas.push(r.commit.sha);
    info.ruleId = r.id;
  } else if (g.to === 'env') {
    const r = await eg.envEntries.add(g.env);
    if (r?.commit?.sha) shas.push(r.commit.sha);
    info.env = g.env;
  } else throw new EngramError(E.INVALID, `看不懂的畢業去向：${String(g.to).slice(0, 20)}`).withEn(`Unknown graduation target: ${String(g.to).slice(0, 20)}`);
  // 原記憶只記下去向（內文不動）；原本確認過的，改完仍算確認過。
  // 記不下去（例如 frontmatter 格式有誤、剛被修改）：把剛寫進去的規則、設定或那一行拿掉，整個不算數（不留下沒有復原依據的變更）
  try {
    const m = await eg.memories.write(g.ref, { frontmatter: { 'metadata.engram.graduated.to': g.to, 'metadata.engram.graduated.at': date }, carryReviewed: true });
    if (m?.commit?.sha) shas.push(m.commit.sha);
  } catch (err) {
    await undoTarget(eg, info).catch(() => {});
    throw err;
  }
  return { ...info, shas };
}

/** 拿掉畢業寫進去的規則、設定或核心準則的那一行（不動原記憶） */
async function undoTarget(eg, info) {
  if (info.to === 'guardrail' && info.ruleId) await eg.guardrails.remove(info.ruleId);
  else if (info.to === 'env' && info.env) await eg.envEntries.remove(info.env);
  else if (info.to === 'core' && info.line) {
    const cur = (await eg.core.read()).text ?? '';
    const next = removeCoreLine(cur, info.line);
    if (next !== cur) await eg.core.write(next, { expect: cur, carryReviewed: true });
  }
}

/** 復原一個畢業（自動駕駛頁的復原）：拿掉規則、設定或核心準則的那一行，再拿掉去向；封存的用 git revert 還原 */
export async function undoGraduation(eg, info) {
  if (info.to === 'archive') {
    for (const sha of [...(info.shas ?? [])].reverse()) await eg.undo(sha);
    return;
  }
  await undoTarget(eg, info);
  const raw = (await eg.memories.read(info.ref).catch(() => null))?.raw ?? null;
  if (raw !== null && graduatedAlready(raw)) await eg.memories.write(info.ref, { frontmatter: { 'metadata.engram.graduated': undefined }, carryReviewed: true });
}

/**
 * 記憶畢業的候選（graduateMemories 與每週摘要共用，第三輪審查 B）：全域與這台的單機記憶，目前內容有確認紀錄（任何來源：
 * 使用者、起點、對話裡的要求、Claude 在對話裡存的、自動駕駛代為確認）、還沒畢業、這個內容還沒看過、沒有疑似金鑰；
 * 讀取與被情境召回帶出最多的在前。完全沒有確認紀錄的（還在「待你確認」）不是候選。
 * 判斷成適合寫進核心準則或成為護欄規則、但目前內容不是使用者或起點確認的（waiting），使用者確認之前不再看（不佔每次的名額）。
 * 使用者關掉確認寫入（reviewWrites: off）時，所有內容都當成使用者確認過。
 * @returns {Promise<{ pool: { m, s, reads, recalled, trusted }[], unconfirmed: number, waiting: Set<string> }>}
 */
export async function graduationPool(eg, mid, { snapshot = new Map(), states = null } = {}) {
  const { seen, waiting: waitMarks } = graduateMarks(states ?? await allMachineStates(eg.paths.vault));
  const idx = await reviewedIndex(eg.paths.vault);
  const off = (await eg.settings?.get?.().catch(() => null))?.reviewWrites === 'off';
  const usage = await loadUsage(eg.paths.vault).catch(() => ({ refs: new Map() }));
  const pool = [];
  const waiting = new Set();
  let unconfirmed = 0;
  for (const m of await eg.memories.list()) {
    if (!(m.scope?.kind === 'global' || (m.scope?.kind === 'machine' && m.scope.mid === mid))) continue;
    const s = await snap(eg, snapshot, m.ref);
    const skip = () => snapshot.delete(m.ref);
    if (!s || graduatedAlready(s.raw)) { skip(); continue; }
    const sha = blobSha(s.raw);
    const e = idx.get(m.ref);
    const trusted = off || !!e?.trusted.has(sha);
    if (!off && !e?.shas.has(sha)) { unconfirmed++; skip(); continue; }
    if (seen[m.ref] === sha.slice(0, 12)) { skip(); continue; }
    if (waitingSha(waitMarks[m.ref]) === sha.slice(0, 12) && !trusted) { waiting.add(m.ref); skip(); continue; }
    if (s.redacted) { skip(); continue; }
    const u = usage.refs.get(m.ref);
    pool.push({ m, s, reads: u?.reads ?? 0, recalled: u?.recalled ?? 0, trusted });
  }
  pool.sort((a, b) => (b.reads + b.recalled) - (a.reads + a.recalled) || a.m.ref.localeCompare(b.m.ref));
  return { pool, unconfirmed, waiting };
}

/** 要使用者確認之後才能寫進核心準則或成為護欄規則的說明（執行紀錄與每週摘要用同一句） */
export const needsConfirmNote = (n) => `${n} 筆常用的記憶要你確認之後才能寫進核心準則或成為護欄規則：到管理介面「自動駕駛」頁的偏好區塊確認`;

/** 這一輪能不能提出核心準則的一行：沒有還沒確認的版本、保留區沒有核心準則的提案、這一輪還沒改過核心準則 */
async function coreBlocked(ctx) {
  const why = await coreUnsettled(ctx.eg).catch(() => '讀不到核心準則的狀態');
  if (why) return why;
  if (ctx.run.actions.some((a) => a.status === 'done' && (a.refs ?? []).includes(CORE_REF))) return '這一輪已經改過核心準則';
  if ((ctx.paused ?? []).includes('core')) return '「核心準則」類的處理被你復原過多次，暫停中';
  return null;
}

/** 沒有候選時的說明：只在「還沒確認」或「要你確認」的筆數和上一次寫的不同時才寫一則（第四輪審查 F-12；記在這台的 local） */
const noteFile = (local) => path.join(local, 'autopilot', 'graduate-note.json');
async function noteNoCandidates(ctx, unconfirmed, waiting) {
  const file = noteFile(ctx.eg.paths.local);
  const prev = await readJson(file, null).catch(() => null);
  if (prev && prev.unconfirmed === unconfirmed && prev.waiting === waiting) return;
  await writeJsonAtomic(file, { unconfirmed, waiting, at: new Date(ctx.clock?.() ?? Date.now()).toISOString() }).catch(() => {});
  const why = [unconfirmed ? `${unconfirmed} 筆還沒確認過（在「待你確認」），確認之前不會看` : null, waiting ? needsConfirmNote(waiting) : null].filter(Boolean);
  ctx.run.notes.push({ task: 'graduate', note: `記憶畢業：沒有可以看的記憶（候選是目前內容確認過、內容有變或還沒看過的全域與這台的單機記憶）${why.length ? `；${why.join('；')}` : ''}` });
}

/**
 * 記憶畢業（每 7 天最多一次）。第四輪審查 F-05：候選分成兩批、各自一次呼叫，提示詞裡只放那一批：
 * - 可信的一批（目前內容由使用者本人或起點確認）：去向可以是 core、guardrail、env、archive、keep；
 * - 其他來源的一批（只被 claude／request／autopilot 確認）：去向只能是 env（本來就要每台核可）、archive、keep；
 *   程式端也檢查：這一批的決定出現 core 或 guardrail 就不執行，改記在 waiting（要你確認）。
 * 兩批合計每次最多 GRADUATE_MAX 筆（可信的優先）；其中一批是空的就不呼叫。每一個決定的 ref 必須屬於那一次呼叫的那一批，否則丟棄。
 * 一批的呼叫失敗不影響另一批：失敗那一批的記憶不記為看過，下一次再看。
 */
export async function graduateMemories(ctx) {
  const { eg, call, run, mid, paused = [], cap } = ctx;
  if (ctx.shared === false) return; // 會寫進所有電腦共用的核心準則、規則檔與環境設定檔：沒拿到另一台的最新變更時不做
  const now = ctx.clock?.() ?? Date.now();
  const states = await allMachineStates(eg.paths.vault);
  const last = Math.max(0, ...states.map((s) => Date.parse(s.graduate?.at ?? '') || 0));
  if (now - last < GRADUATE_EVERY_MS) return;

  // 候選（graduationPool）：有確認紀錄的全域與這台的單機記憶；讀取與帶出最多的優先
  const snapshot = new Map();
  const { pool, unconfirmed, waiting } = await graduationPool(eg, mid, { snapshot, states });
  const trustedList = pool.filter((p) => p.trusted).slice(0, GRADUATE_MAX);
  const otherList = pool.filter((p) => !p.trusted).slice(0, GRADUATE_MAX - trustedList.length);
  const picked = [...trustedList, ...otherList];
  if (!picked.length) { await noteNoCandidates(ctx, unconfirmed, waiting.size); return; }

  const coreWhy = trustedList.length ? await coreBlocked(ctx) : null;
  const coreSnap = trustedList.length && !coreWhy ? await snap(eg, snapshot, CORE_REF) : null;
  const coreOk = !!coreSnap && !coreSnap.redacted;
  const rulesText = await eg.guardrails.list().then((l) => l.rules).catch(() => []);
  const profile = await eg.env.profile().catch(() => null);
  const batches = [
    { list: trustedList, trusted: true, forms: [...(coreOk ? ['core'] : []), 'guardrail', 'env', 'archive'], label: '記憶畢業' },
    { list: otherList, trusted: false, forms: ['env', 'archive'], label: '記憶畢業（還沒由你確認的記憶）' },
  ].filter((b) => b.list.length);
  const answered = []; // [{ d, batch }]
  const judgedBatches = new Set();
  for (const b of batches) {
    b.byRef = new Map(b.list.map((p) => [p.m.ref, p]));
    const prompt = graduatePrompt({
      memories: b.list.map(({ m, s, reads, recalled }) => ({ ref: m.ref, name: m.name, type: m.type, description: m.description, reads, recalled, pinned: s.pinned, text: s.shown })),
      forms: b.forms,
      untrusted: !b.trusted,
      core: b.forms.includes('core') ? coreSnap.shown : undefined,
      rules: rulesText.map((r) => ({ id: r.id, message: r.message })),
      envKeys: Object.keys(profile?.profile?.env ?? {}),
      settingKeys: Object.keys(profile?.profile?.settings ?? {}),
      whitelist: SETTINGS_WHITELIST,
      preferences: ctx.preferences,
      feedback: (ctx.feedback ?? []).slice(-30),
      corrections: ctx.corrections ?? [],
    });
    const r = await call(b.label, { schema: GRADUATE_SCHEMA, prompt });
    if (!r.ok) { run.skipped.push({ task: 'graduate', why: r.error?.message ?? 'LLM 失敗' }); continue; }
    judgedBatches.add(b);
    for (const d of Array.isArray(r.data?.decisions) ? r.data.decisions : []) answered.push({ d, b });
  }
  if (!judgedBatches.size) return;
  if (coreWhy) run.notes.push({ task: 'graduate', note: `${coreWhy}，這一輪不把記憶畢業成核心準則` });

  const fix = (x, b) => { const t = String(x ?? '').trim().replace(/^\.?\//, ''); return b.byRef.has(t) ? t : b.byRef.has(`${t}.md`) ? `${t}.md` : t; };
  const byRef = new Map(picked.map((p) => [p.m.ref, p]));
  const judged = new Set(); // 這一輪看過、有結論的（記進 seen）；延後的不記，下一次再看
  const items = [];
  const invalid = []; // 程式檢查不過（規則驗證、白名單、格式）：直接存進保留區並註明原因
  const allow = await loadAllow(eg.paths.local);
  const homeMask = masker({ userHome: eg.paths.home ? path.dirname(eg.paths.home) : '', claudeHome: eg.paths.claudeHome });
  const takenIds = new Set([...rulesText.map((x) => x.id)]);
  const postponed = new Set();
  const blocked = new Map(); // ref → 想要的去向（core、guardrail）：目前內容不是使用者或起點確認的，要等使用者確認
  let coreTaken = false;
  /** 新寫進去的內容（那一行、規則、設定）有程式偵測到的可疑處：不送審、不執行，存進保留區留給使用者（沒有「待你確認」可以把關） */
  const suspicious = (it, text) => {
    const fl = instructionFlags(text);
    if (!fl.length) return false;
    it.flags = fl;
    invalid.push({ it, why: `程式偵測到可疑處（${fl.join('、')}），不自動畢業，留給你決定` });
    return true;
  };
  const taken = (ref) => judged.has(ref) || blocked.has(ref) || items.some((x) => x.ref === ref) || invalid.some((x) => x.it.ref === ref);
  for (const { d, b } of answered) {
    const ref = fix(d?.ref, b);
    const p = b.byRef.get(ref); // 決定的 ref 要屬於這一次呼叫的那一批，否則丟棄
    if (!p || taken(ref)) continue;
    // 一個提案處理不了（例如 frontmatter 格式有誤，記不下去向）：當成看過，不影響其他提案與這一次的紀錄
    try {
    const form = String(d.form ?? 'keep');
    const title = String(d.title ?? '').trim().slice(0, 120) || `記憶畢業：${p.m.name}`;
    const reason = String(d.reason ?? '').trim().slice(0, 2000) || '（沒有理由）';
    const sha = sha12(p.s.raw);
    const base = { ref, title, reason, cards: [] };
    if (form === 'keep' || !['core', 'guardrail', 'env', 'archive'].includes(form)) { judged.add(ref); continue; }
    // 其他來源的一批：core、guardrail 不執行，記在 waiting（使用者確認之後下一次再判斷）
    if (!p.trusted && (form === 'core' || form === 'guardrail')) { blocked.set(ref, form); continue; }
    if (form === 'archive') {
      if (p.s.pinned) { judged.add(ref); run.notes.push({ task: 'graduate', note: `${ref} 是釘選的記憶，不封存` }); continue; }
      items.push({ ...base, action: 'archive', ops: [{ op: 'remove', ref }], graduate: { to: 'archive', ref, sha, title: p.m.name } });
      continue;
    }
    const marked = markText(p.s.raw, form, localDate(new Date(now)));
    const markOp = { op: 'graduate', ref, to: form, content: marked };
    if (form === 'core') {
      const line = String(d.line ?? '').replace(/^[-*]\s+/, '').trim();
      if (!coreOk || coreTaken) { postponed.add(ref); continue; } // 這一輪不能提出（或已經有一行）：不記為看過，下一次再判斷
      const g = { to: 'core', ref, sha, title: p.m.name, line };
      const problem = graduateTargetProblem(g);
      if (problem) {
        invalid.push({ it: { ...base, action: 'graduate', ops: [{ op: 'core', content: insertCoreLine(coreSnap.raw, line.replace(/[\r\n]+/g, ' ') || '（空白）') }, markOp], graduate: { ...g, line: line.replace(/[\r\n]+/g, ' ') } }, why: problem });
        continue;
      }
      const it = { ...base, action: 'graduate', ops: [{ op: 'core', content: insertCoreLine(coreSnap.raw, line) }, markOp], graduate: g };
      if (suspicious(it, line)) continue;
      coreTaken = true;
      items.push(it);
      continue;
    }
    if (form === 'guardrail') {
      const raw = d.rule && typeof d.rule === 'object' ? d.rule : {};
      const rule = {
        id: ruleId(p.m.name, takenIds), tool: ['Bash', 'PowerShell', '*'].includes(raw.tool) ? raw.tool : 'Bash',
        pattern: String(raw.pattern ?? ''), flags: String(raw.flags ?? ''), unless: String(raw.unless ?? ''), action: 'hint',
        message: String(raw.message ?? '').trim(), source: ref, addedAt: localDate(new Date(now)), by: 'autopilot',
      };
      takenIds.add(rule.id);
      const g = { to: 'guardrail', ref, sha, title: p.m.name, rule };
      const it = { ...base, action: 'graduate', ops: [{ op: 'guardrail', content: JSON.stringify(rule, null, 2) }, markOp], graduate: g };
      // 規則檔來源的保守驗證（和 mod 載入規則檔時同一套，不放寬；採用時再檢查一次）
      const problem = graduateTargetProblem(g);
      if (problem) { invalid.push({ it, why: problem }); continue; }
      if (suspicious(it, [rule.message, rule.pattern, rule.unless].join('\n'))) continue;
      items.push(it);
      continue;
    }
    // env
    const raw = d.env && typeof d.env === 'object' ? d.env : {};
    const area = raw.area === 'setting' ? 'setting' : 'env';
    const key = String(raw.key ?? '').trim();
    let value = String(raw.value ?? '');
    if (area === 'setting' && /^\d+$/.test(value)) value = Number(value); // 數字型的設定（cleanupPeriodDays）
    const g = { to: 'env', ref, sha, title: p.m.name, env: { area, key, value } };
    const it = { ...base, action: 'graduate', ops: [{ op: 'env', content: JSON.stringify({ area, key, value }, null, 2) }, markOp], graduate: g };
    const problem = graduateTargetProblem(g, { allow, homeMask });
    if (problem) { invalid.push({ it, why: problem }); continue; }
    if (area === 'setting' ? Object.hasOwn(profile?.profile?.settings ?? {}, key) : Object.hasOwn(profile?.profile?.env ?? {}, key)) {
      invalid.push({ it, why: `環境設定檔已經有 ${key}，留給你決定要不要改` });
      continue;
    }
    if (suspicious(it, `${key}=${value}`)) continue;
    items.push(it);
    } catch (err) {
      judged.add(ref);
      run.notes.push({ task: 'graduate', note: `${ref} 這一次沒有處理：${String(err?.message ?? err).slice(0, 200)}` });
    }
  }
  // 有回覆的那幾批裡沒有回覆的候選：當成維持（記為看過）。這一輪不能提出的核心準則（postponed）不記，下一次再判斷；
  // 要等使用者確認的（blocked）記在 waiting，不記為看過（使用者確認之後內容雜湊不變，記成看過就再也不會被看）；
  // 呼叫失敗的那一批不記為看過，下一次再看
  for (const b of judgedBatches) for (const p of b.list) if (!taken(p.m.ref) && !postponed.has(p.m.ref)) judged.add(p.m.ref);
  const looked = [...judgedBatches].reduce((n, b) => n + b.list.length, 0);

  const hold = (it, why) => holdItem(ctx, it, { task: 'graduate', why });
  const done = [];
  // 之後任何一步出錯，這一次的紀錄（時間、看過的內容、畢業的項目）照樣寫：不然同一批每一輪都會重新送給 LLM
  try {
  for (const { it, why } of invalid) {
    it.risk = 'high';
    try {
      const hid = await hold(it, why);
      run.rejected.push({ task: 'graduate', title: it.title, reason: it.reason, why, refs: [it.ref], ...(hid ? { holding: hid } : {}) });
      judged.add(it.ref);
    } catch (err) {
      run.rejected.push({ task: 'graduate', title: it.title, why: `${why}（存進保留區失敗：${String(err?.message ?? err).slice(0, 200)}）`, refs: [it.ref] });
    }
  }
  if (items.length) {
    const { approved, rejected } = await screen(call, items, snapshot, { paused, cap: cap.left, roundCap: cap.max, dismissed: ctx.dismissed, mid, preferences: ctx.preferences, hold, memoryNames: await memoryNamesOf(eg) });
    for (const x of rejected) {
      run.rejected.push({ task: 'graduate', ...x });
      const it = items.find((y) => y.title === x.title && (x.refs ?? []).includes(y.ref));
      if (it && !x.deferred) judged.add(it.ref);
    }
    for (const it of approved) {
      try {
        const info = await applyGraduation(eg, it.graduate, { by: 'autopilot', now });
        cap.left -= it.cost ?? 1;
        judged.add(it.ref);
        done.push({ ref: it.ref, title: info.title, to: info.to, at: info.at });
        // undo 放這次的 commit（介面判斷能不能復原看的是 undo 有沒有內容）；實際的復原走 kind graduate（undoGraduation），不用 git revert
        run.actions.push({ task: 'graduate', kind: 'graduate', refs: [it.ref], title: it.title, reason: it.reason, category: it.category, risk: it.risk, review: it.review ?? null, status: 'done', undo: info.shas ?? [], to: info.to, graduate: info });
      } catch (err) {
        judged.add(it.ref);
        run.actions.push({ task: 'graduate', kind: 'graduate', refs: [it.ref], title: it.title, reason: it.reason, category: it.category, status: 'failed', undo: [], message: String(err?.message ?? err).slice(0, 300) });
      }
    }
  }
  } finally {
    // 記下這一次（所有電腦共用：一週內任何一台做過就不再做）、看過的內容與畢業的項目（每週摘要讀）
    const seenNext = {};
    for (const ref of judged) { const p = byRef.get(ref); if (p) seenNext[ref] = sha12(p.s.raw); }
    // waiting 的值：內容雜湊前 12 碼加上想要的去向（core、guardrail）
    const waitNext = {};
    for (const [ref, to] of blocked) { const p = byRef.get(ref); if (p && !judged.has(ref)) waitNext[ref] = `${sha12(p.s.raw)}:${to}`; }
    await updateMachineState(eg, (s) => {
      // waiting：這一輪有結論的（看過）拿掉，再加上這一輪要等使用者確認的
      const kept = Object.fromEntries(Object.entries(s.graduate?.waiting ?? {}).filter(([ref]) => !Object.hasOwn(seenNext, ref)));
      const waitAll = { ...kept, ...waitNext };
      s.graduate = { at: new Date(now).toISOString(), seen: { ...(s.graduate?.seen ?? {}), ...seenNext }, ...(Object.keys(waitAll).length ? { waiting: waitAll } : {}), items: [...(s.graduate?.items ?? []), ...done] };
      return s;
    }, 'autopilot graduate').catch((err) => ctx.log?.warn?.('autopilot', `記憶畢業的紀錄寫入失敗：${err?.message ?? err}`));
    run.notes.push({ task: 'graduate', note: `記憶畢業：看了 ${looked} 筆，畢業 ${done.length} 筆` });
    const waitingNow = new Set([...waiting, ...Object.keys(waitNext)]).size;
    if (blocked.size && waitingNow) run.notes.push({ task: 'graduate', note: needsConfirmNote(waitingNow) });
  }
}
