# CodexData runbook

## Topology

- **Worker `codex-models`** (Cloudflare account "Project 0xinf - FLOWNET"): serves `/v1/*` from KV via the
  edge cache; hosts the `SyncCoordinator` Durable Object (SQLite) that owns the dedicated account's
  OAuth tokens (AES-GCM encrypted with the `REFRESH_TOKEN_KEK` secret) and is the only writer to KV.
- **Sync agent** (`scripts/sync-agent.mjs`, run hourly by `.github/workflows/sync.yml`): leases a
  short-lived access token from the Worker (`POST /admin/lease`), fetches
  `chatgpt.com/backend-api/codex/models` from the GitHub runner (Workers egress is blocked by
  chatgpt.com — Phase 0 probe: 403 HTML), and pushes the raw response back (`POST /admin/ingest`).
  The Worker validates (Codex required fields), canonicalises, hashes, diffs and publishes.
- Token refresh happens **inside the Worker** (`auth.openai.com` is reachable from Workers). The
  refresh token never leaves the Durable Object; rotation is persisted before anything else runs.

## Secrets & variables

| Where                         | Name                       | Purpose                                                                                           |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| Worker secret                 | `REFRESH_TOKEN_KEK`        | 32 random bytes, base64. Encrypts tokens at rest in the DO.                                       |
| Worker secret                 | `ADMIN_TOKEN`              | Bearer for `/admin/*` (seed, lease, ingest, release, status, sync).                               |
| Worker var (`wrangler.jsonc`) | `SYNC_MODE`                | `external` (default) or `worker` (DO fetches itself; blocked today).                              |
| GitHub secret                 | `CODEX_MODELS_ADMIN_TOKEN` | Same value as the Worker `ADMIN_TOKEN`; used by sync.yml.                                         |
| GitHub secret                 | `CLOUDFLARE_API_TOKEN`     | Workers deploy token (Workers Scripts:Edit, KV:Edit, Workers Routes:Edit, Account Settings:Read). |
| GitHub secret                 | `CLOUDFLARE_ACCOUNT_ID`    | `0738b660c639c382b5117a10530d6da1`.                                                               |
| GitHub variable               | `CODEX_MODELS_ORIGIN`      | Worker origin used by sync.yml / monitor.yml (`https://codex-models.flownet.workers.dev`).        |

## Bootstrap (once)

1. Dedicated ChatGPT account (Pro): 2FA on, recovery codes in the password manager. **This account
   must never be logged in anywhere else afterwards** — any other `codex login` rotates the refresh
   token and locks the mirror out (`refresh_token_reused` is permanent).
2. Secrets on the Worker (interactive prompts; never paste secrets into a shell history):
   ```bash
   openssl rand -base64 32 | pnpm exec wrangler secret put REFRESH_TOKEN_KEK
   openssl rand -hex 32   | pnpm exec wrangler secret put ADMIN_TOKEN
   ```
   Put the same ADMIN_TOKEN value into the GitHub repo secret `CODEX_MODELS_ADMIN_TOKEN`
   (`gh secret set CODEX_MODELS_ADMIN_TOKEN` reads from stdin).
3. Deploy: `pnpm run deploy` (first deploy auto-creates the KV namespace and the DO migration).
   **Custom domain `api.codexpass.com`**: the `codexpass.com` zone is on Cloudflare but **not in
   the "Project 0xinf - FLOWNET" account** that hosts the Worker (deploy fails with code 10082
   "Can't infer zone from route"). Until that is fixed the public origin is
   `https://codex-models.flownet.workers.dev` (set as GitHub variable `CODEX_MODELS_ORIGIN` and as
   `CODEX_MODELS_PUBLIC_ORIGIN` in `wrangler.jsonc`). To get the custom domain, either move the zone
   into this account, or deploy the Worker into the account that owns the zone; then restore the
   `routes` line in `wrangler.jsonc` and switch both origins back to `https://api.codexpass.com`.
