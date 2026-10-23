import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { caretAfterStep as caretAfter } from "../features/undo/caret.ts";
import { fromHtml } from "../legacy/richtext.ts";
import { applyStepsLive, changedBetween, createUndoHistory, diffStates } from "../application/editing/undo/history.ts";
import { cellRuns } from "./_cell-runs.mjs";

const caretAfterStep = (step) => caretAfter((h) => fromHtml(h), step);
import { invertSteps } from "../js/04c-doc-model.js";
import { PROTOTYPE_IDS } from "../core/document/id-map.ts";

const row = (id, audio, extra) => Object.assign({ id, status: "todo", visualText: "", audioText: audio || "" }, extra);
const doc = (rows, extra) => Object.assign({ title: "T", docId: "d1", rev: 3, rows, comments: [], productionTags: [], people: [], brollShots: [] }, extra);
const clone = (v) => JSON.parse(JSON.stringify(v));

function roundTrip(before, after) {
  const steps = diffStates(before, after);
  const live = clone(before);
  assert.deepEqual(applyStepsLive(cellRuns, live, steps), { ok: true });
  assert.deepEqual(live.rows.map((r) => r.id), after.rows.map((r) => r.id));
  for (const r of after.rows) {
    const got = live.rows.find((x) => x.id === r.id);
    for (const k of Object.keys(r)) if (k !== "updatedAt" && k !== "updatedBy") assert.deepEqual(got[k], r[k], r.id + "." + k);
  }
  for (const k of ["title", "comments", "productionTags"]) assert.deepEqual(live[k], after[k], k);
  assert.deepEqual(applyStepsLive(cellRuns, live, invertSteps(steps)), { ok: true });
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
  live.rows[0].audioText = "alpha BRAVO charlie delta";
  assert.deepEqual(applyStepsLive(cellRuns, live, invertSteps([step])), { ok: true });
  assert.equal(live.rows[0].audioText, "alpha bravo charlie delta");
  live.rows[0].audioText = "alpha BRAVISSIMO charlie";
  const r = applyStepsLive(cellRuns, live, invertSteps([step]));
  assert.equal(r.ok, false);
  assert.equal(live.rows[0].audioText, "alpha BRAVISSIMO charlie");
});

test("undo of a list change keeps what was added to the list since", () => {
  const e = (name) => ({ id: "t_" + name, cat: "prop", name, owner: "", notes: "", status: "needed" });
  const live = doc([], { productionTags: [e("Mug"), e("Lamp")] });
  const step = { op: "docField", key: "productionTags", before: [], after: [e("Mug")] };
  const r = applyStepsLive(cellRuns, live, invertSteps([step]));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(live.productionTags.map((t) => t.name), ["Lamp"]);
});

test("a refusal part way through changes nothing", () => {
  const live = doc([row("r1", "a"), row("r2", "b")]);
  const steps = [
    { op: "rowField", rowId: "r1", key: "status", before: "todo", after: "shot" },
    { op: "deleteRow", index: 1, row: row("r2", "not what is there") }
  ];
  assert.equal(applyStepsLive(cellRuns, live, steps).ok, false);
  assert.equal(live.rows[0].status, "todo");
  assert.equal(live.rows.length, 2);
});

test("history: typing coalesces into one entry per word, per cell, per pause", () => {
  const h = createUndoHistory(cellRuns);
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
  h.record(t("hey ", "hey!"), 9000);
  assert.equal(h.sizes().redo, 0);
});

test("forget (design D4): a merge that changed a cell drops the entries for it, and only them", () => {
  const h = createUndoHistory(cellRuns);
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

const typed = (b, a, key) => [{ op: "rowField", rowId: "r1", key: key || "audioText", before: b, after: a }];
const status = (id) => [{ op: "rowField", rowId: id, key: "status", before: "todo", after: "shot" }];

test("history: typing that coalesces back to where its entry began drops the entry, and the one below is the top again", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const below = h.top();
  h.record(typed("Three.", "Three.x"), 5000);
  assert.equal(h.sizes().undo, 2);
  h.record(typed("Three.x", "Three."), 5100);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  assert.equal(h.top(), below);
  const live = doc([row("r9", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[0].status, "todo", "the next undo is the real entry below");
});

test("history: after a word-start entry, coalescing back drops only that entry, and what follows joins the history as if it never happened", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("", "hey"), 0);
  h.record(typed("hey", "hey "), 100);
  h.record(typed("hey ", "hey y"), 200);
  assert.equal(h.sizes().undo, 2);
  h.record(typed("hey y", "hey "), 300);
  assert.equal(h.sizes().undo, 1);
  assert.deepEqual(h.top().steps, typed("", "hey "));
  h.record(typed("hey ", "hey  "), 400);
  assert.equal(h.sizes().undo, 1, "a space still joins the word before it");
  h.record(typed("hey  ", "hey  z"), 500);
  assert.equal(h.sizes().undo, 2, "and the next word starts its own entry");
});

test("history: an entry that passes through where it began on the way is kept: x, then nothing, then y is one entry", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  h.record(typed("a", "ax"), 5000);
  h.record(typed("ax", "a"), 5100);
  h.record(typed("a", "ay"), 5200);
  assert.equal(h.sizes().undo, 2);
  assert.deepEqual(h.top().steps, typed("a", "ay"));
  h.record(typed("ay", "a"), 5300);
  assert.equal(h.sizes().undo, 1);
});

test("history: back to where it began means the same runs, so markup that decodes the same counts and a change of marks does not", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Three.", "Three.x"), 0);
  h.record(typed("Three.x", "<span>Three.</span><b></b>"), 100);
  assert.equal(h.sizes().undo, 0);
  h.record(typed("Three.", "Three.x"), 5000);
  h.record(typed("Three.x", "<b>Three.</b>"), 5100);
  assert.equal(h.sizes().undo, 1, "bold text is not where it began");
  assert.equal(h.top().steps[0].after, "<b>Three.</b>");
});

test("history: a drop brings back the redo its typing cleared, and typing that leaves a real step still clears it", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  h.record(typed("a", "ax"), 5000);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 }, "the first keystroke clears redo, as before");
  h.record(typed("ax", "a"), 5100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].status, "shot");
  assert.equal(h.undo(live).ok, true);
  h.record(typed("a", "ax"), 9000);
  h.record(typed("ax", "axy"), 9100);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 }, "typing that stays clears redo");
  h.record(typed("axy", "ax"), 9200);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 }, "and deleting part of it later brings nothing back");
});

