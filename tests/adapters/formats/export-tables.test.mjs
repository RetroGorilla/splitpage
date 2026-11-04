import "../../../src/test/_dom.mjs";
import "../../../src/test/_preferences-started.mjs";
import "../../../src/test/_export-services-started.mjs";
import "../../../src/test/_broll-mounted.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../../../src/bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { mountProductionTagsFeature as initTags } from "../../../src/bootstrap/wiring/production-tags.ts";
import { exportDocumentOf } from "../../../src/bootstrap/wiring/export-capture.ts";
import { exportServices } from "../../../src/application/export/services.ts";
import { LONG_DEMO } from "../../../src/starters/index.ts";
import { loadTestDocument } from "../../../src/test/_document.mjs";
import { buildBreakdownCsv, buildBrollCsv, buildCsv, scriptTable } from "../../../src/adapters/formats/csv.ts";
import {
  breakdownRows,
  breakdownTable,
  brollShotListForPrint,
  brollTable,
  commentBodyText,
  commentEntries,
  beatFacts
} from "../../../src/adapters/formats/export-projections.ts";

initTags();

const copy = (o) => JSON.parse(JSON.stringify(o));
const demo = () => {
  loadTestDocument(migrateRows(copy(LONG_DEMO.state)));
  return exportDocumentOf(currentDocument());
};
const small = (state) => {
  loadTestDocument(migrateRows(Object.assign({ schema: 2, title: "Small", comments: [] }, state)));
  return exportDocumentOf(currentDocument());
};
const row = (id, over) => Object.assign({ id, visualText: "V " + id, audioText: "A " + id, status: "todo" }, over);
const BOM = "﻿";
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);
const img = (sha) => `<img data-blob="${sha}">`;

const BREAKDOWN_HEAD = "Category,Item,Status,Assigned to,Mentions,Beats,In script,Notes,B-roll shots,First beat at,Group";
const BROLL_HEAD = "Beat,Shot,Status,Flagged,Location,Props,Cuts against,Assigned to,Note,Description,Beat start";

test("the breakdown sheet quotes a cell only when it has to, and doubles its quotes", () => {
  const doc = demo();
  const first = doc.production[0];
  const csv = (notes) => buildBreakdownCsv({ ...doc, production: [{ ...first, notes }] });
  assert.ok(csv('say "hi"').includes(',"say ""hi"""'));
  assert.ok(csv("a\rb").includes(',"a\rb",'));
  assert.ok(csv("a\nb").includes(',"a\nb",'));
  assert.ok(csv("a,b").includes(',"a,b",'));
  assert.ok(csv("plain").includes(",plain,"));
  assert.ok(!csv("plain").includes('"plain"'));
});

test("the breakdown sheet starts with a byte order mark, one header line and a CRLF per row", () => {
  const doc = demo();
  const csv = buildBreakdownCsv(doc);
  assert.equal(csv[0], BOM);
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], BREAKDOWN_HEAD);
  assert.equal(lines.length, breakdownTable(doc).rows.length + 1);
  assert.ok(!csv.includes("(nothing labelled yet)"));
});

test("a breakdown with nothing labelled says so in a single row", () => {
  const doc = demo();
  assert.equal(buildBreakdownCsv({ ...doc, production: [] }), BOM + BREAKDOWN_HEAD + "\r\n(nothing labelled yet)");
});

test("the b-roll sheet starts with a byte order mark, one header line and a CRLF per row", () => {
  const doc = demo();
  const csv = buildBrollCsv(doc);
  assert.equal(csv[0], BOM);
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], BROLL_HEAD);
  assert.equal(lines.length, brollTable(doc).rows.length + 1);
  assert.ok(!csv.includes("(no b-roll yet)"));
});

test("a b-roll sheet with no shots says so in a single row", () => {
  const doc = demo();
  assert.equal(buildBrollCsv({ ...doc, broll: [] }), BOM + BROLL_HEAD + "\r\n(no b-roll yet)");
});

test("the script sheet's header and column count", () => {
  const doc = demo();
  const table = scriptTable(doc);
  assert.deepEqual(table.head, ["Beat", "Start", "Status", "Read", "Read set by hand", "Visual", "Audio", "Tags", "B-roll", "Open comments"]);
  assert.deepEqual(table.commentHead, ["No.", "Location", "Status", "Assigned to", "Author", "Date", "Quoted text", "Comment"]);
  assert.equal(buildCsv(doc).slice(1).split("\r\n")[0], table.head.join(","));
});

