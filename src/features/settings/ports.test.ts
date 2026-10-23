import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../../../tests/features/editing/jsdom.mjs";
import { createActionRegistry } from "../../application/actions.ts";
import { createPreferences } from "../../application/preferences/preferences.ts";
import type { PreferenceNotice } from "../../application/preferences/preferences.ts";
import { __init as mountSettings } from "./settings.js";
import type { SettingsMount, SettingsPorts } from "./ports.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
Object.assign(globalThis, { window: win, document: win.document, Event: win.Event });
win.Element.prototype.scrollIntoView = () => {};

function setup() {
  win.document.body.innerHTML = '<button id="btn-file">File</button>';
  const storage = new Map<string, string>();
  const hearing = new Set<(change: PreferenceNotice) => void>();
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
    actions: createActionRegistry(),
    notices: { show: (message, kind) => {
      calls.push(["notice", message, kind]);
      return { isConnected: false, dismiss: () => {}, removeEventListener: () => {} };
    } },
    editor: {
      writerSize: () => 22,
      setWriterSize: (value, persist) => { calls.push(["writer", value, persist]); },
      autoSave: (value) => { calls.push(["autosave", value]); },
      hideShot: (value) => { calls.push(["hide", value]); }
    },
    identity: { name: () => preferences.commentAuthor(), swatchesHtml: () => "" },
    prompter: {
      mirror: (value) => { calls.push(["mirror", value]); },
      flip: (value) => { calls.push(["flip", value]); },
      sceneMode: (value) => { calls.push(["scene", value]); }
    },
    collaboration: {
      defaultServer: "https://scripts.example.com",
      address: () => "https://scripts.example.com",
      normalize: () => null,
      view: () => ({ servedHere: false, label: "", signedIn: false, isDefault: true }),
      signOut: () => { calls.push(["signout"]); }
    },
    desktop: { running: () => false, renderNotice: () => { calls.push(["desktop"]); } }
  };
  const mounted: SettingsMount = mountSettings(ports);
  return { mounted, ports, preferences, calls, hearing };
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
    change("settings-collab-server", "invalid");
    assert.equal(h.calls.at(-1)?.[0], "notice");
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
