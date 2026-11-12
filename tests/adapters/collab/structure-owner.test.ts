import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, ref } from "./executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { planSharedStructureHead, planSharedStructureOwner } from "../../../src/adapters/collab/structure-plan.ts";
import { observeSharedStructureOrder } from "../../../src/adapters/collab/structure-order-index.ts";
import { prepareSharedOrderInsertion } from "../../../src/adapters/collab/structure-order.ts";
import { trapSharedCollectionWalks } from "./collection-guards.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabTextTarget, collabProjectedTextTarget } from "../../../src/adapters/collab/text-target.ts";
import { operation } from "./executor-support.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";

test("preparation owner lookup is frozen, read-only and closes with its view", () => {
  const set = replicas(2);
  try {
    const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a), prep = createSharedPreparation(set.a);
    const owner = prep.view.resolveOwner("R1", "audioText"); assert.deepEqual(owner, { owner: "R1", segment: "b:R1" });
    assert.ok(owner && Object.isFrozen(owner)); assert.throws(() => { (owner as { owner: string }).owner = "other"; }, TypeError);
    assert.deepEqual(prep.view.resolveOwner("H1", "heading"), { owner: "H1", segment: "h:H1" });
    assert.equal(prep.view.resolveOwner("R1", "heading"), null); assert.equal(prep.view.resolveOwner("missing", "audioText"), null);
    const resolve = prep.view.resolveOwner; prep.close(); assert.throws(() => resolve("R1", "audioText"), /Preparation has ended/);
    assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
  } finally { set.close(); }
});

test("native title labels and an unattached native segment are not projected operation addresses", () => {
  const set = replicas(2);
  try {
    transactSharedDocument(set.a, "local-command", () => {
      const segment = new Y.Map<unknown>(); segment.set("text", new Y.Text("a")); segment.set("markRecords", new Y.Map<unknown>());
      collabState(set.a).roots.segments.set("b:orphan", segment);
    });
    registerSharedTextOperationHandlers(set.a);
    const cases = [
      { owner: ref("document"), segment: ref("document"), field: "title" as const, reason: "missing-target" },
      { owner: ref("R1"), segment: ref("R1"), field: "title" as const, reason: "missing-target" },
      { owner: ref("orphan"), segment: ref("b:orphan"), field: "audioText" as const, reason: "missing-target" }
    ];
    for (const { reason, ...target } of cases) {
      assert.equal(collabTextTarget(set.a, target) !== null, target.field === "title"); assert.equal(collabProjectedTextTarget(set.a, target), null);
      const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
      const result = executeSharedOperations(set.a, [operation({ kind: "text-insert", id: "invalid-address", by: "Writer", target,
        at: { left: null, right: flowBaseReference(target.owner, target.field, 0), affinity: "before" }, content: [{ value: "!", marks: [] }] })], { base: revision });
      assert.ok(!result.ok); assert.equal(result.reason, reason);
      assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision);
    }
  } finally { set.close(); }
});

test("owner lookup uses the same call's planned records, heads and order without creating shared data", () => {
  const set = replicas(2);
  try {
    const bytes = encodeSharedState(set.a), prep = createSharedPreparation(set.a), segment = "created-segment";
    prepareSharedOrderInsertion(prep.view, observeSharedStructureOrder(set.a), { left: null, right: ref("b:R1"), affinity: "before" }, segment);
    planSharedStructureOwner(prep.view, "created", segment); planSharedStructureHead(prep.view, segment, { b: "created" });
    assert.deepEqual(prep.view.resolveOwner("created", "audioText"), { owner: "created", segment });
    assert.deepEqual(prep.view.resolveOwner("R1", "audioText"), { owner: "R1", segment: "b:R1" });
    prep.close(); assert.deepEqual(encodeSharedState(set.a), bytes);
  } finally { set.close(); }
});

test("owner metadata follows explicit ownership and head fallback without rescanning a typed text", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    const roots = collabState(set.a).roots, original = roots.segments.get("b:R1") as Y.Map<unknown>, text = original.get("text") as Y.Text;
    const lookup = (id: string) => { const prep = createSharedPreparation(set.a); try { return prep.view.resolveOwner(id, "audioText"); } finally { prep.close(); } };
    const delta = mock.method(text, "toDelta", () => { throw new Error("Owner metadata read the full typed text"); });
    try {
      transactSharedDocument(set.a, "local-command", () => { text.insert(0, "X"); });
      assert.deepEqual(lookup("R1"), { owner: "R1", segment: "b:R1" });
      transactSharedDocument(set.a, "local-command", () => {
        const beat = new Y.Map<unknown>(); beat.set("id", "R2"); beat.set("segment", "b:R1"); roots.beats.set("R2", beat); text.insertEmbed(2, { b: "R2" });
      }); assert.deepEqual(lookup("R2"), { owner: "R2", segment: "b:R1" });
      transactSharedDocument(set.a, "local-command", () => { text.delete(2, 1); }); assert.equal(lookup("R2"), null);
    } finally { delta.mock.restore(); }
    transactSharedDocument(set.a, "local-command", () => {
      const segment = new Y.Map<unknown>(); segment.set("head", { b: "R1" }); segment.set("text", new Y.Text("other")); roots.segments.set("S", segment); roots.order.push(["S"]);
      (roots.beats.get("R1") as Y.Map<unknown>).set("segment", "S");
    }); assert.deepEqual(lookup("R1"), { owner: "R1", segment: "S" });
    transactSharedDocument(set.a, "local-command", () => { (roots.segments.get("S") as Y.Map<unknown>).set("head", { b: "R2" }); });
    assert.deepEqual(lookup("R1"), { owner: "R1", segment: "b:R1" });
  } finally { set.close(); }
});

test("owner preparation reads no native record or order collection with zero or many unrelated beats", t => {
  const reads: number[] = [];
  for (const unrelated of [0, 10000]) {
    const set = replicas(2);
    try {
      const roots = collabState(set.a).roots;
      transactSharedDocument(set.a, "local-command", () => { for (let index = 0; index < unrelated; index++) { roots.beats.set("unrelated" + index, { status: "todo" }); roots.order.push(["unrelated" + index]); } });
      let count = 0;
      const getters = [roots.beats, roots.segments, roots.headings].map(root => mock.method(root, "get", () => { count++; throw new Error("Uncached owner record read"); }));
      const restore = trapSharedCollectionWalks(roots.beats, roots.segments, roots.headings, roots.order);
      try {
        const prep = createSharedPreparation(set.a); assert.deepEqual(prep.view.resolveOwner("R1", "audioText"), { owner: "R1", segment: "b:R1" }); prep.close(); reads.push(count);
      } finally { for (const getter of getters) getter.mock.restore(); restore(); }
    } finally { set.close(); }
  }
  assert.deepEqual(reads, [0, 0]); t.diagnostic(JSON.stringify({ unrelated: [0, 10000], nativeRecordReads: reads, wholeOrderReads: 0 }));
});