const TIMED = [row("r0", { lengthSeconds: 60, status: "shot", visualText: "Wide shot", audioText: "Hello" }), row("r1", { lengthSeconds: 30 })];

test("a scene's row has its number, start, status, read time and whether the read was set by hand", () => {
  const doc = small({ rows: [TIMED[0], row("r1", { audioText: "One two three four five six seven eight nine ten." })] });
  const table = scriptTable(doc);
  assert.equal(table.beats.length, 2);
  assert.deepEqual(table.beats[0].cells.slice(0, 7), ["A.1", "00:00", "Filmed", "1:00", "yes", "Wide shot", "Hello"]);
  assert.equal(table.beats[0].status, "shot");
  assert.equal(table.beats[1].cells[0], "A.2");
  assert.equal(table.beats[1].cells[1], "01:00");
  assert.equal(table.beats[1].cells[4], "");
  assert.equal(table.beats[1].status, "todo");
  assert.deepEqual(table.beats[1].cells.slice(5, 7), ["V r1", "One two three four five six seven eight nine ten."]);
});

test("the total row counts shot scenes and the running time", () => {
  const table = scriptTable(small({ rows: TIMED }));
  assert.equal(table.summary.length, 1);
  assert.deepEqual(table.summary[0].slice(0, 4), ["Total", "", "1 of 2 filmed", "1:30"]);
  assert.equal(table.summary[0].length, table.head.length);
});

test("a script with no scenes has an empty status in its total row", () => {
  const table = scriptTable(small({ rows: [] }));
  assert.deepEqual(table.beats, []);
  assert.deepEqual(table.summary[0].slice(0, 4), ["Total", "", "", "0:00"]);
  assert.equal(table.summary.length, 1);
});

test("the target row says on target, over or under, with the target time", () => {
  const target = (seconds) => scriptTable(small({ rows: TIMED, targetSeconds: seconds })).summary[1];
  assert.deepEqual(target(90).slice(0, 4), ["Target", "", "on target", "1:30"]);
  assert.deepEqual(target(60).slice(0, 4), ["Target", "", "0:30 over", "1:00"]);
  assert.deepEqual(target(120).slice(0, 4), ["Target", "", "0:30 under", "2:00"]);
  assert.equal(scriptTable(small({ rows: TIMED })).summary.length, 1);
});

const at = (n) => `2026-09-20T10:${String(n).padStart(2, "0")}:00.000Z`;
const note = (id, rowId, n, over) => Object.assign({ id, rowId, field: "audioText", author: "Ann", body: "Note " + id, createdAt: at(n), replies: [] }, over);

function commented() {
  const open = Array.from({ length: 11 }, (_, i) => note("c" + i, "r0", i));
  const numbers = Object.fromEntries(open.map((c, i) => [c.id, i + 1]));
  numbers.late = 12;
  const doc = small({
    rows: [row("r0"), row("r1"), row("r2")],
    comments: [
      ...open,
      note("done", "r0", 20, { resolved: true, resolvedBy: "Sam", replies: [{ id: "d1", author: "Bea", body: "Thanks", createdAt: at(21) }] }),
      note("done2", "r0", 22, { resolved: true, resolvedBy: "" }),
      note("early", "r1", 0, { resolved: true, resolvedBy: "Sam" }),
      note("late", "r1", 5, { replies: [{ id: "l1", author: "Cy", body: "Reply <b>text</b>", createdAt: at(6) }] }),
      note("title", "", 7, { field: "title" })
    ]
  });
  return { ...doc, commentNumbers: numbers };
}

test("a scene lists its open comment numbers in number order, not text order", () => {
  const table = scriptTable(commented());
  assert.equal(table.beats[0].cells[9], "1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11");
  assert.equal(table.beats[1].cells[9], "12");
  assert.equal(table.beats[2].cells[9], "");
});

