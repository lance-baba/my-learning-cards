# CardFlow 部署到 Cloudflare 指南

> 架构：Cloudflare **Workers + KV**。Worker（`worker/index.js`）的 `/api/index`、`/api/bundle` 数据 100% 来自 KV，静态资源来自 `public/`。
> **KV 是必须的**，但日常操作已简化成"一键灌值"：建一次命名空间，之后改数据只跑 `npm run sync`（名称←值，重跑即替换，无需重新部署）。

## 前置条件
- 已注册 Cloudflare 账号（免费版即可）
- 本机 Node.js，且已 `npm install`（安装 wrangler）

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
脚本自动把 `data/` 下所有 JSON 按正确键名写入 KV：

| KV 键名（名称） | 值来源 |
|---------|----------|
| `app:index` | `data/app_index.json` |
| `bundle:agriculture:v1` | `data/bundle_agri.json` |
| `bundle:science:v1` | `data/bundle_science.json` |
| `bundle:health:v1` | `data/bundle_health.json` |
| `bundle:history:v1` | `data/bundle_history.json` |
| `bundle:geography:v1` | `data/bundle_geography.json` |
| `bundle:entertainment:v1` | `data/bundle_fun.json` |

### 4. 部署 Worker
```bash
npm run deploy
```
获得 `https://cardflow.<子域>.workers.dev`。

### 5.（可选）绑定自定义域名，解决国内访问
`*.workers.dev` 在部分国内网络不稳定。在 Cloudflare 控制台给该 Worker 加 **Custom Domain** 即可（代码无需改动）。你其他项目已用 `qihang.ccwu.cc` / `qhhd.ccwu.cc` 这类自定义域。

## 以后改数据 / 扩量（最常做）
只改 `data/*.json`，然后**一条命令**：
```bash
npm run sync          # 把所有值重新灌进 KV，已存在的键被替换
```
KV 是独立存储，改值**不需要重新 `wrangler deploy`**。前端若改了 `app_index.json` 的 `version` 字段，会自动弹"发现新库"（纯前端版本感知）。

> 想先预览会写哪些键，不实际写入：`node tools/sync_kv.js --dry`

## 本地预览（无需账号）
```bash
node local-server.js    # 打开 http://localhost:8788
```

## 常见坑
- `setup-kv` 报创建失败 → 多半是没 `wrangler login`，先去登录。
- `sync` 报找不到命名空间 → `wrangler.toml` 的 id 还是占位符，重跑 `npm run setup-kv`。
- `wrangler.toml` 用 `assets = { directory = "./public", binding = "ASSETS" }`，对应 `worker/index.js` 的 `env.ASSETS.fetch`。
- `streaming_text` 子卡字段必须是 `streaming_content`（已在 `card_tool.js` 校验强制）。
