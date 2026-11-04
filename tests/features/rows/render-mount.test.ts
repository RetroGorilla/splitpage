import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaintGuard, createUndoGuard } from "../../../src/application/editing/paint-guard.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { RowsRenderPorts } from "../../../src/features/rows/render-ports.ts";
import { startRowsRender } from "../../../src/features/rows/render.ts";
import { fakeDocument, fakeNotices, fakePictures, fakeTextServices } from "../fakes.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { rowMenuKeydown, toggleRowMenu } from "../../../src/features/rows/row-menu.ts";

function fixture(withBeat = false) {
  const doc = fakeDocument(migrateRows({ schema: 2, title: "Render mount", rows: withBeat ? [{ id: "r1", audioText: "One" }] : [] }, fakeMigration().ports));
  const notices = fakeNotices();
  const paint = createPaintGuard();
  const selection = createEditorSelection<Element, Range, Element>({ epoch: () => 0, order: () => [], keys: () => [] });
  let tracks = 0;
  const ports: RowsRenderPorts = {
    document: doc.document,
    edits: { allowed: () => true },
    text: {
      ...fakeTextServices(document).text,
      productionReaders: { cellOf: () => [], tagsInField: () => [], cueNamesInField: () => [], brollInField: () => [], brollPropsInField: () => [], wordCount: () => 0 }
    },
    video: { card: () => document.createElement("a"), hostLabel: () => "File" },
    editing: {
      cells: () => ({ edit: () => null, sync: () => {} }),
      selection: () => selection, paint: () => paint, undo: () => createUndoGuard()
    },
    draft: { appendMedia: () => null, model: () => ({ cell: [], media: { markThroughout: () => false, toggleMark: () => [] } }), edit: () => null, isDraft: () => false, isScript: () => false },
    undo: { track: () => { tracks++; } },
    hiding: () => ({ groups: rows => rows.map((row, index) => ({ row, index })) }),
    scenes: () => ({ folded: () => false }),
    pictures: fakePictures().pictures,
    personColors: { personColor: () => "#000000" },
    preferences: () => ({ clock: () => "24h" }),
    view: () => ({ writerOpen: () => false }),
    notices: notices.notices,
    actions: { invoke: (id) => ({ kind: "unknown", id }) },
    deletes: () => ({ disarm: () => {} }),
    tagPanel: { setTagAddingPerson: () => {} },
    ids: { id: () => "id" },
    production: { stats: () => ({ derived: 0, flushes: 0 }), resetStats: () => {}, scan: () => {}, occurrences: () => ({ html: "", hits: 0 }) }
  };
  return { ports, paint, tracks: () => tracks };
}

test("sectionless rendering never requests the fold owner", () => {
  document.body.innerHTML = '<div id="rows"></div><input id="doc-title">';
  const first = fixture(true);
  let folds = 0;
  const mounted = startRowsRender({ ...first.ports, scenes: () => { folds++; return { folded: () => false }; } });
  try {
    assert.equal(mounted.renderFirstDraw(), true);
    assert.equal(folds, 0);
  } finally { mounted.dispose(); }
});

test("scene menus place Add Scene Header between Insert beat and Delete and include it in keyboard navigation", () => {
  document.body.innerHTML = '<div id="rows"></div><input id="doc-title">';
  const mounted = startRowsRender(fixture(true).ports);
  try {
    assert.equal(mounted.renderFirstDraw(), true);
    const more = document.querySelector<HTMLElement>(".row-more");
    assert.ok(more);
    toggleRowMenu(more, true);
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".row-menu-item"));
    assert.deepEqual(items.map(item => item.textContent), ["Move up", "Move down", "Insert beat", "Add Scene Header", "Delete"]);
    const insert = items[2], scene = items[3], remove = items[4];
    assert.ok(insert && scene && remove);
    assert.equal(scene.getAttribute("role"), "menuitem");
    assert.equal(scene.getAttribute("data-id"), "r1");
    assert.equal(scene.querySelector(".mi-icon use")?.getAttribute("href"), "#i-plus");
    const down = (target: Element) => rowMenuKeydown({ target, key: "ArrowDown", preventDefault() {} } as unknown as KeyboardEvent);
    insert.focus();
    assert.equal(down(insert), true);
    assert.equal(document.activeElement, scene);
    assert.equal(down(scene), true);
    assert.equal(document.activeElement, remove);
  } finally { mounted.dispose(); }
});

