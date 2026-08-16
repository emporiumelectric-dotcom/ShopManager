"use strict";

// Behavior and wire-shape tests for the v6 write layer in index.html:
// callWrite / postWrite / mintSession / reauthPrompt (sliced out and run in
// a vm sandbox -- see vm-harness.cjs). All 21+ callWrite call sites depend
// on the contract pinned here.
//
// The single most important rule under test: a write is retried ONLY on
// 401 + code:"session_expired" after a successful re-auth, exactly once.
// Network errors, timeouts, and every other error status must NEVER retry,
// because the original write may have landed -- an auto-retry would
// double-post a sale.

const assert = require("assert");
const vm = require("vm");
const h = require("./vm-harness.cjs");

const suite = h.makeSuite("write-layer");
const test = suite.test;

function okData(data) {
  return h.jsonResponse(200, { data: data });
}

function expiredResponse() {
  return h.jsonResponse(401, { error: "Session expired", code: "session_expired" });
}

function loginOk(token) {
  return h.jsonResponse(200, {
    token: token,
    expiresAt: "2026-08-17T08:00:00.000Z",
    user: { id: 7, name: "Akshay", role: "staff", can_delete: false }
  });
}

function call(context, expr) {
  return vm.runInContext(expr, context);
}

function promptCount(dom) {
  // reauthPrompt is the only code in the slice that creates elements.
  return dom.created.length;
}

async function submitPrompt(dom, pin) {
  await h.waitFor(function () {
    return dom.registry.raok && dom.registry.raok.onclick;
  }, "re-auth prompt to appear");
  dom.registry.rapin.value = pin;
  return dom.registry.raok.onclick();
}

// ---------------------------------------------------------------------------
// #1 contract: request wire shape, headers, return shape, never throws
// ---------------------------------------------------------------------------

