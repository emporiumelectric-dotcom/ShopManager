import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Allow-listed tables and the columns callers may set on each. Anything not
// listed here (users, pin_attempts, shop_sessions) is unreachable through
// this function regardless of what a caller sends -- this is the entire
// write surface.
const TABLE_FIELDS: Record<string, string[]> = {
  items: ["store_id", "name", "category", "company", "unit", "qty", "min_stock", "rate", "updated_at"],
  item_locations: ["item_id", "location_id", "qty"],
  locations: ["store_id", "name", "is_default"],
  transactions: ["store_id", "type", "ref", "supplier", "txn_date", "by_user", "location_id", "from_location_id", "to_location_id"],
  transaction_items: ["transaction_id", "item_id", "item_name", "qty", "location_id"],
};

// Deletes, and edits to already-posted transactions, require can_delete --
// mirrors the client UI's existing gating (Delete buttons and the
// transaction-edit flow are hidden from non-can_delete users today). This
// makes that gate real: currently it's UI-only and any logged-in user could
// bypass it via devtools.
function requiresCanDelete(op: string, table: string): boolean {
  if (op === "delete") return true;
  if (op === "update" && (table === "transactions" || table === "transaction_items")) return true;
  return false;
}

function pickFields(table: string, obj: Record<string, unknown>) {
  const allowed = TABLE_FIELDS[table] || [];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj || {})) if (allowed.includes(k)) out[k] = (obj as any)[k];
  return out;
}

const WINDOW_MS = 15 * 60 * 1000;
const USER_FAIL_LIMIT = 5;
const IP_FAIL_LIMIT = 20;

