"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const validation = require("../config-validation.js");

const ROOT = path.resolve(__dirname, "..");
const PRE_PHASE_B_COMMIT = "719e9c594527d8ea1ad4b35ed7051a62b1926420";
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const previousHtml = childProcess.execFileSync(
  "git",
  ["show", PRE_PHASE_B_COMMIT + ":index.html"],
  { cwd: ROOT, encoding: "utf8" }
);

function normalize(value) {
  return value.replace(/\r\n/g, "\n");
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, "missing source markers");
  return source.slice(start, end);
}

const oldCallWrite = sliceBetween(
  normalize(previousHtml),
  "async function callWrite",
  "\n\nvar TODAYKEY"
);
const newCallWrite = sliceBetween(
  normalize(html),
  "async function callWrite",
  "\n\nvar TODAYKEY"
);
assert.strictEqual(newCallWrite, oldCallWrite, "callWrite changed");

assert(!html.includes("cdn.jsdelivr.net"), "jsDelivr remains in the boot path");
assert(
  html.includes('<script src="vendor/supabase-2.112.2.js"></script>'),
  "vendored supabase-js script missing"
);
assert(
  html.includes('<script src="config-validation.js"></script>'),
  "shared config validator script missing"
);
assert(
  !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(html),
  "committed JWT remains in index.html"
);
assert(
  html.includes('fetch("config.json",{cache:"no-store"})'),
  "browser config fetch is not no-store"
);
assert(
  html.includes(
    'sb.from("users_public").select("id,name,role,can_delete")'
  ),
  "fetchUsers does not use the explicit approved column list"
);

const bootstrapSource = sliceBetween(
  html,
  "var STARTUP_ERROR_MESSAGES",
  "// All writes route"
);
const initSource = sliceBetween(html, "async function init()", "\ninit();");

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function validBody() {
  return JSON.stringify({
    url: "https://buzidwccluskdkccidev.supabase.co",
    anonKey: [
      base64UrlJson({ alg: "HS256", typ: "JWT" }),
      base64UrlJson({
        role: "anon",
        ref: "buzidwccluskdkccidev",
        exp: Math.floor(Date.now() / 1000) + 3600
      }),
      "signaturevalue"
    ].join("."),
    generatedAt: "2026-08-09T12:00:00.000Z"
  });
}

function makeContext(fetchImpl, validator) {
  const app = { innerHTML: "" };
  const context = vm.createContext({
    console,
    fetch: fetchImpl,
    G() {
      return app;
    },
    esc(value) {
      return String(value);
    }
  });
  context.window = context;
  context.EEConfigValidation = validator;
  vm.runInContext(bootstrapSource, context, { filename: "index-bootstrap.js" });
  return { app, context };
}

