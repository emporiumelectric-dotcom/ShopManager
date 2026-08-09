# ShopManager backlog

## Open

- [ ] Rotate the legacy Supabase anon JWT as a separate, controlled change.
  - Do not combine the rotation with config-delivery plumbing changes.
  - Deploy the new repository secret, then verify reads and writes on a real, already-installed shop PWA before deactivating the old key.
  - Define a rotation-specific rollback plan first. The normal commit-SHA rollback regenerates `config.json` from the current secrets and is unsafe between changing the secret and completing production verification.

- [ ] Audit the import, seed, item-update, location-stock, and stock-transfer write paths and their RLS boundary.
  - Settle the earlier concern around `parseXLSX`, `runSeed`, `dbUpdateItem`, `dbUpdateLocStock`, and `dbTransferStock` by verifying every mutation reaches `shop-write` in the deployed app.
  - The current source routes the mutation calls in these paths through `callWrite`, but this still needs an end-to-end network/Edge Function verification.
  - Confirm anon clients cannot write the affected tables directly. Successful writes alone do not prove whether they used `shop-write` or permissive RLS.

## Resolved

- [x] Make the Supabase anon key rotation-ready without baking it into committed HTML. Resolved 2026-08-09.
  - Pages now generates `config.json` from repository secrets during a manual deployment, and the installed PWA uses validated network-first configuration with a cached last-known-good fallback.
  - The key remains publicly served by GitHub Pages because it is a client-side anon credential. This change enables rotation without hand-editing HTML; it does not reduce key exposure.
  - Production verification passed on an already-installed PWA for startup, reads, writes, persistence across restart, cached-config offline bootstrap, and recovery after reconnecting.
