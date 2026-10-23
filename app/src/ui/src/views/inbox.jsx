// 收件匣：一張卡片一個決定。順序是衝突 → 高 → 中，最後是「建議」（低等級，不急）。
// 每張卡片都可以忽略或延後；會改內容或設定的動作，執行前先說明會發生什麼。
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { useData, Empty, Skeleton, Dialog, ConfirmDialog, ErrorBanner, useAction, ScopeLabel, Markdown, SevChip, useDirty } from '../components.jsx';
import { Merge } from '../lazy-editor.jsx';
import { relTime } from '../util.js';
import { IconCheckCircle, IconMerge, IconChevronRight, IconShield } from '../icons.jsx';
import { AskClaudeButton } from '../askclaude.jsx';
import { t, N_, local } from '../i18n.js';

const GROUPS = [
  { key: 'attention', label: N_('需要處理') },
  { key: 'conflict', label: N_('同步衝突') },
  { key: 'high', label: N_('高') },
  { key: 'medium', label: N_('中') },
  { key: 'low', label: N_('tab::建議') },
];
// 規則只能找出候選、要讀內容才能判斷的卡片：提供「交給 Claude」（/engram:inbox <id>）
const AI_CODES = new Set(['H01', 'H07', 'H08', 'H09', 'H10', 'H11', 'H12', 'H16', 'H19']);

// 執行前需要確認的動作（會改內容、設定或綁定）；值是中文原文，顯示時經過 t()
const CONFIRM = {
  'restore-deletions': N_('把被刪除的記憶從歷史中還原到目前的版本。'),
  'confirm-deletions': N_('確認這些刪除是你要的，之後不再提醒；檔案仍可從歷史還原。'),
  rebind: N_('重新建立這個資料夾的記憶連結（junction），原本的記憶資料夾會先備份。'),
  remove: N_('把這筆記憶移到歷史（封存）；之後仍可從歷史還原。'),
  'forget-binding': N_('移除這台電腦上已失效的綁定紀錄；記憶本身不受影響。'),
  'allow-read': N_('在你的使用者設定中加入這個記憶資料夾，讓 Claude 讀取時不再跳出權限詢問。'),
  'reconcile-bindings': N_('依這台電腦目前的權限模式重新設定資料夾綁定：auto 模式補上 junction，其他模式改用專案根目錄的設定檔，避免讀寫記憶時跳出權限詢問。記憶本身不受影響。'),
  'rename-collisions': N_('依命名規則在資料夾原名後面加 4 碼代號（例如「照片優化-66ca」），讓它們在 Claude Code 裡不再共用同一份紀錄。改名後重新綁定，這台電腦寫的記憶裡的舊路徑一併更新；已收編完的共用舊記憶資料夾移到備份。改名前的對話不會出現在 /resume 清單。完成後可以按「復原」整批還原。'),
};

