# CardFlow 部署到 Cloudflare 指南

> 架构：Cloudflare **Workers + KV**。Worker（`worker/index.js`）的 `/api/index`、`/api/bundle` 数据 100% 来自 KV，静态资源来自 `public/`。
> **KV 是必须的**，但日常操作已简化成"一键灌值"：建一次命名空间，之后改数据只跑 `npm run sync`（名称←值，重跑即替换，无需重新部署）。

## 前置条件
- 已注册 Cloudflare 账号（免费版即可）
- 本机 Node.js 18+，且已 `npm install`（安装 wrangler / tailwindcss）

## 首次部署（只需做一次）

### 1. 安装依赖 + 登录
```bash
npm install
npx wrangler login        # 弹浏览器授权，仅此一次
```

### 2. 一键建 KV 命名空间并填好配置
```bash
npm run setup-kv
```
脚本自动执行 `wrangler kv:namespace create CARD_KV`，并把拿到的 id 写回 `wrangler.toml`（替换占位符 `YOUR_KV_NAMESPACE_ID`）。以后不用再管创建和 id。

### 3. 一键灌入全部数据（名称 + 值）
```bash
npm run sync
```

脚本自动把 `data/` 下所有 JSON 按正确键名写入 KV。当前实际键名如下（**由 `data/` 目录生成，勿凭记忆修改**）：

| KV 键名（名称） | 值来源 |
|---------|----------|
| `app:index` | `data/app_index.json` |
| `bundle:animals:v1` | `data/bundle_animals.json` |
| `bundle:experiments:v1` | `data/bundle_experiments.json` |
| `bundle:food:v1` | `data/bundle_food.json` |
| `bundle:geography:v1` | `data/bundle_geography.json` |
| `bundle:home:v1` | `data/bundle_home.json` |
| `bundle:lifehacks:v1` | `data/bundle_lifehacks.json` |
| `bundle:movies:v1` | `data/bundle_movies.json` |
| `bundle:plants:v1` | `data/bundle_plants.json` |
| `bundle:science:v1` | `data/bundle_science.json` |
| `bundle:tech:v1` | `data/bundle_tech.json` |
| `bundle:travel:v1` | `data/bundle_travel.json` |
| `bundle:entertainment:v1` | `data/bundle_fun.json` ← **键名与文件名不一致，历史遗留，勿"顺手修正"** |

> ⚠️ 上一版文档这里列的是 `agriculture / health / history` 等**早已不存在的分类**，会误导操作。
> 新增 bundle 后请回到本表补一行；或直接跑 `node tools/sync_kv.js --dry` 看脚本实际要写哪些键。

### 4. 部署 Worker
```bash
npm run deploy
```
获得 `https://cardflow.<子域>.workers.dev`。

### 5.（可选）绑定自定义域名，解决国内访问
`*.workers.dev` 在部分国内网络不稳定。在 Cloudflare 控制台给该 Worker 加 **Custom Domain** 即可（代码无需改动）。你其他项目已用 `qihang.ccwu.cc` / `qhhd.ccwu.cc` 这类自定义域。

### 6.（推荐）配置 Secrets
```bash
# CORS 白名单：不配 = 不向任何跨源站点授予跨域头（最严格）。
# 需要允许其他域名调用 /api/* 时才配，多个用逗号分隔。
npx wrangler secret put ALLOWED_ORIGINS   # 例：https://fwzy.ccwu.cc

# 错误上报：配了之后前端 + Worker 的未捕获异常自动进 Sentry。
# 不配也不影响功能（只写结构化日志），可随时补。
npx wrangler secret put SENTRY_DSN        # 例：https://xxxx@o4507.ingest.sentry.io/6789
npx wrangler secret put APP_VERSION       # 可选，在 Sentry 里标记 release
```

### 7. 部署后自检
```bash
curl https://<你的域名>/api/health
# 期望：{"ok":true,"ts":"...","version":null,"env":"production"}
```
再打开页面，确认卡片能刷、控制台无报错。

## 以后改数据 / 扩量（最常做）
只改 `data/*.json`，然后**一条命令**：
```bash
npm run sync          # 把所有值重新灌进 KV，已存在的键被替换
```
KV 是独立存储，改值**不需要重新 `wrangler deploy`**。前端若改了 `app_index.json` 的 `version` 字段，会自动弹"发现新库"（纯前端版本感知）。

