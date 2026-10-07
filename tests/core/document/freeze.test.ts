import { test } from "node:test";
import assert from "node:assert/strict";
import { deepFreeze, noFreeze } from "../../../src/core/document/freeze.ts";

test("deepFreeze freezes every object and array it can reach and hands back the same value", () => {
  const leaf = { n: 1 };
  const value = { list: [leaf, [leaf, { deep: [2] }]], map: { a: leaf } };
  assert.equal(deepFreeze(value), value);
  const all = [value, value.list, leaf, value.list[1], value.map];
  all.forEach((o) => assert.ok(Object.isFrozen(o)));
  assert.ok(Object.isFrozen((value.list[1] as [unknown, { deep: number[] }])[1].deep));
  assert.throws(() => { (leaf as { n: number }).n = 2; }, TypeError);
});

test("deepFreeze walks into an object frozen only at its top", () => {
  const inner = { n: 1 };
  const outer = Object.freeze({ inner: inner });
  deepFreeze(outer);
  assert.ok(Object.isFrozen(inner));
});

test("deepFreeze ends on a cycle and leaves primitives as they are", () => {
  const a: { self?: unknown; b: { back?: unknown } } = { b: {} };
  a.self = a;
  a.b.back = a;
  assert.equal(deepFreeze(a), a);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.b));
  assert.equal(deepFreeze("text"), "text");
  assert.equal(deepFreeze(3), 3);
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze(undefined), undefined);
});

test("noFreeze hands back the same value and freezes nothing", () => {
  const value = { list: [{ n: 1 }] };
  assert.equal(noFreeze(value), value);
  assert.equal(Object.isFrozen(value), false);
  assert.equal(Object.isFrozen(value.list[0]), false);
});
