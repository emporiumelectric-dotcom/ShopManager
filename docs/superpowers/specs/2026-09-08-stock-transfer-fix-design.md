# Fix Transfer Stock (design)

Date: 2026-09-08
Status: approved, pending implementation
Related backlog entry: `BACKLOG.md` → Open → "`dbTransferStock` (Transfer Stock feature) is broken in production."

## Problem

`dbTransferStock` (`index.html`) inserts a `transactions` row with `type:"transfer"`.
Production's `transactions_type_check` CHECK constraint only allows `'in'`/`'out'`,
confirmed live via the Supabase MCP:

```
transactions_type_check: CHECK ((type = ANY (ARRAY['in'::text, 'out'::text])))
SELECT DISTINCT type FROM transactions; -- => 'in', 'out' only (397 rows total)
```

Every transfer attempt has always failed. The failure is caught silently by
`dbTransferStock` (returns `false`, generic toast) — staff may not have
noticed the feature never worked.

Also confirmed live: `item_locations` (the table backing per-location stock
and Transfer) has 0 rows, and its `item_id` column is `bigint` while
`items.id` is `uuid` — a type mismatch that has made a real foreign key
(and therefore any successful row) impossible since the table was created.
There's already a `UNIQUE (item_id, location_id)` constraint on it (the
client's `onConflict:"item_id,location_id"` upsert already depends on this
existing), but no FKs at all.

## Decision

User decision (2026-09-08): **keep Transfer, fix it properly** — make it a
real third transaction type, fix the `item_locations` type mismatch, and
give it the same atomic+idempotent treatment `record_txn` (sale/stock-in)
got in the immediately preceding change (`sql/atomic-transactions/`).

Rationale: most of the plumbing already assumes Transfer is a first-class
type — `shop-write`'s `TABLE_FIELDS` already allow-lists
`from_location_id`/`to_location_id` on `transactions`; the History tab
already renders a From/To badge for `entry.type==="transfer"`; dashboard
aggregates already filter strictly on `type==="out"`/`"in"` so a third type
is naturally excluded from sale/stock-in totals with no code change needed.
The only things standing between "wired up" and "working" are the CHECK
constraint and the `item_locations` type bug — and since `dbTransferStock`
today does the exact same unsafe multi-call sequence (no idempotency key,
partial-failure leaves inconsistent state) that was just fixed for
sale/stock-in, fixing it partially (constraint only) would ship a working
feature with a known class of bug already fixed everywhere else it occurs.

Explicitly out of scope: no guard against transferring more than a
location's current stock (can go negative) — this matches
`dbTransferStock`'s and `dbUpdateLocStock`'s current behavior exactly, not
a new gap. Not touching `locations.store_id` being `text` while `stores.id`
is `uuid` (found in passing, works today via Postgrest's implicit cast,
same *kind* of latent mismatch but unrelated to this fix and not blocking
anything).

## Design

### 1. Schema migration — `sql/stock-transfer/001_stock_transfer.sql`

Idempotent, single file, applied via the Supabase MCP (`apply_migration`)
directly against `buzidwccluskdkccidev` — user chose this over hand-pasting
into the dashboard SQL editor, since a working MCP path is now available
(first real use of it; verifies the tool path as a side effect).

- Pre-flight guard: abort with `RAISE EXCEPTION` if `item_locations` has
  any rows (expected 0 — re-verified immediately before the ALTER, not
  just trusted from this design doc).
- `ALTER TABLE item_locations ALTER COLUMN item_id TYPE uuid USING item_id::text::uuid` —
  safe because the pre-flight proved 0 rows; the `USING` expression is
  never evaluated against real data.