test("insert: payload shape, headers, {data,error:null} return", async function () {
  const fetchStub = h.makeFetch(function () {
    return okData([{ id: 99 }]);
  });
  const w = h.makeWriteContext({ fetch: fetchStub });
  const result = await call(w.context, 'callWrite("insert","items",{values:{name:"ZZTEST",qty:4}})');

  assert.strictEqual(fetchStub.calls.length, 1);
  const c = fetchStub.calls[0];
  assert.strictEqual(c.url, h.WRITE_FN_URL);
  assert.strictEqual(c.options.method, "POST");
  assert.strictEqual(c.headers.Authorization, "Bearer " + h.SB_ACCESS_TOKEN);
  assert.strictEqual(c.headers.apikey, h.ANON_KEY);
  assert.strictEqual(c.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(c.body, {
    userId: 7,
    token: "stale-token",
    op: "insert",
    table: "items",
    values: { name: "ZZTEST", qty: 4 }
  });
  assert(!("pin" in c.body), "a write must never carry a PIN (v6 sends the session token)");
  assert.deepStrictEqual(h.plain(result), { data: [{ id: 99 }], error: null });
});

test("update/delete/upsert: opts (values, match, onConflict) pass through", async function () {
  const fetchStub = h.makeFetch(function (c) {
    return c.body.op === "delete" ? h.jsonResponse(200, { ok: true }) : okData([]);
  });
  const w = h.makeWriteContext({ fetch: fetchStub });

  await call(w.context, 'callWrite("update","items",{values:{qty:5},match:{id:3}})');
  await call(w.context, 'callWrite("delete","transaction_items",{match:{transaction_id:11}})');
  await call(w.context, 'callWrite("upsert","item_locations",{values:{item_id:1,location_id:2,qty:9},onConflict:"item_id,location_id"})');

  assert.deepStrictEqual(fetchStub.calls[0].body, {
    userId: 7, token: "stale-token", op: "update", table: "items",
    values: { qty: 5 }, match: { id: 3 }
  });
  assert.deepStrictEqual(fetchStub.calls[1].body, {
    userId: 7, token: "stale-token", op: "delete", table: "transaction_items",
    match: { transaction_id: 11 }
  });
  assert.deepStrictEqual(fetchStub.calls[2].body, {
    userId: 7, token: "stale-token", op: "upsert", table: "item_locations",
    values: { item_id: 1, location_id: 2, qty: 9 }, onConflict: "item_id,location_id"
  });
});

test("no Supabase auth session: Authorization falls back to the anon key", async function () {
  const fetchStub = h.makeFetch(function () {
    return okData([]);
  });
  const w = h.makeWriteContext({ fetch: fetchStub, session: null });
  await call(w.context, 'callWrite("insert","items",{values:{name:"X"}})');
  assert.strictEqual(fetchStub.calls[0].headers.Authorization, "Bearer " + h.ANON_KEY);
});

test("logged-out ST.user: body carries userId:null, token:null (no crash)", async function () {
  const fetchStub = h.makeFetch(function () {
    return h.jsonResponse(401, { error: "Invalid session", code: "invalid_session" });
  });
  const w = h.makeWriteContext({ fetch: fetchStub, st: { user: null, cart: [] } });
  const result = await call(w.context, 'callWrite("insert","items",{values:{name:"X"}})');
  assert.strictEqual(fetchStub.calls[0].body.userId, null);
  assert.strictEqual(fetchStub.calls[0].body.token, null);
  assert.strictEqual(result.data, null);
});

test("non-OK with error body: message passthrough, no throw", async function () {
  const fetchStub = h.makeFetch(function () {
    return h.jsonResponse(403, { error: "Not authorized for this action" });
  });
  const w = h.makeWriteContext({ fetch: fetchStub });
  const result = await call(w.context, 'callWrite("delete","items",{match:{id:3}})');
  assert.deepStrictEqual(h.plain(result), { data: null, error: { message: "Not authorized for this action" } });
});

test("non-OK with unparseable body: falls back to 'Request failed (status)'", async function () {
  const fetchStub = h.makeFetch(function () {
    return h.unparseableResponse(500);
  });
  const w = h.makeWriteContext({ fetch: fetchStub });
  const result = await call(w.context, 'callWrite("insert","items",{values:{name:"X"}})');
  assert.deepStrictEqual(h.plain(result), { data: null, error: { message: "Request failed (500)" } });
});

// ---------------------------------------------------------------------------
// #4a the hard rule: NO retry on network failure, timeout, or non-expiry
// errors. One fetch, no re-auth prompt, error surfaced to the caller.
// ---------------------------------------------------------------------------

test("NEVER retries on network error: one fetch, no prompt, error returned", async function () {
  const fetchStub = h.makeFetch(function () {
    throw new TypeError("Failed to fetch");
  });
  const w = h.makeWriteContext({ fetch: fetchStub });
  const result = await call(w.context, 'callWrite("insert","transactions",{values:{type:"sale"}})');

  assert.strictEqual(fetchStub.calls.length, 1, "a network error must not trigger a second POST -- the sale may have landed");
  assert.strictEqual(promptCount(w.dom), 0, "a network error must not open the re-auth prompt");
  assert.deepStrictEqual(h.plain(result), { data: null, error: { message: "Network error: Failed to fetch" } });
});

test("NEVER retries on timeout: one fetch, no prompt, error returned", async function () {
  const fetchStub = h.makeFetch(function () {
    throw new Error("The operation timed out");
  });
  const w = h.makeWriteContext({ fetch: fetchStub });
  const result = await call(w.context, 'callWrite("insert","transactions",{values:{type:"sale"}})');

  assert.strictEqual(fetchStub.calls.length, 1, "a timeout must not trigger a second POST -- the sale may have landed");
  assert.strictEqual(promptCount(w.dom), 0);
  assert.deepStrictEqual(h.plain(result), { data: null, error: { message: "Network error: The operation timed out" } });
});

test("NEVER retries on 500 / 429 / 403: one fetch each, no prompt", async function () {
  for (const status of [500, 429, 403]) {
    const fetchStub = h.makeFetch(function () {
      return h.jsonResponse(status, { error: "server said no (" + status + ")" });
    });
    const w = h.makeWriteContext({ fetch: fetchStub });
    const result = await call(w.context, 'callWrite("update","items",{values:{qty:1},match:{id:3}})');
    assert.strictEqual(fetchStub.calls.length, 1, "status " + status + " must not retry");
    assert.strictEqual(promptCount(w.dom), 0, "status " + status + " must not open the re-auth prompt");
    assert.strictEqual(result.error.message, "server said no (" + status + ")");
  }
});

test("NEVER retries on 401 without code session_expired (invalid_session)", async function () {
  const fetchStub = h.makeFetch(function () {
    return h.jsonResponse(401, { error: "Invalid session", code: "invalid_session" });
  });
  const w = h.makeWriteContext({ fetch: fetchStub });
  const result = await call(w.context, 'callWrite("update","items",{values:{qty:1},match:{id:3}})');

  assert.strictEqual(fetchStub.calls.length, 1, "invalid_session is not session_expired -- no re-auth, no retry");
  assert.strictEqual(promptCount(w.dom), 0);
  assert.strictEqual(result.error.message, "Invalid session");
});

test("NEVER retries on bare 401 with no code at all", async function () {
  const fetchStub = h.makeFetch(function () {
    return h.jsonResponse(401, { error: "Missing Authorization bearer token" });
  });
  const w = h.makeWriteContext({ fetch: fetchStub });
  const result = await call(w.context, 'callWrite("insert","items",{values:{name:"X"}})');
  assert.strictEqual(fetchStub.calls.length, 1);
  assert.strictEqual(promptCount(w.dom), 0);
  assert.strictEqual(result.error.message, "Missing Authorization bearer token");
});

// ---------------------------------------------------------------------------
// #4b the ONLY retry path: 401 + code:"session_expired" -> re-auth -> retry
// exactly once with the fresh token
// ---------------------------------------------------------------------------

test("session_expired: re-auth mints token, original write retried once with it", async function () {
  const fetchStub = h.makeFetch(function (c) {
    if (c.body.op === "login") return loginOk("fresh-token");
    if (c.body.token === "fresh-token") return okData([{ id: 42 }]);
    return expiredResponse();
  });
  const w = h.makeWriteContext({ fetch: fetchStub });
  const cartBefore = JSON.stringify(w.st.cart);

  const pending = call(w.context, 'callWrite("update","items",{values:{qty:5},match:{id:3}})');
  await submitPrompt(w.dom, "4321");
  const result = await pending;

  assert.strictEqual(fetchStub.calls.length, 3, "expected write, login, retried write");
  assert.strictEqual(fetchStub.calls[0].body.token, "stale-token");
  assert.deepStrictEqual(fetchStub.calls[1].body, { op: "login", userId: 7, pin: "4321" });
  assert.strictEqual(fetchStub.calls[2].body.token, "fresh-token", "retry must carry the freshly minted token");
  assert.deepStrictEqual(fetchStub.calls[2].body.values, { qty: 5 });
  assert.deepStrictEqual(fetchStub.calls[2].body.match, { id: 3 });
  assert.deepStrictEqual(h.plain(result), { data: [{ id: 42 }], error: null });

  assert.strictEqual(w.st.user.token, "fresh-token");
  assert.strictEqual(w.st.user.tokenExp, "2026-08-17T08:00:00.000Z");
  assert.strictEqual(w.dom.created[0].removed, true, "prompt overlay removed after success");
  assert.strictEqual(JSON.stringify(w.st.cart), cartBefore, "ST.cart must survive re-auth untouched");
  // render()/logout() are throwing stubs in this sandbox: reaching this
  // line proves neither ran during the expiry flow.
});

test("retries exactly once: a second session_expired is returned, not looped", async function () {
  const fetchStub = h.makeFetch(function (c) {
    if (c.body.op === "login") return loginOk("fresh-token");
    return expiredResponse(); // writes always expire, even with the fresh token
  });
  const w = h.makeWriteContext({ fetch: fetchStub });

  const pending = call(w.context, 'callWrite("update","items",{values:{qty:5},match:{id:3}})');
  await submitPrompt(w.dom, "4321");
  const result = await pending;

  assert.strictEqual(fetchStub.calls.length, 3, "write, login, one retry -- and no more");
  assert.strictEqual(promptCount(w.dom), 1, "no second re-auth prompt");
  assert.deepStrictEqual(h.plain(result), { data: null, error: { message: "Session expired" } });
  assert.strictEqual(call(w.context, "REAUTH"), null, "REAUTH cleared after the prompt closes");
});

test("user cancels re-auth: no retry, no login call, error returned", async function () {
  const fetchStub = h.makeFetch(function () {
    return expiredResponse();
  });
  const w = h.makeWriteContext({ fetch: fetchStub });

  const pending = call(w.context, 'callWrite("delete","items",{match:{id:3}})');
  await h.waitFor(function () {
    return w.dom.registry.racancel && w.dom.registry.racancel.onclick;
  }, "re-auth prompt to appear");
  w.dom.registry.racancel.onclick();
  const result = await pending;

  assert.strictEqual(fetchStub.calls.length, 1, "cancel must not retry the write");
  assert.deepStrictEqual(h.plain(result), { data: null, error: { message: "Session expired" } });
  assert.strictEqual(w.dom.created[0].removed, true);
  assert.strictEqual(call(w.context, "REAUTH"), null);
});

test("concurrent expired writes share one prompt; both retry after one re-auth", async function () {
  const fetchStub = h.makeFetch(function (c) {
    if (c.body.op === "login") return loginOk("fresh-token");
    if (c.body.token === "fresh-token") return okData([{ id: c.body.table === "items" ? 1 : 2 }]);
    return expiredResponse();
  });
  const w = h.makeWriteContext({ fetch: fetchStub });

  const p1 = call(w.context, 'callWrite("update","items",{values:{qty:5},match:{id:3}})');
  const p2 = call(w.context, 'callWrite("insert","transaction_items",{values:{item_id:3,qty:1}})');
  await submitPrompt(w.dom, "4321");
  const r1 = await p1;
  const r2 = await p2;

  assert.strictEqual(promptCount(w.dom), 1, "two expired writes must share a single re-auth prompt");
  const loginCalls = fetchStub.calls.filter(function (c) { return c.body.op === "login"; });
  assert.strictEqual(loginCalls.length, 1, "one shared prompt mints exactly one session");
  assert.strictEqual(fetchStub.calls.length, 5, "two writes, one login, two retries");
  assert.strictEqual(r1.error, null);
  assert.strictEqual(r2.error, null);
});

test("wrong PIN in re-auth prompt: error shown, prompt stays, correct PIN then proceeds", async function () {
  const fetchStub = h.makeFetch(function (c) {
    if (c.body.op === "login") {
      return c.body.pin === "4321" ? loginOk("fresh-token") : h.jsonResponse(401, { error: "Invalid user or PIN" });
    }
    if (c.body.token === "fresh-token") return okData([{ id: 42 }]);
    return expiredResponse();
  });
  const w = h.makeWriteContext({ fetch: fetchStub });

  const pending = call(w.context, 'callWrite("update","items",{values:{qty:5},match:{id:3}})');
  await submitPrompt(w.dom, "0000");
  await h.waitFor(function () {
    return w.dom.registry.raerr.textContent === "Invalid user or PIN";
  }, "wrong-PIN error to render");
  assert.strictEqual(w.dom.registry.raok.disabled, false, "button re-enabled for another try");
  assert.strictEqual(w.dom.created[0].removed, false, "prompt stays up after a wrong PIN");
  assert.strictEqual(w.dom.registry.rapin.value, "", "PIN field cleared after a wrong PIN");

  await submitPrompt(w.dom, "4321");
  const result = await pending;
  assert.deepStrictEqual(h.plain(result), { data: [{ id: 42 }], error: null });
  assert.strictEqual(fetchStub.calls.filter(function (c) { return c.body.op === "login"; }).length, 2);
});

test("re-auth submit in-flight guard: double Enter mints one session, not two", async function () {
  const gate = h.deferred();
  const fetchStub = h.makeFetch(function (c) {
    if (c.body.op === "login") return gate.promise; // hold the login open
    if (c.body.token === "fresh-token") return okData([{ id: 42 }]);
    return expiredResponse();
  });
  const w = h.makeWriteContext({ fetch: fetchStub });

  const pending = call(w.context, 'callWrite("update","items",{values:{qty:5},match:{id:3}})');
  await h.waitFor(function () {
    return w.dom.registry.raok && w.dom.registry.raok.onclick;
  }, "re-auth prompt to appear");
  w.dom.registry.rapin.value = "4321";
  // First Enter starts the mint (held open by the gate); the second lands
  // while it is in flight (the 909a34b bug). Neither submit() promise can be
  // awaited yet -- they only settle after the gate resolves below.
  w.dom.registry.raok.onclick();
  await h.tick();
  w.dom.registry.raok.onclick();
  await h.tick();
  assert.strictEqual(
    fetchStub.calls.filter(function (c) { return c.body.op === "login"; }).length,
    1,
    "a repeated Enter during a slow re-auth must not mint a second session"
  );

  gate.resolve(loginOk("fresh-token"));
  const result = await pending;
  assert.strictEqual(result.error, null);
});

test("empty PIN in re-auth prompt: inline error, no request", async function () {
  const fetchStub = h.makeFetch(function () {
    return expiredResponse();
  });
  const w = h.makeWriteContext({ fetch: fetchStub });

  call(w.context, 'callWrite("update","items",{values:{qty:5},match:{id:3}})');
  await submitPrompt(w.dom, "");
  assert.strictEqual(w.dom.registry.raerr.textContent, "Enter your PIN.");
  assert.strictEqual(fetchStub.calls.length, 1, "no login request for an empty PIN");
});

// ---------------------------------------------------------------------------
// mintSession return shapes
// ---------------------------------------------------------------------------

test("mintSession: success returns {token, expiresAt, user}; failure shapes are errors", async function () {
  let w = h.makeWriteContext({
    fetch: h.makeFetch(function () { return loginOk("minted-token"); })
  });
  let sess = await call(w.context, 'mintSession(7,"1234")');
  assert.strictEqual(sess.token, "minted-token");
  assert.strictEqual(sess.expiresAt, "2026-08-17T08:00:00.000Z");
  assert.strictEqual(sess.user.id, 7);

  w = h.makeWriteContext({
    fetch: h.makeFetch(function () { throw new Error("offline"); })
  });
  sess = await call(w.context, 'mintSession(7,"1234")');
  assert.strictEqual(sess.error, "Network error: offline");

  // 200 but no token in the body must be treated as a failed login, not a
  // session with token undefined.
  w = h.makeWriteContext({
    fetch: h.makeFetch(function () { return h.jsonResponse(200, {}); })
  });
  sess = await call(w.context, 'mintSession(7,"1234")');
  assert.strictEqual(sess.error, "Login failed (200)");
});

suite.run();
