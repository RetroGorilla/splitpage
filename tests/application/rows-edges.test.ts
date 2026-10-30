import { test } from "node:test";
import assert from "node:assert/strict";
import { addSceneCommand, deleteSceneCommand, isBlankScene, moveSceneCommand, swapScenesCommand } from "../../src/application/commands/rows.ts";
import type { StampPorts } from "../../src/application/session/ports.ts";
import { createRichText } from "../../src/adapters/richtext/richtext.ts";
import { createImageIngestion } from "../../src/core/document/media.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import { jsdomParser } from "../adapters/richtext/jsdom.mjs";
import { countingIds } from "../core/migrate-ports.ts";
import { idsIn, liveOf, planOf, rowsOf, viewOf } from "./plan-views.ts";

const stamps: StampPorts = {
  clock: { nowIso: function () { return "2026-10-30T10:00:00.000Z"; } },
  editor: { name: function () { return "Adam"; } }
};

test("row commands are named and need edit capability", () => {
  const named = [
    addSceneCommand(null, "n1", stamps),
    deleteSceneCommand("r1"),
    moveSceneCommand("r1", "r2", true),
    swapScenesCommand("r1", 1)
  ].map(function (c) { return [c.name, c.needs]; });
  assert.deepEqual(named, [["add-scene", "edit"], ["delete-scene", "edit"], ["move-scene", "edit"], ["swap-scenes", "edit"]]);
});

test("adding below a scene that left before the write fails, naming the scene, and writes nothing", () => {
  const planned = planOf(addSceneCommand("r2", "n1", stamps), viewOf({ rows: rowsOf(["r1", "r2"]) }));
  const live = liveOf({ rows: rowsOf(["r1"]) });
  assert.throws(() => planned.apply(live), { message: "scene r2 left the document before it was given a scene below it" });
  assert.deepEqual(idsIn(live), ["r1"]);
});

test("deleting a scene that left before the write fails, naming the scene, and removes nothing", () => {
  const planned = planOf(deleteSceneCommand("r2"), viewOf({ rows: rowsOf(["r1", "r2"]) }));
  const live = liveOf({ rows: rowsOf(["r1", "r3"]) });
  assert.throws(() => planned.apply(live), { message: "scene r2 left the document before it was deleted" });
  assert.deepEqual(idsIn(live), ["r1", "r3"]);
});

const THREE = ["r1", "r2", "r3"];

test("a move or swap whose scene left before the write fails, naming it, and leaves the order alone", () => {
  const plans = [
    planOf(moveSceneCommand("r1", "r3", true), viewOf({ rows: rowsOf(THREE) })),
    planOf(swapScenesCommand("r1", 1), viewOf({ rows: rowsOf(THREE) }))
  ];
  plans.forEach(function (planned) {
    const live = liveOf({ rows: rowsOf(["r1", "r3", "r9"]) });
    assert.throws(() => planned.apply(live), { message: "scene r2 left the document before the scenes were reordered" });
    assert.deepEqual(idsIn(live), ["r1", "r3", "r9"]);
  });
});

test("a move or swap whose scenes gained a neighbour before the write fails and leaves the order alone", () => {
  const plans = [
    planOf(moveSceneCommand("r1", "r3", true), viewOf({ rows: rowsOf(THREE) })),
    planOf(swapScenesCommand("r1", 1), viewOf({ rows: rowsOf(THREE) }))
  ];
  plans.forEach(function (planned) {
    const live = liveOf({ rows: rowsOf(["r1", "r2", "r3", "r9"]) });
    assert.throws(() => planned.apply(live), { message: "the scenes changed before they were reordered" });
    assert.deepEqual(idsIn(live), ["r1", "r2", "r3", "r9"]);
  });
});

test("a move or swap writes exactly the order it planned", () => {
  const moved = liveOf({ rows: rowsOf(THREE) });
  planOf(moveSceneCommand("r1", "r3", true), viewOf({ rows: rowsOf(THREE) })).apply(moved);
  assert.deepEqual(idsIn(moved), ["r2", "r3", "r1"]);
  const swapped = liveOf({ rows: rowsOf(THREE) });
  planOf(swapScenesCommand("r2", 1), viewOf({ rows: rowsOf(THREE) })).apply(swapped);
  assert.deepEqual(idsIn(swapped), ["r1", "r3", "r2"]);
});

const rt = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(function () { return null; }), ids: countingIds() });
const text = { cellOf: rt.createCellReader(deepFreeze, { media: true }) };

type Row = Parameters<typeof isBlankScene>[1];

function row(fields: Record<string, unknown>): Row {
  return { id: "r1", visualText: "", audioText: "", status: "todo", ...fields } as unknown as Row;
}

function blank(fields: Record<string, unknown>, comments?: unknown[]): boolean {
  return isBlankScene(viewOf(comments ? { comments: comments } : {}), row(fields), text);
}

test("a cell that is missing or null is read as empty text, never handed to the reader as it is", () => {
  const seen: unknown[] = [];
  const reader: typeof text = {
    cellOf: function (html: unknown) {
      seen.push(html);
      return deepFreeze([{ text: String(html), marks: {} }]);
    }
  };
  assert.equal(isBlankScene(viewOf({}), row({ visualText: undefined, audioText: null }), reader), true);
  assert.deepEqual(seen, ["", ""]);
});

test("a scene with no row is not blank", () => {
  assert.equal(isBlankScene(viewOf({}), null, text), false);
  assert.equal(isBlankScene(viewOf({}), undefined, text), false);
});

test("a scene with nothing in it is blank, however its empty cells are stored", () => {
  assert.equal(blank({}), true);
  assert.equal(blank({ visualText: "   ", audioText: "  " }), true);
  assert.equal(blank({ visualText: undefined, audioText: undefined }), true);
  assert.equal(blank({ visualText: null, audioText: null }), true);
  assert.equal(blank({ moreImages: [], imageLinks: [], imageRef: null }), true);
});

test("text in either cell makes a scene not blank, whitespace around it or not", () => {
  assert.equal(blank({ visualText: "Wide" }), false);
  assert.equal(blank({ audioText: "Every morning." }), false);
  assert.equal(blank({ visualText: " Wide " }), false);
  assert.equal(blank({ visualText: "Wide", audioText: "Every morning." }), false);
  assert.equal(blank({ visualText: " Wide " }), false);
});

test("a picture, a second picture, a link or a length makes a scene not blank", () => {
  assert.equal(blank({ imageRef: { kind: "blob", id: "b1" } }), false);
  assert.equal(blank({ moreImages: [{ kind: "blob", id: "b1" }] }), false);
  assert.equal(blank({ imageLinks: [{ href: "https://example.com/a.png" }] }), false);
  assert.equal(blank({ lengthSeconds: 12 }), false);
  assert.equal(blank({ lengthSeconds: 0 }), false);
});

test("a comment on the scene makes it not blank, a comment on another scene does not", () => {
  const mine = { id: "c1", rowId: "r1", field: "audioText", body: "Tighter", replies: [] };
  const other = { id: "c2", rowId: "r2", field: "audioText", body: "Tighter", replies: [] };
  assert.equal(blank({}, [mine]), false);
  assert.equal(blank({}, [other]), true);
  assert.equal(blank({}, [other, mine]), false);
  assert.equal(blank({}, [null, other]), true);
  assert.equal(blank({}, []), true);
});
