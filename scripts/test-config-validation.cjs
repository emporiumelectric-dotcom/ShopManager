"use strict";

const assert = require("assert");
const { validateConfigBody } = require("../config-validation.js");

const NOW_MS = Date.UTC(2026, 7, 9);
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

function body(overrides) {
  return JSON.stringify({
    url: EXPECTED_URL,
    anonKey: token({
      role: "anon",
      ref: "buzidwccluskdkccidev",
      exp: Math.floor(NOW_MS / 1000) + 3600
    }),
    generatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides
  });
}

function expectError(name, value, expectedError) {
  const result = validateConfigBody(value, NOW_MS);
  assert.strictEqual(result.ok, false, name);
  assert.strictEqual(result.error, expectedError, name);
}

assert.strictEqual(validateConfigBody(body(), NOW_MS).ok, true);
expectError("empty", "", "invalid_json");
expectError(
  "placeholder",
  body({ anonKey: "**PLACEHOLDER**" }),
  "placeholder_present"
);
expectError("malformed", "{", "invalid_json");
expectError(
  "wrong host",
  body({ url: "https://wrong-project.supabase.co" }),
  "wrong_host"
);
expectError(
  "wrong project",
  body({
    anonKey: token({
      role: "anon",
      ref: "wrong-project",
      exp: Math.floor(NOW_MS / 1000) + 3600
    })
  }),
  "wrong_ref"
);
expectError(
  "wrong role",
  body({
    anonKey: token({
      role: "service_role",
      ref: "buzidwccluskdkccidev",
      exp: Math.floor(NOW_MS / 1000) + 3600
    })
  }),
  "wrong_role"
);
expectError(
  "expired",
  body({
    anonKey: token({
      role: "anon",
      ref: "buzidwccluskdkccidev",
      exp: Math.floor(NOW_MS / 1000) - 1
    })
  }),
  "expired"
);
expectError(
  "unavailable",
  JSON.stringify({ error: "config_unavailable" }),
  "config_unavailable"
);

console.log("config validation tests passed");
