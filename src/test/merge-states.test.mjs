/* mergeStates (03-sync.js) — the three-way merge every hosted save, every
 * crash-stash and every local-file merge goes through.
 *
 * Ported from tests/51-merge-fields.txt and the mergedDocId half of
 * tests/22-doc-id.txt, both of which drove this through
 * window.__splitpageFormats.mergeStates in a real browser for no reason
 * other than that there was no other way in (issue #67). It is a pure
 * function of three documents: nothing here needs a page, a file picker or
 * a server.
 *
 * The two issues this file exists to keep closed:
 *   #60  a top-level field left out of the merge is destroyed by it, on
 *        every merge, forever — see state-fields.test.mjs for the registry
 *        that makes that impossible and this file for the merge honouring
 *        it.
 *   #61  mergePeople/mergeProductionTags/mergeBrollShots used to union both
 *        sides without ever seeing `base`, so anything either side deleted
 *        was resurrected by the next merge, and the one after that.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import { acceptStash, cloneState, mergeStates, readStash, rowContentEqual, stashLocalWork } from "../js/03-sync.js";
import { createMemoryBackend, dataUrlForSync, intern, setBackend } from "../js/02c-blobs.js";
import { S } from "../js/_state.js";

/* The fixture 51-merge-fields.txt used: one person, one prop, one b-roll
   shot, one row, a non-default reading speed. Rebuilt per call — mergeStates
   mutates nothing, but the cases below edit their own copies. */
function mk() {
  return migrateRows({
    title: "M",
    rows: [{ id: "r1", visualText: "v", audioText: "a" }],
    people: [{ id: "p1", name: "Sam" }],
    productionTags: [{ cat: "prop", name: "Kettle", owner: "", notes: "", status: "needed" }],
    brollShots: [{ id: "b1", name: "Rooftop" }],
    wordsPerMinute: 150
  });
}

test("the fixture is what the delete cases assume", () => {
  const s = mk();
  assert.equal(s.people.length, 1);
  assert.equal(s.productionTags.length, 1);
  assert.equal(s.brollShots.length, 1);
});

test("a person I deleted stays deleted", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.people = [];
  assert.equal(mergeStates(base, mine, theirs).merged.people.length, 0);
});

test("a person they deleted stays deleted", () => {
  const base = mk(), mine = mk(), theirs = mk();
  theirs.people = [];
  assert.equal(mergeStates(base, mine, theirs).merged.people.length, 0);
});

test("a production tag I deleted stays deleted", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.productionTags = [];
  assert.equal(mergeStates(base, mine, theirs).merged.productionTags.length, 0);
});

test("a b-roll shot I deleted stays deleted", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.brollShots = [];
  assert.equal(mergeStates(base, mine, theirs).merged.brollShots.length, 0);
});

test("a delete never beats a real edit on the other side — tag", () => {
  /* They marked the kettle sourced while I deleted it: the work survives,
     the way the plain union always did. */
  const base = mk(), mine = mk(), theirs = mk();
  mine.productionTags = [];
  theirs.productionTags[0].status = "have";
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.productionTags.length, 1);
  assert.equal(out.productionTags[0].status, "have");
});

test("a delete never beats a real edit on the other side — b-roll", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.brollShots = [];
  theirs.brollShots[0].owner = "p1";
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.brollShots.length, 1);
  assert.equal(out.brollShots[0].owner, "p1");
});

test("additions still union", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.people.push({ id: "p2", name: "Ada" });
  theirs.people.push({ id: "p3", name: "Bo" });
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.people.length, 3);
  assert.deepEqual(out.people.map((p) => p.name).sort(), ["Ada", "Bo", "Sam"]);
});

test("with no ancestor, nothing is a delete", () => {
  /* A two-way merge cannot tell "removed" from "never had", so it unions. */
  const mine = mk(), theirs = mk();
  mine.people = [];
  assert.equal(mergeStates(null, mine, theirs).merged.people.length, 1);
});

test("wordsPerMinute follows whoever changed it", () => {
  let base = mk(), mine = mk(), theirs = mk();
  mine.wordsPerMinute = 180;
  assert.equal(mergeStates(base, mine, theirs).merged.wordsPerMinute, 180);

  base = mk(); mine = mk(); theirs = mk();
  theirs.wordsPerMinute = 200;
  assert.equal(mergeStates(base, mine, theirs).merged.wordsPerMinute, 200);

  /* Both changed it — theirs is the published truth, the same rule a row
     field follows. */
  base = mk(); mine = mk(); theirs = mk();
  mine.wordsPerMinute = 180;
  theirs.wordsPerMinute = 200;
  assert.equal(mergeStates(base, mine, theirs).merged.wordsPerMinute, 200);
});

