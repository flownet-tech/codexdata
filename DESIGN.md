# CodexData UI

共同设计规范与修改步骤：[codex-pass-ui/DESIGN.md](https://github.com/flownet-tech/codex-pass-ui/blob/main/DESIGN.md)。

Data 保持静态 HTML。内容在 `public/index.html`；颜色、字体和文档布局来自 `@codexpass/tokens`。

设计变更先修改共享库的 `packages/tokens/theme.css` 或 `docs.css`，分发新 archive 后运行 `pnpm install && pnpm build:ui && pnpm validate && pnpm test`。提交 vendor、依赖锁、生成的 `public/design.css`；不要直接修改生成的 CSS。主题行为在 `public/theme.js`。

网页发布使用既有 Deploy workflow；页面修改不调整数据 API、schema、KV/DO 或缓存契约。

## A 方向第一轮

首页先展示用途、快速开始和端点。`public/status.js` 只渐进读取既有同源 meta/health/schema/features，不改变 API：检查时间与内容获取时间分开、UTC 明示，503 显示 Needs attention，网络或数据错误显示 Unavailable。静态 HTML 保留所有文档与元数据入口，无 JS 可读。

`node scripts/e2e/design-refresh.mjs` 在本地静态预览 5191 使用合成 metadata，检查 Chromium/WebKit、503、网络错误、无 JS 与 320/390/1440 明暗页面；不写生产数据。首次运行先 `pnpm exec playwright install chromium webkit`；截图默认写入 `.artifacts/design-refresh/`，可通过 `DESIGN_ARTIFACT_DIR` 指定绝对输出目录。

当前设计使用共享冰薄荷深浅主题、黑白胶囊主按钮与薄荷圆底箭头；CP 标志沿用正式版原色；成功、警告和错误状态保持独立语义。
