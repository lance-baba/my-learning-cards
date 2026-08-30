/* CardFlow SW 缓存治理纯逻辑（UMD）
 * 浏览器/SW：作为经典脚本由 sw.js 用 importScripts 加载，挂载 self.SwCache。
 * Node：module.exports 导出，供 tools/sw_cache.test.mjs 单测。
 * 目的：把「按版本号保留最新 bundle 缓存、回收旧版本」的纯逻辑从 SW 抽离，
 *       既能在 CI/本地用 node:assert 覆盖，又让 SW 安装不依赖该文件的脆弱加载。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof self !== 'undefined') self.SwCache = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 语义化版本比较：返回 -1 / 0 / 1（按 . 分段数值比较，兼容 2026.08.28.01 这类 0-padding 格式）
  function compareVersion(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  /* 选择要删除的旧 bundle 缓存键。
   * entries: [{ id: string, v: string, key: (Request|string) }]
   *   每个 entry 对应缓存里一条 /api/bundle?id=..&v=.. 请求。
   * keepPerId: 每个 bundle id 保留多少个最新版本（默认 1，即只留当前版本）。
   * 返回：待删除的 key 数组（仅保留每个 id 下 v 最大的 keepPerId 条，其余回删）。
   * 纯函数：不碰 Cache API，便于单测。SW 侧拿到返回后用 cache.delete(key) 回收。
   */
  function selectStaleBundleKeys(entries, keepPerId) {
    keepPerId = keepPerId || 1;
    const groups = new Map(); // id -> [{ v, key }]
    for (const e of entries) {
      if (!e || !e.id) continue;
      if (!groups.has(e.id)) groups.set(e.id, []);
      groups.get(e.id).push({ v: e.v || '', key: e.key });
    }
    const toDelete = [];
    for (const list of groups.values()) {
      if (list.length <= keepPerId) continue;
      // 按 v 降序，保留前 keepPerId，其余回删
      list.sort((a, b) => compareVersion(b.v, a.v));
      for (let i = keepPerId; i < list.length; i++) toDelete.push(list[i].key);
    }
    return toDelete;
  }

  return { compareVersion, selectStaleBundleKeys };
});