test("history: redo comes back only to the history it was cleared from, and also after the typing was undone and redone", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  h.record(status("r8"), 100);
  const live = doc([row("r9", "", { status: "shot" }), row("r8", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  h.record(typed("a", "ax"), 5000);
  h.record(status("r7"), 5100);
  const live2 = doc([row("r9", "", { status: "shot" }), row("r7", "", { status: "shot" }), row("r1", "ax")]);
  assert.equal(h.undo(live2).ok, true);
  assert.deepEqual(h.sizes(), { undo: 2, redo: 1 });
  h.record(typed("ax", "axy"), 5200);
  h.record(typed("axy", "ax"), 5300);
  assert.deepEqual(h.sizes(), { undo: 2, redo: 1 }, "the r7 change comes back, not r8's");
  assert.deepEqual(h.nextRedo().steps, status("r7"));

  const g = createUndoHistory(cellRuns);
  g.record(status("r9"), 0);
  const live3 = doc([row("r9", "", { status: "shot" }), row("r1", "a")]);
  assert.equal(g.undo(live3).ok, true);
  g.record(typed("a", "ax"), 5000);
  live3.rows[1].audioText = "ax";
  assert.equal(g.undo(live3).ok, true);
  assert.equal(g.redo(live3).ok, true);
  assert.deepEqual(g.sizes(), { undo: 1, redo: 0 });
  g.record(typed("ax", "a"), 5100);
  assert.deepEqual(g.sizes(), { undo: 0, redo: 1 }, "once the typing was undone and redone, dropping it still brings back the redo from before it");
  assert.equal(g.redo(live3).ok, true);
  assert.equal(live3.rows[0].status, "shot");
});

const inR2 = (b, a) => typed(b, a).map((s) => Object.assign(s, { rowId: "r2" }));

test("history: after the typing that cleared redo is undone, a later drop gives back only the typing's redo, never the older redo the typing cleared", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" }), row("r1", "a"), row("r2", "b")]);
  assert.equal(h.undo(live).ok, true);
  h.record(typed("a", "ax"), 5000);
  live.rows[1].audioText = "ax";
  assert.equal(h.undo(live).ok, true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  h.record(inR2("b", "by"), 9000);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  h.record(inR2("by", "b"), 9100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[1].audioText, "ax", "Ctrl+Y redoes the typing");
  assert.equal(h.redo(live).empty, true, "and stops: the typing cleared the older redo");
  assert.equal(live.rows[0].status, "todo");
});

test("history: a drop gives back only what its own typing cleared, so a scene move and an insert undone from the same point are never stacked", () => {
  const h = createUndoHistory(cellRuns);
  let live = doc(["a", "b", "c", "d"].map((id) => row(id, id)));
  const change = (fn, at) => {
    const after = clone(live);
    fn(after);
    h.record(diffStates(live, after), at);
    live = after;
  };
  const ids = () => live.rows.map((r) => r.id).join("");
  change((d) => d.rows.unshift(d.rows.pop()), 0);
  assert.equal(ids(), "dabc");
  assert.equal(h.undo(live).ok, true);
  change((d) => d.rows.unshift(row("n", "n")), 5000);
  assert.equal(ids(), "nabcd");
  assert.equal(h.undo(live).ok, true);
  assert.equal(ids(), "abcd");
  change((d) => { d.rows[0].audioText = "ax"; }, 9000);
  change((d) => { d.rows[0].audioText = "a"; }, 9100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(ids(), "nabcd");
  assert.equal(h.redo(live).empty, true, "the move was undone from a history without the insert");
  assert.equal(ids(), "nabcd");
});

test("history: a drop after only part of the typing was undone keeps redo cleared, as before the drop gave any back", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" }), row("r1", "a b")]);
  assert.equal(h.undo(live).ok, true);
  h.record(typed("", "a"), 5000);
  h.record(typed("a", "a "), 5100);
  h.record(typed("a ", "a b"), 5200);
  assert.deepEqual(h.sizes(), { undo: 2, redo: 0 });
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[1].audioText, "a ");
  h.record(typed("a ", "a"), 5300);
  h.record(typed("a", ""), 5400);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 });
  assert.equal(h.redo(live).empty, true);
  assert.equal(live.rows[0].status, "todo");
});

test("history: dropping a later word gives back no redo while the entry under it still holds typing made after the redo was parked", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("", "x"), 0);
  h.record(status("r9"), 100);
  const live = doc([row("r1", "x"), row("r9", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 1 });
  h.record(typed("x", "xa"), 300);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  h.record(typed("xa", "xa "), 400);
  h.record(typed("xa ", "xa b"), 500);
  assert.deepEqual(h.sizes(), { undo: 2, redo: 0 });
  h.record(typed("xa b", "xa "), 600);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 }, "the a is still in the cell");
  assert.equal(h.nextRedo(), null);
  assert.equal(h.top().steps[0].after, "xa ");
});

test("history: a cancel whose last update was undone before the drop never puts the older redo on top of that update's redo", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" }), row("r1", "T")]);
  assert.equal(h.undo(live).ok, true);
  const mark = h.markCell("r1", "audioText", "T");
  h.record(typed("T", "Tね"), 5000);
  h.record(typed("Tね", "T"), 6100);
  h.record(typed("T", "Tx"), 7200);
  live.rows[1].audioText = "Tx";
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[1].audioText, "T");
  assert.equal(h.dropEmptySince(mark, true), true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.deepEqual(h.nextRedo().steps, typed("T", "Tx"));
  assert.equal(h.redo(live).ok, true);
  assert.equal(h.redo(live).empty, true);
  assert.equal(live.rows[0].status, "todo");
});

test("history: the older redo a cancel did not put back stays parked, so Ctrl+Y on the update and a Backspace back within the second give it back (#446 N1)", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" }), row("r1", "T")]);
  assert.equal(h.undo(live).ok, true);
  const mark = h.markCell("r1", "audioText", "T");
  h.record(typed("T", "Tね"), 5000);
  h.record(typed("Tね", "T"), 6100);
  h.record(typed("T", "Tx"), 7200);
  live.rows[1].audioText = "Tx";
  assert.equal(h.undo(live).ok, true);
  assert.equal(h.dropEmptySince(mark, true), true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[1].audioText, "Tx");
  h.record(typed("Tx", "T"), 7300);
  live.rows[1].audioText = "T";
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.deepEqual(h.nextRedo().steps, status("r9"));
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].status, "shot");
});

test("history: a slow cancelled composition that replaced a selection leaves one step, back to the cell as it was at compositionstart (#436)", () => {
  for (const order of ["edge", "firefox, revert at once", "firefox, revert later"]) {
    const h = createUndoHistory(cellRuns);
    h.record(status("r9"), 0);
    const mark = h.markCell("r1", "audioText", "Third.");
    h.record(typed("Third.", "Thiね"), 5000);
    h.record(typed("Thiね", "Thiねこ"), 6100);
    if (order !== "edge") assert.equal(h.dropEmptySince(mark, true), false, order);
    h.record(typed("Thiねこ", "Thi"), order === "firefox, revert at once" ? 6105 : 7200);
    assert.equal(h.dropEmptySince(mark, true), false, order);
    assert.deepEqual(h.sizes(), { undo: 2, redo: 0 }, order);
    assert.deepEqual(h.top().steps, typed("Third.", "Thi"), order);
    const live = doc([row("r9", "", { status: "shot" }), row("r1", "Thi")]);
    assert.equal(h.undo(live).ok, true);
    assert.equal(live.rows[1].audioText, "Third.", order + ": one Ctrl+Z brings the selection back");
    assert.equal(h.undo(live).ok, true);
    assert.equal(live.rows[0].status, "todo", order + ": and the next one is the step before the composition");
    assert.equal(h.redo(live).ok, true);
    assert.equal(h.redo(live).ok, true);
    assert.equal(live.rows[1].audioText, "Thi", order + ": redo never shows the cancelled text either");
  }
});

test("history: the one step a cancel leaves takes the word state of what it inserted, so a letter typed next after a left space starts its own step (#436)", () => {
  const h = createUndoHistory(cellRuns);
  const mark = h.markCell("r1", "audioText", "a");
  h.record(typed("a", "aね"), 5000);
  h.record(typed("aね", "a "), 6100);
  assert.equal(h.dropEmptySince(mark, true), false);
  assert.deepEqual(h.top().steps, typed("a", "a "));
  h.record(typed("a ", "a x"), 6200);
  assert.equal(h.sizes().undo, 2);
  const g = createUndoHistory(cellRuns);
  const m2 = g.markCell("r1", "audioText", "a");
  g.record(typed("a", "aね"), 5000);
  g.record(typed("aね", "ab"), 6100);
  assert.equal(g.dropEmptySince(m2, true), false);
  g.record(typed("ab", "abx"), 6200);
  assert.equal(g.sizes().undo, 1, "no space, so the letter joins it");
});

test("history: a committed composition that replaced a selection keeps its steps, as before (#436)", () => {
  const h = createUndoHistory(cellRuns);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Thiね"), 5000);
  h.record(typed("Thiね", "Thiねこ"), 6100);
  assert.equal(h.dropEmptySince(mark, false), false);
  assert.deepEqual(h.sizes(), { undo: 2, redo: 0 });
  assert.deepEqual(h.top().steps, typed("Thiね", "Thiねこ"));
});

