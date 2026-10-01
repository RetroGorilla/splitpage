import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byId, commentContentEqual, conflictComment, mergeComments, mergeRows, rowContentEqual, rowFieldKey
} from "../../../src/core/merge/rows.ts";
import type { MergeComment, MergeConflict, MergeRow, MergeStats } from "../../../src/core/merge/rows.ts";
import type { MergeDoc } from "../../../src/core/merge/states.ts";
import { textMergeContext } from "../../../src/core/merge/text-field.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { T } from "../text/cells.ts";
import { EDITOR, FIXED_ISO, countingIds, fakeDecoder, fixedClock, jsonCopy } from "./fakes.ts";

const OLD = "2026-01-01T09:00:00.000Z";
const pic = (ch: string) => ({ sha256: ch.repeat(64), width: 640, height: 360, mime: "image/png" });

function row(id: string, audio: Run[] | string, extra?: Partial<MergeRow>): MergeRow {
  return Object.assign({
    id: id, status: "todo", visualText: "", audioText: typeof audio === "string" ? audio : toHtml(audio),
    imageRef: null, updatedAt: OLD, updatedBy: "Base Writer"
  }, extra || {});
}

function runRows(cells: Run[][], base: MergeDoc | null, mine: MergeDoc, theirs: MergeDoc) {
  const { decode } = fakeDecoder(cells);
  const conflicts: MergeConflict[] = [];
  const stats: MergeStats = { rowsFromThem: 0, rowsFromMe: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 };
  const before = JSON.stringify([base, mine, theirs]);
  const text = textMergeContext(decode, base, mine, theirs);
  const rows = mergeRows(base, mine, theirs, {
    text: text, conflicts: conflicts, stats: stats, clock: fixedClock, editor: function () { return EDITOR; }
  });
  assert.equal(JSON.stringify([base, mine, theirs]), before, "the inputs are left as they were");
  return { rows: rows, conflicts: conflicts, stats: stats };
}

test("byId maps by id, the last entry winning, into a plain object", () => {
  const a = { id: "a", n: 1 }, a2 = { id: "a", n: 2 }, b = { id: "b", n: 3 };
  const map = byId([a, b, a2]);
  assert.deepEqual(Object.keys(map), ["a", "b"]);
  assert.equal(map.a, a2);
  assert.deepEqual(byId(null), {});
  assert.equal(Object.getPrototypeOf(byId([])), Object.prototype);
});

test("byId with an id of __proto__ sets the map's prototype, and other prototype names read through, as today (#278)", () => {
  const p = { id: "__proto__", n: 1 };
  const map = byId([p]);
  assert.deepEqual(Object.keys(map), []);
  assert.equal(Object.getPrototypeOf(map), p);
  assert.equal(typeof byId([]).toString, "function");
});

test("a row's field keys and content equality ignore stamps but not a set length", () => {
  const r = row("r1", [T("Hi.")], { imageRef: pic("a"), imageLinks: [{ href: "https://v.example/1", poster: true }], lengthSeconds: 12 });
  assert.equal(rowFieldKey(r, "imageRef"), "a".repeat(64));
  assert.equal(rowFieldKey(r, "imageLinks"), "u:https://v.example/1*");
  assert.equal(rowFieldKey(r, "moreImages"), null);
  assert.equal(rowFieldKey(r, "audioText"), toHtml([T("Hi.")]));
  assert.equal(rowFieldKey(r, "visualText"), null);
  assert.equal(rowFieldKey(null, "audioText"), null);
  assert.equal(rowFieldKey({ imageRef: { sha256: 7 } }, "imageRef"), null);
  assert.equal(rowContentEqual(r, Object.assign(jsonCopy(r), { updatedAt: FIXED_ISO, updatedBy: "Someone", status: "shot" })), true);
  assert.equal(rowContentEqual(r, Object.assign(jsonCopy(r), { lengthSeconds: 13 })), false);
  assert.equal(rowContentEqual(r, Object.assign(jsonCopy(r), { lengthSeconds: -1 })), false);
  assert.equal(rowContentEqual(row("x", ""), row("y", "", { lengthSeconds: "12" })), true);
  assert.equal(rowContentEqual(r, null), false);
});

