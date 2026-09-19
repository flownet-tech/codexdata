# Codex 兼容情报（compat）

回答一个问题：**“下一个 Codex 版本会不会弄坏 Codex Pass 托管的配置？”** 每次 Codex CLI
发版，管线自动下载官方二进制做探测，把硬事实发布成机器可读的 JSON；Codex Pass 客户端
定期拉取，在 Codex Doctor 里展示失效配置（可一键清理）与升级风险提醒。

## 数据流

```
npm dist-tags (latest/alpha)
   │  .github/workflows/compat-watch.yml（每 6 小时）
   ▼
scripts/compat-probe.mjs        下载二进制 → 键名字符串探测 / 废弃提示扫描 / 配置可加载性 / release notes
   ▼
data/codex-compat/probes/<version>.json     （探针硬事实，提交回仓库）
   │
   ├── data/codex-compat/tracked.json        （托管键清单 + 人工裁定 statusOverride/action）
   ├── data/codex-compat/advisories/*.json   （人工通告，i18n）
   ▼
scripts/build-compat.mjs → public/v1/compat/codex/latest.json   （确定性产物，--check 防漂移）
   ▼
scripts/publish-compat.mjs → POST /admin/compat/publish → KV    （热更新，无需重新部署 Worker）
   ▼
GET https://data.cp.dev/v1/compat/codex/latest.json             （KV 优先，静态资产兜底；ETag/304）
```

## 探测方法与边界

- **键存在性**：config.toml 键名是 serde 字段名，必然以字符串形式存在于 CLI 二进制；
  从「上一个稳定版有」到「这个版本没有」= 该键极可能被移除（`disable_response_storage`
  实证：上游 2025-09 移除后所有版本二进制里连字符串都没有）。误报方向是安全的
  （字符串还在但语义变了探不出来；字符串消失基本坐实移除）。
- **配置可加载性**：用 Codex Pass 托管的全部形状拼一份 config.toml，跑
  `codex features list`；0.148/0.149 那类「整份拒载」在这里翻车。
- **废弃提示**：扫描二进制里 `no longer supported` / `is deprecated` 消息；符号表里
  token 边界已丢失，展示文本首尾会带少量粘连字符，diff 用「短语 ±24/40 字符」的核心
  锚定，跨版本稳定。
- **探不到的**：`[desktop]` 表由 ChatGPT.app 桌面端（asar）读取，不在 CLI 二进制里
  （`probe: "none"`，状态人工维护）；键语义变化（同名不同义）探不出来，靠 advisories。
- **daemon 表**：`table: "daemon"` 的键不在 config.toml，而在 app-server daemon 状态目录的
  `settings.json`（`$CODEX_HOME/app-server-daemon/settings.json`）；daemon 与 CLI 是同一个
  二进制，serde 字段名（camelCase）照常可探。探到只说明机制还在，不说明 daemon 是否在运行。

## 回归处置

探针只报告事实：稳定版发现「键消失」或「整份拒载」→ workflow 开置顶 issue（exit 20），
数据照常提交发布（客户端会看到 `status: "missing"`，只展示不提供动作）。人工判读后：

- 确认移除 → `tracked.json` 里加 `statusOverride: "removed"` + `action: "remove"`（客户端才提供一键清理）；
- 有升级风险 → `advisories/` 加一条（带 i18n 四语言：zh / en / zh-TW / ja，与客户端 locale 对齐）；
- 重跑 `pnpm build:compat` 提交，workflow 或手动 `node scripts/publish-compat.mjs` 发布。

## 客户端契约

payload schema 在 [data/codex-compat/compat.schema.json](../data/codex-compat/compat.schema.json)
（发布端点按它校验，坏数据进不了 KV）。客户端约定：

- 只对 `action: "remove"` 的键提供修复动作；`status: "missing"` 仅展示。
- `advisories[]` 按安装的 Codex 版本对 `affects.min/max` 过滤（版本比较忽略 prerelease，
  与 codex-pass `codex_client_gate` 的约定一致）；`clientAction: "hold-upgrade"` +
  `codexPassFixedIn` 用于「先升级 Codex Pass 再升级 Codex」的提醒。
- `codex.maxProbedStable` 之上的版本 = 未验证。
- 拉取失败必须静默退化（照抄 feature-annotations 模式：1h 刷新、10min 退避、磁盘缓存）。
