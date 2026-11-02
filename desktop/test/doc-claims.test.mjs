import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createDocClaims } = require(path.join(here, "..", "doc-claims.ts"));
const policy = require(path.join(here, "..", "..", "shared", "doc-id-policy.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const DOC = "d" + "1".repeat(32);
const OTHER_DOC = "d" + "2".repeat(32);

function expectedToId(fromId, homeKey) {
  const hex = crypto.createHash("sha256").update(policy.duplicateReplacementInput(fromId, homeKey), "utf8").digest("hex");
  return policy.docIdFromSha256Hex(hex);
}

function harness() {
  const contents = new Map();
  const sent = [];
  let nextId = 1;
  const claims = createDocClaims({
    policy,
    homeKeyOf: (tab) => tab.home || null,
    contentsFor: (id) => contents.get(id) || null,
    askToReassign: (wc, payload) => wc.send("splitpage:reassign-doc-id", payload)
  });
  function sender(opts) {
    const s = new EventEmitter();
    s.id = nextId++;
    const wc = {
      send(channel, payload) {
        if (opts && opts.throws) throw new Error("gone");
        sent.push({ to: s.id, channel, payload });
      }
    };
    if (!(opts && opts.noContents)) contents.set(s.id, wc);
    s.destroy = () => { contents.delete(s.id); s.emit("destroyed"); };
    return s;
  }
  return { claims, sender, sent, contents };
}

test("the later tab holding the same document from another file is told to take a new id", () => {
  const h = harness();
  const a = h.sender(), b = h.sender();
  h.claims.record(a, { docId: DOC, home: "file:/one.splitpage", title: "One" });
  assert.deepEqual(h.sent, []);
  h.claims.record(b, { docId: DOC, home: "file:/two.splitpage", title: "Two" });
  assert.deepEqual(h.sent, [{
    to: b.id,
    channel: "splitpage:reassign-doc-id",
    payload: { fromId: DOC, toId: expectedToId(DOC, "file:/two.splitpage"), otherTitle: "One" }
  }]);
});

test("the same document from the same file, or different documents, is no duplicate", () => {
  const h = harness();
  h.claims.record(h.sender(), { docId: DOC, home: "file:/one.splitpage", title: "A" });
  h.claims.record(h.sender(), { docId: DOC, home: "file:/one.splitpage", title: "B" });
  h.claims.record(h.sender(), { docId: OTHER_DOC, home: "file:/two.splitpage", title: "C" });
  assert.deepEqual(h.sent, []);
});

test("a tab without a valid id or a home holds no claim, and drops the one it had", () => {
  const h = harness();
  const a = h.sender(), b = h.sender(), c = h.sender();
  h.claims.record(a, { docId: DOC, home: "file:/one.splitpage", title: "One" });
  h.claims.record(a, { docId: DOC, home: null, title: "One" });
  h.claims.record(b, { docId: DOC, home: "file:/two.splitpage", title: "Two" });
  h.claims.record(c, { docId: "not-an-id", home: "file:/three.splitpage", title: "Three" });
  h.claims.record(c, { docId: 7, home: "file:/three.splitpage", title: "Three" });
  assert.deepEqual(h.sent, []);
});

test("recording the same claim again only updates its title, and an asked tab is not asked twice", () => {
  const h = harness();
  const a = h.sender(), b = h.sender();
  h.claims.record(a, { docId: DOC, home: "file:/one.splitpage", title: "One" });
  h.claims.record(b, { docId: DOC, home: "file:/two.splitpage", title: "Two" });
  h.claims.record(a, { docId: DOC, home: "file:/one.splitpage", title: "One renamed" });
  h.claims.record(b, { docId: DOC, home: "file:/two.splitpage", title: "Two renamed" });
  assert.equal(h.sent.length, 1);
  const c = h.sender();
  h.claims.record(c, { docId: DOC, home: "file:/three.splitpage", title: "Three" });
  assert.deepEqual(h.sent.slice(1).map((m) => [m.to, m.payload.otherTitle]), [[c.id, "One renamed"]]);
});

test("a tab moving to a new file is a new claim and is checked again", () => {
  const h = harness();
  const a = h.sender(), b = h.sender();
  h.claims.record(a, { docId: DOC, home: "file:/one.splitpage", title: "One" });
  h.claims.record(b, { docId: DOC, home: "file:/one.splitpage", title: "Same" });
  assert.equal(h.sent.length, 0);
  h.claims.record(b, { docId: DOC, home: "file:/moved.splitpage", title: "Moved" });
  assert.deepEqual(h.sent.map((m) => [m.to, m.payload.toId]), [[b.id, expectedToId(DOC, "file:/moved.splitpage")]]);
});

test("a destroyed tab's claim goes, and the cleanup is registered once per tab", () => {
  const h = harness();
  const a = h.sender(), b = h.sender();
  h.claims.record(a, { docId: DOC, home: "file:/one.splitpage", title: "One" });
  h.claims.record(a, { docId: DOC, home: "file:/one-b.splitpage", title: "One" });
  assert.equal(a.listenerCount("destroyed"), 1);
  a.destroy();
  h.claims.record(b, { docId: DOC, home: "file:/two.splitpage", title: "Two" });
  assert.deepEqual(h.sent, []);
});

test("a loser with no live contents is skipped, and is asked when it next claims a new home", () => {
  const h = harness();
  const a = h.sender(), b = h.sender({ noContents: true });
  h.claims.record(a, { docId: DOC, home: "file:/one.splitpage", title: "One" });
  h.claims.record(b, { docId: DOC, home: "file:/two.splitpage", title: "Two" });
  assert.deepEqual(h.sent, []);
  h.contents.set(b.id, { send: (channel, payload) => h.sent.push({ to: b.id, channel, payload }) });
  h.claims.record(b, { docId: DOC, home: "file:/two-b.splitpage", title: "Two" });
  assert.deepEqual(h.sent.map((m) => [m.to, m.payload.toId]), [[b.id, expectedToId(DOC, "file:/two-b.splitpage")]]);
});

test("a send that throws is swallowed", () => {
  const h = harness();
  const a = h.sender(), b = h.sender({ throws: true });
  h.claims.record(a, { docId: DOC, home: "file:/one.splitpage", title: "One" });
  assert.doesNotThrow(() => h.claims.record(b, { docId: DOC, home: "file:/two.splitpage", title: "Two" }));
  assert.deepEqual(h.sent, []);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
