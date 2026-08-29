/* CardFlow 前端错误监控（工程评审 P0 第 4 项）
 *
 * 职责：捕获未处理异常与 Promise rejection，上报到 Worker 的 /api/log，
 *       由服务端落结构化日志；若配置 SENTRY_DSN，服务端再转发到 Sentry。
 *
 * 设计取舍：
 *  1) **不引 SDK**。项目是无构建步骤的纯静态前端，引 Sentry Browser SDK
 *     要加 ~25KB 依赖并额外处理 source map，收益不匹配。改为把错误交给
 *     服务端统一出口 —— 前端零配置，Sentry 凭据只存在 Worker 侧。
 *  2) **自我保护优先**。监控代码本身抛错会二次污染，全部包 try/catch，
 *     且监听函数永不 throw。
 *  3) **去重 + 条数上限**。渲染循环里的同一个错会每秒触发几十次，
 *     不去重会瞬间打爆日志与配额。
 *  4) **最小化上报字段**。只收 message / stack / url，不收用户信息、
 *     不收 localStorage 内容 —— 保留本项目「零数据收集」的合规优势。
 *  5) **sendBeacon 优先**。页面卸载时（用户切走/关闭）fetch 会被取消，
 *     sendBeacon 由浏览器保证发出。
 */
(function () {
  'use strict';

  var MAX_PER_SESSION = 10;   // 单次会话最多上报条数
  var MAX_SAME = 3;           // 同一条错误最多上报次数
  var counts = {};            // message -> 次数
  var total = 0;

  function now() {
    return new Date().toISOString();
  }

  function send(payload) {
    try {
      var body = JSON.stringify(payload);
      var url = './api/log';
      // sendBeacon 在页面卸载时仍能发出；不支持时退回 fetch keepalive
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
      if (window.fetch) {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {}); // 上报失败静默，绝不能打扰用户
      }
    } catch (e) {
      /* 监控自身异常：吞掉 */
    }
  }

  /** 统一的入口：去重 + 限流后上报 */
  function report(source, err) {
    try {
      if (total >= MAX_PER_SESSION) return;
      var message = '';
      var stack = '';
      if (typeof err === 'string') {
        message = err;
      } else if (err && err.message) {
        message = err.message;
        stack = err.stack || '';
      } else if (err && err.reason) {
        // PromiseRejectionEvent 带上来的原始值
        var r = err.reason;
        message = (r && r.message) || String(r);
        stack = (r && r.stack) || '';
      } else {
        message = String(err);
      }
      if (!message) return;

      var key = source + '|' + message;
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > MAX_SAME) return;
      total += 1;

      send({
        source: source,
        message: String(message).slice(0, 1000),
        stack: String(stack).slice(0, 4000),
        url: String(location.href).slice(0, 500),
        ts: now(),
      });
    } catch (e) {
      /* 吞掉 */
    }
  }

  window.addEventListener(
    'error',
    function (e) {
      // 资源加载失败（img/script 404）没有 message，单独归类，便于区分
      if (e.target && e.target !== window && (e.target.src || e.target.href)) {
        report('resource', '资源加载失败: ' + (e.target.src || e.target.href));
        return;
      }
      report('onerror', e.error || e.message);
    },
    true // 捕获阶段：才能拿到资源加载错误（不冒泡）
  );

  window.addEventListener('unhandledrejection', function (e) {
    report('unhandledrejection', e);
  });

  // 暴露给业务代码主动上报（如 fetch 失败、数据解析异常）
  window.__cfReport = function (err) {
    report('manual', err);
  };
})();
