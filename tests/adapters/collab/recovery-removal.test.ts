import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedRecoveryEntry } from "../../../src/core/collab/recovery.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { assertIncremental, captureIncrementalReplica, identityLetters } from "./incremental-support.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const rows = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] };
const removeR2 = (id: string, by: string, observed: boolean) => ({ kind: "remove", id, by, removalKind: "beat", targets: ["R2"], boundaries: ["R2"],
  observed: observed ? [flowBaseReference("R2", "audioText", 0, 2)] : [], components: [], gallery: [], at: 1 });
const typeX = { kind: "text-insert", id: "typed", by: "Carol", target: { owner: "R2", segment: "b:R2", field: "audioText" },
  at: { left: null, right: flowBaseReference("R2", "audioText", 1), affinity: "before" }, content: [{ value: "X", marks: [] }] };

function send(handle: SharedDocumentHandle, ...ops: unknown[]): void {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function setup(source: Record<string, unknown>) {
  const set = replicas(3, source), handles = [set.a, set.b, set.c];
  for (const handle of handles) { registerSharedJoinHandlers(handle); registerSharedRemovalHandlers(handle); registerSharedTextOperationHandlers(handle); }
  return { set, handles };
}
function provenance(handle: SharedDocumentHandle, entries: readonly SharedRecoveryEntry[] = projectSharedDocumentWithRecovery(handle).recovery) {
  const known = identityLetters(handle);
  return entries.map(entry => {
    assert.ok(entry.kind === "removed-beat" || entry.kind === "removed-heading");
    const id = entry.kind === "removed-beat" ? entry.row.id : entry.heading.id, removal = entry.removal;
    return removal ? { kind: entry.kind, id, ids: removal.ids, by: removal.by, edited: removal.edited.map(identity => known.get(identity.client + ":" + identity.clock) ?? "?").join("") }
      : { kind: entry.kind, id, removal: "none" };
  });
}

for (const observed of [true, false]) for (const order of ["D1", "rev", "dup"] as const) test(`two concurrent removals of a beat are both its provenance, observed by the second: ${observed}/${order}`, () => {
  const { set, handles } = setup(rows);
  try {
    send(set.a, removeR2("a", "Alice", true)); send(set.b, removeR2("b", "Bob", observed)); send(set.c, typeX);
    set.queue.flush(order);
    agree("two removers", order, handles, handle => provenance(handle), [{ kind: "removed-beat", id: "R2", ids: ["structure_1_0061_removal_0", "structure_2_0062_removal_0"],
      by: "Alice, Bob", edited: observed ? "X" : "cXd" }]);
  } finally { set.close(); }
});

test("a removal restored and made again names only the new removal", () => {
  const { set, handles } = setup(rows);
  try {
    send(set.a, removeR2("a", "Alice", true)); set.queue.flush("D1");
    send(set.b, { kind: "restore", id: "back", by: "Bob", removals: ["structure_1_0061_removal_0"] }); set.queue.flush("D1");
    send(set.c, removeR2("c", "Carol", false)); set.queue.flush("D1");
    agree("removed again", "D1", handles, handle => provenance(handle), [{ kind: "removed-beat", id: "R2", ids: ["structure_3_0063_removal_0"], by: "Carol", edited: "cd" }]);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a beat joined into a removed beat carries the removal of the beat it joined: ${order}`, () => {
  const { set, handles } = setup({ rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    send(set.a, { kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " });
    send(set.b, { kind: "remove", id: "remove", by: "Bob", removalKind: "beat", targets: ["R1"], boundaries: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 2)],
      components: [], gallery: [], at: 0 });
    send(set.c, typeX);
    set.queue.flush(order);
    agree("joined member", order, handles, handle => provenance(handle), [{ kind: "removed-beat", id: "R1", ids: ["structure_2_00720065006d006f00760065_removal_0"],
      by: "Bob", edited: "cXd" }]);
  } finally { set.close(); }
});

const heading = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }], sections: [{ id: "H1", name: "In", firstSceneId: "R1" }] };
const discard = (id: string, by: string) => ({ kind: "heading-remove", id, by, heading: "H1", observed: [flowBaseReference("H1", "heading", 0, 2)], newBeat: null, nextBeat: null });
const typeHeading = { kind: "text-insert", id: "typeZ", by: "Bob", target: { owner: "H1", segment: "h:H1", field: "heading" },
  at: { left: flowBaseReference("H1", "heading", 1), right: null, affinity: "after" }, content: [{ value: "Z", marks: [] }] };

for (const order of ["D1", "rev", "dup"] as const) test(`a removed heading names its removals and the heading text typed after them: ${order}`, () => {
  const { set, handles } = setup(heading);
  try {
    send(set.a, discard("unhead", "Alice")); send(set.b, typeHeading); send(set.c, discard("again", "Carol"));
    set.queue.flush(order);
    agree("removed heading", order, handles, handle => provenance(handle), [{ kind: "removed-heading", id: "H1",
      ids: ["structure_1_0075006e0068006500610064_removal_0", "structure_3_0061006700610069006e_removal_0"], by: "Alice, Carol", edited: "Z" }]);
  } finally { set.close(); }
});

test("removal flags without a readable removal record give an entry without provenance", () => {
  const { set } = setup(rows);
  try {
    send(set.a, removeR2("a", "Alice", true));
    const records = collabState(set.a).roots.removalRecords;
    collabState(set.a).doc.transact(() => records.set("structure_1_0061_removal_0", "unreadable"));
    assert.deepEqual(provenance(set.a), [{ kind: "removed-beat", id: "R2", removal: "none" }]);
  } finally { set.close(); }
});

test("removal provenance read incrementally equals a fresh full projection across removal, a second remover, restore and removal again", () => {
  const { set } = setup({ ...rows, sections: [{ id: "H1", name: "In", firstSceneId: "R1" }] });
  try {
    const { projector } = captureIncrementalReplica(set.a);
    send(set.a, removeR2("a", "Alice", true)); assertIncremental(set.a, projector);
    send(set.b, removeR2("b", "Bob", false)); send(set.c, typeX); set.queue.flush("rev"); assertIncremental(set.a, projector);
    send(set.a, { kind: "heading-remove", id: "unhead", by: "Alice", heading: "H1", observed: [flowBaseReference("H1", "heading", 0, 2)], newBeat: null, nextBeat: null });
    assertIncremental(set.a, projector);
    assert.deepEqual(provenance(set.a, projector.read().recovery), [
      { kind: "removed-beat", id: "R2", ids: ["structure_1_0061_removal_0", "structure_2_0062_removal_0"], by: "Alice, Bob", edited: "cXd" },
      { kind: "removed-heading", id: "H1", ids: ["structure_1_0075006e0068006500610064_removal_0"], by: "Alice", edited: "" }]);
    send(set.b, { kind: "restore", id: "back", by: "Bob", removals: ["structure_1_0061_removal_0"] }); set.queue.flush("D1"); assertIncremental(set.a, projector);
    send(set.a, removeR2("again", "Alice", false)); assertIncremental(set.a, projector);
    assert.deepEqual(provenance(set.a, projector.read().recovery).map(entry => entry.ids), [["structure_1_0061006700610069006e_removal_0"], ["structure_1_0075006e0068006500610064_removal_0"]]);
  } finally { set.close(); }
});

test("a removed heading entry is reused while its heading, text and removals are unchanged", () => {
  const { set } = setup(heading);
  try {
    const { projector } = captureIncrementalReplica(set.a);
    send(set.a, discard("unhead", "Alice"));
    const before = projector.read().recovery[0]; assert.ok(before?.kind === "removed-heading");
    send(set.a, { kind: "text-insert", id: "elsewhere", by: "Alice", target: { owner: "R0", segment: "b:R0", field: "audioText" },
      at: { left: flowBaseReference("R0", "audioText", 0), right: null, affinity: "after" }, content: [{ value: "y", marks: [] }] });
    assert.equal(projector.read().recovery[0], before);
    send(set.b, typeHeading); set.queue.flush("D1");
    assert.notEqual(projector.read().recovery[0], before);
  } finally { set.close(); }
});
