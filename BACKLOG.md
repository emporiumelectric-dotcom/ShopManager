# ShopManager backlog

## Open

- [ ] Deno-based contract tests for the `shop-write` Edge Function (phase 2 of checklist 1.3.7; deferred 2026-08-16).
  - The client-side suite landed 2026-08-16 (`scripts/test-*.cjs` via the `vm` harness, run by `node scripts/run-tests.cjs` and `.github/workflows/ci.yml`). It pins the client half of the wire contract; the server half is untested.
  - Wanted: the decision table in `supabase/functions/shop-write/index.ts` — token path vs PIN path vs `op:"login"` routing; `session_expired` vs `invalid_session` codes; token-path failures never writing `pin_attempts` (the lockout-DoS protection); `TABLE_FIELDS` / `pickFields` / `requiresCanDelete` gating.
  - Mechanism: a Deno test imports the module (which starts the handler), points `SUPABASE_URL` at a small fake-PostgREST stub server the test also runs, and fires real HTTP at it. Deno is not installed on this machine, so CI-only via `denoland/setup-deno` is acceptable. Same rules as ci.yml: no secrets, no reachable path to `buzidwccluskdkccidev`.
  - Known limit either way: deploys are copy-pasted through the dashboard Code tab, so tests of the repo's `index.ts` cannot prove the deployed function matches it. One manual end-to-end write after every deploy stays mandatory (RUNBOOK).

