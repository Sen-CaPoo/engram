// 總覽：先回答「同步了嗎？有什麼要我處理？」，再看最近的記憶與這次對話實際載入了什麼。
import { h } from 'preact';
import { api } from '../api.js';
import { useApp, useData, Section, ScopeLabel, TypeLabel, When, Meter, Banner, Skeleton, Empty, useAction, SevChip } from '../components.jsx';
import { relTime, fmtBytes, attentionCount, since } from '../util.js';
import { IconCheckCircle, IconAlert, IconOctagon, IconSync, IconInbox, IconChevronRight, IconMonitor, IconFile, IconGlobe, IconFolder } from '../icons.jsx';

// 同步是否「真的」都好了：本機成功、沒有待推送、每台電腦近期都同步過、沒有被擋下的檔案（UI-B1）
const STALE_HOURS = 24;
export function syncVerdict(s, attention) {
  const reasons = [];
  const others = s.devices.filter((d) => !d.isSelf);
  const staleDevs = others.filter((d) => !(d.lastSyncAt || d.lastSeenAt) || Date.now() - new Date(d.lastSyncAt || d.lastSeenAt).getTime() > STALE_HOURS * 3600e3);
  const held = s.sync.held || [];
  const probeBad = s.agent?.probe && !s.agent.probe.ok;
  let tone = '';
  let headline;
  if (probeBad) { tone = 'bad'; headline = 'Claude Code 更新後有行為改變，自動化已暫停'; }
  else if (s.sync.state === 'never') { tone = 'warn'; headline = '還沒有完成第一次同步'; reasons.push('記憶都在這台的 vault 裡；設定 GitHub 遠端並完成第一次同步後，其他電腦才看得到。'); }
  else if (s.sync.state === 'auth') { tone = 'warn'; headline = '需要重新登入 GitHub 才能同步'; reasons.push(s.sync.error?.hint || '執行 gh auth login 重新登入 GitHub；如果 git 的認證沒有交給 GitHub CLI，改在 PowerShell 或 Git Bash 執行 git -C "$HOME/.engram/vault" fetch，依提示在瀏覽器登入。'); }
  else if (s.sync.state === 'offline') { tone = 'warn'; headline = '目前連不到 GitHub'; reasons.push(`記憶先存在這台，恢復連線後會自動補同步。上次成功是 ${relTime(s.sync.lastSuccessAt)}。`); }
  else if (s.sync.state === 'error') { tone = 'bad'; headline = `同步失敗：${s.sync.error?.message || '原因不明'}`; if (s.sync.error?.hint) reasons.push(s.sync.error.hint); }
  if (held.length) reasons.push(`有 ${held.length} 個檔案疑似含有金鑰，只留在這台、沒有推送。`);
  for (const d of staleDevs) reasons.push(`「${d.label}」已經 ${since(d.lastSyncAt || d.lastSeenAt)}沒有同步，那台的記憶可能不是最新的。`);
  if (s.sync.ahead > 0 && s.sync.state === 'ok') reasons.push(`有 ${s.sync.ahead} 個變更等待推送，常駐程式會在幾分鐘內處理。`);
  if (!headline) {
    if (attention) { tone = 'warn'; headline = `有 ${attention} 件事需要你處理`; }
    else if (held.length || staleDevs.length) { tone = 'warn'; headline = held.length ? '有檔案沒有同步' : '有電腦很久沒有同步'; }
    else if (s.sync.state === 'syncing') { headline = '正在同步…'; }
    else { headline = others.length ? '所有電腦的記憶都是最新的' : '這台電腦的記憶已同步到 GitHub'; }
  }
  return { tone, headline, reasons, probeBad };
}

