import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { brollSeedOf, createRecordsReconciler, recordPastedBroll } from "../../../src/application/production/broll-records.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { TagRecordsPlan } from "../../../src/core/production/index.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { productionReaders } from "../../../src/bootstrap/document-ports.ts";
import { htmlToPlainText } from "../../../src/bootstrap/plain-text.ts";
import { cellOf } from "../../../src/bootstrap/richtext.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const text = { htmlToPlainText, productionReaders };

function doc(visualText: string, shots: unknown[] = []): ValidatedDocument {
  return migrateRows({ title: "B-roll", rows: [{ id: "r1", visualText, audioText: "Over the harbour." }], brollShots: shots }, fakeMigration().ports);
}

function ids() {
  let next = 0;
  return { id: (prefix: string) => prefix + "-" + (++next), docId: () => "doc" };
}

function reconciler(held: ValidatedDocument | null, tags: TagRecordsPlan | null = null) {
  const asked: unknown[] = [];
  const plan = createRecordsReconciler({
    held: () => held,
    viewed: () => held,
    production: { recordsPlan: (d) => { asked.push(d); return tags; } },
    text,
    ids: ids()
  });
  return { plan, asked };
}

test("records reconciler: a document that is not the held one gets no plan and no tag plan", () => {
  const held = doc("");
  const { plan, asked } = reconciler(held);
  assert.equal(plan(doc(""), changeSet({})), null);
  assert.deepEqual(asked, []);
});

test("records reconciler: nothing to record gives no plan", () => {
  const held = doc("");
  const { plan, asked } = reconciler(held);
  assert.equal(plan(held, changeSet({})), null);
  assert.deepEqual(asked, [held]);
});

test("records reconciler: a tag plan with work is applied first and its commit kept", () => {
  const held = doc("");
  const applied: string[] = [];
  const commit = (): void => { applied.push("commit"); };
  const { plan } = reconciler(held, { apply: () => { applied.push("tags"); return 1; }, commit });
  const out = plan(held, changeSet({}));
  assert.ok(out);
  assert.deepEqual(out.fields, ["productionTags"]);
  out.apply(held);
  assert.deepEqual(applied, ["tags"]);
  assert.ok(out.commit);
  out.commit();
  assert.deepEqual(applied, ["tags", "commit"]);
});

const WHO_CELL = toHtml([
  { text: "kettle", marks: { tag: "t:prop:Kettle" } }, { text: " for ", marks: {} },
  { atom: "who", name: "Sam", text: "@Sam", marks: {} }, { text: ". Then tea.", marks: {} }
]);

function whoDoc(visualText: string): ValidatedDocument {
  return migrateRows({
    title: "Who", rows: [{ id: "r1", visualText, audioText: "" }],
    productionTags: [{ id: "tg1", cat: "prop", name: "Kettle", owner: "", notes: "", status: "" }], people: []
  }, fakeMigration().ports);
}

test("records reconciler: a chip added in an edit adds the person and owns the tag in the same plan", () => {
  const held = whoDoc("kettle for tea.");
  const { plan } = reconciler(held);
  plan.resync?.(held);
  const row = held.rows[0];
  assert.ok(row);
  row.visualText = WHO_CELL;
  const out = plan(held, changeSet({ cells: [{ rowId: "r1", field: "visualText" }] }));
  assert.ok(out);
  assert.deepEqual(out.fields, ["people", "productionTags"]);
  out.apply(held);
  const people = held["people"] as { id: string; name: string }[];
  assert.deepEqual(people.map((p) => p.name), ["Sam"]);
  assert.equal(held.productionTags[0]?.owner, people[0]?.id);
  out.commit?.();
  assert.equal(plan(held, changeSet({})), null, "the committed snapshot holds the pair, so the next edit has nothing to do");
});

test("records reconciler: without a resync the first edit only takes its snapshot", () => {
  const held = whoDoc(WHO_CELL);
  const { plan } = reconciler(held);
  assert.equal(plan(held, changeSet({})), null);
  assert.equal(held.productionTags[0]?.owner, "");
});

test("owner resync reads only the changed Visual cells in a 1,000-beat document", () => {
  const held = whoDoc("");
  held.rows = Array.from({ length: 1000 }, (_, i) => ({ id: "r" + i, visualText: "", audioText: "" }));
  const { plan } = reconciler(held);
  plan.resync?.(held);
  let reads = 0;
  for (const row of held.rows) {
    let html = row.visualText;
    Object.defineProperty(row, "visualText", { configurable: true, get: () => { reads++; return html; }, set: (value: string) => { html = value; } });
  }
  const changed = held.rows[500];
  assert.ok(changed);
  changed.visualText = WHO_CELL;
  plan.resync?.(held, changeSet({ cells: [{ rowId: "r500", field: "visualText" }] }));
  assert.ok(reads <= 2, "one changed Visual cell, got " + reads + " reads");
  reads = 0;
  plan.resync?.(held, changeSet({}));
  assert.equal(reads, 0, "an unchanged document reads no Visual fields");
  changed.visualText = "";
  plan.resync?.(held, changeSet({ cells: [{ rowId: "r500", field: "visualText" }] }));
  assert.equal(held.productionTags[0]?.owner, "", "replay updates the snapshot without assigning");
  changed.visualText = WHO_CELL;
  const edit = plan(held, changeSet({ cells: [{ rowId: "r500", field: "visualText" }] }));
  assert.ok(edit);
  edit.apply(held);
  edit.commit?.();
  assert.equal(held.productionTags[0]?.owner, held.people[0]?.id, "an edit after replay compares against the replayed cell");
});

test("pasted b-roll: a pasted marker with a minted id gets a record seeded from its scene; known ids are left", () => {
  const target = doc("", [{ id: "bsKnown", name: "Known" }]);
  const cell = cellOf('<span class="broll-key" data-broll-id="bsNew" contenteditable="false">B-roll:</span> gulls<br><span class="broll-key" data-broll-id="bsKnown" contenteditable="false">B-roll:</span> known');
  recordPastedBroll(target, "r1", cell, ["bsNew", "bsKnown"], text, ids());
  assert.deepEqual(target.brollShots.map((s) => [s.id, s.name]), [["bsKnown", "Known"], ["bsNew", "gulls"]]);
  const seed = brollSeedOf(target.rows[0], text);
  const added = target.brollShots[1];
  assert.ok(added);
  assert.equal(added["audioRef"], seed.audioRef);
  assert.equal(added["location"], seed.location);
});
