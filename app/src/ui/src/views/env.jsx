// 環境（2.0.0）：這台電腦的 Claude Code 環境。四個分頁：
// 1. 這台的發現：環境健檢的卡片（可以修的有「修正」按鈕，只是提醒的不放按鈕）與環境指紋的摘要。
// 2. 兩台差異：每台電腦每天寫進記憶庫的環境指紋（只有名稱、版本、雜湊）互相比較。
// 3. 設定同步：共用的環境設定檔、這台套用後會改什麼、等待這台核可的項目、套用與還原、近 30 天沒用過的外掛。
// 4. 護欄：見 guardrails.jsx。
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { Banner, ConfirmDialog, Empty, ErrorBanner, Section, SevChip, Skeleton, useAction, useApp, useData } from '../components.jsx';
import { t, N_, local } from '../i18n.js';
import { IconCheck, IconCheckCircle, IconChevronRight, IconEnv, IconMonitor, IconUndo } from '../icons.jsx';
import { relTime } from '../util.js';
import { GuardrailsPanel } from './guardrails.jsx';

const TABS = [
  { key: 'findings', label: N_('這台的發現') },
  { key: 'diff', label: N_('兩台差異') },
  { key: 'sync', label: N_('env::設定同步') },
  { key: 'guard', label: N_('護欄') },
];
const SEV_ORDER = { high: 0, medium: 1, low: 2, auto: 3 };

export function Env({ params, go }) {
  const tab = TABS.some((x) => x.key === params.tab) ? params.tab : 'findings';
  // 環境指紋與發現：發現頁與設定同步頁（已停用的外掛）共用。第一次掃描要讀近 30 天的對話紀錄，可能要幾秒
  const env = useData(() => api.env(), []);
  const nFindings = (env.data?.findings || []).filter((f) => f.severity !== 'auto').length;
  return (
    <div class="page">
      <div class="filters env-tabs">
        <div class="seg" role="tablist" aria-label={t('環境的分頁')}>
          {TABS.map((x) => (
            <button key={x.key} role="tab" aria-selected={tab === x.key} aria-pressed={tab === x.key} onClick={() => go('env', { tab: x.key }, true)}>
              {t(x.label)}{x.key === 'findings' && nFindings > 0 && <span class="n">{nFindings}</span>}
            </button>
          ))}
        </div>
      </div>
      {tab === 'findings' && <FindingsTab env={env} go={go} />}
      {tab === 'diff' && <DiffTab />}
      {tab === 'sync' && <SyncTab go={go} />}
      {tab === 'guard' && <GuardrailsPanel go={go} />}
    </div>
  );
}

// ───────── 這台的發現 ─────────

