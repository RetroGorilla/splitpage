import { test } from "node:test";
import assert from "node:assert/strict";
import { createProductionSelection } from "../../../src/application/editing/production-selection.ts";

function setup() {
  const jobs = new Map<unknown, () => void>();
  const delays: number[] = [];
  const cancelled: unknown[] = [];
  let serial = 0;
  const selection = createProductionSelection({
    start(run, ms) { const id = ++serial; delays.push(ms); jobs.set(id, run); return id; },
    stop(id) { cancelled.push(id); jobs.delete(id); }
  });
  return { selection, jobs, delays, cancelled };
}

test("toggle changes membership and anchor while readers cannot mutate the selected keys", () => {
  const { selection } = setup();
  assert.deepEqual(selection.selectedKeys(), []);
  assert.equal(selection.anchorKey(), null);
  assert.equal(selection.armed(), false);
  selection.toggle("hat");
  selection.toggle("coat");
  assert.deepEqual(selection.selectedKeys(), ["hat", "coat"]);
  assert.equal(selection.selected("hat"), true);
  selection.selectedKeys().pop();
  assert.deepEqual(selection.selectedKeys(), ["hat", "coat"]);
  selection.toggle("coat");
  assert.equal(selection.selected("coat"), false);
  assert.equal(selection.anchorKey(), "coat");
});

test("range selection adds the inclusive range without moving the anchor, in either direction", () => {
  const { selection } = setup();
  const order = ["one", "two", "three", "four"];
  assert.equal(selection.select("two", order, false), true);
  assert.equal(selection.select("four", order, true), true);
  assert.deepEqual(selection.selectedKeys(), ["two", "three", "four"]);
  assert.equal(selection.anchorKey(), "two");
  assert.equal(selection.select("one", order, true), true);
  assert.deepEqual(selection.selectedKeys(), ["two", "three", "four", "one"]);
  assert.equal(selection.anchorKey(), "two");
  assert.equal(selection.select("missing", order, false), false);
  assert.deepEqual(selection.selectedKeys(), ["two", "three", "four", "one"]);
  assert.equal(selection.anchorKey(), "two");
});

test("shift with an absent anchor toggles and makes a new anchor", () => {
  const { selection } = setup();
  selection.select("one", ["one", "two"], true);
  assert.deepEqual(selection.selectedKeys(), ["one"]);
  selection.select("two", ["two"], true);
  assert.deepEqual(selection.selectedKeys(), ["one", "two"]);
  assert.equal(selection.anchorKey(), "two");
  selection.select("two", ["two"], false);
  assert.deepEqual(selection.selectedKeys(), ["one"]);
  assert.equal(selection.anchorKey(), "two");
});

test("bulk delete rearms for 2800 ms and announces expiry only after disarming", () => {
  const { selection, jobs, delays, cancelled } = setup();
  const seen: boolean[] = [];
  selection.arm(() => assert.fail("replaced"));
  selection.arm(() => { seen.push(selection.armed()); });
  assert.equal(selection.armed(), true);
  assert.deepEqual(delays, [2800, 2800]);
  assert.deepEqual(cancelled, [null, 1]);
  assert.deepEqual([...jobs.keys()], [2]);
  const expire = jobs.get(2);
  assert.ok(expire);
  expire();
  assert.deepEqual(seen, [false]);
  assert.equal(selection.armed(), false);
  selection.arm(() => assert.fail("cancelled"));
  selection.disarm();
  assert.equal(selection.armed(), false);
  assert.equal(jobs.has(3), false);
});

test("prune retains a bulk arm until a selected key drops and clears a missing anchor independently", () => {
  const { selection, jobs } = setup();
  selection.toggle("one");
  selection.toggle("two");
  selection.arm(() => assert.fail("cancelled"));
  selection.prune([{ key: "one" }, { key: "two" }]);
  assert.equal(selection.armed(), true);
  assert.equal(jobs.size, 1);
  selection.prune([{ key: "two" }]);
  assert.deepEqual(selection.selectedKeys(), ["two"]);
  assert.equal(selection.anchorKey(), "two");
  assert.equal(selection.armed(), false);
  assert.equal(jobs.size, 0);
  selection.toggle("two");
  selection.arm(() => {});
  selection.prune([]);
  assert.equal(selection.anchorKey(), null);
  assert.equal(selection.armed(), true);
});

test("clear resets selection and anchor and cancels the bulk timer", () => {
  const { selection, jobs } = setup();
  selection.toggle("one");
  selection.arm(() => assert.fail("cancelled"));
  selection.clear();
  assert.deepEqual(selection.selectedKeys(), []);
  assert.equal(selection.anchorKey(), null);
  assert.equal(selection.armed(), false);
  assert.equal(jobs.size, 0);
  const other = setup().selection;
  selection.toggle("two");
  assert.deepEqual(other.selectedKeys(), []);
});