# Codex hook product registry

The registry maps distinctive hook script paths to product descriptions. It is community
commentary, not an OpenAI registry, a security verdict, or proof that an app is installed.

- Source: `data/codex-hooks/products/<id>.json` (one file per product).
- Schema: `data/codex-hooks/product.schema.json`.
- Generated API: `https://data.cp.dev/v1/hooks/codex/latest.json`.
- License: CC-BY-4.0, like the other curated datasets.

## Contribute

Copy an existing product file and use a stable lowercase product ID. Add distinctive literal
`path_suffixes`, product name, purpose and removal impact in `i18n.en` and `i18n.zh` (other
languages welcome). Use `reviewed_at` for the date evidence was reviewed, not a promised
compatibility date. Include at least one matching and one nonmatching redacted command.
Use `/Users/demo`, `/home/demo` or `C:\Users\demo`; never submit your real username,
workspace paths, tokens, socket addresses, or an entire private hooks file.

Every claim needs `references`: public official documentation (`kind: official`, HTTPS URL)
or a narrowly described local observation (`kind: local-observation`). `evidence: documented`
means the purpose is supported by official documentation, not that a matching local script has
been audited. Use `observed` when only a path/registration has been seen, and explicitly state
unverified behavior in each translation. Do not infer telemetry, permissions, or safety from
an event name. Xirp is intentionally recorded as observed, with behavior unverified.

Run with Node 22:

```sh
pnpm install --frozen-lockfile
pnpm build:static
pnpm validate
pnpm format:check
```

Commit source files and generated `public/v1/hooks/codex/` together and open a PR. CI rejects
schema mistakes, generic/conflicting suffixes, private home paths, unsafe reference links,
and stale generated assets. Add negative examples for similarly named unrelated scripts.
CI also checks matching and nonmatching examples; the app runs the same cases from a producer fixture.

## Consumer contract (schema_version 1)

Download the whole registry without credentials or local hook contents. Normalize `\\` to `/`
in a command, then look for a case-sensitive literal `path_suffix`. A match must end at the
end of the command or a shell delimiter (space, quote, semicolon, parentheses, pipe, ampersand,
redirection). This excludes `.bak` and similarly named files. No remote regular expressions,
executable code, shell expansion or hook execution is involved. Multiple matches from the
same product count once; matches from different products are ambiguous and must not pick a
winner. This detects **path references**, not shell semantics: an echoed or commented path can
also match, and arbitrary shell substitutions/renamed scripts are not recognized.

Show original command, event, product, translated purpose and removal impact, matched suffix,
evidence level and review date. Prefer exact locale, then base language, then English.
Treat missing/incompatible data as unavailable, and unknown paths as unrecognized. Keep local
scanning and explicit user-selected backup/deletion usable during a network failure. Never
auto-select or delete a hook because it matches a product or lacks a match. File absence alone
does not prove product uninstallation. Deleting a registration does not uninstall the product
or delete its scripts; the product may recreate registrations.

Clients should use a bounded unauthenticated GET, ETag revalidation and last-valid-cache
fallback. Codex Pass keeps a one-hour cache and a ten-minute failure backoff. When the origin
changes, caches from the previous origin must not be reused. The registry cannot change the
scope or authorization of hook deletion.
