import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOwnerSync, planOwnerSync, snapshotOwners } from "../../../src/core/production/owners.ts";
import type { OwnerSnapshot } from "../../../src/core/production/owners.ts";
import type { LiveRecords, Person } from "../../../src/core/production/records.ts";
import type { Run, WhoRun } from "../../../src/core/text/runs.ts";
import { T, countingIds, mapDecoder, readersOver, tag } from "./cells.ts";

const cells = mapDecoder();
const readers = readersOver(cells);

function who(name: string): WhoRun {
  return { atom: "who", name: name, text: "@" + name, marks: {} };
}

type Row = { id: string; visualText: string; audioText: string };

type Doc = LiveRecords & { docId: string; rows: Row[]; people: Person[] };

function row(id: string, visual: Run[]): Row {
  return { id: id, visualText: cells.html(visual), audioText: "" };
}

function doc(rows: Row[], people: Person[] = [{ id: "pSam", name: "Sam" }]): Doc {
  return {
    docId: "d1", rows: rows, people: people, brollShots: [],
    productionTags: [
      { id: "tg1", cat: "prop", name: "Kettle", owner: "", notes: "", status: "" },
      { id: "tg2", cat: "prop", name: "Mug", owner: "", notes: "", status: "" }
    ]
  } as Doc;
}

function owner(d: Doc, name: string): string {
  const entry = d.productionTags.find((t) => t && t.name === name);
  return entry ? entry.owner ?? "" : "missing";
}

function step(was: OwnerSnapshot, d: Doc, ids = countingIds()): OwnerSnapshot {
  const plan = planOwnerSync(was, d, readers);
  applyOwnerSync(plan, d, ids);
  plan.commit();
  return plan.snapshot;
}

const KETTLE = tag("prop", "Kettle", "kettle");
const MUG = tag("prop", "Mug", "mug");

test("owner sync: a chip added to a sentence makes its person the owner of every tag in that sentence", () => {
  const d = doc([row("r1", [T("Fill the "), KETTLE, T(" and the "), MUG, T(".")])]);
  const was = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [T("Fill the "), KETTLE, T(" and the "), MUG, T(" "), who("Sam"), T(".")]);
  const plan = planOwnerSync(was, d, readers);
  assert.deepEqual(plan.fields, ["productionTags"]);
  applyOwnerSync(plan, d, countingIds());
  assert.equal(owner(d, "Kettle"), "pSam");
  assert.equal(owner(d, "Mug"), "pSam");
});

test("owner sync: tags in another sentence, on another line or in another scene keep their owner", () => {
  const d = doc([row("r1", [MUG, T(" first. "), KETTLE, T(" second.\n"), MUG]), row("r2", [MUG])]);
  const was = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [MUG, T(" first. "), KETTLE, T(" second "), who("Sam"), T(".\n"), MUG]);
  step(was, d);
  assert.equal(owner(d, "Kettle"), "pSam");
  assert.equal(owner(d, "Mug"), "");
});

test("owner sync: deleting the chip clears the owner it set", () => {
  const d = doc([row("r1", [KETTLE, T(" ")])]);
  let snap = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [KETTLE, T(" "), who("Sam")]);
  snap = step(snap, d);
  assert.equal(owner(d, "Kettle"), "pSam");
  d.rows[0] = row("r1", [KETTLE, T(" ")]);
  step(snap, d);
  assert.equal(owner(d, "Kettle"), "");
});

test("owner sync: deleting the chip keeps an owner the Production panel changed since", () => {
  const d = doc([row("r1", [KETTLE, T(" ")])], [{ id: "pSam", name: "Sam" }, { id: "pAnn", name: "Ann" }]);
  let snap = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [KETTLE, T(" "), who("Sam")]);
  snap = step(snap, d);
  (d.productionTags[0] as { owner: string }).owner = "pAnn";
  assert.deepEqual(planOwnerSync(snap, d, readers).fields, [], "an owner change in the panel alone plans nothing");
  d.rows[0] = row("r1", [KETTLE, T(" ")]);
  step(snap, d);
  assert.equal(owner(d, "Kettle"), "pAnn");
});

test("owner sync: an edit that keeps the pair leaves a panel change alone", () => {
  const d = doc([row("r1", [KETTLE, T(" "), who("Sam")])], [{ id: "pSam", name: "Sam" }, { id: "pAnn", name: "Ann" }]);
  const snap = snapshotOwners(d, readers);
  (d.productionTags[0] as { owner: string }).owner = "pAnn";
  d.rows[0] = row("r1", [KETTLE, T(" for "), who("Sam"), T(" today")]);
  const plan = planOwnerSync(snap, d, readers);
  assert.deepEqual(plan.fields, []);
  assert.equal(owner(d, "Kettle"), "pAnn");
});

