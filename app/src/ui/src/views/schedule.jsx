// 排程與紀錄：常駐程式是否在跑、每個排程工作的狀態、相容性探測結果，以及日誌。
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Skeleton, Section, Banner, ErrorBanner, useAction } from '../components.jsx';
import { relTime, untilTime, clock } from '../util.js';
import { IconPlay, IconCheck, IconX, IconPower, IconShield } from '../icons.jsx';
import { t, N_, local } from '../i18n.js';

export function Schedule() {
  const { toast, refresh } = useApp();
  const agent = useData(() => api.agent(), []);
  const [level, setLevel] = useState('');
  const logs = useData(() => api.logs({ level, limit: 200 }), [level]);
  const act = useAction();
  const [err, setErr] = useState(null);

  if (!agent.data) return <div class="page"><ErrorBanner error={agent.error} onRetry={agent.reload} /><div class="panel"><Skeleton rows={6} /></div></div>;
  const a = agent.data;
  const run = async (j) => { setErr(null); try { await api.runJob(j.id); toast(t('已開始執行「{label}」', { label: local(j, 'label') })); setTimeout(refresh, 1200); } catch (e) { setErr(e); } };
  const toggle = async (j) => { setErr(null); try { await act(() => api.toggleJob(j.id, !j.enabled)); } catch (e) { setErr(e); } };
  const failed = a.probe?.checks?.filter((c) => !c.ok) || [];

  return (
    <div class="page">
      {a.paused && <Banner tone="bad" title={t('會改寫檔案的自動化已暫停')}>{t('相容性探測有項目失敗。同步照常進行；綁定、正規化與收編會在探測恢復正常後自動繼續。')}</Banner>}
      <ErrorBanner error={err} />

      <div class="grid cols-3">
        <section class="panel stat">
          <span class="label"><IconPower />{t('常駐程式')}</span>
          <span class="value" style={{ color: 'var(--ok)' }}>{t('執行中')}</span>
          <span class="foot">{t('啟動於 {when} · PID {pid} · 連接埠 {port}', { when: relTime(a.startedAt), pid: a.pid, port: a.port })}</span>
        </section>
        <section class="panel stat">
          <span class="label">{t('Windows 登入工作')}</span>
          <span class="value">{a.logonTask.installed ? t('已安裝') : t('未安裝')}</span>
          <span class="foot">{t('{task} · {state} · 啟動器 {launcher}', { task: '\\Engram\\Agent', state: a.logonTask.state ?? '', launcher: a.logonTask.launcher ?? '' })}</span>
        </section>
        <section class="panel stat">
          <span class="label"><IconShield />{t('相容性探測')}</span>
          <span class="value" style={{ color: a.probe?.ok ? 'var(--ok)' : 'var(--danger)' }}>{a.probe?.ok ? t('全部通過') : t('{n} 項失敗', { n: failed.length })}</span>
          <span class="foot">Claude Code {a.probe?.claudeVersion} · {relTime(a.probe?.at)}</span>
        </section>
      </div>

      <Section title={t('排程工作')} sub={t('全部在常駐程式內執行；電腦睡眠後醒來會立即補跑')}>
        <div class="table-wrap">
          <table class="data responsive">
            <thead><tr><th>{t('col::工作')}</th><th>{t('啟用')}</th><th>{t('下次')}</th><th>{t('上次結果')}</th><th><span class="sr-only">{t('動作')}</span></th></tr></thead>
            <tbody>
              {a.jobs.map((j) => (
                <tr key={j.id}>
                  <td data-label={t('col::工作')}><div style={{ fontWeight: 600 }}>{local(j, 'label')}</div><div class="faint" style={{ fontSize: 12 }}>{local(j, 'schedule')}</div></td>
                  <td data-label={t('啟用')}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" id={`job-${j.id}`} checked={j.enabled} onChange={() => toggle(j)} />
                      <span style={{ fontSize: 13 }}>{j.enabled ? t('開') : t('關')}</span>
                    </label>
                  </td>
                  <td data-label={t('下次')} style={{ whiteSpace: 'nowrap' }}>{j.enabled ? (j.nextRunAt ? untilTime(j.nextRunAt) : t('依事件觸發')) : '—'}</td>
                  <td data-label={t('上次結果')}>
                    {j.lastResult ? (
                      <span style={{ display: 'grid', gap: 2 }}>
                        <span><span class={`chip ${j.lastResult.ok ? 'ok' : 'danger'}`}>{j.lastResult.ok ? t('成功') : t('失敗')}</span> <span class="faint" style={{ fontSize: 12 }}>{t('{when} · {n} 秒', { when: relTime(j.lastRunAt), n: (j.lastResult.ms / 1000).toFixed(1) })}</span></span>
                        <span class="muted" style={{ fontSize: 12 }}>{local(j.lastResult, 'note')}</span>
                      </span>
                    ) : <span class="faint">{t('尚未執行')}</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{j.id !== 'watch' && <button class="btn sm" onClick={() => run(j)} disabled={!j.enabled && j.id !== 'curate'}><IconPlay />{t('立即執行')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('相容性探測')} sub={t('Engram 依賴、但官方文件沒有寫明的 Claude Code 行為。版本變更時自動重測')}>
        <div class="rows">
          {(a.probe?.checks || []).map((c) => (
            <div class="row" key={c.id} style={{ cursor: 'default', gridTemplateColumns: 'auto 44px minmax(0,1fr)' }}>
              {c.ok ? <IconCheck style={{ width: 16, height: 16, color: 'var(--ok)' }} /> : <IconX style={{ width: 16, height: 16, color: 'var(--danger)' }} />}
              <span class="mono faint" style={{ fontSize: 12 }}>{c.id}</span>
              <span>{local(c, 'label')}{c.detail && <span class="faint" style={{ display: 'block', fontSize: 12 }}>{local(c, 'detail')}</span>}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('日誌')} sub={t('保留 14 天')} end={
        <div class="seg" role="group" aria-label={t('等級')}>
          {[['', N_('全部')], ['warn', N_('警告')], ['error', N_('錯誤')]].map(([v, l]) => <button key={v} aria-pressed={level === v} onClick={() => setLevel(v)}>{t(l)}</button>)}
        </div>
      }>
        {!logs.data ? <Skeleton rows={6} /> : (
          <div class="log" role="log">
            {logs.data.length === 0 && <div class="faint" style={{ padding: '8px 18px' }}>{t('沒有符合的紀錄。')}</div>}
            {logs.data.map((l, i) => (
              <div class="line" key={i}>
                <span class="faint">{clock(l.at)}</span>
                <span class={`lv lv-${l.level}`}>{l.level === 'warn' ? t('警告') : l.level === 'error' ? t('錯誤') : t('資訊')}</span>
                <span class="src faint">{l.src}</span>
                <span class="msg">{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
