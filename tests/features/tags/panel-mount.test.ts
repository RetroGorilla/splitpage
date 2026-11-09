import { createProductionPrepState } from "../../../src/application/production/prep-state.ts";
import { clickProductionOutline, changeProductionOutline, revealProductionItem } from "../../../src/features/tags/panels.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startTagPanels, IS_TOUCH, openProductionPanel, saveTagRename, setTagNotes } from "../../../src/features/tags/panels.ts";
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
import { tagKey } from "../../../src/core/document/tags.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import { prepContext } from "../../../src/features/tags/outline.ts";
import { tagStatusLampHtml } from "../../../src/features/common/tag-status.ts";
import * as commands from "../../../src/application/tag-panel-commands.ts";
import { owned } from "../../../src/features/routing/owned.ts";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function fixture(cat = "prop", migration = fakeMigration()) {
  win.document.body.innerHTML = '<button id="btn-production"></button><button id="btn-gear"></button>' +
    '<div id="production-panel" hidden></div><div id="gear-panel" hidden></div>' +
    '<div class="tag-entity"><div><button id="menu-button" class="tag-menu-btn" aria-expanded="false"></button>' +
    '<div class="tag-menu" hidden><button class="tag-menu-item">Pick</button></div></div></div>';
  const doc = migrateRows({ schema: 2, rows: [], productionTags: [{ id: "t_hat", cat, name: "Hat" }] }, migration.ports);
  const document = fakeDocument(doc);
  const edits = fakeEdits();
  const calls: string[] = [];
  let renaming: string | null = null;
  let addingPerson: string | null = null;
  let expanded: string | null = null;
  const pending = new Map<unknown, () => void>();
  let timerId = 0;
  const timers = {
    start: (run: () => void) => { const id = ++timerId; pending.set(id, run); return id; },
    stop: (handle: unknown) => { pending.delete(handle); }
  };
  const deletion = createDeleteConfirm(timers);
  const selection = createProductionSelection(timers);
  const prep = createProductionPrepState();
  const ports: TagPanelPorts = {
    preferences: { panelGrouping: () => null },
    changes: { onChange: () => () => {} },
    focus: { lastRow: () => null },
    beats: { setFilmed: () => {}, reveal: () => {} },
    footage: { entries: () => [], open: () => {} },
    view: {
      prep: () => prep,
      gearGroupBy: () => "flat", productionGroupBy: () => "cat",
      setGearGroupBy: () => {}, setProductionGroupBy: () => {},
      setTagAddingPerson: (key) => { addingPerson = key; },
      setTagRenaming: (key) => { renaming = key; },
      tagAddingPersonKey: () => addingPerson, tagRenamingKey: () => renaming,
      tagExpandedKey: () => expanded, setTagExpanded: (key) => { expanded = key; }
    },
    document: document.document,
    lifetime: document.lifetime,
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
    undo: { undo: () => {}, last: () => null, breakCoalescing: () => { calls.push("undo"); } },
    notices: fakeNotices().notices,
    ids: migration.ids,
    bulkTag: () => ({ hits: 0, inTags: 0, skipped: 0 })
  };
  return { ports, calls, edits, doc, document, pending, deletion, selection };
}

function prepFixture(focus: string | null = null) {
  const migration = fakeMigration();
  const tagged = migration.cell([{ text: "Hat", marks: { tag: "t:prop:Hat" } }]);
  const h = fixture("prop", migration);
  const doc = migrateRows({
    schema: 2,
    rows: Array.from({ length: 200 }, (_, i) => ({ id: "r" + i, visualText: tagged, audioText: "Beat " + i, status: i < 2 ? "shot" : "todo" })),
    sections: Array.from({ length: 6 }, (_, i) => ({ id: "sec" + i, name: "Scene " + i, firstSceneId: "r" + i * 34 })),
    people: [{ id: "p1", name: "Adam" }],
    productionTags: [{ id: "hat", cat: "prop", name: "Hat", notes: "https://example.com/hat" }]
  }, migration.ports);
  h.document.replace(doc);
  win.document.body.innerHTML = '<div id="production-panel"><div id="production-bulk"></div><div id="production-list"></div></div>';
  const calls: unknown[][] = [];
  const ports: TagPanelPorts = { ...h.ports,
    focus: { lastRow: () => focus },
    view: { ...h.ports.view, productionGroupBy: () => "prep" },
    beats: { reveal: id => { calls.push(["jump", id]); }, setFilmed: (id, filmed) => { calls.push(["filmed", id, filmed]); } }
  };
  const mounted = startTagPanels(ports);
  mounted.renderProduction();
  function click(selector: string): void {
    const target = win.document.querySelector(selector);
    assert.ok(target, selector);
    assert.equal(clickProductionOutline({ target } as unknown as MouseEvent), true);
  }
  return { ...h, doc, ports, calls, mounted, click };
}

