// 記憶整理（1.3.0）：選範圍、寫補充說明 → 產生給 Claude 的指令；Claude 分析後把建議存成整理記錄，
// 使用者在這裡逐項決定（自動儲存）→ 產生執行指令 → Claude 照決定執行 → 同一頁看結果、逐項復原。
// Engram 本身不呼叫 AI：分析與「依備註調整」由使用者自己的 Claude Code 做；照核可內容執行由 engram tidy apply 做。
import { h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { CopyBox, PluginState } from '../askclaude.jsx';
import { Banner, ConfirmDialog, Dialog, drafts, Empty, ErrorBanner, ScopeLabel, Skeleton, TypeLabel, useApp, useData, useDirty, When } from '../components.jsx';
import { t, N_, local } from '../i18n.js';
import { IconArchive, IconBack, IconCheck, IconChevronRight, IconCore, IconEdit, IconFile, IconMerge, IconMove, IconPlus, IconSparkle, IconTidy, IconTrash, IconUndo } from '../icons.jsx';
import { createSaveQueue } from '../savequeue.js';
import { lineDiff, parseScopeKey, relTime } from '../util.js';

const STATUS = { pending: N_('待你決定'), ready: N_('待 Claude 執行'), applying: N_('執行中'), finishing: N_('Claude 處理備註項目中'), done: N_('已完成') };
const STATUS_TONE = { pending: 'warn', ready: 'brand', applying: 'brand', finishing: 'brand', done: 'ok' };
const ACTION = { keep: N_('保留'), update: N_('改寫'), move: N_('搬移'), archive: N_('封存'), merge: N_('合併'), create: N_('新增'), split: N_('拆分'), promote: N_('升為全域') };
const DECISION = { accept: N_('採用建議'), keep: N_('維持原狀'), archive: N_('封存'), custom: N_('依備註調整') };
const RESULT = { done: N_('已完成'), kept: N_('維持原狀'), failed: N_('失敗'), skipped: N_('略過'), 'needs-claude': N_('等 Claude 處理'), undone: N_('已復原') };
const SCOPES = [
  { key: 'global', label: N_('全域') },
  { key: 'machine', label: N_('單機（這台）') },
  { key: 'project', label: N_('專案') },
  { key: 'core', label: N_('核心準則') },
  { key: 'all', label: N_('全部記憶') },
];
const EDITABLE = new Set(['pending', 'ready']);
const NOTE_MAX = 4000; // 與 app/src/tidy/store.mjs 相同
const CORE_REF = 'core/CORE.md';

/** 這一項可以選的決定（與 app/src/tidy/store.mjs 的 allowedDecisions 一致） */
function allowedDecisions(it) {
  const list = it.action === 'keep' ? ['keep', 'archive', 'custom'] : ['accept', 'keep', 'archive', 'custom'];
  return it.ref && it.ref !== CORE_REF ? list : list.filter((d) => d !== 'archive');
}
const suggestedOf = (it) => (it.action === 'keep' ? 'keep' : 'accept');

export function Tidy({ params }) {
  return params.id ? <TidyRecord id={params.id} key={params.id} /> : <TidyHome preset={params.scope} />;
}

/** 整理範圍的標籤：global、machine:<mid>、project:<pid>、core、all 或單筆記憶的 ref */
function ScopeText({ value }) {
  if (value === 'core') return <span class="scope global"><IconCore /><span>{t('核心準則')}</span></span>;
  if (value === 'all') return <span class="scope global"><IconTidy /><span>{t('全部記憶')}</span></span>;
  if (value === 'global' || /^(project|machine):/.test(String(value))) return <ScopeLabel scope={parseScopeKey(value)} />;
  return <span class="scope global"><IconFile /><code>{String(value).split('/').pop()}</code></span>;
}

// ───────── 首頁：開始新的整理＋整理記錄 ─────────

function presetOf(preset) {
  if (!preset) return { kind: 'global' };
  if (['global', 'machine', 'core', 'all'].includes(preset)) return { kind: preset };
  if (preset.startsWith('project:')) return { kind: 'project', pid: preset.slice(8) };
  return { kind: 'memory', ref: preset };
}

function TidyHome({ preset }) {
  const { status, projects, go } = useApp();
  const list = useData(() => api.tidyList(), []);
  const plugin = useData(() => api.claudePlugin(), []);
  const init = presetOf(preset);
  const [kind, setKind] = useState(init.kind);
  const [pid, setPid] = useState(init.pid || '');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const live = useMemo(() => (projects || []).filter((p) => !p.archived && p.counts.memories > 0).sort((a, b) => b.counts.memories - a.counts.memories), [projects]);
  useEffect(() => { if (kind === 'project' && !pid && live[0]) setPid(live[0].pid); }, [kind, live]);
  useEffect(() => setCopied(false), [kind, pid, note]);

  const arg = kind === 'project' ? (pid ? `project:${pid}` : '') : kind === 'memory' ? init.ref : kind;
  const extra = note.trim().replace(/\s*\n+\s*/g, ' ');
  const command = arg ? `/engram:tidy ${arg}${extra ? ` ${extra}` : ''}` : '';
  const c = status?.counts;
  const size = kind === 'global' ? c?.global : kind === 'machine' ? c?.machine : kind === 'all' ? c?.total : kind === 'project' ? live.find((p) => p.pid === pid)?.counts.memories : null;
  const copy = async () => { try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); } };
  const records = list.data || [];
  const waiting = records.filter((r) => r.status === 'pending');

  return (
    <div class="page">
      <ol class="steps four" aria-label={t('記憶整理的流程')}>
        {[N_('選範圍，複製指令'), N_('貼給 Claude Code 分析'), N_('回到這裡逐項決定'), N_('Claude 照你的決定執行')].map((s) => <li key={s}><b>{t(s)}</b></li>)}
      </ol>

      {waiting.length > 0 && (
        <Banner tone="warn" title={t('有 {n} 份整理記錄等你決定', { n: waiting.length })} actions={<button class="btn sm primary" onClick={() => go('tidy', { id: waiting[0].id })}>{t('開始決定')}<IconChevronRight /></button>}>
          {t('Claude 已經看過記憶並提出建議，每一項都要你決定之後才會執行。')}
        </Banner>
      )}

      <div class="grid split">
        <section class="panel">
          <div class="panel-head"><h2>{t('請 Claude 整理記憶')}</h2></div>
          <div class="panel-body tidy-start">
            <p class="muted" style={{ fontSize: 13 }}>{t('Claude 會讀過這個範圍的記憶，找出重複、過時、互相矛盾、放錯範圍與說明不清楚的內容，提出整理建議。分析時不會改動任何記憶。')}</p>
            <div class="field">
              <span class="field-label" id="tidy-scope-label">{t('整理範圍')}</span>
              <div class="scope-pick">
                <div class="seg" role="group" aria-labelledby="tidy-scope-label">
                  {SCOPES.map((s) => <button key={s.key} aria-pressed={kind === s.key} onClick={() => setKind(s.key)}>{t(s.label)}</button>)}
                  {init.kind === 'memory' && <button aria-pressed={kind === 'memory'} onClick={() => setKind('memory')}>{t('這一筆')}</button>}
                </div>
                {kind === 'project' && (
                  <select class="select" value={pid} onChange={(e) => setPid(e.currentTarget.value)} aria-label={t('選擇專案')}>
                    {!live.length && <option value="">{t('沒有含記憶的專案')}</option>}
                    {live.map((p) => <option key={p.pid} value={p.pid}>{t('{name}（{n} 筆）', { name: p.name, n: p.counts.memories })}</option>)}
                  </select>
                )}
              </div>
              <span class="hint">
                {kind === 'core' ? t('每次對話都會載入的部分：核心準則 CORE.md、全域索引與這台電腦的單機索引。')
                  : kind === 'memory' ? t('只檢查這一筆：{ref}', { ref: <code>{init.ref}</code> })
                  : kind === 'all' ? t('全部範圍共 {n} 筆記憶。範圍很大時，Claude 會先看清單與說明，只打開可能有問題的記憶。', { n: size ?? '—' })
                  : size != null ? t('這個範圍有 {n} 筆記憶。', { n: size }) : null}
              </span>
            </div>
            <div class="field">
              <label for="tidy-note">{t('補充說明（選填）')}</label>
              <textarea id="tidy-note" class="input" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('例如：重點看重複的使用者記憶；客戶相關的先不要動')} />
            </div>
            <div class="tidy-cmd">
              <span class="field-label" id="tidy-cmd-label">{t('要貼給 Claude Code 的指令')}</span>
              <pre aria-labelledby="tidy-cmd-label">{command || t('請先選擇專案')}</pre>
              <div class="btn-row">
                <button class="btn primary" disabled={!command} onClick={copy}>{copied ? <><IconCheck />{t('已複製')}</> : <><IconSparkle />{t('複製指令')}</>}</button>
                <span class="faint" style={{ fontSize: 12.5 }}>{t('在 Claude Code 貼上送出；分析完成後，Claude 會給你回到這裡的網址。')}</span>
              </div>
            </div>
            <PluginState status={plugin} />
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>{t('整理記錄')}</h2><span class="sub">{t('保留 90 天')}</span></div>
          {list.error && !list.data ? <div class="panel-body"><ErrorBanner error={list.error} onRetry={list.reload} /></div>
            : list.loading && !list.data ? <div class="panel-body"><Skeleton rows={3} /></div>
            : !records.length ? <Empty icon={IconTidy} title={t('還沒有整理記錄')}>{t('在左邊選好範圍、把指令貼給 Claude Code，Claude 提出的建議就會出現在這裡。')}</Empty>
            : (
              <div class="rows tidy-records">
                {records.map((r) => (
                  <a class="row" key={r.id} href={`#/tidy?id=${r.id}`} onClick={(e) => { e.preventDefault(); go('tidy', { id: r.id }); }}>
                    <span class="title"><ScopeText value={r.scope} /></span>
                    <span class={`chip ${STATUS_TONE[r.status] || ''}`}>{t(STATUS[r.status] || r.status)}</span>
                    <span class="desc">{r.summary}</span>
                    <span class="meta">
                      <span>{t('{n} 項，建議變更 {k} 項', { n: r.counts.items, k: r.counts.suggested })}</span>
                      {r.status !== 'pending' && r.counts.failed > 0 && <span style={{ color: 'var(--danger)' }}>{t('失敗 {n} 項', { n: r.counts.failed })}</span>}
                      <span>{relTime(r.createdAt)}</span>
                    </span>
                  </a>
                ))}
              </div>
            )}
        </section>
      </div>
    </div>
  );
}