test("comment content equality looks at the body, resolution, assignee and replies only", () => {
  const c: MergeComment = { id: "c1", body: "Look", resolved: false, assignee: "", replies: [], updatedAt: OLD };
  assert.equal(commentContentEqual(c, { id: "c1", body: "Look", updatedAt: FIXED_ISO, author: "Other" }), true);
  assert.equal(commentContentEqual(c, Object.assign(jsonCopy(c), { body: "Look again" })), false);
  assert.equal(commentContentEqual(c, Object.assign(jsonCopy(c), { resolved: true })), false);
  assert.equal(commentContentEqual(c, Object.assign(jsonCopy(c), { assignee: "Ada" })), false);
  assert.equal(commentContentEqual(c, Object.assign(jsonCopy(c), { replies: [{ id: "rp1" }] })), false);
  assert.equal(commentContentEqual(c, null), false);
});

const ONE = [T("one two")], ONE_M = [T("ONE two")], ONE_T = [T("one TWO")], ONE_MT = [T("ONE TWO")];
const TWO = [T("two")], THREE = [T("three")], FOUR = [T("four")], FOUR_M = [T("four, mine")];
const NEW_M = [T("mine new")], NEW_T = [T("theirs new")];

test("rows: inserts land after their neighbour, deletes of untouched rows hold, edits merge and stamp mine", () => {
  const base = { rows: [row("r1", ONE), row("r2", TWO), row("r3", THREE), row("r4", FOUR)] };
  const mine = { rows: [row("r1", ONE_M, { updatedBy: "Mine" }), row("r2", TWO), row("rM", NEW_M), row("r4", FOUR_M, { updatedBy: "Mine" })] };
  const theirs = { rows: [row("r1", ONE_T, { updatedBy: "Theirs" }), row("r2", TWO), row("r3", THREE), row("rT", NEW_T)] };
  const r = runRows([ONE, ONE_M, ONE_T, TWO, THREE, FOUR, FOUR_M, NEW_M, NEW_T], base, mine, theirs);
  assert.deepEqual(r.rows.map((x) => x.id), ["r1", "r2", "rM", "r4", "rT"]);
  assert.deepEqual(r.rows[0], row("r1", ONE_MT, { updatedAt: FIXED_ISO, updatedBy: EDITOR }));
  assert.deepEqual(r.rows[1], row("r2", TWO));
  assert.deepEqual(r.rows[3], mine.rows[3]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.stats, { rowsFromThem: 0, rowsFromMe: 1, rowsAddedByMe: 1, rowsAddedByThem: 1 });
});

test("rows: a word changed two ways is a conflict that keeps theirs and is not stamped", () => {
  const CAT = [T("the cat sat")], DOG = [T("the dog sat")], COW = [T("the cow sat")];
  const r = runRows([CAT, DOG, COW], { rows: [row("r1", CAT)] }, { rows: [row("r1", DOG)] },
    { rows: [row("r1", COW, { updatedBy: "Theirs" })] });
  assert.deepEqual(r.rows, [row("r1", COW, { updatedBy: "Theirs" })]);
  assert.deepEqual(r.conflicts, [{ rowId: "r1", field: "audioText", mine: toHtml(DOG), theirs: toHtml(COW) }]);
  assert.deepEqual(r.stats, { rowsFromThem: 1, rowsFromMe: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 });
});

test("rows: a picture only I changed comes with its name and drawing; changed both ways it is a conflict", () => {
  const ann = { imageRef: pic("f"), marks: [{ kind: "pen" }] };
  const base = { rows: [row("r1", "", { imageRef: pic("a"), imageName: "a.png" }), row("r2", "", { imageRef: pic("b") })] };
  const mine = { rows: [row("r1", "", { imageRef: pic("e"), imageAnnotation: ann }), row("r2", "", { imageRef: pic("1") })] };
  const theirs = { rows: [row("r1", "", { imageRef: pic("a"), imageName: "a.png" }), row("r2", "", { imageRef: pic("2") })] };
  const r = runRows([], base, mine, theirs);
  assert.deepEqual(r.rows[0], row("r1", "", { imageRef: pic("e"), imageAnnotation: ann, updatedAt: FIXED_ISO, updatedBy: EDITOR }));
  assert.deepEqual(r.rows[1], theirs.rows[1]);
  assert.deepEqual(r.conflicts, [{ rowId: "r2", field: "imageRef", mine: pic("1"), theirs: pic("2") }]);
});

