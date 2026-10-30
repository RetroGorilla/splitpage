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

function fixture() {
  const doc = fakeDocument(migrateRows({ title: "Render mount", rows: [] }, fakeMigration().ports));
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
    hiding: () => ({ groups: () => [] }),
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