/* ---- docId (the truth table 22-doc-id.txt asserted twice: once on
   mergedDocId directly, once through the merge that calls it) ---------- */

const ID_A = "d" + "1".repeat(32);
const ID_B = "d" + "2".repeat(32);
const ID_D = "d" + "4".repeat(32);

test("a merge keeps the document's id rather than minting a fresh one", () => {
  /* Without this the document came out of every server and stash merge with
     a new random id, orphaning its whole history. Rows are identical on both
     sides so only docId is in play. */
  const s = mk();
  const mine = cloneState(s), theirs = cloneState(s);
  mine.docId = ID_A;
  theirs.docId = ID_B;
  assert.equal(mergeStates(null, mine, theirs).merged.docId, ID_B);

  const base2 = cloneState(s), mine2 = cloneState(s), theirs2 = cloneState(s);
  base2.docId = ID_A; mine2.docId = ID_A; theirs2.docId = ID_D;
  assert.equal(mergeStates(base2, mine2, theirs2).merged.docId, ID_D);
});

/* ---- rows: what the browser suite never reached, and where the data
   actually goes missing -------------------------------------------------- */

function rowDoc(rows) {
  return migrateRows({ title: "R", rows: rows, schema: 2 });
}

test("only one side changed a cell: that side wins, silently", () => {
  const base = rowDoc([{ id: "r1", audioText: "one" }]);
  const mine = rowDoc([{ id: "r1", audioText: "one" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "two" }]);
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "two");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.stats.rowsFromThem, 1);
});

test("both sides changed the same cell: theirs goes live, mine becomes a conflict comment", () => {
  const base = rowDoc([{ id: "r1", audioText: "one" }]);
  const mine = rowDoc([{ id: "r1", audioText: "mine" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "theirs" }]);
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "theirs");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].field, "audioText");
  assert.equal(res.conflicts[0].mine, "mine");
  const card = res.merged.comments.find((c) => c.kind === "conflict");
  assert.ok(card, "the conflict is preserved as a comment, never dropped");
  assert.equal(card.rowId, "r1");
  assert.equal(card.conflictField, "Audio");
  assert.equal(card.body, "mine");
});

