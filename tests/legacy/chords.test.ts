import "../../src/test/_dom.mjs";
import "../../src/test/_preferences-started.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import type { ActionRegistry } from "../../src/application/actions.ts";
import { actionForKey } from "../../src/application/shortcuts.ts";
import { registerFileActions } from "../../src/legacy/file-actions.ts";
import { helpMenuActions } from "../../src/legacy/help-actions.ts";
import { helpActions, mountHelpFeature, stopHelpFeature } from "../../src/bootstrap/wiring/help.ts";
import { registerShareActions } from "../../src/legacy/share-actions.ts";
import { registerThisDocumentActions } from "../../src/legacy/this-document-actions.ts";
import { registerViewActions } from "../../src/legacy/view-actions.ts";
import { scriptZoomActions } from "../../src/bootstrap/wiring/script-zoom.ts";

function appRegistry(): { registry: ActionRegistry; dispose: () => void } {
  const registry = createActionRegistry();
  mountHelpFeature();
  const menu = helpMenuActions();
  const disposers = [
    registerThisDocumentActions(registry), registerFileActions(registry), registerViewActions(registry),
    registerAll(registry, [...menu.slice(0, 3), ...helpActions(), ...menu.slice(3)]), registerShareActions(registry), registerAll(registry, scriptZoomActions()), stopHelpFeature
  ];
  return { registry, dispose: () => { for (const d of disposers) d(); } };
}

function pressed(registry: ActionRegistry, key: string, mods: { shift?: boolean; alt?: boolean; meta?: boolean } = {}): string | null {
  const input = { key, ctrlKey: !mods.meta, metaKey: Boolean(mods.meta), shiftKey: Boolean(mods.shift), altKey: Boolean(mods.alt) };
  return actionForKey(registry.shortcuts(), input)?.id ?? null;
}

test("each action declares the chords its menu item shows", () => {
  const { registry, dispose } = appRegistry();
  try {
    const keys = (id: string): string => (registry.view(id)?.keys ?? []).join(" ");
    assert.equal(keys("save"), "mod+s");
    assert.equal(keys("save-as"), "mod+shift+s");
    assert.equal(keys("open"), "mod+o");
    assert.equal(keys("export"), "mod+e");
    assert.equal(keys("command-menu"), "mod+k");
    assert.equal(keys("find"), "mod+f mod+shift+f mod+alt+f mod+alt+shift+f");
    assert.equal(keys("toggle-hide-shot"), "mod+alt+h mod+alt+shift+h");
  } finally {
    dispose();
  }
});

test("in the browser, each key runs its own action: Ctrl+S saves and Ctrl+Shift+S saves a copy", () => {
  const { registry, dispose } = appRegistry();
  try {
    assert.equal(pressed(registry, "s"), "save");
    assert.equal(pressed(registry, "S", { shift: true }), "save-as");
    assert.equal(pressed(registry, "s", { meta: true }), "save");
    assert.equal(pressed(registry, "S", { meta: true, shift: true }), "save-as");
    assert.equal(pressed(registry, "o"), "open");
    assert.equal(pressed(registry, "O", { shift: true }), null);
    assert.equal(pressed(registry, "e"), "export");
    assert.equal(pressed(registry, "k"), "command-menu");
    assert.equal(pressed(registry, "f"), "find");
    assert.equal(pressed(registry, "F", { shift: true }), "find");
    assert.equal(pressed(registry, "h", { alt: true }), "toggle-hide-shot");
    assert.equal(pressed(registry, "s", { alt: true }), null);
  } finally {
    dispose();
  }
});