export function Inbox({ params, go }) {
  const data = useData(() => Promise.all([api.conflicts(), api.findings()]), []);
  const [filter, setFilter] = useState('attention');
  const [open, setOpen] = useState(null);
  const act = useAction();

  useEffect(() => {
    if (params.focus && data.data) {
      const [cs, fs] = data.data;
      const c = cs.find((x) => x.id === params.focus);
      if (c) setOpen({ kind: 'conflict', item: c });
      else {
        const f = fs.find((x) => x.id === params.focus);
        if (f) setFilter(f.severity === 'low' ? 'low' : 'attention');
        setTimeout(() => document.getElementById(`card-${params.focus}`)?.scrollIntoView({ block: 'center' }), 50);
      }
    }
  }, [params.focus, data.data]);

  if (!data.data) return <div class="page"><ErrorBanner error={data.error} onRetry={data.reload} /><Skeleton rows={6} /></div>;
  const [conflicts, findings] = data.data;
  const active = findings.filter((f) => f.severity !== 'auto');
  const n = { conflict: conflicts.length, high: 0, medium: 0, low: 0 };
  for (const f of active) n[f.severity]++;
  n.attention = n.conflict + n.high + n.medium;

  // 引擎無法自動處理、需要介面接手的動作（引擎回傳 needsUi 時也走這裡）
  const UI_ACTIONS = {
    merge: (f) => setOpen({ kind: 'merge', item: f }),
    edit: (f) => (f.code === 'H13' ? setOpen({ kind: 'secret', item: f })
      : f.code === 'H10' ? setOpen({ kind: 'guide', item: f, guide: 'split' })
      : go('library', { ref: f.fix.args?.ref || f.refs?.[0], edit: '1' })),
    'open-conflict': (f) => { const c = conflicts.find((x) => x.id === f.fix.args?.id); if (c) setOpen({ kind: 'conflict', item: c }); },
    'open-core': () => go('core'),
    'open-project': (f) => go('projects', { focus: f.fix.args?.pid || f.pid }),
    'open-rename': (f) => setOpen({ kind: 'guide', item: f, guide: 'rename' }),
  };
  const run = async (f, fix = f.fix) => {
    if (UI_ACTIONS[fix.action]) return UI_ACTIONS[fix.action]({ ...f, fix });
    if (CONFIRM[fix.action]) return setOpen({ kind: 'confirm', item: f, fix });
    const r = await act(() => api.apply(fix), t('已{label}', { label: local(fix, 'label') }));
    if (r?.needsUi) UI_ACTIONS[r.action]?.({ ...f, fix });
  };

  const show = (k) => (filter === 'attention' ? ['conflict', 'high', 'medium'].includes(k) : filter === k);
  const visible = (show('conflict') ? conflicts.length : 0) + active.filter((f) => show(f.severity)).length;

  return (
    <div class="page">
      <div class="filters">
        <div class="seg" role="group" aria-label={t('篩選')}>
          {GROUPS.map((g) => <button key={g.key} aria-pressed={filter === g.key} onClick={() => setFilter(g.key)}>{t(g.label)}<span class="n">{n[g.key]}</span></button>)}
        </div>
        <span class="faint" style={{ fontSize: 13, flex: '1 1 320px' }}>{t('「需要處理」＝衝突＋高＋中；「建議」不急，可以忽略。健康檢查每天 09:30 執行，判斷全部依規則。')}</span>
        {n.attention + n.low > 0 && (
          <AskClaudeButton cls="btn sm primary" label={t('交給 Claude 整理')} title={t('交給 Claude 整理收件匣')}
            intro={t('規則只能找出候選，要不要升級全域、是不是真的重複、還有沒有用，需要讀內容才能判斷。Claude 會逐張讀過 {n} 張卡片，列出每一張的判斷與建議處理方式。', { n: n.attention + n.low })}
            variants={[
              { label: t('逐項確認（建議）'), command: '/engram:inbox', note: t('Claude 列出計畫表後停下來，你選擇要執行哪些項目。') },
              {
                label: t('自動處理'),
                command: t('/engram:inbox 自動'),
                auto: true,
                note: t('Claude 列出計畫表後直接處理有把握的項目（升級全域、搬到單機、合併重複、修正格式、精簡、忽略）；疑似金鑰、資料夾改名與綁定、大量刪除、封存、同步衝突與沒有把握的項目一律留給你決定。每一項都附復原指令。'),
              },
            ]} />
        )}
      </div>

      {visible === 0 && <div class="panel"><Empty icon={IconCheckCircle} title={filter === 'low' ? t('沒有建議') : t('沒有需要處理的事')}>{filter === 'attention' && n.low ? t('另有 {n} 項不急的建議，可以有空再看。', { n: n.low }) : t('新的衝突或健康檢查發現會出現在這裡。')}</Empty></div>}

      <div class="cards">
        {show('conflict') && conflicts.map((c) => (
          <article class="card sev-stripe high" key={c.id} id={`card-${c.id}`}>
            <header>
              <SevChip sev="conflict" />
              <h3>{(c.ref || c.id).split('/').pop()}</h3>
              <span class="faint" style={{ fontSize: 12 }}>{relTime(c.createdAt)}</span>
            </header>
            <p>{local(c, 'summary')}</p>
            <p class="faint" style={{ fontSize: 12 }}>{t('目前檔案保留這台的版本，對方的版本暫存在衝突區，Claude 不會讀到衝突標記。')}</p>
            <footer>
              <button class="btn primary sm" onClick={() => setOpen({ kind: 'conflict', item: c })}><IconMerge />{t('比對並決定')}</button>
              <AskClaudeButton cls="btn sm ghost" label={t('交給 Claude 合併')} title={t('交給 Claude 合併：{name}', { name: (c.ref || c.id).split('/').pop() })} command={`/engram:inbox ${c.id}`}
                intro={t('Claude 會比對兩台電腦的版本與修改前的共同版本，說明兩邊各改了什麼，提出合併後的內容讓你確認。')} />
            </footer>
          </article>
        ))}
        {['high', 'medium', 'low'].filter(show).flatMap((sev) => active.filter((f) => f.severity === sev)).map((f) => {
          const fixes = f.fixes?.length ? f.fixes : f.fix ? [f.fix] : [];
          return (
            <article class={`card sev-stripe ${f.severity}`} key={f.id} id={`card-${f.id}`}>
              <header>
                <SevChip sev={f.severity} />
                <h3>{local(f, 'title')}</h3>
                <span class="code">{f.code}</span>
              </header>
              <p>{local(f, 'detail')}</p>
              {f.refs?.length > 0 && <div class="refs">{f.refs.map((r) => <code key={r}>{r}</code>)}</div>}
              <footer>
                {fixes.map((fx, i) => <button key={fx.action + i} class={`btn sm${i === 0 ? ' primary' : ''}`} onClick={() => run(f, fx)}>{local(fx, 'label')}</button>)}
                {AI_CODES.has(f.code) && <AskClaudeButton cls="btn sm ghost" title={t('交給 Claude：{title}', { title: local(f, 'title') })} command={`/engram:inbox ${f.id}`}
                  intro={t('Claude 會讀這張卡片相關的記憶內容，說明判斷的依據，建議要套用修正、改寫、合併還是忽略。')} />}
                {f.refs?.[0] && /^(global|projects|machines)\//.test(f.refs[0]) && <button class="btn sm ghost" onClick={() => go('library', { ref: f.refs[0] })}>{t('在記憶庫開啟')}<IconChevronRight /></button>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button class="btn sm ghost" onClick={() => act(() => api.dismissFinding(f.id, new Date(Date.now() + 7 * 864e5).toISOString()), t('七天後再提醒'))}>{t('七天後提醒')}</button>
                  <button class="btn sm ghost" onClick={() => act(() => api.dismissFinding(f.id), t('已忽略這項，之後不再提醒'))}>{t('忽略')}</button>
                </span>
              </footer>
            </article>
          );
        })}
      </div>

      {open?.kind === 'conflict' && <ConflictDialog c={open.item} onClose={() => { setOpen(null); if (params.focus) go('inbox', {}, true); }} />}
      {open?.kind === 'merge' && <MergeDialog f={open.item} onClose={() => setOpen(null)} />}
      {open?.kind === 'secret' && <SecretDialog f={open.item} onClose={() => setOpen(null)} />}
      {open?.kind === 'guide' && <GuideDialog f={open.item} guide={open.guide} onClose={() => setOpen(null)} />}
      {open?.kind === 'confirm' && (
        <ConfirmDialog title={t('{label}？', { label: local(open.fix, 'label') })} desc={t(CONFIRM[open.fix.action])} confirmLabel={local(open.fix, 'label')}
          onConfirm={async () => { await act(() => api.apply(open.fix), t('已{label}', { label: local(open.fix, 'label') })); setOpen(null); }} onClose={() => setOpen(null)}>
          <p class="muted" style={{ fontSize: 13 }}>{local(open.item, 'detail')}</p>
          {open.item.refs?.length > 0 && <div class="refs" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{open.item.refs.map((r) => <code key={r}>{r}</code>)}</div>}
        </ConfirmDialog>
      )}
    </div>
  );
}

function ConflictDialog({ c, onClose }) {
  const act = useAction();
  const [body, setBody] = useState(c.ours);
  const [view, setView] = useState('theirs');
  const [err, setErr] = useState(null);
  const edited = body !== c.ours;
  useDirty(edited, t('衝突的合併結果'));
  const name = (c.ref || c.id).split('/').pop();
  const resolve = async (choice) => {
    try {
      const label = { ours: t('已保留這台的版本'), theirs: t('已改用對方的版本'), both: t('兩個版本都已保留'), manual: t('已儲存合併結果') }[choice];
      await act(() => api.resolveConflict(c.id, choice, choice === 'manual' ? body : undefined), label, { rethrow: true });
      onClose();
    } catch (e) { setErr(e); }
  };
  const other = c.otherMachine || t('另一台');
  if (c.kind === 'modify-delete') {
    return (
      <Dialog title={t('改刪衝突：{name}', { name })} desc={local(c, 'summary')} onClose={onClose} footer={<>
        <button class="btn" onClick={() => resolve('theirs')}>{t('接受刪除')}</button>
        <button class="btn primary" onClick={() => resolve('ours')}>{t('保留這筆記憶')}</button>
      </>}>
        <ErrorBanner error={err} />
        <p class="muted" style={{ fontSize: 13 }}>{t('一台電腦修改了這筆記憶，另一台把它刪除了。Engram 先保留了修改後的版本：')}</p>
        <Markdown text={c.ours || c.theirs || ''} />
      </Dialog>
    );
  }
  if (c.kind === 'rename') {
    return (
      <Dialog title={t('兩邊各自改名：{name}', { name })} desc={local(c, 'summary')} onClose={onClose} footer={<>
        <button class="btn" onClick={() => resolve('both')}>{t('兩個檔名都保留')}</button>
        <button class="btn primary" onClick={() => resolve('ours')}>{t('用這台的檔名')}</button>
      </>}>
        <ErrorBanner error={err} />
        <p class="muted" style={{ fontSize: 13 }}>{t('兩台電腦把同一筆記憶改成不同的檔名。保留兩者時，會在收件匣出現「可能重複」卡片，之後可以合併。')}</p>
      </Dialog>
    );
  }
  return (
    <Dialog wide dirty={edited} title={t('同步衝突：{name}', { name })} desc={local(c, 'summary')} onClose={onClose}
      footer={<>
        <span class="faint" style={{ fontSize: 12, flex: '1 1 260px', alignSelf: 'center' }}>{t('「兩者都保留」會把{other}的版本另存成 {file}', { other, file: `${name.replace(/\.md$/, '')}-2.md` })}</span>
        <button class="btn" onClick={() => resolve('both')}>{t('兩者都保留')}</button>
        <button class="btn" onClick={() => resolve('theirs')}>{t('改用{other}的版本', { other })}</button>
        <button class="btn" onClick={() => resolve('ours')}>{t('保留這台的版本')}</button>
        <button class="btn primary" disabled={!edited} onClick={() => resolve('manual')}>{t('儲存左邊的合併結果')}</button>
      </>}>
      <ErrorBanner error={err} />
      {c.base != null && (
        <div class="seg" role="group" aria-label={t('右邊顯示')}>
          <button aria-pressed={view === 'theirs'} onClick={() => setView('theirs')}>{t('右邊：{other}的版本', { other })}</button>
          <button aria-pressed={view === 'base'} onClick={() => setView('base')}>{t('右邊：修改前的共同版本')}</button>
        </div>
      )}
      <div>
        <div class="merge-cols"><span>{t('這台的版本（可直接編輯；點中間的箭頭把右邊的段落搬過來）')}</span><span>{view === 'base' ? t('兩邊修改前的共同版本') : t('{other}的版本', { other })}</span></div>
        <Merge key={view} ours={body} theirs={view === 'base' ? c.base : c.theirs} onChange={setBody} />
      </div>
    </Dialog>
  );
}

function MergeDialog({ f, onClose }) {
  const act = useAction();
  const refs = f.fix?.args?.refs || f.refs;
  const items = useData(() => Promise.all(refs.map((r) => api.memory(r))), [f.id]);
  const [into, setInto] = useState(refs[0]);
  const [body, setBody] = useState(null);
  const [initial, setInitial] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (items.data && body === null) {
      const merged = items.data.map((m) => `## ${m.name}\n\n${m.body.trim()}`).join('\n\n');
      setBody(merged); setInitial(merged);
    }
  }, [items.data]);
  const dirty = body !== null && body !== initial;
  useDirty(dirty, t('合併中的記憶'));
  const submit = async () => {
    try { await act(() => api.mergeMemories(refs, into, body), t('已合併 {n} 筆記憶', { n: refs.length }), { rethrow: true }); onClose(); } catch (e) { setErr(e); }
  };
  return (
    <Dialog wide dirty={dirty} title={t('合併 {n} 筆記憶', { n: refs.length })} desc={t('上方並排列出 {n} 筆的內容；下方是合併後的內文，請刪掉重複的段落，再選擇要保留哪個檔名。其他檔案會移到歷史中，隨時可以還原。', { n: refs.length })} onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>{t('取消')}</button><button class="btn primary" disabled={!body} onClick={submit}><IconMerge />{t('合併')}</button></>}>
      <ErrorBanner error={err} />
      {!items.data ? <Skeleton rows={4} /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {items.data.map((m) => (
              <label key={m.ref} class="panel" style={{ padding: '10px 12px', display: 'grid', gap: 6, cursor: 'pointer', boxShadow: 'none', borderColor: into === m.ref ? 'var(--brand)' : undefined, alignContent: 'start' }}>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="radio" name="merge-into" id={`mi-${m.name}`} checked={into === m.ref} onChange={() => setInto(m.ref)} />
                  <b style={{ overflowWrap: 'anywhere' }}>{m.name}</b>
                </span>
                <ScopeLabel scope={m.scope} />
                <div class="diff" style={{ maxHeight: 180 }}>{m.body.trim()}</div>
              </label>
            ))}
          </div>
          <div class="field">
            <label for="merge-body">{t('合併後的內文')}</label>
            <textarea id="merge-body" class="input" rows="12" value={body || ''} onInput={(e) => setBody(e.currentTarget.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }} />
          </div>
        </>
      )}
    </Dialog>
  );
}

