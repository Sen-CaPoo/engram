// 專案：每個專案在各台電腦的位置、綁定方式、記憶量與 MEMORY.md 的載入預算。
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { useApp, useData, Empty, Skeleton, Meter, Dialog, ErrorBanner, useAction, When } from '../components.jsx';
import { relTime, fmtBytes } from '../util.js';
import { IconFolder, IconChevronDown, IconChevronRight, IconCheck, IconAlert, IconEdit, IconLibrary, IconLink, IconArchive, IconSparkle } from '../icons.jsx';
import { t, N_ } from '../i18n.js';

export function Projects({ go, params = {} }) {
  const { status } = useApp();
  const data = useData(() => api.projects(), []);
  const pending = useData(() => api.pendingBinds(), []);
  const act = useAction();
  const [filter, setFilter] = useState(params.focus ? 'all' : 'active');
  const [open, setOpen] = useState(params.focus || null);
  const [dialog, setDialog] = useState(null);
  // 從其他頁面帶著 focus 進來時，展開該專案並捲動到它
  useEffect(() => {
    if (!params.focus) return;
    setFilter('all'); setOpen(params.focus);
    setTimeout(() => document.getElementById(`pj-${params.focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  }, [params.focus, data.data]);

  if (!data.data) return <div class="page"><ErrorBanner error={data.error} onRetry={data.reload} /><div class="panel"><Skeleton rows={8} /></div></div>;
  const self = status?.devices?.find((d) => d.isSelf);
  const others = status?.devices?.filter((d) => !d.isSelf) || [];
  const all = data.data;
  const problem = (p) => p.counts.findings > 0 || Object.values(p.paths).some((x) => !x.exists) || (p.index?.lines || 0) >= 150;
  const list = all.filter((p) => (filter === 'all' ? true : filter === 'active' ? !p.archived : filter === 'archived' ? p.archived : problem(p)))
    .sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));

  return (
    <div class="page">
      <div class="filters">
        <div class="seg" role="group" aria-label={t('篩選')}>
          <button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>{t('使用中')}<span class="n">{all.filter((p) => !p.archived).length}</span></button>
          <button aria-pressed={filter === 'problem'} onClick={() => setFilter('problem')}>{t('需要注意')}<span class="n">{all.filter(problem).length}</span></button>
          <button aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>{t('已封存')}<span class="n">{all.filter((p) => p.archived).length}</span></button>
        </div>
        <span class="faint" style={{ fontSize: 13 }}>{t('專案用固定 ID 識別，資料夾搬家或改名都不影響記憶。')}</span>
      </div>

      {pending.data?.length > 0 && (
        <section class="panel">
          <div class="panel-head"><h2>{t('等待接上的資料夾')}</h2><span class="sub">{t('folders::{n} 個', { n: pending.data.length })}</span></div>
          <div class="rows">
            {pending.data.map((b) => (
              <div class="row" key={b.path} style={{ cursor: 'default' }}>
                <span class="title path">{b.path}</span>
                {b.reason === 'changed-since-plan'
                  ? <button class="btn sm" onClick={() => go('import')}>{t('重新產生匯入計畫')}</button>
                  : <button class="btn sm primary" onClick={() => act(() => api.bind(b.path, { pid: b.pid }), t('已接上，下一次對話生效'))}>{t('接上')}</button>}
                <span class="desc">{b.reason === 'ask' ? t('已認出是「{name}」，依你的設定等待確認。', { name: all.find((p) => p.pid === b.pid)?.name ?? b.pid })
                  : b.reason === 'changed-since-plan' ? t('匯入計畫產生後，這個資料夾又有新的或改過的記憶。請重新產生計畫並檢查，套用後才會接上。')
                  : t('對話結束後會自動接上；也可以現在接上。')}{b.since ? ' · ' + relTime(b.since) : ''}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section class="panel">
        <div class="table-wrap">
          <table class="data responsive">
            <thead>
              <tr>
                <th style={{ width: 28 }}><span class="sr-only">{t('展開')}</span></th>
                <th style={{ minWidth: 220 }}>{t('專案')}</th>
                <th>{t('這台（{label}）的位置', { label: self?.label })}</th>
                <th>{t('其他電腦')}</th>
                <th class="num">{t('col::記憶')}</th>
                <th style={{ minWidth: 160 }}>{t('MEMORY.md 載入預算')}</th>
                <th>{t('最近活動')}</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan="7"><Empty icon={IconFolder} title={t('這裡沒有專案')}>{filter === 'problem' ? t('所有專案都正常。') : t('在任何資料夾開啟 Claude Code 並留下記憶，就會自動建立專案。')}</Empty></td></tr>}
              {list.map((p) => {
                const here = p.paths[self?.id];
                const isOpen = open === p.pid;
                return (
                  <Fragment key={p.pid}>
                    <tr id={`pj-${p.pid}`} onClick={() => setOpen(isOpen ? null : p.pid)} style={{ cursor: 'pointer' }}>
                      <td><button class="expander" aria-expanded={isOpen} aria-label={isOpen ? t('收合「{name}」', { name: p.name }) : t('展開「{name}」', { name: p.name })} onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : p.pid); }}>{isOpen ? <IconChevronDown style={{ width: 16, height: 16 }} /> : <IconChevronRight style={{ width: 16, height: 16 }} />}</button></td>
                      <td>
                        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                          {p.archived ? <IconArchive style={{ width: 16, height: 16, color: 'var(--text-3)' }} /> : <IconFolder style={{ width: 16, height: 16, color: 'var(--text-2)' }} />}
                          {p.name}
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
                          <span class="mono faint" style={{ fontSize: 11.5 }}>{p.pid}</span>
                          {p.counts.findings > 0 && <span class="chip warn">{t('{n} 項發現', { n: p.counts.findings })}</span>}
                        </div>
                      </td>
                      <td data-label={t('這台（{label}）的位置', { label: self?.label })}>{here ? <PathCell x={here} /> : <span class="faint">{p.archived ? t('原資料夾已不存在') : t('這台還沒開過')}</span>}</td>
                      <td data-label={t('其他電腦')}>{others.map((d) => p.paths[d.id] ? <span key={d.id} class="chip" title={p.paths[d.id].path}>{d.label}</span> : null)}{!others.some((d) => p.paths[d.id]) && <span class="faint">—</span>}</td>
                      <td class="num" data-label={t('col::記憶')}>{p.counts.memories}</td>
                      <td data-label={t('MEMORY.md 載入預算')}>{p.index ? <Meter label={fmtBytes(p.index.bytes)} value={p.index.lines} max={200} unit={t(' 行')} /> : '—'}</td>
                      <td data-label={t('最近活動')} style={{ whiteSpace: 'nowrap' }}><When at={p.lastActivityAt} /></td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan="6" style={{ background: 'var(--panel-2)' }}>
                          <ProjectDetail p={p} devices={status?.devices || []} go={go} onRename={() => setDialog({ kind: 'rename', p })} onLink={() => setDialog({ kind: 'link', p })} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {dialog?.kind === 'rename' && <RenameDialog p={dialog.p} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'link' && <LinkDialog p={dialog.p} projects={all} onClose={() => setDialog(null)} />}
    </div>
  );
}

// R-52：設定檔綁定一律存在；junction 只在權限模式為 auto／bypassPermissions 時另外建立
const BIND_KINDS = {
  junction: ['junction', N_('Claude Code 預設的記憶資料夾以 junction 指向記憶庫；專案根目錄另有 settings.local.json，從子資料夾啟動也會用到 Engram 記憶')],
  settings: [N_('設定檔'), N_('以專案根目錄的 settings.local.json 指定記憶資料夾。這台電腦的權限模式不是 auto，所以不建立 junction；從子資料夾啟動 Claude Code 時不會用到 Engram 記憶')],
  collision: [N_('設定檔（撞名）'), N_('以專案根目錄的 settings.local.json 指定記憶資料夾：這個資料夾的路徑編碼與其他資料夾相同（中文名稱撞名），所以不能用 junction')],
};

function BindChip({ x }) {
  const kind = x.method === 'junction' ? 'junction' : x.collision === false ? 'settings' : 'collision';
  const [label, title] = BIND_KINDS[kind];
  return <span class="chip" title={t(title)}>{t(label)}</span>;
}

function PathCell({ x }) {
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span class="path" title={x.path}>{x.path}</span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5 }}>
        {x.exists ? <span class="chip ok"><IconCheck />{t('資料夾存在')}</span> : <span class="chip danger"><IconAlert />{t('資料夾不見了')}</span>}
        <BindChip x={x} />
      </span>
    </div>
  );
}

function ProjectDetail({ p, devices, go, onRename, onLink }) {
  return (
    <div style={{ display: 'grid', gap: 12, padding: '4px 0 8px' }}>
      <div class="btn-row">
        <button class="btn sm" onClick={() => go('library', { scope: `project:${p.pid}` })}><IconLibrary />{t('查看 {n} 筆記憶', { n: p.counts.memories })}</button>
        <button class="btn sm" onClick={onRename}><IconEdit />{t('改名')}</button>
        <button class="btn sm" onClick={onLink}><IconLink />{t('併入另一個專案')}</button>
        {p.counts.memories > 0 && <button class="btn sm" onClick={() => go('tidy', { scope: `project:${p.pid}` })} title={t('到「記憶整理」產生給 Claude 的指令')}><IconSparkle />{t('請 Claude 整理')}</button>}
      </div>
      <dl class="kv">
        {devices.map((d) => (
          <Fragment key={d.id}>
            <dt>{d.label}</dt>
            <dd>{p.paths[d.id] ? <><span class="path">{p.paths[d.id].path}</span><span class="faint" style={{ fontSize: 12 }}>　{t('最後開啟 {when}', { when: relTime(p.paths[d.id].lastOpenedAt) })}{p.paths[d.id].encoded ? ` · ${t('編碼 {code}', { code: p.paths[d.id].encoded })}` : ''}</span></> : <span class="faint">{t('尚未在這台開過')}</span>}</dd>
          </Fragment>
        ))}
        <dt>git remote</dt><dd>{p.remotes?.length ? p.remotes.map((r) => <code key={r}>{r}</code>) : <span class="faint">{t('不是 git 專案，以 .claude/engram.json 標記檔識別')}</span>}</dd>
        {p.aliases?.length > 0 && <><dt>{t('別名')}</dt><dd>{p.aliases.join(t('、'))}</dd></>}
        <dt>{t('索引')}</dt><dd>{t('MEMORY.md 共 {lines} 行、{size}。Claude Code 每次只載入前 200 行或 25 KB。', { lines: p.index?.lines ?? '—', size: fmtBytes(p.index?.bytes) })}</dd>
      </dl>
    </div>
  );
}

function RenameDialog({ p, onClose }) {
  const act = useAction();
  const [name, setName] = useState(p.name);
  const [err, setErr] = useState(null);
  const submit = async () => { try { await act(() => api.renameProject(p.pid, name.trim()), t('已改名')); onClose(); } catch (e) { setErr(e); } };
  return (
    <Dialog title={t('專案改名')} desc={t('只改顯示名稱。專案 ID、資料夾和綁定都不受影響。')} onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>{t('取消')}</button><button class="btn primary" disabled={!name.trim() || name === p.name} onClick={submit}>{t('儲存')}</button></>}>
      <ErrorBanner error={err} />
      <div class="field"><label for="pj-name">{t('顯示名稱')}</label><input id="pj-name" class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} /></div>
    </Dialog>
  );
}

function LinkDialog({ p, projects, onClose }) {
  const act = useAction();
  const options = projects.filter((x) => x.pid !== p.pid && !x.archived);
  const [to, setTo] = useState(options[0]?.pid);
  const [err, setErr] = useState(null);
  const submit = async () => { try { await act(() => api.linkProjects(p.pid, to), t('已併入')); onClose(); } catch (e) { setErr(e); } };
  return (
    <Dialog title={t('把「{name}」併入另一個專案', { name: p.name })} desc={t('適合同一個專案在兩台電腦被認成兩個的情況。記憶會搬到目標專案，原專案保留為別名，可以從歷史復原。')} onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>{t('取消')}</button><button class="btn primary" disabled={!to} onClick={submit}><IconLink />{t('併入')}</button></>}>
      <ErrorBanner error={err} />
      <div class="field"><label for="pj-to">{t('目標專案')}</label>
        <select id="pj-to" class="select" value={to} onChange={(e) => setTo(e.currentTarget.value)}>
          {options.map((x) => <option key={x.pid} value={x.pid}>{t('{name}（{n} 筆）', { name: x.name, n: x.counts.memories })}</option>)}
        </select>
      </div>
    </Dialog>
  );
}
