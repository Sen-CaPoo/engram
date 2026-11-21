// 自動駕駛（1.5.0）：開關與用量、每一輪做了什麼與為什麼、逐項或整輪復原。
// 開啟後，常駐程式每天在電腦閒置時讓 AI（claude -p）整理記憶、處理收件匣、回顧對話；每一項變更先備份、經審核員檢查，
// 這一頁看得到全部過程，也都能復原。這一頁不呼叫 AI，只讀取常駐程式寫下的執行紀錄。
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { Banner, ConfirmDialog, Empty, ErrorBanner, Meter, ReviewLine, ScopeLabel, Skeleton, useAction, useApp, useData } from '../components.jsx';
import { t, N_, local, locale } from '../i18n.js';
import { IconAutopilot, IconCheck, IconChevronRight, IconPlay, IconUndo } from '../icons.jsx';
import { latestStop, parseScopeKey, relTime, untilTime, RISK_LABEL, TYPE_LABEL } from '../util.js';

// 顯示順序：整理、對話回顧、記憶畢業、保留區重審、收件匣、同步衝突、金鑰、待你確認
const TASKS = ['curate', 'dream', 'graduate', 'holding', 'cards', 'conflicts', 'secrets', 'review'];
const TASK = { curate: N_('整理'), dream: N_('對話回顧'), graduate: N_('記憶畢業'), cards: N_('收件匣'), conflicts: N_('同步衝突'), secrets: N_('金鑰'), review: N_('待你確認'), holding: N_('保留區重審'), other: N_('ap::其他') };
// 記憶畢業的去向（2.0.0 WP9）：原記憶內文不動，只記下去向
export const GRADUATE_TO = { core: N_('成為核心準則的一行'), guardrail: N_('成為一條護欄規則'), env: N_('成為環境設定'), archive: N_('一次性的進度，已封存') };
const REASON = { schedule: N_('自動執行'), coalesced: N_('自動執行'), manual: N_('手動執行'), enable: N_('剛開啟時') };
const RUN_STATUS = { running: N_('執行中'), done: N_('已完成'), failed: N_('失敗'), interrupted: N_('中斷') };
const RUN_TONE = { running: 'brand live', done: 'ok', failed: 'danger', interrupted: 'warn' };
/** 每月上限的常用金額（1.6.0 預設 US$200；也可以自訂 1～1000） */
const PRESET_CAPS = [50, 100, 200, 500];
// 整理項目的動作（與記憶整理頁相同的詞）與其他種類的處理
const ACTION = { update: N_('改寫'), move: N_('搬移'), archive: N_('封存'), merge: N_('合併'), create: N_('新增'), split: N_('拆分'), promote: N_('升為全域'), verify: N_('確認仍正確'), keep: N_('保留') };
const KIND = { card: N_('處理卡片'), rename: N_('資料夾改名'), conflict: N_('同步衝突'), vault: N_('金鑰移到保管區'), 'not-secret': N_('標記不是金鑰'), confirm: N_('代你確認'), revert: N_('退回'), dismiss: N_('不處理'), graduate: N_('記憶畢業') };
// 被復原次數統計用的類別（暫停與你復原過的項目；與 app/src/autopilot/run.mjs 的 CATEGORY_LABEL 對應）
const CATEGORY = { ...ACTION, core: N_('核心準則'), 'dream-create': N_('對話回顧新增'), 'dream-update': N_('對話回顧改寫'), confirm: N_('代你確認'), revert: N_('退回'), vault: N_('金鑰移到保管區'), 'not-secret': N_('標記不是金鑰'), rename: N_('撞名資料夾改名'), guardrail: N_('畢業成護欄規則'), env: N_('畢業成環境設定') };
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
const undoable = (a) => a.status === 'done' && !a.undone && (a.kind === 'tidy' || a.undo?.length > 0 || (a.kind === 'rename' && !!a.renameId) || (a.kind === 'not-secret' && a.allowHashes?.length > 0) || (a.kind === 'vault' && a.vaultNames?.length > 0) || (a.kind === 'graduate' && !!a.graduate?.to));
const scopeOf = (x) => (x.scope ? parseScopeKey(x.scope) : x.pid ? { kind: 'project', pid: x.pid } : null);
const whenText = (at) => new Date(at).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 這一輪的數字：處理幾項、幾張卡片不用處理、幾項建議沒有執行、幾項失敗 */
function countParts(s) {
  const parts = [];
  if (s.changes) parts.push(t('處理 {n} 項', { n: s.changes }));
  if (s.dismissed) parts.push(t('{n} 張卡片判斷不用處理', { n: s.dismissed }));
  if (s.rejected) parts.push(t('{n} 項建議沒有執行', { n: s.rejected }));
  if (s.held) parts.push(t('{n} 項存進保留區', { n: s.held }));
  if (s.failed) parts.push(t('{n} 項失敗', { n: s.failed }));
  return parts;
}

