# Codex Models

**Not affiliated with, endorsed by, or maintained by OpenAI.** "Codex" refers to OpenAI's Codex
client; this project is an independent, open mirror and dataset for it.

Static JSON served from Cloudflare Workers:

- **Official OpenAI Codex catalog mirror** (`/v1/codex/*`): the exact `{"models":[...]}` envelope
  the Codex client fetches from `chatgpt.com/backend-api/codex/models`, synced centrally from one
  dedicated account, with immutable snapshots and a change feed (new-model-release history).
- **Third-party model profiles for Codex** (`/v1/profiles/codex.json`, _upcoming_): human-curated,
  reviewable source data (reasoning levels and defaults, context window, modalities, tool flags,
  minimal client version) that a client such as [codex-pass](https://codexpass.com) renders locally
  into Codex's `ModelInfo` format, so a relay-hosted model (Claude, Gemini, DeepSeek, …) can appear
  in the native Codex picker with a correct reasoning slider. Profiles ship with the JSON Schema of
  Codex's `ModelInfo` per client tag (`/v1/schema/codex-model-info/<tag>.json`) so entries can be
  validated fail-closed before they are ever sent to a client.

Public host: `https://codex-models.flownet.workers.dev` · Docs: `/` · Discovery: `/v1/index.json`

> **Status: work in progress.** Phase 0 egress probe found that Cloudflare Workers cannot reach
> `chatgpt.com/backend-api/codex/models` (403 HTML from the edge), while `auth.openai.com` is
> reachable. The catalog fetch therefore runs from an external agent (GitHub Actions) that leases
> the token from the Worker, refreshes it, hands the rotated token back, and pushes the fetched
> catalog to the Worker for validation and publishing. See `docs/RUNBOOK.md`. Profiles and schema
> endpoints are not published yet.

## Honest notes

- The mirror is a server-side use of the Codex client's public OAuth flow with a dedicated ChatGPT
  account. OpenAI can change or revoke that at any time; the mirror then keeps serving the last
  successfully fetched catalog and `/healthz` turns 503.
- The catalog reflects that one account's plan/rollout view (`meta.json` → `source.plan_label`).
- `/v1/codex/*` bodies include OpenAI's model instructions verbatim (the Codex client requires
  them). They are relayed as-is; Codex Models grants no license over them.
- A Codex client discards the **entire** `/models` response if any single entry fails to parse.
  Third-party profiles are therefore source data, not ready-made catalog entries: the consuming
  client must render and validate them against the schema for the exact client version it serves.

## Licenses

Code: MIT (`LICENSE`). Profile data under `data/`: CC-BY-4.0 (`data/LICENSE-DATA`).
`/v1/codex/*`: none granted (OpenAI's content, relayed as-is).

## Development

```bash
corepack enable && pnpm install
pnpm typecheck      # wrangler types + tsc
pnpm test           # vitest (workers pool / Miniflare)
pnpm dev            # local Worker on http://localhost:8787
pnpm deploy:dry     # validate config without deploying
```
