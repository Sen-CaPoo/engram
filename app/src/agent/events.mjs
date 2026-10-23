// SSE 事件中心：GET /api/events?t=<token>。事件名稱見 api.js：status | sync | change | finding | job | probe。
export const EVENT_NAMES = Object.freeze(['status', 'sync', 'change', 'finding', 'job', 'probe']);
export const KEEPALIVE_MS = 25_000;

export function createEventHub({ keepAliveMs = KEEPALIVE_MS } = {}) {
  const clients = new Set();
  // 每 25 秒送一行註解保活，避免連線被中間設備或瀏覽器判定閒置
  const timer = setInterval(() => {
    for (const res of clients) res.write(': keep-alive\n\n');
  }, keepAliveMs);
  timer.unref();

  return {
    subscribe(req, res, headers = {}) {
      // 連線數上限：分頁開太多時，最舊的連線先關閉（R-46）
      if (clients.size >= 16) { const oldest = clients.values().next().value; oldest.end(); clients.delete(oldest); }
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    emit(name, data) {
      if (!EVENT_NAMES.includes(name)) throw new Error(`未定義的事件：${name}`);
      const msg = `event: ${name}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
      for (const res of clients) res.write(msg);
    },
    get size() {
      return clients.size;
    },
    close() {
      clearInterval(timer);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