test("history: a slow cancelled composition over a selection that joined earlier typing gives that typing back and adds one step from the cell at compositionstart (#436)", () => {
  for (const firefox of [false, true]) {
    const h = createUndoHistory(cellRuns);
    h.record(typed("Thir", "Third."), 0);
    const mark = h.markCell("r1", "audioText", "Third.");
    h.record(typed("Third.", "Thiね"), 100);
    h.record(typed("Thiね", "Thiねこ"), 1200);
    if (firefox) assert.equal(h.dropEmptySince(mark, true), false);
    h.record(typed("Thiねこ", "Thi"), firefox ? 1205 : 2300);
    assert.equal(h.dropEmptySince(mark, true), false);
    assert.deepEqual(h.sizes(), { undo: 2, redo: 0 });
    assert.deepEqual(h.top().steps, typed("Third.", "Thi"));
    const live = doc([row("r1", "Thi")]);
    assert.equal(h.undo(live).ok, true);
    assert.equal(live.rows[0].audioText, "Third.");
    assert.equal(h.undo(live).ok, true);
    assert.equal(live.rows[0].audioText, "Thir", "the typing before the composition keeps its own step");
  }
});

test("history: a fast cancelled composition over a selection, every update joined to the typing before it, coalesces like that typing in either event order (#436)", () => {
  for (const firefox of [false, true]) {
    const h = createUndoHistory(cellRuns);
    h.record(typed("Thir", "Third."), 0);
    const mark = h.markCell("r1", "audioText", "Third.");
    h.record(typed("Third.", "Thiね"), 100);
    if (firefox) assert.equal(h.dropEmptySince(mark, true), false);
    h.record(typed("Thiね", "Thi"), 200);
    assert.equal(h.dropEmptySince(mark, true), false);
    assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
    assert.deepEqual(h.top().steps, typed("Thir", "Thi"));
    h.record(typed("Thi", "Thir"), 300);
    assert.deepEqual(h.sizes(), { undo: 0, redo: 0 }, "back where that typing began is no step at all, as for any typing");
  }
});

test("history: the one step a cancel over a selection leaves keeps the redo it cleared parked, and typing the selection back within the second gives it back (#436)", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" }), row("r1", "Third.")]);
  assert.equal(h.undo(live).ok, true);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Thiね"), 5000);
  h.record(typed("Thiね", "Thiねこ"), 6100);
  h.record(typed("Thiねこ", "Thi"), 7200);
  assert.equal(h.dropEmptySince(mark, true), false);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 }, "the deleted selection is a real step, so redo stays cleared");
  h.record(typed("Thi", "Third."), 7300);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].status, "shot");
});

test("history: a Ctrl+Z during a composition that undid typing from before it keeps the composition's steps, so the re-typed text stays undoable (#446)", () => {
  for (const cancelled of [false, true]) {
    const h = createUndoHistory(cellRuns);
    const live = doc([row("r1", "aか")]);
    h.record(typed("", "a"), 0);
    h.record(typed("a", "aか"), 5000);
    const mark = h.markCell("r1", "audioText", "aか");
    assert.equal(h.undo(live).ok, true);
    assert.equal(live.rows[0].audioText, "a");
    h.record(typed("a", "aか"), 10000);
    live.rows[0].audioText = "aか";
    assert.equal(h.dropEmptySince(mark, cancelled), false);
    assert.deepEqual(h.sizes(), { undo: 2, redo: 0 });
    assert.equal(h.undo(live).ok, true);
    assert.equal(live.rows[0].audioText, "a");
    assert.equal(h.undo(live).ok, true);
    assert.equal(live.rows[0].audioText, "");
  }
});

test("history: a Ctrl+Y during a composition that redid an entry from before it keeps the composition's steps (#446)", () => {
  const h = createUndoHistory(cellRuns);
  const live = doc([row("r1", "aか")]);
  h.record(typed("", "a"), 0);
  h.record(typed("a", "aか"), 5000);
  assert.equal(h.undo(live).ok, true);
  const mark = h.markCell("r1", "audioText", "a");
  assert.equal(h.redo(live).ok, true);
  h.record(typed("aか", "a"), 10000);
  live.rows[0].audioText = "a";
  assert.equal(h.dropEmptySince(mark, true), false);
  assert.deepEqual(h.sizes(), { undo: 3, redo: 0 });
  for (const want of ["aか", "a", ""]) {
    assert.equal(h.undo(live).ok, true);
    assert.equal(live.rows[0].audioText, want);
  }
});

test("history: a composition's mark drops nothing once a later composition has started, so a late recheck never reaches into the new one (#446)", () => {
  const h = createUndoHistory(cellRuns);
  const first = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Thi"), 5000);
  h.markCell("r1", "audioText", "Thi");
  h.record(typed("Thi", "Thiね"), 6100);
  h.record(typed("Thiね", "Third."), 7200);
  assert.equal(h.dropEmptySince(first, true), false);
  assert.deepEqual(h.sizes(), { undo: 3, redo: 0 });
});

const CANCELLED = /[ねこぬ]/;

function undoChain(h, live, field) {
  const seen = [];
  for (;;) {
    const r = h.undo(live);
    if (r.empty) return seen;
    seen.push(r.ok ? live.rows[0][field || "audioText"] : "refused: " + r.reason);
  }
}

test("history: typing n, then within the second a composition over the n that first puts the cell back where that typing began, then a slow cancel, keeps the typing as its own step and one Ctrl+Z goes back to the cell at compositionstart (#448 B1)", () => {
  for (const order of ["edge", "firefox"]) {
    for (const restored of [false, true]) {
      const how = order + (restored ? ", selection put back" : ", selection deleted");
      const h = createUndoHistory(cellRuns);
      h.record(typed("", "Ta"), 0);
      h.record(typed("Ta", "Tan"), 3000);
      const mark = h.markCell("r1", "audioText", "Tan");
      h.record(typed("Tan", "Ta"), 3400);
      h.record(typed("Ta", "Tai"), 4500);
      if (order === "firefox") h.dropEmptySince(mark, true);
      const end = restored ? "Tan" : "T";
      h.record(typed("Tai", end), 5600);
      h.dropEmptySince(mark, true);
      const live = doc([row("r1", end)]);
      const chain = restored ? ["Ta", ""] : ["Tan", "Ta", ""];
      assert.deepEqual(undoChain(h, live), chain, how);
      for (const want of chain.slice(0, -1).reverse().concat([end])) {
        assert.equal(h.redo(live).ok, true, how);
        assert.equal(live.rows[0].audioText, want, how);
      }
    }
  }
});

test("history: a reconversion whose first update puts the cell back where the conversion began, within the second, then cancelled or committed back to the same text, never refuses an undo (#448 B1)", () => {
  for (const cancelled of [true, false]) {
    const h = createUndoHistory(cellRuns);
    h.record(typed("T", "Tかん"), 0);
    h.record(typed("Tかん", "T漢"), 1100);
    const mark = h.markCell("r1", "audioText", "T漢");
    h.record(typed("T漢", "Tかん"), 1200);
    const mid = cancelled ? "Tかんね" : "Tかんか";
    h.record(typed("Tかん", mid), 2300);
    const end = cancelled ? "T" : "T漢";
    h.record(typed(mid, end), 3400);
    h.dropEmptySince(mark, cancelled);
    assert.deepEqual(undoChain(h, doc([row("r1", end)])), cancelled ? ["T漢", "Tかん", "T"] : ["Tかん", "T"]);
  }
});

