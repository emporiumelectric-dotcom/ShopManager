-- 003_rehearsal.sql
--
-- Rehearses the post-cutover verify_pin (001 + 002 applied) against a single
-- THROWAWAY test user, id 9001 - well outside the live range 1-7. Exercises:
--   1. correct PIN            -> one row back
--   2. wrong PIN               -> no rows, failure logged
--   3. four more wrong PINs    -> failure count reaches 5
--   4. throttle trip           -> even the CORRECT PIN is now rejected,
--                                  and the attempt is still logged
--   5. sanity check on the resulting pin_attempts rows for this user
--
-- Everything runs inside one transaction. Every assertion below RAISEs an
-- EXCEPTION on failure, which aborts the transaction and automatically
-- rolls back everything the script did up to that point - including the
-- test user - so a failed rehearsal cannot leave stray rows behind on its
-- own. On success, this script ALSO runs its own explicit, id-scoped
-- DELETEs before COMMIT, so cleanup does not depend solely on that
-- rollback safety net (e.g. if run through a client that doesn't treat
-- BEGIN/COMMIT as one transaction, run each numbered block by hand and use
-- the cleanup block at the end regardless of outcome).
--
-- Every DELETE in this file is scoped to id / user_id = 9001. Nothing here
-- ever deletes from users or pin_attempts without that filter - no
-- table-wide deletes.
--
-- Run this AFTER 001_add_pin_hash.sql and 002_verify_pin_hash_cutover.sql,
-- and BEFORE trusting the cutover with real staff PINs.

BEGIN;

INSERT INTO public.users (id, name, role, pin, can_delete, pin_hash)
VALUES (
  9001,
  'PIN_HASH_REHEARSAL_TEST',
  'test',
  '4242',
  false,
  extensions.crypt('4242', extensions.gen_salt('bf'))
);

-- 1. correct PIN -> one row back, matching this user
DO $$
DECLARE
  v_row record;
  v_count int;
BEGIN
  SELECT * INTO v_row FROM public.verify_pin(9001, '4242');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 OR v_row.id IS DISTINCT FROM 9001::bigint THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (correct PIN): expected 1 row for id 9001, got % row(s) (%)', v_count, v_row;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (correct PIN): id=%, name=%, role=%, can_delete=%', v_row.id, v_row.name, v_row.role, v_row.can_delete;
END $$;

-- 2. wrong PIN -> no rows (1st failure logged)
DO $$
DECLARE
  v_count int;
BEGIN
  PERFORM * FROM public.verify_pin(9001, '0000');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (wrong PIN): expected 0 rows, got %', v_count;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (wrong PIN): 0 rows returned';
END $$;

-- 3. four more wrong attempts -> brings the 15-minute failure count to 5
DO $$
DECLARE
  v_count int;
  i int;
BEGIN
  FOR i IN 1..4 LOOP
    PERFORM * FROM public.verify_pin(9001, '0000');
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'REHEARSAL FAILED (throttle warm-up #%): expected 0 rows, got %', i, v_count;
    END IF;
  END LOOP;
  RAISE NOTICE 'REHEARSAL PASSED: 4 more wrong attempts logged, 5 failures now on record';
END $$;

-- 4. throttle trip: even the CORRECT pin is rejected, and the attempt is
--    still logged as a failure (locked path), not silently dropped
DO $$
DECLARE
  v_count int;
BEGIN
  PERFORM * FROM public.verify_pin(9001, '4242');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (throttle trip): correct PIN should be rejected while locked, got % rows', v_count;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (throttle trip): correct PIN rejected while locked';
END $$;

-- 5. sanity check on the attempt log itself: 1 success + 6 failures = 7 rows
--    (1 correct, 1 wrong, 4 more wrong, 1 locked-path attempt)
DO $$
DECLARE
  v_total int;
  v_fails int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE success = false)
    INTO v_total, v_fails
  FROM public.pin_attempts
  WHERE user_id = 9001;

  IF v_total <> 7 OR v_fails <> 6 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (attempt log): expected 7 total / 6 failures for user 9001, got % total / % failures', v_total, v_fails;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (attempt log): % total attempts, % failures logged for user 9001', v_total, v_fails;
END $$;

-- ---------------------------------------------------------------------
-- Cleanup: ONLY rows scoped to test user 9001. No table-wide deletes.
-- pin_attempts deleted before users defensively, in case of an FK.
-- ---------------------------------------------------------------------

DELETE FROM public.pin_attempts WHERE user_id = 9001;
DELETE FROM public.users WHERE id = 9001;

DO $$
DECLARE
  v_left_attempts int;
  v_left_user int;
BEGIN
  SELECT count(*) INTO v_left_attempts FROM public.pin_attempts WHERE user_id = 9001;
  SELECT count(*) INTO v_left_user FROM public.users WHERE id = 9001;
  IF v_left_attempts <> 0 OR v_left_user <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL CLEANUP FAILED: % pin_attempts rows and % users rows still present for id 9001', v_left_attempts, v_left_user;
  END IF;
  RAISE NOTICE 'REHEARSAL CLEANUP PASSED: no rows remain for test id 9001';
END $$;

COMMIT;
