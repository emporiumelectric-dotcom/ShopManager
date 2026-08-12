# ShopManager backlog

## Open

- [ ] Hash the staff PINs. `users.pin` stores plaintext and `verify_pin` compares raw.
  - Throttling (see Resolved) slows guessing but does not protect the stored value. Any DB dump, backup leak, or future SECURITY DEFINER mistake exposes every staff PIN at once.
  - Use `pgcrypto` `crypt()` with a per-row salt; migrate by rehashing existing PINs in place, then drop the plaintext column.
  - `verify_pin` is the only reader, so the change is contained — but staff cannot log in if the migration half-applies. Needs a rehearsed rollback.

- [ ] Trace the staff session token source before touching anonymous sign-in.
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