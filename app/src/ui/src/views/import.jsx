// 匯入：把 ~/.claude/projects/*/memory 的既有記憶複製進 vault。
// 流程：產生計畫 → 逐筆檢查與調整 → 沙盒演練（必須通過）→ 套用 → 驗證與還原。原始檔不刪除，隨時可還原。
import { h, Fragment } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Skeleton, Section, Banner, ErrorBanner, Dialog, ConfirmDialog, Empty, TypeLabel, useAction } from '../components.jsx';
import { relTime } from '../util.js';
import { IconImport, IconChevronDown, IconChevronRight, IconFolder, IconArchive, IconUndo, IconCheckCircle, IconShield, IconCheck, IconX, IconPlay, IconGlobe, IconMonitor } from '../icons.jsx';
import { t, N_, local } from '../i18n.js';

const HOW = { 'origin-session': N_('依記憶的 originSessionId 對到對話紀錄'), 'content-path': N_('依記憶內文提到的資料夾'), 'transcript-cwd': N_('依對話紀錄裡的工作目錄'), decoded: N_('由資料夾編碼反推'), unknown: N_('原資料夾已不存在，無法判斷'), suggested: N_('採用 Engram 的建議') };
const ACTION = {
  copy: { label: N_('匯入'), cls: 'brand' },
  'skip-same': { label: N_('略過（重複）'), cls: '' },
  superseded: { label: N_('略過（較舊版本）'), cls: '' },
  rename: { label: N_('改名後匯入'), cls: 'warn' },
  'merge-candidate': { label: N_('匯入，建議合併'), cls: 'warn' },
};
const SCOPE = { global: N_('全域'), machine: N_('單機'), project: N_('專案') };
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
    const tot = { sources: sources.length, memories: 0, copy: 0, skip: 0, global: 0, machine: 0, project: 0, archived: 0 };
    for (const s of sources) {
      if (s.target.archived && keepsProject(s)) tot.archived++;
      for (const it of s.items) {
        tot.memories++;
        if (SKIP.has(it.action)) { tot.skip++; continue; }
        tot.copy++; tot[it.scope] = (tot[it.scope] || 0) + 1;
      }
    }
    return { sources, totals: tot };
  }, [plan.data, editsKey]);

  if (!plan.data) return <div class="page"><ErrorBanner error={plan.error} onRetry={plan.reload} /><div class="panel"><Skeleton rows={8} /></div></div>;
  const p = plan.data;
  // 有還原點才算套用過；所有來源都因規劃後有變更而延後時，沒有還原點
  const applied = !!result?.tag || (!again && p.applied);
  const tag = result?.tag || p.tag;
  const rehearsedOk = rehearsal && rehearsal.editsKey === editsKey && rehearsal.report.ok;
  const nEdits = Object.keys(edits.items).length + Object.keys(edits.names).length + Object.keys(edits.targets).length;
  const adopt = (s, tgt) => setEdits((e) => { const targets = { ...e.targets }; if (tgt) targets[s._k] = tgt; else delete targets[s._k]; return { ...e, targets }; });
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
      toast(r.tag ? t('已匯入 {n} 筆記憶', { n: r.copied }) : t('記憶在產生計畫後有變更，這次沒有匯入'));
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
    try { await api.importUndo(tag); setResult(null); setRehearsal(null); setDialog(null); plan.reload(); refresh(); toast(t('已還原到匯入前')); }
    catch (e) { setErr(e); }
    finally { setBusy(''); }
  };

  if (!p.sources.length && !applied) {
    return <div class="page"><div class="panel"><Empty icon={IconCheckCircle} title={t('沒有需要匯入的記憶')}>{t('Claude Code 預設位置裡的記憶都已經收編。之後若有新的，健康檢查會提醒你收編。')}</Empty></div></div>;
  }
  const tot = view.totals;

  return (
    <div class="page">
      <ol class="steps" aria-label={t('匯入步驟')}>
        {[N_('產生計畫'), N_('檢查與調整'), N_('沙盒演練'), N_('套用'), N_('驗證與還原')].map((s, i) => (
          <li key={s} class={i < step ? 'done' : i === step ? 'now' : ''}><b>{t(s)}</b></li>
        ))}
      </ol>

      <ErrorBanner error={err} />
      {applied && !result && p.lastImport?.failed ? (
        <Banner tone="bad" title={t('上次匯入中途失敗')} actions={<button class="btn sm" disabled={!!busy} onClick={() => setDialog('undo')}><IconUndo />{t('還原到匯入前')}</button>}>
          {t('已完成的部分已經寫入，建議先還原到匯入前，原始記憶會回到匯入前的狀態；之後可以重新產生計畫再試一次。還原點 {tag}。原因：{reason}', { tag: <code>{tag}</code>, reason: local(p.lastImport.failed, 'message') })}
        </Banner>
      ) : applied ? (
        <Banner tone="info" title={t('匯入完成')} actions={<button class="btn sm" disabled={!!busy} onClick={() => setDialog('undo')}><IconUndo />{t('還原到匯入前')}</button>}>
          {t('{summary}還原點 {tag}。原始檔案都還在原位；確認一切正常之前，Engram 不會刪除它們。', {
            summary: result ? t('已匯入 {copied} 筆、略過 {skipped} 筆，綁定 {bound} 個資料夾。', { copied: result.copied, skipped: result.skipped, bound: result.bound }) : p.lastImport ? t('{when}匯入 {copied} 筆、綁定 {bound} 個資料夾。', { when: relTime(p.lastImport.at), copied: p.lastImport.copied, bound: p.lastImport.bound }) : '',
            tag: <code>{tag}</code>,
          })}
          {(result?.backupOnly ?? p.lastImport?.backupOnly) > 0 && ` ${t('略過的 {n} 筆原始檔另外保存在 ~/.engram/local/backups。', { n: result?.backupOnly ?? p.lastImport?.backupOnly })}`}
        </Banner>
      ) : (
        <Banner tone="info" title={t('這只是計畫，還沒有動到任何檔案')}>
          {t('請先展開各來源檢查每一筆的去處，需要時調整範圍或略過；接著執行「沙盒演練」，用你的記憶複本完整跑一次匯入與還原。演練通過後才能套用。')}
        </Banner>
      )}

      {changed.length > 0 && (
        <Banner tone="warn" title={t('有 {n} 個資料夾這次沒有匯入', { n: changed.length })} actions={<button class="btn sm" disabled={!!busy} onClick={replan}>{t('重新產生計畫')}</button>}>
          {t('{paths}。產生計畫之後，這些資料夾又有新的或改過的記憶；為了只匯入你檢查過的內容，這次先跳過。重新產生計畫並檢查後，再套用一次即可。', { paths: changed.map((d) => d.path).join(t('、')) })}
        </Banner>
      )}
      {later.length > 0 && (
        <Banner tone="info" title={t('有 {n} 個資料夾稍後才會接上', { n: later.length })}>
          {t('{paths}。記憶已經匯入；這些資料夾正有對話在使用或檔案被占用，對話結束後常駐程式會自動接上，不需要再操作。', { paths: later.map((d) => d.path).join(t('、')) })}
        </Banner>
      )}
      {applied && !result && !p.lastImport?.failed && p.sources.length > 0 && (
        <Banner tone="warn" title={t('還有 {n} 個資料夾的記憶尚未匯入', { n: p.sources.length })} actions={<button class="btn sm" disabled={!!busy} onClick={replan}>{t('為這些資料夾產生計畫')}</button>}>
          {t('可能是上次匯入時延後的資料夾，或之後才寫的記憶。產生新的計畫並檢查後，可以再匯入一次；上次的匯入不受影響。')}
        </Banner>
      )}
      <div class="grid cols-4">
        <Tile label={t('既有記憶')} value={tot.memories} foot={t('來自 {n} 個資料夾', { n: tot.sources })} />
        <Tile label={applied ? t('已匯入') : t('將匯入')} value={result?.copied ?? tot.copy} foot={t('略過 {n} 筆重複或舊版本', { n: result?.skipped ?? tot.skip })} />
        <Tile label={t('全域／單機')} value={t('{global}／{machine}', { global: tot.global || 0, machine: tot.machine || 0 })} foot={indexRoom !== null ? `${t('全域索引可列 {n} 筆', { n: indexRoom })}${(tot.global || 0) > indexRoom ? t('，超出的 {n} 筆只能用搜尋找到', { n: (tot.global || 0) - indexRoom }) : ''}` : t('其餘 {n} 筆留在專案', { n: tot.project || 0 })} />
        <Tile label={applied ? t('已綁定的資料夾') : t('將綁定的資料夾')} value={result?.bound ?? p.lastImport?.bound ?? bindCount} foot={t('另有 {n} 個原資料夾已不存在，記憶存入封存專案', { n: tot.archived })} />
      </div>

      {!applied && (
        <Section title={t('沙盒演練')} sub={t('複製你的記憶到暫存資料夾，完整跑一次匯入、驗證與還原，不碰真實環境')} end={
          <button class="btn" disabled={!!busy} onClick={doRehearse}><IconPlay class={busy === 'rehearse' ? 'spin' : ''} />{busy === 'rehearse' ? t('演練中…') : rehearsal ? t('重新演練') : t('開始演練')}</button>
        }>
          <div class="panel-body">
            {!rehearsal ? <p class="muted" style={{ fontSize: 13 }}>{t('大約需要 20 秒。演練會檢查四件事：每一筆都有去處；用正式的「還原到匯入前」還原後，記憶庫與匯入前一致；你真實的記憶檔一個位元都沒有被改動；以及用合成資料測試資料夾綁定的還原。')}</p> : (
              <div style={{ display: 'grid', gap: 12 }}>
                {rehearsal.editsKey !== editsKey && <Banner tone="warn" title={t('調整內容在演練後有變更')}>{t('請重新演練，確認新的調整也能正確匯入與還原。')}</Banner>}
                <div class="rows" style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
                  <Check ok={rehearsal.report.accounting.ok} label={t('每一筆都有去處')} detail={t('計畫匯入 {planned} 筆，沙盒 vault 實際有 {actual} 筆（全域 {global}、單機 {machine}、專案 {project}）', { planned: rehearsal.report.accounting.copyPlanned, actual: rehearsal.report.accounting.vaultMemoryFiles, global: rehearsal.report.accounting.byScope.global, machine: rehearsal.report.accounting.byScope.machine, project: rehearsal.report.accounting.byScope.project })} />
                  <Check ok={rehearsal.report.restore.ok} label={t('還原到匯入前：記憶庫端（與正式還原同一套程式）')}
                    detail={rehearsal.report.restore.ok ? t('還原 {n} 個變更後，記憶庫與還原點零差異，沙盒中的原始記憶逐檔一致', { n: rehearsal.report.restore.reverted }) : t('仍有差異：{diff}', { diff: rehearsal.report.restore.remainingDiff || t('{n} 個原始記憶檔不同', { n: rehearsal.report.restore.legacyChanged?.length ?? 0 }) })} />
                  <Check ok={rehearsal.report.realUntouched.ok} label={t('真實記憶完全沒有被改動')} detail={t('演練前後比對每個原始記憶檔的 SHA-256')} />
                  {rehearsal.report.selfTest && (
                    <Check ok={rehearsal.report.selfTest.ok} label={t('還原到匯入前：資料夾綁定（合成資料自我測試）')}
                      detail={rehearsal.report.selfTest.ok
                        ? t('{n} 項檢查全部通過。演練不會在你的資料夾建立綁定，所以用合成的專案資料夾驗證 junction、撞名資料夾的設定檔綁定、匯入後的修改，以及 settings.json 與專案資料夾都回到匯入前', { n: rehearsal.report.selfTest.checks.length })
                        : t('未通過：{checks}', { checks: rehearsal.report.selfTest.checks.filter((c) => !c.ok).map((c) => local(c, 'name') + (c.detail ? t('（{text}）', { text: local(c, 'detail') }) : '')).join(t('、')) })} />
                  )}
                </div>
                {rehearsal.report.health?.length > 0 && (
                  <p class="muted" style={{ fontSize: 13 }}>{t('匯入後的健康檢查會提出 {n} 項建議（例如可能重複、檔案過大），匯入後可以在收件匣逐一處理。', { n: rehearsal.report.health.length })}</p>
                )}
                <span class="faint" style={{ fontSize: 12 }}>{t('用時 {n} 秒', { n: (rehearsal.report.ms / 1000).toFixed(1) })}</span>
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title={t('匯入計畫')} sub={nEdits ? t('你已調整 {n} 處', { n: nEdits }) : t('展開來源可逐筆調整範圍，或取消勾選略過')} end={
        !applied && (
          <button class="btn primary" disabled={!rehearsedOk || !!busy} title={rehearsedOk ? '' : t('先完成沙盒演練')} onClick={() => setDialog('apply')}><IconImport />{t('套用計畫')}</button>
        )
      }>
        <div class="panel-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', paddingBlock: 10 }}>
          <div class="seg" role="group" aria-label={t('顯示')}>
            <button aria-pressed={srcFilter === 'all'} onClick={() => setSrcFilter('all')}>{t('全部來源')}<span class="n">{view.sources.length}</span></button>
            <button aria-pressed={srcFilter === 'attention'} onClick={() => setSrcFilter('attention')}>{t('需要注意')}<span class="n">{view.sources.filter(needsLook).length}</span></button>
          </div>
          <button class="btn sm ghost" onClick={() => setOpen(Object.fromEntries(view.sources.map((s) => [s._k, true])))}>{t('全部展開')}</button>
          <button class="btn sm ghost" onClick={() => setOpen({})}>{t('全部收合')}</button>
          <span class="faint" style={{ fontSize: 12 }}>{t('「需要注意」：原資料夾已不存在、有建議、建議合併，或範圍是全域／單機的來源')}</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th style={{ width: 28 }}><span class="sr-only">{t('展開')}</span></th><th>{t('來源')}</th><th>{t('判斷方式')}</th><th>{t('匯入到')}</th><th class="num">{t('匯入／全部')}</th></tr></thead>
            <tbody>
              {view.sources.filter((s) => srcFilter === 'all' || needsLook(s)).map((s) => {
                const isOpen = open[s._k];
                const copy = s.items.filter((i) => !SKIP.has(i.action)).length;
                const edited = s.items.some((i) => i.edited) || edits.names[s._k] || edits.targets[s._k];
                return (
                  <Fragment key={s._k}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setOpen({ ...open, [s._k]: !isOpen })}>
                      <td><button class="expander" aria-expanded={!!isOpen} aria-label={isOpen ? t('收合 {path}', { path: s.resolvedPath || s.encoded }) : t('展開 {path}', { path: s.resolvedPath || s.encoded })} onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [s._k]: !isOpen }); }}>{isOpen ? <IconChevronDown style={{ width: 16, height: 16 }} /> : <IconChevronRight style={{ width: 16, height: 16 }} />}</button></td>
                      <td>
                        <div class="path" style={{ color: 'var(--text)' }}>{s.resolvedPath || t('（原資料夾路徑無法還原）')}</div>
                        <div class="mono faint" style={{ fontSize: 11 }}>{s.encoded}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{s.exists ? <span class="chip ok">{t('資料夾存在')}</span> : <span class="chip warn">{t('資料夾已不存在')}</span>}<div class="faint" style={{ marginTop: 4 }}>{HOW[s.how] ? t(HOW[s.how]) : null}</div></td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {s.target.archived ? <IconArchive style={{ width: 15, height: 15, color: 'var(--text-3)' }} /> : <IconFolder style={{ width: 15, height: 15, color: 'var(--text-2)' }} />}
                          <b style={{ fontWeight: 600 }}>{s.target.name}</b>
                          {s.target.archived && !keepsProject(s) ? <span class="chip" title={t('原資料夾已不存在，記憶都進了全域或單機（或被略過），不另外建立空的封存專案')}>{t('不建立專案')}</span>
                            : s.target.archived ? <span class="chip">{t('封存專案')}</span> : s.target.isNew ? <span class="chip brand">{t('新專案')}</span> : <span class="chip">{t('既有專案')}</span>}
                          {edited && <span class="chip warn">{t('已調整')}</span>}
                        </span>
                      </td>
                      <td class="num">{copy} / {s.items.length}</td>
                    </tr>
                    {isOpen && !applied && s.suggestions?.length > 0 && (
                      <tr style={{ background: 'var(--panel-2)' }}>
                        <td />
                        <td colSpan="4">
                          <div style={{ display: 'grid', gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>{t('Engram 找到可能是同一個專案的位置（不會自動採用）')}</span>
                            {s.suggestions.map((sg, i) => {
                              const tgt = sg.kind === 'project' ? { pid: sg.pid } : sg.kind === 'source' ? { sameAs: sg.sameAs } : { path: sg.path };
                              const on = JSON.stringify(edits.targets[s._k] || null) === JSON.stringify(tgt);
                              return (
                                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                                  <span class="chip">{sg.kind === 'project' ? t('既有專案') : sg.kind === 'source' ? t('這次匯入的資料夾') : t('桌面上的資料夾')}</span>
                                  <span class="path" style={{ color: 'var(--text)' }}>{sg.name || sg.path}</span>
                                  <span class="faint" style={{ fontSize: 12 }}>{local(sg, 'reason')}</span>
                                  <button class={`btn sm${on ? '' : ' primary'}`} onClick={(e) => { e.stopPropagation(); adopt(s, on ? null : tgt); }}>{on ? t('取消採用') : t('採用')}</button>
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
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>{t('新專案的顯示名稱')}</span>
                            <input class="input" id={`nm-${s._k}`} value={s.target.name} onClick={(e) => e.stopPropagation()} onInput={(e) => setName(s, e.currentTarget.value.trim())} />
                          </label>
                        </td>
                      </tr>
                    )}
                    {isOpen && s.items.map((it) => {
                      const userSkipped = it.edited && SKIP.has(it.action) && !SKIP.has(origOf(s, it).action);
                      const a = userSkipped ? { label: N_('你選擇略過'), cls: '' } : ACTION[it.action] || { label: it.action, cls: '' };
                      const on = !SKIP.has(it.action);
                      return (
                        <tr key={it.file} style={{ background: 'var(--panel-2)' }}>
                          <td>
                            {!applied && <input type="checkbox" id={`it-${s.encoded}-${it.file}`} aria-label={t('匯入 {file}', { file: it.file })} checked={on} onChange={() => toggle(s, it)} />}
                          </td>
                          <td><span class="mono" style={{ fontSize: 12, textDecoration: on ? 'none' : 'line-through', color: on ? 'var(--text)' : 'var(--text-3)' }}>{it.file}</span>{it.description && <div class="muted" style={{ fontSize: 12 }}>{it.description}</div>}<div><TypeLabel type={it.type} /></div></td>
                          <td><span class={`chip ${a.cls}`}>{t(a.label)}</span>{it.edited && <span class="chip warn" style={{ marginLeft: 6 }}>{t('已調整')}</span>}</td>
                          <td>
                            {on && !applied ? (
                              <select class="select" id={`sc-${s.encoded}-${it.file}`} aria-label={t('{file} 的範圍', { file: it.file })} value={it.scope} onChange={(e) => setItem(s, it, { scope: e.currentTarget.value })} style={{ height: 28 }}>
                                <option value="project">{t('專案（只在這個專案載入）')}</option>
                                <option value="global">{t('全域（每個專案都載入索引）')}</option>
                                <option value="machine">{t('單機（只在這台電腦載入）')}</option>
                              </select>
                            ) : <ScopeText scope={it.scope} />}
                            {it.reason && <div class="faint" style={{ fontSize: 12, marginTop: 4 }}>{local(it, 'reason')}{it.dupOf ? t('（{text}）', { text: it.dupOf }) : ''}</div>}
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
        <Dialog title={t('套用匯入計畫？')} desc={t('以下是這次套用會寫入的位置。每一項都記在安裝清單裡，可以完整還原。')} onClose={() => setDialog(null)}
          footer={<><button class="btn" onClick={() => setDialog(null)}>{t('取消')}</button><button class="btn primary" disabled={!!busy} onClick={doApply}>{busy === 'apply' ? t('套用中…') : t('套用')}</button></>}>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8, fontSize: 13 }}>
            <li>{t('{head}複製 {n} 筆記憶（全域 {global}、單機 {machine}、專案 {project}），並建立還原點。', { head: <b>{t('vault：')}</b>, n: tot.copy, global: tot.global || 0, machine: tot.machine || 0, project: tot.project || 0 })}</li>
            <li>{t('{head}{n} 個仍存在的資料夾改以 junction 指向 vault；原本的檔案先備份。', { head: <b>{t('Claude Code 的記憶資料夾：')}</b>, n: bindCount })}</li>
            <li>{t('{head}在 {key} 新增 {n} 筆 junction 路徑，讓 Claude 讀記憶時不跳權限提問。寫入前會備份，只增加 Engram 自己的項目。', { head: <b>{t('你的使用者設定 {file}：', { file: <code>~/.claude/settings.json</code> })}</b>, key: <code>permissions.additionalDirectories</code>, n: bindCount })}</li>
            <li><IconShield style={{ width: 14, height: 14, verticalAlign: -2, color: 'var(--ok)' }} /> {t('原始記憶檔保留不刪；隨時可以「還原到匯入前」。')}</li>
          </ul>
        </Dialog>
      )}
      {dialog === 'undo' && (
        <Dialog title={t('還原到匯入前？')} desc={t('會解除這次匯入建立的綁定（junction 換回實體資料夾），並依序撤銷匯入產生的變更。還原點 {tag}。', { tag })} onClose={() => setDialog(null)}
          footer={<><button class="btn" onClick={() => setDialog(null)}>{t('取消')}</button><button class="btn danger" disabled={!!busy} onClick={doUndo}><IconUndo />{busy === 'undo' ? t('還原中…') : t('還原')}</button></>}>
          <p class="muted" style={{ fontSize: 13 }}>{t('匯入之後你在 Engram 裡做的其他修改（例如編輯、改範圍）會保留在歷史中，不會被刪除。')}</p>
        </Dialog>
      )}
    </div>
  );
}

// 與後端 plan.mjs 的 retarget 規則相同
function retarget(s, tgt) {
  if (!tgt) return s;
  if (tgt.pid) return { ...s, target: { ...s.target, pid: tgt.pid, isNew: false, archived: false } };
  if (tgt.sameAs) return { ...s, target: { ...s.target, sameAs: tgt.sameAs, isNew: false, archived: false, name: s.suggestions?.find((x) => x.sameAs === tgt.sameAs)?.name ?? s.target.name } };
  return { ...s, resolvedPath: tgt.path, exists: true, how: 'suggested', target: { ...s.target, pid: null, isNew: true, archived: false, name: tgt.path.split(/[\\/]/).pop() } };
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
  return <span class="scope"><Icon /><span>{SCOPE[scope] ? t(SCOPE[scope]) : null}</span></span>;
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
    <Section title={t('選用：讓所有電腦共用你的工作準則')} sub={g.data.adopted ? t('已同步') : t('{n} 行', { n: g.data.lines })} end={g.data.adopted
      ? <button class="btn sm" onClick={() => setAsk('revert')}>{t('改回各台電腦自己的版本')}</button>
      : <button class="btn sm primary" onClick={() => setAsk('adopt')}>{t('同步工作準則')}</button>}>
      <div class="panel-body" style={{ display: 'grid', gap: 10 }}>
        <p class="muted" style={{ fontSize: 13 }}>{t('你在 {file} 寫的工作準則目前只存在這台電腦。同步後，內容會搬進 vault 的 {rules}，由 CORE.md 以 {line} 引用；這台的 CLAUDE.md 只保留 Engram 區塊。原檔會先備份，移除 Engram 時會逐字還原。', { file: <code>~/.claude/CLAUDE.md</code>, rules: <code>core/rules/user-guidelines.md</code>, line: <code>{g.data.coreLine}</code> })}</p>
        <details><summary class="faint" style={{ cursor: 'pointer', fontSize: 12 }}>{t('預覽搬移後的內容')}</summary><div class="diff" style={{ marginTop: 8 }}>{g.data.proposed}</div></details>
      </div>
      {ask && (
        <ConfirmDialog title={ask === 'adopt' ? t('同步工作準則？') : t('改回各台電腦自己的版本？')} confirmLabel={ask === 'adopt' ? t('同步') : t('改回')}
          desc={ask === 'adopt' ? t('會修改這台的 ~/.claude/CLAUDE.md（先備份），並在 vault 新增 core/rules/user-guidelines.md。') : t('工作準則會放回這台的 ~/.claude/CLAUDE.md，vault 裡的副本保留在歷史中。')}
          onConfirm={async () => { await act(() => (ask === 'adopt' ? api.adoptGuidelines() : api.revertGuidelines()), ask === 'adopt' ? t('已同步工作準則，下一次對話生效') : t('已改回')); setAsk(null); g.reload(); }} onClose={() => setAsk(null)}>
          <span />
        </ConfirmDialog>
      )}
    </Section>
  );
}
