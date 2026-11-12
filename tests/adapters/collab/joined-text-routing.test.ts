import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { createSharedAnchor, resolveSharedAnchor, resolveSharedTextAnchor } from "../../../src/adapters/collab/anchors.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { deliveryReplica } from "./helpers.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const target = { owner: ref("R1"), segment: ref("R1"), field: "audioText" as const };
const join = (from = "R2", id = "join") => operation({ kind: "join", id, by: "Writer", from, into: "R1", glue: " " });
const insert = (id: string, point: string, value: string, owner = "R1") => operation({ kind: "text-insert", id, by: "Writer", target: { owner, segment: owner, field: "audioText" },
  at: { left: null, right: point, affinity: "before" }, content: [{ value, marks: [] }] });
const split = (owner: string, point: string, id = "split") => operation({ kind: "split", id, by: "Writer", target: { owner, segment: owner, field: "audioText" },
  at: { left: null, right: point, affinity: "before" }, observed: [], boundary: id + "_beat", beat: id + "_beat", fields: {} });
const read = (handle: SharedDocumentHandle) => {
  const result = projectSharedDocumentWithRecovery(handle); assert.deepEqual(result.recovery, []);
  return result.document.rows.map(row => row.audioText);
};

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const form of ["flow", "native", "painted"] as const) test(`joined typing resolves ${form} references on both sides: ${copies}/${order}`, () => {
  const set = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), handles = [set.a, set.b, set.c].slice(0, copies);
  const incremental = handles.map(handle => captureIncrementalReplica(handle));
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); });
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true }); set.queue.flush(order);
    const point = (handle: SharedDocumentHandle, index: number) => {
      const value = form === "flow" ? flowBaseReference("R1", "audioText", index) : form === "native" ? createSharedAnchor(handle, target, index, "after") : readSharedPaintedText(handle, target)?.identity(index);
      assert.ok(value); return value;
    };
    assert.deepEqual(executeSharedOperations(set.a, [insert("left", point(set.a, 1), "Y")], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [insert("right", point(set.b, 4), "X")], { base: readSharedRevision(set.b) }), { ok: true });
    if (copies === 3) assert.deepEqual(executeSharedOperations(set.c, [operation({ kind: "text-delete", id: "third", by: "Cara", target, observed: [flowBaseReference("R1", "audioText", 1, 2)] })], { base: readSharedRevision(set.c) }), { ok: true });
    set.queue.flush(order); agree("routed typing", order, handles, read, [copies === 3 ? "aY cXd" : "aYb cXd"]);
    handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); assert.equal(readSharedPaintedText(handle, target)?.text, copies === 3 ? "aY cXd" : "aYb cXd"); });
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const form of ["flow", "painted", "captured"] as const) test(`joined replacement removes observed fragments and separator, retaining unseen typing: ${copies}/${order}/${form}`, () => {
  const set = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), handles = [set.a, set.b, set.c].slice(0, copies);
  const incremental = handles.map(handle => captureIncrementalReplica(handle));
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); });
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true }); set.queue.flush(order);
    const painted = readSharedPaintedText(set.b, target); assert.ok(painted);
    const captured = captureSharedTextRange(set.b, target, 1, 4); assert.ok(captured);
    const observed = form === "flow" ? [flowBaseReference("R1", "audioText", 1, 4)] : form === "captured" ? [captured] : [painted.identity(1), painted.identity(2), painted.identity(3)];
    assert.deepEqual(executeSharedOperations(set.a, [insert("prefix", flowBaseReference("R1", "audioText", 0), "Z")], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [insert("replacement", flowBaseReference("R1", "audioText", 1), "X"),
      operation({ kind: "text-delete", id: "delete", by: "Bob", target, observed })], { base: readSharedRevision(set.b) }), { ok: true });
    if (copies === 3) assert.deepEqual(executeSharedOperations(set.c, [insert("third", flowBaseReference("R1", "audioText", 3), "Y")], { base: readSharedRevision(set.c) }), { ok: true });
    set.queue.flush(order); agree("observed joined replacement", order, handles, read, [copies === 3 ? "ZaXYd" : "ZaXd"]);
    handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});

