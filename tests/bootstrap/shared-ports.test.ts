import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import type { PreferenceNotice } from "../../src/application/preferences/preferences.ts";
import { sharedPorts } from "../../src/bootstrap/wiring/shared-ports.ts";
import { mountScriptZoomFeature, scriptZoomActions, stopScriptZoomFeature } from "../../src/bootstrap/wiring/script-zoom.ts";
import { installAppActions } from "../../src/legacy/app-actions.ts";
import { PREF_EVENT, preferences, startPreferences, viewFlags } from "../../src/legacy/preferences-bridge.ts";

test("shared ports follow their current owners, announce synchronously in subscription order and unsubscribe", () => {
  const shared = sharedPorts();
  assert.equal(sharedPorts(), shared);
  const notices: PreferenceNotice[] = [];
  const order: string[] = [];
  const before = (): void => { order.push("before"); };
  const after = (): void => { order.push("after"); };
  const start = (): (() => void) => startPreferences({
    storage: () => localStorage,
    announce: (change) => document.dispatchEvent(new window.CustomEvent(PREF_EVENT, { detail: change }))
  });
  document.addEventListener(PREF_EVENT, before);
  const off = shared.changes.onChange((change) => { order.push("change"); notices.push(change); });
  document.addEventListener(PREF_EVENT, after);
  const first = createActionRegistry();
  let ran = 0;
  first.register({ id: "probe", label: "First", group: "Test", run: () => { ran++; } });
  let stopActions = installAppActions(first);
  let stopPreferences = start();
  try {
    preferences().setScriptScale(1.25);
    assert.deepEqual(order, ["before", "change", "after"]);
    assert.deepEqual(notices, [{ name: "scriptScale", value: "1.25", elsewhere: false }]);
    window.dispatchEvent(new window.StorageEvent("storage", { key: "splitpage-script-scale", newValue: "1.5" }));
    assert.deepEqual(notices, [
      { name: "scriptScale", value: "1.25", elsewhere: false },
      { name: "scriptScale", value: "1.5", elsewhere: true }
    ]);
    window.dispatchEvent(new window.StorageEvent("storage", { key: null }));
    window.dispatchEvent(new window.StorageEvent("storage", { key: "unrelated" }));
    document.dispatchEvent(new window.CustomEvent(PREF_EVENT, { detail: { key: "unrelated", value: "1" } }));
    assert.equal(notices.length, 2);
    assert.equal(shared.actions.view("probe")?.label, "First");
    assert.equal(shared.actions.invoke("probe", "button").kind, "ran");
    assert.equal(ran, 1);
    viewFlags().setWriterOpen(true);
    assert.equal(shared.screen().writer, true);
    stopActions();
    stopPreferences();
    const second = createActionRegistry();
    second.register({ id: "probe", label: "Second", group: "Test", run: () => { ran += 10; } });
    stopActions = installAppActions(second);
    stopPreferences = start();
    assert.equal(shared.screen().writer, false);
    assert.equal(shared.actions.view("probe")?.label, "Second");
    assert.equal(shared.actions.invoke("probe", "button").kind, "ran");
    assert.equal(ran, 11);
    preferences().clearScriptScale();
    assert.deepEqual(notices[2], { name: "scriptScale", value: null, elsewhere: false });
    off();
    off();
    preferences().setScriptScale(1.75);
    window.dispatchEvent(new window.StorageEvent("storage", { key: "splitpage-script-scale", newValue: "2" }));
    assert.equal(notices.length, 3);
  } finally {
    off();
    document.removeEventListener(PREF_EVENT, before);
    document.removeEventListener(PREF_EVENT, after);
    stopActions();
    stopPreferences();
    localStorage.clear();
  }
});

test("wired zoom actions follow remounts and refuse both a disposed owner and a stopped feature", () => {
  const stopPreferences = startPreferences();
  const registry = createActionRegistry();
  const off = registerAll(registry, scriptZoomActions());
  try {
    assert.equal(registry.view("script-zoom-in", "native-menu")?.enabled, false);
    const first = mountScriptZoomFeature();
    assert.equal(registry.view("script-zoom-in", "native-menu")?.enabled, true);
    const second = mountScriptZoomFeature();
    assert.equal(first.mounted(), false);
    assert.equal(second.mounted(), true);
    first.dispose();
    assert.equal(registry.view("script-zoom-in", "native-menu")?.enabled, true);
    second.dispose();
    assert.equal(registry.invoke("script-zoom-in", "native-menu").kind, "unavailable");
    mountScriptZoomFeature();
    assert.equal(registry.view("script-zoom-in", "native-menu")?.enabled, true);
    stopScriptZoomFeature();
    assert.equal(registry.invoke("script-zoom-reset", "shortcut").kind, "unavailable");
  } finally {
    stopScriptZoomFeature();
    off();
    stopPreferences();
  }
});