test("shoot rendering derives document numbering once for many location groups", () => {
  const migration = fakeMigration();
  const h = fixture("location", migration);
  const doc = migrateRows({ schema: 2, rows: Array.from({ length: 94 }, (_, i) => ({
    id: "r" + i, visualText: migration.cell([{ text: "Place " + i, marks: { tag: "t:location:Place " + i } }]), audioText: ""
  })), sections: [{ id: "s1", name: "Opening", firstSceneId: "r0" }],
  productionTags: Array.from({ length: 94 }, (_, i) => ({ id: "t_" + i, cat: "location", name: "Place " + i })) }, migration.ports);
  const entries = h.ports.production.entries(doc);
  let derivations = 0;
  const counted = new Proxy(doc, { get(target, key, receiver) {
    if (key === "sections") derivations++;
    return Reflect.get(target, key, receiver) as unknown;
  } });
  win.document.body.innerHTML = '<div id="production-panel"><div id="production-list"></div></div>';
  const ports: TagPanelPorts = { ...h.ports,
    document: { ...h.ports.document, current: () => counted, numbering: () => deriveDocumentNumbering(counted) },
    production: { ...h.ports.production, entries: () => entries },
    view: { ...h.ports.view, productionGroupBy: () => "shoot" }
  };
  const mounted = startTagPanels(ports);
  try {
    mounted.renderProduction();
    assert.equal(win.document.querySelectorAll('.shoot-group').length, 94);
    assert.equal(derivations, 1);
  } finally { mounted.dispose(); }
});

test("tag panels unsubscribe from preference changes on disposal", () => {
  const h = fixture();
  let listeners = 0;
  const mounted = startTagPanels({ ...h.ports, changes: { onChange: () => { listeners++; return () => { listeners--; }; } } });
  assert.equal(listeners, 1);
  mounted.dispose();
  mounted.dispose();
  assert.equal(listeners, 0);
});

test("Scene prep handles 200 beats as six scene groups, reveals the focused beat, and keeps browsing stable across refresh", () => {
  const h = prepFixture("r119");
  try {
    assert.equal(win.document.querySelectorAll(".prep-scene").length, 6);
    assert.equal(win.document.querySelectorAll(".prep-scene.is-open").length, 1);
    assert.equal(win.document.querySelector(".prep-beat.is-open .prep-beat-ref")?.textContent, "D.18");
    assert.equal(win.document.querySelectorAll(".prep-beat").length, 8);
    h.click('[data-prep="more"]');
    assert.equal(win.document.querySelectorAll(".prep-beat").length, 16);
    h.mounted.renderProduction();
    assert.equal(win.document.querySelectorAll(".prep-beat").length, 16);
    h.click('[data-prep="jump"][data-id="r119"]');
    assert.deepEqual(h.calls, [["jump", "r119"]]);
    assert.equal(h.edits.ran.length, 0);
  } finally { h.mounted.dispose(); }
});

test("Scene prep labels an unnamed scene by its scene letter and keeps a given name", () => {
  const h = prepFixture();
  try {
    const migration = fakeMigration();
    h.document.replace(migrateRows({
      schema: 2,
      rows: Array.from({ length: 5 }, (_, i) => ({ id: "r" + i, visualText: migration.cell([]), audioText: "Beat " + i, status: "todo" })),
      sections: [{ id: "sb", name: "Harbour", firstSceneId: "r3" }]
    }, migration.ports));
    h.mounted.renderProduction();
    const names = [...win.document.querySelectorAll(".prep-scene-name")].map(el => el.textContent);
    assert.deepEqual(names, ["Scene A", "Harbour"]);
  } finally { h.mounted.dispose(); }
});

test("Scene prep renders shared items once per beat and once in the scene summary, with one notes editor and literal Assign", () => {
  const h = prepFixture("r2");
  try {
    const owner = win.document.querySelector<HTMLSelectElement>(".prep-owner select");
    assert.equal(owner?.selectedOptions[0]?.textContent, "Assign");
    assert.equal(owner?.parentElement?.dataset["initial"], "+");
    assert.equal(win.document.querySelectorAll(".prep-reference").length, 1);
    h.click('[data-prep="requirements"]');
    assert.equal(win.document.querySelectorAll(".prep-resource").length, 2);
    h.click('.prep-resource-name [data-prep="notes"]');
    assert.equal(win.document.querySelectorAll(".tag-notes-input").length, 1);
    assert.equal(win.document.querySelectorAll(".prep-status-select option").length, 8);
    const ids = [...win.document.querySelectorAll("[id]")].map(el => el.id);
    assert.equal(ids.length, new Set(ids).size);
    const film = win.document.querySelector<HTMLInputElement>('[data-row="r2"]');
    assert.ok(film);
    film.checked = true;
    changeProductionOutline(film);
    assert.deepEqual(h.calls, [["filmed", "r2", true]]);
  } finally { h.mounted.dispose(); }
});

