# ModelDex

Open model catalog served as static JSON from Cloudflare Workers:

- **Official OpenAI Codex catalog mirror** (`/v1/codex/*`): the exact `{"models":[...]}` envelope
  the Codex client fetches from `chatgpt.com/backend-api/codex/models`, synced centrally from one
  dedicated account so that clients behind a proxy do not each have to call OpenAI.
- **Cross-provider model registry** (`/v1/registry*`, `/v1/pricing.json`): model name, provider,
  reasoning effort levels, context/output limits, modalities, tool capabilities, pricing, status,
  dates — OpenAI entries derived from the official catalog, other providers imported from
  [models.dev](https://models.dev) with attribution, plus curated overrides.

Public host: `https://api.codexpass.com` · Docs: `/` · Discovery: `/v1/index.json`

> **Status: work in progress.** Phase 0 egress probe found that Cloudflare Workers cannot reach
> `chatgpt.com/backend-api/codex/models` (403 HTML from the edge), while `auth.openai.com` is
> reachable. The catalog fetch therefore runs from an external agent (GitHub Actions) that leases
> the token from the Worker, refreshes it, hands the rotated token back, and pushes the fetched
> catalog to the Worker for validation and publishing. See `docs/RUNBOOK.md`.

## Honest notes

- The mirror is a server-side use of the Codex client's public OAuth flow with a dedicated ChatGPT
  account. OpenAI can change or revoke that at any time; the mirror then keeps serving the last
  successfully fetched catalog and `/healthz` turns 503.
- The catalog reflects that one account's plan/rollout view (`meta.json` → `source.plan_label`).
- `/v1/codex/*` bodies include OpenAI's model instructions verbatim (the Codex client requires
  them). They are relayed as-is; ModelDex grants no license over them.

## Licenses

Code: MIT (`LICENSE`). Registry data: CC-BY-4.0 (`data/LICENSE-DATA`). `/v1/codex/*`: none granted.

## Development

```bash
corepack enable && pnpm install
pnpm typecheck      # wrangler types + tsc
pnpm test           # vitest (workers pool / Miniflare)
pnpm dev            # local Worker on http://localhost:8787
pnpm deploy:dry     # validate config without deploying
```
