# ModelDex runbook

## Topology

- **Worker `modeldex`** (Cloudflare account "Project 0xinf - FLOWNET"): serves `/v1/*` from KV via the
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

| Where                         | Name                    | Purpose                                                                                           |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| Worker secret                 | `REFRESH_TOKEN_KEK`     | 32 random bytes, base64. Encrypts tokens at rest in the DO.                                       |
| Worker secret                 | `ADMIN_TOKEN`           | Bearer for `/admin/*` (seed, lease, ingest, release, status, sync).                               |
| Worker var (`wrangler.jsonc`) | `SYNC_MODE`             | `external` (default) or `worker` (DO fetches itself; blocked today).                              |
| GitHub secret                 | `MODELDEX_ADMIN_TOKEN`  | Same value as the Worker `ADMIN_TOKEN`; used by sync.yml.                                         |
| GitHub secret                 | `CLOUDFLARE_API_TOKEN`  | Workers deploy token (Workers Scripts:Edit, KV:Edit, Workers Routes:Edit, Account Settings:Read). |
| GitHub secret                 | `CLOUDFLARE_ACCOUNT_ID` | `0738b660c639c382b5117a10530d6da1`.                                                               |
| GitHub variable               | `MODELDEX_ORIGIN`       | Optional override of `https://api.codexpass.com` (e.g. workers.dev URL before DNS).               |

## Bootstrap (once)

1. Dedicated ChatGPT account (Pro): 2FA on, recovery codes in the password manager. **This account
   must never be logged in anywhere else afterwards** — any other `codex login` rotates the refresh
   token and locks the mirror out (`refresh_token_reused` is permanent).
2. Secrets on the Worker (interactive prompts; never paste secrets into a shell history):
   ```bash
   openssl rand -base64 32 | pnpm exec wrangler secret put REFRESH_TOKEN_KEK
   openssl rand -hex 32   | pnpm exec wrangler secret put ADMIN_TOKEN
   ```
   Put the same ADMIN_TOKEN value into the GitHub repo secret `MODELDEX_ADMIN_TOKEN`
   (`gh secret set MODELDEX_ADMIN_TOKEN` reads from stdin).
3. Deploy: `pnpm deploy` (first deploy auto-creates the KV namespace and the DO migration).
   **Custom domain `api.codexpass.com`**: the `codexpass.com` zone is on Cloudflare but **not in
   the "Project 0xinf - FLOWNET" account** that hosts the Worker (deploy fails with code 10082
   "Can't infer zone from route"). Until that is fixed the public origin is
   `https://modeldex.flownet.workers.dev` (set as GitHub variable `MODELDEX_ORIGIN` and as
   `MODELDEX_PUBLIC_ORIGIN` in `wrangler.jsonc`). To get the custom domain, either move the zone
   into this account, or deploy the Worker into the account that owns the zone; then restore the
   `routes` line in `wrangler.jsonc` and switch both origins back to `https://api.codexpass.com`.
4. Log the dedicated account in on a trusted machine into a throwaway Codex home:
   ```bash
   CODEX_HOME=/tmp/modeldex-bootstrap codex login
   ```
5. Seed the Worker and shred the file:
   ```bash
   MODELDEX_ADMIN_TOKEN=… node scripts/seed.mjs --auth /tmp/modeldex-bootstrap/auth.json --shred
   ```
6. First sync: `gh workflow run sync.yml` (or run `MODELDEX_ADMIN_TOKEN=… node scripts/sync-agent.mjs`
   from any machine that can reach chatgpt.com). Then check:
   ```bash
   curl -s https://api.codexpass.com/v1/codex/meta.json | jq '{fetched_at, client_version, model_count, source}'
   curl -sI https://api.codexpass.com/v1/codex/models.json | grep -iE 'etag|cache-control|x-modeldex'
   curl -s https://api.codexpass.com/healthz
   ```

## Operations

- **Status**: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.codexpass.com/admin/status`
  (seeded, plan label, last refresh, access-token expiry, active lease, recent runs).
- **Manual sync**: `gh workflow run sync.yml`.
- **Health**: `/healthz` is 200 when a catalog exists and the last successful check is < 24 h old and
  there is no permanent token failure; `monitor.yml` opens/updates an `ops` issue otherwise.
- **Permanent token failure** (`permanent_failure` in status; `/healthz` 503; last-good catalog
  keeps being served): the account's refresh token expired/was reused/revoked. Recovery = repeat
  bootstrap steps 4–5 (re-login on a trusted machine, re-seed). Seeding clears the failure flag.
- **Stuck lease** (agent died mid-run): leases expire after 10 minutes; nothing to do.
- **Rotate ADMIN_TOKEN**: `wrangler secret put ADMIN_TOKEN` + update the GitHub secret.
- **Rotate KEK**: not supported in place (stored ciphertext would become unreadable) — rotate by
  re-seeding after setting the new KEK.

## Known limitations

- The mirror reflects one account's plan/rollout view (`meta.source.plan_label`).
- It is fetched with the latest npm `@openai/codex` version; older Codex clients ignore unknown
  fields, but a new _required_ field could make a much older client reject the whole list.
- Snapshots are kept 180 days in KV; the change feed keeps the latest 500 events.
