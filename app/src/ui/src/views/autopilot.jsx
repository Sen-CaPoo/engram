// 自動駕駛（1.5.0）：開關與用量、每一輪做了什麼與為什麼、逐項或整輪復原。
// 開啟後，常駐程式每天在電腦閒置時讓 AI（claude -p）整理記憶、處理收件匣、回顧對話；每一項變更先備份、經審核員檢查，
// 這一頁看得到全部過程，也都能復原。這一頁不呼叫 AI，只讀取常駐程式寫下的執行紀錄。
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { Banner, ConfirmDialog, Empty, ErrorBanner, Meter, ReviewLine, ScopeLabel, Skeleton, useAction, useApp, useData } from '../components.jsx';
import { t, N_, local, locale } from '../i18n.js';
import { IconAutopilot, IconChevronRight, IconPlay, IconUndo } from '../icons.jsx';
import { parseScopeKey, relTime, untilTime, RISK_LABEL } from '../util.js';

// 顯示順序：整理、對話回顧、收件匣、同步衝突、金鑰、待你確認
const TASKS = ['curate', 'dream', 'cards', 'conflicts', 'secrets', 'review'];
const TASK = { curate: N_('整理'), dream: N_('對話回顧'), cards: N_('收件匣'), conflicts: N_('同步衝突'), secrets: N_('金鑰'), review: N_('待你確認') };
const REASON = { schedule: N_('自動執行'), coalesced: N_('自動執行'), manual: N_('手動執行'), enable: N_('剛開啟時') };
const RUN_STATUS = { running: N_('執行中'), done: N_('已完成'), failed: N_('失敗'), interrupted: N_('中斷') };
const RUN_TONE = { running: 'brand live', done: 'ok', failed: 'danger', interrupted: 'warn' };
// 整理項目的動作（與記憶整理頁相同的詞）與其他種類的處理
const ACTION = { update: N_('改寫'), move: N_('搬移'), archive: N_('封存'), merge: N_('合併'), create: N_('新增'), split: N_('拆分'), promote: N_('升為全域'), verify: N_('確認仍正確'), keep: N_('保留') };
const KIND = { card: N_('處理卡片'), rename: N_('資料夾改名'), conflict: N_('同步衝突'), vault: N_('金鑰移到保管區'), 'not-secret': N_('標記不是金鑰'), confirm: N_('代你確認'), revert: N_('退回'), dismiss: N_('不處理') };
// 被復原次數統計用的類別（暫停與你復原過的項目）
const CATEGORY = { ...ACTION, core: N_('核心準則'), 'dream-create': N_('對話回顧新增'), 'dream-update': N_('對話回顧改寫'), confirm: N_('代你確認'), revert: N_('退回'), vault: N_('金鑰移到保管區'), 'not-secret': N_('標記不是金鑰'), rename: N_('撞名資料夾改名') };
const HOW = [N_('每天一次，電腦閒置時開始'), N_('AI 整理記憶、處理收件匣、回顧對話'), N_('每項變更先備份，再由審核員檢查'), N_('你在這裡看結果，逐項復原')];

const categoryLabel = (c) => {
  if (CATEGORY[c]) return t(CATEGORY[c]);
  if (String(c).startsWith('card-')) return t('收件匣卡片 {code}', { code: String(c).slice(5) });
  if (String(c).startsWith('conflict-')) return t('同步衝突');
  return String(c);
};
const taskLabel = (k) => (TASK[k] ? t(TASK[k]) : k === 'run' ? t('這一輪') : String(k));
const usd = (n) => (n > 0 && n < 0.01 ? '<0.01' : Number(n || 0).toFixed(2));
// 與 app/src/autopilot/run.mjs 的 undoable 相同
const undoable = (a) => a.status === 'done' && !a.undone && (a.kind === 'tidy' || a.undo?.length > 0 || (a.kind === 'rename' && !!a.renameId) || (a.kind === 'not-secret' && a.allowHashes?.length > 0) || (a.kind === 'vault' && a.vaultNames?.length > 0));
const scopeOf = (x) => (x.scope ? parseScopeKey(x.scope) : x.pid ? { kind: 'project', pid: x.pid } : null);
const whenText = (at) => new Date(at).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 這一輪的數字：處理幾項、幾張卡片不用處理、幾項建議沒有執行、幾項失敗 */
function countParts(s) {
  const parts = [];
  if (s.changes) parts.push(t('處理 {n} 項', { n: s.changes }));
  if (s.dismissed) parts.push(t('{n} 張卡片判斷不用處理', { n: s.dismissed }));
  if (s.rejected) parts.push(t('{n} 項建議沒有執行', { n: s.rejected }));
  if (s.failed) parts.push(t('{n} 項失敗', { n: s.failed }));
  return parts;
}

