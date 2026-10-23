// 收件匣：讓 Claude 在對話中讀取、判斷、處理健康檢查與衝突（/engram:inbox 技能用）。
// 輸出給 Claude 的內容一律先在本機遮蔽疑似金鑰（M5）；會改內容、設定或綁定的修正要加 --yes。
import { allowEntries, loadAllow } from '../../core/secretallow.mjs';
import { parsePositiveInt } from '../args.mjs';
import { CliError } from '../errors.mjs';
import { SEVERITY_LABEL } from '../output.mjs';
import { readContent } from './memory.mjs';
import { assertNoNewRedaction, checkMemoryText, heldNote, isMemoryRef, readSafe, redactText, undoHint } from './safe.mjs';

// 每種修正實際會做什麼（與管理介面的確認說明一致）
export const FIX_INFO = {
  normalize: '整理索引：把不在索引裡的記憶補進索引檔。',
  sync: '立即同步一次。',
  move: '把記憶移到另一個範圍（全域、單機或其他專案）。',
  remove: '把這筆記憶移到歷史（封存）；之後仍可從歷史還原。',
  rebind: '重新建立這個資料夾的記憶連結（junction），原本的記憶資料夾會先備份。',
  sweep: '把 Claude Code 本機資料夾裡尚未納管的記憶收編進 Engram，原檔移到備份。',
  'allow-read': '在使用者設定中加入這個記憶資料夾，讓 Claude 讀取時不再跳出權限詢問。',
  split: '把撞名的資料夾分開綁定。',
  reassign: '把這筆記憶移到它真正所屬的資料夾（必要時建立專案並綁定）。',
  'reconcile-bindings': '依這台電腦目前的權限模式重新設定資料夾綁定；記憶本身不受影響。',
  'rename-collisions': '依命名規則在資料夾原名後加 4 碼代號並重新綁定，記憶裡的舊路徑一併更新；可以用 engram collisions undo 整批還原。改名前的對話不會出現在 /resume 清單，改名中的資料夾不能有進行中的 Claude Code 對話。',
  'restore-deletions': '把被刪除的記憶從歷史中還原到目前的版本。',
  'confirm-deletions': '確認這些刪除是你要的，之後不再提醒；檔案仍可從歷史還原。',
  'forget-binding': '移除這台電腦上已失效的綁定紀錄；記憶本身不受影響。',
};
const SCOPE_WORDS = { global: '全域（所有專案都會讀到）', project: '專案', machine: '單機（只有那台電腦會讀到）' };
function describeFix(fix) {
  const to = fix.args?.scope;
  if (fix.action === 'move' && to?.kind) return `把 ${fix.args.ref} 移到${SCOPE_WORDS[to.kind] ?? to.kind}${to.pid ? ` ${to.pid}` : ''}${to.mid ? ` ${to.mid}` : ''}。`;
  return FIX_INFO[fix.action] ?? '修改記憶或設定。';
}
// 不改任何內容、可以直接執行的修正
const NO_CONFIRM = new Set(['normalize', 'sync']);

/** 需要先寫好內容才能處理的卡片：告訴 Claude 下一步用哪個指令 */
function contentStep(f, fix) {
  const ref = fix?.args?.ref ?? f.refs?.find(isMemoryRef);
  switch (fix?.action) {
    case 'merge': return `合併內容：先用 engram inbox show ${f.id} 讀各筆內容，寫好合併後的內容，再執行 engram memory merge ${(fix.args?.refs ?? f.refs).join(' ')} --into <保留的 ref> --base <各筆版本>（內容從標準輸入傳入）。`;
    case 'open-conflict': return `處理衝突：engram inbox show ${fix.args?.id}，再用 engram inbox resolve ${fix.args?.id} --choice ours|theirs|both|manual。`;
    case 'open-core': return '精簡核心準則：engram core 讀取，寫好後用 engram core write --base <版本> 寫回（內容從標準輸入傳入）。';
    case 'open-project': return `整理專案記憶：engram memory list --project ${fix.args?.pid ?? f.pid}，再合併、精簡或封存（或使用 /engram:tidy ${fix.args?.pid ?? f.pid}）。`;
    default:
      if (f.code === 'H08') return `請使用者確認這是哪一台電腦的環境，再用 engram memory move ${ref} --to machine:<mid> 搬過去（mid 見 engram status 第一行或管理介面的「裝置與同步」頁；--to machine 是目前這台）。`;
      return ref ? `改寫內容：engram memory show ${ref} 讀取後，用 engram memory write ${ref} --base <版本> 寫回整份內容（內容從標準輸入傳入）。` : '這張卡片需要在管理介面處理（engram ui）。';
  }
}
/** 每種修正怎麼復原：只對真的能復原的動作給指令（綁定、索引、同步類的 commit 不能單獨 undo） */
function restoreHint(action, r) {
  if (['move', 'remove', 'reassign'].includes(action)) return undoHint(r);
  if (action === 'sweep' && r?.restorePoint) return `需要還原時執行：engram import undo ${r.restorePoint}`;
  if (action === 'rename-collisions' && r?.id) return `需要還原時執行：engram collisions undo ${r.id}`;
  return null;
}
const CONTENT_ACTIONS = new Set(['merge', 'edit', 'open-conflict', 'open-core', 'open-project', 'open-rename']);