test("rows: the further status wins, a set length follows the side that changed it, and gallery lists merge", () => {
  const v = (s: string) => ({ href: "https://v.example/" + s });
  const base = { rows: [row("r1", "", { status: "ready", lengthSeconds: 12, imageLinks: [v("a")] })] };
  const mine = { rows: [row("r1", "", { status: "todo", lengthSeconds: 20, imageLinks: [v("a"), v("m")] })] };
  const theirs = { rows: [row("r1", "", { status: "shot", lengthSeconds: 12, imageLinks: [v("a"), v("t")] })] };
  const r = runRows([], base, mine, theirs);
  assert.deepEqual(r.rows[0], row("r1", "", {
    status: "shot", lengthSeconds: 20, imageLinks: [v("a"), v("t"), v("m")], updatedAt: FIXED_ISO, updatedBy: EDITOR
  }));
  assert.deepEqual(r.stats, { rowsFromThem: 0, rowsFromMe: 1, rowsAddedByMe: 0, rowsAddedByThem: 0 });
});

test("rows: a cell theirs holds as null, or not at all, is left so when the merge keeps it", () => {
  const holed = () => {
    const r = row("r1", [T("One.")], { visualText: null });
    Reflect.deleteProperty(r, "audioText");
    return r;
  };
  const r = runRows([], { rows: [holed()] }, { rows: [holed()] }, { rows: [holed()] });
  assert.equal(r.rows[0]?.visualText, null);
  assert.equal("audioText" in (r.rows[0] as MergeRow), false);
  assert.deepEqual(r.rows, [holed()]);
});

test("rows: equal status ranks keep mine, and an unknown status ranks as todo, before migration", () => {
  const status = (mine: string, theirs: string) => runRows([ONE], { rows: [row("r1", ONE)] },
    { rows: [row("r1", ONE, { status: mine })] }, { rows: [row("r1", ONE, { status: theirs })] }).rows[0]?.status;
  assert.equal(status("todo", "bogus"), "todo");
  assert.equal(status("bogus", "todo"), "bogus");
  assert.equal(status("bogus", "ready"), "ready");
  assert.equal(status("shot", "ready"), "shot");
});

test("rows: one id added on both sides has no base, so an empty cell of mine beside their text is a conflict", () => {
  const r = runRows([ONE, TWO], { rows: [row("r1", ONE)] },
    { rows: [row("r1", ONE), row("r9", "")] }, { rows: [row("r1", ONE), row("r9", TWO)] });
  assert.deepEqual(r.conflicts, [{ rowId: "r9", field: "audioText", mine: null, theirs: toHtml(TWO) }]);
  assert.deepEqual(r.rows.map((x) => x.id), ["r1", "r9"]);
  assert.equal(r.rows[1]?.audioText, toHtml(TWO));
});

test("rows: with no base nothing is a delete, and a row only they hold counts as theirs", () => {
  const r = runRows([ONE, TWO], null, { rows: [row("r1", ONE)] }, { rows: [row("r2", TWO)] });
  assert.deepEqual(r.rows.map((x) => x.id), ["r1", "r2"]);
  assert.deepEqual(r.stats, { rowsFromThem: 0, rowsFromMe: 0, rowsAddedByMe: 1, rowsAddedByThem: 1 });
});

const PROTO_IDS = ["constructor", "__proto__", "toString", "hasOwnProperty"];

test("rows with Object.prototype ids: mine's new ones are lost and theirs' count as edits, as today (#278)", () => {
  const cells = [[T("One.")], [T("Mine ctor.")], [T("Mine proto.")], [T("Their ts.")], [T("Their hop.")]];
  const base = { rows: [row("r1", [T("One.")])] };
  const mine = { rows: [row("r1", [T("One.")]), row("constructor", [T("Mine ctor.")]), row("__proto__", [T("Mine proto.")])] };
  const theirs = { rows: [row("r1", [T("One.")]), row("toString", [T("Their ts.")]), row("hasOwnProperty", [T("Their hop.")])] };
  const r = runRows(cells, base, mine, theirs);
  assert.deepEqual(r.rows.map((x) => x.id), ["r1", "toString", "hasOwnProperty"]);
  assert.deepEqual(r.stats, { rowsFromThem: 2, rowsFromMe: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 });
});