test("history: a dropped typing entry is not put back on a cancel once a later update has joined the entry under it, so no undo is refused (#448 B1)", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Ta", "Ta "), 0);
  h.record(typed("Ta ", "Ta n"), 200);
  const mark = h.markCell("r1", "audioText", "Ta n");
  h.record(typed("Ta n", "Ta "), 300);
  h.record(typed("Ta ", "Ta  "), 400);
  h.record(typed("Ta  ", "Ta  ね"), 1500);
  h.record(typed("Ta  ね", "Ta"), 2600);
  h.dropEmptySince(mark, true);
  const chain = undoChain(h, doc([row("r1", "Ta")]));
  assert.ok(chain.every((text) => !text.startsWith("refused")), chain.join(" < "));
  assert.equal(chain[chain.length - 1], "Ta");
});

test("history: a composition whose own update was deleted back to the cell at compositionstart within the second, then went on and was cancelled, leaves no step and puts nothing back twice (#448)", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Third.ね"), 5000);
  h.record(typed("Third.ね", "Third."), 5100);
  h.record(typed("Third.", "Third.こ"), 6200);
  h.record(typed("Third.こ", "Third."), 7300);
  assert.equal(h.dropEmptySince(mark, true), true);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  assert.deepEqual(h.top().steps, status("r9"));
});

test("history: a composition's mark drops nothing once the history was cleared, even in a cell with the same row id (#448)", () => {
  const h = createUndoHistory(cellRuns);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.clear();
  h.record(typed("Third.", "Thiね"), 5000);
  h.record(typed("Thiね", "Thi"), 6100);
  assert.equal(h.dropEmptySince(mark, true), false);
  assert.deepEqual(h.sizes(), { undo: 2, redo: 0 });
  assert.deepEqual(h.top().steps, typed("Thiね", "Thi"));
});

test("history: a co-editor's change to the cell during a slow composition is not undone by the cancel's step (#448 S2)", () => {
  const h = createUndoHistory(cellRuns);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Thiね"), 5000);
  h.forget({ rowFields: { "r1\u0000audioText": true }, structure: false, doc: {} });
  h.record(typed("THiね", "THiねこ"), 6100);
  h.record(typed("THiねこ", "THi"), 7200);
  h.dropEmptySince(mark, true);
  const chain = undoChain(h, doc([row("r1", "THi")]));
  assert.ok(chain.length > 0);
  for (const text of chain) assert.match(text, /^TH/, "every step keeps the co-editor's H");
});

test("history: a cancel after a Ctrl+Z past compositionstart works from the cell as that Ctrl+Z left it: back there it is no step and gives the redo back, anything else is one step from there (#448 S3)", () => {
  for (const end of ["a", ""]) {
    const h = createUndoHistory(cellRuns);
    const live = doc([row("r1", "aか")]);
    h.record(typed("", "a"), 0);
    h.record(typed("a", "aか"), 5000);
    const mark = h.markCell("r1", "audioText", "aか");
    assert.equal(h.undo(live).ok, true);
    h.record(typed("a", "aね"), 10000);
    h.record(typed("aね", "aねこ"), 11100);
    h.record(typed("aねこ", end), 12200);
    live.rows[0].audioText = end;
    assert.equal(h.dropEmptySince(mark, true), end === "a");
    if (end === "a") {
      assert.deepEqual(h.sizes(), { undo: 1, redo: 1 });
      assert.equal(h.redo(live).ok, true);
      assert.equal(live.rows[0].audioText, "aか");
    } else {
      assert.deepEqual(h.sizes(), { undo: 2, redo: 0 });
      assert.deepEqual(undoChain(h, live), ["a", ""]);
    }
  }
});

test("history: a Ctrl+Z past compositionstart that undid typing the composition had joined gives that typing back on redo without the composition's text (#448 S3)", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Thir", "Third."), 0);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Third.ね"), 100);
  const live = doc([row("r1", "Third.ね")]);
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Thir");
  h.record(typed("Thir", "Thirね"), 1300);
  h.record(typed("Thirね", "Thir"), 2400);
  live.rows[0].audioText = "Thir";
  assert.equal(h.dropEmptySince(mark, true), true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Third.", "the typing, without the cancelled text");
});

test("history: once a composition joined to typing has ended in a commit, a later Ctrl+Z of that typing keeps the committed text for Ctrl+Y (#448)", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Thir", "Third."), 0);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Third.か"), 100);
  assert.equal(h.dropEmptySince(mark, false), false);
  const live = doc([row("r1", "Third.か")]);
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Thir");
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Third.か");
});

test("history: a refused Ctrl+Z past compositionstart still takes a fresh mark, so the typing the composition then joined is put back when it is cancelled (#448)", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("", "Ta"), 4800);
  h.record(status("r9"), 5000);
  const mark = h.markCell("r1", "audioText", "Ta");
  const live = doc([row("r1", "Ta"), row("r9")]);
  assert.equal(h.undo(live).ok, false);
  h.record(typed("Ta", "Taね"), 5500);
  h.record(typed("Taね", "Taねこ"), 6600);
  h.record(typed("Taねこ", "Ta"), 7700);
  assert.equal(h.dropEmptySince(mark, true), true);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  assert.deepEqual(undoChain(h, live), [""]);
});

test("history: a Ctrl+Z that applies inside a composition ends its mark, since the render drops the composition and no compositionend arrives, so later Ctrl+Z and Ctrl+Y keep what the document held (#448 R1)", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Third.", "Third.x"), 0);
  h.markCell("r1", "audioText", "Third.x");
  h.record(typed("Third.x", "Third.xね"), 100);
  h.record(typed("Third.xね", "Third.xねこ"), 1300);
  const live = doc([row("r1", "Third.xねこ")]);
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Third.xね");
  h.record(typed("Third.xね", "Third.xね!"), 5000);
  live.rows[0].audioText = "Third.xね!";
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Third.xね");
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Third.");
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Third.xね");
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Third.xね!");
});

const seededDraw = (seed) => {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 16) % n;
  };
};

