import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import {
  acceptStash, cloneState, mergeStates, mergeTextField, readStash, rowContentEqual, stashLocalWork, textMergeContext
} from "../js/03-sync.js";
import { createMemoryBackend, dataUrlForSync, intern, setBackend } from "../js/02c-blobs.js";
import { S } from "../js/_state.js";
import { changedBetween } from "../js/12a-undo.js";

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

  base = mk(); mine = mk(); theirs = mk();
  mine.wordsPerMinute = 180;
  theirs.wordsPerMinute = 200;
  assert.equal(mergeStates(base, mine, theirs).merged.wordsPerMinute, 200);
});

const ID_A = "d" + "1".repeat(32);
const ID_B = "d" + "2".repeat(32);
const ID_D = "d" + "4".repeat(32);

test("a merge keeps the document's id rather than minting a fresh one", () => {
  const s = mk();
  const mine = cloneState(s), theirs = cloneState(s);
  mine.docId = ID_A;
  theirs.docId = ID_B;
  assert.equal(mergeStates(null, mine, theirs).merged.docId, ID_B);

  const base2 = cloneState(s), mine2 = cloneState(s), theirs2 = cloneState(s);
  base2.docId = ID_A; mine2.docId = ID_A; theirs2.docId = ID_D;
  assert.equal(mergeStates(base2, mine2, theirs2).merged.docId, ID_D);
});

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
  const base = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two" }]);
  const mine = rowDoc([{ id: "r1", audioText: "one" }]);
  const theirs = rowDoc([{ id: "r1", audioText: "one" }, { id: "r2", audioText: "two, edited" }]);
  const kept = mergeStates(base, mine, theirs).merged.rows.map((r) => r.id);
  assert.deepEqual(kept, ["r1", "r2"]);

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
  assert.equal(card.rowId, null);
});

test("a title only I changed is kept", () => {
  const base = rowDoc([]); base.title = "Base";
  const mine = rowDoc([]); mine.title = "Mine";
  const theirs = rowDoc([]); theirs.title = "Base";
  assert.equal(mergeStates(base, mine, theirs).merged.title, "Mine");
});

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

test("pinned, found and not changed in 2.5: mergeStates changes the replies of its own mine and theirs, through migrateRows", () => {
  const base = commentDoc([cmt(), cmt({ id: "c2", anchorId: "c2" })]);
  const mine = commentDoc([cmt(), cmt({ id: "c2", anchorId: "c2" })]);
  const theirs = commentDoc([cmt()]);
  mine.comments[0].replies = [{ id: "rpM", body: "mine", createdAt: "2026-01-02T00:00:00.000Z" }];
  mine.comments[1].replies = [{ id: "rpX", body: "only mine", createdAt: "2026-01-02T00:00:00.000Z" }];
  theirs.comments[0].replies = [{ id: "rpT", body: "theirs", createdAt: "2026-01-03T00:00:00.000Z" }];
  const out = mergeStates(base, mine, theirs).merged.comments;
  assert.equal(out.find((c) => c.id === "c1").replies[0], mine.comments[0].replies[0], "the merged reply is mine's own object");
  assert.equal(mine.comments[0].replies[0].author, "Anonymous", "migrateRows wrote into mine's reply");
  assert.equal(theirs.comments[0].replies[0].author, "Anonymous", "and into theirs'");
  assert.equal("author" in mine.comments[1].replies[0], false, "a comment only one side holds is copied, so its reply is left alone");
});

test("a comment I deleted and they replied to comes back; one nobody touched does not", () => {
  const base = commentDoc([cmt()]);
  const mine = commentDoc([]);
  const withReply = commentDoc([cmt({ replies: [{ id: "rp1", body: "hi", author: "Bo", createdAt: "2026-01-04T00:00:00.000Z" }] })]);
  assert.equal(mergeStates(base, mine, withReply).merged.comments.filter((c) => c.id === "c1").length, 1);

  const untouched = commentDoc([cmt()]);
  assert.equal(mergeStates(base, mine, untouched).merged.comments.filter((c) => c.id === "c1").length, 0);
});

