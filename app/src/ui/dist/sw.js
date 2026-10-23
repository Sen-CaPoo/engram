// Engram 管理介面的 service worker：常駐程式沒有執行時，仍能開啟介面並顯示「連不到常駐程式」的說明（M3）。
// 一律先走網路（常駐程式重啟後 token 會變，頁面必須是最新的）；網路失敗才用快取。API 不經過快取。
const CACHE = 'engram-ui-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/app.js', '/app.css', '/icon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const nav = e.request.mode === 'navigate';
  const key = nav ? '/' : e.request;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          // 首頁內嵌存取權杖：快取前清掉，離線時只用來顯示「連不到常駐程式」（R-46）
          const stored = nav
            ? copy.text().then((t) => new Response(t.replace(/(<meta\s+name=["']engram-token["']\s+content=)["'][^"']*["']/i, '$1""'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
            : Promise.resolve(copy);
          stored.then((r) => caches.open(CACHE).then((c) => c.put(key, r)));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error())),
  );
});