export function Overview({ go }) {
  const { status, syncNow } = useApp();
  const inbox = useData(() => Promise.all([api.conflicts(), api.findings()]), []);
  const recent = useData(() => api.memories({ sort: 'updated' }), []);
  const activity = useData(() => api.activity(30), []);
  const loaded = useData(() => api.loaded(), []);
  const history = useData(() => api.history({ limit: 40 }), []);

  if (!status) return <div class="page"><div class="panel"><Skeleton rows={3} /></div></div>;
  const s = status;
  const nAttention = attentionCount(s);
  const v = syncVerdict(s, nAttention);
  const self = s.devices.find((d) => d.isSelf);

  return (
    <div class="page">
      {v.probeBad && (
        <Banner tone="bad" title="相容性探測失敗" actions={<button class="btn sm" onClick={() => go('schedule')}>查看探測結果</button>}>
          Engram 依賴的 Claude Code 行為有 {s.agent.probe.failed.length} 項不符合預期。同步照常進行，但綁定、正規化與收編先暫停，避免改壞檔案。
        </Banner>
      )}

      <section class={`panel status-hero ${v.tone}`} aria-live="polite">
        <div class="mark">{v.tone === 'bad' ? <IconOctagon /> : v.tone === 'warn' ? <IconAlert /> : <IconCheckCircle />}</div>
        <div>
          <h2>{v.headline}</h2>
          <p>上次同步 {relTime(s.sync.lastSuccessAt)} · 這台是「{self?.label}」 · vault 共 {s.counts.total} 筆記憶</p>
          {v.reasons.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--text-2)', display: 'grid', gap: 2 }}>{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
        <div class="btn-row">
          {nAttention > 0 && <button class="btn" onClick={() => go('inbox')}><IconInbox />開啟收件匣</button>}
          {s.sync.state === 'never' && <button class="btn" onClick={() => go('settings')}>設定同步</button>}
          <button class="btn primary" onClick={syncNow} disabled={s.sync.state === 'syncing'}>
            <IconSync class={s.sync.state === 'syncing' ? 'spin' : ''} />{s.sync.state === 'syncing' ? '同步中…' : '立即同步'}
          </button>
        </div>
      </section>

      <div class="grid overview">
        <div class="grid">
          <Section title="需要你處理" sub={nAttention ? `${nAttention} 項` : '目前沒有'} end={<button class="btn sm ghost" onClick={() => go('inbox')}>收件匣<IconChevronRight /></button>}>
            <Attention data={inbox.data} go={go} />
          </Section>

          <Section title="最近記住的事" end={<button class="btn sm ghost" onClick={() => go('library')}>記憶庫<IconChevronRight /></button>}>
            {recent.data ? (
              <div class="rows">
                {recent.data.slice(0, 6).map((m) => (
                  <button class="row" key={m.ref} onClick={() => go('library', { ref: m.ref })}>
                    <span class="title">{m.name}</span>
                    <When at={m.updatedAt} />
                    <span class="desc">{m.description}</span>
                    <span class="meta"><ScopeLabel scope={m.scope} /><TypeLabel type={m.type} /></span>
                  </button>
                ))}
              </div>
            ) : <Skeleton />}
          </Section>

          <Section title="近 30 天的記憶活動" sub="依 vault 的變更紀錄統計">
            <div class="panel-body">
              {activity.data ? <ActivityChart days={activity.data} /> : <Skeleton rows={2} />}
            </div>
          </Section>
        </div>

        <div class="grid">
          <Section title="裝置與同步軌跡" sub="過去 24 小時">
            <div class="panel-body" style={{ display: 'grid', gap: 14 }}>
              <div class="rows" style={{ gap: 10 }}>
                {s.devices.map((d) => (
                  <div key={d.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center' }}>
                    <IconMonitor style={{ width: 18, height: 18, color: d.isSelf ? 'var(--dot)' : 'var(--text-2)' }} />
                    <div>
                      <b style={{ fontWeight: 600 }}>{d.label}</b>{d.isSelf && <span class="chip live" style={{ marginLeft: 8 }}>這台</span>}
                      <div class="faint" style={{ fontSize: 12 }}>{d.id} · Engram {d.engramVersion}</div>
                    </div>
                    <span class="faint" style={{ fontSize: 12, textAlign: 'right' }}>
                      {d.isSelf ? `最後同步 ${relTime(s.sync.lastSuccessAt)}` : <>最後同步 {relTime(d.lastSyncAt || d.lastSeenAt)}<br />上線 {relTime(d.lastSeenAt)}</>}
                    </span>
                  </div>
                ))}
              </div>
              {history.data && <SyncTrail commits={history.data} />}
            </div>
          </Section>

          <Section title="記憶分布">
            <div class="panel-body"><Distribution counts={s.counts} /></div>
          </Section>

          <Section title="最近一次對話載入了什麼" sub={loaded.data ? relTime(loaded.data.at) : ''}>
            <LoadedFiles rec={loaded.data} loading={loaded.loading} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Attention({ data, go }) {
  const act = useAction();
  if (!data) return <Skeleton rows={3} />;
  const [conflicts, findings] = data;
  const items = [
    ...conflicts.map((c) => ({ key: c.id, sev: 'conflict', title: `同步衝突：${c.ref.split('/').pop()}`, detail: c.summary, primary: { label: '處理衝突', run: () => go('inbox', { focus: c.id }) } })),
    ...findings.filter((f) => f.severity === 'high' || f.severity === 'medium').sort((a, b) => rank(a) - rank(b)).map((f) => ({
      key: f.id, sev: f.severity, title: f.title, detail: f.detail, code: f.code,
      primary: f.fix ? { label: f.fix.label, run: () => (DIRECT.has(f.fix.action) ? act(() => api.apply(f.fix), `已${f.fix.label}`) : go('inbox', { focus: f.id })) } : null,
    })),
  ].slice(0, 4);
  if (!items.length) return <Empty icon={IconCheckCircle} title="沒有待處理的事">新的衝突或健康檢查發現會出現在這裡。</Empty>;
  return (
    <div class="rows">
      {items.map((it) => (
        <div class="row" key={it.key} style={{ cursor: 'default', gridTemplateColumns: 'auto minmax(0,1fr) auto' }}>
          <SevChip sev={it.sev} />
          <span class="title">{it.title}</span>
          {it.primary ? <button class="btn sm" onClick={it.primary.run}>{it.primary.label}</button> : <span />}
          <span class="desc" style={{ gridColumn: '2 / -1' }}>{it.detail}</span>
        </div>
      ))}
    </div>
  );
}
const rank = (f) => ({ high: 0, medium: 1, low: 2, auto: 3 }[f.severity]);
// 引擎可以直接完成、不需要再確認內容的動作；其餘一律帶去收件匣處理
const DIRECT = new Set(['move', 'remove', 'sweep', 'normalize', 'sync', 'rebind', 'restore-deletions', 'forget-binding', 'allow-read', 'reconcile-bindings']);

function ActivityChart({ days }) {
  const W = 640, H = 168, L = 28, R = 8, T = 10, B = 26;
  const max = Math.max(4, ...days.map((d) => d.added + d.changed));
  const step = max <= 6 ? 2 : max <= 12 ? 4 : 5;
  const top = Math.ceil(max / step) * step;
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const bw = (W - L - R) / days.length;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const totalAdded = days.reduce((a, d) => a + d.added, 0);
  const totalChanged = days.reduce((a, d) => a + d.changed, 0);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div class="legend">
        <span><i style={{ background: 'var(--brand)' }} />新增 {totalAdded} 筆</span>
        <span><i style={{ background: 'color-mix(in srgb, var(--brand) 38%, var(--panel))' }} />修改 {totalChanged} 次</span>
        <span><i style={{ background: 'var(--dot)', borderRadius: '50%' }} />今天</span>
      </div>
      <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`近 30 天新增 ${totalAdded} 筆、修改 ${totalChanged} 次`}>
        {ticks.map((v) => (
          <g key={v}>
            <line class="grid-line" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text class="axis" x={L - 6} y={y(v) + 4} text-anchor="end">{v}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = L + i * bw + 2, w = Math.max(2, bw - 4);
          const hA = y(0) - y(d.added), hC = y(0) - y(d.changed);
          const isToday = i === days.length - 1;
          const label = `${d.date.slice(5).replace('-', '/')}`;
          return (
            <g key={d.date}>
              <title>{`${label}：新增 ${d.added}、修改 ${d.changed}`}</title>
              {d.added > 0 && <rect class="bar-add" x={x} y={y(d.added)} width={w} height={hA} rx="2" />}
              {d.changed > 0 && <rect class="bar-chg" x={x} y={y(d.added) - hC} width={w} height={hC} rx="2" />}
              {isToday && <circle class="today" cx={x + w / 2} cy={y(0) + 9} r="3.5" />}
              {i % 7 === 0 && <text class="axis" x={x + w / 2} y={H - 4} text-anchor="middle">{label}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function SyncTrail({ commits }) {
  const now = Date.now(), span = 24 * 3600e3;
  const evs = commits.filter((c) => now - new Date(c.at).getTime() < span);
  const pos = (at) => `${100 - ((now - new Date(at).getTime()) / span) * 100}%`;
  return (
    <div>
      <div class="timeline" aria-label={`過去 24 小時有 ${evs.length} 次變更或同步`}>
        <div class="line" />
        {evs.map((c) => (
          <span key={c.sha} class={`ev ${c.action === 'sync' ? 'pull' : ''} ${c.action === 'conflict' ? 'fail' : ''}`} style={{ left: pos(c.at) }} title={`${relTime(c.at)} · ${c.message}`} />
        ))}
        <span class="ev now" style={{ left: '100%' }} title="現在" />
        {[24, 18, 12, 6].map((hAgo) => <span class="tick" key={hAgo} style={{ left: `${100 - (hAgo / 24) * 100}%`, transform: hAgo === 24 ? 'none' : undefined }}>{hAgo} 小時前</span>)}
        <span class="tick" style={{ left: '100%', transform: 'translateX(-100%)' }}>現在</span>
      </div>
      <div class="legend" style={{ marginTop: 4 }}>
        <span><i style={{ background: 'var(--brand)', borderRadius: '50%' }} />同步</span>
        <span><i style={{ border: '2px solid var(--brand)', background: 'var(--panel)', borderRadius: '50%' }} />本機變更</span>
        <span><i style={{ background: 'var(--warn-soft)', border: '2px solid var(--warn)', borderRadius: '50%' }} />衝突</span>
      </div>
    </div>
  );
}

function Distribution({ counts }) {
  const parts = [
    { key: 'global', label: '全域', n: counts.global, color: 'var(--brand)', icon: IconGlobe, hint: '每個專案都看得到' },
    { key: 'project', label: '專案', n: counts.projectMemories, color: 'var(--t-project)', icon: IconFolder, hint: `分屬 ${counts.projects} 個專案` },
    { key: 'machine', label: '單機', n: counts.machine, color: 'var(--scope-machine)', icon: IconMonitor, hint: '只在所屬的電腦載入' },
  ];
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', gap: 2 }} role="img" aria-label={parts.map((p) => `${p.label} ${p.n} 筆`).join('、')}>
        {parts.map((p) => <span key={p.key} style={{ flex: p.n || 0.0001, background: p.color }} />)}
      </div>
      <div class="grid cols-3" style={{ gap: 8 }}>
        {parts.map((p) => (
          <div key={p.key} style={{ display: 'grid', gap: 2 }}>
            <span class="faint" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />{p.label}</span>
            <b class="num" style={{ font: '600 22px/1.2 var(--font-display)' }}>{p.n}</b>
            <span class="faint" style={{ fontSize: 11 }}>{p.hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const KIND_LABEL = { user: '使用者準則', project: '專案準則', local: '本機準則', rule: '規則', import: '匯入', 'memory-index': '記憶索引' };

function LoadedFiles({ rec, loading }) {
  if (loading && !rec) return <Skeleton rows={3} />;
  if (!rec) return <Empty icon={IconFile} title="還沒有紀錄">下一次開啟 Claude Code 後，這裡會列出那次對話實際載入的準則與記憶檔。</Empty>;
  const totalLines = rec.files.reduce((a, f) => a + (f.lines || 0), 0);
  const totalBytes = rec.files.reduce((a, f) => a + (f.bytes || 0), 0);
  const mem = rec.files.find((f) => f.kind === 'memory-index');
  return (
    <div>
      <div class="rows">
        {rec.files.map((f) => (
          <div class="row" key={f.path} style={{ cursor: 'default', gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <span class="title mono" style={{ fontWeight: 500, fontSize: 12 }} title={f.path}>{shortPath(f.path)}</span>
            <span class="when">{f.lines} 行 · {fmtBytes(f.bytes)}</span>
            <span class="meta"><span class="chip">{KIND_LABEL[f.kind] || f.kind}</span>{f.parent && <span>由 {shortPath(f.parent).split('/').pop()} 匯入</span>}</span>
          </div>
        ))}
      </div>
      <div class="panel-body" style={{ display: 'grid', gap: 12, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13 }}>開工時共載入 <b class="num">{totalLines}</b> 行、約 <b class="num">{fmtBytes(totalBytes)}</b>（估計 {Math.round(totalBytes / 3.2).toLocaleString('zh-TW')} tokens）。</div>
        {mem && <Meter label="專案 MEMORY.md（超過 200 行的部分不會載入）" value={mem.lines} max={200} unit=" 行" />}
      </div>
    </div>
  );
}

const shortPath = (p) => p.replace(/^C:\\Users\\[^\\]+\\/i, '~/').replace(/\\/g, '/');