/** 清單裡一句話說明這一輪的結果 */
function runLine(s, status) {
  if (status === 'running') return t('正在處理，結果會陸續出現');
  if (status === 'interrupted') return t('被中斷，沒有完成');
  if (!s) return '';
  const parts = countParts(s);
  if (status === 'failed') parts.push(t('中途停止'));
  return parts.length ? parts.join(t('、')) : t('這一輪沒有需要處理的事');
}

// ───────── 開關（自動駕駛頁與設定頁共用） ─────────

/** 開啟前先說明會發生什麼（開啟會立刻跑第一輪）；關閉直接生效。畫面先照使用者的選擇切換，存不進去時換回來。 */
export function useAutopilotToggle(enabled, monthly) {
  const act = useAction();
  const [ask, setAsk] = useState(false);
  const [opt, setOpt] = useState(null);
  useEffect(() => { setOpt(null); }, [enabled]);
  const set = async (on) => {
    setOpt(on);
    const res = await act(() => api.saveSettings({ autopilot: on ? 'on' : 'off' }), on ? t('自動駕駛已開啟，第一輪正在執行') : t('自動駕駛已關閉'));
    if (!res) setOpt(null);
  };
  const dialog = ask && (
    <ConfirmDialog title={t('開啟自動駕駛？')} desc={t('Engram 會立刻執行第一輪，之後每天在電腦閒置時自動執行。AI 的每個變更都會先備份、經過另一位「審核員」檢查；你可以在「自動駕駛」頁看到做了什麼，並逐項或整輪復原。')} confirmLabel={t('開啟並立即執行')}
      onConfirm={async () => { setAsk(false); await set(true); }} onClose={() => setAsk(false)}>
      <p class="muted" style={{ fontSize: 13 }}>{t('每月用量上限約當 US$ {n}。用 Claude 訂閱時不另外計費，這是額度消耗的參考。', { n: monthly ?? 30 })}</p>
    </ConfirmDialog>
  );
  return { on: opt ?? !!enabled, request: (on) => (on ? setAsk(true) : set(false)), dialog };
}

export function AutopilotSwitch({ tog, id }) {
  return (
    <button type="button" role="switch" id={id} class="switch" aria-checked={tog.on ? 'true' : 'false'} aria-label={t('自動駕駛')} onClick={() => tog.request(!tog.on)}>
      <span class="knob" />
    </button>
  );
}

// ───────── 頁面 ─────────

