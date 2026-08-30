/* =============================================================
 * CardFlow 前端 —— 四层架构（数据 / 外壳 / Layout 分发 / 支撑）
 * 全局 Vue3（无构建步骤），组件以 app.component 注册。
 * 约定：关键样式一律走 style.css 纯 CSS 类，不依赖 Tailwind 任意值。
 * ============================================================= */
const { createApp, ref, reactive, computed, onMounted, inject } = Vue;

/* -------------------------------------------------------------
 * 1) 共享状态 store（reactive 单例）
 *    仅承载"跨组件交互状态"，卡片流数据也放这里以便模板统一引用。
 * ----------------------------------------------------------- */
const store = reactive({
  mixedTopics: [],
  allTopics: [],          // 原始全量（未洗牌），供发现/搜索稳定浏览
  categories: [],         // 分类列表（来自 app:index），供发现页筛选
  enabledCats: null,      // 用户勾选要下载/刷题的分类（null=全开；数组=仅这些）。持久化 localStorage cf_cats
  hasUpdate: false,
  activeIndex: 0,
  streamingDisplay: {},   // key -> 已流式吐出的文字
  isFlipped: {},          // key -> 翻牌状态
  revealed: {},           // key -> 笑话笑点是否揭晓
  bookmarked: {},         // sub_id -> 收藏对象（持久化 localStorage）
  view: 'stream',         // 'stream' 卡片流 | 'favorites' 收藏夹
  catSheet: false,        // 分类选择 sheet 是否打开（刷自选分类）
  mastered: {},           // topicId -> 是否已标记"记住了"（持久化 cf_mastered）
  speaking: {},           // sub_id -> 是否正在朗读
  activeSource: null,     // 引用抽屉：当前来源对象
  activeAnchor: null,     // 引用抽屉：当前章节锚点
  loading: false,         // 首屏数据加载中（驱动加载态 UI）
  loadError: '',          // 加载失败信息；空=正常，非空=显示错误态+重试
});

/* -------------------------------------------------------------
 * 2) 共享服务 services（纯函数/副作用，注入给各组件）
 * ----------------------------------------------------------- */
const services = {
  openSource(source, anchor) {
    store.activeSource = source || null;
    store.activeAnchor = anchor || null;
  },
  toggleBookmark(topic) {
    // 整条收藏：以 topic.id 为键，收藏整条知识卡（含所有子卡）
    const key = topic.id;
    if (store.bookmarked[key]) {
      delete store.bookmarked[key];
    } else {
      store.bookmarked[key] = {
        topicId: topic.id,
        catId: topic.catId || '',
        catName: topic.catName || '未分类',
        title: topic.title || '',
        subCount: (topic.sub_cards || []).length,
        type: topic.type || ''
      };
    }
    try {
      localStorage.setItem('bookmarked_cards', JSON.stringify(store.bookmarked));
    } catch (e) { /* 忽略隐私模式写入失败 */ }
  },
  // 标记/取消"记住了"：加重或撤销该卡的曝光惩罚，长时间不再出现
  toggleMaster(topicId) {
    if (!topicId) return;
    const map = loadExposure();
    const e = map[topicId] || { seen: 0, last: 0 };
    if (store.mastered[topicId]) {
      delete store.mastered[topicId];
      e.seen = Math.max(0, e.seen - 6);
    } else {
      store.mastered[topicId] = true;
      e.seen += 6;
      e.last = Date.now();
    }
    map[topicId] = e;
    saveExposure(map);
    try { localStorage.setItem('cf_mastered', JSON.stringify(store.mastered)); } catch (e) {}
  },
  // 从收藏夹跳回卡片流并定位到该 topic
  openInStream(topicId) {
    store.view = 'stream';
    if (verticalSwiper) verticalSwiper.enable();
    setTimeout(() => {
      if (verticalSwiper) {
        verticalSwiper.update();
        const idx = store.mixedTopics.findIndex(t => t.id === topicId);
        if (idx >= 0) verticalSwiper.slideTo(idx, 0);
      }
    }, 80);
  },
  toggleSpeak(key, text) {
    if (!('speechSynthesis' in window)) return;
    if (store.speaking[key]) {
      window.speechSynthesis.cancel();
      store.speaking[key] = false;
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text || '');
    u.lang = 'zh-CN';
    u.onend = () => { store.speaking[key] = false; };
    u.onerror = () => { store.speaking[key] = false; };
    window.speechSynthesis.speak(u);
    store.speaking[key] = true;
  },
  speakText(topic, sub) {
    if (!sub) return '';
    if (sub.layout === 'flip_card') return (sub.front_text || sub.title || '') + '。' + (sub.back_text || '');
    if (sub.layout === 'streaming_text') return (sub.title || '') + '。' + (sub.streaming_content || '');
    if (sub.layout === 'joke_text') return (sub.title || '') + '。' + (sub.content || '') + ' ' + (sub.punchline || '');
    return (sub.title || '') + '。' + (sub.content || '');
  }
};

