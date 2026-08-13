# PIN hashing package - notes, risks, open questions

Scope reminder: this package only moves `verify_pin`'s comparison from
plaintext to hash. `users.pin` and the `shop-write` Edge Function comparison
site are deliberately untouched. Nothing in this package has been executed
or run against any database - all four files are written, unreviewed SQL for
a human to apply.

## Ordering

Apply in file order: `001` -> (manual check) -> `002` -> `003` (rehearsal,
against a real or branch/staging DB, not production during shop hours) ->
only then trust `002` for the 7 live staff. `004` is the rollback if `002`
needs to be reverted.

## Risks / things I was unsure about

- **`gen_salt('bf')` uses pgcrypto's default cost factor (6).** For a
  4-digit PIN the keyspace is only 10,000 values, so the cost factor barely
  matters against an *offline* brute force of a leaked hash - trying all
  10,000 bcrypt candidates per row is fast regardless of cost factor within
  any reasonable range. Hashing here mainly protects against casual exposure
  of a DB dump (no PIN is visible at a glance) and defense-in-depth, not
  against a determined offline attacker with the hash in hand. The real
  protection against *online* guessing is still the existing throttle (5
  failures / 15 min), which this package leaves untouched. I did not raise
  the cost factor above the pgcrypto default since nothing in the brief
  asked for it and it doesn't materially change the security posture for a
  4-digit PIN - flagging it here in case that tradeoff should be revisited
  (e.g. moving to longer PINs is the more effective fix, not a bigger cost
  factor).

- **The plaintext fallback is a silent, ongoing state, not just a
  migration-night safety net.** As designed (and as instructed), any row
  where `pin_hash IS NULL` keeps authenticating via plaintext comparison
  indefinitely, with no error or warning surfaced anywhere. If `001`'s
  backfill silently fails for one row (e.g. a future row inserted with a
  null PIN, or a constraint issue), that user keeps working via the fallback
  and nobody would notice without deliberately re-running the verification
  query in `001`'s trailing comment. I did not add an alerting mechanism
  since none was requested and this task is DB-only (no scheduled jobs) -
  worth a periodic manual check if this matters long-term.

- **`003`'s auto-rollback-on-failure depends on the whole file running as
  one transaction.** I wrote it so any `RAISE EXCEPTION` aborts and rolls
  back everything, including the inserted test user, as a safety net beyond
  the explicit cleanup `DELETE`s. That only holds if it's run through a
  client that honors `BEGIN`/`COMMIT` as a single transaction (e.g. `psql`,
  or "Run" in an editor that doesn't auto-split statements). A tool that
  autocommits per statement would not get that safety net if something fails
  mid-script; the explicit cleanup block at the end still handles the normal
  success path, but I'd recommend running `003` via `psql` specifically.

- **`003`'s attempt-log assertion (7 rows: 1 success + 6 failures) is
  tightly coupled to the exact number of calls in the script.** If the
  script is later edited to add/remove a step without updating that
  assertion, it will false-fail (safely - it just won't clean up until fixed
  and rerun, since the failure trips the transaction rollback).

- **`004` clears *all* `pin_attempts` for ids 1-7**, not just failed ones -
  per your instruction ("clears pin_attempts rows for user_ids 1-7"). That
  also erases successful-attempt history for those 7 users, not only the
  lockout-causing failures. Flagging this as a read of the instruction, not
  an oversight - a narrower `AND success = false` filter would leave
  successful-attempt history intact if that's preferred instead.

- **Whether `pin_attempts.user_id` has a foreign key to `users.id`** wasn't
  in the established facts I was given, so I don't know if deleting a
  `users` row before its `pin_attempts` rows would fail on an FK constraint.
  `003` deletes `pin_attempts` before `users` defensively; `004` doesn't
  touch `users` at all so this doesn't apply there.

- **I did not verify `pin_attempts.id`'s default (identity/serial) or any
  other constraint beyond what was given** ("id bigint, user_id bigint, ip
  text, success boolean, created_at timestamptz") - the scripts never insert
  into `pin_attempts` directly (only `verify_pin` does, matching the
  original function's own inserts), so this shouldn't matter, but it's
  unverified since I couldn't inspect the live schema further.

- **Concurrent staff logins during the `002` cutover window.** `002` is a
  single `CREATE OR REPLACE FUNCTION` statement wrapped in `BEGIN/COMMIT`,
  so the exposure window is effectively one fast DDL statement - but I have
  no visibility into shop traffic patterns. Recommend applying during a
  low-traffic moment regardless.

## What I did NOT do (out of scope, per your constraints)

- Did not modify or drop `users.pin`.
- Did not touch the `shop-write` Edge Function or any client code
  (`index.html`, etc.).
- Did not change `verify_pin`'s signature, `RETURNS TABLE` shape, security
  attributes, or throttle behavior.
- Did not execute, connect to, or otherwise touch any database.
- Did not push anything (committed locally to `feat/pin-hashing` only).
