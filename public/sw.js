/* CardFlow Service Worker —— 单设备离线缓存
 * 策略：
 *  - 应用壳（/、index.html、app.js、style.css、sw.js、manifest、icon）：network-first，
 *    保证部署后在线用户立即拿到新代码（不再被旧缓存卡住）；离线回退缓存。
 *  - 导航：network-first，离线回退缓存的 index.html。
 *  - 数据 API（/api/*）：stale-while-revalidate，离线用上次缓存的数据。
 *  - 同源静态（vendor 等）：cache-first（很少变动）。
 *  - 跨域 CDN（已自托管，正常不会走到）：best-effort cache-first。
 */
// v4：vendor/tailwind.min.css 由 2.80MB 全量包替换为 10KB 按需构建包，
//     且补齐了 v2.2.19 默认主题缺失的 slate/emerald/amber 色族（详见 tailwind.config.js）。
//     该文件走 cache-first 策略，必须 bump 版本号才能让老用户丢弃旧缓存。
const CACHE = 'cardflow-v4';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/sw.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 导航：network-first，离线回退缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put('/index.html', c)); return res; })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 应用壳（app.js / index.html / style.css / sw.js）：network-first，部署后立即生效
  if (url.origin === self.location.origin && /\/(app\.js|index\.html|style\.css|sw\.js)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put(req, c)); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 数据 API：stale-while-revalidate
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.open(CACHE).then(async (ca) => {
        const cached = await ca.match(req);
        const network = fetch(req).then((res) => { ca.put(req, res.clone()); return res; }).catch(() => null);
        return cached || network;
      })
    );
    return;
  }

  // 同源静态（vendor 等）：cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((r) =>
        r || fetch(req).then((res) => { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put(req, c)); return res; }).catch(() => r)
      )
    );
    return;
  }

  // 跨域：best-effort cache-first
  event.respondWith(
    caches.match(req).then((r) =>
      r || fetch(req, { mode: 'cors' }).then((res) => { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put(req, c)); return res; }).catch(() => r)
    )
  );
});
