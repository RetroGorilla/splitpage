import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { CELL_TEXT_DERIVES } from "../../src/application/commands/cell-text.ts";
import { addSceneCommand, deleteSceneCommand, moveSceneCommand, swapScenesCommand } from "../../src/application/commands/rows.ts";
import type { StampPorts } from "../../src/application/session/ports.ts";
import { harness, runConfined } from "./session-fakes.ts";

const STAMP = "2026-10-15T03:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

function stamps(name = "Adam"): StampPorts {
  return {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { return name; } }
  };
}

function script(): Record<string, unknown> {
  return {
    title: "Rows",
    docId: "d" + "2".repeat(32),
    rows: ["r1", "r2", "r3", "r4"].map(function (id, i) {
      return { id: id, visualText: "V" + (i + 1), audioText: "A" + (i + 1), status: "todo", updatedAt: OLD, updatedBy: "Sam" };
    }),
    comments: [{ id: "c1", rowId: "r2", field: "audioText", body: "Tighter", replies: [] }]
  };
}

function opened(): ReturnType<typeof harness> {
  const h = harness();
  h.session.adopt(script());
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function order(h: ReturnType<typeof harness>): string[] {
  return h.session.read(function (doc) { return doc ? doc.rows.map(function (r) { return r.id; }) : []; });
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function stampsOf(h: ReturnType<typeof harness>): string[] {
  return h.session.read(function (doc) { return doc ? doc.rows.map(function (r) { return String(r.updatedAt); }) : []; });
}

const ONE_EDIT = ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"];

test("rows: adding a scene below another is one generation, one undo record, a stamped blank scene in place", () => {
  const h = opened();
  const out = runConfined(h.session, addSceneCommand("r2", "new1", stamps()));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: changeSet({ rowsInserted: ["new1"] }) });
  assert.deepEqual(h.log, ["reconcile"].concat(ONE_EDIT));
  assert.deepEqual(order(h), ["r1", "r2", "new1", "r3", "r4"]);
  const made = h.session.read(function (doc) { return doc ? JSON.parse(JSON.stringify(doc.rows[2])) as Record<string, unknown> : null; });
  assert.deepEqual(made, { id: "new1", visualText: "", imageRef: null, audioText: "", status: "todo", updatedAt: STAMP, updatedBy: "Adam" });
  assert.deepEqual(stampsOf(h).filter(function (s) { return s === STAMP; }).length, 1, "only the new scene is stamped");
  assert.equal(h.published[0]?.changes.saveNow, false, "adding a blank scene waits for the ordinary autosave, as before");
});

test("rows: adding with no anchor appends at the end", () => {
  const h = opened();
  assert.equal(runConfined(h.session, addSceneCommand(null, "new1", stamps())).kind, "applied");
  assert.deepEqual(order(h), ["r1", "r2", "r3", "r4", "new1"]);
});

test("rows: adding below a scene that has gone is a no-op, not a scene at the top", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, addSceneCommand("gone", "new1", stamps())), { kind: "noop" });
  assert.deepEqual(h.log, []);
  assert.equal(snapshot(h), before);
});

test("rows: deleting a scene is one transaction that also re-points the comments it held", () => {
  const h = opened();
  const out = runConfined(h.session, deleteSceneCommand("r2"));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: changeSet({ rowsRemoved: ["r2"], derive: CELL_TEXT_DERIVES }) });
  assert.deepEqual(h.log, ["reconcile"].concat(ONE_EDIT), "anchors reconcile inside the transaction, before commit");
  assert.deepEqual(order(h), ["r1", "r3", "r4"]);
  assert.deepEqual(stampsOf(h), [OLD, OLD, OLD], "no scene is stamped by a delete");
});

test("rows: deleting a scene that has gone is a no-op", () => {
  const h = opened();
  assert.deepEqual(runConfined(h.session, deleteSceneCommand("gone")), { kind: "noop" });
  assert.deepEqual(h.log, []);
});

test("rows: a drag move is one transaction marked as moved rows, saved at once, with no stamps", () => {
  const h = opened();
  const out = runConfined(h.session, moveSceneCommand("r1", "r3", true));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: changeSet({ rowsMoved: true, derive: CELL_TEXT_DERIVES, saveNow: true }) });
  assert.deepEqual(order(h), ["r2", "r3", "r1", "r4"]);
  assert.equal(h.log.filter(function (l) { return l === "undo.record"; }).length, 1);
  assert.deepEqual(stampsOf(h), [OLD, OLD, OLD, OLD]);
  assert.equal(runConfined(h.session, moveSceneCommand("r4", "r2", false)).kind, "applied");
  assert.deepEqual(order(h), ["r4", "r2", "r3", "r1"]);
});

test("rows: a move that leaves the order as it was is a no-op with no undo entry and no dirty mark", () => {
  const h = opened();
  assert.deepEqual(runConfined(h.session, moveSceneCommand("r2", "r1", true)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, moveSceneCommand("r2", "r3", false)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, moveSceneCommand("r2", "r2", true)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, moveSceneCommand("gone", "r2", true)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, moveSceneCommand("r2", "gone", true)), { kind: "noop" });
  assert.deepEqual(h.log, []);
  assert.deepEqual(order(h), ["r1", "r2", "r3", "r4"]);
});

test("rows: swapping with a neighbour is one transaction; past either end is a no-op", () => {
  const h = opened();
  assert.equal(runConfined(h.session, swapScenesCommand("r2", -1)).kind, "applied");
  assert.deepEqual(order(h), ["r2", "r1", "r3", "r4"]);
  assert.equal(runConfined(h.session, swapScenesCommand("r3", 1)).kind, "applied");
  assert.deepEqual(order(h), ["r2", "r1", "r4", "r3"]);
  assert.equal(h.session.generation(), 2);
  h.log.length = 0;
  assert.deepEqual(runConfined(h.session, swapScenesCommand("r2", -1)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, swapScenesCommand("r3", 1)), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, swapScenesCommand("gone", 1)), { kind: "noop" });
  assert.deepEqual(h.log, []);
});

test("rows: a review copy refuses every row command before it plans, with nothing written", () => {
  const h = opened();
  const before = snapshot(h);
  h.deny("review");
  for (const command of [addSceneCommand("r1", "new1", stamps()), deleteSceneCommand("r1"), moveSceneCommand("r1", "r3", true), swapScenesCommand("r1", 1)]) {
    assert.deepEqual(runConfined(h.session, command), { kind: "rejected", reason: "review" }, command.name);
  }
  assert.deepEqual(h.log, []);
  assert.equal(snapshot(h), before);
});

test("rows: with no document open the row commands are refused", () => {
  const h = harness();
  assert.deepEqual(runConfined(h.session, addSceneCommand(null, "new1", stamps())), { kind: "rejected", reason: NO_DOCUMENT });
  assert.deepEqual(runConfined(h.session, moveSceneCommand("r1", "r2", true)), { kind: "rejected", reason: NO_DOCUMENT });
});

test("rows: a stamp port that throws fails the add and leaves the scenes as they were", () => {
  const h = opened();
  const before = snapshot(h);
  const broken: StampPorts = {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { throw new Error("no editor"); } }
  };
  const out = runConfined(h.session, addSceneCommand("r1", "new1", broken));
  assert.equal(out.kind, "failed");
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
  assert.equal(h.session.generation(), 0);
});
