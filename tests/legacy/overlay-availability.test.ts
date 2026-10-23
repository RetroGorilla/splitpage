import "../../src/test/_dom.mjs";
import "../../src/test/_preferences-started.mjs";
import "../../src/test/_location-started.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import type { ActionRegistry, ActionSource } from "../../src/application/actions.ts";
import { currentDocument } from "../../src/legacy/session-bridge.ts";
import { loadTestDocument } from "../../src/test/_document.mjs";
import { prompterIsOpen, setPrompterOpen } from "../../src/application/prompter-state.ts";
import { registerFileActions } from "../../src/legacy/file-actions.ts";
import { helpMenuActions } from "../../src/legacy/help-actions.ts";
import { helpActions, mountHelpFeature, stopHelpFeature } from "../../src/bootstrap/wiring/help.ts";
import { availableUnless, EVERY_OVERLAY, everyOverlayBut, inFront, OPENS_A_DIALOG } from "../../src/application/screen.ts";
import type { Blocker, ScreenState } from "../../src/application/screen.ts";
import { registerShareActions } from "../../src/legacy/share-actions.ts";
import { thisDocumentActions } from "../../src/legacy/this-document-actions.ts";
import { hideShotActions } from "../../src/bootstrap/wiring/hide-shot.ts";
import { mountRundownFeature, rundownMinimizeActions, stopRundownFeature } from "../../src/bootstrap/wiring/rundown.ts";
import { registerViewActions } from "../../src/legacy/view-actions.ts";
import { viewFlags } from "../../src/legacy/preferences-bridge.ts";

const NOTHING: ScreenState = {
  loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false
};

function open(...blockers: Blocker[]): ScreenState {
  const screen: Record<Blocker, boolean> = { ...NOTHING };
  for (const b of blockers) screen[b] = true;
  return screen;
}

test("the one in front is named: loading, then a dialog, the command menu, the tour, Present, the writer, the shot list", () => {
  const all = ["loading", ...EVERY_OVERLAY] as const;
  assert.equal(inFront(all, NOTHING), undefined);
  assert.equal(inFront(all, open(...all)), "loading");
  assert.equal(inFront(all, open("writer", "dialog")), "dialog");
  assert.equal(inFront(all, open("tour", "dialog")), "dialog");
  assert.equal(inFront(all, open("shotlist", "launcher")), "launcher");
  assert.equal(inFront(all, open("writer", "tour")), "tour");
  assert.equal(inFront(all, open("writer", "prompter")), "prompter");
  assert.equal(inFront(all, open("shotlist", "writer")), "writer");
  assert.equal(inFront(["writer"], open("dialog", "writer")), "writer");
  assert.equal(inFront(["dialog"], open("writer", "prompter", "tour", "shotlist")), undefined);
});

test("each blocker refuses with its own reason", () => {
  const reason = (b: Blocker): string | undefined => availableUnless([b], open(b)).reason;
  assert.equal(reason("loading"), "Still loading…");
  assert.equal(reason("dialog"), "Close the open dialog first");
  assert.equal(reason("launcher"), "Close the open dialog first");
  assert.equal(reason("tour"), "Finish or skip the tour first");
  assert.equal(reason("prompter"), "Close Present first");
  assert.equal(reason("writer"), "Close the writer first");
  assert.equal(reason("shotlist"), "Close the shot list first");
  assert.deepEqual(availableUnless(EVERY_OVERLAY, NOTHING, true), { enabled: true, checked: true });
  assert.deepEqual(everyOverlayBut("writer"), ["dialog", "launcher", "tour", "prompter", "shotlist"]);
  assert.equal(availableUnless(OPENS_A_DIALOG, open("tour")).reason, "Finish or skip the tour first");
  assert.equal(availableUnless(OPENS_A_DIALOG, open("tour", "dialog")).reason, "Close the open dialog first");
  assert.equal(availableUnless(OPENS_A_DIALOG, open("writer", "prompter", "shotlist", "launcher")).enabled, true);
});

function loadedRegistry(): { registry: ActionRegistry; restore: () => void } {
  mountHelpFeature();
  const registry = createActionRegistry();
  mountRundownFeature();
  const disposers = [stopRundownFeature, registerFileActions(registry), registerAll(registry, [...hideShotActions(), ...rundownMinimizeActions(), ...thisDocumentActions()]), registerViewActions(registry),
    registerShareActions(registry), stopHelpFeature];
  const was = { state: currentDocument() as unknown, prompterOpen: prompterIsOpen() };
  loadTestDocument({ rows: [] });
  setPrompterOpen(false);
  return {
    registry,
    restore: () => {
      loadTestDocument(was.state);
      setPrompterOpen(was.prompterOpen);
      document.body.innerHTML = "";
      for (const dispose of disposers) dispose();
    }
  };
}

function refusal(registry: ActionRegistry, id: string, source: ActionSource = "native-menu"): string | null {
  const view = registry.view(id, source);
  assert.ok(view, `${id} is registered`);
  return view.enabled ? null : view.reason;
}