async function run() {
  let seenOptions;
  let harness = makeContext(async function (url, options) {
    assert.strictEqual(url, "config.json");
    seenOptions = options;
    return new Response(validBody(), { status: 200 });
  }, validation);
  let result = await vm.runInContext("loadConfig()", harness.context);
  assert.strictEqual(result.url, "https://buzidwccluskdkccidev.supabase.co");
  assert.strictEqual(seenOptions.cache, "no-store");

  harness = makeContext(async function () {
    throw new Error("offline");
  }, validation);
  result = await vm.runInContext("loadConfig()", harness.context);
  assert.strictEqual(result.error, "config_unavailable");

  harness = makeContext(async function () {
    return new Response(JSON.stringify({ error: "config_unavailable" }), {
      status: 200
    });
  }, validation);
  result = await vm.runInContext("loadConfig()", harness.context);
  assert.strictEqual(result.error, "config_unavailable");

  harness = makeContext(async function () {
    return new Response("{", { status: 200 });
  }, validation);
  result = await vm.runInContext("loadConfig()", harness.context);
  assert.strictEqual(result.error, "config_invalid");

  harness = makeContext(async function () {
    return new Response(validBody(), { status: 200 });
  }, undefined);
  result = await vm.runInContext("loadConfig()", harness.context);
  assert.strictEqual(result.error, "application_files_unavailable");

  vm.runInContext('renderStartupError("config_unavailable")', harness.context);
  assert(
    harness.app.innerHTML.includes(
      "Configuration unavailable — connect to the internet once to finish setup."
    ),
    "config_unavailable did not render a staff-readable message"
  );

  harness = makeContext(async function () {
    return new Response(validBody(), { status: 200 });
  }, validation);
  vm.runInContext(initSource, harness.context, { filename: "index-init.js" });

  harness.context.loadConfig = async function () {
    return { error: "config_unavailable" };
  };
  await vm.runInContext("init()", harness.context);
  assert(
    harness.app.innerHTML.includes("Configuration unavailable"),
    "init did not stop on config_unavailable"
  );

  harness.context.loadConfig = async function () {
    return JSON.parse(validBody());
  };
  harness.context.supabase = undefined;
  await vm.runInContext("init()", harness.context);
  assert(
    harness.app.innerHTML.includes("Application files unavailable"),
    "missing supabase-js did not render application_files_unavailable"
  );

  harness.context.supabase = {
    createClient() {
      throw new Error("invalid config");
    }
  };
  await vm.runInContext("init()", harness.context);
  assert(
    harness.app.innerHTML.includes("Configuration invalid"),
    "createClient failure did not render config_invalid"
  );

  let authCalled = false;
  let readsCalled = 0;
  let rendered = false;
  harness.context.supabase = {
    createClient(url, key) {
      assert.strictEqual(url, "https://buzidwccluskdkccidev.supabase.co");
      assert.strictEqual(key, JSON.parse(validBody()).anonKey);
      return {
        auth: {
          async signInAnonymously() {
            authCalled = true;
            return { error: null };
          }
        }
      };
    }
  };
  harness.context.ST = {};
  harness.context.fetchStores = async function () {
    readsCalled += 1;
    return [];
  };
  harness.context.fetchUsers = async function () {
    readsCalled += 1;
    return [];
  };
  harness.context.render = function () {
    rendered = true;
  };
  await vm.runInContext("init()", harness.context);

  assert(authCalled, "anonymous auth path did not run");
  assert.strictEqual(readsCalled, 2, "existing initial reads did not run");
  assert(rendered, "existing render path did not run");
  assert.strictEqual(
    harness.context.WRITE_FN_URL,
    "https://buzidwccluskdkccidev.supabase.co/functions/v1/shop-write"
  );

  let capturedWrite;
  const writeContext = vm.createContext({
    SUPABASE_KEY: "test-anon-key",
    WRITE_FN_URL:
      "https://buzidwccluskdkccidev.supabase.co/functions/v1/shop-write",
    ST: { user: { id: 7, pin: "4321" } },
    sb: {
      auth: {
        async getSession() {
          return { data: { session: { access_token: "session-token" } } };
        }
      }
    },
    async fetch(url, options) {
      capturedWrite = { options, url };
      return {
        ok: true,
        async json() {
          return { data: [{ id: 99 }] };
        }
      };
    }
  });
  vm.runInContext(newCallWrite, writeContext, { filename: "call-write.js" });
  const writeResult = await vm.runInContext(
    'callWrite("insert","items",{values:{name:"ZZTEST"}})',
    writeContext
  );
  const writeBody = JSON.parse(capturedWrite.options.body);
  assert.strictEqual(capturedWrite.url, writeContext.WRITE_FN_URL);
  assert.strictEqual(capturedWrite.options.method, "POST");
  assert.strictEqual(
    capturedWrite.options.headers.Authorization,
    "Bearer session-token"
  );
  assert.strictEqual(capturedWrite.options.headers.apikey, "test-anon-key");
  assert.deepStrictEqual(writeBody, {
    userId: 7,
    pin: "4321",
    op: "insert",
    table: "items",
    values: { name: "ZZTEST" }
  });
  assert.strictEqual(writeResult.data[0].id, 99);

  console.log("browser bootstrap and write-path invariance tests passed");
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