test("each comment is a row with its number, place, status, author and text, and each reply follows it", () => {
  const comments = scriptTable(commented()).comments;
  const byBody = (text) => comments.find((c) => c.cells[7] === text);
  assert.equal(comments.length, 11 + 2 + 1 + 1 + 1 + 1 + 1);
  assert.deepEqual(byBody("Note c0").cells.slice(0, 5), [1, "Beat A.1 · Audio", "Open", "", "Ann"]);
  assert.deepEqual(byBody("Note c0").reply, false);
  assert.deepEqual(byBody("Note done").cells.slice(0, 5), ["", "Beat A.1 · Audio", "Resolved by Sam", "", "Ann"]);
  assert.equal(byBody("Note done2").cells[2], "Resolved");
  assert.equal(byBody("Note late").cells[0], 12);
  assert.equal(byBody("Note title").cells[1], "Document title");
  const done = comments.indexOf(byBody("Note done"));
  const reply = comments[done + 1];
  assert.equal(reply.reply, true);
  assert.equal(reply.resolved, true);
  assert.deepEqual([reply.cells[0], reply.cells[1], reply.cells[2], reply.cells[3], reply.cells[4], reply.cells[6], reply.cells[7]], ["", "", "", "", "↳ Bea", "", "Thanks"]);
  assert.ok(reply.cells[5].length > 0);
  const late = comments.indexOf(byBody("Note late"));
  assert.equal(comments[late].resolved, false);
  assert.equal(comments[late + 1].reply, true);
  assert.equal(comments[late + 1].resolved, false);
  assert.equal(comments[late + 1].cells[7], "Reply text");
  assert.equal(byBody("Note done").resolved, true);
});

test("the sheet's comments section comes after a blank line and its own heading and header", () => {
  const lines = buildCsv(commented()).slice(1).split("\r\n");
  const heading = lines.indexOf("Comments");
  assert.ok(heading > 0);
  assert.equal(lines[heading - 1], "");
  assert.equal(lines[heading + 1], "No.,Location,Status,Assigned to,Author,Date,Quoted text,Comment");
  assert.equal(lines.length - heading - 2, 18);
  assert.ok(lines.slice(0, heading - 1).every((l) => l !== ""));
});

test("a sheet with no comments has no comments section", () => {
  const csv = buildCsv(small({ rows: TIMED }));
  assert.ok(!csv.includes("Comments"));
  assert.ok(!csv.endsWith("\r\n"));
  assert.equal(csv.slice(1).split("\r\n").length, 1 + 2 + 1);
});

test("a scene's b-roll cell lists every shot with its state, joined by a semicolon", () => {
  const doc = demo();
  const extra = shotWith(doc, { id: "x1", name: "second shot", ordinal: 1, status: "needed", reshoot: true });
  const table = scriptTable({ ...doc, broll: [...doc.broll, extra] });
  assert.equal(table.beats[3].cells[8], "A.4.1 fingertip pushing on the sticky old foam (shot); A.4.2 second shot (to shoot, flagged)");
  assert.equal(table.beats[5].cells[8], "A.6.1 the toothpick lifting a long strand of goo (shot, flagged)");
  assert.equal(table.beats[0].cells[8], "");
});

test("a scene's tag cell groups names by category, in the order they appear", () => {
  const doc = demo();
  const table = scriptTable(doc);
  assert.equal(table.beats[0].cells[7], "Prop: Pentax K1000; Location: workbench; Music/SFX: shutter click");
  assert.equal(table.beats[4].cells[7], "Prop: toothpick, light seal kit, naphtha; Gear: overhead rig");
});

test("scene facts: start times add up, read times are the formatted seconds, an unknown status is to do", () => {
  const doc = demo();
  const beats = beatFacts(doc);
  let at = 0;
  for (const s of beats) {
    assert.equal(s.startSeconds, at);
    assert.ok(s.seconds > 0);
    at += s.seconds;
  }
  assert.equal(beats[1].startSeconds, beats[0].seconds);
  assert.equal(beats[0].read, Math.floor(beats[0].seconds / 60) + ":" + String(Math.round(beats[0].seconds % 60)).padStart(2, "0"));
  const todo = beatFacts({ ...doc, beats: [{ ...doc.beats[0], status: "todo" }] })[0];
  const odd = beatFacts({ ...doc, beats: [{ ...doc.beats[0], status: "no such status" }] })[0];
  assert.deepEqual(odd.status, todo.status);
  assert.equal(todo.status.id, "todo");
  assert.notEqual(todo.status.label, todo.status.id);
  assert.deepEqual(beatFacts({ ...doc, beats: undefined }), []);
});

