import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../src/application/actions.ts";
import type { ActionRegistry, ActionSource } from "../../src/application/actions.ts";
import { S } from "../../src/js/_state.js";
import { registerFileActions } from "../../src/legacy/file-actions.ts";
import { registerThisDocumentActions } from "../../src/legacy/this-document-actions.ts";
import { registerViewActions } from "../../src/legacy/view-actions.ts";

function loadingRegistry(): { registry: ActionRegistry; restore: () => void } {
  const registry = createActionRegistry();
  const disposers = [registerFileActions(registry), registerThisDocumentActions(registry), registerViewActions(registry)];
  const was: unknown = S.state;
  Object.assign(S, { state: null });
  return {
    registry,
    restore: () => {
      Object.assign(S, { state: was });
      for (const dispose of disposers) dispose();
    }
  };
}

function refusal(registry: ActionRegistry, id: string, source: ActionSource): string | null {
  const view = registry.view(id, source);
  assert.ok(view, `${id} is registered`);
  return view.enabled ? null : view.reason;
}

test("while loading, Save from its buttons and the desktop menu runs, and only Ctrl+S waits, as in 3.1", () => {
  const { registry, restore } = loadingRegistry();
  try {
    assert.equal(refusal(registry, "save", "button"), null);
    assert.equal(refusal(registry, "save", "native-menu"), null);
    assert.equal(refusal(registry, "save", "shortcut"), "Still loading…");
    assert.equal(refusal(registry, "save-as", "native-menu"), "Still loading…");
    assert.equal(refusal(registry, "open", "menu"), "Still loading…");
  } finally {
    restore();
  }
});

test("while loading, the rundown's own button still toggles and the File menu's switch waits, as in 3.1", () => {
  const { registry, restore } = loadingRegistry();
  try {
    assert.equal(refusal(registry, "toggle-rundown-min", "button"), null);
    assert.equal(refusal(registry, "toggle-rundown-min", "menu"), "Still loading…");
    assert.equal(refusal(registry, "toggle-rundown-min", "native-menu"), "Still loading…");
  } finally {
    restore();
  }
});

test("while loading, each panel button answers as its own 3.1 handler did", () => {
  const { registry, restore } = loadingRegistry();
  try {
    assert.equal(refusal(registry, "panel-production", "button"), "Still loading...");
    assert.equal(refusal(registry, "panel-gear", "button"), "Still loading...");
    assert.equal(refusal(registry, "panel-comments", "button"), "Still loading…");
    assert.equal(refusal(registry, "panel-broll", "button"), null);
    assert.equal(refusal(registry, "present", "button"), "Still loading…");
    assert.equal(refusal(registry, "write", "button"), "Still loading…");
  } finally {
    restore();
  }
});
