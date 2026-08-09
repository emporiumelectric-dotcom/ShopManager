"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const ORIGIN = "https://manager.electricemporium.in";
const CONFIG_URL = ORIGIN + "/config.json";
const EXPECTED_URL = "https://buzidwccluskdkccidev.supabase.co";

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(payload) {
  return [
    base64UrlJson({ alg: "HS256", typ: "JWT" }),
    base64UrlJson(payload),
    "signaturevalue"
  ].join(".");
}

function configBody(overrides) {
  return JSON.stringify({
    url: EXPECTED_URL,
    anonKey: token({
      role: "anon",
      ref: "buzidwccluskdkccidev",
      exp: Math.floor(Date.now() / 1000) + 3600
    }),
    generatedAt: "2026-08-09T12:00:00.000Z",
    ...overrides
  });
}

function requestKey(input) {
  var value = typeof input === "string" ? input : input.url;
  return new URL(value, ORIGIN + "/").href;
}

class MockCache {
  constructor() {
    this.entries = new Map();
    this.added = [];
  }

  async addAll(files) {
    this.added = files.slice();
    for (const file of files) {
      this.entries.set(
        requestKey(file),
        new Response("shell:" + file, { status: 200 })
      );
    }
  }

  async put(request, response) {
    this.entries.set(requestKey(request), response.clone());
  }

  async match(request) {
    const response = this.entries.get(requestKey(request));
    return response ? response.clone() : undefined;
  }

  async delete(request) {
    return this.entries.delete(requestKey(request));
  }
}

const cacheStores = new Map();
const caches = {
  async open(name) {
    if (!cacheStores.has(name)) {
      cacheStores.set(name, new MockCache());
    }
    return cacheStores.get(name);
  },
  async keys() {
    return Array.from(cacheStores.keys());
  },
  async delete(name) {
    return cacheStores.delete(name);
  }
};

const listeners = {};
let networkFetch = async function () {
  throw new Error("network unavailable");
};
let lastFetchOptions;

const context = vm.createContext({
  Buffer,
  URL,
  Request,
  Response,
  atob,
  caches,
  console,
  fetch(request, options) {
    lastFetchOptions = options;
    return networkFetch(request, options);
  },
  location: { origin: ORIGIN },
  clients: { claim: async function () {} },
  skipWaiting: async function () {},
  addEventListener(type, listener) {
    listeners[type] = listener;
  }
});
context.self = context;
context.globalThis = context;
context.importScripts = function (...files) {
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
};

vm.runInContext(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8"), context, {
  filename: "sw.js"
});

async function dispatchLifecycle(type) {
  let lifetime;
  listeners[type]({
    waitUntil(value) {
      lifetime = Promise.resolve(value);
    }
  });
  if (lifetime) {
    await lifetime;
  }
}

async function dispatchFetch(request) {
  let responsePromise;
  listeners.fetch({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    }
  });
  assert(responsePromise, "service worker did not handle " + request.url);
  return responsePromise;
}

function getRequest(pathname, mode) {
  return {
    method: "GET",
    mode: mode || "cors",
    url: new URL(pathname, ORIGIN + "/").href
  };
}

async function responseText(response) {
  return response.clone().text();
}

