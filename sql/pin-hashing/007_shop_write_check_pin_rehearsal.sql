-- 007_shop_write_check_pin_rehearsal.sql
--
-- Rehearses public.shop_write_check_pin (006 applied) against THROWAWAY
-- test users only - ids 9002 and 9003, well outside the live range 1-7 and
-- distinct from 003's id 9001. NOT applied automatically; run by hand via
-- psql (like 003, the auto-rollback safety net depends on BEGIN/COMMIT
-- being honored as one transaction, so avoid clients that autocommit per
-- statement). Exercises:
--   1. correct PIN                 -> exactly the test user's row back
--   2. wrong PIN                   -> no rows
--   3. unknown user id             -> no rows
--   4. row with pin_hash IS NULL   -> no rows even with the "correct"
--                                     plaintext PIN (no fallback - this
--                                     helper never reads users.pin)
--   5. no side effects             -> zero pin_attempts rows for the test
--                                     ids after all of the above calls
--   6. ACL state                   -> anon/authenticated (and, via role
--                                     inheritance, PUBLIC) lack EXECUTE;
--                                     service_role has it
--   7. runtime denial              -> actually assuming role anon and
--                                     role authenticated and calling the
--                                     helper raises insufficient_privilege
--
-- Everything runs inside one transaction. Every assertion RAISEs an
-- EXCEPTION on failure, aborting the transaction and rolling back
-- everything this script did - including the test users - so a failed run
-- cannot leave stray rows behind on its own. On success it ALSO runs
-- explicit, id-scoped cleanup DELETEs before COMMIT and verifies they
-- worked, failing loudly if anything remains.
--
-- Every INSERT and DELETE in this file is scoped to ids 9002/9003 created
-- by this run. Nothing here deletes from users or pin_attempts without
-- that filter - no table-wide deletes.

BEGIN;

-- Pre-flight: the throwaway ids must not already exist (a stray 9002/9003
-- users row would make the PK inserts fail loudly anyway, but stray
-- pin_attempts rows would falsely fail check 5, so refuse to run instead
-- of deleting rows this run did not create).
DO $$
DECLARE
  v_users int;
  v_attempts int;
BEGIN
  SELECT count(*) INTO v_users FROM public.users WHERE id IN (9002, 9003, 9999);
  SELECT count(*) INTO v_attempts FROM public.pin_attempts WHERE user_id IN (9002, 9003);
  IF v_users <> 0 OR v_attempts <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL PRE-FLIGHT FAILED: % users rows in (9002,9003,9999) and % pin_attempts rows for (9002,9003) already exist - clean these up manually before running (this script only deletes rows it created itself)', v_users, v_attempts;
  END IF;
  RAISE NOTICE 'REHEARSAL PRE-FLIGHT PASSED: ids 9002/9003/9999 are free';
END $$;

-- 9002: hashed test user (the normal case shop-write will hit).
-- 9003: pin_hash deliberately NULL to prove there is no plaintext
-- fallback. Explicit pin_hash values on INSERT - the users_sync_pin_hash
-- trigger fires on UPDATE OF pin only, not on INSERT. OVERRIDING SYSTEM
-- VALUE is required to supply explicit ids because users.id is GENERATED
-- ALWAYS AS IDENTITY (learned in the 2026-08-16 rehearsal run).
INSERT INTO public.users (id, name, role, pin, can_delete, pin_hash)
OVERRIDING SYSTEM VALUE
VALUES
  (9002, 'SHOP_WRITE_CHECK_PIN_TEST', 'test', '4242', false,
   extensions.crypt('4242', extensions.gen_salt('bf'))),
  (9003, 'SHOP_WRITE_CHECK_PIN_TEST_NOHASH', 'test', '5151', false, NULL);

-- 1. correct PIN -> exactly this user's row, fields intact
DO $$
DECLARE
  v_row record;
  v_count int;
BEGIN
  SELECT * INTO v_row FROM public.shop_write_check_pin(9002, '4242');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1
     OR v_row.id IS DISTINCT FROM 9002::bigint
     OR v_row.name IS DISTINCT FROM 'SHOP_WRITE_CHECK_PIN_TEST'
     OR v_row.role IS DISTINCT FROM 'test'
     OR v_row.can_delete IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (correct PIN): expected 1 matching row for id 9002, got % row(s) (%)', v_count, v_row;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (correct PIN): id=%, name=%, role=%, can_delete=%', v_row.id, v_row.name, v_row.role, v_row.can_delete;
END $$;

-- 2. wrong PIN -> no rows
DO $$
DECLARE
  v_count int;
BEGIN
  PERFORM * FROM public.shop_write_check_pin(9002, '0000');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (wrong PIN): expected 0 rows, got %', v_count;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (wrong PIN): 0 rows returned';
END $$;