/**
 * 頁面上方的提示：用量上限還沒重置（GET /api/autopilot 的 limit，任何一台電腦撞到都算）時說明幾點之後自動繼續；
 * 否則看最近一輪是不是因為登入到期或 Claude 暫時忙碌而提前停止（登入到期要說清楚怎麼重新登入）
 */
function StopBanner({ stop, limit, labelOf }) {
  let limitBanner = null;
  if (limit?.resetAt) {
    const at = new Date(limit.resetAt);
    const time = at.toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const who = labelOf(limit.machine);
    limitBanner = (
      <Banner tone="warn" title={t('碰到 Claude 的用量上限，{time} 之後自動繼續', { time })}>
        {t('{who}的自動駕駛用完了 Claude 訂閱的用量額度（例如 5 小時的上限）。重置之前，每台電腦的自動駕駛都不會自動開始；到了 {time} 會自動繼續，你不需要做任何事。', { who: who ? t('「{label}」', { label: who }) : t('其中一台電腦'), time })}
      </Banner>
    );
  }
  const when = stop ? relTime(stop.run.startedAt) : '';
  // 登入到期要使用者處理：用量上限的橫幅在時也照樣顯示；暫時忙碌不用處理，用量上限的橫幅在時不另外顯示
  const stopBanner = stop?.reason === 'auth' ? (
    <Banner tone="bad" title={t('自動駕駛停下來了：Claude Code 的登入已到期')}>
      {t('最近一輪（{when}）沒辦法讓 AI 判斷，所以提前停止，沒有改任何記憶。請重新登入：在終端機執行 {cli}，或在 Claude Code 裡輸入 {slash}。登入之後，下一輪會接著處理，也可以直接按「立即執行」。', { when, cli: <code>claude auth login</code>, slash: <code>/login</code> })}
    </Banner>
  ) : stop?.reason === 'busy' && !limitBanner ? (
    <Banner tone="info" title={t('最近一輪因為 Claude 暫時忙碌而提前停止')}>
      {t('最近一輪（{when}）遇到 Claude 過載或速率限制，先停下來，之後會自動再試，你不需要做任何事。', { when })}
    </Banner>
  ) : null;
  if (!limitBanner && !stopBanner) return null;
  return <>{limitBanner}{stopBanner}</>;
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
      <p class="muted" style={{ fontSize: 13 }}>{t('每月用量上限約當 US$ {n}。用 Claude 訂閱時不另外計費，這是額度消耗的參考。', { n: monthly ?? 200 })}</p>
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
  const { toast, reportError, refresh, status } = useApp();
  const ap = useData(() => api.autopilot(), []);
  const agent = useData(() => api.agent(), []);
  const act = useAction();
  const tog = useAutopilotToggle(ap.data?.enabled, ap.data?.budget?.monthly);
  const [sel, setSel] = useState(params?.id || null);
  const [starting, setStarting] = useState(false);
  // 自訂每月上限：null＝沒有在輸入；字串＝輸入框目前的值
  const [custom, setCustom] = useState(null);
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
  const caps = [...new Set([...PRESET_CAPS, d.budget.monthly])].sort((a, b) => a - b);
  const capValue = Number(custom);
  const capOk = custom !== null && String(custom).trim() !== '' && Number.isFinite(capValue) && capValue >= 1 && capValue <= 1000;

  const start = async () => {
    setStarting(true);
    try {
      await api.autopilotStart();
      toast(t('已開始執行自動駕駛'));
      setTimeout(() => { setStarting(false); refresh(); }, 1500);
    } catch (e) { setStarting(false); reportError(e); }
  };
  const setCap = (e) => {
    const v = e.currentTarget.value;
    if (v === 'custom') { setCustom(String(d.budget.monthly)); return; }
    setCustom(null);
    act(() => api.saveSettings({ autopilotBudget: Number(v) }), t('已更新每月用量上限'));
  };
  const saveCustom = async () => {
    if (!capOk) return;
    const res = await act(() => api.saveSettings({ autopilotBudget: Math.round(capValue * 100) / 100 }), t('已更新每月用量上限'));
    if (res) setCustom(null);
  };
  const pick = (id) => {
    setSel(id);
    // 窄螢幕的清單與內容上下排列：選了之後捲到內容
    if (window.matchMedia?.('(max-width: 1000px)').matches) setTimeout(() => document.getElementById('ap-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const busy = !!running || starting;

  return (
    <div class="page">
      <ErrorBanner error={ap.error} onRetry={ap.reload} />
      {!running && <StopBanner stop={latestStop(runs)} limit={d.limit} labelOf={(mid) => d.machines?.find((x) => x.mid === mid)?.label ?? status?.devices?.find((x) => x.id === mid)?.label} />}
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
              <dt>{t('開啟自動駕駛的電腦')}</dt>
              <dd>
                {d.machines?.length
                  ? <span class="ap-host">{d.machines.map((x) => <span key={x.mid} class="ap-machine">{x.label}{x.self && <span class="chip brand">{t('這台')}</span>}</span>)}</span>
                  : <span class="faint">{t('還沒有電腦開啟自動駕駛')}</span>}
                <span class="faint ap-sub">{t('每台電腦都一樣，都會整理全域、核心準則與專案記憶；一台整理過的版本，其他台不會重複處理。')}</span>
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
              <select class="select" value={custom !== null ? 'custom' : d.budget.monthly} onChange={setCap} aria-label={t('每月用量上限')}>
                {caps.map((n) => <option key={n} value={n}>{t('約當 US$ {n}', { n })}</option>)}
                <option value="custom">{t('自訂金額…')}</option>
              </select>
            </label>
            {custom !== null && (
              <form class="ap-cap-custom" noValidate onSubmit={(e) => { e.preventDefault(); saveCustom(); }}>
                <span>US$</span>
                <input class="input" type="number" min="1" max="1000" step="any" inputMode="decimal" value={custom} onInput={(e) => setCustom(e.currentTarget.value)} aria-label={t('自訂每月上限（US$）')} autoFocus />
                <button class="btn sm primary" type="submit" disabled={!capOk}>{t('儲存')}</button>
                <button class="btn sm ghost" type="button" onClick={() => setCustom(null)}>{t('取消')}</button>
                {!capOk && <span class="ap-over">{t('請輸入 1 到 1000 之間的金額')}</span>}
              </form>
            )}
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

      <PreferencesPanel focus={params?.focus === 'prefs'} />

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

// ───────── 自動駕駛遵守的偏好 ─────────

// 偏好的確認來源（GET /api/autopilot/preferences）：used 是採用的、pending 是還沒採用的
const USED_SOURCE = {
  user: N_('你確認過'), baseline: N_('安裝時的起點'), off: N_('確認寫入已關閉，直接採用'), 'no-baseline': N_('還沒有起點，直接採用目前的內容'),
};
const PENDING_SOURCE = {
  claude: N_('Claude 在對話裡寫入時標成已確認，但不是你本人確認的'), request: N_('對話裡找到你的要求，但還沒有你本人的確認'),
  autopilot: N_('只有自動駕駛代為確認過'), none: N_('還沒有人確認過'),
};
const TYPE_TEXT = { core: N_('核心準則'), feedback: N_('回饋'), user: N_('使用者') };
// 記憶畢業判斷適合、正在等你確認的去向（graduation）：core＝核心準則的一行、guardrail＝一條護欄規則（只提醒，不擋下）
const GRAD_CHIP = { core: N_('可寫進核心準則'), guardrail: N_('可成為護欄規則') };
const GRAD_HINT = { core: N_('記憶畢業判斷這筆適合寫進核心準則，正在等你確認'), guardrail: N_('記憶畢業判斷這筆適合成為一條護欄規則（只在送出相關指令時提醒，不會擋下），正在等你確認') };
function GraduationChip({ g }) {
  return GRAD_CHIP[g] ? <span class="chip brand env-self" title={t(GRAD_HINT[g])}>{t(GRAD_CHIP[g])}</span> : null;
}

/**
 * 自動駕駛判斷時會遵守的偏好（核心準則與你確認過的全域回饋、使用者記憶），以及還沒採用的項目。
 * 只有你本人確認過的內容與安裝時的起點會被當成規則；其餘的按「這是我的偏好」（走待你確認的確認）。
 */
function PreferencesPanel({ focus }) {
  const p = useData(() => api.autopilotPreferences(), []);
  // 從每週摘要的「還沒採用的偏好」過來：偏好載入後捲到這一區（等上方的執行紀錄也排好版）
  const ready = p.data !== undefined;
  useEffect(() => {
    if (!focus || !ready) return undefined;
    const timer = setTimeout(() => document.getElementById('ap-prefs')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 500);
    return () => clearTimeout(timer);
  }, [focus, ready]);
  const act = useAction();
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(() => new Set());
  // 要看全文的候選（ref）
  const [open, setOpen] = useState(() => new Set());
  const toggle = (ref) => setOpen((s) => { const n = new Set(s); if (n.has(ref)) n.delete(ref); else n.add(ref); return n; });
  // 候選只是確認內容，不是採用成偏好：提示文字分開
  const confirm = async (items, { candidates = false } = {}) => {
    setErr(null);
    try {
      const r = await act(() => api.reviewConfirm(items.map((x) => ({ ref: x.ref, sha: x.sha }))), (res) => (res?.confirmed?.length ? (candidates ? t('已確認 {n} 筆', { n: res.confirmed.length }) : t('已採用 {n} 筆偏好', { n: res.confirmed.length })) : null), { rethrow: true });
      setDone((s) => new Set([...s, ...(r?.confirmed || [])]));
      if (r?.stale?.length) setErr({ message: t('{n} 筆在你看過之後又被修改，請重新看過', { n: r.stale.length }) });
    } catch (e) { setErr(e); }
  };
  const head = (sub, end) => <div class="panel-head"><h2>{t('自動駕駛遵守的偏好')}</h2>{sub && <span class="sub">{sub}</span>}{end && <div class="end">{end}</div>}</div>;
  if (p.data === undefined) {
    return <section class="panel" id="ap-prefs">{head()}<div class="panel-body">{p.error ? <ErrorBanner error={p.error} onRetry={p.reload} /> : <Skeleton rows={2} />}</div></section>;
  }
  if (p.data === null) {
    return (
      <section class="panel" id="ap-prefs">{head()}
        <div class="panel-body"><p class="faint">{t('這個版本的常駐程式還不能列出自動駕駛遵守的偏好。更新 Engram 之後，這裡會列出它判斷時會遵守的規則，以及還沒採用的項目。')}</p></div>
      </section>
    );
  }
  const used = p.data.used || [];
  const pending = (p.data.pending || []).filter((x) => !done.has(x.ref));
  const cands = (p.data.candidates || []).filter((x) => !done.has(x.ref));
  return (
    <section class="panel ap-prefs" id="ap-prefs">
      {head(t('遵守 {a} 筆、還沒採用 {b} 筆', { a: used.length, b: pending.length }), pending.length > 1 ? <button class="btn sm primary" onClick={() => confirm(pending)}><IconCheck />{t('全部確認（{n}）', { n: pending.length })}</button> : null)}
      <div class="panel-body ap-prefs-body">
        <p class="faint ap-fold-note">{t('自動駕駛判斷時會遵守核心準則，以及全域的「回饋」與「使用者」記憶，但只採用你本人確認過的內容與安裝時的起點。Claude 在對話裡寫的、自動駕駛代為確認的，都不會被當成你的規則，所以列在「還沒採用」；確實是你的偏好就按「這是我的偏好」。')}</p>
        <ErrorBanner error={err} onDismiss={err ? () => setErr(null) : undefined} />
        {pending.length > 0 && (
          <div class="ap-prefs-group">
            <b>{t('還沒採用')}</b>
            <ul class="env-list">
              {pending.map((x) => (
                <li key={x.ref} class="env-wait-item">
                  <span>
                    <b>{x.name}</b>{TYPE_TEXT[x.type] && <span class="chip env-self">{t(TYPE_TEXT[x.type])}</span>}<GraduationChip g={x.graduation} />{x.description && <span class="muted">　{local(x, 'description')}</span>}
                    {PENDING_SOURCE[x.source] && <span class="faint ap-pref-src">{t(PENDING_SOURCE[x.source])}</span>}
                  </span>
                  <button class="btn sm" onClick={() => confirm([x])} aria-label={t('這是我的偏好：{name}', { name: x.name })}><IconCheck />{t('這是我的偏好')}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {cands.length > 0 && (
          <div class="ap-prefs-group" id="ap-cands">
            <div class="ap-cands-head">
              <b>{t('常用、但還沒由你確認的記憶')}</b>
              {cands.length > 1 && <button class="btn sm" onClick={() => confirm(cands, { candidates: true })}><IconCheck />{t('全部確認（{n}）', { n: cands.length })}</button>}
            </div>
            <p class="faint ap-fold-note">{t('這些記憶近 90 天常被讀到，但目前的內容還沒由你本人確認。確認之後，自動駕駛的「記憶畢業」才有可能把它寫進核心準則或成為護欄規則；確認不會改動記憶的內容。')}</p>
            <p class="faint ap-fold-note">{t('標了「可寫進核心準則」或「可成為護欄規則」的，是記憶畢業已經判斷適合、正在等你確認；確認之後，下一次記憶畢業會重新判斷。')}</p>
            <ul class="env-list">
              {cands.map((x) => (
                <li key={x.ref} class="env-wait-item">
                  <span>
                    <b>{x.name}</b><span class="chip env-self">{TYPE_LABEL[x.type] ? t(TYPE_LABEL[x.type]) : x.type}</span><span class="chip env-self">{x.scope === 'machine' ? t('單機') : t('全域')}</span><GraduationChip g={x.graduation} />{x.description && <span class="muted">　{local(x, 'description')}</span>}
                    <span class="faint ap-pref-src">{PENDING_SOURCE[x.source] ? t(PENDING_SOURCE[x.source]) : x.source}</span>
                    <span class="faint ap-pref-src">{t('近 90 天讀取 {a} 次、情境召回帶出 {b} 次', { a: x.reads ?? 0, b: x.recalled ?? 0 })}</span>
                  </span>
                  <span class="ap-cand-act">
                    <button class="btn sm ghost" aria-expanded={open.has(x.ref) ? 'true' : 'false'} onClick={() => toggle(x.ref)}>{open.has(x.ref) ? t('收合全文') : t('看全文')}</button>
                    <button class="btn sm" onClick={() => confirm([x], { candidates: true })} aria-label={t('確認：{name}', { name: x.name })}><IconCheck />{t('確認')}</button>
                  </span>
                  {open.has(x.ref) && <CandidateFull target={x.ref} />}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div class="ap-prefs-group">
          <b>{t('判斷時會遵守')}</b>
          {used.length === 0 ? <p class="faint">{t('還沒有確認過的偏好。')}</p> : (
            <ul class="env-list">
              {used.map((x) => (
                <li key={x.ref || x.name}>
                  <b>{x.name}</b>{TYPE_TEXT[x.type] && <span class="chip env-self">{t(TYPE_TEXT[x.type])}</span>}{x.description && <span class="muted">　{local(x, 'description')}</span>}
                  <span class="faint ap-pref-src">
                    {USED_SOURCE[x.source] ? t(USED_SOURCE[x.source]) : x.source}
                    {x.version === 'previous' && t('；採用的是你上次確認的版本，目前的內容還沒確認')}
                    {x.omitted && t('；放不進偏好區塊（超過字數上限），這次沒有帶給自動駕駛')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** 候選記憶的全文（點「看全文」才讀取） */
function CandidateFull({ target }) {
  const m = useData(() => api.memory(target), [target]);
  if (!m.data) return <div class="ap-cand-full">{m.error ? <ErrorBanner error={m.error} onRetry={m.reload} /> : <Skeleton rows={3} />}</div>;
  return <div class="ap-cand-full"><pre class="diff">{m.data.raw ?? m.data.body}</pre></div>;
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
    failed: acts.filter(({ a }) => a.status === 'failed').length, held: r.summary?.held ?? r.held?.length ?? 0,
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
          {REASON[r.reason] && <span class="sub">{t(REASON[r.reason])}</span>}
          {undoableN > 0 && r.status !== 'running' && <div class="end"><button class="btn sm danger" onClick={() => setDialog({ kind: 'all' })}><IconUndo />{t('整輪復原')}</button></div>}
        </div>
        <div class="panel-body ap-detail-body">
          {r.status === 'failed' && <Banner tone="bad" title={t('這一輪沒有完成')}>{local(r.error, 'message') || t('沒有留下原因')}</Banner>}
          {r.status === 'interrupted' && <Banner tone="warn" title={t('這一輪被中斷')}>{t('常駐程式在這一輪還沒結束時被關閉。已經完成的變更仍然有效，也可以復原；其餘的下一輪會再處理。')}</Banner>}
          {r.status === 'running' && <Banner tone="info" title={t('這一輪正在執行')}>{t('結果會陸續出現在這裡。')}</Banner>}
          {line ? <p class="ap-summary">{line}</p> : r.status === 'done' ? <p class="ap-summary">{t('這一輪沒有改動任何記憶')}</p> : null}
          {sum.held > 0 && (
            <p class="ap-held">
              <span>{t('沒有執行的建議連同內容與證據存進了保留區，你可以看過之後決定要不要採用。')}</span>
              <button class="btn sm" onClick={() => go('holding')}>{t('到保留區看')}<IconChevronRight /></button>
            </p>
          )}
          {TASKS.some((k) => made(k) > 0) && (
            <div class="ap-chips" role="group" aria-label={t('各項工作處理的數量')}>
              {TASKS.filter((k) => made(k) > 0).map((k) => <span class="chip" key={k}>{t(TASK[k])} <b>{made(k)}</b></span>)}
            </div>
          )}
          {r.calls.length > 0 && <p class="faint ap-cost">{t('呼叫 Claude {n} 次，用量約當 US$ {cost}', { n: r.calls.length, cost: usd(cost) })}</p>}
          {r.summary?.callsByTask && Object.keys(r.summary.callsByTask).length > 1 && (
            <p class="faint ap-cost">{Object.entries(r.summary.callsByTask).map(([k, v]) => t('{task} {n} 次（US$ {cost}）', { task: taskLabel(k), n: v.calls, cost: usd(v.costUsd) })).join(t('、'))}</p>
          )}
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
                    {x.dismissed && <span class="chip">{t('你標成不需要過')}</span>}
                    {x.grounded && <span class="chip ok">{t('核心事實有依據')}</span>}
                  </div>
                  <b>{local(x, 'title')}</b>
                  <p class="why">{x.dismissed ? t('你之前在保留區把同一個提案標成「不需要」（90 天內），所以這次直接略過，沒有再送審。') : local(x, 'why')}</p>
                  {x.grounded && x.keep?.length > 0 && <p class="faint">{t('有依據的部分：{list}', { list: x.keep.join(t('；')) })}</p>}
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

/**
 * 記憶畢業寫進去的內容（執行紀錄的 graduate 與保留區項目的 graduate 共用）：核心準則的那一行、護欄規則（ruleId 或完整規則）、環境設定的鍵與值。
 * 原記憶內文不動，只在 frontmatter 記下去向。
 */
export function GraduateWhat({ g }) {
  const rule = g.rule;
  return (
    <dl class="kv ap-grad">
      <dt>{t('原本的記憶')}</dt><dd><code>{g.ref}</code><span class="faint">　{t('（內文不動，只記下畢業的去向）')}</span></dd>
      {g.to === 'core' && g.line && <><dt>{t('加進核心準則的一行')}</dt><dd>{g.line}</dd></>}
      {g.to === 'guardrail' && rule && (
        <>
          <dt>{t('比對樣式')}</dt><dd><code class="env-val">{rule.pattern}</code>{rule.tool ? <span class="faint">　{rule.tool === '*' ? 'Bash / PowerShell' : rule.tool}</span> : null}</dd>
          {rule.unless && <><dt>{t('例外')}</dt><dd><code class="env-val">{rule.unless}</code></dd></>}
          <dt>{t('提醒 Claude 的訊息')}</dt><dd>{rule.message}</dd>
        </>
      )}
      {g.to === 'guardrail' && !rule && g.ruleId && <><dt>{t('護欄規則')}</dt><dd><code>{g.ruleId}</code><span class="faint">　{t('（只提醒，不擋下）')}</span></dd></>}
      {g.to === 'env' && g.env && <><dt>{g.env.area === 'setting' ? t('envarea::設定') : t('envarea::環境變數')}</dt><dd><code>{g.env.key}</code> = <code class="env-val">{String(g.env.value)}</code><span class="faint">　{t('（每台電腦核可之後才會套用）')}</span></dd></>}
    </dl>
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
      {(a.confirmed || a.matchedRequest || a.disputed || (a.kind === 'graduate' && a.to)) && (
        <div class="hd-chips">
          {a.kind === 'graduate' && GRADUATE_TO[a.to] && <span class="chip brand">{t(GRADUATE_TO[a.to])}</span>}
          {a.confirmed && <span class="chip ok" title={t('寫進每次都會載入的範圍、審核員也同意，所以直接記為確認過，不會再出現在「待你確認」。')}>{t('已記為確認過')}</span>}
          {a.matchedRequest && <span class="chip ok" title={t('Claude 寫入的內容和你在那場對話裡的要求相符，所以不需要再審一次。')}>{t('和你在對話裡的要求相符')}</span>}
          {a.disputed && <span class="chip warn" title={t('判斷的 AI 認為內容和你在對話裡的要求不符，審核員也同意，所以退回。')}>{t('和你的要求不符')}</span>}
        </div>
      )}
      {reason && <p class="ap-reason-text">{reason}</p>}
      {a.kind === 'graduate' && a.graduate && <GraduateWhat g={a.graduate} />}
      <ReviewLine review={a.review} />
      {message && <p class="ap-msg">{message}</p>}
      {(canUndo || (a.kind === 'tidy' && a.record) || a.holding || (a.status === 'done' && !a.undone && !canUndo)) && (
        <footer>
          {a.holding && <button class="btn sm" onClick={() => go('holding')}>{t('到保留區看')}<IconChevronRight /></button>}
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
