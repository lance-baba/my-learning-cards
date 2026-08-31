/* =============================================================
 * CardFlow —— 备考题库模块（学习 / 模考 / 错题本 / 统计）
 *
 * 移植自 D:\项目开发\小树学习\模拟考试.html（learnST）。
 * 数据：地基基础检测备考题库，1683 题 / 8 章
 *      （单选 668 · 判断 445 · 多选 400 · 计算 170）
 *
 * 与 CardFlow 主卡片流完全解耦：题库文件 /exam/questions.json 按需加载，
 * 只有点进本模块才下载，不进首屏、不影响刷一刷。
 *
 * 移植时修掉的原版缺陷（对照 模拟考试-移植规格.md §8）：
 *  - 洗牌由 sort(()=>Math.random()-0.5) 换成 Fisher-Yates（原版分布有偏）
 *  - 交卷时「未答」不再塞进错题本，只在成绩页单独统计
 *  - 倒计时在组件卸载 / 离开考试页时必定清理（原版跨页存活，会回调已卸载 DOM）
 *  - 序号用「章内连续 idx+1」而非 q.num（q.num 按题型分别计数，会重复）
 *  - localStorage 读取支持假值（原版 `v ? JSON.parse(v) : def` 读不回 0/false/''）
 *  - 去掉全部死代码：wrongBadge 角标、5 个不存在的导航按钮、未写入的错题筛选行、
 *    无界面的收藏功能、从不调用的 showLoadError
 *  - 修复「我选对了」与「这是正确答案」同色同款、无法区分的问题
 * ============================================================= */