// ───────── 整理記錄：逐項決定、產生執行指令、看結果 ─────────

function TidyRecord({ id }) {
  const { go, reportError, toast, refresh } = useApp();
  const rec = useData(() => api.tidyRecord(id), [id]);
  const [edits, setEdits] = useState({});
  const [unsaved, setUnsaved] = useState(0);
  const [saving, setSaving] = useState('idle');
  const [filter, setFilter] = useState('all');
  const [dialog, setDialog] = useState(null);
  const [missing, setMissing] = useState([]);
  const [noneIds, setNoneIds] = useState(null);
  const [authFailed, setAuthFailed] = useState(false);
  const queue = useRef(null);
  queue.current ??= createSaveQueue();
  const timer = useRef(null);
  const inflight = useRef(null);
  const mounted = useRef(true);
  const failures = useRef(0);
  const rejected = useRef(0);
  // 存不進去（暫時性失敗或權杖失效）：直到下一次成功儲存前都擋住離開，而且把待送的修改暫存在這個分頁，重新整理後恢復
  const [failed, setFailed] = useState(false);
  const draftKey = `tidy.${id}`;
  const keepDraft = () => { if (queue.current.size) drafts.set(draftKey, { changes: queue.current.snapshot() }); else drafts.clear(draftKey); };
  // 換頁時會自動存回、關閉分頁時也會送出；只有存不進去時才擋住離開
  useDirty(unsaved > 0 && (authFailed || failed), t('尚未儲存的整理決定'));

  // keepalive：送到一半關掉分頁也會送完；瀏覽器限制本文約 64 KB，太大時改用一般請求
  const send = (changes) => api.tidyDecide(id, changes, { keepalive: new TextEncoder().encode(JSON.stringify({ id, changes })).length < 60_000 });

  // 決定與備註先記在畫面上，停手 0.7 秒後一次存回（常駐程式收到後其他分頁也會更新）；
  // 前一次還在存時先等它完成；暫時性的失敗 3 秒後重試；放回時舊值不會蓋掉之後的新值（savequeue.js）
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const r0 = rejected.current;
    while (inflight.current) await inflight.current.catch(() => {});
    // 等待期間有一批被拒絕（記錄已經改變）：畫面正在重新讀取，不要接著做
    if (rejected.current !== r0) return false;
    const q = queue.current;
    if (!q.size) return true;
    const batch = q.take();
    if (mounted.current) setSaving('saving');
    const p = send(batch.changes);
    inflight.current = p;
    try {
      await p;
      failures.current = 0;
      if (mounted.current) {
        setAuthFailed(false);
        setFailed(false);
        drafts.clear(draftKey);
        setSaving(q.size ? 'pending' : 'saved');
        setUnsaved(q.size);
      }
      return true;
    } catch (e) {
      // 權杖失效（常駐程式重新啟動）：重試也沒用，修改留著，請使用者重新整理頁面
      const auth = e.status === 401 || e.status === 403;
      // 記錄已經執行、被刪除或內容不合法：重試也不會成功，丟掉這批修改、重新讀取，讓畫面回到實際的狀態
      const permanent = !auth && e.status >= 400 && e.status < 500 && !['E_LOCKED', 'E_AGENT_DOWN'].includes(e.code);
      if (!permanent) q.putBack(batch);
      if (!mounted.current) {
        // 已經離開這一頁：暫時性的失敗再送一次，不留在背景重試
        if (!permanent && !auth && q.size) send(q.take().changes).catch(() => {});
        return false;
      }
      setUnsaved(q.size);
      if (auth) setAuthFailed(true);
      if (!permanent) { setFailed(true); keepDraft(); } else rejected.current++;
      setSaving(permanent ? 'rejected' : 'error');
      if (failures.current++ === 0 || permanent || auth) reportError(e);
      if (permanent) {
        setEdits((cur) => { const next = { ...cur }; for (const k of Object.keys(batch.changes)) if (!q.has(k)) delete next[k]; return next; });
        rec.reload();
      } else if (!auth) timer.current = setTimeout(flush, 3000);
      return false;
    } finally {
      if (inflight.current === p) inflight.current = null;
    }
  }, [id]);
  useEffect(() => {
    mounted.current = true;
    // 上次存不進去、重新整理後恢復那些修改（會再自動儲存一次）
    const saved = drafts.get(draftKey);
    if (saved?.changes && Object.keys(saved.changes).length) {
      drafts.clear(draftKey);
      for (const [k, patch] of Object.entries(saved.changes)) change(k, patch);
      toast(t('已恢復上次沒存進去的修改'));
    }
    const sendNow = () => { if (queue.current.size) send(queue.current.take().changes).catch(() => {}); };
    window.addEventListener('pagehide', sendNow);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', sendNow);
      clearTimeout(timer.current);
      sendNow();
    };
  }, [id]);
  // 伺服器的內容追上了畫面上的修改（存好了，或在別的分頁改了同樣的值）：拿掉那些暫存，以伺服器為準
  useEffect(() => {
    const d = rec.data;
    if (!d) return;
    if (!EDITABLE.has(d.status)) { setEdits({}); return; }
    setEdits((cur) => {
      let changed = false;
      const next = { ...cur };
      for (const [k, e] of Object.entries(cur)) {
        if (queue.current.has(k)) continue;
        const it = d.items.find((x) => x.id === k);
        if (!it || ((e.decision === undefined || e.decision === it.decision) && (e.note === undefined || e.note === (it.note || '')))) { delete next[k]; changed = true; }
      }
      return changed ? next : cur;
    });
  }, [rec.data]);

  const change = (itemId, patch) => {
    setEdits((cur) => ({ ...cur, [itemId]: { ...(cur[itemId] || {}), ...patch } }));
    queue.current.change(itemId, patch);
    setUnsaved(queue.current.size);
    setSaving('pending');
    setMissing((m) => m.filter((x) => x !== itemId));
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  };

  if (rec.error && !rec.data) {
    const notFound = rec.error.code === 'E_NOT_FOUND';
    return (
      <div class="page">
        <div class="panel"><Empty icon={IconTidy} title={notFound ? t('找不到這份整理記錄') : t('讀不到這份整理記錄')} action={<div class="btn-row">{!notFound && <button class="btn" onClick={rec.reload}>{t('重試')}</button>}<button class="btn" onClick={() => go('tidy')}><IconBack />{t('回到記憶整理')}</button></div>}>{local(rec.error, 'message')}</Empty></div>
      </div>
    );
  }
  if (!rec.data) return <div class="page"><div class="panel"><div class="panel-body"><Skeleton rows={6} /></div></div></div>;

  const r = rec.data;
  const editable = EDITABLE.has(r.status);
  const dOf = (it) => (edits[it.id]?.decision !== undefined ? edits[it.id].decision : it.decision);
  const nOf = (it) => (edits[it.id]?.note !== undefined ? edits[it.id].note : it.note || '');
  const n = { accept: 0, keep: 0, archive: 0, custom: 0, none: 0 };
  for (const it of r.items) n[dOf(it) || 'none']++;

  const FILTERS = editable
    ? [['all', N_('全部'), r.items.length], ['none', N_('待決定'), n.none], ['change', N_('建議變更'), r.items.filter((it) => it.action !== 'keep').length], ['keep', N_('建議保留'), r.items.filter((it) => it.action === 'keep').length]]
    : [['all', N_('全部'), r.items.length], ['done', N_('已完成'), r.counts.done], ['failed', N_('失敗'), r.counts.failed], ['waiting', N_('等 Claude 處理'), r.counts.waiting]];
  // 狀態改變後原本的篩選不在了，就看全部；「待決定」用選它當下的清單，做了決定卡片也不會立刻消失
  const fil = FILTERS.some(([k]) => k === filter) ? filter : 'all';
  const pickFilter = (k) => { setFilter(k); setNoneIds(k === 'none' ? new Set(r.items.filter((it) => !dOf(it)).map((it) => it.id)) : null); };
  const shown = r.items.filter((it) => fil === 'all'
    || (fil === 'none' && (noneIds ? noneIds.has(it.id) : !dOf(it))) || (fil === 'change' && it.action !== 'keep') || (fil === 'keep' && it.action === 'keep')
    || (fil === 'done' && it.result?.status === 'done') || (fil === 'failed' && it.result?.status === 'failed') || (fil === 'waiting' && it.result?.status === 'needs-claude'));
  const groups = [];
  for (const it of shown) {
    const key = it.group || '';
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, items: [] });
    g.items.push(it);
  }

  const acceptRest = () => {
    for (const it of r.items) if (!dOf(it)) change(it.id, { decision: suggestedOf(it) });
  };
  const doReady = async () => {
    setDialog(null);
    try {
      const res = await api.tidyReady(id);
      setDialog({ kind: 'command', command: res.command });
      setEdits({}); // 全部已存好；沒有決定的已由伺服器當成維持原狀
      rec.reload();
      refresh();
    } catch (e) { reportError(e); }
  };
  const onReady = async () => {
    if (!(await flush())) return;
    const need = r.items.filter((it) => dOf(it) === 'custom' && !nOf(it).trim()).map((it) => it.id);
    if (need.length) {
      setMissing(need);
      if (!shown.some((it) => it.id === need[0])) pickFilter('all');
      setTimeout(() => document.getElementById(`item-${need[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
      return;
    }
    if (n.none) setDialog({ kind: 'confirm-ready' }); else doReady();
  };
  const steps = [N_('Claude 分析'), N_('你決定'), N_('Claude 執行'), N_('完成')];
  const at = { pending: 1, ready: 2, applying: 2, finishing: 2, done: 4 }[r.status] ?? 1;

  return (
    <div class="page">
      <div><button class="btn ghost sm" onClick={() => go('tidy')}><IconBack />{t('記憶整理')}</button></div>

      <section class="panel tidy-head">
        <div class="panel-body">
          <div class="tidy-meta">
            <ScopeText value={r.scope} />
            <span class={`chip ${STATUS_TONE[r.status] || ''}`}>{t(STATUS[r.status] || r.status)}</span>
            <span>{t('Claude 建立於 {when}', { when: <When at={r.createdAt} /> })}</span>
            {r.status !== 'applying' && r.status !== 'finishing' && <span class="end"><button class="btn ghost sm danger" onClick={() => setDialog({ kind: 'delete' })}><IconTrash />{t('刪除這份記錄')}</button></span>}
          </div>
          <h2 class="tidy-summary">{r.summary}</h2>
          {r.highlights?.length > 0 && <ul class="tidy-highlights">{r.highlights.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {r.request && <p class="faint" style={{ fontSize: 13 }}>{t('你的補充說明：{text}', { text: r.request })}</p>}
          <ol class="steps four" aria-label={t('進度')}>
            {steps.map((s, i) => <li key={s} class={i < at ? 'done' : i === at ? 'now' : ''}><b>{t(s)}</b></li>)}
          </ol>
        </div>
      </section>

      {r.status === 'ready' && r.command && (
        <Banner tone="info" title={t('已產生執行指令')}>
          <span style={{ display: 'block', marginBottom: 8 }}>{t('在 Claude Code 貼上執行。Claude 開始執行之前，你仍然可以修改下面的決定。')}</span>
          <CopyBox text={r.command} label={t('複製指令')} />
        </Banner>
      )}
      {(r.status === 'applying' || r.status === 'finishing') && (
        <Banner tone="info" title={r.status === 'applying' ? t('Claude 正在執行') : t('Claude 正在處理「依備註調整」的 {n} 項', { n: r.counts.waiting })}>
          <span style={{ display: 'block', marginBottom: 8 }}>{t('這一頁會即時更新。如果 Claude Code 的對話中斷了，再貼一次這個指令會從中斷的地方繼續：')}</span>
          <CopyBox text={`/engram:tidy-apply ${r.id}`} label={t('複製指令')} />
        </Banner>
      )}
      {r.status === 'done' && (
        <Banner tone={r.counts.failed ? 'warn' : 'info'} title={t('整理完成')}>
          {t('完成 {done} 項、維持原狀 {kept} 項、失敗 {failed} 項、略過 {skipped} 項。動手前的備份在 {path}；每一項都可以單獨復原。', { done: r.counts.done, kept: r.counts.kept, failed: r.counts.failed, skipped: r.counts.skipped, path: <code>{r.backup || '—'}</code> })}
        </Banner>
      )}
      {missing.length > 0 && <Banner tone="warn" title={t('「依備註調整」要寫備註')}>{t('有 {n} 項選了「依備註調整」但沒有寫備註；寫下要 Claude 怎麼調整，或改選其他處理方式。', { n: missing.length })}</Banner>}

      <div class="tidy-toolbar">
        <div class="seg" role="group" aria-label={t('篩選')}>
          {FILTERS.map(([k, label, count]) => <button key={k} aria-pressed={fil === k} onClick={() => pickFilter(k)}>{t(label)}<span class="n">{count}</span></button>)}
        </div>
        {editable && n.none > 0 && <button class="btn sm" onClick={acceptRest}><IconCheck />{t('未決定的 {n} 項照建議', { n: n.none })}</button>}
      </div>

      {groups.map((g) => (
        <div class="tidy-group" key={g.key}>
          {(groups.length > 1 || g.key) && <h2>{g.key || t('其他')}<span>{t('{n} 項', { n: g.items.length })}</span></h2>}
          <div class="cards">
            {g.items.map((it) => (
              <ItemCard key={it.id} it={it} rec={r} editable={editable} decision={dOf(it)} note={nOf(it)} missing={missing.includes(it.id)}
                onChange={(patch) => change(it.id, patch)} onUndo={() => setDialog({ kind: 'undo', item: it })} />
            ))}
          </div>
        </div>
      ))}
      {!shown.length && <div class="panel"><Empty icon={IconCheck} title={t('這個篩選沒有項目')} /></div>}

      {r.kept?.length > 0 && (
        <details class="panel" style={{ padding: '12px 16px' }}>
          <summary class="muted" style={{ cursor: 'pointer', fontSize: 13 }}>{t('另外 {n} 筆 Claude 看過、建議保留，沒有逐項列出', { n: r.kept.length })}</summary>
          <div class="refs" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>{r.kept.map((x) => <code key={x}>{x}</code>)}</div>
        </details>
      )}

      {editable && (
        <div class="tidy-bar" role="region" aria-label={t('整理決定')}>
          <div class="counts">
            {['accept', 'keep', 'archive', 'custom'].map((k) => <span key={k} class="chip">{t(DECISION[k])} <b>{n[k]}</b></span>)}
            <span class={`chip${n.none ? ' warn' : ''}`}>{t('未決定')} <b>{n.none}</b></span>
          </div>
          <span class={`save-state${authFailed || saving === 'error' || saving === 'rejected' ? ' error' : ''}`} aria-live="polite">{authFailed ? t('沒有存進去：常駐程式重新啟動過，請重新整理這一頁') : saving === 'saving' || saving === 'pending' ? t('儲存中…') : saving === 'error' ? t('儲存失敗，稍後會再試') : saving === 'rejected' ? t('沒有存進去：這份記錄已經改變，畫面已重新讀取') : saving === 'saved' ? t('已自動儲存') : t('決定會自動儲存')}</span>
          <button class="btn primary" onClick={onReady}><IconSparkle />{r.status === 'ready' ? t('更新並顯示執行指令') : t('產生執行指令')}</button>
        </div>
      )}

      {dialog?.kind === 'confirm-ready' && (
        <ConfirmDialog title={t('還有 {n} 項沒有決定', { n: n.none })} desc={t('沒有決定的項目會當成「維持原狀」，不會改動。也可以先按「未決定的 {n} 項照建議」。', { n: n.none })} confirmLabel={t('產生執行指令')} onConfirm={doReady} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'command' && <CommandDialog command={dialog.command} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog title={t('刪除這份整理記錄？')} desc={r.status === 'done' ? t('只刪除這份記錄，已經做的整理不受影響（仍可在記憶的歷史裡復原）。') : t('Claude 的建議會一起刪除，記憶不會被改動。')} danger confirmLabel={t('刪除')}
          onConfirm={async () => { try { await api.tidyDelete(id); toast(t('已刪除整理記錄')); go('tidy'); } catch (e) { reportError(e); } }} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'undo' && (
        <ConfirmDialog title={t('復原「{name}」？', { name: dialog.item.name })} desc={t('依相反順序復原這一項做過的 {n} 個變更。之後若又改過同一筆記憶，可能無法自動復原。', { n: dialog.item.result?.undo?.length ?? 0 })} confirmLabel={t('復原')}
          onConfirm={async () => { try { await api.tidyUndo(id, dialog.item.id); toast(t('已復原')); setDialog(null); rec.reload(); refresh(); } catch (e) { setDialog(null); reportError(e); } }} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function CommandDialog({ command, onClose }) {
  return (
    <Dialog title={t('把這段指令貼給 Claude Code')} desc={t('採用建議的項目會照你看到的內容寫入；「依備註調整」的項目由 Claude 依你的備註處理。動手前會先備份，每一項都可以復原。')} onClose={onClose}
      footer={<button class="btn primary" onClick={onClose}>{t('完成')}</button>}>
      <CopyBox text={command} label={t('複製指令')} />
      <ol class="muted" style={{ fontSize: 13, margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
        <li>{t('回到 Claude Code（剛才的對話或新的對話都可以），貼上指令並送出。')}</li>
        <li>{t('Claude 會回報執行結果；這一頁也會即時更新，每一項都看得到結果與復原按鈕。')}</li>
      </ol>
    </Dialog>
  );
}

function ItemCard({ it, rec, editable, decision, note, missing, onChange, onUndo }) {
  const allowed = allowedDecisions(it);
  const sug = suggestedOf(it);
  const before = it.ref ? rec.texts?.[it.ref] : null;
  const scope = it.scope && it.scope !== 'core' ? parseScopeKey(it.scope) : null;
  return (
    <article class="card tidy-item" data-decision={decision || 'none'} id={`item-${it.id}`}>
      <header>
        <span class={`act-chip ${it.action}`}>{t(ACTION[it.action] || it.action)}</span>
        <h3><code>{it.name}</code></h3>
        {scope ? <ScopeLabel scope={scope} /> : it.scope === 'core' ? <ScopeText value="core" /> : null}
        {it.type && <TypeLabel type={it.type} />}
      </header>
      <p class="tidy-title"><IconSparkle />{it.title}</p>
      <p class="tidy-reason">{it.reason}</p>
      {!it.result && it.changed?.length > 0 && (
        <Banner tone="warn" title={t('建議之後被改過')}>{t('{refs} 在 Claude 提出建議之後被修改了（可能是另一台電腦同步過來）。執行時這一項不會寫入（會標成失敗），不會覆蓋；要依最新內容整理，請重新整理一次。', { refs: it.changed.join(t('、')) })}</Banner>
      )}
      {it.ops.length > 0 && (
        <div class="ops">
          <div class="ops-label">{t('採用建議會這樣做')}</div>
          {it.ops.map((o, k) => <OpRow key={k} op={o} rec={rec} />)}
        </div>
      )}
      {before != null && (
        <details class="tidy-current">
          <summary>{t('目前內容（建議當時）')}</summary>
          <pre class="diff">{before}</pre>
        </details>
      )}
      {editable ? (
        <div class="tidy-decide">
          <div class="seg" role="group" aria-label={t('處理方式：{name}', { name: it.name })}>
            {allowed.map((d) => (
              <button key={d} data-d={d} aria-pressed={decision === d} onClick={() => onChange({ decision: decision === d ? null : d })} title={d === sug ? t('Claude 的建議') : undefined}>
                {d === sug && <span class="sug" aria-hidden="true" />}{t(DECISION[d])}{d === sug && <span class="sr-only">{t('（Claude 的建議）')}</span>}
              </button>
            ))}
          </div>
          <textarea class="input" rows={decision === 'custom' ? 3 : 1} value={note} maxLength={NOTE_MAX} aria-invalid={missing || undefined} style={missing ? { borderColor: 'var(--danger)' } : undefined}
            aria-label={t('備註：{name}', { name: it.name })}
            placeholder={decision === 'custom' ? t('寫下要 Claude 怎麼調整（必填）') : t('備註（選填）')} onInput={(e) => onChange({ note: e.currentTarget.value })} />
          {note.trim() && decision && decision !== 'custom' && <p class="faint hint">{t('要 Claude 依備註修改，請選「依備註調整」；其他選項照原本的內容執行，備註只做紀錄。')}</p>}
        </div>
      ) : (
        <div class="tidy-decided">
          {decision && <span class="chip">{t('你的決定：{d}', { d: t(DECISION[decision]) })}</span>}
          {note && <span class="muted">{t('備註：{note}', { note })}</span>}
        </div>
      )}
      {it.result && <ResultRow r={it.result} onUndo={onUndo} />}
    </article>
  );
}

function ResultRow({ r, onUndo }) {
  const undoable = r.undo?.length > 0 && r.status !== 'undone';
  const message = r.error ? local(r.error, 'message') : local(r, 'message');
  return (
    <div class={`tidy-result ${r.status}`}>
      <b>{t(RESULT[r.status] || r.status)}</b>
      {message && <span class="muted">{message}</span>}
      {undoable && <span class="faint">{t('復原指令：{cmd}', { cmd: <code>{[...r.undo].reverse().map((s) => `engram undo ${String(s).slice(0, 10)}`).join(' → ')}</code> })}</span>}
      {undoable && <button class="btn sm" onClick={onUndo}><IconUndo />{t('復原這一項')}</button>}
    </div>
  );
}

function OpRow({ op, rec }) {
  const [open, setOpen] = useState(false);
  let Icon = IconEdit;
  let text;
  let diff = null;
  if (op.op === 'write') { text = t('改寫 {ref}', { ref: <code>{op.ref}</code> }); diff = [rec.texts?.[op.ref] ?? '', op.content]; }
  else if (op.op === 'move') { Icon = IconMove; text = t('把 {ref} 搬到 {scope}', { ref: <code>{op.ref}</code>, scope: <ScopeText value={op.to} /> }); }
  else if (op.op === 'remove') { Icon = IconArchive; text = t('封存 {ref}（移到歷史，可以復原）', { ref: <code>{op.ref}</code> }); }
  else if (op.op === 'merge') { Icon = IconMerge; text = t('把 {refs} 合併成 {into}，其他筆移到歷史', { refs: op.refs.map((x) => x.split('/').pop()).join(t('、')), into: <code>{op.into}</code> }); diff = [rec.texts?.[op.into] ?? '', op.content]; }
  else if (op.op === 'create') { Icon = IconPlus; text = t('新增 {scope} 記憶 {ref}', { scope: <ScopeText value={op.scope} />, ref: <code>{op.name}</code> }); diff = ['', op.content]; }
  else if (op.op === 'core') { Icon = IconCore; text = t('改寫核心準則 CORE.md'); diff = [rec.texts?.[CORE_REF] ?? '', op.content]; }
  return (
    <div class="op">
      <Icon />
      <span>{text}</span>
      {diff ? <button class="btn ghost sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('收起') : op.op === 'create' ? t('看內容') : t('看差異')}</button> : <span />}
      {open && diff && <DiffView a={diff[0]} b={diff[1]} />}
    </div>
  );
}

/** 只顯示有變化的行與前後兩行，中間相同的部分收起來 */
function DiffView({ a, b }) {
  const rows = useMemo(() => {
    const lines = lineDiff(a, b);
    const keep = new Array(lines.length).fill(false);
    lines.forEach((l, i) => { if (l.t !== ' ') for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep[k] = true; });
    const out = [];
    let gap = 0;
    lines.forEach((l, i) => {
      if (keep[i]) { if (gap) out.push({ gap }); gap = 0; out.push(l); } else gap++;
    });
    if (gap) out.push({ gap });
    return out;
  }, [a, b]);
  if (!rows.some((x) => !x.gap && x.t !== ' ')) return <p class="faint" style={{ fontSize: 12.5 }}>{t('內容相同，只差在空白或檔尾換行。')}</p>;
  return (
    <div class="diff-lines" role="group" aria-label={t('差異比對')}>
      {rows.map((r, i) => (r.gap
        ? <div class="gap" key={i}>{t('⋯ {n} 行相同', { n: r.gap })}</div>
        : <div key={i} class={`l${r.t === '+' ? ' add' : r.t === '-' ? ' del' : ''}`}><span class="g" aria-hidden="true">{r.t}</span><span class="s">{r.t === '+' ? <span class="sr-only">{t('新增：')}</span> : r.t === '-' ? <span class="sr-only">{t('刪除：')}</span> : null}{r.s || ' '}</span></div>))}
    </div>
  );
}
