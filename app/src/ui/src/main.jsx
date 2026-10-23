// 介面外殼：導覽列、頂列、路由、全域狀態、即時事件、未儲存內容的保護。
import { h, render } from 'preact';
import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { api } from './api.js';
import { AppCtx, ToastHost, ErrorBanner, Banner, Dialog } from './components.jsx';
import { relTime, SYNC_LABEL, composing, attentionCount } from './util.js';
import { t, N_, LANGS, getLang, setLang, local } from './i18n.js';
import {
  EngramLogo, IconOverview, IconLibrary, IconInbox, IconProjects, IconDevices, IconCore, IconSchedule, IconImport,
  IconSearch, IconSun, IconMoon, IconMonitor, IconSettings, IconSync, IconGlobe, IconTidy,
} from './icons.jsx';
import { Overview } from './views/overview.jsx';
import { Library } from './views/library.jsx';
import { Inbox } from './views/inbox.jsx';
import { Tidy } from './views/tidy.jsx';
import { Projects } from './views/projects.jsx';
import { Devices } from './views/devices.jsx';
import { Core } from './views/core.jsx';
import { Schedule } from './views/schedule.jsx';
import { Import } from './views/import.jsx';
import { Settings } from './views/settings.jsx';
import './styles.css';

// 標題與分組是中文原文，顯示時經過 t()
const ROUTES = {
  overview: { title: N_('總覽'), short: N_('總覽'), icon: IconOverview, view: Overview, group: N_('nav::記憶') },
  library: { title: N_('記憶庫'), short: N_('記憶庫'), icon: IconLibrary, view: Library, group: N_('nav::記憶') },
  inbox: { title: N_('收件匣'), short: N_('收件匣'), icon: IconInbox, view: Inbox, group: N_('nav::記憶') },
  tidy: { title: N_('記憶整理'), short: N_('整理'), icon: IconTidy, view: Tidy, group: N_('nav::記憶') },
  projects: { title: N_('nav::專案'), short: N_('nav::專案'), icon: IconProjects, view: Projects, group: N_('管理') },
  devices: { title: N_('裝置與同步'), short: N_('裝置'), icon: IconDevices, view: Devices, group: N_('管理') },
  core: { title: N_('核心準則'), short: N_('準則'), icon: IconCore, view: Core, group: N_('管理') },
  schedule: { title: N_('排程與紀錄'), short: N_('排程'), icon: IconSchedule, view: Schedule, group: N_('系統') },
  import: { title: N_('匯入既有記憶'), short: N_('匯入'), icon: IconImport, view: Import, group: N_('系統') },
  settings: { title: N_('設定'), short: N_('設定'), icon: IconSettings, view: Settings, group: N_('系統') },
};
const THEME_LABEL = { system: N_('跟隨系統'), light: N_('淺色'), dark: N_('深色') };

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
  const next = () => setTheme((cur) => (cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system'));
  return [theme, next];
}

// 介面語言：記在本機瀏覽器；切換時整個畫面重新繪製，未儲存的編輯內容不受影響
function useLang() {
  const [lang, set] = useState(getLang);
  useEffect(() => { setLang(lang, false); }, [lang]);
  const change = useCallback((id) => set(setLang(id)), []);
  return [lang, change];
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
  const [lang, changeLang] = useLang();
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

  const reportError = useCallback((e) => setGlobalError(e ? { message: e.message || String(e), hint: e.hint || '', code: e.code, en: e.en } : null), []);
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
    setToasts((list) => [...list.slice(-2), { id, text, undo }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), undo ? 8000 : 4000);
  }, []);
  const dismiss = useCallback((id) => setToasts((list) => list.filter((x) => x.id !== id)), []);

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
      if (['change', 'finding', 'job', 'sync', 'tidy'].includes(name)) refresh();
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
  const ctx = useMemo(() => ({ status, projects, projectsById, version, refresh, toast, go, syncNow, reportError, dirty, lang, changeLang }), [status, projects, projectsById, version, lang]);
  const R = ROUTES[loc.route];
  const View = R.view;
  const hot = attentionCount(status);
  const urgent = status ? status.inbox.conflicts + status.inbox.findings.high : 0;
  const tidyWaiting = status?.tidy?.pending || 0;
  useEffect(() => { document.title = `${t(R.title)} · ${t('Engram 憶跡')}`; }, [R, lang]);
  const otherLang = LANGS.find((l) => l.id !== lang);
  const themeText = t('主題：{name}', { name: t(THEME_LABEL[theme]) });

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
          <a class="brand" href="#/overview" onClick={navClick('overview')} aria-label={t('Engram 憶跡：Claude Code 記憶同步')}>
            <EngramLogo />
            <span class="word"><b>{t('Engram 憶跡')}</b><small>{t('Claude Code 記憶同步')}</small></span>
          </a>
          <nav class="nav" aria-label={t('主要導覽')}>
            {Object.entries(ROUTES).map(([key, r]) => {
              const label = r.group !== lastGroup ? <div class="nav-label" key={`g-${r.group}`}>{t(r.group)}</div> : null;
              lastGroup = r.group;
              const Icon = r.icon;
              return [
                label,
                <a key={key} href={toHash(key)} onClick={navClick(key)} aria-current={loc.route === key ? 'page' : undefined} title={t(r.title)}>
                  <Icon /><span class="txt">{t(r.title)}</span><span class="short" aria-hidden="true">{t(r.short)}</span>
                  {key === 'inbox' && hot > 0 && <span class={`count ${urgent ? 'hot' : 'warm'}`} aria-label={t('{n} 件需要處理', { n: hot })}>{hot}</span>}
                  {key === 'tidy' && tidyWaiting > 0 && <span class="count warm" aria-label={t('{n} 份整理記錄等你決定', { n: tidyWaiting })}>{tidyWaiting}</span>}
                </a>,
              ];
            })}
          </nav>
          <div class="sidebar-foot">
            {api.isDemo && <div class="demo-badge">{t('展示版：資料由記憶盤點產生，動作只在這個頁面裡模擬，不會改到任何檔案。')}</div>}
            {status && (
              <div class="trace" aria-label={t('裝置')}>
                {status.devices.map((d, i) => (
                  <div key={d.id}>
                    {i > 0 && <div class="trace-link" aria-hidden="true" />}
                    <div class="trace-row">
                      <span class={`node${d.isSelf ? ' self' : ''}`} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
                      <small>{d.isSelf ? t('這台') : relTime(d.lastSyncAt || d.lastSeenAt)}</small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        <div class="main">
          <header class="topbar">
            <h1>{t(R.title)}</h1>
            <div class="spacer" />
            <label class="searchbox">
              <IconSearch style={{ width: 16, height: 16, flex: 'none' }} />
              <input ref={searchRef} id="global-search" type="search" placeholder={t('搜尋所有記憶')} onKeyDown={onSearch} aria-label={t('搜尋所有記憶')} />
              <span class="kbd">Ctrl K</span>
            </label>
            {status && <SyncPill sync={status.sync} onClick={() => go('devices')} />}
            <button class="btn ghost sm lang-switch" onClick={() => changeLang(otherLang.id)} lang={otherLang.id} aria-label={t('切換介面語言：{name}', { name: otherLang.label })} title={t('切換介面語言：{name}', { name: otherLang.label })}>
              <IconGlobe /><span class="txt">{otherLang.label}</span>
            </button>
            <button class="btn ghost icon" onClick={nextTheme} aria-label={themeText} title={themeText}>
              {theme === 'dark' ? <IconMoon /> : theme === 'light' ? <IconSun /> : <IconMonitor />}
            </button>
          </header>
          <main class="content" id="main">
            {(globalError || coreConflict) && (
              <div class="page global-banner" style={{ marginBottom: 'var(--sp-4)' }}>
                {globalError && <ErrorBanner error={globalError} onDismiss={() => setGlobalError(null)} />}
                {coreConflict && <Banner tone="bad" title={t('核心準則有同步衝突')} actions={<button class="btn sm" onClick={() => go('inbox')}>{t('處理衝突')}</button>}>{t('兩台電腦都改了 CORE.md。解決之前，每次對話載入的是這台的版本。')}</Banner>}
              </div>
            )}
            {!status && statusError ? <AgentDown error={statusError} onRetry={loadStatus} /> : <View params={loc.params} go={go} key={loc.route} />}
          </main>
        </div>
      </div>
      <ToastHost toasts={toasts} dismiss={dismiss} />
      {leave && (
        <Dialog title={t('離開這一頁？')} desc={t('有尚未儲存的內容：{labels}。離開後會遺失（草稿仍暫存在這個分頁，回來時可以恢復）。', { labels: leave.labels.join(t('、')) })} onClose={() => setLeave(null)}
          footer={<><button class="btn" onClick={() => setLeave(null)}>{t('留在這一頁')}</button><button class="btn danger" onClick={() => { const r = leave.run; dirtyMap.current.clear(); setLeave(null); r(); }}>{t('離開')}</button></>}>
          <span />
        </Dialog>
      )}
    </AppCtx.Provider>
  );
}

function SyncPill({ sync, onClick }) {
  const text = sync.state === 'ok' ? t('已同步 · {when}', { when: relTime(sync.lastSuccessAt) }) : sync.state === 'syncing' ? t('同步中…') : t(SYNC_LABEL[sync.state] || sync.state);
  return (
    <button class={`sync-pill ${sync.state}`} onClick={onClick} title={t('查看裝置與同步')}>
      <span class="led" aria-hidden="true" />
      <span class="txt">{text}</span>
      {sync.ahead > 0 && <span class="chip brand" style={{ height: 18 }} title={t('{n} 個變更等待推送', { n: sync.ahead })}>↑{sync.ahead}</span>}
    </button>
  );
}

// 常駐程式連不上時，不讓畫面停在載入中（M3）
function AgentDown({ error, onRetry }) {
  return (
    <div class="agent-down panel" style={{ padding: 24 }}>
      <h2 style={{ font: '600 20px/1.3 var(--font-display)' }}>{t('連不到 Engram 常駐程式')}</h2>
      <p class="muted">{t('管理介面需要常駐程式提供資料。你的記憶不受影響：Claude Code 照常讀寫，常駐程式恢復後會自動補同步。')}</p>
      <ol>
        <li>{t('正常情況下，登入 Windows 後常駐程式會自動啟動。如果剛開機，請等一分鐘再重試。')}</li>
        <li>{t('也可以在終端機執行 {agent} 手動啟動，或執行 {doctor} 檢查原因。', { agent: <code>engram agent</code>, doctor: <code>engram doctor</code> })}</li>
        <li>{t('如果反覆出現，請到「排程與紀錄」確認登入工作 {task} 是否存在（可執行 {cmd} 重建）。', { task: '\\Engram\\Agent', cmd: <code>engram schedule install</code> })}</li>
      </ol>
      <div class="btn-row"><button class="btn primary" onClick={onRetry}><IconSync />{t('重試')}</button><span class="faint" style={{ fontSize: 12 }}>{local(error, 'message')}</span></div>
    </div>
  );
}

render(<App />, document.getElementById('app'));
