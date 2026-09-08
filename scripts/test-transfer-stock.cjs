"use strict";

// Wire-shape and behavior tests for dbTransferStock (index.html), sliced and
// run in a vm sandbox (see vm-harness.cjs). This is the client half of the
// atomic/idempotent stock transfer (sql/stock-transfer/001, shop-write
// op:"record_transfer") -- it must send requestId through untouched, apply
// the server's returned per-location qty rather than compute its own, and
// never touch ST.itemLocs on failure.

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

const source = sliceBetween("async function dbTransferStock", "\nasync function fetchUsers");

const h = require("./vm-harness.cjs");
const suite = h.makeSuite("transfer-stock");
const test = suite.test;

function makeContext(opts) {
  opts = opts || {};
  const calls = { callWrite: [] };
  const st = opts.st || { storeId: "store-1", user: { name: "Akshay" }, itemLocs: {} };
  const context = vm.createContext({
    ST: st,
    TODAYKEY: "2026-09-08",
    callWrite: async function (op, table, payload) {
      calls.callWrite.push({ op: op, table: table, payload: payload });
      return opts.callWriteResult || { data: { txn_id: "txn-1", replayed: false, item_locations: [] }, error: null };
    }
  });
  vm.runInContext(source, context, { filename: "db-transfer-stock.js" });
  return { context: context, calls: calls, st: st };
}

test("sends op record_transfer with requestId, from/to locations, mapped lines; applies returned per-location qty", async function () {
  const st = { storeId: "store-1", user: { name: "Akshay" }, itemLocs: {} };
  const { context, calls } = makeContext({
    st: st,
    callWriteResult: {
      data: { txn_id: "txn-1", replayed: false, item_locations: [
        { item_id: "item-a", location_id: 1, qty: -5 },
        { item_id: "item-a", location_id: 2, qty: 5 }
      ] },
      error: null
    }
  });
  context.lines = [{ itemId: "item-a", name: "A", qty: 5 }];
  const ok = await vm.runInContext("dbTransferStock(1,2,lines,'req-1')", context, { filename: "call.js" });

  assert.strictEqual(ok, true);
  assert.strictEqual(calls.callWrite.length, 1);
  const sent = calls.callWrite[0];
  assert.strictEqual(sent.op, "record_transfer");
  assert.strictEqual(sent.table, null);
  assert.strictEqual(sent.payload.requestId, "req-1");
  assert.strictEqual(sent.payload.storeId, "store-1");
  assert.strictEqual(sent.payload.fromLocationId, 1);
  assert.strictEqual(sent.payload.toLocationId, 2);
  assert.strictEqual(sent.payload.byUser, "Akshay");
  assert.strictEqual(sent.payload.txnDate, "2026-09-08");
  assert.deepStrictEqual(h.plain(sent.payload.lines), [{ item_id: "item-a", item_name: "A", qty: 5 }]);
  assert.strictEqual(st.itemLocs["item-a"][1], -5, "ST.itemLocs must come from the server response, not a client-computed delta");
  assert.strictEqual(st.itemLocs["item-a"][2], 5);
});

test("failure: returns false, never touches ST.itemLocs", async function () {
  const st = { storeId: "store-1", user: { name: "Akshay" }, itemLocs: { "item-a": { 1: 10 } } };
  const { context } = makeContext({
    st: st,
    callWriteResult: { data: null, error: { message: "Network error: fetch failed" } }
  });
  context.lines = [{ itemId: "item-a", name: "A", qty: 5 }];
  const ok = await vm.runInContext("dbTransferStock(1,2,lines,'req-2')", context, { filename: "call.js" });
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(h.plain(st.itemLocs), { "item-a": { 1: 10 } }, "itemLocs must be untouched on failure");
});

test("replay: server's replayed:true response is applied the same way as a fresh write (no special-casing needed client-side)", async function () {
  const st = { storeId: "store-1", user: { name: "Akshay" }, itemLocs: { "item-a": { 1: -5, 2: 5 } } };
  const { context } = makeContext({
    st: st,
    callWriteResult: { data: { txn_id: "txn-1", replayed: true, item_locations: [
      { item_id: "item-a", location_id: 1, qty: -5 },
      { item_id: "item-a", location_id: 2, qty: 5 }
    ] }, error: null }
  });
  context.lines = [{ itemId: "item-a", name: "A", qty: 999 }];
  const ok = await vm.runInContext("dbTransferStock(1,2,lines,'req-1')", context, { filename: "call.js" });
  assert.strictEqual(ok, true);
  assert.strictEqual(st.itemLocs["item-a"][1], -5, "a replay must leave qty exactly as the server reports, ignoring this call's own (stale) line qty");
  assert.strictEqual(st.itemLocs["item-a"][2], 5);
});

suite.run();
