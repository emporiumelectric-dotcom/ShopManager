-- 006_shop_write_check_pin.sql
--
-- Creates public.shop_write_check_pin(p_user_id, p_pin): the hash-compare
-- helper the shop-write Edge Function will call instead of reading
-- users.pin and comparing plaintext in TypeScript (checklist 1.2.1).
--
-- Deliberately NOT routed through verify_pin. shop-write keeps its own
-- throttles and its own pin_attempts logging, where the caller IP is known.
-- Routing writes through verify_pin would either kill the IP throttle
-- (verify_pin logs no ip) or, if shop-write kept logging too, record two
-- failure rows per failed write and silently drop the effective per-user
-- lockout threshold from 5 to 3.
--
-- Properties:
--   - Returns the caller's user row ONLY when extensions.crypt(p_pin,
--     pin_hash) equals pin_hash (bcrypt compare, same pgcrypto
--     implementation verify_pin uses). pgcrypto lives in the "extensions"
--     schema on this project, not "public", so the call is
--     schema-qualified.
--   - NO plaintext fallback: a row with pin_hash IS NULL never matches
--     (the crypt() comparison would yield NULL anyway; the explicit guard
--     makes the intent visible). This function must never read users.pin -
--     removing the last reader of that column is the point of the change.
--   - NO side effects: no pin_attempts insert, no throttling, no logging.
--     Those stay in shop-write. Because it has no side effects it is
--     marked STABLE - the VOLATILE lesson from the verify_pin throttling
--     work (BACKLOG.md) applied to a function whose inserts must not be
--     collapsed by the planner; there is nothing here to collapse.
--   - Service-role only: EXECUTE revoked from PUBLIC, anon, and
--     authenticated below. With no throttle inside, an EXECUTE leak to
--     anon would allow unthrottled offline-style PIN guessing over RPC,
--     so the REVOKEs are the security boundary of this function.
--     007_shop_write_check_pin_rehearsal.sql asserts them.
--
-- SECURITY DEFINER (matching verify_pin and sync_pin_hash) so behavior
-- does not depend on the caller's RLS/grant state on users; safe because
-- EXECUTE is restricted to service_role.
--
-- Idempotent: CREATE OR REPLACE plus re-runnable REVOKE/GRANT, so this
-- file can be re-applied safely. CREATE OR REPLACE preserves any existing
-- ACL, which is why the REVOKEs are (re)issued alongside it.
--
-- Does NOT touch users.pin, verify_pin, the users_sync_pin_hash trigger,
-- or the shop-write Edge Function. Applying this file changes no live
-- behavior at all until shop-write is rewritten to call it.

BEGIN;

CREATE OR REPLACE FUNCTION public.shop_write_check_pin(p_user_id bigint, p_pin text)
RETURNS TABLE(id bigint, name text, role text, can_delete boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT u.id, u.name, u.role, u.can_delete
  FROM users u
  WHERE u.id = p_user_id
    AND u.pin_hash IS NOT NULL
    AND u.pin_hash = extensions.crypt(p_pin, u.pin_hash);
$$;

COMMENT ON FUNCTION public.shop_write_check_pin(bigint, text) IS
  'Service-role-only bcrypt PIN check for the shop-write Edge Function. '
  'No throttle, no attempt logging - shop-write does both (it knows the caller IP). '
  'Never reads users.pin; a row without pin_hash never matches.';

-- Functions are EXECUTE-able by PUBLIC by default (and this project's
-- default privileges also grant anon/authenticated on new public
-- functions). Close all of that, then grant the one intended caller.
REVOKE ALL ON FUNCTION public.shop_write_check_pin(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shop_write_check_pin(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.shop_write_check_pin(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.shop_write_check_pin(bigint, text) TO service_role;

COMMIT;

-- Verification: run 007_shop_write_check_pin_rehearsal.sql (manual, via
-- psql, NOT applied automatically). It proves correct/wrong/unknown-PIN
-- behavior, the absence of side effects, and that anon/authenticated are
-- denied EXECUTE, using only throwaway rows it creates itself.
