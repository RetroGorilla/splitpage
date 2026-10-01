import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../../src/application/actions.ts";
import { mountShortcuts } from "../../../src/features/shortcuts/mount.ts";

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

function keydown(key: string, mods: { ctrlKey?: boolean; altKey?: boolean } = {}): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...mods });
  return event;
}

test("mount, dispose and mount again leave one listener, and each key runs its action once", () => {
  const registry = createActionRegistry();
  const runs: string[] = [];
  registry.register({ id: "hide", label: "Hide", group: "G", keys: ["mod+alt+h"], run: (s) => { runs.push(`hide:${s}`); } });
  registry.register({ id: "find", label: "Find", group: "G", keys: ["mod+f"], run: (s) => { runs.push(`find:${s}`); } });
  const target = new CountingTarget();

  const first = mountShortcuts({ target, registry });
  assert.equal(target.listeners, 1);
  first();
  assert.equal(target.listeners, 0);
  target.dispatchEvent(keydown("h", { ctrlKey: true, altKey: true }));
  assert.deepEqual(runs, []);

  const second = mountShortcuts({ target, registry });
  assert.equal(target.listeners, 1);
  target.dispatchEvent(keydown("h", { ctrlKey: true, altKey: true }));
  target.dispatchEvent(keydown("f", { ctrlKey: true }));
  assert.deepEqual(runs, ["hide:shortcut", "find:shortcut"]);

  second();
  second();
  assert.equal(target.listeners, 0);
  first();
  assert.equal(target.listeners, 0);
});

test("a mount hands each outcome to its owner", () => {
  const registry = createActionRegistry();
  registry.register({ id: "save", label: "Save", group: "G", keys: ["mod+s"], availability: () => ({ enabled: false, reason: "Still loading…" }), run: () => {} });
  const target = new CountingTarget();
  const outcomes: string[] = [];
  const dispose = mountShortcuts({ target, registry, onOutcome: (o) => { outcomes.push(o.kind); } });
  target.dispatchEvent(keydown("s", { ctrlKey: true }));
  dispose();
  target.dispatchEvent(keydown("s", { ctrlKey: true }));
  assert.deepEqual(outcomes, ["unavailable"]);
});
