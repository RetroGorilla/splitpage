import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../../../tests/features/editing/jsdom.mjs";
import { createActionRegistry } from "../../application/actions.ts";
import { createPreferences } from "../../application/preferences/preferences.ts";
import type { PreferenceName, PreferenceNotice } from "../../application/preferences/preferences.ts";
import { startSettings as mountSettings } from "./settings.ts";
import type { SettingsMount, SettingsPorts } from "./ports.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
Object.assign(globalThis, { window: win, document: win.document, Event: win.Event });
win.Element.prototype.scrollIntoView = () => {};

function setup(microphones: SettingsPorts["microphones"] = { support: () => "browser", list: async () => ({ options: [], named: false }), onChange: () => () => {} }) {
  win.document.body.innerHTML = '<button id="btn-file">File</button>';
  const storage = new Map<string, string>();
  const hearing = new Set<(change: PreferenceNotice) => void>();
  const stored = new Set<(name: PreferenceName | null) => void>();
  let writerSize = 22;
  const preferences = createPreferences({
    storage: () => ({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: (key) => { storage.delete(key); } }),
    announce: (change) => {
      const name = preferences.nameOf(change.key);
      if (name) for (const listener of hearing) listener({ name, value: change.value, elsewhere: false });
    }
  });
  const calls: unknown[][] = [];
  const ports: SettingsPorts = {
    preferences,
    changes: { onChange: (listener) => { hearing.add(listener); return () => { hearing.delete(listener); }; } },
    elsewhere: (listener) => { stored.add(listener); return () => { stored.delete(listener); }; },
    microphones,
    actions: createActionRegistry(),
    notices: { show: (message, kind) => {
      calls.push(["notice", message, kind]);
      return { isConnected: false, dismiss: () => {}, removeEventListener: () => {} };
    } },
    editor: {
      writerSize: () => writerSize,
      setWriterSize: (value, persist) => { calls.push(["writer", value, persist]); },
      autoSave: (value) => { calls.push(["autosave", value]); },
      hideShot: (value) => { calls.push(["hide", value]); }
    },
    identity: { name: () => preferences.commentAuthor(), swatchesHtml: () => "" },
    prompter: {
      mirror: (value) => { calls.push(["mirror", value]); },
      flip: (value) => { calls.push(["flip", value]); },
      beatMode: (value) => { calls.push(["scene", value]); }
    },
    desktop: { running: () => false, renderNotice: () => { calls.push(["desktop"]); } }
  };
  const mounted: SettingsMount = mountSettings(ports);
  return { mounted, ports, preferences, calls, hearing, stored, storeWriterSize: (size: number) => { writerSize = size; } };
}

function input(id: string): HTMLInputElement {
  const element = win.document.getElementById(id);
  assert.ok(element instanceof win.HTMLInputElement);
  return element;
}

function change(id: string, value: string | boolean) {
  const element = input(id);
  if (typeof value === "boolean") element.checked = value;
  else element.value = value;
  element.dispatchEvent(new win.Event("change", { bubbles: true }));
}

test("settings ports preserve field edits and focus across local and external preference changes", () => {
  const h = setup();
  try {
    h.mounted.openSettings({ focus: "settings-name" });
    const name = input("settings-name");
    name.value = "Unsubmitted";
    h.preferences.setClock("24");
    assert.equal(input("settings-name").value, "Unsubmitted");
    assert.equal(win.document.activeElement?.id, "settings-name");
    h.preferences.setCommentAuthor("Saved");
    assert.equal(input("settings-name").value, "Saved");
    for (const listener of h.hearing) listener({ name: "theme", value: "dark", elsewhere: true });
    assert.equal(input("settings-name").value, "Saved");
    change("settings-default-wpm", "500");
    assert.equal(input("settings-default-wpm").value, String(h.preferences.defaultWpm()));
  } finally {
    h.mounted.dispose();
  }
});

test("settings routes controls to their existing owners and disposal permits a fresh mount", () => {
  const h = setup();
  h.mounted.openSettings();
  change("settings-autosave", true);
  change("settings-hide-shot", true);
  change("settings-prompter-mirror", true);
  change("settings-prompter-flip", true);
  change("settings-prompter-scene", true);
  change("settings-writer-size", "25");
  assert.deepEqual(h.calls, [["autosave", true], ["hide", true], ["mirror", true], ["flip", true], ["scene", true], ["writer", 25, true]]);
  const old = input("settings-autosave");
  h.mounted.dispose();
  assert.equal(h.hearing.size, 0);
  assert.equal(win.document.getElementById("settings-modal"), null);
  old.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.equal(h.calls.length, 6);
  const fresh: SettingsMount = mountSettings(h.ports);
  try {
    fresh.openSettings();
    change("settings-autosave", false);
    assert.deepEqual(h.calls.at(-1), ["autosave", false]);
    win.document.getElementById("settings-modal")?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(win.document.getElementById("settings-modal")?.hidden, true);
  } finally {
    fresh.dispose();
  }
});

