#!/usr/bin/env node
/**
 * Tailwind 类名覆盖率审计（purge 回归守卫）
 *
 * 用途：
 *   按需构建靠静态扫描收集类名。一旦有人把类名改写成拼接形式
 *   （如 'text-' + color），或新增了 purge 未覆盖的模板文件，
 *   对应样式会被静默丢弃 —— 页面不会报错，只是「某个颜色/间距不见了」，
 *   极难排查。本脚本把源码里用到的类名与构建产物逐一比对，缺失就非零退出。
 *
 * 用法：
 *   npm run audit:css
 *   （建议接到 CI，或在每次 build:css 后手动跑一次）
 *
 * 退出码：0 = 无缺失；1 = 存在既不在产物 CSS、也不在 style.css 里的类名。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['public/index.html', 'public/app.js', 'public/style.css'];
const CSS_OUT = 'public/vendor/tailwind.min.css';
const STYLE_CSS = 'public/style.css';

// 非类名噪声：模板里的 JS 变量、运算符、属性名等会被宽松正则误捕
const NOISE = new Set([
  '%', '===', '?', '[', '{', '(sub.layout', 'c', 'i', 'in', 'item', 'sub', 'cats',
  'choices', 'filtered', 'fillMode', 'glowClass', 'heroClass', 'shellClass',
  'isBookmarked', 'isMastered', 'isSpeaking', 'topic.sub_cards',
  // 第三方库的原生类名，由各自 CSS 提供
  'swiper', 'swiper-slide', 'swiper-wrapper', 'vertical-swiper',
]);

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const src = SOURCES.map(read).join('\n');
// CSS 产物里的类名是转义过的（.ml-0\.5），先抹掉反斜杠再比对
const css = read(CSS_OUT).replace(/\\/g, '');
const styleCss = read(STYLE_CSS).replace(/\\/g, '');

const has = (cls, text) =>
  new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])').test(text);

// ---- 1. 收集源码中出现的类名 token ----
const tokens = new Set();
let m;
const attrRe = /(?:class|className)\s*[:=]\s*["'`]([^"'`]*)["'`]/g;
while ((m = attrRe.exec(src))) m[1].split(/\s+/).forEach((t) => t && tokens.add(t));

// 兜底：捕获三元/条件表达式里的裸字符串，如 isMastered ? 'text-emerald-400' : 'text-slate-400'
[/'([a-z][a-z0-9-]*(?:\s+[a-z0-9:/[\].\-_%#(),]+)+)'/g,
 /"([a-z][a-z0-9-]*(?:\s+[a-z0-9:/[\].\-_%#(),]+)+)"/g].forEach((rx) => {
  while ((m = rx.exec(src))) {
    m[1].split(/\s+/).forEach((t) => {
      if (/^[a-z]/.test(t) && t.length < 40) tokens.add(t);
    });
  }
});

const isClassLike = (t) => /^[a-z]+(-[a-z0-9./[\]%#(),]+)*$/.test(t) && !NOISE.has(t);
const arr = [...tokens].filter(isClassLike).sort();

// ---- 2. 比对 ----
const inCss = [], onlyStyle = [], missing = [];
for (const t of arr) {
  if (has(t, css)) inCss.push(t);
  else if (has(t, styleCss)) onlyStyle.push(t);
  else missing.push(t);
}

const cssBytes = fs.statSync(path.join(ROOT, CSS_OUT)).size;
console.log('产物: ' + CSS_OUT + ' (' + cssBytes + ' 字节)');
console.log('扫描: ' + SOURCES.join(', '));
console.log('类名: 共 ' + arr.length + ' | 命中产物 ' + inCss.length +
  ' | style.css 提供 ' + onlyStyle.length + ' | 缺失 ' + missing.length);

if (missing.length) {
  console.log('\n[FAIL] 以下类在产物 CSS 和 style.css 中都不存在：');
  missing.forEach((t) => console.log('   - ' + t));
  console.log('\n常见原因：');
  console.log('   1) 动态拼接类名（\'text-\' + color）静态扫描不到 —— 改回字面量，');
  console.log('      或登记到 tailwind.config.js 的 purge.options.safelist；');
  console.log('   2) 颜色族不在 v2.2.19 默认主题里（slate/emerald/amber 等）');
  console.log('      —— 已在 tools/tailwind-palette.js 补齐，确认配置引用了它；');
  console.log('   3) 新增了模板文件但没有加进 purge.content —— 更新 tailwind.config.js。');
  process.exit(1);
}

console.log('\n[OK] 无缺失类名。');