test("an explicit script tag reveal reaches a beat beyond the current batch", () => {
  const h = prepFixture("r2");
  try {
    const item = h.ports.production.entries(h.doc)[0];
    assert.ok(item);
    revealProductionItem("r119", item.key);
    assert.equal(win.document.querySelector(".prep-beat.is-open .prep-beat-ref")?.textContent, "D.18");
    assert.equal(win.document.querySelectorAll(".tag-notes-input").length, 1);
    assert.equal(h.edits.ran.length, 0);
    h.document.replace(h.doc);
    h.mounted.renderProduction();
    assert.equal(win.document.querySelector(".prep-beat.is-open")?.getAttribute("data-beat"), "r2");
    assert.equal(win.document.querySelectorAll(".tag-notes-input").length, 0);
  } finally { h.mounted.dispose(); }
});

for (const focused of [true, false]) {
  test("Scene prep preserves an unfinished rename across refresh, focused=" + focused, () => {
    const h = prepFixture("r2");
    try {
      h.click('.prep-resource-name [data-prep="notes"]');
      const item = h.ports.production.entries(h.doc)[0];
      assert.ok(item);
      h.ports.view.setTagRenaming(item.key);
      h.mounted.renderProduction();
      const input = win.document.querySelector<HTMLInputElement>(".tag-rename-input");
      assert.ok(input);
      input.value = "A new hat";
      input.focus();
      input.setSelectionRange(2, 5, "backward");
      if (!focused) input.blur();
      h.mounted.renderProduction();
      const next = win.document.querySelector<HTMLInputElement>(".tag-rename-input");
      assert.equal(next, input);
      assert.equal(next.value, "A new hat");
      assert.equal(next.selectionStart, 2);
      assert.equal(next.selectionEnd, 5);
      assert.equal(next.selectionDirection, "backward");
      assert.equal(win.document.activeElement === next, focused);
    } finally { h.mounted.dispose(); }
  });
}

test("Scene prep rename moves the open detail to the item's new key", () => {
  const h = prepFixture("r2");
  try {
    h.click('.prep-resource-name [data-prep="notes"]');
    const item = h.ports.production.entries(h.doc)[0];
    assert.ok(item);
    h.ports.view.setTagRenaming(item.key);
    h.mounted.renderProduction();
    const open = h.ports.view.prep().current().notes;
    assert.ok(open);
    h.edits.answer({ kind: "applied", generation: 1, changes: changeSet({}) });
    assert.equal(saveTagRename(item.key, "Cap"), tagKey("prop", "Cap"));
    const [container] = JSON.parse(open) as [string];
    assert.equal(h.ports.view.prep().current().notes, prepContext(container, tagKey("prop", "Cap")));
  } finally { h.mounted.dispose(); }
});

test("a requirement that becomes ready stays in place; initially ready items use an explicit fold", () => {
  const h = prepFixture("r2");
  try {
    const tag = h.doc.productionTags?.[0];
    assert.ok(tag);
    tag.status = "have";
    h.mounted.renderProduction();
    assert.equal(win.document.querySelectorAll(".prep-resource").length, 1);
    assert.equal(win.document.querySelectorAll('[data-prep="ready-fold"]').length, 0);
    h.document.replace(h.doc);
    h.mounted.renderProduction();
    assert.equal(win.document.querySelectorAll(".prep-resource").length, 0);
    h.click('[data-prep="ready-fold"]');
    assert.equal(win.document.querySelectorAll(".prep-resource").length, 1);
  } finally { h.mounted.dispose(); }
});

test("a requirement that stops being ready leaves the ready fold, and a script tag can reveal an initially ready item", () => {
  const h = prepFixture("r2");
  try {
    const tag = h.doc.productionTags?.[0];
    assert.ok(tag);
    tag.status = "have";
    h.document.replace(h.doc);
    h.mounted.renderProduction();
    assert.equal(win.document.querySelectorAll(".prep-resource").length, 0);
    const item = h.ports.production.entries(h.doc)[0];
    assert.ok(item);
    revealProductionItem("r2", item.key);
    assert.equal(win.document.querySelectorAll(".tag-notes-input").length, 1);
    h.ports.view.prep().toggleReady("beat:r2");
    tag.status = "needed";
    h.mounted.renderProduction();
    assert.equal(win.document.querySelectorAll(".prep-resource").length, 1);
    assert.equal(win.document.querySelectorAll('[data-prep="ready-fold"]').length, 0);
  } finally { h.mounted.dispose(); }
});

