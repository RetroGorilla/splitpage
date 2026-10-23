import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../../src/adapters/desktop/desktop-port.ts";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import type { ExternalLinks } from "../../src/application/desktop-presence.ts";
import type { PreferenceNotice } from "../../src/application/preferences/preferences.ts";
import { sharedPorts } from "../../src/bootstrap/wiring/shared-ports.ts";
import { mountScriptZoomFeature, scriptZoomActions, stopScriptZoomFeature } from "../../src/bootstrap/wiring/script-zoom.ts";
import { installAppActions } from "../../src/legacy/app-actions.ts";
import { PREF_EVENT, preferences, startPreferences, viewFlags } from "../../src/legacy/preferences-bridge.ts";
import type { SaveChange } from "../../src/application/save/save-state.ts";
import { autoSavePolicy, haltAutoSave, noteSaveChange, saveDestinations, startSaves } from "../../src/legacy/save-bridge.ts";
import type { LegacySavePorts } from "../../src/legacy/save-bridge.ts";
import { cacheSeal } from "../../src/legacy/cache-freeze.ts";
import { productionReaders } from "../../src/legacy/document-ports.ts";
import { productionIndex, startProductionIndex } from "../../src/legacy/production-index-bridge.ts";
import { migrateRows } from "../../src/js/02-state.js";

test("external links check the current desktop capability and forward each address to the current bridge", () => {
  const externalLinks: ExternalLinks = sharedPorts().externalLinks;
  const opened: string[][] = [];
  const url = "https://splitpage.test/releases?version=4.2#download";
  try {
    useDesktopForTest(null);
    assert.equal(externalLinks.available(), false);
    externalLinks.open(url);
    useDesktopForTest({});
    assert.equal(externalLinks.available(), false);
    externalLinks.open(url);
    assert.deepEqual(opened as unknown, []);
    useDesktopForTest({ openExternal: (address) => { opened.push(["first", address]); } });
    assert.equal(externalLinks.available(), true);
    externalLinks.open(url);
    useDesktopForTest({ openExternal: (address) => { opened.push(["second", address]); } });
    assert.equal(externalLinks.available(), true);
    externalLinks.open("mailto:hello@splitpage.test");
    useDesktopForTest(null);
    assert.equal(externalLinks.available(), false);
    externalLinks.open(url);
    assert.deepEqual(opened, [["first", url], ["second", "mailto:hello@splitpage.test"]]);
    const error = new Error("the desktop could not open the address");
    useDesktopForTest({ openExternal: () => { throw error; } });
    assert.throws(() => externalLinks.open(url), error);
  } finally {
    restoreDesktop();
  }
});

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
  const inputs: unknown[] = [];
  first.register({ id: "probe", label: "First", group: "Test", run: (_source, input) => { ran++; inputs.push(input); } });
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
    assert.equal(shared.actions.invoke("probe", "button", { at: 3 }).kind, "ran");
    assert.deepEqual(inputs, [undefined, { at: 3 }]);
    assert.equal(ran, 2);
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
    assert.equal(ran, 12);
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

function savePorts(): LegacySavePorts {
  return {
    destination: () => "here",
    keyOf: (identity) => ({ owner: identity, name: "" }),
    obsolete: () => {},
    ownership: { capture: () => ({ epoch: 1, docId: null, destination: "here", destinationGeneration: 0, generation: 0, connection: null, revision: null }), stillOwns: () => true },
    autosave: { enabledAtStart: () => true, changed: () => {} }
  };
}

test("the save state port follows the running save owner: unsaved, busy, its changes, an autosave now and resuming autosave", async () => {
  const saves = sharedPorts().saves;
  const timers = { start: () => null, stop: () => {} };
  assert.equal(saves.unsaved(), false);
  assert.equal(saves.busy(), false);
  assert.throws(() => { saves.dueNow(); }, /The save coordinator is not started yet/);
  assert.throws(() => { saves.resume(); }, /The save coordinator is not started yet/);
  const heard: SaveChange[] = [];
  const off = saves.onChange((change) => { heard.push(change); });
  let stop = startSaves(savePorts(), timers);
  try {
    const written: string[] = [];
    saveDestinations().register({ id: "probe", takes: () => true, autoSaveTarget: () => "file", write: async (job) => { written.push(job.request.kind); return { kind: "saved" }; } });
    noteSaveChange();
    assert.equal(saves.unsaved(), true);
    assert.deepEqual(heard, ["change"]);
    haltAutoSave("stopped for the test");
    assert.equal(autoSavePolicy().halted(), "stopped for the test");
    saves.resume();
    assert.equal(autoSavePolicy().halted(), "");
    saves.dueNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(written, ["autosave"]);
    assert.equal(saves.busy(), false);
    stop();
    stop = startSaves(savePorts(), timers);
    assert.equal(saves.unsaved(), false, "the port reads the save owner running now");
    noteSaveChange();
    assert.equal(saves.unsaved(), true);
    off();
    noteSaveChange();
    assert.equal(heard.filter((change) => change === "change").length, 2);
  } finally {
    off();
    stop();
  }
});

test("the production index port forwards each call to the running production index and follows a restart", () => {
  const production = sharedPorts().production;
  assert.throws(() => production.entries(null), /The production index is not started yet/);
  const doc = migrateRows({ schema: 2, title: "T", comments: [], rows: [{ id: "r1", audioText: 'Put the <span class="tag-anchor" data-tag-cat="prop" data-tag-name="kettle" contenteditable="false">kettle</span> on.' }] });
  let stop = startProductionIndex(productionReaders, cacheSeal);
  try {
    assert.deepEqual(production.entries(doc).map((e) => e.key), ["prop kettle"]);
    assert.equal(production.current(doc), productionIndex().current(doc));
    assert.equal(production.derived(), 1);
    assert.equal(JSON.stringify(production.recordsPlan(doc, doc)), JSON.stringify(productionIndex().recordsPlan(doc, doc)));
    production.resetDerived();
    assert.equal(productionIndex().derived(), 0);
    production.entries(doc);
    assert.equal(production.derived(), 0, "an unchanged document is not derived again");
    const first = productionIndex();
    stop();
    stop = startProductionIndex(productionReaders, cacheSeal);
    assert.notEqual(productionIndex(), first);
    production.entries(doc);
    assert.equal(production.derived(), productionIndex().derived(), "the port reads the production index running now");
    production.resetDerived();
    assert.equal(productionIndex().derived(), 0);
  } finally {
    stop();
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
