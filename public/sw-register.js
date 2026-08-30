// Service Worker 注册（从 index.html 内联脚本抽出，便于 CSP 收紧为 script-src 'self'）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