test("owner sync: changing the chip to another person moves the tag to that person", () => {
  const d = doc([row("r1", [KETTLE, T(" "), who("Sam")])], [{ id: "pSam", name: "Sam" }, { id: "pAnn", name: "Ann" }]);
  (d.productionTags[0] as { owner: string }).owner = "pSam";
  const snap = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [KETTLE, T(" "), who("Ann")]);
  step(snap, d);
  assert.equal(owner(d, "Kettle"), "pAnn");
});

test("owner sync: a name not in People yet is added, once, and owns the tag", () => {
  const d = doc([row("r1", [KETTLE]), row("r2", [T("x")])], []);
  const snap = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [KETTLE, T(" "), who("Robin")]);
  d.rows[1] = row("r2", [T("x "), who("robin"), T(" and "), who("Lee")]);
  const plan = planOwnerSync(snap, d, readers);
  assert.deepEqual(plan.people, ["Robin", "Lee"]);
  assert.deepEqual(plan.fields, ["people", "productionTags"]);
  const ids = countingIds();
  applyOwnerSync(plan, d, ids);
  assert.deepEqual(d.people.map((p) => p.name), ["Robin", "Lee"]);
  assert.equal(owner(d, "Kettle"), d.people[0]?.id);
});

test("owner sync: moving a chip and its tag to another scene in one edit changes nothing", () => {
  const d = doc([row("r1", [KETTLE, T(" "), who("Sam")]), row("r2", [T("")])]);
  (d.productionTags[0] as { owner: string }).owner = "pSam";
  const snap = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [T("")]);
  d.rows[1] = row("r2", [KETTLE, T(" "), who("Sam")]);
  assert.deepEqual(planOwnerSync(snap, d, readers).fields, []);
});

test("owner sync: the pair stays while another sentence still holds it", () => {
  const d = doc([row("r1", [KETTLE, T(" "), who("Sam")]), row("r2", [KETTLE, T(" "), who("Sam")])]);
  (d.productionTags[0] as { owner: string }).owner = "pSam";
  const snap = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [KETTLE]);
  step(snap, d);
  assert.equal(owner(d, "Kettle"), "pSam");
});

test("owner sync: deleting the scene that held the pair clears the owner", () => {
  const d = doc([row("r1", [KETTLE, T(" "), who("Sam")]), row("r2", [T("x")])]);
  (d.productionTags[0] as { owner: string }).owner = "pSam";
  const snap = snapshotOwners(d, readers);
  d.rows.splice(0, 1);
  step(snap, d);
  assert.equal(owner(d, "Kettle"), "");
});

test("owner sync: with two names in one sentence the last one owns the tag", () => {
  const d = doc([row("r1", [KETTLE])], [{ id: "pSam", name: "Sam" }, { id: "pAnn", name: "Ann" }]);
  const snap = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [who("Sam"), T(" and "), who("Ann"), T(" "), KETTLE]);
  step(snap, d);
  assert.equal(owner(d, "Kettle"), "pAnn");
});

test("owner sync: a different document takes a fresh snapshot and plans nothing", () => {
  const d = doc([row("r1", [KETTLE])]);
  const snap = snapshotOwners(d, readers);
  const other = doc([row("r1", [KETTLE, T(" "), who("Sam")])]);
  other.docId = "d2";
  const plan = planOwnerSync(snap, other, readers);
  assert.deepEqual(plan.fields, []);
  assert.deepEqual(planOwnerSync(plan.snapshot, other, readers).fields, []);
  assert.deepEqual(planOwnerSync(null, other, readers).fields, []);
});

test("owner sync: an unchanged document reuses the snapshot's cells and decodes nothing", () => {
  const d = doc([row("r1", [KETTLE, T(" "), who("Sam")]), row("r2", [MUG])]);
  const snap = snapshotOwners(d, readers);
  cells.decoded.length = 0;
  const plan = planOwnerSync(snap, d, readers);
  assert.deepEqual(cells.decoded, []);
  assert.equal(plan.snapshot.pairs, snap.pairs);
});

