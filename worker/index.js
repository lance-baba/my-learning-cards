/**
 * CardFlow Worker —— 数据 API + 静态资源分发
 *
 * 安全基线（工程评审 P0 第 3 项）：
 *  1) CORS 改为「默认同源」：/api/* 与静态资源本就同域，前端请求不需要跨域头。
 *     仅当 Origin 命中 ALLOWED_ORIGINS 白名单时才回 Access-Control-Allow-Origin，
 *     不再无差别 `*`，避免任意站点抓取整套题库。
 *  2) 错误脱敏：异常详情只写日志（供 Sentry / Workers Logs 采集），
 *     响应体返回固定文案，不再回显 e.message（避免泄露内部键名/堆栈）。
 *  3) 入参白名单：bundle id 仅允许键名字符集，异常输入直接 400，不打穿 KV。
 *
 * 可观测性（工程评审 P0 第 4 项，见 ./observe.js）：
 *  4) 所有 /api/* 请求输出结构化日志（request-id、路径、状态码、耗时 ms）。
 *  5) /api/health 供部署后自检与探活。
 *  6) /api/log 接收前端未捕获异常，落结构化日志；配了 SENTRY_DSN 时转发 Sentry。
 *     前端上报做了去重与条数上限，端点侧再叠一层 IP 限流，防止失控循环打爆日志。
 *
 * 可选配置（不配即最严格）：
 *   wrangler secret put ALLOWED_ORIGINS   # 逗号分隔，如 https://fwzy.ccwu.cc
 *   wrangler secret put SENTRY_DSN        # 接入后错误自动上报，不配则仅写日志
 *   wrangler secret put APP_VERSION       # 可选，Sentry 里标记 release
 */
import { requestId, log, captureException } from './observe.js';
import { createRateLimiter } from './ratelimit.js';

/** 前端错误上报限流：同一 isolate 内按 IP 计数（best-effort，见 ratelimit.js 说明） */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20; // 每 IP 每分钟最多 20 条
const logLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_MAX, pruneSize: 1000 });

/** 全局 /api/* 限流（best-effort，单 isolate）：防 KV 读放大与探测扫描 */
const API_RATE_WINDOW_MS = 60_000;
const API_RATE_MAX = 120; // 每 IP 每分钟 120 次（index+bundle+health+log 合计）
const apiLimiter = createRateLimiter({ windowMs: API_RATE_WINDOW_MS, max: API_RATE_MAX, pruneSize: 2000 });

/** 题库上传限流（best-effort）：上传虽需密钥，仍限量防 KV 写入滥用 */
const BANK_UPLOAD_WINDOW_MS = 60_000;
const BANK_UPLOAD_MAX = 10; // 每 IP 每分钟最多上传 10 个题库
const bankLimiter = createRateLimiter({ windowMs: BANK_UPLOAD_WINDOW_MS, max: BANK_UPLOAD_MAX, pruneSize: 500 });

