import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorBrollCell,
  brollAnchorTodo,
  brollCellLines,
  brollEntries,
  brollInCell,
  brollLineKey,
  brollMarkerLines,
  brollPropsInCell,
  brollPropsRenamed,
  brollSeedLocation,
  brollSeedRef,
  brollSortedForList,
  collectBrollFromRows,
  planBrollAnchors
} from "../../../src/core/production/broll.ts";
import type { BrollShot, BrollState } from "../../../src/core/production/broll.ts";
import type { RegistryTag } from "../../../src/core/production/tags.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { B, T, countingIds, jsonCopy, mapDecoder, plainTextOf, readersOver, tag } from "./cells.ts";

const cells = mapDecoder();
const EMPTY = cells.html([]);
const readers = readersOver(cells);

function shot(id: string, name: string, extra?: Partial<BrollShot>): BrollShot {
  return Object.assign({
    id: id, name: name, desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "",
    props: [], origin: "script"
  }, extra || {});
}

const read = (cell: Run[]) => brollInCell(normalizeCell(cell));

test("brollCellLines splits a cell into lines of positioned items, a key counting one position", () => {
  const cell = normalizeCell([B("bs1"), T(" gulls\n\nover"), T(" the pier", { b: true })]);
  const key = cell[0] as Run;
  assert.deepEqual(brollCellLines(cell), [
    { start: 0, end: 7, items: [{ atom: key, text: "B-roll:", marks: {}, pos: 0 }, { text: " gulls", marks: {}, pos: 1 }] },
    { start: 8, end: 8, items: [] },
    { start: 9, end: 22, items: [{ text: "over", marks: {}, pos: 9 }, { text: " the pier", marks: { b: true }, pos: 13 }] }
  ]);
});

test("brollInCell reads a key or a typed marker at a line's start, and the lines under it as the description", () => {
  assert.deepEqual(read([T("  "), B("b1"), T(" gulls\ndesc\n\n")]), [{ id: "b1", name: "gulls", desc: "desc" }]);
  assert.deepEqual(read([T("B-roll:", { b: true }), T(" the gulls\nlow")]), [{ id: "", name: "the gulls", desc: "low" }]);
  assert.deepEqual(read([T("b roll - drone\nB-Roll — boat")]), [{ id: "", name: "drone", desc: "" }, { id: "", name: "boat", desc: "" }]);
  assert.deepEqual(read([T("Intro "), B("b1"), T(" mid-line")]), []);
  assert.deepEqual(read([T("B-roll: " + "n".repeat(205) + "\n" + "d".repeat(2005))]),
    [{ id: "", name: "n".repeat(200), desc: "d".repeat(2000) }]);
});

test("a key carrying a comment still reads as a key, with its id", () => {
  assert.deepEqual(read([B("b1", "B-roll:", { cmt: ["c1"] }), T(" gulls")]), [{ id: "b1", name: "gulls", desc: "" }]);
  assert.deepEqual(read([T("  ", { cmt: ["c1"] }), B("b1", "B-roll:", { cmt: ["c1", "c2"] }), T(" gulls\ndesc", { cmt: ["c1"] })]),
    [{ id: "b1", name: "gulls", desc: "desc" }]);});

test("a commented key opens an item for the props tagged on its lines, and is collected with its id", () => {
  const html = cells.html([B("b1", "B-roll:", { cmt: ["c1"] }), T(" the "), tag("prop", "Red mug", "red mug")]);
  assert.deepEqual(brollPropsInCell(cells.decode(html)), [["Red mug"]]);
  assert.deepEqual(collectBrollFromRows([{ id: "r0", visualText: html, audioText: EMPTY }], readers), [
    { id: "b1", name: "the red mug", desc: "", rowId: "r0", rowIndex: 0, ordinal: 0, autoProps: ["Red mug"] }
  ]);
});

test("brollPropsInCell lists the props tagged on each item's own lines, once each, lined up with brollInCell", () => {
  const cell = normalizeCell([
    T("Open on the "), tag("prop", "Kettle", "kettle"), T("\n"),
    B("b1"), T(" the "), tag("prop", "Red mug", "red mug"), T(" on the sill\nwith a "), tag("prop", "Tea towel", "towel"),
    T(" and a "), tag("location", "Kitchen", "kitchen"), T(" and the "), tag("prop", " red MUG", "mug"), T("\n"),
    T("B-roll:", { b: true }), T(" steam, "), tag("prop", "P".repeat(85), "kettle"), T("\n"),
    B("b3"), T(" nothing needed")
  ]);
  assert.deepEqual(brollInCell(cell).map((b) => b.name), ["the red mug on the sill", "steam, kettle", "nothing needed"]);
  assert.deepEqual(brollPropsInCell(cell), [["Red mug", "Tea towel"], ["P".repeat(80)], []]);
  assert.deepEqual(brollPropsInCell(normalizeCell([T("no markers "), tag("prop", "Kettle")])), []);
});

