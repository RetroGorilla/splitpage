import test from "node:test";
import assert from "node:assert/strict";
import { createViewLifetime } from "../../../src/features/common/view-lifetime.ts";

interface Added { readonly type: string; readonly listener: EventListener; readonly options: unknown }

function fakeTarget(isConnected = true) {
  const added: Added[] = [];
  const removed: Added[] = [];
  const target = {
    isConnected,
    addEventListener(type: string, listener: EventListener, options?: unknown) { added.push({ type, listener, options }); },
    removeEventListener(type: string, listener: EventListener, options?: unknown) { removed.push({ type, listener, options }); }
  };
  return { target: target as unknown as EventTarget, raw: target, added, removed };
}

function fakeWindow() {
  const document = fakeTarget();
  const window = fakeTarget();
  (window.raw as unknown as { document: unknown }).document = document.target;
  return { window: window.target as unknown as Window, document };
}

const only = <T>(list: readonly T[], at = 0): T => {
  const item = list[at];
  assert.ok(item);
  return item;
};
const fire = (list: readonly Added[], at = 0) => only(list, at).listener({} as Event);

test("listen: registers the type and options given, defaulting to the bubble phase", () => {
  const { window } = fakeWindow();
  const life = createViewLifetime(window);
  const a = fakeTarget();
  life.listen(a.target, "click", () => {});
  life.listen(a.target, "keydown", () => {}, true);
  assert.deepEqual(a.added.map((e) => [e.type, e.options]), [["click", false], ["keydown", true]]);
});

test("listen: a null target registers nothing", () => {
  const { window } = fakeWindow();
  const life = createViewLifetime(window);
  assert.doesNotThrow(() => life.listen(null, "click", () => {}));
  life.dispose();
});

test("listen: the handler runs while the target is connected", () => {
  const { window } = fakeWindow();
  const life = createViewLifetime(window);
  const a = fakeTarget();
  let calls = 0;
  life.listen(a.target, "click", () => { calls++; });
  fire(a.added);
  assert.equal(calls, 1);
});

test("listen: a disconnected element is ignored, but window and document targets are not checked", () => {
  const { window, document } = fakeWindow();
  const life = createViewLifetime(window);
  const detached = fakeTarget(false);
  let calls = 0;
  life.listen(detached.target, "click", () => { calls++; });
  (document.raw as { isConnected: boolean }).isConnected = false;
  life.listen(document.target, "keydown", () => { calls++; });
  life.listen(window, "resize", () => { calls++; });
  fire(detached.added);
  fire(document.added);
  assert.equal(calls, 1);
});

test("dispose: removes each registration with its own type, listener and options, newest first", () => {
  const { window } = fakeWindow();
  const life = createViewLifetime(window);
  const a = fakeTarget();
  const b = fakeTarget();
  life.listen(a.target, "click", () => {});
  life.listen(b.target, "keydown", () => {}, { capture: true });
  const order: string[] = [];
  life.release(() => order.push("release"));
  a.raw.removeEventListener = (type: string) => { order.push("a:" + type); };
  b.raw.removeEventListener = (type: string) => { order.push("b:" + type); };
  life.dispose();
  assert.deepEqual(order, ["release", "b:keydown", "a:click"]);
});

test("dispose: removes the very listener that was added", () => {
  const { window } = fakeWindow();
  const life = createViewLifetime(window);
  const a = fakeTarget();
  life.listen(a.target, "click", () => {}, true);
  life.dispose();
  assert.equal(a.removed.length, 1);
  assert.equal(only(a.removed).listener, only(a.added).listener);
  assert.equal(only(a.removed).options, true);
});

test("dispose: is idempotent, marks the lifetime inactive and silences held listeners", () => {
  const { window } = fakeWindow();
  const life = createViewLifetime(window);
  const a = fakeTarget();
  let calls = 0;
  life.listen(a.target, "click", () => { calls++; });
  assert.equal(life.active(), true);
  life.dispose();
  life.dispose();
  assert.equal(life.active(), false);
  assert.equal(a.removed.length, 1);
  fire(a.added);
  assert.equal(calls, 0);
});
