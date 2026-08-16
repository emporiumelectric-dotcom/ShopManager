-- 001_shop_sessions.sql
--
-- Creates public.shop_sessions: the server-side session store for
-- checklist 1.2.4 (stop the client re-sending the raw PIN on every
-- write). The shop-write Edge Function (future v6) will mint a session
-- at login (op:"login": existing throttle + shop_write_check_pin +
-- pin_attempts logging, then insert a row here) and validate writes by
-- looking up the SHA-256 hash of the presented token.
--
-- Applying this file changes NO live behavior: nothing reads or writes
-- this table until shop-write v6 is deployed. It is safe to apply ahead
-- of the function change and safe to leave in place if that change is
-- delayed or rolled back (v4/v5 never touch it).
--
-- Properties:
--   - Stores only token_hash (lowercase SHA-256 hex of the opaque
--     token), never the token itself. A leaked dump of this table does
--     not yield usable credentials. The format CHECK below rejects
--     anything that does not look like a sha256 hex digest, so a bug
--     that tried to store a raw token (base64url, wrong length, upper
--     case) fails loudly at INSERT instead of silently weakening this.
--   - The UNIQUE constraint on token_hash doubles as the lookup index
--     shop-write will use on every write (one indexed probe replaces
--     the per-write bcrypt compare).
--   - Liveness predicate is: expires_at > now(). Expired rows are left
--     in place and identifiable; shop-write v6's login op will lazily
--     delete a user's expired rows (no cron/pg_cron dependency).
--   - last_used_at exists for coarse per-session activity visibility
--     (pin_attempts stops being a de-facto write log after 1.2.4);
--     shop-write may touch it on validated writes.
--   - user_id references users(id) ON DELETE CASCADE: removing a staff
--     row revokes that person's sessions in the same statement. The
--     users.id column being GENERATED ALWAYS AS IDENTITY does not
--     affect this FK (it only matters for test INSERTs into users,
--     which need OVERRIDING SYSTEM VALUE - rehearsal 002 does this).
--   - Multiple concurrent sessions per user are allowed by design (two
--     devices); no uniqueness on user_id. The plain index on user_id
--     supports the lazy expired-row cleanup and the cascade path
--     (Postgres does not auto-index FK referencing columns).
--
-- Lockdown - service-role only, mirroring pin_attempts:
--   pin_attempts' own DDL is not in this repo (it predates the sql/
--   convention), but its posture is documented and relied upon
--   (shop-write/index.ts: users and pin_attempts are "unreachable
--   through this function"; no client code path touches it). Mirrored
--   here explicitly: RLS ENABLED with ZERO policies (deny-all for any
--   RLS-subject role), plus REVOKE of all table AND identity-sequence
--   privileges from PUBLIC/anon/authenticated. This project's default
--   privileges grant anon/authenticated on new public tables and
--   sequences (same lesson as the function-EXECUTE defaults in
--   pin-hashing/006), so the REVOKEs are load-bearing, not decorative.
--   service_role keeps access (explicit GRANTs; it also carries
--   BYPASSRLS on Supabase, which is why no policies are needed for the
--   Edge Function's admin client). Rehearsal 002 asserts all of this
--   and warns if the live pin_attempts posture turns out looser than
--   what this file mirrors.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- plus re-runnable ALTER/REVOKE/GRANT, so the file can be re-applied
-- safely. (If the table already exists, the CREATE is skipped whole -
-- including its constraints - so do not edit constraints here expecting
-- a re-run to apply them to a live table; that needs its own numbered
-- file.)
--
-- Dashboard note: apply as ONE run of the SQL editor (it autocommits
-- per run and does not preserve BEGIN/COMMIT across separate runs).

BEGIN;

CREATE TABLE IF NOT EXISTS public.shop_sessions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL
               REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash   text   NOT NULL
               CONSTRAINT shop_sessions_token_hash_key UNIQUE
               CONSTRAINT shop_sessions_token_hash_format_chk
                 CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT shop_sessions_expiry_after_creation_chk
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS shop_sessions_user_id_idx
  ON public.shop_sessions (user_id);

COMMENT ON TABLE public.shop_sessions IS
  'Service-role-only session store for shop-write (checklist 1.2.4). '
  'Rows are minted by shop-write op:"login" after the PIN check and '
  'validated on every write by token_hash lookup. Live means '
  'expires_at > now(); expired rows are lazily deleted at login.';
COMMENT ON COLUMN public.shop_sessions.token_hash IS
  'Lowercase SHA-256 hex of the opaque session token. The raw token '
  'exists only in the staff device''s page memory and in flight.';
COMMENT ON COLUMN public.shop_sessions.last_used_at IS
  'Touched by shop-write on validated writes; coarse activity trail '
  'now that pin_attempts only records logins.';

-- Lockdown. RLS on with no policies denies everything to RLS-subject
-- roles even if a grant leaks back later; the REVOKEs close the grants
-- this project's default privileges hand to anon/authenticated on new
-- public tables. Both layers are asserted by rehearsal 002.
ALTER TABLE public.shop_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shop_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.shop_sessions FROM anon;
REVOKE ALL ON TABLE public.shop_sessions FROM authenticated;
GRANT ALL ON TABLE public.shop_sessions TO service_role;

-- Same closure for the identity column's backing sequence (default
-- privileges cover new sequences too; name resolved dynamically rather
-- than assuming the generated shop_sessions_id_seq).
DO $$
DECLARE
  v_seq text := pg_get_serial_sequence('public.shop_sessions', 'id');
BEGIN
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'shop_sessions.id has no backing sequence - identity column missing?';
  END IF;
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', v_seq);
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon', v_seq);
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM authenticated', v_seq);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', v_seq);
END $$;

COMMIT;

-- Verification: run 002_shop_sessions_rehearsal.sql (manual - proves
-- insert/lookup-by-hash, the expiry predicate, anon/authenticated
-- denial at both the ACL and runtime level, service_role access, the
-- FK cascade, and parity with pin_attempts' lockdown, using only a
-- throwaway user id 9005 it creates and removes itself).
--
-- Quick parity spot-check against pin_attempts, if wanted standalone:
--   SELECT c.relname, c.relrowsecurity,
--          has_table_privilege('anon', c.oid, 'SELECT')          AS anon_select,
--          has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
--          has_table_privilege('service_role', c.oid, 'SELECT')  AS svc_select
--   FROM pg_class c
--   WHERE c.oid IN ('public.shop_sessions'::regclass,
--                   'public.pin_attempts'::regclass);
-- Expect relrowsecurity = true and anon/auth = false on both rows.