function redoInvariantRun(seed, count) {
  const draw = seededDraw(seed);
  const h = createUndoHistory(cellRuns);
  let live = doc(["a", "b", "c", "d"].map((id) => row(id, id)));
  const undoneFrom = new Map();
  const canon = () => live.rows.map((r) => r.id + ":" + r.audioText + ":" + r.status).join("|");
  const model = { undo: [], redo: [] };
  const ops = [];
  let now = 0, fresh = 0, i = 0;
  const where = (what) => "seed " + seed + ": " + what + " at op " + i + ": " + ops.join(",");
  const change = (fn, gap) => {
    now += gap;
    const after = clone(live);
    fn(after);
    h.record(diffStates(live, after), now);
    live = after;
  };
  const real = () => { model.undo.push(canon()); model.redo.length = 0; };
  const setText = (at, text, gap) => change((d) => { d.rows[at].audioText = text; }, gap);
  const undoOne = () => {
    const entry = h.top();
    const want = model.undo.pop();
    const from = canon();
    const r = h.undo(live);
    assert.ok(r.ok || r.empty, where("undo refused: " + r.reason));
    assert.equal(r.ok ? canon() : undefined, want, where("undo lands somewhere the model does not"));
    if (r.ok) { undoneFrom.set(entry, canon()); model.redo.push(from); }
    assert.doesNotMatch(canon(), CANCELLED, where("an undo shows cancelled text"));
    live = clone(live);
  };
  const pace = () => [100, 400, 1100][draw(3)];
  const revert = (at, mark, kept, firefox) => {
    if (firefox) h.dropEmptySince(mark, true);
    const gap = firefox && draw(2) ? 5 : pace();
    setText(at, kept, gap);
    h.dropEmptySince(mark, true);
    return gap;
  };
  const cancelled = (at, kept, firstGap, firefox) => {
    const mark = h.markCell(live.rows[at].id, "audioText", live.rows[at].audioText);
    const gap = pace();
    setText(at, kept + "ね", firstGap);
    setText(at, kept + "ねこ", gap);
    return revert(at, mark, kept, firefox) < 1000 && gap < 1000;
  };
  const kinds = ["edit", "status", "drop", "cancel", "cancelSel", "joinCancel", "selCancel", "commit", "cancelUndo",
    "crossCommit", "crossCancel", "crossJoin", "insert", "move", "undo", "undo", "redo", "redo", "redo"];
  for (; i < count; i++) {
    const at = draw(live.rows.length);
    const text = live.rows[at].audioText;
    const drawn = kinds[draw(kinds.length)];
    const kind = drawn === "selCancel" && !text ? "edit" : drawn;
    ops.push(kind);
    if (kind === "edit") {
      real();
      setText(at, text + "e", 5000);
    } else if (kind === "status") {
      real();
      change((d) => { d.rows[at].status = d.rows[at].status === "todo" ? "shot" : "todo"; }, 5000);
    } else if (kind === "drop") {
      setText(at, text + "x", 5000);
      setText(at, text, 100);
    } else if (kind === "cancel" || kind === "cancelSel") {
      const kept = kind === "cancelSel" ? text.slice(0, -1) : text;
      if (kept !== text) real();
      cancelled(at, kept, 5000, draw(2));
    } else if (kind === "joinCancel") {
      const before = { undo: model.undo.slice(), redo: model.redo.slice() };
      real();
      setText(at, text + "e", 5000);
      const typed = canon();
      const sel = draw(2);
      const fast = cancelled(at, sel ? text : text + "e", 100, draw(2));
      if (sel && fast) { model.undo = before.undo; model.redo = before.redo; }
      else if (sel) model.undo.push(typed);
    } else if (kind === "selCancel") {
      real();
      setText(at, text + "n", 5000);
      const typed = canon();
      const mark = h.markCell(live.rows[at].id, "audioText", text + "n");
      const restored = draw(2);
      setText(at, text, 100 + 100 * draw(9));
      setText(at, text + "ね", pace());
      revert(at, mark, restored ? text + "n" : text.slice(0, -1), draw(2));
      if (!restored) model.undo.push(typed);
    } else if (kind === "commit") {
      const mark = h.markCell(live.rows[at].id, "audioText", text);
      real();
      setText(at, text + "か", 5000);
      real();
      setText(at, text + "かな", 1100);
      assert.equal(h.dropEmptySince(mark, false), false, where("a commit drops"));
    } else if (kind === "cancelUndo") {
      const mark = h.markCell(live.rows[at].id, "audioText", text);
      setText(at, text + "ね", 5000);
      setText(at, text, 1100);
      setText(at, text + "x", 1100);
      const entry = h.top();
      const from = canon();
      assert.equal(h.undo(live).ok, true);
      undoneFrom.set(entry, canon());
      live = clone(live);
      h.dropEmptySince(mark, true);
      model.redo.length = 0;
      model.redo.push(from);
    } else if (kind === "crossCommit" || kind === "crossCancel" || kind === "crossJoin") {
      real();
      setText(at, text + "e", 5000);
      const typed = canon();
      const mark = h.markCell(live.rows[at].id, "audioText", text + "e");
      if (kind === "crossJoin") {
        setText(at, text + "eぬ", 100 + 100 * draw(9));
        const entry = h.top();
        const want = model.undo.pop();
        assert.equal(h.undo(live).ok, true, where("a Ctrl+Z past the mark is refused"));
        assert.equal(canon(), want, where("a Ctrl+Z past the mark lands somewhere the model does not"));
        undoneFrom.set(entry, canon());
        model.redo.push(typed);
        live = clone(live);
      } else {
        undoOne();
      }
      const before = { undo: model.undo.slice(), redo: model.redo.slice() };
      const undone = canon();
      if (kind === "crossCommit") {
        real();
        setText(at, text + "e", pace());
        assert.equal(h.dropEmptySince(mark, false), false, where("a re-typed commit after a Ctrl+Z past the mark drops"));
      } else {
        const sel = text && draw(2);
        setText(at, text + "ぬ", pace());
        revert(at, mark, sel ? text.slice(0, -1) : text, draw(2));
        model.undo = sel ? before.undo.concat([undone]) : before.undo;
        model.redo = sel ? [] : before.redo;
      }
    } else if (kind === "insert") {
      real();
      change((d) => { d.rows.splice(at, 0, row("n" + ++fresh, "n")); }, 5000);
    } else if (kind === "move") {
      const to = draw(live.rows.length);
      if (to !== at) real();
      change((d) => { d.rows.splice(to, 0, d.rows.splice(at, 1)[0]); }, 5000);
    } else if (kind === "undo") {
      undoOne();
    } else {
      const entry = h.nextRedo();
      if (entry) {
        assert.equal(canon(), undoneFrom.get(entry), where("redo starts from a state its entry was not undone from"));
      }
      const want = model.redo.pop();
      const from = canon();
      const r = h.redo(live);
      assert.ok(r.ok || r.empty, where("redo refused: " + r.reason));
      assert.equal(r.ok ? canon() : undefined, want, where("redo lands somewhere the model does not"));
      if (r.ok) model.undo.push(from);
      assert.doesNotMatch(canon(), CANCELLED, where("a redo shows cancelled text"));
      live = clone(live);
    }
    assert.doesNotMatch(canon(), CANCELLED, where("the document keeps cancelled text"));
    assert.deepEqual(h.sizes(), { undo: model.undo.length, redo: model.redo.length }, where("history sizes differ from the model"));
  }
}

test("history: every undo and redo lands where a plain stack of states says, every redo starts from the exact state its entry was undone from, and no step shows cancelled text, over seeded mixes of edits, drops, cancels, cancels over a selection, joined cancels, cancels over the letter just typed, commits, Ctrl+Z past a composition's start (with and without a joined update), then a commit or a cancel, updates under a second apart, inserts, moves, undo and redo", () => {
  for (let seed = 1; seed <= 600; seed++) redoInvariantRun(seed, 24);
});

test("history: a typing that cleared redo and was undone and redone gives that redo back when a slow or joined cancel drops it", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" }), row("r1", "Third.ねこ")]);
  assert.equal(h.undo(live).ok, true);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Third.ね"), 5000);
  h.record(typed("Third.ね", "Third.ねこ"), 6100);
  assert.equal(h.undo(live).ok, true);
  assert.equal(h.redo(live).ok, true);
  h.record(typed("Third.ねこ", "Third."), 7200);
  assert.equal(h.dropEmptySince(mark, true), true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].status, "shot");

  const g = createUndoHistory(cellRuns);
  g.record(typed("Three.", "Three.か"), 10000);
  g.record(status("r9"), 10100);
  const live2 = doc([row("r9", "", { status: "shot" }), row("r1", "Three.かねこ")]);
  assert.equal(g.undo(live2).ok, true);
  const m2 = g.markCell("r1", "audioText", "Three.か");
  g.record(typed("Three.か", "Three.かね"), 10300);
  g.record(typed("Three.かね", "Three.かねこ"), 11400);
  assert.equal(g.undo(live2).ok, true);
  assert.equal(g.redo(live2).ok, true);
  g.record(typed("Three.かねこ", "Three.か"), 12500);
  assert.equal(g.dropEmptySince(m2, true), true);
  assert.deepEqual(g.sizes(), { undo: 1, redo: 1 });
  assert.equal(g.redo(live2).ok, true);
  assert.equal(live2.rows[0].status, "shot");
});

