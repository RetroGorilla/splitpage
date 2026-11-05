import { test } from "node:test";
import assert from "node:assert/strict";
import { addSceneCommand, moveSceneCommand, removeSceneCommand, renameSceneCommand } from "../../src/application/commands/scenes.ts";
import { deleteBeatCommand, moveBeatCommand, swapBeatsCommand } from "../../src/application/commands/rows.ts";
import { removeBeatsCommand } from "../../src/application/commands/beats.ts";
import { joinBeatsCommand } from "../../src/application/commands/split-join.ts";
import { createUndoHistory, diffStates } from "../../src/application/editing/undo/history.ts";
import { sceneForBeat, scenesInOrder } from "../../src/core/document/scenes.ts";
import { harness, runConfined } from "./session-fakes.ts";
import type { Harness } from "./session-fakes.ts";
import type { DocumentShape } from "../../src/core/document/validated.ts";

function opened(): Harness {
  const h = harness();
  h.session.adopt({ title: "Sections", rows: ["a", "b", "c", "d", "e"].map(id => ({ id })),
    sections: [{ id: "s1", name: "Opening", firstSceneId: "b" }, { id: "s2", name: "Ending", firstSceneId: "d" }] });
  h.log.length = 0;
  return h;
}

function snapshot(h: Harness): DocumentShape {
  return h.session.read(doc => JSON.parse(JSON.stringify(doc)) as DocumentShape);
}

test("sections: add, rename and remove are confined single transactions and keep all scenes", () => {
  const h = opened();
  const rows = snapshot(h).rows;
  assert.equal(runConfined(h.session, addSceneCommand("c", "middle", " Middle ")).kind, "applied");
  assert.equal(runConfined(h.session, renameSceneCommand("middle", "The middle")).kind, "applied");
  assert.equal(sceneForBeat(snapshot(h), "c")?.name, "The middle");
  assert.equal(runConfined(h.session, removeSceneCommand("middle")).kind, "applied");
  assert.equal(sceneForBeat(snapshot(h), "c")?.id, "s1");
  assert.deepEqual(snapshot(h).rows, rows.map(row => row.id === "c" ? { ...row, paragraphStart: true } : row));
  assert.equal(h.log.filter(item => item === "undo.record").length, 3);
  assert.equal(runConfined(h.session, removeSceneCommand("s1")).kind, "applied");
  assert.equal(sceneForBeat(snapshot(h), "b"), undefined);
  assert.equal(sceneForBeat(snapshot(h), "c"), undefined);
});

test("sections: invalid, duplicate and unchanged operations are no-ops", () => {
  const h = opened();
  const before = snapshot(h);
  for (const command of [addSceneCommand("b", "s3", "Duplicate"), addSceneCommand("gone", "s3", "Missing"),
    renameSceneCommand("s1", "Opening"), renameSceneCommand("s1", "  "), removeSceneCommand("gone")]) {
    assert.equal(runConfined(h.session, command).kind, "noop");
  }
  assert.deepEqual(snapshot(h), before);
  assert.deepEqual(h.log, []);
});

test("sections: deleting or moving the first scene advances the boundary; the last removal drops it", () => {
  const h = opened();
  assert.equal(runConfined(h.session, moveBeatCommand("b", "e", true)).kind, "applied");
  assert.equal(sceneForBeat(snapshot(h), "b")?.id, "s2");
  assert.equal(scenesInOrder(snapshot(h))?.[0]?.firstSceneId, "c");
  assert.equal(runConfined(h.session, deleteBeatCommand("c")).kind, "applied");
  assert.deepEqual(scenesInOrder(snapshot(h))?.map(scene => scene.id), ["s2"]);
});

test("sections: an explicit drop after a header can become its first scene, and swaps reassign scenes", () => {
  const h = opened();
  assert.equal(runConfined(h.session, moveBeatCommand("a", "b", false, "s1")).kind, "applied");
  assert.equal(scenesInOrder(snapshot(h))?.[0]?.firstSceneId, "a");
  assert.equal(runConfined(h.session, swapBeatsCommand("c", 1)).kind, "applied");
  assert.equal(sceneForBeat(snapshot(h), "c")?.id, "s2");
});

test("sections: a group move carries every scene and leaves the unsectioned prefix in place", () => {
  const h = opened();
  assert.equal(runConfined(h.session, moveSceneCommand("s2", "s1", false)).kind, "applied");
  assert.deepEqual(snapshot(h).rows.map(row => row.id), ["a", "d", "e", "b", "c"]);
  assert.deepEqual(scenesInOrder(snapshot(h))?.map(scene => scene.id), ["s2", "s1"]);
  assert.equal(h.log.filter(item => item === "undo.record").length, 1);
});

test("sections: undo restores a removed header and its name in one step; redo removes only the header", () => {
  const h = opened();
  const before = snapshot(h);
  runConfined(h.session, removeSceneCommand("s1"));
  const after = snapshot(h);
  const steps = diffStates(before, after);
  assert.equal(steps.length, 2);
  const history = createUndoHistory(() => []);
  history.record(steps, 0);
  assert.equal(history.undo(after).ok, true);
  assert.deepEqual(after.sections, before.sections);
  assert.deepEqual(after.rows, before.rows);
  assert.equal(history.redo(after).ok, true);
  assert.deepEqual(after.sections, snapshot(h).sections);
  assert.deepEqual(after.rows, snapshot(h).rows);
});

test("sections: bulk deletion advances boundaries and a join cannot silently remove a header", () => {
  const h = opened();
  const before = snapshot(h);
  const outcome = runConfined(h.session, joinBeatsCommand("c", {
    clock: { nowIso: () => "2030-01-01T00:00:00.000Z" }, editor: { name: () => "Adam" }, cells: () => [], plainText: () => ""
  }));
  assert.equal(outcome.kind, "rejected");
  assert.deepEqual(snapshot(h), before);
  assert.equal(runConfined(h.session, removeBeatsCommand(["a", "b", "d"])).kind, "applied");
  assert.deepEqual(scenesInOrder(snapshot(h))?.map(scene => scene.firstSceneId), ["c", "e"]);
  assert.equal(runConfined(h.session, removeBeatsCommand(["c", "e"])).kind, "applied");
  assert.equal("sections" in snapshot(h), false);
});

test("sections: undo after an unrelated merged edit retains that edit; a changed header is not overwritten", () => {
  const h = opened();
  const before = snapshot(h);
  runConfined(h.session, removeSceneCommand("s1"));
  const live = snapshot(h);
  const history = createUndoHistory(() => []);
  history.record(diffStates(before, live), 0);
  const first = live.rows[0];
  assert.ok(first);
  first.audioText = "Incoming text";
  assert.equal(history.undo(live).ok, true);
  assert.equal(live.rows[0]?.audioText, "Incoming text");
  assert.deepEqual(live.sections, before.sections);
  live.sections = [{ id: "s1", name: "Incoming name", firstSceneId: "b" }];
  assert.equal(history.redo(live).ok, false);
  assert.deepEqual(live.sections, [{ id: "s1", name: "Incoming name", firstSceneId: "b" }]);
});
