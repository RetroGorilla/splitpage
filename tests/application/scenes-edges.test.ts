import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENE_PASTE_FIELDS, pasteScenesCommand, removeScenesCommand } from "../../src/application/commands/scenes.ts";
import type { ScenePaste } from "../../src/application/commands/scenes.ts";
import { MAY_EDIT, idsIn, liveOf, planOf, rowsOf, viewOf } from "./plan-views.ts";

function paste(replaced: string | null): ScenePaste {
  return {
    plan: function () { return { inserted: ["n1"], replaced: replaced, title: false, saveNow: false }; },
    apply: function () {}
  };
}

test("scene commands are named and need edit capability", () => {
  const pasted = pasteScenesCommand(paste(null));
  assert.deepEqual([pasted.name, pasted.needs], ["paste-scenes", "edit"]);
  const removed = removeScenesCommand(["r1"]);
  assert.deepEqual([removed.name, removed.needs], ["remove-scenes", "edit"]);
});

test("a paste declares the comment, people, tag and shot lists as document fields, and the list is frozen", () => {
  assert.deepEqual(SCENE_PASTE_FIELDS, ["comments", "people", "productionTags", "brollShots"]);
  assert.equal(Object.isFrozen(SCENE_PASTE_FIELDS), true);
});

test("a paste that replaces a scene the document no longer holds declares no removal", () => {
  const doc = viewOf({ rows: rowsOf(["r1", "r2"]) });
  assert.deepEqual(planOf(pasteScenesCommand(paste("gone")), doc).changes.rowsRemoved, []);
  assert.deepEqual(planOf(pasteScenesCommand(paste("r2")), doc).changes.rowsRemoved, ["r2"]);
  assert.deepEqual(planOf(pasteScenesCommand(paste(null)), doc).changes.rowsRemoved, []);
});

test("removing scenes the document does not hold plans nothing", () => {
  const doc = viewOf({ rows: rowsOf(["r1", "r2"]) });
  assert.equal(removeScenesCommand(["gone"]).plan(doc, MAY_EDIT), null);
  assert.equal(removeScenesCommand(["gone", "gone"]).plan(doc, MAY_EDIT), null);
  assert.equal(removeScenesCommand([]).plan(doc, MAY_EDIT), null);
});

test("a removal writes only the scenes it planned, even when a requested one appeared after planning", () => {
  const planned = planOf(removeScenesCommand(["r1", "r2"]), viewOf({ rows: rowsOf(["r1", "r3"]) }));
  assert.deepEqual(planned.changes.rowsRemoved, ["r1"]);
  const live = liveOf({ rows: rowsOf(["r1", "r2", "r3"]) });
  planned.apply(live);
  assert.deepEqual(idsIn(live), ["r2", "r3"]);
});

test("removing neighbouring scenes removes every one of them, and a repeated id counts once", () => {
  const doc = viewOf({ rows: rowsOf(["r1", "r2", "r3", "r4", "r5"]) });
  const planned = planOf(removeScenesCommand(["r2", "r3", "r2", "gone"]), doc);
  assert.deepEqual(planned.changes.rowsRemoved, ["r2", "r3"]);
  const live = liveOf({ rows: rowsOf(["r1", "r2", "r3", "r4", "r5"]) });
  planned.apply(live);
  assert.deepEqual(idsIn(live), ["r1", "r4", "r5"]);
  const edge = liveOf({ rows: rowsOf(["r1", "r2", "r3"]) });
  planOf(removeScenesCommand(["r1", "r3"]), viewOf({ rows: rowsOf(["r1", "r2", "r3"]) })).apply(edge);
  assert.deepEqual(idsIn(edge), ["r2"]);
});
