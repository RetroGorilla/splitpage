import { test } from "node:test";
import assert from "node:assert/strict";
import { createCellEditing } from "../../../src/application/editing/cell-editing.ts";
import type { CellEditing, CellRange, ShownRow } from "../../../src/application/editing/cell-editing.ts";
import type { CellTextPorts } from "../../../src/application/session/ports.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { harness } from "../session-fakes.ts";

const STAMP = "2026-10-22T12:00:00.000Z";

interface Cell {
  rowId: string | null;
  field: string | null;
  shown: string;
  attached: boolean;
  sel: CellRange | null;
}

interface Rig {
  h: ReturnType<typeof harness>;
  editing: CellEditing<Cell>;
  calls: string[];
  painted: { cell: Cell; field: string; row: ShownRow }[];
  announced: { message: string; before: unknown }[];
  refused: string[];
  set: (flags: { stale?: boolean; applying?: boolean }) => void;
}

function plain(html: string): Run[] {
  return normalizeCell(html ? [{ text: html, marks: {} }] : []);
}

function textPorts(failing = false): CellTextPorts {
  return {
    clock: { nowIso: function () { if (failing) throw new Error("no clock"); return STAMP; } },
    editor: { name: function () { return "Adam"; } },
    cells: function (h: string) { return deepFreeze(plain(h)); }
  };
}

function script(): Record<string, unknown> {
  return {
    title: "Cells",
    docId: "d" + "3".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Every morning.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Nets.", status: "todo", imageLinks: [{ href: "https://youtu.be/abc" }] },
      { id: "r3", visualText: "Card", audioText: 'Hi <a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>', status: "todo" }
    ],
    comments: []
  };
}

function rig(opts: { failing?: boolean } = {}): Rig {
  const h = harness();
  h.session.adopt(script());
  h.log.length = 0;
  h.published.length = 0;
  const calls: string[] = [];
  const painted: Rig["painted"] = [];
  const announced: Rig["announced"] = [];
  const refused: string[] = [];
  const flags = { stale: false, applying: false };
  let entries = 0;
  const editing = createCellEditing<Cell>({
    page: {
      address: function (cell) { return { rowId: cell.rowId, field: cell.field }; },
      attached: function (cell) { return cell.attached; },
      html: function (cell) { calls.push("page.html"); return cell.shown; },
      selection: function (cell) { return cell.sel; },
      write: function (cell, html) { calls.push("page.write"); cell.shown = html; },
      focus: function (cell, sel) { calls.push("page.focus"); cell.sel = sel || null; }
    },
    document: function () { return h.session.read(function (doc) { return doc; }); },
    run: function (command) {
      calls.push("run:" + command.name);
      const outcome = h.session.run(command);
      if (outcome.kind === "applied" || outcome.kind === "committed") entries++;
      return outcome;
    },
    text: textPorts(opts.failing),
    decode: { text: plain, withMedia: plain },
    undo: {
      applying: function () { return flags.applying; },
      breakCoalescing: function () { calls.push("undo.break"); },
      flush: function () { calls.push("undo.flush"); },
      latest: function () { return "entry" + entries; }
    },
    stale: function () { return flags.stale; },
    painted: function (cell, field, row) { calls.push("painted"); painted.push({ cell: cell, field: field, row: row }); },
    redraw: function () { calls.push("redraw"); },
    announce: function (message, before) { announced.push({ message: message, before: before }); },
    refused: function (reason) { refused.push(reason); }
  });
  return {
    h: h,
    editing: editing,
    calls: calls,
    painted: painted,
    announced: announced,
    refused: refused,
    set: function (next) { Object.assign(flags, next); }
  };
}

function cell(rowId: string | null, field: string | null, shown: string, sel: CellRange | null = null): Cell {
  return { rowId: rowId, field: field, shown: shown, attached: true, sel: sel };
}