/* -------------------------------------------------------------
 * 3) 工具函数
 * ----------------------------------------------------------- */
const splitLines = (text) =>
  (text ? String(text).split('\n').map(s => s.trim()).filter(Boolean) : []);

const subKey = (topic, sub) => `${topic.id}_${sub.sub_id}`;

// 语义化版本比较：a 是否严格大于 b（按 . 分段数值比较）
function isVersionGt(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// 客户端静态版本（仅用于 min_app_version 强制更新判断）
const CLIENT_APP_VERSION = '1.0.0';

/* -------------------------------------------------------------
 * 4) 数据层：拉取 + 去重 + 混排（relax_ratio 接入点）
 * ----------------------------------------------------------- */

/* ---- 学习机制：曝光加权间隔排程（Leitner-lite） ----
 * 每张卡记录 已看次数(seen) + 上次时间(last)。排序权重：
 *   weight = 1/(1 + seen*0.7) * 间隔衰减(0.15~1，7天回满)
 * 再叠加 ±随机抖动，避免每次都从第一条开始、也避免刷过的内容频繁出现。 */
const EXPOSURE_KEY = 'cf_exposure';
function loadExposure() {
  try { return JSON.parse(localStorage.getItem(EXPOSURE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function saveExposure(map) {
  try { localStorage.setItem(EXPOSURE_KEY, JSON.stringify(map)); } catch (e) {}
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
function weightedOrder(topics) {
  const map = loadExposure();
  const now = Date.now();
  const scored = topics.map(t => {
    const e = map[t.id] || { seen: 0, last: 0 };
    const days = e.last ? (now - e.last) / 86400000 : 999;
    const recency = Math.max(0.15, Math.min(1, days / 7));
    const freq = 1 / (1 + e.seen * 0.7);
    const jitter = 0.7 + Math.random() * 0.6; // 0.7~1.3
    return { t, score: freq * recency * jitter };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.map(s => s.t);
}

// 混排：按 relax_ratio 在学习卡间穿插放松卡（不再做永久去重）
function mixTopics(topics, ratio) {
  const study = topics.filter(t => t.type !== 'joke');
  const fun = topics.filter(t => t.type === 'joke');
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

// 带超时 + 指数退避重试的 fetch 封装（解决「网络抖动即白屏、无重试」问题）
// - 单次请求 8s 超时（AbortController 中断）
// - 瞬时失败（网络错误 / 超时 / 5xx）最多重试 2 次，退避 700ms → 1400ms
// - 4xx（客户端错误，重试无意义）直接抛出不重试
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithRetry(url, opts = {}, { timeout = 8000, retries = 2, baseDelay = 700 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(tid);
      if (res.ok) return res;
      if (res.status >= 500 && attempt < retries) {
        lastErr = new Error('HTTP ' + res.status);
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      clearTimeout(tid);
      if (attempt < retries) { lastErr = e; await sleep(baseDelay * 2 ** attempt); continue; }
      throw e;
    }
  }
  throw lastErr;
}

async function fetchAllTopics() {
  const indexRes = await fetchWithRetry('/api/index');
  const indexData = await indexRes.json();

  // 版本号写入 bundle 请求 URL（?v=），与 Worker 边缘缓存配合：版本不变命中缓存、零 KV 读；
  // 同步后版本号变化 => URL 变化 => 缓存自动失效拉新数据。
  const version = (indexData && indexData.version) || '0';
  const enabled = store.enabledCats; // null=全开；数组=仅这些分类

  let all = [];
  if (indexData && Array.isArray(indexData.categories)) {
    for (const cat of indexData.categories) {
      if (enabled && enabled.length && !enabled.includes(cat.id)) continue; // ② 按需下载：未勾选分类直接跳过
      for (const bundleId of (cat.bundles || [])) {
        const bundleRes = await fetchWithRetry(`/api/bundle?id=${encodeURIComponent(bundleId)}&v=${encodeURIComponent(version)}`);
        const bundleData = await bundleRes.json();
        if (bundleData && Array.isArray(bundleData.items)) {
          bundleData.items.forEach(it => { it.catId = cat.id; it.catName = cat.name; });
          all = all.concat(bundleData.items);
        }
      }
    }
  }
  return { topics: all, indexData };
}

/* -------------------------------------------------------------
 * 5) 交互层：Swiper 引擎 + 纯前端打字机
 * ----------------------------------------------------------- */
let verticalSwiper = null;

// 视图切换：收藏夹 <-> 卡片流
// 进入收藏夹/分类时禁用竖向 Swiper 的触摸拦截，否则手机上竖向拖动会被底层 Swiper 吃掉、收藏夹滑不动
function setView(v) {
  store.view = v;
  if (!verticalSwiper) return;
  if (v === 'favorites' || v === 'catSheet') verticalSwiper.disable();
  else { verticalSwiper.enable(); setTimeout(() => verticalSwiper.update(), 60); }
}

function initSwipers() {
  verticalSwiper = new Swiper('.vertical-swiper', {
    direction: 'vertical',
    spaceBetween: 0,
    on: {
      slideChange(s) {
        store.activeIndex = s.activeIndex;
        triggerStreaming(s.activeIndex);
        const tp = store.mixedTopics[s.activeIndex];
        if (tp) recordExposure(tp.id);
      }
    }
  });

  new Swiper('.horizontal-swiper', {
    direction: 'horizontal',
    nested: true,
    pagination: { el: '.swiper-pagination', clickable: true }
  });

  store.activeIndex = 0;
  triggerStreaming(0);
  const t0 = store.mixedTopics[0];
  if (t0) recordExposure(t0.id);
}

function triggerStreaming(vIdx) {
  const topic = store.mixedTopics[vIdx];
  if (!topic) return;
  topic.sub_cards.forEach(sub => {
    if (sub.layout === 'streaming_text' && sub.streaming_content) {
      const key = subKey(topic, sub);
      if (store.streamingDisplay[key]) return; // 已播放过不重复触发
      const text = sub.streaming_content;
      let idx = 0;
      store.streamingDisplay[key] = '';
      const timer = setInterval(() => {
        if (idx < text.length) {
          store.streamingDisplay[key] += text.charAt(idx++);
        } else {
          clearInterval(timer);
        }
      }, 30);
    }
  });
}

/* -------------------------------------------------------------
 * 6) 组件：CardShell（统一外壳：80vh / 头图 / 徽章+时长 / 内容插槽 / 底部 footer）
 * ----------------------------------------------------------- */
const CardShell = {
  props: { topic: Object, sub: Object, hideBookmark: { type: Boolean, default: false } },
  inject: ['store', 'services'],
  computed: {
    shellClass() {
      const base = 'card-shell glass-card w-full max-w-md shadow-2xl relative flex flex-col';
      // 梗图保持满屏无内边距；翻牌卡恢复 p-6，让底部 footer 与其他卡缩进一致
      const pad = this.sub.layout === 'meme_card' ? '' : 'p-6';
      const fun = this.topic.type === 'joke' ? ' glass-card-fun' : '';
      return (base + ' ' + pad + fun).trim();
    },
    // 翻牌/梗图独占满屏：退出头部/头图 chrome，内容区不滚动
    fillMode() { return this.sub.layout === 'flip_card' || this.sub.layout === 'meme_card'; },
    showHero() { return !this.fillMode && !!this.cardHeroSrc; },
    cardHeroSrc() { return this.sub.image || this.topic.image || ''; },
    heroClass() { return this.topic.type === 'joke' ? 'hero-fun' : 'hero-knowledge'; },
    heroIcon() {
      return { streaming_text: '📖', joke_text: '😄', flip_card: '❓' }[this.sub.layout] || '🌱';
    },
    badgeText() { return (this.topic.tags && this.topic.tags[0]) || '知识'; },
    difficulty() { return this.topic.difficulty || 2; },
    difficultyLabel() { return ['', '★☆☆ 入门', '★★☆ 进阶', '★★★ 深入'][this.difficulty] || '★★☆ 进阶'; },
    readTime() { return this.topic.type === 'joke' ? '😄 放松' : '⏱️ 约20秒'; },
    hasSource() { return !!this.topic.source; },
    isBookmarked() { return !!this.store.bookmarked[this.topic.id]; },
    isMastered() { return !!this.store.mastered[this.topic.id]; },
    isSpeaking() { return !!this.store.speaking[this.sub.sub_id]; },
    speakTextVal() { return this.services.speakText(this.topic, this.sub); },
    // 动态字号：当前子卡文字量少则放大，多则保持默认
    contentText() {
      const s = this.sub || {};
      return [
        s.content, s.streaming_content, s.back_text, s.caption,
        (s.items || []).join(''), s.quote, s.wrong, s.right, s.punchline
      ].filter(Boolean).join('');
    },
    shortContent() { return this.contentText.length <= 160; },
    contentStyle() {
      return { '--card-fs': this.shortContent ? '1.2rem' : '1.05rem' };
    }
  },
  methods: {
    onSource() {
      if (this.hasSource) this.services.openSource(this.topic.source, this.sub.citation_anchor || null);
    },
    onBookmark() { this.services.toggleBookmark(this.topic); },
    onMaster() { this.services.toggleMaster(this.topic.id); },
    onSpeak() { this.services.toggleSpeak(this.sub.sub_id, this.speakTextVal); }
  },
  template: `
    <div :class="shellClass">
      <div v-if="showHero" class="card-hero" :class="heroClass">
        <img v-if="cardHeroSrc" :src="cardHeroSrc" class="card-hero-img" alt="">
        <template v-else>{{ heroIcon }}</template>
      </div>

      <div class="flex justify-between items-center mb-4">
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-1 rounded-full font-semibold badge-knowledge">{{ badgeText }}</span>
          <span class="text-xs px-2 py-1 rounded-full badge-difficulty">{{ difficultyLabel }}</span>
        </div>
        <span class="text-xs text-slate-400">{{ readTime }}</span>
      </div>

      <div :class="fillMode ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 min-h-0 overflow-y-auto'" :style="contentStyle">
        <slot></slot>
      </div>

      <!-- footer 始终贴底：mt-auto 在 flex-col 容器中把 footer 推到底部 -->
      <div class="pt-3 mt-auto divider flex justify-between items-center">
        <div v-if="hasSource" @click="onSource"
             class="card-footer-text text-slate-400 hover:text-emerald-400 cursor-pointer flex items-center gap-1">
          🏛️ {{ topic.source.name }}
        </div>
        <div v-else class="card-footer-text text-slate-500">CardFlow</div>
        <div class="flex items-center gap-4">
          <button @click="onMaster"
                  :class="isMastered ? 'text-emerald-400 font-semibold' : 'text-slate-400'"
                  class="action-btn" :title="isMastered ? '已记住（点取消）' : '记住了'">{{ isMastered ? '✓ 记住了' : '✓ 记住' }}</button>
          <button v-if="!hideBookmark" @click="onBookmark"
                  :class="isBookmarked ? 'text-emerald-400 font-semibold' : 'text-slate-400'"
                  class="action-btn" :title="isBookmarked ? '已收藏（点取消）' : '收藏'">{{ isBookmarked ? '🔖 已收藏' : '📑 收藏' }}</button>
          <button @click="onSpeak"
                  :class="isSpeaking ? 'text-emerald-400' : 'text-slate-400'"
                  class="action-btn" title="朗读">🔊</button>
        </div>
      </div>
    </div>
  `
};

/* -------------------------------------------------------------
 * 7) 组件：四种 Layout（只渲染"内容区"，外壳由 CardShell 提供）
 * ----------------------------------------------------------- */
const QaCard = {
  props: { topic: Object, sub: Object },
  template: `
    <div>
      <h2 class="card-title text-slate-100 mb-4 leading-snug">{{ sub.title }}</h2>
      <p class="card-body">{{ sub.content }}</p>
      <div class="text-right text-sm text-emerald-400 font-medium animate-bounce mt-4">
        {{ sub.action_hint || '左右滑动查看详情 ➔' }}
      </div>
    </div>
  `
};

const StreamCard = {
  props: { topic: Object, sub: Object, full: Boolean },
  inject: ['store'],
  computed: {
    key() { return `${this.topic.id}_${this.sub.sub_id}`; },
    display() { return this.full ? (this.sub.streaming_content || '') : (this.store.streamingDisplay[this.key] || ''); }
  },
  template: `
    <div>
      <h3 class="card-subtitle text-emerald-400 mb-3">{{ sub.title }}</h3>
      <div class="card-body whitespace-pre-line stream-min">
        {{ display }}<span v-if="!full" class="inline-block w-2 h-5 bg-emerald-400 animate-pulse ml-0.5 align-middle"></span>
      </div>
    </div>
  `
};

const FlipCard = {
  props: { topic: Object, sub: Object },
  inject: ['store'],
  computed: {
    key() { return `${this.topic.id}_${this.sub.sub_id}`; },
    flipped: {
      get() { return !!this.store.isFlipped[this.key]; },
      set(v) { this.store.isFlipped[this.key] = v; }
    }
  },
  methods: { toggle() { this.flipped = !this.flipped; } },
  template: `
    <div class="w-full h-full perspective-1000 cursor-pointer" @click="toggle">
      <div class="w-full h-full relative transform-style-3d" :class="{ 'rotate-y-180': flipped }">
        <!-- 正面：透明面，圆角/玻璃质感由外层 card-shell 提供，避免内层再画一圈圆角产生接缝 -->
        <div class="absolute inset-0 p-8 flex flex-col justify-between backface-hidden">
          <span class="text-sm text-blue-400 font-semibold">❓ 思考翻牌</span>
          <h3 class="card-title text-slate-100">{{ sub.front_text || sub.title }}</h3>
          <p class="text-center text-sm text-slate-400">点击卡片翻转揭晓答案 ↺</p>
        </div>
        <!-- 背面：同样透明，翻转时显示解析 -->
        <div class="absolute inset-0 p-8 flex flex-col justify-between backface-hidden rotate-y-180">
          <span class="text-sm text-emerald-400 font-semibold">💡 核心解析</span>
          <p class="card-body">{{ sub.back_text }}</p>
          <p class="text-center text-xs text-slate-400">点击卡片翻回 ↺</p>
        </div>
      </div>
    </div>
  `
};

const JokeCard = {
  props: { topic: Object, sub: Object },
  inject: ['store'],
  computed: {
    key() { return `${this.topic.id}_${this.sub.sub_id}`; },
    lines() { return splitLines(this.sub.content); },
    punch() { return splitLines(this.sub.punchline); },
    revealed() { return !!this.store.revealed[this.key]; }
  },
  methods: { reveal() { this.store.revealed[this.key] = true; } },
  template: `
    <div>
      <div class="flex items-center justify-between mb-3">
        <span class="badge-fun">😄 轻松一下</span>
        <span class="text-xs text-slate-400">⏱️ 一笑解压</span>
      </div>
      <h3 class="card-subtitle text-amber-200 mb-2">{{ sub.title }}</h3>
      <div class="chat">
        <div v-for="(line, i) in lines" :key="'c'+i"
             class="bubble" :class="i % 2 === 0 ? 'bubble-left' : 'bubble-right'">{{ line }}</div>
      </div>
      <div v-if="!revealed" class="reveal-btn" @click="reveal">点击揭晓笑点 🎉</div>
      <div v-else class="chat">
        <div v-for="(line, i) in punch" :key="'p'+i"
             class="bubble" :class="i % 2 === 0 ? 'bubble-left' : 'bubble-right'">{{ line }}</div>
      </div>
    </div>
  `
};

/* -------------------------------------------------------------
 * 7a) 组件：富文本三类（list_card / quote_card / compare_card）
 *      文字升级方向：要点清单、权威摘录、易错对照，全部纯文本无图。
 * ----------------------------------------------------------- */
const ListCard = {
  props: { topic: Object, sub: Object },
  computed: { items() { return Array.isArray(this.sub.items) ? this.sub.items : []; } },
  template: `
    <div>
      <h3 class="card-subtitle text-emerald-400 mb-3">{{ sub.title || '核心要点' }}</h3>
      <ul class="list-card">
        <li v-for="(it, i) in items" :key="i" class="list-item">
          <span class="list-dot">✓</span><span>{{ it }}</span>
        </li>
      </ul>
    </div>
  `
};

const QuoteCard = {
  props: { topic: Object, sub: Object },
  inject: ['services'],
  computed: { src() { return this.topic.source || null; } },
  template: `
    <div>
      <h3 class="card-subtitle text-blue-300 mb-3">{{ sub.title || '权威摘录' }}</h3>
      <blockquote class="quote-card">
        <p class="quote-text">{{ sub.quote }}</p>
        <footer class="quote-src">
          <span v-if="src" @click="services.openSource(src, sub.citation || null)"
                class="cursor-pointer hover:text-emerald-400">🏛️ {{ src.name }}<template v-if="sub.citation"> · {{ sub.citation }}</template></span>
          <span v-else>CardFlow</span>
        </footer>
      </blockquote>
    </div>
  `
};

const CompareCard = {
  props: { topic: Object, sub: Object },
  template: `
    <div>
      <h3 class="card-subtitle text-amber-200 mb-3">{{ sub.title || '常见误区' }}</h3>
      <div class="compare-card">
        <div class="compare-wrong">
          <span class="compare-tag wrong">误区</span>
          <p>{{ sub.wrong }}</p>
        </div>
        <div class="compare-right">
          <span class="compare-tag right">正解</span>
          <p>{{ sub.right }}</p>
        </div>
      </div>
    </div>
  `
};

/* -------------------------------------------------------------
 * 7b) 组件：梗图（meme_card）—— 大图 + 文案，独占满屏
 * ----------------------------------------------------------- */
const MemeCard = {
  props: { topic: Object, sub: Object },
  template: `
    <div class="w-full h-full flex flex-col items-center justify-center gap-3">
      <img v-if="sub.image" :src="sub.image" class="content-img" alt="">
      <div v-else class="text-6xl">😄</div>
      <p v-if="sub.caption" class="meme-caption">{{ sub.caption }}</p>
    </div>
  `
};

/* -------------------------------------------------------------
 * 7c) 组件：极简 H5 小游戏（game_card）—— 石头剪刀布 vs 电脑
 *     纯事件驱动，无定时循环，无生命周期负担。
 * ----------------------------------------------------------- */
const GameCard = {
  props: { topic: Object, sub: Object },
  setup() {
    const choices = [
      { key: 'rock', icon: '✊', name: '石头' },
      { key: 'scissors', icon: '✌️', name: '剪刀' },
      { key: 'paper', icon: '✋', name: '布' }
    ];
    const you = ref(null);
    const cpu = ref(null);
    const result = ref('');
    const scoreYou = ref(0);
    const scoreCpu = ref(0);
    const play = (key) => {
      you.value = key;
      const cpuKey = choices[Math.floor(Math.random() * 3)].key;
      cpu.value = cpuKey;
      if (key === cpuKey) { result.value = '平局 🤝'; return; }
      const win = (key === 'rock' && cpuKey === 'scissors') ||
                  (key === 'scissors' && cpuKey === 'paper') ||
                  (key === 'paper' && cpuKey === 'rock');
      if (win) { result.value = '你赢了 🎉'; scoreYou.value++; }
      else { result.value = '电脑赢了 🤖'; scoreCpu.value++; }
    };
    const iconOf = (k) => (k ? choices.find(c => c.key === k).icon : '❔');
    return { choices, you, cpu, result, scoreYou, scoreCpu, play, iconOf };
  },
  template: `
    <div class="w-full flex flex-col items-center justify-center text-center">
      <h3 class="card-subtitle text-amber-200 mb-3">{{ sub.title || '来一局石头剪刀布' }}</h3>
      <div class="flex items-center justify-center gap-6 my-3">
        <div>
          <div class="text-5xl">{{ iconOf(you) }}</div>
          <div class="text-xs text-slate-400 mt-1">你 {{ scoreYou }}</div>
        </div>
        <div class="text-2xl text-slate-500">VS</div>
        <div>
          <div class="text-5xl">{{ iconOf(cpu) }}</div>
          <div class="text-xs text-slate-400 mt-1">电脑 {{ scoreCpu }}</div>
        </div>
      </div>
      <p class="card-body mb-4">{{ result || '选一个出拳吧' }}</p>
      <div class="flex items-center justify-center gap-3">
        <button v-for="c in choices" :key="c.key" @click="play(c.key)" class="game-btn">{{ c.icon }}</button>
      </div>
    </div>
  `
};

/* -------------------------------------------------------------
 * 布局分发：layout 字段 -> 组件名（新增题型只需注册组件，框架零改动）
 * 模块级，供 AppShell 与 FavoritesView 共用。
 * ----------------------------------------------------------- */
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
    compare_card: 'compare-card'
  };
  return map[layout] || 'qa-card';
}

/* -------------------------------------------------------------
 * 8) 根组件 AppShell（持有数据拉取与 Swiper 生命周期）
 * ----------------------------------------------------------- */
const app = createApp({
  setup() {
    const glowClass = computed(() => {
      const t = store.mixedTopics[store.activeIndex];
      return t && t.type === 'joke' ? 'glow-fun' : 'glow-knowledge';
    });

    // 数据驱动：layout 字段 -> 组件名
    const layoutComp = resolveLayout;

    const initData = async () => {
      store.loading = true;
      store.loadError = '';
      try {
        const { topics, indexData } = await fetchAllTopics();
        const ratio = (indexData && indexData.global_config && indexData.global_config.relax_ratio) || 5;
        store.mixedTopics = mixTopics(weightedOrder(topics), ratio);
        store.allTopics = topics;     // 保留全量原始顺序，供发现/搜索
        store.categories = (indexData && indexData.categories) || [];
        if (store.mixedTopics.length === 0 && topics.length > 0) {
          store.mixedTopics = topics; // 兜底：数据异常时仍展示
        }

        // 版本感知：服务端 index.version 变化 => 提示"发现新库"
        const serverVersion = (indexData && indexData.version) || '';
        const prevVersion = localStorage.getItem('cardflow_last_version') || '';
        if (prevVersion && prevVersion !== serverVersion) store.hasUpdate = true;
        // 最低客户端版本强制更新
        if (isVersionGt(indexData && indexData.min_app_version, CLIENT_APP_VERSION)) store.hasUpdate = true;
        if (serverVersion) localStorage.setItem('cardflow_last_version', serverVersion);

        setTimeout(initSwipers, 100);
      } catch (e) {
        console.error('加载卡片失败', e);
        store.loadError = (e && e.name === 'AbortError')
          ? '加载超时，请检查网络后重试'
          : '卡片加载失败，请检查网络';
        // 同步上报到监控（与 monitor.js 去重/限流一致）
        if (window.__cfReport) window.__cfReport('load', (e && e.message) ? e.message : 'load-failed');
      } finally {
        store.loading = false;
      }
    };

    const syncData = () => {
      localStorage.removeItem('read_topics');
      location.reload();
    };

    const favCount = computed(() => Object.keys(store.bookmarked).length); // 现在每条是一个 topic

    onMounted(() => {
      // 注意：必须原地合并，不能整体重新赋值 store.bookmarked / store.mastered，
      // 否则已挂载组件对其计算属性的订阅会指向被丢弃的旧代理，导致图标/状态不刷新。
      try {
        const saved = JSON.parse(localStorage.getItem('bookmarked_cards') || '{}') || {};
        for (const k of Object.keys(saved)) store.bookmarked[k] = saved[k];
      } catch (e) { /* 忽略 */ }
      try {
        const m = JSON.parse(localStorage.getItem('cf_mastered') || '{}') || {};
        for (const k of Object.keys(m)) store.mastered[k] = m[k];
      } catch (e) { /* 忽略 */ }
      // ② 分类按需下载：读取用户勾选的题库范围（null=全开）
      try {
        const ec = JSON.parse(localStorage.getItem('cf_cats') || 'null');
        store.enabledCats = Array.isArray(ec) ? ec : null;
      } catch (e) { store.enabledCats = null; }
      initData();
    });

    return { store, glowClass, layoutComp, syncData, setView, favCount, retryLoad: initData };
  }
});

/* -------------------------------------------------------------
 * 9) 收藏夹视图：整条收藏 + 每条可右滑查看子卡 + 底部操作栏
 * ----------------------------------------------------------- */
const FavoritesView = {
  inject: ['store', 'services', 'setView'],
  data() { return { filterCat: 'all', q: '', chipsExpanded: false, hasMoreCats: false }; },
  computed: {
    // 收藏列表：每项是一条完整的 topic（含所有子卡）
    favTopics() {
      const map = store.bookmarked;
      const byId = {};
      store.allTopics.concat(store.mixedTopics).forEach(t => { byId[t.id] = t; });
      const list = [];
      for (const key of Object.keys(map)) {
        const v = map[key];
        const topic = byId[key] || (v && byId[v.topicId]);
        if (topic && topic.sub_cards && topic.sub_cards.length > 0) {
          list.push({
            key,
            topic,
            catId: (v && v.catId) || topic.catId || '',
            catName: (v && v.catName) || topic.catName || '未分类'
          });
        }
      }
      return list;
    },
    cats() {
      const seen = {}; const out = [];
      this.favTopics.forEach(it => {
        if (it.catId && !seen[it.catId]) { seen[it.catId] = true; out.push({ id: it.catId, name: it.catName }); }
      });
      return out;
    },
    filtered() {
      const q = this.q.trim().toLowerCase();
      let list = this.filterCat === 'all' ? this.favTopics : this.favTopics.filter(it => it.catId === this.filterCat);
      if (q) {
        list = list.filter(it => {
          const titles = [it.topic.title].concat((it.topic.sub_cards || []).map(s => s.title));
          const hay = titles.filter(Boolean).join(' ').toLowerCase();
          return hay.includes(q);
        });
      }
      return list;
    }
  },
  methods: {
    goBack() { this.setView('stream'); },
    remove(item) {
      this.services.toggleBookmark(item.topic);
    },
    openInStream(topicId) {
      this.services.openInStream(topicId);
    },
    clearAll() {
      if (!confirm('确定清空所有收藏？')) return;
      store.bookmarked = {};
      try { localStorage.setItem('bookmarked_cards', '{}'); } catch (e) {}
    },
    // 分类标签是否超出 2 排（折叠态下容器被 max-height 裁切，scrollHeight>clientHeight 即溢出）
    //
    // 注意：必须定义在 methods 内。Vue Options API 只会把 methods 里的函数挂到实例上，
    // 写在 options 根层级的函数访问 this.measureChips 得到 undefined。
    // 这里曾踩坑：函数被误放在 mounted 之后、options 根层级，导致每次进收藏夹都抛
    //   TypeError: this.measureChips is not a function
    // 而 hasMoreCats 永远不会被更新（「展开」按钮逻辑形同虚设）。
    // 该异常此前一直静默发生，是接入前端错误监控后捕获到的第一个真实缺陷。
    measureChips() {
      const el = this.$refs.chipsEl;
      if (el) this.hasMoreCats = el.scrollHeight > el.clientHeight + 2;
    }
  },
  // 收藏夹 Swiper 延迟初始化（等 DOM 渲染完成）
  mounted() {
    this.$nextTick(() => {
      setTimeout(() => {
        // 内层横向 Swiper：每条收藏可左右滑动子卡（触摸 + 鼠标拖动均生效）
        document.querySelectorAll('.fav-topic-swiper').forEach(el => {
          if (el.swiper) return;
          new Swiper(el, {
            direction: 'horizontal',
            slidesPerView: 1,
            spaceBetween: 0,
            mousewheel: { enabled: true, forceToAxis: true },
            pagination: { el: el.querySelector('.swiper-pagination'), clickable: true }
          });
        });
        this.measureChips();
      }, 200);
    });
  },
  beforeUnmount() {},
  // 收藏集合变化导致分类数变化时，重新测量是否需要「展开」按钮
  watch: {
    cats() {
      this.$nextTick(() => this.measureChips());
    }
  },
  template: `
    <div class="fav-panel">
      <!-- 头部：返回 + 标题 + 计数 + 清空 -->
      <div class="fav-head">
        <button class="fav-back" @click="goBack">← 返回</button>
        <h3 class="fav-title">★ 我的收藏</h3>
        <div class="flex items-center gap-2">
          <span class="fav-count">{{ favTopics.length }} 条</span>
          <button class="fav-remove" @click="clearAll" v-if="favTopics.length > 0">清空</button>
        </div>
      </div>

      <!-- 搜索 + 分类筛选 -->
      <div class="fav-search">
        <input class="discover-input" type="search" v-model="q" placeholder="搜索收藏（标题 / 标签）…" />
      </div>
      <div class="fav-chips" ref="chipsEl" :class="{ 'chips-collapsed': !chipsExpanded }">
        <button :class="['fav-chip', filterCat==='all'?'active':'']" @click="filterCat='all'">全部</button>
        <button v-for="c in cats" :key="c.id" :class="['fav-chip', filterCat===c.id?'active':'']" @click="filterCat=c.id">{{ c.name }}</button>
      </div>
      <button v-if="hasMoreCats || chipsExpanded" class="fav-chip-more" @click="chipsExpanded = !chipsExpanded">
        {{ chipsExpanded ? '收起 ▴' : '展开全部分类 ▾' }}
      </button>

      <!-- 收藏列表：原生 CSS 滚动（外层），每条含内层横向 Swiper 切子卡 -->
      <div class="fav-list">
        <div v-for="item in filtered" :key="item.key" class="fav-topic-card">
            <!-- 卡片头部：分类 + 操作 -->
            <div class="fav-item-head">
              <div class="flex items-center gap-2">
                <span class="fav-cat">{{ item.catName }}</span>
                <span class="text-xs text-slate-500">{{ item.topic.sub_cards.length }} 页</span>
              </div>
              <div class="flex gap-2">
                <button class="fav-open" @click="openInStream(item.topic.id)">↗ 卡片流查看</button>
                <button class="fav-remove" @click="remove(item)">取消收藏</button>
              </div>
            </div>

            <!-- 紧凑子卡预览：左右滑动切换，不嵌套完整 CardShell（避免框套框） -->
            <div class="fav-swiper-wrap">
              <div class="swiper fav-topic-swiper" :data-fid="'fav-'+item.key">
                <div class="swiper-wrapper">
                  <div class="swiper-slide fav-swiper-slide" v-for="(sub, si) in item.topic.sub_cards" :key="sub.sub_id">
                    <div class="fav-sub-preview">
                      <div class="flex items-center justify-between mb-2">
                        <span class="fav-sub-index">{{ si + 1 }}/{{ item.topic.sub_cards.length }}</span>
                        <span class="text-xs text-slate-500">{{ {streaming_text:'📖',joke_text:'😄',flip_card:'❓'}[sub.layout] || '🌱' }}</span>
                      </div>
                      <h4 class="fav-sub-title">{{ sub.title || sub.front_text || sub.caption || '无标题' }}</h4>
                      <p class="fav-sub-body">{{ [sub.content, sub.streaming_content, sub.back_text, sub.caption, (sub.items||[]).join('')].filter(Boolean).join('').slice(0, 120) || '（暂无内容预览）' }}</p>
                      <p v-if="sub.layout==='streaming_text'" class="fav-sub-hint">左右滑动查看更多 →</p>
                      <p v-else-if="sub.layout==='flip_card'" class="fav-sub-hint">点击翻牌查看解析 ↺</p>
                    </div>
                  </div>
                </div>
                <div class="swiper-pagination"></div>
              </div>
            </div>
          </div>

      <p v-if="filtered.length===0 && !q" class="fav-empty">还没有收藏任何卡片，去「刷一刷」点 📑 收藏吧～</p>
      <p v-else-if="filtered.length===0 && q" class="fav-empty">收藏里没有匹配「{{ q }}」的内容</p>
    </div>
  `
};

/* -------------------------------------------------------------
 * 9.5) 分类选择 sheet：勾选要刷题的分类（按需下载，未勾不拉取）
 * ----------------------------------------------------------- */
const CategorySheet = {
  inject: ['store', 'services'],
  computed: {
    cats() { return this.store.categories || []; },
    enabled() { return this.store.enabledCats; }
  },
  methods: {
    isOn(catId) { return !this.enabled || this.enabled.length === 0 || this.enabled.includes(catId); },
    close() { this.store.catSheet = false; if (verticalSwiper) verticalSwiper.enable(); },
    // 切换分类：持久化后整页重载，仅下载勾选分类的 bundle
    toggleCat(catId) {
      const all = (this.store.categories || []).map((c) => c.id);
      let cur = this.enabled && this.enabled.length ? this.enabled.slice() : all.slice();
      if (cur.includes(catId)) cur = cur.filter((x) => x !== catId);
      else cur.push(catId);
      const next = (cur.length === all.length) ? null : cur;
      this.store.enabledCats = next;
      try { localStorage.setItem('cf_cats', JSON.stringify(next)); } catch (e) {}
      location.reload();
    }
  },
  template: `
    <div class="cat-overlay" @click.self="close">
      <div class="cat-sheet">
        <div class="flex justify-between items-center mb-3">
          <h4 class="font-bold text-slate-100 text-base">📂 选择刷题分类</h4>
          <button @click="close" class="source-close">&times;</button>
        </div>
        <p class="text-xs text-slate-400 mb-3">未勾选的分类不会被下载、也不会出现在卡片流。修改后整页重载以应用。</p>
        <div class="cat-chips">
          <button v-for="c in cats" :key="c.id" :class="['discover-chip', isOn(c.id)?'active':'']" @click="toggleCat(c.id)">{{ c.name }}</button>
        </div>
      </div>
    </div>
  `
};

/* 注入共享依赖 + 注册组件 */
app.provide('store', store);
app.provide('services', services);
app.provide('setView', setView);
app.component('card-shell', CardShell);
app.component('qa-card', QaCard);
app.component('stream-card', StreamCard);
app.component('flip-card', FlipCard);
app.component('joke-card', JokeCard);
app.component('meme-card', MemeCard);
app.component('game-card', GameCard);
app.component('list-card', ListCard);
app.component('quote-card', QuoteCard);
app.component('compare-card', CompareCard);
app.component('favorites-view', FavoritesView);
app.component('category-sheet', CategorySheet);

app.mount('#app');