-- 3. unknown user -> no rows (pre-flight already proved id 9999 is absent)
DO $$
DECLARE
  v_count int;
BEGIN
  PERFORM * FROM public.shop_write_check_pin(9999, '4242');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (unknown user): expected 0 rows for absent id 9999, got %', v_count;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (unknown user): 0 rows returned';
END $$;

-- 4. pin_hash IS NULL -> no rows, even though users.pin matches. The
--    helper has no plaintext fallback by design.
DO $$
DECLARE
  v_count int;
BEGIN
  PERFORM * FROM public.shop_write_check_pin(9003, '5151');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (null hash): expected 0 rows for pin_hash IS NULL even with matching plaintext pin, got % - the helper must not fall back to users.pin', v_count;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (null hash): 0 rows, no plaintext fallback';
END $$;

-- 5. no side effects: none of the calls above may have written to
--    pin_attempts (logging/throttling belong to shop-write, not here)
DO $$
DECLARE
  v_attempts int;
BEGIN
  SELECT count(*) INTO v_attempts FROM public.pin_attempts WHERE user_id IN (9002, 9003);
  IF v_attempts <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (side effects): % pin_attempts row(s) appeared for test ids - the helper must not log attempts', v_attempts;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (side effects): pin_attempts untouched';
END $$;

-- 6. ACL state. has_function_privilege('anon', ...) is true if anon holds
--    EXECUTE directly OR via a PUBLIC grant, so these two checks also
--    prove PUBLIC was revoked.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.shop_write_check_pin(bigint, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (ACL): anon can EXECUTE shop_write_check_pin (directly or via PUBLIC)';
  END IF;
  IF has_function_privilege('authenticated', 'public.shop_write_check_pin(bigint, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (ACL): authenticated can EXECUTE shop_write_check_pin (directly or via PUBLIC)';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.shop_write_check_pin(bigint, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (ACL): service_role cannot EXECUTE shop_write_check_pin - shop-write would break on cutover';
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (ACL): anon/authenticated/PUBLIC denied, service_role allowed';
END $$;

-- 7. runtime denial: actually assume each client-facing role and call the
--    helper; expect insufficient_privilege. SET LOCAL ROLE inside the
--    guarded block is undone automatically when the expected exception
--    rolls back the subtransaction, restoring this session's role.
DO $$
DECLARE
  v_assumed boolean := false;
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    v_assumed := true;
    PERFORM * FROM public.shop_write_check_pin(9002, '4242');
    RAISE EXCEPTION 'REHEARSAL FAILED (runtime anon): anon executed the helper without a permission error';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF v_assumed THEN
        RAISE NOTICE 'REHEARSAL PASSED (runtime anon): EXECUTE denied at call time';
      ELSE
        RAISE EXCEPTION 'REHEARSAL INCONCLUSIVE (runtime anon): this session cannot SET ROLE anon - rerun as a role with anon membership (e.g. postgres) or rely on check 6';
      END IF;
  END;
END $$;

DO $$
DECLARE
  v_assumed boolean := false;
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    v_assumed := true;
    PERFORM * FROM public.shop_write_check_pin(9002, '4242');
    RAISE EXCEPTION 'REHEARSAL FAILED (runtime authenticated): authenticated executed the helper without a permission error';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF v_assumed THEN
        RAISE NOTICE 'REHEARSAL PASSED (runtime authenticated): EXECUTE denied at call time';
      ELSE
        RAISE EXCEPTION 'REHEARSAL INCONCLUSIVE (runtime authenticated): this session cannot SET ROLE authenticated - rerun as a role with authenticated membership (e.g. postgres) or rely on check 6';
      END IF;
  END;
END $$;

-- ---------------------------------------------------------------------
-- Cleanup: ONLY rows scoped to test ids 9002/9003 created above. No
-- table-wide deletes. pin_attempts deleted first defensively (check 5
-- proved it should be empty for these ids), in case of an FK.
-- ---------------------------------------------------------------------

DELETE FROM public.pin_attempts WHERE user_id IN (9002, 9003);
DELETE FROM public.users WHERE id IN (9002, 9003);

DO $$
DECLARE
  v_left_attempts int;
  v_left_users int;
BEGIN
  SELECT count(*) INTO v_left_attempts FROM public.pin_attempts WHERE user_id IN (9002, 9003);
  SELECT count(*) INTO v_left_users FROM public.users WHERE id IN (9002, 9003);
  IF v_left_attempts <> 0 OR v_left_users <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL CLEANUP FAILED: % pin_attempts rows and % users rows still present for test ids 9002/9003', v_left_attempts, v_left_users;
  END IF;
  RAISE NOTICE 'REHEARSAL CLEANUP PASSED: no rows remain for test ids 9002/9003';
END $$;

COMMIT;
