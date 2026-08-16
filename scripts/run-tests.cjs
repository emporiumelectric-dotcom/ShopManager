"use strict";

// One-command test runner: `node scripts/run-tests.cjs`
// Runs every scripts/test-*.cjs in its own Node process and prints a
// PASS/FAIL line per file plus a summary. Node stdlib only -- no npm
// install, no network, nothing to configure. Exit code 0 means all passed.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const files = fs
  .readdirSync(__dirname)
  .filter(function (name) {
    return /^test-.*\.cjs$/.test(name);
  })
  .sort();

if (files.length === 0) {
  console.error("No test files found in " + __dirname);
  process.exit(1);
}

const failed = [];
for (const name of files) {
  console.log("=== " + name + " ===");
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    stdio: "inherit"
  });
  if (result.status !== 0) failed.push(name);
  console.log("");
}

console.log("----------------------------------------");
for (const name of files) {
  console.log((failed.includes(name) ? "FAIL  " : "PASS  ") + name);
}
if (failed.length > 0) {
  console.log("\n" + failed.length + " of " + files.length + " test files FAILED");
  process.exit(1);
}
console.log("\nALL TESTS PASSED (" + files.length + " files)");