function FindingsTab({ env, go }) {
  const act = useAction();
  if (!env.data) {
    return (
      <>
        <ErrorBanner error={env.error} onRetry={env.reload} />
        {!env.error && <p class="faint env-wait">{t('正在檢查這台電腦的環境（第一次要讀近 30 天的對話紀錄，可能要幾秒）…')}</p>}
        <div class="panel"><Skeleton rows={5} /></div>
      </>
    );
  }
  const { envHealth, fingerprint: fp, findings } = env.data;
  const list = [...findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  const plugins = fp?.plugins || [];
  const disabled = Object.values(fp?.settings?.enabledPlugins || {}).filter((v) => v === false).length;
  const fix = (f) => act(() => api.envFix(f.id), (res) => (res?.delegated ? local(res, 'note') : t('已處理：{label}。修改前的設定檔已備份。', { label: local(f.fix, 'label') })));

  return (
    <>
      <ErrorBanner error={env.error} onRetry={env.reload} />
      {envHealth === 'off' && (
        <Banner tone="warn" title={t('環境健檢已關閉')} actions={<button class="btn sm" onClick={() => go('settings')}>{t('前往設定')}<IconChevronRight /></button>}>
          {t('這台電腦不會每天檢查環境，下面是上一次檢查的結果。')}
        </Banner>
      )}
      <Section title={t('這台電腦的 Claude Code')} sub={fp?.updated ? t('上次檢查 {date}', { date: fp.updated }) : null}>
        <div class="panel-body env-fp">
          <dl class="kv">
            <dt>Claude Code</dt><dd>{fp?.claudeCode?.version || '—'}</dd>
            <dt>Engram</dt><dd>{fp?.engram?.version || '—'}{fp?.engram?.commit ? <span class="faint mono">　{String(fp.engram.commit).slice(0, 7)}</span> : null}</dd>
            <dt>{t('fp::外掛')}</dt><dd>{disabled ? t('{n} 個（{off} 個停用中）', { n: plugins.length, off: disabled }) : t('plugins::{n} 個', { n: plugins.length })}</dd>
            <dt>{t('自製技能')}</dt><dd>{t('plugins::{n} 個', { n: fp?.skills?.length || 0 })}</dd>
          </dl>
          <p class="faint env-note">{t('每天檢查一次，只讀名稱、版本、雜湊與耗時，不讀設定值、環境變數的值或對話內容。指令：{cmd}', { cmd: <code>engram env</code> })}</p>
        </div>
      </Section>

      {list.length === 0 ? (
        <div class="panel"><Empty icon={IconCheckCircle} title={t('這台電腦的環境沒有發現問題')}>{t('之後有慢的 hook、失效的設定或沒在用的外掛，會出現在這裡。')}</Empty></div>
      ) : (
        <div class="cards">
          {list.map((f) => (
            <article class={`card sev-stripe ${f.severity === 'auto' ? 'low' : f.severity}`} key={f.id}>
              <header>
                {f.severity === 'auto' ? <span class="chip ok">{t('會自動處理')}</span> : <SevChip sev={f.severity} />}
                <h3>{local(f, 'title')}</h3>
                <span class="code" title={t('卡片代碼')}>{f.code}</span>
              </header>
              <p>{local(f, 'detail')}</p>
              <footer>
                {f.fix ? <button class="btn sm primary" onClick={() => fix(f)}>{local(f.fix, 'label')}</button>
                  : f.code === 'H33' ? <button class="btn sm" onClick={() => go('env', { tab: 'sync' }, true)}>{t('看沒在用的外掛')}<IconChevronRight /></button>
                    : f.severity === 'auto' ? <span class="faint env-note">{t('背景工作會處理，不需要你動手。')}</span>
                      : <span class="faint env-note">{t('只是提醒：Engram 不會改這一項，需要你自己決定。')}</span>}
              </footer>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

// ───────── 兩台差異 ─────────

const AREA = {
  'claude-code': N_('Claude Code 版本'), engram: N_('Engram 版本'), plugin: N_('外掛'), skill: N_('自製技能'), 'claude-md': '~/.claude/CLAUDE.md',
  'claude-md-block': N_('CLAUDE.md 的標記區塊'), 'setting-key': N_('settings.json 的設定'), 'env-key': N_('環境變數（只比名稱）'),
};
const VERSIONED = new Set(['claude-code', 'engram', 'plugin']);
const SINGLE = new Set(['claude-code', 'engram', 'claude-md']);

function DiffValue({ area, kind, v }) {
  if (v === null || v === undefined || v === '') return <span class="chip warn">{t('沒有')}</span>;
  if (VERSIONED.has(area)) return <span class="mono">{v}</span>;
  if (v === 'present' || kind === 'missing') return <span>{t('有')}</span>;
  return <span>{t('有')}<code class="faint env-hash" title={t('內容的雜湊：一樣的代表內容相同')}>{String(v).slice(0, 7)}</code></span>;
}

function DiffTab() {
  const d = useData(() => api.envDiff(), []);
  if (!d.data) return <><ErrorBanner error={d.error} onRetry={d.reload} /><div class="panel"><Skeleton rows={6} /></div></>;
  const { machines, compared, items } = d.data;
  const cols = [...machines].filter((m) => m.hasEnv).sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0));
  const label = (mid) => machines.find((m) => m.mid === mid)?.label || mid;
  const intro = (
    <p class="faint env-note">{t('每台電腦每天把自己的環境指紋寫進記憶庫（只有名稱、版本與內容雜湊，不含設定值），這裡列出不一樣的地方。「比較新」依版本號判斷，沒有版本號的依修改日期。指令：{cmd}', { cmd: <code>engram env diff</code> })}</p>
  );
  if (compared < 2) {
    const missing = machines.filter((m) => !m.hasEnv);
    return (
      <div class="panel">
        <Empty icon={IconMonitor} title={t('還沒有可以比較的電腦')}>
          {t('要有兩台以上的電腦更新到 Engram 2.0.0、而且各自完成一次環境檢查，才能比較。')}
          {missing.length > 0 && <span class="env-block">{t('還沒有環境指紋：{list}', { list: missing.map((m) => m.label).join(t('、')) })}</span>}
        </Empty>
      </div>
    );
  }
  return (
    <Section title={t('兩台電腦的差異')} sub={t('比較 {n} 台電腦', { n: compared })}>
      <div class="panel-body">{intro}
        <p class="faint env-note">{cols.map((m, i) => <span key={m.mid}>{i > 0 && t('；')}{t('「{label}」的指紋：{date}', { label: m.label, date: m.updated || '—' })}</span>)}</p>
      </div>
      {items.length === 0 ? <Empty icon={IconCheckCircle} title={t('各台電腦的環境一致')} /> : (
        <div class="table-wrap">
          <table class="data responsive env-diff">
            <thead><tr><th>{t('項目')}</th>{cols.map((m) => <th key={m.mid}>{m.label}{m.self && <span class="chip brand env-self">{t('這台')}</span>}</th>)}<th>{t('比較新')}</th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={`${it.area}:${it.key}:${i}`}>
                  <td data-label={t('項目')}>
                    <b class="env-area">{t(AREA[it.area] || it.area)}</b>
                    {!SINGLE.has(it.area) && <code class="env-key">{it.key}</code>}
                    <span class="faint env-kind">{it.kind === 'missing' ? t('只有部分電腦有') : it.kind === 'version' ? t('版本不同') : t('內容不同')}</span>
                  </td>
                  {cols.map((m) => <td key={m.mid} data-label={m.label}><DiffValue area={it.area} kind={it.kind} v={it.values?.[m.mid]} /></td>)}
                  <td data-label={t('比較新')}>{it.newer ? <b>{label(it.newer)}</b> : <span class="faint">{t('看不出來')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ───────── 設定同步 ─────────

const MODE = {
  report: { label: N_('只報告'), help: N_('每天算出這台套用後會改什麼，放在這裡給你看，不會自動寫入。') },
  auto: { label: N_('自動套用'), help: N_('沒有對話進行中時，自動套用已核可的項目。') },
  off: { label: N_('envsync::關閉'), help: N_('不同步環境設定。') },
};
const AREA_NAME = { setting: N_('envarea::設定'), env: N_('envarea::環境變數'), skill: N_('envarea::技能'), plugin: N_('envarea::外掛') };
const CHANGE = new Set(['add', 'update', 'restore']);

/** 設定與環境變數的值：完整顯示（不截斷），字串原樣、其他用 JSON */
const valueText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

function ItemChange({ it }) {
  const area = t(AREA_NAME[it.area] || it.area);
  if (it.area === 'skill') {
    return <span>{t('{area}「{key}」：{what}（{n} 個檔案；內容在記憶庫的 {dir}）', { area, key: it.key, what: it.action === 'add' ? t('envsync::新增') : t('envsync::更新'), n: it.files ?? 0, dir: <code>env/skills/{it.key}/</code> })}</span>;
  }
  return (
    <span class="env-change">
      <span>{t('{area}「{key}」', { area, key: it.key })}</span>
      {it.action === 'restore' ? (
        <span class="faint">{t('共用設定檔已經沒有這一項，會還原成套用之前的樣子：')}</span>
      ) : it.from != null ? <span class="faint">{t('從')}</span> : <span class="faint">{t('envsync::新增')}</span>}
      {it.from != null && it.action !== 'restore' && <code class="env-val old">{it.from}</code>}
      {it.from != null && it.action !== 'restore' && <span class="faint">{t('改成')}</span>}
      {it.action === 'restore' ? <code class="env-val">{it.to ?? t('（沒有這一項）')}</code> : <code class="env-val">{it.to}</code>}
    </span>
  );
}

function otherText(it, labels) {
  if (it.action === 'missing') return t('外掛「{key}」：這台沒有安裝。Engram 不會自動安裝外掛，需要的話請自己安裝。', { key: it.key });
  if (it.action === 'version') {
    const others = Object.entries(it.others || {}).map(([l, v]) => `${l} ${v}`).join(t('、'));
    const newer = it.newer ? (labels.self === it.newer ? t('這台比較新') : t('{label} 比較新', { label: labels[it.newer] || it.newer })) : '';
    return t('外掛「{key}」：版本不同（這台 {local}；{others}）{newer}', { key: it.key, local: it.local, others, newer: newer ? t('；{text}', { text: newer }) : '' });
  }
  if (it.action === 'skip') return t('{area}「{key}」：這台電腦設定為略過', { area: t(AREA_NAME[it.area] || it.area), key: it.key });
  if (it.action === 'not-exported') return t('技能「{key}」：記憶庫裡還沒有這個技能的檔案（到有這個技能的電腦執行 engram env export --skill {key}）', { key: it.key });
  return local(it, 'summary');
}

function SyncTab({ go }) {
  const { status, reportError } = useApp();
  const plan = useData(() => api.envPlan(), []);
  const prof = useData(() => api.envProfile(), []);
  const act = useAction();
  const [ask, setAsk] = useState(null);
  if (!plan.data) return <><ErrorBanner error={plan.error} onRetry={plan.reload} /><div class="panel"><Skeleton rows={6} /></div></>;
  const p = plan.data;
  const labels = Object.fromEntries((status?.devices || []).map((d) => [d.id, d.label]));
  labels.self = status?.devices?.find((d) => d.isSelf)?.id;
  const changes = p.items.filter((it) => CHANGE.has(it.action) && it.approved !== false);
  const waiting = p.items.filter((it) => it.approved === false);
  const others = p.items.filter((it) => !CHANGE.has(it.action));
  const mode = MODE[p.envSync] || MODE.report;
  // 已停用的外掛：plan 從這台的 settings.json 讀出（停用、啟用之後重新讀 plan 就會更新）
  const offKeys = p.disabledPlugins || [];

  // 核可失敗（例如內容在你看過之後又變了）：重新讀 plan，畫面換成最新的內容與雜湊，再顯示原因
  const approveRun = async (fn, text) => {
    try { await act(fn, text, { rethrow: true }); } catch (e) { plan.reload(); prof.reload(); reportError(e); }
  };
  const approve = (it) => approveRun(() => api.envApprove(`${it.area}:${it.key}`, it.hash), t('已核可「{key}」，套用時會一起寫入', { key: it.key }));
  const approveAll = () => approveRun(() => api.envApprove(), (r) => t('已核可 {n} 項', { n: r?.count ?? waiting.length }));
  const plugin = (key, enabled) => act(() => api.envPlugin(key, enabled), enabled ? t('已啟用 {name}', { name: key }) : t('已停用 {name}（可以再啟用，或按「還原上一次」）', { name: key }));

  return (
    <>
      <ErrorBanner error={plan.error} onRetry={plan.reload} />
      <section class="panel env-mode">
        <div class="panel-body">
          <div class="env-mode-top">
            <b>{t('目前的設定：{mode}', { mode: t(mode.label) })}</b>
            <button class="btn sm ghost" onClick={() => go('settings')}>{t('變更')}<IconChevronRight /></button>
          </div>
          <p class="muted">{t(mode.help)}</p>
          <p class="muted">{t('兩台電腦可以共用一份環境設定（白名單內的 Claude Code 設定、環境變數、自製技能、應該安裝的外掛清單）。從其他電腦同步來的設定，要在這台看過並「核可」才會套用：核可代表你確認這些值可以在這台電腦生效；內容之後又被改過，就要重新核可。')}</p>
          <p class="muted">{t('核可只能在這個管理介面或你自己的終端機（{cmd}）做；在 Claude Code 的對話裡執行核可會被拒絕，這樣 AI 不能自己核可要套用的設定。', { cmd: <code>engram env approve</code> })}</p>
          <p class="faint env-note">{t('指令：{plan}（看會改什麼）、{approve}、{apply}、{undo}', { plan: <code>engram env plan</code>, approve: <code>engram env approve</code>, apply: <code>engram env apply</code>, undo: <code>engram env undo</code> })}</p>
        </div>
      </section>
      {p.problem && <Banner tone="bad" title={t('這台的 settings.json 不能自動修改')}>{local(p.problem, 'message')}</Banner>}

      <ProfileSection prof={prof} labels={labels} />

      <Section title={t('這台套用後會改什麼')} sub={changes.length ? t('{n} 項', { n: changes.length }) : t('沒有要改的')}
        end={<>
          <button class="btn sm" onClick={() => setAsk('undo')}><IconUndo />{t('還原上一次')}</button>
          <button class="btn sm primary" disabled={!p.changes} onClick={() => setAsk('apply')}><IconCheck />{p.changes ? t('套用（{n} 項）', { n: p.changes }) : t('套用')}</button>
        </>}>
        {changes.length === 0 ? (
          <div class="panel-body"><p class="faint">{waiting.length ? t('已核可的項目都已經套用；還有 {n} 項等待你核可（見下方）。', { n: waiting.length }) : t('這台電腦的設定已經和共用設定檔一致。')}</p></div>
        ) : (
          <ul class="env-list">{changes.map((it) => <li key={`${it.area}:${it.key}`}><ItemChange it={it} /></li>)}</ul>
        )}
        <div class="panel-body env-foot"><p class="faint env-note">{t('套用會改 ~/.claude/settings.json 與 ~/.claude/skills/，改之前先備份；「還原上一次」把最近一次套用（或外掛的停用、啟用）改回原本的樣子。')}</p></div>
      </Section>

      {waiting.length > 0 && (
        <Section title={t('等待這台核可')} sub={t('{n} 項', { n: waiting.length })} end={<button class="btn sm primary" onClick={approveAll}><IconCheck />{t('全部核可（{n}）', { n: waiting.length })}</button>}>
          <div class="panel-body"><p class="muted env-note">{t('這些值是其他電腦放進共用設定檔的。看過每一項的完整內容，確認可以在這台生效再核可；核可之後按「套用」才會寫入。')}</p></div>
          <ul class="env-list">
            {waiting.map((it) => (
              <li key={`${it.area}:${it.key}`} class="env-wait-item">
                <ItemChange it={it} />
                <button class="btn sm" onClick={() => approve(it)} aria-label={t('核可：{key}', { key: it.key })}><IconCheck />{t('核可')}</button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {others.length > 0 && (
        <Section title={t('其他說明')}>
          <ul class="env-list">
            {others.map((it) => <li key={`${it.area}:${it.key}:${it.action}`}>{otherText(it, labels)}</li>)}
          </ul>
        </Section>
      )}

      {p.blocked?.length > 0 && (
        <Section title={t('不會同步的項目')} sub={t('{n} 項', { n: p.blocked.length })}>
          <div class="panel-body">
            <p class="muted env-note">{t('共用設定檔裡的這些項目沒有通過檢查，不會套用到任何電腦。需要的話請在各台電腦自己設定。會被擋下的有：')}</p>
            <ul class="env-rules">
              <li>{t('設定：只同步 {list}；其他設定（例如會定期執行指令的 statusLine、hooks、權限）都不同步。', { list: <code>model、effortLevel、language、theme、cleanupPeriodDays、autoUpdatesChannel、editorMode</code> })}</li>
              <li>{t('名稱含 KEY、TOKEN、SECRET、PASSWORD 的環境變數，以及看起來像金鑰、或含這台電腦家目錄路徑的值。')}</li>
              <li>{t('會改變執行環境或執行別的程式的環境變數，例如 {names}，以及 {prefixes} 開頭的。', { names: <code>PATH、HOME、TEMP、NODE_OPTIONS、PYTHONPATH、BASH_ENV、CLAUDE_CONFIG_DIR</code>, prefixes: <code>LD_、DYLD_、GIT_、NPM_CONFIG_、ANTHROPIC_、CLAUDE_CODE_USE_、AWS_、AZURE_CLIENT_、GOOGLE_APPLICATION_、SSL_CERT_、CLAUDE_CODE_SHELL</code> })}</li>
              <li>{t('名稱結尾指向程式、位置、憑證或轉送請求的環境變數，例如 {suffixes}。', { suffixes: <code>_PATH、_HOME、_DIR、_FILE、_CMD、_COMMAND、_SHELL、_PREFIX、_EXEC、_CERT、_CA_CERTS、_PROXY、_BASE_URL、_ENDPOINT</code> })}</li>
            </ul>
          </div>
          <ul class="env-list">
            {p.blocked.map((b, i) => <li key={`b${i}`} class="env-blocked">{t('{area}「{key}」：{why}', { area: t(AREA_NAME[b.area] || b.area), key: b.key, why: local(b, 'message') })}</li>)}
          </ul>
        </Section>
      )}

      <Section title={t('近 {n} 天沒用過的外掛', { n: p.unused?.windowDays ?? 30 })}>
        <div class="panel-body"><p class="muted env-note">{t('沒在用的外掛仍會在每次對話載入、佔用上下文。停用只改 settings.json 的 enabledPlugins（先備份），隨時可以再啟用。Engram 不會自動停用。')}</p></div>
        {!p.unused?.known ? (
          <div class="panel-body"><p class="faint">{t('這台的對話紀錄還不夠 {n} 天（或還沒有統計），看不出哪些外掛沒在用。', { n: p.unused?.windowDays ?? 30 })}</p></div>
        ) : p.unused.plugins.length === 0 && offKeys.length === 0 ? (
          <div class="panel-body"><p class="faint">{t('每個啟用中的外掛近期都有用到。')}</p></div>
        ) : null}
        {(p.unused?.plugins?.length > 0 || offKeys.length > 0) && (
          <ul class="env-list">
            {(p.unused?.plugins || []).map((pl) => (
              <li key={pl.key} class="env-wait-item">
                <span><code>{pl.key}</code>{pl.installedAt && <span class="faint">　{t('安裝於 {when}', { when: relTime(pl.installedAt) })}</span>}</span>
                <button class="btn sm" onClick={() => plugin(pl.key, false)}>{t('停用')}</button>
              </li>
            ))}
            {offKeys.map((k) => (
              <li key={k} class="env-wait-item">
                <span><code>{k}</code><span class="chip env-self">{t('已停用')}</span></span>
                <button class="btn sm" onClick={() => plugin(k, true)}>{t('plugin::啟用')}</button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {ask === 'apply' && (
        <ConfirmDialog title={t('套用 {n} 項環境設定？', { n: p.changes })} confirmLabel={t('套用')}
          desc={t('會寫進這台的 ~/.claude/settings.json 與 ~/.claude/skills/（先備份），新開的 Claude Code 對話就會生效。之後可以按「還原上一次」改回來。')}
          onConfirm={async () => { await act(() => api.envApply(), (r) => t('已套用 {n} 項', { n: r?.applied ?? 0 })); setAsk(null); }} onClose={() => setAsk(null)}>
          <ul class="env-list compact">{changes.map((it) => <li key={`${it.area}:${it.key}`}><ItemChange it={it} /></li>)}</ul>
        </ConfirmDialog>
      )}
      {ask === 'undo' && (
        <ConfirmDialog title={t('還原上一次？')} confirmLabel={t('還原上一次')}
          desc={t('把最近一次套用（或外掛的停用、啟用）改回原本的樣子。之後你自己改過的值不會被動到。')}
          onConfirm={async () => { await act(() => api.envUndo(), (r) => t('已還原 {n} 項', { n: r?.restored ?? 0 })); setAsk(null); }} onClose={() => setAsk(null)} />
      )}
    </>
  );
}

function ProfileSection({ prof, labels }) {
  const act = useAction();
  const [ask, setAsk] = useState(null);
  if (!prof.data) {
    return (
      <Section title={t('共用的環境設定檔')}>
        {prof.error ? <div class="panel-body"><p class="faint">{local(prof.error, 'message')}</p></div> : <div class="panel-body"><Skeleton rows={3} /></div>}
      </Section>
    );
  }
  const d = prof.data;
  if (!d.present) {
    return (
      <Section title={t('共用的環境設定檔')}>
        <Empty icon={IconEnv} title={t('還沒有共用的環境設定檔')}>
          {t('在想當成範本的電腦執行 {cmd}，會把白名單內的設定、啟用中的外掛清單與指定的技能寫進記憶庫，其他電腦就能看到並核可。', { cmd: <code>engram env export</code> })}
        </Empty>
      </Section>
    );
  }
  if (d.problem) return <Section title={t('共用的環境設定檔')}><div class="panel-body"><Banner tone="bad" title={t('共用設定檔損毀')}>{t('vault/env/profile.json 不是有效的 JSON，Engram 不會套用也不會覆蓋它。')}</Banner></div></Section>;
  const pf = d.profile;
  const rows = [
    ...Object.entries(pf.settings || {}).map(([k, v]) => ({ area: 'setting', key: k, value: valueText(v) })),
    ...Object.entries(pf.env || {}).map(([k, v]) => ({ area: 'env', key: k, value: valueText(v) })),
    ...(pf.skills || []).map((s) => ({ area: 'skill', key: s, value: null })),
    ...(pf.plugins || []).map((x) => ({ area: 'plugin', key: `${x.name}@${x.marketplace}`, name: x.name, value: null })),
  ];
  const skips = d.overrides?.skip || [];
  // 這台的略過清單裡對應這一列的那一筆（略過可以寫成名稱或 area:名稱；外掛也可以只寫名稱）
  const skipOf = (r) => skips.find((s) => s === r.key || s === `${r.area}:${r.key}` || (r.name && (s === r.name || s === `plugin:${r.name}`)));
  const removeAction = { setting: 'unset', env: 'unset', skill: 'remove-skill', plugin: 'remove-plugin' };
  const removeName = (r) => (r.area === 'setting' ? `setting:${r.key}` : r.key);
  const doSkip = (r) => {
    const cur = skipOf(r);
    return act(() => api.envProfileAction(cur ? 'unskip' : 'skip', cur || `${r.area}:${r.key}`), cur ? t('這台不再略過「{key}」', { key: r.key }) : t('這台會略過「{key}」，其他電腦不受影響', { key: r.key }));
  };
  return (
    <Section title={t('共用的環境設定檔')} sub={pf.updatedAt ? t('{when}由「{label}」更新', { when: relTime(pf.updatedAt), label: labels[pf.by] || pf.by || '—' }) : null}>
      {rows.length === 0 ? <div class="panel-body"><p class="faint">{t('設定檔是空的。')}</p></div> : (
        <div class="table-wrap">
          <table class="data responsive env-profile">
            <thead><tr><th>{t('類別')}</th><th>{t('名稱')}</th><th>{t('值')}</th><th><span class="sr-only">{t('動作')}</span></th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const skipped = !!skipOf(r);
                return (
                  <tr key={`${r.area}:${r.key}`}>
                    <td data-label={t('類別')}>{t(AREA_NAME[r.area])}{skipped && <span class="chip env-self">{t('這台略過')}</span>}</td>
                    <td data-label={t('名稱')}><code>{r.key}</code></td>
                    <td data-label={t('值')}>{r.value !== null ? <code class="env-val">{r.value}</code> : <span class="faint">{r.area === 'skill' ? t('技能資料夾（在記憶庫的 env/skills/）') : t('應該安裝的外掛（不會自動安裝）')}</span>}</td>
                    <td class="env-row-actions">
                      <button class="btn sm ghost" onClick={() => doSkip(r)}>{skipped ? t('取消略過') : t('這台略過')}</button>
                      <button class="btn sm ghost" onClick={() => setAsk(r)}>{t('從設定檔移除')}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div class="panel-body env-foot"><p class="faint env-note">{t('「這台略過」只影響這台電腦；「從設定檔移除」會讓所有電腦都不再同步這一項（已經套用到某台的值，下次套用時還原成套用之前的樣子）。')}</p></div>
      {ask && (
        <ConfirmDialog title={t('從共用設定檔移除「{key}」？', { key: ask.key })} confirmLabel={t('從設定檔移除')} danger
          desc={t('所有電腦都不會再同步這一項。已經套用到某台電腦的值不會馬上改，下次套用時會還原成套用之前的樣子；技能已經裝好的檔案不會被刪掉。')}
          onConfirm={async () => { await act(() => api.envProfileAction(removeAction[ask.area], removeName(ask)), t('已從共用設定檔移除「{key}」', { key: ask.key })); setAsk(null); }}
          onClose={() => setAsk(null)} />
      )}
    </Section>
  );
}
