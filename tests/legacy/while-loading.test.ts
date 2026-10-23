import "../../src/test/_dom.mjs";
import "../../src/test/_preferences-started.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import type { ActionRegistry, ActionSource } from "../../src/application/actions.ts";
import { currentDocument } from "../../src/legacy/session-bridge.ts";
import { loadTestDocument } from "../../src/test/_document.mjs";
import { registerFileActions } from "../../src/legacy/file-actions.ts";
import { thisDocumentActions } from "../../src/legacy/this-document-actions.ts";
import { hideShotActions } from "../../src/bootstrap/wiring/hide-shot.ts";
import { mountRundownFeature, rundownMinimizeActions, stopRundownFeature } from "../../src/bootstrap/wiring/rundown.ts";
import { registerViewActions } from "../../src/legacy/view-actions.ts";

function loadingRegistry(): { registry: ActionRegistry; restore: () => void } {
  const registry = createActionRegistry();
  mountRundownFeature();
  const disposers = [stopRundownFeature, registerFileActions(registry), registerAll(registry, [...hideShotActions(), ...rundownMinimizeActions(), ...thisDocumentActions()]), registerViewActions(registry)];
  const was: unknown = currentDocument();
  loadTestDocument(null);
  return {
    registry,
    restore: () => {
      loadTestDocument(was);
      for (const dispose of disposers) dispose();
    }
  };
}

const STILL_LOADING = "Still loading…";

function refusal(registry: ActionRegistry, id: string, source: ActionSource): string | null {
  const view = registry.view(id, source);
  assert.ok(view, `${id} is registered`);
  return view.enabled ? null : view.reason;
}

test("while loading, Save is refused from every surface with the File menu's wording", () => {
  const { registry, restore } = loadingRegistry();
  try {
    assert.equal(refusal(registry, "save", "button"), STILL_LOADING);
    assert.equal(refusal(registry, "save", "native-menu"), STILL_LOADING);
    assert.equal(refusal(registry, "save", "shortcut"), STILL_LOADING);
    assert.equal(refusal(registry, "save-as", "native-menu"), STILL_LOADING);
    assert.equal(refusal(registry, "open", "menu"), STILL_LOADING);
  } finally {
    restore();
  }
});

test("while loading, Save from its button and the native menu is refused rather than run", () => {
  const { registry, restore } = loadingRegistry();
  try {
    for (const source of ["button", "native-menu", "shortcut"] as const) {
      assert.deepEqual(registry.invoke("save", source), { kind: "unavailable", id: "save", reason: STILL_LOADING });
    }
  } finally {
    restore();
  }
});

test("while loading, the rundown's own button still toggles and the File menu's switch waits, as in 3.1", () => {
  const { registry, restore } = loadingRegistry();
  try {
    assert.equal(refusal(registry, "toggle-rundown-min", "button"), null);
    assert.equal(refusal(registry, "toggle-rundown-min", "menu"), STILL_LOADING);
    assert.equal(refusal(registry, "toggle-rundown-min", "native-menu"), STILL_LOADING);
  } finally {
    restore();
  }
});

test("while loading, each panel button that waits refuses with the one wording and the B-roll button does not wait", () => {
  const { registry, restore } = loadingRegistry();
  try {
    assert.equal(refusal(registry, "panel-production", "button"), STILL_LOADING);
    assert.equal(refusal(registry, "panel-gear", "button"), STILL_LOADING);
    assert.equal(refusal(registry, "panel-comments", "button"), STILL_LOADING);
    assert.equal(refusal(registry, "panel-broll", "button"), null);
    assert.equal(refusal(registry, "present", "button"), STILL_LOADING);
    assert.equal(refusal(registry, "write", "button"), STILL_LOADING);
  } finally {
    restore();
  }
});
