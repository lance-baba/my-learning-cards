/**
 * CardFlow ESLint 配置（工程评审 P1 第 3 项：ESLint + Prettier）
 *
 * 为什么用 flat config（eslint.config.mjs）：
 *   - 根 package.json 是 CommonJS（tools/ 与 local-server.js 仍是 CJS），不能加 type:module；
 *     用 .mjs 后缀让本配置无条件按 ESM 加载，避免与根 package.json 冲突。
 *   - worker/ 是 ESM（worker/package.json 声明 type:module），tools/*.mjs 是 ESM，
 *     local-server.js 是 CJS，public/*.js 是浏览器全局脚本（无模块系统）。
 *     一个项目三种模块形态，用 files 维度分别配置 globals / sourceType。
 *
 * 分层：eslint:recommended（抓真实 bug：未定义变量 / 未用变量 / 空块等）
 *       + eslint-config-prettier（关闭所有格式化规则，格式化交给 Prettier，避免两套规则打架）。
 *
 * ⚠️ 安装：本环境（AI 沙箱）禁 npm install，请在你的本机执行：
 *     npm install -D eslint@9 prettier eslint-config-prettier globals @eslint/js
 *   然后 npm run lint。首次运行可能报若干历史问题，属正常（评审时即指出"无 lint"），按需修复或迭代。
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
    ],
  },

  // 浏览器端脚本（app.js / monitor.js / cardflow-logic.js / sw-register.js）：Vue 全局构建，无 import/export
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        Vue: 'readonly',
        Swiper: 'readonly',
      },
    },
  },

  // Cloudflare Worker（ESM，但运行时不是 Node：无 process / Buffer，有 Request/Response/caches 等）
  {
    files: ['worker/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: {
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        caches: 'readonly',
        Cache: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        structuredClone: 'readonly',
        self: 'readonly',
      },
    },
  },

  // 工具脚本（Node ESM，.mjs）
  {
    files: ['tools/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },

  // 本地预览服务（Node CJS）
  {
    files: ['local-server.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },

  // 配置文件（Node CJS）
  {
    files: ['*.config.js', '*.config.cjs', 'tailwind.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },
];
