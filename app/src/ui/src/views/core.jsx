// 核心準則：編輯每次對話都會載入的 CORE.md，並看清楚它是怎麼被載入的、佔了多少預算。
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { api } from '../api.js';
import { useData, Skeleton, Meter, ErrorBanner, Banner, useAction, Section, Markdown, useDirty, useSaveShortcut, drafts, ConfirmDialog } from '../components.jsx';
import { Editor } from '../lazy-editor.jsx';
import { fmtBytes, relTime } from '../util.js';
import { IconEye, IconEdit } from '../icons.jsx';
import { AskClaudeButton } from '../askclaude.jsx';
import { t, N_, local } from '../i18n.js';

const KIND = { user: N_('使用者層'), import: N_('引用'), project: N_('專案'), rule: N_('kind::規則') };

export function Core() {
  const core = useData(() => api.core(), []);
  const act = useAction();
  const [text, setText] = useState(null);
  const [view, setView] = useState('edit');
  const [err, setErr] = useState(null);
  const [stash, setStash] = useState(() => drafts.get('core'));
  const [ask, setAsk] = useState(false);
  useEffect(() => { if (core.data && text === null) setText(core.data.text); }, [core.data]);
  const dirty = !!(core.data && text !== null && text !== core.data.text);
  useDirty(dirty, t('核心準則的修改'));
  useEffect(() => { if (dirty) drafts.set('core', { text }); }, [text, dirty]);
  const [secret, setSecret] = useState(null);
  const save = async (allowSecrets = false) => {
    if (!dirty) return;
    setErr(null);
    try { await act(() => api.writeCore(text, allowSecrets), t('核心準則已儲存，下一次對話生效'), { rethrow: true }); drafts.clear('core'); setStash(null); } catch (e) {
      // 疑似金鑰：Engram 不寫入；使用者確認不是金鑰才照樣儲存（M5）
      if (e.code === 'E_SECRET' && !allowSecrets) setSecret(e); else setErr(e);
    }
  };
  useSaveShortcut(() => save(), dirty);

  if (!core.data || text === null) return <div class="page"><ErrorBanner error={core.error} onRetry={core.reload} /><div class="panel"><Skeleton rows={8} /></div></div>;
  const lines = text.split('\n').length;
  const bytes = new TextEncoder().encode(text).length;
  const chainLines = core.data.chain.reduce((a, f) => a + (f.depth > 0 ? (f.path.endsWith('CORE.md') ? lines : f.lines) : 0), 0);

  return (
    <div class="page">
      <div class="grid split">
        <Section title="CORE.md" sub={t('兩台電腦共用，每次對話開始時載入')} end={
          <>
            <div class="seg" role="group" aria-label={t('檢視方式')}>
              <button aria-pressed={view === 'edit'} onClick={() => setView('edit')}><IconEdit style={{ width: 14, height: 14 }} />{t('編輯')}</button>
              <button aria-pressed={view === 'preview'} onClick={() => setView('preview')}><IconEye style={{ width: 14, height: 14 }} />{t('預覽')}</button>
            </div>
            <button class="btn sm" disabled={!dirty} onClick={() => setAsk(true)}>{t('放棄修改')}</button>
            <button class="btn sm primary" disabled={!dirty} onClick={() => save()}>{t('儲存')}</button>
          </>
        }>
          <div class="panel-body" style={{ display: 'grid', gap: 12 }}>
            {stash && !dirty && stash.text !== core.data.text && (
              <Banner tone="info" title={t('有尚未儲存的草稿')} actions={<>
                <button class="btn sm primary" onClick={() => { setText(stash.text); setStash(null); }}>{t('恢復草稿')}</button>
                <button class="btn sm" onClick={() => { drafts.clear('core'); setStash(null); }}>{t('捨棄')}</button>
              </>}>{t('{when}在這個分頁編輯過，還沒有儲存。', { when: relTime(stash.savedAt) })}</Banner>
            )}
            <ErrorBanner error={err} />
            {view === 'edit' ? <Editor value={text} onChange={setText} label={t('核心準則')} /> : <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '14px 18px' }}><Markdown text={text} /></div>}
            <div class="faint" style={{ fontSize: 12 }}>{t('{n} 行', { n: lines })} · {fmtBytes(bytes)}{dirty && ` · ${t('尚未儲存（Ctrl+S 儲存）')}`}</div>
          </div>
        </Section>

        <div class="grid">
          <Section title={t('載入預算')}>
            <div class="panel-body" style={{ display: 'grid', gap: 14 }}>
              <Meter label={t('核心準則＋兩份索引')} value={chainLines} max={200} unit={t(' 行')} />
              <p class="muted" style={{ fontSize: 13 }}>{t('官方建議 CLAUDE.md 與它匯入的檔案合計不超過 200 行。內容越精簡，Claude 越能確實遵守。細節規則可以移到 {rules}，用 {paths} 限定只在相關檔案時載入。', { rules: <code>core/rules/</code>, paths: <code>paths:</code> })}</p>
              <div><AskClaudeButton label={t('請 Claude 精簡')} title={t('請 Claude 精簡每次都會載入的內容')} command="/engram:tidy core"
                intro={t('Claude 會讀核心準則、全域與這台電腦的單機記憶，找出重複、已被其他記憶涵蓋或說明太長的部分，列出刪改前後的差異讓你確認。Engram 維護的區塊會原樣保留。')} /></div>
            </div>
          </Section>

          <Section title={t('載入順序')}>
            <div class="panel-body">
              <div class="chain">
                {core.data.chain.map((f) => (
                  <div key={f.path} class={`link depth-${Math.min(2, f.depth)}${f.isSelf ? ' self' : ''}`}>
                    <span class="dotm" />
                    <span>
                      <span class="path">{f.path}</span>
                      <span class="faint" style={{ display: 'block', fontSize: 11 }}>{KIND[f.kind] ? t(KIND[f.kind]) : f.kind}{f.isSelf ? ` · ${t('只在這台載入')}` : ''}{f.note ? ` · ${local(f, 'note')}` : ''}</span>
                    </span>
                    <span class="size">{t('{n} 行', { n: f.path.endsWith('CORE.md') ? lines : f.lines })}</span>
                  </div>
                ))}
              </div>
              <p class="faint" style={{ fontSize: 12, marginTop: 10 }}>{t('你在 {file} 寫的內容維持原樣；Engram 只在檔案末尾加一段用標記包住的引用區塊。', { file: <code>~/.claude/CLAUDE.md</code> })}</p>
            </div>
          </Section>
        </div>
      </div>
      {secret && <ConfirmDialog title={t('內容疑似含有金鑰')} desc={local(secret, 'message')} confirmLabel={t('這不是金鑰，照樣儲存')} danger
        onConfirm={async () => { setSecret(null); await save(true); }} onClose={() => setSecret(null)}><p class="muted" style={{ fontSize: 13 }}>{t('是真的金鑰時請取消，改成只記「存放在哪裡、怎麼取得」。選「這不是金鑰」後，這些值會記入「不是金鑰」清單（只存雜湊、同步到所有電腦）並照常儲存；核心準則每次對話都會載入，也會同步到其他電腦。')}</p></ConfirmDialog>}
      {ask && <ConfirmDialog title={t('放棄這次的修改？')} desc={t('編輯內容不會儲存。')} confirmLabel={t('放棄修改')} danger onConfirm={() => { setText(core.data.text); drafts.clear('core'); setAsk(false); }} onClose={() => setAsk(false)}><span /></ConfirmDialog>}
    </div>
  );
}
