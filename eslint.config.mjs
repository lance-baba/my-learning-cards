/**
 * CardFlow ESLint 配置（工程评审 P1 第 3 项：ESLint + Prettier）
 *
 * 为什么用 flat config（eslint.config.mjs）：
 *   - 根 package.json 是 CommonJS（tools/ 与 local-server.js 仍是 CJS），不能加 type:module；
 *     用 .mjs 后缀让本配置无条件按 ESM 加载，避免与根 package.json 冲突。
 *   - 一个项目三种模块形态：worker/ 是 ESM（worker/package.json 声明 type:module），
 *     tools/*.mjs 是 ESM，public/*.js 是浏览器全局脚本（无模块系统，但 cardflow-logic.js /
 *     sw_cache.js 用 UMD 的 module.exports），local-server.js / tools/*.js 是 Node CJS。
 *     用 files 维度分别配置 globals / sourceType。
 *
 * 分层：eslint:recommended（抓真实 bug：未定义变量 / 重复 key / 空块等）
 *       + eslint-config-prettier（关闭所有格式化规则，格式化交给 Prettier，避免两套规则打架）。
 *
 * ⚠️ 安装：本环境（AI 沙箱）禁 npm install，请在你的本机执行：
 *     npm install -D eslint@9 prettier eslint-config-prettier globals @eslint/js
 *   然后 npm run lint。
 *
 * ⚠️ 首轮落地策略（评审时即指出"无 lint"，历史噪音先不阻断 CI）：
 *   - 故意留空的 catch(e){}（localStorage 等 best-effort 写入）允许（no-empty allowEmptyCatch）。
 *   - 未使用变量（no-unused-vars）先降为 warning，真实 bug 类规则（no-undef 等）仍按 error 生效。
 *   后续可逐步收紧。
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  prettier,
  {
    ignores: [
      'node_modules/**',
      'public/vendor/**', // 第三方库不打分
      'data/**', // 题库 JSON 不 lint
      '.wrangler/**',
      'dist/**',
      'tools/tmp/**', // DOM 探针，非生产代码（用 browser 全局，不在 Node 下 lint）
    ],
  },

  // 兜底：.js / .cjs 按 Node CommonJS；.mjs 按 ESM（含本配置文件自身，否则被 commonjs 解析 import/export 报错）。
  // 避免任何文件"无配置"报错（ESLint 9 对匹配不到配置的文件直接 error）。
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // 浏览器端脚本（含 Service Worker 运行时 + UMD 模块全局）
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        module: 'writable', // UMD：cardflow-logic.js / sw_cache.js 的 module.exports
        Vue: 'readonly',
        Swiper: 'readonly',
        caches: 'readonly', // Service Worker
        clients: 'readonly',
        skipWaiting: 'readonly',
        importScripts: 'readonly',
      },
    },
  },

  // Cloudflare Worker（ESM，运行时非 Node：用 Worker 全局集，覆盖 Request/Response/caches/self 等）
  {
    files: ['worker/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.worker },
    },
  },

  // 首轮落地：空 catch 允许 + 未用变量降 warning（见文件头注释）
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'warn',
    },
  },
];