/**
 * 卡片的文字也會交給 Claude：一律遮蔽（例如 H12 的 frontmatter 錯誤訊息會附上那一行原文）。
 * H13 的說明含有金鑰的前 4 個字元，改成只列行號。
 */
function safeFinding(f) {
  const safe = { ...f, title: redactText(f.title), detail: redactText(f.detail) };
  if (f.code !== 'H13') return safe;
  const lines = f.fix?.args?.lines ?? [];
  return { ...safe, detail: `${lines.length ? `第 ${lines.join('、')} 行` : '內文'}疑似含有金鑰或密碼（內容不顯示）。此檔案不會同步，也不會列在索引裡（之後的對話看不到它），直到改成記錄「存放位置」。` };
}

const fixesOf = (f) => (f.fixes?.length ? f.fixes : f.fix ? [f.fix] : []);
const RANK = { high: 0, medium: 1, low: 2, auto: 3 };

async function load(eg, { all = false } = {}) {
  const [conflicts, findings] = await Promise.all([eg.conflicts.list(), eg.health({ includeDismissed: all })]);
  const shown = findings.filter((f) => all || f.severity !== 'auto').map(safeFinding).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return { conflicts, findings: shown };
}

async function findItem(eg, id) {
  if (!id) throw new CliError('E_USAGE', '請提供卡片 id', '執行 engram inbox 可以看到每張卡片的 id');
  if (/^cf_/.test(id)) {
    const c = (await eg.conflicts.list()).find((x) => x.id === id);
    if (!c) throw new CliError('E_NOT_FOUND', `找不到衝突：${id}`, '衝突可能已經處理過；執行 engram inbox 重新列出');
    return { conflict: c };
  }
  const f = (await eg.health({ includeDismissed: true })).find((x) => x.id === id);
  if (!f) throw new CliError('E_NOT_FOUND', `找不到卡片：${id}`, '問題可能已經解決；執行 engram inbox 重新列出');
  return { finding: safeFinding(f) };
}

/** 衝突的內容與摘要遮蔽疑似金鑰；套用該檔案的「不是金鑰」清單，Claude 寫回時才不會被當成新的遮蔽標記擋下 */
function conflictView(c, allow = {}) {
  const ok = allowEntries(allow, c.ref);
  return { id: c.id, ref: c.ref, kind: c.kind, createdAt: c.createdAt, summary: redactText(c.summary), ours: redactText(c.ours, ok), theirs: redactText(c.theirs, ok), base: redactText(c.base, ok) };
}

function conflictLines(c, allow) {
  const v = conflictView(c, allow);
  const part = (title, t) => [`── ${title}`, t === null ? '（沒有這個版本：表示這一邊刪除了它）' : t.replace(/\n$/, '')];
  return [
    `[衝突] ${v.id}  ${v.ref ?? '（未知檔案）'}`,
    `  ${v.summary}`,
    '  目前檔案保留這台的版本；處理方式：ours＝保留這台、theirs＝改用對方、both＝兩者都保留（對方另存一筆）、manual＝寫入合併後的內容。',
    ...part('這台的版本（ours）', v.ours),
    ...part('對方的版本（theirs）', v.theirs),
    ...(v.base !== null ? part('兩邊修改前的共同版本（base）', v.base) : []),
  ];
}

export async function cmdInbox(ctx) {
  const [sub, ...rest] = ctx.args;
  const eg = await ctx.engine();
  if (!sub) return listInbox(ctx, eg);
  if (sub === 'show') return showItems(ctx, eg, rest);
  if (sub === 'apply') return applyItem(ctx, eg, rest[0]);
  if (sub === 'dismiss') return dismissItem(ctx, eg, rest[0]);
  if (sub === 'resolve') return resolveItem(ctx, eg, rest[0]);
  throw new CliError('E_USAGE', `看不懂的子指令：${sub}`, '可用的子指令：show、apply、dismiss、resolve；不加子指令列出收件匣');
}

