// 記憶庫：寬螢幕三欄（範圍、清單、內容）；中寬度兩欄（範圍改下拉）；窄螢幕清單與內容分頁切換。
import { h } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { api } from '../api.js';
import {
  useApp, useData, ScopeLabel, TypeLabel, When, Empty, Skeleton, Markdown, Dialog, ConfirmDialog, ErrorBanner, Banner,
  useAction, Bytes, useDirty, useSaveShortcut, drafts,
} from '../components.jsx';
import { Editor } from '../lazy-editor.jsx';
import { TYPE_LABEL, scopeKey, relTime, debounce, humanizeCommit } from '../util.js';
import { IconGlobe, IconFolder, IconMonitor, IconLibrary, IconEdit, IconMove, IconPin, IconHistory, IconTrash, IconSearch, IconArchive, IconUndo, IconBack, IconEye } from '../icons.jsx';
import { AskClaudeButton } from '../askclaude.jsx';
import { t, local } from '../i18n.js';

function useMedia(query) {
  const [m, set] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => set(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

// 金鑰遮蔽：引擎提供 secretRanges 時以它為準；沒有時用常見格式比對（M5）
const SECRET_RE = /(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,})/gi;
export function maskSecrets(text, ranges) {
  if (ranges?.length) {
    let out = '';
    let i = 0;
    for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) { out += text.slice(i, a) + t('••••••（已遮蔽）'); i = b; }
    return { text: out + text.slice(i), count: ranges.length };
  }
  let count = 0;
  const masked = text.replace(SECRET_RE, () => { count++; return t('••••••（已遮蔽）'); });
  return { text: masked, count };
}

