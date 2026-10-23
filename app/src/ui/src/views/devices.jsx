// 裝置與同步：每台電腦的狀態、vault 的遠端資訊，以及完整的變更紀錄（可逐筆復原）。
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Skeleton, Banner, ErrorBanner, useAction, Section, Empty, ConfirmDialog } from '../components.jsx';
import { relTime, SYNC_LABEL, humanizeCommit, undoText } from '../util.js';
import { IconMonitor, IconSync, IconUndo, IconHistory, IconCloud, IconChevronRight } from '../icons.jsx';
import { IMPORT_ACTIONS } from './library.jsx';
import { t, local } from '../i18n.js';

// 同步錯誤：說清楚原因與下一步（M4）
export function SyncErrorBanner({ sync, go, syncNow }) {
  const e = sync.error || {};
  if (sync.state === 'auth') return <Banner tone="warn" title={t('GitHub 登入已過期')} actions={<button class="btn sm" onClick={syncNow}><IconSync />{t('登入後重試')}</button>}>{t('執行 {login} 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 {fetch}，依提示在瀏覽器登入。完成後按「登入後重試」。這段時間記憶照常存在這台。', { login: <code>gh auth login</code>, fetch: <code>git -C "$HOME/.engram/vault" fetch</code> })}</Banner>;
  if (sync.state === 'offline') return <Banner tone="warn" title={t('目前連不到 GitHub')} actions={<button class="btn sm" onClick={syncNow}><IconSync />{t('立即重試')}</button>}>{t('記憶照常寫入這台的 vault，恢復連線後會自動補同步。{hint}', { hint: e.code === 'E_PROXY' ? t('看起來是公司網路的代理設定，請確認 git 的 http.proxy。') : (local(e, 'hint') ?? '') })}</Banner>;
  if (sync.state !== 'error') return null;
  if (e.code === 'E_PUSH_PROTECTED') return <Banner tone="bad" title={t('GitHub 拒絕推送：偵測到疑似金鑰')} actions={<button class="btn sm" onClick={() => go('inbox')}>{t('到收件匣處理')}<IconChevronRight /></button>}>{e.ref ? t('檔案 {ref} 被擋下。在收件匣的「疑似含有金鑰」卡片遮蔽後，其他檔案會照常推送。', { ref: <code>{e.ref}</code> }) : t('在收件匣的「疑似含有金鑰」卡片遮蔽後，其他檔案會照常推送。')}</Banner>;
  return <Banner tone="bad" title={t('同步失敗：{message}', { message: local(e, 'message') || t('原因不明') })} actions={<><button class="btn sm" onClick={syncNow}><IconSync />{t('重試')}</button><button class="btn sm ghost" onClick={() => go('schedule')}>{t('看日誌')}</button></>}>{local(e, 'hint') || t('可以到「排程與紀錄」查看日誌，或在終端機執行 engram doctor 檢查。')}</Banner>;
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
      {s.held?.length > 0 && <Banner tone="warn" title={t('有 {n} 個檔案沒有推送', { n: s.held.length })} actions={<button class="btn sm" onClick={() => go('inbox')}>{t('到收件匣處理')}<IconChevronRight /></button>}>{t('{files} 疑似含有金鑰，只留在這台。', { files: s.held.map((x) => x.ref).join(t('、')) })}</Banner>}

      <div class="grid cols-2">
        {status.devices.map((d) => (
          <section key={d.id} class={`panel device${d.isSelf ? ' self' : ''}`}>
            <header>
              <IconMonitor />
              <h3>{d.label}</h3>
              {d.isSelf ? <span class="chip live">{t('這台')}</span> : <span class="chip">{t('最後同步 {when}', { when: relTime(d.lastSyncAt || d.lastSeenAt) })}</span>}
            </header>
            <dl class="kv">
              <dt>{t('電腦 ID')}</dt><dd class="mono">{d.id}</dd>
              <dt>{t('Engram 版本')}</dt><dd>{d.engramVersion}</dd>
              {d.isSelf ? (
                <>
                  <dt>{t('同步狀態')}</dt><dd><span class={`chip ${s.state === 'ok' ? 'ok' : s.state === 'syncing' || s.state === 'busy' ? 'brand' : 'warn'}`}>{t(SYNC_LABEL[s.state])}</span></dd>
                  <dt>{t('上次成功')}</dt><dd>{relTime(s.lastSuccessAt)}</dd>
                  <dt>{t('等待推送')}</dt><dd class="num">{t('{n} 個變更', { n: s.ahead })}</dd>
                  <dt>{t('其他電腦的新變更')}</dt><dd class="num">{t('changes::{n} 個', { n: s.behind })}</dd>
                  <dt>vault</dt><dd class="mono" style={{ fontSize: 12 }}>{status.vault.path}</dd>
                </>
              ) : (
                <>
                  <dt>{t('最後同步')}</dt><dd>{relTime(d.lastSyncAt || d.lastSeenAt)}</dd>
                  <dt>{t('最後上線')}</dt><dd>{relTime(d.lastSeenAt)}</dd>
                  <dt>{t('寫入範圍')}</dt><dd>{t('只寫自己的 {dir} 與記憶檔，不會互相覆蓋', { dir: <code>machines/{d.id}/</code> })}</dd>
                </>
              )}
            </dl>
            {d.isSelf && (
              <div class="btn-row">
                <button class="btn primary sm" onClick={syncNow} disabled={s.state === 'syncing'}><IconSync class={s.state === 'syncing' ? 'spin' : ''} />{s.state === 'syncing' ? t('同步中…') : t('立即同步')}</button>
                <button class="btn sm ghost" onClick={() => go('settings')}>{t('同步設定')}</button>
              </div>
            )}
          </section>
        ))}
      </div>

      <Section title={t('同步遠端')} end={<span class="chip"><IconCloud />{t('GitHub 私人 repo')}</span>}>
        <div class="panel-body">
          <dl class="kv">
            <dt>{t('遠端')}</dt><dd class="mono">{status.vault.remote || t('尚未設定')}</dd>
            <dt>{t('分支')}</dt><dd class="mono">{status.vault.branch}</dd>
            <dt>{t('目前版本')}</dt><dd class="mono">{status.vault.head}</dd>
            <dt>{t('規則')}</dt><dd>{t('只用 main 分支，不 rebase、不 force push，歷史只增不改。疑似含金鑰的檔案不會推送。')}</dd>
          </dl>
        </div>
      </Section>

      <Section title={t('變更紀錄')} sub={t('每個變更都可以追溯；大部分可以單獨復原')} end={
        <div class="seg" role="group" aria-label={t('依電腦篩選')}>
          <button aria-pressed={who === 'all'} onClick={() => setWho('all')}>{t('全部')}</button>
          {status.devices.map((d) => <button key={d.id} aria-pressed={who === d.id} onClick={() => setWho(d.id)}>{d.label}</button>)}
        </div>
      }>
        <ErrorBanner error={hist.error} onRetry={hist.reload} />
        {!hist.data ? <Skeleton rows={6} /> : commits.length === 0 ? <Empty icon={IconHistory} title={t('沒有紀錄')} /> : (
          <div class="table-wrap">
            <table class="data responsive">
              <thead><tr><th>{t('時間')}</th><th>{t('電腦')}</th><th>{t('變更')}</th><th><span class="sr-only">{t('復原')}</span></th></tr></thead>
              <tbody>
                {commits.map((c) => {
                  const hc = humanizeCommit(c);
                  const isImport = IMPORT_ACTIONS.has(c.action) || c.importTag;
                  const names = c.refs.slice(0, 2).map((r) => r.split('/').pop()).join(t('、'));
                  return (
                    <tr key={c.sha}>
                      <td data-label={t('時間')} style={{ whiteSpace: 'nowrap' }}>{relTime(c.at)}</td>
                      <td data-label={t('電腦')} style={{ whiteSpace: 'nowrap' }}>{devName(c.machine)}</td>
                      <td data-label={t('變更')}>
                        <div><b style={{ fontWeight: 600 }}>{hc.title}</b>{hc.detail && <span class="muted">　{hc.detail}</span>}</div>
                        {c.refs.length > 0 && <div class="faint" style={{ fontSize: 12 }}>{c.refs.length > 2 ? t('{names} 等 {n} 個檔案', { names, n: c.refs.length }) : names}</div>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {isImport ? <button class="btn sm ghost" onClick={() => go('import')}>{t('到匯入頁還原')}</button>
                          : c.undoable ? <button class="btn sm ghost" onClick={() => setConfirm(c)}><IconUndo />{t('復原')}</button> : null}
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
        <ConfirmDialog title={t('復原這個變更？')} desc={t('「{title}」（{device} · {when}）會被撤銷，並產生一筆新的紀錄同步到其他電腦；之後仍可再復原。', { title: humanizeCommit(confirm).title, device: devName(confirm.machine), when: relTime(confirm.at) })} confirmLabel={t('復原')}
          onConfirm={async () => { await act(() => api.undo(confirm.sha), (r) => undoText(r, t('已復原這個變更'))); setConfirm(null); }} onClose={() => setConfirm(null)}>
          {confirm.refs?.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{confirm.refs.map((r) => <code key={r}>{r}</code>)}</div>}
        </ConfirmDialog>
      )}
    </div>
  );
}
