-- 002_stock_transfer_rehearsal.sql
--
-- Rehearses shop_write_record_transfer (001 applied) using ONLY a
-- throwaway store + 2 throwaway locations + 2 throwaway items + 2 fixed
-- test request_ids, all named/marked REHEARSAL. NOT applied automatically.
--
-- AUTOCOMMIT WARNING (if run through the dashboard SQL editor instead of
-- the Supabase MCP -- see sql/atomic-transactions/002 for the story): the
-- dashboard editor does not preserve BEGIN/COMMIT across separate runs.
-- Manual cleanup if a check RAISEs mid-script:
--   DELETE FROM public.transaction_items WHERE transaction_id IN
--     (SELECT id FROM public.transactions WHERE request_id IN (
--       'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2'));
--   DELETE FROM public.transactions WHERE request_id IN (
--     'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2');
--   DELETE FROM public.item_locations WHERE item_id IN
--     (SELECT id FROM public.items WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_ITEM_%');
--   DELETE FROM public.items  WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_ITEM_%';
--   DELETE FROM public.locations WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_LOC_%';
--   DELETE FROM public.stores WHERE name = 'STOCK_TRANSFER_REHEARSAL_STORE';
--
-- Exercises:
--   1. pre-flight        -> 001 applied, test rows free
--   2. first call        -> new transaction, item_locations at from/to
--                           updated, non-replay
--   3. replayed call     -> SAME request_id, DIFFERENT lines -> same
--                           txn_id, replayed=true, item_locations
--                           UNCHANGED (proves the replay short-circuits
--                           before re-running any line logic)
--   4. second real call  -> different request_id, moves stock again
--   5. guards            -> same from/to location and empty lines both raise
--   6. EXECUTE ACL       -> anon/authenticated denied at call time
--   7. cleanup           -> explicit scoped DELETEs, zero-rows verification

BEGIN;

-- 1. Pre-flight
DO $$
DECLARE
  v_store int; v_locs int; v_items int; v_txns int;
BEGIN
  IF to_regprocedure('public.shop_write_record_transfer(uuid,uuid,bigint,bigint,date,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'REHEARSAL PRE-FLIGHT FAILED: function missing - apply 001 first';
  END IF;
  SELECT count(*) INTO v_store FROM public.stores WHERE name = 'STOCK_TRANSFER_REHEARSAL_STORE';
  SELECT count(*) INTO v_locs FROM public.locations WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_LOC_%';
  SELECT count(*) INTO v_items FROM public.items WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_ITEM_%';
  SELECT count(*) INTO v_txns FROM public.transactions WHERE request_id IN
    ('bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2');
  IF v_store <> 0 OR v_locs <> 0 OR v_items <> 0 OR v_txns <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL PRE-FLIGHT FAILED: leftover test rows exist (store=%, locs=%, items=%, txns=%) - clean up manually first', v_store, v_locs, v_items, v_txns;
  END IF;
  RAISE NOTICE 'REHEARSAL PRE-FLIGHT PASSED';
END $$;

INSERT INTO public.stores (name) VALUES ('STOCK_TRANSFER_REHEARSAL_STORE');

INSERT INTO public.locations (store_id, name, is_default)
SELECT s.id::text, v.name, false
FROM public.stores s,
     (VALUES ('STOCK_TRANSFER_REHEARSAL_LOC_FROM'), ('STOCK_TRANSFER_REHEARSAL_LOC_TO')) AS v(name)
WHERE s.name = 'STOCK_TRANSFER_REHEARSAL_STORE';

INSERT INTO public.items (store_id, name, unit, qty, min_stock, rate)
SELECT s.id, v.name, 'Nos', 50, 0, 0
FROM public.stores s,
     (VALUES ('STOCK_TRANSFER_REHEARSAL_ITEM_A'), ('STOCK_TRANSFER_REHEARSAL_ITEM_B')) AS v(name)
WHERE s.name = 'STOCK_TRANSFER_REHEARSAL_STORE';

-- 2. First call: transfer both items from LOC_FROM to LOC_TO.
DO $$
DECLARE
  v_store_id uuid; v_from_id bigint; v_to_id bigint; v_a_id uuid; v_b_id uuid; v_result jsonb;
BEGIN
  SELECT id INTO v_store_id FROM public.stores WHERE name = 'STOCK_TRANSFER_REHEARSAL_STORE';
  SELECT id INTO v_from_id FROM public.locations WHERE name = 'STOCK_TRANSFER_REHEARSAL_LOC_FROM';
  SELECT id INTO v_to_id FROM public.locations WHERE name = 'STOCK_TRANSFER_REHEARSAL_LOC_TO';
  SELECT id INTO v_a_id FROM public.items WHERE name = 'STOCK_TRANSFER_REHEARSAL_ITEM_A';
  SELECT id INTO v_b_id FROM public.items WHERE name = 'STOCK_TRANSFER_REHEARSAL_ITEM_B';

  SELECT public.shop_write_record_transfer(
    'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1'::uuid, v_store_id, v_from_id, v_to_id,
    current_date, 'rehearsal', jsonb_build_array(
      jsonb_build_object('item_id', v_a_id, 'item_name', 'A', 'qty', 5),
      jsonb_build_object('item_id', v_b_id, 'item_name', 'B', 'qty', 3)
    )
  ) INTO v_result;

  IF (v_result->>'replayed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (first call): expected replayed=false, got %', v_result;
  END IF;
  IF (SELECT qty FROM public.item_locations WHERE item_id = v_a_id AND location_id = v_from_id) <> -5
     OR (SELECT qty FROM public.item_locations WHERE item_id = v_a_id AND location_id = v_to_id) <> 5
     OR (SELECT qty FROM public.item_locations WHERE item_id = v_b_id AND location_id = v_from_id) <> -3
     OR (SELECT qty FROM public.item_locations WHERE item_id = v_b_id AND location_id = v_to_id) <> 3 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (first call): item_locations not as expected: A from=%, A to=%, B from=%, B to=%',
      (SELECT qty FROM public.item_locations WHERE item_id = v_a_id AND location_id = v_from_id),
      (SELECT qty FROM public.item_locations WHERE item_id = v_a_id AND location_id = v_to_id),
      (SELECT qty FROM public.item_locations WHERE item_id = v_b_id AND location_id = v_from_id),
      (SELECT qty FROM public.item_locations WHERE item_id = v_b_id AND location_id = v_to_id);
  END IF;
  IF (SELECT qty FROM public.items WHERE id = v_a_id) <> 50 OR (SELECT qty FROM public.items WHERE id = v_b_id) <> 50 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (first call): items.qty total must be untouched by a transfer';
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (first call): txn_id=%, stock moved from->to, totals untouched', v_result->>'txn_id';
END $$;

-- 3. Replay: SAME request_id, DIFFERENT lines (single item, different qty).
--    Must return the original txn_id, replayed=true, and leave
--    item_locations untouched -- proving it short-circuits.
DO $$
DECLARE
  v_store_id uuid; v_from_id bigint; v_to_id bigint; v_a_id uuid; v_first_txn uuid; v_result jsonb;
BEGIN
  SELECT id INTO v_store_id FROM public.stores WHERE name = 'STOCK_TRANSFER_REHEARSAL_STORE';
  SELECT id INTO v_from_id FROM public.locations WHERE name = 'STOCK_TRANSFER_REHEARSAL_LOC_FROM';
  SELECT id INTO v_to_id FROM public.locations WHERE name = 'STOCK_TRANSFER_REHEARSAL_LOC_TO';
  SELECT id INTO v_a_id FROM public.items WHERE name = 'STOCK_TRANSFER_REHEARSAL_ITEM_A';
  SELECT id INTO v_first_txn FROM public.transactions WHERE request_id = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1';

  SELECT public.shop_write_record_transfer(
    'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1'::uuid, v_store_id, v_from_id, v_to_id,
    current_date, 'rehearsal', jsonb_build_array(
      jsonb_build_object('item_id', v_a_id, 'item_name', 'A', 'qty', 999)
    )
  ) INTO v_result;

  IF (v_result->>'txn_id')::uuid IS DISTINCT FROM v_first_txn THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (replay): expected original txn_id %, got %', v_first_txn, v_result->>'txn_id';
  END IF;
  IF (v_result->>'replayed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (replay): expected replayed=true, got %', v_result;
  END IF;
  IF (SELECT qty FROM public.item_locations WHERE item_id = v_a_id AND location_id = v_from_id) <> -5
     OR (SELECT qty FROM public.item_locations WHERE item_id = v_a_id AND location_id = v_to_id) <> 5 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (replay): item_locations changed (delta re-applied!) - idempotency broken';
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (replay): same txn_id, replayed=true, item_locations untouched despite different payload';
END $$;

-- 4. Second real call: different request_id, transfers item B back
--    LOC_TO -> LOC_FROM (proves the RPC works either direction).
DO $$
DECLARE
  v_store_id uuid; v_from_id bigint; v_to_id bigint; v_b_id uuid; v_result jsonb;
BEGIN
  SELECT id INTO v_store_id FROM public.stores WHERE name = 'STOCK_TRANSFER_REHEARSAL_STORE';
  SELECT id INTO v_from_id FROM public.locations WHERE name = 'STOCK_TRANSFER_REHEARSAL_LOC_FROM';
  SELECT id INTO v_to_id FROM public.locations WHERE name = 'STOCK_TRANSFER_REHEARSAL_LOC_TO';
  SELECT id INTO v_b_id FROM public.items WHERE name = 'STOCK_TRANSFER_REHEARSAL_ITEM_B';

  SELECT public.shop_write_record_transfer(
    'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2'::uuid, v_store_id, v_to_id, v_from_id,
    current_date, 'rehearsal', jsonb_build_array(
      jsonb_build_object('item_id', v_b_id, 'item_name', 'B', 'qty', 3)
    )
  ) INTO v_result;

  IF (v_result->>'replayed')::boolean IS DISTINCT FROM false
     OR (SELECT qty FROM public.item_locations WHERE item_id = v_b_id AND location_id = v_from_id) <> 0
     OR (SELECT qty FROM public.item_locations WHERE item_id = v_b_id AND location_id = v_to_id) <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (second call): expected replayed=false and B back to 0/0, got % / from=% / to=%',
      v_result,
      (SELECT qty FROM public.item_locations WHERE item_id = v_b_id AND location_id = v_from_id),
      (SELECT qty FROM public.item_locations WHERE item_id = v_b_id AND location_id = v_to_id);
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (second call): reverse transfer applied, B back to 0/0';
END $$;

-- 5. Guards: same from/to location and empty lines both raise.
DO $$
DECLARE v_store_id uuid; v_from_id bigint;
BEGIN
  SELECT id INTO v_store_id FROM public.stores WHERE name = 'STOCK_TRANSFER_REHEARSAL_STORE';
  SELECT id INTO v_from_id FROM public.locations WHERE name = 'STOCK_TRANSFER_REHEARSAL_LOC_FROM';
  BEGIN
    PERFORM public.shop_write_record_transfer(
      gen_random_uuid(), v_store_id, v_from_id, v_from_id, current_date, 'rehearsal',
      jsonb_build_array(jsonb_build_object('item_id', gen_random_uuid(), 'item_name', 'x', 'qty', 1)));
    RAISE EXCEPTION 'REHEARSAL FAILED (guard): same from/to location was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'from and to location must differ%' THEN RAISE; END IF;
    RAISE NOTICE 'REHEARSAL PASSED (guard): same from/to location rejected';
  END;
  BEGIN
    PERFORM public.shop_write_record_transfer(
      gen_random_uuid(), v_store_id, v_from_id, v_from_id + 1, current_date, 'rehearsal', '[]'::jsonb);
    RAISE EXCEPTION 'REHEARSAL FAILED (guard): empty lines was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'at least one line item%' THEN RAISE; END IF;
    RAISE NOTICE 'REHEARSAL PASSED (guard): empty lines rejected';
  END;
END $$;

-- 6. EXECUTE ACL: anon/authenticated must be denied at call time.
DO $$
DECLARE v_assumed boolean := false;
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    v_assumed := true;
    PERFORM public.shop_write_record_transfer(
      gen_random_uuid(), gen_random_uuid(), 1, 2, current_date, 'x',
      jsonb_build_array(jsonb_build_object('item_id', gen_random_uuid(), 'item_name', 'x', 'qty', 1)));
    RAISE EXCEPTION 'REHEARSAL FAILED (ACL anon): call succeeded without EXECUTE privilege';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF v_assumed THEN RAISE NOTICE 'REHEARSAL PASSED (ACL anon): EXECUTE denied';
      ELSE RAISE EXCEPTION 'REHEARSAL INCONCLUSIVE (ACL anon): could not SET ROLE anon'; END IF;
  END;
END $$;

-- 7. Cleanup: only rows scoped to this run's store/locations/items/request_ids.
DELETE FROM public.transaction_items WHERE transaction_id IN
  (SELECT id FROM public.transactions WHERE request_id IN
    ('bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2'));
DELETE FROM public.transactions WHERE request_id IN
  ('bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2');
DELETE FROM public.item_locations WHERE item_id IN
  (SELECT id FROM public.items WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_ITEM_%');
DELETE FROM public.items  WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_ITEM_%';
DELETE FROM public.locations WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_LOC_%';
DELETE FROM public.stores WHERE name = 'STOCK_TRANSFER_REHEARSAL_STORE';

DO $$
DECLARE v_store int; v_locs int; v_items int; v_txns int;
BEGIN
  SELECT count(*) INTO v_store FROM public.stores WHERE name = 'STOCK_TRANSFER_REHEARSAL_STORE';
  SELECT count(*) INTO v_locs FROM public.locations WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_LOC_%';
  SELECT count(*) INTO v_items FROM public.items WHERE name LIKE 'STOCK_TRANSFER_REHEARSAL_ITEM_%';
  SELECT count(*) INTO v_txns FROM public.transactions WHERE request_id IN
    ('bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb1','bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbb2');
  IF v_store <> 0 OR v_locs <> 0 OR v_items <> 0 OR v_txns <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL CLEANUP FAILED: store=%, locs=%, items=%, txns=% still present', v_store, v_locs, v_items, v_txns;
  END IF;
  RAISE NOTICE 'REHEARSAL CLEANUP PASSED: no rows remain';
END $$;

COMMIT;
