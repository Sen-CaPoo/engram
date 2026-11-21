// engram holding：保留區（2.0.0）。自動駕駛沒有執行的提案連同完整內容；使用者可以採用（寫進記憶、可復原）或忽略。
// 輸出的疑似金鑰已在本機遮蔽（這個指令也可能由 Claude 執行）。
import { CliError } from '../errors.mjs';
import { localTime } from '../fsutil.mjs';
import { CLAUDE_NOTE, confirmSource } from '../source.mjs';

const KIND = { rejected: '沒有通過', 'cross-scope': '別的範圍', reverted: '退回的版本' };
const STATUS = { held: '保留中', adopted: '已採用', dismissed: '已忽略' };

const describeOp = (o) => (o.op === 'move' ? `move ${o.ref} → ${o.to}` : o.op === 'merge' ? `merge ${(o.refs ?? []).join(' + ')} → ${o.into}` : o.op === 'create' ? `create ${o.scope}` : `${o.op} ${o.ref ?? ''}`);

export async function cmdHolding(ctx) {
  const [sub = 'list', id] = ctx.args;
  const eg = await ctx.engine();

  if (sub === 'list') {
    const list = await eg.holding.list();
    return ctx.out.result({ items: list }, list.length
      ? [...list.map((x) => `${x.id}｜${STATUS[x.status] ?? x.status}｜${KIND[x.kind] ?? x.kind}｜${x.title}${x.secret ? '（含疑似金鑰，只在這台電腦）' : x.local ? '（只在這台電腦）' : ''}`),'看內容：engram holding show <編號>；採用：engram holding adopt <編號>；忽略：engram holding dismiss <編號>']
      : ['保留區是空的']);
  }

  if (!id) throw new CliError('E_USAGE', '要指定保留區的編號', 'engram holding list 可以列出所有項目');

  if (sub === 'show') {
    const x = await eg.holding.get(id);
    return ctx.out.result(x, [
      `${x.id}｜${STATUS[x.status] ?? x.status}｜${KIND[x.kind] ?? x.kind}｜${localTime(x.at)}｜${x.machine}${x.secret ? '｜含疑似金鑰（已遮蔽），只在這台電腦' : x.local ? '｜含對話原文，只在這台電腦' : ''}`,
      `標題：${x.title}`,
      x.reason ? `理由：${x.reason}` : null,
      x.why ? `沒有執行的原因：${x.why}` : null,
      x.attempts ? `自動重審過 ${x.attempts} 次` : null,
      ...x.ops.flatMap((o, k) => [`動作 ${k + 1}：${describeOp(o)}`, ...(typeof o.content === 'string' ? [o.content.trimEnd()] : [])]),
      ...(x.evidence.length ? ['對話證據：', ...x.evidence.map((e) => `  - ${e.date ?? ''}${e.fromUser ? '（使用者說的話）' : ''}「${e.quote}」`)] : []),
    ].filter((l) => l !== null));
  }

  if (sub === 'adopt') {
    // 第三輪審查 A：在 Claude Code 裡採用的記為 claude（不算使用者本人確認，不進自動駕駛的偏好區塊）
    const by = confirmSource(ctx);
    const r = await eg.holding.adopt(id, { by });
    return ctx.out.result(r, [
      `已採用 ${id}：寫進記憶（整理記錄 ${r.record}）。要復原：到管理介面的「記憶整理」，或依序執行 ${[...r.undo].reverse().map((s) => `engram undo ${s}`).join('、') || 'engram undo <版本>'}`,
      // 第四輪審查 F-04：在 Claude Code 裡採用改了核心準則：照寫但不記確認
      r.coreUnconfirmed ? '核心準則有變更（每次對話都會載入）：還沒算你確認過，請到管理介面的收件匣「待你確認」看差異，確認或退回。' : null,
      by === 'claude' ? CLAUDE_NOTE : null,
    ].filter(Boolean));
  }

  if (sub === 'dismiss') {
    const r = await eg.holding.dismiss(id);
    return ctx.out.result(r, [`已忽略 ${id}：之後不會再自動重審（紀錄留著）`]);
  }

  throw new CliError('E_USAGE', `看不懂的子指令：${sub}`, 'engram help holding');
}
