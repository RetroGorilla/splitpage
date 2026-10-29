import test from "node:test";
import assert from "node:assert/strict";
import { addListener } from "../../../src/features/common/listeners.ts";

interface Call { readonly type: string; readonly listener: EventListener; readonly options: unknown }

function fakeTarget() {
  const added: Call[] = [];
  const removed: Call[] = [];
  const target = {
    addEventListener(type: string, listener: EventListener, options?: unknown) { added.push({ type, listener, options }); },
    removeEventListener(type: string, listener: EventListener, options?: unknown) { removed.push({ type, listener, options }); }
  };
  return { target: target as unknown as EventTarget, added, removed };
}

test("addListener adds the listener with its type and handler", () => {
  const fake = fakeTarget();
  const handler: EventListener = () => {};
  addListener(fake.target, "click", handler);
  assert.equal(fake.added.length, 1);
  assert.equal(fake.added[0]?.type, "click");
  assert.equal(fake.added[0]?.listener, handler);
  assert.equal(fake.removed.length, 0);
});

test("the returned function removes the same type and handler", () => {
  const fake = fakeTarget();
  const handler: EventListener = () => {};
  const remove = addListener(fake.target, "keydown", handler);
  remove();
  assert.equal(fake.removed.length, 1);
  assert.equal(fake.removed[0]?.type, "keydown");
  assert.equal(fake.removed[0]?.listener, handler);
});

test("options are passed to both add and remove", () => {
  const fake = fakeTarget();
  const options = { capture: true, passive: true };
  const remove = addListener(fake.target, "scroll", () => {}, options);
  remove();
  assert.equal(fake.added[0]?.options, options);
  assert.equal(fake.removed[0]?.options, options);

  const boolean = fakeTarget();
  addListener(boolean.target, "scroll", () => {}, true)();
  assert.equal(boolean.added[0]?.options, true);
  assert.equal(boolean.removed[0]?.options, true);
});

test("omitted options stay undefined on both calls", () => {
  const fake = fakeTarget();
  addListener(fake.target, "input", () => {})();
  assert.equal(fake.added[0]?.options, undefined);
  assert.equal(fake.removed[0]?.options, undefined);
});

test("removing twice is harmless on a real EventTarget", () => {
  const target = new EventTarget();
  let calls = 0;
  const remove = addListener(target, "ping", () => { calls += 1; });
  target.dispatchEvent(new Event("ping"));
  remove();
  remove();
  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 1);
});