/**
 * 内容安全策略：收紧为同源资源，杜绝外链脚本/内联脚本注入（XSS 防护基线）。
 *
 * ⚠️ script-src 必须含 'unsafe-eval'：本项目用「Vue 3 全局构建 + 无构建步骤」方案，
 * 运行时模板编译器靠 new Function()（即 eval）编译 index.html 里的 in-DOM 模板与各组件
 * 的 template 选项。若去掉 'unsafe-eval'，Vue 直接抛 EvalError 导致整站白屏（已在 #74
 * 本地 fresh-profile 实测确认）。
 *
 * 风险说明：'unsafe-eval' 只影响「把字符串当代码执行」这一条路径。本应用模板全部来自
 * 自有源码（index.html + app.js），不会把任何用户/题库数据喂进 eval；CSP 仍禁止内联
 * <script> 与外链脚本。因此该项的 XSS 风险增量可忽略，属本架构下的必要且可接受取舍。
 * 若要彻底去掉 'unsafe-eval'，需改「Vue runtime-only 构建 + 预编译 render 函数」，那要
 * 引入构建步骤，超出 #74 范围（见评审报告 P1 后续项）。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "manifest-src 'self'",
].join('; ');

async function handle(request, env, ctx, rid) {
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

  // 全局 /api/* 限流（best-effort，单 isolate）：连续打 API 直接 429，保护 KV 与 Worker 算力
  if (path.startsWith('/api/') && !apiLimiter.rateOk(request.headers.get('CF-Connecting-IP') || 'unknown')) {
    log('warn', 'api_rate_limited', { rid, path });
    return new Response(null, { status: 429, headers: corsHeaders });
  }

  try {
    // ---- 健康检查：部署自检 / 探活。不读 KV，零成本 ----
    if (path === '/api/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          ts: new Date().toISOString(),
          version: env.APP_VERSION || null,
          env: env.APP_ENV || 'production',
        }),
        { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } }
      );
    }

    // ---- 前端错误上报（POST）----
    if (path === '/api/log') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: corsHeaders,
        });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!logLimiter.rateOk(ip)) {
        log('warn', 'log_rate_limited', { rid, ip });
        return new Response(null, { status: 429, headers: corsHeaders });
      }
      const raw = await request.text();
      // 体积上限：堆栈可能很长，截断防止单条日志过大
      if (raw.length > 8192) {
        return new Response(JSON.stringify({ error: 'Payload Too Large' }), {
          status: 413,
          headers: corsHeaders,
        });
      }
      let payload = {};
      try {
        payload = JSON.parse(raw) || {};
      } catch {
        return new Response(JSON.stringify({ error: 'Bad Request' }), {
          status: 400,
          headers: corsHeaders,
        });
      }
      // 只取白名单字段，避免客户端塞任意内容进日志
      const message = String(payload.message || '').slice(0, 1000);
      const stack = String(payload.stack || '').slice(0, 4000);
      const src = String(payload.source || 'frontend').slice(0, 32);

      ctx.waitUntil(
        captureException(env, { name: 'FrontendError', message, stack }, {
          rid,
          source: src,
          url: String(payload.url || '').slice(0, 500),
        })
      );
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // API 路由: 获取全局索引（始终新鲜，不边缘缓存，保证同步后立即生效）
    if (path === '/api/index') {
      const data = await env.CARD_KV.get('app:index', { type: 'json' });
      return new Response(JSON.stringify(data || {}), {
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=30' },
      });
    }

    // API 路由: 获取指定卡片包
    // 注意：本运行环境的 caches.default（Cache API）极不可靠——match/put 会间歇抛错，
    // 且一旦 put 后后续 match 稳定抛错，曾造成「首请求成功、之后全部 500」的灾难。
    // 因此这里完全放弃边缘缓存，只做 KV 读取 + 容错。KV 读放大靠前端版本号 &v= 隔离，
    // 数据量很小，直接回源 KV 的延迟可忽略，稳定性远重于那点缓存收益。
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

      // 回源 KV；KV 异常降级为优雅空包，绝不抛 500（避免前端整站「卡片加载失败」）。
      let data = null;
      try {
        data = await env.CARD_KV.get(id, { type: 'json' });
      } catch (kvErr) {
        ctx.waitUntil(captureException(env, kvErr, { rid, path, id }));
      }
      const payload = data && Array.isArray(data.items) ? data : { items: [] };
      return new Response(JSON.stringify(payload), {
        headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=60' },
      });
    }

    // 备考题库：上传（需密钥）→ 生成随机验证码；按验证码加载（公开）
    // 验证码为 16 位不可猜测的随机串，存在 CARD_KV 的 bank:<code>。
    if (path === '/api/bank') {
      if (request.method === 'POST') {
        // 鉴权：必须带正确上传密钥（env.BANK_UPLOAD_KEY），否则无权发布
        const key = request.headers.get('X-Bank-Key') || '';
        if (!env.BANK_UPLOAD_KEY || key !== env.BANK_UPLOAD_KEY) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }
        if (!bankLimiter.rateOk(request.headers.get('CF-Connecting-IP') || 'unknown')) {
          return new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429, headers: corsHeaders });
        }
        const raw = await request.text();
        if (raw.length > 1_000_000) {
          return new Response(JSON.stringify({ error: 'Payload Too Large' }), { status: 413, headers: corsHeaders });
        }
        let bank;
        try { bank = JSON.parse(raw); } catch {
          return new Response(JSON.stringify({ error: 'Bad Request' }), { status: 400, headers: corsHeaders });
        }
        // 入参校验：必须有非空 questions 数组，其余字段可选
        if (!bank || !Array.isArray(bank.questions) || !bank.questions.length) {
          return new Response(JSON.stringify({ error: 'Invalid Bank' }), { status: 400, headers: corsHeaders });
        }
        // 生成不可猜测的验证码（UUID 去横杠取前 16 位）
        const code = (typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : (Date.now().toString(16) + Math.random().toString(16).slice(2))
        ).replace(/-/g, '').slice(0, 16);
        // 只存必要字段，避免客户端塞入垃圾数据撑爆 KV
        const clean = {
          title: String(bank.title || '').slice(0, 80),
          version: String(bank.version || code).slice(0, 40),
          chapters: Array.isArray(bank.chapters) ? bank.chapters : [],
          shortNames: bank.shortNames && typeof bank.shortNames === 'object' ? bank.shortNames : {},
          questions: bank.questions,
        };
        try {
          await env.CARD_KV.put('bank:' + code, JSON.stringify(clean));
        } catch (kvErr) {
          ctx.waitUntil(captureException(env, kvErr, { rid, path }));
          return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500, headers: corsHeaders });
        }
        return new Response(JSON.stringify({ code }), {
          headers: { ...corsHeaders, 'Cache-Control': 'no-store' },
        });
      }
      if (request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id || !/^[A-Za-z0-9]{4,32}$/.test(id)) {
          return new Response(JSON.stringify({ error: 'Invalid ID' }), { status: 400, headers: corsHeaders });
        }
        let data = null;
        try { data = await env.CARD_KV.get('bank:' + id, { type: 'json' }); }
        catch (kvErr) { ctx.waitUntil(captureException(env, kvErr, { rid, path, id })); }
        if (!data) {
          return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders });
        }
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300' },
        });
      }
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: corsHeaders });
    }

    // 备考题库独立页：/exam 与 /exam/ 都映射到 /exam.html（用户习惯不带后缀直接访问）。
    // 不依赖 Cloudflare 的 html_handling 扩展名补全行为，保证两种写法都稳定可访问。
    if (path === '/exam' || path === '/exam/') {
      const assetUrl = new URL('/exam.html', url.origin);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // 静态站点路由分发
    return env.ASSETS.fetch(request);
  } catch (e) {
    // 错误脱敏：详情进日志 + Sentry，响应只给固定文案
    ctx.waitUntil(captureException(env, e, { rid, path }));
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const rid = requestId();
    const started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;

    // 静态资源量太大，逐条记日志会淹没真正的信号；只记 /api/*
    const shouldLog = path.startsWith('/api/');

    try {
      const res = await handle(request, env, ctx, rid);
      // 安全基线：所有响应注入 CSP（脚本仅同源，阻断外链/内联脚本 XSS）
      if (!res.headers.has('Content-Security-Policy')) res.headers.set('Content-Security-Policy', CSP);
      if (shouldLog) {
        log('info', 'request', {
          rid,
          method: request.method,
          path,
          status: res.status,
          ms: Date.now() - started,
        });
      }
      // request-id 回传，便于用户报障时把前端日志与服务端日志对上
      if (shouldLog) res.headers.set('X-Request-Id', rid);
      return res;
    } catch (e) {
      // handle 内部已 try/catch，走到这里说明是框架级异常，必须留下痕迹
      ctx.waitUntil(captureException(env, e, { rid, path, fatal: true }));
      log('error', 'request_failed', {
        rid,
        method: request.method,
        path,
        ms: Date.now() - started,
        message: e && e.message,
      });
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
      });
    }
  },
};
