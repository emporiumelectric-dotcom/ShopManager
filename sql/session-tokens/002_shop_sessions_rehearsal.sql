-- 002_shop_sessions_rehearsal.sql
--
-- Rehearses public.shop_sessions (001 applied) using ONLY throwaway
-- rows: test user id 9005 (outside the live range 1-7, distinct from
-- earlier rehearsals' 9001-9004) and session rows whose token hashes
-- derive from the literal labels below. NOT applied automatically.
--
-- AUTOCOMMIT WARNING: the Supabase dashboard SQL editor autocommits
-- per run and does not preserve BEGIN/COMMIT across separate runs
-- (learned the hard way in the 2026-08-16 pin-hashing rehearsal), so
-- CLEANUP MUST NOT DEPEND ON THE ENCLOSING TRANSACTION. Accordingly:
--   - The success path cleans up via explicit DELETEs scoped to this
--     run's rows (the FK-cascade check doubles as cleanup) and then
--     verifies zero rows remain - no rollback involved.
--   - If a check RAISEs mid-script under autocommit, already-committed
--     pieces persist. Manual cleanup, scoped to this run only:
--         DELETE FROM public.shop_sessions WHERE user_id = 9005;
--         DELETE FROM public.users        WHERE id      = 9005;
--   - The BEGIN/COMMIT below still gives an all-or-nothing safety net
--     when the file runs through a client that honors it as one
--     transaction (psql, or the dashboard editor in a SINGLE
--     submission). Prefer that; never run this file in pieces.
--
-- Exercises:
--   1. pre-flight            -> 001 applied; id 9005 and this run's
--                               token hashes are free (refuses to run
--                               rather than delete rows it didn't
--                               create)
--   2. schema guards         -> a raw-looking token (not sha256 hex)
--                               is rejected; expires_at <= created_at
--                               is rejected
--   3. insert + lookup       -> a live and an expired session insert;
--                               lookup by token hash returns the live
--                               row with the right user_id/expiry
--   4. expiry predicate      -> the expired row is invisible to the
--                               liveness predicate (expires_at >
--                               now()) but identifiable without it
--   5. unknown token         -> lookup of an unminted hash -> 0 rows
--   6. last_used_at touch    -> the per-write touch UPDATE works
--   7. ACL state             -> anon/authenticated (and via PUBLIC)
--                               hold no table or sequence privilege;
--                               service_role does; RLS enabled; zero
--                               policies (deny-all); WARNING (not
--                               failure) if pin_attempts' live posture
--                               is looser than what 001 mirrors
--   8. runtime denial        -> actually assuming role anon and role
--                               authenticated, SELECT raises
--                               insufficient_privilege
--   9. FK cascade + cleanup  -> deleting users row 9005 cascades away
--                               its sessions; explicit scoped DELETEs
--                               and a zero-rows verification follow
--
-- Every INSERT and DELETE in this file is scoped to id 9005 or to the
-- two token hashes derived from this file's literal labels. No
-- table-wide deletes.
--
-- Test users INSERT needs OVERRIDING SYSTEM VALUE: users.id is
-- GENERATED ALWAYS AS IDENTITY (2026-08-16 rehearsal lesson). Explicit
-- pin_hash because the users_sync_pin_hash trigger fires on UPDATE OF
-- pin only, not on INSERT.

BEGIN;

-- 1. Pre-flight
DO $$
DECLARE
  v_users int;
  v_sessions int;
BEGIN
  IF to_regclass('public.shop_sessions') IS NULL THEN
    RAISE EXCEPTION 'REHEARSAL PRE-FLIGHT FAILED: public.shop_sessions does not exist - apply 001_shop_sessions.sql first';
  END IF;
  SELECT count(*) INTO v_users FROM public.users WHERE id = 9005;
  SELECT count(*) INTO v_sessions FROM public.shop_sessions
   WHERE user_id = 9005
      OR token_hash IN (
           encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_LIVE_9005',    'sha256'), 'hex'),
           encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_EXPIRED_9005', 'sha256'), 'hex'));
  IF v_users <> 0 OR v_sessions <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL PRE-FLIGHT FAILED: % users row(s) for id 9005 and % shop_sessions row(s) for this run''s ids already exist - clean up manually first (this script only deletes rows it created itself)', v_users, v_sessions;
  END IF;
  RAISE NOTICE 'REHEARSAL PRE-FLIGHT PASSED: table exists, id 9005 and token hashes free';
END $$;

INSERT INTO public.users (id, name, role, pin, can_delete, pin_hash)
OVERRIDING SYSTEM VALUE
VALUES (9005, 'SHOP_SESSIONS_TEST', 'test', '4242', false,
        extensions.crypt('4242', extensions.gen_salt('bf')));

-- 2. Schema guards: both CHECK constraints must reject bad rows.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.shop_sessions (user_id, token_hash, expires_at)
    VALUES (9005, 'RAW-TOKEN-THAT-SHOULD-NEVER-BE-STORED',
            now() + interval '1 hour');
    RAISE EXCEPTION 'REHEARSAL FAILED (token format): a non-sha256-hex token_hash was accepted - the format CHECK is missing or wrong';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'REHEARSAL PASSED (token format): raw-looking token rejected by CHECK';
  END;
  BEGIN
    INSERT INTO public.shop_sessions (user_id, token_hash, created_at, expires_at)
    VALUES (9005,
            encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_BADRANGE_9005', 'sha256'), 'hex'),
            now(), now() - interval '1 hour');
    RAISE EXCEPTION 'REHEARSAL FAILED (expiry range): expires_at <= created_at was accepted - the range CHECK is missing or wrong';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'REHEARSAL PASSED (expiry range): inverted expiry rejected by CHECK';
  END;
END $$;

-- 3. Insert one live and one already-expired session, then look the
--    live one up by token hash exactly the way shop-write v6 will.
INSERT INTO public.shop_sessions (user_id, token_hash, created_at, expires_at)
VALUES
  (9005,
   encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_LIVE_9005', 'sha256'), 'hex'),
   now(), now() + interval '14 hours'),
  (9005,
   encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_EXPIRED_9005', 'sha256'), 'hex'),
   now() - interval '2 hours', now() - interval '1 hour');

DO $$
DECLARE
  v_row record;
  v_count int;
BEGIN
  SELECT s.* INTO v_row
  FROM public.shop_sessions s
  WHERE s.token_hash = encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_LIVE_9005', 'sha256'), 'hex')
    AND s.expires_at > now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1
     OR v_row.user_id IS DISTINCT FROM 9005::bigint
     OR v_row.expires_at <= now() THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (lookup): expected exactly the live session row for user 9005, got % row(s) (%)', v_count, v_row;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (lookup): live session found by token hash, user_id=%, expires_at=%', v_row.user_id, v_row.expires_at;
END $$;

-- 4. Expiry predicate: the expired row must be invisible to the
--    liveness predicate but still present (identifiable) without it.
DO $$
DECLARE
  v_live int;
  v_present int;
BEGIN
  SELECT count(*) INTO v_live FROM public.shop_sessions
   WHERE token_hash = encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_EXPIRED_9005', 'sha256'), 'hex')
     AND expires_at > now();
  SELECT count(*) INTO v_present FROM public.shop_sessions
   WHERE token_hash = encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_EXPIRED_9005', 'sha256'), 'hex');
  IF v_live <> 0 OR v_present <> 1 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (expiry): expired session matched the liveness predicate % time(s) / present % time(s) (want 0 / 1)', v_live, v_present;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (expiry): expired row excluded by expires_at > now(), still identifiable';
END $$;

-- 5. Unknown token hash -> 0 rows
DO $$
DECLARE
  v_count int;
BEGIN
  PERFORM 1 FROM public.shop_sessions
   WHERE token_hash = encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_NEVER_MINTED', 'sha256'), 'hex');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (unknown token): expected 0 rows, got %', v_count;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (unknown token): 0 rows returned';
END $$;

-- 6. last_used_at touch (the per-write UPDATE shop-write v6 will do)
DO $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.shop_sessions
     SET last_used_at = now()
   WHERE token_hash = encode(extensions.digest('SHOP_SESSIONS_REHEARSAL_LIVE_9005', 'sha256'), 'hex')
     AND expires_at > now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (touch): last_used_at update hit % row(s), want 1', v_count;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (touch): last_used_at updated on the live session';
END $$;

-- 7. ACL state. has_table_privilege('anon', ...) is true if anon holds
--    the privilege directly OR via PUBLIC, so these checks also prove
--    PUBLIC was revoked. Sequence checked too (default privileges
--    cover sequences). pin_attempts parity is a WARNING, not a
--    failure: shop_sessions being stricter than pin_attempts is fine,
--    but pin_attempts being looser than 001 assumed is worth knowing.
DO $$
DECLARE
  v_seq text := pg_get_serial_sequence('public.shop_sessions', 'id');
  v_priv text;
  v_policies int;
BEGIN
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.shop_sessions', v_priv) THEN
      RAISE EXCEPTION 'REHEARSAL FAILED (ACL): anon has % on shop_sessions (directly or via PUBLIC)', v_priv;
    END IF;
    IF has_table_privilege('authenticated', 'public.shop_sessions', v_priv) THEN
      RAISE EXCEPTION 'REHEARSAL FAILED (ACL): authenticated has % on shop_sessions (directly or via PUBLIC)', v_priv;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.shop_sessions', v_priv) THEN
      RAISE EXCEPTION 'REHEARSAL FAILED (ACL): service_role lacks % on shop_sessions - shop-write v6 would break', v_priv;
    END IF;
  END LOOP;
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (ACL): shop_sessions.id has no backing sequence';
  END IF;
  IF has_sequence_privilege('anon', v_seq, 'USAGE')
     OR has_sequence_privilege('authenticated', v_seq, 'USAGE') THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (ACL): anon/authenticated can use the identity sequence %', v_seq;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shop_sessions'::regclass) THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (RLS): row level security is not enabled on shop_sessions';
  END IF;
  SELECT count(*) INTO v_policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'shop_sessions';
  IF v_policies <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (RLS): expected zero policies (deny-all) on shop_sessions, found %', v_policies;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (ACL): anon/authenticated/PUBLIC denied on table+sequence, service_role allowed, RLS on, zero policies';

  IF to_regclass('public.pin_attempts') IS NOT NULL THEN
    IF has_table_privilege('anon', 'public.pin_attempts', 'SELECT')
       OR has_table_privilege('authenticated', 'public.pin_attempts', 'SELECT')
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pin_attempts'::regclass) THEN
      RAISE WARNING 'REHEARSAL PARITY WARNING: live pin_attempts is looser than the posture 001 mirrored (client-role SELECT or RLS off) - shop_sessions itself is fine, but review pin_attempts';
    ELSE
      RAISE NOTICE 'REHEARSAL PASSED (parity): pin_attempts matches the mirrored lockdown';
    END IF;
  END IF;
END $$;

-- 8. Runtime denial: actually assume each client-facing role and
--    SELECT; expect insufficient_privilege. SET LOCAL ROLE inside the
--    guarded block is undone automatically when the expected exception
--    rolls back the subtransaction, restoring this session's role.
DO $$
DECLARE
  v_assumed boolean := false;
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    v_assumed := true;
    PERFORM 1 FROM public.shop_sessions WHERE user_id = 9005;
    RAISE EXCEPTION 'REHEARSAL FAILED (runtime anon): anon read shop_sessions without a permission error';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF v_assumed THEN
        RAISE NOTICE 'REHEARSAL PASSED (runtime anon): SELECT denied at call time';
      ELSE
        RAISE EXCEPTION 'REHEARSAL INCONCLUSIVE (runtime anon): this session cannot SET ROLE anon - rerun as a role with anon membership (e.g. postgres) or rely on check 7';
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
    PERFORM 1 FROM public.shop_sessions WHERE user_id = 9005;
    RAISE EXCEPTION 'REHEARSAL FAILED (runtime authenticated): authenticated read shop_sessions without a permission error';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF v_assumed THEN
        RAISE NOTICE 'REHEARSAL PASSED (runtime authenticated): SELECT denied at call time';
      ELSE
        RAISE EXCEPTION 'REHEARSAL INCONCLUSIVE (runtime authenticated): this session cannot SET ROLE authenticated - rerun as a role with authenticated membership (e.g. postgres) or rely on check 7';
      END IF;
  END;
END $$;

-- ---------------------------------------------------------------------
-- 9. FK cascade + cleanup. Deleting the test users row must cascade
--    away its sessions (this is the revocation-on-staff-removal
--    property, and it doubles as cleanup). ONLY rows scoped to id 9005
--    created above; no table-wide deletes. The explicit shop_sessions
--    DELETE afterwards is belt-and-braces - the cascade check requires
--    it to find nothing.
-- ---------------------------------------------------------------------

DELETE FROM public.users WHERE id = 9005;

DO $$
DECLARE
  v_orphans int;
BEGIN
  SELECT count(*) INTO v_orphans FROM public.shop_sessions WHERE user_id = 9005;
  IF v_orphans <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (cascade): % shop_sessions row(s) survived deleting users row 9005 - ON DELETE CASCADE is not working', v_orphans;
  END IF;
  RAISE NOTICE 'REHEARSAL PASSED (cascade): deleting the user removed its sessions';
END $$;

DELETE FROM public.shop_sessions WHERE user_id = 9005;

DO $$
DECLARE
  v_left_sessions int;
  v_left_users int;
BEGIN
  SELECT count(*) INTO v_left_sessions FROM public.shop_sessions WHERE user_id = 9005;
  SELECT count(*) INTO v_left_users FROM public.users WHERE id = 9005;
  IF v_left_sessions <> 0 OR v_left_users <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL CLEANUP FAILED: % shop_sessions rows and % users rows still present for test id 9005', v_left_sessions, v_left_users;
  END IF;
  RAISE NOTICE 'REHEARSAL CLEANUP PASSED: no rows remain for test id 9005';
END $$;

COMMIT;
