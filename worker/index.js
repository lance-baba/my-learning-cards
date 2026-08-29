/**
 * CardFlow Worker —— 数据 API + 静态资源分发
 *
 * 安全基线（工程评审 P0 第 3 项）：
 *  1) CORS 改为「默认同源」：/api/* 与静态资源本就同域，前端请求不需要跨域头。
 *     仅当 Origin 命中 ALLOWED_ORIGINS 白名单时才回 Access-Control-Allow-Origin，
 *     不再无差别 `*`，避免任意站点抓取整套题库。
 *  2) 错误脱敏：异常详情只写日志（供 Sentry / Workers Analytics 采集），
 *     响应体返回固定文案，不再回显 e.message（避免泄露内部键名/堆栈）。
 *  3) 入参白名单：bundle id 仅允许键名字符集，异常输入直接 400，不打穿 KV。
 *
 * 可选配置（不配即最严格）：
 *   wrangler secret put ALLOWED_ORIGINS   # 逗号分隔，如 https://fwzy.ccwu.cc
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 白名单来源（可选）：未配置 = 不向任何跨源站点授予 CORS
    const allowedOrigins = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const baseHeaders = {
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Content-Type': 'application/json;charset=UTF-8',
    };

    // 同源请求（无 Origin）天然放行，无需跨域头；跨源仅在白名单内才授予
    const origin = request.headers.get('Origin');
    const corsHeaders =
      origin && allowedOrigins.includes(origin)
        ? { ...baseHeaders, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
        : baseHeaders;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API 路由: 获取全局索引（始终新鲜，不边缘缓存，保证同步后立即生效）
      if (path === '/api/index') {
        const data = await env.CARD_KV.get('app:index', { type: 'json' });
        return new Response(JSON.stringify(data || {}), {
          headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=30' },
        });
      }

      // API 路由: 获取指定卡片包（边缘缓存，URL 带 &v=VERSION 做版本隔离）
      // 版本不变 => 同一边缘节点在 TTL 内直接命中缓存，不再打 KV；版本变更 => URL 变化自动失效
      if (path === '/api/bundle') {
        const id = url.searchParams.get('id');
        if (!id) {
          return new Response(JSON.stringify({ error: 'Missing ID' }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        // 入参白名单：仅允许 bundle:science:v1 这类键名字符集，防异常输入打穿 KV
        if (!/^[A-Za-z0-9:_-]{1,64}$/.test(id)) {
          return new Response(JSON.stringify({ error: 'Invalid ID' }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request); // 含 ?id= 与 &v= 版本号
        let res = await cache.match(cacheKey);
        if (!res) {
          const data = await env.CARD_KV.get(id, { type: 'json' });
          res = new Response(JSON.stringify(data || {}), {
            headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=86400' },
          });
          ctx.waitUntil(cache.put(cacheKey, res.clone()));
        }
        return res;
      }

      // 静态站点路由分发
      return env.ASSETS.fetch(request);
    } catch (e) {
      // 错误脱敏：详情进日志（供可观测性采集），响应只给固定文案
      console.error(
        '[cardflow] unhandled error',
        JSON.stringify({ path, message: e && e.message, stack: e && e.stack })
      );
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};
