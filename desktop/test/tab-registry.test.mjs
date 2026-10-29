import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createTabRegistry } = require(path.join(here, "..", "tab-registry.js"));
const { TAB_OR_WINDOW_ID_RE } = require(path.join(here, "..", "desktop-state.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const pathKey = (p) => p.toLowerCase();
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const fileTab = (id, absPath) => ({ id, source: { kind: "file", absPath } });

test("a preferred tab id is kept when it is well formed and free", () => {
  const r = createTabRegistry({ pathKey });
  assert.equal(r.mintUniqueTabId(ID_A), ID_A);
  r.tabs.set(ID_A, {});
  const minted = r.mintUniqueTabId(ID_A);
  assert.notEqual(minted, ID_A);
  assert.match(minted, TAB_OR_WINDOW_ID_RE);
  assert.match(r.mintUniqueTabId("not an id"), TAB_OR_WINDOW_ID_RE);
  assert.match(r.mintUniqueTabId(undefined), TAB_OR_WINDOW_ID_RE);
});

test("window ids are checked against windows, not tabs", () => {
  const r = createTabRegistry({ pathKey });
  r.tabs.set(ID_A, {});
  assert.equal(r.mintUniqueWindowId(ID_A), ID_A);
  r.windowsById.set(ID_B, {});
  assert.notEqual(r.mintUniqueWindowId(ID_B), ID_B);
  assert.equal(r.mintUniqueTabId(ID_B), ID_B);
});

test("the first window record is the first one added, or none", () => {
  const r = createTabRegistry({ pathKey });
  assert.equal(r.firstWindowRecord(), null);
  const one = { id: "1" }, two = { id: "2" };
  r.windowsById.set("1", one);
  r.windowsById.set("2", two);
  assert.equal(r.firstWindowRecord(), one);
  r.windowsById.delete("1");
  assert.equal(r.firstWindowRecord(), two);
});

test("a routing key stays with a live owner and passes on once the owner is gone", () => {
  const r = createTabRegistry({ pathKey });
  const map = new Map();
  r.tabs.set(ID_A, {});
  assert.equal(r.claimRoutingKey(map, "k", ID_A), true);
  assert.equal(r.claimRoutingKey(map, "k", ID_A), true);
  assert.equal(r.claimRoutingKey(map, "k", ID_B), false);
  assert.equal(map.get("k"), ID_A);
  r.tabs.delete(ID_A);
  assert.equal(r.claimRoutingKey(map, "k", ID_B), true);
  assert.equal(map.get("k"), ID_B);
});

test("a file tab is indexed by its path key, and a blank tab is not", () => {
  const r = createTabRegistry({ pathKey });
  const a = fileTab(ID_A, "/Docs/One.splitpage");
  r.tabs.set(ID_A, a);
  r.indexTabSource(a);
  r.indexTabSource({ id: ID_B, source: { kind: "blank" } });
  assert.deepEqual([...r.pathToTabId], [["/docs/one.splitpage", ID_A]]);
});

test("a second live tab on the same path does not take the path over", () => {
  const r = createTabRegistry({ pathKey });
  const a = fileTab(ID_A, "/one"), b = fileTab(ID_B, "/ONE");
  r.tabs.set(ID_A, a); r.tabs.set(ID_B, b);
  r.indexTabSource(a);
  r.indexTabSource(b);
  assert.equal(r.pathToTabId.get("/one"), ID_A);
});

test("unindexing drops every path the tab holds and leaves others", () => {
  const r = createTabRegistry({ pathKey });
  r.pathToTabId.set("/one", ID_A);
  r.pathToTabId.set("/draft-of-one", ID_A);
  r.pathToTabId.set("/two", ID_B);
  r.unindexTabSource({ id: ID_A });
  assert.deepEqual([...r.pathToTabId], [["/two", ID_B]]);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
