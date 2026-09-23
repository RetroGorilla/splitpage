/* Undo and redo (#85, docs/DOCUMENT-MODEL.md §7): src/js/12a-undo.js's pure
 * core. The app records a change by diffing the document against its last
 * copy (diffStates), applies an entry to the live document in place
 * (applyStepsLive), keeps the stacks (createUndoHistory) and forgets what a
 * collaborator's merge changed (changedBetween + forget, design D4). The
 * keys, the caret and the repaint are browser suite 73-undo. */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { applyStepsLive, caretAfterStep, changedBetween, createUndoHistory, diffStates } from "../js/12a-undo.js";
import { invertSteps } from "../js/04c-doc-model.js";

const row = (id, audio, extra) => Object.assign({ id, status: "todo", visualText: "", audioText: audio || "" }, extra);
const doc = (rows, extra) => Object.assign({ title: "T", docId: "d1", rev: 3, rows, comments: [], productionTags: [], people: [], brollShots: [] }, extra);
const clone = (v) => JSON.parse(JSON.stringify(v));

/* The property everything rests on: the steps take before to after. */
function roundTrip(before, after) {
  const steps = diffStates(before, after);
  const live = clone(before);
  assert.deepEqual(applyStepsLive(live, steps), { ok: true });
  assert.deepEqual(live.rows.map((r) => r.id), after.rows.map((r) => r.id));
  for (const r of after.rows) {
    const got = live.rows.find((x) => x.id === r.id);
    for (const k of Object.keys(r)) if (k !== "updatedAt" && k !== "updatedBy") assert.deepEqual(got[k], r[k], r.id + "." + k);
  }
  for (const k of ["title", "comments", "productionTags"]) assert.deepEqual(live[k], after[k], k);
  /* and the inverse takes it back */
  assert.deepEqual(applyStepsLive(live, invertSteps(steps)), { ok: true });
  assert.deepEqual(live.rows.map((r) => r.id), before.rows.map((r) => r.id));
  for (const r of before.rows) assert.equal(live.rows.find((x) => x.id === r.id).audioText, r.audioText);
  return steps;
}

test("diffStates: a cell, a status, the title", () => {
  const a = doc([row("r1", "one"), row("r2", "two")]);
  const b = clone(a); b.rows[0].audioText = "ONE"; b.rows[1].status = "shot"; b.title = "New"; b.rev = 9; b.rows[0].updatedAt = "x";
  const steps = roundTrip(a, b);
  assert.deepEqual(steps.map((s) => s.op + ":" + (s.key || "")), ["rowField:audioText", "rowField:status", "docField:title"]);
});

test("diffStates: rows deleted, inserted and moved, in any combination", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const base = doc(ids.map((id) => row(id, id)));
  const cases = [
    ["b", "c", "d", "e"], ["a", "b", "c", "d", "e", "f"], ["e", "a", "b", "c", "d"], ["b", "a", "c", "d", "e"],
    ["x", "c", "a"], ["e", "d", "c", "b", "a"], [], ["a", "y", "b", "z", "e"]
  ];
  for (const order of cases) {
    const after = doc(order.map((id) => row(id, id + (ids.includes(id) ? "" : "-new"))));
    roundTrip(base, after);
  }
});

test("diffStates: the lists and comments are one step each; bookkeeping is never a step", () => {
  const a = doc([row("r1")]);
  const b = clone(a);
  b.productionTags.push({ id: "t_1", cat: "prop", name: "Mug" });
  b.comments.push({ id: "c1", body: "hi" });
  b.docId = "d2"; b.lastEditedAt = "now"; b.schema = 2;
  const steps = diffStates(a, b);
  assert.deepEqual(steps.map((s) => s.key).sort(), ["comments", "productionTags"]);
  assert.deepEqual(diffStates(a, b, { skip: { comments: true } }).map((s) => s.key), ["productionTags"]);
});

test("undo puts a cell back even after something else changed it since, when the two do not overlap", () => {
  const live = doc([row("r1", "alpha bravo charlie")]);
  const step = { op: "rowField", rowId: "r1", key: "audioText", before: "alpha bravo charlie", after: "alpha BRAVO charlie" };
  live.rows[0].audioText = "alpha BRAVO charlie delta";                 // the step, then a word added
  assert.deepEqual(applyStepsLive(live, invertSteps([step])), { ok: true });
  assert.equal(live.rows[0].audioText, "alpha bravo charlie delta");
  /* the same words changed again since: refused, and nothing is touched */
  live.rows[0].audioText = "alpha BRAVISSIMO charlie";
  const r = applyStepsLive(live, invertSteps([step]));
  assert.equal(r.ok, false);
  assert.equal(live.rows[0].audioText, "alpha BRAVISSIMO charlie");
});

