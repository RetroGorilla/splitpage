import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startTagPanels, IS_TOUCH, openProductionPanel, setTagNotes } from "../../../src/features/tags/panels.js";
import type { TagPanelPorts } from "../../../src/features/tags/ports.ts";
import { createProductionSelection } from "../../../src/application/editing/production-selection.ts";
import { createDeleteConfirm } from "../../../src/application/editing/delete-confirm.ts";
import { createProductionIndex } from "../../../src/application/production/production-index.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices, fakeScreen } from "../fakes.ts";
import { tagPanelActions } from "../../../src/features/tags/actions.ts";
import { TAG_STATUSES } from "../../../src/core/production/looks.ts";
import { tagStatusLampHtml } from "../../../src/features/common/tag-status.ts";
import * as commands from "../../../src/application/tag-panel-commands.ts";
import { owned } from "../../../src/features/routing/owned.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function fixture() {
  win.document.body.innerHTML = '<button id="btn-production"></button><button id="btn-gear"></button>' +
    '<div id="production-panel" hidden></div><div id="gear-panel" hidden></div>' +
    '<div class="tag-entity"><div><button id="menu-button" class="tag-menu-btn" aria-expanded="false"></button>' +
    '<div class="tag-menu" hidden><button class="tag-menu-item">Pick</button></div></div></div>';
  const migration = fakeMigration();
  const doc = migrateRows({ schema: 2, rows: [], productionTags: [{ id: "t_hat", cat: "prop", name: "Hat" }] }, migration.ports);
  const document = fakeDocument(doc);
  const edits = fakeEdits();
  const calls: string[] = [];
  let renaming: string | null = null;
  let addingPerson: string | null = null;
  const pending = new Map<unknown, () => void>();
  let timerId = 0;
  const timers = {
    start: (run: () => void) => { const id = ++timerId; pending.set(id, run); return id; },
    stop: (handle: unknown) => { pending.delete(handle); }
  };
  const deletion = createDeleteConfirm(timers);
  const selection = createProductionSelection(timers);
  const ports: TagPanelPorts = {
    view: {
      gearGroupBy: () => "flat", productionGroupBy: () => "cat",
      setTagAddingPerson: (key) => { addingPerson = key; },
      setTagRenaming: (key) => { renaming = key; },
      tagAddingPersonKey: () => addingPerson, tagRenamingKey: () => renaming,
      tagExpandedKey: () => null
    },
    document: document.document,
    edits: edits.edits,
    production: createProductionIndex(migration.ports.readers, deepFreeze),
    text: {
      productionReaders: migration.ports.readers,
      cellOf: () => deepFreeze([]),
      inertBody: (html) => { const body = win.document.createElement("div"); body.innerHTML = String(html ?? ""); return body; },
      retagBody: (body) => body.innerHTML,
      sanitizeHtml: (html) => String(html ?? "")
    },
    deletion,
    selection,
    shotHiding: { reveal: (id) => { calls.push(id); } },
    panels: { open: (id) => { calls.push(id); } },
    personColors: { personColor: () => "blue" },
    undo: { breakCoalescing: () => { calls.push("undo"); } },
    notices: fakeNotices().notices,
    ids: migration.ids,
    bulkTag: () => ({ hits: 0, inTags: 0, skipped: 0 })
  };
  return { ports, calls, edits, doc, pending, deletion, selection };
}

