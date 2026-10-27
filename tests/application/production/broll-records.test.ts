import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { brollSeedOf, createRecordsReconciler, recordPastedBroll } from "../../../src/application/production/broll-records.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { TagRecordsPlan } from "../../../src/core/production/index.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { productionReaders } from "../../../src/legacy/document-ports.ts";
import { htmlToPlainText } from "../../../src/bootstrap/plain-text.ts";
import { cellOf } from "../../../src/legacy/richtext.ts";
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
  assert.equal(out.commit, commit);
  out.apply(held);
  assert.deepEqual(applied, ["tags"]);
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
