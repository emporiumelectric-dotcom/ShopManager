"use strict";

// Shared harness for testing functions defined inside index.html's inline
// <script> without a build step: slice the source between stable text
// markers and evaluate the slice in a vm sandbox whose globals are stubs.
// Node stdlib only. No test built on this harness may perform network I/O --
// every sandbox gets `fetch` from the test, never the real one.
//
// Assertions built on these slices must target behavior and wire shapes,
// not byte equality: intentional edits to index.html should update
// assertions, not invalidate the suite.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const html = fs
  .readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace(/\r\n/g, "\n");

function sliceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert(
    start >= 0 && end > start,
    "missing source markers: " + JSON.stringify(startMarker) + " .. " + JSON.stringify(endMarker)
  );
  assert.strictEqual(
    html.indexOf(startMarker, start + 1),
    -1,
    "start marker is not unique: " + JSON.stringify(startMarker)
  );
  return html.slice(start, end);
}

// callWrite + postWrite + mintSession + REAUTH + reauthPrompt are contiguous.
const writeLayerSource = sliceBetween("async function callWrite", "\n\nvar TODAYKEY");
const doLoginSource = sliceBetween("async function doLogin()", "\nfunction logout()");

// --- minimal fake DOM -------------------------------------------------------
// Just enough surface for the login/re-auth code paths: property bags with
// appendChild/remove/focus. innerHTML assignments are stored as strings, not
// parsed; elements looked up via G(id) are created lazily so handler wiring
// (G("raok").onclick = ...) lands somewhere the test can reach.

function makeElement(tag) {
  return {
    tagName: tag || "div",
    className: "",
    style: {},
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false,
    removed: false,
    children: [],
    onclick: null,
    onkeydown: null,
    appendChild: function (child) {
      this.children.push(child);
    },
    remove: function () {
      this.removed = true;
    },
    focus: function () {}
  };
}

function makeDom() {
  const registry = {};
  const created = [];
  const documentStub = {
    createElement: function (tag) {
      const el = makeElement(tag);
      created.push(el);
      return el;
    },
    body: makeElement("body")
  };
  function G(id) {
    if (!registry[id]) registry[id] = makeElement("div");
    return registry[id];
  }
  return { document: documentStub, G: G, registry: registry, created: created };
}

// Values built inside the vm sandbox carry that realm's prototypes, which
// assert.deepStrictEqual rejects even for identical structures. Round-trip
// through JSON before comparing anything a sandbox returned.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// --- async helpers ----------------------------------------------------------

