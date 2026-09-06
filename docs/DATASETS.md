# Datasets

Reference for the static datasets served by Codex Models. Everything on this page is **pregenerated
into `public/` by `scripts/build-static.mjs` and served by the Workers static-asset layer** — asset
requests do not invoke the Worker and are free; the Worker only runs for the live catalog mirror
(`/v1/codex/*`, `/v1/index.json`, `/healthz`, `/admin/*`) and for JSON 404s on unknown dataset
paths. Not affiliated with OpenAI.

All dataset responses carry `Access-Control-Allow-Origin: *`, a strong `ETag` (send
`If-None-Match`, get `304`), and `Cache-Control: public, max-age=3600` (see `public/_headers`).

One asset-layer limitation (confirmed in production): `OPTIONS` on a dataset URL returns `405` —
the asset layer only serves `GET`/`HEAD`. Plain browser `fetch`/HTTP-cache revalidation is
unaffected (no preflight); only JavaScript that manually sets `If-None-Match` from a cross-origin
page would trip a preflight and fail. Server-side and native clients (curl, codex-pass) are
unaffected.

## Feature-flag registry — `/v1/features/codex/`

What every `[features]` flag in the Codex client actually is, per verified client tag. Machine
facts are extracted deterministically from the client's own `codex-rs/features` sources
(`data/codex-features/sources/`, Apache-2.0); Chinese annotations are human-curated
(`data/codex-features/annotations.json`, CC-BY-4.0).

| URL                                      | Content                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `latest.json`                            | Merged registry for the latest verified tag                 |
| `<tag>.json` (e.g. `rust-v0.153.4.json`) | Same, for that tag; alias tags serve their snapshot's bytes |
| `index.json`                             | Verified tags, snapshot mapping, notes, license             |

### Payload shape (`latest.json` / `<tag>.json`)

```jsonc
{
  "dataset": "codex-feature-flags",
  "snapshot_tag": "rust-v0.153.4", // the source snapshot this body was built from
  "applies_to": ["rust-v0.153.1", "rust-v0.153.4"], // verified tags with byte-identical sources
  "counts": { "total": 135, "annotated": 135 },
  "flags": [ /* sorted by key, see below */ ],
  "source": { "files": [...], "license": "...", "not_affiliated_with_openai": true }
}
```

### Flag fields

| Field                                | Meaning                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                                | The `[features]` config key / `codex features enable <key>` name                                                                                                                                                                                                                                                                |
| `variant`                            | Rust enum variant name in the client source (e.g. `undo` → `GhostCommit`)                                                                                                                                                                                                                                                       |
| `stage`                              | Lifecycle stage; strings match `codex features list` output exactly: `stable`, `experimental`, `under development`, `deprecated`, `removed`                                                                                                                                                                                     |
| `default_enabled`                    | `true` / `false`, or `null` when platform-conditional                                                                                                                                                                                                                                                                           |
| `default_expr`                       | Present only when `default_enabled` is `null`: the raw Rust expression (currently only `cfg!(windows)`, for `secret_auth_storage`)                                                                                                                                                                                              |
| `doc`                                | The client's own rustdoc comment for the flag (English, verbatim; multi-line collapsed to one paragraph)                                                                                                                                                                                                                        |
| `experimental`                       | For `experimental`-stage flags: OpenAI's own `/experimental` menu copy — `{ name, menu_description, announcement }` (`announcement` may be `null`); otherwise `null`                                                                                                                                                            |
| `stage_condition` / `stage_fallback` | Present only when the stage itself is platform-conditional (currently only `prevent_idle_sleep`): `stage` is the value under the listed platforms, `stage_fallback` elsewhere                                                                                                                                                   |
| `legacy_aliases`                     | Older config keys the client still maps to this flag (from `legacy.rs`), e.g. `chronicle` ← `telepathy`, `apps` ← `connectors`                                                                                                                                                                                                  |
| `history`                            | Across verified tags: `first_seen`, `last_seen`, `stages` (stage transitions with the tag they appeared at), `delisted_after` if the key vanished from the table entirely. **`first_seen` is bounded by the earliest verified tag** (`rust-v0.148.0`) — a flag "first seen" there may well predate it                           |
| `annotation`                         | Human-curated Chinese layer, or `null` if not yet covered: `title_zh` (short name), `summary_zh` (grounded in the official doc — not invented), optional `aka` (observed user-facing name, e.g. chronicle = "Computer History"), `note_zh`, `risk_zh`. Where a meaning is unconfirmed the note says so (e.g. the `psp` acronym) |

### Consumption rules

- **Display enrichment only.** The authoritative flag list for a machine is always its local
  `codex features list`; this dataset adds names, context and history on top. If the fetch fails,
  degrade to showing raw keys.
- Flags with `stage` `removed` / `deprecated` are kept because the client still parses the keys;
  don't offer them as toggles.
- Nine flags are documented by the client as **requirements-only gates** (`browser_use*`,
  `computer_use`, `in_app_*`): meant to be set from system-level `requirements.toml`, not user
  config. Their annotations say so.

## ModelInfo JSON Schema — `/v1/schema/codex-model-info/`

JSON Schema (2020-12) of the Codex client's rejection rules for a `GET /models` response: required
fields, JSON types, closed enums. One schema covers every verified tag (all struct changes across
them are additive with serde defaults); each tag URL serves the same bytes. The mirror validates
every catalog it publishes against this same schema. Details and per-tag notes:
`data/codex-schema/tags.json`, served at `index.json`.

| URL                          | Content                                            |
| ---------------------------- | -------------------------------------------------- |
| `latest.json` / `<tag>.json` | The schema (identical bytes for all verified tags) |
| `index.json`                 | Verified tags, source files, change notes, license |

## Versioning & updates

- A "verified tag" is a Codex release whose relevant sources are vendored in this repository and
  from which the artifacts are deterministically rebuilt (`pnpm validate` fails on any drift).
- New tags are added manually per release — see `docs/RUNBOOK.md` ("Feature-flag dataset: adding a
  new Codex tag"). Newly introduced flags may temporarily lack an `annotation` (CI warns, doesn't
  fail); consumers must tolerate `annotation: null`.
- `index.json` URLs are absolute, baked from the configured public origin at build time; after a
  domain move they change on the next build + deploy.

## Licenses

Registry + annotations: CC-BY-4.0 (`data/LICENSE-DATA`), derived from openai/codex sources
(Apache-2.0, reproduced with `LICENSE` + `NOTICE` under the respective `sources/` directories).
The Chinese annotations are community commentary grounded in the client's own doc comments and
observed behavior — **not OpenAI documentation**.
