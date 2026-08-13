-- 004_rollback.sql
--
-- Emergency rollback for the PIN-hashing cutover (002_verify_pin_hash_cutover.sql).
--
-- Restores the ORIGINAL verify_pin body (plaintext-only comparison),
-- reproduced verbatim from before the cutover, and clears pin_attempts rows
-- for the 7 live staff (user_ids 1-7) so nobody is left locked out by
-- failed attempts made during the cutover.
--
-- Does NOT drop users.pin_hash. Leaving the column is harmless; dropping it
-- would lose the backfill and force a full re-hash if the cutover is
-- retried later. Does NOT touch users.pin.
--
-- This restores comparison-site 1 (verify_pin) only. It has no effect on
-- shop-write, which this package never touched.

BEGIN;

CREATE OR REPLACE FUNCTION public.verify_pin(p_user_id bigint, p_pin text)
 RETURNS TABLE(id bigint, name text, role text, can_delete boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fails int;
  v_ok boolean := false;
BEGIN
  -- count recent failures for this user only
  SELECT count(*) INTO v_fails
  FROM pin_attempts
  WHERE user_id = p_user_id
    AND success = false
    AND created_at > now() - interval '15 minutes';

  -- locked: log and return nothing, same shape as a wrong PIN
  IF v_fails >= 5 THEN
    INSERT INTO pin_attempts (user_id, success) VALUES (p_user_id, false);
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = p_user_id AND u.pin = p_pin
  ) INTO v_ok;

  INSERT INTO pin_attempts (user_id, success) VALUES (p_user_id, v_ok);

  IF v_ok THEN
    RETURN QUERY
      SELECT u.id, u.name, u.role, u.can_delete
      FROM users u
      WHERE u.id = p_user_id;
  END IF;

  RETURN;
END;
$function$;

-- Clear attempt history for the 7 live staff only, so nobody is left
-- throttled/locked-out by attempts made during the cutover attempt. This
-- clears ALL of their pin_attempts rows (success and failure alike), not
-- just failures - deliberate, per rollback intent: a clean slate. Scoped by
-- id - never a table-wide delete.
DELETE FROM public.pin_attempts WHERE user_id IN (1, 2, 3, 4, 5, 6, 7);

COMMIT;
