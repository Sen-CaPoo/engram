// 保留區（2.0.0）：自動駕駛想做、但沒有執行的修改（審核員沒有放行、不是這一輪負責的範圍、被退回的版本），
// 連同完整的內容與證據保存下來。使用者在這裡看過之後「採用」（交給整理流程寫進記憶，先備份、可以復原），或標成「不需要」。
// 自動駕駛也會在之後的一輪自動再審（最多兩次）。資料來自 GET /api/holding（疑似金鑰已在本機遮蔽）。
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { Banner, ConfirmDialog, Empty, ErrorBanner, ScopeLabel, Skeleton, useAction, useApp, useData, When } from '../components.jsx';
import { t, N_, local } from '../i18n.js';
import { IconArchive, IconCheck, IconCheckCircle, IconChevronDown, IconChevronRight, IconCore, IconEdit, IconEnv, IconHolding, IconMerge, IconMove, IconPlus, IconShield, IconSparkle } from '../icons.jsx';
import { DiffView } from './tidy.jsx';
import { GRADUATE_TO, GraduateWhat } from './autopilot.jsx';
import { parseScopeKey, RISK_LABEL } from '../util.js';

// 為什麼在保留區
const KIND = {
  rejected: { label: N_('審核員沒有放行'), help: N_('AI 提出了修改，但另一位 AI 審核員或安全規則認為證據不夠或有風險，所以沒有執行。') },
  'cross-scope': { label: N_('不是這一輪的範圍'), help: N_('對話回顧時發現的事屬於別的範圍（例如全域記憶），這台電腦這一輪不能處理，先存起來。') },
  reverted: { label: N_('被退回的版本'), help: N_('自動駕駛把 Claude 寫入的內容退回確認過的版本之前，先把被退回的那個版本存在這裡。') },
};
const FILTERS = [
  { key: 'held', label: N_('保留中') },
  { key: 'adopted', label: N_('已採用') },
  { key: 'dismissed', label: N_('不需要') },
  { key: 'all', label: N_('全部') },
];
// 提案來自自動駕駛的哪一項工作
const TASK = { curate: N_('整理'), dream: N_('對話回顧'), review: N_('待你確認'), cards: N_('收件匣'), holding: N_('保留區重審'), graduate: N_('記憶畢業') };
// 記憶畢業的提案（2.0.0 WP9）：採用時交給記憶畢業的流程，不是整理計畫
// 採用記憶畢業的提案之後的提示（依去向；封存會移除原記憶，其他去向只在原記憶記下去向）
const ADOPTED_TO = {
  core: N_('已採用：核心準則加上了這一行，原本的記憶內文沒有動'),
  guardrail: N_('已採用：加進護欄規則（只提醒，不擋下），原本的記憶內文沒有動'),
  env: N_('已採用：加進環境設定，每台電腦核可之後才會套用；原本的記憶內文沒有動'),
  archive: N_('已採用：這筆記憶已封存，可以從變更紀錄還原'),
};
const isGraduation = (x) => !!x.graduate || x.task === 'graduate' || x.ops.some((o) => ['guardrail', 'env', 'graduate'].includes(o.op));
// 審核員判斷「核心事實有依據、細節沒有」時，後端標 grounded，keep 是有依據的部分（2.0.0 Q4）
export const coreBacked = (x) => x.grounded === true;

const scopeOf = (x) => (x.scope && x.scope !== 'core' ? parseScopeKey(x.scope) : x.pid ? { kind: 'project', pid: x.pid } : null);
const nameOf = (text) => /^name:\s*(.+)$/m.exec(String(text || ''))?.[1]?.trim() || '';