async function run() {
  const configRequest = getRequest("/config.json");
  const configCache = await caches.open("shopmanager-config-v1");
  const validBody = configBody();

  await configCache.put(
    configRequest,
    new Response(validBody, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  );
  await caches.open("shopmanager-shell-v2");
  await dispatchLifecycle("install");
  await dispatchLifecycle("activate");

  assert.deepStrictEqual(
    (await caches.keys()).sort(),
    ["shopmanager-config-v1", "shopmanager-shell-v3"],
    "activate must retain only the v3 shell and config caches"
  );
  assert(await configCache.match(configRequest), "upgrade erased cached config");

  const shellCache = await caches.open("shopmanager-shell-v3");
  assert(
    shellCache.added.includes("./vendor/supabase-2.112.2.js"),
    "vendored supabase-js missing from atomic shell install"
  );

  networkFetch = async function () {
    throw new Error("offline");
  };
  let response = await dispatchFetch(
    getRequest("/vendor/supabase-2.112.2.js")
  );
  assert.strictEqual(
    await responseText(response),
    "shell:./vendor/supabase-2.112.2.js",
    "vendored supabase-js did not load from the offline shell"
  );

  const freshBody = configBody({ generatedAt: "2026-08-09T12:01:00.000Z" });
  networkFetch = async function () {
    return new Response(freshBody, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  response = await dispatchFetch(configRequest);
  assert.strictEqual(await responseText(response), freshBody);
  assert.strictEqual(lastFetchOptions.cache, "no-store");
  assert.strictEqual(
    await responseText(await configCache.match(configRequest)),
    freshBody,
    "valid network config was not cached"
  );
  assert.strictEqual(
    await shellCache.match(configRequest),
    undefined,
    "config.json leaked into the unvalidated shell cache"
  );

  networkFetch = async function () {
    throw new Error("offline");
  };
  response = await dispatchFetch(configRequest);
  assert.strictEqual(
    await responseText(response),
    freshBody,
    "valid cached config was not served offline"
  );

  const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
  const invalidBodies = {
    empty: "",
    placeholder: configBody({ anonKey: "**PLACEHOLDER**" }),
    malformed: "{",
    wrong_host: configBody({ url: "https://wrong-project.supabase.co" }),
    wrong_ref: configBody({
      anonKey: token({ role: "anon", ref: "wrong", exp: futureExpiry })
    }),
    wrong_role: configBody({
      anonKey: token({
        role: "service_role",
        ref: "buzidwccluskdkccidev",
        exp: futureExpiry
      })
    }),
    expired: configBody({
      anonKey: token({
        role: "anon",
        ref: "buzidwccluskdkccidev",
        exp: Math.floor(Date.now() / 1000) - 1
      })
    })
  };

  for (const [name, body] of Object.entries(invalidBodies)) {
    networkFetch = async function () {
      return new Response(body, { status: 200 });
    };
    response = await dispatchFetch(configRequest);
    assert.strictEqual(
      await responseText(response),
      freshBody,
      name + " network config replaced or bypassed last-known-good"
    );
    assert.strictEqual(
      await responseText(await configCache.match(configRequest)),
      freshBody,
      name + " network config poisoned the cache"
    );
  }

  networkFetch = async function () {
    return new Response("server error", { status: 503 });
  };
  response = await dispatchFetch(configRequest);
  assert.strictEqual(
    await responseText(response),
    freshBody,
    "HTTP failure did not use last-known-good config"
  );

  await configCache.delete(configRequest);
  networkFetch = async function () {
    return new Response(invalidBodies.placeholder, { status: 200 });
  };
  response = await dispatchFetch(configRequest);
  assert.deepStrictEqual(JSON.parse(await responseText(response)), {
    error: "config_unavailable"
  });
  assert.strictEqual(
    await configCache.match(configRequest),
    undefined,
    "invalid network config was cached without a last-known-good copy"
  );

  networkFetch = async function () {
    throw new Error("offline");
  };
  response = await dispatchFetch(configRequest);
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(JSON.parse(await responseText(response)), {
    error: "config_unavailable"
  });

  await configCache.put(configRequest, new Response("{", { status: 200 }));
  response = await dispatchFetch(configRequest);
  assert.deepStrictEqual(JSON.parse(await responseText(response)), {
    error: "config_unavailable"
  });
  assert.strictEqual(
    await configCache.match(configRequest),
    undefined,
    "invalid cached config was not deleted"
  );

  response = await dispatchFetch(getRequest("/", "navigate"));
  assert.strictEqual(
    await responseText(response),
    "shell:./index.html",
    "offline navigation did not fall back to cached index.html"
  );

  await shellCache.delete("./index.html");
  response = await dispatchFetch(getRequest("/", "navigate"));
  assert.strictEqual(response.status, 503);
  assert.strictEqual(
    response.headers.get("content-type"),
    "text/plain; charset=utf-8"
  );
  assert.strictEqual(
    await responseText(response),
    "Offline and no cached copy available."
  );

  console.log("service worker config/offline tests passed");
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
