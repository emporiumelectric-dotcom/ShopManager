-- 001_add_pin_hash.sql
--
-- Adds a nullable users.pin_hash column and backfills it for every existing
-- row (the 7 live staff, ids 1-7) using pgcrypto's blowfish crypt() with a
-- freshly generated salt per row.
--
-- Does NOT touch users.pin. The plaintext column is left fully intact,
-- because the shop-write Edge Function still reads it and is not being
-- changed tonight (see project notes). Does NOT touch verify_pin - that
-- cutover is 002_verify_pin_hash_cutover.sql.
--
-- pgcrypto lives in the "extensions" schema on this project, not "public",
-- so every call below is schema-qualified.
--
-- Idempotent: the UPDATE only fills rows where pin_hash IS NULL, so this
-- file can be re-run safely (e.g. if a later row is added before pin is
-- ever removed, or a prior partial run is being completed).

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pin_hash text;

UPDATE public.users
SET pin_hash = extensions.crypt(pin, extensions.gen_salt('bf'))
WHERE pin_hash IS NULL;

COMMIT;

-- Manual verification (read-only, run by hand after applying):
--   SELECT id, name, (pin_hash IS NOT NULL) AS hashed FROM public.users ORDER BY id;
-- Expect all 7 rows (ids 1-7) to show hashed = true before trusting
-- 002_verify_pin_hash_cutover.sql's primary (hash) path for everyone.
