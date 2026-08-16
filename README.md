# ShopManager

Installable PWA the Electric Emporium shop floor runs on — stock, sales,
stock-in, transfers between locations, history, and owner-only import and
reports. Live at **https://manager.electricemporium.in**.

Repo: `emporiumelectric-dotcom/ShopManager`

## Start here

- [DEPLOYMENT.md](DEPLOYMENT.md) — publishing model, rollback handle, rollback hazards. **Read before deploying.**
- [BACKLOG.md](BACKLOG.md) — open security work, with the reasoning and the live verification behind each item.
- [supabase/functions/shop-write/README.md](supabase/functions/shop-write/README.md) — which Edge Function version is deployed vs. written.
- [supabase/functions/shop-write/RUNBOOK.md](supabase/functions/shop-write/RUNBOOK.md) — deploy, verify, roll back the function.
- [sql/pin-hashing/NOTES.md](sql/pin-hashing/NOTES.md) — PIN-hash migration record.
- [docs/RECON_session_token_trace.md](docs/RECON_session_token_trace.md) — how auth actually flows; corrects earlier assumptions.

## Shape

One file: [`index.html`](index.html), ~419KB of HTML, CSS and vanilla JS. No
framework, no bundler, no `package.json`. Alongside it:

| File | Role |
|---|---|
| `sw.js` | Service worker — network-first shell cache + separate validated config cache |
| `manifest.json`, `icon-*.png` | PWA install metadata |
| `config-validation.js` | Shared validator for `config.json`, used by the browser, the SW, and the build |
| `shell-files.js` | Single source of truth for the SW precache list (UMD — loaded by both `importScripts` and Node) |
| `config.template.json` | Placeholder shape for the generated config |
| `vendor/supabase-2.112.2.js` | Vendored Supabase client, pinned |

`config.json` and `dist/` are gitignored. `config.json` is generated at deploy
time from repository secrets; `dist/` is the build output.

### Navigation

Staff see: Home, Stock, Sale, Stock IN, Transfer, History.
Owners additionally see: Import, Reports (`index.html:672`).

### Supabase

Project `buzidwccluskdkccidev` (`electric-emporium-ops`) — **a different project
from the storefront's.** Tables read directly: `stores`, `locations`,
`item_locations`, `items`, `transactions`, `users_public`. Auth-adjacent:
`users`, `pin_attempts`, `shop_sessions`.

Writes do **not** go direct. Everything mutating routes through `callWrite()`
(`index.html:263`) → the `shop-write` Edge Function (`verify_jwt: true`), which
holds the service role key. RLS blocks anon writes to the affected tables;
verified 2026-08-02.

Reads are still open — an accepted, recorded risk, not an oversight. See the
"Constrain anonymous sign-in" item in BACKLOG.md before touching it: the PWA
gets its Bearer token from `signInAnonymously()` (`index.html:1602`), so flipping
that setting could break reads *and* writes mid-shift.

Staff identity is separate from Supabase Auth: a 4-digit PIN checked by
`verify_pin`, throttled to 5 failures per user per 15 minutes.

## Service worker

Shell files are **network-first** — updates land immediately, cache is only the
offline fallback. Navigations fall back to `./index.html`; everything else
returns a 503 with a plain-text body if uncached.

`config.json` is handled separately (`sw.js:96`): fetch `no-store`, validate,
cache on success; on network failure serve the cached copy **only if it still
validates**, otherwise evict it and return `{"error":"config_unavailable"}`.
A malformed config never reaches the app.

Cache names `shopmanager-shell-v3` / `shopmanager-config-v1` — bump the shell
version when the precache list changes; `activate` deletes anything not
whitelisted.

## Deploying

**Pushing `main` does not deploy anything.** Auto-deploy is off.

Deploy: manually dispatch [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
(only runs on `main`). It refuses to build if a JWT-shaped string is committed
in any `.html`/`.js`/`.json`, copies the shell into `dist/`, generates
`config.json` from `SUPABASE_URL` + `SUPABASE_ANON_KEY` secrets, validates it,
verifies the precache list matches `dist/`, records SHA-256 of `config.json` and
the vendored client, deploys, then re-downloads both from the live site and
retries up to 12× until the hashes match — failing the run if they never do.

Roll back: dispatch `rollback-pages.yml` with a `commit_sha` (must be an
ancestor of `main`). Current verified handle is in DEPLOYMENT.md — update it
after each deployment clears its installed-PWA verification gate.

The one trap, spelled out in DEPLOYMENT.md: rollback regenerates `config.json`
from *current* secrets, so commit-SHA rollback is **unsafe during a key
rotation** between changing the secret and finishing production verification.

`config.json` is public by design — the browser needs the anon credential.
Authorization rests on RLS and `shop-write`, not on hiding it.

## Local checks

No package manager. Run the scripts directly with Node:

```bash
node scripts/test-bootstrap.cjs
```

```bash
node scripts/test-config-validation.cjs
```

```bash
node scripts/test-service-worker.cjs
```

To serve the app locally you need a `config.json` next to `index.html`:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/build-config.cjs config.json
```

Note `build-config.cjs` opens with flag `wx` — it refuses to overwrite. Delete
the old file first.

Then:

```bash
python -m http.server 8000
```

## Working branch

`main` is the deploy source. This checkout currently sits on
`test/shopmanager-harness`.