> 想先预览会写哪些键，不实际写入：`node tools/sync_kv.js --dry`

## ⚠️ 改了样式或模板类名，必须重新构建 CSS
`public/vendor/tailwind.min.css` 是 **Tailwind JIT 按需生成**的产物（约 10KB），
**不是**手改的文件。只要改了 `public/index.html` / `public/app.js` 里的**类名**，
就必须重新构建，否则新类名不会出现在 CSS 里（不报错，只是样式静默失效）：

```bash
npm run build:css     # 重新扫描模板并生成
npm run audit:css     # 校验：源码用到的类名是否都存在于产物中，缺失即报错
```

两个已知的坑（踩过，勿重蹈）：
1. **禁止动态拼接类名**，如 `'text-' + color`。静态扫描扫不到，会被 purge 丢弃。
   要写完整字面量：`isMastered ? 'text-emerald-400' : 'text-slate-400'`。
2. **构建用的 tailwindcss@2.2.19 默认主题只有 8 个颜色族**（gray/red/yellow/green/blue/
   indigo/purple/pink），**没有 slate / emerald / amber，也没有 950 色阶**。
   本项目通过 `tools/tailwind-palette.js`（取自 v3 官方调色板）补齐并注入主题，
   所以这些类可用；但**不要**再引入 palette 里没有的色族，否则同样是静默失效。

## 可观测性
- **结构化日志**：Worker 所有 `/api/*` 请求都会输出单行 JSON（含 `rid` 请求 ID、路径、
  状态码、耗时 ms）。用 `npx wrangler tail` 实时查看，或接 Logpush。
- **前端错误上报**：`public/monitor.js` 捕获 `onerror` / `unhandledrejection` /
  资源加载失败，POST 到 `/api/log`。做了去重（同类错误最多 3 条）与会话上限（10 条），
  只上报 message / stack / url，**不采集任何用户信息**，保留"零数据收集"的合规优势。
- **Sentry**：配了 `SENTRY_DSN` 后，服务端自动把前端与 Worker 的异常转发到 Sentry。
  未配置时只落日志，**不会有任何外发请求**。
- 用户报障时让他提供页面响应头里的 `X-Request-Id`，可与服务端日志精确对上。

## 本地预览（无需账号）
```bash
npm run preview       # 等价于 node local-server.js，打开 http://localhost:8788
```
`local-server.js` 是**独立的模拟层**（零依赖，不复用 `worker/index.js`），
接口行为与 Worker 对齐。改了 Worker 路由时，**两边都要同步改**，否则会出现
"本地测过、线上行为不一致"。

## 命令速查
| 命令 | 作用 |
|------|------|
| `npm run preview` | 本地预览（无需 CF 账号） |
| `npm run validate` | 校验 `data/*.json` 数据契约（已接入 pre-commit） |
| `npm test` | 运行单元测试（当前覆盖 `worker/observe.js`） |
| `npm run build:css` | 重新生成按需 Tailwind CSS |
| `npm run audit:css` | 校验类名是否被 purge 漏掉 |
| `npm run sync` | 把 `data/` 灌入 KV |
| `npm run deploy` | 部署 Worker |

## 常见坑
- `setup-kv` 报创建失败 → 多半是没 `wrangler login`，先去登录。
- `sync` 报找不到命名空间 → `wrangler.toml` 的 id 还是占位符，重跑 `npm run setup-kv`。
- `wrangler.toml` 用 `assets = { directory = "./public", binding = "ASSETS" }`，对应 `worker/index.js` 的 `env.ASSETS.fetch`。
- `streaming_text` 子卡字段必须是 `streaming_content`（已在 `card_tool.js` 校验强制）。
- **改了前端却看到旧页面** → Service Worker 在缓存。应用壳是 network-first，刷新 1~2 次即可；
  但 `public/vendor/*` 是 **cache-first**，改了 vendor 下任何文件都必须 bump
  `public/sw.js` 里的 `CACHE` 常量（当前 `cardflow-v4`）才能让老用户拿到新文件。
- **提交被 pre-commit 拦下** → 说明 `data/*.json` 校验没过，按报错修数据。
  确需紧急跳过：`git commit --no-verify`（随后记得补修）。
