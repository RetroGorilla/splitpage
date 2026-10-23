import "./_dom.mjs";
import { bootApp, clearTimers, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import { baseStateReason, setBaseState } from "../js/03-sync.js";
import { applyMerge, mergeStates } from "../legacy/merge-bridge.ts";
import { mergeUndo } from "../legacy/editor-bridge.ts";
import { getHistorySnapshot, listDocHistory } from "../js/03a-history-store.js";
import { personById } from "../core/production/records.ts";
import { currentDocument } from "../legacy/session-bridge.ts";
import { cloneState } from "../core/document/clone.ts";
import { loadTestDocument } from "./_document.mjs";
import { holdMergeBase, mergeBase } from "../legacy/session-bridge.ts";

await bootApp();
await window.__historyTest.forceBackend("memory");
after(() => {
  loadTestDocument(mk(freshId()));
  closeApp();
});

let seq = 0;
function mk(docId) {
  return migrateRows({
    docId: docId,
    title: "M",
    rows: [
      { id: "r1", visualText: "v1", audioText: "a1" },
      { id: "r2", visualText: "v2", audioText: "a2" }
    ]
  });
}
function freshId() {
  seq++;
  return "d" + String(seq).padStart(32, "0");
}

function unstamped(s) {
  const c = cloneState(s);
  c.rows.forEach(function (r) { r.updatedAt = ""; });
  return c;
}

let untouched = null;

function reset() {
  clearTimers();
  loadTestDocument({ sentinel: "state" });
  untouched = { held: currentDocument(), json: JSON.stringify(currentDocument()) };
  holdMergeBase({ sentinel: "base" });
  mergeUndo().arm({ id: "s-earlier", docId: "d-earlier" });
}

test("mergeOnly merges and hands the result back, touching nothing on screen", () => {
  reset();
  const id = freshId();
  const base = mk(id), mine = mk(id), theirs = mk(id);
  mine.rows[0].audioText = "mine";
  theirs.rows[1].audioText = "theirs";

  const direct = mergeStates(cloneState(base), cloneState(mine), cloneState(theirs)).merged;

  const out = applyMerge({
    base: base, mine: mine, theirs: theirs,
    source: "stash", mergeOnly: true, undoPoint: cloneState(theirs)
  });
  assert.deepEqual(unstamped(out.state), unstamped(direct));
  assert.equal(out.result.merged, out.state);
  assert.equal(currentDocument(), untouched.held);
  assert.equal(JSON.stringify(currentDocument()), untouched.json);
  assert.deepEqual(mergeBase(), { sentinel: "base" });
});

test("`base` and `mine` are normalised, so a caller hands over what it holds", () => {
  reset();
  const id = freshId();
  const theirs = mk(id);
  const mine = { docId: id, title: "M", rows: [
    { id: "r1", visualText: "v1", audioText: "typed" },
    { id: "r2", visualText: "v2", audioText: "a2" }
  ] };

  const out = applyMerge({
    base: mk(id), mine: mine, theirs: theirs, source: "stash", mergeOnly: true
  });
  assert.equal(out.state.rows.length, 2);
  assert.equal(out.state.rows[0].audioText, "typed");
  assert.equal(out.result.stats.rowsFromMe, 1);
});

test("`theirs` arrives as it is: lists of the wrong shape in it merge as their objects, and applyMerge hands back a migrated state (#304)", () => {
  reset();
  const id = freshId();
  const mine = mk(id);
  mine.rows[0].audioText = "typed";
  const theirs = { docId: id, title: "M", rows: [mine.rows[1], "x", null], comments: {}, people: "Sam", productionTags: { 0: "x" }, brollShots: 7 };
  const before = JSON.stringify(theirs);

  const out = applyMerge({ base: mk(id), mine: mine, theirs: theirs, source: "stash", mergeOnly: true });
  assert.equal(JSON.stringify(theirs), before, "their copy is left as it came");
  assert.deepEqual(out.state.rows.map((r) => [r.id, r.audioText]), [["r1", "typed"], ["r2", "a2"]]);
  assert.deepEqual([out.state.comments, out.state.people, out.state.productionTags, out.state.brollShots], [[], [], [], []]);
  assert.equal(out.result.stats.rowsAddedByThem, 0, "nothing that is not a scene counts as one");
  assert.deepEqual(migrateRows(cloneState(out.state)), out.state);
});

test("a recovered stash where both sides added the same person: the merged script still names my items' owner (#283)", async () => {
  reset();
  const id = freshId();
  const base = mk(id);
  const mine = mk(id);
  mine.people = [{ id: "pMine", name: "Ada" }];
  mine.productionTags = [{ cat: "prop", name: "Lamp", owner: "pMine", notes: "", status: "needed" }];
  mine.brollShots = [{ id: "b1", name: "Harbour", owner: "pMine" }];
  const theirs = mk(id);
  theirs.people = [{ id: "pTheirs", name: "ada" }];

  const out = applyMerge({ base: base, mine: mine, theirs: theirs, source: "stash", mergeOnly: true });
  loadTestDocument(out.state);
  assert.deepEqual(currentDocument().people, [{ id: "pTheirs", name: "ada" }]);
  assert.equal(personById(currentDocument(), currentDocument().productionTags.find((t) => t.name === "Lamp").owner).name, "ada");
  assert.equal(personById(currentDocument(), currentDocument().brollShots[0].owner).name, "ada");
  assert.deepEqual(migrateRows(cloneState(currentDocument())).brollShots[0].owner, "pTheirs", "and a reload keeps it");
});

test("pictures merge by sha through applyMerge, and a stash's legacy inline one is the same picture (#82)", () => {
  reset();
  const id = freshId();
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const theirs = mk(id);
  theirs.rows[0].audioText = "theirs";
  const legacyRows = () => [
    { id: "r1", visualText: "v1", audioText: "a1", visualImage: png },
    { id: "r2", visualText: "v2", audioText: "a2" }
  ];
  const base = { docId: id, title: "M", rows: legacyRows() };
  const mine = { docId: id, title: "M", rows: legacyRows() };
  mine.rows[1].audioText = "mine";
  theirs.rows[0].imageRef = migrateRows({ rows: [{ id: "x", visualImage: png }] }).rows[0].imageRef;
  const out = applyMerge({ base: base, mine: mine, theirs: theirs, source: "stash", mergeOnly: true });
  assert.equal(out.result.conflicts.length, 0, "the same picture on both sides is no conflict");
  assert.deepEqual(out.state.rows[0].imageRef, theirs.rows[0].imageRef);
  assert.equal(out.state.rows[0].audioText, "theirs");
  assert.equal(out.state.rows[1].audioText, "mine");
});

test("nothing differed: no merge, no snapshot, no rev bump", () => {
  reset();
  const id = freshId();
  const theirs = mk(id);
  theirs.rev = 7;

  const out = applyMerge({ theirs: theirs, source: "stash", mergeOnly: true, unchanged: true });
  assert.equal(out.state, theirs);
  assert.equal(out.result, null);
  assert.equal(out.snapshot, null);
  assert.equal(out.state.rev, 7, "max-plus-one never ran");
  assert.deepEqual(mergeUndo().last(), { id: "s-earlier", docId: "d-earlier" });
});

for (const [source, label] of [
  ["stash", "Before merging your unsaved changes"],
  ["server-resume", "Before merging your recovered changes"],
  ["server-conflict", "Before merging in someone else's changes"]
]) {
  test("source '" + source + "' files its undo point as “" + label + "”", async () => {
    reset();
    const id = freshId();
    const theirs = mk(id);
    const mine = mk(id);
    mine.rows[0].audioText = "mine";

    const out = applyMerge({
      base: mk(id), mine: mine, theirs: theirs,
      source: source, mergeOnly: true, undoPoint: cloneState(theirs)
    });
    assert.ok(out.snapshot, "a ticket, synchronously");
    assert.deepEqual(mergeUndo().last(), { id: out.snapshot.id, docId: id, source: source });

    await out.snapshot.done;
    const listed = await listDocHistory(id);
    const filed = listed.entries.filter(function (e) { return e.id === out.snapshot.id; });
    assert.equal(filed.length, 1);
    assert.equal(filed[0].label, label);
  });
}

test("keepLabel files the recovered version alongside the undo point", async () => {
  reset();
  const id = freshId();
  const theirs = mk(id);
  const mine = mk(id);
  mine.title = "recovered";

  const out = applyMerge({
    base: mk(id), mine: mine, theirs: theirs,
    source: "server-resume", mergeOnly: true,
    undoPoint: cloneState(theirs),
    keepLabel: "Your unsaved changes, recovered"
  });
  await out.snapshot.done;
  const listed = await listDocHistory(id);
  const labels = listed.entries.map(function (e) { return e.label; }).sort();
  assert.deepEqual(labels, ["Before merging your recovered changes", "Your unsaved changes, recovered"]);
  const recovered = listed.entries.filter(function (e) { return e.label === "Your unsaved changes, recovered"; })[0];
  assert.equal(recovered.title, "recovered");
});

test("server-conflict arms Undo merge at MINE, the version being saved (#97)", async () => {
  reset();
  const id = freshId();
  const mine = mk(id);
  mine.rows[0].audioText = "mine";
  const theirs = mk(id);
  theirs.rows[1].audioText = "theirs";

  const out = applyMerge({
    base: mk(id), mine: mine, theirs: theirs,
    source: "server-conflict", mergeOnly: true,
    undoPoint: cloneState(mine)
  });
  assert.ok(out.snapshot);
  assert.deepEqual(mergeUndo().last(), { id: out.snapshot.id, docId: id, source: "server-conflict" });
  assert.equal(out.state.rows[1].audioText, "theirs", "the merge took theirs");

  await out.snapshot.done;
  const listed = await listDocHistory(id);
  const filed = listed.entries.filter(function (e) { return e.id === out.snapshot.id; });
  assert.equal(filed.length, 1);
  const got = await getHistorySnapshot({ docId: id, id: out.snapshot.id });
  const held = JSON.parse(got.stateJson);
  assert.equal(held.rows[0].audioText, "mine", "the undo point holds mine");
  assert.equal(held.rows[1].audioText, "a2", "and not the merged document");
});

test("an undo point the store refuses clears Undo merge rather than leaving it stale", () => {
  reset();
  const id = freshId();
  const mine = mk(id);
  mine.rows[0].audioText = "mine";

  const out = applyMerge({
    base: mk(id), mine: mine, theirs: mk(id),
    source: "stash", mergeOnly: true, undoPoint: { docId: id, rows: null }
  });
  assert.equal(out.snapshot, null);
  assert.equal(mergeUndo().last(), null);
  assert.ok(out.result, "the merge still happened");
});

test("no undo point asked for leaves Undo merge alone", () => {
  reset();
  const id = freshId();
  const mine = mk(id);
  mine.rows[0].audioText = "mine";

  applyMerge({ base: mk(id), mine: mine, theirs: mk(id), source: "server-resume", mergeOnly: true });
  assert.deepEqual(mergeUndo().last(), { id: "s-earlier", docId: "d-earlier" });
});

function ticks(n) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

test("awaitUndoPoint adopts nothing until the undo point is written", async () => {
  reset();
  const id = freshId();
  const mine = mk(id);
  mine.rows[0].audioText = "mine";
  const theirs = mk(id);
  theirs.rows[1].audioText = "theirs";
  const newBase = { sentinel: "the file on disk" };
  let baseAsked = 0;

  window.__historyTest.injectFault("delay-put");
  let p;
  try {
    p = applyMerge({
      base: mk(id), mine: mine, theirs: theirs,
      source: "stash", undoPoint: cloneState(theirs),
      awaitUndoPoint: true,
      newBase: function () { baseAsked++; return newBase; },
      report: false
    });
    assert.equal(typeof p.then, "function", "a Promise, not the answer");

    await ticks(5);
    assert.equal(currentDocument(), untouched.held);
  assert.equal(JSON.stringify(currentDocument()), untouched.json);
    assert.deepEqual(mergeBase(), { sentinel: "base" });
    assert.deepEqual(mergeUndo().last(), { id: "s-earlier", docId: "d-earlier" });
    assert.equal(baseAsked, 0, "newBase is not even read yet");

    window.__historyTest.releaseDelayedPut();
  } finally {
    window.__historyTest.injectFault(null);
  }
  await p.then(null, () => {});

  assert.equal(currentDocument().rows[0].audioText, "mine");
  assert.equal(currentDocument().rows[1].audioText, "theirs");
  assert.equal(mergeBase(), newBase, "the function's answer, as it is");
  assert.equal(baseAsked, 1);
  assert.equal(baseStateReason(), "merge: stash");
  assert.equal(mergeUndo().last().docId, id);
  assert.equal(mergeUndo().last().source, "stash");

  const listed = await listDocHistory(id);
  const filed = listed.entries.filter((e) => e.id === mergeUndo().last().id);
  assert.equal(filed.length, 1, "the undo point it waited for is in the history");
  assert.equal(filed[0].label, "Before merging your unsaved changes");
});

test("awaitUndoPoint answers a Promise even with no undo point to wait for", async () => {
  reset();
  const theirs = mk(freshId());

  const p = applyMerge({ theirs: theirs, source: "stash", unchanged: true, awaitUndoPoint: true, report: false });
  assert.equal(typeof p.then, "function");
  await p.then(null, () => {});
  assert.equal(currentDocument(), theirs);
  assert.deepEqual(mergeBase(), { sentinel: "base" });
});

test("setBaseState stores what it is given, as it is, with its reason", () => {
  reset();
  const doc = mk(freshId());
  assert.equal(setBaseState(doc, "a test: adopt what was confirmed"), doc);
  assert.equal(mergeBase(), doc, "not a copy");
  assert.equal(baseStateReason(), "a test: adopt what was confirmed");

  setBaseState(null, "a test: no ancestor");
  assert.equal(mergeBase(), null);
  assert.equal(baseStateReason(), "a test: no ancestor");
});

test("an apply that adopts the merged document redraws #rows with no window or console error (#522)", () => {
  reset();
  const id = freshId();
  const mine = mk(id);
  mine.rows[0].audioText = "mine";
  const theirs = mk(id);
  theirs.rows[1].audioText = "theirs";
  const windowErrors = [];
  const logged = [];
  const onError = (e) => { windowErrors.push(e.message); e.preventDefault(); };
  const realError = console.error;
  window.addEventListener("error", onError);
  console.error = (...args) => { logged.push(args.map(String).join(" ")); };
  try {
    applyMerge({ base: mk(id), mine: mine, theirs: theirs, source: "stash", report: false });
  } finally {
    console.error = realError;
    window.removeEventListener("error", onError);
  }
  assert.deepEqual(windowErrors, []);
  assert.deepEqual(logged, []);
});
