# CodexData UI

共同设计规范与修改步骤：[codex-pass-ui/DESIGN.md](https://github.com/flownet-tech/codex-pass-ui/blob/main/DESIGN.md)。

Data 保持静态 HTML。内容在 `public/index.html`；颜色、字体和文档布局来自 `@codexpass/tokens`。

设计变更先修改共享库的 `packages/tokens/theme.css` 或 `docs.css`，分发新 archive 后运行 `pnpm install && pnpm build:ui && pnpm validate && pnpm test`。提交 vendor、依赖锁、生成的 `public/design.css`；不要直接修改生成的 CSS。主题行为在 `public/theme.js`。

网页发布使用既有 Deploy workflow；页面修改不调整数据 API、schema、KV/DO 或缓存契约。
