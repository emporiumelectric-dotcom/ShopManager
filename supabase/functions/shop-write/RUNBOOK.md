# shop-write PIN-hash rewrite — deployment & verification runbook

Scope: deploying the rewritten `index.ts` (PIN check via
`public.shop_write_check_pin`, no reads of plaintext `users.pin`) to project
`buzidwccluskdkccidev`, verifying it with a **disposable test user**, and
rolling back to the archived v4 if needed.

> Sections 0–4 are the v5 (PIN-hash) record and reference. **Section 5**
> covers the v6 session-token deploy (checklist 1.2.4) — written, NOT yet
> deployed.

Never use a real staff PIN for any step in this runbook. All verification
uses throwaway user id **9004**, which this runbook creates and deletes.

---

## 0. Execution record — this runbook was run 2026-08-16

The cutover is **done** (checklist 1.2.1). Deviations from the written
procedure, kept here because the sections below stay as the reusable
reference (e.g. for the rollback path):

- **Deploy went through the dashboard Code tab, not the CLI** — the
  `supabase` CLI is not installed on this machine. Section 2's CLI
  command is still the canonical procedure where the CLI exists;
  otherwise paste `index.ts` into Dashboard → Edge Functions →
  shop-write → Code and deploy from there, then do the same
  post-deploy checks (version bump, `verify_jwt` still `true`, bundle
  contains `shop_write_check_pin`, no `from("users")` /
  `timingSafeEqual`).
- 006 was likewise applied via the dashboard SQL editor (the Supabase
  MCP tools were blocked by the permission layer).
- The 007 rehearsal passed clean, but it was run in pieces and the
  dashboard SQL editor does not preserve the enclosing `BEGIN`/`COMMIT`
  across separate runs — the transactional cleanup did not hold, and
  test rows 9002/9003 had to be deleted by hand. Any script here that
  relies on running as one transaction (007, and the cleanup semantics
  in section 3) must be submitted as a single run or via psql.
- Verification passed: preconditions held (all seven users hashed),
  test user 9004 exercised and removed, Owner login worked, a real item
  edit logged a `pin_attempts` success with the caller IP, a wrong PIN
  was rejected, no stray failures.
- **Not done, deliberately: dropping plaintext `users.pin` (1.2.5).**
  It waits until several days of normal shop use by Akshay and Lokesh
  on the new path. Dropping the column invalidates the archived v4
  rollback below, so it goes last.

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

> 2026-08-16: the actual deploy used the dashboard Code tab, not the CLI
> (not installed on this machine) — see section 0. The CLI steps below
> remain the reference for machines that have it.

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

---

## 5. v6 — session-token writes (checklist 1.2.4). Written, NOT deployed