// Session tokens (checklist 1.2.4). A login mints one; writes present it
// instead of the raw PIN. ~14h covers a full shop day, so expiry mid-sale
// only happens on a tab left open overnight (the client re-prompts and
// retries; see index.html callWrite once the client side ships).
const SESSION_TTL_MS = 14 * 60 * 60 * 1000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 256-bit random token, base64url-encoded (43 chars). Deliberately NOT hex:
// shop_sessions.token_hash carries a CHECK enforcing 64 lowercase hex chars,
// so a bug that stored the raw token instead of its hash would violate the
// constraint and fail loudly rather than silently keeping usable
// credentials at rest.
function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // verify_jwt (set at deploy time) already rejects requests with no valid
  // Supabase session before this code runs. That JWT only proves "a real
  // browser completed the anonymous-auth handshake" -- unlike AdminPanel,
  // the caller's identity isn't the authorization credential here (ShopManager
  // has no per-staff Supabase Auth accounts). The credential check below is
  // the actual authorization decision: a session token minted by op:"login",
  // or (old cached clients -- the service worker can serve stale index.html
  // for days) the raw PIN exactly as in v5.
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) return json({ error: "Missing Authorization bearer token" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { userId, pin, token, op, table, values, match, onConflict } = body;
  const ip = getClientIp(req);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let userRow: any = null;

  if (typeof token === "string" && token && op !== "login") {
    // ===== Token path (new clients). op:"login" never lands here -- a
    // login always re-verifies the PIN below, token or not. =====
    //
    // Failures on this path are NEVER logged to pin_attempts: they are not
    // PIN attempts, and per-user logging here would let anyone who knows a
    // userId lock that user out of writes by spamming garbage tokens --
    // exactly the mid-shift DoS this change removes. Guessing a 256-bit
    // token is not a realistic path, so a console.warn is enough.
    const tokenHash = await sha256Hex(token);
    const { data: sess, error: sessErr } = await admin
      .from("shop_sessions")
      .select("id, user_id, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (sessErr) {
      console.error(`shop-write: session lookup failed: ${sessErr.message}`);
      return json({ error: "Session lookup failed" }, 500);
    }
    if (!sess) {
      console.warn(`shop-write: unknown session token from ${ip}`);
      return json({ error: "Invalid session", code: "invalid_session" }, 401);
    }
    if (new Date(sess.expires_at).getTime() <= Date.now()) {
      // Distinguishable from a bad token so the client can re-prompt for
      // the PIN and retry instead of treating it as an attack/logout.
      console.warn(`shop-write: expired session for user ${sess.user_id} from ${ip}`);
      return json({ error: "Session expired", code: "session_expired" }, 401);
    }

    // Coarse activity trail now that pin_attempts only records logins.
    // Best-effort: a failed touch must not block the write.
    const { error: touchErr } = await admin
      .from("shop_sessions")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", sess.id);
    if (touchErr) console.warn(`shop-write: last_used_at touch failed: ${touchErr.message}`);

    // Re-derive the user per request (never cached in the session row) so
    // role/can_delete changes take effect immediately. Selected columns
    // only -- this function must never read users.pin (checklist 1.2.1).
    const { data: u, error: userErr } = await admin
      .from("users")
      .select("id, name, role, can_delete")
      .eq("id", sess.user_id)
      .maybeSingle();
    if (userErr) {
      console.error(`shop-write: session user lookup failed: ${userErr.message}`);
      return json({ error: "Session lookup failed" }, 500);
    }
    if (!u) {
      // User row gone mid-session (the FK cascade removes sessions when a
      // user is deleted, but a race is possible). Treat as invalid.
      console.warn(`shop-write: session for missing user ${sess.user_id} from ${ip}`);
      return json({ error: "Invalid session", code: "invalid_session" }, 401);
    }
    userRow = u;
  } else {
    // ===== PIN path: v5 behavior, unchanged (old cached clients, and
    // op:"login"). Only mechanical deltas from v5: `admin` is created
    // above the branch, and `const userRow` became an assignment to the
    // shared variable. Throttles, pin_attempts logging, error shapes and
    // status codes are byte-for-byte. =====
    if (!userId || typeof pin !== "string") return json({ error: "userId and pin are required" }, 400);

    const since = new Date(Date.now() - WINDOW_MS).toISOString();

    const { count: userFails } = await admin
      .from("pin_attempts")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("success", false)
      .gte("created_at", since);
    if ((userFails || 0) >= USER_FAIL_LIMIT) {
      console.warn(`shop-write: user ${userId} locked out (${userFails} failed attempts in the last 15m)`);
      return json({ error: "Too many failed attempts for this user. Try again later." }, 429);
    }

    const { count: ipFails } = await admin
      .from("pin_attempts")
      .select("*", { count: "exact", head: true })
      .eq("ip", ip)
      .eq("success", false)
      .gte("created_at", since);
    if ((ipFails || 0) >= IP_FAIL_LIMIT) {
      console.warn(`shop-write: ip ${ip} locked out (${ipFails} failed attempts in the last 15m)`);
      return json({ error: "Too many failed attempts from this network. Try again later." }, 429);
    }

    // The PIN comparison happens inside Postgres: shop_write_check_pin
    // (service-role-only, SECURITY DEFINER) bcrypt-compares against
    // users.pin_hash and returns the caller's user row only on a match --
    // wrong PIN, unknown user, and pin_hash IS NULL (no plaintext fallback)
    // all return zero rows. This function never reads users.pin.
    const { data: pinRows, error: pinErr } = await admin
      .rpc("shop_write_check_pin", { p_user_id: userId, p_pin: pin });

    userRow = !pinErr && Array.isArray(pinRows) && pinRows.length === 1 ? pinRows[0] : null;
    const pinOk = !!userRow;

    await admin.from("pin_attempts").insert({ user_id: userId, ip, success: pinOk });

    if (!userRow) {
      console.warn(`shop-write: failed PIN check for user ${userId} from ${ip}`);
      return json({ error: "Invalid user or PIN" }, 401);
    }
  }

  const canDelete = userRow.role === "owner" || !!userRow.can_delete;

  if (op === "login") {
    // ===== Mint a session (new clients call this once per login instead
    // of re-sending the PIN on every write). Reaching here means the PIN
    // path above already passed: throttles enforced, PIN verified via
    // shop_write_check_pin, pin_attempts success row written -- exactly as
    // for a v5 write. =====

    // Lazy cleanup of this user's expired sessions -- the deliberate
    // no-cron design (001_shop_sessions.sql). Best-effort: a failed
    // cleanup must not block the login.
    const { error: cleanupErr } = await admin
      .from("shop_sessions")
      .delete()
      .eq("user_id", userRow.id)
      .lte("expires_at", new Date().toISOString());
    if (cleanupErr) console.warn(`shop-write: expired-session cleanup failed for user ${userRow.id}: ${cleanupErr.message}`);

    const newToken = mintToken();
    const tokenHash = await sha256Hex(newToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    // Only the hash is stored (shop_sessions.token_hash, CHECK-constrained
    // to sha256 hex). The raw token exists only in this response and in
    // the staff device's page memory. Multiple concurrent sessions per
    // user are allowed by design (two devices).
    const { error: insertErr } = await admin
      .from("shop_sessions")
      .insert({ user_id: userRow.id, token_hash: tokenHash, expires_at: expiresAt });
    if (insertErr) {
      console.error(`shop-write: session insert failed for user ${userRow.id}: ${insertErr.message}`);
      return json({ error: "Could not create session" }, 500);
    }

    console.log(`shop-write: session minted for user ${userRow.id} from ${ip}, expires ${expiresAt}`);
    return json({ token: newToken, expiresAt, user: userRow });
  }

  if (!op || !table) return json({ error: "op and table are required" }, 400);
  if (!TABLE_FIELDS[table]) return json({ error: "Table not permitted: " + table }, 403);
  if (requiresCanDelete(op, table) && !canDelete) {
    return json({ error: "Not authorized for this action" }, 403);
  }

  try {
    if (op === "insert") {
      const rows = Array.isArray(values) ? values.map((v: any) => pickFields(table, v)) : pickFields(table, values);
      const { data, error } = await admin.from(table).insert(rows).select();
      if (error) return json({ error: error.message }, 500);
      return json({ data });
    }

    if (op === "upsert") {
      const rows = Array.isArray(values) ? values.map((v: any) => pickFields(table, v)) : pickFields(table, values);
      const { data, error } = await admin.from(table).upsert(rows, onConflict ? { onConflict } : undefined).select();
      if (error) return json({ error: error.message }, 500);
      return json({ data });
    }

    if (op === "update") {
      if (!match || typeof match !== "object" || !Object.keys(match).length) {
        return json({ error: "match is required for update" }, 400);
      }
      let q = admin.from(table).update(pickFields(table, values || {}));
      for (const k of Object.keys(match)) q = q.eq(k, match[k]);
      const { data, error } = await q.select();
      if (error) return json({ error: error.message }, 500);
      return json({ data });
    }

    if (op === "delete") {
      if (!match || typeof match !== "object" || !Object.keys(match).length) {
        return json({ error: "match is required for delete" }, 400);
      }
      let q = admin.from(table).delete();
      for (const k of Object.keys(match)) q = q.eq(k, match[k]);
      const { error } = await q;
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Unknown op: " + op }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