test("settings repaints when another tab changes stored app state, a preference or not, and stops hearing it once disposed", () => {
  const h = setup();
  try {
    h.mounted.openSettings({ focus: "settings-name" });
    input("settings-name").value = "Unsubmitted";
    assert.equal(input("settings-writer-size").value, "22");
    h.storeWriterSize(25);
    for (const listener of h.stored) listener(null);
    assert.equal(input("settings-writer-size").value, "25");
    assert.equal(input("settings-name").value, "Unsubmitted");
    assert.equal(win.document.activeElement?.id, "settings-name");
    h.preferences.setCommentAuthor("Saved");
    input("settings-name").value = "Unsubmitted";
    for (const listener of h.stored) listener("commentAuthor");
    assert.equal(input("settings-name").value, "Saved");
    h.mounted.dispose();
    assert.equal(h.stored.size, 0);
  } finally {
    h.mounted.dispose();
  }
});

function select(id: string): HTMLSelectElement {
  const element = win.document.getElementById(id);
  assert.ok(element instanceof win.HTMLSelectElement);
  return element;
}

test("settings offers the microphone list where it works: names after permission, the saved one chosen, a pick saved", async () => {
  let named = false;
  const changed = new Set<() => void>();
  const h = setup({
    support: () => "yes",
    list: async () => named
      ? { options: [{ id: "dev-1", label: "Mic One" }, { id: "dev-2", label: "Mic Two" }], named: true }
      : { options: [], named: false },
    onChange: (listener) => { changed.add(listener); return () => { changed.delete(listener); }; }
  });
  try {
    h.preferences.setMicrophone("dev-2");
    h.mounted.openSettings();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Array.from(select("settings-microphone").options, (o) => [o.value, o.textContent]), [["", "System default"], ["dev-2", "Saved microphone"]]);
    assert.match(win.document.getElementById("settings-microphone-hint")?.textContent ?? "", /names appear once Follow My Voice has been allowed/i);
    named = true;
    for (const listener of changed) listener();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Array.from(select("settings-microphone").options, (o) => [o.value, o.textContent]), [["", "System default"], ["dev-1", "Mic One"], ["dev-2", "Mic Two"]]);
    assert.equal(select("settings-microphone").value, "dev-2");
    select("settings-microphone").value = "dev-1";
    select("settings-microphone").dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.equal(h.preferences.microphone(), "dev-1");
    h.preferences.setMicrophone("");
    assert.equal(select("settings-microphone").value, "", "a pick made in Present shows here");
  } finally {
    h.mounted.dispose();
  }
  assert.equal(changed.size, 0);
});

test("settings turns its note into the list once the desktop app says it can listen, even with no microphones", async () => {
  let support: "desktop" | "yes" = "desktop";
  const changed = new Set<() => void>();
  const h = setup({
    support: () => support,
    list: async () => ({ options: [], named: false }),
    onChange: (listener) => { changed.add(listener); return () => { changed.delete(listener); }; }
  });
  try {
    h.mounted.openSettings();
    assert.ok(win.document.getElementById("settings-microphone-note"));
    support = "yes";
    for (const listener of changed) listener();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(win.document.getElementById("settings-microphone-note"), null);
    assert.deepEqual(Array.from(select("settings-microphone").options, (o) => [o.value, o.textContent]), [["", "System default"]]);
  } finally {
    h.mounted.dispose();
  }
});

test("settings shows a note, not a list, where recognition cannot be aimed at a microphone", () => {
  for (const [support, note] of [["desktop", /Windows default microphone/], ["browser", /system's default microphone/]] as const) {
    const h = setup({ support: () => support, list: async () => ({ options: [], named: false }), onChange: () => () => {} });
    try {
      h.mounted.openSettings();
      assert.equal(win.document.getElementById("settings-microphone"), null, support);
      assert.match(win.document.getElementById("settings-microphone-note")?.textContent ?? "", note);
    } finally {
      h.mounted.dispose();
    }
  }
});