test("owner sync: a chip pasted into Audio is kept without assigning or adding people", () => {
  const d = doc([row("r1", [KETTLE])]);
  const snap = snapshotOwners(d, readers);
  const audio = cells.html([KETTLE, T(" "), who("Robin")]);
  const first = d.rows[0];
  assert.ok(first);
  first.audioText = audio;
  const plan = planOwnerSync(snap, d, readers);
  applyOwnerSync(plan, d, countingIds());
  assert.deepEqual(plan.fields, []);
  assert.equal(owner(d, "Kettle"), "");
  assert.deepEqual(d.people.map((p) => p.name), ["Sam"]);
  assert.equal(first.audioText, audio);
});

test("owner sync: a new occurrence assigns again even when another sentence already has the pair", () => {
  for (const sameRow of [false, true]) {
    const first = [KETTLE, T(" "), who("Sam"), T(". ")];
    const d = doc(sameRow ? [row("r1", [...first, KETTLE])] : [row("r1", first), row("r2", [KETTLE])],
      [{ id: "pSam", name: "Sam" }, { id: "pAnn", name: "Ann" }]);
    const snap = snapshotOwners(d, readers);
    const kettle = d.productionTags[0];
    assert.ok(kettle);
    kettle.owner = "pAnn";
    d.rows[sameRow ? 0 : 1] = row(sameRow ? "r1" : "r2", [...(sameRow ? first : []), KETTLE, T(" "), who("Sam")]);
    step(snap, d);
    assert.equal(owner(d, "Kettle"), "pSam");
  }
});

test("owner sync: inserting an earlier name cannot override the sentence's last name", () => {
  const d = doc([row("r1", [KETTLE, T(" "), who("Ann")])], [{ id: "pSam", name: "Sam" }, { id: "pAnn", name: "Ann" }]);
  const kettle = d.productionTags[0];
  assert.ok(kettle);
  kettle.owner = "pAnn";
  let snap = snapshotOwners(d, readers);
  d.rows[0] = row("r1", [KETTLE, T(" "), who("Sam"), T(" "), who("Ann")]);
  snap = step(snap, d);
  assert.equal(owner(d, "Kettle"), "pAnn");
  d.rows[0] = row("r1", [KETTLE, T(" "), who("Sam"), T(" "), who("Ann"), T(" "), who("Sam")]);
  snap = step(snap, d);
  assert.equal(owner(d, "Kettle"), "pSam");
  d.rows[0] = row("r1", [KETTLE, T(" "), who("Sam"), T(" "), who("Ann")]);
  step(snap, d);
  assert.equal(owner(d, "Kettle"), "pAnn");
});

test("owner sync: new sentence assignments are detected when document-wide pair counts stay equal", () => {
  for (const sameRow of [false, true]) {
    const sam = [KETTLE, T(" "), who("Sam")], ann = [KETTLE, T(" "), who("Ann")];
    const d = doc(sameRow ? [row("r1", [...sam, T(". "), ...ann])] : [row("r1", [...sam, T(" first")]), row("r2", [...ann, T(" second")])],
      [{ id: "pSam", name: "Sam" }, { id: "pAnn", name: "Ann" }]);
    const kettle = d.productionTags[0];
    assert.ok(kettle);
    kettle.owner = "pAnn";
    const snap = snapshotOwners(d, readers);
    d.rows = sameRow ? [row("r1", [...ann, T(". "), ...sam])] : [row("r1", [...ann, T(" first")]), row("r2", [...sam, T(" second")])];
    step(snap, d);
    assert.equal(owner(d, "Kettle"), "pSam");
  }
});

test("owner sync: planning one changed cell reads one Visual field, with no document scan or snapshot copy", () => {
  const d = doc(Array.from({ length: 1000 }, (_, i) => row("r" + i, [KETTLE])));
  const snap = snapshotOwners(d, readers);
  let reads = 0;
  for (const row of d.rows) {
    let html = row.visualText;
    Object.defineProperty(row, "visualText", { get: () => { reads++; return html; }, set: (value: string) => { html = value; } });
  }
  const changed = d.rows[500];
  assert.ok(changed);
  changed.visualText = cells.html([KETTLE, T(" "), who("Sam")]);
  const plan = planOwnerSync(snap, d, readers, { rows: [changed], removed: [] });
  assert.equal(reads, 1);
  assert.equal(plan.snapshot.cells, snap.cells);
  assert.equal(plan.snapshot.pairs, snap.pairs);
  plan.commit();
  reads = 0;
  const quiet = planOwnerSync(plan.snapshot, d, readers, { rows: [], removed: [] });
  quiet.commit();
  assert.equal(reads, 0);
  assert.equal(quiet.snapshot, plan.snapshot);
});
