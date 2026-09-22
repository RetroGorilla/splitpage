/* planHistoryEviction (03a-history-store.js) — what version history throws
 * away when the budget runs out.
 *
 * Ported from the "eviction planner fixtures (a)-(g)" block of
 * tests/24-history.txt, which booted a browser and reached this through
 * window.__historyTest.planEviction even though the comment above it
 * already said the function is PURE and needs no backend at all (#67).
 *
 * The backdoor member itself STAYS, and deliberately: desktop/test/smoke
 * .mjs drives it to prove main.js's line-for-line copy of this planner
 * still answers exactly what the renderer's does (caseHistoryPlannerTwin).
 * That is a two-implementation comparison over CDP, not a unit test, and
 * nothing here can replace it.
 *
 * The order the planner applies, until the total fits:
 *   1. the Older bucket once expired (always, cap or not), as a whole
 *   2. every document trimmed to perDoc (always)
 *   3. Older, oldest first
 *   4. documents by lastOpenedAt ascending (ties by docId), each one's
 *      oldest snapshot first, while it still has more than one
 *   5. a document's newest snapshot is never deleted; if nothing more can
 *      go, overCap is reported
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planHistoryEviction } from "../js/03a-history-store.js";

/* 24-history.txt's did(): a canonical 32-hex document id built out of a
   two-character tag, so a fixture reads as which document it is. */
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
  /* No expiry set at all is not an expiry of zero: the sweep only ever
     looks at `expiresAt > 0`. */
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

  /* And when the times differ, the time decides rather than the id. */
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
  /* A negative perDoc falls back to the default rather than trimming
     everything, and an unusable cap means no budget rather than a budget
     of zero. */
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.overCap, false);
  assert.doesNotThrow(() => planHistoryEviction(null, null, null, null));
  assert.doesNotThrow(() => planHistoryEviction(undefined, undefined, undefined, undefined));
});

test("(g) a protected snapshot is never the one an eviction takes", () => {
  /* The snapshot a restore is reading while its backup is written. */
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
  /* A backend that hands them back in insertion order must not change
     which one is called the oldest. */
  const plan = planHistoryEviction(
    [{ docId: did("s0"), lastOpenedAt: 1, snapshots: [snap("late", 30, 10), snap("early", 10, 10), snap("mid", 20, 10)] }],
    Infinity, 100, { perDoc: 1 });
  assert.deepEqual(plan.deletes.map((d) => d.id), ["early", "mid"]);
});

test("a custom olderKey is what gets the Older treatment", () => {
  const docs = [{ docId: "_archive", lastOpenedAt: 0, expiresAt: 500, snapshots: [snap("o1", 1, 5), snap("o2", 2, 5)] }];
  /* Under the default key it is an ordinary document: expiry means nothing
     and its newest snapshot is protected. */
  assert.deepEqual(planHistoryEviction(docs, Infinity, 1000, {}).deletes, []);
  assert.equal(planHistoryEviction(docs, Infinity, 1000, { olderKey: "_archive" }).deletes.length, 2);
});
