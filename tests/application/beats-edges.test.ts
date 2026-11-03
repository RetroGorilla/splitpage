import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAT_PASTE_FIELDS, pasteBeatsCommand, removeBeatsCommand } from "../../src/application/commands/beats.ts";
import type { BeatPaste } from "../../src/application/commands/beats.ts";
import { MAY_EDIT, idsIn, liveOf, planOf, rowsOf, viewOf } from "./plan-views.ts";

function paste(replaced: string | null): BeatPaste {
  return {
    plan: function () { return { inserted: ["n1"], replaced: replaced, title: false, saveNow: false }; },
    apply: function () {}
  };
}

test("scene commands are named and need edit capability", () => {
  const pasted = pasteBeatsCommand(paste(null));
  assert.deepEqual([pasted.name, pasted.needs], ["paste-scenes", "edit"]);
  const removed = removeBeatsCommand(["r1"]);
  assert.deepEqual([removed.name, removed.needs], ["remove-scenes", "edit"]);
});

test("a paste declares the comment, people, tag and shot lists as document fields, and the list is frozen", () => {
  assert.deepEqual(BEAT_PASTE_FIELDS, ["comments", "people", "productionTags", "brollShots"]);
  assert.equal(Object.isFrozen(BEAT_PASTE_FIELDS), true);
});

test("a paste that replaces a scene the document no longer holds declares no removal", () => {
  const doc = viewOf({ rows: rowsOf(["r1", "r2"]) });
  assert.deepEqual(planOf(pasteBeatsCommand(paste("gone")), doc).changes.rowsRemoved, []);
  assert.deepEqual(planOf(pasteBeatsCommand(paste("r2")), doc).changes.rowsRemoved, ["r2"]);
  assert.deepEqual(planOf(pasteBeatsCommand(paste(null)), doc).changes.rowsRemoved, []);
});

test("removing scenes the document does not hold plans nothing", () => {
  const doc = viewOf({ rows: rowsOf(["r1", "r2"]) });
  assert.equal(removeBeatsCommand(["gone"]).plan(doc, MAY_EDIT), null);
  assert.equal(removeBeatsCommand(["gone", "gone"]).plan(doc, MAY_EDIT), null);
  assert.equal(removeBeatsCommand([]).plan(doc, MAY_EDIT), null);
});

test("a removal writes only the scenes it planned, even when a requested one appeared after planning", () => {
  const planned = planOf(removeBeatsCommand(["r1", "r2"]), viewOf({ rows: rowsOf(["r1", "r3"]) }));
  assert.deepEqual(planned.changes.rowsRemoved, ["r1"]);
  const live = liveOf({ rows: rowsOf(["r1", "r2", "r3"]) });
  planned.apply(live);
  assert.deepEqual(idsIn(live), ["r2", "r3"]);
});

test("removing neighbouring scenes removes every one of them, and a repeated id counts once", () => {
  const doc = viewOf({ rows: rowsOf(["r1", "r2", "r3", "r4", "r5"]) });
  const planned = planOf(removeBeatsCommand(["r2", "r3", "r2", "gone"]), doc);
  assert.deepEqual(planned.changes.rowsRemoved, ["r2", "r3"]);
  const live = liveOf({ rows: rowsOf(["r1", "r2", "r3", "r4", "r5"]) });
  planned.apply(live);
  assert.deepEqual(idsIn(live), ["r1", "r4", "r5"]);
  const edge = liveOf({ rows: rowsOf(["r1", "r2", "r3"]) });
  planOf(removeBeatsCommand(["r1", "r3"]), viewOf({ rows: rowsOf(["r1", "r2", "r3"]) })).apply(edge);
  assert.deepEqual(idsIn(edge), ["r2"]);
});
