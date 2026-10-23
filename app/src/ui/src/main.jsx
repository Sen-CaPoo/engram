// 介面外殼：導覽列、頂列、路由、全域狀態、即時事件、未儲存內容的保護。
import { h, render } from 'preact';
import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { api } from './api.js';
import { AppCtx, ToastHost, ErrorBanner, Banner, Dialog } from './components.jsx';
import { relTime, SYNC_LABEL, composing, attentionCount } from './util.js';
import {
  EngramLogo, IconOverview, IconLibrary, IconInbox, IconProjects, IconDevices, IconCore, IconSchedule, IconImport,
  IconSearch, IconSun, IconMoon, IconMonitor, IconSettings, IconSync,
} from './icons.jsx';
import { Overview } from './views/overview.jsx';
import { Library } from './views/library.jsx';
import { Inbox } from './views/inbox.jsx';
import { Projects } from './views/projects.jsx';
import { Devices } from './views/devices.jsx';
import { Core } from './views/core.jsx';
import { Schedule } from './views/schedule.jsx';
import { Import } from './views/import.jsx';
import { Settings } from './views/settings.jsx';
import './styles.css';

const ROUTES = {
  overview: { title: '總覽', short: '總覽', icon: IconOverview, view: Overview, group: '記憶' },
  library: { title: '記憶庫', short: '記憶庫', icon: IconLibrary, view: Library, group: '記憶' },
  inbox: { title: '收件匣', short: '收件匣', icon: IconInbox, view: Inbox, group: '記憶' },
  projects: { title: '專案', short: '專案', icon: IconProjects, view: Projects, group: '管理' },
  devices: { title: '裝置與同步', short: '裝置', icon: IconDevices, view: Devices, group: '管理' },
  core: { title: '核心準則', short: '準則', icon: IconCore, view: Core, group: '管理' },
  schedule: { title: '排程與紀錄', short: '排程', icon: IconSchedule, view: Schedule, group: '系統' },
  import: { title: '匯入既有記憶', short: '匯入', icon: IconImport, view: Import, group: '系統' },
  settings: { title: '設定', short: '設定', icon: IconSettings, view: Settings, group: '系統' },
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const route = ROUTES[path] ? path : 'overview';
  const params = Object.fromEntries(new URLSearchParams(query));
  return { route, params };
}

function toHash(route, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return `#/${route}${q ? `?${q}` : ''}`;
}

// 主題：跟隨系統 → 淺色 → 深色，記在本機瀏覽器
function useTheme() {
  const read = () => { try { return localStorage.getItem('engram.theme') || 'system'; } catch { return 'system'; } };
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', theme);
    try { localStorage.setItem('engram.theme', theme); } catch { /* 無法存取時維持預設 */ }
  }, [theme]);
  const next = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'));
  return [theme, next];
}

