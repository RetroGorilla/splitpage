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
      transactSharedDocument(set.a, "local-command", () => { for (let index = 0; index < unrelated; index++) roots.beats.set("unrelated" + index, { status: "todo" }); });
      let count = 0;
      const getters = [roots.beats, roots.segments, roots.headings].map(root => mock.method(root, "get", () => { count++; throw new Error("Uncached owner record read"); }));
      const order = mock.method(roots.order, "toArray", () => { throw new Error("Whole order read in preparation"); });
      try {
        const prep = createSharedPreparation(set.a); assert.deepEqual(prep.view.resolveOwner("R1", "audioText"), { owner: "R1", segment: "b:R1" }); prep.close(); reads.push(count);
      } finally { for (const getter of getters) getter.mock.restore(); order.mock.restore(); }
    } finally { set.close(); }
  }
  assert.deepEqual(reads, [0, 0]); t.diagnostic(JSON.stringify({ unrelated: [0, 10000], nativeRecordReads: reads, wholeOrderReads: 0 }));
});