export function Holding({ go }) {
  const list = useData(() => api.holding(), []);
  const [filter, setFilter] = useState('held');
  // 採用時核心準則有變更、還沒算你確認過（POST /api/holding/adopt 回 coreUnconfirmed；從管理介面採用通常不會有）
  const [coreNotice, setCoreNotice] = useState(false);

  if (!list.data) return <div class="page"><ErrorBanner error={list.error} onRetry={list.reload} /><div class="panel"><Skeleton rows={5} /></div></div>;
  const all = list.data;
  const n = { held: 0, adopted: 0, dismissed: 0, all: all.length };
  for (const x of all) n[x.status] = (n[x.status] || 0) + 1;
  const shown = all.filter((x) => filter === 'all' || x.status === filter);

  return (
    <div class="page">
      <ErrorBanner error={list.error} onRetry={list.reload} />
      {coreNotice && (
        <Banner tone="warn" title={t('核心準則有變更，到收件匣的「待你確認」可以看差異，確認或退回。')} actions={<><button class="btn sm" onClick={() => go('inbox', { review: '1' })}>{t('看差異')}<IconChevronRight /></button><button class="btn sm ghost" onClick={() => setCoreNotice(false)}>{t('關閉')}</button></>} />
      )}
      <section class="panel hd-intro">
        <div class="panel-body">
          <p>{t('保留區放的是自動駕駛想做、但沒有執行的修改：審核員沒有放行、不是這一輪負責的範圍，或是被退回的版本。內容與證據都完整保存，你看過之後可以「採用」（寫進記憶，會先備份、可以復原），或標成「不需要」。')}</p>
          <p class="faint">{t('自動駕駛之後也會再審這些項目（每項最多兩次），通過就自動執行。也可以在終端機執行 {cmd} 查看。', { cmd: <code>engram holding</code> })}</p>
        </div>
      </section>

      <div class="filters">
        <div class="seg" role="group" aria-label={t('篩選')}>
          {FILTERS.map((f) => <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{t(f.label)}<span class="n">{n[f.key] || 0}</span></button>)}
        </div>
      </div>

      {shown.length === 0 ? (
        <div class="panel">
          <Empty icon={filter === 'held' ? IconCheckCircle : IconHolding} title={filter === 'held' ? t('保留區是空的') : t('沒有這一類的項目')}
            action={filter === 'held' ? <button class="btn" onClick={() => go('autopilot')}>{t('前往自動駕駛')}<IconChevronRight /></button> : null}>
            {filter === 'held' ? t('自動駕駛沒有執行的修改會出現在這裡，你可以決定要不要採用。') : null}
          </Empty>
        </div>
      ) : (
        <div class="cards">
          {shown.map((x) => <HeldCard key={x.id} x={x} go={go} onCoreUnconfirmed={() => setCoreNotice(true)} />)}
        </div>
      )}
    </div>
  );
}

