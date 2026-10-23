// 裝置與同步：每台電腦的狀態、vault 的遠端資訊，以及完整的變更紀錄（可逐筆復原）。
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Skeleton, Banner, ErrorBanner, useAction, Section, Empty, ConfirmDialog } from '../components.jsx';
import { relTime, SYNC_LABEL, humanizeCommit, undoText } from '../util.js';
import { IconMonitor, IconSync, IconUndo, IconHistory, IconCloud, IconChevronRight } from '../icons.jsx';
import { IMPORT_ACTIONS } from './library.jsx';

// 同步錯誤：說清楚原因與下一步（M4）
export function SyncErrorBanner({ sync, go, syncNow }) {
  const e = sync.error || {};
  if (sync.state === 'auth') return <Banner tone="warn" title="GitHub 登入已過期" actions={<button class="btn sm" onClick={syncNow}><IconSync />登入後重試</button>}>執行 <code>gh auth login</code> 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 <code>git -C "$HOME/.engram/vault" fetch</code>，依提示在瀏覽器登入。完成後按「登入後重試」。這段時間記憶照常存在這台。</Banner>;
  if (sync.state === 'offline') return <Banner tone="warn" title="目前連不到 GitHub" actions={<button class="btn sm" onClick={syncNow}><IconSync />立即重試</button>}>記憶照常寫入這台的 vault，恢復連線後會自動補同步。{e.code === 'E_PROXY' ? '看起來是公司網路的代理設定，請確認 git 的 http.proxy。' : e.hint}</Banner>;
  if (sync.state !== 'error') return null;
  if (e.code === 'E_PUSH_PROTECTED') return <Banner tone="bad" title="GitHub 拒絕推送：偵測到疑似金鑰" actions={<button class="btn sm" onClick={() => go('inbox')}>到收件匣處理<IconChevronRight /></button>}>{e.ref ? <>檔案 <code>{e.ref}</code> 被擋下。</> : null}在收件匣的「疑似含有金鑰」卡片遮蔽後，其他檔案會照常推送。</Banner>;
  return <Banner tone="bad" title={`同步失敗：${e.message || '原因不明'}`} actions={<><button class="btn sm" onClick={syncNow}><IconSync />重試</button><button class="btn sm ghost" onClick={() => go('schedule')}>看日誌</button></>}>{e.hint || '可以到「排程與紀錄」查看日誌，或在終端機執行 engram doctor 檢查。'}</Banner>;
}

