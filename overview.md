# CardFlow（卡片智刷）— Option A 大卡流式布局落地

## 已实现的 UI/UX（两轮累计）
### 第一轮：基础体验升级
- 卡片 `h-[80vh]` 大卡，上下留白收紧。
- 字号阶梯：标题 `card-title` ≈21-22px/700、副标题 ≈18px/600、正文 `card-body` ≈17px/行高1.75。
- 背景 `.ambient` 氛围光晕，随卡片类型切换（知识绿蓝 / 放松橙）。
- 分页点内嵌卡下、翡翠绿 `#10B981` 高亮。
- 放松卡 `glass-card-fun` 暖色发光边框 + 微信气泡对话 + 点击揭晓笑点。
- 头图占位区 140px（按分类动态图标/渐变）。

### 第二轮：Option A 富交互 footer
- **顶部**：分类徽章（圆角胶囊）+ 阅读时长（约20秒 / 一笑解压）。
- **底部富交互 footer**：左侧来源角标（点击开半屏抽屉），右侧快捷图标：
  - 🔖/📑 收藏：状态持久化到 `localStorage['bookmarked_cards']`，刷新后保留。
  - 🔊 朗读：调用 Web Speech API（`zh-CN`）朗读卡片正文；再次点击停止；翻牌背面同样支持。
- 页脚文字统一 `card-footer-text` 14px；`.action-btn` 点击缩放反馈。

## 验证
- `node --check public/app.js` 通过
- 本地服务 `http://localhost:8788` 下 `/`、`/style.css`、`/app.js` 均 200（静态实时读取）

## 预览
内置浏览器已打开 `http://localhost:8788`。

## 部署
Cloudflare 真部署见 `deploy_guide.md`（需你本人 `wrangler login` + 建 KV + 灌库 + deploy）。前端为纯静态 + KV，无需改后端。
