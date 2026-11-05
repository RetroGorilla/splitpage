import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBeatsCommand, splitBeatCommand, textCut } from "../../src/application/commands/split-join.ts";
import type { JoinPorts } from "../../src/application/commands/split-join.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import type { Run } from "../../src/core/text/runs.ts";
import { idsIn, liveOf, planOf, viewOf } from "./plan-views.ts";

const ports: JoinPorts = {
  clock: { nowIso: function () { return "2026-10-30T10:00:00.000Z"; } },
  editor: { name: function () { return "Adam"; } },
  cells: function (html: string) { return deepFreeze([{ text: html, marks: {} } as Run]); },
  plainText: function (html: string | null | undefined) { return html || ""; }
};

function rows(spec: readonly [string, string, string][]): Record<string, unknown>[] {
  return spec.map(function ([id, visual, audio]) { return { id: id, visualText: visual, audioText: audio, status: "todo" }; });
}

test("split and join are named and need edit capability", () => {
  const split = splitBeatCommand("r1", "audioText", textCut(0, 0), "n1", ports);
  const join = joinBeatsCommand("r1", ports);
  assert.deepEqual([split.name, split.needs], ["split-scene", "edit"]);
  assert.deepEqual([join.name, join.needs], ["join-scenes", "edit"]);
});

test("a split whose scene left before the write fails, naming the scene, and adds nothing", () => {
  const planned = planOf(splitBeatCommand("r1", "audioText", textCut(2, 2), "n1", ports), viewOf({ rows: rows([["r1", "V", "Hello"]]) }));
  const live = liveOf({ rows: rows([["r2", "V", "Hello"]]) });
  assert.throws(() => planned.apply(live), { message: "scene r1 left the document before it was split" });
  assert.deepEqual(idsIn(live), ["r2"]);
});

test("a join whose scenes changed before the write fails, naming the scene, and removes nothing", () => {
  const planned = planOf(joinBeatsCommand("r1", ports), viewOf({ rows: rows([["r1", "", "One."], ["r2", "", "Two."]]) }));
  const gone = liveOf({ rows: rows([["r0", "", "Zero."]]) });
  assert.throws(() => planned.apply(gone), { message: "scenes r1 changed before they were joined" });
  assert.deepEqual(idsIn(gone), ["r0"]);
  const alone = liveOf({ rows: rows([["r0", "", "Zero."], ["r1", "", "One."]]) });
  assert.throws(() => planned.apply(alone), { message: "scenes r1 changed before they were joined" });
  assert.deepEqual(idsIn(alone), ["r0", "r1"]);
  assert.equal(alone.rows[1]?.audioText, "One.");
});

test("a status that is not a string ranks as todo, so a join neither declares nor copies it", () => {
  const view = viewOf({ rows: [{ id: "r1", visualText: "", audioText: "One.", status: "todo" }, { id: "r2", visualText: "", audioText: "Two.", status: ["shot"] }] });
  const planned = planOf(joinBeatsCommand("r1", ports), view);
  assert.equal(planned.changes.cells.some(function (c) { return c.field === "status"; }), false);
  const live = liveOf({ rows: [{ id: "r1", visualText: "", audioText: "One.", status: "todo" }, { id: "r2", visualText: "", audioText: "Two.", status: ["shot"] }] });
  planned.apply(live);
  assert.equal(live.rows[0]?.status, "todo");
  const raised = planOf(joinBeatsCommand("r1", ports), viewOf({ rows: rows([["r1", "", "One."], ["r2", "", "Two."]]).map(function (r, i) { return { ...r, status: i ? "shot" : "todo" }; }) }));
  assert.equal(raised.changes.cells.some(function (c) { return c.field === "status"; }), true);
});