test("breakdown rows: a scene is counted once however often an item is mentioned in it", () => {
  const doc = demo();
  const first = doc.production[0];
  const twice = { ...first, mentions: [first.mentions[0], { ...first.mentions[0], text: "again" }, first.mentions[1]] };
  const [r] = breakdownRows({ ...doc, production: [twice] });
  assert.deepEqual(r.beats, ["A.1", "A.28"]);
  assert.equal(r.mentions, 3);
  const [t] = breakdownTable({ ...doc, production: [twice] }).rows;
  assert.equal(t.cells[4], 3);
  assert.equal(t.cells[5], "A.1 A.28");
});

test("breakdown rows: status, owner, notes and where the item is", () => {
  const doc = demo();
  const first = doc.production[0];
  const people = [{ id: "", name: "Nobody" }, { id: "p1", name: "First" }, { id: "p2", name: "Second" }];
  const one = (over, extra) => breakdownRows({ ...doc, people, production: [{ ...first, ...over }], ...extra })[0];
  assert.equal(one({ owner: "p2" }).owner, "Second");
  assert.equal(one({ owner: "p1" }).owner, "First");
  assert.equal(one({ owner: "" }).owner, "");
  assert.equal(one({ owner: "gone" }).owner, "");
  assert.equal(one({ status: "have" }).status, "have");
  assert.equal(one({ status: "nonsense" }).status, "needed");
  assert.equal(one({ status: "nonsense" }).statusLabel, one({ status: "needed" }).statusLabel);
  assert.notEqual(one({ status: "have" }).statusLabel, "have");
  assert.equal(one({ notes: "" }).notes, "");
  assert.equal(one({ notes: undefined }).notes, "");
  assert.equal(one({ notes: "Keep" }).notes, "Keep");
  assert.equal(one({ orphaned: false }).inScript, "yes");
  const gone = one({ orphaned: true });
  assert.equal(gone.inScript, "no");
  assert.deepEqual(gone.beats, ["not in script"]);
  assert.deepEqual(one({ orphaned: true, mentions: [] }).beats, ["not in script"]);
  assert.deepEqual(one({ orphaned: false, mentions: [] }).beats, []);
  const plain = one({});
  assert.equal(plain.catId, "prop");
  assert.equal(plain.category, "Props & set dressing");
  assert.equal(plain.categoryLabel, "Prop");
});

test("breakdown table: the first scene's start, and nothing for an item that is nowhere", () => {
  const doc = demo();
  const first = doc.production[0];
  const cells = (over) => breakdownTable({ ...doc, production: [{ ...first, ...over }] }).rows[0].cells;
  assert.deepEqual(cells({}).slice(0, 4), ["Prop", "Pentax K1000", "Have it", "Sam"]);
  assert.equal(cells({})[6], "yes");
  assert.equal(cells({})[9], "00:00");
  assert.equal(cells({})[10], "Props & set dressing");
  assert.equal(cells({ mentions: [] })[9], "");
  assert.equal(cells({ orphaned: true })[9], "");
  assert.equal(cells({ mentions: [{ ...first.mentions[0], rowIndex: 4, rowId: doc.beats[4].id }] })[9], "01:40");
  assert.equal(breakdownTable({ ...doc, production: [first] }).rows[0].status, "have");
  assert.equal(breakdownTable({ ...doc, production: [first] }).rows[0].catId, "prop");
  assert.deepEqual(breakdownTable(doc).head, BREAKDOWN_HEAD.split(","));
});

test("breakdown table: an unknown category stops the export instead of guessing", () => {
  const doc = demo();
  assert.throws(() => breakdownRows({ ...doc, production: [{ ...doc.production[0], catId: "nope" }] }), /Unknown tag category: nope/);
});

function shotWith(doc, over) {
  const entry = { ...doc.broll.find((e) => e.id === "bs_ld_01"), ...over };
  const number = entry.rowIndex < 0 ? null : doc.numbering.shot(entry.rowId, entry.ordinal);
  return { ...entry, beatNumber: number ? doc.numbering.beats[entry.rowId].full : "", shotNumber: number?.full ?? "", shortShotNumber: number?.short ?? "" };
}
const prop = (name) => ({ key: "k" + name, id: "i" + name, name, status: "have" });