function HeldCard({ x, go, onCoreUnconfirmed }) {
  const { status } = useApp();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState(null);
  const [err, setErr] = useState(null);
  const kind = KIND[x.kind] || KIND.rejected;
  const scope = scopeOf(x);
  const from = status?.devices?.find((d) => d.id === x.machine);
  const held = x.status === 'held';
  const grad = isGraduation(x);
  const to = x.graduate?.to;

  const adopt = async () => {
    setErr(null);
    try {
      const res = await act(() => api.holdingAdopt(x.id), grad ? t(ADOPTED_TO[to] || N_('已採用：記憶畢業完成，原本的記憶內文沒有動')) : t('已採用，寫進記憶了；可以在記憶整理的紀錄裡復原'), { rethrow: true });
      if (res?.coreUnconfirmed) onCoreUnconfirmed();
    } catch (e) { setErr(e); }
    setAsk(null);
  };
  const dismiss = async () => {
    setErr(null);
    try {
      await act(() => api.holdingDismiss(x.id), t('已標成不需要，自動駕駛不會再重審這一項'), { rethrow: true });
    } catch (e) { setErr(e); }
    setAsk(null);
  };

  return (
    <article class={`card hd-item ${x.status}`} id={`hd-${x.id}`}>
      <header>
        <span class={`act-chip hd-kind ${x.kind}`} title={t(kind.help)}>{t(kind.label)}</span>
        <h3>{local(x, 'title')}</h3>
        {scope ? <ScopeLabel scope={scope} /> : x.scope === 'core' ? <span class="scope global"><IconCore /><span>{t('核心準則')}</span></span> : null}
        <When at={x.at} />
      </header>
      <div class="hd-chips">
        {grad && <span class="chip brand">{to && GRADUATE_TO[to] ? t('記憶畢業：{to}', { to: t(GRADUATE_TO[to]) }) : t('記憶畢業')}</span>}
        {coreBacked(x) && <span class="chip ok" title={t('審核員認為主要的事實有對話佐證，只是部分細節沒有依據；改一改細節通常就能採用。')}>{t('核心事實有依據')}</span>}
        {x.local && <span class="chip" title={t('來自對話回顧、含對話原文或疑似金鑰的項目只存在這台電腦，不會同步到其他電腦。')}>{t('只在這台電腦')}</span>}
        {x.secret && <span class="chip warn" title={t('內容有疑似金鑰的字串，畫面上已遮蔽；採用時會再檢查一次。')}>{t('含疑似金鑰（已遮蔽）')}</span>}
        {x.risk && RISK_LABEL[x.risk] && <span class={`sev-chip ${x.risk}`}>{t(RISK_LABEL[x.risk])}</span>}
        {x.status === 'adopted' && <span class="chip brand">{t('已採用 · {when}', { when: <When at={x.adoptedAt} /> })}</span>}
        {x.status === 'dismissed' && <span class="chip">{t('不需要 · {when}', { when: <When at={x.dismissedAt} /> })}</span>}
      </div>
      {x.why && <p class="hd-why"><b>{t('沒有執行的原因：')}</b>{local(x, 'why')}</p>}
      {coreBacked(x) && (
        <div class="hd-keep">
          <span>{t('審核員認為主要的事實有對話佐證，只是部分細節沒有依據；改一改細節通常就能採用。')}</span>
          {x.keep?.length > 0 && <><b>{t('有依據的部分：')}</b><ul>{x.keep.map((k, i) => <li key={i}>{k}</li>)}</ul></>}
        </div>
      )}
      <p class="faint hd-meta">
        {t('來自自動駕駛的「{task}」', { task: TASK[x.task] ? t(TASK[x.task]) : x.task || '—' })}
        {from && !from.isSelf ? <span>{t('（{label}）', { label: from.label })}</span> : null}
        {held && x.attempts > 0 ? <span>{t('，已自動重審 {n} 次', { n: x.attempts })}</span> : null}
        {held && x.incomplete > 0 ? <span>{t('，有 {n} 輪審核沒有完成', { n: x.incomplete })}</span> : null}
      </p>

      {err && (
        <Banner tone="bad" title={local(err, 'message')} actions={<button class="btn sm ghost" onClick={() => setErr(null)}>{t('關閉')}</button>}>
          {local(err, 'hint')}
        </Banner>
      )}

      <button type="button" class="btn ghost sm hd-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <IconChevronDown /> : <IconChevronRight />}{open ? t('收起內容與證據') : t('看會怎麼改與證據')}
      </button>
      {open && <HeldDetail x={x} />}

      <footer>
        {held && <button class="btn sm primary" onClick={() => setAsk('adopt')}><IconCheck />{t('holding::採用')}</button>}
        {held && <button class="btn sm" onClick={() => setAsk('dismiss')}>{t('不需要')}</button>}
        {x.status === 'adopted' && x.record && (
          <button class="btn sm" onClick={() => go('tidy', { id: x.record })}>{t('看紀錄與復原')}<IconChevronRight /></button>
        )}
      </footer>

      {ask === 'adopt' && (
        <ConfirmDialog title={t('採用「{name}」？', { name: local(x, 'title') })} confirmLabel={t('holding::採用')}
          desc={grad
            ? t('原本的記憶內文不動，只在它的 frontmatter 記下畢業的去向。核心準則的那一行會記為你確認過；護欄規則只會提醒、不會擋下；環境設定還要在每台電腦核可之後才會套用。')
            : t('這些修改會寫進記憶（寫入前先備份）。之後可以在「記憶整理」的紀錄裡復原。如果相關的記憶在這段時間被改過，就不會寫入，這一項會留在保留區。')}
          onConfirm={adopt} onClose={() => setAsk(null)}>
          <p class="muted" style={{ fontSize: 13 }}>{t('會做的事：')}</p>
          {x.graduate ? <GraduateWhat g={x.graduate} /> : <div class="ops">{x.ops.map((o, i) => <OpLine key={i} op={o} />)}</div>}
        </ConfirmDialog>
      )}
      {ask === 'dismiss' && (
        <ConfirmDialog title={t('把「{name}」標成不需要？', { name: local(x, 'title') })} confirmLabel={t('不需要')}
          desc={t('記憶不會有任何改變，自動駕駛也不會再重審這一項。它會留在「不需要」清單當作紀錄。')}
          onConfirm={dismiss} onClose={() => setAsk(null)} />
      )}
    </article>
  );
}

