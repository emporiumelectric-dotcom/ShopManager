-- 005_pin_hash_sync_trigger.sql
--
-- APPLIED TO PRODUCTION 2026-08-14. Recorded here after the fact.
--
-- Keeps users.pin_hash in step with users.pin. Without this, updating pin
-- alone leaves a stale hash: that user can still write (shop-write compares
-- plaintext pin) but cannot log in (verify_pin compares pin_hash).
--
-- This trigger becomes unnecessary once shop-write calls verify_pin and the
-- plaintext pin column is dropped. Drop it in the same change.
--
-- pgcrypto lives in the "extensions" schema on this project, so both calls
-- are schema-qualified. The function's search_path is 'public'; an
-- unqualified crypt() would throw at runtime.
--
-- Note: users.id is GENERATED ALWAYS AS IDENTITY. Any test fixture must let
-- the database assign the id rather than inserting one.

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_pin_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.pin IS DISTINCT FROM OLD.pin THEN
    NEW.pin_hash := extensions.crypt(NEW.pin, extensions.gen_salt('bf'));
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER users_sync_pin_hash
  BEFORE UPDATE OF pin ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_pin_hash();

COMMIT;

-- Rollback:
--   DROP TRIGGER IF EXISTS users_sync_pin_hash ON public.users;
--   DROP FUNCTION IF EXISTS public.sync_pin_hash();