test("an unnamed scene cannot collide with an imported scene whose ID is auto", () => {
  const h = prepFixture("r0");
  try {
    const imported = migrateRows({ ...h.doc, sections: [{ id: "auto", name: "Intro", firstSceneId: "r2" }] }, fakeMigration().ports);
    h.document.replace(imported);
    h.mounted.renderProduction();
    assert.equal(win.document.querySelectorAll(".prep-scene").length, 2);
    assert.equal(win.document.querySelectorAll(".prep-scene.is-open").length, 1);
    h.click('[data-prep="scene"][data-id="scene:auto"]');
    assert.equal(win.document.querySelectorAll(".prep-scene.is-open").length, 2);
  } finally { h.mounted.dispose(); }
});

test("marking a focused requirement ready keeps keyboard focus in the same resource", () => {
  const h = prepFixture("r2");
  try {
    const button = win.document.querySelector<HTMLButtonElement>('[data-prep="ready"]');
    assert.ok(button);
    button.focus();
    const tag = h.doc.productionTags?.[0];
    assert.ok(tag);
    tag.status = "have";
    h.mounted.renderProduction();
    assert.equal(win.document.activeElement, win.document.querySelector(".prep-status-select"));
  } finally { h.mounted.dispose(); }
});

for (const focused of [true, false]) {
  test("gear rename keeps its draft and selection across production refresh, focused=" + focused, () => {
    const h = fixture("gear");
    win.document.body.innerHTML = '<input id="script"><div id="gear-panel"><div id="gear-list"></div></div>';
    const mounted = startTagPanels(h.ports);
    try {
      const entry = h.ports.production.entries(h.doc)[0];
      assert.ok(entry);
      h.ports.view.setTagRenaming(entry.key);
      mounted.renderProduction();
      const input = win.document.querySelector<HTMLInputElement>(".tag-rename-input");
      assert.ok(input);
      input.value = "Camera draft";
      input.focus();
      input.setSelectionRange(2, 8, "backward");
      const script = win.document.getElementById("script");
      assert.ok(script);
      if (!focused) script.focus();
      mounted.renderProduction();
      const refreshed = win.document.querySelector<HTMLInputElement>(".tag-rename-input");
      assert.ok(refreshed);
      assert.equal(refreshed.value, "Camera draft");
      assert.equal(refreshed.selectionStart, 2);
      assert.equal(refreshed.selectionEnd, 8);
      assert.equal(refreshed.selectionDirection, "backward");
      assert.equal(win.document.activeElement, focused ? refreshed : script);
      h.ports.view.setTagRenaming(null);
      mounted.renderProduction();
      assert.equal(win.document.querySelector(".tag-rename-input"), null);
      h.ports.view.setTagRenaming(entry.key);
      mounted.renderProduction();
      assert.equal(win.document.querySelector<HTMLInputElement>(".tag-rename-input")?.value, "Hat");
    } finally { mounted.dispose(); }
  });
}

test("gear rename discards its draft when the same document and registry ID enter a new lifetime", () => {
  const h = fixture("gear");
  win.document.body.innerHTML = '<div id="gear-panel"><div id="gear-list"></div></div>';
  const mounted = startTagPanels(h.ports);
  try {
    const entry = h.ports.production.entries(h.doc)[0];
    assert.ok(entry);
    h.ports.view.setTagRenaming(entry.key);
    mounted.renderProduction();
    const input = win.document.querySelector<HTMLInputElement>(".tag-rename-input");
    assert.ok(input);
    input.value = "Camera draft";
    h.document.replace(h.doc);
    mounted.renderProduction();
    const refreshed = win.document.querySelector<HTMLInputElement>(".tag-rename-input");
    assert.ok(refreshed);
    assert.notEqual(refreshed, input);
    assert.equal(refreshed.value, "Hat");
  } finally { mounted.dispose(); }
});

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
  first.saveTagRename(entry.key, "name");
  first.addPersonForTag(entry.key, "name");
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
    saveTagRename: (key, value) => { calls.push([label, "rename", key, value]); return key; },
    addPersonForTag: (key, value) => { calls.push([label, "person", key, value]); },
    setTagOwner: (key, person) => { calls.push([label, "owner", key, person]); },
    setTagNotes: (key, text) => { calls.push([label, "notes", key, text]); }
  });
  const first = commands.installTagPanelCommands(handlers("first"));
  const second = commands.installTagPanelCommands(handlers("second"));
  first();
  commands.renderProduction();
  commands.saveTagRename("hat", "cap");
  commands.addPersonForTag("hat", "Alice");
  commands.setTagOwner("hat", "ada");
  commands.setTagNotes("hat", "Packed");
  assert.deepEqual(calls, [["second", "render"], ["second", "rename", "hat", "cap"], ["second", "person", "hat", "Alice"], ["second", "owner", "hat", "ada"], ["second", "notes", "hat", "Packed"]]);
  second();
  assert.throws(commands.renderProduction, /not installed yet/);
});
