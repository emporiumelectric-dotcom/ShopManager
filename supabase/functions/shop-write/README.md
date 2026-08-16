# shop-write

`index.ts` is the source of the `shop-write` Edge Function for Supabase
project `buzidwccluskdkccidev` (electric-emporium-ops), function id
`72ec771d-bdd7-43de-86b9-cf109bafdf50`, deployed with `verify_jwt: true`
(deploy-time setting — must be preserved on every redeploy).

Current state of this file: the **PIN-hash rewrite, deployed as version 5
on 2026-08-16** (via the dashboard Code tab — the `supabase` CLI is not
installed on the deploying machine; `verify_jwt: true` preserved). The PIN
check goes through the service-role-only `public.shop_write_check_pin`
helper (bcrypt compare against `users.pin_hash`, applied in
`sql/pin-hashing/006`); the function no longer reads plaintext `users.pin`.
Everything else — both throttle pre-checks, the `pin_attempts` logging with
caller IP, response shapes, delete/edit gating — is unchanged from v4.
Verified in production per the RUNBOOK (test user 9004, plus a real Owner
login and item edit logging a success attempt with caller IP).

The plaintext `users.pin` column is **deliberately still present**
(checklist 1.2.5 pending): it stays until the new path has several days of
normal shop use behind it, because dropping it invalidates the v4 rollback
below.

Deployment, verification, and rollback: see [RUNBOOK.md](RUNBOOK.md).

## Archived v4 (rollback target)

The verbatim source of deployed **version 4** (2026-08-01, the plaintext-PIN
version, retrieved via the management API on 2026-08-16) is preserved in git
at commit `074f5c9`:

    git show 074f5c9:supabase/functions/shop-write/index.ts

Deployed v4 bundle ezbr_sha256:
`f8acfdaaf6e7d9437ed34fc6ef5f464f4696437ddbeba32cf26b47c50c4efb0c`

The v4 rollback is only valid while the plaintext `users.pin` column still
exists — that version reads it directly. Do not edit the archived content;
if it must be materialized for a rollback, extract it from the commit
unchanged.
