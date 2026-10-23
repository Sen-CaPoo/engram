// 排程與紀錄：常駐程式是否在跑、每個排程工作的狀態、相容性探測結果，以及日誌。
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Skeleton, Section, Banner, ErrorBanner, useAction } from '../components.jsx';
import { relTime, untilTime, clock } from '../util.js';
import { IconPlay, IconCheck, IconX, IconPower, IconShield } from '../icons.jsx';

export function Schedule() {
  const { toast, refresh } = useApp();
  const agent = useData(() => api.agent(), []);
  const [level, setLevel] = useState('');
  const logs = useData(() => api.logs({ level, limit: 200 }), [level]);
  const act = useAction();
  const [err, setErr] = useState(null);

  if (!agent.data) return <div class="page"><ErrorBanner error={agent.error} onRetry={agent.reload} /><div class="panel"><Skeleton rows={6} /></div></div>;
  const a = agent.data;
  const run = async (j) => { setErr(null); try { await api.runJob(j.id); toast(`已開始執行「${j.label}」`); setTimeout(refresh, 1200); } catch (e) { setErr(e); } };
  const toggle = async (j) => { setErr(null); try { await act(() => api.toggleJob(j.id, !j.enabled)); } catch (e) { setErr(e); } };
  const failed = a.probe?.checks?.filter((c) => !c.ok) || [];

  return (
    <div class="page">
      {a.paused && <Banner tone="bad" title="會改寫檔案的自動化已暫停">相容性探測有項目失敗。同步照常進行；綁定、正規化與收編會在探測恢復正常後自動繼續。</Banner>}
      <ErrorBanner error={err} />

      <div class="grid cols-3">
        <section class="panel stat">
          <span class="label"><IconPower />常駐程式</span>
          <span class="value" style={{ color: 'var(--ok)' }}>執行中</span>
          <span class="foot">啟動於 {relTime(a.startedAt)} · PID {a.pid} · 連接埠 {a.port}</span>
        </section>
        <section class="panel stat">
          <span class="label">Windows 登入工作</span>
          <span class="value">{a.logonTask.installed ? '已安裝' : '未安裝'}</span>
          <span class="foot">\Engram\Agent · {a.logonTask.state} · 啟動器 {a.logonTask.launcher}</span>
        </section>
        <section class="panel stat">
          <span class="label"><IconShield />相容性探測</span>
          <span class="value" style={{ color: a.probe?.ok ? 'var(--ok)' : 'var(--danger)' }}>{a.probe?.ok ? '全部通過' : `${failed.length} 項失敗`}</span>
          <span class="foot">Claude Code {a.probe?.claudeVersion} · {relTime(a.probe?.at)}</span>
        </section>
      </div>

      <Section title="排程工作" sub="全部在常駐程式內執行；電腦睡眠後醒來會立即補跑">
        <div class="table-wrap">
          <table class="data responsive">
            <thead><tr><th>工作</th><th>啟用</th><th>下次</th><th>上次結果</th><th><span class="sr-only">動作</span></th></tr></thead>
            <tbody>
              {a.jobs.map((j) => (
                <tr key={j.id}>
                  <td data-label="工作"><div style={{ fontWeight: 600 }}>{j.label}</div><div class="faint" style={{ fontSize: 12 }}>{j.schedule}</div></td>
                  <td data-label="啟用">
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" id={`job-${j.id}`} checked={j.enabled} onChange={() => toggle(j)} />
                      <span style={{ fontSize: 13 }}>{j.enabled ? '開' : '關'}</span>
                    </label>
                  </td>
                  <td data-label="下次" style={{ whiteSpace: 'nowrap' }}>{j.enabled ? (j.nextRunAt ? untilTime(j.nextRunAt) : '依事件觸發') : '—'}</td>
                  <td data-label="上次結果">
                    {j.lastResult ? (
                      <span style={{ display: 'grid', gap: 2 }}>
                        <span><span class={`chip ${j.lastResult.ok ? 'ok' : 'danger'}`}>{j.lastResult.ok ? '成功' : '失敗'}</span> <span class="faint" style={{ fontSize: 12 }}>{relTime(j.lastRunAt)} · {(j.lastResult.ms / 1000).toFixed(1)} 秒</span></span>
                        <span class="muted" style={{ fontSize: 12 }}>{j.lastResult.note}</span>
                      </span>
                    ) : <span class="faint">尚未執行</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{j.id !== 'watch' && <button class="btn sm" onClick={() => run(j)} disabled={!j.enabled && j.id !== 'curate'}><IconPlay />立即執行</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="相容性探測" sub="Engram 依賴、但官方文件沒有寫明的 Claude Code 行為。版本變更時自動重測">
        <div class="rows">
          {(a.probe?.checks || []).map((c) => (
            <div class="row" key={c.id} style={{ cursor: 'default', gridTemplateColumns: 'auto 44px minmax(0,1fr)' }}>
              {c.ok ? <IconCheck style={{ width: 16, height: 16, color: 'var(--ok)' }} /> : <IconX style={{ width: 16, height: 16, color: 'var(--danger)' }} />}
              <span class="mono faint" style={{ fontSize: 12 }}>{c.id}</span>
              <span>{c.label}{c.detail && <span class="faint" style={{ display: 'block', fontSize: 12 }}>{c.detail}</span>}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="日誌" sub="保留 14 天" end={
        <div class="seg" role="group" aria-label="等級">
          {[['', '全部'], ['warn', '警告'], ['error', '錯誤']].map(([v, l]) => <button key={v} aria-pressed={level === v} onClick={() => setLevel(v)}>{l}</button>)}
        </div>
      }>
        {!logs.data ? <Skeleton rows={6} /> : (
          <div class="log" role="log">
            {logs.data.length === 0 && <div class="faint" style={{ padding: '8px 18px' }}>沒有符合的紀錄。</div>}
            {logs.data.map((l, i) => (
              <div class="line" key={i}>
                <span class="faint">{clock(l.at)}</span>
                <span class={`lv lv-${l.level}`}>{l.level === 'warn' ? '警告' : l.level === 'error' ? '錯誤' : '資訊'}</span>
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
