import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, STATE_FIELDS, STRATEGY_IDS } from "../../../src/core/document/fields.ts";
import type { StateField } from "../../../src/core/document/fields.ts";
import type { MergeComment, MergeRow } from "../../../src/core/merge/rows.ts";
import { mergeStateFields } from "../../../src/core/merge/states.ts";
import type { MergeDoc } from "../../../src/core/merge/states.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { T } from "../text/cells.ts";
import { EDITOR, FIXED_ISO, countingIds, fakeDecoder, fakePorts, jsonCopy } from "./fakes.ts";

const OLD = "2026-01-01T09:00:00.000Z";
const NEW = "2026-01-02T09:00:00.000Z";
const DOC = "d" + "1".repeat(32), DOC_MINE = "d" + "2".repeat(32);

const ONE = [T("one two")], ONE_M = [T("ONE two")], ONE_T = [T("one TWO")], ONE_MT = [T("ONE TWO")];
const CAT = [T("the cat sat")], DOG = [T("the dog sat")], COW = [T("the cow sat")];
const CELLS = [ONE, ONE_M, ONE_T, ONE_MT, CAT, DOG, COW];

function row(id: string, audio: Run[], extra?: Partial<MergeRow>): MergeRow {
  return Object.assign({ id: id, status: "todo", visualText: "", audioText: toHtml(audio), imageRef: null, updatedAt: OLD, updatedBy: "Base" }, extra || {});
}

function cm(id: string): MergeComment {
  return { id: id, rowId: "r1", field: "audioText", body: "Look", resolved: false, resolvedBy: null, resolvedAt: null, assignee: "",
    kind: "anchor", createdAt: NEW, updatedAt: NEW, replies: [] };
}

function doc(over?: Partial<MergeDoc>): MergeDoc {
  return Object.assign({
    title: "Lighthouse", docId: DOC, rows: [row("r1", ONE)], comments: [], people: [], productionTags: [], brollShots: [],
    wordsPerMinute: 150, rev: 4, lastEditedBy: "Base", lastEditedAt: OLD, personColors: { Sam: "#80BDFB" }, targetSeconds: 300,
    schema: SCHEMA_VERSION
  }, over || {});
}

const shot = { id: "b1", name: "Gulls", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "list" };
const kettle = { id: "t_kettle", cat: "prop", name: "Kettle", owner: "", notes: "", status: "needed" };

function everyField() {
  const base = doc();
  const mine = doc({
    title: "Mine title", docId: DOC_MINE, rows: [row("r1", ONE_M, { updatedBy: "Mine" })], comments: [cm("cM")],
    people: [{ id: "p1", name: "Sam" }], productionTags: [kettle], wordsPerMinute: 180, rev: 9, lastEditedBy: "Mine", lastEditedAt: NEW,
    personColors: { Sam: "#CBA1FA" }, targetSeconds: 420
  });
  const theirs = doc({
    rows: [row("r1", ONE_T, { updatedBy: "Theirs" })], people: [{ id: "p2", name: "Ada" }], brollShots: [shot],
    rev: 6, lastEditedBy: "Theirs", lastEditedAt: NEW, schema: SCHEMA_VERSION + 1
  });
  return { base: base, mine: mine, theirs: theirs };
}

test("core's table names every strategy, so a merge with it exercises each one", () => {
  assert.deepEqual([...new Set(STATE_FIELDS.map((f) => f.merge))].sort(), [...STRATEGY_IDS].sort());
});

test("every strategy merges its field, in the table's order", () => {
  const { base, mine, theirs } = everyField();
  const { decode } = fakeDecoder(CELLS);
  const before = JSON.stringify([base, mine, theirs]);
  const r = mergeStateFields(base, mine, theirs, fakePorts(decode));
  assert.equal(JSON.stringify([base, mine, theirs]), before, "the inputs are left as they were");
  assert.deepEqual(Object.keys(r.merged), STATE_FIELDS.map((f) => f.key));
  assert.deepEqual(r.merged, {
    title: "Mine title",
    docId: DOC_MINE,
    rows: [row("r1", ONE_MT, { updatedAt: FIXED_ISO, updatedBy: EDITOR })],
    comments: [cm("cM")],
    people: [{ id: "p2", name: "Ada" }, { id: "p1", name: "Sam" }],
    productionTags: [kettle],
    brollShots: [shot],
    wordsPerMinute: 180,
    rev: 10,
    lastEditedBy: "Theirs",
    lastEditedAt: NEW,
    personColors: { Sam: "#CBA1FA" },
    targetSeconds: 420,
    schema: SCHEMA_VERSION
  });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.stats, { rowsFromThem: 0, rowsFromMe: 1, rowsAddedByMe: 0, rowsAddedByThem: 0 });
});

test("person colours and a target length that no side has leave no key behind", () => {
  const strip = (d: MergeDoc) => { delete d.personColors; delete d.targetSeconds; return d; };
  const { decode } = fakeDecoder(CELLS);
  const r = mergeStateFields(strip(doc()), strip(doc()), strip(doc()), fakePorts(decode));
  assert.deepEqual(Object.keys(r.merged), STATE_FIELDS.map((f) => f.key).filter((k) => k !== "personColors" && k !== "targetSeconds"));
});