test("undo of a list change keeps what was added to the list since", () => {
  const e = (name) => ({ id: "t_" + name, cat: "prop", name, owner: "", notes: "", status: "needed" });
  const live = doc([], { productionTags: [e("Mug"), e("Lamp")] });
  const step = { op: "docField", key: "productionTags", before: [], after: [e("Mug")] };
  const r = applyStepsLive(live, invertSteps([step]));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(live.productionTags.map((t) => t.name), ["Lamp"]);
});

test("a refusal part way through changes nothing", () => {
  const live = doc([row("r1", "a"), row("r2", "b")]);
  const steps = [
    { op: "rowField", rowId: "r1", key: "status", before: "todo", after: "shot" },
    { op: "deleteRow", index: 1, row: row("r2", "not what is there") }
  ];
  assert.equal(applyStepsLive(live, steps).ok, false);
  assert.equal(live.rows[0].status, "todo");
  assert.equal(live.rows.length, 2);
});

test("history: typing coalesces into one entry per word, per cell, per pause", () => {
  const h = createUndoHistory();
  const t = (b, a) => [{ op: "rowField", rowId: "r1", key: "audioText", before: b, after: a }];
  h.record(t("", "h"), 0);
  h.record(t("h", "he"), 100);
  h.record(t("he", "hey"), 200);
  h.record(t("hey", "hey "), 300);
  assert.equal(h.sizes().undo, 1, "a word and the space after it");
  h.record(t("hey ", "hey y"), 400);
  assert.equal(h.sizes().undo, 2, "the next word starts a new entry");
  h.record(t("hey y", "hey yo"), 5000);
  assert.equal(h.sizes().undo, 3, "a pause starts a new entry");
  h.record([{ op: "rowField", rowId: "r1", key: "visualText", before: "", after: "v" }], 5100);
  assert.equal(h.sizes().undo, 4, "another cell starts a new entry");
  h.breakCoalescing();
  h.record([{ op: "rowField", rowId: "r1", key: "visualText", before: "v", after: "vv" }], 5200);
  assert.equal(h.sizes().undo, 5);

  const live = doc([row("r1", "hey yo", { visualText: "vv" })]);
  for (const want of [["hey yo", "v"], ["hey yo", ""], ["hey y", ""], ["hey ", ""], ["", ""]]) {
    assert.equal(h.undo(live).ok, true);
    assert.deepEqual([live.rows[0].audioText, live.rows[0].visualText], want);
  }
  assert.equal(h.undo(live).empty, true);
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].audioText, "hey ");
  /* a new change drops the redo stack */
  h.record(t("hey ", "hey!"), 9000);
  assert.equal(h.sizes().redo, 0);
});

test("forget (design D4): a merge that changed a cell drops the entries for it, and only them", () => {
  const h = createUndoHistory();
  h.record([{ op: "rowField", rowId: "r1", key: "audioText", before: "a", after: "A" }], 0);
  h.record([{ op: "rowField", rowId: "r2", key: "audioText", before: "b", after: "B" }], 5000);
  h.record([{ op: "moveRow", from: 0, to: 1 }], 9000);
  const prev = doc([row("r2", "B"), row("r1", "A")]);
  const next = doc([row("r2", "B"), row("r1", "A merged")]);
  const touched = changedBetween(prev, next);
  assert.deepEqual(Object.keys(touched.rowFields), ["r1\u0000audioText"]);
  assert.equal(touched.structure, false);
  h.forget(touched);
  assert.equal(h.sizes().undo, 2);
  const withNewRow = doc([row("r2", "B"), row("r1", "A merged"), row("r3")]);
  h.forget(changedBetween(next, withNewRow));
  assert.equal(h.sizes().undo, 1, "the move goes with a change to the scene list");
});

test("caretAfterStep: the end of what differs, in the DOM's text", () => {
  const s = { op: "rowField", rowId: "r1", key: "audioText", before: "one<br>two", after: "one<br>two three" };
  assert.equal(caretAfterStep(s, "undo"), "onetwo".length);
  assert.equal(caretAfterStep(s, "redo"), "onetwo three".length);
});