test("an edit outranks a delete, in both directions", () => {
  /* They edited a row I deleted — their edit survives my delete. */
  const base = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const mine = rowDoc([{ id: "r1", audioText: "one" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two, edited" }]);
  const kept = mergeStates(base, mine, theirs).merged.rows.map((r) => r.id);
  assert.deepEqual(kept, ["r1", "r2"]);

  /* And a row I deleted that they never touched really goes. */
  const theirs2 = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const gone = mergeStates(base, mine, theirs2).merged.rows.map((r) => r.id);
  assert.deepEqual(gone, ["r1"]);
});

test("a row I added lands back beside the neighbour it was added after", () => {
  const base = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const mine = rowDoc([
    { id: "r1", audioText: "one" },
    { id: "rNEW", audioText: "new" },
    { id: "r2", audioText: "two" }
  ]);
  const theirs = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const res = mergeStates(base, mine, theirs);
  assert.deepEqual(res.merged.rows.map((r) => r.id), ["r1", "rNEW", "r2"]);
  assert.equal(res.stats.rowsAddedByMe, 1);
});

test("status is progress, not text: the furthest-along value wins", () => {
  /* A merge can never un-shoot something somebody filmed. */
  const base = rowDoc([{ id: "r1", audioText: "one", status: "todo" }]);
  const mine = rowDoc([{ id: "r1", audioText: "one", status: "shot" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "one", status: "ready" }]);
  assert.equal(mergeStates(base, mine, theirs).merged.rows[0].status, "shot");
  assert.equal(mergeStates(base, theirs, mine).merged.rows[0].status, "shot");
});

test("a title both sides changed is a conflict, not a silent overwrite", () => {
  const base = rowDoc([]); base.title = "Base";
  const mine = rowDoc([]); mine.title = "Mine";
  const theirs = rowDoc([]); theirs.title = "Theirs";
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.title, "Theirs");
  const card = res.merged.comments.find((c) => c.conflictField === "Title");
  assert.ok(card, "my title survives as a conflict card");
  assert.equal(card.titleValue, "Mine");
  /* A document-level card is anchored to no row at all (migrateRows leaves
     rowId null for it rather than fabricating one). */
  assert.equal(card.rowId, null);
});

test("a title only I changed is kept", () => {
  const base = rowDoc([]); base.title = "Base";
  const mine = rowDoc([]); mine.title = "Mine";
  const theirs = rowDoc([]); theirs.title = "Base";
  assert.equal(mergeStates(base, mine, theirs).merged.title, "Mine");
});

/* ---- comments ---------------------------------------------------------- */

function commentDoc(comments) {
  return migrateRows({
    title: "C", schema: 2,
    rows: [{ id: "r1", audioText: "one" }],
    comments: comments
  });
}

function cmt(extra) {
  return Object.assign({
    id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "one",
    author: "Sam", body: "look", resolved: false, kind: "anchor",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", replies: []
  }, extra || {});
}

test("resolved is forward progress, whichever side is newer", () => {
  /* An unrelated reply bumping updatedAt on one side used to silently
     revert a resolve made earlier on the other. */
  const base = commentDoc([cmt()]);
  const mine = commentDoc([cmt({ resolved: true, resolvedBy: "Sam", resolvedAt: "2026-01-02T00:00:00.000Z" })]);
  const theirs = commentDoc([cmt({ updatedAt: "2026-01-03T00:00:00.000Z", body: "look, edited" })]);
  const out = mergeStates(base, mine, theirs).merged.comments.find((c) => c.id === "c1");
  assert.equal(out.resolved, true);
  assert.equal(out.resolvedBy, "Sam");
});

test("an assignee only one side made survives the merge", () => {
  const base = commentDoc([cmt()]);
  const mine = commentDoc([cmt({ assignee: "Ada" })]);
  const theirs = commentDoc([cmt({ updatedAt: "2026-01-05T00:00:00.000Z" })]);
  const out = mergeStates(base, mine, theirs).merged.comments.find((c) => c.id === "c1");
  assert.equal(out.assignee, "Ada");
});

test("replies from both sides are unioned, oldest first", () => {
  const rep = (id, at) => ({ id: id, body: id, author: "Sam", createdAt: at });
  const base = commentDoc([cmt()]);
  const mine = commentDoc([cmt({ replies: [rep("rp1", "2026-01-02T00:00:00.000Z")] })]);
  const theirs = commentDoc([cmt({ replies: [rep("rp2", "2026-01-03T00:00:00.000Z")] })]);
  const out = mergeStates(base, mine, theirs).merged.comments.find((c) => c.id === "c1");
  assert.deepEqual(out.replies.map((r) => r.id), ["rp1", "rp2"]);
});

test("a comment I deleted and they replied to comes back; one nobody touched does not", () => {
  const base = commentDoc([cmt()]);
  const mine = commentDoc([]);
  const withReply = commentDoc([cmt({ replies: [{ id: "rp1", body: "hi", author: "Bo", createdAt: "2026-01-04T00:00:00.000Z" }] })]);
  assert.equal(mergeStates(base, mine, withReply).merged.comments.filter((c) => c.id === "c1").length, 1);

  const untouched = commentDoc([cmt()]);
  assert.equal(mergeStates(base, mine, untouched).merged.comments.filter((c) => c.id === "c1").length, 0);
});

/* ---- rev -------------------------------------------------------------- */

test("rev is max of both sides plus one", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.rev = 4; theirs.rev = 7;
  assert.equal(mergeStates(base, mine, theirs).merged.rev, 8);
});

/* ---- pictures (#82): merged by the sha their imageRef names ---- */

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/* a PNG header the registry accepts, one per (w, h) */
function pic(w, h) {
  return intern(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(w), ...be32(h), 8, 6, 0, 0, 0, ...be32(0), ...be32(0), 0x49, 0x45, 0x4e, 0x44]));
}
function imgDoc(ref) {
  return rowDoc([{ id: "r1", audioText: "a", imageRef: ref }]);
}

test("pictures compare by sha: two records of the same bytes are the same picture", () => {
  const a = pic(10, 10);
  const x = imgDoc(a), y = imgDoc({ ...a });
  assert.notEqual(x.rows[0].imageRef, y.rows[0].imageRef);
  assert.ok(rowContentEqual(x.rows[0], y.rows[0]));
  assert.ok(!rowContentEqual(x.rows[0], imgDoc(pic(11, 10)).rows[0]));
  assert.ok(!rowContentEqual(x.rows[0], imgDoc(null).rows[0]));
});

test("a picture only one side changed: that side wins, with no conflict", () => {
  const a = pic(20, 10), b = pic(21, 10);
  const mineChanged = mergeStates(imgDoc(a), imgDoc(b), imgDoc(a));
  assert.deepEqual(mineChanged.merged.rows[0].imageRef, b);
  assert.equal(mineChanged.conflicts.length, 0);
  assert.equal(mineChanged.stats.rowsFromMe, 1);
  const theirsChanged = mergeStates(imgDoc(a), imgDoc(a), imgDoc(b));
  assert.deepEqual(theirsChanged.merged.rows[0].imageRef, b);
  assert.equal(theirsChanged.conflicts.length, 0);
  const removedByMe = mergeStates(imgDoc(a), imgDoc(null), imgDoc(a));
  assert.equal(removedByMe.merged.rows[0].imageRef, null);
  /* the merged row's record is its own copy, not mine */
  const mine = imgDoc(b);
  assert.notEqual(mergeStates(imgDoc(a), mine, imgDoc(a)).merged.rows[0].imageRef, mine.rows[0].imageRef);
});

