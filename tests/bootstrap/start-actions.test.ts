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

test("while started, a refusal is shown as a toast from every surface but a shortcut, and not once stopped", () => {
  const host = document.createElement("div");
  host.id = "toast-host";
  document.body.appendChild(host);
  const registry = createActionRegistry();
  registry.register({ id: "test-refused", label: "Refused", group: "G", availability: () => ({ enabled: false, reason: "Close the open dialog first" }), run: () => {} });
  const toasts = (): string[] => Array.prototype.map.call(host.querySelectorAll(".toast"), (t: Element) => t.textContent ?? "") as string[];
  try {
    const stop = startActions(registry, new CountingTarget());
    registry.invoke("test-refused", "button");
    registry.invoke("test-refused", "native-menu");
    registry.invoke("test-refused", "shortcut");
    assert.deepEqual(toasts(), ["Close the open dialog first.", "Close the open dialog first."]);
    stop();
    registry.invoke("test-refused", "button");
    assert.equal(toasts().length, 2);
  } finally {
    stopActions();
    host.remove();
  }
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