test("a whole-row typed anchor and the projected separator both resolve after a joined destination splits", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), runtime = createFlowLoadRuntime();
  try {
    registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a); registerSharedSplitHandlers(set.a, runtime);
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
    const point = createSharedAnchor(set.a, target, 4, "after"), glue = readSharedPaintedText(set.a, target)?.identity(2); assert.ok(point && glue);
    assert.deepEqual(resolveSharedAnchor(set.a, point), { segment: "b:R2", offset: 1 }); assert.equal(resolveSharedTextAnchor(set.a, point, target), 4);
    assert.deepEqual(resolveSharedAnchor(set.a, glue), { segment: "b:R1", offset: 2 });
    assert.deepEqual(executeSharedOperations(set.a, [split("R1", flowBaseReference("R1", "audioText", 1))], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(read(set.a), ["a", "b cd"]);
    assert.deepEqual(resolveSharedAnchor(set.a, glue), { segment: "b:R1", offset: 3 });
    assert.deepEqual(executeSharedOperations(set.a, [insert("typed", point, "X", "structure_1_00730070006c00690074_beat_0")], { base: readSharedRevision(set.a) }), { ok: true });
    set.queue.flush("dup"); agree("stored anchor follows joined tail", "dup", [set.a, set.b], read, ["a", "b cXd"]);
  } finally { set.close(); }
});

test("staged joins, typed units and two splits retain new-row aliases in one transaction", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), runtime = createFlowLoadRuntime();
  try {
    registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a); registerSharedSplitHandlers(set.a, runtime);
    let updates = 0, transactions = 0; const stop = deliveryReplica(set.a).onLocalUpdate(() => updates++), observer = () => { transactions++; };
    collabState(set.a).doc.on("afterTransaction", observer);
    try {
      assert.deepEqual(executeSharedOperations(set.a, [join(), insert("typed", flowBaseReference("R2", "audioText", 1), "X"), split("R1", flowBaseReference("R1", "audioText", 1)),
        insert("later", flowBaseReference("split_beat", "audioText", 3), "Y", "split_beat"), split("split_beat", flowBaseReference("split_beat", "audioText", 1), "again")], { base: readSharedRevision(set.a) }), { ok: true });
      assert.deepEqual([updates, transactions], [1, 1]);
    } finally { stop(); collabState(set.a).doc.off("afterTransaction", observer); }
    set.queue.flush("rev"); agree("staged joined aliases", "rev", [set.a, set.b], read, ["a", "b", " cYXd"]);
  } finally { set.close(); }
});

test("a second join in the same list observes the first join's destination end", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] }), runtime = createFlowLoadRuntime();
  try {
    registerSharedJoinHandlers(set.a); registerSharedSplitHandlers(set.a, runtime);
    assert.deepEqual(executeSharedOperations(set.a, [join("R2", "first"), join("R3", "second"), split("R1", flowBaseReference("R2", "audioText", 1))], { base: readSharedRevision(set.a) }), { ok: true });
    set.queue.flush("dup"); agree("issued logical end", "dup", [set.a, set.b], read, ["ab c", "d ef"]);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test("joined typing preserves birth marks and Enter preserves both physical mark stores: " + order, () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "<b>ab</b>" }, { id: "R2", audioText: "<em>cd</em>" }] }), runtime = createFlowLoadRuntime();
  try {
    registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a); registerSharedSplitHandlers(set.a, runtime);
    assert.deepEqual(executeSharedOperations(set.a, [join()]), { ok: true });
    const typed = operation({ kind: "text-insert", id: "typed", by: "Writer", target,
      at: { left: null, right: flowBaseReference("R1", "audioText", 4), affinity: "before" }, content: [{ value: "X", marks: [{ kind: "u", value: true }] }] });
    assert.deepEqual(executeSharedOperations(set.a, [typed], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(read(set.a), ["<strong>ab</strong> <em>c</em><u>X</u><em>d</em>"]);
    assert.deepEqual(executeSharedOperations(set.a, [split("R1", flowBaseReference("R1", "audioText", 5))], { base: readSharedRevision(set.a) }), { ok: true });
    set.queue.flush(order); agree("marked joined Enter", order, [set.a, set.b], read, ["<strong>ab</strong> <em>c</em><u>X</u>", "<em>d</em>"]);
  } finally { set.close(); }
});