test("collectBrollFromRows numbers each row's items and keeps an id only the first time it appears", () => {
  const rows = [
    { id: "r1", visualText: cells.html([B("bsA"), T(" one\n"), B("bsA"), T(" two")]), audioText: EMPTY },
    { id: "r2", visualText: cells.html([B("bsA"), T(" three "), tag("prop", "Kite")]), audioText: EMPTY }
  ];
  assert.deepEqual(collectBrollFromRows(rows, readers), [
    { id: "bsA", name: "one", desc: "", rowId: "r1", rowIndex: 0, ordinal: 0, autoProps: [] },
    { id: "", name: "two", desc: "", rowId: "r1", rowIndex: 0, ordinal: 1, autoProps: [] },
    { id: "", name: "three Kite", desc: "", rowId: "r2", rowIndex: 1, ordinal: 0, autoProps: ["Kite"] }
  ]);
});

const PIER = cells.html([T("Waves on the "), tag("location", "Pier", "pier"), T(".")]);
const QUAY = cells.html([T("Quiet "), tag("location", "Quay", "quay"), T(" now.")]);

function crafted(): BrollState & { brollShots: BrollShot[] } {
  return {
    rows: [
      { id: "r1", audioText: PIER, visualText: cells.html([B("bs_keep"), T(" the gulls\nover the pier\nB-roll: drone sweep\nlow and slow")]) },
      { id: "r2", audioText: EMPTY, visualText: cells.html([B("bs_keep"), T(" the gulls again\nB-roll: The Harbour")]) },
      { id: "r3", audioText: QUAY, visualText: cells.html([T("B-roll: new wording\n"), B("bs_held"), T(" held line")]) }
    ],
    productionTags: [{ id: "t_kettle", cat: "prop", name: "Kettle", status: "have" }],
    brollShots: [
      shot("bs_keep", "the gulls", { status: "shot", notes: "got it" }),
      shot("bs_harbour", "the harbour"),
      shot("bs_held", "new wording"),
      shot("bs_orphan", "cut from the script"),
      shot("bs_list", "pickup from the list", { origin: "list", props: [{ id: "t_kettle", name: "Kettle" }] })
    ]
  };
}

test("the b-roll read model matches each line to a shot and plans the shots to create and rename, writing nothing", () => {
  const state = crafted();
  const before = JSON.stringify(state);
  const ids = countingIds();
  const res = brollEntries(state, readers, ids, plainTextOf, false);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(ids.minted, ["bsmint0001", "bsmint0002", "bsmint0003"]);
  assert.deepEqual(res.entries.map((e) => [e.id, e.name, e.desc, e.rowId, e.rowIndex, e.ordinal, e.markerless, e.orphaned, e.status]), [
    ["bs_keep", "the gulls", "over the pier", "r1", 0, 0, false, false, "shot"],
    ["bsmint0001", "drone sweep", "low and slow", "r1", 0, 1, true, false, "unshot"],
    ["bsmint0002", "the gulls again", "", "r2", 1, 0, true, false, "unshot"],
    ["bs_harbour", "The Harbour", "", "r2", 1, 1, true, false, "unshot"],
    ["bsmint0003", "new wording", "", "r3", 2, 0, true, false, "unshot"],
    ["bs_held", "held line", "", "r3", 2, 1, false, false, "unshot"],
    ["bs_orphan", "cut from the script", "", null, -1, -1, false, true, "unshot"],
    ["bs_list", "pickup from the list", "", null, -1, -1, false, false, "unshot"]
  ]);
  assert.equal(res.entries[0]?.rec, state.brollShots[0], "a matched line's entry holds the stored shot");
  assert.deepEqual(res.plan.rename, [
    { at: 0, name: "the gulls", desc: "over the pier" },
    { at: 1, name: "The Harbour", desc: "" },
    { at: 2, name: "held line", desc: "" }
  ]);
  const created = (id: string, name: string, desc: string, audioRef: string, location: string) => ({
    id: id, name: name, desc: desc, status: "unshot", reshoot: false, notes: "", owner: "", audioRef: audioRef, location: location,
    props: [], origin: "script"
  });
  assert.deepEqual(res.plan.create, [
    { entry: 1, shot: created("bsmint0001", "drone sweep", "low and slow", "Waves on the pier.", "Pier") },
    { entry: 2, shot: created("bsmint0002", "the gulls again", "", "", "") },
    { entry: 4, shot: created("bsmint0003", "new wording", "", "Quiet quay now.", "Quay") }
  ]);
  assert.deepEqual(JSON.stringify(res.entries[1]?.rec), JSON.stringify({
    status: "unshot", props: [], origin: "script", id: "bsmint0001", name: "drone sweep", desc: "low and slow",
    audioRef: "Waves on the pier.", location: "Pier"
  }), "an unmatched line's entry shows the shot it would seed, in the read model's own shape");
  assert.notEqual(res.entries[1]?.rec, res.plan.create[0]?.shot);
});