test("a prop's shots are found by its normalised name and listed in scene order", () => {
  const doc = demo();
  const first = doc.production[0];
  const early = shotWith(doc, { id: "e", name: "early", rowIndex: 2, rowId: "r3", ordinal: 0, props: [prop("  PENTAX   k1000 ")] });
  const late = shotWith(doc, { id: "l", name: "late", rowIndex: 9, rowId: "r10", ordinal: 0, props: [prop("Pentax K1000")] });
  const untitled = shotWith(doc, { id: "u", name: "", rowIndex: 5, rowId: "r6", ordinal: 0, props: [prop("pentax k1000")] });
  const other = shotWith(doc, { id: "o", name: "other", rowIndex: 1, rowId: "r2", ordinal: 0, props: [prop("different")] });
  const withShots = { ...doc, production: [first], broll: [late, other, untitled, early] };
  assert.deepEqual(breakdownRows(withShots)[0].broll, ["A.3.1 early", "A.6.1 Untitled shot", "A.10.1 late"]);
  assert.equal(breakdownTable(withShots).rows[0].cells[8], "A.3.1 early; A.6.1 Untitled shot; A.10.1 late");
  assert.deepEqual(breakdownRows({ ...doc, production: [first], broll: [other] })[0].broll, []);
  assert.deepEqual(breakdownRows({ ...doc, production: [first], broll: [] })[0].broll, []);
});

test("b-roll table: flags, props, scene start and order", () => {
  const doc = demo();
  const a = shotWith(doc, { id: "a", name: "A", rowIndex: 3, rowId: "r4", ordinal: 0, status: "shot", reshoot: false, props: [prop("one"), prop("two")] });
  const b = shotWith(doc, { id: "b", name: "B", rowIndex: 3, rowId: "r4", ordinal: 1, status: "needed", reshoot: true, props: [] });
  const c = shotWith(doc, { id: "c", name: "C", rowIndex: 0, rowId: "r1", ordinal: 0, status: "needed", reshoot: false, props: [] });
  const table = brollTable({ ...doc, broll: [b, a, c] });
  assert.deepEqual(table.head, BROLL_HEAD.split(","));
  assert.deepEqual(table.rows.map((r) => r.cells[1]), ["A.1.1 C", "A.4.1 A", "A.4.2 B"]);
  assert.deepEqual(table.rows.map((r) => [r.shot, r.flagged]), [[false, false], [true, false], [false, true]]);
  assert.deepEqual(table.rows.map((r) => r.cells[3]), ["", "", "yes"]);
  assert.equal(table.rows[1].cells[5], "one; two");
  assert.deepEqual(table.rows.map((r) => r.cells[10]), ["00:00", "01:03", "01:03"]);
  assert.deepEqual(table.rows.map((r) => r.cells[0]), ["A.1", "A.4", "A.4"]);
});

test("b-roll table: a shot whose scene is gone has no scene start, even for names every object has", () => {
  const doc = demo();
  for (const rowId of ["toString", "constructor", "__proto__", "gone"]) {
    const orphan = shotWith(doc, { id: "o", name: "O", rowIndex: -1, rowId });
    assert.equal(brollTable({ ...doc, broll: [orphan] }).rows[0].cells[10], "", rowId);
  }
});

test("the print list honours the filter and grouping asked for, and says so in its scope line", () => {
  const doc = demo();
  const all = doc.broll;
  const shotCount = all.filter((e) => e.status === "shot").length;
  const flaggedCount = all.filter((e) => e.reshoot).length;
  const total = (p) => p.groups.reduce((n, g) => n + g.total, 0);
  const plain = brollShotListForPrint(doc);
  assert.equal(plain.scope, "by beat");
  assert.equal(total(plain), all.length);
  assert.equal(brollShotListForPrint(doc, {}).scope, "by beat");
  assert.equal(brollShotListForPrint(doc, "shot").scope, "by beat");
  assert.equal(brollShotListForPrint(doc, null).scope, "by beat");
  assert.equal(brollShotListForPrint(doc, { filter: "nonsense", group: "nonsense" }).scope, "by beat");
  const shot = brollShotListForPrint(doc, { filter: "shot" });
  assert.equal(shot.scope, "Filmed, by beat");
  assert.equal(total(shot), shotCount);
  const flagged = brollShotListForPrint(doc, { filter: "flagged", group: "location" });
  assert.equal(flagged.scope, "Flagged, by location");
  assert.equal(total(flagged), flaggedCount);
  const unshot = brollShotListForPrint(doc, { filter: "unshot", group: "person" });
  assert.equal(unshot.scope, "To film, by person");
  assert.equal(total(unshot), all.length - shotCount);
  assert.equal(brollShotListForPrint(doc, { filter: "all", group: "location" }).scope, "by location");
  assert.equal(brollShotListForPrint(doc, { group: "location" }).scope, "by location");
});

