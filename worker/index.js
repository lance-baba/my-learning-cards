export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Content-Type': 'application/json;charset=UTF-8',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API 路由: 获取全局索引（始终新鲜，不边缘缓存，保证同步后立即生效）
      if (path === '/api/index') {
        const data = await env.CARD_KV.get('app:index', { type: 'json' });
        return new Response(JSON.stringify(data || {}), {
          headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=30' }
        });
      }

      // API 路由: 获取指定卡片包（边缘缓存，URL 带 &v=VERSION 做版本隔离）
      // 版本不变 => 同一边缘节点在 TTL 内直接命中缓存，不再打 KV；版本变更 => URL 变化自动失效
      if (path === '/api/bundle') {
        const id = url.searchParams.get('id');
        if (!id) return new Response(JSON.stringify({ error: 'Missing ID' }), { status: 400, headers: corsHeaders });

        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request); // 含 ?id= 与 &v= 版本号
        let res = await cache.match(cacheKey);
        if (!res) {
          const data = await env.CARD_KV.get(id, { type: 'json' });
          res = new Response(JSON.stringify(data || {}), {
            headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=86400' }
          });
          ctx.waitUntil(cache.put(cacheKey, res.clone()));
        }
        return res;
      }

      // 静态站点路由分发
      return env.ASSETS.fetch(request);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }
};
