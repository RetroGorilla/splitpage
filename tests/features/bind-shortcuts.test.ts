import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../src/application/actions.ts";
import type { InvokeOutcome } from "../../src/application/actions.ts";
import { bindShortcuts } from "../../src/features/shortcuts/bind-shortcuts.ts";

interface KeyInit { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean }

function keydown(init: KeyInit): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...init });
  return event;
}

function setup(enabled = () => true) {
  const registry = createActionRegistry();
  const runs: string[] = [];
  registry.register({
    id: "hide", label: "Hide", group: "G", keys: ["mod+alt+h"],
    availability: () => (enabled() ? { enabled: true } : { enabled: false, reason: "Still loading…" }),
    run: (source) => { runs.push(source); }
  });
  return { registry, runs, target: new EventTarget() };
}

test("a bound shortcut runs its action and claims the key", () => {
  const { registry, runs, target } = setup();
  bindShortcuts(target, registry);
  const event = keydown({ key: "h", ctrlKey: true, altKey: true });
  target.dispatchEvent(event);
  assert.deepEqual(runs, ["shortcut"]);
  assert.equal(event.defaultPrevented, true);
});

test("an unavailable action leaves the key to the browser", () => {
  const { registry, runs, target } = setup(() => false);
  const outcomes: InvokeOutcome[] = [];
  bindShortcuts(target, registry, { onOutcome: (o) => outcomes.push(o) });
  const event = keydown({ key: "h", ctrlKey: true, altKey: true });
  target.dispatchEvent(event);
  assert.deepEqual(runs, []);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(outcomes, [{ kind: "unavailable", id: "hide", reason: "Still loading…" }]);
});

test("keys no action declares are ignored", () => {
  const { registry, runs, target } = setup();
  bindShortcuts(target, registry);
  const event = keydown({ key: "h", ctrlKey: true });
  target.dispatchEvent(event);
  assert.deepEqual(runs, []);
  assert.equal(event.defaultPrevented, false);
});

test("disposing removes the listener, and a remount does not double the handler", () => {
  const { registry, runs, target } = setup();
  const dispose = bindShortcuts(target, registry);
  dispose();
  target.dispatchEvent(keydown({ key: "h", ctrlKey: true, altKey: true }));
  assert.deepEqual(runs, []);
  const again = bindShortcuts(target, registry);
  target.dispatchEvent(keydown({ key: "h", ctrlKey: true, altKey: true }));
  assert.deepEqual(runs, ["shortcut"]);
  again();
});

test("an action registered after binding is found, and one unregistered is not", () => {
  const { registry, runs, target } = setup();
  bindShortcuts(target, registry);
  const off = registry.register({ id: "find", label: "Find", group: "G", keys: ["mod+f"], run: () => { runs.push("find"); } });
  target.dispatchEvent(keydown({ key: "f", metaKey: true }));
  off();
  target.dispatchEvent(keydown({ key: "f", metaKey: true }));
  assert.deepEqual(runs, ["find"]);
});

test("a key a focused control already handled is left alone", () => {
  const { registry, runs, target } = setup();
  target.addEventListener("keydown", (e) => { e.preventDefault(); });
  bindShortcuts(target, registry);
  target.dispatchEvent(keydown({ key: "h", ctrlKey: true, altKey: true }));
  assert.deepEqual(runs, []);
});

test("a keydown without a key, as autofill sends, passes through untouched", () => {
  const { registry, runs, target } = setup();
  bindShortcuts(target, registry);
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { ctrlKey: true, metaKey: false, shiftKey: false, altKey: true, isComposing: false });
  target.dispatchEvent(event);
  assert.deepEqual(runs, []);
  assert.equal(event.defaultPrevented, false);
});

test("an action that throws still keeps its key from the browser", () => {
  const registry = createActionRegistry();
  registry.register({ id: "hide", label: "Hide", group: "G", keys: ["mod+alt+h"], run: () => { throw new Error("broken"); } });
  const target = new EventTarget();
  const outcomes: string[] = [];
  bindShortcuts(target, registry, { onOutcome: (o) => outcomes.push(o.kind) });
  const event = keydown({ key: "h", ctrlKey: true, altKey: true });
  target.dispatchEvent(event);
  assert.deepEqual(outcomes, ["failed"]);
  assert.equal(event.defaultPrevented, true);
});

test("plain typing never asks the registry for its shortcuts, and a held modifier asks once", () => {
  const registry = createActionRegistry();
  let asked = 0;
  const runs: string[] = [];
  registry.register({ id: "hide", label: "Hide", group: "G", keys: () => { asked++; return ["mod+alt+h"]; }, run: () => { runs.push("hide"); } });
  registry.register({ id: "help", label: "Help", group: "G", keys: ["F1"], run: () => { runs.push("help"); } });
  const target = new EventTarget();
  bindShortcuts(target, registry);
  asked = 0;
  for (const key of ["h", "H", " ", "Enter", "Backspace", "ArrowDown"]) target.dispatchEvent(keydown({ key, shiftKey: key === "H" }));
  assert.equal(asked, 0);
  assert.deepEqual(runs, []);
  target.dispatchEvent(keydown({ key: "h", ctrlKey: true, altKey: true }));
  assert.equal(asked, 1);
  target.dispatchEvent(keydown({ key: "F1" }));
  assert.equal(asked, 2);
  target.dispatchEvent(keydown({ key: "x", altKey: true }));
  assert.equal(asked, 3);
  assert.deepEqual(runs, ["hide", "help"]);
});

test("a claimed key is kept from the browser even when its action is refused", () => {
  const registry = createActionRegistry();
  registry.register({ id: "save", label: "Save", group: "G", keys: ["mod+s"], claimKeys: true, availability: () => ({ enabled: false, reason: "Still loading…" }), run: () => {} });
  const target = new EventTarget();
  bindShortcuts(target, registry);
  const event = keydown({ key: "s", ctrlKey: true });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
});
