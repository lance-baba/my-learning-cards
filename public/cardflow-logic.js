/* CardFlow 纯逻辑层（UMD）
 * 浏览器：作为经典 <script> 加载，挂载 window.CardFlowLogic，供 app.js 使用。
 * Node/Vitest：module.exports 导出，供单元测试直接 import。
 * 目的：把可单测的纯函数从 app.js（Vue 全局脚本）中抽离，
 *       既不影响线上无构建部署，又能用 Vitest 覆盖核心算法。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') window.CardFlowLogic = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 语义化版本比较：a 是否严格大于 b（按 . 分段数值比较）
  function isVersionGt(a, b) {
    if (!a || !b) return false;
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }

  /* ---- 学习机制：曝光加权间隔排程（Leitner-lite） ----
   * 每张卡记录 已看次数(seen) + 上次时间(last)。排序权重：
   *   weight = 1/(1 + seen*0.7) * 间隔衰减(0.15~1，7天回满)
   * 再叠加 ±随机抖动，避免每次都从第一条开始、也避免刷过的内容频繁出现。 */
  const EXPOSURE_KEY = 'cf_exposure';
  function loadExposure() {
    try {
      return JSON.parse((typeof localStorage !== 'undefined' ? localStorage.getItem(EXPOSURE_KEY) : null) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveExposure(map) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(EXPOSURE_KEY, JSON.stringify(map));
    } catch (e) {}
  }
  function recordExposure(topicId) {
    if (!topicId) return;
    const map = loadExposure();
    const e = map[topicId] || { seen: 0, last: 0 };
    e.seen += 1;
    e.last = Date.now();
    map[topicId] = e;
    saveExposure(map);
  }

  // 曝光加权混排：未看/久未看排前，刚看/多看沉后，+抖动保变化
  // exposure / rng 为可选注入项，便于单测固定输出；缺省走 localStorage + Math.random
  function weightedOrder(topics, exposure, rng) {
    const map = exposure && typeof exposure === 'object' ? exposure : loadExposure();
    const rand = typeof rng === 'function' ? rng : Math.random;
    const now = Date.now();
    const scored = topics.map((t) => {
      const e = map[t.id] || { seen: 0, last: 0 };
      const days = e.last ? (now - e.last) / 86400000 : 999;
      const recency = Math.max(0.15, Math.min(1, days / 7));
      const freq = 1 / (1 + e.seen * 0.7);
      const jitter = 0.7 + rand() * 0.6; // 0.7~1.3
      return { t, score: freq * recency * jitter };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.t);
  }

  // 混排：按 relax_ratio 在学习卡间穿插放松卡（不再做永久去重）
  function mixTopics(topics, ratio) {
    const study = topics.filter((t) => t.type !== 'joke');
    const fun = topics.filter((t) => t.type === 'joke');
    if (fun.length === 0) return study;

    const r = Math.max(1, parseInt(ratio, 10) || 5);
    const out = [];
    let fi = 0;
    for (let i = 0; i < study.length; i++) {
      out.push(study[i]);
      if ((i + 1) % r === 0 && fi < fun.length) out.push(fun[fi++]);
    }
    while (fi < fun.length) out.push(fun[fi++]); // 放松卡多于间隔时兜底追加
    return out;
  }

  // 数据驱动的 layout 字段 -> 组件名（未知 layout 兜底 qa-card）
  function resolveLayout(layout) {
    const map = {
      qa_card: 'qa-card',
      streaming_text: 'stream-card',
      flip_card: 'flip-card',
      joke_text: 'joke-card',
      meme_card: 'meme-card',
      game_card: 'game-card',
      list_card: 'list-card',
      quote_card: 'quote-card',
      compare_card: 'compare-card',
      knowledge_card: 'knowledge-card',
    };
    return map[layout] || 'qa-card';
  }

  return {
    isVersionGt,
    EXPOSURE_KEY,
    loadExposure,
    saveExposure,
    recordExposure,
    weightedOrder,
    mixTopics,
    resolveLayout,
  };
});