test("the print list's summary counts every shot, whatever the filter shows", () => {
  const doc = demo();
  const all = doc.broll;
  const shotCount = all.filter((e) => e.status === "shot").length;
  const flaggedCount = all.filter((e) => e.reshoot).length;
  const expected = shotCount + " of " + all.length + " filmed" + (flaggedCount ? " · " + flaggedCount + " flagged" : "");
  for (const filter of ["all", "shot", "unshot", "flagged"]) {
    assert.equal(brollShotListForPrint(doc, { filter }).summary, expected, filter);
  }
});

test("the print list's title falls back for an untitled script", () => {
  const doc = demo();
  assert.equal(brollShotListForPrint(doc).title, LONG_DEMO.state.title);
  assert.equal(brollShotListForPrint({ ...doc, title: "" }).title, "Untitled Script");
});

test("each print group counts its shots, marks the unplaced group and carries its scene's start", () => {
  const doc = demo();
  const a = shotWith(doc, { id: "a", name: "A", rowIndex: 3, rowId: "r4", ordinal: 0, status: "shot", location: "Garage" });
  const b = shotWith(doc, { id: "b", name: "B", rowIndex: 3, rowId: "r4", ordinal: 1, status: "needed", location: "" });
  const added = shotWith(doc, { id: "c", name: "C", rowIndex: -1, rowId: null, ordinal: 0, status: "needed", location: "" });
  const beats = beatFacts(doc);
  const byBeat = brollShotListForPrint({ ...doc, broll: [b, a, added] }, { group: "scene" });
  assert.deepEqual(byBeat.groups.map((g) => [g.label, g.kind, g.none, g.start, g.done, g.total]), [
    ["Beat A.4", "scene", false, beats[3].start, 1, 2],
    ["Added here", "added", false, "", 0, 1]
  ]);
  assert.deepEqual(byBeat.groups[0].items.map((i) => [i.name, i.start]), [["A.4.1 A", beats[3].start], ["A.4.2 B", beats[3].start]]);
  assert.deepEqual(byBeat.groups[1].items.map((i) => [i.name, i.start]), [["C", ""]]);
  const byPlace = brollShotListForPrint({ ...doc, broll: [b, a, added] }, { group: "location" });
  assert.deepEqual(byPlace.groups.map((g) => [g.kind, g.none, g.start, g.done, g.total]), [
    ["location", false, "", 1, 1],
    ["location", true, "", 0, 2]
  ]);
  assert.deepEqual(byPlace.groups[1].items.map((i) => i.start), [beats[3].start, ""]);
});

const ROWS = [row("r0"), row("r1"), row("r2")];
const comment = (id, rowId, over) => Object.assign({ id, rowId, field: "audioText", author: "Ann", body: "Body " + id, createdAt: at(Number(id.replace(/\D/g, "")) || 0), replies: [] }, over);

test("a comment's place: the row and field, a missing row, or the title", () => {
  const doc = small({ rows: ROWS });
  const entries = commentEntries({
    ...doc,
    comments: [
      comment("c1", "r0"),
      comment("c2", "r1", { field: "visualText" }),
      comment("c3", "gone"),
      comment("c4", "", { field: "title" }),
      comment("c5", "r1", { field: "title" })
    ]
  });
  const place = (id) => { const e = entries.find((x) => x.id === id); return [e.location, e.rowIndex, e.field]; };
  assert.deepEqual(place("c1"), ["Row A.1 · Audio", 0, "audioText"]);
  assert.deepEqual(place("c2"), ["Row A.2 · Visual", 1, "visualText"]);
  assert.deepEqual(place("c3"), ["Deleted row · Audio", -1, "audioText"]);
  assert.deepEqual(place("c4"), ["Document title", -1, "title"]);
  assert.deepEqual(place("c5"), ["Document title", -1, "title"]);
});

