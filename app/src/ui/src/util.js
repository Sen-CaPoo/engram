// 共用的小工具：時間、標籤、Markdown 轉換、frontmatter 拆解。
import { t, N_, local, locale, getLang } from './i18n.js';

// 標籤表的值是中文原文，顯示時一律經過 t()
export const TYPE_LABEL = { user: N_('使用者'), feedback: N_('回饋'), project: N_('專案'), reference: N_('參考') };
export const SEVERITY_LABEL = { high: N_('高'), medium: N_('中'), low: N_('低'), auto: N_('自動') };
export const SYNC_LABEL = {
  ok: N_('已同步'), syncing: N_('同步中'), busy: N_('同步中'), offline: N_('離線'), auth: N_('需要登入 GitHub'), error: N_('同步失敗'), never: N_('尚未同步'),
};

const pad = (n) => String(n).padStart(2, '0');

export function relTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const at = new Date(iso).getTime();
  const s = Math.round((now - at) / 1000);
  if (s < 45) return t('剛剛');
  if (s < 3600) return t('{n} 分鐘前', { n: Math.round(s / 60) });
  if (s < 6 * 3600) return t('{n} 小時前', { n: Math.round(s / 3600) });
  const d = new Date(at), today = new Date(now);
  const dayDiff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayDiff === 0) return t('今天 {hm}', { hm });
  if (dayDiff === 1) return t('昨天 {hm}', { hm });
  if (dayDiff < 7) return t('{n} 天前', { n: dayDiff });
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function untilTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 30) return t('即將執行');
  if (s < 3600) return t('{n} 分鐘後', { n: Math.ceil(s / 60) });
  const d = new Date(iso);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (s < 24 * 3600 && d.getDate() === new Date(now).getDate()) return t('今天 {hm}', { hm });
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function clock(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtNum(n) { return n == null ? '—' : n.toLocaleString(locale()); }

export function scopeKey(scope) {
  if (!scope) return '';
  if (scope.kind === 'global') return 'global';
  if (scope.kind === 'project') return `project:${scope.pid}`;
  return `machine:${scope.mid}`;
}

export function parseScopeKey(key) {
  if (!key || key === 'all') return null;
  if (key === 'global') return { kind: 'global' };
  const [kind, id] = key.split(':');
  return kind === 'project' ? { kind, pid: id } : { kind, mid: id };
}

// IME 防護：組字中（注音、倉頡）不處理快捷鍵與 Enter
export const composing = (e) => e.isComposing || e.keyCode === 229;

export function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw || '');
  if (!m) return { fm: '', body: raw || '' };
  return { fm: m[1], body: raw.slice(m[0].length) };
}

// 精簡、安全的 Markdown 轉 HTML：先跳脫，再處理有限的語法。
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<code>$1</code>');
  return out;
}

export function markdownToHtml(md) {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let list = null, para = [], code = null;
  const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) { html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) { flushPara(); flushList(); html.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  if (code) html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flushPara(); flushList();
  return html.join('\n');
}

export function debounce(fn, ms) {
  let timer;
  return (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), ms); };
}

export function plural(n, unit) { return `${fmtNum(n)} ${unit}`; }

// 「需要處理」的唯一定義：衝突＋高＋中（低等級是建議，不計入徽章與標題）
export function attentionCount(status) {
  if (!status) return 0;
  const f = status.inbox?.findings || {};
  return (status.inbox?.conflicts || 0) + (f.high || 0) + (f.medium || 0);
}

// 變更紀錄改用白話，不顯示 git 術語
const ACTION_TEXT = {
  sync: N_('與其他電腦同步'), autosave: N_('自動儲存'), move: N_('改變範圍'), merge: N_('合併記憶'), edit: N_('編輯記憶'), remove: N_('刪除記憶'),
  restore: N_('還原記憶'), import: N_('匯入既有記憶'), sweep: N_('收編既有記憶'), bind: N_('綁定專案資料夾'), unbind: N_('解除綁定'),
  init: N_('建立記憶庫'), conflict: N_('隔離同步衝突'), tidy: N_('整理索引'), link: N_('合併專案'), undo: N_('復原變更'), core: N_('編輯核心準則'),
};
export function humanizeCommit(c) {
  const title = t(ACTION_TEXT[c.action] || N_('變更'));
  const m = /([+＋])(\d+)\s*[~～](\d+)\s*[−-](\d+)/.exec(c.message || '');
  if (m) {
    const parts = [];
    if (+m[2]) parts.push(t('新增 {n} 筆', { n: +m[2] }));
    if (+m[3]) parts.push(t('修改 {n} 筆', { n: +m[3] }));
    if (+m[4]) parts.push(t('刪除 {n} 筆', { n: +m[4] }));
    return { title, detail: parts.join(t('、')) || t('沒有內容變更') };
  }
  if (c.action === 'sync') return { title, detail: /merge/i.test(c.message) ? t('合併了另一台電腦的變更') : t('推送這台的變更') };
  // 變更紀錄的訊息是 git commit 原文（中文）；英文介面看不懂，只顯示已翻譯的標題
  const detail = (c.message || '').replace(/^engram\([^)]*\):\s*/, '');
  return { title, detail: getLang() !== 'zh-TW' && /\p{Script=Han}/u.test(detail) ? '' : detail };
}

// 復原的結果：資料夾改名的整批還原可能只完成一部分（有資料夾被其他程式開著），照實說並提示再按一次
export function undoText(res, okText) {
  const notes = local(res, 'notes');
  if (res?.done === false) return t('部分還原：{note}。處理後再按一次復原', { note: notes?.[0] ?? t('有資料夾沒有改回') });
  if (notes?.length) return t('{ok}；注意：{notes}', { ok: okText, notes: notes.join(t('；')) });
  return okText;
}

// 經過多久（用在「已經 9 天沒有同步」這類句子）
export function since(iso, now = Date.now()) {
  if (!iso) return t('很久');
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 60) return t('{n} 分鐘', { n: m });
  if (m < 48 * 60) return t('{n} 小時', { n: Math.round(m / 60) });
  return t('{n} 天', { n: Math.round(m / 1440) });
}
