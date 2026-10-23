// 匯入：把 ~/.claude/projects/*/memory 的既有記憶複製進 vault。
// 流程：產生計畫 → 逐筆檢查與調整 → 沙盒演練（必須通過）→ 套用 → 驗證與還原。原始檔不刪除，隨時可還原。
import { h, Fragment } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Skeleton, Section, Banner, ErrorBanner, Dialog, ConfirmDialog, Empty, TypeLabel, useAction } from '../components.jsx';
import { relTime } from '../util.js';
import { IconImport, IconChevronDown, IconChevronRight, IconFolder, IconArchive, IconUndo, IconCheckCircle, IconShield, IconCheck, IconX, IconPlay, IconGlobe, IconMonitor } from '../icons.jsx';

const HOW = { 'origin-session': '依記憶的 originSessionId 對到對話紀錄', 'content-path': '依記憶內文提到的資料夾', 'transcript-cwd': '依對話紀錄裡的工作目錄', decoded: '由資料夾編碼反推', unknown: '原資料夾已不存在，無法判斷', suggested: '採用 Engram 的建議' };
const ACTION = {
  copy: { label: '匯入', cls: 'brand' },
  'skip-same': { label: '略過（重複）', cls: '' },
  superseded: { label: '略過（較舊版本）', cls: '' },
  rename: { label: '改名後匯入', cls: 'warn' },
  'merge-candidate': { label: '匯入，建議合併', cls: 'warn' },
};
const SKIP = new Set(['skip-same', 'superseded']);
const key = (s, it) => `${s.encoded}/${it.file}`;
// 來源鍵（與後端 plan.mjs 的 sourceKey 相同）：同一個編碼資料夾可能拆成好幾個來源（撞名、內文路徑），
// 展開狀態、採用建議與命名都要以來源為單位。一律用原始計畫的值，採用「改綁到資料夾」後 resolvedPath 會變。
const skey = (s) => `${s.encoded}|${s.resolvedPath ?? ''}`;