// 疑似金鑰：在本機遮蔽，不把內容送到任何模型（M5）
function SecretDialog({ f, onClose }) {
  const act = useAction();
  const ref = f.fix?.args?.ref || f.refs?.[0];
  const prev = useData(() => api.secretPreview(ref), [ref]);
  const [err, setErr] = useState(null);
  const run = async (fn, text) => { try { await act(fn, text, { rethrow: true }); onClose(); } catch (e) { setErr(e); } };
  return (
    <Dialog wide title={local(f, 'title')} desc={t('遮蔽在這台電腦上完成，不會把內容送到 Claude 或任何網路服務。遮蔽後檔案會恢復同步；之後仍可從歷史復原。')} onClose={onClose}
      footer={<>
        <button class="btn" onClick={onClose}>{t('稍後再處理')}</button>
        <button class="btn" onClick={() => run(() => api.secretAllow(ref, prev.data?.matches?.[0]?.line), t('已標記為不是金鑰'))}>{t('這不是金鑰')}</button>
        <button class="btn primary" disabled={!prev.data} onClick={() => run(() => api.secretRedact(ref), t('已遮蔽，檔案會恢復同步'))}><IconShield />{t('遮蔽並恢復同步')}</button>
      </>}>
      <ErrorBanner error={err || prev.error} />
      {!prev.data ? <Skeleton rows={4} /> : (
        <>
          <p class="muted" style={{ fontSize: 13 }}>{t('找到 {n} 處：{list}。遮蔽後的內容：', { n: prev.data.matches.length, list: prev.data.matches.map((m) => t('第 {line} 行（{kind}）', { line: m.line, kind: m.kind })).join(t('、')) })}</p>
          <div class="diff">{prev.data.after}</div>
          <p class="faint" style={{ fontSize: 12 }}>{t('建議把金鑰本身存在 Windows 認證管理員或密碼管理工具，記憶裡只寫「存放在哪裡、怎麼取得」。')}</p>
        </>
      )}
    </Dialog>
  );
}

// 需要 Claude 改寫內容的項目（不含金鑰）：提供可以直接貼給 Claude 的指示
function GuideDialog({ f, guide, onClose }) {
  const ref = f.fix?.args?.ref || f.refs?.[0] || '';
  const roots = f.fix?.args?.roots || f.refs || [];
  const prompt = {
    split: `/engram:inbox ${f.id}`,
    rename: t('請協助把下列中文資料夾改成英文名稱：先確認沒有進行中的 Claude Code 對話，改名後執行 engram bind 重新綁定。資料夾：{roots}', { roots: roots.join(t('、')) }),
  }[guide];
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(prompt); setCopied(true); } catch { setCopied(false); } };
  return (
    <Dialog title={local(f, 'title')} desc={t('這件事需要改寫內容，交給 Claude 在對話中處理最安全。複製下面的指示，貼到任何一個 Claude Code 對話即可。')} onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>{t('關閉')}</button><button class="btn primary" onClick={copy}>{copied ? t('已複製') : t('複製指示')}</button></>}>
      <Markdown text={local(f, 'detail')} />
      <pre class="frontmatter" style={{ whiteSpace: 'pre-wrap' }}>{prompt}</pre>
    </Dialog>
  );
}
