/**
 * CardFlow Worker 可观测性模块（工程评审 P0 第 4 项）
 *
 * 设计原则：
 *  1) **零依赖**。不引入 @sentry/* SDK —— Workers 有 bundle 体积限制，
 *     而我们需要的能力只有「发一条错误事件」，自己写 60 行比引一个 SDK 更合适。
 *  2) **未配置即降级**。SENTRY_DSN 没配时，captureException 只写结构化日志，
 *     不发任何外部请求。这样接入 Sentry 变成纯运维动作（wrangler secret put），
 *     不影响代码正确性，也不存在「SDK 抛错把业务拖垮」的风险。
 *  3) **日志结构化**。统一输出单行 JSON，便于 Cloudflare Workers Logs /
 *     Logpush / wrangler tail 检索。禁止再出现裸 console.log('xxx')。
 *
 * 启用 Sentry：
 *   wrangler secret put SENTRY_DSN     # https://<key>@<host>/<project_id>
 *   wrangler secret put APP_VERSION    # 可选，用于标记 release
 */

/** 生成短请求 ID，用于把同一次请求的日志串起来 */
export function requestId() {
  // crypto.randomUUID 在 Workers 可用；取前 8 位足够定位，又不至于太长
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  } catch {
    return Math.random().toString(36).slice(2, 18);
  }
}

/**
 * 结构化日志
 * @param {'info'|'warn'|'error'} level
 * @param {string} event 事件名，检索用，建议小写下划线
 * @param {object} fields 附加字段（不要放敏感信息）
 */
export function log(level, event, fields = {}) {
  const rec = { level, event, ts: new Date().toISOString(), ...fields };
  const line = JSON.stringify(rec);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return rec;
}

/**
 * 解析 Sentry DSN
 * @returns {{endpoint:string, publicKey:string, projectId:string}|null}
 */
export function parseSentryDsn(dsn) {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\//, '');
    if (!publicKey || !projectId) return null;
    const endpoint =
      `${u.protocol}//${u.host}/api/${projectId}/envelope/` +
      `?sentry_key=${publicKey}&sentry_version=7`;
    return { endpoint, publicKey, projectId };
  } catch {
    return null;
  }
}

/**
 * 上报异常到 Sentry（未配置 DSN 时仅记录日志）
 * 返回 Promise，调用方应用 ctx.waitUntil 挂起，避免阻塞响应。
 */
export async function captureException(env, err, extra = {}) {
  const message = (err && err.message) || String(err);
  const stack = err && err.stack ? String(err.stack).slice(0, 4000) : undefined;

  // 无论 Sentry 是否配置，都先落一条结构化日志（这是兜底，不能省）
  log('error', 'exception', { message, stack, ...extra });

  const parsed = parseSentryDsn(env.SENTRY_DSN);
  if (!parsed) return { sent: false, reason: 'SENTRY_DSN 未配置' };

  const eventId = requestId() + requestId(); // 32 位十六进制
  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    level: 'error',
    logger: 'cardflow.worker',
    environment: env.APP_ENV || 'production',
    release: env.APP_VERSION || undefined,
    server_name: 'cloudflare-worker',
    exception: {
      values: [
        {
          type: (err && err.name) || 'Error',
          value: message.slice(0, 2000),
          // 不做堆栈帧解析：Workers 的堆栈格式与 V8 不完全一致，
          // 硬解析容易产生错位的 frame。原始 stack 放 extra，Sentry 里一样能看到。
        },
      ],
    },
    extra: { raw_stack: stack, ...extra },
    tags: { runtime: 'cloudflare-workers' },
  };

  // Sentry Envelope 格式：第一行 envelope header，第二行 item header，第三行 payload
  const body =
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }) + '\n' +
    JSON.stringify({ type: 'event' }) + '\n' +
    JSON.stringify(event);

  try {
    const res = await fetch(parsed.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body,
    });
    if (!res.ok) {
      log('warn', 'sentry_reject', { status: res.status, event_id: eventId });
      return { sent: false, reason: 'HTTP ' + res.status };
    }
    return { sent: true, event_id: eventId };
  } catch (e) {
    // 上报失败绝不能影响业务响应
    log('warn', 'sentry_unreachable', { message: e && e.message });
    return { sent: false, reason: e && e.message };
  }
}