test("production panels mount with fake ports and remove both menu listeners on disposal and remount", () => {
  const h = fixture();
  const first = startTagPanels(h.ports);
  const button = win.document.getElementById("menu-button") as HTMLButtonElement;
  const menu = win.document.querySelector(".tag-menu") as HTMLElement;
  button.click();
  assert.equal(menu.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  first.dispose();
  first.dispose();
  assert.equal(menu.hidden, true);
  assert.equal(IS_TOUCH, undefined);
  button.click();
  assert.equal(menu.hidden, true);
  const second = startTagPanels(h.ports);
  button.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(menu.hidden, false);
  second.dispose();
  button.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(menu.hidden, true);
});

test("production panel commands use the document, edit and panel ports", () => {
  const h = fixture();
  const mounted = startTagPanels(h.ports);
  try {
    openProductionPanel();
    assert.deepEqual(h.calls, ["production-panel"]);
    const entry = h.ports.production.entries(h.doc)[0];
    assert.ok(entry);
    setTagNotes(entry.key, "Notes");
    assert.equal(h.edits.ran.length, 1);
  } finally { mounted.dispose(); }
});

test("replaced and disposed panel controls cannot act on the next mount", () => {
  const h = fixture();
  const state = owned<ReturnType<typeof startTagPanels>>();
  const first = state.replace(() => startTagPanels(h.ports));
  first.openProductionPanel();
  assert.deepEqual(h.calls, ["production-panel"]);
  h.selection.arm(() => { assert.fail("a replaced mount's bulk-delete timer fired"); });
  h.deletion.arm("tag", "hat", () => { assert.fail("a replaced mount's tag-delete timer fired"); });
  assert.equal(h.pending.size, 2);
  const second = state.replace(() => startTagPanels(h.ports));
  assert.equal(h.pending.size, 0);
  const entry = h.ports.production.entries(h.doc)[0];
  assert.ok(entry);
  first.openProductionPanel();
  first.openGearPanel();
  first.renderProduction();
  first.saveTagRename(entry.key);
  first.addPersonForTag(entry.key);
  first.setTagOwner(entry.key, "ada");
  first.setTagNotes(entry.key, "Stale");
  first.dispose();
  assert.deepEqual(h.calls, ["production-panel"]);
  assert.equal(h.edits.ran.length, 0);
  second.openProductionPanel();
  assert.deepEqual(h.calls, ["production-panel", "production-panel"]);
  state.stop();
  second.openProductionPanel();
  second.setTagNotes(entry.key, "Disposed");
  assert.deepEqual(h.calls, ["production-panel", "production-panel"]);
  assert.equal(h.edits.ran.length, 0);
});

test("production actions preserve their order, availability and panel toggles", () => {
  const h = fixture();
  let owner: ReturnType<typeof startTagPanels> | null = startTagPanels(h.ports);
  const screen = fakeScreen();
  const calls: string[] = [];
  const actions = tagPanelActions(() => owner, screen.screen, { close: (id) => { calls.push(id); } });
  assert.deepEqual(actions.map((action) => action.id), ["panel-production", "panel-gear"]);
  const production = actions[0];
  assert.ok(production);
  assert.equal(production.availability?.("button").enabled, true);
  screen.state.loading = true;
  assert.equal(production.availability?.("button").enabled, false);
  (win.document.getElementById("production-panel") as HTMLElement).hidden = false;
  production.run("button");
  assert.deepEqual(calls, ["production-panel"]);
  owner.dispose();
  owner = null;
  assert.equal(production.availability?.("button").enabled, false);
  production.run("button");
  assert.deepEqual(calls, ["production-panel"]);
});

test("status lamps preserve markup for each status and unknown values", () => {
  for (const status of TAG_STATUSES) {
    assert.equal(tagStatusLampHtml(status.id), status.id === "returned"
      ? '<svg class="item-lamp is-returned" aria-hidden="true" focusable="false"><use href="#i-return"/></svg>'
      : '<span class="item-lamp is-' + status.id + '" aria-hidden="true"></span>');
  }
  assert.equal(tagStatusLampHtml("unknown"), tagStatusLampHtml("needed"));
});

test("the teleprompter hand-off forwards all five commands and releases only its installation", () => {
  const calls: unknown[][] = [];
  const handlers = (label: string): commands.TagPanelCommands => ({
    renderProduction: () => { calls.push([label, "render"]); },
    saveTagRename: (key) => { calls.push([label, "rename", key]); },
    addPersonForTag: (key) => { calls.push([label, "person", key]); },
    setTagOwner: (key, person) => { calls.push([label, "owner", key, person]); },
    setTagNotes: (key, text) => { calls.push([label, "notes", key, text]); }
  });
  const first = commands.installTagPanelCommands(handlers("first"));
  const second = commands.installTagPanelCommands(handlers("second"));
  first();
  commands.renderProduction();
  commands.saveTagRename("hat");
  commands.addPersonForTag("hat");
  commands.setTagOwner("hat", "ada");
  commands.setTagNotes("hat", "Packed");
  assert.deepEqual(calls, [["second", "render"], ["second", "rename", "hat"], ["second", "person", "hat"], ["second", "owner", "hat", "ada"], ["second", "notes", "hat", "Packed"]]);
  second();
  assert.throws(commands.renderProduction, /not installed yet/);
});