export function Library({ params, go }) {
  const { status, projects } = useApp();
  const wide = useMedia('(min-width: 1361px)');
  const narrow = useMedia('(max-width: 820px)');
  const [scope, setScope] = useState(params.scope || 'all');
  const [type, setType] = useState('');
  const [sort, setSort] = useState('updated');
  const [q, setQ] = useState(params.q || '');
  const [qLive, setQLive] = useState(params.q || '');
  const composingRef = useRef(false);
  const all = useData(() => api.memories({ sort: 'updated' }), []);
  const list = useData(() => api.memories({ scope: scope === 'all' ? '' : scope, type, q, sort }), [scope, type, q, sort]);
  const selected = params.ref;
  const setQDebounced = useMemo(() => debounce(setQ, 200), []);
  const listRef = useRef(null);

  useEffect(() => { if (params.q !== undefined) { setQ(params.q); setQLive(params.q); } }, [params.q]);
  useEffect(() => { if (params.scope) setScope(params.scope); }, [params.scope]);
  // 寬或中寬度、還沒選取時，自動選第一筆，讓內容區不是空白（窄螢幕不自動，避免直接跳到內容頁）
  useEffect(() => {
    if (!selected && !narrow && list.data?.length) go('library', { ...params, ref: list.data[0].ref }, true);
  }, [list.data, narrow]);

  const counts = useMemo(() => {
    const c = { all: 0, global: 0 };
    for (const m of all.data || []) { c.all++; const k = scopeKey(m.scope); c[k] = (c[k] || 0) + 1; }
    return c;
  }, [all.data]);
  const typeCounts = useMemo(() => {
    const c = {};
    for (const m of all.data || []) if (scope === 'all' || scopeKey(m.scope) === scope) c[m.type] = (c[m.type] || 0) + 1;
    return c;
  }, [all.data, scope]);

  const activeProjects = (projects || []).filter((p) => !p.archived);
  const archived = (projects || []).filter((p) => p.archived);
  const devices = status?.devices || [];

  // 注音、倉頡組字中不搜尋，組完才送出（M10）
  const onSearchInput = (e) => {
    setQLive(e.currentTarget.value);
    if (!composingRef.current) setQDebounced(e.currentTarget.value);
  };
  // 清單支援上下方向鍵（M9）
  const onListKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...listRef.current.querySelectorAll('.row')];
    const i = rows.indexOf(document.activeElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { e.preventDefault(); next.focus(); }
  };

  const scopeSelect = (
    <select id="lib-scope" class="select" value={scope} onChange={(e) => setScope(e.currentTarget.value)} aria-label={t('範圍')} style={{ minWidth: 0, flex: '1 1 180px' }}>
      <option value="all">{t('全部記憶（{n}）', { n: counts.all })}</option>
      <option value="global">{t('全域（{n}）', { n: counts.global })}</option>
      <optgroup label={t('nav::專案')}>{activeProjects.map((p) => <option key={p.pid} value={`project:${p.pid}`}>{t('{name}（{n}）', { name: p.name, n: counts[`project:${p.pid}`] || 0 })}</option>)}</optgroup>
      {archived.length > 0 && <optgroup label={t('已封存的專案')}>{archived.map((p) => <option key={p.pid} value={`project:${p.pid}`}>{t('{name}（{n}）', { name: p.name, n: counts[`project:${p.pid}`] || 0 })}</option>)}</optgroup>}
      <optgroup label={t('單機')}>{devices.map((d) => <option key={d.id} value={`machine:${d.id}`}>{t('{name}（{n}）', { name: d.label, n: counts[`machine:${d.id}`] || 0 })}</option>)}</optgroup>
    </select>
  );

  const listPanel = (
    <section class="panel list-panel" aria-label={t('記憶清單')}>
      <div class="panel-head" style={{ gap: 8 }}>
        <label class="searchbox" style={{ width: '100%' }}>
          <IconSearch style={{ width: 16, height: 16 }} />
          <input id="lib-q" type="search" placeholder={t('搜尋名稱、說明或內文')} value={qLive} aria-label={t('搜尋記憶')}
            onInput={onSearchInput}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e) => { composingRef.current = false; setQDebounced(e.currentTarget.value); }} />
        </label>
        {!wide && scopeSelect}
        <div class="seg" role="group" aria-label={t('類型')}>
          <button aria-pressed={type === ''} onClick={() => setType('')}>{t('全部')}</button>
          {['user', 'feedback', 'project', 'reference'].map((k) => (
            <button key={k} aria-pressed={type === k} onClick={() => setType(k)}>{t(TYPE_LABEL[k])}<span class="n">{typeCounts[k] || 0}</span></button>
          ))}
        </div>
        <select id="lib-sort" class="select" value={sort} onChange={(e) => setSort(e.currentTarget.value)} aria-label={t('排序')} style={{ marginLeft: 'auto' }}>
          <option value="updated">{t('最近更新')}</option>
          <option value="name">{t('名稱')}</option>
          <option value="size">{t('檔案大小')}</option>
        </select>
      </div>
      <div class="scroll">
        <ErrorBanner error={list.error} onRetry={list.reload} />
        {!list.data ? <Skeleton rows={8} /> : list.data.length === 0 ? (
          <Empty icon={IconSearch} title={q ? t('找不到符合的記憶') : t('這裡還沒有記憶')}>
            {q ? t('換個關鍵字，或切換範圍再試一次。') : t('Claude 在這個範圍寫下記憶後，會自動出現在這裡。')}
          </Empty>
        ) : (
          <div class="rows" role="listbox" aria-label={t('list::記憶')} ref={listRef} onKeyDown={onListKey}>
            {list.data.map((m) => (
              <button class="row" role="option" key={m.ref} aria-selected={m.ref === selected} onClick={() => go('library', { ...params, scope, ref: m.ref })}>
                <span class="title">{m.pinned && <IconPin style={{ width: 13, height: 13, marginRight: 4, color: 'var(--brand)', verticalAlign: -1 }} />}{m.name}</span>
                <When at={m.updatedAt} />
                <span class="desc">{m.description}</span>
                <span class="meta">
                  {scope === 'all' && <ScopeLabel scope={m.scope} />}
                  <TypeLabel type={m.type} />
                  {m.findings.length > 0 && <span class="chip warn">{m.findings.join(' ')}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );

  const detailPanel = (
    <section class="panel detail" aria-label={t('記憶內容')}>
      {narrow && <div class="back-bar"><button class="btn sm ghost" onClick={() => go('library', { scope })}><IconBack />{t('回到清單')}</button></div>}
      {selected ? <Detail key={selected} ref_={selected} go={go} params={params} /> : (
        <Empty icon={IconLibrary} title={t('選一筆記憶')}>{t('從清單選一筆，就能閱讀、編輯、改變範圍，或查看它的修改歷史。')}</Empty>
      )}
    </section>
  );

  if (narrow) return <div class="page wide"><div class="library one">{selected ? detailPanel : listPanel}</div></div>;
  return (
    <div class="page wide">
      <div class={`library${wide ? '' : ' two'}`}>
        {wide && (
          <nav class="panel rail" aria-label={t('範圍')}>
            <div class="scroll">
              <div class="tree">
                <ScopeBtn k="all" cur={scope} set={setScope} icon={IconLibrary} label={t('全部記憶')} n={counts.all} />
                <ScopeBtn k="global" cur={scope} set={setScope} icon={IconGlobe} label={t('全域')} n={counts.global} />
                <div class="group">{t('nav::專案')}</div>
                {activeProjects.map((p) => (
                  <ScopeBtn key={p.pid} k={`project:${p.pid}`} cur={scope} set={setScope} icon={IconFolder} label={p.name} n={counts[`project:${p.pid}`] || 0} warn={p.counts.findings > 0} />
                ))}
                {archived.length > 0 && <div class="group">{t('已封存的專案')}</div>}
                {archived.map((p) => (
                  <ScopeBtn key={p.pid} k={`project:${p.pid}`} cur={scope} set={setScope} icon={IconArchive} label={p.name} n={counts[`project:${p.pid}`] || 0} />
                ))}
                <div class="group">{t('單機')}</div>
                {devices.map((d) => (
                  <ScopeBtn key={d.id} k={`machine:${d.id}`} cur={scope} set={setScope} icon={IconMonitor} label={d.label} n={counts[`machine:${d.id}`] || 0} self={d.isSelf} />
                ))}
              </div>
            </div>
          </nav>
        )}
        {listPanel}
        {detailPanel}
      </div>
    </div>
  );
}

function ScopeBtn({ k, cur, set, icon: Icon, label, n, warn, self }) {
  return (
    <button aria-pressed={cur === k} onClick={() => set(k)} title={label}>
      <Icon style={self ? { color: 'var(--dot)' } : undefined} />
      <span class="label">{label}</span>
      {warn && <span class="warn-dot" title={t('有健康檢查發現')} />}
      <span class="n">{n}</span>
    </button>
  );
}

function Detail({ ref_, go, params }) {
  const act = useAction();
  const mem = useData(() => api.memory(ref_), [ref_]);
  const [mode, setMode] = useState('read'); // read | edit | raw
  const [draft, setDraft] = useState(null);
  const [stash, setStash] = useState(() => drafts.get(`mem:${ref_}`));
  const [dialog, setDialog] = useState(null);
  const [err, setErr] = useState(null);
  const [reveal, setReveal] = useState(false);
  const [autoEdit, setAutoEdit] = useState(params.edit === '1');
  const m = mem.data;

  const original = m && (mode === 'raw' ? { raw: m.raw } : { description: m.frontmatter.description, type: m.frontmatter.metadata?.type || m.type, body: m.body });
  const dirty = !!(draft && original && JSON.stringify(draft) !== JSON.stringify(original));
  useDirty(mode !== 'read' && dirty, t('「{name}」的編輯內容', { name: m?.name ?? t('fallback::記憶') }));
  useEffect(() => { if (mode !== 'read' && draft) drafts.set(`mem:${ref_}`, { mode, draft }); }, [draft, mode]);

  const startEdit = (raw = false) => {
    setErr(null);
    setDraft(raw ? { raw: m.raw } : { description: m.frontmatter.description, type: m.frontmatter.metadata?.type || m.type, body: m.body });
    setMode(raw ? 'raw' : 'edit');
  };
  useEffect(() => { if (autoEdit && m) { setAutoEdit(false); startEdit(false); } }, [autoEdit, m]);

  const finish = () => { drafts.clear(`mem:${ref_}`); setStash(null); setMode('read'); setDraft(null); };
  const save = async (allowSecrets = false) => {
    setErr(null);
    try {
      if (mode === 'raw') await act(() => api.writeMemoryRaw(m.ref, draft.raw, allowSecrets), t('已儲存'), { rethrow: true });
      else {
        const fm = { ...m.frontmatter, description: draft.description, metadata: { ...m.frontmatter.metadata, type: draft.type } };
        await act(() => api.writeMemory(m.ref, fm, draft.body, allowSecrets), t('已儲存'), { rethrow: true });
      }
      finish();
    } catch (e) {
      // 疑似金鑰：Engram 不寫入；使用者確認不是金鑰才照樣儲存（M5）
      if (e.code === 'E_SECRET' && !allowSecrets) { setDialog({ kind: 'secret', error: e }); return; }
      // frontmatter 格式有誤時，改用原始碼模式編輯整份內容（R-28）
      if (e.code === 'E_INVALID' && mode === 'edit') { setDraft({ raw: m.raw }); setMode('raw'); }
      setErr(e);
    }
  };
  useSaveShortcut(() => save(), mode !== 'read');

  const remove = async () => {
    setDialog(null);
    const r = await act(() => api.removeMemory(m.ref), t('已刪除「{name}」', { name: m.name }));
    if (r) go('library', { ...params, ref: undefined }, true);
  };

  if (mem.error) return <div class="panel-body"><ErrorBanner error={mem.error} onRetry={mem.reload} /></div>;
  if (!m) return <Skeleton rows={6} />;
  const bodyStart = m.raw.length - m.body.length;
  const ranges = (m.secretRanges || []).map((r) => (Array.isArray(r) ? r : [r.offset - bodyStart, r.offset - bodyStart + r.length])).filter(([a]) => a >= 0);
  const masked = maskSecrets(m.body, ranges.length ? ranges : null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div class="detail-head">
        <h2>{m.name}</h2>
        {mode === 'read' && <p class="desc">{m.description}</p>}
        <div class="facts">
          <ScopeLabel scope={m.scope} />
          <TypeLabel type={m.type} />
          <span>{t('更新於 {when}', { when: relTime(m.updatedAt) })}</span>
          <span><Bytes n={m.size} /></span>
          {m.pinned && <span class="chip brand"><IconPin />{t('已釘選')}</span>}
        </div>
      </div>
      <div class="detail-tools" role="toolbar" aria-label={t('動作')}>
        {mode === 'read' ? (
          <>
            <button class="btn sm" onClick={() => startEdit(false)}><IconEdit />{t('編輯')}</button>
            <button class="btn sm" onClick={() => setDialog('move')}><IconMove />{t('改變範圍')}</button>
            <button class="btn sm" onClick={() => act(() => api.pinMemory(m.ref, !m.pinned), m.pinned ? t('已取消釘選') : t('已釘選，會排在索引最前面'))}><IconPin />{m.pinned ? t('取消釘選') : t('釘選')}</button>
            <button class="btn sm" onClick={() => setDialog('history')}><IconHistory />{t('歷史')}</button>
            <AskClaudeButton label={t('請 Claude 檢查')} title={t('請 Claude 檢查「{name}」', { name: m.name })} command={`/engram:tidy ${m.ref}`}
              intro={t('Claude 會檢查這筆記憶：說明是否具體、是不是一筆講好幾件事、有沒有過時或與其他記憶重複矛盾、範圍放得對不對，再提出改寫或整理的建議。')} />
            <button class="btn sm danger" style={{ marginLeft: 'auto' }} onClick={() => setDialog('delete')}><IconTrash />{t('刪除')}</button>
          </>
        ) : (
          <>
            <button class="btn sm primary" disabled={!dirty} onClick={() => save()}>{t('儲存')}</button>
            <button class="btn sm" onClick={() => (dirty ? setDialog('discard') : finish())}>{t('取消')}</button>
            {mode === 'edit' && <button class="btn sm ghost" onClick={() => { setDraft({ raw: m.raw }); setMode('raw'); }}>{t('改用原始碼模式')}</button>}
            <span class="faint" style={{ fontSize: 12, alignSelf: 'center', marginLeft: 'auto' }}>{t('Ctrl+S 儲存 · 儲存後會在 30 秒內同步到其他電腦')}</span>
          </>
        )}
      </div>
      <div class="detail-body">
        <ErrorBanner error={err} onDismiss={() => setErr(null)} />
        {stash && mode === 'read' && (
          <Banner tone="info" title={t('有尚未儲存的草稿')} actions={<>
            <button class="btn sm primary" onClick={() => { setDraft(stash.draft); setMode(stash.mode); setStash(null); }}>{t('恢復草稿')}</button>
            <button class="btn sm" onClick={() => { drafts.clear(`mem:${ref_}`); setStash(null); }}>{t('捨棄')}</button>
          </>}>{t('{when}在這個分頁編輯過，還沒有儲存。', { when: relTime(stash.savedAt) })}</Banner>
        )}
        {mode === 'read' ? (
          <div style={{ display: 'grid', gap: 16 }}>
            {masked.count > 0 && (
              <Banner tone="warn" title={t('內文有 {n} 處疑似金鑰，已遮蔽', { n: masked.count })} actions={<button class="btn sm" onClick={() => setReveal(!reveal)}><IconEye />{reveal ? t('重新遮蔽') : t('顯示原文')}</button>}>
                {t('這筆記憶不會推送到 GitHub。建議到收件匣用「移除金鑰」改寫成只記存放位置。')}
              </Banner>
            )}
            <Markdown text={reveal ? m.body : masked.text} />
            <details>
              <summary class="faint" style={{ cursor: 'pointer', fontSize: 12 }}>{t('原始檔案與位置')}</summary>
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                <div class="mono faint" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{m.path}</div>
                <pre class="frontmatter">{m.raw.split('\n---')[0]}{'\n---'}</pre>
              </div>
            </details>
          </div>
        ) : mode === 'raw' ? (
          <div class="field">
            <label>{t('整份檔案（含 frontmatter）')}</label>
            <Editor value={draft.raw} onChange={(raw) => setDraft({ raw })} label={t('記憶原始碼')} />
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            <div class="field">
              <label for="ed-desc">{t('說明（顯示在索引裡，Claude 靠它判斷要不要讀這筆）')}</label>
              <input id="ed-desc" class="input" value={draft.description} onInput={(e) => setDraft({ ...draft, description: e.currentTarget.value })} />
            </div>
            <div class="field">
              <label for="ed-type">{t('類型')}</label>
              <select id="ed-type" class="select" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.currentTarget.value })} style={{ maxWidth: 200 }}>
                {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
              </select>
            </div>
            <div class="field">
              <label>{t('內文（Markdown）')}</label>
              <Editor value={draft.body} onChange={(body) => setDraft((d) => ({ ...d, body }))} label={t('記憶內文')} />
            </div>
          </div>
        )}
      </div>

      {dialog === 'move' && <MoveDialog m={m} onClose={() => setDialog(null)} onMoved={(ref) => { setDialog(null); go('library', { ...params, ref }, true); }} />}
      {dialog === 'history' && <HistoryDialog m={m} go={go} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'secret' && (
        <ConfirmDialog title={t('內容疑似含有金鑰')} desc={local(dialog.error, 'message')} confirmLabel={t('這不是金鑰，照樣儲存')} danger
          onConfirm={async () => { setDialog(null); await save(true); }} onClose={() => setDialog(null)}>
          <p class="muted" style={{ fontSize: 13 }}>{t('是真的金鑰時請取消，改成只記「存放在哪裡、怎麼取得」（例如 Windows 認證管理員的項目名稱）。選「這不是金鑰」後，這些值會記入「不是金鑰」清單（只存雜湊、同步到所有電腦），之後任何記憶裡的這些值都不再當成金鑰，記憶照常同步。')}</p>
        </ConfirmDialog>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog title={t('刪除「{name}」？', { name: m.name })} desc={t('檔案會從 vault 移除並同步到其他電腦。刪除紀錄保留在歷史裡，隨時可以還原。')} confirmLabel={t('刪除')} danger onConfirm={remove} onClose={() => setDialog(null)}>
          <p class="muted" style={{ fontSize: 13 }}>{m.description}</p>
        </ConfirmDialog>
      )}
      {dialog === 'discard' && (
        <ConfirmDialog title={t('放棄這次的修改？')} desc={t('編輯內容不會儲存。')} confirmLabel={t('放棄修改')} danger onConfirm={() => { setDialog(null); finish(); }} onClose={() => setDialog(null)}><span /></ConfirmDialog>
      )}
    </div>
  );
}

function MoveDialog({ m, onClose, onMoved }) {
  const { projects, status } = useApp();
  const act = useAction();
  const [kind, setKind] = useState(m.scope.kind === 'global' ? 'project' : 'global');
  const [pid, setPid] = useState(m.scope.pid || (projects || []).find((p) => !p.archived)?.pid);
  const [mid, setMid] = useState(status?.devices?.find((d) => d.isSelf)?.id);
  const [err, setErr] = useState(null);
  const target = kind === 'global' ? { kind } : kind === 'project' ? { kind, pid } : { kind, mid };
  const same = scopeKey(target) === scopeKey(m.scope);
  const submit = async () => {
    try {
      const label = kind === 'global' ? t('全域') : kind === 'machine' ? t('單機') : t('專案');
      await act(() => api.moveMemory(m.ref, target), t('已移到{label}', { label }), { rethrow: true });
      const name = m.ref.split('/').pop();
      const dir = kind === 'global' ? 'global' : kind === 'machine' ? `machines/${mid}` : `projects/${pid}/memory`;
      onMoved(`${dir}/${name}`);
    } catch (e) { setErr(e); }
  };
  const OPTIONS = [
    { k: 'global', icon: IconGlobe, title: t('全域'), desc: t('每個專案、每台電腦都看得到。適合個人偏好與通用經驗。') },
    { k: 'project', icon: IconFolder, title: t('專案'), desc: t('只在這個專案的對話裡載入，所有電腦都會同步。') },
    { k: 'machine', icon: IconMonitor, title: t('單機'), desc: t('只在指定的電腦載入。適合安裝路徑、網路設定、硬碟狀況。') },
  ];
  return (
    <Dialog title={t('改變範圍')} desc={t('「{name}」目前在：', { name: m.name })} onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>{t('取消')}</button><button class="btn primary" disabled={same} onClick={submit}><IconMove />{t('移動')}</button></>}>
      <div><ScopeLabel scope={m.scope} /></div>
      <ErrorBanner error={err} />
      <div role="radiogroup" aria-label={t('目標範圍')} style={{ display: 'grid', gap: 8 }}>
        {OPTIONS.map((o) => (
          <label key={o.k} class="panel" style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: 10, padding: '10px 12px', cursor: 'pointer', alignItems: 'start', borderColor: kind === o.k ? 'var(--brand)' : undefined, boxShadow: 'none' }}>
            <input type="radio" name="mv-kind" id={`mv-${o.k}`} checked={kind === o.k} onChange={() => setKind(o.k)} style={{ marginTop: 3 }} />
            <o.icon style={{ width: 18, height: 18, marginTop: 1, color: 'var(--text-2)' }} />
            <span><b>{o.title}</b><br /><span class="muted" style={{ fontSize: 13 }}>{o.desc}</span></span>
          </label>
        ))}
      </div>
      {kind === 'project' && (
        <div class="field">
          <label for="mv-pid">{t('專案')}</label>
          <select id="mv-pid" class="select" value={pid} onChange={(e) => setPid(e.currentTarget.value)}>
            {(projects || []).filter((p) => !p.archived).map((p) => <option key={p.pid} value={p.pid}>{p.name}</option>)}
          </select>
        </div>
      )}
      {kind === 'machine' && (
        <div class="field">
          <label for="mv-mid">{t('電腦')}</label>
          <select id="mv-mid" class="select" value={mid} onChange={(e) => setMid(e.currentTarget.value)}>
            {(status?.devices || []).map((d) => <option key={d.id} value={d.id}>{d.isSelf ? t('{label}（這台）', { label: d.label }) : d.label}</option>)}
          </select>
        </div>
      )}
    </Dialog>
  );
}