4. Log the dedicated account in on a trusted machine into a throwaway Codex home:
   ```bash
   CODEX_HOME=/tmp/codex-models-bootstrap codex login
   ```
5. Seed the Worker and shred the file:
   ```bash
   CODEX_MODELS_ADMIN_TOKEN=… node scripts/seed.mjs --auth /tmp/codex-models-bootstrap/auth.json --shred
   ```
6. First sync: `gh workflow run sync.yml` (or run `CODEX_MODELS_ADMIN_TOKEN=… node scripts/sync-agent.mjs`
   from any machine that can reach chatgpt.com). Then check:
   ```bash
   curl -s https://codex-models.flownet.workers.dev/v1/codex/meta.json | jq '{fetched_at, client_version, model_count, source}'
   curl -sI https://codex-models.flownet.workers.dev/v1/codex/models.json | grep -iE 'etag|cache-control|x-codex-models'
   curl -s https://codex-models.flownet.workers.dev/healthz
   ```

## Operations

- **Status**: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://codex-models.flownet.workers.dev/admin/status`
  (seeded, plan label, last refresh, access-token expiry, active lease, recent runs).
- **Manual sync**: `gh workflow run sync.yml`.
- **Schedule**: in the default `SYNC_MODE=external`, only `.github/workflows/sync.yml` schedules
  catalog sync, hourly at minute 7 UTC. `triggers.crons` is explicitly empty so deploying removes
  any old Worker cron. If Worker egress becomes usable and you switch to `SYNC_MODE=worker`,
  explicitly set `triggers.crons` to `["7 * * * *"]` for hourly sync and disable the external
  agent schedule. Manual Worker sync remains available through `POST /admin/sync` in that mode.
- **Health**: `/healthz` is 200 when a catalog exists and the last successful check is < 24 h old and
  there is no permanent token failure; `monitor.yml` opens/updates an `ops` issue otherwise.
- **Permanent token failure** (`permanent_failure` in status; `/healthz` 503; last-good catalog
  keeps being served): the account's refresh token expired/was reused/revoked. Recovery = repeat
  bootstrap steps 4–5 (re-login on a trusted machine, re-seed). Seeding clears the failure flag.
- **Stuck lease** (agent died mid-run): leases expire after 10 minutes; nothing to do.
- **Rotate ADMIN_TOKEN**: `wrangler secret put ADMIN_TOKEN` + update the GitHub secret.
- **Rotate KEK**: not supported in place (stored ciphertext would become unreadable) — rotate by
  re-seeding after setting the new KEK.
- **Feature-flag dataset: adding a new Codex tag** (manual, on each upstream `rust-v*` release):
  1. Vendor `codex-rs/features/src/lib.rs` at the new tag into
     `data/codex-features/sources/<tag>/` (raw.githubusercontent.com). If it is byte-identical to
     the previous snapshot, add the tag to `snapshot_aliases` in `data/codex-features/tags.json`
     instead. Diff `legacy.rs` too; it has been identical across tags so far and lives once at
     `sources/legacy.rs`.
  2. Add the tag to `verified_tags` + `latest` in `data/codex-features/tags.json`, then run
     `node scripts/extract-features.mjs` to regenerate `registry.json` and `pnpm build:static` to
     regenerate the served files under `public/v1/`. The parser fails loudly if upstream changed
     the table's shape — extend it, don't hand-edit the registry.
  3. `pnpm validate` prints any flags at the new tag that lack a zh annotation; add per-flag
     files under `data/codex-features/annotations/` (coverage gaps warn but do not fail CI).
  4. `pnpm check`, deploy.

## Known limitations

- The mirror reflects one account's plan/rollout view (`meta.source.plan_label`).
- It is fetched with the latest npm `@openai/codex` version; older Codex clients ignore unknown
  fields, but a new _required_ field could make a much older client reject the whole list.
- Snapshots are kept 180 days in KV; the change feed keeps the latest 500 events.