const NO_DIALOG_COMMANDS = ["server-publish", "save-back", "prompter-open-in-browser", "prompter-open-in-chromium"];

const PAGE_COMMANDS =["open", "export", "command-menu", "find", "history", "panel-production", "panel-gear", "panel-comments"];

test("in Present, what would open behind it is refused, and Save, Hide shot scenes and Present itself are not", () => {
  const { registry, restore } = loadedRegistry();
  try {
    setPrompterOpen(true);
    for (const id of [...PAGE_COMMANDS, "write"]) assert.equal(refusal(registry, id), "Close Present first", id);
    for (const id of ["save", "save-as", "toggle-hide-shot", "present"]) assert.equal(refusal(registry, id), null, id);
  } finally {
    restore();
  }
});

test("on the shot-list page, what would open behind it is refused", () => {
  const { registry, restore } = loadedRegistry();
  try {
    document.body.innerHTML = '<div id="broll-page"></div>';
    viewFlags().setBrollPageOpen(true);
    for (const id of [...PAGE_COMMANDS, "write", "present"]) assert.equal(refusal(registry, id), "Close the shot list first", id);
    for (const id of ["save", "save-as", "toggle-hide-shot"]) assert.equal(refusal(registry, id), null, id);
    viewFlags().setBrollPageOpen(false);
    for (const id of [...PAGE_COMMANDS, "write", "present"]) assert.equal(refusal(registry, id), null, id);
  } finally {
    viewFlags().setBrollPageOpen(false);
    restore();
  }
});

test("a dialog over Present is named first, and the commands that only acted behind a dialog are refused there too", () => {
  const { registry, restore } = loadedRegistry();
  try {
    setPrompterOpen(true);
    document.body.innerHTML = '<div class="modal-backdrop"></div>';
    for (const id of [...PAGE_COMMANDS, "write", "present", "save", "save-as", "toggle-hide-shot", ...NO_DIALOG_COMMANDS]) {
      assert.equal(refusal(registry, id), "Close the open dialog first", id);
    }
    assert.equal(refusal(registry, "toggle-rundown-min"), null);
  } finally {
    restore();
  }
});

const DIALOG_OPENERS = ["about", "settings", "servers", "setup", "tagging-help", "collaborate", "paste", "gdoc-import",
  "drive-open", "server-open"];

test("a command that opens a dialog, Help among them, is refused over a dialog but opens over Present", () => {
  const { registry, restore } = loadedRegistry();
  const menu = helpMenuActions();
  const help = registerAll(registry, [...menu.slice(0, 3), ...helpActions(), ...menu.slice(3)]);
  try {
    for (const id of [...DIALOG_OPENERS, "help"]) assert.equal(refusal(registry, id, "menu"), null, id);
    document.body.innerHTML = '<div class="modal-backdrop"></div>';
    for (const id of [...DIALOG_OPENERS, "help"]) assert.equal(refusal(registry, id, "menu"), "Close the open dialog first", id);
    document.body.innerHTML = "";
    setPrompterOpen(true);
    for (const id of [...DIALOG_OPENERS, "help"]) assert.equal(refusal(registry, id, "menu"), null, id);
  } finally {
    help();
    restore();
  }
});

test("the tour is refused over a dialog and starts over Present and the shot list", () => {
  const { registry, restore } = loadedRegistry();
  const menu = helpMenuActions();
  const help = registerAll(registry, [...menu.slice(0, 3), ...helpActions(), ...menu.slice(3)]);
  try {
    assert.equal(refusal(registry, "tour", "menu"), null);
    document.body.innerHTML = '<div class="modal-backdrop"></div>';
    assert.equal(refusal(registry, "tour", "menu"), "Close the open dialog first");
    assert.equal(refusal(registry, "tour"), "Close the open dialog first");
    document.body.innerHTML = '<div class="modal-backdrop" hidden></div>';
    assert.equal(refusal(registry, "tour", "menu"), null);
    document.body.innerHTML = "";
    setPrompterOpen(true);
    assert.equal(refusal(registry, "tour", "menu"), null);
    setPrompterOpen(false);
    document.body.innerHTML = '<div id="broll-page"></div>';
    assert.equal(refusal(registry, "tour", "menu"), null);
  } finally {
    help();
    restore();
  }
});

test("the open command menu refuses what its shortcut refused, and not Find, Hide shot scenes or itself", () => {
  const { registry, restore } = loadedRegistry();
  try {
    document.body.innerHTML = '<div class="cmdk-backdrop"></div>';
    for (const id of ["save", "save-as", "open", "export", "present", "write", "history", "panel-production", ...NO_DIALOG_COMMANDS]) {
      assert.equal(refusal(registry, id), "Close the open dialog first", id);
    }
    for (const id of ["find", "toggle-hide-shot", "command-menu"]) assert.equal(refusal(registry, id), null, id);
  } finally {
    restore();
  }
});