export function Autopilot({ params, go }) {
  const { toast, reportError, refresh } = useApp();
  const ap = useData(() => api.autopilot(), []);
  const agent = useData(() => api.agent(), []);
  const act = useAction();
  const tog = useAutopilotToggle(ap.data?.enabled, ap.data?.budget?.monthly);
  const [sel, setSel] = useState(params?.id || null);
  const [starting, setStarting] = useState(false);
  const runningId = ap.data?.running?.id;
  useEffect(() => { if (runningId) setStarting(false); }, [runningId]);

  if (!ap.data) return <div class="page"><ErrorBanner error={ap.error} onRetry={ap.reload} /><div class="panel"><Skeleton rows={6} /></div></div>;
  const d = ap.data;
  const on = tog.on;
  const running = d.running;
  const runs = d.runs;
  const selected = sel ?? running?.id ?? runs[0]?.id ?? null;
  const job = agent.data?.jobs?.find((j) => j.id === 'curate');
  const lastAt = job?.lastRunAt ?? runs.find((r) => r.status !== 'running')?.startedAt ?? null;
  const caps = [...new Set([15, 30, 60, 120, d.budget.monthly])].sort((a, b) => a - b);

  const start = async () => {
    setStarting(true);
    try {
      await api.autopilotStart();
      toast(t('已開始執行自動駕駛'));
      setTimeout(() => { setStarting(false); refresh(); }, 1500);
    } catch (e) { setStarting(false); reportError(e); }
  };
  const setCap = (e) => act(() => api.saveSettings({ autopilotBudget: Number(e.currentTarget.value) }), t('已更新每月用量上限'));
  const pick = (id) => {
    setSel(id);
    // 窄螢幕的清單與內容上下排列：選了之後捲到內容
    if (window.matchMedia?.('(max-width: 1000px)').matches) setTimeout(() => document.getElementById('ap-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const busy = !!running || starting;

  return (
    <div class="page">
      <ErrorBanner error={ap.error} onRetry={ap.reload} />
      {d.paused.length > 0 && (
        <Banner tone="warn" title={t('有 {n} 類處理暫停中', { n: d.paused.length })}>
          {t('這些類別在 60 天內被你復原過 2 次以上，自動駕駛只會記錄建議、不會執行：{list}', { list: d.paused.map((c, i) => <span key={c}>{i > 0 && t('、')}<b>{categoryLabel(c)}</b></span>) })}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {d.paused.map((c) => <button key={c} class="btn sm" onClick={() => act(() => api.autopilotResume(c), t('已恢復「{name}」', { name: categoryLabel(c) }))}>{t('恢復「{name}」', { name: categoryLabel(c) })}</button>)}
          </div>
        </Banner>
      )}

      <section class={`panel ap-hero${on ? ' on' : ''}`}>
        <div class="ap-hero-top">
          <span class="ap-mark"><IconAutopilot /></span>
          <h2>{on ? t('自動駕駛已開啟') : t('自動駕駛已關閉')}{running && <span class="chip brand live">{t('執行中')}</span>}</h2>
          <AutopilotSwitch tog={tog} id="ap-switch" />
        </div>
        <p class="ap-hero-text">{t('開啟後，Engram 會在電腦閒置時，每天讓 AI 自動整理記憶、處理收件匣、回顧對話，不會逐項問你。每一項變更都有備份，可以在這一頁復原。')}</p>
        <div class="ap-hero-body">
          <div class="ap-side">
            <dl class="kv ap-facts">
              <dt>{t('處理共用記憶的電腦')}</dt>
              <dd>
                {d.host?.label ? <span class="ap-host">{d.host.label}{d.host.self && <span class="chip brand">{t('這台')}</span>}</span> : <span class="faint">{t('還沒有電腦開啟自動駕駛')}</span>}
                <span class="faint ap-sub">{t('全域與專案記憶在每台電腦上都一樣，一次只讓一台處理，避免兩台互相改。')}</span>
              </dd>
              <dt>{t('上次執行')}</dt>
              <dd>
                {lastAt ? relTime(lastAt) : <span class="faint">{t('尚未執行')}</span>}
                {job?.lastResult && lastAt && <span class="faint ap-sub">{local(job.lastResult, 'note')}</span>}
              </dd>
              <dt>{t('下次執行')}</dt>
              <dd>
                {!on ? <span class="faint">—</span> : running ? t('執行中') : job?.nextRunAt ? untilTime(job.nextRunAt) : t('電腦閒置時')}
                {on && <span class="faint ap-sub">{t('電腦閒置 20 分鐘以上才會開始，不會打斷你工作。')}</span>}
              </dd>
            </dl>
            <div class="btn-row">
              <button class="btn primary" disabled={!on || busy} onClick={start}><IconPlay />{busy ? t('執行中…') : t('立即執行')}</button>
              {!on && <span class="faint" style={{ fontSize: 12.5 }}>{t('開啟之後才能執行')}</span>}
            </div>
          </div>
          <div class="ap-budget">
            <Meter value={Math.round(d.budget.used * 100) / 100} max={d.budget.monthly} label={t('這台電腦本月用量（約當 US$）')} />
            <label class="ap-cap">
              <span>{t('每月上限')}</span>
              <select class="select" value={d.budget.monthly} onChange={setCap} aria-label={t('每月用量上限')}>
                {caps.map((n) => <option key={n} value={n}>{t('約當 US$ {n}', { n })}</option>)}
              </select>
            </label>
            <p class="faint ap-sub">{t('用 Claude 訂閱時不另外計費，這是額度消耗的參考。')}</p>
            {d.budget.remaining <= 0 && <p class="ap-over">{t('這個月的額度已用完，下個月會自動繼續。')}</p>}
          </div>
        </div>
      </section>

      {running && (
        <Banner tone="info" title={t('自動駕駛正在執行')}>
          {t('開始於 {when}。結果會陸續出現在下面，這一頁會即時更新。', { when: relTime(running.startedAt) })}
        </Banner>
      )}

      {!runs.length && !running ? (
        <section class="panel ap-empty">
          <Empty icon={IconAutopilot} title={t('還沒有執行過')}
            action={on
              ? <button class="btn primary" disabled={busy} onClick={start}><IconPlay />{t('立即執行第一輪')}</button>
              : <button class="btn primary" onClick={() => tog.request(true)}><IconAutopilot />{t('開啟自動駕駛')}</button>}>
            {t('開啟自動駕駛後，Engram 會先跑第一輪，之後每天在電腦閒置時自動執行。每一輪做了什麼、為什麼這樣做，都會列在這裡，可以逐項復原。')}
          </Empty>
          <div class="panel-body">
            <ol class="steps four" aria-label={t('自動駕駛怎麼運作')}>
              {HOW.map((s) => <li key={s}><b>{t(s)}</b></li>)}
            </ol>
          </div>
        </section>
      ) : (
        <div class="grid split rev">
          <section class="panel ap-runs">
            <div class="panel-head"><h2>{t('執行紀錄')}</h2><span class="sub">{t('新的在前')}</span></div>
            <div class="rows" role="listbox" aria-label={t('執行紀錄')}>
              {runs.map((r) => {
                const line = runLine(r.summary, r.status);
                return (
                  <button class="row" role="option" key={r.id} aria-selected={r.id === selected} onClick={() => pick(r.id)}>
                    <span class="title">{relTime(r.startedAt)}{REASON[r.reason] && <span class="faint ap-reason">{t(REASON[r.reason])}</span>}</span>
                    <span class={`chip ${RUN_TONE[r.status] || ''}`}>{t(RUN_STATUS[r.status] || r.status)}</span>
                    {line && <span class="desc">{line}</span>}
                    <span class="meta">
                      {r.host?.label && <span>{r.host.label}</span>}
                      {r.summary?.costUsd > 0 && <span>{t('約當 US$ {cost}', { cost: usd(r.summary.costUsd) })}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <div id="ap-detail" class="ap-detail-wrap">
            {selected && <RunDetail id={selected} key={selected} go={go} />}
          </div>
        </div>
      )}

      {d.feedback.length > 0 && (
        <details class="panel ap-fold">
          <summary>{t('你復原過的項目（{n}）', { n: d.feedback.length })}</summary>
          <p class="faint ap-fold-note">{t('自動駕駛會記住這些，之後避開類似的處理。同一類在 60 天內被復原 2 次以上，就會暫停這一類。')}</p>
          <div class="ap-reject-list">
            {[...d.feedback].reverse().map((f, i) => (
              <div class="ap-reject" key={i}>
                <div class="head"><span class="chip">{categoryLabel(f.category)}</span><span class="faint">{String(f.at).slice(0, 10)}</span></div>
                <b>{local(f, 'title')}</b>
              </div>
            ))}
          </div>
        </details>
      )}
      {tog.dialog}
    </div>
  );
}

// ───────── 一輪的詳情 ─────────

function RunDetail({ id, go }) {
  const { reportError, toast, refresh } = useApp();
  const run = useData(() => api.autopilotRun(id), [id]);
  const [dialog, setDialog] = useState(null);
  const r = run.data?.id === id ? run.data : null;

  if (!r) {
    if (run.error) {
      const gone = run.error.code === 'E_NOT_FOUND';
      return <div class="panel"><Empty icon={IconAutopilot} title={gone ? t('找不到這一輪的紀錄') : t('讀不到這一輪的紀錄')} action={gone ? null : <button class="btn" onClick={run.reload}>{t('重試')}</button>}>{local(run.error, 'message')}</Empty></div>;
    }
    return <div class="panel"><div class="panel-body"><Skeleton rows={5} /></div></div>;
  }

  const acts = r.actions.map((a, i) => ({ a, i }));
  const shown = acts.filter(({ a }) => a.kind !== 'dismiss');
  const dismissed = acts.filter(({ a }) => a.kind === 'dismiss');
  const groups = TASKS.map((k) => [k, shown.filter(({ a }) => a.task === k)]).filter(([, list]) => list.length);
  const made = (k) => shown.filter(({ a }) => a.task === k && a.status === 'done').length;
  const sum = {
    changes: shown.filter(({ a }) => a.status === 'done').length, dismissed: dismissed.length, rejected: r.rejected.length,
    failed: acts.filter(({ a }) => a.status === 'failed').length,
  };
  const line = countParts(sum).join(t('、'));
  const undoableN = acts.filter(({ a }) => undoable(a)).length;
  const cost = r.summary?.costUsd ?? r.calls.reduce((n, c) => n + (c.costUsd ?? 0), 0);

  const doUndo = async (index) => {
    try {
      const res = await api.autopilotUndo(id, index);
      const ok = res.results.filter((x) => x.ok).length;
      const bad = res.results.filter((x) => !x.ok);
      if (bad.length) reportError({ message: t('有 {n} 項沒有復原成功', { n: bad.length }), hint: bad[0].message || '' });
      if (ok) toast(index === undefined ? t('已復原 {n} 項', { n: ok }) : t('已復原'));
    } catch (e) { reportError(e); }
    setDialog(null);
    refresh();
  };

  return (
    <div class="ap-detail">
      <section class="panel">
        <div class="panel-head">
          <h2>{whenText(r.startedAt)}</h2>
          <span class={`chip ${RUN_TONE[r.status] || ''}`}>{t(RUN_STATUS[r.status] || r.status)}</span>
          <span class="sub">{[REASON[r.reason] && t(REASON[r.reason]), r.host?.label && t('共用記憶由「{label}」處理', { label: r.host.label })].filter(Boolean).join(' · ')}</span>
          {undoableN > 0 && r.status !== 'running' && <div class="end"><button class="btn sm danger" onClick={() => setDialog({ kind: 'all' })}><IconUndo />{t('整輪復原')}</button></div>}
        </div>
        <div class="panel-body ap-detail-body">
          {r.status === 'failed' && <Banner tone="bad" title={t('這一輪沒有完成')}>{local(r.error, 'message') || t('沒有留下原因')}</Banner>}
          {r.status === 'interrupted' && <Banner tone="warn" title={t('這一輪被中斷')}>{t('常駐程式在這一輪還沒結束時被關閉。已經完成的變更仍然有效，也可以復原；其餘的下一輪會再處理。')}</Banner>}
          {r.status === 'running' && <Banner tone="info" title={t('這一輪正在執行')}>{t('結果會陸續出現在這裡。')}</Banner>}
          {line ? <p class="ap-summary">{line}</p> : r.status === 'done' ? <p class="ap-summary">{t('這一輪沒有改動任何記憶')}</p> : null}
          {TASKS.some((k) => made(k) > 0) && (
            <div class="ap-chips" role="group" aria-label={t('各項工作處理的數量')}>
              {TASKS.filter((k) => made(k) > 0).map((k) => <span class="chip" key={k}>{t(TASK[k])} <b>{made(k)}</b></span>)}
            </div>
          )}
          {r.calls.length > 0 && <p class="faint ap-cost">{t('呼叫 Claude {n} 次，用量約當 US$ {cost}', { n: r.calls.length, cost: usd(cost) })}</p>}
          {(r.notes?.length > 0 || r.skipped?.length > 0) && (
            <div class="ap-notes faint">
              <span class="ap-label">{t('備註')}</span>
              <ul>
                {r.notes.map((x, i) => <li key={`n${i}`}>{t('{task}：{note}', { task: taskLabel(x.task), note: local(x, 'note') })}</li>)}
                {r.skipped.map((x, i) => <li key={`s${i}`}>{t('略過 {task}：{why}', { task: taskLabel(x.task), why: local(x, 'why') })}</li>)}
              </ul>
            </div>
          )}
        </div>
      </section>

      {groups.map(([k, list]) => (
        <div class="tidy-group" key={k}>
          <h2>{t(TASK[k])}<span>{t('{n} 項', { n: list.length })}</span></h2>
          <div class="cards">
            {list.map(({ a, i }) => <ActionCard key={i} a={a} go={go} onUndo={() => setDialog({ kind: 'one', index: i, title: local(a, 'title') })} />)}
          </div>
        </div>
      ))}

      {dismissed.length > 0 && (
        <details class="panel ap-fold">
          <summary>{t('判斷不用處理的卡片（{n}）', { n: dismissed.length })}</summary>
          <p class="faint ap-fold-note">{t('AI 看過這些收件匣卡片，認為不需要動，所以只把卡片關掉，沒有改任何記憶。')}</p>
          <div class="ap-reject-list">
            {dismissed.map(({ a, i }) => <div class="ap-reject" key={i}><b>{local(a, 'title')}</b>{a.reason && <p class="why">{local(a, 'reason')}</p>}</div>)}
          </div>
        </details>
      )}

      {r.rejected.length > 0 && (
        <details class="panel ap-fold">
          <summary>{t('沒有執行的建議（{n}）', { n: r.rejected.length })}</summary>
          <p class="faint ap-fold-note">{t('AI 提出了這些建議，但審核員或安全規則沒有放行，所以什麼都沒有改。')}</p>
          <div class="ap-reject-list">
            {r.rejected.map((x, i) => {
              const scope = scopeOf(x);
              return (
                <div class="ap-reject" key={i}>
                  <div class="head">
                    <span class="chip">{taskLabel(x.task)}</span>
                    {scope && <ScopeLabel scope={scope} />}
                    {x.risk && <span class={`sev-chip ${x.risk}`}>{t(RISK_LABEL[x.risk])}</span>}
                    {x.deferred && <span class="chip warn">{t('下一輪再處理')}</span>}
                  </div>
                  <b>{local(x, 'title')}</b>
                  <p class="why">{local(x, 'why')}</p>
                  {x.reason && <p class="faint">{t('AI 原本的理由：{reason}', { reason: local(x, 'reason') })}</p>}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {dialog?.kind === 'one' && (
        <ConfirmDialog title={t('復原「{name}」？', { name: dialog.title })} desc={t('把這一項改回原本的樣子。之後若又改過同一筆記憶，可能無法自動復原。同一類處理被復原 2 次以上，自動駕駛就會暫停這一類。')} confirmLabel={t('復原')}
          onConfirm={() => doUndo(dialog.index)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'all' && (
        <ConfirmDialog title={t('整輪復原？')} desc={t('依相反順序復原這一輪還沒復原的 {n} 項變更。沒有備份可以復原的項目不受影響。', { n: undoableN })} danger confirmLabel={t('整輪復原')}
          onConfirm={() => doUndo(undefined)} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function ActionCard({ a, go, onUndo }) {
  const scope = scopeOf(a);
  const canUndo = undoable(a);
  const message = local(a, 'message');
  const reason = local(a, 'reason');
  const chipText = a.kind === 'tidy' ? t(ACTION[a.action] || N_('整理')) : t(KIND[a.kind] || N_('整理'));
  return (
    <article class={`card ap-action${a.undone ? ' undone' : ''}${a.status === 'failed' ? ' failed' : ''}`}>
      <header>
        <span class={`act-chip ${a.kind === 'tidy' ? a.action || '' : ''}`}>{chipText}</span>
        <h3>{local(a, 'title')}</h3>
        {scope && <ScopeLabel scope={scope} />}
        {a.risk && <span class={`sev-chip ${a.risk}`}>{t(RISK_LABEL[a.risk])}</span>}
        {a.status === 'failed' && <span class="chip danger">{t('失敗')}</span>}
        {a.undone && <span class="chip">{t('已復原 · {when}', { when: relTime(a.undone) })}</span>}
      </header>
      {reason && <p class="ap-reason-text">{reason}</p>}
      <ReviewLine review={a.review} />
      {message && <p class="ap-msg">{message}</p>}
      {(canUndo || (a.kind === 'tidy' && a.record) || (a.status === 'done' && !a.undone && !canUndo)) && (
        <footer>
          {a.kind === 'tidy' && a.record && (
            <a class="btn sm" href={`#/tidy?id=${a.record}`} onClick={(e) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); go('tidy', { id: a.record }); } }}>
              {t('看完整差異')}<IconChevronRight />
            </a>
          )}
          {canUndo && <button class="btn sm" onClick={onUndo}><IconUndo />{t('復原')}</button>}
          {a.status === 'done' && !a.undone && !canUndo && <span class="faint ap-sub">{t('這一項沒有可以自動復原的內容')}</span>}
        </footer>
      )}
    </article>
  );
}