test("rows with Object.prototype ids that mine deleted come back emptied and stamped mine, as today (#278)", () => {
  const cells = PROTO_IDS.flatMap((id) => [[T("Row " + id + ".")], [T("Visual " + id + ".")]]);
  const all = [row("r1", "")].concat(PROTO_IDS.map((id) =>
    row(id, [T("Row " + id + ".")], { visualText: toHtml([T("Visual " + id + ".")]) })));
  const r = runRows(cells, { rows: jsonCopy(all) }, { rows: [row("r1", "")] }, { rows: jsonCopy(all) });
  assert.deepEqual(r.rows.map((x) => x.id), ["r1"].concat(PROTO_IDS));
  r.rows.slice(1).forEach((x) => {
    assert.equal(x.audioText, "", x.id);
    assert.equal(x.visualText, "", x.id);
    assert.equal(x.updatedBy, EDITOR, x.id);
  });
  assert.deepEqual(r.stats, { rowsFromThem: 0, rowsFromMe: 4, rowsAddedByMe: 0, rowsAddedByThem: 0 });
});

function cm(id: string, extra?: Partial<MergeComment>): MergeComment {
  return Object.assign({
    id: id, rowId: "r1", field: "audioText", body: "Look at " + id, resolved: false, resolvedBy: null, resolvedAt: null,
    assignee: "", kind: "anchor", createdAt: OLD, updatedAt: OLD, replies: []
  }, extra || {});
}
const reply = (id: string, when: string) => ({ id: id, body: "Reply " + id, createdAt: when });
const at = (day: number) => "2026-02-0" + String(day) + "T09:00:00.000Z";

test("comments: the newer copy wins, resolution and assignee are kept, replies are joined in time order", () => {
  const base = { rows: [], comments: [cm("c1"), cm("c2"), cm("c3")] };
  const mine = { rows: [], comments: [
    cm("c1", { resolved: true, resolvedBy: "Sam", resolvedAt: at(5), assignee: "Ada", updatedAt: at(5), replies: [reply("rpM", at(3))] }),
    cm("c3"), cm("cM", { createdAt: at(5), updatedAt: at(5) })
  ] };
  const theirs = { rows: [], comments: [
    cm("c1", { body: "Edited", updatedAt: at(6), replies: [reply("rpT", at(2))] }), cm("c2", { body: "Theirs" })
  ] };
  const before = JSON.stringify([base, mine, theirs]);
  const out = mergeComments(base, mine, theirs);
  assert.equal(JSON.stringify([base, mine, theirs]), before);
  assert.deepEqual(out.map((c) => c.id), ["c1", "c2", "cM"]);
  assert.deepEqual(out[0], cm("c1", {
    body: "Edited", updatedAt: at(6), resolved: true, resolvedBy: "Sam", resolvedAt: at(5), assignee: "Ada",
    replies: [reply("rpT", at(2)), reply("rpM", at(3))]
  }));
  assert.deepEqual(mergeComments(null, { rows: [], comments: [cm("c1")] }, { rows: [], comments: [cm("c1", { resolved: true, resolvedBy: "Bo", resolvedAt: at(7) })] })[0],
    cm("c1", { resolved: true, resolvedBy: "Bo", resolvedAt: at(7) }));
});

test("comments: on an updatedAt tie my copy is kept, while on a resolvedAt tie theirs names the resolver", () => {
  const side = (body: string, by: string, extra?: Partial<MergeComment>) => ({ rows: [], comments: [
    cm("c1", Object.assign({ body: body, updatedAt: at(5), resolved: true, resolvedBy: by, resolvedAt: at(5) }, extra || {}))
  ] });
  const out = mergeComments(null, side("Mine", "Sam"), side("Theirs", "Bo"))[0] as MergeComment;
  assert.deepEqual([out.body, out.resolvedBy], ["Mine", "Bo"]);
  const created = mergeComments(null, side("Mine", "Sam", { updatedAt: null }), side("Theirs", "Bo", { updatedAt: null }))[0] as MergeComment;
  assert.equal(created.body, "Mine", "the tie falls back to createdAt, and still keeps mine");
});

