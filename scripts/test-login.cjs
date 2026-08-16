"use strict";

// Behavior tests for doLogin (index.html), run against the REAL
// mintSession/postWrite chain from the write-layer slice so the assertions
// hold at the network boundary. Pins the two 909a34b fixes:
//   - one PIN check per login: exactly one outbound request, op:"login" to
//     shop-write, and no verify_pin RPC (sb.rpc throws in this sandbox);
//   - in-flight guard: repeated taps/Enter during a slow login mint one
//     session, not one per keypress.

const assert = require("assert");
const vm = require("vm");
const h = require("./vm-harness.cjs");

const suite = h.makeSuite("login");
const test = suite.test;

function loginResponse(user) {
  return h.jsonResponse(200, {
    token: "minted-token",
    expiresAt: "2026-08-17T08:00:00.000Z",
    user: user
  });
}

function fillForm(dom, values) {
  dom.G("lu").value = "uid" in values ? values.uid : "5";
  dom.G("ls").value = "storeId" in values ? values.storeId : "2";
  dom.G("lp").value = "pin" in values ? values.pin : "9876";
}

test("successful login: exactly one request, and it is op:login to shop-write", async function () {
  const fetchStub = h.makeFetch(function () {
    return loginResponse({ id: 5, name: "Lokesh", role: "staff", can_delete: true });
  });
  const l = h.makeLoginContext({ fetch: fetchStub });
  fillForm(l.dom, {});

  await vm.runInContext("doLogin()", l.context);

  // The 909a34b bug A regression check: one network call per login, total.
  // sb.rpc (verify_pin) throwing in this sandbox guarantees no second,
  // ip-less pin_attempts row can ever come from this client.
  assert.strictEqual(fetchStub.calls.length, 1, "a login must make exactly one outbound request");
  const c = fetchStub.calls[0];
  assert.strictEqual(c.url, h.WRITE_FN_URL);
  assert.deepStrictEqual(c.body, { op: "login", userId: "5", pin: "9876" });
  assert(!("token" in c.body), "op:login carries the PIN, never a session token");
});

test("successful login: ST.user populated from the server row, session stored", async function () {
  const fetchStub = h.makeFetch(function () {
    return loginResponse({ id: 5, name: "Lokesh", role: "staff", can_delete: true });
  });
  const l = h.makeLoginContext({ fetch: fetchStub });
  fillForm(l.dom, {});

  await vm.runInContext("doLogin()", l.context);

  assert.deepStrictEqual(h.plain(l.st.user), {
    id: 5, // numeric, from the server's user row -- not the "5" string from the select
    name: "Lokesh",
    role: "staff",
    canDelete: true,
    token: "minted-token",
    tokenExp: "2026-08-17T08:00:00.000Z"
  });
  assert.strictEqual(l.st.storeId, "2");
  assert.strictEqual(l.st.storeName, "Balaghat Main");
  assert.strictEqual(l.st.tab, "dashboard");
  assert.strictEqual(l.renderCalls.length, 1);
  assert.deepStrictEqual(l.loadStoreDataCalls, ["2"]);
});

test("the PIN is not retained anywhere on ST after login", async function () {
  const fetchStub = h.makeFetch(function () {
    return loginResponse({ id: 5, name: "Lokesh", role: "staff", can_delete: false });
  });
  const l = h.makeLoginContext({ fetch: fetchStub });
  fillForm(l.dom, { pin: "739406" });

  await vm.runInContext("doLogin()", l.context);

  assert(!("pin" in l.st.user), "ST.user must not have a pin field");
  assert(
    !JSON.stringify(l.st).includes("739406"),
    "the PIN value must not survive login anywhere in ST"
  );
});

