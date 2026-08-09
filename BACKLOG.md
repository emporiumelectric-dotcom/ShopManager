# ShopManager backlog

## Open

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

- [x] Make the Supabase anon key rotation-ready without baking it into committed HTML. Resolved 2026-08-09.
  - Pages now generates `config.json` from repository secrets during a manual deployment, and the installed PWA uses validated network-first configuration with a cached last-known-good fallback.
  - The key remains publicly served by GitHub Pages because it is a client-side anon credential. This change enables rotation without hand-editing HTML; it does not reduce key exposure.
  - Production verification passed on an already-installed PWA for startup, reads, writes, persistence across restart, cached-config offline bootstrap, and recovery after reconnecting.
