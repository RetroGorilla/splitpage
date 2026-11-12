import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, operation, agree } from "./executor-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector, observeSharedTransactions, observeSharedUpdates, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { registeredSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { collabState, SharedExecutionWriteError } from "../../../src/adapters/collab/state.ts";
import { trapSharedCollectionWalks } from "./collection-guards.ts";
import { measureLibraryReads } from "../../collab/library-read-counts.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedRemovalCommand } from "../../../src/adapters/collab/removal-record.ts";

const remove = { kind: "remove", id: "a", by: "Alice", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 2)], boundaries: ["R1"], components: [], gallery: [], at: 0 };
const create = { kind: "segment-create", id: "r17", by: "Alice", beat: "new", segment: "segment", at: { left: null, right: null, affinity: "after" }, fields: { audioText: "abc" } };

test("late removal and restore refusals leave bytes, vector, revision, transaction and update counts unchanged", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    registerSharedRemovalHandlers(set.a); registerSharedSplitHandlers(set.a, createFlowLoadRuntime());
    let transactions = 0, updates = 0;
    const stop = observeSharedTransactions(set.a, () => { transactions++; }), detach = observeSharedUpdates(set.a, () => { updates++; });
    try { for (const [bad, reason] of [
      [{ ...remove, targets: ["gone"] }, "missing-target"], [{ ...remove, boundaries: ["R2"] }, "invalid-removal-boundary"],
      [{ ...remove, observed: [flowBaseReference("R2", "audioText", 0, 1)] }, "invalid-reference"],
      [{ ...remove, components: ["foreign"] }, "invalid-removal-components"], [{ ...remove, gallery: ["foreign"] }, "invalid-removal-gallery"],
      [{ kind: "restore", id: "back", by: "Alice", removals: ["gone"] }, "invalid-removal-record"],
      [{ ...create, id: "other", beat: "other", segment: "otherSegment", fields: { bufferSourceOwner: "R1" } }, "invalid-buffer-recovery-metadata"],
      [{ ...create, id: "other", beat: "other", segment: "otherSegment", fields: { bufferSourceOwner: "R1", bufferPaintedBase: -1 } }, "invalid-buffer-recovery-metadata"]
    ] as const) {
      const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
      const result = executeSharedOperations(set.a, [operation(create), operation(bad)], { base: revision }); assert.ok(!result.ok); assert.equal(result.reason, reason);
      assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
      assert.deepEqual([transactions, updates], [0, 0]);
    } } finally { stop(); detach(); }
  } finally { set.close(); }
});

test("a staged remove, restore and later scalar share aliases without copying any boundary or text", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }] });
  try {
    registerSharedRemovalHandlers(set.a); registerSharedSplitHandlers(set.a, createFlowLoadRuntime());
    const commands = [{ ...create, fields: { ...create.fields, audioText: "<strong>abc</strong>", visualText: "<em>V</em>", imageRef: { sha256: "a".repeat(64) }, moreImages: [{ imageRef: { sha256: "b".repeat(64) } }] } },
      { ...remove, targets: ["new"], boundaries: ["new"], observed: [flowBaseReference("new", "audioText", 0, 3)] },
      { kind: "restore", id: "back", by: "Alice", removals: ["a"] }, { kind: "scalar", id: "length", by: "Alice", target: { scope: "beat", record: "new" }, field: "lengthSeconds", value: 9 }];
    assert.deepEqual(executeSharedOperations(set.a, commands.map(operation), { base: readSharedRevision(set.a) }), { ok: true });
    const value = projectSharedDocumentWithRecovery(set.a); assert.deepEqual(value.recovery, []); assert.equal(value.document.rows.at(-1)?.audioText, "<strong>abc</strong>");
    assert.equal(value.document.rows.at(-1)?.lengthSeconds, 9); assert.equal(collabState(set.a).roots.order.length, 2);
    const record = readSharedRemovalCommand("structure_1_0061_removal_0", collabState(set.a).roots.removalRecords.get("structure_1_0061_removal_0"));
    assert.ok(record?.kind === "remove"); assert.equal(record.comments, null); assert.equal(record.observed[0]?.identities.length, 3);
    assert.deepEqual(record.components, ["structure_1_007200310037_visual_0"]);
    assert.deepEqual(record.gallery, ["structure_1_007200310037_gallery_0", "structure_1_007200310037_gallery_1"]);
    assert.equal(record.observed[1]?.identities.length, 1); assert.equal(value.document.rows.at(-1)?.visualText, "<em>V</em>");
    assert.deepEqual(value.document.rows.at(-1)?.imageRef, { sha256: "a".repeat(64) });
    const images = value.document.rows.at(-1)?.moreImages; assert.ok(Array.isArray(images)); assert.equal(images.length, 1);
    assert.deepEqual((images[0] as Record<string, unknown>).imageRef, { sha256: "b".repeat(64) });
  } finally { set.close(); }
});

test("removal descriptions are deeply frozen and apply refuses outside the entry", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }] });
  try {
    registerSharedRemovalHandlers(set.a); const preparation = createSharedPreparation(set.a, readSharedRevision(set.a));
    const command = operation(remove); assert.equal(command.kind, "remove"); if (command.kind !== "remove") throw new Error("Wrong fixture");
    const result = registeredSharedOperationHandlers(set.a).remove?.(command, preparation.view); assert.ok(result?.ok); preparation.close();
    const frozen = (value: unknown): void => { if (value === null || typeof value !== "object") return; assert.ok(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child); };
    frozen(Reflect.get(result, "description")); frozen(result.writes);
    const bytes = encodeSharedState(set.a); assert.throws(() => result.apply(set.a), SharedExecutionWriteError); assert.deepEqual(encodeSharedState(set.a), bytes);
  } finally { set.close(); }
});