function App() {
  const [loc, setLoc] = useState(parseHash);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [projects, setProjects] = useState(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [globalError, setGlobalError] = useState(null);
  const [leave, setLeave] = useState(null);
  const [coreConflict, setCoreConflict] = useState(false);
  const [theme, nextTheme] = useTheme();
  const searchRef = useRef(null);
  const lastHash = useRef(location.hash);
  const bypass = useRef(false);

  // 未儲存內容登記表：任何畫面有未儲存的內容時，切換頁面前先確認
  const dirtyMap = useRef(new Map());
  const dirty = useMemo(() => ({
    set: (id, label) => dirtyMap.current.set(id, label),
    delete: (id) => dirtyMap.current.delete(id),
  }), []);
  const guard = useCallback((run) => {
    if (dirtyMap.current.size) setLeave({ run, labels: [...dirtyMap.current.values()] });
    else run();
  }, []);

  const go = useCallback((route, params = {}, replace = false) => {
    const doIt = () => {
      const hash = toHash(route, params);
      bypass.current = true;
      if (replace) history.replaceState(null, '', hash); else location.hash = hash;
      lastHash.current = hash;
      setLoc(parseHash());
      setTimeout(() => { bypass.current = false; }, 0);
    };
    if (replace) doIt(); else guard(doIt);
  }, []);

  const reportError = useCallback((e) => setGlobalError(e ? { message: e.message || String(e), hint: e.hint || '', code: e.code } : null), []);
  const loadStatus = useCallback(() => api.status().then((s) => { setStatus(s); setStatusError(null); }).catch((e) => setStatusError(e)), []);
  const loadProjects = useCallback(() => api.projects().then(setProjects).catch(() => {}), []);
  const bump = useRef(null);
  const refresh = useCallback(() => {
    // 短時間內的多個事件合併成一次重新整理，避免每個面板同時重抓
    clearTimeout(bump.current);
    bump.current = setTimeout(() => { setVersion((v) => v + 1); loadStatus(); loadProjects(); }, 250);
  }, []);

  const toast = useCallback((text, undo) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, text, undo }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), undo ? 8000 : 4000);
  }, []);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const syncNow = useCallback(async () => {
    try { await api.sync(); loadStatus(); } catch (e) { reportError(e); }
  }, []);

  useEffect(() => {
    const onHash = () => {
      if (!bypass.current && dirtyMap.current.size && location.hash !== lastHash.current) {
        const target = location.hash;
        history.replaceState(null, '', lastHash.current);
        setLeave({ run: () => { bypass.current = true; location.hash = target; lastHash.current = target; setLoc(parseHash()); setTimeout(() => { bypass.current = false; }, 0); }, labels: [...dirtyMap.current.values()] });
        return;
      }
      lastHash.current = location.hash;
      setLoc(parseHash());
    };
    const onUnload = (e) => { if (dirtyMap.current.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('beforeunload', onUnload);
    loadStatus(); loadProjects();
    const unsub = api.subscribe((name) => {
      if (name === 'status' || name === 'probe') loadStatus();
      if (['change', 'finding', 'job', 'sync'].includes(name)) refresh();
    });
    const poll = setInterval(loadStatus, 30000);
    const onKey = (e) => {
      if (composing(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    if (!api.isDemo && 'serviceWorker' in navigator && location.protocol === 'http:') navigator.serviceWorker.register('/sw.js').catch(() => {});
    return () => {
      window.removeEventListener('hashchange', onHash); window.removeEventListener('beforeunload', onUnload); window.removeEventListener('keydown', onKey);
      clearInterval(poll); unsub?.();
    };
  }, []);

  // 核心準則有衝突時，每一頁頂端都顯示（M7）
  const nConf = status?.inbox?.conflicts || 0;
  useEffect(() => {
    if (!nConf) { setCoreConflict(false); return; }
    api.conflicts().then((cs) => setCoreConflict(cs.some((c) => /(^|\/)core\/CORE\.md$/.test(c.ref)))).catch(() => {});
  }, [nConf]);

  const projectsById = useMemo(() => Object.fromEntries((projects || []).map((p) => [p.pid, p])), [projects]);
  const ctx = useMemo(() => ({ status, projects, projectsById, version, refresh, toast, go, syncNow, reportError, dirty }), [status, projects, projectsById, version]);
  const R = ROUTES[loc.route];
  const View = R.view;
  const hot = attentionCount(status);
  const urgent = status ? status.inbox.conflicts + status.inbox.findings.high : 0;
  useEffect(() => { document.title = `${R.title} · Engram 憶跡`; }, [R]);

  const onSearch = (e) => {
    if (composing(e)) return;
    if (e.key === 'Enter') { go('library', { q: e.currentTarget.value }); e.currentTarget.blur(); }
    if (e.key === 'Escape') e.currentTarget.blur();
  };
  const navClick = (key) => (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    go(key);
  };

  let lastGroup = null;
  return (
    <AppCtx.Provider value={ctx}>
      <div class="app">
        <aside class="sidebar">
          <a class="brand" href="#/overview" onClick={navClick('overview')} aria-label="Engram 憶跡：Claude Code 記憶同步">
            <EngramLogo />
            <span class="word"><b>Engram 憶跡</b><small>Claude Code 記憶同步</small></span>
          </a>
          <nav class="nav" aria-label="主要導覽">
            {Object.entries(ROUTES).map(([key, r]) => {
              const label = r.group !== lastGroup ? <div class="nav-label" key={`g-${r.group}`}>{r.group}</div> : null;
              lastGroup = r.group;
              const Icon = r.icon;
              return [
                label,
                <a key={key} href={toHash(key)} onClick={navClick(key)} aria-current={loc.route === key ? 'page' : undefined} title={r.title}>
                  <Icon /><span class="txt">{r.title}</span><span class="short" aria-hidden="true">{r.short}</span>
                  {key === 'inbox' && hot > 0 && <span class={`count ${urgent ? 'hot' : 'warm'}`} aria-label={`${hot} 件需要處理`}>{hot}</span>}
                </a>,
              ];
            })}
          </nav>
          <div class="sidebar-foot">
            {api.isDemo && <div class="demo-badge">展示版：資料由記憶盤點產生，動作只在這個頁面裡模擬，不會改到任何檔案。</div>}
            {status && (
              <div class="trace" aria-label="裝置">
                {status.devices.map((d, i) => (
                  <div key={d.id}>
                    {i > 0 && <div class="trace-link" aria-hidden="true" />}
                    <div class="trace-row">
                      <span class={`node${d.isSelf ? ' self' : ''}`} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
                      <small>{d.isSelf ? '這台' : relTime(d.lastSyncAt || d.lastSeenAt)}</small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        <div class="main">
          <header class="topbar">
            <h1>{R.title}</h1>
            <div class="spacer" />
            <label class="searchbox">
              <IconSearch style={{ width: 16, height: 16, flex: 'none' }} />
              <input ref={searchRef} id="global-search" type="search" placeholder="搜尋所有記憶" onKeyDown={onSearch} aria-label="搜尋所有記憶" />
              <span class="kbd">Ctrl K</span>
            </label>
            {status && <SyncPill sync={status.sync} onClick={() => go('devices')} />}
            <button class="btn ghost icon" onClick={nextTheme} aria-label={`主題：${theme === 'system' ? '跟隨系統' : theme === 'light' ? '淺色' : '深色'}`} title={`主題：${theme === 'system' ? '跟隨系統' : theme === 'light' ? '淺色' : '深色'}`}>
              {theme === 'dark' ? <IconMoon /> : theme === 'light' ? <IconSun /> : <IconMonitor />}
            </button>
          </header>
          <main class="content" id="main">
            {(globalError || coreConflict) && (
              <div class="page global-banner" style={{ marginBottom: 'var(--sp-4)' }}>
                {globalError && <ErrorBanner error={globalError} onDismiss={() => setGlobalError(null)} />}
                {coreConflict && <Banner tone="bad" title="核心準則有同步衝突" actions={<button class="btn sm" onClick={() => go('inbox')}>處理衝突</button>}>兩台電腦都改了 CORE.md。解決之前，每次對話載入的是這台的版本。</Banner>}
              </div>
            )}
            {!status && statusError ? <AgentDown error={statusError} onRetry={loadStatus} /> : <View params={loc.params} go={go} key={loc.route} />}
          </main>
        </div>
      </div>
      <ToastHost toasts={toasts} dismiss={dismiss} />
      {leave && (
        <Dialog title="離開這一頁？" desc={`有尚未儲存的內容：${leave.labels.join('、')}。離開後會遺失（草稿仍暫存在這個分頁，回來時可以恢復）。`} onClose={() => setLeave(null)}
          footer={<><button class="btn" onClick={() => setLeave(null)}>留在這一頁</button><button class="btn danger" onClick={() => { const r = leave.run; dirtyMap.current.clear(); setLeave(null); r(); }}>離開</button></>}>
          <span />
        </Dialog>
      )}
    </AppCtx.Provider>
  );
}

function SyncPill({ sync, onClick }) {
  const text = sync.state === 'ok' ? `已同步 · ${relTime(sync.lastSuccessAt)}` : sync.state === 'syncing' ? '同步中…' : SYNC_LABEL[sync.state];
  return (
    <button class={`sync-pill ${sync.state}`} onClick={onClick} title="查看裝置與同步">
      <span class="led" aria-hidden="true" />
      <span class="txt">{text}</span>
      {sync.ahead > 0 && <span class="chip brand" style={{ height: 18 }} title={`${sync.ahead} 個變更等待推送`}>↑{sync.ahead}</span>}
    </button>
  );
}

// 常駐程式連不上時，不讓畫面停在載入中（M3）
function AgentDown({ error, onRetry }) {
  return (
    <div class="agent-down panel" style={{ padding: 24 }}>
      <h2 style={{ font: '600 20px/1.3 var(--font-display)' }}>連不到 Engram 常駐程式</h2>
      <p class="muted">管理介面需要常駐程式提供資料。你的記憶不受影響：Claude Code 照常讀寫，常駐程式恢復後會自動補同步。</p>
      <ol>
        <li>正常情況下，登入 Windows 後常駐程式會自動啟動。如果剛開機，請等一分鐘再重試。</li>
        <li>也可以在終端機執行 <code>engram agent</code> 手動啟動，或執行 <code>engram doctor</code> 檢查原因。</li>
        <li>如果反覆出現，請到「排程與紀錄」確認登入工作 \Engram\Agent 是否存在（可執行 <code>engram schedule install</code> 重建）。</li>
      </ol>
      <div class="btn-row"><button class="btn primary" onClick={onRetry}><IconSync />重試</button><span class="faint" style={{ fontSize: 12 }}>{error?.message}</span></div>
    </div>
  );
}

render(<App />, document.getElementById('app'));
