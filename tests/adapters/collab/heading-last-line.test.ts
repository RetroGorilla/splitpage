import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { validatedFixture } from "./helpers.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { sharedOperationListNotes } from "../../../src/adapters/collab/operation-list-notes.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { finalizeHeading, startParagraph, beatPos } from "../../../src/core/flow/flow.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { structureIdentityFixture } from "../../collab/structure-identity.ts";

const runtime = createFlowLoadRuntime();
const names = new Map([[structureIdentityFixture("1", "fin_o_0", "beat"), "Xa"], [structureIdentityFixture("2", "fin_o_0", "beat"), "Xb"], [structureIdentityFixture("1", "fin_o_1", "heading"), "Ha"],
  [structureIdentityFixture("2", "fin_o_1", "heading"), "Hb"], [structureIdentityFixture("2", "end_o_0", "beat"), "Rb"], [structureIdentityFixture("1", "blank", "beat"), "Xa"]]);
const shown = (id: string) => names.get(id) ?? id;
const last = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab", paragraphStart: true }] };

function lines(source: Record<string, unknown>, by: string, run: (doc: Parameters<typeof finalizeHeading>[0], ports: Parameters<typeof finalizeHeading>[4]) => unknown) {
  const fixture = validatedFixture(source); let next = 0;
  const outcome = run({ rows: fixture.rows, sections: fixture.sections, comments: [] }, { ...runtime.ports, newId: () => by + ++next, operations: { id: by === "Bob" && run !== finish ? "end" : "fin", by } });
  assert.ok(outcome && typeof outcome === "object" && "ops" in outcome); return (outcome as { ops: readonly SharedOperation[] }).ops;
}
const finish = (doc: Parameters<typeof finalizeHeading>[0], ports: Parameters<typeof finalizeHeading>[4]) => finalizeHeading(doc, "R1", null, null, ports);
function send(handle: SharedDocumentHandle, ops: readonly unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function setup(source: Record<string, unknown> = last) {
  const set = replicas(3, source), handles = [set.a, set.b, set.c];
  for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); registerSharedHeadingHandlers(handle); }
  return { set, handles };
}
function visible(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle), loaded = runtime.load(document);
  return { rows: loaded.rows.map(row => [shown(row.id), row.audioText]), sections: ((loaded.sections ?? []) as DocumentScene[]).map(scene => [shown(scene.id), scene.name, shown(scene.firstSceneId)]),
    recovery: recovery.map(entry => entry.kind === "removed-beat" ? [entry.kind, shown(String(entry.row.id))] : [entry.kind]) };
}
const type = (by: string, owner: string, offset: number, value: string) => ({ kind: "text-insert", id: "type" + value, by, target: { owner, segment: owner, field: "audioText" },
  at: { left: flowBaseReference(owner, "audioText", offset - 1), right: null, affinity: "after" }, content: [{ value, marks: [] }] });


test("the list note names a created beat only when a later heading-finalize names it as its empty first beat", () => {
  const ops = lines(last, "Alice", finish), [created, finalized, removed] = ops;
  assert.ok(created?.kind === "segment-create" && finalized?.kind === "heading-finalize" && removed);
  assert.deepEqual([...sharedOperationListNotes(ops).emptyFirstBeats], [[created.beat, "R1"]]);
  assert.deepEqual([...sharedOperationListNotes([created]).emptyFirstBeats], []);
  assert.deepEqual([...sharedOperationListNotes([finalized, created, removed]).emptyFirstBeats], []);
  assert.deepEqual([...sharedOperationListNotes([created, { ...finalized, emptyBeat: null }, removed]).emptyFirstBeats], []);
});

const blank = { kind: "segment-create", id: "blank", by: "Alice", segment: "Xn", beat: "Xn", at: { left: "R0", right: null, affinity: "after" }, fields: { audioText: "", status: "todo" } };
const placements = {
  "the empty first beat of a finalized last line goes after the line": { source: last, ops: lines(last, "Alice", finish),
    expected: { rows: [["R0", "x"], ["Xa", ""]], sections: [["Ha", "Ab", "Xa"]], recovery: [] } },
  "a created beat with no later finalization stays after the earlier beat": { source: last, ops: [blank],
    expected: { rows: [["R0", "x"], ["Xa", ""], ["R1", "# Ab"]], sections: [], recovery: [] } }
};
for (const [name, { source, ops, expected }] of Object.entries(placements)) test(name, () => {
  const { set, handles } = setup(source);
  try { send(set.a, ops); set.queue.flush("D1"); agree(name, "D1", handles, visible, expected); } finally { set.close(); }
});

test("an empty first beat whose emitted left beat is not directly followed by the line is placed as before, and the list is refused unchanged", () => {
  const source = { rows: [{ id: "R0", audioText: "x" }, { id: "Rm", audioText: "m" }, { id: "R1", audioText: "# Ab", paragraphStart: true }] }, { set } = setup(source);
  try {
    const app = lines(source, "Alice", finish), [created, ...rest] = app; assert.ok(created?.kind === "segment-create");
    assert.deepEqual(created.at, { left: "Rm", right: null, affinity: "after" });
    const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
    const result = executeSharedOperations(set.a, [{ ...created, at: { ...created.at, left: "R0" } }, ...rest], { base: revision });
    assert.ok(!result.ok && "index" in result); assert.deepEqual([result.reason, result.index], ["misplaced-heading-beat", 1]);
    assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], [bytes, vector, revision]);
  } finally { set.close(); }
});