test("removal preparation reads only touched records with zero and many unrelated beats and attachments", t => {
  const counts: unknown[] = [];
  for (const unrelated of [0, 10000]) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }] });
    try {
      const roots = collabState(set.a).roots;
      transactSharedDocument(set.a, "local-command", () => { for (let index = 0; index < unrelated; index++) {
        const record = new Y.Map<unknown>(); record.set("beat", "other" + index); roots.gallery.set("g" + index, record);
        roots.beats.set("other" + index, { id: "other" + index }); roots.order.push(["other" + index]);
      } });
      registerSharedRemovalHandlers(set.a); const prep = createSharedPreparation(set.a, readSharedRevision(set.a));
      const command = operation(remove); assert.ok(command.kind === "remove");
      try {
        const result = measureLibraryReads(set.a, "R1", () => {
          const restore = trapSharedCollectionWalks(roots.beats, roots.segments, roots.headings, roots.visuals, roots.gallery, roots.order, roots.removalRecords);
          try { return registeredSharedOperationHandlers(set.a).remove?.(command, prep.view); } finally { restore(); }
        });
        assert.ok(result.result?.ok); assert.deepEqual(result.unrelated, { texts: 0, markEntries: 0, records: 4, statusEntries: 0, orderEntries: 0 }); counts.push(result.totals);
      } finally { prep.close(); }
    } finally { set.close(); }
  }
  assert.deepEqual(counts, [{ texts: 4, markEntries: 0, records: 57, statusEntries: 0, orderEntries: 0 }, { texts: 4, markEntries: 0, records: 57, statusEntries: 0, orderEntries: 0 }]);
  t.diagnostic(JSON.stringify({ unrelated: [0, 10000], reads: counts, requiredIdentityAbsenceReads: 4 }));
});

for (const kind of ["split", "split-before"] as const) test(`restore an inline ${kind} half without inserting a duplicate boundary`, () => {
  const set = replicas(3, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    registerSharedRemovalHandlers(set.a); registerSharedSplitHandlers(set.a, createFlowLoadRuntime());
    const split = { kind, id: "enter", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, observed: [flowBaseReference("R1", "audioText", 0, 4)], beat: "new", boundary: "new", fields: {} };
    assert.deepEqual(executeSharedOperations(set.a, [split, { ...remove, targets: ["new"], boundaries: ["new"], observed: [] },
      { kind: "restore", id: "back", by: "Alice", removals: ["a"] }].map(operation), { base: readSharedRevision(set.a) }), { ok: true });
    set.queue.flush("dup");
    for (const handle of [set.a, set.b, set.c]) {
      const value = projectSharedDocumentWithRecovery(handle); assert.deepEqual(value.recovery, []);
      assert.deepEqual(value.document.rows.map(row => ({ id: row.id, text: row.audioText })), kind === "split" ? [
        { id: "R1", text: "ab" }, { id: "structure_1_0065006e007400650072_beat_0", text: "cd" }
      ] : [{ id: "structure_1_0065006e007400650072_beat_0", text: "ab" }, { id: "R1", text: "cd" }]);
      assert.equal(collabState(handle).roots.order.length, 1);
    }
  } finally { set.close(); }
});

test("seeded malformed removal records have one validated result on writing, receiving and encoded copies", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }] }), key = "structure_1_0061_removal_0";
  const valid = { kind: "remove", writer: "1", operation: "a", by: "Alice", targets: [{ beat: "R1", segment: "b:R1", generation: 0 }], removalKind: "beat", at: 0,
    observed: [], references: [], boundaries: ["R1"], components: [], gallery: [], comments: null, buffer: [] };
  let seed = 0x5c44;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  const atom = (): unknown => [undefined, null, true, 0, "", "R1", [], {}, new Y.Map<unknown>()][random(9)];
  try {
    for (let index = 0; index < 128; index++) {
      const field = ["kind", "writer", "operation", "by", "targets", "removalKind", "observed", "buffer", "comments"][random(9)]; assert.ok(field);
      const raw = index % 7 === 0 ? valid : { ...valid, [field]: random(2) ? atom() : [atom()] };
      transactSharedDocument(set.a, "local-command", () => collabState(set.a).roots.removalRecords.set(key, raw)); set.queue.flush("dup");
      agree("record grammar " + index, "dup", [set.a, set.b], handle => readSharedRemovalCommand(key, collabState(handle).roots.removalRecords.get(key)));
    }
    assert.equal(readSharedRemovalCommand(key, { ...valid, removalKind: ["beat"] }), null);
    assert.equal(readSharedRemovalCommand(key, { ...valid, targets: [...valid.targets, ...valid.targets] }), null);
  } finally { set.close(); }
});

test("removal generation overflow is a named whole-list refusal", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }] });
  try {
    registerSharedRemovalHandlers(set.a);
    transactSharedDocument(set.a, "local-command", () => ((collabState(set.a).roots.beats.get("R1") as Y.Map<unknown>).get("removals") as Y.Map<unknown>)
      .set("old", { generation: Number.MAX_SAFE_INTEGER, removed: false }));
    const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
    const result = executeSharedOperations(set.a, [operation(remove)], { base: revision }); assert.ok(!result.ok); assert.equal(result.reason, "removal-generation-limit");
    assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
  } finally { set.close(); }
});
