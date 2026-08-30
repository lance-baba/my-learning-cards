/**
 * 轻量 best-effort 限流（单 isolate / 单进程内存计数）。
 *
 * 设计取舍（工程评审 P1 第 3 项「限流」）：
 *  - Cloudflare Workers 多 isolate 下，Map 不跨 isolate 共享，所以这是「尽力而为」限速，
 *    不是严格全局限速。对防探测扫描 / KV 读放大已足够；真正严格的全局限速需
 *    Durable Objects / KV 原子计数，超出 #74 范围（见评审报告 P1 后续项）。
 *  - 内存计数在 isolate 冷启动/回收时会清零，属可接受误差。
 *
 * 用法：
 *   const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 120, pruneSize: 2000 });
 *   if (!apiLimiter.rateOk(ip)) return new Response(null, { status: 429 });
 *
 * 为可单测，now 可注入（默认 Date.now）。
 */
export function createRateLimiter({ windowMs = 60_000, max = 20, pruneSize = 1000, now = () => Date.now() } = {}) {
  const store = new Map(); // ip -> { n, resetAt }

  function rateOk(ip) {
    const t = now();
    const rec = store.get(ip);
    if (!rec || t > rec.resetAt) {
      store.set(ip, { n: 1, resetAt: t + windowMs });
      // 顺带清理过期项，避免 Map 无界增长
      if (store.size > pruneSize) {
        for (const [k, v] of store) if (t > v.resetAt) store.delete(k);
      }
      return true;
    }
    if (rec.n >= max) return false;
    rec.n += 1;
    return true;
  }

  return { rateOk, _store: store };
}

export default createRateLimiter;
