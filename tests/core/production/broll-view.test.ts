import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brollGroups,
  filterCounts,
  matchesFilter,
  oneOf,
  pageSummaryText,
  personIn,
  beatLabel,
  shotRecordForFile,
  startOf
} from "../../../src/core/production/broll-view.ts";

type Entry = Parameters<typeof matchesFilter>[0];
type Rows = Parameters<typeof brollGroups>[2]["rows"];

function entry(id: string, extra?: Partial<Entry>): Entry {
  const result = Object.assign({
    id: id, name: id, desc: "", rowId: "r1", rowIndex: 0, ordinal: 0, status: "unshot", reshoot: false,
    notes: "", owner: "", audioRef: "", location: "", props: []
  }, extra || {}) as Entry;
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: "r" + (i + 1) }));
  const n = deriveDocumentNumbering({ rows });
  const idAt = rows[result.rowIndex]?.id ?? null;
  return { ...result, beatNumber: n.beats[idAt ?? ""]?.full ?? "", shotNumber: n.shot(idAt, result.ordinal)?.full ?? "" };
}

const PEOPLE = [{ id: "p1", name: "Sam" }, { id: "p2", name: "Alex" }];

test("oneOf and personIn find an item by id and fall back otherwise", () => {
  assert.equal(oneOf([{ id: "a" }, { id: "b" }], "b", "x"), "b");
  assert.equal(oneOf([{ id: "a" }], "z", "x"), "x");
  assert.equal(personIn(PEOPLE, "p2"), PEOPLE[1]);
  assert.equal(personIn(PEOPLE, "p9"), null);
  assert.equal(personIn(PEOPLE, ""), null);
});

test("each filter keeps the shots it names: to shoot, flagged, shot, or all", () => {
  const todo = entry("a"), done = entry("b", { status: "shot" }), flagged = entry("c", { reshoot: true });
  const pick = (filter: string) => [todo, done, flagged].filter((e) => matchesFilter(e, filter)).map((e) => e.id);
  assert.deepEqual(pick("unshot"), ["a", "c"]);
  assert.deepEqual(pick("shot"), ["b"]);
  assert.deepEqual(pick("flagged"), ["c"]);
  assert.deepEqual(pick("all"), ["a", "b", "c"]);
  assert.deepEqual(pick("anything else"), ["a", "b", "c"]);
});

test("the counts and the page summary say how many are shot and how many flagged", () => {
  const shots = [entry("a"), entry("b", { status: "shot", reshoot: true }), entry("c", { status: "shot" }), entry("d", { reshoot: true })];
  assert.deepEqual(filterCounts(shots), { all: 4, unshot: 2, shot: 2, flagged: 2 });
  assert.equal(pageSummaryText(shots), "2 of 4 filmed · 2 flagged");
  assert.equal(pageSummaryText([entry("a", { status: "shot" })]), "1 of 1 filmed");
  assert.equal(pageSummaryText([]), "0 of 0 filmed");
});

test("a scene uses the shared unpadded number, a start is a timecode, and a shot with no scene has neither", () => {
  assert.equal(beatLabel(entry("a", { rowIndex: 0 })), "A.1");
  assert.equal(beatLabel(entry("a", { rowIndex: 11 })), "A.12");
  assert.equal(beatLabel(entry("a", { rowIndex: -1 })), "");
  const starts = { r1: 0, r2: 65 };
  assert.equal(startOf(entry("a", { rowId: "r1" }), starts), "00:00", "a scene that starts at zero still has a start");
  assert.equal(startOf(entry("a", { rowId: "r2" }), starts), "01:05");
  assert.equal(startOf(entry("a", { rowId: "r3" }), starts), "");
  assert.equal(startOf(entry("a", { rowId: null }), starts), "");
});

test("a shot's file record names its scene, owner, status and props, with defaults for what is blank", () => {
  const full = entry("a", {
    name: "Gulls", status: "shot", reshoot: true, location: "Pier", owner: "p1", audioRef: "cut 3", notes: "wide", desc: "over the pier", rowIndex: 2,
    props: [{ key: "t:k", id: "t_k", name: "Kettle", status: "have" }, { key: "n:x", id: "", name: "Boat hook", status: "" }]
  });
  assert.deepEqual(shotRecordForFile(full, PEOPLE), {
    beat: "A.3", name: "A.3.1 Gulls", status: "Filmed", shot: true, flagged: true, location: "Pier",
    props: ["Kettle", "Boat hook"], propsWithStatus: ["Kettle (have it)", "Boat hook"],
    cuts: "cut 3", owner: "Sam", note: "wide", desc: "over the pier"
  });
  assert.deepEqual(shotRecordForFile(entry("b", { name: undefined, rowId: null, rowIndex: -1 }), PEOPLE), {
    beat: "", name: "Untitled shot", status: "To film", shot: false, flagged: false, location: "",
    props: [], propsWithStatus: [], cuts: "", owner: "", note: "", desc: ""
  });
});

test("shots group by scene in script order with the added ones last, or flat in that order", () => {
  const rows = [{ id: "r1" }, { id: "r2" }] as unknown as Rows;
  const shots = [
    entry("added", { rowId: null, rowIndex: -1, name: "Added" }),
    entry("two", { rowId: "r2", rowIndex: 1 }),
    entry("one-b", { rowId: "r1", rowIndex: 0, ordinal: 1 }),
    entry("one-a", { rowId: "r1", rowIndex: 0, ordinal: 0 })
  ];
  const groups = brollGroups(shots, "scene", { rows: rows, people: PEOPLE });
  assert.deepEqual(groups.map((g) => [g.key, g.kind, g.label, g.none, g.items.map((e) => e.id)]), [
    ["r:r1", "scene", "Beat A.1", false, ["one-a", "one-b"]],
    ["r:r2", "scene", "Beat A.2", false, ["two"]],
    ["added", "added", "Added here", false, ["added"]]
  ]);
  assert.equal(groups[0]?.row?.id, "r1");
  assert.equal(groups[2]?.row, null);
  const flat = brollGroups(shots, "flat", { rows: rows, people: PEOPLE });
  assert.deepEqual(flat.map((g) => [g.key, g.kind, g.label, g.items.map((e) => e.id)]), [["all", "flat", "", ["one-a", "one-b", "two", "added"]]]);
});

test("shots group by location, or by person, in name order with the ungrouped last", () => {
  const shots = [
    entry("a", { location: "Pier", owner: "p2" }),
    entry("b", { location: "", owner: "" }),
    entry("c", { location: "  pier ", owner: "p1" }),
    entry("d", { location: "Barn", owner: "p9" })
  ];
  const byLocation = brollGroups(shots, "location", { rows: [], people: PEOPLE });
  assert.deepEqual(byLocation.map((g) => [g.key, g.label, g.none, g.items.map((e) => e.id)]), [
    ["l:barn", "Barn", false, ["d"]],
    ["l:pier", "Pier", false, ["a", "c"]],
    ["none", "No location", true, ["b"]]
  ]);
  const byPerson = brollGroups(shots, "person", { rows: [], people: PEOPLE });
  assert.deepEqual(byPerson.map((g) => [g.key, g.label, g.none, g.items.map((e) => e.id)]), [
    ["p:p2", "Alex", false, ["a"]],
    ["p:p1", "Sam", false, ["c"]],
    ["none", "Unassigned", true, ["b", "d"]]
  ]);
});