test("after-paint callback faults do not hold a successfully drawn screen stale (#513)", () => {
  document.body.innerHTML = '<div id="rows"></div><input id="doc-title">';
  const h = fixture(true);
  const mounted = startRowsRender(h.ports);
  let queued = false;
  let continued = 0;
  const off = mounted.onPainted(() => {
    if (queued) return;
    queued = true;
    h.paint.afterThisPaint(() => { throw new Error("callback failed"); });
    h.paint.afterThisPaint(() => { continued++; });
  });
  try {
    assert.equal(mounted.renderFirstDraw(), true);
    assert.equal(mounted.screenIsStale(), false);
    assert.equal(continued, 1);
    assert.equal(document.body.classList.contains("is-stale-screen"), false);
    assert.ok(document.querySelector('#rows .row[data-id="r1"]'));
  } finally { off(); mounted.dispose(); }
});

test("render mounts without drawing and a disposed queued paint cannot reach the replacement", () => {
  document.body.innerHTML = '<div id="rows"></div><input id="doc-title">';
  const first = fixture();
  const mounted = startRowsRender(first.ports);
  assert.equal(first.tracks(), 0);
  assert.equal(mounted.renderFirstDraw(), true);
  assert.equal(first.tracks(), 1);
  let paints = 0;
  const painted = () => { paints++; };
  const oldOff = mounted.onPainted(painted);
  const listeners = mounted.screenListeners();
  mounted.renderFirstDraw();
  const second = fixture();
  let replacement = mounted;
  paints = 0;
  first.paint.whileShown(() => {
    listeners.session({ kind: "amend", changes: changeSet({ cells: [{ rowId: "r1", field: "status" }] }) });
    mounted.dispose();
    replacement = startRowsRender(second.ports);
  });
  assert.equal(second.tracks(), 0);
  const replacementOff = replacement.onPainted(painted);
  oldOff();
  oldOff();
  mounted.dispose();
  assert.equal(replacement.renderFirstDraw(), true);
  assert.equal(second.tracks(), 1);
  assert.equal(paints, 2);
  replacementOff();
  replacement.renderFirstDraw();
  assert.equal(paints, 2, "the replacement subscriber owns its own cleanup");
  replacement.dispose();
});

test("disposing a stale screen removes its event gate and retires the retained Redraw action", () => {
  document.body.innerHTML = '<div id="rows"></div><input id="doc-title">';
  const first = fixture();
  let redraw = () => {};
  const failure = new Error("draw failure");
  const ports: RowsRenderPorts = {
    ...first.ports,
    undo: { track: () => { throw failure; } },
    notices: {
      ...first.ports.notices,
      showAction: (_message, _kind, _label, action) => {
        redraw = action;
        const notice = document.createElement("div");
        notice.innerHTML = '<button class="toast-action">Redraw</button>';
        document.body.appendChild(notice);
        return Object.assign(notice, { dismiss: () => { notice.remove(); } });
      }
    }
  };
  const mounted = startRowsRender(ports);
  const oldError = console.error;
  console.error = () => {};
  try { assert.equal(mounted.renderFirstDraw(), false); } finally { console.error = oldError; }
  const target = document.getElementById("rows");
  assert.ok(target);
  const blocked = new window.Event("keydown", { bubbles: true, cancelable: true });
  target.dispatchEvent(blocked);
  assert.equal(blocked.defaultPrevented, true);
  mounted.dispose();
  const allowed = new window.Event("keydown", { bubbles: true, cancelable: true });
  target.dispatchEvent(allowed);
  assert.equal(allowed.defaultPrevented, false);
  assert.equal(target.hasAttribute("inert"), false);
  const second = fixture();
  const replacement = startRowsRender(second.ports);
  redraw();
  assert.equal(second.tracks(), 0);
  replacement.dispose();
});
