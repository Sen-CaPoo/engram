// 護欄（2.0.0）：環境頁的一個分頁。把「踩過的坑」編成規則，Claude 送出 Bash／PowerShell 指令前比對：
// 把握高的直接擋下並附正確寫法，把握低的只在結果後附提醒。這裡列出規則、近 30 天的命中與誤擋、這台電腦的停用與啟用，
// 以及「試試看」（貼上一段指令，看會命中哪些規則；只是比對，不會執行）。
// 規則檔來的擋下規則要在這台核可才真的擋下：approval 是 builtin（內建）｜approved｜pending（等待核可，只當提醒）｜not-needed（提醒類）。
// 這台的覆寫（override）可能有期限（until）：誤擋後暫時降成提醒、比對太慢暫時停用，到期自動恢復。
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { Banner, ConfirmDialog, Empty, ErrorBanner, Section, Skeleton, useAction, useApp, useData } from '../components.jsx';
import { t, N_, local, locale, getLang } from '../i18n.js';
import { IconCheck, IconChevronRight, IconPlay, IconShield } from '../icons.jsx';
import { FALSE_BLOCK_DAYS, ruleMessage } from '../../../../plugin/hooks/lens/guard.mjs';

const MODE = {
  block: { label: N_('擋下'), help: N_('把握高的規則直接擋下指令並告訴 Claude 正確寫法，其餘只提醒。') },
  hint: { label: N_('只提醒'), help: N_('所有規則都只在指令執行後附上提醒，不擋下。') },
  off: { label: N_('guard::關閉'), help: N_('不比對任何規則。') },
};
const ACTION = { block: N_('擋下'), hint: N_('提醒') };
const VERDICT = {
  block: { tone: 'bad', title: N_('這段指令會被擋下') },
  hint: { tone: 'warn', title: N_('這段指令會執行，但會附上提醒') },
  pass: { tone: 'info', title: N_('沒有命中任何規則') },
};

/** 規則沒有標題：用訊息的第一句當標題（中文到第一個句號，英文到第一個句點） */
export function firstSentence(message) {
  const text = String(message ?? '').trim();
  const zh = text.indexOf('。');
  if (zh >= 0) return text.slice(0, zh + 1);
  const m = /^.+?[.!?](?=\s|$)/.exec(text);
  return m ? m[0] : text;
}

export function GuardrailsPanel({ go }) {
  const g = useData(() => api.guardrails(), []);
  if (!g.data) return <><ErrorBanner error={g.error} onRetry={g.reload} /><div class="panel"><Skeleton rows={6} /></div></>;
  const d = g.data;
  const mode = MODE[d.mode] || MODE.block;
  const tot = d.rules.reduce((s, r) => ({ blocks: s.blocks + (r.blocks || 0), hints: s.hints + (r.hints || 0), confirmed: s.confirmed + (r.confirmed || 0), falseBlocks: s.falseBlocks + (r.falseBlocks || 0) }), { blocks: 0, hints: 0, confirmed: 0, falseBlocks: 0 });
  const waiting = d.rules.filter((r) => r.approval === 'pending');

  return (
    <>
      <ErrorBanner error={g.error} onRetry={g.reload} />
      <section class="panel env-mode">
        <div class="panel-body">
          <div class="env-mode-top">
            <b>{t('目前的設定：{mode}', { mode: t(mode.label) })}</b>
            <button class="btn sm ghost" onClick={() => go('settings')}>{t('變更')}<IconChevronRight /></button>
          </div>
          <p class="muted">{t(mode.help)}</p>
          <p class="muted">{t('護欄把踩過的坑（例如某種指令寫法在這台電腦會出錯）編成規則，在 Claude 送出 Bash 或 PowerShell 指令之前比對。被擋下時，Claude 會收到正確的寫法並自己改寫。')}</p>
          <p class="faint env-note">{t('「擋對」：被擋下的指令原封不動再送一次，結果真的失敗，證明這次擋得對。「誤擋」：原封不動再送一次卻成功了，代表擋錯了；這條規則會在這台暫時降成只提醒，{n} 天後自動恢復。指令：{cmd}', { n: FALSE_BLOCK_DAYS, cmd: <code>engram guardrails</code> })}</p>
        </div>
      </section>
      {d.problem && <Banner tone="warn" title={t('規則檔有問題')}>{local(d, 'problem')}</Banner>}
      {d.skipped?.length > 0 && (
        <Banner tone="warn" title={t('有 {n} 條規則沒有生效', { n: d.skipped.length })}>
          {t('規則檔裡的這些規則沒有通過檢查（例如樣式可能比對太久、和內建規則同名），所以略過、不會比對任何指令。要讓它生效，請修改規則檔裡的這一條：')}
          <ul class="guard-skipped">
            {d.skipped.map((s, i) => <li key={`${s.id}-${i}`}><code>{s.id || t('（沒有 id）')}</code>{t('：{reason}', { reason: local(s, 'reason') || '—' })}</li>)}
          </ul>
        </Banner>
      )}

      <div class="grid cols-4 env-stats">
        <Stat label={t('擋下')} value={tot.blocks} foot={t('近 {n} 天', { n: d.days })} />
        <Stat label={t('提醒')} value={tot.hints} foot={t('近 {n} 天', { n: d.days })} />
        <Stat label={t('擋對')} value={tot.confirmed} foot={t('重送後真的失敗')} />
        <Stat label={t('誤擋')} value={tot.falseBlocks} foot={t('重送後成功，已降成提醒')} />
      </div>

      <TryIt rules={d.rules} />

      {waiting.length > 0 && (
        <Banner tone="warn" title={t('有 {n} 條同步來的規則等待這台核可', { n: waiting.length })}>
          {t('其他電腦加入（或內容改過）的擋下規則，要在這台看過樣式與訊息並核可，才會真的擋下指令；核可之前只會提醒。')}
          {t('核可只能在這個管理介面或你自己的終端機（{cmd}）做；在 Claude Code 的對話裡執行會被拒絕。', { cmd: <code>engram guardrails approve</code> })}
        </Banner>
      )}

      <Section title={t('規則')} sub={d.source === 'default' ? t('{n} 條（內建的預設規則）', { n: d.rules.length })
        : d.defaults ? t('{n} 條（內建規則加上規則檔的規則）', { n: d.rules.length }) : t('rules::{n} 條', { n: d.rules.length })}>
        {d.rules.length === 0 ? <Empty icon={IconShield} title={t('沒有任何規則')}>{t('規則檔是空的，所以不會比對任何指令。')}</Empty> : (
          <div class="guard-list">{d.rules.map((r) => <RuleRow key={r.id} r={r} mode={d.mode} />)}</div>
        )}
      </Section>
    </>
  );
}

