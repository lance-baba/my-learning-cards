/**
 * CardFlow 本地预览服务（零依赖，纯 Node）
 * 模拟 Cloudflare Worker 的行为：
 *   GET  /api/index          -> data/app_index.json
 *   GET  /api/bundle?id=... -> 对应 bundle_*.json
 *   GET  /api/health        -> 健康检查（对齐 worker/index.js）
 *   POST /api/log           -> 前端错误上报（对齐 worker/index.js，落控制台）
 *   其余路径 -> public/ 静态文件
 * 用于本地即时预览，无需 Cloudflare 账号即可查看完整效果。
 *
 * 注意：本服务是**独立模拟层**，不复用 worker/index.js。两者接口行为必须保持一致，
 * 改动 worker 的路由时，这里要同步（否则本地测过、线上行为不一致）。
 * 唯一有意保留的差异：本地 CORS 为 `*`，方便任意来源调试；
 * 生产由 ALLOWED_ORIGINS 白名单控制，见 worker/index.js。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8788;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

// bundle id -> 本地文件名映射（按 bundle_id 字段在 data/ 自动匹配，避免新增 bundle 漏配）
function bundleFileFor(id) {
  if (!id) return null;
  try {
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('bundle_') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
        if (data.bundle_id === id) return f;
      } catch (_) { /* 跳过损坏文件 */ }
    }
  } catch (_) { /* data 目录读取失败 */ }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, data, cacheAge) {
  res.writeHead(200, {
    'Content-Type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cacheAge ? `public, max-age=${cacheAge}` : 'no-cache',
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    });
    return res.end();
  }

  // 前端错误上报：请求体需流式读取，故在路由分发前单独处理。
  // 状态码与 worker/index.js 严格对齐：非 POST -> 405，超 8KB -> 413。
  if (pathname === '/api/log') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json;charset=UTF-8' });
      return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    }
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return; // 已判定超限，丢弃后续分片
      raw += chunk;
      if (raw.length > 8192) {
        tooBig = true;
        res.writeHead(413, { 'Content-Type': 'application/json;charset=UTF-8' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
      }
    });
    req.on('end', () => {
      if (tooBig) return; // 413 已响应，不要再写一次
      let payload = {};
      try { payload = JSON.parse(raw) || {}; } catch (_) { payload = {}; }
      // 结构化输出，与 worker/observe.js 的日志格式对齐，便于同一套检索
      console.error(JSON.stringify({
        level: 'error',
        event: 'exception',
        ts: new Date().toISOString(),
        message: String(payload.message || '').slice(0, 1000),
        stack: String(payload.stack || '').slice(0, 4000),
        source: String(payload.source || 'frontend').slice(0, 32),
        url: String(payload.url || '').slice(0, 500),
        note: '前端上报（本地预览：未转发 Sentry）',
      }));
      res.writeHead(204, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end();
    });
    return;
  }

  try {
    if (pathname === '/api/health') {
      return sendJson(res, {
        ok: true,
        ts: new Date().toISOString(),
        version: process.env.APP_VERSION || null,
        env: 'local',
      });
    }

    if (pathname === '/api/index') {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'app_index.json'), 'utf-8'));
      return sendJson(res, data, 60);
    }

    if (pathname === '/api/bundle') {
      const id = url.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        return res.end(JSON.stringify({ error: 'Missing ID' }));
      }
      // 与 worker 一致的入参白名单，避免本地与生产行为分叉
      if (!/^[A-Za-z0-9:_-]{1,64}$/.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json;charset=UTF-8' });
        return res.end(JSON.stringify({ error: 'Invalid ID' }));
      }
      const file = bundleFileFor(id);
      if (!file) {
        return sendJson(res, {});
      }
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
      return sendJson(res, data, 3600);
    }

    // 静态文件
    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, rel);
    // 防目录穿越
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    serveStatic(res, filePath);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json;charset=UTF-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`CardFlow 本地预览已启动: http://localhost:${PORT}`);
});
