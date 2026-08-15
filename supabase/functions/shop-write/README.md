# shop-write — archived deployed source

`index.ts` is a verbatim archive of the `shop-write` Edge Function exactly as
deployed to Supabase project `buzidwccluskdkccidev` (electric-emporium-ops):

- Deployed version: **4**, deployed 2026-08-01
- Archived: 2026-08-16, retrieved via the Supabase management API, **before**
  the PIN-hash rewrite of the function (backlog item: move the PIN check off
  plaintext `users.pin` onto `pin_hash`)
- Function id: `72ec771d-bdd7-43de-86b9-cf109bafdf50`, deployed with
  `verify_jwt: true` (deploy-time setting — must be preserved on redeploy)
- Deployed bundle ezbr_sha256:
  `f8acfdaaf6e7d9437ed34fc6ef5f464f4696437ddbeba32cf26b47c50c4efb0c`

**This is the rollback target.** If the PIN-hash rewrite of `shop-write`
misbehaves, redeploy this file unchanged. Note the rollback is only valid
while the plaintext `users.pin` column still exists — this version reads it
directly.

Do not edit, reformat, or "fix" this file. Known issues stay as deployed; the
point of the archive is that it matches what is running.
