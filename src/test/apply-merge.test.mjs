/* applyMerge (03-sync.js) — the one merge orchestration (#72).
 *
 * The merge CORE is mergeStates, and merge-states.test.mjs covers it. What
 * is covered here is the sequence AROUND it, which used to be written out
 * once per caller: file the undo point, merge, arm "Undo merge", adopt the
 * result, reassign `baseState`, redraw, say what happened.
 *
 * Only the `mergeOnly` half of that sequence is reachable from here, and
 * deliberately so: everything after it — render(), the identity and file
 * chips, reportMerge's banner, the toast — reads the app's PAGE, and
 * src/test has a DOM but no page (see _dom.mjs). Those belong to the
 * browser suites (tests/42-local-merge.txt, 26-desktop-drafts.txt,
 * 24-history.txt). `mergeOnly` is exactly the mode applyStashedWork
 * (14-export.js) runs in on the boot-stash and crash-draft paths, so what
 * it does is worth pinning down without a browser:
 *
 *   - the merge itself is mergeStates, unchanged, with `base` and `mine`
 *     normalised here so a caller can hand over whatever it is holding;
 *   - `source` names the undo point's label — three merges, three
 *     sentences, and no caller writing one out;
 *   - "Undo merge" is armed at that undo point — on every path, the
 *     409's included since #97 removed `armUndo:false` — carrying the
 *     `source` that says which version it holds, and is CLEARED rather
 *     than left pointing at an older merge when the history store refuses
 *     the write;
 *   - nothing on screen, and above all `baseState`, is touched.
 */
import "./_dom.mjs";
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { applyMerge, cloneState, mergeStates } from "../js/03-sync.js";
import { __init as historyInit, getHistorySnapshot, listDocHistory } from "../js/03a-history-store.js";

/* The one thing here that is NOT free to import (#92): filing an undo
   point goes through the history store, and that store's one write chain
   is created in its __init(). Calling it is honest — a merge really does
   need the store running — and it is all this file needs: __init() sets
   the chain and installs the test hook, and touches nothing else. The
   backend is pinned to memory so no case here depends on jsdom having an
   IndexedDB. */
before(async () => {
  historyInit();
  await window.__historyTest.forceBackend("memory");
});

/* A document with an id of its own, so the snapshots this files can be
   read back per document. Deliberately conflict-free: a merge with
   conflicts mints comment ids and timestamps, and the comparisons below
   want the merge to be a function of its three inputs and nothing else. */
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

/* A merged row carries the moment the merge ran (stampRow, 03-sync.js), so
   two runs of the same merge are equal everywhere except there. */
function unstamped(s) {
  const c = cloneState(s);
  c.rows.forEach(function (r) { r.updatedAt = ""; });
  return c;
}

/* The module globals applyMerge is allowed to touch, put back to a known
   value before every case — they are shared by every module (_state.js). */
function reset() {
  S.state = { sentinel: "state" };
  S.baseState = { sentinel: "base" };
  S.lastMergeUndo = { id: "s-earlier", docId: "d-earlier" };
}

test("mergeOnly merges and hands the result back, touching nothing on screen", () => {
  reset();
  const id = freshId();
  const base = mk(id), mine = mk(id), theirs = mk(id);
  mine.rows[0].audioText = "mine";
  theirs.rows[1].audioText = "theirs";

  /* The same three documents through mergeStates directly. Built from
     copies, not from mk() again: migrateRows stamps every row with the
     clock, so a second fixture is not the same document. The stamps a
     merge writes onto the rows it took (stampRow) are the clock too, so
     they come off both sides before the comparison — what is being
     compared is that applyMerge merges and does not do anything else. */
  const direct = mergeStates(cloneState(base), cloneState(mine), cloneState(theirs), false).merged;

  const out = applyMerge({
    base: base, mine: mine, theirs: theirs,
    source: "stash", mergeOnly: true, undoPoint: cloneState(theirs)
  });
  assert.deepEqual(unstamped(out.state), unstamped(direct));
  assert.equal(out.result.merged, out.state);
  /* the caller adopts it — applyMerge has not */
  assert.deepEqual(S.state, { sentinel: "state" });
  assert.deepEqual(S.baseState, { sentinel: "base" });
});

test("`base` and `mine` are normalised, so a caller hands over what it holds", () => {
  reset();
  const id = freshId();
  const theirs = mk(id);
  /* Straight off a stash: never through migrateRows, so no row ids and no
     schema. If applyMerge did not normalise it, mergeStates would read it
     as two rows deleted and two added. */
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
  /* the earlier merge's undo point is left exactly as it was */
  assert.deepEqual(S.lastMergeUndo, { id: "s-earlier", docId: "d-earlier" });
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
    assert.deepEqual(S.lastMergeUndo, { id: out.snapshot.id, docId: id, source: source });

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
  /* the SECOND one holds mine, not the merge */
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

  /* saveToServer's 409 used to pass armUndo:false: the snapshot was filed
     and the button never pointed at it. The option is gone; the undo point
     is armed, and it is the pre-merge document, not the merged one. */
  const out = applyMerge({
    base: mk(id), mine: mine, theirs: theirs,
    source: "server-conflict", mergeOnly: true,
    undoPoint: cloneState(mine)
  });
  assert.ok(out.snapshot);
  assert.deepEqual(S.lastMergeUndo, { id: out.snapshot.id, docId: id, source: "server-conflict" });
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

  /* captureSnapshot (03a) answers null for anything it cannot store — a
     document too large to serialise, a full quota. Left armed, the button
     reportMerge puts on screen would restore the version from before some
     EARLIER merge of this same document. */
  const out = applyMerge({
    base: mk(id), mine: mine, theirs: mk(id),
    source: "stash", mergeOnly: true, undoPoint: { docId: id, rows: null }
  });
  assert.equal(out.snapshot, null);
  assert.equal(S.lastMergeUndo, null);
  assert.ok(out.result, "the merge still happened");
});

test("no undo point asked for leaves Undo merge alone", () => {
  reset();
  const id = freshId();
  const mine = mk(id);
  mine.rows[0].audioText = "mine";

  applyMerge({ base: mk(id), mine: mine, theirs: mk(id), source: "server-resume", mergeOnly: true });
  assert.deepEqual(S.lastMergeUndo, { id: "s-earlier", docId: "d-earlier" });
});