function fieldOf(r: Rig, rowId: string, field: "visualText" | "audioText"): unknown {
  return r.h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (x) { return x.id === rowId; });
    return row ? row[field] : undefined;
  });
}

test("a sync stores what the cell shows and tells the screen the row it now holds", () => {
  const r = rig();
  const c = cell("r1", "audioText", "Every evening.");
  r.editing.sync(c);
  assert.equal(fieldOf(r, "r1", "audioText"), "Every evening.");
  assert.deepEqual(r.calls, ["page.html", "run:set-cell-text", "painted"]);
  assert.equal(r.painted.length, 1);
  assert.equal(r.painted[0]?.field, "audioText");
  assert.equal(r.painted[0]?.row.id, "r1");
  assert.equal(r.painted[0]?.row.audioText, "Every evening.", "the row handed over is the one after the edit");
  assert.equal(r.h.session.generation(), 1);
});

test("a sync does nothing for a detached cell, during an undo replay, on a stale screen, or for a scene that is gone", () => {
  const r = rig();
  const gone = cell("r1", "audioText", "Detached");
  gone.attached = false;
  r.editing.sync(gone);
  r.set({ applying: true });
  r.editing.sync(cell("r1", "audioText", "Replaying"));
  r.set({ applying: false, stale: true });
  r.editing.sync(cell("r1", "audioText", "Stale"));
  r.set({ stale: false });
  r.editing.sync(cell("r9", "audioText", "Missing"));
  assert.deepEqual(r.calls, []);
  assert.equal(r.h.session.generation(), 0);
  assert.equal(fieldOf(r, "r1", "audioText"), "Every morning.");
});

test("a sync whose command fails throws the failure", () => {
  const r = rig({ failing: true });
  assert.throws(function () { r.editing.sync(cell("r1", "audioText", "Every evening.")); }, /no clock/);
  assert.deepEqual(r.painted, []);
});

test("opening a cell syncs it first, reads the stored text, keeps the selection and breaks undo coalescing", () => {
  const r = rig();
  const c = cell("r1", "visualText", "Wider", { from: 1, to: 3 });
  const opened = r.editing.open(c);
  assert.deepEqual(opened, { rowId: "r1", field: "visualText", html: "Wider", sel: { from: 1, to: 3 } });
  assert.deepEqual(r.calls, ["page.html", "run:set-cell-text", "painted", "undo.break"]);
});

test("opening refuses a stale screen, a missing scene, a field that is not script text, and a cell holding media", () => {
  const r = rig();
  r.set({ stale: true });
  assert.equal(r.editing.open(cell("r1", "audioText", "Every morning.")), null);
  r.set({ stale: false });
  assert.equal(r.editing.open(cell("r9", "audioText", "x")), null);
  assert.equal(r.editing.open(cell("r1", "title", "x")), null);
  assert.equal(r.editing.open(cell("r1", null, "x")), null);
  assert.equal(r.calls.length, 0, "nothing was synced for those");
  const media = cell("r3", "audioText", 'Hi <a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>');
  r.calls.length = 0;
  assert.equal(r.editing.open(media), null);
  assert.ok(!r.calls.includes("undo.break"), "a refused media cell does not break coalescing");
});

test("an edit runs one cell-text command, then writes the cell, syncs it, puts the selection back and closes the undo step", () => {
  const r = rig();
  const c = cell("r1", "audioText", "Every morning.", { from: 0, to: 5 });
  const out = r.editing.edit(c, function (runs, sel) {
    assert.deepEqual(sel, { from: 0, to: 5 });
    assert.equal(runs.map(function (x) { return x.text; }).join(""), "Every morning.");
    return { cell: plain("Each morning."), sel: { from: 4, to: 4 } };
  });
  assert.equal(out, c);
  assert.equal(c.shown, "Each morning.");
  assert.deepEqual(c.sel, { from: 4, to: 4 });
  assert.equal(fieldOf(r, "r1", "audioText"), "Each morning.");
  assert.deepEqual(r.calls, [
    "page.html", "run:set-cell-text", "painted", "undo.break",
    "run:set-cell-text",
    "page.write", "page.html", "run:set-cell-text", "painted", "page.focus", "undo.flush", "undo.break"
  ]);
  assert.equal(r.h.session.generation(), 1, "the edit is one generation; the syncs around it change nothing");
});

