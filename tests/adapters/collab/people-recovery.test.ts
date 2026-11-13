import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { createRecord, deleteRecord } from "./record-support.ts";
import { assertIncremental, captureIncrementalReplica } from "./incremental-support.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { encodeSharedState, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { sharedRecoveryDiscardOperation, sharedRecoveryPersonRestore } from "../../../src/core/collab/recovery.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { buildBenchmarkDocument, submitBenchmarkOperations } from "../../collab/benchmark-document.ts";
import { createMonitoredNativeDocument } from "./helpers.ts";

const who = (name: string) => `<span class="who-anchor" data-who="${name}" contenteditable="false">@${name}</span>`;
const SOURCE = { rows: [{ id: "R1", audioText: "one", visualText: who("ada") + " looks" }, { id: "R2", audioText: "two", visualText: "wide" }],
  people: [{ id: "P1", name: "Ada" }, { id: "P2", name: "Bo" }], productionTags: [{ id: "t_1", cat: "prop", name: "Cup", status: "needed" }] };
const COMMAND = { label: "people", selection: null, typing: null };
const writer = (by: string) => { let next = 0; return { by, nextId: () => by + "-undo-" + next++ }; };
const collabRemovalId = (id: string) => "structure_1_" + [...id].map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "_removal_0";

