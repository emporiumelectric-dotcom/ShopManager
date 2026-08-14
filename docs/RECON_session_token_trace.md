# Recon: staff session token trace (read-only)

Scope: current app only (`index.html` in this repo). Did not read/reference
`ElectricEmporium_ShopManager.html` per instructions. Did not connect to
Supabase, run SQL, or query any database — DB-side definitions (`verify_pin`
body, `shop-write` Edge Function body, RLS policies) are **not in this repo**
and could not be inspected; anything about their internals below is quoted
from `BACKLOG.md` commentary, not observed directly.

## 1. Config bootstrap: config.json → Supabase client

- `index.html:219-220` loads `vendor/supabase-2.112.2.js` then
  `config-validation.js` (exposes `window.EEConfigValidation`).
- `index.html:237-256` `loadConfig()`: `fetch("config.json",{cache:"no-store"})`,
  reads body as text, passes it to
  `EEConfigValidation.validateConfigBody(body)` (`config-validation.js:42-134`).
- Validator (`config-validation.js`) requires:
  - valid JSON, no literal `"PLACEHOLDER"` substring (`:54`)
  - `config.url` is `https://buzidwccluskdkccidev.supabase.co` exactly
    (host pinned, `:18,81`)
  - `config.anonKey` is a **3-segment legacy JWT** whose base64url-decoded
    payload has `role === "anon"`, `ref === "buzidwccluskdkccidev"`, and a
    numeric `exp` that hasn't passed (`:89-120`). A new-format
    `sb_publishable_...` key would **fail** this validator (noted explicitly
    in `BACKLOG.md:19-20` as an open migration item — not yet done).
  - `config.generatedAt` non-empty string.
  - On success returns `{url, anonKey, generatedAt}` only.
- `index.html:1585-1601` `init()`: on validation failure calls
  `renderStartupError()` and stops. On success:
  `SUPABASE_URL=cfg.url; SUPABASE_KEY=cfg.anonKey;`
  `WRITE_FN_URL = SUPABASE_URL + "/functions/v1/shop-write"`;
  `sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)`.

**`config.json` itself is not in git** (it's deploy-generated — see
`.gitignore`/`config.template.json`). Its generation:
- `config.template.json` holds `**PLACEHOLDER**` values for `url`/`anonKey`/`generatedAt`.
- `scripts/build-config.cjs:15-16` fills them from env vars
  `SUPABASE_URL` and `SUPABASE_ANON_KEY`, stamps `generatedAt`, then
  re-runs `validateConfigBody` on the generated body before writing the file
  (`wx` flag — refuses to overwrite an existing file).
- `.github/workflows/deploy-pages.yml:40-48` supplies those env vars from
  GitHub Actions repo secrets `secrets.SUPABASE_URL` /
  `secrets.SUPABASE_ANON_KEY`, then runs `build-config.cjs` and
  `scripts/validate-config-file.cjs` before publishing `dist/` (including
  `config.json`) to GitHub Pages. Deploy is manual-dispatch only
  (`DEPLOYMENT.md:5-9`).
- `DEPLOYMENT.md:26-28`: `config.json` (and thus the anon key) is
  **intentionally public** — "Authorization continues to depend on
  server-side controls, including RLS and the … `shop-write` Edge Function
  path", not on hiding the key.

**Key in play at this stage: the legacy Supabase `anon` JWT** (not a
publishable key — see above). This is the only key ever loaded into the
client; there is no separate service-role or publishable key anywhere in
`index.html`, `config-validation.js`, or `scripts/build-config.cjs`.

## 2. Supabase Auth session: anonymous sign-in

- Immediately after client creation, `index.html:1602`:
  `var {error:authErr} = await sb.auth.signInAnonymously();`
  This runs **before any user picks a name or enters a PIN**. If it errors,
  init aborts with a "Could not connect" message and the app never renders
  login.
- This is what populates the Supabase Auth session that
  `sb.auth.getSession()` later returns (`index.html:263`). Per
  `BACKLOG.md:10-13`: *"the PWA may obtain its `authenticated` token from
  anonymous sign-in"* and *"`shop-write` runs `verify_jwt: true`"* — i.e.
  the JWT used to authorize calls to the `shop-write` Edge Function is
  believed (per that backlog note, not verified here against the live
  project) to be the anonymous-sign-in token, not something derived from the
  staff PIN. `BACKLOG.md:11` also flags that live Supabase advisors report
  `auth_allow_anonymous_sign_ins` as enabled on all six read tables — an
  open/unresolved item, not something this recon changed.
- **No PIN and no staff identity is involved in this Auth session at all.**
  It exists purely so the browser has *some* Supabase JWT to present.

## 3. Staff PIN login (`verify_pin`) — app-level identity, separate from Supabase Auth

