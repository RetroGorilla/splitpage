import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { replicas, operation, ref, agree } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedJoinEndpoint, sharedJoinEndpointField } from "../../../src/adapters/collab/join-endpoint.ts";
import { applySharedJoinEndpoint } from "../../../src/adapters/collab/join-endpoint-write.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { deliveryReplica } from "./helpers.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { trapSharedCollectionWalks } from "./collection-guards.ts";

const join = () => operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " });
const target = { owner: ref("R1"), segment: ref("R1"), field: "audioText" as const };
const insert = (point = flowBaseReference("R1", "audioText", 4)) => operation({ kind: "text-insert", id: "typed", by: "Writer", target,
  at: { left: null, right: point, affinity: "before" }, content: [{ value: "X", marks: [] }] });

test("joined typing inspects only connected native records with zero or ten thousand unrelated beats", t => {
  const reads: number[] = [];
  for (const unrelated of [0, 10000]) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
    try {
      const roots = collabState(set.a).roots;
      transactSharedDocument(set.a, "local-command", () => {
        for (let index = 0; index < unrelated; index++) { roots.beats.set("unrelated" + index, { id: "unrelated" + index }); roots.order.push(["unrelated" + index]); }
      });
      registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a);
      assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
      let count = 0;
      const getters = [roots.beats, roots.segments, roots.headings].map(root => { const get = root.get.bind(root); return mock.method(root, "get", (key: string) => { count++; return get(key); }); });
      const restore = trapSharedCollectionWalks(roots.beats, roots.segments, roots.headings, roots.order);
      try { assert.deepEqual(executeSharedOperations(set.a, [insert()], { base: readSharedRevision(set.a) }), { ok: true }); reads.push(count); }
      finally { getters.forEach(get => get.mock.restore()); restore(); }
    } finally { set.close(); }
  }
  assert.deepEqual(reads, [15, 15]); t.diagnostic(JSON.stringify({ unrelated: [0, 10000], reads, wholeCollectionWalks: 0 }));
});

test("a late refusal discards a staged endpoint and edits in both physical fragments", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a);
    const before = [encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)]; let updates = 0;
    const stop = deliveryReplica(set.a).onLocalUpdate(() => updates++);
    try {
      const result = executeSharedOperations(set.a, [join(), insert(flowBaseReference("R2", "audioText", 1)), operation({ kind: "text-delete", id: "delete", by: "Writer", target,
        observed: [flowBaseReference("R1", "audioText", 1, 2), flowBaseReference("R2", "audioText", 0, 1)] }), join()], { base: readSharedRevision(set.a) });
      assert.ok(!result.ok && "index" in result); assert.equal(result.index, 3); assert.equal(result.reason, "existing-join");
      assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], before); assert.equal(updates, 0);
    } finally { stop(); }
  } finally { set.close(); }
});

test("declared prefix-extraction limit refuses before changing either joined fragment", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), runtime = createFlowLoadRuntime();
  try {
    registerSharedJoinHandlers(set.a); registerSharedSplitHandlers(set.a, runtime);
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
    const before = [encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)];
    let updates = 0; const stop = deliveryReplica(set.a).onLocalUpdate(() => updates++);
    const result = executeSharedOperations(set.a, [operation({ kind: "split-before", id: "prefix", by: "Writer", target,
      at: { left: null, right: flowBaseReference("R1", "audioText", 4), affinity: "before" }, observed: [], beat: "fresh", boundary: "fresh", fields: {} })], { base: readSharedRevision(set.a) });
    assert.ok(!result.ok); assert.equal(result.reason, "partial-joined-prefix");
    assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], before);
    stop(); assert.equal(updates, 0);
  } finally { set.close(); }
});

test("apply-phase join binding refuses idle and its single validator rejects damaged positions", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    assert.throws(() => applySharedJoinEndpoint(set.a, { join: "j", target, index: 2, source: { ...target, owner: ref("R2"), segment: ref("b:R2") }, from: 0, to: 2 }), /write/i);
    registerSharedJoinHandlers(set.a); assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
    const raw = collabState(set.a).roots.meta.get(sharedJoinEndpointField("structure_1_006a006f0069006e_join_0")), binding = readSharedJoinEndpoint(raw); assert.ok(binding);
    assert.deepEqual(binding, raw);
    const position = { segment: "b:R1", type: [1, 1], item: null, assoc: 0 };
    for (const value of [null, [], {}, { end: position, start: position, stop: position }, { end: position, start: { ...position, assoc: -1 }, stop: { ...position, type: [-1, 0] } },
      { end: position, start: { ...position, assoc: -1 }, stop: { ...position, segment: "b:R2" } }]) assert.equal(readSharedJoinEndpoint(value), null);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) for (const form of ["flow", "native"] as const) test(`joined source split clamps a surrogate boundary: ${form}/${order}`, () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "😀z" }] }), runtime = createFlowLoadRuntime();
  try {
    registerSharedJoinHandlers(set.a); registerSharedSplitHandlers(set.a, runtime); registerSharedTextOperationHandlers(set.b);
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true }); set.queue.flush(order);
    const point = form === "flow" ? flowBaseReference("R1", "audioText", 4) : createSharedAnchor(set.a, "b:R2", 1, "after"); assert.ok(point);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "split", id: "split", by: "Writer", target,
      at: { left: null, right: point, affinity: "before" }, observed: [], beat: "fresh", boundary: "fresh", fields: {} })], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [operation({ kind: "text-insert", id: "append", by: "Writer", target: { owner: "R2", segment: "R2", field: "audioText" },
      at: { left: null, right: flowBaseReference("R2", "audioText", 3), affinity: "before" }, content: [{ value: "X", marks: [] }] })], { base: readSharedRevision(set.b) }), { ok: true });
    set.queue.flush(order); agree("joined surrogate policy", order, [set.a, set.b], handle => {
      const result = projectSharedDocumentWithRecovery(handle); assert.deepEqual(result.recovery, []); return result.document.rows.map(row => row.audioText);
    }, ["ab 😀", "zX"]);
  } finally { set.close(); }
});