test("when two rows share an id, a comment belongs to the first", () => {
  const doc = small({ rows: ROWS });
  const twins = [doc.beats[0], { ...doc.beats[1], id: doc.beats[0].id }];
  const [entry] = commentEntries({ ...doc, beats: twins, comments: [comment("c1", "r0")] });
  assert.equal(entry.rowIndex, 0);
  assert.equal(entry.location, "Row A.1 · Audio");
});

test("comments come in document order, then by time", () => {
  const doc = small({ rows: ROWS });
  const ids = (list) => commentEntries({ ...doc, comments: list }).map((e) => e.id);
  assert.deepEqual(ids([comment("c9", "r2", { createdAt: at(1) }), comment("c8", "r0", { createdAt: at(30) }), comment("c7", "r0", { createdAt: at(10) })]), ["c7", "c8", "c9"]);
  assert.deepEqual(ids([comment("c2", "r0", { createdAt: at(30) }), comment("c1", "r0", { createdAt: at(10) })]), ["c1", "c2"]);
  assert.deepEqual(ids([comment("c1", "r0", { createdAt: at(10) }), comment("c2", "r0", { createdAt: at(30) })]), ["c1", "c2"]);
  assert.deepEqual(commentEntries({ ...doc, comments: undefined }), []);
});

test("a comment entry carries its author, text, quote, status and assignee", () => {
  const doc = small({ rows: ROWS });
  const [anon, named, resolved, open] = commentEntries({
    ...doc,
    comments: [
      comment("c1", "r0", { author: "", body: "<b>Bold</b> words" }),
      comment("c2", "r0", { author: "Ann", quotedText: "quoted", assignee: "Sam", createdAt: at(11) }),
      comment("c3", "r0", { resolved: true, resolvedBy: "Bea", createdAt: at(12) }),
      comment("c4", "r0", { resolved: false, resolvedBy: "Bea", createdAt: at(13) })
    ]
  });
  assert.equal(anon.author, "Anonymous");
  assert.equal(anon.body, "Bold words");
  assert.equal(named.author, "Ann");
  assert.equal(named.quoted, "quoted");
  assert.equal(named.assignee, "Sam");
  assert.equal(anon.quoted, "");
  assert.equal(anon.assignee, "");
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.resolvedBy, "Bea");
  assert.equal(open.resolved, false);
  assert.equal(open.resolvedBy, "");
});

test("a reply carries its author, text and time, in the clock asked for", () => {
  const doc = small({ rows: ROWS });
  const withReplies = {
    ...doc,
    comments: [comment("c1", "r0", { replies: [
      { id: "r1", author: "", body: "<i>Soft</i> reply", createdAt: at(15) },
      { id: "r2", author: "Cy", body: "Second", createdAt: at(16) }
    ] })]
  };
  const [e] = commentEntries(withReplies, { clockMode: "24" });
  assert.deepEqual(e.replies.map((r) => [r.author, r.body]), [["Anonymous", "Soft reply"], ["Cy", "Second"]]);
  const twelve = commentEntries(withReplies, { clockMode: "12" })[0];
  assert.ok(e.replies.every((r) => !/\b[AP]M\b/i.test(r.when)), e.replies.map((r) => r.when).join(" | "));
  assert.ok(twelve.replies.every((r) => /\b[AP]M\b/i.test(r.when)), twelve.replies.map((r) => r.when).join(" | "));
});

test("pieces are only built when asked for", () => {
  const doc = small({ rows: ROWS });
  const withReply = { ...doc, comments: [comment("c1", "r0", { replies: [{ id: "r1", author: "Cy", body: "Hi", createdAt: at(15) }] })] };
  const bare = commentEntries(withReply)[0];
  assert.ok(!("pieces" in bare));
  assert.ok(!("pieces" in bare.replies[0]));
  assert.ok(!("pieces" in commentEntries(withReply, {})[0]));
  assert.ok(!("pieces" in commentEntries(withReply, { pieces: false })[0]));
  const rich = commentEntries(withReply, { pieces: true })[0];
  assert.deepEqual(rich.pieces, [{ text: "Body c1" }]);
  assert.deepEqual(rich.replies[0].pieces, [{ text: "Hi" }]);
});