function Stat({ label, value, foot }) {
  return <div class="panel stat"><span class="label">{label}</span><span class="value">{value}</span><span class="foot">{foot}</span></div>;
}

const dateOf = (iso) => (iso ? new Date(iso).toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' }) : '');

/** 這台的覆寫說明：停用（自己停用、比對太慢）或降成提醒（誤擋），有期限的附上恢復的日期 */
function overrideText(o) {
  if (!o) return null;
  const until = o.until ? dateOf(o.until) : '';
  if (o.action === 'off') {
    if (o.reason === 'slow') return until ? t('比對太慢，已在這台停用到 {date}', { date: until }) : t('比對太慢，已在這台停用');
    return until ? t('這台已停用到 {date}', { date: until }) : t('這台已停用');
  }
  if (o.reason === 'falseBlock') return until ? t('誤擋後在這台降成提醒，到 {date} 自動恢復', { date: until }) : t('誤擋後已在這台降成提醒');
  return until ? t('這台降成提醒，到 {date} 自動恢復', { date: until }) : t('這台降成提醒');
}

function RuleRow({ r, mode }) {
  const { status } = useApp();
  const act = useAction();
  const [ask, setAsk] = useState(false);
  // 規則的英文訊息是 messageEn（沒有就用中文）
  const message = ruleMessage(r, getLang()) || '';
  const title = firstSentence(message);
  const rest = message.slice(title.length).trim();
  const off = r.override?.action === 'off';
  const demoted = r.override?.action === 'hint';
  const pending = r.approval === 'pending';
  const by = status?.devices?.find((d) => d.id === r.by)?.label;
  const toggle = () => act(() => (off ? api.guardrailsEnable(r.id) : api.guardrailsDisable(r.id)), off ? t('已在這台重新啟用這條規則') : t('已在這台停用這條規則（其他電腦不受影響）'));
  const approve = async () => {
    await act(() => api.guardrailsApprove(r.id), (res) => (res?.changed === false ? t('這條規則不需要核可') : t('已核可，這條規則在這台會擋下指令')));
    setAsk(false);
  };
  return (
    <article class={`guard-rule${off ? ' off' : ''}`}>
      <header>
        <span class={`act-chip ${r.action === 'block' ? 'archive' : 'update'}`}>{t(ACTION[r.action] || r.action)}</span>
        <h3>{title}</h3>
        <button type="button" role="switch" class="switch" aria-checked={off ? 'false' : 'true'} aria-label={t('在這台使用這條規則：{title}', { title })} onClick={toggle}><span class="knob" /></button>
      </header>
      <div class="hd-chips">
        {pending && <span class="chip warn">{t('等待這台核可')}</span>}
        {r.approval === 'builtin' && <span class="chip">{t('內建規則')}</span>}
        {r.override && <span class={`chip${demoted ? ' warn' : ''}`}>{overrideText(r.override)}</span>}
        {!off && !demoted && r.action === 'block' && mode === 'hint' && <span class="chip">{t('設定為只提醒')}</span>}
      </div>
      {rest && <p class="muted guard-msg">{rest}</p>}
      {r.silentFailure && r.action === 'block' && <p class="faint guard-msg">{t('這條規則防的問題不會讓指令失敗（結果會悄悄變錯），所以被擋下後重送不會自動降級，要不要調整由你決定。')}</p>}
      <p class="faint guard-meta">
        {t('來源：{source}', { source: local(r, 'source') || '—' })}
        <span>{t('，適用 {tool}', { tool: r.tool === '*' ? 'Bash / PowerShell' : r.tool })}</span>
        {by && <span>{t('，由「{label}」加入', { label: by })}</span>}
        <span class="guard-id" title={t('規則 id')}>{r.id}</span>
      </p>
      <p class="guard-stats">
        <span>{t('近 30 天命中 {n} 次', { n: r.hits || 0 })}</span>
        <span>{t('擋對 {n}', { n: r.confirmed || 0 })}</span>
        <span class={r.falseBlocks ? 'warn' : ''}>{t('誤擋 {n}', { n: r.falseBlocks || 0 })}</span>
        {r.slow > 0 && <span class="warn">{t('比對太慢 {n} 次', { n: r.slow })}</span>}
      </p>
      {(pending || demoted) && (
        <footer>
          {pending && <button class="btn sm primary" onClick={() => setAsk(true)}><IconCheck />{t('看內容並核可')}</button>}
          {demoted && <button class="btn sm" onClick={() => act(() => api.guardrailsEnable(r.id), t('已恢復成擋下'))}>{t('恢復成擋下')}</button>}
        </footer>
      )}
      {ask && (
        <ConfirmDialog title={t('核可這條規則？')} confirmLabel={t('核可')} onConfirm={approve} onClose={() => setAsk(false)}
          desc={t('核可之後，這條規則在這台電腦會真的擋下符合的指令。只在這台生效；規則內容之後被改過，就要重新核可。')}>
          <dl class="kv guard-review">
            <dt>{t('適用')}</dt><dd>{r.tool === '*' ? 'Bash / PowerShell' : r.tool}</dd>
            <dt>{t('比對樣式')}</dt><dd><code>{r.pattern}</code>{r.flags ? <span class="faint">　{r.flags}</span> : null}</dd>
            {r.unless && <><dt>{t('例外')}</dt><dd><code>{r.unless}</code></dd></>}
            <dt>{t('擋下時告訴 Claude')}</dt><dd>{message}</dd>
          </dl>
        </ConfirmDialog>
      )}
    </article>
  );
}

function TryIt({ rules }) {
  const [cmd, setCmd] = useState('');
  const [tool, setTool] = useState('Bash');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    e?.preventDefault();
    if (!cmd.trim()) return;
    setBusy(true); setErr(null);
    try { setRes(await api.guardrailsTest(cmd, tool)); } catch (x) { setErr(x); setRes(null); } finally { setBusy(false); }
  };
  const v = res ? VERDICT[res.verdict] || VERDICT.pass : null;
  return (
    <Section title={t('試試看')} sub={t('貼上一段指令，看會命中哪些規則；只是比對，不會執行')}>
      <form class="panel-body guard-try" onSubmit={run}>
        <textarea class="input mono" rows="3" value={cmd} placeholder={t('例如：{cmd}', { cmd: 'rm -rf "$BUILD_DIR"' })} aria-label={t('要測試的指令')}
          onInput={(e) => { setCmd(e.currentTarget.value); setRes(null); }} />
        <div class="btn-row">
          <select class="select" value={tool} onChange={(e) => { setTool(e.currentTarget.value); setRes(null); }} aria-label={t('用哪個工具執行')}>
            <option value="Bash">Bash</option>
            <option value="PowerShell">PowerShell</option>
          </select>
          <button class="btn primary" type="submit" disabled={!cmd.trim() || busy}><IconPlay />{busy ? t('比對中…') : t('試試看')}</button>
        </div>
        <ErrorBanner error={err} />
        {res && (
          <Banner tone={v.tone} title={t(v.title)}>
            {res.matches.length > 0 ? (
              <ul class="guard-hits">
                {res.matches.map((m) => (
                  <li key={m.id}>
                    <span class={`act-chip ${m.action === 'block' ? 'archive' : 'update'}`}>{t(ACTION[m.action] || m.action)}</span>
                    <span>{ruleMessage(rules.find((r) => r.id === m.id), getLang()) || m.message}</span>
                    {m.declared !== m.action && <span class="faint">{t('（規則本來是「{a}」，這台目前是「{b}」）', { a: t(ACTION[m.declared] || m.declared), b: t(ACTION[m.action] || m.action) })}</span>}
                  </li>
                ))}
              </ul>
            ) : t('Claude 送出這段指令時，護欄不會有任何動作。')}
          </Banner>
        )}
      </form>
    </Section>
  );
}
