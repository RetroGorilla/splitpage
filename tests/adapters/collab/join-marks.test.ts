import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const target = { owner: "R1", segment: "R1", field: "audioText" };
const bold = { kind: "b", value: true }, comment = { kind: "comment", id: "c1", value: true }, link = { kind: "link", id: "https://v/1", value: "https://v/1" };
const strong = (text: string) => `<strong>${text}</strong>`, anchored = (text: string) => `<span class="cmt-anchor" data-cmt="c1">${text}</span>`;
const cases = [
  { name: "inside the first fragment", mark: bold, range: [0, 1], typed: 4, added: strong("a") + "b cXd", removal: [0, 1], again: 6, removed: "ab cXdY" },
  { name: "inside the later fragment", mark: bold, range: [3, 5], typed: 1, added: "aXb " + strong("cd"), removal: [4, 6], again: 0, removed: "YaXb cd" },
  { name: "across the join point", mark: bold, range: [1, 4], typed: 0, added: "Xa" + strong("b") + " " + strong("c") + "d", removal: [2, 5], again: 6, removed: "Xab cdY" },
  { name: "over the whole row", mark: bold, range: [0, 5], typed: 5, added: strong("ab") + " " + strong("cd") + "X", removal: [0, 6], again: 0, removed: "Yab cdX" },
  { name: "comment across the join point", mark: comment, range: [1, 4], typed: 0, added: "Xa" + anchored("b c") + "d", removal: [2, 5], again: 6, removed: "Xab cdY" },
  { name: "comment over the whole row", mark: comment, range: [0, 5], typed: 5, added: anchored("ab cd") + "X", removal: [0, 6], again: 0, removed: "Yab cdX" },
  { name: "link over the whole row", mark: link, range: [0, 5], typed: 5, added: '<a href="https://v/1" target="_blank" rel="noopener">ab cd</a>X', removal: [0, 6], again: 0, removed: "Yab cdX" }
] as const;

function rows(handle: SharedDocumentHandle) {
  const result = projectSharedDocumentWithRecovery(handle); assert.deepEqual(result.recovery, []);
  return result.document.rows.map(row => row.audioText);
}
function mark(id: string, range: readonly number[], value: Record<string, unknown>) {
  return operation({ kind: "mark", id, by: "Writer", target, observed: [flowBaseReference("R1", "audioText", range[0] ?? 0, range[1] ?? 0)], mark: value });
}
function type(id: string, at: number, value: string) {
  return operation({ kind: "text-insert", id, by: "Other", target, at: { left: null, right: flowBaseReference("R1", "audioText", at), affinity: "before" }, content: [{ value, marks: [] }] });
}

for (const item of cases) for (const order of ["D1", "rev", "dup"] as const) test(`joined row mark ${item.name}, added and removed against concurrent typing: ${order}`, () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), handles = [set.a, set.b];
  const incremental = handles.map(handle => captureIncrementalReplica(handle));
  const check = () => handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); });
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
    set.queue.flush(order); check();
    assert.deepEqual(executeSharedOperations(set.a, [mark("add", item.range, item.mark)], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [type("typed", item.typed, "X")], { base: readSharedRevision(set.b) }), { ok: true });
    check(); set.queue.flush(order); check();
    agree("joined mark added " + item.name, order, handles, rows, [item.added]);
    assert.deepEqual(executeSharedOperations(set.a, [mark("remove", item.removal, { ...item.mark, value: null })], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [type("again", item.again, "Y")], { base: readSharedRevision(set.b) }), { ok: true });
    check(); set.queue.flush(order); check();
    agree("joined mark removed " + item.name, order, handles, rows, [item.removed]);
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});

test("a mark over the virtual separator alone writes nothing and the row reads unchanged", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
    const before = encodeSharedState(set.a);
    for (const value of [bold, comment]) assert.deepEqual(executeSharedOperations(set.a, [mark("glue", [2, 3], value)], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(encodeSharedState(set.a), before); assert.deepEqual(rows(set.a), ["ab cd"]);
  } finally { set.close(); }
});

test("native anchors in both fragments mark the later fragment and the join point", () => {
  for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
    try {
      registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a);
      assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
      const b = createSharedAnchor(set.a, "b:R1", 1, "after"), c = createSharedAnchor(set.a, "b:R2", 0, "after"); assert.ok(b && c);
      assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "mark", id: "native", by: "Writer", target, observed: [b, c], mark: bold })]), { ok: true });
      set.queue.flush(order); agree("native joined mark", order, [set.a, set.b], rows, ["a" + strong("b") + " " + strong("c") + "d"]);
    } finally { set.close(); }
  }
});