test("with fake ids, clock and editor the merge is deterministic, conflict cards included", () => {
  const base = doc({ rows: [row("r1", CAT)] });
  const mine = doc({ title: "Mine title", rows: [row("r1", DOG)] });
  const theirs = doc({ title: "Their title", rows: [row("r1", COW)] });
  const { decode } = fakeDecoder(CELLS);
  const run = () => {
    const ids = countingIds();
    const r = mergeStateFields(jsonCopy(base), jsonCopy(mine), jsonCopy(theirs), fakePorts(decode, { ids: ids }));
    return { r: r, minted: ids.minted };
  };
  const first = run(), second = run();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.minted, ["c-fake-1", "c-fake-2"]);
  assert.deepEqual(first.r.conflicts, [
    { rowId: "r1", field: "audioText", mine: toHtml(DOG), theirs: toHtml(COW) },
    { rowId: null, field: "title", mine: "Mine title", theirs: "Their title" }
  ]);
  const cards = first.r.merged.comments as MergeComment[];
  assert.deepEqual(cards.map((c) => [c.id, c.conflictField, c.author, c.createdAt, c.updatedAt]), [
    ["c-fake-1", "Audio", EDITOR, FIXED_ISO, FIXED_ISO],
    ["c-fake-2", "Title", EDITOR, FIXED_ISO, FIXED_ISO]
  ]);
  assert.equal(first.r.merged.title, "Their title");
  assert.deepEqual((first.r.merged.rows as MergeRow[])[0], row("r1", COW));
});

test("the ports are the only source of time, ids and the editor's name", () => {
  const { base, mine, theirs } = everyField();
  const { decode, calls } = fakeDecoder(CELLS);
  let clockReads = 0, editorReads = 0;
  const ids = countingIds();
  mergeStateFields(base, mine, theirs, {
    decode: decode, ids: ids,
    clock: { nowIso: function () { clockReads++; return FIXED_ISO; } },
    editor: function () { editorReads++; return EDITOR; }
  });
  assert.deepEqual([clockReads, editorReads, ids.minted.length], [1, 1, 0], "one stamped row, no conflict cards");
  assert.deepEqual(calls, [toHtml(ONE_M), toHtml(ONE_T), toHtml(ONE)], "only the cell both sides changed is read");
});

