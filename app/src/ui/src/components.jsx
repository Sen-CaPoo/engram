// 共用元件：資料載入、標籤、量表、對話框、提示、Markdown 檢視、未儲存內容的保護。
import { h, createContext, Fragment } from 'preact';
import { useState, useEffect, useCallback, useContext, useRef } from 'preact/hooks';
import { api } from './api.js';
import { TYPE_LABEL, relTime, markdownToHtml, fmtBytes, composing, undoText } from './util.js';
import { IconGlobe, IconFolder, IconMonitor, IconAlert, IconInfo, IconOctagon, IconX } from './icons.jsx';

// ── 全域情境：狀態、專案對照、提示、重新整理、錯誤橫幅、未儲存保護 ──
export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// 讀取資料；version 變動（SSE 事件或動作完成）時自動重抓
export function useData(loader, deps = []) {
  const { version } = useApp();
  const [state, set] = useState({ data: undefined, error: null, loading: true });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const load = useCallback(() => {
    set((s) => ({ ...s, loading: true }));
    loader().then(
      (data) => alive.current && set({ data, error: null, loading: false }),
      (error) => alive.current && set((s) => ({ data: s.data, error, loading: false })),
    );
  }, deps);
  useEffect(load, [load, version]);
  return { ...state, reload: load };
}

// 登記「這個畫面有未儲存的內容」。切換頁面、關閉分頁、關閉對話框前都會先確認。
export function useDirty(isDirty, label = '未儲存的內容') {
  const { dirty } = useApp();
  const id = useRef(Math.random().toString(36).slice(2));
  useEffect(() => {
    if (isDirty) dirty.set(id.current, label); else dirty.delete(id.current);
    return () => dirty.delete(id.current);
  }, [isDirty, label]);
}