test("rev is max of both sides plus one", () => {
  const base = mk(), mine = mk(), theirs = mk();
  mine.rev = 4; theirs.rev = 7;
  assert.equal(mergeStates(base, mine, theirs).merged.rev, 8);
});

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
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
  assert.equal(card.body, '<img class="comment-img" data-blob="' + b.sha256 + '" data-w="31" data-h="10" data-mime="image/png">');
  assert.equal(card.emptyValue, false);
  const again = migrateRows(cloneState(res.merged));
  assert.deepEqual(again.comments.find((k) => k.id === card.id).imageValue, b);
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
  assert.equal(stash.mine.rows[0].imageRef.sha256, b.sha256);
});

test("stashLocalWork writes refs, plus the bytes of every picture not durably stored", () => {
  setBackend(createMemoryBackend());
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

const span = (cat, name, text) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${text || name}</span>`;
function cellDoc(audioText, productionTags) {
  return migrateRows({
    title: "R", schema: 2,
    rows: [{ id: "r1", audioText: audioText }],
    productionTags: productionTags || []
  });
}

test("a word changed on each side of one cell: both words are kept, no conflict", () => {
  const base = cellDoc("the cat sat on the mat");
  const mine = cellDoc("the dog sat on the mat");
  const theirs = cellDoc("the cat sat on the rug");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "the dog sat on the rug");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.merged.comments.length, 0, "no Unmerged edit card");
  assert.equal(res.stats.rowsFromMe, 1);
  assert.equal(res.stats.rowsFromThem, 0);
});

test("#85: a tag wrapped round words on one side, a word fixed elsewhere on the other — both", () => {
  const base = cellDoc("Put the red mug on the tabel");
  const mine = cellDoc("Put the " + span("prop", "red mug") + " on the tabel");
  const theirs = cellDoc("Put the red mug on the table");
  assert.equal(mine.productionTags.length, 1, "tagging registered the item on my side");
  for (const [m, t] of [[mine, theirs], [theirs, mine]]) {
    const res = mergeStates(base, cloneState(m), cloneState(t));
    assert.equal(res.merged.rows[0].audioText, "Put the " + span("prop", "red mug") + " on the table");
    assert.equal(res.conflicts.length, 0);
    assert.deepEqual(res.merged.productionTags.map((x) => x.name), ["red mug"]);
  }
});

test("the same words changed differently on both sides: the conflict card, exactly as before", () => {
  const base = cellDoc("the cat sat on the mat");
  const mine = cellDoc("the dog sat on the mat, <strong>twice</strong>");
  const theirs = cellDoc("the cow sat on the mat");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "the cow sat on the mat", "theirs stays live");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].field, "audioText");
  const card = res.merged.comments.find((c) => c.kind === "conflict");
  assert.equal(card.rowId, "r1");
  assert.equal(card.conflictField, "Audio");
  assert.equal(card.body, "the dog sat on the mat, <strong>twice</strong>", "the card holds my whole cell");
  assert.equal(res.stats.rowsFromMe, 0);
  assert.equal(res.stats.rowsFromThem, 1);
});

test("a tag renamed on one side and the cell edited on the other: both, under the new name", () => {
  const base = cellDoc("Pour the " + span("prop", "Mug", "mug") + " out now");
  const id = base.productionTags[0].id;
  const renamed = cellDoc("Pour the " + span("prop", "Cup", "mug") + " out now",
    [{ id: id, cat: "prop", name: "Cup", owner: "", notes: "", status: "needed" }]);
  const edited = cellDoc("Pour the " + span("prop", "Mug", "mug") + " out slowly");
  const want = "Pour the " + span("prop", "Cup", "mug") + " out slowly";
  for (const [m, t] of [[renamed, edited], [edited, renamed]]) {
    const res = mergeStates(base, cloneState(m), cloneState(t));
    assert.equal(res.merged.rows[0].audioText, want);
    assert.equal(res.conflicts.length, 0);
    assert.deepEqual(res.merged.productionTags.map((x) => [x.id, x.name]), [[id, "Cup"]],
      "one entry, renamed — the old name is not healed back in beside it");
  }
});

test("a formatting change on one side and a text change on the other: both", () => {
  const base = cellDoc("a quick brown fox");
  const mine = cellDoc("a <strong>quick</strong> brown fox");
  const theirs = cellDoc("a quick brown dog");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "a <strong>quick</strong> brown dog");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.stats.rowsFromMe, 1);
});

const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;

test("both set a different link on the same word: the merged cell is live, a card holds mine", () => {
  const base = cellDoc("see the docs for more");
  const mine = cellDoc("see the " + link("https://mine.example/", "docs") + " for more");
  const theirs = cellDoc("see the " + link("https://theirs.example/", "docs") + " for more");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, theirs.rows[0].audioText, "their link stays live");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].field, "audioText");
  const card = res.merged.comments.find((c) => c.kind === "conflict");
  assert.equal(card.rowId, "r1");
  assert.equal(card.conflictField, "Audio");
  assert.equal(card.body, mine.rows[0].audioText, "the card holds my whole cell, my link in it");
  assert.equal(res.stats.rowsFromMe, 0);
  assert.equal(res.stats.rowsFromThem, 1);
});

test("different links on one word and different words edited elsewhere: both words live, a card for my link", () => {
  const base = cellDoc("see the docs for more");
  const mine = cellDoc("see the " + link("https://mine.example/", "docs") + " for more");
  const theirs = cellDoc("see the " + link("https://theirs.example/", "docs") + " for less");
  const mine2 = cellDoc("look at the " + link("https://mine.example/", "docs") + " for more");
  const res = mergeStates(base, mine2, theirs);
  assert.equal(res.merged.rows[0].audioText, "look at the " + link("https://theirs.example/", "docs") + " for less",
    "everything else merged; their link on the word both linked");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.merged.comments.find((c) => c.kind === "conflict").body, mine2.rows[0].audioText);
  assert.equal(res.stats.rowsFromMe, 1);
  const ctx = textMergeContext(base, mine, theirs);
  const r = mergeTextField(base.rows[0].audioText, mine.rows[0].audioText, theirs.rows[0].audioText, ctx);
  assert.equal(r.outcome, "conflict");
  assert.equal(r.marks, true);
});

test("both set a different tag on the same word: theirs is live, a card holds mine", () => {
  const base = cellDoc("pour the mug out now");
  const mine = cellDoc("pour the " + span("prop", "Mug", "mug") + " out now");
  const theirs = cellDoc("pour the " + span("prop", "Cup", "mug") + " out now");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, theirs.rows[0].audioText);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.merged.comments.find((c) => c.kind === "conflict").body, mine.rows[0].audioText);
  assert.deepEqual(res.merged.productionTags.map((x) => x.name).sort(), ["Cup", "Mug"]);
});

test("one side links a word, the other edits a different word: both, no card", () => {
  const base = cellDoc("see the docs for more");
  const mine = cellDoc("see the " + link("https://mine.example/", "docs") + " for more");
  const theirs = cellDoc("see the docs for less");
  for (const [m, t] of [[mine, theirs], [theirs, mine]]) {
    const res = mergeStates(base, cloneState(m), cloneState(t));
    assert.equal(res.merged.rows[0].audioText, "see the " + link("https://mine.example/", "docs") + " for less");
    assert.equal(res.conflicts.length, 0);
    assert.equal(res.merged.comments.length, 0, "no Unmerged edit card");
  }
});

test("both set the same link on a word: no card, whatever else changed", () => {
  const base = cellDoc("see the docs for more");
  const mine = cellDoc("see the " + link("https://same.example/", "docs") + " for more");
  let res = mergeStates(base, mine, cloneState(mine));
  assert.equal(res.merged.rows[0].audioText, mine.rows[0].audioText);
  assert.equal(res.conflicts.length, 0);
  const theirs = cellDoc("see the " + link("https://same.example/", "docs") + " for less");
  res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, theirs.rows[0].audioText);
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.merged.comments.length, 0);
});

test("a link conflict touches only its own cell, so undo forgets only that one (design D4)", () => {
  const two = (a1, a2) => migrateRows({ title: "R", schema: 2, rows: [{ id: "r1", audioText: a1 }, { id: "r2", audioText: a2 }] });
  const base = two("see the docs", "second scene");
  const mine = two("see the " + link("https://mine.example/", "docs"), "second scene, mine");
  const theirs = two("see the " + link("https://theirs.example/", "docs"), "second scene");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.conflicts.length, 1);
  const touched = changedBetween(mine, res.merged);
  assert.deepEqual(Object.keys(touched.rowFields), ["r1\u0000audioText"],
    "my edit in the other scene is untouched, so its undo entry survives");
  assert.equal(touched.structure, false);
});

test("formatting both sides toggled on the same word is never a conflict", () => {
  const base = cellDoc("a quick brown fox");
  const mine = cellDoc("one <strong>quick</strong> brown fox");
  const theirs = cellDoc("a <em>quick</em> brown dog");
  const res = mergeStates(base, mine, theirs);
  assert.equal(res.merged.rows[0].audioText, "one <strong><em>quick</em></strong> brown dog");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.merged.comments.length, 0);
  const ctx = textMergeContext(base, mine, theirs);
  const r = mergeTextField(base.rows[0].audioText, mine.rows[0].audioText, theirs.rows[0].audioText, ctx);
  assert.equal(r.outcome, "merged");
  assert.equal(r.marks, undefined);
});

test("a re-serialisation is not a change: the same content, nested differently", () => {
  const old = "<em><strong>x</strong></em> y";
  const canon = "<strong><em>x</em></strong> y";
  assert.notEqual(cellDoc(old).rows[0].audioText, cellDoc(canon).rows[0].audioText, "the fixture really differs as a string");

  let res = mergeStates(cellDoc(old), cellDoc(canon), cellDoc("<em><strong>x</strong></em> z"));
  assert.equal(res.merged.rows[0].audioText, "<em><strong>x</strong></em> z");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.stats.rowsFromMe, 0);

  res = mergeStates(cellDoc(old), cellDoc(canon), cellDoc(old));
  assert.equal(res.merged.rows[0].audioText, old);
  assert.equal(res.stats.rowsFromMe, 0);
  assert.equal(res.stats.rowsFromThem, 0);

  res = mergeStates(cellDoc(old), cellDoc("<em><strong>x</strong></em> w"), cellDoc(canon));
  assert.equal(res.merged.rows[0].audioText, "<em><strong>x</strong></em> w");
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.stats.rowsFromMe, 1);

  res = mergeStates(null, cellDoc(canon), cellDoc(old));
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.merged.rows[0].audioText, old, "theirs' string is preferred");
});

test("mergeTextField names each outcome the way mergeRow acts on it", () => {
  const b = cellDoc("one two three"), ctx = textMergeContext(b, b, b);
  const f = (base, mine, theirs) => mergeTextField(base, mine, theirs, ctx);
  assert.deepEqual(f("one two three", "one two three", "one two three"), { html: "one two three", outcome: "same" });
  assert.deepEqual(f("one two three", "one 2 three", "one two three"), { html: "one 2 three", outcome: "mine" });
  assert.deepEqual(f("one two three", "one two three", "one two 3"), { html: "one two 3", outcome: "theirs" });
  assert.deepEqual(f("one two three", "1 two three", "one two 3"), { html: "1 two 3", outcome: "merged" });
  assert.deepEqual(f("one two three", "one 2 three", "one II three"), { html: "one II three", outcome: "conflict" });
  assert.deepEqual(f("one two three", "one 2 three", "one 2 three"), { html: "one 2 three", outcome: "same" });
  assert.equal(f(undefined, "one 2 three", "one two three").outcome, "conflict");
});

test("a cell holding a picture is compared whole, as a string — the model has no place for one", () => {
  const img = '<img class="comment-img" data-blob="' + "a".repeat(64) + '" data-w="1" data-h="1" data-mime="image/png">';
  const b = cellDoc("one two"), ctx = textMergeContext(b, b, b);
  assert.deepEqual(mergeTextField("one two", "one two " + img, "one two", ctx), { html: "one two " + img, outcome: "mine" });
  assert.equal(mergeTextField("one two", "1 two " + img, "one 2", ctx).outcome, "conflict");
});


function withProps(names) {
  const s = mk();
  s.productionTags.push({ cat: "prop", name: "Ladder", owner: "", notes: "", status: "needed" });
  const out = migrateRows(s);
  out.brollShots[0].props = names.map((n) => ({ id: out.productionTags.find((t) => t.name === n).id, name: n }));
  return out;
}
const propNames = (s) => s.brollShots[0].props.map((p) => p.name);

test("b-roll props: both sides' additions are kept", () => {
  const base = withProps([]), mine = withProps(["Kettle"]), theirs = withProps(["Ladder"]);
  assert.deepEqual(propNames(mergeStates(base, mine, theirs).merged).sort(), ["Kettle", "Ladder"]);
});

test("b-roll props: a prop I took off stays off, and so does one they took off", () => {
  const base = withProps(["Kettle", "Ladder"]);
  assert.deepEqual(propNames(mergeStates(base, withProps(["Ladder"]), withProps(["Kettle", "Ladder"])).merged), ["Ladder"]);
  assert.deepEqual(propNames(mergeStates(base, withProps(["Kettle", "Ladder"]), withProps(["Kettle"])).merged), ["Kettle"]);
});

test("b-roll props: a removal on one side and an addition on the other both land", () => {
  const base = withProps(["Kettle"]);
  assert.deepEqual(propNames(mergeStates(base, withProps([]), withProps(["Kettle", "Ladder"])).merged), ["Ladder"]);
});

test("b-roll props: with no base copy of the shot, the two lists union", () => {
  const base = mk();
  base.brollShots = [];
  assert.deepEqual(propNames(mergeStates(base, withProps(["Kettle"]), withProps(["Ladder"])).merged).sort(), ["Kettle", "Ladder"]);
});

test("b-roll props: a copy from before props (no list at all) never removes one", () => {
  const base = withProps(["Kettle"]), mine = withProps(["Kettle"]), theirs = withProps(["Kettle"]);
  delete base.brollShots[0].props;
  delete theirs.brollShots[0].props;
  assert.deepEqual(propNames(mergeStates(base, mine, theirs).merged), ["Kettle"]);
});

test("b-roll props: one side's name-only copy and the other's id'd one are one prop", () => {
  const base = withProps([]), mine = withProps(["Kettle"]), theirs = withProps([]);
  theirs.brollShots[0].props = [{ id: "", name: "kettle" }];
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.brollShots[0].props.length, 1);
  assert.deepEqual(out.brollShots[0].props[0], mine.brollShots[0].props[0]);
});

test("b-roll props: the other fields of a shot still merge the way they did", () => {
  const base = withProps([]), mine = withProps(["Kettle"]), theirs = withProps([]);
  theirs.brollShots[0].status = "shot";
  mine.brollShots[0].notes = "wide and tight";
  const out = mergeStates(base, mine, theirs).merged.brollShots[0];
  assert.equal(out.status, "shot");
  assert.equal(out.notes, "wide and tight");
  assert.deepEqual(out.props.map((p) => p.name), ["Kettle"]);
});