test("a repair draws one more id after each created shot's seeds and stores none of them; a read draws only for lines with no id", () => {
  const log: string[] = [];
  const ids = countingIds();
  const logged = { id: (p: string) => { const id = ids.id(p); log.push(id); return id; }, docId: ids.docId };
  const seeded = (html: string | null | undefined): string => { log.push("seed"); return plainTextOf(html); };
  const state: BrollState = {
    rows: [
      { id: "r1", audioText: PIER, visualText: cells.html([T("B-roll: Steam\nB-roll: Hands")]) },
      { id: "r2", audioText: EMPTY, visualText: cells.html([B("bs_new"), T(" Cup")]) }
    ],
    brollShots: [],
    productionTags: []
  };
  const read = brollEntries(state, readers, logged, seeded, false);
  assert.deepEqual(log, ["bsmint0001", "seed", "bsmint0002", "seed", "seed"]);
  assert.deepEqual(read.plan.create.map((c) => c.shot.id), ["bsmint0001", "bsmint0002", "bs_new"]);
  log.length = 0;
  const repair = brollEntries(state, readers, logged, seeded, true);
  assert.deepEqual(log, ["bsmint0003", "seed", "bsmint0004", "bsmint0005", "seed", "bsmint0006", "seed", "bsmint0007"]);
  assert.deepEqual(repair.plan.create.map((c) => c.shot.id), ["bsmint0003", "bsmint0005", "bs_new"]);
  assert.deepEqual(repair.entries.map((e) => e.id), ["bsmint0003", "bsmint0005", "bs_new"]);
});

test("a line never takes a shot a keyed line further down holds, and a typed marker takes a shot by its name", () => {
  const state: BrollState = {
    rows: [
      { id: "r0", visualText: cells.html([T("B-roll: the gulls\nB-roll: Drone Sweep")]), audioText: EMPTY },
      { id: "r1", visualText: cells.html([B("bsA"), T(" the gulls")]), audioText: EMPTY }
    ],
    brollShots: [shot("bsA", "the gulls", { status: "shot" }), shot("bsD", "drone sweep")],
    productionTags: []
  };
  const ids = countingIds();
  const res = brollEntries(state, readers, ids, plainTextOf, false);
  assert.deepEqual(res.entries.map((e) => e.id), ["bsmint0001", "bsD", "bsA"]);
  assert.deepEqual(res.plan.rename, [{ at: 1, name: "Drone Sweep", desc: "" }]);
  const plan = planBrollAnchors(state, readers, countingIds("anchor"));
  assert.deepEqual(Object.entries(plan), [[brollLineKey("r0", 0), "bsanchor0001"], [brollLineKey("r0", 1), "bsD"]]);
});

test("anchoring hands a shot to one typed line only: a second line of the same name gets a fresh id", () => {
  const state: BrollState = {
    rows: [
      { id: "r0", visualText: cells.html([T("B-roll: the gulls\nB-roll: The Gulls")]), audioText: EMPTY },
      { id: "r1", visualText: cells.html([T("B-roll: the gulls")]), audioText: EMPTY }
    ],
    brollShots: [shot("bsA", "the gulls")],
    productionTags: []
  };
  const plan = planBrollAnchors(state, readers, countingIds());
  assert.deepEqual(Object.entries(plan), [
    [brollLineKey("r0", 0), "bsA"], [brollLineKey("r0", 1), "bsmint0001"], [brollLineKey("r1", 0), "bsmint0002"]
  ]);
});

