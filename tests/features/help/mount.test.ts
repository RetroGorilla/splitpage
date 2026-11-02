import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { helpActions } from "../../../src/features/help/actions.ts";
import type { HelpPorts } from "../../../src/features/help/ports.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeActions, fakeDocument, fakeNotices, fakeScreen, fakeSidePanels, fakeTourFlags, fakeTourPreferences } from "../fakes.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;
const help = await import("../../../src/features/help/help.ts");

function page() {
  win.document.body.innerHTML = '<button id="outside">Outside</button><div id="rows"><div class="row"><div class="visual-cell"><div class="cell-editable"></div></div></div></div>' +
    '<button id="btn-comments"></button><button id="btn-save"></button><button id="btn-present"></button>' +
    '<div id="help-modal" hidden><button id="help-close"></button><div id="help-body"></div><nav id="help-toc"></nav></div>' +
    '<div id="tagging-help" hidden><div class="tagging-help-foot"></div></div>' +
    '<div id="tour-overlay" hidden><div id="tour-cutout"></div><div id="tour-card"><span id="tour-step"></span><h2 id="tour-title"></h2><p id="tour-body"></p>' +
    '<a id="tour-readmore"></a><button id="tour-back"></button><button id="tour-next"></button><button id="tour-skip"></button></div></div>';
}

function click(id: string) {
  const el = win.document.getElementById(id);
  assert.ok(el);
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setup() {
  page();
  const registry = createActionRegistry();
  const runner = fakeActions(registry);
  const reader = fakeDocument();
  const notices = fakeNotices();
  const preferences = fakeTourPreferences();
  const viewFlags = fakeTourFlags();
  const panels = fakeSidePanels();
  const view = fakeScreen();
  const given: HelpPorts = {
    document: reader.document, notices: notices.notices,
    preferences: preferences.preferences, viewFlags, sidePanels: panels.sidePanels
  };
  const holder: { current: ReturnType<typeof help.startHelp> | null } = { current: null };
  const unregister = registerAll(registry, helpActions(() => holder.current, { screen: view.screen, desktop: () => false }));
  const mount = () => { holder.current = help.startHelp(given); return holder.current; };
  const loaded = () => { reader.replace(migrateRows({ rows: [] }, fakeMigration().ports)); };
  const dispose = () => { holder.current?.dispose(); holder.current = null; unregister(); };
  return { registry, runner, reader, notices, preferences, viewFlags, panels, view, mount, loaded, dispose };
}

test("help actions refuse before mount and over dialogs, and the tour reads its document and notice ports", () => {
  const h = setup();
  try {
    assert.equal(h.registry.invoke("help", "menu").kind, "unavailable");
    h.mount();
    assert.equal(h.registry.invoke("tour", "menu").kind, "ran");
    assert.deepEqual(h.notices.shown.map(({ message, kind }) => ({ message, kind })), [{ message: "Still loading…", kind: "warn" }]);
    assert.equal(h.viewFlags.tourOpen(), false);
    h.view.state.dialog = true;
    assert.equal(h.registry.view("help")?.reason, "Close the open dialog first");
    assert.equal(h.registry.invoke("tour", "menu").kind, "unavailable");
    h.view.state.dialog = false;
    h.loaded();
    h.registry.invoke("help", "menu");
    assert.equal(win.document.getElementById("help-modal")?.hidden, false);
    assert.equal(win.document.activeElement?.id, "help-close");
    click("help-close");
    h.registry.invoke("tour", "menu");
    assert.equal(h.viewFlags.tourOpen(), true);
    assert.equal(h.panels.closed(), 2);
    click("tour-skip");
    assert.equal(h.preferences.finished(), 1);
  } finally {
    h.dispose();
  }
});

test("tour refuses every screen overlay and loading without starting, while Help keeps its availability", () => {
  const h = setup();
  h.loaded();
  h.mount();
  try {
    for (const blocker of ["loading", "dialog", "launcher", "tour", "prompter", "writer", "shotlist"] as const) {
      h.view.state[blocker] = true;
      assert.equal(h.registry.invoke("tour", "native-menu").kind, "unavailable", blocker);
      assert.equal(h.viewFlags.tourOpen(), false, blocker);
      assert.equal(h.panels.closed(), 0, blocker);
      assert.equal(h.registry.view("help")?.enabled, blocker !== "dialog", blocker);
      h.view.state[blocker] = false;
    }
    assert.equal(h.registry.invoke("tour", "menu").kind, "ran");
    assert.equal(h.viewFlags.tourOpen(), true);
  } finally { h.dispose(); }
});

test("disposal removes listeners, clears tour state, and permits a fresh mount", () => {
  const h = setup();
  try {
    h.loaded();
    const first = h.mount();
    h.registry.invoke("tour", "menu");
    first.dispose();
    first.dispose();
    assert.equal(h.viewFlags.tourOpen(), false);
    assert.equal(win.document.getElementById("tagging-help-fullguide"), null);
    click("tour-skip");
    assert.equal(h.preferences.finished(), 0);
    const next = h.mount();
    h.registry.invoke("tour", "menu");
    click("tour-next");
    assert.equal(win.document.getElementById("tour-step")?.textContent, "Step 2 of 5");
    next.dispose();
    click("tour-next");
    win.dispatchEvent(new win.Event("resize"));
    win.dispatchEvent(new win.Event("scroll"));
    assert.equal(h.viewFlags.tourOpen(), false);
    assert.equal(h.preferences.finished(), 0);
  } finally {
    h.dispose();
  }
});
