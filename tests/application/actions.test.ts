import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
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

test("a hidden action is not listed but still runs from a surface that has it", () => {
  const registry = createActionRegistry();
  let ran = 0;
  registry.register({ id: "a", label: "A", group: "G", availability: () => ({ enabled: true, visible: false }), run: () => { ran++; } });
  assert.equal(registry.view("a")?.visible, false);
  assert.equal(registry.view("a")?.enabled, true);
  assert.equal(registry.invoke("a", "native-menu").kind, "ran");
  assert.equal(ran, 1);
});

test("availability can depend on the surface that asks, and a view is the command menu's reading", () => {
  const registry = createActionRegistry();
  const asked: ActionSource[] = [];
  let ran = 0;
  registry.register({
    id: "save", label: "Save", group: "G",
    availability: (source) => {
      asked.push(source);
      return source === "shortcut" ? { enabled: false, reason: "Still loading…" } : { enabled: true };
    },
    run: () => { ran++; }
  });
  assert.deepEqual(registry.invoke("save", "shortcut"), { kind: "unavailable", id: "save", reason: "Still loading…" });
  assert.equal(registry.invoke("save", "button").kind, "ran");
  assert.equal(registry.view("save")?.enabled, true);
  assert.equal(registry.view("save", "shortcut")?.enabled, false);
  assert.equal(registry.list()[0]?.enabled, true);
  assert.equal(registry.list("shortcut")[0]?.reason, "Still loading…");
  assert.deepEqual(asked, ["shortcut", "button", "command-menu", "shortcut", "command-menu", "shortcut"]);
  assert.equal(ran, 1);
});

test("a refusal goes to the presenter the composition supplies, with the surface that asked", () => {
  const registry = createActionRegistry();
  let enabled = false;
  registry.register({ id: "save", label: "Save", group: "G", availability: () => (enabled ? { enabled: true } : { enabled: false, reason: "Close the open dialog first" }), run: () => {} });
  assert.equal(registry.invoke("save", "button").kind, "unavailable");
  const shown: string[] = [];
  const stop = registry.presentRefusals((refusal, source) => { shown.push(`${refusal.id}:${refusal.reason}:${source}`); });
  assert.equal(registry.invoke("save", "menu").kind, "unavailable");
  assert.equal(registry.invoke("save", "shortcut").kind, "unavailable");
  registry.view("save");
  registry.list();
  enabled = true;
  assert.equal(registry.invoke("save", "menu").kind, "ran");
  assert.equal(registry.invoke("missing", "menu").kind, "unknown");
  enabled = false;
  stop();
  registry.invoke("save", "menu");
  assert.deepEqual(shown, ["save:Close the open dialog first:menu", "save:Close the open dialog first:shortcut"]);
});

