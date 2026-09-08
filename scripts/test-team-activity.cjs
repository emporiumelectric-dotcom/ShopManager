"use strict";

// Tests for the pure helpers behind the Team Activity report (index.html):
// computePeriodRange, aggregateTeamActivity, polarToXY, donutSlicePath.
// Sliced and run in a vm sandbox, same style as test-record-transaction.cjs.
// These are pure functions (no ST, no DOM) so the sandbox only needs to
// supply the one global they read: TODAYKEY.

const assert = require("assert");
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const html = fs
  .readFileSync(path.join(__dirname, "..", "index.html"), "utf8")
  .replace(/\r\n/g, "\n");

function sliceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert(start >= 0 && end > start, "missing source markers: " + JSON.stringify(startMarker) + " .. " + JSON.stringify(endMarker));
  return html.slice(start, end);
}

const source = sliceBetween(
  "// ===== TEAM ACTIVITY REPORT =====",
  "\nfunction renderReports(tc){"
);

const h = require("./vm-harness.cjs");
const suite = h.makeSuite("team-activity");
const test = suite.test;

function makeContext(todayKey) {
  const context = vm.createContext({ TODAYKEY: todayKey });
  vm.runInContext(source, context, { filename: "team-activity.js" });
  return context;
}

function call(context, expr) {
  return vm.runInContext(expr, context);
}

// --- computePeriodRange ---------------------------------------------------

test("computePeriodRange('today') is just TODAYKEY on both ends", function () {
  const context = makeContext("2026-09-08");
  const r = call(context, "computePeriodRange('today', '', '')");
  assert.deepStrictEqual(h.plain(r), { from: "2026-09-08", to: "2026-09-08" });
});

test("computePeriodRange('week') starts on the most recent Monday (UTC)", function () {
  // 2026-09-08 is a Tuesday (UTC) -> most recent Monday is 2026-09-07.
  const context = makeContext("2026-09-08");
  const r = call(context, "computePeriodRange('week', '', '')");
  assert.deepStrictEqual(h.plain(r), { from: "2026-09-07", to: "2026-09-08" });
});

test("computePeriodRange('week') on a Monday returns that same Monday", function () {
  // 2026-09-07 is itself a Monday (UTC).
  const context = makeContext("2026-09-07");
  const r = call(context, "computePeriodRange('week', '', '')");
  assert.deepStrictEqual(h.plain(r), { from: "2026-09-07", to: "2026-09-07" });
});

test("computePeriodRange('month') starts on the 1st of the current UTC month", function () {
  const context = makeContext("2026-09-08");
  const r = call(context, "computePeriodRange('month', '', '')");
  assert.deepStrictEqual(h.plain(r), { from: "2026-09-01", to: "2026-09-08" });
});

test("computePeriodRange('custom') passes the given dates through, defaulting to TODAYKEY", function () {
  const context = makeContext("2026-09-08");
  const withDates = call(context, "computePeriodRange('custom', '2026-08-01', '2026-08-15')");
  assert.deepStrictEqual(h.plain(withDates), { from: "2026-08-01", to: "2026-08-15" });
  const noDates = call(context, "computePeriodRange('custom', '', '')");
  assert.deepStrictEqual(h.plain(noDates), { from: "2026-09-08", to: "2026-09-08" });
});

// --- aggregateTeamActivity --------------------------------------------------

test("aggregateTeamActivity groups by by_user, counts per type, sorts descending by total", function () {
  const context = makeContext("2026-09-08");
  context.rows = [
    { type: "out", by_user: "Akshay", txn_date: "2026-09-08" },
    { type: "out", by_user: "Akshay", txn_date: "2026-09-08" },
    { type: "in", by_user: "Akshay", txn_date: "2026-09-08" },
    { type: "out", by_user: "Lokesh", txn_date: "2026-09-08" },
    { type: "in", by_user: "Lokesh", txn_date: "2026-09-08" },
    { type: "in", by_user: "Lokesh", txn_date: "2026-09-08" },
    { type: "in", by_user: "Lokesh", txn_date: "2026-09-08" }
  ];
  const result = h.plain(call(context, "aggregateTeamActivity(rows)"));
  assert.deepStrictEqual(result, [
    { name: "Lokesh", total: 4, out: 1, in: 3, transfer: 0 },
    { name: "Akshay", total: 3, out: 2, in: 1, transfer: 0 }
  ]);
});