test("INV-54: anchoring gives a key repeating an earlier line's id an id of its own, and leaves the first alone", () => {
  const first = cells.html([B("bsA"), T(" the gulls")]);
  const repeat = cells.html([T("intro\n"), B("bsA"), T(" the gulls")]);
  const state: BrollState = {
    rows: [{ id: "r0", visualText: first, audioText: EMPTY }, { id: "r1", visualText: repeat, audioText: EMPTY }],
    brollShots: [shot("bsA", "the gulls", { status: "shot" })],
    productionTags: []
  };
  const before = JSON.stringify(state);
  const ids = countingIds();
  const plan = planBrollAnchors(state, readers, ids);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(Object.entries(plan), [[brollLineKey("r1", 0), "bsmint0001"]]);
  assert.deepEqual(brollAnchorTodo(cells.decode(first), "r0", plan), []);
  const todo = brollAnchorTodo(cells.decode(repeat), "r1", plan);
  assert.deepEqual(todo.map((t) => [t.found.index, t.id, !!t.found.marker.key]), [[1, "bsmint0001", true]]);
  assert.deepEqual(anchorBrollCell(cells.decode(repeat), todo), {
    cell: normalizeCell([T("intro\n"), B("bsmint0001"), T(" the gulls")]),
    anchored: 1
  });
});

test("anchoring turns a typed marker into a key and a space, and leaves a commented key and its comment alone", () => {
  const typed = cells.html([T("B-roll: the gulls\nlow\nb roll - drone")]);
  const commented = cells.html([B("b1", "B-roll:", { cmt: ["c1"] }), T(" gulls", { cmt: ["c1"] })]);
  const state: BrollState = {
    rows: [{ id: "r0", visualText: typed, audioText: EMPTY }, { id: "r1", visualText: commented, audioText: EMPTY }],
    brollShots: [],
    productionTags: []
  };
  const plan = planBrollAnchors(state, readers, countingIds());
  assert.deepEqual(Object.values(plan), ["bsmint0001", "bsmint0002"]);
  const typedCell = cells.decode(typed);
  assert.deepEqual(anchorBrollCell(typedCell, brollAnchorTodo(typedCell, "r0", plan)), {
    cell: normalizeCell([B("bsmint0001"), T(" the gulls\nlow\n"), B("bsmint0002", "b roll-"), T(" drone")]),
    anchored: 2
  });
  const commentedCell = cells.decode(commented);
  const todo = brollAnchorTodo(commentedCell, "r1", plan);
  assert.deepEqual(todo, []);
  assert.deepEqual(anchorBrollCell(commentedCell, todo), { cell: commentedCell, anchored: 0 });
  assert.deepEqual(brollMarkerLines(typedCell).map((m) => m.index), [0, 2]);
});

test("anchoring a commented key that repeats an earlier id gives it a fresh id and keeps its comment", () => {
  const first = cells.html([B("bsA"), T(" the gulls")]);
  const repeat = cells.html([T("intro\n"), B("bsA", "B-roll:", { cmt: ["c1"] }), T(" the gulls", { cmt: ["c1"] })]);
  const state: BrollState = {
    rows: [{ id: "r0", visualText: first, audioText: EMPTY }, { id: "r1", visualText: repeat, audioText: EMPTY }],
    brollShots: [shot("bsA", "the gulls", { status: "shot" })],
    productionTags: []
  };
  const plan = planBrollAnchors(state, readers, countingIds());
  assert.deepEqual(Object.entries(plan), [[brollLineKey("r1", 0), "bsmint0001"]]);
  const cell = cells.decode(repeat);
  assert.deepEqual(anchorBrollCell(cell, brollAnchorTodo(cell, "r1", plan)), {
    cell: normalizeCell([T("intro\n"), B("bsmint0001", "B-roll:", { cmt: ["c1"] }), T(" the gulls", { cmt: ["c1"] })]),
    anchored: 1
  });
});

