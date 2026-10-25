import { commandMenuActions, mountCommandMenuFeature, stopCommandMenuFeature } from "../../src/bootstrap/wiring/command-menu.ts";
import { onboardingActions, mountOnboardingFeature, stopOnboardingFeature } from "../../src/bootstrap/wiring/onboarding.ts";
import { commentsPanelActions, commentsHelpActions } from "../../src/bootstrap/wiring/comments.ts";
import "../../src/test/_dom.mjs";
import "../../src/test/_preferences-started.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import type { ActionRegistry } from "../../src/application/actions.ts";
import { actionForKey } from "../../src/application/shortcuts.ts";
import { fileActions } from "../../src/legacy/file-actions.ts";
import { helpMenuActions } from "../../src/legacy/help-actions.ts";
import { helpActions, mountHelpFeature, stopHelpFeature } from "../../src/bootstrap/wiring/help.ts";
import { updateActions } from "../../src/bootstrap/wiring/update.ts";
import { shareActions } from "../../src/legacy/share-actions.ts";
import { thisDocumentActions } from "../../src/legacy/this-document-actions.ts";
import { hideShotActions } from "../../src/bootstrap/wiring/hide-shot.ts";
import { mountRundownFeature, rundownMinimizeActions, stopRundownFeature } from "../../src/bootstrap/wiring/rundown.ts";
import { viewActions } from "../../src/legacy/view-actions.ts";
import { scriptZoomActions } from "../../src/bootstrap/wiring/script-zoom.ts";
import { findActions, mountFindFeature, stopFindFeature } from "../../src/bootstrap/wiring/find.ts";
import { fileMenuExportActions, mountFileMenuExportFeature, stopFileMenuExportFeature } from "../../src/bootstrap/wiring/file-menu-export.ts";


function appRegistry(): { registry: ActionRegistry; dispose: () => void } {
  const globals = [window, globalThis].flatMap((target) =>
    ["CSS", "Highlight"].map((name) => ({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) })));
  const css = { highlights: new Map() };
  class Highlight extends Set {}
  for (const target of [window, globalThis]) {
    Object.defineProperty(target, "CSS", { configurable: true, writable: true, value: css });
    Object.defineProperty(target, "Highlight", { configurable: true, writable: true, value: Highlight });
  }
  const registry = createActionRegistry();
  mountRundownFeature();
  mountFileMenuExportFeature();
  mountHelpFeature();
  mountOnboardingFeature();
  mountCommandMenuFeature();
  mountFindFeature();
  const menu = helpMenuActions();
  const disposers = [stopRundownFeature, stopFileMenuExportFeature, stopFindFeature,
    registerAll(registry, [...hideShotActions(), ...rundownMinimizeActions(), ...thisDocumentActions(), ...findActions()]), registerAll(registry, [...fileActions().slice(0, 3), ...fileMenuExportActions().slice(0, 1), ...commandMenuActions(), ...fileActions().slice(3)]), registerAll(registry, [...viewActions().slice(0, 3), ...commentsPanelActions(), ...viewActions().slice(3)]),
    registerAll(registry, [...menu.slice(0, 3), ...helpActions(), ...menu.slice(3, 4), ...onboardingActions(), ...updateActions(), ...commentsHelpActions(), ...menu.slice(4)]), registerAll(registry, [...shareActions().slice(0, 11), ...fileMenuExportActions().slice(1), ...shareActions().slice(11)]), registerAll(registry, scriptZoomActions()), stopHelpFeature, stopOnboardingFeature, stopCommandMenuFeature
  ];
  return { registry, dispose: () => {
    try {
      for (const d of disposers) d();
    } finally {
      for (const { target, name, descriptor } of globals) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else Reflect.deleteProperty(target, name);
      }
    }
  } };
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
