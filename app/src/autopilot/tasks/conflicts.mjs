// 自動駕駛：同步衝突（H15，1.5.0）。衝突資料夾會同步，每台都看得到；1.6.0 起每台都處理（不再只有主機）。
// 每輪開始前先同步：另一台已經處理掉的衝突不會再出現。兩台剛好同時處理同一個衝突時，處理結果會在同步時
// 再產生一個衝突，下一輪再判斷，不會遺失內容。ours 是記憶庫裡目前的檔案、theirs 是另一個版本（與哪台電腦處理無關）。
// 會捨棄一邊內容的選擇（ours、theirs、manual）要審核員同意；不同意或拿不準 → both（兩個版本都留下，之後整理時再合併）。
import { redactSecrets } from '../../core/secrets.mjs';
import { CONFLICT_SCHEMA, REVIEW_SCHEMA, conflictPrompt, reviewPrompt } from '../prompts.mjs';
import { instructionFlags } from '../guard.mjs';
import { checkMemoryText } from '../../cli/commands/safe.mjs';

const shaOf = (r) => r?.undo?.sha ?? r?.commit?.sha ?? null;
const red = (t) => (t === null || t === undefined ? t : redactSecrets(String(t)).text);
const hasSecret = (t) => t !== null && t !== undefined && redactSecrets(String(t)).matches.length > 0;

export async function resolveConflicts(ctx) {
  const { eg, call, run } = ctx;
  const all = await eg.conflicts.list().catch(() => []);
  if (!all.length) return;
  const safe = [];
  for (const c of all) {
    // 含疑似金鑰的版本不給 LLM 改寫：兩邊都留下，金鑰由金鑰任務處理
    if (!c.ref || [c.ours, c.theirs, c.base].some(hasSecret)) {
      await resolve(ctx, c, 'both', null, c.ref ? '內容含疑似金鑰：兩個版本都留下，金鑰另外處理' : '不是記憶檔的衝突：兩個版本都留下');
      continue;
    }
    safe.push({ id: c.id, ref: c.ref, summary: c.summary, ours: red(c.ours), theirs: red(c.theirs), base: red(c.base) });
  }
  if (!safe.length) return;
  const r = await call('同步衝突', { schema: CONFLICT_SCHEMA, prompt: conflictPrompt({ conflicts: safe }) });
  if (!r.ok) { run.skipped.push({ task: 'conflicts', why: r.error?.message ?? '判斷失敗' }); return; }
  const seenIds = new Set();
  const decisions = (r.data.decisions ?? []).filter((d) => safe.some((c) => c.id === String(d.id)) && !seenIds.has(String(d.id)) && seenIds.add(String(d.id)))
    .map((d) => ((ctx.paused ?? []).includes(`conflict-${d.choice}`) ? { ...d, choice: 'both', reason: `「${d.choice}」被你復原過多次，暫停中：兩個版本都留下` } : d));
  // 會捨棄內容的選擇送審
  const lossy = decisions.filter((d) => d.choice !== 'both');
  const verdict = new Map();
  if (lossy.length) {
    const cands = lossy.map((d) => {
      const c = safe.find((x) => x.id === String(d.id));
      const after = d.choice === 'ours' ? c.ours : d.choice === 'theirs' ? c.theirs : String(d.content ?? '');
      return {
        id: c.id, action: `conflict-${d.choice}`, title: `衝突處理：${d.choice === 'manual' ? '手動合併' : d.choice === 'ours' ? '保留目前的版本' : '改用另一個版本'}`, reason: String(d.reason ?? ''), risk: 'high',
        flags: d.choice === 'manual' ? instructionFlags(after, `${c.ours ?? ''}\n${c.theirs ?? ''}`) : [],
        before: [{ ref: `${c.ref}（目前的版本）`, text: c.ours }, { ref: `${c.ref}（另一個版本）`, text: c.theirs }], after: [{ ref: c.ref, text: after }],
      };
    });
    const rv = await call('衝突審核', { schema: REVIEW_SCHEMA, prompt: reviewPrompt(cands) });
    for (const v of rv.ok ? rv.data.verdicts ?? [] : []) verdict.set(String(v.id), v);
  }
  for (const d of decisions) {
    const c = all.find((x) => x.id === String(d.id));
    const v = verdict.get(c.id);
    const ok = d.choice === 'both' || v?.verdict === 'approve';
    const content = d.choice === 'manual' ? String(d.content ?? '').replace(/\r\n/g, '\n') : null;
    if (ok && d.choice === 'manual' && (!content.trim() || /‹已遮蔽：/.test(content) || !validMemory(content, c.ref))) { await resolve(ctx, c, 'both', null, '合併內容格式不完整：兩個版本都留下'); continue; }
    if (ok) await resolve(ctx, c, d.choice, content, String(d.reason ?? ''), v);
    else await resolve(ctx, c, 'both', null, `審核員沒有同意「${d.choice}」（${v?.reason ?? '審核失敗'}）：兩個版本都留下`, v);
  }
}

/** 手動合併的內容要是完整的記憶檔（核心準則與 project.json 不檢查 frontmatter） */
function validMemory(text, ref) {
  if (!/\.md$/.test(String(ref)) || ref === 'core/CORE.md') return true;
  try { checkMemoryText(text); return true; } catch { return false; }
}

async function resolve(ctx, c, choice, body, reason, review = null) {
  const { eg, run } = ctx;
  try {
    const res = await eg.conflicts.resolve(c.id, { choice, reviewed: false, ...(body !== null ? { body } : {}) });
    run.actions.push({ task: 'conflicts', kind: 'conflict', card: c.id, code: 'H15', refs: [c.ref, res?.ref].filter(Boolean), title: `處理衝突：${c.ref ?? c.id}（${{ ours: '保留目前的版本', theirs: '改用另一個版本', both: '兩個版本都留下', manual: '合併兩邊' }[choice]}）`, reason: String(reason).slice(0, 500), category: `conflict-${choice}`, status: 'done', undo: [shaOf(res)].filter(Boolean), ...(review ? { review: { verdict: review.verdict, reason: String(review.reason ?? '').slice(0, 300) } } : {}) });
  } catch (err) {
    run.actions.push({ task: 'conflicts', kind: 'conflict', card: c.id, code: 'H15', title: `處理衝突：${c.ref ?? c.id}`, reason: '', status: 'failed', undo: [], message: String(err?.message ?? err).slice(0, 300) });
  }
}