test("an edit that returns nothing changes nothing and leaves the cell alone", () => {
  const r = rig();
  const c = cell("r1", "audioText", "Every morning.");
  assert.equal(r.editing.edit(c, function () { return null; }), null);
  assert.equal(c.shown, "Every morning.");
  assert.ok(!r.calls.includes("page.write"));
  assert.equal(r.h.session.generation(), 0);
});

test("an edit that keeps the text runs no command but still closes the cell", () => {
  const r = rig();
  const c = cell("r1", "audioText", "Every morning.");
  const out = r.editing.edit(c, function (runs, sel) { return { cell: runs, sel: sel }; });
  assert.equal(out, c);
  assert.deepEqual(r.calls.filter(function (x) { return x.startsWith("run:"); }), ["run:set-cell-text", "run:set-cell-text"], "only the two syncs ran");
  assert.ok(r.calls.includes("page.focus"));
  assert.equal(r.h.session.generation(), 0);
});

test("an edit refused in review mode returns nothing and does not touch the cell", () => {
  const r = rig();
  r.h.deny("review");
  const c = cell("r1", "audioText", "Every morning.");
  assert.equal(r.editing.edit(c, function () { return { cell: plain("Changed.") }; }), null);
  assert.equal(c.shown, "Every morning.");
  assert.equal(fieldOf(r, "r1", "audioText"), "Every morning.");
  assert.ok(!r.calls.includes("page.write"));
});

test("an edit whose command fails throws the failure", () => {
  const r = rig({ failing: true });
  const c = cell("r1", "audioText", "Every morning.");
  assert.throws(function () { r.editing.edit(c, function () { return { cell: plain("Changed.") }; }); }, /no clock/);
  assert.equal(c.shown, "Every morning.");
});

test("a gallery edit runs one command, redraws, and announces with the undo entry from before it", () => {
  const r = rig();
  const done = r.editing.editGallery("r2", "Video link removed", function (row) {
    row.imageLinks = [];
    return true;
  });
  assert.equal(done, true);
  assert.deepEqual(r.calls, ["undo.break", "run:gallery-edit", "redraw"]);
  assert.deepEqual(r.announced, [{ message: "Video link removed", before: "entry0" }]);
  assert.equal(r.h.session.generation(), 1);
});

test("a gallery edit for a missing scene, or one that changes nothing, does not redraw or announce", () => {
  const r = rig();
  assert.equal(r.editing.editGallery("r9", "Gone", function () { return true; }), false);
  assert.deepEqual(r.calls, []);
  assert.equal(r.editing.editGallery("r2", "Nothing", function () { return false; }), false);
  assert.deepEqual(r.calls, ["undo.break", "run:gallery-edit"]);
  assert.deepEqual(r.announced, []);
});

test("moving a row runs the move and redraws; a review refusal is reported and nothing redraws", () => {
  const r = rig();
  r.editing.moveRow("r1", "r3", true);
  assert.deepEqual(r.h.session.read(function (doc) { return doc ? doc.rows.map(function (x) { return x.id; }) : []; }), ["r2", "r3", "r1"]);
  assert.deepEqual(r.calls, ["run:move-scene", "redraw"]);
  r.calls.length = 0;
  r.h.deny("review");
  r.editing.moveRow("r1", "r2", false);
  assert.deepEqual(r.refused, ["review"]);
  assert.deepEqual(r.calls, ["run:move-scene"]);
  r.h.deny(null);
  r.calls.length = 0;
  r.editing.moveRow("r1", "r1", true);
  assert.deepEqual(r.calls, ["run:move-scene"], "a move onto itself changes nothing");
});