test("both sides changed the picture: theirs is live, mine is a card holding it as imageValue", () => {
  const a = pic(30, 10), b = pic(31, 10), c = pic(32, 10);
  const res = mergeStates(imgDoc(a), imgDoc(b), imgDoc(c));
  assert.deepEqual(res.merged.rows[0].imageRef, c);
  assert.equal(res.conflicts.length, 1);
  const card = res.merged.comments.find((k) => k.kind === "conflict");
  assert.equal(card.field, "visualImage", "the comment's field keeps its old name");
  assert.equal(card.conflictField, "Visual image");
  assert.deepEqual(card.imageValue, b);
  /* the body shows the same picture in the stored HTML form (#82 P6) */
  assert.equal(card.body, '<img class="comment-img" data-blob="' + b.sha256 + '" data-w="31" data-h="10" data-mime="image/png">');
  assert.equal(card.emptyValue, false);
  /* and it survives the one door, and a second merge, as it is */
  const again = migrateRows(cloneState(res.merged));
  assert.deepEqual(again.comments.find((k) => k.id === card.id).imageValue, b);
  /* I removed it while they replaced it: the card says so */
  const cleared = mergeStates(imgDoc(a), imgDoc(null), imgDoc(c)).merged.comments.find((k) => k.kind === "conflict");
  assert.equal(cleared.imageValue, null);
  assert.equal(cleared.body, "");
  assert.equal(cleared.emptyValue, true);
});

test("a stash carries the pictures the store does not hold, and they come back", () => {
  const b = pic(40, 10);
  const url = "data:image/png;base64," + Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(41), ...be32(10), 8, 6, 0, 0, 0, ...be32(0), ...be32(0), 0x49, 0x45, 0x4e, 0x44])).toString("base64");
  const stash = { mine: imgDoc(b), blobs: { ["0".repeat(64)]: url } };
  acceptStash(stash, imgDoc(null));
  /* interned under its REAL sha — the key it came under is not believed */
  assert.equal(stash.mine.rows[0].imageRef.sha256, b.sha256);
});

test("stashLocalWork writes refs, plus the bytes of every picture not durably stored", () => {
  setBackend(createMemoryBackend()); /* memory is never durable */
  const b = pic(60, 10), c = pic(61, 10);
  const was = { state: S.state, base: S.baseState };
  S.state = imgDoc(b);
  S.baseState = imgDoc(c);
  try {
    assert.equal(stashLocalWork(), true);
    const st = readStash();
    assert.deepEqual(st.mine.rows[0].imageRef, b);
    assert.equal(JSON.stringify(st.mine).indexOf("data:image"), -1, "the document itself holds refs");
    assert.deepEqual(Object.keys(st.blobs).sort(), [b.sha256, c.sha256].sort());
    assert.equal(st.blobs[b.sha256], dataUrlForSync(b.sha256));
    assert.equal(st.imagesStripped, undefined);
  } finally {
    S.state = was.state;
    S.baseState = was.base;
    sessionStorage.clear();
  }
});

test("one release: an older stash's \"__IMAGE__\" sentinels take theirs' picture", () => {
  const a = pic(50, 10), c = pic(51, 10);
  const stash = {
    imagesStripped: true,
    base: { title: "R", schema: 2, rows: [{ id: "r1", audioText: "a", visualImage: "__IMAGE__" }] },
    mine: { title: "R", schema: 2, rows: [{ id: "r1", audioText: "mine", visualImage: "__IMAGE__" }, { id: "r2", audioText: "new", visualImage: null }] }
  };
  const theirs = imgDoc(c);
  acceptStash(stash, theirs);
  assert.equal(stash.imagesStripped, undefined);
  assert.deepEqual(stash.mine.rows[0].imageRef, c);
  assert.equal("visualImage" in stash.mine.rows[0], false);
  const res = mergeStates(migrateRows(stash.base), migrateRows(stash.mine), theirs);
  assert.deepEqual(res.merged.rows[0].imageRef, c, "their picture is kept");
  assert.equal(res.merged.rows[0].audioText, "mine", "and my text still merges");
  assert.equal(res.conflicts.length, 0, "no empty card for a picture nobody can know about");
  void a;
});