test("history: a drop after an undo and redo that pushed entries out of 200 puts them back and brings back the redo from before the typing", () => {
  const h = createUndoHistory(cellRuns);
  for (let i = 0; i < 200; i++) h.record(status("s" + i), i * 2000);
  const live = doc(Array.from({ length: 200 }, (_, i) => row("s" + i, "", { status: "shot" })).concat([row("r1", "aか")]));
  assert.equal(h.undo(live).ok, true);
  const mark = h.markCell("r1", "audioText", "a");
  h.record(typed("a", "ak"), 500000);
  h.record(typed("ak", "aか"), 502000);
  assert.equal(h.undo(live).ok, true);
  assert.equal(h.redo(live).ok, true);
  h.record(typed("aか", "a"), 504000);
  assert.deepEqual(h.sizes(), { undo: 200, redo: 0 });
  assert.equal(h.dropEmptySince(mark, true), true);
  assert.deepEqual(h.sizes(), { undo: 199, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[199].status, "shot");
  for (let i = 0; i < 200; i++) assert.equal(h.undo(live).ok, true, "undo " + i);
  assert.equal(live.rows[0].status, "todo", "the oldest entry came back");
});

test("history: a drop gives back the redo its own typing cleared and nothing the earlier typing cleared from the same point", () => {
  const h = createUndoHistory(cellRuns);
  const live = doc(Array.from({ length: 150 }, (_, i) => row("s" + i, "", { status: "shot" }))
    .concat(Array.from({ length: 100 }, (_, i) => row("q" + i, "", { status: "shot" })), [row("r1", "ax"), row("r2", "b")]));
  for (let i = 0; i < 150; i++) h.record(status("s" + i), i * 2000);
  for (let i = 0; i < 150; i++) assert.equal(h.undo(live).ok, true);
  h.record(typed("a", "ax"), 400000);
  for (let i = 0; i < 100; i++) h.record(status("q" + i), 402000 + i * 2000);
  for (let i = 0; i < 101; i++) assert.equal(h.undo(live).ok, true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 101 });
  h.record(inR2("b", "by"), 900000);
  h.record(inR2("by", "b"), 900100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 101 });
  assert.deepEqual(h.nextRedo().steps, typed("a", "ax"));
  for (let i = 0; i < 101; i++) assert.equal(h.redo(live).ok, true, "redo " + i);
  assert.equal(h.redo(live).empty, true);
  assert.equal(live.rows[249].status, "shot");
  assert.equal(live.rows[149].status, "todo", "the changes the earlier typing cleared stay cleared");
});

test("history: after the typing was undone, or undone and redone, a merge that forgets it means a later drop gives nothing back", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" }), row("r1", "ax")]);
  assert.equal(h.undo(live).ok, true);
  h.record(typed("a", "ax"), 5000);
  assert.equal(h.undo(live).ok, true);
  h.forget(changedBetween(doc([row("r1", "a")]), doc([row("r1", "a theirs")])));
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 });
  h.record(inR2("b", "by"), 9000);
  h.record(inR2("by", "b"), 9100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 });

  const g = createUndoHistory(cellRuns);
  const live2 = doc([row("r9", "", { status: "shot" }), row("r1", "ax")]);
  g.record(status("r9"), 0);
  assert.equal(g.undo(live2).ok, true);
  g.record(typed("a", "ax"), 5000);
  assert.equal(g.undo(live2).ok, true);
  assert.equal(g.redo(live2).ok, true);
  g.forget(changedBetween(doc([row("r1", "ax")]), doc([row("r1", "ax theirs")])));
  assert.deepEqual(g.sizes(), { undo: 0, redo: 0 });
  g.record(inR2("b", "by"), 9000);
  g.record(inR2("by", "b"), 9100);
  assert.deepEqual(g.sizes(), { undo: 0, redo: 0 }, "an undone and redone typing that a merge forgot is no different");
});

test("history: after a refused undo of the typing, a later drop gives back no redo from before it", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  assert.equal(h.undo(doc([row("r9", "", { status: "shot" })])).ok, true);
  h.record(typed("a", "ax"), 5000);
  assert.equal(h.undo(doc([row("r9")])).ok, false);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 });
  h.record(inR2("b", "by"), 9000);
  h.record(inR2("by", "b"), 9100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 }, "the typing is still in the document");
});

test("history: redo that a merge forgot stays forgotten when the typing that cleared it drops", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  h.record(status("r8"), 100);
  const live = doc([row("r9", "", { status: "shot" }), row("r8", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  assert.equal(h.undo(live).ok, true);
  h.record(typed("a", "ax"), 5000);
  h.forget(changedBetween(doc([row("r9", "", { status: "todo" })]), doc([row("r9", "", { status: "cut" })])));
  h.record(typed("ax", "a"), 5100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.deepEqual(h.nextRedo().steps, status("r8"));
});

test("history: a merge that forgets the real edit that cleared redo keeps that redo cleared when a later typing drops", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  h.record(typed("a", "ax"), 5000);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  h.forget(changedBetween(doc([row("r1", "ax")]), doc([row("r1", "ax theirs")])));
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 });
  h.record(inR2("b", "bx"), 9000);
  h.record(inR2("bx", "b"), 9100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 }, "the typing in r1 is still in the document, so the r9 change stays cleared");
  assert.equal(h.redo(live).empty, true);

  const g = createUndoHistory(cellRuns);
  g.record(status("r9"), 0);
  const live2 = doc([row("r9", "", { status: "shot" })]);
  assert.equal(g.undo(live2).ok, true);
  g.record([{ op: "moveRow", from: 0, to: 1 }], 5000);
  g.forget(changedBetween(doc([row("r9"), row("r1", "a")]), doc([row("r9"), row("r1", "a"), row("r2")])));
  assert.deepEqual(g.sizes(), { undo: 0, redo: 0 });
  const mark = g.markCell("r1", "audioText", "a");
  g.record(typed("a", "aね"), 9000);
  g.record(typed("aね", "a"), 10100);
  assert.equal(g.dropEmptySince(mark), true);
  assert.deepEqual(g.sizes(), { undo: 0, redo: 0 }, "a structural edit a merge forgot is the same");
});

test("history: clear drops the parked redo, so the next document never gets the last one's redo back", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  assert.equal(h.undo(doc([row("r9", "", { status: "shot" })])).ok, true);
  h.record(typed("a", "ax"), 5000);
  h.clear();
  h.record(typed("b", "bx"), 9000);
  h.record(typed("bx", "b"), 9100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 });
});

test("history: a fast cancel joined to earlier typing, with the revert before compositionend, gives that typing back its own time and word state", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Three.", "Three.か"), 0);
  const mark = h.markCell("r1", "audioText", "Three.か");
  h.record(typed("Three.か", "Three.か "), 100);
  h.record(typed("Three.か ", "Three.か"), 200);
  assert.equal(h.sizes().undo, 1);
  assert.equal(h.top().steps[0].after, "Three.か", "the revert left the entry's end as it was");
  assert.equal(h.dropEmptySince(mark), true);
  assert.equal(h.top().at, 0);
  assert.equal(h.top().endsInSpace, false);
  h.record(typed("Three.か", "Three.かx"), 1050);
  assert.equal(h.sizes().undo, 2, "a keystroke a second after the typing is its own step");
});

test("history: typing that coalesced into the entry under it gives redo back only when that entry decodes as it did, not when only its text matches", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Three.", "Three.a"), 0);
  h.record(status("r9"), 100);
  const live = doc([row("r9", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  h.record(typed("Three.a", "Three.ax"), 200);
  h.record(typed("Three.ax", "<b>Three.a</b>"), 300);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 }, "bold is not where it was");
  h.record(typed("<b>Three.a</b>", "Three.a"), 400);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 1 });
  assert.equal(h.top().steps[0].after, "Three.a");
});

