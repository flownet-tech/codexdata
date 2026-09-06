# Contributing

CodexData is an open dataset for the OpenAI Codex client (not affiliated with OpenAI). The most
useful thing you can contribute is **feature-flag annotations and their translations** — the
human-readable layer over the machine-extracted registry.

## Where the data lives

One JSON file per flag, named after the flag key:

```
data/codex-features/annotations/<flag_key>.json
```

```jsonc
{
  "key": "chronicle", // must equal the filename
  "aka": "Computer History", // optional: observed official/user-facing name, locale-independent
  "i18n": {
    "zh": {
      "title": "电脑使用历史（Computer History）",
      "summary": "启用 Chronicle 边车进程，被动记录屏幕上下文形成记忆。",
      "note": "…", // optional extra context
      "risk": "…", // optional risk note
    },
    "en": { "title": "…", "summary": "…" },
  },
}
```

**Adding a language = adding one `i18n` block** to files you can translate. Locale codes are
BCP-47-style (`zh`, `en`, `ja`, `zh-TW`, `zh-Hant`, …). `title` and `summary` are required per
locale; `note` / `risk` are optional. The full schema is
`data/codex-features/annotations.schema.json`; machine facts (stage, defaults, official English
rustdoc, menu copy) come from the extracted registry and are **not** edited here.

## Honesty rules (the actual review bar)

- Ground every claim in the flag's official rustdoc (`doc` in
  `/v1/features/codex/latest.json`), the client's own menu copy, or behavior you have personally
  observed. **Do not guess.**
- If a meaning is unconfirmed, say so in `note` (see `psp.json` for the pattern) rather than
  inventing an expansion.
- Translations should translate the grounded summary — not embellish it.
- These annotations are community commentary, not OpenAI documentation; keep that tone.

## Checking your change

```bash
corepack enable && pnpm install
pnpm validate        # schema + filename/key match + key exists in the registry + zh coverage
pnpm build:static    # regenerate public/v1/** (commit the result; CI fails on drift)
```

CI runs the same checks on every pull request (plus typecheck, tests, prettier). If you only edit
annotation files, `pnpm validate && pnpm build:static` is all you need locally; Node ≥ 22.

## Other contributions

- **New Codex tags** (new flags, stage changes): see "Feature-flag dataset: adding a new Codex
  tag" in `docs/RUNBOOK.md`. The extractor is strict on purpose — extend it rather than hand-edit
  `registry.json` (CI rejects hand edits).
- **Dataset consumers / field semantics**: `docs/DATASETS.md`.
- Third-party model profiles are planned under `data/profiles/` and are not open for contribution
  yet.

## Licensing

By contributing you agree your data contributions under `data/` are licensed CC-BY-4.0
(`data/LICENSE-DATA`) and code contributions under MIT (`LICENSE`). Vendored `sources/` snapshots
are OpenAI's, Apache-2.0, and must stay byte-verbatim.

---

### 中文速览（翻译贡献者看这段就够）

- 每个旗标一个文件：`data/codex-features/annotations/<旗标名>.json`，`key` 必须等于文件名。
- **加一种语言 = 在 `i18n` 里加一个语言块**（`title`、`summary` 必填，`note`、`risk` 选填）。
- 诚实纪律：只写有依据的内容（官方 rustdoc / 菜单文案 / 你亲自验证过的行为），拿不准就在
  `note` 里写明「未确认」，禁止编造；翻译忠实于原意，不加戏。
- 提交前跑 `pnpm validate && pnpm build:static`（Node ≥ 22），把 `public/` 下生成的变更一并提交。
