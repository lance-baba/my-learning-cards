/* CardFlow Service Worker —— 单设备离线缓存
 * 策略：
 *  - 应用壳（/、index.html、app.js、style.css、sw.js、manifest、icon）：network-first，
 *    保证部署后在线用户立即拿到新代码（不再被旧缓存卡住）；离线回退缓存。
 *  - 导航：network-first，离线回退缓存的 index.html。
 *  - 数据 API（/api/*）：stale-while-revalidate，离线用上次缓存的数据。
 *  - 同源静态（vendor 等）：cache-first（很少变动）。
 *  - 跨域 CDN（已自托管，正常不会走到）：best-effort cache-first。
 *
 * #82 缓存配额治理：
 *  - 所有写缓存走 safeCachePut：写入失败（QuotaExceededError 等）先回收旧 bundle 版本再重试一次，
 *    仍失败则静默丢弃，绝不阻断在线请求，也不让 SW 安装因存储满而失败。
 *  - activate 时回收每个 bundle id 下除最新版本外的旧 /api/bundle 缓存（数据先于指针：版本号变 → 新条目，
 *    旧条目此前永不回收，长期膨胀撑爆浏览器 Storage 配额）。
 *  - 纯逻辑 compareVersion / selectStaleBundleKeys 抽至 sw_cache.js（UMD，可单测）；
 *    若 importScripts 失败，回退到文件内联副本，保证 SW 安装不被该文件缺失拖垮。
 */
// v5：接入缓存配额治理（safeCachePut + 旧 bundle 版本回收）。前端任何改动都 bump 本常量，
//     使老用户丢弃旧缓存、拉取新 SW（activate 会删除非当前 CACHE 名）。
const CACHE = 'cardflow-v5';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/monitor.js', '/manifest.webmanifest', '/icon.svg', '/sw.js'];
const MAX_BUNDLE_VERSIONS_PER_ID = 1; // 每个 bundle（分类）仅保留最新一个版本缓存

// ---- 加载纯逻辑层（失败回退内联副本） ----
let SwCache;
try {
  importScripts('./sw_cache.js');
  SwCache = self.SwCache;
} catch (_) {
  SwCache = null;
}
if (!SwCache || typeof SwCache.selectStaleBundleKeys !== 'function') {
  // 回退副本：与 public/sw_cache.js 保持同步
  SwCache = (function () {
    function compareVersion(a, b) {
      if (!a && !b) return 0;
      if (!a) return -1;
      if (!b) return 1;
      const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
      const n = Math.max(pa.length, pb.length);
      for (let i = 0; i < n; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
      }
      return 0;
    }
    function selectStaleBundleKeys(entries, keepPerId) {
      keepPerId = keepPerId || 1;
      const groups = new Map();
      for (const e of entries) {
        if (!e || !e.id) continue;
        if (!groups.has(e.id)) groups.set(e.id, []);
        groups.get(e.id).push({ v: e.v || '', key: e.key });
      }
      const toDelete = [];
      for (const list of groups.values()) {
        if (list.length <= keepPerId) continue;
        list.sort((a, b) => compareVersion(b.v, a.v));
        for (let i = keepPerId; i < list.length; i++) toDelete.push(list[i].key);
      }
      return toDelete;
    }
    return { compareVersion, selectStaleBundleKeys };
  })();
}

// 配额错误名（跨浏览器）
function isQuotaError(err) {
  if (!err) return false;
  const name = err.name || '';
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    name === 'QuotaError'
  );
}

// 安全写缓存：失败先回收旧 bundle 版本再重试一次；仍失败静默丢弃。永不 reject。
async function safeCachePut(cache, request, response) {
  const tryPut = () => cache.put(request, response.clone()); // 每次尝试独立 clone，重试可用
  try {
    await tryPut();
  } catch (err) {
    if (isQuotaError(err)) {
      try {
        await evictStaleBundles(cache);
        await tryPut();
      } catch (_) {
        /* 回收后仍写不进：丢弃，不影响在线请求 */
      }
    }
    // 其他写入错误（如隐私模式禁存储）也静默忽略
  }
}

// 回收每个 bundle id 下除最新版本外的旧 /api/bundle 缓存
async function evictStaleBundles(cache) {
  const reqs = await cache.keys();
  const entries = [];
  for (const r of reqs) {
    let u;
    try {
      u = new URL(r.url);
    } catch (_) {
      continue;
    }
    if (u.pathname === '/api/bundle') {
      entries.push({
        id: u.searchParams.get('id'),
        v: u.searchParams.get('v'),
        key: r,
      });
    }
  }
  const del = SwCache.selectStaleBundleKeys(entries, MAX_BUNDLE_VERSIONS_PER_ID);
  await Promise.all(del.map((k) => cache.delete(k).catch(() => {})));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => caches.open(CACHE))
      .then((c) => evictStaleBundles(c)) // #82：激活即回收上一版本的旧 bundle 缓存
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
        .then(async (res) => {
          await safeCachePut(await caches.open(CACHE), '/index.html', res);
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 应用壳（app.js / index.html / style.css / sw.js）：network-first，部署后立即生效
  if (url.origin === self.location.origin && /\/(app\.js|index\.html|style\.css|sw\.js)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          await safeCachePut(await caches.open(CACHE), req, res);
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 数据 API：stale-while-revalidate
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.open(CACHE).then(async (ca) => {
        const cached = await ca.match(req);
        const network = fetch(req)
          .then(async (res) => {
            await safeCachePut(ca, req, res);
            return res;
          })
          .catch(() => null);
        return cached || network;
      })
    );
    return;
  }

  // 同源静态（vendor 等）：cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((r) =>
        r ||
        fetch(req)
          .then(async (res) => {
            await safeCachePut(await caches.open(CACHE), req, res);
            return res;
          })
          .catch(() => r)
      )
    );
    return;
  }

  // 跨域：best-effort cache-first
  event.respondWith(
    caches.match(req).then((r) =>
      r ||
      fetch(req, { mode: 'cors' })
        .then(async (res) => {
          await safeCachePut(await caches.open(CACHE), req, res);
          return res;
        })
        .catch(() => r)
    )
  );
});
