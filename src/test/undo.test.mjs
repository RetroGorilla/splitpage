import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { applyStepsLive, caretAfterStep, changedBetween, createUndoHistory, diffStates } from "../js/12a-undo.js";
import { invertSteps } from "../js/04c-doc-model.js";
import { PROTOTYPE_IDS } from "../core/document/id-map.ts";

const row = (id, audio, extra) => Object.assign({ id, status: "todo", visualText: "", audioText: audio || "" }, extra);
const doc = (rows, extra) => Object.assign({ title: "T", docId: "d1", rev: 3, rows, comments: [], productionTags: [], people: [], brollShots: [] }, extra);
const clone = (v) => JSON.parse(JSON.stringify(v));

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
  live.rows[0].audioText = "alpha BRAVO charlie delta";
  assert.deepEqual(applyStepsLive(live, invertSteps([step])), { ok: true });
  assert.equal(live.rows[0].audioText, "alpha bravo charlie delta");
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

const typed = (b, a, key) => [{ op: "rowField", rowId: "r1", key: key || "audioText", before: b, after: a }];
const status = (id) => [{ op: "rowField", rowId: id, key: "status", before: "todo", after: "shot" }];

test("history: typing that coalesces back to where its entry began drops the entry, and the one below is the top again", () => {
  const h = createUndoHistory();
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
  const h = createUndoHistory();
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
  const h = createUndoHistory();
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
  const h = createUndoHistory();
  h.record(typed("Three.", "Three.x"), 0);
  h.record(typed("Three.x", "<span>Three.</span><b></b>"), 100);
  assert.equal(h.sizes().undo, 0);
  h.record(typed("Three.", "Three.x"), 5000);
  h.record(typed("Three.x", "<b>Three.</b>"), 5100);
  assert.equal(h.sizes().undo, 1, "bold text is not where it began");
  assert.equal(h.top().steps[0].after, "<b>Three.</b>");
});

test("history: a drop keeps redo as typing leaves it: the first keystroke cleared it, and it stays cleared", () => {
  const h = createUndoHistory();
  h.record(status("r9"), 0);
  const live = doc([row("r9", "", { status: "shot" })]);
  assert.equal(h.undo(live).ok, true);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 1 });
  h.record(typed("a", "ax"), 5000);
  h.record(typed("ax", "a"), 5100);
  assert.deepEqual(h.sizes(), { undo: 0, redo: 0 });
});

test("history: a dropped entry that pushed the oldest of 200 out puts it back", () => {
  const h = createUndoHistory();
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
  const h = createUndoHistory();
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
  const h = createUndoHistory();
  h.record(status("r9"), 0);
  const mark = h.mark();
  h.record(typed("Third.", "Third.ね"), 5000);
  h.record(typed("Third.ね", "Third.ねこ"), 6100);
  h.record(typed("Third.ねこ", "Third."), 7200);
  assert.equal(h.sizes().undo, 4);
  assert.equal(h.dropEmptySince(mark), true);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  assert.deepEqual(h.top().steps, status("r9"));
  assert.equal(h.dropEmptySince(mark), false, "nothing is left since the mark");
  assert.equal(h.dropEmptySince(0), false, "an entry older than the mark is never dropped");
  assert.equal(h.sizes().undo, 1);
});

test("history: dropEmptySince keeps entries that end somewhere else, span two cells, or hold more than typing", () => {
  const cases = [
    [typed("a", "ak"), typed("ak", "aか")],
    [typed("a", "ax"), typed("", "y", "visualText"), typed("y", "", "visualText"), typed("ax", "a")],
    [typed("a", "ax"), typed("ax", "a").concat(status("r9"))]
  ];
  for (const steps of cases) {
    const h = createUndoHistory();
    h.record(status("r8"), 0);
    const mark = h.mark();
    steps.forEach((s, i) => h.record(s, 5000 + i * 2000));
    const sizes = h.sizes();
    assert.equal(h.dropEmptySince(mark), false, JSON.stringify(steps));
    assert.deepEqual(h.sizes(), sizes);
  }
});

test("history: dropEmptySince puts back the entries the dropped ones pushed out of 200", () => {
  const h = createUndoHistory();
  for (let i = 0; i < 200; i++) h.record(status("s" + i), i * 2000);
  const mark = h.mark();
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
    assert.deepEqual(applyStepsLive(live, [edit]), { ok: false, reason: "a scene it changed has gone" });
    assert.deepEqual(applyStepsLive(live, [{ op: "insertRow", index: 1, row: row(x, "two") }]), { ok: true });
    assert.deepEqual(live.rows.map((r) => r.id), ["r1", x]);
    assert.deepEqual(applyStepsLive(live, [edit]), { ok: true });
    assert.equal(live.rows[1].audioText, "TWO");
  });

  test(`changedBetween: a scene "${x}" added or edited is reported as such (#311)`, () => {
    const prev = doc([row("r1", "one")]);
    const next = doc([row("r1", "one"), row(x, "two")]);
    assert.deepEqual(changedBetween(prev, next), { rowFields: {}, structure: true, doc: {} });
    const edited = doc([row("r1", "one"), row(x, "TWO")]);
    assert.deepEqual(Object.keys(changedBetween(next, edited).rowFields), [x + "\u0000audioText"]);
  });
}
