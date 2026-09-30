import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../src/application/actions.ts";
import type { ActionSource } from "../../src/application/actions.ts";

test("an action runs from any source and learns which one", () => {
  const registry = createActionRegistry();
  const sources: ActionSource[] = [];
  registry.register({ id: "a", label: "A", group: "G", run: (s) => { sources.push(s); } });
  assert.deepEqual(registry.invoke("a", "menu"), { kind: "ran", id: "a" });
  assert.deepEqual(registry.invoke("a", "shortcut"), { kind: "ran", id: "a" });
  assert.deepEqual(sources, ["menu", "shortcut"]);
});

test("an unavailable action does not run and gives its reason", () => {
  const registry = createActionRegistry();
  let ran = 0;
  let enabled = false;
  registry.register({ id: "a", label: "A", group: "G", availability: () => ({ enabled, reason: "Still loading…" }), run: () => { ran++; } });
  assert.deepEqual(registry.invoke("a", "command-menu"), { kind: "unavailable", id: "a", reason: "Still loading…" });
  assert.equal(ran, 0);
  enabled = true;
  assert.equal(registry.invoke("a", "command-menu").kind, "ran");
  assert.equal(ran, 1);
});

test("a hidden action is unavailable even when enabled", () => {
  const registry = createActionRegistry();
  registry.register({ id: "a", label: "A", group: "G", availability: () => ({ enabled: true, visible: false }), run: () => {} });
  assert.equal(registry.invoke("a", "menu").kind, "unavailable");
  assert.equal(registry.view("a")?.enabled, false);
});

test("an unknown action is reported as unknown", () => {
  assert.deepEqual(createActionRegistry().invoke("nope", "menu"), { kind: "unknown", id: "nope" });
});

test("a throwing action reaches the reporting boundary and fails", () => {
  const reported: unknown[] = [];
  const registry = createActionRegistry({ report: (error, id) => { reported.push([id, (error as Error).message]); } });
  registry.register({ id: "a", label: "A", group: "G", run: () => { throw new Error("boom"); } });
  const outcome = registry.invoke("a", "button");
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(reported, [["a", "boom"]]);
});

test("the view carries label, keys, checked state and reason", () => {
  const registry = createActionRegistry();
  registry.register({
    id: "hide", label: "Hide shot scenes", group: "This document", icon: "i-eye-off", keys: ["mod+alt+h"], words: "collapse",
    availability: () => ({ enabled: false, reason: "Still loading…", checked: true }), run: () => {}
  });
  assert.deepEqual(registry.view("hide"), {
    id: "hide", label: "Hide shot scenes", group: "This document", icon: "i-eye-off", keys: ["mod+alt+h"], words: "collapse",
    enabled: false, visible: true, reason: "Still loading…", checked: true
  });
  assert.equal(registry.view("missing"), undefined);
});

test("an id cannot be registered twice", () => {
  const registry = createActionRegistry();
  registry.register({ id: "a", label: "A", group: "G", run: () => {} });
  assert.throws(() => registry.register({ id: "a", label: "A2", group: "G", run: () => {} }), /already registered/);
});

test("unregistering removes the action, and a stale disposer does not remove its replacement", () => {
  const registry = createActionRegistry();
  const first = registry.register({ id: "a", label: "A", group: "G", run: () => {} });
  first();
  assert.equal(registry.has("a"), false);
  registry.register({ id: "a", label: "A again", group: "G", run: () => {} });
  first();
  assert.equal(registry.view("a")?.label, "A again");
});

test("list returns every registered action in registration order", () => {
  const registry = createActionRegistry();
  registry.register({ id: "b", label: "B", group: "G", run: () => {} });
  registry.register({ id: "a", label: "A", group: "G", run: () => {} });
  assert.deepEqual(registry.list().map((v) => v.id), ["b", "a"]);
});