export function Import() {
  const { refresh, toast } = useApp();
  const plan = useData(() => api.importPlan(), []);
  const [open, setOpen] = useState({});
  const [srcFilter, setSrcFilter] = useState('all');
  const [edits, setEdits] = useState({ items: {}, names: {}, targets: {} });
  const [rehearsal, setRehearsal] = useState(null); // { editsKey, report }
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [again, setAgain] = useState(false); // 匯入後還有延後或新出現的來源：回到規劃模式
  const editsKey = JSON.stringify(edits);

  // 套用調整後的即時檢視（與後端 applyEdits 相同的規則）
  const view = useMemo(() => {
    if (!plan.data) return null;
    const sources = plan.data.sources.map((s0) => {
      const k = skey(s0);
      const s = retarget(s0, edits.targets[k]);
      return {
        ...s,
        _k: k,
        target: s.target.isNew && edits.names[k] ? { ...s.target, name: edits.names[k] } : s.target,
        items: s.items.map((it) => (edits.items[key(s, it)] ? { ...it, ...edits.items[key(s, it)], edited: true } : it)),
      };
    });
    const t = { sources: sources.length, memories: 0, copy: 0, skip: 0, global: 0, machine: 0, project: 0, archived: 0 };
    for (const s of sources) {
      if (s.target.archived && keepsProject(s)) t.archived++;
      for (const it of s.items) {
        t.memories++;
        if (SKIP.has(it.action)) { t.skip++; continue; }
        t.copy++; t[it.scope] = (t[it.scope] || 0) + 1;
      }
    }
    return { sources, totals: t };
  }, [plan.data, editsKey]);

  if (!plan.data) return <div class="page"><ErrorBanner error={plan.error} onRetry={plan.reload} /><div class="panel"><Skeleton rows={8} /></div></div>;
  const p = plan.data;
  // 有還原點才算套用過；所有來源都因規劃後有變更而延後時，沒有還原點
  const applied = !!result?.tag || (!again && p.applied);
  const tag = result?.tag || p.tag;
  const rehearsedOk = rehearsal && rehearsal.editsKey === editsKey && rehearsal.report.ok;
  const nEdits = Object.keys(edits.items).length + Object.keys(edits.names).length + Object.keys(edits.targets).length;
  const adopt = (s, t) => setEdits((e) => { const targets = { ...e.targets }; if (t) targets[s._k] = t; else delete targets[s._k]; return { ...e, targets }; });
  const indexRoom = p.budget ? Math.max(0, p.budget.global - 6) : null;
  const step = applied ? 4 : rehearsedOk ? 3 : rehearsal ? 2 : 1;
  const changed = (result?.deferred ?? []).filter((d) => d.reason === 'changed-since-plan');
  const later = (result?.deferred ?? []).filter((d) => d.reason !== 'changed-since-plan');
  // 早就綁定到同一個專案的資料夾不會重新綁定（target.boundPid，40 號 §09）
  const bindCount = view.sources.filter((s) => s.exists && s.items.some((i) => !SKIP.has(i.action)) && !(s.target.boundPid && s.target.boundPid === s.target.pid)).length;

  const origOf = (s, it) => p.sources.find((x) => skey(x) === s._k).items.find((x) => x.file === it.file);
  const toggle = (s, it) => {
    const orig = origOf(s, it);
    if (!SKIP.has(it.action)) setItem(s, it, { action: 'skip-same' });
    else setItem(s, it, { action: SKIP.has(orig.action) ? 'copy' : orig.action });
  };
  const setItem = (s, it, patch) => setEdits((e) => {
    const k = key(s, it);
    const orig = origOf(s, it);
    const next = { ...(e.items[k] || {}), ...patch };
    for (const f of Object.keys(next)) if (next[f] === orig[f]) delete next[f];
    const items = { ...e.items };
    if (Object.keys(next).length) items[k] = next; else delete items[k];
    return { ...e, items };
  });
  const setName = (s, name) => setEdits((e) => {
    const names = { ...e.names };
    if (name && name !== p.sources.find((x) => skey(x) === s._k).target.name) names[s._k] = name; else delete names[s._k];
    return { ...e, names };
  });

  // SW-2：附上規劃當時每個來源的指紋；套用時有變更的來源會延後，只匯入使用者看過的內容
  const withRevs = () => ({ ...edits, revs: Object.fromEntries(p.sources.filter((s) => s.rev).map((s) => [`${s.encoded}|${s.resolvedPath ?? ''}`, s.rev])) });
  const doRehearse = async () => {
    setBusy('rehearse'); setErr(null);
    try { setRehearsal({ editsKey, report: await api.importRehearse(withRevs()) }); }
    catch (e) { setErr(e); }
    finally { setBusy(''); }
  };
  const doApply = async () => {
    setBusy('apply'); setErr(null);
    try {
      const r = await api.importApply(withRevs());
      setResult(r); setDialog(null); refresh();
      toast(r.tag ? `已匯入 ${r.copied} 筆記憶` : '記憶在產生計畫後有變更，這次沒有匯入');
    }
    catch (e) { setErr(e); setDialog(null); setAgain(false); plan.reload(); } // 中途失敗會留下紀錄，重新讀取後顯示還原按鈕
    finally { setBusy(''); }
  };
  const replan = () => {
    setAgain(true); setResult(null); setRehearsal(null); setEdits({ items: {}, names: {}, targets: {} }); setOpen({});
    plan.reload();
  };
  const doUndo = async () => {
    setBusy('undo'); setErr(null);
    try { await api.importUndo(tag); setResult(null); setRehearsal(null); setDialog(null); plan.reload(); refresh(); toast('已還原到匯入前'); }
    catch (e) { setErr(e); }
    finally { setBusy(''); }
  };

  if (!p.sources.length && !applied) {
    return <div class="page"><div class="panel"><Empty icon={IconCheckCircle} title="沒有需要匯入的記憶">Claude Code 預設位置裡的記憶都已經收編。之後若有新的，健康檢查會提醒你收編。</Empty></div></div>;
  }
  const t = view.totals;

  return (
    <div class="page">
      <ol class="steps" aria-label="匯入步驟">
        {['產生計畫', '檢查與調整', '沙盒演練', '套用', '驗證與還原'].map((s, i) => (
          <li key={s} class={i < step ? 'done' : i === step ? 'now' : ''}><b>{s}</b></li>
        ))}
      </ol>

      <ErrorBanner error={err} />
      {applied && !result && p.lastImport?.failed ? (
        <Banner tone="bad" title="上次匯入中途失敗" actions={<button class="btn sm" disabled={!!busy} onClick={() => setDialog('undo')}><IconUndo />還原到匯入前</button>}>
          已完成的部分已經寫入，建議先還原到匯入前，原始記憶會回到匯入前的狀態；之後可以重新產生計畫再試一次。還原點 <code>{tag}</code>。原因：{p.lastImport.failed.message}
        </Banner>
      ) : applied ? (
        <Banner tone="info" title="匯入完成" actions={<button class="btn sm" disabled={!!busy} onClick={() => setDialog('undo')}><IconUndo />還原到匯入前</button>}>
          {result ? `已匯入 ${result.copied} 筆、略過 ${result.skipped} 筆，綁定 ${result.bound} 個資料夾。` : p.lastImport ? `${relTime(p.lastImport.at)}匯入 ${p.lastImport.copied} 筆、綁定 ${p.lastImport.bound} 個資料夾。` : ''}
          還原點 <code>{tag}</code>。原始檔案都還在原位；確認一切正常之前，Engram 不會刪除它們。
          {(result?.backupOnly ?? p.lastImport?.backupOnly) > 0 && ` 略過的 ${result?.backupOnly ?? p.lastImport?.backupOnly} 筆原始檔另外保存在 ~/.engram/local/backups。`}
        </Banner>
      ) : (
        <Banner tone="info" title="這只是計畫，還沒有動到任何檔案">
          請先展開各來源檢查每一筆的去處，需要時調整範圍或略過；接著執行「沙盒演練」，用你的記憶複本完整跑一次匯入與還原。演練通過後才能套用。
        </Banner>
      )}

      {changed.length > 0 && (
        <Banner tone="warn" title={`有 ${changed.length} 個資料夾這次沒有匯入`} actions={<button class="btn sm" disabled={!!busy} onClick={replan}>重新產生計畫</button>}>
          {changed.map((d) => d.path).join('、')}。產生計畫之後，這些資料夾又有新的或改過的記憶；為了只匯入你檢查過的內容，這次先跳過。重新產生計畫並檢查後，再套用一次即可。
        </Banner>
      )}
      {later.length > 0 && (
        <Banner tone="info" title={`有 ${later.length} 個資料夾稍後才會接上`}>
          {later.map((d) => d.path).join('、')}。記憶已經匯入；這些資料夾正有對話在使用或檔案被占用，對話結束後常駐程式會自動接上，不需要再操作。
        </Banner>
      )}
      {applied && !result && !p.lastImport?.failed && p.sources.length > 0 && (
        <Banner tone="warn" title={`還有 ${p.sources.length} 個資料夾的記憶尚未匯入`} actions={<button class="btn sm" disabled={!!busy} onClick={replan}>為這些資料夾產生計畫</button>}>
          可能是上次匯入時延後的資料夾，或之後才寫的記憶。產生新的計畫並檢查後，可以再匯入一次；上次的匯入不受影響。
        </Banner>
      )}
      <div class="grid cols-4">
        <Tile label="既有記憶" value={t.memories} foot={`來自 ${t.sources} 個資料夾`} />
        <Tile label={applied ? '已匯入' : '將匯入'} value={result?.copied ?? t.copy} foot={`略過 ${result?.skipped ?? t.skip} 筆重複或舊版本`} />
        <Tile label="全域／單機" value={`${t.global || 0}／${t.machine || 0}`} foot={indexRoom !== null ? `全域索引可列 ${indexRoom} 筆${(t.global || 0) > indexRoom ? `，超出的 ${(t.global || 0) - indexRoom} 筆只能用搜尋找到` : ''}` : `其餘 ${t.project || 0} 筆留在專案`} />
        <Tile label={applied ? '已綁定的資料夾' : '將綁定的資料夾'} value={result?.bound ?? p.lastImport?.bound ?? bindCount} foot={`另有 ${t.archived} 個原資料夾已不存在，記憶存入封存專案`} />
      </div>

      {!applied && (
        <Section title="沙盒演練" sub="複製你的記憶到暫存資料夾，完整跑一次匯入、驗證與還原，不碰真實環境" end={
          <button class="btn" disabled={!!busy} onClick={doRehearse}><IconPlay class={busy === 'rehearse' ? 'spin' : ''} />{busy === 'rehearse' ? '演練中…' : rehearsal ? '重新演練' : '開始演練'}</button>
        }>
          <div class="panel-body">
            {!rehearsal ? <p class="muted" style={{ fontSize: 13 }}>大約需要 20 秒。演練會檢查四件事：每一筆都有去處；用正式的「還原到匯入前」還原後，記憶庫與匯入前一致；你真實的記憶檔一個位元都沒有被改動；以及用合成資料測試資料夾綁定的還原。</p> : (
              <div style={{ display: 'grid', gap: 12 }}>
                {rehearsal.editsKey !== editsKey && <Banner tone="warn" title="調整內容在演練後有變更">請重新演練，確認新的調整也能正確匯入與還原。</Banner>}
                <div class="rows" style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
                  <Check ok={rehearsal.report.accounting.ok} label="每一筆都有去處" detail={`計畫匯入 ${rehearsal.report.accounting.copyPlanned} 筆，沙盒 vault 實際有 ${rehearsal.report.accounting.vaultMemoryFiles} 筆（全域 ${rehearsal.report.accounting.byScope.global}、單機 ${rehearsal.report.accounting.byScope.machine}、專案 ${rehearsal.report.accounting.byScope.project}）`} />
                  <Check ok={rehearsal.report.restore.ok} label="還原到匯入前：記憶庫端（與正式還原同一套程式）"
                    detail={rehearsal.report.restore.ok ? `還原 ${rehearsal.report.restore.reverted} 個變更後，記憶庫與還原點零差異，沙盒中的原始記憶逐檔一致` : `仍有差異：${rehearsal.report.restore.remainingDiff || `${rehearsal.report.restore.legacyChanged?.length ?? 0} 個原始記憶檔不同`}`} />
                  <Check ok={rehearsal.report.realUntouched.ok} label="真實記憶完全沒有被改動" detail="演練前後比對每個原始記憶檔的 SHA-256" />
                  {rehearsal.report.selfTest && (
                    <Check ok={rehearsal.report.selfTest.ok} label="還原到匯入前：資料夾綁定（合成資料自我測試）"
                      detail={rehearsal.report.selfTest.ok
                        ? `${rehearsal.report.selfTest.checks.length} 項檢查全部通過。演練不會在你的資料夾建立綁定，所以用合成的專案資料夾驗證 junction、撞名資料夾的設定檔綁定、匯入後的修改，以及 settings.json 與專案資料夾都回到匯入前`
                        : `未通過：${rehearsal.report.selfTest.checks.filter((c) => !c.ok).map((c) => c.name + (c.detail ? `（${c.detail}）` : '')).join('、')}`} />
                  )}
                </div>
                {rehearsal.report.health?.length > 0 && (
                  <p class="muted" style={{ fontSize: 13 }}>匯入後的健康檢查會提出 {rehearsal.report.health.length} 項建議（例如可能重複、檔案過大），匯入後可以在收件匣逐一處理。</p>
                )}
                <span class="faint" style={{ fontSize: 12 }}>用時 {(rehearsal.report.ms / 1000).toFixed(1)} 秒</span>
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="匯入計畫" sub={nEdits ? `你已調整 ${nEdits} 處` : '展開來源可逐筆調整範圍，或取消勾選略過'} end={
        !applied && (
          <button class="btn primary" disabled={!rehearsedOk || !!busy} title={rehearsedOk ? '' : '先完成沙盒演練'} onClick={() => setDialog('apply')}><IconImport />套用計畫</button>
        )
      }>
        <div class="panel-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', paddingBlock: 10 }}>
          <div class="seg" role="group" aria-label="顯示">
            <button aria-pressed={srcFilter === 'all'} onClick={() => setSrcFilter('all')}>全部來源<span class="n">{view.sources.length}</span></button>
            <button aria-pressed={srcFilter === 'attention'} onClick={() => setSrcFilter('attention')}>需要注意<span class="n">{view.sources.filter(needsLook).length}</span></button>
          </div>
          <button class="btn sm ghost" onClick={() => setOpen(Object.fromEntries(view.sources.map((s) => [s._k, true])))}>全部展開</button>
          <button class="btn sm ghost" onClick={() => setOpen({})}>全部收合</button>
          <span class="faint" style={{ fontSize: 12 }}>「需要注意」：原資料夾已不存在、有建議、建議合併，或範圍是全域／單機的來源</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th style={{ width: 28 }}><span class="sr-only">展開</span></th><th>來源</th><th>判斷方式</th><th>匯入到</th><th class="num">匯入／全部</th></tr></thead>
            <tbody>
              {view.sources.filter((s) => srcFilter === 'all' || needsLook(s)).map((s) => {
                const isOpen = open[s._k];
                const copy = s.items.filter((i) => !SKIP.has(i.action)).length;
                const edited = s.items.some((i) => i.edited) || edits.names[s._k] || edits.targets[s._k];
                return (
                  <Fragment key={s._k}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setOpen({ ...open, [s._k]: !isOpen })}>
                      <td><button class="expander" aria-expanded={!!isOpen} aria-label={`${isOpen ? '收合' : '展開'} ${s.resolvedPath || s.encoded}`} onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [s._k]: !isOpen }); }}>{isOpen ? <IconChevronDown style={{ width: 16, height: 16 }} /> : <IconChevronRight style={{ width: 16, height: 16 }} />}</button></td>
                      <td>
                        <div class="path" style={{ color: 'var(--text)' }}>{s.resolvedPath || '（原資料夾路徑無法還原）'}</div>
                        <div class="mono faint" style={{ fontSize: 11 }}>{s.encoded}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{s.exists ? <span class="chip ok">資料夾存在</span> : <span class="chip warn">資料夾已不存在</span>}<div class="faint" style={{ marginTop: 4 }}>{HOW[s.how]}</div></td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {s.target.archived ? <IconArchive style={{ width: 15, height: 15, color: 'var(--text-3)' }} /> : <IconFolder style={{ width: 15, height: 15, color: 'var(--text-2)' }} />}
                          <b style={{ fontWeight: 600 }}>{s.target.name}</b>
                          {s.target.archived && !keepsProject(s) ? <span class="chip" title="原資料夾已不存在，記憶都進了全域或單機（或被略過），不另外建立空的封存專案">不建立專案</span>
                            : s.target.archived ? <span class="chip">封存專案</span> : s.target.isNew ? <span class="chip brand">新專案</span> : <span class="chip">既有專案</span>}
                          {edited && <span class="chip warn">已調整</span>}
                        </span>
                      </td>
                      <td class="num">{copy} / {s.items.length}</td>
                    </tr>
                    {isOpen && !applied && s.suggestions?.length > 0 && (
                      <tr style={{ background: 'var(--panel-2)' }}>
                        <td />
                        <td colSpan="4">
                          <div style={{ display: 'grid', gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>Engram 找到可能是同一個專案的位置（不會自動採用）</span>
                            {s.suggestions.map((sg, i) => {
                              const t = sg.kind === 'project' ? { pid: sg.pid } : sg.kind === 'source' ? { sameAs: sg.sameAs } : { path: sg.path };
                              const on = JSON.stringify(edits.targets[s._k] || null) === JSON.stringify(t);
                              return (
                                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                                  <span class="chip">{sg.kind === 'project' ? '既有專案' : sg.kind === 'source' ? '這次匯入的資料夾' : '桌面上的資料夾'}</span>
                                  <span class="path" style={{ color: 'var(--text)' }}>{sg.name || sg.path}</span>
                                  <span class="faint" style={{ fontSize: 12 }}>{sg.reason}</span>
                                  <button class={`btn sm${on ? '' : ' primary'}`} onClick={(e) => { e.stopPropagation(); adopt(s, on ? null : t); }}>{on ? '取消採用' : '採用'}</button>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                    {isOpen && s.target.isNew && !applied && (
                      <tr style={{ background: 'var(--panel-2)' }}>
                        <td />
                        <td colSpan="4">
                          <label class="field" style={{ maxWidth: 420 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>新專案的顯示名稱</span>
                            <input class="input" id={`nm-${s._k}`} value={s.target.name} onClick={(e) => e.stopPropagation()} onInput={(e) => setName(s, e.currentTarget.value.trim())} />
                          </label>
                        </td>
                      </tr>
                    )}
                    {isOpen && s.items.map((it) => {
                      const userSkipped = it.edited && SKIP.has(it.action) && !SKIP.has(origOf(s, it).action);
                      const a = userSkipped ? { label: '你選擇略過', cls: '' } : ACTION[it.action] || { label: it.action, cls: '' };
                      const on = !SKIP.has(it.action);
                      return (
                        <tr key={it.file} style={{ background: 'var(--panel-2)' }}>
                          <td>
                            {!applied && <input type="checkbox" id={`it-${s.encoded}-${it.file}`} aria-label={`匯入 ${it.file}`} checked={on} onChange={() => toggle(s, it)} />}
                          </td>
                          <td><span class="mono" style={{ fontSize: 12, textDecoration: on ? 'none' : 'line-through', color: on ? 'var(--text)' : 'var(--text-3)' }}>{it.file}</span>{it.description && <div class="muted" style={{ fontSize: 12 }}>{it.description}</div>}<div><TypeLabel type={it.type} /></div></td>
                          <td><span class={`chip ${a.cls}`}>{a.label}</span>{it.edited && <span class="chip warn" style={{ marginLeft: 6 }}>已調整</span>}</td>
                          <td>
                            {on && !applied ? (
                              <select class="select" id={`sc-${s.encoded}-${it.file}`} aria-label={`${it.file} 的範圍`} value={it.scope} onChange={(e) => setItem(s, it, { scope: e.currentTarget.value })} style={{ height: 28 }}>
                                <option value="project">專案（只在這個專案載入）</option>
                                <option value="global">全域（每個專案都載入索引）</option>
                                <option value="machine">單機（只在這台電腦載入）</option>
                              </select>
                            ) : <ScopeText scope={it.scope} />}
                            {it.reason && <div class="faint" style={{ fontSize: 12, marginTop: 4 }}>{it.reason}{it.dupOf ? `（${it.dupOf}）` : ''}</div>}
                          </td>
                          <td />
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {applied && <GuidelinesStep />}

      {dialog === 'apply' && (
        <Dialog title="套用匯入計畫？" desc="以下是這次套用會寫入的位置。每一項都記在安裝清單裡，可以完整還原。" onClose={() => setDialog(null)}
          footer={<><button class="btn" onClick={() => setDialog(null)}>取消</button><button class="btn primary" disabled={!!busy} onClick={doApply}>{busy === 'apply' ? '套用中…' : '套用'}</button></>}>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8, fontSize: 13 }}>
            <li><b>vault：</b>複製 {t.copy} 筆記憶（全域 {t.global || 0}、單機 {t.machine || 0}、專案 {t.project || 0}），並建立還原點。</li>
            <li><b>Claude Code 的記憶資料夾：</b>{bindCount} 個仍存在的資料夾改以 junction 指向 vault；原本的檔案先備份。</li>
            <li><b>你的使用者設定 <code>~/.claude/settings.json</code>：</b>在 <code>permissions.additionalDirectories</code> 新增 {bindCount} 筆 junction 路徑，讓 Claude 讀記憶時不跳權限提問。寫入前會備份，只增加 Engram 自己的項目。</li>
            <li><IconShield style={{ width: 14, height: 14, verticalAlign: -2, color: 'var(--ok)' }} /> 原始記憶檔保留不刪；隨時可以「還原到匯入前」。</li>
          </ul>
        </Dialog>
      )}
      {dialog === 'undo' && (
        <Dialog title="還原到匯入前？" desc={`會解除這次匯入建立的綁定（junction 換回實體資料夾），並依序撤銷匯入產生的變更。還原點 ${tag}。`} onClose={() => setDialog(null)}
          footer={<><button class="btn" onClick={() => setDialog(null)}>取消</button><button class="btn danger" disabled={!!busy} onClick={doUndo}><IconUndo />{busy === 'undo' ? '還原中…' : '還原'}</button></>}>
          <p class="muted" style={{ fontSize: 13 }}>匯入之後你在 Engram 裡做的其他修改（例如編輯、改範圍）會保留在歷史中，不會被刪除。</p>
        </Dialog>
      )}
    </div>
  );
}

// 與後端 plan.mjs 的 retarget 規則相同
function retarget(s, t) {
  if (!t) return s;
  if (t.pid) return { ...s, target: { ...s.target, pid: t.pid, isNew: false, archived: false } };
  if (t.sameAs) return { ...s, target: { ...s.target, sameAs: t.sameAs, isNew: false, archived: false, name: s.suggestions?.find((x) => x.sameAs === t.sameAs)?.name ?? s.target.name } };
  return { ...s, resolvedPath: t.path, exists: true, how: 'suggested', target: { ...s.target, pid: null, isNew: true, archived: false, name: t.path.split(/[\\/]/).pop() } };
}

function Check({ ok, label, detail }) {
  return (
    <div class="row" style={{ cursor: 'default', gridTemplateColumns: 'auto minmax(0, 1fr)' }}>
      {ok ? <IconCheck style={{ width: 18, height: 18, color: 'var(--ok)' }} /> : <IconX style={{ width: 18, height: 18, color: 'var(--danger)' }} />}
      <span><b style={{ fontWeight: 600 }}>{label}</b><span class="faint" style={{ display: 'block', fontSize: 12 }}>{detail}</span></span>
    </div>
  );
}

function ScopeText({ scope }) {
  const Icon = scope === 'global' ? IconGlobe : scope === 'machine' ? IconMonitor : IconFolder;
  return <span class="scope"><Icon /><span>{{ global: '全域', machine: '單機', project: '專案' }[scope]}</span></span>;
}

function Tile({ label, value, foot }) {
  return (
    <section class="panel stat">
      <span class="label">{label}</span>
      <span class="value">{value}</span>
      <span class="foot">{foot}</span>
    </section>
  );
}

// 有沒有記憶留在專案範圍；孤兒來源沒有的話，引擎不建立封存專案（40 號 §09）
function keepsProject(s) {
  return s.items.some((i) => !SKIP.has(i.action) && (i.scope ?? 'project') === 'project');
}

// 「需要注意」的來源
function needsLook(s) {
  return !s.exists || s.suggestions?.length > 0 || s.items.some((i) => ['merge-candidate', 'rename'].includes(i.action) || (i.scope && i.scope !== 'project')) || s.items.some((i) => i.edited);
}

// 選用步驟：把 ~/.claude/CLAUDE.md 的工作準則搬進 vault，讓所有電腦共用（41 號 §11）
function GuidelinesStep() {
  const g = useData(() => api.guidelines(), []);
  const act = useAction();
  const [ask, setAsk] = useState(null);
  if (!g.data) return null;
  return (
    <Section title="選用：讓所有電腦共用你的工作準則" sub={g.data.adopted ? '已同步' : `${g.data.lines} 行`} end={g.data.adopted
      ? <button class="btn sm" onClick={() => setAsk('revert')}>改回各台電腦自己的版本</button>
      : <button class="btn sm primary" onClick={() => setAsk('adopt')}>同步工作準則</button>}>
      <div class="panel-body" style={{ display: 'grid', gap: 10 }}>
        <p class="muted" style={{ fontSize: 13 }}>你在 <code>~/.claude/CLAUDE.md</code> 寫的工作準則目前只存在這台電腦。同步後，內容會搬進 vault 的 <code>core/rules/user-guidelines.md</code>，由 CORE.md 以 <code>{g.data.coreLine}</code> 引用；這台的 CLAUDE.md 只保留 Engram 區塊。原檔會先備份，移除 Engram 時會逐字還原。</p>
        <details><summary class="faint" style={{ cursor: 'pointer', fontSize: 12 }}>預覽搬移後的內容</summary><div class="diff" style={{ marginTop: 8 }}>{g.data.proposed}</div></details>
      </div>
      {ask && (
        <ConfirmDialog title={ask === 'adopt' ? '同步工作準則？' : '改回各台電腦自己的版本？'} confirmLabel={ask === 'adopt' ? '同步' : '改回'}
          desc={ask === 'adopt' ? '會修改這台的 ~/.claude/CLAUDE.md（先備份），並在 vault 新增 core/rules/user-guidelines.md。' : '工作準則會放回這台的 ~/.claude/CLAUDE.md，vault 裡的副本保留在歷史中。'}
          onConfirm={async () => { await act(() => (ask === 'adopt' ? api.adoptGuidelines() : api.revertGuidelines()), ask === 'adopt' ? '已同步工作準則，下一次對話生效' : '已改回'); setAsk(null); g.reload(); }} onClose={() => setAsk(null)}>
          <span />
        </ConfirmDialog>
      )}
    </Section>
  );
}
