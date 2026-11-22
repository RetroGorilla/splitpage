import { test } from "node:test";
import assert from "node:assert/strict";
import { beatAt, beatLengthCommand } from "../../src/application/commands/beat-length.ts";
import { beatStatusCommand, setBeatFilmedCommand } from "../../src/application/commands/beat-status.ts";
import { targetLengthCommand, wordsPerMinuteCommand } from "../../src/application/commands/document-settings.ts";
import type { StampPorts } from "../../src/application/session/ports.ts";
import { MAY_EDIT, liveOf, planOf, rowsOf, viewOf } from "./plan-views.ts";

const stamps: StampPorts = {
  clock: { nowIso: function () { return "2026-10-30T10:00:00.000Z"; } },
  editor: { name: function () { return "Adam"; } }
};

test("the length and status commands are named and need edit capability", () => {
  const length = beatLengthCommand("r1", 5, stamps);
  const status = beatStatusCommand("r1", stamps);
  assert.deepEqual([length.name, length.needs], ["set-scene-length", "edit"]);
  assert.deepEqual([status.name, status.needs], ["cycle-scene-status", "edit"]);
});

test("the scene a length reads from is a frozen copy, not the live row", () => {
  const doc = viewOf({ rows: rowsOf(["r1", "r2"], { lengthSeconds: 7 }) });
  const found = beatAt("r2")(doc);
  assert.ok(found);
  assert.equal(Object.isFrozen(found), true);
  assert.equal(Object.isFrozen(found.row), true);
  assert.equal(found.index, 1);
  assert.equal(found.row === doc.rows[1], false);
  assert.deepEqual(found.row, doc.rows[1]);
});

test("a stored length that is not a usable number counts as no length when deciding whether anything changes", () => {
  const clear = beatLengthCommand("r1", null, stamps);
  [-5, "12", Number.NaN, Infinity, 100000000].forEach(function (stored) {
    const doc = viewOf({ rows: rowsOf(["r1"], { lengthSeconds: stored }) });
    assert.equal(clear.plan(doc, MAY_EDIT), null, "stored " + String(stored));
  });
  assert.equal(clear.plan(viewOf({ rows: rowsOf(["r1"], { lengthSeconds: 12 }) }), MAY_EDIT) !== null, true);
});

test("a length write whose scene left before it fails, naming the scene, and writes nothing", () => {
  const planned = planOf(beatLengthCommand("r1", 9, stamps), viewOf({ rows: rowsOf(["r1"]) }));
  const live = liveOf({ rows: rowsOf(["r2"]) });
  assert.throws(() => planned.apply(live), { message: "scene r1 left the document before its length was set" });
  assert.equal("lengthSeconds" in (live.rows[0] ?? {}), false);
});

test("a status write whose scene left before it fails, naming the scene, and writes nothing", () => {
  const planned = planOf(beatStatusCommand("r1", stamps), viewOf({ rows: rowsOf(["r1"]) }));
  const live = liveOf({ rows: rowsOf(["r2"]) });
  assert.throws(() => planned.apply(live), { message: "scene r1 left the document before its status was set" });
  assert.equal(live.rows[0]?.status, "todo");
});

test("unchanged standalone beat fields and document settings plan no edit", () => {
  const doc = viewOf({ rows: rowsOf(["R1"], { lengthSeconds: 5, status: "todo" }), targetSeconds: 60, wordsPerMinute: 150 });
  for (const command of [beatStatusCommand("R9", stamps), setBeatFilmedCommand("R1", false, stamps), beatLengthCommand("R1", 5, stamps),
    targetLengthCommand(60), wordsPerMinuteCommand(150), wordsPerMinuteCommand(20)]) {
    assert.equal(command.plan(doc, MAY_EDIT), null, command.name);
  }
});