test("a field whose strategy is unknown makes the merge throw, prototype names included", () => {
  const { decode } = fakeDecoder(CELLS);
  for (const merge of ["no-such-strategy", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const fields = STATE_FIELDS.concat([{ key: "probe", merge: merge, undo: false } as unknown as StateField]);
    assert.throws(() => mergeStateFields(doc(), doc(), doc(), fakePorts(decode, { fields: fields })),
      /^Error: no merge strategy for state field probe$/, merge);
  }
});

test("INV-04: a field added to a copy of the table with a per-key strategy merges with no other edit", () => {
  const added: StateField[] = [
    { key: "probeChanged", def: function () { return "fallback"; }, merge: "changed-side-wins", undo: true },
    { key: "probeEmpty", def: function () { return "fallback"; }, merge: "changed-side-wins", undo: true },
    { key: "probeTheirs", merge: "theirs-wins", undo: false },
    { key: "probeCount", merge: "max-plus-one", undo: false },
    { key: "probeColors", merge: "person-colors", undo: false },
    { key: "probeSchema", merge: "constant", undo: false }
  ];
  const fields = STATE_FIELDS.concat(added);
  const base = doc({ probeChanged: "base", probeTheirs: "base", probeCount: 1, probeColors: { Ada: "#F9B64F" } });
  const mine = doc({ probeChanged: "mine", probeTheirs: "mine", probeCount: 3, probeColors: { Ada: "#F9B64F", Bo: "#73D4AC" } });
  const theirs = doc({ probeChanged: "base", probeTheirs: "theirs", probeCount: 7, probeColors: { Ada: "#64D1D7" }, probeSchema: 99 });
  const { decode } = fakeDecoder(CELLS);
  const r = mergeStateFields(base, mine, theirs, fakePorts(decode, { fields: fields }));
  assert.deepEqual(Object.keys(r.merged), fields.map((f) => f.key));
  assert.deepEqual(added.map((f) => r.merged[f.key]),
    ["mine", "fallback", "theirs", 8, { Ada: "#64D1D7", Bo: "#73D4AC" }, SCHEMA_VERSION]);
  assert.ok(Object.isFrozen(STATE_FIELDS));
  assert.equal(STATE_FIELDS.some((f) => f.key.indexOf("probe") === 0), false);
});

test("a table passed in is used as given, and core's table is the default", () => {
  const { decode } = fakeDecoder(CELLS);
  const fields = STATE_FIELDS.filter((f) => f.key !== "title" && f.key !== "schema");
  assert.deepEqual(Object.keys(mergeStateFields(doc(), doc(), doc(), fakePorts(decode, { fields: fields })).merged), fields.map((f) => f.key));
  assert.deepEqual(Object.keys(mergeStateFields(doc(), doc(), doc(), fakePorts(decode)).merged), STATE_FIELDS.map((f) => f.key));
});

test("productionTags is merged once by id: a rename on my side and a status on theirs both land", () => {
  const base = doc({ productionTags: [kettle] });
  const mine = doc({ productionTags: [Object.assign({}, kettle, { name: "Copper kettle" })] });
  const theirs = doc({ productionTags: [Object.assign({}, kettle, { status: "have" })] });
  const { decode } = fakeDecoder(CELLS);
  const r = mergeStateFields(base, mine, theirs, fakePorts(decode));
  assert.deepEqual(r.merged.productionTags, [Object.assign({}, kettle, { name: "Copper kettle", status: "have" })]);
});

test("a person both sides added keeps my items: their owners move to the id that survived, and no input changes (#283)", () => {
  const base = doc();
  const mine = doc({ people: [{ id: "pMine", name: "Ada" }], productionTags: [Object.assign({}, kettle, { owner: "pMine" })],
    brollShots: [Object.assign({}, shot, { owner: "pMine" })] });
  const theirs = doc({ people: [{ id: "pTheirs", name: "ada" }], brollShots: [Object.assign({}, shot, { id: "b2", owner: "pTheirs" })] });
  const before = JSON.stringify([base, mine, theirs]);
  const { decode } = fakeDecoder(CELLS);
  const r = mergeStateFields(base, mine, theirs, fakePorts(decode));
  assert.equal(JSON.stringify([base, mine, theirs]), before);
  assert.deepEqual(r.merged.people, [{ id: "pTheirs", name: "ada" }]);
  assert.deepEqual((r.merged.productionTags as { owner: string }[]).map((t) => t.owner), ["pTheirs"]);
  assert.deepEqual((r.merged.brollShots as { id: string; owner: string }[]).map((b) => [b.id, b.owner]), [["b2", "pTheirs"], ["b1", "pTheirs"]]);
});

test("an owner I deleted on my side gives way to the owner I handed the items to, and no input changes (#353)", () => {
  const people = [{ id: "pSam", name: "Sam" }, { id: "pAda", name: "Ada" }];
  const owned = (owner: string) => ({ productionTags: [Object.assign({}, kettle, { owner: owner })], brollShots: [Object.assign({}, shot, { owner: owner })] });
  const base = doc(Object.assign({ people: people }, owned("pSam")));
  const theirs = doc(Object.assign({ people: people }, owned("pSam")));
  const mine = doc(Object.assign({ people: [{ id: "pAda", name: "Ada" }] }, owned("pAda")));
  const before = JSON.stringify([base, mine, theirs]);
  const { decode } = fakeDecoder(CELLS);
  const r = mergeStateFields(base, mine, theirs, fakePorts(decode));
  assert.equal(JSON.stringify([base, mine, theirs]), before);
  assert.deepEqual(r.merged.people, [{ id: "pAda", name: "Ada" }]);
  assert.deepEqual((r.merged.productionTags as { owner: string }[]).map((t) => t.owner), ["pAda"]);
  assert.deepEqual((r.merged.brollShots as { owner: string }[]).map((b) => b.owner), ["pAda"]);
});

test("their owner whose id lost to their own same-named person still survives, so mine does not replace it (#353)", () => {
  const owned = (owner: string) => ({ productionTags: [Object.assign({}, kettle, { owner: owner })] });
  const base = doc(owned(""));
  const theirs = doc(Object.assign({ people: [{ id: "pT1", name: "Ada" }, { id: "pT2", name: "ada" }] }, owned("pT2")));
  const mine = doc(Object.assign({ people: [{ id: "pBo", name: "Bo" }] }, owned("pBo")));
  const { decode } = fakeDecoder(CELLS);
  const r = mergeStateFields(base, mine, theirs, fakePorts(decode));
  assert.deepEqual((r.merged.people as { id: string }[]).map((p) => p.id), ["pT1", "pBo"]);
  assert.deepEqual((r.merged.productionTags as { owner: string }[]).map((t) => t.owner), ["pT1"]);
});

test("a table with no people field merges owners as before: no person counts as deleted (#353)", () => {
  const fields = STATE_FIELDS.filter((f) => f.key !== "people");
  const owned = (owner: string) => ({ productionTags: [Object.assign({}, kettle, { owner: owner })] });
  const base = doc(Object.assign({ people: [{ id: "pSam", name: "Sam" }] }, owned("pSam")));
  const mine = doc(Object.assign({ people: [{ id: "pAda", name: "Ada" }] }, owned("pAda")));
  const { decode } = fakeDecoder(CELLS);
  const r = mergeStateFields(base, mine, doc(Object.assign({ people: "junk" }, owned("pSam"))), fakePorts(decode, { fields: fields }));
  assert.deepEqual((r.merged.productionTags as { owner: string }[]).map((t) => t.owner), ["pSam"]);
});
