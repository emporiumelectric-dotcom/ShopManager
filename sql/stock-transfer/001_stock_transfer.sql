-- 001_stock_transfer.sql
--
-- Root problem: dbTransferStock (index.html) inserts transactions with
-- type:"transfer", but transactions_type_check only allows 'in'/'out'
-- (confirmed live: distinct type values in production are 'in'/'out' only,
-- 397 rows, zero transfers). Every transfer attempt has always failed
-- silently (dbTransferStock catches the error and returns false).
--
-- Also confirmed live: item_locations has 0 rows, and item_id is bigint
-- while items.id is uuid -- a type mismatch that has made a real foreign
-- key, and therefore any successful row, impossible since the table was
-- created. There IS already a UNIQUE (item_id, location_id) constraint
-- (item_locations_item_id_location_id_key) that the client's upsert
-- (onConflict:"item_id,location_id") depends on -- untouched here.
--
-- This migration: (1) fixes item_locations.item_id's type and adds the
-- FKs every sibling table in this schema already has, (2) widens the type
-- CHECK to allow 'transfer', (3) adds shop_write_record_transfer, an
-- atomic+idempotent RPC for the whole transfer (move item_locations stock
-- at both locations + log the transaction), mirroring
-- shop_write_record_transaction (sql/atomic-transactions/001) -- the
-- client's old dbTransferStock sequence has the exact same partial-write/
-- double-apply exposure that fix addressed for sale/stock-in.
--
-- Does NOT touch items.qty -- a transfer moves stock between locations,
-- it doesn't change how much exists in total.
-- Does NOT add a guard against transferring more than a location's
-- current stock (can go negative) -- matches dbUpdateLocStock's existing
-- behavior exactly, not a new gap introduced here.
--
-- Idempotent file: guarded ALTER/ADD CONSTRAINT, CREATE OR REPLACE
-- FUNCTION, re-runnable REVOKE/GRANT. Dashboard note (if run there instead
-- of via the Supabase MCP): run as ONE submission (autocommits per run).

BEGIN;

-- 1. item_locations.item_id: bigint -> uuid (matches items.id).
DO $$
DECLARE v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.item_locations;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'item_locations has % row(s), expected 0 -- aborting the item_id type change; re-verify before proceeding.', v_rows;
  END IF;
END $$;

ALTER TABLE public.item_locations
  ALTER COLUMN item_id TYPE uuid USING item_id::text::uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'item_locations_item_id_fkey'
  ) THEN
    ALTER TABLE public.item_locations
      ADD CONSTRAINT item_locations_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'item_locations_location_id_fkey'
  ) THEN
    ALTER TABLE public.item_locations
      ADD CONSTRAINT item_locations_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id);
  END IF;
END $$;

-- 2. Widen the type CHECK. Confirmed live name/definition:
--    transactions_type_check: CHECK ((type = ANY (ARRAY['in','out']))).
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check CHECK (type IN ('in', 'out', 'transfer'));

-- 3. Atomic + idempotent transfer RPC.
CREATE OR REPLACE FUNCTION public.shop_write_record_transfer(
  p_request_id       uuid,
  p_store_id         uuid,
  p_from_location_id bigint,
  p_to_location_id   bigint,
  p_txn_date         date,
  p_by_user          text,
  p_lines            jsonb  -- [{item_id, item_name, qty}, ...]
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
  v_locs     jsonb;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id is required';
  END IF;
  IF p_from_location_id IS NULL OR p_to_location_id IS NULL THEN
    RAISE EXCEPTION 'from and to location are required';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'from and to location must differ';
  END IF;
  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'at least one line item is required';
  END IF;

  SELECT id INTO v_txn_id FROM transactions WHERE request_id = p_request_id;

  IF v_txn_id IS NULL THEN
    BEGIN
      INSERT INTO transactions (store_id, type, txn_date, by_user, from_location_id, to_location_id, request_id)
      VALUES (p_store_id, 'transfer', p_txn_date, p_by_user, p_from_location_id, p_to_location_id, p_request_id)
      RETURNING id INTO v_txn_id;

      FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_item_id := (v_line->>'item_id')::uuid;
        v_qty     := (v_line->>'qty')::numeric;
        IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
          RAISE EXCEPTION 'invalid line item: %', v_line;
        END IF;

        INSERT INTO transaction_items (transaction_id, item_id, item_name, qty)
        VALUES (v_txn_id, v_item_id, v_line->>'item_name', v_qty);

        INSERT INTO item_locations (item_id, location_id, qty)
          VALUES (v_item_id, p_from_location_id, -v_qty)
        ON CONFLICT (item_id, location_id)
          DO UPDATE SET qty = item_locations.qty - v_qty;

        INSERT INTO item_locations (item_id, location_id, qty)
          VALUES (v_item_id, p_to_location_id, v_qty)
        ON CONFLICT (item_id, location_id)
          DO UPDATE SET qty = item_locations.qty + v_qty;
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

  -- Current authoritative per-(item,location) qty for everything this
  -- call touched, whether freshly written or replayed.
  SELECT coalesce(jsonb_agg(jsonb_build_object('item_id', il.item_id, 'location_id', il.location_id, 'qty', il.qty)), '[]'::jsonb)
    INTO v_locs
    FROM item_locations il
    WHERE il.item_id IN (SELECT (l->>'item_id')::uuid FROM jsonb_array_elements(p_lines) l)
      AND il.location_id IN (p_from_location_id, p_to_location_id);

  RETURN jsonb_build_object('txn_id', v_txn_id, 'replayed', v_replayed, 'item_locations', v_locs);
END;
$$;

COMMENT ON FUNCTION public.shop_write_record_transfer(uuid,uuid,bigint,bigint,date,text,jsonb) IS
  'Service-role-only atomic+idempotent write for a stock transfer between '
  'two locations: inserts transactions(type=''transfer'') + '
  'transaction_items and moves item_locations qty from->to in one call, '
  'keyed by request_id. items.qty is untouched. Called by shop-write '
  'op:"record_transfer".';

REVOKE ALL ON FUNCTION public.shop_write_record_transfer(uuid,uuid,bigint,bigint,date,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shop_write_record_transfer(uuid,uuid,bigint,bigint,date,text,jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.shop_write_record_transfer(uuid,uuid,bigint,bigint,date,text,jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.shop_write_record_transfer(uuid,uuid,bigint,bigint,date,text,jsonb) TO service_role;

COMMIT;

-- Verification: run 002_stock_transfer_rehearsal.sql (throwaway
-- store/items/locations/request_ids only, self-cleaning).