- [ ] Remove plaintext `users.pin`. Login-path hashing landed 2026-08-13; the column remains because `shop-write` reads it.
  - Throttling (see Resolved) slows guessing but does not protect the stored value. Any DB dump, backup leak, or future SECURITY DEFINER mistake exposes every staff PIN at once.
  - Use `pgcrypto` `crypt()` with a per-row salt; migrate by rehashing existing PINs in place, then drop the plaintext column.
  - CORRECTED 2026-08-13: `verify_pin` is NOT the only reader. `shop-write` independently fetches `users.pin` with the service role key and compares in TypeScript (`timingSafeEqual`), so the column could not be dropped in the same change. See `docs/RECON_session_token_trace.md`. Hashing shipped as an additive `pin_hash` column instead: `verify_pin` compares the hash, falling back to plaintext only when `pin_hash IS NULL`. Verified live, all 7 staff, login and write paths, zero lockouts. `users_sync_pin_hash` keeps the two columns from drifting. SQL in `sql/pin-hashing/001`-`005`. Original note follows: the change is contained — but staff cannot log in if the migration half-applies. Needs a rehearsed rollback.
  - DONE 2026-08-16 (checklist 1.2.1): `shop-write` no longer reads `users.pin`. Rather than routing through `verify_pin` (which would have broken shop-write's own IP throttle and logging), it calls the service-role-only `public.shop_write_check_pin` helper (`sql/pin-hashing/006`, rehearsed via `007`). Deployed as v5 via the dashboard Code tab and verified in production: Owner login, real item edit logging a `pin_attempts` success with caller IP, wrong PIN rejected. Details and deviations in `supabase/functions/shop-write/RUNBOOK.md` §0 and `sql/pin-hashing/NOTES.md`.
  - REMAINING — deliberately NOT done yet (checklist 1.2.5): drop the plaintext `pin` column, drop the `users_sync_pin_hash` trigger, remove `verify_pin`'s plaintext fallback, stop the client sending a raw PIN per write. The column drop waits until the new path has run through **several days of normal shop use by Akshay and Lokesh**, and goes **last**: dropping `pin` invalidates the archived v4 rollback (commit `074f5c9`), which reads the column directly.

- [ ] Constrain anonymous sign-in. Trace DONE 2026-08-13 (`docs/RECON_session_token_trace.md`): `signInAnonymously()` at `index.html:1602` supplies the Bearer token on writes; staff identity is a separate `verify_pin` check that never touches Supabase Auth. Confirmed a token-source replacement, not a toggle.
  - Live advisors flag `auth_allow_anonymous_sign_ins` on all six read tables. Disabling it looks like a one-setting close of the read-side gap.
  - It is not safe yet: `shop-write` runs `verify_jwt: true`, and the PWA may obtain its `authenticated` token from anonymous sign-in. Disabling could break both reads and writes for the shop floor mid-shift.
  - Read the auth call in `index.html` first. If the token is anonymous-derived, this becomes a token-source replacement, not a toggle.

- [ ] Rotate the legacy Supabase anon JWT as a separate, controlled change.
  - Legacy JWT `anon` and `service_role` keys are scheduled for deprecation by the end of 2026. Supabase has announced no forced-disable date; legacy keys remain valid until the project owner explicitly disables them. Source: [Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys).
  - The August 2026 breaking change was the self-hosted Kong-to-Envoy migration and is unrelated to legacy API keys.
  - Rotation is owner-scheduled, not deadline-driven. Target completion: before the end of 2026.
  - Rotation likely means migrating from the legacy JWT anon key to a publishable key (`sb_publishable_...`), not replacing it with another legacy JWT. Confirm the target key format before implementation.
  - `config-validation.js` currently requires exactly three dot-separated segments and a decoded JWT payload whose `role` is `anon` and whose `ref` matches the project. A publishable key satisfies none of those checks, so the validator must be revised as part of the migration or deployment will fail validation.
  - Do not combine the rotation with config-delivery plumbing changes.
  - Deploy the new repository secret, then verify reads and writes on a real, already-installed shop PWA before deactivating the old key.
  - Define a rotation-specific rollback plan first. As documented in the [deployment rollback warning](DEPLOYMENT.md#rollback-behavior), the normal commit-SHA rollback regenerates `config.json` from the current secrets and is unsafe between changing the secret and completing production verification.

- [ ] Audit the import, seed, item-update, location-stock, and stock-transfer write paths and their RLS boundary.
  - Settle the earlier concern around `parseXLSX`, `runSeed`, `dbUpdateItem`, `dbUpdateLocStock`, and `dbTransferStock` by verifying every mutation reaches `shop-write` in the deployed app.
  - The current source routes the mutation calls in these paths through `callWrite`, but this still needs an end-to-end network/Edge Function verification.
  - Confirm anon clients cannot write the affected tables directly. Successful writes alone do not prove whether they used `shop-write` or permissive RLS.

## Resolved

- [x] Throttle `verify_pin` against brute force. Resolved 2026-08-12.
  - Was `LANGUAGE sql`, unthrottled, and EXECUTE-able by `authenticated`. With anonymous sign-in enabled, any stranger could mint a JWT and brute-force a 4-digit staff PIN. The `shop-write` rate limit does not cover direct RPC calls.
  - Now `plpgsql`, still SECURITY DEFINER. Counts failed `pin_attempts` rows for that `user_id` in the last 15 minutes; at 5 or more it logs the attempt and returns no rows. Per-user, silent (a locked correct PIN is indistinguishable from a wrong PIN), expires by time.
  - Also marked VOLATILE. It was not, so the planner could collapse repeat calls within a single statement and skip both the check and the logging.
  - Verified live on `electric-emporium-ops` (project ref `buzidwccluskdkccidev`): good PIN returns the row; five wrong then correct PIN returns nothing; clearing attempts restores access. Test user and test rows removed.
  - Does not address plaintext PIN storage — see Open.

- [x] Make the Supabase anon key rotation-ready without baking it into committed HTML. Resolved 2026-08-09.
  - Pages now generates `config.json` from repository secrets during a manual deployment, and the installed PWA uses validated network-first configuration with a cached last-known-good fallback.
  - The key remains publicly served by GitHub Pages because it is a client-side anon credential. This change enables rotation without hand-editing HTML; it does not reduce key exposure.
  - Production verification passed on an already-installed PWA for startup, reads, writes, persistence across restart, cached-config offline bootstrap, and recovery after reconnecting.