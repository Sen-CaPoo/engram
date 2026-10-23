// 共用的小工具：時間、標籤、Markdown 轉換、frontmatter 拆解。

export const TYPE_LABEL = { user: '使用者', feedback: '回饋', project: '專案', reference: '參考' };
export const SEVERITY_LABEL = { high: '高', medium: '中', low: '低', auto: '自動' };
export const SYNC_LABEL = {
  ok: '已同步', syncing: '同步中', offline: '離線', auth: '需要登入 GitHub', error: '同步失敗', never: '尚未同步',
};

const pad = (n) => String(n).padStart(2, '0');

export function relTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const s = Math.round((now - t) / 1000);
  if (s < 45) return '剛剛';
  if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
  if (s < 6 * 3600) return `${Math.round(s / 3600)} 小時前`;
  const d = new Date(t), today = new Date(now);
  const dayDiff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) return `${dayDiff} 天前`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function untilTime(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 30) return '即將執行';
  if (s < 3600) return `${Math.ceil(s / 60)} 分鐘後`;
  const d = new Date(iso);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (s < 24 * 3600 && d.getDate() === new Date(now).getDate()) return `今天 ${hm}`;
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

export function fmtNum(n) { return n == null ? '—' : n.toLocaleString('zh-TW'); }

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
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
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
  sync: '與其他電腦同步', autosave: '自動儲存', move: '改變範圍', merge: '合併記憶', edit: '編輯記憶', remove: '刪除記憶',
  restore: '還原記憶', import: '匯入既有記憶', sweep: '收編既有記憶', bind: '綁定專案資料夾', unbind: '解除綁定',
  init: '建立記憶庫', conflict: '隔離同步衝突', tidy: '整理索引', link: '合併專案', undo: '復原變更', core: '編輯核心準則',
};
export function humanizeCommit(c) {
  const title = ACTION_TEXT[c.action] || '變更';
  const m = /([+＋])(\d+)\s*[~～](\d+)\s*[−-](\d+)/.exec(c.message || '');
  if (m) {
    const parts = [];
    if (+m[2]) parts.push(`新增 ${m[2]} 筆`);
    if (+m[3]) parts.push(`修改 ${m[3]} 筆`);
    if (+m[4]) parts.push(`刪除 ${m[4]} 筆`);
    return { title, detail: parts.join('、') || '沒有內容變更' };
  }
  if (c.action === 'sync') return { title, detail: /merge/i.test(c.message) ? '合併了另一台電腦的變更' : '推送這台的變更' };
  return { title, detail: (c.message || '').replace(/^engram\([^)]*\):\s*/, '') };
}

// 復原的結果：資料夾改名的整批還原可能只完成一部分（有資料夾被其他程式開著），照實說並提示再按一次
export function undoText(res, okText) {
  if (res?.done === false) return `部分還原：${res.notes?.[0] ?? '有資料夾沒有改回'}。處理後再按一次復原`;
  if (res?.notes?.length) return `${okText}；注意：${res.notes.join('；')}`;
  return okText;
}

// 經過多久（用在「已經 9 天沒有同步」這類句子）
export function since(iso, now = Date.now()) {
  if (!iso) return '很久';
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m} 分鐘`;
  if (m < 48 * 60) return `${Math.round(m / 60)} 小時`;
  return `${Math.round(m / 1440)} 天`;
}