test("comments: the replies of a comment both sides hold are the input objects themselves, not copies (pinned: found, not changed in 2.5)", () => {
  const mineShared = reply("rp1", at(2)), mineOwn = reply("rpM", at(3));
  const theirsShared = reply("rp1", at(2)), theirsOwn = reply("rpT", at(4));
  const onlyMine = reply("rpX", at(5));
  const mine = { rows: [], comments: [cm("c1", { replies: [mineShared, mineOwn] }), cm("c2", { replies: [onlyMine] })] };
  const theirs = { rows: [], comments: [cm("c1", { replies: [theirsShared, theirsOwn] })] };
  const out = mergeComments(null, mine, theirs);
  const both = (out[0] as MergeComment).replies || [];
  assert.equal(both.length, 3);
  assert.equal(both[0], theirsShared, "theirs replaces a reply id both hold, by reference");
  assert.equal(both[1], mineOwn);
  assert.equal(both[2], theirsOwn);
  const one = (out[1] as MergeComment).replies || [];
  assert.notEqual(one[0], onlyMine, "a comment only one side holds is copied whole");
  assert.deepEqual(one[0], onlyMine);
});

test("comments with Object.prototype ids are dropped, and a reply id of __proto__ is lost, as today (#278)", () => {
  const base = { rows: [], comments: [cm("constructor"), cm("toString"), cm("c1", { replies: [reply("constructor", at(3)), reply("__proto__", at(3))] })] };
  const mine = jsonCopy(base);
  (mine.comments[0] as MergeComment).body = "Ctor, mine";
  mine.comments.push(cm("__proto__"));
  ((mine.comments[2] as MergeComment).replies as unknown[]).push(reply("hasOwnProperty", at(5)));
  const theirs = jsonCopy(base);
  (theirs.comments[1] as MergeComment).resolved = true;
  theirs.comments.push(cm("hasOwnProperty"));
  ((theirs.comments[2] as MergeComment).replies as unknown[]).push(reply("toString", at(6)));
  const out = mergeComments(base, mine, theirs);
  assert.deepEqual(out.map((c) => c.id), ["c1"]);
  assert.deepEqual((out[0] as MergeComment).replies?.map((x) => x.id), ["constructor", "hasOwnProperty", "toString"]);
});

test("a conflict card takes its id, time and author from the ports, in today's key order", () => {
  const ids = countingIds();
  const ports = { ids: ids, clock: fixedClock, editor: function () { return EDITOR; } };
  const image = conflictComment({ rowId: "r2", field: "imageRef", mine: pic("1"), theirs: pic("2") }, ports);
  assert.equal(JSON.stringify(image), JSON.stringify({
    id: "c-fake-1", rowId: "r2", field: "visualImage", imageValue: pic("1"), anchorId: null, quotedText: "", author: EDITOR,
    body: '<img class="comment-img" data-blob="' + "1".repeat(64) + '" data-w="640" data-h="360" data-mime="image/png">',
    resolved: false, createdAt: FIXED_ISO, updatedAt: FIXED_ISO, kind: "conflict", conflictField: "Visual image", emptyValue: false,
    replies: []
  }));
  assert.equal("titleValue" in image && image.titleValue === undefined, true);
  const title = conflictComment({ rowId: null, field: "title", mine: "Fish & Chips <3", theirs: "Theirs" }, ports);
  assert.equal(title.id, "c-fake-2");
  assert.equal(title.body, "Fish &amp; Chips &lt;3");
  assert.equal(title.conflictField, "Title");
  assert.equal(title.titleValue, "Fish & Chips <3");
  assert.equal(title.imageValue, undefined);
  const audio = conflictComment({ rowId: "r1", field: "audioText", mine: null, theirs: "<b>x</b>" }, ports);
  assert.deepEqual([audio.body, audio.conflictField, audio.emptyValue, audio.field], ["", "Audio", true, "audioText"]);
  assert.equal(conflictComment({ rowId: "r1", field: "visualText", mine: "<em>v</em>", theirs: "" }, ports).body, "<em>v</em>");
  assert.deepEqual(ids.minted, ["c-fake-1", "c-fake-2", "c-fake-3", "c-fake-4"]);
});
