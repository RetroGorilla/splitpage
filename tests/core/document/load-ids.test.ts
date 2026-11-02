import { test } from "node:test";
import assert from "node:assert/strict";
import { canShareLoadId, createLoadIds } from "../../../src/core/document/load-ids.ts";

test("load identities canonicalize nested objects while retaining array order", () => {
  const first = { rows: [{ imageRef: { width: 10, height: 20 }, cells: ["a", "b"] }] };
  const reordered = { rows: [{ cells: ["a", "b"], imageRef: { height: 20, width: 10 } }] };
  const reversed = { rows: [{ cells: ["b", "a"], imageRef: { height: 20, width: 10 } }] };
  const ids = (source: unknown) => createLoadIds(() => source, () => []).id("r");
  assert.equal(ids(first), ids(reordered));
  assert.notEqual(ids(first), ids(reversed));
});

test("load identities initialize lazily and enumerate reservations once for a large twin group", () => {
  let reads = 0, scans = 0;
  const source = { rows: [{ audioText: "Repeat." }, { audioText: "Repeat." }] };
  const first = createLoadIds(() => source, () => []).id("r");
  const ids = createLoadIds(() => { reads++; return source; }, () => { scans++; return [first]; });
  assert.deepEqual([reads, scans], [0, 0]);
  const drawn = Array.from({ length: 10000 }, () => ids.id("r"));
  assert.equal(drawn[0], first.replace(/-1$/, "-2"));
  assert.equal(new Set(drawn).size, 10000);
  assert.ok(!drawn.includes(first));
  assert.deepEqual([reads, scans], [1, 1]);
});

test("changing twin content or a reservation gives every repaired record a different identity", () => {
  const source = { rows: [{ audioText: "Repeat." }, { audioText: "Repeat." }], people: [{ id: "held", name: "Ann" }] };
  const before = createLoadIds(() => source, () => []);
  const original = [before.id("r"), before.id("r"), before.id("rp"), before.id("c"), before.id("p"), before.id("bs")];
  for (const edit of ["row", "reservation"]) {
    const changed = structuredClone(source);
    if (edit === "row") changed.rows[0] = { audioText: "Edited." };
    else changed.people[0] = { id: "other", name: "Ann" };
    const after = createLoadIds(() => changed, () => []);
    const fresh = [after.id("r"), after.id("r"), after.id("rp"), after.id("c"), after.id("p"), after.id("bs")];
    assert.ok(fresh.every(id => !original.includes(id)));
  }
});

test("b-roll alignment cannot lend a different repaired identity, even within one source", () => {
  const source = { rows: [{ audioText: "one" }] };
  const original = createLoadIds(() => source, () => []).id("bs");
  const same = createLoadIds(() => structuredClone(source), () => []);
  const other = createLoadIds(() => ({ rows: [{ audioText: "two" }] }), () => []);
  assert.equal(same.id("bs"), original);
  assert.equal(canShareLoadId(original, same.id("bs")), false);
  assert.equal(canShareLoadId("bs-explicit", original), false);
  assert.equal(canShareLoadId(original, other.id("bs")), false);
  assert.equal(canShareLoadId(original, original), true);
  assert.equal(canShareLoadId("bs-old", "bs-other"), true);
});