/** 展開後：AI 的理由、每一步會怎麼改（新內容或前後對照）、證據與前後的對話 */
function HeldDetail({ x }) {
  return (
    <div class="hd-detail">
      {x.reason && <p class="tidy-reason"><b>{t('AI 的理由：')}</b>{local(x, 'reason')}</p>}
      {x.graduate && (
        <div class="ops">
          <div class="ops-label">{x.graduate.to && GRADUATE_TO[x.graduate.to] ? t('這筆記憶會{to}', { to: t(GRADUATE_TO[x.graduate.to]) }) : t('記憶畢業')}</div>
          <GraduateWhat g={x.graduate} />
        </div>
      )}
      {x.ops.length > 0 && (
        <div class="ops">
          <div class="ops-label">{t('採用後會這樣改')}</div>
          {x.ops.map((o, i) => <OpRow key={i} op={o} />)}
        </div>
      )}
      {x.evidence.length > 0 && (
        <div class="tidy-evidence" role="group" aria-label={t('對話裡的證據')}>
          <div class="ops-label">{t('對話裡的證據')}</div>
          {x.evidence.map((e, i) => (
            <blockquote key={i}>
              <span class="ev-meta">
                {e.fromUser && <span class="chip brand">{t('使用者說的')}</span>}
                {(e.date || e.session) && <span class="faint">{[e.date, e.session].filter(Boolean).join(' · ')}</span>}
              </span>
              <span>{e.quote}</span>
              {e.context && (
                <details class="hd-context">
                  <summary>{t('看前後的對話')}</summary>
                  <pre>{e.context}</pre>
                </details>
              )}
            </blockquote>
          ))}
        </div>
      )}
    </div>
  );
}

/** 一步的文字說明（確認對話框與展開後共用） */
function opText(op) {
  if (op.op === 'write') return [IconEdit, t('改寫 {ref}', { ref: <code>{op.ref}</code> })];
  if (op.op === 'move') return [IconMove, t('把 {ref} 搬到 {scope}', { ref: <code>{op.ref}</code>, scope: op.to ? <ScopeLabel scope={parseScopeKey(op.to)} /> : '—' })];
  if (op.op === 'remove') return [IconArchive, t('封存 {ref}（移到歷史，可以復原）', { ref: <code>{op.ref}</code> })];
  if (op.op === 'merge') return [IconMerge, t('把 {refs} 合併成 {into}，其他筆移到歷史', { refs: (op.refs || []).map((r) => r.split('/').pop()).join(t('、')), into: <code>{op.into || op.refs?.[0]}</code> })];
  if (op.op === 'create') return [IconPlus, t('新增 {scope} 記憶 {ref}', { scope: op.scope ? <ScopeLabel scope={parseScopeKey(op.scope)} /> : '', ref: <code>{nameOf(op.content) || '—'}</code> })];
  if (op.op === 'core') return [IconCore, t('改寫核心準則 CORE.md')];
  if (op.op === 'guardrail') return [IconShield, t('新增一條護欄規則（只提醒，不擋下）')];
  if (op.op === 'env') return [IconEnv, t('在共用的環境設定檔新增一項（每台電腦核可之後才會套用）')];
  if (op.op === 'graduate') return [IconSparkle, t('在 {ref} 記下畢業的去向（內文不動）', { ref: <code>{op.ref}</code> })];
  return [IconCheckCircle, t('在 {ref} 記下驗證日期 {date}（內容不變）', { ref: <code>{op.ref}</code>, date: '—' })];
}

