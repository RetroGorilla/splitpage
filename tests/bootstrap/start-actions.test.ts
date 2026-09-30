import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../src/application/actions.ts";
import { startActions, stopActions } from "../../src/bootstrap/actions.ts";

class CountingTarget extends EventTarget {
  listeners = 0;

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    this.listeners++;
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    this.listeners--;
    super.removeEventListener(type, listener, options);
  }
}

function probeKey(): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: "y", ctrlKey: true, metaKey: false, shiftKey: true, altKey: true, isComposing: false });
  return event;
}

test("the app's actions start, stop and start again with one key listener and nothing left behind", () => {
  const registry = createActionRegistry();
  const target = new CountingTarget();
  let probed = 0;
  registry.register({ id: "test-probe", label: "Probe", group: "G", keys: ["mod+alt+shift+y"], run: () => { probed++; } });

  try {
    const stop = startActions(registry, target);
    const started = registry.list().map((v) => v.id);
    assert.ok(started.includes("save") && started.includes("toggle-hide-shot") && started.length > 30, `registers the app's actions (${started.length})`);
    assert.equal(target.listeners, 1);
    target.dispatchEvent(probeKey());
    assert.equal(probed, 1);

    stop();
    assert.deepEqual(registry.list().map((v) => v.id), ["test-probe"]);
    assert.equal(target.listeners, 0);
    target.dispatchEvent(probeKey());
    assert.equal(probed, 1);

    startActions(registry, target);
    assert.deepEqual(registry.list().map((v) => v.id), started);
    assert.equal(target.listeners, 1);
    target.dispatchEvent(probeKey());
    assert.equal(probed, 2);
  } finally {
    stopActions();
  }
  assert.equal(target.listeners, 0);
  assert.deepEqual(registry.list().map((v) => v.id), ["test-probe"]);
});

test("starting twice without stopping is refused, so no listener or action is doubled", () => {
  const registry = createActionRegistry();
  const target = new CountingTarget();
  const stop = startActions(registry, target);
  try {
    assert.throws(() => startActions(registry, target), /already started/);
    assert.equal(target.listeners, 1);
  } finally {
    stop();
  }
  assert.equal(target.listeners, 0);
});