async function listInbox(ctx, eg) {
  const { conflicts, findings } = await load(eg, { all: ctx.opts.all });
  const n = { high: 0, medium: 0, low: 0, auto: 0 };
  for (const f of findings) if (!f.dismissed) n[f.severity]++;
  const data = { counts: { conflicts: conflicts.length, ...n }, conflicts: conflicts.map(({ id, ref, kind, createdAt, summary }) => ({ id, ref, kind, createdAt, summary: redactText(summary) })), findings };
  if (!conflicts.length && !findings.length) return ctx.out.result(data, '收件匣是空的，沒有需要處理的事。');
  const lines = [`收件匣：衝突 ${conflicts.length} · 高 ${n.high} · 中 ${n.medium} · 建議 ${n.low}${ctx.opts.all ? ` · 自動 ${n.auto}` : ''}`, ''];
  for (const c of data.conflicts) lines.push(`[衝突] ${c.id}  ${c.ref ?? ''}`, `  ${c.summary}`, '');
  for (const f of findings) {
    const when = f.dismissed ? (f.dismissed.until ? `（延後到 ${f.dismissed.until.slice(0, 10)}）` : '（已忽略）') : '';
    lines.push(`[${SEVERITY_LABEL[f.severity] ?? f.severity}] ${f.id}  ${f.title}${when}`, `  ${f.detail}`);
    if (f.refs?.length) lines.push(`  相關：${f.refs.join('、')}`);
    const fx = fixesOf(f);
    if (fx.length) lines.push(`  修正：${fx.map((x, i) => `${i + 1}. ${x.label}`).join('　')}`);
    lines.push('');
  }
  lines.push('看單一項目的完整內容：engram inbox show <id>');
  ctx.out.result(data, lines);
}

async function showItems(ctx, eg, ids) {
  if (!ids.length) throw new CliError('E_USAGE', '請提供卡片 id（可以一次多個）', '例如：engram inbox show H07:1a2b3c4d5e');
  const items = [];
  const lines = [];
  const allow = await loadAllow(eg.paths.local);
  for (const id of ids) {
    const { conflict, finding: f } = await findItem(eg, id);
    if (conflict) {
      items.push({ kind: 'conflict', conflict: conflictView(conflict, allow) });
      lines.push(...conflictLines(conflict, allow), '');
      continue;
    }
    const fixes = fixesOf(f).map((x, i) => ({
      n: i + 1, action: x.action, label: x.label, args: x.args,
      ...(f.code === 'H13' ? { does: '在這台電腦把疑似金鑰換成「‹已遮蔽›」標記（內容不經過 Claude），檔案恢復同步。', needsYes: true }
        : CONTENT_ACTIONS.has(x.action) ? { needsContent: true, next: contentStep(f, x) }
        : { does: describeFix(x), needsYes: !NO_CONFIRM.has(x.action) }),
    }));
    const memories = [];
    for (const ref of f.refs ?? []) if (isMemoryRef(ref)) memories.push(await readSafe(eg, ref));
    const related = fixesOf(f).find((x) => x.action === 'open-conflict');
    const linked = related ? (await eg.conflicts.list()).find((x) => x.id === related.args?.id) : null;
    items.push({ kind: 'finding', finding: f, fixes, memories, ...(linked ? { conflict: conflictView(linked, allow) } : {}) });
    lines.push(`[${SEVERITY_LABEL[f.severity] ?? f.severity}] ${f.id}  ${f.title}`, `  ${f.detail}`);
    if (f.refs?.length) lines.push(`  相關：${f.refs.join('、')}`);
    if (f.dismissed) lines.push(`  狀態：${f.dismissed.until ? `延後到 ${f.dismissed.until.slice(0, 10)}` : '已忽略'}`);
    if (!fixes.length) lines.push(`  沒有可以直接套用的修正。${contentStep(f, null)}`);
    for (const x of fixes) lines.push(`  修正 ${x.n}：${x.label} — ${x.needsContent ? x.next : `${x.does}${x.needsYes ? `（執行：engram inbox apply ${f.id}${x.n > 1 ? ` --fix ${x.n}` : ''} --yes）` : `（執行：engram inbox apply ${f.id}）`}`}`);
    for (const m of memories) {
      lines.push(`── ${m.ref}${m.exists ? `（版本 ${m.rev}${m.redacted ? `；已遮蔽 ${m.redacted} 處疑似金鑰` : ''}）` : '（目前不存在：已被刪除或移走）'}`);
      if (m.exists) lines.push(m.text.replace(/\n$/, ''));
    }
    if (linked) lines.push(...conflictLines(linked, allow));
    lines.push('');
  }
  ctx.out.result(items.length === 1 ? items[0] : items, lines);
}

