import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import { migrateDocument } from "../js/02b-doc-id.js";
import { byId, mergeBrollShots, mergePeople, mergeProductionTags, mergeStates } from "../js/03-sync.js";
import { __init as initTags } from "../js/07-production-tags.js";

initTags();

const RESERVED = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

function load(raw) {
  return migrateRows(JSON.parse(JSON.stringify(raw)));
}

function twoRows(x) {
  return load({
    schema: 2, title: "T",
    rows: [{ id: "r1", audioText: "one" }, { id: x, audioText: "two", visualText: "look" }],
    people: [{ id: "p1", name: "Sam" }],
    brollShots: [{ id: "b1", name: "Rooftop" }]
  });
}

function rowIds(s) { return s.rows.map((r) => r.id); }

for (const x of RESERVED) {
  test(`migrate: a document with the id "${x}" everywhere loads with every id and link intact`, () => {
    const s = load({
      schema: 2, title: "T",
      rows: [{ id: x, audioText: 'two <span class="cmt-anchor" data-cmt="' + x + '">here</span>' }],
      comments: [{ id: x, rowId: x, field: "audioText", body: "note", createdAt: "2026-01-01T00:00:00Z",
                   replies: [{ id: x, body: "ok", createdAt: "2026-01-02T00:00:00Z" }] }],
      people: [{ id: x, name: "Ada" }],
      productionTags: [{ cat: "prop", name: "Kettle", owner: x }],
      brollShots: [{ id: x, name: "Street", owner: x }]
    });
    assert.deepEqual(rowIds(s), [x]);
    assert.match(s.rows[0].audioText, new RegExp('data-cmt="' + x + '"'));
    assert.equal(s.comments.length, 1);
    assert.equal(s.comments[0].id, x);
    assert.equal(s.comments[0].rowId, x);
    assert.equal(s.comments[0].anchorId, x);
    assert.deepEqual(s.comments[0].replies.map((r) => r.id), [x]);
    assert.deepEqual(s.people.map((p) => p.id), [x]);
    assert.equal(s.productionTags[0].owner, x);
    assert.equal(s.brollShots[0].id, x);
    assert.equal(s.brollShots[0].owner, x);
    assert.ok(Object.getPrototypeOf(s.rows[0]) === Object.prototype);
  });

  test(`merge: deleting the scene "${x}" deletes it and blanks nothing`, () => {
    const base = twoRows(x), mine = twoRows(x), theirs = twoRows(x);
    mine.rows = mine.rows.filter((r) => r.id !== x);
    const out = mergeStates(base, mine, theirs).merged;
    assert.deepEqual(rowIds(out), ["r1"]);
    assert.equal(out.rows[0].audioText, "one");
  });

  test(`merge: deleting the scene "${x}" on their side deletes it too`, () => {
    const base = twoRows(x), mine = twoRows(x), theirs = twoRows(x);
    theirs.rows = theirs.rows.filter((r) => r.id !== x);
    assert.deepEqual(rowIds(mergeStates(base, mine, theirs).merged), ["r1"]);
  });

  test(`merge: a scene "${x}" they added arrives once, with its text`, () => {
    const base = twoRows(x), mine = twoRows(x), theirs = twoRows(x);
    base.rows.pop(); mine.rows.pop();
    const out = mergeStates(base, mine, theirs).merged;
    assert.deepEqual(rowIds(out), ["r1", x]);
    assert.equal(out.rows[1].audioText, "two");
  });

  test(`merge: a scene "${x}" I added stays, once`, () => {
    const base = twoRows(x), mine = twoRows(x), theirs = twoRows(x);
    base.rows.pop(); theirs.rows.pop();
    const out = mergeStates(base, mine, theirs).merged;
    assert.deepEqual(rowIds(out), ["r1", x]);
    assert.equal(out.rows[1].audioText, "two");
  });

  test(`merge: edits to different fields of the scene "${x}" combine`, () => {
    const base = twoRows(x), mine = twoRows(x), theirs = twoRows(x);
    mine.rows[1].audioText = "two, mine";
    theirs.rows[1].visualText = "look, theirs";
    const out = mergeStates(base, mine, theirs).merged;
    assert.deepEqual(rowIds(out), ["r1", x]);
    assert.equal(out.rows[1].audioText, "two, mine");
    assert.equal(out.rows[1].visualText, "look, theirs");
  });

  test(`merge: comments and replies with the id "${x}" merge like any other`, () => {
    const comment = (replies) => ({ id: x, rowId: "r1", field: "audioText", body: "note",
                                    createdAt: "2026-01-01T00:00:00Z", replies });
    const base = twoRows(x), mine = twoRows(x), theirs = twoRows(x);
    theirs.comments = [comment([{ id: x, body: "theirs", createdAt: "2026-01-02T00:00:00Z" }])];
    let out = mergeStates(base, mine, theirs).merged;
    assert.deepEqual(out.comments.map((c) => c.id), [x]);

    const base2 = load(Object.assign({}, twoRows(x), { comments: [comment([])] }));
    const mine2 = load(Object.assign({}, twoRows(x), { comments: [comment([{ id: x, body: "mine", createdAt: "2026-01-02T00:00:00Z" }])] }));
    const theirs2 = load(Object.assign({}, twoRows(x), { comments: [comment([{ id: "rp2", body: "theirs", createdAt: "2026-01-03T00:00:00Z" }])] }));
    out = mergeStates(base2, mine2, theirs2).merged;
    assert.deepEqual(out.comments.map((c) => c.id), [x]);
    assert.deepEqual(out.comments[0].replies.map((r) => r.id), [x, "rp2"]);

    const mine3 = load(Object.assign({}, twoRows(x), { comments: [] }));
    out = mergeStates(base2, mine3, load(base2)).merged;
    assert.deepEqual(out.comments, []);
  });

  test(`merge: people, tags and b-roll shots with the id "${x}" add, keep and delete`, () => {
    assert.deepEqual(mergePeople([], [{ id: x, name: "Ada" }], []).map((p) => p.id), [x]);
    assert.deepEqual(mergePeople([], [], [{ id: x, name: "Ada" }]).map((p) => p.id), [x]);

    const tag = { id: x, cat: "prop", name: "Kettle", owner: "", notes: "", status: "needed" };
    assert.deepEqual(mergeProductionTags([], [tag], [tag]).map((t) => t.id), [x]);
    assert.deepEqual(mergeProductionTags([], [], [tag]).map((t) => t.id), [x]);
    assert.deepEqual(mergeProductionTags([tag], [], [tag]), []);

    const shot = { id: x, name: "Street", owner: "", notes: "", status: "needed" };
    assert.deepEqual(mergeBrollShots([], [shot], [shot]).map((b) => b.id), [x]);
    assert.deepEqual(mergeBrollShots([], [], [shot]).map((b) => b.id), [x]);
    assert.deepEqual(mergeBrollShots([shot], [], [shot]), []);
    const mineShot = Object.assign({}, shot, { notes: "low sun" });
    const merged = mergeBrollShots([shot], [mineShot], [shot]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].notes, "low sun");
  });

  test(`byId: a missing "${x}" is missing, a present one is found`, () => {
    assert.equal(byId([])[x], undefined);
    const item = { id: x };
    assert.equal(byId([item])[x], item);
    assert.deepEqual(Object.keys(byId([item])), [x]);
  });
}

