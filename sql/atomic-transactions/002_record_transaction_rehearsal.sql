-- 002_record_transaction_rehearsal.sql
--
-- Rehearses shop_write_record_transaction (001 applied) using ONLY a
-- throwaway store + 2 throwaway items + 2 fixed test request_ids, all
-- named/marked REHEARSAL. NOT applied automatically.
--
-- AUTOCOMMIT WARNING (dashboard SQL editor autocommits per run, no
-- cross-run BEGIN/COMMIT -- see session-tokens/002 for the story): if a
-- check RAISEs mid-script, already-committed pieces persist. Manual
-- cleanup if that happens:
--   DELETE FROM public.transaction_items WHERE transaction_id IN
--     (SELECT id FROM public.transactions WHERE request_id IN (
--       'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1','aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa2'));
--   DELETE FROM public.transactions WHERE request_id IN (
--     'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1','aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa2');
--   DELETE FROM public.items  WHERE name LIKE 'RECORD_TXN_REHEARSAL_ITEM_%';
--   DELETE FROM public.stores WHERE name = 'RECORD_TXN_REHEARSAL_STORE';
-- Prefer running this whole file as one submission (psql, or the
-- dashboard editor in a single paste) so BEGIN/COMMIT is honored.
--
-- Exercises:
--   1. pre-flight        -> 001 applied, test store/items/request_ids free
--   2. first call        -> new transaction, both items decremented, non-replay
--   3. replayed call     -> SAME request_id, DIFFERENT lines -> same txn_id,
--                           replayed=true, qty UNCHANGED (proves the replay
--                           short-circuits before re-running any line logic,
--                           not just that it happens to be safe on identical input)
--   4. second real call  -> different request_id, type 'in' -> new txn, qty up
--   5. guards            -> invalid type and empty lines both raise
--   6. EXECUTE ACL       -> anon/authenticated denied at call time
--   7. cleanup           -> explicit scoped DELETEs, zero-rows verification

BEGIN;

-- 1. Pre-flight
DO $$
DECLARE
  v_store int; v_items int; v_txns int;