test("canDelete derivation: owner is always true; staff follows can_delete", async function () {
  const rows = [
    { row: { id: 1, name: "Yash", role: "owner", can_delete: false }, expect: true },
    { row: { id: 5, name: "Lokesh", role: "staff", can_delete: true }, expect: true },
    { row: { id: 6, name: "Akshay", role: "staff", can_delete: false }, expect: false }
  ];
  for (const r of rows) {
    const l = h.makeLoginContext({
      fetch: h.makeFetch(function () { return loginResponse(r.row); })
    });
    fillForm(l.dom, {});
    await vm.runInContext("doLogin()", l.context);
    assert.strictEqual(
      l.st.user.canDelete,
      r.expect,
      r.row.role + "/can_delete=" + r.row.can_delete + " should derive canDelete=" + r.expect
    );
  }
});

test("wrong PIN: server error shown, button re-enabled, no ST.user", async function () {
  const fetchStub = h.makeFetch(function () {
    return h.jsonResponse(401, { error: "Invalid user or PIN" });
  });
  const l = h.makeLoginContext({ fetch: fetchStub });
  fillForm(l.dom, { pin: "0000" });

  await vm.runInContext("doLogin()", l.context);

  assert.strictEqual(fetchStub.calls.length, 1);
  assert.strictEqual(l.dom.registry.lerr.textContent, "Invalid user or PIN");
  assert.strictEqual(l.st.user, null);
  assert.strictEqual(l.dom.registry.loginbtn.disabled, false, "button must be usable for another try");
  assert.strictEqual(l.renderCalls.length, 0, "a failed login must not render the app");
});

test("network error during login: message shown, button re-enabled", async function () {
  const fetchStub = h.makeFetch(function () {
    throw new TypeError("Failed to fetch");
  });
  const l = h.makeLoginContext({ fetch: fetchStub });
  fillForm(l.dom, {});

  await vm.runInContext("doLogin()", l.context);

  assert.strictEqual(fetchStub.calls.length, 1, "a failed login request must not be auto-retried");
  assert.strictEqual(l.dom.registry.lerr.textContent, "Network error: Failed to fetch");
  assert.strictEqual(l.st.user, null);
  assert.strictEqual(l.dom.registry.loginbtn.disabled, false);
});

test("validation: missing user, store, or PIN sends no request at all", async function () {
  const cases = [
    { values: { uid: "" }, message: "Please select a user." },
    { values: { storeId: "" }, message: "Please select a store." },
    { values: { pin: "  " }, message: "Enter your PIN." }
  ];
  for (const c of cases) {
    const fetchStub = h.makeFetch(function () {
      throw new Error("must not be reached");
    });
    const l = h.makeLoginContext({ fetch: fetchStub });
    fillForm(l.dom, c.values);
    await vm.runInContext("doLogin()", l.context);
    assert.strictEqual(fetchStub.calls.length, 0, "no request for: " + c.message);
    assert.strictEqual(l.dom.registry.lerr.textContent, c.message);
  }
});

test("in-flight guard: repeated doLogin during a slow request mints one session", async function () {
  const gate = h.deferred();
  const fetchStub = h.makeFetch(function () {
    return gate.promise;
  });
  const l = h.makeLoginContext({ fetch: fetchStub });
  fillForm(l.dom, {});

  // First tap starts the request; the next two are the impatient re-taps /
  // held Enter of the 909a34b bug B (each used to mint another session).
  const first = vm.runInContext("doLogin()", l.context);
  await h.tick();
  await vm.runInContext("doLogin()", l.context);
  await vm.runInContext("doLogin()", l.context);
  assert.strictEqual(fetchStub.calls.length, 1, "re-entry while a login is in flight must not send another request");
  assert.strictEqual(l.dom.registry.loginbtn.disabled, true, "button disabled while in flight");

  gate.resolve(loginResponse({ id: 5, name: "Lokesh", role: "staff", can_delete: true }));
  await first;
  assert.strictEqual(fetchStub.calls.length, 1);
  assert.strictEqual(l.renderCalls.length, 1, "the single login completes exactly once");
});

test("client no longer references verify_pin anywhere in the login/write slices", function () {
  assert(!h.doLoginSource.includes("verify_pin("), "doLogin must not call verify_pin");
  assert(!h.writeLayerSource.includes("verify_pin("), "the write layer must not call verify_pin");
});

suite.run();