- Add FKs: `item_locations.item_id → items(id)`,
  `item_locations.location_id → locations(id)` (guarded — `IF NOT EXISTS`
  via `pg_constraint` check, matching the repo's existing idiom).
- Widen `transactions_type_check` to
  `CHECK (type IN ('in','out','transfer'))` (drop + recreate under the
  confirmed name `transactions_type_check`).
- New function `public.shop_write_record_transfer(p_request_id uuid,
  p_store_id uuid, p_from_location_id bigint, p_to_location_id bigint,
  p_txn_date date, p_by_user text, p_lines jsonb)`:
  - `plpgsql`, `SECURITY DEFINER`, `SET search_path = public` — same
    shape as `shop_write_record_transaction`.
  - Validates: `request_id` required; `from_location_id`/`to_location_id`
    required and not equal; `lines` non-empty; each line has a valid
    `item_id`/`qty > 0`.
  - Idempotency: looks up `transactions.request_id` first; if found,
    returns that transaction with `replayed: true` without touching stock
    again. A `unique_violation` on insert (concurrent replay) is caught
    and treated as a replay, same pattern as `shop_write_record_transaction`.
  - Per line: insert `transaction_items` (no `location_id` set on the
    line — matches current `dbTransferStock` behavior, since from/to
    already live on the parent `transactions` row); upsert
    `item_locations` at `from_location_id` with `qty = qty - line_qty`
    (row created at `-line_qty` if none exists) and at `to_location_id`
    with `qty = qty + line_qty`.
  - `items.qty` (the aggregate total) is **not** touched — a transfer
    doesn't change how much stock exists, only where it is.
  - Insert `transactions` with `type='transfer'`, `from_location_id`,
    `to_location_id`, `store_id`, `txn_date`, `by_user`, `request_id`
    (`ref`/`supplier` left null, matching current behavior).
  - Returns `{txn_id, replayed, item_locations: [{item_id, location_id,
    qty}, ...]}` — authoritative post-transfer quantities for every
    `(item, location)` pair touched, for the client to apply directly
    (mirrors `shop_write_record_transaction`'s returned `items` array).
  - `REVOKE ALL ... FROM PUBLIC/anon/authenticated`, `GRANT EXECUTE ...
    TO service_role` only.

### 2. `sql/stock-transfer/002_stock_transfer_rehearsal.sql`

Same shape as `sql/atomic-transactions/002_record_transaction_rehearsal.sql`:
throwaway store + 2 items + 2 locations, self-cleaning, run as one
transaction.

1. Pre-flight (function exists, no leftover test rows).
2. First transfer call → new transaction, `item_locations` at from/to
   updated correctly, `replayed:false`.
3. Replay: same `request_id`, different lines/qty → same `txn_id`,
   `replayed:true`, `item_locations` **unchanged** from step 2 (proves the
   replay short-circuits, doesn't just happen to be safe).
4. Second real transfer (different `request_id`) → stock moves again.
5. Guards: `from_location_id = to_location_id` rejected; empty `lines`
   rejected.
6. EXECUTE ACL: `anon`/`authenticated` denied at call time.
7. Cleanup: scoped deletes (transaction_items, transactions, item_locations,
   items, locations, store) + zero-rows verification.

### 3. `supabase/functions/shop-write/index.ts`

- Add `fromLocationId, toLocationId` to the destructured request body.
- New `op === "record_transfer"` branch, mirroring the existing
  `op === "record_txn"` branch: validate required fields present, call
  `admin.rpc("shop_write_record_transfer", {...})`, return `{data}` or
  the error.
- No changes to `TABLE_FIELDS` (already has `from_location_id`/
  `to_location_id` on `transactions` from the earlier change) or to
  `requiresCanDelete`.
- Deployed via the dashboard Code tab as usual (RUNBOOK's existing
  process — Edge Function deploy via MCP is unverified, out of scope for
  this change to start relying on).

### 4. `index.html`

- `dbTransferStock(fromLocId, toLocId, lines)` rewritten to call
  `callWrite("record_transfer", null, {requestId, storeId, fromLocationId,
  toLocationId, txnDate, byUser, lines})` instead of the current sequence
  (2× `dbUpdateLocStock` per line + insert `transactions` + insert
  `transaction_items`). Applies the RPC's returned `item_locations` array
  to `ST.itemLocs` directly (same pattern `dbRecordTransaction` uses for
  `ST.inv`), rather than each line re-reading-then-upserting.
- New `ST.trReqId` state, following `ST.saleReqId`/`ST.siReqId`'s exact
  lifecycle: generated once per attempt (`ST.trReqId = ST.trReqId ||
  crypto.randomUUID()`), held across a failed attempt so retry replays
  instead of double-transferring, cleared on success, on `cleartr`, and on
  `logout()`.
- `doTransfer` unchanged in shape — still calls `dbTransferStock`, still
  reloads via `loadStoreData` on success.

### 5. Tests — `scripts/test-transfer-stock.cjs`

Same vm-harness slice-and-run approach as
`scripts/test-record-transaction.cjs`: wire contract (`op:"record_transfer"`,
payload fields, `table:null`), applies server-returned `item_locations` to
`ST.itemLocs`, failure path alerts/returns `false`/touches nothing, replay
response applied the same way as a fresh write. Picked up automatically by
`scripts/run-tests.cjs`'s `test-*.cjs` glob.

### 6. `BACKLOG.md`

Move the entry to Resolved, in the existing style: what was broken, what
changed, what was verified (rehearsal + live smoke test with a throwaway
store/items/locations, mirroring the record_txn resolution's verification
notes), and the explicitly-out-of-scope note (no over-transfer guard;
`locations.store_id` type note as a new, separate Open item if the user
wants it tracked).

## Testing / verification plan

1. Apply `001` via Supabase MCP `apply_migration`.
2. Run `002` rehearsal via `execute_sql`, confirm every `RAISE NOTICE
   ... PASSED` step and clean cleanup.
3. `node scripts/run-tests.cjs` — all files including the new
   `test-transfer-stock.cjs` pass.
4. Deploy `shop-write` via the dashboard Code tab (per RUNBOOK); confirm
   version bump and bundle contains `record_transfer`/
   `shop_write_record_transfer`.
5. One real transfer through the app UI (throwaway/low-risk items) to
   confirm end-to-end, then check the resulting `transactions`/
   `item_locations` rows and clean up if using test data.
6. Update `BACKLOG.md`.

## Open questions / risks

- None outstanding — schema facts were confirmed live via the Supabase MCP
  rather than assumed (see "Problem" section for the actual query
  results), and the one product decision (keep vs. rework vs. remove) was
  made by the user before this doc was written.
