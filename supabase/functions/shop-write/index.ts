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
// listed here (users, pin_attempts) is unreachable through this function
// regardless of what a caller sends -- this is the entire write surface.
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
  // has no per-staff Supabase Auth accounts). The PIN check below is the
  // actual authorization decision.
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) return json({ error: "Missing Authorization bearer token" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { userId, pin, op, table, values, match, onConflict } = body;
  const ip = getClientIp(req);

  if (!userId || typeof pin !== "string") return json({ error: "userId and pin are required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
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

  const userRow = !pinErr && Array.isArray(pinRows) && pinRows.length === 1 ? pinRows[0] : null;
  const pinOk = !!userRow;

  await admin.from("pin_attempts").insert({ user_id: userId, ip, success: pinOk });

  if (!userRow) {
    console.warn(`shop-write: failed PIN check for user ${userId} from ${ip}`);
    return json({ error: "Invalid user or PIN" }, 401);
  }

  const canDelete = userRow.role === "owner" || !!userRow.can_delete;

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