/** 護欄規則與環境設定的內容是 JSON：拆成欄位顯示（看不懂就原樣顯示） */
function JsonContent({ op }) {
  let v = null;
  try { v = JSON.parse(op.content); } catch { v = null; }
  if (!v || typeof v !== 'object') return <pre class="diff hd-new">{op.content}</pre>;
  if (op.op === 'env') {
    return <dl class="kv hd-json"><dt>{v.area === 'setting' ? t('envarea::設定') : t('envarea::環境變數')}</dt><dd><code>{v.key}</code> = <code class="env-val">{String(v.value)}</code></dd></dl>;
  }
  return (
    <dl class="kv hd-json">
      <dt>{t('比對樣式')}</dt><dd><code class="env-val">{v.pattern}</code>{v.tool ? <span class="faint">　{v.tool === '*' ? 'Bash / PowerShell' : v.tool}</span> : null}</dd>
      {v.unless && <><dt>{t('例外')}</dt><dd><code class="env-val">{v.unless}</code></dd></>}
      <dt>{t('提醒 Claude 的訊息')}</dt><dd>{v.message}</dd>
    </dl>
  );
}

function OpLine({ op }) {
  const [Icon, text] = opText(op);
  return <div class="op"><Icon /><span>{text}</span><span /></div>;
}

/** 改寫與合併：展開時讀目前的內容做前後對照；新增只看新內容 */
function OpRow({ op }) {
  const [Icon, text] = opText(op);
  const [open, setOpen] = useState(false);
  const hasContent = typeof op.content === 'string';
  const target = op.op === 'merge' ? op.into || op.refs?.[0] : op.ref;
  return (
    <div class="op">
      <Icon />
      <span>{text}</span>
      {hasContent ? <button class="btn ghost sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('收起') : ['create', 'guardrail', 'env'].includes(op.op) ? t('看內容') : t('看差異')}</button> : <span />}
      {open && hasContent && (op.op === 'create' ? <pre class="diff hd-new">{op.content}</pre>
        : op.op === 'guardrail' || op.op === 'env' ? <div class="hd-diff"><JsonContent op={op} /></div>
          : <CurrentDiff target={target} core={op.op === 'core'} next={op.content} />)}
    </div>
  );
}

function CurrentDiff({ target, core, next }) {
  const cur = useData(() => (core ? api.core().then((c) => c.text) : api.memory(target).then((m) => m.raw)), [target, core]);
  if (cur.data === undefined && !cur.error) return <div class="hd-diff"><Skeleton rows={2} /></div>;
  if (cur.error) {
    return (
      <div class="hd-diff">
        <p class="faint" style={{ fontSize: 12.5 }}>{t('讀不到目前的內容（可能已經被刪除或改名），下面是保留區裡的新內容：')}</p>
        <pre class="diff hd-new">{next}</pre>
      </div>
    );
  }
  return (
    <div class="hd-diff">
      <p class="faint" style={{ fontSize: 12.5 }}>{t('和目前的內容比較：紅色是會被拿掉的，綠色是會加上的。')}</p>
      <DiffView a={cur.data} b={next} />
    </div>
  );
}
