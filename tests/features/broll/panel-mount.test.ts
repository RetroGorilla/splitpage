import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { __init, mountBrollPanel } from "../../../src/features/broll/panel.js";
import type { BrollPanelPorts } from "../../../src/features/broll/ports.ts";
import { fakeDocument, fakeEdits, fakeReview, fakeNotices } from "../fakes.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;
const saved = new Map<string, string>();
const storage = { clear: () => saved.clear(), setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key) ?? null };
realm.localStorage = storage;

function fixture() {
  storage.clear();
  storage.setItem("splitpage-broll-view", JSON.stringify({ filter: "unshot", group: "flat", pageGroup: "person" }));
  win.document.body.innerHTML = '<button id="btn-broll"></button><div id="broll-panel" hidden>' +
    '<button id="filter" data-action="broll-filter" data-filter="flagged"></button></div>' +
    '<div id="broll-page" hidden><select id="broll-page-group"><option value="location">Location</option></select></div>';
  const calls: string[] = [];
  let open = false;
  const ports: BrollPanelPorts = {
    document: fakeDocument().document,
    edits: fakeEdits().edits,
    text: { productionReaders: { cellOf: () => [], tagsInField: () => [], cueNamesInField: () => [], brollInField: () => [], brollPropsInField: () => [], wordCount: () => 0 } },
    ids: { id: (prefix) => prefix + "test", docId: () => "test" },
    production: { entries: () => [] },
    shotHiding: { reveal: (id) => { calls.push("reveal:" + id); } },
    panels: {
      open: (id) => { calls.push("open:" + id); },
      close: (id) => { calls.push("close:" + id); },
      closeAll: () => { calls.push("closeAll"); },
      registerPanel: (id) => { calls.push("register:" + id); return () => { calls.push("unregister:" + id); }; },
      sync: () => { calls.push("sync"); }
    },
    flags: { brollPageOpen: () => open, setBrollPageOpen: (value) => { open = value; } },
    presence: { personColor: () => "blue" },
    undo: { breakCoalescing: () => { calls.push("break"); } },
    review: fakeReview().review,
    actions: { invoke: (id) => { calls.push(id); return { kind: "ran", id }; } },
    notices: fakeNotices().notices,
    records: { brollEntries: () => [], addBrollProp: () => false, renameBrollInScript: () => false, updateBrollBadge: () => {} },
    rows: { focusField: (id, field) => { calls.push(id + ":" + field); } }
  };
  return { ports, calls };
}

function click(id: string) {
  const el = win.document.getElementById(id);
  assert.ok(el);
  el.click();
}

test("B-roll mounts with fake ports, keeps live export scope and removes listeners on replacement and disposal", () => {
  const h = fixture();
  const state = __init(h.ports);
  assert.deepEqual(state.brollPrintView(), { filter: "unshot", group: "person" });
  const first = mountBrollPanel({ exportAs: () => {} });
  click("btn-broll");
  assert.equal(h.calls.filter((c) => c === "panel-broll").length, 1);
  click("filter");
  assert.deepEqual(state.brollPrintView(), { filter: "flagged", group: "person" });
  const group = win.document.getElementById("broll-page-group") as HTMLSelectElement;
  group.value = "location";
  group.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.deepEqual(state.brollPrintView(), { filter: "flagged", group: "location" });
  assert.deepEqual(state.brollPrintView({ filter: "shot", group: "scene" }), { filter: "shot", group: "scene" });
  assert.deepEqual(state.brollPrintView(), { filter: "flagged", group: "location" });
  const second = mountBrollPanel({ exportAs: () => {} });
  first.dispose();
  click("btn-broll");
  assert.equal(h.calls.filter((c) => c === "panel-broll").length, 2);
  second.dispose();
  second.dispose();
  click("btn-broll");
  assert.equal(h.calls.filter((c) => c === "panel-broll").length, 2);
  state.dispose();
  state.dispose();
  assert.equal(h.calls.filter((c) => c === "unregister:broll-panel").length, 2);
  assert.equal(win.document.body.classList.contains("broll-page-open"), false);
});