test("a saved file that already holds __proto__ and constructor ids loads, merges and reloads intact", () => {
  const fileText = JSON.stringify({
    schema: 2, rev: 3, title: "Old file", lastEditedBy: "Adam",
    rows: [
      { id: "r1", audioText: "one" },
      { id: "__proto__", audioText: 'proto <span class="cmt-anchor" data-cmt="constructor">line</span>' },
      { id: "constructor", audioText: "ctor" }
    ],
    comments: [{ id: "constructor", rowId: "__proto__", field: "audioText", body: "check",
                 createdAt: "2026-01-01T00:00:00Z" }],
    brollShots: [{ id: "__proto__", name: "Street" }]
  });
  const base = migrateDocument(JSON.parse(fileText), { kind: "file" });
  assert.deepEqual(rowIds(base), ["r1", "__proto__", "constructor"]);
  assert.equal(base.comments[0].rowId, "__proto__");

  const mine = load(base), theirs = load(base);
  mine.rows = mine.rows.filter((r) => r.id !== "constructor");
  mine.rows[1].audioText = 'proto, mine <span class="cmt-anchor" data-cmt="constructor">line</span>';
  theirs.rows.push({ id: "valueOf", audioText: "new", visualText: "", status: "todo", updatedAt: "" });
  theirs.brollShots = [];
  const r = mergeStates(base, mine, theirs);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(rowIds(r.merged), ["r1", "__proto__", "valueOf"]);
  assert.match(r.merged.rows[1].audioText, /proto, mine/);
  assert.equal(r.merged.rows[2].audioText, "new");
  assert.deepEqual(r.merged.comments.map((c) => [c.id, c.rowId]), [["constructor", "__proto__"]]);
  assert.deepEqual(r.merged.brollShots, []);

  const reloaded = migrateRows(JSON.parse(JSON.stringify(r.merged)));
  assert.deepEqual(reloaded, r.merged);
});