function send(handle: SharedDocumentHandle, ...raw: unknown[]): void {
  assert.deepEqual(executeSharedOperations(handle, raw.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function setup() {
  const set = replicas(3, SOURCE), handles = [set.a, set.b, set.c];
  for (const handle of handles) { registerSharedRecordHandlers(handle); registerSharedRemovalHandlers(handle); }
  return { set, handles, projector: captureIncrementalReplica(set.c).projector };
}
function people(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { people: (document.people ?? []).map(person => person.id), recovery: recovery.filter(entry => entry.kind === "deleted-person") };
}
const entry = (person: string, name: string, by: string, owners: readonly { collection: "tags" | "shots"; record: string }[], mentions: readonly string[]) =>
  ({ kind: "deleted-person" as const, person, name, by, owners, mentions });

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 54: a deleted person named by an @Name is listed with its kept name; a restore beside a namesake's create gives two namesakes, and undo of the deletion is accepted beside one: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    const before = encodeSharedState(set.b).length;
    const deletion = executeSharedCommand(set.b, [operation(deleteRecord("people", "P1", "Bob"))], COMMAND);
    assert.deepEqual(deletion.result, { ok: true }); assert.ok(deletion.record); set.queue.flush(order); assertIncremental(set.c, projector);
    assert.equal(encodeSharedState(set.b).length - before, -15);
    const listed = entry("P1", "Ada", "Bob", [], ["R1"]);
    agree("deleted", order, handles, people, { people: ["P2"], recovery: [listed] });
    const found = projectSharedDocumentWithRecovery(set.c).recovery.find(value => value.kind === "deleted-person"); assert.ok(found);
    const restore = sharedRecoveryPersonRestore(found, projectSharedDocumentWithRecovery(set.c).document.people ?? [], { id: "back", by: "Carol" });
    assert.ok(restore);
    const restored = executeSharedCommand(set.c, [restore], COMMAND);
    assert.deepEqual(restored.result, { ok: true }); assert.ok(restored.record);
    send(set.a, createRecord("people", "P9", { name: "ada" })); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("restored beside a namesake", order, handles, people, { people: ["P1", "P9", "P2"], recovery: [] });
    const undone = reverseSharedUndoRecord(set.c, restored.record, writer("Carol"));
    assert.ok(undone.ok && undone.effective); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("restore undone", order, handles, people, { people: ["P9", "P2"], recovery: [entry("P1", "Ada", "Carol", [], ["R1"])] });
    const back = reverseSharedUndoRecord(set.b, deletion.record, writer("Bob"));
    assert.ok(back.ok && back.effective); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("deletion undone beside a namesake", order, handles, people, { people: ["P9", "P1", "P2"], recovery: [] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 54: an owner assigned without seeing the deletion lists the person; a deletion nothing refers to is not listed, nor one named only in a removed beat: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    send(set.a, { kind: "record-set", id: "own", by: "Alice", target: { collection: "tags", record: "t_1" }, field: "owner", value: "P2" });
    send(set.b, deleteRecord("people", "P2", "Bob")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("owner kept", order, handles, people, { people: ["P1"], recovery: [entry("P2", "Bo", "Bob", [{ collection: "tags", record: "t_1" }], [])] });
    send(set.a, { kind: "record-set", id: "clear", by: "Alice", target: { collection: "tags", record: "t_1" }, field: "owner", value: "" });
    set.queue.flush(order); assertIncremental(set.c, projector);
    agree("unreferenced", order, handles, people, { people: ["P1"], recovery: [] });
    send(set.b, deleteRecord("people", "P1", "Bob"));
    send(set.a, { kind: "remove", id: "gone", by: "Alice", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 3)],
      boundaries: ["R1"], components: [], gallery: [], at: 0 }); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("named only in a removed beat", order, handles, people, { people: [], recovery: [] });
    send(set.a, { kind: "restore", id: "back", by: "Alice", removals: [collabRemovalId("gone")] }); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("beat restored", order, handles, people, { people: [], recovery: [entry("P1", "Ada", "Bob", [], ["R1"])] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`assumed rule 54: the restore builder refuses while a live person has the name, redo of a person's creation is accepted beside a namesake, and a discarded person stays hidden when it is named again: ${order}`, () => {
  const { set, handles, projector } = setup();
  try {
    send(set.b, deleteRecord("people", "P1", "Bob"));
    send(set.a, createRecord("people", "P9", { name: "ADA" })); set.queue.flush(order); assertIncremental(set.c, projector);
    const listed = projectSharedDocumentWithRecovery(set.c).recovery.find(value => value.kind === "deleted-person");
    assert.ok(listed); assert.equal(sharedRecoveryPersonRestore(listed, projectSharedDocumentWithRecovery(set.c).document.people ?? [], { id: "back", by: "Carol" }), null);
    agree("namesake", order, handles, people, { people: ["P9", "P2"], recovery: [entry("P1", "Ada", "Bob", [], ["R1"])] });
    const created = executeSharedCommand(set.b, [operation(createRecord("people", "P5", { name: "Cy" }, "Bob"))], COMMAND);
    assert.ok(created.result.ok && created.record);
    const uncreated = reverseSharedUndoRecord(set.b, created.record, writer("Bob")); assert.ok(uncreated.ok && uncreated.effective);
    send(set.a, createRecord("people", "P6", { name: "cy" })); set.queue.flush(order);
    const recreated = reverseSharedUndoRecord(set.b, uncreated.inverse, writer("Bob")); assert.ok(recreated.ok && recreated.effective);
    set.queue.flush(order); assertIncremental(set.c, projector);
    agree("creation redone beside a namesake", order, handles, people, { people: ["P5", "P6", "P9", "P2"], recovery: [entry("P1", "Ada", "Bob", [], ["R1"])] });
    const discard = sharedRecoveryDiscardOperation(listed, { id: "d", by: "Bob" }); assert.ok(discard);
    send(set.b, discard); set.queue.flush(order); assertIncremental(set.c, projector);
    transactSharedDocument(set.a, "local-command", () => {
      const visual = collabState(set.a).roots.visuals.get("R2"); assert.ok(visual instanceof Y.Map);
      const text = visual.get("text"); assert.ok(text instanceof Y.Text); text.insertEmbed(0, { w: "Ada" });
    }); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("named again", order, handles, people, { people: ["P5", "P6", "P9", "P2"], recovery: [] });
  } finally { set.close(); }
});

test("assumed rule 54: with no deleted person the @Name read does nothing; with one, a typed character reads only the changed cell at 300 beats", t => {
  const type = (segment: string, field: string, id: string) => ({ kind: "text-insert", id, by: "Writer", target: { owner: "R0", segment, field },
    at: { left: null, right: flowBaseReference("R0", field as "audioText", 2), affinity: "before" }, content: [{ value: "z", marks: [] }] });
  const readings: Record<string, unknown> = {};
  for (const deleted of [false, true]) {
    const run = buildBenchmarkDocument({ beats: 300, rounds: 1 });
    try {
      if (deleted) submitBenchmarkOperations(run.a, [deleteRecord("people", "P2", "Writer")]);
      const read: Record<string, { cells: number; units: number; keys: string[] }> = {};
      let phase = "full";
      const { projector } = captureIncrementalReplica(run.a, (kind, key, units) => {
        if (kind !== "who-scan") return;
        const into = read[phase] ??= { cells: 0, units: 0, keys: [] };
        into.cells++; into.units += units ?? 0; if (phase !== "full") into.keys.push(key);
      });
      try {
        projector.read();
        phase = "visual"; submitBenchmarkOperations(run.a, [type("R0", "visualText", "typed-visual")]); assertIncremental(run.a, projector);
        phase = "narration"; submitBenchmarkOperations(run.a, [type("b:R0", "audioText", "typed-narration")]); assertIncremental(run.a, projector);
        readings[deleted ? "deleted" : "empty"] = read;
      } finally { projector.dispose(); }
    } finally { run.close(); }
  }
  t.diagnostic(JSON.stringify(readings));
  assert.deepEqual(readings, { empty: {}, deleted: { full: { cells: 300, units: 947, keys: [] }, visual: { cells: 1, units: 12, keys: ['["R0","visualText","R0"]'] } } });
  const doc = createMonitoredNativeDocument(); doc.clientID = 2;
  const before = Y.encodeStateAsUpdate(doc).length; doc.getMap("deletedPeople").set("P1", { name: "Ada", by: "Bob" });
  assert.equal(Y.encodeStateAsUpdate(doc).length - before, 43);
  doc.destroy();
});
