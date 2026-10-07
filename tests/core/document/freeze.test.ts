import { test } from "node:test";
import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";
import { deepFreeze, deepLock, noFreeze } from "../../../src/core/document/freeze.ts";

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

const sloppy = runInThisContext(
  "(function (v, write) { switch (write) {" +
  " case 'set': v.id = 'x'; return v.id;" +
  " case 'nested': v.list[0].text = 'x'; return v.list[0].text;" +
  " case 'index': v.list[0] = 'x'; return v.list[0];" +
  " case 'length': v.list.length = 0; return v.list.length;" +
  " case 'delete': delete v.id; return v.id;" +
  " case 'add': v.added = 1; return v.added;" +
  " case 'proto': Object.setPrototypeOf(v, null); return Object.getPrototypeOf(v);" +
  " case 'define': Object.defineProperty(v, 'id', { value: 'x' }); return v.id;" +
  " } })"
) as (v: unknown, write: string) => unknown;

const WRITES = ["set", "nested", "index", "length", "delete", "add", "proto", "define"];

test("in sloppy code a write into a deep-frozen value is lost without a throw; that is why the page uses deepLock", () => {
  const frozen = deepFreeze({ id: "a", list: [{ text: "t" }] });
  assert.throws(() => sloppy(frozen, "define"), TypeError);
  assert.equal(sloppy(frozen, "set"), "a");
  assert.equal(sloppy(frozen, "length"), 1);
  assert.equal(sloppy(frozen, "delete"), "a");
});

test("deepLock makes every kind of write throw a TypeError, even in sloppy code, at any depth", () => {
  const locked = deepLock({ id: "a", list: [{ text: "t" }] });
  for (const write of WRITES) assert.throws(() => sloppy(locked, write), TypeError, write);
  assert.deepEqual(JSON.parse(JSON.stringify(locked)), { id: "a", list: [{ text: "t" }] });
});

test("deepLock's messages are the ones the drivers' end-of-suite check looks for", () => {
  const locked = deepLock({ id: "a", list: [{ text: "t" }] });
  const pattern = /Cannot assign to read only property|object is not extensible|Cannot add property|Cannot delete property|Cannot define property/;
  for (const write of WRITES) {
    assert.throws(() => sloppy(locked, write), (e: unknown) => e instanceof TypeError && pattern.test(e.message), write);
  }
});

test("deepLock reads like the value: same shape, arrays stay arrays, frozen, and the same object on every read", () => {
  const leaf = { text: "t", marks: { b: true as const, cmt: ["c1"] } };
  const value = { id: "a", list: [leaf, leaf], none: null, n: 3 };
  const locked = deepLock(value);
  assert.deepEqual(locked, value);
  assert.ok(Array.isArray(locked.list) && Array.isArray(locked.list[0]?.marks.cmt));
  assert.equal(locked.list[0], locked.list[1], "a shared object stays shared");
  assert.equal(locked.list, locked.list);
  assert.equal(deepLock(value), locked, "locking the same value again gives the same object");
  assert.equal(deepLock(locked), locked);
  assert.ok(Object.isFrozen(locked) && Object.isFrozen(locked.list) && Object.isFrozen(locked.list[0]?.marks));
  assert.deepEqual(locked.list.map((r) => r.text), ["t", "t"]);
  assert.deepEqual(locked.list.slice().reverse().length, 2, "a copy the caller makes is its own");
  assert.deepEqual([...locked.list[0]?.marks.cmt ?? []], ["c1"]);
});

test("deepLock locks a copy and leaves the value it was given, and anything else that holds its parts, writable", () => {
  const shared = { id: "prop", label: "Prop" };
  const value = { cat: shared, list: [1, 2] };
  const locked = deepLock(value);
  shared.label = "Props";
  value.list.push(3);
  assert.equal(Object.isFrozen(shared), false);
  assert.equal(locked.cat.label, "Prop");
  assert.deepEqual(locked.list, [1, 2]);
});

test("deepLock keeps holes and cycles, and leaves objects that are not plain as they are", () => {
  const sparse: number[] = [1];
  sparse[2] = 3;
  const holes = deepLock(sparse);
  assert.equal(holes.length, 3);
  assert.equal(1 in holes, false);
  const ring: { self?: unknown } = {};
  ring.self = ring;
  const locked = deepLock(ring);
  assert.equal(locked.self, locked);
  const when = new Date(0);
  assert.equal(deepLock({ when: when }).when, when);
  assert.equal(deepLock("text"), "text");
  assert.equal(deepLock(null), null);
});

test("noFreeze hands back the same value and freezes nothing", () => {
  const value = { list: [{ n: 1 }] };
  assert.equal(noFreeze(value), value);
  assert.equal(Object.isFrozen(value), false);
  assert.equal(Object.isFrozen(value.list[0]), false);
});