// Ctrl+S（⌘S）儲存；只在 active 時攔截，避免觸發瀏覽器的「另存網頁」
export function useSaveShortcut(onSave, active) {
  const cb = useRef(onSave);
  cb.current = onSave;
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (composing(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); cb.current?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

// 草稿暫存在 sessionStorage：誤關分頁或切換後可以恢復
export const drafts = {
  get(key) { try { return JSON.parse(sessionStorage.getItem(`engram.draft.${key}`) || 'null'); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(`engram.draft.${key}`, JSON.stringify({ ...value, savedAt: new Date().toISOString() })); } catch { /* 無法存取時略過 */ } },
  clear(key) { try { sessionStorage.removeItem(`engram.draft.${key}`); } catch { /* 略過 */ } },
};

// ── 標籤 ─────────────────────────────────────────────
export function TypeLabel({ type }) {
  return <span class={`type ${type}`}>{TYPE_LABEL[type] || type}</span>;
}

export function ScopeLabel({ scope, short }) {
  const { projectsById, status } = useApp();
  if (!scope) return null;
  if (scope.kind === 'global') return <span class="scope global"><IconGlobe /><span>全域</span></span>;
  if (scope.kind === 'machine') {
    const dev = status?.devices?.find((d) => d.id === scope.mid);
    const self = dev?.isSelf;
    return <span class={`scope machine${self ? ' self' : ''}`}><IconMonitor /><span>{short ? '單機' : `單機 · ${dev?.label || scope.mid}`}</span></span>;
  }
  const p = projectsById?.[scope.pid];
  return <span class="scope project" title={scope.pid}><IconFolder /><span>{p?.name || scope.pid}</span></span>;
}

const SEV_TEXT = { high: '高', medium: '中', low: '建議', conflict: '衝突' };
export function SevChip({ sev }) {
  return <span class={`sev-chip ${sev}`}>{SEV_TEXT[sev] || sev}</span>;
}

export function When({ at }) {
  return <time class="when" dateTime={at} title={at ? new Date(at).toLocaleString('zh-TW') : ''}>{relTime(at)}</time>;
}

export function Meter({ value, max, label, unit = '', warnAt = 0.75 }) {
  const ratio = max ? Math.min(1, value / max) : 0;
  const cls = ratio >= 1 ? 'bad' : ratio >= warnAt ? 'warn' : '';
  return (
    <div class={`meter ${cls}`} role="meter" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
      <div class="track"><div class="fill" style={{ width: `${Math.max(2, ratio * 100)}%` }} /></div>
      <div class="cap"><span>{label}</span><span>{value}{unit} / {max}{unit}</span></div>
    </div>
  );
}

export function Banner({ tone = 'info', title, children, actions }) {
  const Icon = tone === 'bad' ? IconOctagon : tone === 'warn' ? IconAlert : IconInfo;
  return (
    <div class={`banner ${tone}`} role={tone === 'info' ? 'status' : 'alert'}>
      <Icon />
      <div>{title && <b>{title}　</b>}{children}</div>
      {actions && <div class="btn-row">{actions}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry, onDismiss }) {
  if (!error) return null;
  return (
    <Banner tone="bad" title={error.message} actions={<>
      {onRetry && <button class="btn sm" onClick={onRetry}>重試</button>}
      {onDismiss && <button class="btn sm ghost" onClick={onDismiss}>關閉</button>}
    </>}>
      {error.hint}
    </Banner>
  );
}

export function Empty({ icon: Icon = IconInfo, title, children, action }) {
  return (
    <div class="empty">
      <Icon />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 4 }) {
  return (
    <div class="rows" aria-busy="true" aria-label="載入中">
      {Array.from({ length: rows }, (_, i) => (
        <div class="row" key={i} style={{ cursor: 'default' }}>
          <div style={{ height: 12, width: `${40 + ((i * 17) % 40)}%`, background: 'var(--border)', borderRadius: 4 }} />
          <div style={{ gridColumn: '1 / -1', height: 10, width: `${60 + ((i * 13) % 30)}%`, background: 'var(--panel-2)', borderRadius: 4 }} />
        </div>
      ))}
    </div>
  );
}

export function Markdown({ text }) {
  return <div class="prose" dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} />;
}

export function Bytes({ n }) { return <span class="num">{fmtBytes(n)}</span>; }

// ── 對話框：原生 <dialog>（焦點鎖定、背景不可操作） ──────
// dirty 為 true 時，點背景不會關閉；按 Esc 或關閉鈕會先確認是否放棄內容。
export function Dialog({ title, desc, wide, onClose, children, footer, dirty = false }) {
  const ref = useRef(null);
  const [asking, setAsking] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const tryClose = useCallback(() => { if (dirtyRef.current) setAsking(true); else onClose?.(); }, [onClose]);
  useEffect(() => {
    const d = ref.current;
    const prev = document.activeElement;
    try { d.showModal(); } catch { d.setAttribute('open', ''); }
    d.querySelector('input, textarea, select, button.primary')?.focus();
    const onCancel = (e) => { e.preventDefault(); tryClose(); };
    d.addEventListener('cancel', onCancel);
    return () => { d.removeEventListener('cancel', onCancel); try { d.close(); } catch { /* 已關閉 */ } prev?.focus?.(); };
  }, []);
  const onBackdrop = (e) => {
    if (e.target !== ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside && !dirtyRef.current) onClose?.();
  };
  return (
    <dialog class={`dialog${wide ? ' wide' : ''}`} ref={ref} aria-label={title} onMouseDown={onBackdrop}>
      <header>
        <div style={{ display: 'flex', alignItems: 'start', gap: 8 }}>
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button class="btn ghost icon sm" aria-label="關閉" onClick={tryClose}><IconX /></button>
        </div>
        {desc && <p>{desc}</p>}
      </header>
      <div class="body">{children}</div>
      {asking ? (
        <div class="leave-confirm" role="alertdialog" aria-label="放棄未儲存的內容？">
          <span>這裡有尚未儲存的內容，關閉後會遺失。</span>
          <button class="btn sm" onClick={() => setAsking(false)}>繼續編輯</button>
          <button class="btn sm danger" onClick={() => { setAsking(false); onClose?.(); }}>放棄並關閉</button>
        </div>
      ) : footer && <footer>{footer}</footer>}
    </dialog>
  );
}

// 確認對話框：動作前先說清楚會發生什麼
export function ConfirmDialog({ title, desc, confirmLabel = '確定', danger, onConfirm, onClose, children }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} desc={desc} onClose={onClose} footer={<>
      <button class="btn" onClick={onClose}>取消</button>
      <button class={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{busy ? '處理中…' : confirmLabel}</button>
    </>}>
      {children}
    </Dialog>
  );
}

// ── 提示（只用於「已完成，可復原」） ───────────────────
export function ToastHost({ toasts, dismiss }) {
  return (
    <div class="toast-host" aria-live="polite">
      {toasts.map((t) => (
        <div class="toast" key={t.id}>
          <span style={{ flex: 1 }}>{t.text}</span>
          {t.undo && <button class="btn sm" onClick={() => { t.undo(); dismiss(t.id); }}>復原</button>}
          <button class="btn sm ghost icon" aria-label="關閉" style={{ color: 'inherit' }} onClick={() => dismiss(t.id)}><IconX /></button>
        </div>
      ))}
    </div>
  );
}

// 執行動作：成功時顯示可復原的提示並重新整理；失敗時顯示在頁面上方的錯誤橫幅（不用 toast）。
// rethrow：呼叫端需要自己處理錯誤時（例如保持對話框開啟）設為 true。doneText 也可以是依結果決定文字的函式。
export function useAction() {
  const { toast, refresh, reportError } = useApp();
  return useCallback(async (fn, doneText, { rethrow = false } = {}) => {
    try {
      const res = await fn();
      refresh();
      const text = typeof doneText === 'function' ? doneText(res) : doneText;
      if (text) {
        const undoSha = res?.undo?.sha;
        toast(text, undoSha ? async () => {
          try { const r = await api.undo(undoSha); refresh(); toast(undoText(r, '已復原')); } catch (e) { reportError(e); }
        } : null);
      }
      return res;
    } catch (e) {
      if (rethrow) throw e;
      reportError(e);
      return null;
    }
  }, [toast, refresh, reportError]);
}

export function Section({ title, sub, end, children }) {
  return (
    <section class="panel">
      <div class="panel-head">
        <h2>{title}</h2>
        {sub && <span class="sub">{sub}</span>}
        {end && <div class="end">{end}</div>}
      </div>
      {children}
    </section>
  );
}

export { Fragment };