(function () {
  'use strict';

  /* ---------------- 本地存储 ----------------
   * 沿用 learnST 的 djjc_ 前缀，便于老用户数据直接迁移。 */
  var LS = {
    get: function (k, def) {
      try {
        var v = localStorage.getItem('djjc_' + k);
        // 原版用 `v ? JSON.parse(v) : def`，会把 "0"/"false"/"" 当 falsy 返回默认值
        return v !== null ? JSON.parse(v) : def;
      } catch (e) { return def; }
    },
    set: function (k, v) {
      try { localStorage.setItem('djjc_' + k, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ }
    }
  };

  var TYPES_ORDER = ['单选题', '多选题', '判断题', '计算题'];
  var BANK_URL = '/exam/questions.json';

  /* ---------------- 工具 ---------------- */

  // Fisher-Yates 无偏洗牌。原版的 sort(() => Math.random() - 0.5) 是已知的有偏实现。
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function formatTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    if (m === 0) return s + '秒';
    return m + '分' + (s < 10 ? '0' : '') + s + '秒';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 题干里少量题目带 <sup> 上标（如 2.45×10<sup>3</sup>kg/m³）。
  // 直接 v-html 太危险（题库可被用户导入，是真实 XSS 面），
  // 所以先全量转义，再把白名单标签放回来。
  var ALLOWED_TAGS = 'sup|sub|b|i|u';
  function safeRichText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(new RegExp('&lt;(/?)(' + ALLOWED_TAGS + ')&gt;', 'g'), '<$1$2>');
  }

  // 判断用户答案是否正确。多选题比对前排序，避免顺序影响。
  function isRight(q, userAns) {
    if (!userAns) return false;
    var std = String(q.ans).trim();
    if (q.type === '多选题') {
      return userAns.split('').sort().join('') === std.split('').sort().join('');
    }
    return userAns === std;
  }

  /* =============================================================
   * 子组件：单题渲染（学习 / 模考 / 复盘 / 错题重做 共用）
   * 原版用 innerHTML 重建后再 querySelector 抓回来补 class，
   * 这里改成一份声明式的 optionClass，渲染/还原/复盘三处逻辑合一。
   * ============================================================= */
  var ExamQuestion = {
    name: 'ExamQuestion',
    props: {
      q: { type: Object, required: true },
      mode: { type: String, default: 'exam' },   // study | exam | review | wrong
      selected: { type: String, default: '' },   // 用户答案
      judged: { type: Boolean, default: false }, // 是否已判定对错
      locked: { type: Boolean, default: false }, // 判定后是否锁死选项
      indexLabel: { type: String, default: '' }, // 题号文案，由父组件决定（q.num 会重复）
    },
    emits: ['select'],
    computed: {
      optKeys: function () { return Object.keys(this.q.opts || {}); },
      // 学习模式直接亮答案；复盘/错题重做在判定后亮答案
      showAnswer: function () { return this.mode === 'study' || this.judged; },
      isMulti: function () { return this.q.type === '多选题'; },
      correctKeys: function () {
        return this.isMulti ? String(this.q.ans).trim().split('') : [String(this.q.ans).trim()];
      },
      richText: function () { return safeRichText(this.q.q); }
    },
    methods: {
      // 模板里要判定「我答对了吗」，必须挂到实例上（模块级函数在模板作用域里取不到）
      isRight: isRight,
      cls: function (key) {
        var sel = this.selected ? this.selected.split('') : [];
        var isCorrectKey = this.correctKeys.indexOf(key) >= 0;
        var picked = sel.indexOf(key) >= 0;
        return {
          'ex-opt': true,
          // 选中但未判定：仅高亮，不透露对错
          'ex-opt--picked': picked && !this.showAnswer,
          // 已揭示答案：正确答案标绿；「我选对了」是实心绿，「漏选的正确答案」是描边绿
          'ex-opt--right': this.showAnswer && isCorrectKey && picked,
          'ex-opt--right-hint': this.showAnswer && isCorrectKey && !picked,
          // 我选错了：实心红
          'ex-opt--wrong': this.showAnswer && !isCorrectKey && picked,
          'ex-opt--locked': this.locked
        };
      },
      onPick: function (key) {
        if (this.locked) return;
        this.$emit('select', key);
      },
      rich: function (s) { return safeRichText(s); }
    },
    template: [
      '<div class="ex-qcard">',
      '  <div class="ex-qhead">',
      '    <span class="ex-qnum">{{ indexLabel }}</span>',
      '    <span class="ex-tag" :class="\'ex-tag--\' + q.type">{{ q.type }}</span>',
      '    <span v-if="q.diff" class="ex-tag ex-tag--diff">{{ q.diff }}</span>',
      '  </div>',
      '  <div class="ex-qtext" v-html="richText"></div>',
      '  <div class="ex-opts">',
      '    <div v-for="k in optKeys" :key="k" :class="cls(k)" @click="onPick(k)">',
      '      <span class="ex-optkey">{{ k }}</span>',
      '      <span class="ex-opttext" v-html="rich(q.opts[k])"></span>',
      '    </div>',
      '  </div>',
      '  <div v-if="showAnswer" class="ex-answerbar">',
      '    <template v-if="mode === \'study\'">',
      '      <span class="ex-ans-label">答案</span><span class="ex-ans-val">{{ q.ans }}</span>',
      '    </template>',
      '    <template v-else-if="selected">',
      '      <span class="ex-ans-label" :class="judged && !isRight(q, selected) ? \'ex-ans-label--bad\' : \'ex-ans-label--ok\'">',
      '        {{ isRight(q, selected) ? "✓ 答对" : "✘ 答错" }}',
      '      </span>',
      '      <span class="ex-ans-val">正确答案 {{ q.ans }}<span v-if="!isRight(q, selected)"> · 你选了 {{ selected }}</span></span>',
      '    </template>',
      '    <template v-else>',
      '      <span class="ex-ans-label ex-ans-label--skip">未作答</span>',
      '      <span class="ex-ans-val">正确答案 {{ q.ans }}</span>',
      '    </template>',
      '  </div>',
      '</div>'
    ].join('')
  };

  /* =============================================================
   * 主组件：ExamView
   * 页面：home | study-select | study | exam-config | exam | exam-result
   *       exam-review | wrong | wrong-practice | stats
   * ============================================================= */
  var ExamView = {
    name: 'ExamView',
    components: { ExamQuestion: ExamQuestion },
    data: function () {
      return {
        page: 'home',
        loadState: 'idle',      // idle | loading | ready | error
        loadError: '',
        title: '备考题库',

        // 题库（按需加载）
        questions: [],
        chapterMap: {},         // { 章节: { 题型: [下标] } }
        chapters: [],
        shortNames: {},
        version: '',

        // 学习模式
        study: { chapter: '', type: 'all', list: [], idx: 0, jumpInput: '' },

        // 模考配置与运行态
        cfg: { chapters: ['all'], types: ['all'], count: 50, time: 60 },
        exam: { list: [], idx: 0, answers: {}, seconds: 0, totalTime: 3600, submitted: false, timer: null },
        review: { list: [], idx: 0, onlyWrong: false },
        sheetOpen: false,       // 答题卡

        // 错题重做
        wrongPractice: { chapter: 'all', list: [], idx: 0, answers: {}, jumpInput: '' },
        wrongPicked: {},        // 错题重做里的临时选中（答错可重试，未答对不落库）
        wrongWrong: {},         // 错题重做里本次答错过（仅驱动 UI 变红）

        result: null,           // 交卷后的成绩对象
        dialog: null,           // { msg, onOk }
        // localStorage 不是响应式数据源，写它不会触发 computed 重算。
        // 用一个自增计数器建立依赖：任何写 LS 的地方都 rev++，读 LS 的 computed 才会刷新。
        rev: 0,
        // 返回栈：子页进栈，首页作为「退出到 CardFlow」的边界（清空历史）
        history: [],
        // 题库管理：当前激活题库（code 空 = 内置地基题库）。持久化到 localStorage。
        // 注意：网页端只保留「验证码加载」入口；上传题库只能由本机程序调用
        // Worker POST /api/bank（需 X-Bank-Key，见 tools/upload_bank.mjs），不在网页留任何上传接口。
        activeBank: LS.get('activeBank', { code: '', title: '' }),
        loadCode: '', loadBusy: false, loadMsg: ''
      };
    },

    computed: {
      /* ---------- 题库统计 ---------- */
      totalCount: function () { return this.questions.length; },

      // 首页标题：内置题库显示「备考题库」，加载验证码题库后显示其标题
      homeTitle: function () {
        return this.activeBank.code ? ('题库 · ' + (this.activeBank.title || this.activeBank.code)) : '备考题库';
      },

      // 每章：总题数 / 已读（学习模式）/ 各题型数量
      chapterCards: function () {
        var self = this;
        var read = LS.get('studyRead', {});
        void this.rev;   // 建立对 localStorage 写入的依赖
        return this.chapters.map(function (ch) {
          var byType = self.chapterMap[ch] || {};
          var ids = [];
          var types = [];
          TYPES_ORDER.forEach(function (t) {
            var arr = byType[t] || [];
            if (arr.length) { types.push({ name: t, count: arr.length }); ids = ids.concat(arr); }
          });
          var done = ids.filter(function (id) { return read[id]; }).length;
          return {
            ch: ch,
            short: self.shortNames[ch] || ch,
            total: ids.length,
            done: done,
            pct: ids.length ? Math.round(done / ids.length * 100) : 0,
            types: types
          };
        });
      },

      // 全部题的已读进度（首页用）
      studyProgress: function () {
        void this.rev;
        var read = LS.get('studyRead', {});
        var done = this.questions.filter(function (q) { return read[q._id]; }).length;
        return { done: done, total: this.questions.length, pct: this.questions.length ? Math.round(done / this.questions.length * 100) : 0 };
      },

      wrongList: function () {
        var self = this;
        void this.rev;
        var w = LS.get('wrong', {});
        return Object.keys(w).map(Number)
          .filter(function (id) { return self.questions[id]; })
          .sort(function (a, b) { return (w[b] || 0) - (w[a] || 0); });  // 最近错的在前
      },

      wrongCount: function () { return this.wrongList.length; },

      /* ---------- 组卷 ---------- */
      examPool: function () {
        var chs = this.cfg.chapters.indexOf('all') >= 0 ? this.chapters : this.cfg.chapters;
        var tps = this.cfg.types.indexOf('all') >= 0 ? TYPES_ORDER : this.cfg.types;
        var pool = [];
        var self = this;
        chs.forEach(function (ch) {
          tps.forEach(function (t) {
            pool = pool.concat((self.chapterMap[ch] || {})[t] || []);
          });
        });
        return pool;
      },

      /* ---------- 模考运行时 ---------- */
      examQ: function () { return this.questions[this.exam.list[this.exam.idx]] || null; },
      examAnswered: function () {
        var a = this.exam.answers;
        return Object.keys(a).filter(function (k) { return a[k]; }).length;
      },
      examRemain: function () { return Math.max(0, this.exam.totalTime - this.exam.seconds); },
      examRemainText: function () {
        var r = this.examRemain;
        return pad2(Math.floor(r / 60)) + ':' + pad2(r % 60);
      },
      examDanger: function () { return this.examRemain <= 60; },

      /* ---------- 复盘 ---------- */
      reviewQ: function () { return this.questions[this.review.list[this.review.idx]] || null; },

      /* ---------- 错题重做 ---------- */
      wrongQ: function () {
        return this.questions[this.wrongPractice.list[this.wrongPractice.idx]] || null;
      },

      /* ---------- 统计 ----------
       * 做成 computed 而非 methods：否则模板里 statsData 会被调用十几次，
       * 每次都要遍历全量 1683 题重新分组。 */
      statsData: function () {
        void this.rev;
        var self = this;
        var rec = LS.get('record', {});
        var w = LS.get('wrong', {});
        var his = LS.get('examHistory', []);
        var doneIds = Object.keys(rec);
        var rightIds = doneIds.filter(function (k) { return rec[k]; });

        // 按章节
        var byCh = this.chapters.map(function (ch) {
          var byType = self.chapterMap[ch] || {};
          var ids = [];
          TYPES_ORDER.forEach(function (t) { ids = ids.concat(byType[t] || []); });
          var done = ids.filter(function (id) { return rec[id] !== undefined; }).length;
          var right = ids.filter(function (id) { return rec[id] === true; }).length;
          return {
            key: ch, name: self.shortNames[ch] || ch, total: ids.length, done: done, right: right,
            pct: done ? Math.round(right / done * 100) : 0
          };
        });

        // 按题型
        var byType = TYPES_ORDER.map(function (t) {
          var ids = [];
          self.chapters.forEach(function (ch) { ids = ids.concat((self.chapterMap[ch] || {})[t] || []); });
          var done = ids.filter(function (id) { return rec[id] !== undefined; }).length;
          var right = ids.filter(function (id) { return rec[id] === true; }).length;
          return { key: t, name: t, total: ids.length, done: done, right: right, pct: done ? Math.round(right / done * 100) : 0 };
        });

        return {
          total: this.questions.length,
          done: doneIds.length,
          wrong: Object.keys(w).length,
          exams: his.length,
          pct: doneIds.length ? Math.round(rightIds.length / doneIds.length * 100) : 0,
          byCh: byCh,
          byType: byType,
          history: his.slice().reverse()
        };
      }
    },

    methods: {
      /* ================= 题库加载 ================= */
      loadBank: function () {
        var self = this;
        if (this.loadState === 'ready' || this.loadState === 'loading') return;
        this.loadState = 'loading';
        this.loadError = '';
        var bankUrl = this.activeBank.code ? ('/api/bank?id=' + encodeURIComponent(this.activeBank.code)) : BANK_URL;
        fetch(bankUrl, { cache: this.activeBank.code ? 'no-store' : 'force-cache' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (data) {
            if (!data || !Array.isArray(data.questions) || !data.questions.length) {
              throw new Error('题库为空或格式不正确');
            }
            self.questions = data.questions.map(function (q, i) { q._id = i; return q; });
            self.chapters = data.chapters || [];
            self.shortNames = data.shortNames || {};
            self.version = data.version || '';
            self.buildIndex();
            self.loadState = 'ready';
            self.go('home');
          })
          .catch(function (e) {
            console.error('题库加载失败', e);
            self.loadState = 'error';
            self.loadError = '题库加载失败，请检查网络后重试';
            if (window.__cfReport) window.__cfReport('exam', 'bank-load: ' + (e && e.message ? e.message : 'failed'));
          });
      },

      // 二级索引 {章节: {题型: [下标]}}，组卷时 O(1) 取用
      buildIndex: function () {
        var map = {};
        this.questions.forEach(function (q) {
          if (!map[q.ch]) map[q.ch] = {};
          if (!map[q.ch][q.type]) map[q.ch][q.type] = [];
          map[q.ch][q.type].push(q._id);
        });
        this.chapterMap = map;
        if (!this.chapters.length) this.chapters = Object.keys(map);
      },

      /* ================= 题库管理（网页端仅「验证码加载」） ================= */
      reloadBank: function () {
        this.questions = []; this.chapters = []; this.chapterMap = {}; this.shortNames = {}; this.version = '';
        this.history = [];
        this.loadState = 'idle';
        this.loadBank();
      },
      useBuiltin: function () {
        this.activeBank = { code: '', title: '' };
        LS.set('activeBank', this.activeBank);
        this.reloadBank();
      },
      loadByCode: function (code) {
        var self = this;
        code = (code || '').trim();
        if (!/^[A-Za-z0-9]{4,32}$/.test(code)) { this.loadMsg = '验证码格式不正确（4–32 位字母数字）'; return; }
        this.loadBusy = true; this.loadMsg = '正在加载…';
        fetch('/api/bank?id=' + encodeURIComponent(code), { cache: 'no-store' })
          .then(function (r) {
            if (r.ok) return r.json();
            // 非 200：尽量取服务端返回的中文提示（如设备超限），否则按状态码给默认文案
            return r.json().catch(function () { return {}; }).then(function (err) {
              var msg = (err && (err.message || err.error)) ? (err.message || err.error) : null;
              if (r.status === 404 && !msg) msg = '验证码不存在，请检查后重试';
              throw new Error(msg || ('题库加载失败（' + r.status + '）'));
            });
          })
          .then(function (data) {
            if (!data || !Array.isArray(data.questions) || !data.questions.length) throw new Error('题库为空或格式不正确');
            self.activeBank = { code: code, title: data.title || data.version || code };
            LS.set('activeBank', self.activeBank);
            self.loadBusy = false; self.loadMsg = '';
            self.reloadBank();
          })
          .catch(function (e) {
            self.loadBusy = false;
            self.loadMsg = (e && e.message) || '题库加载失败，请重试';
          });
      },
      /* 上传题库走本机程序，见 tools/upload_bank.mjs（调用 Worker POST /api/bank，需 X-Bank-Key）。
         网页端不提供任何上传入口，故此处只保留「验证码加载」。 */

      /* ================= 路由 ================= */
      go: function (page) {
        // 离开考试页时若考试未提交，倒计时必须停掉，
        // 否则定时器会在组件卸载后回调 submitExam 操作已销毁的数据。
        if (page !== 'exam' && page !== 'exam-result' && page !== 'exam-review') this.stopTimer();
        // 返回栈：进入子页进栈；首页作为「退出到 CardFlow」的边界，清空历史
        if (page !== this.page) {
          if (page === 'home') { this.history = []; this.title = this.homeTitle(); }
          else if (this.history[this.history.length - 1] !== this.page) this.history.push(this.page);
        }
        this.page = page;
        this.sheetOpen = false;
        var el = this.$refs.body;
        if (el) el.scrollTop = 0;
      },

      // 返回：优先在备考模块内逐级回退（避免一按返回就跳回 CardFlow 刷一刷，跳转层级过多）。
      // 仅在首页（历史栈空）时才退出到 CardFlow 主页。
      back: function () {
        this.stopTimer();
        if (this.history.length) {
          var prev = this.history.pop();
          this.page = prev;
          this.sheetOpen = false;
          var el = this.$refs.body;
          if (el) el.scrollTop = 0;
        } else {
          this.close();
        }
      },

      close: function () {
        this.stopTimer();
        // 独立页面：返回 CardFlow 主页（同一站点下的 index.html）
        window.location.href = './';
      },

      /* ================= 存取 ================= */
      recordAnswer: function (qid, ok) {
        var rec = LS.get('record', {});
        var wrong = LS.get('wrong', {});
        rec[qid] = ok;
        if (ok) delete wrong[qid];
        else wrong[qid] = Date.now();
        LS.set('record', rec);
        LS.set('wrong', wrong);
        this.rev++;   // localStorage 不触发响应式，手动通知依赖它的 computed
      },

      markRead: function (qid) {
        var read = LS.get('studyRead', {});
        if (read[qid]) return;
        read[qid] = 1;
        LS.set('studyRead', read);
        this.rev++;
      },

      /* ================= 学习模式 ================= */
      startStudy: function (ch) {
        var self = this;
        this.study.chapter = ch;
        this.study.type = 'all';
        this.buildStudyList();
        // 断点续读：定位到第一个未读的题；全读完了就回到第 1 题
        var read = LS.get('studyRead', {});
        var resume = 0;
        for (var i = 0; i < this.study.list.length; i++) {
          if (!read[this.study.list[i]]) { resume = i; break; }
          if (i === this.study.list.length - 1) resume = 0;
        }
        this.study.idx = resume;
        this.title = (this.shortNames[ch] || ch) + ' · 看题学习';
        this.go('study');
        this.$nextTick(function () { self.markCurrentRead(); });
      },

      buildStudyList: function () {
        var byType = this.chapterMap[this.study.chapter] || {};
        var list = [];
        TYPES_ORDER.forEach(function (t) {
          if (this.study.type === 'all' || this.study.type === t) {
            list = list.concat(byType[t] || []);
          }
        }, this);
        this.study.list = list;
        if (this.study.idx >= list.length) this.study.idx = Math.max(0, list.length - 1);
      },

      setStudyType: function (t) {
        this.study.type = t;
        this.study.idx = 0;
        this.buildStudyList();
      },

      studyNav: function (d) {
        var n = this.study.idx + d;
        if (n < 0 || n >= this.study.list.length) return;
        this.study.idx = n;
        this.markCurrentRead();
      },

      studyJump: function (n) {
        n = parseInt(n, 10);
        if (isNaN(n) || n < 1 || n > this.study.list.length) { this.study.jumpInput = ''; return; }
        this.study.idx = n - 1;
        this.study.jumpInput = '';
        this.markCurrentRead();
      },

      // 错题重做：跳到指定题号（与学习模式同样的「输入 + 按钮」体验）
      wrongJump: function (n) {
        n = parseInt(n, 10);
        if (isNaN(n) || n < 1 || n > this.wrongPractice.list.length) { this.wrongPractice.jumpInput = ''; return; }
        this.wrongPractice.idx = n - 1;
        this.wrongPractice.jumpInput = '';
      },

      markCurrentRead: function () {
        var id = this.study.list[this.study.idx];
        if (id !== undefined) this.markRead(id);
      },

      studyDone: function () {
        var read = LS.get('studyRead', {});
        return this.study.list.filter(function (id) { return read[id]; }).length;
      },

      studyQ: function () { return this.questions[this.study.list[this.study.idx]] || null; },

      /* ================= 模考 ================= */
      toggleChip: function (group, val) {
        var arr = group === 'ch' ? this.cfg.chapters : this.cfg.types;
        if (val === 'all') {
          // 选「全部」：清空同组其它选中（全部与具体项互斥）
          if (group === 'ch') this.cfg.chapters = ['all'];
          else this.cfg.types = ['all'];
          return;
        }
        var rest = arr.filter(function (x) { return x !== 'all'; });
        if (rest.indexOf(val) >= 0) rest = rest.filter(function (x) { return x !== val; });
        else rest.push(val);
        // 一个都不选时自动回落到「全部」
        if (!rest.length) rest = ['all'];
        if (group === 'ch') this.cfg.chapters = rest;
        else this.cfg.types = rest;
      },

      chipActive: function (group, val) {
        var arr = group === 'ch' ? this.cfg.chapters : this.cfg.types;
        return arr.indexOf(val) >= 0;
      },

      startExam: function () {
        var pool = this.examPool;
        if (!pool.length) { alert('所选范围内无可用题目'); return; }
        var count = Math.min(parseInt(this.cfg.count, 10) || 50, pool.length);
        var time = parseInt(this.cfg.time, 10) || 60;
        this.exam.list = shuffle(pool).slice(0, count);
        this.exam.idx = 0;
        this.exam.answers = {};
        this.exam.seconds = 0;
        this.exam.totalTime = time * 60;
        this.exam.submitted = false;
        this.title = '模拟考试';
        this.go('exam');
        this.startTimer();
      },

      startTimer: function () {
        var self = this;
        this.stopTimer();
        this.exam.timer = setInterval(function () {
          self.exam.seconds++;
          if (self.examRemain <= 0) {
            self.stopTimer();
            self.submitExam(true);   // 到点强制交卷，与手动交卷同一入口
          }
        }, 1000);
      },

      stopTimer: function () {
        if (this.exam.timer) { clearInterval(this.exam.timer); this.exam.timer = null; }
      },

      // 考试中答题：可反复修改，不判对错、不锁定
      answer: function (key) {
        var q = this.examQ;
        if (!q) return;
        if (q.type === '多选题') {
          var cur = (this.exam.answers[q._id] || '').split('').filter(Boolean);
          var i = cur.indexOf(key);
          if (i >= 0) cur.splice(i, 1); else cur.push(key);
          var v = cur.sort().join('');
          if (v) this.exam.answers[q._id] = v;
          else delete this.exam.answers[q._id];
        } else {
          this.exam.answers[q._id] = key;
        }
      },

      examNav: function (d) {
        var n = this.exam.idx + d;
        if (n < 0 || n >= this.exam.list.length) return;
        this.exam.idx = n;
      },

      examJump: function (i) {
        this.exam.idx = i;
        this.sheetOpen = false;
      },

      confirmSubmit: function () {
        var self = this;
        var total = this.exam.list.length;
        var done = this.examAnswered;
        var msg = done < total ? ('还有 ' + (total - done) + ' 道题未作答，确认交卷？') : '确认交卷？';
        this.dialog = { msg: msg, onOk: function () { self.dialog = null; self.submitExam(false); } };
      },

      submitExam: function (auto) {
        if (this.exam.submitted) return;
        this.stopTimer();
        this.exam.submitted = true;

        var correct = 0, wrong = 0, unanswered = 0;
        var self = this;
        this.exam.list.forEach(function (qid) {
          var q = self.questions[qid];
          var ua = self.exam.answers[qid];
          if (!ua) {
            // 原版把未答也记成错、塞进错题本（一次模考能瞬间灌进几十道错题）。
            // 这里只统计、不入错题本。
            unanswered++;
            return;
          }
          var ok = isRight(q, ua);
          if (ok) correct++; else wrong++;
          self.recordAnswer(qid, ok);
        });

        var total = this.exam.list.length;
        this.result = {
          correct: correct,
          wrong: wrong,
          unanswered: unanswered,
          total: total,
          pct: total ? Math.round(correct / total * 100) : 0,
          seconds: this.exam.seconds,
          auto: !!auto
        };

        var his = LS.get('examHistory', []);
        his.push({ date: Date.now(), total: total, correct: correct, wrong: wrong, unanswered: unanswered, seconds: this.exam.seconds });
        if (his.length > 50) his.shift();
        LS.set('examHistory', his);
        this.rev++;

        this.title = '考试成绩';
        this.go('exam-result');
      },

      reviewExam: function (onlyWrong) {
        var self = this;
        var list = onlyWrong
          ? this.exam.list.filter(function (qid) { return !isRight(self.questions[qid], self.exam.answers[qid]); })
          : this.exam.list.slice();
        if (onlyWrong && !list.length) { alert('没有错题，太棒了！'); return; }
        this.review.list = list;
        this.review.idx = 0;
        this.review.onlyWrong = !!onlyWrong;
        this.title = onlyWrong ? ('错题回顾（' + list.length + '题）') : '考试回顾（全部）';
        this.go('exam-review');
      },

      reviewNav: function (d) {
        var n = this.review.idx + d;
        if (n < 0 || n >= this.review.list.length) return;
        this.review.idx = n;
      },

      /* ================= 错题本 ================= */
      startWrongPractice: function (ch, jumpTo) {
        var list = ch === 'all' ? this.wrongList.slice() : this.wrongList.filter(function (id) { return this.questions[id] && this.questions[id].ch === ch; }, this);
        if (!list.length) { alert('暂无错题'); return; }
        this.wrongPractice.chapter = ch;
        this.wrongPractice.list = list;
        this.wrongPractice.answers = {};
        var i = jumpTo !== undefined ? list.indexOf(jumpTo) : 0;
        this.wrongPractice.idx = i < 0 ? 0 : i;
        this.title = '错题重做';
        this.go('wrong-practice');
      },

      // 错题重做：答错不锁定（可以重试），答对才锁定并移出错题本
      answerWrong: function (key) {
        var q = this.wrongQ;
        if (!q) return;
        if (this.wrongPractice.answers[q._id]) return;   // 已答对，锁定
        var picked;
        if (q.type === '多选题') {
          var cur = (this.wrongPicked || {})[q._id] || [];
          var i = cur.indexOf(key);
          if (i >= 0) cur.splice(i, 1); else cur.push(key);
          picked = cur.slice().sort().join('');
          this.wrongPicked = this.wrongPicked || {};
          this.wrongPicked[q._id] = cur;
        } else {
          picked = key;
        }
        var ok = isRight(q, picked);
        if (ok) {
          this.wrongPractice.answers[q._id] = picked;
          this.recordAnswer(q._id, true);
        } else {
          // 答错：只更新临时选中态供重选，不写 record（避免重复计数）
          if (q.type !== '多选题') {
            this.wrongPicked = this.wrongPicked || {};
            this.wrongPicked[q._id] = [key];
          }
          this.wrongWrong = this.wrongWrong || {};
          this.wrongWrong[q._id] = true;
          this.recordAnswer(q._id, false);
        }
      },

      wrongPickedOf: function (qid) {
        return ((this.wrongPicked || {})[qid] || []).join('');
      },

      wrongNav: function (d) {
        var n = this.wrongPractice.idx + d;
        if (n < 0 || n >= this.wrongPractice.list.length) return;
        this.wrongPractice.idx = n;
      },

      clearWrong: function () {
        var self = this;
        this.dialog = {
          msg: '确认清空全部错题？此操作不可撤销。',
          onOk: function () { LS.set('wrong', {}); self.rev++; self.dialog = null; }
        };
      },

      /* ================= 统计 ================= */
      fmtDate: function (ts) {
        var d = new Date(ts);
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      },

      fmtTime: formatTime,
      isRight: isRight
    },

    mounted: function () { this.loadBank(); },
    beforeUnmount: function () { this.stopTimer(); },

    template: [
      '<div class="ex-panel">',

      /* ---------- 顶栏 ---------- */
      '  <div class="ex-head">',
      '    <button class="ex-back" @click="back">← 返回</button>',
      '    <span class="ex-title">{{ title }}</span>',
      '    <button v-if="page === \'exam\'" class="ex-headbtn" @click="sheetOpen = !sheetOpen">答题卡</button>',
      '    <span v-else class="ex-headbtn ex-headbtn--ghost"></span>',
      '  </div>',

      '  <div class="ex-body" ref="body">',

      /* ---------- 加载态 ---------- */
      '    <div v-if="loadState === \'loading\'" class="ex-state">',
      '      <div class="ex-spinner"></div><p>正在加载题库…</p>',
      '    </div>',
'    <div v-else-if="loadState === \'error\'" class="ex-state">',
'      <div class="ex-state-icon">⚠️</div><p>{{ loadError }}</p>',
'      <button class="ex-btn" @click="loadBank">重试</button>',
'      <button v-if="activeBank.code" class="ex-btn ex-btn--sm" @click="useBuiltin">恢复内置题库</button>',
'    </div>',

      /* ---------- 首页 ---------- */
      '    <div v-else-if="page === \'home\'" class="ex-home">',
      '      <div class="ex-hero">',
      '        <h2 class="ex-hero-title">地基基础检测 · 备考题库</h2>',
      '        <p class="ex-hero-sub">涵盖 {{ chapters.length }} 大章节 · 4 种题型 · 共 {{ totalCount }} 题</p>',
      '        <div class="ex-hero-bar"><span :style="{ width: studyProgress.pct + \'%\' }"></span></div>',
      '        <p class="ex-hero-prog">学习进度 {{ studyProgress.done }}/{{ studyProgress.total }}（{{ studyProgress.pct }}%）</p>',
      '      </div>',
      '      <div class="ex-grid">',
      '        <button class="ex-entry ex-entry--study" @click="go(\'study-select\')">',
      '          <span class="ex-entry-icon">📖</span><span class="ex-entry-name">看题学习</span>',
      '          <span class="ex-entry-desc">逐题浏览 · 直接看答案</span>',
      '        </button>',
      '        <button class="ex-entry ex-entry--exam" @click="go(\'exam-config\')">',
      '          <span class="ex-entry-icon">📝</span><span class="ex-entry-name">模拟考试</span>',
      '          <span class="ex-entry-desc">组卷 · 计时 · 判分 · 复盘</span>',
      '        </button>',
      '        <button class="ex-entry ex-entry--wrong" @click="go(\'wrong\')">',
      '          <span class="ex-entry-icon">🔁</span><span class="ex-entry-name">错题回顾</span>',
      '          <span class="ex-entry-desc">{{ wrongCount ? wrongCount + \' 道待巩固\' : \'巩固薄弱知识点\' }}</span>',
      '        </button>',
'        <button class="ex-entry ex-entry--stats" @click="go(\'stats\')">',
'          <span class="ex-entry-icon">📊</span><span class="ex-entry-name">学习统计</span>',
'          <span class="ex-entry-desc">正确率 · 章节进度</span>',
'        </button>',
'      </div>',
'      <div class="ex-bankcard">',
'        <div class="ex-bankhead">📚 题库管理</div>',
'        <div v-if="activeBank.code" class="ex-bankrow">',
'          <span>当前：{{ activeBank.title || activeBank.code }}（验证码 <b>{{ activeBank.code }}</b>）</span>',
'          <button class="ex-btn ex-btn--sm" @click="useBuiltin">恢复内置题库</button>',
'        </div>',
'        <div v-else class="ex-bankrow"><span class="ex-banktip">当前：内置「地基题库」（测试用，可切换）</span></div>',
'        <div class="ex-bankload">',
'          <input class="ex-jumpinput" type="text" maxlength="32" placeholder="输入验证码" v-model="loadCode" :disabled="loadBusy">',
'          <button class="ex-btn ex-btn--sm" :disabled="loadBusy" @click="loadByCode(loadCode)">加载</button>',
'        </div>',
'        <p v-if="loadMsg" class="ex-bankmsg">{{ loadMsg }}</p>',
'      </div>',
'    </div>',

      /* ---------- 学习：章节选择 ---------- */
      '    <div v-else-if="page === \'study-select\'" class="ex-page">',
      '      <div v-for="(c, i) in chapterCards" :key="c.ch" class="ex-chcard" @click="startStudy(c.ch)">',
      '        <div class="ex-chindex">{{ i + 1 }}</div>',
      '        <div class="ex-chname">{{ c.ch }}</div>',
      '        <div class="ex-chmeta">',
      '          <span v-for="t in c.types" :key="t.name" class="ex-chtag">{{ t.name }} {{ t.count }}</span>',
      '        </div>',
      '        <div class="ex-chbar"><span :style="{ width: c.pct + \'%\' }"></span></div>',
      '        <div class="ex-chpct">{{ c.pct }}% · 已看 {{ c.done }}/{{ c.total }}</div>',
      '      </div>',
      '    </div>',

      /* ---------- 学习：看题 ---------- */
      '    <div v-else-if="page === \'study\'" class="ex-page">',
      '      <div class="ex-subhead">',
      '        <div class="ex-filters">',
      '          <span class="ex-chip" :class="{ \'is-on\': study.type === \'all\' }" @click="setStudyType(\'all\')">全部</span>',
      '          <span v-for="t in [\'单选题\',\'多选题\',\'判断题\',\'计算题\']" :key="t" class="ex-chip" :class="{ \'is-on\': study.type === t }" @click="setStudyType(t)">{{ t }}</span>',
      '        </div>',
      '        <div class="ex-progtext">{{ studyDone() }}/{{ study.list.length }}</div>',
      '      </div>',
      '      <div v-if="study.list.length === 0" class="ex-empty">该筛选下暂无题目</div>',
      '      <template v-else>',
      '        <exam-question :q="studyQ()" mode="study" :index-label="\'第 \' + (study.idx + 1) + \' / \' + study.list.length + \' 题\'"></exam-question>',
      '        <div class="ex-nav">',
      '          <button class="ex-btn" :disabled="study.idx === 0" @click="studyNav(-1)">← 上一题</button>',
      '          <button class="ex-btn" :disabled="study.idx === study.list.length - 1" @click="studyNav(1)">下一题 →</button>',
      '        </div>',
'        <div class="ex-jump">',
'          <span>跳至</span>',
'          <input class="ex-jumpinput" type="number" min="1" :max="study.list.length" placeholder="题号"',
'                 v-model="study.jumpInput" @keyup.enter="studyJump(study.jumpInput)">',
'          <button class="ex-btn ex-btn--sm" @click="studyJump(study.jumpInput)">跳转</button>',
'          <span>/ {{ study.list.length }}</span>',
'        </div>',
      '      </template>',
      '    </div>',

      /* ---------- 模考：组卷 ---------- */
      '    <div v-else-if="page === \'exam-config\'" class="ex-page">',
      '      <div class="ex-field"><label>章节范围</label>',
      '        <div class="ex-chips">',
      '          <span class="ex-chip" :class="{ \'is-on\': chipActive(\'ch\', \'all\') }" @click="toggleChip(\'ch\', \'all\')">全部</span>',
      '          <span v-for="ch in chapters" :key="ch" class="ex-chip" :class="{ \'is-on\': chipActive(\'ch\', ch) }" @click="toggleChip(\'ch\', ch)">{{ shortNames[ch] || ch }}</span>',
      '        </div>',
      '      </div>',
      '      <div class="ex-field"><label>题型</label>',
      '        <div class="ex-chips">',
      '          <span class="ex-chip" :class="{ \'is-on\': chipActive(\'tp\', \'all\') }" @click="toggleChip(\'tp\', \'all\')">全部</span>',
      '          <span v-for="t in [\'单选题\',\'多选题\',\'判断题\',\'计算题\']" :key="t" class="ex-chip" :class="{ \'is-on\': chipActive(\'tp\', t) }" @click="toggleChip(\'tp\', t)">{{ t }}</span>',
      '        </div>',
      '      </div>',
      '      <div class="ex-field ex-field--row">',
      '        <div><label>题数</label><input class="ex-num" type="number" min="5" max="200" v-model.number="cfg.count"></div>',
      '        <div><label>时长（分钟）</label><input class="ex-num" type="number" min="5" max="300" v-model.number="cfg.time"></div>',
      '      </div>',
      '      <p class="ex-poolinfo">可用题目：<b>{{ examPool.length }}</b> 道<span v-if="examPool.length < cfg.count">（不足设定题数，将按 {{ examPool.length }} 道组卷）</span></p>',
      '      <button class="ex-btn ex-btn--primary ex-btn--block" :disabled="!examPool.length" @click="startExam">开始考试</button>',
      '    </div>',

      /* ---------- 模考：答题 ---------- */
      '    <div v-else-if="page === \'exam\'" class="ex-page">',
      '      <div class="ex-exambar">',
      '        <span class="ex-timer" :class="{ \'is-danger\': examDanger }">⏱ {{ examRemainText }}</span>',
      '        <span class="ex-progtext">已答 {{ examAnswered }}/{{ exam.list.length }}</span>',
      '      </div>',
      '      <exam-question :q="examQ" mode="exam" :selected="exam.answers[examQ._id] || \'\'"',
      '                     :index-label="\'第 \' + (exam.idx + 1) + \' / \' + exam.list.length + \' 题\'"',
      '                     @select="answer"></exam-question>',
      '      <div class="ex-nav">',
      '        <button class="ex-btn" :disabled="exam.idx === 0" @click="examNav(-1)">← 上一题</button>',
      '        <button v-if="exam.idx < exam.list.length - 1" class="ex-btn" @click="examNav(1)">下一题 →</button>',
      '        <button v-else class="ex-btn ex-btn--primary" @click="confirmSubmit">交卷</button>',
      '      </div>',
      '      <button class="ex-btn ex-btn--block" @click="confirmSubmit">交卷并查看成绩</button>',
      '      <div v-if="sheetOpen" class="ex-sheet">',
      '        <div v-for="(qid, i) in exam.list" :key="i" class="ex-sheet-cell"',
      '             :class="{ \'is-cur\': i === exam.idx, \'is-done\': !!exam.answers[qid] }"',
      '             @click="examJump(i)">{{ i + 1 }}</div>',
      '      </div>',
      '    </div>',

      /* ---------- 模考：成绩 ---------- */
      '    <div v-else-if="page === \'exam-result\'" class="ex-page ex-result">',
      '      <div class="ex-score"><b>{{ result.correct }}</b><span>/{{ result.total }}</span></div>',
      '      <p class="ex-scorelabel">正确率 {{ result.pct }}% · 用时 {{ fmtTime(result.seconds) }}<span v-if="result.auto"> · 时间到自动交卷</span></p>',
      '      <div class="ex-scoregrid">',
      '        <div class="ex-scorecell is-right"><b>{{ result.correct }}</b><span>正确</span></div>',
      '        <div class="ex-scorecell is-wrong"><b>{{ result.wrong }}</b><span>错误</span></div>',
      '        <div class="ex-scorecell is-skip"><b>{{ result.unanswered }}</b><span>未答</span></div>',
      '      </div>',
      '      <button class="ex-btn ex-btn--primary ex-btn--block" @click="reviewExam(false)">查看全部复盘</button>',
      '      <button class="ex-btn ex-btn--block" @click="reviewExam(true)">只看未答对（{{ result.wrong + result.unanswered }}）</button>',
      '      <button class="ex-btn ex-btn--block" @click="go(\'exam-config\')">再考一次</button>',
      '      <button class="ex-btn ex-btn--block" @click="go(\'home\')">返回首页</button>',
      '    </div>',

      /* ---------- 模考：复盘 ---------- */
      '    <div v-else-if="page === \'exam-review\'" class="ex-page">',
      '      <div v-if="!review.list.length" class="ex-empty">暂无题目</div>',
      '      <template v-else>',
      '        <exam-question :q="reviewQ" mode="review" judged',
      '                       :selected="exam.answers[reviewQ._id] || \'\'" locked',
      '                       :index-label="\'第 \' + (review.idx + 1) + \' / \' + review.list.length + \' 题\'"></exam-question>',
      '        <div class="ex-nav">',
      '          <button class="ex-btn" :disabled="review.idx === 0" @click="reviewNav(-1)">← 上一题</button>',
      '          <button class="ex-btn" :disabled="review.idx === review.list.length - 1" @click="reviewNav(1)">下一题 →</button>',
      '        </div>',
      '        <button class="ex-btn ex-btn--block" @click="go(\'exam-result\')">返回成绩单</button>',
      '      </template>',
      '    </div>',

      /* ---------- 错题本 ---------- */
      '    <div v-else-if="page === \'wrong\'" class="ex-page">',
      '      <div class="ex-wrongbar">',
      '        <span class="ex-chip" :class="{ \'is-on\': wrongPractice.chapter === \'all\' }" @click="startWrongPractice(\'all\')">全部练习（{{ wrongCount }}）</span>',
      '        <button class="ex-btn ex-btn--danger" @click="clearWrong">清空错题本</button>',
      '      </div>',
      '      <div v-if="!wrongCount" class="ex-empty"><div class="ex-empty-icon">🏆</div><p>暂无错题，继续保持！</p></div>',
      '      <template v-else>',
      '        <div v-for="id in wrongList.slice(0, 20)" :key="id" class="ex-wrongcard" @click="startWrongPractice(\'all\', id)">',
      '          <div class="ex-wrongmeta">',
      '            <span>{{ shortNames[questions[id].ch] || questions[id].ch }}</span>',
      '            <span class="ex-tag" :class="\'ex-tag--\' + questions[id].type">{{ questions[id].type }}</span>',
      '          </div>',
      '          <p class="ex-wrongtext">{{ questions[id].q }}</p>',
      '          <p class="ex-wrongans">正确答案：<b>{{ questions[id].ans }}</b></p>',
      '        </div>',
      '        <p v-if="wrongCount > 20" class="ex-more">还有 {{ wrongCount - 20 }} 道错题…（开始练习查看全部）</p>',
      '      </template>',
      '    </div>',

      /* ---------- 错题重做 ---------- */
      '    <div v-else-if="page === \'wrong-practice\'" class="ex-page">',
      '      <div v-if="!wrongQ" class="ex-empty">暂无错题</div>',
      '      <template v-else>',
      '        <exam-question :q="wrongQ" mode="wrong"',
      '                       :selected="wrongPractice.answers[wrongQ._id] || wrongPickedOf(wrongQ._id)"',
      '                       :judged="!!(wrongPractice.answers[wrongQ._id] || (wrongWrong || {})[wrongQ._id])"',
      '                       :locked="!!wrongPractice.answers[wrongQ._id]"',
      '                       :index-label="\'第 \' + (wrongPractice.idx + 1) + \' / \' + wrongPractice.list.length + \' 题\'"',
      '                       @select="answerWrong"></exam-question>',
      '        <div class="ex-nav">',
      '          <button class="ex-btn" :disabled="wrongPractice.idx === 0" @click="wrongNav(-1)">← 上一题</button>',
      '          <button class="ex-btn" :disabled="wrongPractice.idx === wrongPractice.list.length - 1" @click="wrongNav(1)">下一题 →</button>',
      '        </div>',
'        <button class="ex-btn ex-btn--block" @click="go(\'wrong\')">返回错题本</button>',
'        <div class="ex-jump" v-if="wrongPractice.list.length > 1">',
'          <span>跳至</span>',
'          <input class="ex-jumpinput" type="number" min="1" :max="wrongPractice.list.length" placeholder="题号"',
'                 v-model="wrongPractice.jumpInput" @keyup.enter="wrongJump(wrongPractice.jumpInput)">',
'          <button class="ex-btn ex-btn--sm" @click="wrongJump(wrongPractice.jumpInput)">跳转</button>',
'          <span>/ {{ wrongPractice.list.length }}</span>',
'        </div>',
'      </template>',
      '    </div>',

      /* ---------- 统计 ---------- */
      '    <div v-else-if="page === \'stats\'" class="ex-page">',
      '      <div v-if="page === \'stats\'" class="ex-statsover">',
      '        <div class="ex-statcard"><b>{{ statsData.total }}</b><span>总题数</span></div>',
      '        <div class="ex-statcard"><b>{{ statsData.done }}</b><span>已做</span></div>',
      '        <div class="ex-statcard"><b>{{ statsData.pct }}%</b><span>正确率</span></div>',
      '        <div class="ex-statcard"><b>{{ statsData.wrong }}</b><span>错题</span></div>',
      '        <div class="ex-statcard"><b>{{ statsData.exams }}</b><span>模考次数</span></div>',
      '      </div>',
      '      <h3 class="ex-h3">各章节统计</h3>',
      '      <table class="ex-table">',
      '        <thead><tr><th>章节</th><th>总题</th><th>已做</th><th>正确</th><th>正确率</th></tr></thead>',
      '        <tbody>',
      '          <tr v-for="r in statsData.byCh" :key="r.key">',
      '            <td>{{ r.name }}</td><td>{{ r.total }}</td><td>{{ r.done }}</td><td>{{ r.right }}</td>',
      '            <td><span class="ex-accbar"><span :style="{ width: r.pct + \'%\', background: r.pct >= 60 ? \'#4A7C59\' : \'#C0563E\' }"></span></span>{{ r.pct }}%</td>',
      '          </tr>',
      '        </tbody>',
      '      </table>',
      '      <h3 class="ex-h3">各题型统计</h3>',
      '      <table class="ex-table">',
      '        <thead><tr><th>题型</th><th>总题</th><th>已做</th><th>正确</th><th>正确率</th></tr></thead>',
      '        <tbody>',
      '          <tr v-for="r in statsData.byType" :key="r.key">',
      '            <td>{{ r.name }}</td><td>{{ r.total }}</td><td>{{ r.done }}</td><td>{{ r.right }}</td>',
      '            <td><span class="ex-accbar"><span :style="{ width: r.pct + \'%\', background: r.pct >= 60 ? \'#4A7C59\' : \'#C0563E\' }"></span></span>{{ r.pct }}%</td>',
      '          </tr>',
      '        </tbody>',
      '      </table>',
      '      <template v-if="statsData.history.length">',
      '        <h3 class="ex-h3">模考记录</h3>',
      '        <table class="ex-table">',
      '          <thead><tr><th>日期</th><th>题数</th><th>正确</th><th>正确率</th><th>用时</th></tr></thead>',
      '          <tbody>',
      '            <tr v-for="(h, i) in statsData.history" :key="i">',
      '              <td>{{ fmtDate(h.date) }}</td><td>{{ h.total }}</td><td>{{ h.correct }}</td>',
      '              <td>{{ Math.round(h.correct / h.total * 100) }}%</td><td>{{ fmtTime(h.seconds) }}</td>',
      '            </tr>',
      '          </tbody>',
      '        </table>',
      '      </template>',
      '    </div>',

      '  </div>',

      /* ---------- 确认弹窗 ---------- */
      '  <div v-if="dialog" class="ex-mask" @click.self="dialog = null">',
      '    <div class="ex-dialog">',
      '      <p>{{ dialog.msg }}</p>',
      '      <div class="ex-dialogbtns">',
      '        <button class="ex-btn" @click="dialog = null">取消</button>',
      '        <button class="ex-btn ex-btn--primary" @click="dialog.onOk()">确定</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('')
  };

  /* =============================================================
   * 独立 bootstrap：本文件不再依赖 CardFlow 的 app 实例，
   * 自行创建 Vue 应用挂载到 #exam-app（见 exam.html）。
   * CardFlow 与备考题库是完全两套互不相干的页面/应用。
   *
   * ⚠️ 根因修正（线上空白 bug）：不能写成
   *   Vue.createApp({ components: {...} }).mount('#exam-app')
   * 那样根组件没有 template，而 #exam-app 又是空 div，Vue 会渲染出
   * 空页面（exam-view 虽注册却从未被引用）。正确做法：根组件直接用
   * ExamView 本身——它的 template 含完整页面，且自带 exam-question
   * 子组件注册（components: { ExamQuestion }），因此 <exam-question>
   * 在模板里能正常解析。
   * ============================================================= */
  if (window.Vue) {
    Vue.createApp(ExamView).mount('#exam-app');
  }
})();