test("INV-56: a shot shows props tagged on its lines and hand-added ones by registry id; a created shot stores none", () => {
  const registry: RegistryTag[] = [
    { id: "t_mug", cat: "prop", name: "Red mug", status: "have" },
    { id: "t_kettle", cat: "prop", name: "Kettle" }
  ];
  const state: BrollState = {
    rows: [
      { id: "r0", visualText: cells.html([B("b1"), T(" the "), tag("prop", "Red mug", "red mug"), T(" on the sill")]), audioText: EMPTY },
      { id: "r1", visualText: cells.html([B("b2"), T(" a "), tag("prop", "Lamp", "lamp")]), audioText: EMPTY }
    ],
    brollShots: [shot("b1", "the red mug on the sill", {
      props: [{ id: "t_mug", name: "Red mug" }, { id: "", name: "Boat hook" }, { id: "t_kettle", name: "old kettle name" }, null]
    })],
    productionTags: registry
  };
  const res = brollEntries(state, readers, countingIds(), plainTextOf, false);
  assert.deepEqual(res.entries[0]?.props, [
    { key: "t:t_mug", id: "t_mug", name: "Red mug", status: "have", auto: true, hand: true, tracked: true, ref: "t_mug" },
    { key: "n:boat hook", id: "", name: "Boat hook", status: "", auto: false, hand: true, tracked: false, ref: "n:boat hook" },
    { key: "t:t_kettle", id: "t_kettle", name: "Kettle", status: "needed", auto: false, hand: true, tracked: true, ref: "t_kettle" }
  ]);
  assert.deepEqual(res.entries[1]?.props, [
    { key: "n:lamp", id: "", name: "Lamp", status: "", auto: true, hand: false, tracked: false, ref: "" }
  ]);
  assert.deepEqual(res.plan.create.map((c) => c.shot.props), [[]]);
});

test("INV-56: renaming a prop is planned per shot, by id and by name for a prop with none, and normalised", () => {
  const state = {
    brollShots: [
      shot("s1", "one", { props: [{ id: "t_k", name: "Kettle" }, { id: "", name: "kettle" }, { id: "", name: "Mug" }] }),
      shot("s2", "two"),
      { id: "s3", name: "three" },
      shot("s4", "four", { props: [null, { id: "", name: "old" }] })
    ],
    productionTags: [{ id: "t_k", cat: "prop", name: "Copper kettle" }, { id: "t_m", cat: "prop", name: "Mug" }]
  };
  const before = JSON.stringify(state);
  assert.deepEqual(brollPropsRenamed(state, "t_k", "kettle", "t_k", "Copper kettle"), [
    { at: 0, props: [{ id: "t_k", name: "Copper kettle" }, { id: "t_m", name: "Mug" }] }
  ]);
  assert.deepEqual(brollPropsRenamed(state, "t_k", "", "t_m", "Mug"), [
    { at: 0, props: [{ id: "t_m", name: "Mug" }, { id: "", name: "kettle" }] }
  ], "folding onto another entry re-points the shot at it");
  assert.equal(JSON.stringify(state), before, "the plan leaves the shots to the caller");
  assert.deepEqual(brollPropsRenamed(state, "t_k", "", "", "Copper pot"), [
    { at: 0, props: [{ id: "t_k", name: "Copper kettle" }, { id: "", name: "kettle" }, { id: "t_m", name: "Mug" }] }
  ], "with no new id a renamed prop keeps its own, and the registry names it");
  assert.deepEqual(brollPropsRenamed(state, null, "old", null, "New"), [
    { at: 3, props: [{ id: "", name: "New" }] }
  ], "with no ids at all a prop is renamed by name and stays untracked");
  assert.deepEqual(brollPropsRenamed(null, "t_k", "kettle", "t_k", "x"), []);
  assert.deepEqual(brollPropsRenamed({ productionTags: [] }, "t_k", "kettle", "t_k", "x"), []);
});

test("the seeds read the scene's audio as plain text and its first location tag, cut to size", () => {
  const row = {
    id: "r1",
    visualText: cells.html([tag("location", "L".repeat(85), "there")]),
    audioText: cells.html([T("w".repeat(2005))])
  };
  assert.equal(brollSeedRef(row, plainTextOf), "w".repeat(2000));
  assert.equal(brollSeedLocation(row, readers), "L".repeat(80));
  assert.equal(brollSeedRef(null, plainTextOf), "");
  assert.equal(brollSeedLocation(undefined, readers), "");
});

test("the shot list sorts by scene and line, then shots outside the script by name", () => {
  const list = [
    { rowIndex: -1, ordinal: -1, name: "b" }, { rowIndex: 1, ordinal: 0, name: "z" }, { rowIndex: 0, ordinal: 1, name: "y" },
    { rowIndex: -1, ordinal: -1, name: "a" }, { rowIndex: 0, ordinal: 0, name: "x" }, { rowIndex: -1, ordinal: -1, name: undefined }
  ];
  const copy = jsonCopy(list);
  assert.deepEqual(brollSortedForList(list).map((e) => e.name), ["x", "y", "z", undefined, "a", "b"]);
  assert.deepEqual(jsonCopy(list), copy, "the input keeps its order");
});