async function applyItem(ctx, eg, id) {
  const { conflict, finding: f } = await findItem(eg, id);
  if (conflict) throw new CliError('E_USAGE', '衝突要用 engram inbox resolve 處理', `例如：engram inbox resolve ${id} --choice ours`);
  const fixes = fixesOf(f);
  const n = ctx.opts.fix ? parsePositiveInt(ctx.opts.fix, '--fix', { max: Math.max(1, fixes.length) }) : 1;
  const fix = fixes[n - 1];
  if (!fix || (CONTENT_ACTIONS.has(fix.action) && f.code !== 'H13')) {
    throw new CliError('E_NEEDS_CONTENT', fix ? `「${fix.label}」需要先寫好內容，不能直接套用` : '這張卡片沒有可以直接套用的修正', contentStep(f, fix));
  }
  if (f.code === 'H13') {
    const ref = fix.args?.ref ?? f.refs?.[0];
    if (!ctx.opts.yes) throw new CliError('E_CONFIRM', `會在這台電腦把 ${ref} 裡的疑似金鑰換成「‹已遮蔽›」標記（內容不經過 Claude），之後檔案恢復同步`, '請先確認金鑰已另外保存（例如 Windows 認證管理員）；確認後加上 --yes 再執行。如果其實不是金鑰，請到管理介面的收件匣按「這不是金鑰」。');
    const r = await eg.secrets.redact(ref);
    // 含金鑰的原檔從未被 commit：復原這次遮蔽等於刪掉整筆記憶，所以不提示 engram undo
    return ctx.out.result(r, `已在本機遮蔽 ${ref} 的疑似金鑰，檔案會恢復同步。遮蔽不能復原；之後可以改寫成記錄金鑰的存放位置。`);
  }
  if (!NO_CONFIRM.has(fix.action) && !ctx.opts.yes) {
    throw new CliError('E_CONFIRM', `「${fix.label}」：${describeFix(fix)}`, `確認後加上 --yes 再執行：engram inbox apply ${f.id}${n > 1 ? ` --fix ${n}` : ''} --yes`);
  }
  const r = await eg.apply(fix);
  if (r?.needsUi) throw new CliError('E_NEEDS_CONTENT', `「${fix.label}」需要先寫好內容，不能直接套用`, contentStep(f, fix));
  ctx.out.result(r ?? { ok: true }, [`已${fix.label}（${f.id}）。`, restoreHint(fix.action, r)]);
}

async function dismissItem(ctx, eg, id) {
  const { conflict, finding: f } = await findItem(eg, id);
  if (conflict) throw new CliError('E_USAGE', '衝突不能忽略，請用 engram inbox resolve 處理', `例如：engram inbox resolve ${id} --choice ours`);
  const days = ctx.opts.days ? parsePositiveInt(ctx.opts.days, '--days', { max: 365 }) : null;
  const until = days ? new Date(Date.now() + days * 864e5).toISOString() : undefined;
  const r = await eg.findings.dismiss(f.id, until ? { until } : {});
  ctx.out.result(r, days ? `已延後：${f.title}（${days} 天後再提醒）。` : `已忽略：${f.title}（之後不再提醒；engram doctor 仍會列出）。`);
}

async function resolveItem(ctx, eg, id) {
  if (!/^cf_/.test(id ?? '')) throw new CliError('E_USAGE', '請提供衝突 id（cf_ 開頭）', '執行 engram inbox 可以看到衝突的 id');
  const choice = ctx.opts.choice;
  if (!['ours', 'theirs', 'both', 'manual'].includes(choice)) throw new CliError('E_USAGE', '請用 --choice 指定處理方式：ours、theirs、both 或 manual');
  const { conflict } = await findItem(eg, id);
  let body;
  let done = async () => {};
  if (choice === 'manual') {
    ({ text: body, done } = await readContent(ctx, '手動合併的內容'));
    if (isMemoryRef(conflict.ref)) checkMemoryText(body);
    assertNoNewRedaction(body, [conflict.ours, conflict.theirs, conflict.base]);
  }
  const r = await eg.conflicts.resolve(id, { choice, body });
  await done();
  const held = choice === 'manual' && conflict.ref ? await heldNote(eg, conflict.ref, body) : null;
  const label = { ours: '保留這台的版本', theirs: '改用對方的版本', both: '兩個版本都保留', manual: '寫入合併後的內容' }[choice];
  ctx.out.result(r, [`已處理衝突 ${id}：${label}${r?.ref ? `（${r.ref}）` : ''}。`, held, held ? null : undoHint(r)]);
}