const end = () => lines(last, "Bob", (doc, ports) => startParagraph(doc, beatPos("R1", 4), ports));
const concurrent: Record<string, { readonly other: () => readonly unknown[]; readonly expected: ReturnType<typeof visible> }> = {
  "types at the end of the previous beat": { other: () => [type("Bob", "R0", 1, "Z")], expected: { rows: [["R0", "xZ"], ["Xa", ""]], sections: [["Ha", "Ab", "Xa"]], recovery: [] } },
  "types in the line": { other: () => [type("Bob", "R1", 3, "Z")], expected: { rows: [["R0", "x"], ["Xa", ""]], sections: [["Ha", "AZb", "Xa"]], recovery: [] } },
  "adds a beat at the end of the script, as a higher writer: it follows the empty first beat": { other: end, expected: { rows: [["R0", "x"], ["Xa", ""], ["Rb", ""]], sections: [["Ha", "Ab", "Xa"]], recovery: [] } },
  "finalizes the same last line: the higher heading takes the name, both empty first beats stay": { other: () => lines(last, "Bob", finish),
    expected: { rows: [["R0", "x"], ["Xa", ""], ["Xb", ""]], sections: [["Hb", "Ab", "Xa"]], recovery: [] } }
};
for (const [name, { other, expected }] of Object.entries(concurrent)) for (const order of ["D1", "rev", "dup"] as const) test(`a heading added at the end while another writer ${name}: ${order}`, () => {
  const { set, handles } = setup();
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.b, other()); send(set.a, lines(last, "Alice", finish)); set.queue.flush(order); assertIncremental(set.c, projector);
    agree(name, order, handles, visible, expected);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a heading added at the end by the higher writer while a lower writer adds a beat at the end: that beat comes first and becomes the scene's first beat: ${order}`, () => {
  const { set, handles } = setup();
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, end().map(op => ({ ...op, by: "Bob" }))); send(set.b, lines(last, "Alice", finish)); set.queue.flush(order); assertIncremental(set.c, projector);
    const swapped = new Map([[structureIdentityFixture("1", "end_o_0", "beat"), "Rb"], ["Xb", "Xa"], ["Hb", "Ha"]]);
    agree("swapped", order, handles, handle => JSON.parse(JSON.stringify(visible(handle), (_, value: unknown) => typeof value === "string" ? swapped.get(value) ?? value : value)) as ReturnType<typeof visible>,
      { rows: [["R0", "x"], ["Rb", ""], ["Xa", ""]], sections: [["Ha", "Ab", "Rb"]], recovery: [] });
  } finally { set.close(); }
});

test("a refusal later in a last-line list leaves bytes, vector and revision unchanged", () => {
  const { set } = setup();
  try {
    const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
    const result = executeSharedOperations(set.a, [...lines(last, "Alice", finish), operation(type("Alice", "R9", 1, "Z"))], { base: revision });
    assert.ok(!result.ok && "index" in result); assert.deepEqual([result.reason, result.index], ["missing-target", 3]);
    assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], [bytes, vector, revision]);
  } finally { set.close(); }
});

test("rule 44: finishing a heading on a beat split off a removed beat by a writer who had not seen the removal refuses as on the flagged beat, unchanged", () => {
  const source = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab<br># Cd", paragraphStart: true }, { id: "R2", audioText: "ef", paragraphStart: true }] }, { set } = setup(source);
  try {
    send(set.a, [{ kind: "remove", id: "gone", by: "Alice", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 7)], boundaries: ["R1"], components: [], gallery: [], at: 1 }]);
    send(set.b, [{ kind: "split", id: "cut", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" }, at: { left: flowBaseReference("R1", "audioText", 2), right: null, affinity: "after" },
      observed: [], boundary: "Rs", beat: "Rs", fields: {} }]);
    set.queue.flush("D1");
    const finalize = (owner: string, from: number) => [{ kind: "heading-finalize", id: "fin_o_0", by: "Bob", target: { owner, segment: owner, field: "audioText" }, heading: "Hn",
      prefix: [flowBaseReference(owner, "audioText", from, from + 2)], name: [flowBaseReference(owner, "audioText", from + 2, from + 4)], separator: [],
      tail: { left: flowBaseReference(owner, "audioText", from + 3), right: null, affinity: "after" }, retainedBeat: "R2", emptyBeat: null }];
    const refusal = (ops: readonly unknown[]) => {
      const bytes = encodeSharedState(set.b), vector = encodeSharedStateVector(set.b), revision = readSharedRevision(set.b);
      const result = executeSharedOperations(set.b, ops.map(operation), { base: revision }); assert.ok(!result.ok);
      assert.deepEqual([encodeSharedState(set.b), encodeSharedStateVector(set.b), readSharedRevision(set.b)], [bytes, vector, revision]);
      return result.reason;
    };
    assert.deepEqual([refusal(finalize(structureIdentityFixture("2", "cut", "beat"), 0)), refusal(finalize("R1", 3))], ["missing-target", "missing-target"]);
  } finally { set.close(); }
});
