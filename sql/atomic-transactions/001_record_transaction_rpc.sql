-- 001_record_transaction_rpc.sql
--
-- Root problem: dbRecordTransaction (index.html) does 3 sequential
-- callWrite calls (insert transactions, insert transaction_items, update
-- items.qty per line). A network failure between any of them leaves a
-- partial write, and there was no safe way to retry -- replaying the
-- whole sequence could insert a second transactions row and double-apply
-- the stock delta. This makes the whole sequence one atomic, idempotent
-- DB call keyed by a client-generated request_id: op:"record_txn" in
-- shop-write will call it instead of 3 separate ops.
--
-- Scope: dbRecordTransaction only (type 'in'/'out' -- sale and stock-in).
-- Does NOT touch dbTransferStock's insert (type "transfer") -- that path
-- already violates transactions_type_check in production (confirmed live:
-- distinct type values are only 'in'/'out'), a separate pre-existing bug,
-- out of scope here.
--
-- request_id: nullable, UNIQUE. Nullable so it's a no-op for existing
-- rows and any other insert path into transactions (Postgres allows
-- multiple NULLs under a UNIQUE constraint). Only rows written through
-- this function ever set it.
--
-- Idempotency: same request_id replayed (same call twice, or two
-- concurrent copies of the same failed-then-retried request) returns the
-- SAME transaction, does not re-insert line items or re-apply the qty
-- delta. The insert+loop runs inside a sub-block so a unique_violation
-- from a genuine race (two concurrent inserts for the same request_id)
-- is caught and treated as a replay rather than surfaced as an error.
-- Atomicity comes free: this is one plpgsql function, so an unhandled
-- exception partway through rolls back everything it already did.
--
-- items.qty is now updated as an atomic `qty = qty + delta` here, not by
-- the client sending a precomputed absolute value (the old per-line
-- callWrite("update","items",{qty:newQty}) racily overwrote whatever the
-- server had if two devices sold concurrently).
--
-- Per-location stock (item_locations) is untouched by this function --
-- that table has 0 rows in production; the client's separate
-- dbUpdateLocStock call after record_txn is left as-is.
--
-- Idempotent file: ADD COLUMN IF NOT EXISTS, guarded ADD CONSTRAINT,
-- CREATE OR REPLACE FUNCTION, re-runnable REVOKE/GRANT.
-- Dashboard note: run as ONE submission (autocommits per run).

BEGIN;

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS request_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_request_id_key'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_request_id_key UNIQUE (request_id);
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.request_id IS
  'Client-generated idempotency key for writes made via '
  'shop_write_record_transaction. NULL for rows from any other path.';

CREATE OR REPLACE FUNCTION public.shop_write_record_transaction(
  p_request_id uuid,
  p_store_id   uuid,
  p_type       text,
  p_ref        text,
  p_supplier   text,
  p_txn_date   date,
  p_by_user    text,
  p_lines      jsonb  -- [{item_id, item_name, qty, location_id}, ...]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn_id   uuid;
  v_replayed boolean := false;
  v_line     jsonb;
  v_item_id  uuid;
  v_qty      numeric;
  v_delta    numeric;
  v_items    jsonb;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id is required';
  END IF;
  IF p_type NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'invalid transaction type: %', p_type;
  END IF;
  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'at least one line item is required';
  END IF;

  SELECT id INTO v_txn_id FROM transactions WHERE request_id = p_request_id;

  IF v_txn_id IS NULL THEN
    BEGIN
      INSERT INTO transactions (store_id, type, ref, supplier, txn_date, by_user, request_id)
      VALUES (p_store_id, p_type, p_ref, p_supplier, p_txn_date, p_by_user, p_request_id)
      RETURNING id INTO v_txn_id;

      FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_item_id := (v_line->>'item_id')::uuid;
        v_qty     := (v_line->>'qty')::numeric;
        IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
          RAISE EXCEPTION 'invalid line item: %', v_line;
        END IF;

        INSERT INTO transaction_items (transaction_id, item_id, item_name, qty, location_id)
        VALUES (v_txn_id, v_item_id, v_line->>'item_name', v_qty,
                NULLIF(v_line->>'location_id', '')::bigint);

        v_delta := v_qty * (CASE WHEN p_type = 'out' THEN -1 ELSE 1 END);
        UPDATE items SET qty = qty + v_delta, updated_at = now()
          WHERE id = v_item_id;
      END LOOP;
    EXCEPTION WHEN unique_violation THEN
      -- Concurrent retry of the same request_id lost the race; the
      -- winner already did the work above. Fall through as a replay.
      SELECT id INTO v_txn_id FROM transactions WHERE request_id = p_request_id;
      IF v_txn_id IS NULL THEN
        RAISE;  -- a different unique violation; not ours to swallow
      END IF;
      v_replayed := true;
    END;
  ELSE
    v_replayed := true;
  END IF;

  -- Current authoritative qty for every item this call touched, whether
  -- freshly written or replayed -- the client applies these directly,
  -- no branching on replayed needed client-side.
  SELECT coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'qty', i.qty)), '[]'::jsonb)
    INTO v_items
    FROM items i
    WHERE i.id IN (SELECT (l->>'item_id')::uuid FROM jsonb_array_elements(p_lines) l);

  RETURN jsonb_build_object('txn_id', v_txn_id, 'replayed', v_replayed, 'items', v_items);
END;
$$;

COMMENT ON FUNCTION public.shop_write_record_transaction(uuid,uuid,text,text,text,date,text,jsonb) IS
  'Service-role-only atomic+idempotent write for a sale or stock-in: '
  'inserts transactions + transaction_items and applies the items.qty '
  'delta in one call, keyed by request_id. Called by shop-write op:"record_txn".';

REVOKE ALL ON FUNCTION public.shop_write_record_transaction(uuid,uuid,text,text,text,date,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shop_write_record_transaction(uuid,uuid,text,text,text,date,text,jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.shop_write_record_transaction(uuid,uuid,text,text,text,date,text,jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.shop_write_record_transaction(uuid,uuid,text,text,text,date,text,jsonb) TO service_role;

COMMIT;

-- Verification: run 002_record_transaction_rehearsal.sql (manual, throwaway
-- store/items/request_ids only, self-cleaning).
