import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertIncremental, captureIncrementalReplica } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { sharedBufferSourceSegment } from "../../../src/adapters/collab/buffer.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { bufferedRecoveryOperations } from "../../../src/core/collab/buffer-operations.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime();
const hex = (value: string) => value.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const native = (client: number, id: string, role: string) => "structure_" + client + "_" + hex(id) + "_" + role + "_0";
const REMOVAL = native(1, "gone", "removal"), RB = native(2, "cut", "beat");
const draft = (client: number, id: string) => native(client, id, "beat"), kept = (client: number, id: string) => native(client, id + "_remove", "removal");
const names = new Map([[RB, "Rb"], [draft(1, "d1"), "D1"], [draft(2, "d2"), "D2"], [draft(1, "d3"), "D3"]]), shown = (id: unknown) => names.get(String(id)) ?? id;
const source = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] };
const remove = (beat: string, id = "gone", length = 4) => ({ kind: "remove", id, by: "Alice", removalKind: "beat", targets: [beat],
  observed: [flowBaseReference(beat, "audioText", 0, length)], boundaries: [beat], components: [], gallery: [], at: 1 });
const split = { kind: "split", id: "cut", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
  at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, observed: [], boundary: "Rb", beat: "Rb", fields: {} };
const restore = (removal: string) => ({ kind: "restore", id: "back_" + removal, by: "Carol", removals: [removal] });

function send(handle: SharedDocumentHandle, ...ops: unknown[]): void {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function keep(handle: SharedDocumentHandle, owner: string, id: string, text = "typed"): void {
  const client = collabState(handle).doc.clientID, segment = sharedBufferSourceSegment(handle, owner);
  send(handle, ...bufferedRecoveryOperations({ owner, base: 0, html: text, units: text.length, segment }, { id, by: client === 1 ? "Alice" : "Bob" },
    { rows: 3, visual: native(client, id, "visual") }));
}
function setup() {
  const set = replicas(3, source), handles = [set.a, set.b, set.c];
  for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedJoinHandlers(handle); }
  return { set, handles, projector: captureIncrementalReplica(set.c).projector };
}
function summary(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { rows: document.rows.map(row => [shown(row.id), row.audioText]), recovery: recovery.map(entry => entry.kind === "removed-beat" ? shown(entry.row.id) : entry.kind) };
}

test("assumed rule 50: the source's segment is read for a live, removed and split-off source, and is unknown for a beat the document does not hold", () => {
  const { set } = setup();
  try {
    assert.equal(sharedBufferSourceSegment(set.a, "R1"), "b:R1");
    send(set.a, remove("R1")); send(set.b, split); set.queue.flush("D1");
    assert.deepEqual([sharedBufferSourceSegment(set.a, "R1"), sharedBufferSourceSegment(set.a, RB), sharedBufferSourceSegment(set.a, "R9")], ["b:R1", "b:R1", null]);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 50: a draft is created after its source's segment, listed beside it and restored there: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    send(set.a, remove("R1"), remove("R2", "gone2", 2)); keep(set.a, "R1", "d1"); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("beside its removed source", order, handles, summary, { rows: [["R0", "x"]], recovery: ["R1", "D1", "R2"] });
    send(set.c, restore(kept(1, "d1"))); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("draft restored alone", order, handles, summary, { rows: [["R0", "x"], ["D1", "typed"]], recovery: ["R1", "R2"] });
    send(set.c, restore(REMOVAL)); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("source restored", order, handles, summary, { rows: [["R0", "x"], ["R1", "abcd"], ["D1", "typed"]], recovery: ["R2"] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 50: a draft of a split-off source goes after the whole segment, and a split or join made later leaves it there: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    send(set.a, remove("R1")); send(set.b, split); set.queue.flush(order);
    keep(set.a, RB, "d1"); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("covered source", order, handles, summary, { rows: [["R0", "x"], ["R2", "ef"]], recovery: ["R1", "Rb", "D1"] });
    send(set.c, restore(kept(1, "d1"))); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("draft after the segment", order, handles, summary, { rows: [["R0", "x"], ["D1", "typed"], ["R2", "ef"]], recovery: ["R1", "Rb"] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 50: a live source split and joined after the draft was written keeps the draft after its segment: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    keep(set.a, "R1", "d1"); set.queue.flush(order);
    send(set.b, split); send(set.b, { kind: "join", id: "glue", by: "Bob", from: "R2", into: "R1", glue: " " }); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("split and joined", order, handles, summary, { rows: [["R0", "x"], ["R1", "ab ef"], ["Rb", "cd"]], recovery: ["D1"] });
    send(set.c, restore(kept(1, "d1"))); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("restored after the source's segment", order, handles, summary, { rows: [["R0", "x"], ["R1", "ab ef"], ["Rb", "cd"], ["D1", "typed"]], recovery: [] });
  } finally { set.close(); }
});

test("assumed rule 50: a source the document does not hold leaves the draft at the end, as before, and the write is accepted", () => {
  const { set, handles } = setup();
  try {
    keep(set.a, "R9", "d1"); set.queue.flush("D1");
    send(set.c, restore(kept(1, "d1"))); set.queue.flush("D1");
    agree("end of order", "D1", handles, summary, { rows: [["R0", "x"], ["R1", "abcd"], ["R2", "ef"], ["D1", "typed"]], recovery: [] });
  } finally { set.close(); }
});

for (const order of ["D1", "D2", "D3", "dup", "rev"] as const) test(`assumed rule 50: drafts of one source written at the same moment by two writers, and later by one, keep one order on every copy and a late joiner: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    keep(set.a, "R1", "d1", "alice"); keep(set.b, "R1", "d2", "bob"); set.queue.flush(order); assertIncremental(set.c, projector);
    keep(set.a, "R1", "d3", "later"); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("drafts listed", order, handles, summary, { rows: [["R0", "x"], ["R1", "abcd"], ["R2", "ef"]], recovery: ["D3", "D1", "D2"] });
    send(set.c, restore(kept(1, "d1")), restore(kept(2, "d2")), restore(kept(1, "d3"))); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("drafts restored", order, handles, summary, { rows: [["R0", "x"], ["R1", "abcd"], ["D3", "later"], ["D1", "alice"], ["D2", "bob"], ["R2", "ef"]], recovery: [] });
  } finally { set.close(); }
});