BEGIN
  IF to_regprocedure('public.shop_write_record_transaction(uuid,uuid,text,text,text,date,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'REHEARSAL PRE-FLIGHT FAILED: function missing - apply 001 first';
  END IF;
  SELECT count(*) INTO v_store FROM public.stores WHERE name = 'RECORD_TXN_REHEARSAL_STORE';
  SELECT count(*) INTO v_items FROM public.items WHERE name LIKE 'RECORD_TXN_REHEARSAL_ITEM_%';
  SELECT count(*) INTO v_txns FROM public.transactions WHERE request_id IN
    ('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1','aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa2');
  IF v_store <> 0 OR v_items <> 0 OR v_txns <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL PRE-FLIGHT FAILED: leftover test rows exist (store=%, items=%, txns=%) - clean up manually first', v_store, v_items, v_txns;
  END IF;
  RAISE NOTICE 'REHEARSAL PRE-FLIGHT PASSED';
END $$;

INSERT INTO public.stores (name) VALUES ('RECORD_TXN_REHEARSAL_STORE');

INSERT INTO public.items (store_id, name, unit, qty, min_stock, rate)
SELECT s.id, v.name, 'Nos', 50, 0, 0
FROM public.stores s,
     (VALUES ('RECORD_TXN_REHEARSAL_ITEM_A'), ('RECORD_TXN_REHEARSAL_ITEM_B')) AS v(name)
WHERE s.name = 'RECORD_TXN_REHEARSAL_STORE';

-- 2. First call: a sale ('out') of both items.
DO $$
DECLARE
  v_store_id uuid; v_a_id uuid; v_b_id uuid; v_result jsonb;
BEGIN
  SELECT id INTO v_store_id FROM public.stores WHERE name = 'RECORD_TXN_REHEARSAL_STORE';
  SELECT id INTO v_a_id FROM public.items WHERE name = 'RECORD_TXN_REHEARSAL_ITEM_A';
  SELECT id INTO v_b_id FROM public.items WHERE name = 'RECORD_TXN_REHEARSAL_ITEM_B';

  SELECT public.shop_write_record_transaction(
    'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1'::uuid, v_store_id, 'out', 'REH-REF-1', NULL,
    current_date, 'rehearsal', jsonb_build_array(
      jsonb_build_object('item_id', v_a_id, 'item_name', 'A', 'qty', 5),
      jsonb_build_object('item_id', v_b_id, 'item_name', 'B', 'qty', 3)
    )
  ) INTO v_result;

  IF (v_result->>'replayed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (first call): expected replayed=false, got %', v_result;
  END IF;
  IF (SELECT qty FROM public.items WHERE id = v_a_id) <> 45
     OR (SELECT qty FROM public.items WHERE id = v_b_id) <> 47 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (first call): expected qty 45/47, got %/%',
      (SELECT qty FROM public.items WHERE id = v_a_id), (SELECT qty FROM public.items WHERE id = v_b_id);
  END IF;
  IF (SELECT count(*) FROM public.transaction_items ti JOIN public.transactions t ON t.id = ti.transaction_id
      WHERE t.request_id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1') <> 2 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (first call): expected 2 transaction_items rows';
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (first call): txn_id=%, qty A=45 B=47', v_result->>'txn_id';
END $$;

-- 3. Replay: SAME request_id, DIFFERENT lines (single item, different qty).
--    Must return the original txn_id, replayed=true, and leave qty untouched
--    -- proving it short-circuits rather than re-applying a delta.
DO $$
DECLARE
  v_store_id uuid; v_a_id uuid; v_first_txn uuid; v_result jsonb;
BEGIN
  SELECT id INTO v_store_id FROM public.stores WHERE name = 'RECORD_TXN_REHEARSAL_STORE';
  SELECT id INTO v_a_id FROM public.items WHERE name = 'RECORD_TXN_REHEARSAL_ITEM_A';
  SELECT id INTO v_first_txn FROM public.transactions WHERE request_id = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1';

  SELECT public.shop_write_record_transaction(
    'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1'::uuid, v_store_id, 'out', 'REH-REF-1-RETRY', NULL,
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
  IF (SELECT qty FROM public.items WHERE id = v_a_id) <> 45 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (replay): item A qty changed to % (delta re-applied!) - idempotency broken', (SELECT qty FROM public.items WHERE id = v_a_id);
  END IF;
  IF (SELECT count(*) FROM public.transaction_items WHERE transaction_id = v_first_txn) <> 2 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (replay): transaction_items row count changed - a duplicate line was inserted';
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (replay): same txn_id, replayed=true, qty untouched despite different payload';
END $$;

-- 4. Second real call: different request_id, type 'in'.
DO $$
DECLARE
  v_store_id uuid; v_a_id uuid; v_result jsonb;
BEGIN
  SELECT id INTO v_store_id FROM public.stores WHERE name = 'RECORD_TXN_REHEARSAL_STORE';
  SELECT id INTO v_a_id FROM public.items WHERE name = 'RECORD_TXN_REHEARSAL_ITEM_A';

  SELECT public.shop_write_record_transaction(
    'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa2'::uuid, v_store_id, 'in', 'REH-REF-2', 'REH-SUPPLIER',
    current_date, 'rehearsal', jsonb_build_array(
      jsonb_build_object('item_id', v_a_id, 'item_name', 'A', 'qty', 10)
    )
  ) INTO v_result;

  IF (v_result->>'replayed')::boolean IS DISTINCT FROM false
     OR (SELECT qty FROM public.items WHERE id = v_a_id) <> 55 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (second call): expected replayed=false and qty 55, got % / %', v_result, (SELECT qty FROM public.items WHERE id = v_a_id);
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (second call): stock-in applied, qty A=55';
END $$;

-- 5. Guards: invalid type and empty lines both raise.
DO $$
DECLARE v_store_id uuid;
BEGIN
  SELECT id INTO v_store_id FROM public.stores WHERE name = 'RECORD_TXN_REHEARSAL_STORE';
  BEGIN
    PERFORM public.shop_write_record_transaction(
      gen_random_uuid(), v_store_id, 'bogus', NULL, NULL, current_date, 'rehearsal', '[]'::jsonb);
    RAISE EXCEPTION 'REHEARSAL FAILED (guard): invalid type was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'invalid transaction type%' THEN RAISE; END IF;
    RAISE NOTICE 'REHEARSAL PASSED (guard): invalid type rejected';
  END;
  BEGIN
    PERFORM public.shop_write_record_transaction(
      gen_random_uuid(), v_store_id, 'out', NULL, NULL, current_date, 'rehearsal', '[]'::jsonb);
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
    PERFORM public.shop_write_record_transaction(
      gen_random_uuid(), gen_random_uuid(), 'out', NULL, NULL, current_date, 'x',
      jsonb_build_array(jsonb_build_object('item_id', gen_random_uuid(), 'item_name', 'x', 'qty', 1)));
    RAISE EXCEPTION 'REHEARSAL FAILED (ACL anon): call succeeded without EXECUTE privilege';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF v_assumed THEN RAISE NOTICE 'REHEARSAL PASSED (ACL anon): EXECUTE denied';
      ELSE RAISE EXCEPTION 'REHEARSAL INCONCLUSIVE (ACL anon): could not SET ROLE anon'; END IF;
  END;
END $$;

-- 7. Cleanup: only rows scoped to this run's store/items/request_ids.
DELETE FROM public.transaction_items WHERE transaction_id IN
  (SELECT id FROM public.transactions WHERE request_id IN
    ('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1','aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa2'));
DELETE FROM public.transactions WHERE request_id IN
  ('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1','aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa2');
DELETE FROM public.items  WHERE name LIKE 'RECORD_TXN_REHEARSAL_ITEM_%';
DELETE FROM public.stores WHERE name = 'RECORD_TXN_REHEARSAL_STORE';

DO $$
DECLARE v_store int; v_items int; v_txns int;
BEGIN
  SELECT count(*) INTO v_store FROM public.stores WHERE name = 'RECORD_TXN_REHEARSAL_STORE';
  SELECT count(*) INTO v_items FROM public.items WHERE name LIKE 'RECORD_TXN_REHEARSAL_ITEM_%';
  SELECT count(*) INTO v_txns FROM public.transactions WHERE request_id IN
    ('aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa1','aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa2');
  IF v_store <> 0 OR v_items <> 0 OR v_txns <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL CLEANUP FAILED: store=%, items=%, txns=% still present', v_store, v_items, v_txns;
  END IF;
  RAISE NOTICE 'REHEARSAL CLEANUP PASSED: no rows remain';
END $$;

COMMIT;