function deferred() {
  let resolve, reject;
  const promise = new Promise(function (res, rej) {
    resolve = res;
    reject = rej;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

function tick() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

async function waitFor(cond, label) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error("timed out waiting for " + label);
}

// --- fetch stubbing ---------------------------------------------------------
// handler(call, index) receives {url, options, body (parsed JSON), headers}
// and returns a response stub. All calls are recorded on fetchStub.calls.

function makeFetch(handler) {
  const calls = [];
  const fetchStub = async function (url, options) {
    const call = {
      url: url,
      options: options,
      headers: options && options.headers ? options.headers : null,
      body: options && options.body ? JSON.parse(options.body) : null
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  fetchStub.calls = calls;
  return fetchStub;
}

function jsonResponse(status, body) {
  return {
    status: status,
    ok: status >= 200 && status < 300,
    json: async function () {
      return body;
    }
  };
}

function unparseableResponse(status) {
  return {
    status: status,
    ok: status >= 200 && status < 300,
    json: async function () {
      throw new SyntaxError("Unexpected end of JSON input");
    }
  };
}

// --- sandbox builders -------------------------------------------------------

const WRITE_FN_URL = "https://stub.test/functions/v1/shop-write";
const ANON_KEY = "anon-key-for-tests";
const SB_ACCESS_TOKEN = "sb-access-token";

// Sandbox with the write layer (callWrite/postWrite/mintSession/reauthPrompt)
// loaded. render()/logout() throw: the re-auth flow's contract is that the
// screen (ST.cart, half-filled forms) survives, so neither may ever run.
function makeWriteContext(opts) {
  opts = opts || {};
  const dom = makeDom();
  const st =
    "st" in opts
      ? opts.st
      : {
          user: { id: 7, name: "Akshay", role: "staff", canDelete: false, token: "stale-token", tokenExp: "2026-08-16T22:00:00.000Z" },
          cart: [{ itemId: 3, qty: 2 }]
        };
  const context = vm.createContext({
    console: console,
    fetch: opts.fetch,
    ST: st,
    sb: {
      auth: {
        getSession: async function () {
          return { data: { session: "session" in opts ? opts.session : { access_token: SB_ACCESS_TOKEN } } };
        }
      },
      rpc: function () {
        throw new Error("sb.rpc must not be called by the write layer");
      }
    },
    WRITE_FN_URL: WRITE_FN_URL,
    SUPABASE_KEY: ANON_KEY,
    document: dom.document,
    G: dom.G,
    esc: String,
    render: function () {
      throw new Error("render() must not run during write/re-auth flows");
    },
    logout: function () {
      throw new Error("logout() must not run during write/re-auth flows");
    }
  });
  vm.runInContext(writeLayerSource, context, { filename: "write-layer.js" });
  return { context: context, dom: dom, st: st };
}

// Sandbox with the write layer AND doLogin loaded, so login tests exercise
// the real mintSession/postWrite chain down to the fetch stub -- the
// "exactly one outbound request per login" assertion needs the full chain.
function makeLoginContext(opts) {
  opts = opts || {};
  const dom = makeDom();
  const st = {
    user: null,
    users: [{ id: 5, name: "Lokesh", role: "staff", can_delete: true }],
    stores: [{ id: "2", name: "Balaghat Main" }],
    tab: "",
    cart: []
  };
  const renderCalls = [];
  const loadStoreDataCalls = [];
  const context = vm.createContext({
    console: console,
    fetch: opts.fetch,
    ST: st,
    sb: {
      auth: {
        getSession: async function () {
          return { data: { session: { access_token: SB_ACCESS_TOKEN } } };
        }
      },
      rpc: function () {
        throw new Error("sb.rpc must not be called during login (verify_pin was removed in 909a34b)");
      }
    },
    WRITE_FN_URL: WRITE_FN_URL,
    SUPABASE_KEY: ANON_KEY,
    document: dom.document,
    G: dom.G,
    esc: String,
    render: function () {
      renderCalls.push(true);
    },
    loadStoreData: async function (storeId) {
      loadStoreDataCalls.push(storeId);
    }
  });
  vm.runInContext(writeLayerSource, context, { filename: "write-layer.js" });
  vm.runInContext(doLoginSource, context, { filename: "do-login.js" });
  return {
    context: context,
    dom: dom,
    st: st,
    renderCalls: renderCalls,
    loadStoreDataCalls: loadStoreDataCalls
  };
}

// --- tiny case runner -------------------------------------------------------
// Each test file registers named async cases and calls run(); output is one
// line per case plus a summary, exit code 1 on any failure.

function makeSuite(suiteName) {
  const cases = [];
  let completed = false;
  // A test that awaits a promise nothing will ever resolve empties the event
  // loop, and Node exits 0 mid-suite -- which would read as a pass. Turn a
  // premature exit into a loud failure.
  process.on("exit", function () {
    if (!completed) {
      console.error(
        suiteName + ": process exited before the suite finished -- a test is deadlocked on an await"
      );
      process.exitCode = 1;
    }
  });
  function test(name, fn) {
    cases.push({ name: name, fn: fn });
  }
  async function run() {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log("  ok  " + c.name);
      } catch (error) {
        failed += 1;
        console.error("  FAIL " + c.name);
        console.error(error);
      }
    }
    const passed = cases.length - failed;
    completed = true;
    console.log(suiteName + ": " + passed + "/" + cases.length + " passed");
    if (failed > 0) process.exitCode = 1;
  }
  return { test: test, run: run };
}

module.exports = {
  html: html,
  plain: plain,
  sliceBetween: sliceBetween,
  writeLayerSource: writeLayerSource,
  doLoginSource: doLoginSource,
  makeElement: makeElement,
  makeDom: makeDom,
  deferred: deferred,
  tick: tick,
  waitFor: waitFor,
  makeFetch: makeFetch,
  jsonResponse: jsonResponse,
  unparseableResponse: unparseableResponse,
  makeWriteContext: makeWriteContext,
  makeLoginContext: makeLoginContext,
  makeSuite: makeSuite,
  WRITE_FN_URL: WRITE_FN_URL,
  ANON_KEY: ANON_KEY,
  SB_ACCESS_TOKEN: SB_ACCESS_TOKEN
};