// 匯入產生的變更不能在這裡單獨復原：只撤銷檔案、junction 卻仍指向 vault，記憶會消失（M13）
export const IMPORT_ACTIONS = new Set(['import', 'sweep', 'bind']);

function HistoryDialog({ m, go, onClose }) {
  const act = useAction();
  const hist = useData(() => api.history({ ref: m.ref, limit: 30 }), [m.ref]);
  const { status } = useApp();
  const [confirm, setConfirm] = useState(null);
  const devName = (id) => status?.devices?.find((d) => d.id === id)?.label || id;
  return (
    <Dialog title={t('修改歷史')} desc={t('{name} 的每一次變更都有紀錄，可以逐筆復原。', { name: m.name })} onClose={onClose} footer={<button class="btn" onClick={onClose}>{t('關閉')}</button>}>
      {!hist.data ? <Skeleton rows={4} /> : hist.data.length === 0 ? <Empty icon={IconHistory} title={t('還沒有歷史')}>{t('匯入後的第一次修改會出現在這裡。')}</Empty> : (
        <div class="rows" style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
          {hist.data.map((c) => {
            const hc = humanizeCommit(c);
            const isImport = IMPORT_ACTIONS.has(c.action) || c.importTag;
            return (
              <div class="row" key={c.sha} style={{ cursor: 'default' }}>
                <span class="title" style={{ fontWeight: 500 }}>{hc.title}<span class="muted" style={{ fontWeight: 400 }}>　{hc.detail}</span></span>
                {isImport ? <button class="btn sm ghost" onClick={() => { onClose(); go('import'); }}>{t('到匯入頁還原')}</button>
                  : c.undoable ? <button class="btn sm" onClick={() => setConfirm(c)}><IconUndo />{t('復原')}</button> : <span />}
                <span class="meta"><span>{devName(c.machine)}</span><span>{relTime(c.at)}</span><span class="mono">{c.sha}</span></span>
              </div>
            );
          })}
        </div>
      )}
      {confirm && (
        <ConfirmDialog title={t('復原這個變更？')} desc={t('{title}（{when}）會被撤銷，並產生一筆新的變更紀錄；之後仍可再復原。', { title: humanizeCommit(confirm).title, when: relTime(confirm.at) })} confirmLabel={t('復原')}
          onConfirm={async () => { await act(() => api.undo(confirm.sha), t('已復原這個變更')); setConfirm(null); }} onClose={() => setConfirm(null)}>
          {confirm.refs?.length > 0 && <div class="refs" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{confirm.refs.map((r) => <code key={r}>{r}</code>)}</div>}
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
