"use strict";

// Wire-shape and behavior tests for dbRecordTransaction (index.html), sliced
// and run in a vm sandbox (see vm-harness.cjs). This is the client half of
// the atomic/idempotent sale+stock-in write (sql/atomic-transactions/001,
// shop-write op:"record_txn") -- it must send requestId through untouched,
// apply the server's returned qty rather than compute its own, and never
// touch ST.inv or call dbUpdateLocStock on failure.

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

const source = sliceBetween("async function dbRecordTransaction", "\nasync function dbDeleteTransaction");

const h = require("./vm-harness.cjs");
const suite = h.makeSuite("record-transaction");
const test = suite.test;

function makeContext(opts) {
  opts = opts || {};
  const calls = { callWrite: [], dbUpdateLocStock: [], alert: [] };
  const st = opts.st || { storeId: "store-1", user: { name: "Akshay" }, inv: [] };
  const context = vm.createContext({
    ST: st,
    callWrite: async function (op, table, payload) {
      calls.callWrite.push({ op: op, table: table, payload: payload });
      return opts.callWriteResult || { data: { txn_id: "txn-1", replayed: false, items: [] }, error: null };
    },
    dbUpdateLocStock: async function (itemId, locationId, delta) {
      calls.dbUpdateLocStock.push({ itemId: itemId, locationId: locationId, delta: delta });
    },
    alert: function (msg) {
      calls.alert.push(msg);
    }
  });
  vm.runInContext(source, context, { filename: "db-record-transaction.js" });
  return { context: context, calls: calls, st: st };
}

test("sale: sends op record_txn with requestId, type, mapped lines; applies returned qty; updates per-location stock", async function () {
  const st = { storeId: "store-1", user: { name: "Akshay" }, inv: [{ id: "item-a", qty: 50 }, { id: "item-b", qty: 20 }] };
  const { context, calls } = makeContext({
    st: st,
    callWriteResult: {
      data: { txn_id: "txn-1", replayed: false, items: [{ item_id: "item-a", qty: 45 }, { item_id: "item-b", qty: 17 }] },
      error: null
    }
  });
  context.lines = [
    { itemId: "item-a", name: "A", qty: 5, locationId: 9 },
    { itemId: "item-b", name: "B", qty: 3, locationId: null }
  ];
  const ok = await vm.runInContext("dbRecordTransaction('out',{ref:'R1',date:'2026-09-08',requestId:'req-1'},lines)", context, { filename: "call.js" });

  assert.strictEqual(ok, true);
  assert.strictEqual(calls.callWrite.length, 1);
  const sent = calls.callWrite[0];
  assert.strictEqual(sent.op, "record_txn");
  assert.strictEqual(sent.table, null);
  assert.strictEqual(sent.payload.requestId, "req-1");
  assert.strictEqual(sent.payload.storeId, "store-1");
  assert.strictEqual(sent.payload.type, "out");
  assert.strictEqual(sent.payload.byUser, "Akshay");
  assert.deepStrictEqual(h.plain(sent.payload.lines), [
    { item_id: "item-a", item_name: "A", qty: 5, location_id: 9 },
    { item_id: "item-b", item_name: "B", qty: 3, location_id: null }
  ]);
  assert.strictEqual(st.inv[0].qty, 45, "ST.inv qty must come from the server response, not a client-computed delta");
  assert.strictEqual(st.inv[1].qty, 17);
  assert.strictEqual(calls.dbUpdateLocStock.length, 1, "only the line with a locationId updates per-location stock");
  assert.deepStrictEqual(calls.dbUpdateLocStock[0], { itemId: "item-a", locationId: 9, delta: -5 });
});

test("stock-in: locDelta is positive, requestId still passed through", async function () {
  const st = { storeId: "store-1", user: { name: "Lokesh" }, inv: [{ id: "item-a", qty: 10 }] };
  const { context, calls } = makeContext({
    st: st,
    callWriteResult: { data: { txn_id: "txn-2", replayed: false, items: [{ item_id: "item-a", qty: 20 }] }, error: null }
  });
  context.lines = [{ itemId: "item-a", name: "A", qty: 10, locationId: 4 }];
  const ok = await vm.runInContext("dbRecordTransaction('in',{supplier:'S',ref:'R2',date:'2026-09-08',requestId:'req-2'},lines)", context, { filename: "call.js" });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.callWrite[0].payload.type, "in");
  assert.strictEqual(calls.callWrite[0].payload.requestId, "req-2");
  assert.strictEqual(st.inv[0].qty, 20);
  assert.deepStrictEqual(calls.dbUpdateLocStock[0], { itemId: "item-a", locationId: 4, delta: 10 });
});

test("failure: alerts, returns false, never touches ST.inv or per-location stock", async function () {
  const st = { storeId: "store-1", user: { name: "Akshay" }, inv: [{ id: "item-a", qty: 50 }] };
  const { context, calls } = makeContext({
    st: st,
    callWriteResult: { data: null, error: { message: "Network error: fetch failed" } }
  });
  context.lines = [{ itemId: "item-a", name: "A", qty: 5, locationId: 1 }];
  const ok = await vm.runInContext("dbRecordTransaction('out',{ref:'R',date:'2026-09-08',requestId:'req-3'},lines)", context, { filename: "call.js" });
  assert.strictEqual(ok, false);
  assert.strictEqual(st.inv[0].qty, 50, "qty must be untouched on failure");
  assert.strictEqual(calls.dbUpdateLocStock.length, 0, "per-location stock must not run on failure");
  assert.strictEqual(calls.alert.length, 1);
  assert.match(calls.alert[0], /Network error: fetch failed/);
});

test("replay: server's replayed:true response is applied the same way as a fresh write (no special-casing needed client-side)", async function () {
  const st = { storeId: "store-1", user: { name: "Akshay" }, inv: [{ id: "item-a", qty: 45 }] };
  const { context, calls } = makeContext({
    st: st,
    callWriteResult: { data: { txn_id: "txn-1", replayed: true, items: [{ item_id: "item-a", qty: 45 }] }, error: null }
  });
  context.lines = [{ itemId: "item-a", name: "A", qty: 999, locationId: null }];
  const ok = await vm.runInContext("dbRecordTransaction('out',{ref:'retry',date:'2026-09-08',requestId:'req-1'},lines)", context, { filename: "call.js" });
  assert.strictEqual(ok, true);
  assert.strictEqual(st.inv[0].qty, 45, "a replay must leave qty exactly as the server reports, ignoring this call's own (stale) line qty");
});

suite.run();