function piecesOf(body, kind) {
  const doc = small({ rows: ROWS });
  return commentEntries({ ...doc, comments: [comment("c1", "r0", { body, ...kind })] }, { pieces: true })[0].pieces;
}

test("a comment with no picture is one text piece, or none when it says nothing", () => {
  const services = exportServices();
  for (const html of ["plain", "a<br>b", "<p>a</p><p>b</p>", "a&nbsp;b", "<b>x</b> <i>y</i>"]) {
    assert.deepEqual(piecesOf(html), [{ text: services.htmlToPlainText(html) }], html);
  }
  assert.deepEqual(piecesOf(""), []);
  assert.deepEqual(piecesOf(undefined), []);
  assert.deepEqual(piecesOf(null), []);
  assert.deepEqual(piecesOf("<b></b>"), []);
  assert.deepEqual(piecesOf("<p></p>"), []);
});

test("a comment with pictures is its text and pictures, in order", () => {
  assert.deepEqual(piecesOf("Before " + img(SHA) + " after"), [{ text: "Before" }, { image: SHA }, { text: "after" }]);
  assert.deepEqual(piecesOf(img(SHA) + img(SHA2)), [{ image: SHA }, { image: SHA2 }]);
  assert.deepEqual(piecesOf("only text after" + img(SHA) + "tail"), [{ text: "only text after" }, { image: SHA }, { text: "tail" }]);
});

test("line breaks inside a comment with pictures become newlines, however they are written", () => {
  assert.deepEqual(piecesOf("a<br>b<BR>c<br/>d<br />e" + img(SHA)), [{ text: "a\nb\nc\nd\ne" }, { image: SHA }]);
});

test("text around nested markup stays in one piece, and a picture nested in markup is found", () => {
  assert.deepEqual(piecesOf("x <b>bold</b> y" + img(SHA)), [{ text: "x bold y" }, { image: SHA }]);
  assert.deepEqual(piecesOf("<div>a" + img(SHA) + "b</div>"), [{ text: "a" }, { image: SHA }, { text: "b" }]);
  assert.deepEqual(piecesOf("<div><p>deep " + img(SHA) + "</p></div>"), [{ text: "deep" }, { image: SHA }]);
});

test("non-breaking spaces in a comment with pictures read as spaces", () => {
  assert.deepEqual(piecesOf("a&nbsp;b" + img(SHA)), [{ text: "a b" }, { image: SHA }]);
});

test("a picture with a bad address is left out and does not split the text around it", () => {
  assert.deepEqual(piecesOf("before<img data-blob=\"zz\">after" + img(SHA)), [{ text: "beforeafter" }, { image: SHA }]);
  assert.deepEqual(piecesOf("<img data-blob=\"zz\">"), []);
});

test("a conflict on the visual image is its picture alone, and only then", () => {
  const ref = { sha256: SHA, width: 10, height: 10, mime: "image/png" };
  assert.deepEqual(piecesOf("words", { kind: "conflict", field: "visualImage", imageValue: ref }), [{ image: SHA }]);
  assert.deepEqual(piecesOf("words", { kind: "conflict", field: "visualImage", imageValue: { ...ref, sha256: "nope" } }), []);
  assert.deepEqual(piecesOf("words", { kind: "conflict", field: "visualImage", imageValue: null }), []);
  assert.deepEqual(piecesOf("words", { kind: "conflict", field: "audioText", imageValue: ref }), [{ text: "words" }]);
  assert.deepEqual(piecesOf("words", { kind: "anchor", field: "visualImage", imageValue: ref }), [{ text: "words" }]);
});

test("a comment's plain text swaps each picture for [image] and otherwise is its body", () => {
  assert.equal(commentBodyText({ body: "B", pieces: [{ text: "x" }, { text: "y" }] }), "B");
  assert.equal(commentBodyText({ body: "B" }), "B");
  assert.equal(commentBodyText({ body: "B", pieces: [] }), "B");
  assert.equal(commentBodyText({ body: "B", pieces: [{ text: "x" }, { image: SHA }, { text: "y" }] }), "x\n[image]\ny");
  assert.equal(commentBodyText({ body: "B", pieces: [{ image: SHA }, { image: SHA2 }] }), "[image]\n[image]");
});
