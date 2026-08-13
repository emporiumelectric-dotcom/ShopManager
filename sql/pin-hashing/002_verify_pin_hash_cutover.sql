-- 002_verify_pin_hash_cutover.sql
--
-- Moves verify_pin's comparison from plaintext users.pin to users.pin_hash,
-- with a deliberate fallback to plaintext when a given row has no hash yet
-- (pin_hash IS NULL) - so a backfill gap locks nobody out.
--
-- Preconditions: 001_add_pin_hash.sql has been applied. Recommended: confirm
-- pin_hash is populated for all 7 live users first (see the verification
-- query at the bottom of 001) so this cutover uses the hash path for
-- everyone in practice; the plaintext fallback below only matters if that
-- isn't true.
--
-- Unchanged from the original: signature, RETURNS TABLE shape, SECURITY
-- DEFINER, search_path = 'public', and the throttle logic (5 failures / 15
-- minutes, one pin_attempts row inserted per call including the locked
-- path) - byte-identical behaviour to the original function.
--
-- search_path is 'public' here, NOT 'public, extensions', so every pgcrypto
-- call is schema-qualified (extensions.crypt). An unqualified crypt() call
-- would throw "function crypt(...) does not exist" at runtime and lock out
-- all 7 staff - do not remove the extensions. prefix.

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
  v_pin_hash text;
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

  SELECT u.pin_hash INTO v_pin_hash
  FROM users u
  WHERE u.id = p_user_id;

  IF v_pin_hash IS NOT NULL THEN
    -- primary path: this row has been backfilled, compare against the hash
    SELECT EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = p_user_id
        AND u.pin_hash = extensions.crypt(p_pin, u.pin_hash)
    ) INTO v_ok;
  ELSE
    -- fallback path: no hash yet for this row (backfill gap). Compare
    -- plaintext so this user can still log in instead of being locked out.
    -- Deliberate - see sql/pin-hashing/NOTES.md.
    SELECT EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = p_user_id AND u.pin = p_pin
    ) INTO v_ok;
  END IF;

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

COMMIT;