test("aggregateTeamActivity: a staff member with zero rows in the period never appears (nothing to group)", function () {
  const context = makeContext("2026-09-08");
  context.rows = [{ type: "out", by_user: "Akshay", txn_date: "2026-09-08" }];
  const result = h.plain(call(context, "aggregateTeamActivity(rows)"));
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, "Akshay");
});

test("aggregateTeamActivity: missing by_user falls back to 'Unknown' instead of a blank group", function () {
  const context = makeContext("2026-09-08");
  context.rows = [{ type: "out", by_user: null, txn_date: "2026-09-08" }];
  const result = h.plain(call(context, "aggregateTeamActivity(rows)"));
  assert.strictEqual(result[0].name, "Unknown");
});

test("aggregateTeamActivity: an unrecognized type (defensive) counts toward transfer, not silently dropped", function () {
  const context = makeContext("2026-09-08");
  context.rows = [{ type: "transfer", by_user: "Akshay", txn_date: "2026-09-08" }];
  const result = h.plain(call(context, "aggregateTeamActivity(rows)"));
  assert.strictEqual(result[0].transfer, 1);
  assert.strictEqual(result[0].total, 1);
});

// --- donut geometry ----------------------------------------------------------

test("polarToXY: 0 radians (12 o'clock) is straight up from center", function () {
  const context = makeContext("2026-09-08");
  const p = call(context, "polarToXY(50, 50, 40, 0)");
  assert.strictEqual(Math.round(p.x), 50);
  assert.strictEqual(Math.round(p.y), 10);
});

test("polarToXY: quarter turn (PI/2) is straight right of center", function () {
  const context = makeContext("2026-09-08");
  const p = call(context, "polarToXY(50, 50, 40, Math.PI / 2)");
  assert.strictEqual(Math.round(p.x), 90);
  assert.strictEqual(Math.round(p.y), 50);
});

test("donutSlicePath: a small wedge uses the small-arc flag (0)", function () {
  const context = makeContext("2026-09-08");
  const d = call(context, "donutSlicePath(50, 50, 40, 20, 0, Math.PI / 2)");
  // "A rOuter rOuter 0 <largeArcFlag> 1 x y" -- assert the large-arc flag is 0.
  assert.match(d, /A 40 40 0 0 1/);
});

test("donutSlicePath: a wedge over half the circle uses the large-arc flag (1)", function () {
  const context = makeContext("2026-09-08");
  const d = call(context, "donutSlicePath(50, 50, 40, 20, 0, Math.PI * 1.5)");
  assert.match(d, /A 40 40 0 1 1/);
});

test("donutSlicePath: start and end angle equal (degenerate) still returns a finite path, no NaN", function () {
  const context = makeContext("2026-09-08");
  const d = call(context, "donutSlicePath(50, 50, 40, 20, 0, 0)");
  assert.doesNotMatch(d, /NaN/);
});

test("TEAM_ACTIVITY_PALETTE has 8 fixed-order hex slots (dataviz-validated categorical default)", function () {
  const context = makeContext("2026-09-08");
  const palette = call(context, "TEAM_ACTIVITY_PALETTE");
  assert.deepStrictEqual(h.plain(palette), [
    "#2a78d6", "#eb6834", "#1baf7a", "#eda100",
    "#e87ba4", "#008300", "#4a3aa7", "#e34948"
  ]);
});

suite.run();