test("history: dropEmptySince brings back the redo the composition cleared, slow or joined to earlier typing", () => {
  const h = createUndoHistory(cellRuns);
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Third.ね"), 5000);
  h.record(typed("Third.ね", "Third.ねこ"), 6100);
  h.record(typed("Third.ねこ", "Third."), 7200);
  assert.deepEqual(h.sizes(), { undo: 3, redo: 0 });
  assert.equal(h.dropEmptySince(mark), true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[0].status, "shot");

  const g = createUndoHistory(cellRuns);
  g.record(typed("Three.", "Three.か"), 10000);
  g.record(status("r9"), 10100);
  const live2 = doc([row("r9", "", { status: "shot" })]);
  assert.equal(g.undo(live2).ok, true);
  const m2 = g.markCell("r1", "audioText", "Three.か");
  g.record(typed("Three.か", "Three.かね"), 10300);
  g.record(typed("Three.かね", "Three.かねこ"), 11400);
  g.record(typed("Three.かねこ", "Three.か"), 12500);
  assert.deepEqual(g.sizes(), { undo: 3, redo: 0 });
  assert.equal(g.dropEmptySince(m2), true);
  assert.deepEqual(g.sizes(), { undo: 1, redo: 1 });
  assert.deepEqual(g.top().steps, typed("Three.", "Three.か"));
  assert.equal(g.redo(live2).ok, true);
  assert.equal(live2.rows[0].status, "shot");
});

test("history: a dropped step that pushed entries out of 200 puts them back and brings back the redo", () => {
  const rows = () => doc(Array.from({ length: 200 }, (_, i) => row("s" + i, "", { status: "shot" })));
  const h = createUndoHistory(cellRuns);
  for (let i = 0; i < 200; i++) h.record(status("s" + i), i * 2000);
  const live = rows();
  assert.equal(h.undo(live).ok, true);
  const mark = h.markCell("r1", "audioText", "a");
  h.record(typed("a", "ak"), 500000);
  h.record(typed("ak", "aか"), 502000);
  h.record(typed("aか", "a"), 504000);
  assert.deepEqual(h.sizes(), { undo: 200, redo: 0 });
  assert.equal(h.dropEmptySince(mark), true);
  assert.deepEqual(h.sizes(), { undo: 199, redo: 1 });
  assert.equal(h.redo(live).ok, true);
  assert.equal(live.rows[199].status, "shot");
  for (let i = 0; i < 200; i++) assert.equal(h.undo(live).ok, true, "undo " + i);
  assert.equal(live.rows[0].status, "todo", "the oldest entry came back");

  const g = createUndoHistory(cellRuns);
  for (let i = 0; i < 200; i++) g.record(status("s" + i), i * 2000);
  const live2 = rows();
  assert.equal(g.undo(live2).ok, true);
  g.record(typed("a", "a "), 500000);
  g.record(typed("a ", "a y"), 500100);
  assert.deepEqual(g.sizes(), { undo: 200, redo: 0 });
  g.record(typed("a y", "a "), 500200);
  assert.deepEqual(g.sizes(), { undo: 200, redo: 0 }, "the word's entry went and gave back the one it pushed out; the space's entry still stands");
  g.record(typed("a ", "a"), 500300);
  assert.deepEqual(g.sizes(), { undo: 199, redo: 1 });
  assert.equal(g.redo(live2).ok, true);
  assert.equal(live2.rows[199].status, "shot");
});

test("history: a dropped entry that pushed the oldest of 200 out puts it back", () => {
  const h = createUndoHistory(cellRuns);
  for (let i = 0; i < 200; i++) h.record(status("s" + i), i * 2000);
  assert.equal(h.sizes().undo, 200);
  h.record(typed("a", "ax"), 500000);
  assert.equal(h.sizes().undo, 200);
  h.record(typed("ax", "a"), 500100);
  assert.equal(h.sizes().undo, 200);
  const live = doc(Array.from({ length: 200 }, (_, i) => row("s" + i, "", { status: "shot" })));
  for (let i = 0; i < 200; i++) assert.equal(h.undo(live).ok, true, "undo " + i);
  assert.equal(h.undo(live).empty, true);
  assert.equal(live.rows[0].status, "todo", "the oldest entry came back");
});

test("history: a merge that forgets the entry a drop would put back keeps it forgotten", () => {
  const h = createUndoHistory(cellRuns);
  for (let i = 0; i < 200; i++) h.record(status("s" + i), i * 2000);
  h.record(typed("a", "ax"), 500000);
  const prev = doc([row("s0", "", { status: "shot" })]);
  const next = doc([row("s0", "", { status: "todo" })]);
  h.forget(changedBetween(prev, next));
  assert.equal(h.sizes().undo, 200);
  h.record(typed("ax", "a"), 500100);
  assert.equal(h.sizes().undo, 199);
});

test("history: dropEmptySince drops every entry since the mark when they are one cell's typing that ends where it began", () => {
  const h = createUndoHistory(cellRuns);
  const early = h.markCell("r1", "audioText", "Third.");
  h.record(status("r9"), 0);
  const mark = h.markCell("r1", "audioText", "Third.");
  h.record(typed("Third.", "Third.ね"), 5000);
  h.record(typed("Third.ね", "Third.ねこ"), 6100);
  h.record(typed("Third.ねこ", "Third."), 7200);
  assert.equal(h.sizes().undo, 4);
  assert.equal(h.dropEmptySince(mark), true);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  assert.deepEqual(h.top().steps, status("r9"));
  assert.equal(h.dropEmptySince(mark), false, "nothing is left since the mark");
  assert.equal(h.dropEmptySince(early), false, "an entry older than the mark is never dropped");
  assert.equal(h.sizes().undo, 1);
});

test("history: dropEmptySince keeps entries that end somewhere else, span two cells, or hold more than typing", () => {
  const cases = [
    [typed("a", "ak"), typed("ak", "aか")],
    [typed("a", "ax"), typed("", "y", "visualText"), typed("y", "", "visualText"), typed("ax", "a")],
    [typed("a", "ax"), typed("ax", "a").concat(status("r9"))]
  ];
  for (const steps of cases) {
    const h = createUndoHistory(cellRuns);
    h.record(status("r8"), 0);
    const mark = h.markCell("r1", "audioText", "a");
    steps.forEach((s, i) => h.record(s, 5000 + i * 2000));
    const sizes = h.sizes();
    assert.equal(h.dropEmptySince(mark), false, JSON.stringify(steps));
    assert.deepEqual(h.sizes(), sizes);
  }
});

test("history: dropEmptySince puts back the entries the dropped ones pushed out of 200", () => {
  const h = createUndoHistory(cellRuns);
  for (let i = 0; i < 200; i++) h.record(status("s" + i), i * 2000);
  const mark = h.markCell("r1", "audioText", "a");
  h.record(typed("a", "ak"), 500000);
  h.record(typed("ak", "aか"), 502000);
  h.record(typed("aか", "a"), 504000);
  assert.equal(h.sizes().undo, 200);
  assert.equal(h.dropEmptySince(mark), true);
  assert.equal(h.sizes().undo, 200);
  const live = doc(Array.from({ length: 200 }, (_, i) => row("s" + i, "", { status: "shot" })));
  for (let i = 0; i < 198; i++) assert.equal(h.undo(live).ok, true, "undo " + i);
  assert.deepEqual(live.rows.slice(0, 4).map((r) => r.status), ["shot", "shot", "todo", "todo"], "they came back in their order");
  assert.equal(h.undo(live).ok, true);
  assert.equal(h.undo(live).ok, true);
  assert.deepEqual(live.rows.slice(0, 3).map((r) => r.status), ["todo", "todo", "todo"]);
});

test("history: dropEmptySince decides against the cell's value at the mark, so a composition whose first update joined earlier typing drops its own entries and gives that typing back its own end", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Three.", "Three.か"), 0);
  const mark = h.markCell("r1", "audioText", "Three.か");
  h.record(typed("Three.か", "Three.かね"), 100);
  h.record(typed("Three.かね", "Three.かねこ"), 1200);
  h.record(typed("Three.かねこ", "Three.か"), 2300);
  assert.equal(h.sizes().undo, 3);
  assert.equal(h.dropEmptySince(mark), true);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  assert.deepEqual(h.top().steps, typed("Three.", "Three.か"));
  h.record(typed("Three.か", "Three.かx"), 1050);
  assert.equal(h.sizes().undo, 2, "the typing's own time is back too, so a keystroke a second after it is its own step");
  const live = doc([row("r1", "Three.かx")]);
  assert.equal(h.undo(live).ok, true);
  assert.equal(h.undo(live).ok, true);
  assert.equal(live.rows[0].audioText, "Three.");
  assert.equal(h.undo(live).empty, true);
});

