import { test } from "node:test";
import assert from "node:assert/strict";
import { cellRuns, cellTextCommand } from "../../src/application/commands/cell-text.ts";
import type { CellRecords } from "../../src/application/commands/cell-text.ts";
import type { CellTextPorts } from "../../src/application/session/ports.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import { toHtml } from "../../src/core/text/html.ts";
import type { Marks, Run } from "../../src/core/text/runs.ts";
import { REVIEW_ONLY, liveOf, planOf, rowsOf, viewOf } from "./plan-views.ts";

function run(text: string, marks: Marks = {}): Run {
  return { text: text, marks: marks };
}

const ports: CellTextPorts = {
  clock: { nowIso: function () { return "2026-10-30T10:00:00.000Z"; } },
  editor: { name: function () { return "Adam"; } },
  cells: function (html: string) {
    assert.equal(typeof html, "string", "the decoder is only ever given stored text");
    return deepFreeze([run(html)]);
  }
};

function oneRow(fields: Record<string, unknown>): ReturnType<typeof viewOf> {
  return viewOf({ rows: rowsOf(["r1"], fields) });
}

test("the cell command is named, needs nothing up front, and its runs value is frozen", () => {
  const command = cellTextCommand("r1", "audioText", cellRuns([]), ports);
  assert.deepEqual([command.name, command.needs], ["set-cell-text", "nothing"]);
  assert.equal(Object.isFrozen(cellRuns([run("x")])), true);
});

test("a cell made only of commented words still counts as moving its comment anchors", () => {
  const text = cellRuns([run("Every morning.", { cmt: ["c9"] })]);
  const planned = planOf(cellTextCommand("r1", "audioText", text, ports), oneRow({ audioText: "Every morning." }));
  assert.equal(planned.changes.runsMoved, true);
});

test("a stored cell that is not text gives the review check nothing to decode, so it is refused", () => {
  const command = cellTextCommand("r1", "audioText", cellRuns([]), ports);
  assert.deepEqual(command.plan(viewOf({ rows: [{ id: "r1" }] }), REVIEW_ONLY), { refused: "review" });
});

test("a scene that left before the write fails, naming the scene, and writes nothing", () => {
  const command = cellTextCommand("r1", "audioText", cellRuns([run("Changed")]), ports);
  const planned = planOf(command, oneRow({ audioText: "Before" }));
  const live = liveOf({ rows: rowsOf(["r2"]) });
  assert.throws(() => planned.apply(live), { message: "scene r1 left the document before its text was set" });
  assert.equal(live.rows[0]?.audioText, "");
});

test("a shot record with no id, or one repeated in the same edit, is written at most once", () => {
  const shots: CellRecords = {
    shots: [
      { id: "", audioRef: "Steam", location: "Kitchen" },
      { id: "bs1", audioRef: "Steam", location: "Kitchen" },
      { id: "bs1", audioRef: "Other", location: "Hall" }
    ]
  };
  const command = cellTextCommand("r1", "audioText", cellRuns([run("Changed")]), ports, shots);
  const live = liveOf({ rows: rowsOf(["r1"]) });
  planOf(command, oneRow({ audioText: "Before" })).apply(live);
  assert.deepEqual(live.brollShots.map(function (s) { return s.id + "<" + String(s.audioRef) + "@" + String(s.location); }), ["bs1<Steam@Kitchen"]);
});

test("a shot the document already holds is not written again, and one with no id in the document does not hide others", () => {
  const command = cellTextCommand("r1", "audioText", cellRuns([run("Changed")]), ports, { shots: [{ id: "bs1", audioRef: "A", location: "B" }] });
  const held = viewOf({ rows: rowsOf(["r1"], { audioText: "Before" }), brollShots: [{ id: "" }, { id: "bs1" }] });
  assert.equal(planOf(command, held).changes.docFields.length, 0);
  const free = viewOf({ rows: rowsOf(["r1"], { audioText: "Before" }), brollShots: [{ id: "" }] });
  assert.deepEqual(planOf(command, free).changes.docFields, ["brollShots"]);
});

test("each application of a plan writes its own copy of the records, so no two documents share one", () => {
  const records: CellRecords = {
    tags: [{ cat: "prop", name: "Mug" }],
    shots: [{ id: "bs1", audioRef: "Steam", location: "Kitchen" }]
  };
  const command = cellTextCommand("r1", "audioText", cellRuns([run("Mug")]), ports, records);
  const planned = planOf(command, oneRow({ audioText: "Before" }));
  const first = liveOf({ rows: rowsOf(["r1"]) });
  const second = liveOf({ rows: rowsOf(["r1"]) });
  planned.apply(first);
  planned.apply(second);
  assert.equal(first.productionTags[0] === second.productionTags[0], false);
  assert.equal(first.brollShots[0] === second.brollShots[0], false);
  assert.equal(first.brollShots[0]?.props === second.brollShots[0]?.props, false);
  const tag = first.productionTags[0];
  const shot = first.brollShots[0];
  assert.ok(tag && shot);
  tag.name = "Changed";
  shot.props?.push({ id: "p1" });
  assert.equal(second.productionTags[0]?.name, "Mug");
  assert.deepEqual(second.brollShots[0]?.props, []);
  assert.equal(second.rows[0]?.audioText, toHtml([run("Mug")]));
});
