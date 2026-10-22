import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeleteConfirm } from "../../../src/application/editing/delete-confirm.ts";
import type { DeleteArea } from "../../../src/application/editing/delete-confirm.ts";

function clock() {
  const jobs = new Map<unknown, () => void>();
  const events: unknown[] = [];
  let serial = 0;
  return {
    jobs,
    events,
    start(run: () => void, ms: number): unknown {
      const id = ++serial;
      events.push(["start", id, ms]);
      jobs.set(id, run);
      return id;
    },
    stop(id: unknown): void {
      events.push(["stop", id]);
      jobs.delete(id);
    },
    fire(id: unknown): void {
      const run = jobs.get(id);
      assert.ok(run);
      jobs.delete(id);
      run();
    }
  };
}

for (const area of ["row", "tag", "comment"] as const) {
  test(area + " confirmation arms before painting, cancels after painting and expires before its announcement", () => {
    const timers = clock();
    const owner = createDeleteConfirm(timers);
    assert.equal(owner.armedId(area), null);
    const seen: (string | null)[] = [];
    owner.arm(area, "one", () => {
      seen.push(owner.armedId(area));
      timers.events.push("expired");
    }, () => {
      seen.push(owner.armedId(area));
      timers.events.push("paint");
    });
    assert.deepEqual(timers.events, ["paint", ["stop", null], ["start", 1, 2800]]);
    assert.equal(owner.armedId(area), "one");
    timers.fire(1);
    assert.deepEqual(seen, ["one", null]);
    assert.equal(owner.armedId(area), null);
    assert.deepEqual(timers.events, ["paint", ["stop", null], ["start", 1, 2800], "expired"]);
  });
}

test("replacement cancels the old confirmation without repainting its button, and areas remain independent", () => {
  const timers = clock();
  const owner = createDeleteConfirm(timers);
  const expired: string[] = [];
  owner.arm("tag", "hat", () => { expired.push("hat"); });
  owner.arm("row", "row", () => { expired.push("row"); });
  owner.arm("tag", "person:ada", () => { expired.push("person"); });
  assert.equal(owner.armedId("tag"), "person:ada");
  assert.equal(owner.armedId("row"), "row");
  assert.equal(timers.jobs.has(1), false);
  assert.deepEqual([...timers.jobs.keys()], [2, 3]);
  owner.disarm("tag");
  assert.equal(owner.armedId("tag"), null);
  assert.deepEqual([...timers.jobs.keys()], [2]);
  timers.fire(2);
  assert.deepEqual(expired, ["row"]);
  owner.disarm("comment");
  assert.equal(owner.armedId("comment"), null);
});

test("comment timers keep their lifetime guard and cancellation port", () => {
  const normal = clock();
  const comments = clock();
  let current = true;
  const owner = createDeleteConfirm(normal);
  let expired = 0;
  owner.arm("comment", "c1", () => { expired++; }, undefined, {
    start(run, ms) { return comments.start(() => { if (current) run(); }, ms); },
    stop: comments.stop
  });
  assert.deepEqual(comments.events, [["start", 1, 2800]]);
  current = false;
  comments.fire(1);
  assert.equal(owner.armedId("comment"), "c1");
  assert.equal(expired, 0);
  owner.disarm("comment");
  assert.equal(owner.armedId("comment"), null);
  assert.deepEqual(comments.events, [["start", 1, 2800], ["stop", 1]]);
});

test("dispose cancels row, comment and tag confirmations in the render reset order", () => {
  const timers = clock();
  const owner = createDeleteConfirm(timers);
  for (const area of ["row", "comment", "tag"] as const) owner.arm(area, area, () => assert.fail("cancelled"));
  timers.events.length = 0;
  owner.dispose();
  assert.deepEqual(timers.events, [["stop", 1], ["stop", 2], ["stop", 3]]);
  assert.equal(timers.jobs.size, 0);
  for (const area of ["row", "comment", "tag"] as DeleteArea[]) assert.equal(owner.armedId(area), null);
});

test("confirmation owners share no state", () => {
  const timers = clock();
  const one = createDeleteConfirm(timers);
  const two = createDeleteConfirm(timers);
  one.arm("row", "r1", () => {});
  assert.equal(two.armedId("row"), null);
  one.dispose();
});