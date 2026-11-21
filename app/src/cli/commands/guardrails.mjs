// engram guardrails：護欄（2.0.0 WP4b）。列出規則與近 30 天的命中、測試一個指令、核可同步來的擋下規則、在這台電腦停用或啟用一條規則。
import { CliError } from '../errors.mjs';
import { inClaudeCode } from '../source.mjs';
import { readStdinText } from './memory.mjs';

const ACTION = { block: '擋下', hint: '提醒', off: '停用' };
const MODE = { block: 'block（把握高的擋下、把握低的提醒）', hint: 'hint（全部只提醒）', off: 'off（不比對）' };
const VERDICT = { block: '會擋下', hint: '不會擋，但會在結果後附提醒', pass: '沒有命中任何規則' };
const APPROVAL = { approved: '已核可', pending: '待核可（沒核可之前只當提醒）' };

/** 規則訊息的第一句（清單只放一句） */
const brief = (message) => String(message ?? '').split('。')[0];

/** 這台電腦對這條規則的覆寫（停用、暫時降成提醒、比對太慢被停用） */
function overrideLabel(o) {
  if (!o) return '';
  if (o.action === 'off') return o.reason === 'slow' ? '這台電腦已停用（比對太慢）' : '這台電腦已停用';
  const note = [o.reason === 'falseBlock' ? '被誤擋後自動降級' : '', o.until ? `${o.until.slice(0, 10)} 自動恢復` : ''].filter(Boolean).join('，');
  return `這台電腦已降成提醒${note ? `（${note}）` : ''}`;
}

export async function cmdGuardrails(ctx) {
  const [sub = 'list', ...rest] = ctx.args;
  const eg = await ctx.engine();

  if (sub === 'list') {
    const s = await eg.guardrails.status();
    return ctx.out.result(s, [
      `護欄：${MODE[s.mode] ?? s.mode}（設定 guardrails）`,
      `規則來源：${s.source === 'file' ? (s.defaults ? '內建的預設規則＋vault/guardrails/rules.json' : 'vault/guardrails/rules.json') : '內建的預設規則（還沒有規則檔）'}`,
      s.problem ? `注意：${s.problem}` : null,
      ...s.rules.flatMap((r) => [
        `• ${r.id}｜${ACTION[r.effective] ?? r.effective}｜${r.tool}｜近 ${s.days} 天命中 ${r.hits}、誤擋 ${r.falseBlocks}、擋對 ${r.confirmed}${APPROVAL[r.approval] ? `｜${APPROVAL[r.approval]}` : ''}${r.override ? `｜${overrideLabel(r.override)}` : ''}`,
        `    ${brief(r.message)}。`,
      ]),
      ...(s.skipped.length ? ['略過的規則（格式不對）：', ...s.skipped.map((x) => `  - ${x.id ?? '（沒有 id）'}：${x.reason}`)] : []),
      '測試指令：engram guardrails test "<指令>"；核可同步來的擋下規則：engram guardrails approve <規則 id>；停用或啟用：engram guardrails disable|enable <規則 id>',
    ].filter((l) => l !== null));
  }

  if (sub === 'test') {
    const command = rest[0] ?? (await readStdinText(ctx.io.stdin)).replace(/\r?\n$/, '');
    if (!command.trim()) throw new CliError('E_USAGE', '要提供測試的指令', '例如 engram guardrails test "rm -rf $DIR"；多行的指令從標準輸入傳入');
    const r = await eg.guardrails.test(command);
    return ctx.out.result(r, [
      `${VERDICT[r.verdict]}${r.mode === 'block' ? '' : `（目前設定是 ${r.mode}）`}`,
      ...r.matches.map((x) => `• ${x.id}｜${ACTION[x.action] ?? x.action}${x.action !== x.declared ? `（規則本來是${ACTION[x.declared]}）` : ''}\n    ${x.message}`),
    ]);
  }

  if (sub === 'approve') {
    const id = rest[0];
    if (!id) throw new CliError('E_USAGE', '要指定規則 id', 'engram guardrails approve <規則 id>；engram guardrails list 可以列出所有規則');
    // 核可是使用者本人的確認（比照 not-secret）：同步來的規則不能讓 Claude 自己核可自己擋自己要擋的東西。
    // 只要變數存在（即使是空字串）就拒絕；判斷見 source.mjs 的 inClaudeCode
    if (inClaudeCode(ctx)) {
      throw new CliError('E_CONFIRM', '核可同步來的擋下規則要由你本人確認，不能在 Claude Code 裡執行', `請在你自己的終端機（不是 Claude Code 的對話或 ! 指令）執行 engram guardrails approve ${id}，或到管理介面（engram ui）核可。`);
    }
    const r = await eg.guardrails.approve(id);
    if (!r.changed) {
      return ctx.out.result(r, [r.approval === 'approved' ? `「${id}」已經核可過這份內容` : `「${id}」不需要核可（${r.approval === 'builtin' ? '內建規則' : '只有擋下的規則需要核可，提醒類的規則本來就會生效'}）`]);
    }
    return ctx.out.result(r, [
      `已在這台電腦核可「${id}」，之後會真的擋下。核可的內容：`,
      `  範圍：${r.rule.tool}`,
      `  樣式：${r.rule.pattern}${r.rule.flags ? `（旗標 ${r.rule.flags}）` : ''}`,
      r.rule.unless ? `  例外：${r.rule.unless}` : null,
      `  訊息：${r.rule.message}`,
      '規則內容被改過就要重新核可。',
    ].filter((l) => l !== null));
  }

  if (sub === 'disable' || sub === 'enable') {
    const id = rest[0];
    if (!id) throw new CliError('E_USAGE', '要指定規則 id', `engram guardrails ${sub} <規則 id>；engram guardrails list 可以列出所有規則`);
    const r = await eg.guardrails[sub](id);
    return ctx.out.result(r, sub === 'disable'
      ? [r.changed ? `已在這台電腦停用「${id}」（不影響其他電腦；engram guardrails enable ${id} 可以恢復）` : `「${id}」在這台電腦本來就是停用的`]
      : [r.changed ? `已在這台電腦恢復「${id}」，回到規則本來的動作` : `「${id}」在這台電腦沒有被停用或降級`]);
  }

  throw new CliError('E_USAGE', `看不懂的子指令：${sub}`, 'engram help guardrails');
}
