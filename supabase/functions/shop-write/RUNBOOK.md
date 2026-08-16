# shop-write PIN-hash rewrite — deployment & verification runbook

Scope: deploying the rewritten `index.ts` (PIN check via
`public.shop_write_check_pin`, no reads of plaintext `users.pin`) to project
`buzidwccluskdkccidev`, verifying it with a **disposable test user**, and
rolling back to the archived v4 if needed.

Never use a real staff PIN for any step in this runbook. All verification
uses throwaway user id **9004**, which this runbook creates and deletes.

---

## 1. Preconditions (all must hold before deploying)

1. `sql/pin-hashing/006_shop_write_check_pin.sql` applied to production
   (done 2026-08-16) and `007` rehearsal passed clean.
2. **Every live user row has a hash.** The rewritten function has no
   plaintext fallback — a `NULL pin_hash` user cannot write at all:

   ```sql
   SELECT id, name FROM public.users WHERE pin_hash IS NULL;
   ```

   Must return **0 rows**. If it doesn't, backfill first (`002`), do not
   deploy.
3. Grant sanity (the function calls the helper as `service_role`):

   ```sql
   SELECT has_function_privilege('service_role',
     'public.shop_write_check_pin(bigint, text)', 'EXECUTE');  -- must be true
   ```

## 2. Deploy

`verify_jwt: true` is a **deploy-time setting and must be preserved** — it is
what forces callers through the Supabase session handshake before the
function runs.

From the repo root:

```sh
supabase functions deploy shop-write --project-ref buzidwccluskdkccidev
```

- Do **not** pass `--no-verify-jwt`. The CLI defaults to `verify_jwt: true`;
  the flag would turn it off.
- (Equivalent: the Supabase MCP `deploy_edge_function` tool — if used,
  explicitly confirm the verify_jwt setting is not dropped in the call.)

Immediately after deploy, confirm via the management API / dashboard
(function id `72ec771d-bdd7-43de-86b9-cf109bafdf50`):

- version bumped (4 → 5),
- `verify_jwt` is still `true`,
- the new bundle's source contains `shop_write_check_pin` and does **not**
  contain `from("users")` or `timingSafeEqual`.

## 3. Verify with a disposable test user

### 3.1 Create the test user (SQL editor / psql, service role)

Id 9004 — outside the live range 1–7 and distinct from rehearsal ids
9001–9003. `OVERRIDING SYSTEM VALUE` because `users.id` is GENERATED ALWAYS
AS IDENTITY; explicit `pin_hash` because the sync trigger fires on UPDATE OF
pin only.

```sql
-- pre-flight: id must be free
SELECT count(*) FROM public.users WHERE id = 9004;          -- expect 0
SELECT count(*) FROM public.pin_attempts WHERE user_id = 9004;  -- expect 0

INSERT INTO public.users (id, name, role, pin, can_delete, pin_hash)
OVERRIDING SYSTEM VALUE
VALUES (9004, 'RUNBOOK_TEST', 'test', '4242', false,
        extensions.crypt('4242', extensions.gen_salt('bf')));
```

### 3.2 Get a caller token

`verify_jwt` requires a valid Supabase session. Obtain one the same way the
app does — anonymous sign-in — e.g. in a browser console on the app, or any
supabase-js client:

```js
const { data } = await supabase.auth.signInAnonymously();
// data.session.access_token is the Bearer token below
```

### 3.3 Test matrix (curl; ANON = anon key, TOK = access token)

```sh
URL=https://buzidwccluskdkccidev.supabase.co/functions/v1/shop-write
call() { curl -s -w '\n%{http_code}\n' "$URL" \
  -H "Authorization: Bearer $TOK" -H "apikey: $ANON" \
  -H "Content-Type: application/json" -d "$1"; }
```

Run **in this order** (the per-user lockout counts failures; the sequence
budgets them deliberately):

| # | Call | Expect |
|---|------|--------|
| 1 | correct PIN, harmless no-op write:<br>`{"userId":9004,"pin":"4242","op":"update","table":"items","match":{"id":-1},"values":{"name":"x"}}` | `200`, `{"data":[]}` — nothing matched, nothing written |
| 2 | wrong PIN: same body with `"pin":"0000"` | `401`, `{"error":"Invalid user or PIN"}` (failure #1) |
| 3 | no-fallback proof: `UPDATE public.users SET pin_hash = NULL WHERE id = 9004;` then repeat call 1 (correct plaintext PIN) | `401` — proves the deployed function does not fall back to `users.pin`, which still holds `4242` (failure #2). Then restore: `UPDATE public.users SET pin_hash = extensions.crypt('4242', extensions.gen_salt('bf')) WHERE id = 9004;` |
| 4 | can_delete gate: correct PIN, `"op":"delete","table":"items","match":{"id":-1}` | `403`, `{"error":"Not authorized for this action"}` (test user has `can_delete=false`; logged as a *success* attempt, not a failure) |
| 5 | three more wrong-PIN calls (failures #3–5) | `401` each |
| 6 | any further call for user 9004, even with the correct PIN | `429`, `{"error":"Too many failed attempts for this user. Try again later."}` |

### 3.4 Check pin_attempts

```sql
SELECT user_id, ip, success, created_at
FROM public.pin_attempts WHERE user_id = 9004 ORDER BY created_at;
```

Expect: rows for every call above (2 successes from #1/#4, 5 failures), and
`ip` showing your real client IP — **not** `"unknown"` (that would mean the
`x-forwarded-for` handling regressed).

### 3.5 Check the function logs

Dashboard → Edge Functions → shop-write → Logs (or `query_logs`):

- `shop-write: failed PIN check for user 9004 from <ip>` warns for each 401,
  and the lockout warn for the 429 — same shapes as v4.
- **No** `permission denied for function shop_write_check_pin` (would mean
  the service_role grant is missing — rollback and re-apply 006).
- No unexpected 500s or unhandled exceptions.

### 3.6 Cleanup (scoped to the test id only)

```sql
DELETE FROM public.pin_attempts WHERE user_id = 9004;
DELETE FROM public.users WHERE id = 9004;
-- verify: both of these return 0
SELECT count(*) FROM public.pin_attempts WHERE user_id = 9004;
SELECT count(*) FROM public.users WHERE id = 9004;
```

Deleting the pin_attempts rows also clears the test lockout immediately.

### 3.7 Real-world smoke test

Have one normal write performed through the app UI by a staff member (their
own PIN, entered by them — do not collect it). Confirm it succeeds and a
`success=true` pin_attempts row appears.

## 4. Rollback

Target: **deployed v4**, archived verbatim at commit `074f5c9` (plaintext-PIN
version; see README.md). Valid **only while the `users.pin` column still
exists** — v4 reads it directly.

```sh
git show 074f5c9:supabase/functions/shop-write/index.ts > /tmp/shop-write-v4.ts
# replace supabase/functions/shop-write/index.ts with that file on a
# temporary branch (do not commit it over the rewrite), then:
supabase functions deploy shop-write --project-ref buzidwccluskdkccidev
```

- Again: **no `--no-verify-jwt`** — verify_jwt must stay `true`.
- Confirm version bumped and the deployed source matches the archive
  (v4 bundle ezbr_sha256
  `f8acfdaaf6e7d9437ed34fc6ef5f464f4696437ddbeba32cf26b47c50c4efb0c`).
- Re-run 3.1–3.3 calls #1 and #2 with a fresh disposable user to confirm
  writes work again, then clean up per 3.6.
- The `shop_write_check_pin` helper can stay in place during rollback — v4
  never calls it and it grants nothing to client roles.
