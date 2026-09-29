import test from "node:test";
import assert from "node:assert/strict";
import { planHistoryEviction } from "../../shared/history-policy.js";

const did = (tag) => "d" + tag.repeat(16).slice(0, 32);
const snap = (id, atMs, sizeBytes) => ({ id, atMs, sizeBytes });

test("(a) every document is trimmed to perDoc even with no cap at all", () => {
  const plan = planHistoryEviction(
    [{ docId: did("e0"), lastOpenedAt: 1, snapshots: [1, 2, 3, 4, 5].map((n) => snap("s" + n, n, 10)) }],
    Infinity, 100, { perDoc: 3 });
  assert.equal(plan.deletes.length, 2);
  assert.deepEqual(plan.deletes.map((d) => d.id), ["s1", "s2"], "oldest first");
  assert.equal(plan.overCap, false);
  assert.equal(plan.totalBefore, 50);
  assert.equal(plan.totalAfter, 30);
});

test("(b) an expired Older bucket goes as a whole; an unexpired one is untouched", () => {
  const bucket = (expiresAt) => [{
    docId: "_older", lastOpenedAt: 0, expiresAt,
    snapshots: [snap("o1", 1, 5), snap("o2", 2, 5)]
  }];
  assert.equal(planHistoryEviction(bucket(500), Infinity, 1000, {}).deletes.length, 2);
  assert.equal(planHistoryEviction(bucket(5000), Infinity, 1000, {}).deletes.length, 0);
  assert.equal(planHistoryEviction(bucket(0), Infinity, 1000, {}).deletes.length, 0);
});

test("(c) under cap pressure, an unexpired Older goes before any real document", () => {
  const plan = planHistoryEviction([
    { docId: "_older", lastOpenedAt: 0, expiresAt: 999999, snapshots: [snap("o1", 1, 50), snap("o2", 2, 50)] },
    { docId: did("e1"), lastOpenedAt: 5, snapshots: [snap("d1", 3, 50), snap("d2", 4, 50)] }
  ], 150, 100, {});
  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].docId, "_older");
  assert.ok(plan.totalAfter <= 150);
});

test("(d) the least-recently-opened document goes first; ties break by docId", () => {
  const plan = planHistoryEviction([
    { docId: did("e3"), lastOpenedAt: 10, snapshots: [snap("x1", 1, 50), snap("x2", 2, 50)] },
    { docId: did("e2"), lastOpenedAt: 10, snapshots: [snap("y1", 1, 50), snap("y2", 2, 50)] }
  ], 150, 100, {});
  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].docId, did("e2"));

  const byTime = planHistoryEviction([
    { docId: did("a1"), lastOpenedAt: 999, snapshots: [snap("x1", 1, 50), snap("x2", 2, 50)] },
    { docId: did("z9"), lastOpenedAt: 1, snapshots: [snap("y1", 1, 50), snap("y2", 2, 50)] }
  ], 150, 100, {});
  assert.deepEqual(byTime.deletes, [{ docId: did("z9"), id: "y1" }]);
});

test("(e) a document's newest snapshot is never deleted; overCap says so", () => {
  const plan = planHistoryEviction(
    [{ docId: did("e4"), lastOpenedAt: 1, snapshots: [snap("z1", 1, 1000)] }], 10, 100, {});
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.overCap, true);
  assert.equal(plan.totalAfter, 1000);
});

test("(f) garbage input is tolerated, never thrown on", () => {
  let plan;
  assert.doesNotThrow(() => {
    plan = planHistoryEviction(
      [null, {}, { docId: 42, snapshots: "nope" },
       { docId: did("e5"), snapshots: [null, { id: "ok" }, { id: "g1", atMs: "bad", sizeBytes: -5 }] }],
      "not a number", "also not a number", { perDoc: -3, olderKey: 7 });
  });
  assert.ok(Array.isArray(plan.deletes));
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.overCap, false);
  assert.doesNotThrow(() => planHistoryEviction(null, null, null, null));
  assert.doesNotThrow(() => planHistoryEviction(undefined, undefined, undefined, undefined));
});

test("(g) a protected snapshot is never the one an eviction takes", () => {
  const older = planHistoryEviction(
    [{ docId: "_older", lastOpenedAt: 0, expiresAt: 999999, snapshots: [snap("o1", 1, 50), snap("o2", 2, 50)] }],
    50, 100, { protect: [{ docId: "_older", id: "o1" }] });
  assert.equal(older.deletes.length, 1);
  assert.equal(older.deletes[0].id, "o2", "the next one goes instead");

  const doc = planHistoryEviction(
    [{ docId: did("f3"), lastOpenedAt: 1, snapshots: [snap("p1", 1, 50), snap("p2", 2, 50), snap("p3", 3, 50)] }],
    50, 100, { protect: [{ docId: did("f3"), id: "p1" }] });
  assert.equal(doc.deletes.length, 1);
  assert.equal(doc.deletes[0].id, "p2");
  assert.equal(doc.overCap, true, "rather than delete the newest");
});

test("an expired Older bucket keeps its protected entry for the next sweep", () => {
  const plan = planHistoryEviction(
    [{ docId: "_older", lastOpenedAt: 0, expiresAt: 500, snapshots: [snap("o1", 1, 5), snap("o2", 2, 5)] }],
    Infinity, 1000, { protect: [{ docId: "_older", id: "o1" }] });
  assert.deepEqual(plan.deletes.map((d) => d.id), ["o2"]);
});

test("nothing to do is a valid plan", () => {
  const plan = planHistoryEviction(
    [{ docId: did("n1"), lastOpenedAt: 100, snapshots: [snap("s1", 10, 10)] }], 1000, 1000, {});
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.totalBefore, 10);
  assert.equal(plan.totalAfter, 10);
  assert.equal(plan.overCap, false);
  assert.deepEqual(planHistoryEviction([], 1000, 1000, {}),
    { deletes: [], totalBefore: 0, totalAfter: 0, overCap: false });
});

test("snapshots are ordered by time, not by the order they arrive in", () => {
  const plan = planHistoryEviction(
    [{ docId: did("s0"), lastOpenedAt: 1, snapshots: [snap("late", 30, 10), snap("early", 10, 10), snap("mid", 20, 10)] }],
    Infinity, 100, { perDoc: 1 });
  assert.deepEqual(plan.deletes.map((d) => d.id), ["early", "mid"]);
});

test("a custom olderKey is what gets the Older treatment", () => {
  const docs = [{ docId: "_archive", lastOpenedAt: 0, expiresAt: 500, snapshots: [snap("o1", 1, 5), snap("o2", 2, 5)] }];
  assert.deepEqual(planHistoryEviction(docs, Infinity, 1000, {}).deletes, []);
  assert.equal(planHistoryEviction(docs, Infinity, 1000, { olderKey: "_archive" }).deletes.length, 2);
});