v6 adds `op:"login"` (mints a session token after exactly the v5 PIN
check + throttle + `pin_attempts` logging; token stored only as a
SHA-256 hash in `public.shop_sessions`, ~14h expiry, lazy expired-row
cleanup) and a token path for writes (hash the presented token, look up
a live session, touch `last_used_at`, derive `can_delete` from the
session's user). The PIN path is **unchanged from v5 by design**: the
service worker can serve stale `index.html` for days, so old cached
clients keep writing with `{userId, pin}` throughout the rollout.

Token failures are deliberately **never** logged to `pin_attempts` —
they are not PIN attempts, and per-user logging there would let anyone
who knows a userId lock that user out of writes by spamming garbage
tokens. Expired sessions return a distinguishable
`{"code":"session_expired"}` so the client can re-prompt and retry
instead of treating it as a bad token.

### 5.1 Preconditions

1. `sql/session-tokens/001_shop_sessions.sql` applied to production and
   the `002` rehearsal passed clean (both done 2026-08-16: format CHECK
   rejects raw tokens, expiry predicate works, anon/authenticated denied
   on table and sequence, RLS enabled, FK cascade removes sessions on
   user delete, no rows left behind).
2. v5 verified in production (section 0) — v6 is additive on top of it.
3. Grant sanity: `service_role` holds ALL on `public.shop_sessions`
   (asserted by rehearsal 002's check 7).

### 5.2 Deploy

Dashboard Code tab, as for v5 (no CLI on this machine): paste `index.ts`
into Dashboard → Edge Functions → shop-write → Code and deploy.
`verify_jwt: true` is a deploy-time setting and **must be preserved**.

Post-deploy checks (function id `72ec771d-bdd7-43de-86b9-cf109bafdf50`):

- version bumped (5 → 6), `verify_jwt` still `true`,
- the bundle contains `shop_sessions`, `session_expired`, `op === "login"`
  markers, and still contains `shop_write_check_pin`,
- **the v5 "no `from("users")`" check is obsolete in v6.** The token path
  legitimately reads `users` — the invariant is now narrower: the ONLY
  `from("users")` in the bundle selects `id, name, role, can_delete`, and
  the bundle contains no read of the `pin` column.

### 5.3 Verify with a disposable test user (id 9006)

Create the test user as in 3.1 but with **id 9006** (9004 was the v5
run, 9005 the 002 rehearsal) and name `RUNBOOK_V6_TEST`. Caller token as
in 3.2, `call()` helper as in 3.3.

Run **in this order** (the per-user lockout budget is spent
deliberately; steps 7–8 depend on it):

| # | Call | Expect |
|---|------|--------|
| 1 | **OLD-CLIENT PROOF** — v5-shape write, correct PIN:<br>`{"userId":9006,"pin":"4242","op":"update","table":"items","match":{"id":-1},"values":{"name":"x"}}` | `200`, `{"data":[]}` — the pin path still works; a `pin_attempts` success row with caller IP |
| 2 | **OLD-CLIENT PROOF** — same body with `"pin":"0000"` | `401`, `{"error":"Invalid user or PIN"}` (failure #1) |
| 3 | login: `{"op":"login","userId":9006,"pin":"4242"}` | `200`, `{token, expiresAt, user}` with `expiresAt` ~14h out and `user.id = 9006`; a `pin_attempts` success row; exactly one `shop_sessions` row whose `token_hash` equals `encode(extensions.digest('<token>','sha256'),'hex')` and is **not** the token itself |
| 4 | token write: `{"token":"<token from #3>","op":"update","table":"items","match":{"id":-1},"values":{"name":"x"}}` | `200`, `{"data":[]}`; `last_used_at` bumped; **no new `pin_attempts` row** |
| 5 | garbage token: same body with `"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"` | `401`, `{"error":"Invalid session","code":"invalid_session"}`; **no `pin_attempts` row** (the lockout-DoS guard — this is the check that matters most) |
| 6 | expiry: `UPDATE public.shop_sessions SET expires_at = now() - interval '1 second' WHERE user_id = 9006;` then repeat #4 | `401`, `{"error":"Session expired","code":"session_expired"}` — distinguishable from #5. Then log in again (#3 shape) for a fresh token; keep it for #8 |
| 7 | lockout independence, part 1: four more wrong-PIN calls (#2 shape; failures #2–5), then `{"op":"login","userId":9006,"pin":"4242"}` with the **correct** PIN | wrong-PIN calls `401` each; the login `429` — the user lockout blocks new logins as before |
| 8 | lockout independence, part 2: repeat #4 with the live token from #6's re-login | `200` — an **established session is immune to the PIN lockout**; staff can no longer be knocked out mid-shift |

`pin_attempts` check (3.4 query, `user_id = 9006`): successes from
#1/#3/#6-relogin, five failures from #2/#7, and **nothing at all** from
#4/#5/#6's token calls — token traffic must be invisible to
`pin_attempts`.

Function logs (3.5): the v5 warn shapes for #2/#7, plus
`unknown session token` for #5, `expired session` for #6,
`session minted` for #3/#6-relogin. No 500s, no
`permission denied for table shop_sessions` (would mean the 001 grants
regressed).

Cleanup (scoped to the test id only):

```sql
DELETE FROM public.pin_attempts WHERE user_id = 9006;
DELETE FROM public.users WHERE id = 9006;  -- FK cascade removes its shop_sessions rows
-- verify: all three return 0
SELECT count(*) FROM public.pin_attempts WHERE user_id = 9006;
SELECT count(*) FROM public.users WHERE id = 9006;
SELECT count(*) FROM public.shop_sessions WHERE user_id = 9006;
```

Real-world smoke test as in 3.7 — one normal write through the app UI by
a staff member. Note that until the new client ships, this exercises the
**pin path** (that is the point: old clients must keep working).

### 5.4 Rollback ordering — CLIENT FIRST, FUNCTION SECOND

The dual-path design **inverts the usual rollback order**:

- v6 serves both client generations. If the new (token) client
  misbehaves after the Pages deploy, roll back the **Pages deploy**
  (old `index.html`) and leave v6 running — old clients use the pin
  path v6 preserves unchanged.
- Rolling the **function** back to v5 while token-sending clients exist
  strands them: v5 answers token bodies with
  `400 "userId and pin are required"`. Only redeploy v5 after the Pages
  rollback is confirmed on the actual installed shop PWAs —
  service-worker propagation included, not just a fresh browser tab.
- The v4 archive rules in section 4 are unchanged (v4 still requires
  `users.pin` to exist, which is why the column drop stays last).
- `shop_sessions` can stay in place under any rollback — v4/v5 never
  touch it. Stale session rows expire on their own and are swept by the
  next v6 login.