export function Devices({ go }) {
  const { status, syncNow } = useApp();
  const hist = useData(() => api.history({ limit: 60 }), []);
  const act = useAction();
  const [who, setWho] = useState('all');
  const [confirm, setConfirm] = useState(null);
  if (!status) return <div class="page"><Skeleton rows={6} /></div>;
  const s = status.sync;
  const devName = (id) => status.devices.find((d) => d.id === id)?.label || id;
  const commits = (hist.data || []).filter((c) => who === 'all' || c.machine === who);

  return (
    <div class="page">
      <SyncErrorBanner sync={s} go={go} syncNow={syncNow} />
      {s.held?.length > 0 && <Banner tone="warn" title={`有 ${s.held.length} 個檔案沒有推送`} actions={<button class="btn sm" onClick={() => go('inbox')}>到收件匣處理<IconChevronRight /></button>}>{s.held.map((x) => x.ref).join('、')} 疑似含有金鑰，只留在這台。</Banner>}

      <div class="grid cols-2">
        {status.devices.map((d) => (
          <section key={d.id} class={`panel device${d.isSelf ? ' self' : ''}`}>
            <header>
              <IconMonitor />
              <h3>{d.label}</h3>
              {d.isSelf ? <span class="chip live">這台</span> : <span class="chip">最後同步 {relTime(d.lastSyncAt || d.lastSeenAt)}</span>}
            </header>
            <dl class="kv">
              <dt>電腦 ID</dt><dd class="mono">{d.id}</dd>
              <dt>Engram 版本</dt><dd>{d.engramVersion}</dd>
              {d.isSelf ? (
                <>
                  <dt>同步狀態</dt><dd><span class={`chip ${s.state === 'ok' ? 'ok' : s.state === 'syncing' ? 'brand' : 'warn'}`}>{SYNC_LABEL[s.state]}</span></dd>
                  <dt>上次成功</dt><dd>{relTime(s.lastSuccessAt)}</dd>
                  <dt>等待推送</dt><dd class="num">{s.ahead} 個變更</dd>
                  <dt>其他電腦的新變更</dt><dd class="num">{s.behind} 個</dd>
                  <dt>vault</dt><dd class="mono" style={{ fontSize: 12 }}>{status.vault.path}</dd>
                </>
              ) : (
                <>
                  <dt>最後同步</dt><dd>{relTime(d.lastSyncAt || d.lastSeenAt)}</dd>
                  <dt>最後上線</dt><dd>{relTime(d.lastSeenAt)}</dd>
                  <dt>寫入範圍</dt><dd>只寫自己的 <code>machines/{d.id}/</code> 與記憶檔，不會互相覆蓋</dd>
                </>
              )}
            </dl>
            {d.isSelf && (
              <div class="btn-row">
                <button class="btn primary sm" onClick={syncNow} disabled={s.state === 'syncing'}><IconSync class={s.state === 'syncing' ? 'spin' : ''} />{s.state === 'syncing' ? '同步中…' : '立即同步'}</button>
                <button class="btn sm ghost" onClick={() => go('settings')}>同步設定</button>
              </div>
            )}
          </section>
        ))}
      </div>

      <Section title="同步遠端" end={<span class="chip"><IconCloud />GitHub 私人 repo</span>}>
        <div class="panel-body">
          <dl class="kv">
            <dt>遠端</dt><dd class="mono">{status.vault.remote || '尚未設定'}</dd>
            <dt>分支</dt><dd class="mono">{status.vault.branch}</dd>
            <dt>目前版本</dt><dd class="mono">{status.vault.head}</dd>
            <dt>規則</dt><dd>只用 main 分支，不 rebase、不 force push，歷史只增不改。疑似含金鑰的檔案不會推送。</dd>
          </dl>
        </div>
      </Section>

      <Section title="變更紀錄" sub="每個變更都可以追溯；大部分可以單獨復原" end={
        <div class="seg" role="group" aria-label="依電腦篩選">
          <button aria-pressed={who === 'all'} onClick={() => setWho('all')}>全部</button>
          {status.devices.map((d) => <button key={d.id} aria-pressed={who === d.id} onClick={() => setWho(d.id)}>{d.label}</button>)}
        </div>
      }>
        <ErrorBanner error={hist.error} onRetry={hist.reload} />
        {!hist.data ? <Skeleton rows={6} /> : commits.length === 0 ? <Empty icon={IconHistory} title="沒有紀錄" /> : (
          <div class="table-wrap">
            <table class="data responsive">
              <thead><tr><th>時間</th><th>電腦</th><th>變更</th><th><span class="sr-only">復原</span></th></tr></thead>
              <tbody>
                {commits.map((c) => {
                  const hc = humanizeCommit(c);
                  const isImport = IMPORT_ACTIONS.has(c.action) || c.importTag;
                  return (
                    <tr key={c.sha}>
                      <td data-label="時間" style={{ whiteSpace: 'nowrap' }}>{relTime(c.at)}</td>
                      <td data-label="電腦" style={{ whiteSpace: 'nowrap' }}>{devName(c.machine)}</td>
                      <td data-label="變更">
                        <div><b style={{ fontWeight: 600 }}>{hc.title}</b>{hc.detail && <span class="muted">　{hc.detail}</span>}</div>
                        {c.refs.length > 0 && <div class="faint" style={{ fontSize: 12 }}>{c.refs.slice(0, 2).map((r) => r.split('/').pop()).join('、')}{c.refs.length > 2 ? ` 等 ${c.refs.length} 個檔案` : ''}</div>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {isImport ? <button class="btn sm ghost" onClick={() => go('import')}>到匯入頁還原</button>
                          : c.undoable ? <button class="btn sm ghost" onClick={() => setConfirm(c)}><IconUndo />復原</button> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {confirm && (
        <ConfirmDialog title="復原這個變更？" desc={`「${humanizeCommit(confirm).title}」（${devName(confirm.machine)} · ${relTime(confirm.at)}）會被撤銷，並產生一筆新的紀錄同步到其他電腦；之後仍可再復原。`} confirmLabel="復原"
          onConfirm={async () => { await act(() => api.undo(confirm.sha), (r) => undoText(r, '已復原這個變更')); setConfirm(null); }} onClose={() => setConfirm(null)}>
          {confirm.refs?.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{confirm.refs.map((r) => <code key={r}>{r}</code>)}</div>}
        </ConfirmDialog>
      )}
    </div>
  );
}