test("history: a joined composition that ended in a space and was cancelled gives the typing back its own word state", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Three.", "Three.か"), 0);
  const mark = h.markCell("r1", "audioText", "Three.か");
  h.record(typed("Three.か", "Three.か "), 100);
  h.record(typed("Three.か ", "Three.か"), 1200);
  assert.equal(h.dropEmptySince(mark), true);
  h.record(typed("Three.か", "Three.かx"), 300);
  assert.equal(h.sizes().undo, 1, "x does not start a new word after the cancelled space");
});

test("history: dropEmptySince against the value at the mark keeps a joined composition that ends somewhere else, or reaches another cell", () => {
  const h = createUndoHistory(cellRuns);
  h.record(typed("Three.", "Three.か"), 0);
  const mark = h.markCell("r1", "audioText", "Three.か");
  h.record(typed("Three.か", "Three.かね"), 100);
  h.record(typed("Three.かね", "Three."), 1200);
  assert.equal(h.dropEmptySince(mark), false, "back to before the earlier typing is not back to the mark");
  assert.equal(h.sizes().undo, 2);
  const g = createUndoHistory(cellRuns);
  g.record(typed("Three.", "Three.か"), 0);
  const m2 = g.markCell("r1", "visualText", "");
  g.record(typed("Three.か", "Three.かね"), 100);
  g.record(typed("Three.かね", "Three.か"), 1200);
  assert.equal(g.dropEmptySince(m2), false, "the mark was taken in another cell");
  assert.equal(g.sizes().undo, 2);
});

test("history: an entry that pushes one out of 200 keeps only that one, not the chain of every entry pushed out before it", () => {
  const h = createUndoHistory(cellRuns);
  for (let i = 0; i < 2000; i++) h.record(typed("c" + i, "c" + i + "x", i % 2 ? "visualText" : "audioText").map((s) => Object.assign(s, { rowId: "r" + (i % 7) })), i * 2000);
  assert.equal(h.sizes().undo, 200);
  let depth = 0;
  for (let e = h.top(); e.evicted; e = e.evicted) depth++;
  assert.equal(depth, 1);
});

test("caretAfterStep: the end of what differs, in the DOM's text", () => {
  const typed = { op: "rowField", rowId: "r1", key: "audioText", before: "one<br>two", after: "one<br>two three" };
  assert.equal(caretAfterStep(typed), "onetwo three".length, "redo: end of the retyped text");
  assert.equal(caretAfterStep(invertSteps([typed])[0]), "onetwo".length, "undo: where the typing began");
});

test("caretAfterStep: a common character right at the edit doesn't grow the match past it (#119)", () => {
  const typed = { op: "rowField", rowId: "r1", key: "audioText", before: "Alpha beta", after: "Alpha mid beta" };
  assert.equal(caretAfterStep(invertSteps([typed])[0]), "Alpha".length, "undo: right after \"Alpha\", not after its space too");
  assert.equal(caretAfterStep(typed), "Alpha mid".length, "redo: end of the retyped word");
});

test("caretAfterStep: a change of marks alone lands at the end of it, not at 0", () => {
  const bold = { op: "rowField", rowId: "r1", key: "audioText",
    before: "one two three four five", after: "one two three <strong>four</strong> five" };
  assert.equal(caretAfterStep(bold), "one two three four".length, "redo: after the bolded word");
  assert.equal(caretAfterStep(invertSteps([bold])[0]), "one two three four".length, "undo: the same");
  const cue = { op: "rowField", rowId: "r1", key: "audioText",
    before: "Line one<br>SFX:", after: "Line one<br><span class=\"audio-cue\">SFX:</span>" };
  assert.equal(caretAfterStep(invertSteps([cue])[0]), "Line oneSFX:".length);
  const dir = { op: "rowField", rowId: "r1", key: "audioText",
    before: "Hi there. Go", after: "Hi <span class=\"stage-dir\">there.</span> Go" };
  assert.equal(caretAfterStep(invertSteps([dir])[0]), "Hi there.".length);
  assert.equal(caretAfterStep(dir), "Hi there.".length);
});

test("caretAfterStep: Tab closing a plain-language tag, undone and redone (#210)", () => {
  const tagged = { op: "rowField", rowId: "r1", key: "visualText", before: "Wide VFX: lens flare",
    after: "Wide <span class=\"tag-anchor\" data-tag-cat=\"vfx\" data-tag-name=\"lens flare\" contenteditable=\"false\">lens flare</span>" };
  assert.equal(caretAfterStep(invertSteps([tagged])[0]), "Wide VFX: lens flare".length, "undo: where the caret was when Tab closed it");
  assert.equal(caretAfterStep(tagged), "Wide lens flare".length, "redo: after the tag");
});

test("caretAfterStep: never lands between the two halves of an emoji's surrogate pair", () => {
  const typed = { op: "rowField", rowId: "r1", key: "audioText", before: "a😀b", after: "a😀Xb" };
  const offset = caretAfterStep(invertSteps([typed])[0]);
  assert.equal(offset, "a😀".length);
});

test("diffStates: deleting the scene constructor is a deleteRow, as for any other id (#311)", () => {
  const steps = diffStates({ rows: [{ id: "r1", audioText: "one" }, { id: "constructor", audioText: "two" }] }, { rows: [{ id: "r1", audioText: "one" }] });
  assert.deepEqual(steps, [{ op: "deleteRow", index: 1, row: { id: "constructor", audioText: "two" } }]);
});

for (const x of PROTOTYPE_IDS) {
  test(`undo and redo: a scene with the id "${x}" is deleted, inserted, moved and edited like any other (#311)`, () => {
    const base = doc([row("r1", "one"), row(x, "two"), row("r3", "three")]);
    const cases = [
      doc([row("r1", "one"), row("r3", "three")]),
      doc([row(x, "two"), row("r1", "one"), row("r3", "three")]),
      doc([row("r1", "one"), row(x, "TWO", { status: "shot" }), row("r3", "three")])
    ];
    for (const after of cases) roundTrip(base, after);
    roundTrip(doc([row("r1", "one")]), doc([row("r1", "one"), row(x, "new")]));
    assert.deepEqual(diffStates(doc([row("r1", "one")]), doc([row("r1", "one"), row(x, "new")])).map((s) => s.op), ["insertRow"]);
  });

  test(`applyStepsLive refuses a step for a missing scene "${x}" and inserts a new one (#311)`, () => {
    const live = doc([row("r1", "one")]);
    const edit = { op: "rowField", rowId: x, key: "audioText", before: "two", after: "TWO" };
    assert.deepEqual(applyStepsLive(cellRuns, live, [edit]), { ok: false, reason: "a scene it changed has gone" });
    assert.deepEqual(applyStepsLive(cellRuns, live, [{ op: "insertRow", index: 1, row: row(x, "two") }]), { ok: true });
    assert.deepEqual(live.rows.map((r) => r.id), ["r1", x]);
    assert.deepEqual(applyStepsLive(cellRuns, live, [edit]), { ok: true });
    assert.equal(live.rows[1].audioText, "TWO");
  });

  test(`changedBetween: a scene "${x}" added or edited is reported as such (#311)`, () => {
    const prev = doc([row("r1", "one")]);
    const next = doc([row("r1", "one"), row(x, "two")]);
    assert.deepEqual(changedBetween(prev, next), { rowFields: {}, structure: true, doc: {}, items: {} });
    const edited = doc([row("r1", "one"), row(x, "TWO")]);
    assert.deepEqual(Object.keys(changedBetween(next, edited).rowFields), [x + "\u0000audioText"]);
  });
}