- Login UI: `index.html:524-539` (`renderLogin`) — user picks their name
  (from `ST.users`, populated by `fetchUsers()`) and store from `<select>`
  dropdowns, then types a PIN into `#lp` (`type="password"`,
  `autocomplete="current-password"`, `maxlength="6"`).
- `fetchUsers()` (`index.html:376-380`):
  `sb.from("users_public").select("id,name,role,can_delete")` — reads from a
  view named `users_public` that exposes only `id,name,role,can_delete`.
  **No PIN or PIN hash column is selected or exposed here.**
- **Exact current call signature** (`index.html:545`):
  ```js
  var {data,error} = await sb.rpc("verify_pin", {p_user_id: uid, p_pin: pin});
  ```
  - `uid` = the selected user's `id` (string, from the `<select>` value).
  - `pin` = raw text typed by the user, trimmed (`index.html:541`:
    `(G("lp").value||"").trim()`), sent **in plaintext** over this RPC call.
- **Return shape as consumed by the client** (`index.html:546-548`):
  ```js
  if(error || !data || !data.length){ /* "Wrong user or PIN." */ }
  var u = data[0];
  ST.user = {id:u.id, name:u.name, role:u.role,
             canDelete: u.role==="owner" || !!u.can_delete, pin:pin};
  ```
  So `data` is an **array of rows** (empty array/no rows = wrong PIN,
  wrong user, *or* throttled — the client cannot distinguish these, by
  design per `BACKLOG.md:34`: "a locked correct PIN is indistinguishable
  from a wrong PIN"). The client only reads `u.id`, `u.name`, `u.role`,
  `u.can_delete` from the returned row. Whether the RPC's actual SQL
  `RETURNS TABLE` definition includes additional columns (e.g. a PIN hash)
  **cannot be determined from this repo** — the function body lives in the
  Supabase project, not in git (no `supabase/` dir, no `.sql` files tracked
  here). The client code simply never reads or transmits any such column if
  present.
- Per `BACKLOG.md:32-37` (resolved 2026-08-12, described there, not verified
  live by this recon): `verify_pin` is `plpgsql`, `SECURITY DEFINER`, counts
  failed `pin_attempts` rows for that `user_id` in the last 15 minutes, and
  returns zero rows silently at 5+ failures.
- Per `BACKLOG.md:5-8` (open item, unresolved): `users.pin` is stored in
  **plaintext** in the database and `verify_pin` compares the raw value —
  hashing has not been implemented as of this recon.

This PIN check is **entirely independent of Supabase Auth** — it's an RPC
call (authorized only by whatever Supabase Auth session already exists, i.e.
the anonymous session from step 2, plus the `apikey` header carrying the anon
key) against app data, not a `sb.auth.signIn*` call. Logging in as staff does
**not** create or replace any Supabase Auth session/JWT.

## 4. Where the raw PIN goes after login

- `index.html:548` stores the **raw PIN the user just typed** in memory:
  `ST.user.pin = pin`. This is a plain JS object, held only in page memory —
  confirmed by search: **no `localStorage`, `sessionStorage`, or
  `indexedDB` calls anywhere in `index.html`**. A page reload wipes `ST`
  entirely and forces re-login (`ST` initial state at `index.html:285-292`
  has `user:null`).
- Every subsequent write goes through `callWrite()` (`index.html:261-279`),
  which re-sends that same plaintext PIN on **every write request**:
  ```js
  body: JSON.stringify(Object.assign(
    {userId: ST.user?ST.user.id:null, pin: ST.user?ST.user.pin:null,
     op:op, table:table}, opts))
  ```
  posted to `WRITE_FN_URL` (`${SUPABASE_URL}/functions/v1/shop-write`) with
  headers `Authorization: Bearer <token>` and `apikey: SUPABASE_KEY`
  (`index.html:267-269`), where `token` is
  `session.access_token` from `sb.auth.getSession()` if present, else falls
  back to the raw `SUPABASE_KEY` (anon key) as the bearer token
  (`index.html:263-264`).
- Comment at `index.html:257-260` states the intent: `shop-write`
  "re-verifies the PIN server-side (with rate limiting) before using its own
  service-role key — direct client writes are blocked by RLS." The
  Edge Function's actual source is not in this repo, so this re-verification
  logic could not be inspected directly here — only the comment and the
  outbound request shape are confirmed from the client code.
- `callWrite` is invoked from ~20 call sites (inventory edits, stock-in,
  transfers, sale/history edits, import, merge duplicates — see
  `index.html:344,352,369,373,427,439,444,450,454,460,477,480,482,497,501,
  503,508,1326,1405,1456,1459`). Every one of them transmits `ST.user.pin`
  in plaintext in the POST body to `shop-write`.
- `verify_pin` itself (`index.html:545`) is called from **exactly one**
  place in the client: the login flow. It is not re-called for writes;
  writes instead resend the raw PIN to `shop-write`, per the comment above.

## 5. Answer to "which key is in play, at each step"

| Step | Key/token used |
|---|---|
| `config.json` fetch | none (static file) |
| `createClient(url, key)` | legacy Supabase **anon** JWT (`cfg.anonKey`), validated to have `role:"anon"` |
| `signInAnonymously()` | anon key as `apikey`, no bearer yet (this call establishes the session) |
| `verify_pin` RPC | anon key as `apikey` header; bearer = whatever `sb.auth.getSession()` returns after anonymous sign-in (Supabase client attaches this automatically) |
| `fetchUsers`/`fetchStores`/`fetchItems`/etc. (plain reads) | same anon key + anonymous-session bearer, via `sb.from(...)` |
| `callWrite` → `shop-write` Edge Function | `apikey: SUPABASE_KEY` (anon key) header + `Authorization: Bearer <anon-session access_token, or anon key itself if no session>`; PIN re-verification happens server-side inside the Edge Function using its own service-role key (per comment, not independently verified) |

No **publishable** key (`sb_publishable_...`) is used anywhere in this repo
today. `BACKLOG.md:15-20` documents this as a planned-but-not-done rotation,
and flags that `config-validation.js` would need to change first since it
currently hard-requires the legacy 3-segment JWT shape.

## 6. Does any raw PIN or PIN-derived value ever reach the client?

Yes, but only the user's **own** PIN, and only as far as it already had to
travel for the user to type it:
- The staff member types their own raw PIN into the client (`#lp`).
- It is sent once to `verify_pin` over the RPC call (plaintext, `p_pin`).
- On success it is **retained in client memory** (`ST.user.pin`, never
  persisted to disk) and **re-sent on every write** to `shop-write`.
- No PIN or PIN hash is ever included in `users_public` (the list used to
  populate the login dropdown), so no user can see any *other* user's PIN or
  PIN hash via the client. Whether `verify_pin`'s returned row could contain
  a hash column the client simply ignores is undetermined from this repo
  (function body not present here).
- `BACKLOG.md:5-8` confirms server-side storage is currently plaintext
  (`users.pin`), which is an open/unresolved backlog item, not something
  addressed by this recon.

## Files/lines touching PIN or session logic (exhaustive, this repo only)

- `index.html:222-226` — `SUPABASE_URL`, `SUPABASE_KEY`, `sb`, `WRITE_FN_URL` globals
- `index.html:237-256` — `loadConfig()` (fetch + validate `config.json`)
- `index.html:257-279` — `callWrite()` (session token retrieval, PIN re-send on writes)
- `index.html:376-380` — `fetchUsers()` (`users_public` view, no PIN column)
- `index.html:524-539` — `renderLogin()` (PIN input field)
- `index.html:540-555` — `doLogin()` (verify_pin call, `ST.user` construction incl. `pin:pin`, storeId set)
- `index.html:556` — `logout()` (clears `ST.user`/session-relevant state, in-memory only)
- `index.html:1584-1611` — `init()` (config load, client creation, `signInAnonymously()`, initial data fetch)
- `index.html:1613-1620` — service worker registration (not session-related; noted for completeness, no PIN/session code)
- `config-validation.js` (whole file) — anon-key JWT shape/role/ref/expiry validation
- `config.template.json` — placeholder shape for `url`/`anonKey`/`generatedAt`
- `scripts/build-config.cjs` — deploy-time `config.json` generation from `SUPABASE_URL`/`SUPABASE_ANON_KEY` env vars
- `scripts/validate-config-file.cjs` — post-generation validation (not read in full this pass; invoked by workflow, same validator)
- `.github/workflows/deploy-pages.yml:40-48` — secrets → env vars → `build-config.cjs`
- `BACKLOG.md:5-41` — narrative notes on PIN plaintext storage, anonymous-sign-in token sourcing, `verify_pin` throttling, and anon-key rotation plan (DB-side facts asserted there, not independently verified by this recon)

## Explicit gaps (could not determine from this repo)

- Exact SQL/plpgsql source of `verify_pin` (columns returned beyond what the
  client reads, exact throttling logic) — not in repo.
- Exact source of the `shop-write` Edge Function (how/whether it
  re-verifies the PIN, what service-role writes it performs) — not in repo.
- Live Supabase project settings (whether `auth_allow_anonymous_sign_ins`
  is actually enabled today, RLS policy bodies, `verify_jwt` setting on
  `shop-write`) — not queried; only quoted from `BACKLOG.md` narrative.