test("a newer presenter replaces the one before, and a stale disposer leaves it in place", () => {
  const registry = createActionRegistry();
  registry.register({ id: "open", label: "Open", group: "G", availability: () => ({ enabled: false, reason: "Still loading…" }), run: () => {} });
  const first: string[] = [];
  const second: string[] = [];
  const stopFirst = registry.presentRefusals((r) => { first.push(r.reason); });
  const stopSecond = registry.presentRefusals((r) => { second.push(r.reason); });
  stopFirst();
  registry.invoke("open", "button");
  stopSecond();
  registry.invoke("open", "button");
  assert.deepEqual(first, []);
  assert.deepEqual(second, ["Still loading…"]);
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

test("an action whose promise rejects reaches the reporting boundary", async () => {
  const reported: unknown[] = [];
  const registry = createActionRegistry({ report: (error, id) => { reported.push([id, (error as Error).message]); } });
  registry.register({ id: "save", label: "Save", group: "G", run: () => Promise.reject(new Error("disk full")) });
  assert.deepEqual(registry.invoke("save", "shortcut"), { kind: "ran", id: "save" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reported, [["save", "disk full"]]);
});

test("an action whose promise resolves reports nothing", async () => {
  const reported: unknown[] = [];
  const registry = createActionRegistry({ report: (error) => { reported.push(error); } });
  let finished = false;
  registry.register({ id: "open", label: "Open", group: "G", run: async () => { await Promise.resolve(); finished = true; } });
  assert.equal(registry.invoke("open", "menu").kind, "ran");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, true);
  assert.deepEqual(reported, []);
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

test("shortcuts lists only actions that declare keys, without asking their availability", () => {
  const registry = createActionRegistry();
  let asked = 0;
  registry.register({ id: "a", label: "A", group: "G", keys: ["mod+a"], availability: () => { asked++; return { enabled: true }; }, run: () => {} });
  registry.register({ id: "b", label: "B", group: "G", run: () => {} });
  assert.deepEqual(registry.shortcuts(), [{ id: "a", keys: ["mod+a"], claim: false }]);
  assert.equal(asked, 0);
});

test("keys another owner binds are not offered for binding, and claimed keys say so", () => {
  const registry = createActionRegistry();
  registry.register({ id: "save", label: "Save", group: "G", keys: ["mod+s"], claimKeys: true, run: () => {} });
  let desktop = true;
  registry.register({ id: "open", label: "Open", group: "G", keys: ["mod+o"], bindKeys: () => !desktop, run: () => {} });
  assert.deepEqual(registry.shortcuts(), [{ id: "save", keys: ["mod+s"], claim: true }]);
  assert.deepEqual(registry.view("open")?.keys, ["mod+o"]);
  desktop = false;
  assert.deepEqual(registry.shortcuts().map((s) => s.id), ["save", "open"]);
});

test("keys can depend on where the app runs, read each time", () => {
  const registry = createActionRegistry();
  let desktop = false;
  registry.register({ id: "help", label: "Help", group: "G", keys: () => (desktop ? ["F1"] : []), run: () => {} });
  assert.deepEqual(registry.view("help")?.keys, []);
  assert.deepEqual(registry.shortcuts(), []);
  desktop = true;
  assert.deepEqual(registry.view("help")?.keys, ["F1"]);
  assert.deepEqual(registry.shortcuts(), [{ id: "help", keys: ["F1"], claim: false }]);
});

test("a label can follow the app's state, read each time", () => {
  const registry = createActionRegistry();
  let host = "";
  registry.register({ id: "servers", label: () => (host ? `Servers… (${host})` : "Servers…"), group: "G", run: () => {} });
  assert.equal(registry.view("servers")?.label, "Servers…");
  host = "studio";
  assert.equal(registry.view("servers")?.label, "Servers… (studio)");
});

test("a group of actions registers whole or not at all", () => {
  const registry = createActionRegistry();
  registry.register({ id: "taken", label: "Taken", group: "G", keys: ["mod+t"], run: () => {} });
  const group = (last: string, keys: string[]) => [
    { id: "a", label: "A", group: "G", keys: ["mod+a"], run: () => {} },
    { id: "b", label: "B", group: "G", run: () => {} },
    { id: last, label: "C", group: "G", keys, run: () => {} }
  ];
  assert.throws(() => registerAll(registry, group("taken", [])), /taken is already registered/);
  assert.deepEqual(registry.list().map((v) => v.id), ["taken"]);
  assert.throws(() => registerAll(registry, group("c", ["mod+T"])), /mod\+t is already bound to taken/);
  assert.deepEqual(registry.list().map((v) => v.id), ["taken"]);
  assert.deepEqual(registry.shortcuts().map((k) => k.id), ["taken"]);
  const off = registerAll(registry, group("c", ["mod+c"]));
  assert.deepEqual(registry.list().map((v) => v.id), ["taken", "a", "b", "c"]);
  off();
  assert.deepEqual(registry.list().map((v) => v.id), ["taken"]);
});
