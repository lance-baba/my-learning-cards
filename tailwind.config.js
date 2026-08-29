/**
 * Tailwind 按需构建配置（工程评审 P0 第 2 项）
 *
 * 背景：此前 index.html 直接引入预编译全量 tailwind.min.css（2.80MB）作为
 *       首屏阻塞 CSS，其中 99% 的类本项目根本没用到。改为 JIT 按需生成后
 *       体积降至 ~30KB（-98%）。
 *
 * 扫描范围：
 *   - public/index.html（HTML 模板）
 *   - public/app.js（所有 Vue 组件的 template 字符串都在这里）
 *
 * 重要约束：app.js 中的动态类名**必须保持字符串字面量**形式
 *   （如 isMastered ? 'text-emerald-400 font-semibold' : 'text-slate-400'），
 *   这样才能被静态扫描命中。禁止改写成拼接形式（'text-' + color），
 *   否则对应类会被 purge 掉导致样式丢失。
 *
 * 调色板补齐（关键）：
 *   tailwindcss@2.2.19 的默认主题只有 8 个颜色族
 *   （gray/red/yellow/green/blue/indigo/purple/pink），
 *   **不含 slate / emerald / amber，也没有 950 色阶**。
 *   而本项目大量使用 text-slate-400 / bg-emerald-500 / text-amber-400 /
 *   text-slate-950 —— 这些类在原全量 tailwind.min.css 里同样不存在，
 *   一直是"死类"，从未产生任何 CSS 规则。
 *   这里把 v3 官方调色板合并进主题，使它们按设计意图生效。
 *   详见 tools/tailwind-palette.js 头部注释。
 *
 * 回滚：原全量文件备份在 public/vendor/tailwind.full.backup.css
 */
const palette = require('./tools/tailwind-palette');

module.exports = {
  mode: 'jit',
  purge: {
    content: ['./public/index.html', './public/app.js', './public/style.css'],
    options: {
      // 当前无动态拼接类名，留空；如将来引入拼接写法，在此登记兜底
      safelist: [],
    },
  },
  darkMode: false, // 项目为深色单主题
  theme: {
    extend: {
      colors: palette,
    },
  },
  variants: {
    extend: {},
  },
  plugins: [],
};
