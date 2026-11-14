import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBeatsCommand, splitBeatCommand, textCut } from "../../../src/application/commands/split-join.ts";
import { addBeatCommand, deleteBeatCommand } from "../../../src/application/commands/rows.ts";
import { removeBeatsCommand } from "../../../src/application/commands/beats.ts";
import { removeSceneCommand } from "../../../src/application/commands/scenes.ts";
import type { SharedStructurePorts } from "../../../src/application/commands/shared-structure.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import type { StampPorts } from "../../../src/application/session/ports.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { sharedStructurePorts } from "../../../src/bootstrap/wiring/ports/shared-values.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { createSharedDocument, applySharedUpdate, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { toPlainText } from "../../../src/core/text/projections.ts";
import { replicas, operation } from "../../adapters/collab/executor-support.ts";
import { sharedHarness, adapterReplica } from "../session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { bufferStamps } from "../../collab/buffer-readers.ts";

type Fields = Record<string, unknown>;
type Stamp = readonly [string, string | null];
type Make = (stamps: StampPorts, shared?: SharedStructurePorts) => Command;
const ORDERS = ["D1", "rev", "dup"] as const;
const at = (second: number) => "2026-11-13T10:00:0" + second + ".000Z";
const DOC = "d00000000000000000000000000000000";
const ANN: Stamp = [at(0), "Ann"], ALICE: Stamp = [at(5), "Alice"], BOB: Stamp = [at(6), "Bob"], NONE: Stamp = ["", null];
const SOURCE = { title: "Title", rows: [{ id: "R1", audioText: "abc", updatedAt: at(0), updatedBy: "Ann" }, { id: "R2", audioText: "cd", status: "ready", paragraphStart: true },
  { id: "R3", audioText: "ef" }, { id: "R4", audioText: "gh" }, { id: "R5", audioText: "ij" }], sections: [{ id: "S1", name: "Scene", firstSceneId: "R4" }] };
const runtime = createFlowLoadRuntime();
const cells = (html: string) => runtime.cells(html);

const SPLIT_A = "structure_1_00770031005f0031005f006f005f0031_beat_0", SPLIT_B = "structure_2_00770032005f0031005f006f005f0031_beat_0";
const ADD_A = "structure_1_00770031005f0031005f006f005f0030_beat_0", ADD_B = "structure_2_00770032005f0031005f006f005f0030_beat_0";

interface Shape { readonly audio?: string; readonly status?: string; readonly stamp?: Stamp; readonly flag?: boolean }
const START: Readonly<Record<string, Required<Omit<Shape, "flag">> & { readonly flag: boolean }>> = {
  R1: { audio: "abc", status: "todo", stamp: ANN, flag: false }, R2: { audio: "cd", status: "ready", stamp: NONE, flag: true },
  R3: { audio: "ef", status: "todo", stamp: NONE, flag: false }, R4: { audio: "gh", status: "todo", stamp: NONE, flag: false },
  R5: { audio: "ij", status: "todo", stamp: NONE, flag: false }
};
function beat(id: string, shape: Shape = {}): Fields {
  const start = START[id] ?? { audio: "", status: "todo", stamp: NONE, flag: false }, flag = shape.flag ?? start.flag, stamp = shape.stamp ?? start.stamp;
  return { id, status: shape.status ?? start.status, visualText: "", audioText: shape.audio ?? start.audio, imageRef: null, updatedAt: stamp[0], updatedBy: stamp[1],
    ...flag ? { paragraphStart: true } : {} };
}
function documentWith(rows: readonly Fields[], scene: string | null = "R4"): Fields {
  return { schema: 2, title: "Title", docId: DOC, rows, comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0,
    ...scene === null ? {} : { sections: [{ id: "S1", name: "Scene", firstSceneId: scene }] } };
}
const removed = (row: Fields, members: readonly string[] = [String(row.id)]) => ({ removed: row, members });
const HEADING = { removedHeading: { id: "S1", name: "Scene" } };
const startRows = () => ["R1", "R2", "R3", "R4", "R5"].map(id => beat(id));

function setup() {
  const set = replicas(2, SOURCE);
  for (const handle of [set.a, set.b, set.c]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
  return set;
}
function stampsOf(name: "Alice" | "Bob", second: number): StampPorts { return bufferStamps(name, () => at(second)); }
function ports(handle: SharedDocumentHandle, stamps: StampPorts): SharedStructurePorts {
  const author = sharedAuthorPort({ handle: () => handle, name: () => stamps.editor.name() });
  const shared = sharedStructurePorts({ handle: () => handle, author: () => author.next(), stamps, cells })();
  assert.ok(shared);
  return shared;
}
function project(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { document, recovery: recovery.map(entry => entry.kind === "removed-beat" ? removed(entry.row, entry.members)
    : entry.kind === "removed-heading" ? { removedHeading: entry.heading } : entry) };
}
function late(handle: SharedDocumentHandle) {
  const joiner = createSharedDocument();
  try { assert.equal(applySharedUpdate(joiner, encodeSharedState(handle)).ok, true); return project(joiner); } finally { destroySharedDocument(joiner); }
}
function agreeing(label: string, handles: readonly SharedDocumentHandle[], order: typeof ORDERS[number] = "D1") {
  const readings = handles.map((handle, index) => ({ order, replica: index ? "B" as const : "A" as const, output: project(handle) }));
  assertReplicasAgree(label, [...readings, { order: "late-C", replica: "C", output: late(handles[0] as SharedDocumentHandle) }]);
  return readings[0]?.output;
}
function flush(queue: ReturnType<typeof replicas>["queue"], order: typeof ORDERS[number]) {
  for (let round = 0; round < 100 && queue.pending.length; round++) {
    const messages = [...queue.pending];
    if (order === "rev") messages.reverse();
    for (const message of messages) queue.deliver(message.id, order === "dup" ? 2 : 1);
  }
  assert.equal(queue.pending.length, 0);
}
function send(handle: SharedDocumentHandle, ...values: unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function typing(owner: string) {
  return { kind: "text-insert", id: "typed", by: "Bob", target: { owner, segment: owner, field: "audioText" },
    at: { left: null, right: flowBaseReference(owner, "audioText", 0), affinity: "before" }, content: [{ value: "X", marks: [] }] };
}
function removal(owner: string) {
  const length = String(START[owner]?.audio).length;
  return { kind: "remove", id: "removed", by: "Bob", removalKind: "beat", targets: [owner], observed: [flowBaseReference(owner, "audioText", 0, length)],
    boundaries: [owner], components: [], gallery: [], at: 0 };
}
const capabilities = () => createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
function standalone(before: Fields, command: Command, created?: string): Fields {
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(before) };
  const plan = command.plan(live, capabilities());
  assert.ok(plan && !("refused" in plan) && plan.shared === undefined);
  plan.apply(live);
  const out = live as unknown as Fields;
  return created ? { ...out, rows: (out.rows as Fields[]).map(row => row.id === "N1" ? { ...row, id: created } : row) } : out;
}
const join = (stamps: StampPorts) => ({ ...stamps, cells, plainText: (html: string | null | undefined) => toPlainText(cells(html ?? "")) });
const stamp = (who: string, record: string, by: string, second: number) =>
  ({ kind: "scalar", id: who + "_stamp_0:stamp", by, target: { scope: "beat", record }, field: "stamp", value: { at: at(second), by } });
const created = (by: string, second: number) => ({ visualText: "", imageRef: null, status: "todo", stamp: { at: at(second), by } });
const flag = (who: string, by: string, record: string) => ({ kind: "scalar", target: { scope: "beat", record }, field: "paragraphStart", value: true, id: who + ":1", by });
const beatRemoval = (who: string, by: string, targets: readonly string[], lengths: readonly number[], index: number) => ({ kind: "remove", removalKind: "beat", targets,
  observed: targets.map((target, i) => flowBaseReference(target, "audioText", 0, lengths[i] as number)), boundaries: targets,
  components: targets.map(target => target + ":visual"), gallery: targets.map(target => target + ":gallery"), at: index, id: who + "_o_0", by });

interface Expectation { readonly document: Fields; readonly recovery: readonly unknown[] }
interface StructureLiteral {
  readonly name: string;
  readonly make: Make;
  readonly operations: (who: string, by: string, second: number) => readonly unknown[];
  readonly after: Expectation;
  readonly created?: string;
  readonly subject: string;
  readonly same: Expectation;
  readonly typed: Expectation;
  readonly gone: Expectation;
  readonly undone: Expectation | string;
}
const cases: readonly StructureLiteral[] = [
  { name: "split a beat's narration over a selection", make: (stamps, shared) => splitBeatCommand("R1", "audioText", textCut(1, 2), "N1", { ...stamps, cells }, shared),
    operations: (who, by, second) => [
      { kind: "text-delete", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: [flowBaseReference("R1", "audioText", 1, 2)], id: who + ":0", by },
      { kind: "split", target: { owner: "R1", segment: "R1", field: "audioText" }, at: { left: null, right: flowBaseReference("R1", "audioText", 2, 2), affinity: "before" },
        observed: [flowBaseReference("R1", "audioText", 0, 1), flowBaseReference("R1", "audioText", 2, 3)], boundary: "N1", beat: "N1", fields: created(by, second), id: who + "_o_1", by },
      stamp(who, "R1", by, second)],
    after: { document: documentWith([beat("R1", { audio: "a", stamp: ALICE }), beat(SPLIT_A, { audio: "c", stamp: ALICE }), ...startRows().slice(1)]), recovery: [] },
    created: SPLIT_A, subject: "R1",
    same: { document: documentWith([beat("R1", { audio: "a", stamp: BOB }), beat(SPLIT_A, { audio: "", stamp: ALICE }), beat(SPLIT_B, { audio: "c", stamp: BOB }),
      ...startRows().slice(1)]), recovery: [] },
    typed: { document: documentWith([beat("R1", { audio: "Xa", stamp: ALICE }), beat(SPLIT_A, { audio: "c", stamp: ALICE }), ...startRows().slice(1)]), recovery: [] },
    gone: { document: documentWith([beat(SPLIT_A, { audio: "c", stamp: ALICE }), ...startRows().slice(1)]), recovery: [removed(beat("R1", { audio: "a", stamp: ALICE }))] },
    undone: { document: documentWith([beat("R1", { stamp: ALICE }), ...startRows().slice(1)]), recovery: [] } },
  { name: "join the next beat into a beat", make: (stamps, shared) => joinBeatsCommand("R2", join(stamps), shared),
    operations: (who, by, second) => [{ kind: "join", from: "R3", into: "R2", glue: " ", id: who + "_o_0", by }, stamp(who, "R2", by, second)],
    after: { document: documentWith([beat("R1"), beat("R2", { audio: "cd ef", stamp: ALICE }), beat("R4"), beat("R5")]), recovery: [] },
    subject: "R3",
    same: { document: documentWith([beat("R1"), beat("R2", { audio: "cd ef", stamp: BOB }), beat("R4"), beat("R5")]), recovery: [] },
    typed: { document: documentWith([beat("R1"), beat("R2", { audio: "cd Xef", stamp: ALICE }), beat("R4"), beat("R5")]), recovery: [] },
    gone: { document: documentWith([beat("R1"), beat("R2", { stamp: ALICE }), beat("R4"), beat("R5")]), recovery: [removed(beat("R3"))] },
    undone: { document: documentWith([beat("R1"), beat("R2", { stamp: ALICE }), beat("R3"), beat("R4"), beat("R5")]), recovery: [] } },
  { name: "add a beat after a beat", make: (stamps, shared) => addBeatCommand("R1", "N1", stamps, shared),
    operations: (who, by, second) => [{ kind: "segment-create", segment: "N1", beat: "N1", at: { left: "R1", right: "R2", affinity: "before" },
      fields: { audioText: "", ...created(by, second) }, id: who + "_o_0", by }],
    after: { document: documentWith([beat("R1"), beat(ADD_A, { audio: "", stamp: ALICE }), ...startRows().slice(1)]), recovery: [] },
    created: ADD_A, subject: "R1",
    same: { document: documentWith([beat("R1"), beat(ADD_A, { audio: "", stamp: ALICE }), beat(ADD_B, { audio: "", stamp: BOB }), ...startRows().slice(1)]), recovery: [] },
    typed: { document: documentWith([beat("R1", { audio: "Xabc" }), beat(ADD_A, { audio: "", stamp: ALICE }), ...startRows().slice(1)]), recovery: [] },
    gone: { document: documentWith([beat(ADD_A, { audio: "", stamp: ALICE }), ...startRows().slice(1)]), recovery: [removed(beat("R1"))] },
    undone: "undo-unsupported:segment-create" },
  { name: "add a beat at the end", make: (stamps, shared) => addBeatCommand(null, "N1", stamps, shared),
    operations: (who, by, second) => [{ kind: "segment-create", segment: "N1", beat: "N1", at: { left: "R5", right: null, affinity: "after" },
      fields: { audioText: "", ...created(by, second) }, id: who + "_o_0", by }],
    after: { document: documentWith([...startRows(), beat(ADD_A, { audio: "", stamp: ALICE })]), recovery: [] },
    created: ADD_A, subject: "R5",
    same: { document: documentWith([...startRows(), beat(ADD_A, { audio: "", stamp: ALICE }), beat(ADD_B, { audio: "", stamp: BOB })]), recovery: [] },
    typed: { document: documentWith([...startRows().slice(0, 4), beat("R5", { audio: "Xij" }), beat(ADD_A, { audio: "", stamp: ALICE })]), recovery: [] },
    gone: { document: documentWith([...startRows().slice(0, 4), beat(ADD_A, { audio: "", stamp: ALICE })]), recovery: [removed(beat("R5"))] },
    undone: "undo-unsupported:segment-create" },
  { name: "delete a beat that starts a paragraph", make: (_stamps, shared) => deleteBeatCommand("R2", shared),
    operations: (who, by) => [beatRemoval(who, by, ["R2"], [2], 1), flag(who, by, "R3")],
    after: { document: documentWith([beat("R1"), beat("R3", { flag: true }), beat("R4"), beat("R5")]), recovery: [removed(beat("R2"))] },
    subject: "R2",
    same: { document: documentWith([beat("R1"), beat("R3", { flag: true }), beat("R4"), beat("R5")]), recovery: [removed(beat("R2"))] },
    typed: { document: documentWith([beat("R1"), beat("R3", { flag: true }), beat("R4"), beat("R5")]), recovery: [removed(beat("R2", { audio: "Xcd" }))] },
    gone: { document: documentWith([beat("R1"), beat("R3", { flag: true }), beat("R4"), beat("R5")]), recovery: [removed(beat("R2"))] },
    undone: { document: documentWith(startRows()), recovery: [] } },
  { name: "delete the first beat of a scene", make: (_stamps, shared) => deleteBeatCommand("R4", shared),
    operations: (who, by) => [beatRemoval(who, by, ["R4"], [2], 3)],
    after: { document: documentWith([beat("R1"), beat("R2"), beat("R3"), beat("R5")], "R5"), recovery: [removed(beat("R4"))] },
    subject: "R4",
    same: { document: documentWith([beat("R1"), beat("R2"), beat("R3"), beat("R5")], "R5"), recovery: [removed(beat("R4"))] },
    typed: { document: documentWith([beat("R1"), beat("R2"), beat("R3"), beat("R5")], "R5"), recovery: [removed(beat("R4", { audio: "Xgh" }))] },
    gone: { document: documentWith([beat("R1"), beat("R2"), beat("R3"), beat("R5")], "R5"), recovery: [removed(beat("R4"))] },
    undone: { document: documentWith(startRows()), recovery: [] } },
  { name: "remove two beats", make: (_stamps, shared) => removeBeatsCommand(["R3", "R2"], shared),
    operations: (who, by) => [beatRemoval(who, by, ["R2", "R3"], [2, 2], 1)],
    after: { document: documentWith([beat("R1"), beat("R4"), beat("R5")]), recovery: [removed(beat("R2")), removed(beat("R3"))] },
    subject: "R2",
    same: { document: documentWith([beat("R1"), beat("R4"), beat("R5")]), recovery: [removed(beat("R2")), removed(beat("R3"))] },
    typed: { document: documentWith([beat("R1"), beat("R4"), beat("R5")]), recovery: [removed(beat("R2", { audio: "Xcd" })), removed(beat("R3"))] },
    gone: { document: documentWith([beat("R1"), beat("R4"), beat("R5")]), recovery: [removed(beat("R2")), removed(beat("R3"))] },
    undone: { document: documentWith(startRows()), recovery: [] } },
  { name: "remove a scene header", make: (_stamps, shared) => removeSceneCommand("S1", shared),
    operations: (who, by) => [{ kind: "heading-remove", heading: "S1", observed: [flowBaseReference("S1", "heading", 0, 5)], newBeat: null, nextBeat: "R4", id: who + "_o_0", by },
      flag(who, by, "R4")],
    after: { document: documentWith([beat("R1"), beat("R2"), beat("R3"), beat("R4", { flag: true }), beat("R5")], null), recovery: [HEADING] },
    subject: "R4",
    same: { document: documentWith([beat("R1"), beat("R2"), beat("R3"), beat("R4", { flag: true }), beat("R5")], null), recovery: [HEADING] },
    typed: { document: documentWith([beat("R1"), beat("R2"), beat("R3"), beat("R4", { audio: "Xgh", flag: true }), beat("R5")], null), recovery: [HEADING] },
    gone: { document: documentWith([beat("R1"), beat("R2"), beat("R3"), beat("R5")], null), recovery: [removed(beat("R4", { flag: true })), HEADING] },
    undone: { document: documentWith(startRows()), recovery: [] } }
];
const run = (handle: SharedDocumentHandle, literal: { readonly make: Make }, who: "Alice" | "Bob", second: number) => {
  const stamps = stampsOf(who, second);
  return literal.make(stamps, ports(handle, stamps));
};

for (const literal of cases) test(`shared structure command literal: ${literal.name}`, () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    const before = project(h.a).document;
    assert.deepEqual(before, documentWith(startRows()));
    assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [literal.operations("w1_1", "Alice", 5)]);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), literal.after);
    assert.deepEqual(a.session.read(doc => doc), literal.after.document);
    assert.deepEqual(b.session.read(doc => doc), literal.after.document);
    assert.deepEqual(standalone(before, literal.make(stampsOf("Alice", 5)), literal.created), literal.after.document);
  } finally { a.session.dispose(); b.session.dispose(); h.close(); }
});

for (const literal of cases) for (const order of ORDERS) {
  test(`shared structure command races the same command from the other copy: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
      assert.equal(b.session.run(run(h.b, literal, "Bob", 6)).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), literal.same);
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
  test(`shared structure command races typing in the beat it changes: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
      send(h.b, typing(literal.subject));
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), literal.typed);
    } finally { a.session.dispose(); h.close(); }
  });
  test(`shared structure command races removal of the beat it changes: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
      send(h.b, removal(literal.subject));
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), literal.gone);
    } finally { a.session.dispose(); h.close(); }
  });
}

function owned(handle: SharedDocumentHandle, label: string, operations: readonly SharedOperation[]) {
  let count = 0;
  const owner = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(handle, record, { by: "Alice", nextId: () => "u" + ++count }) });
  owner.perform(() => {
    const done = executeSharedCommand(handle, operations, { label, selection: null, typing: null }, { base: readSharedRevision(handle) });
    assert.deepEqual(done.result, { ok: true });
    return done.record;
  });
  return owner;
}
function planned(handle: SharedDocumentHandle, a: ReturnType<typeof sharedHarness>, make: Make): readonly SharedOperation[] {
  const plan = a.session.read(doc => doc ? run(handle, { make }, "Alice", 5).plan(doc, capabilities()) : null);
  assert.ok(plan && !("refused" in plan) && plan.shared);
  return plan.shared.operations as readonly SharedOperation[];
}

for (const literal of cases) for (const order of ORDERS) {
  test(`shared structure command through the undo owner: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      const owner = owned(h.a, literal.name, planned(h.a, a, literal.make));
      flush(h.queue, order);
      if (typeof literal.undone === "string") {
        assert.deepEqual(owner.undo(), { ok: false, reason: literal.undone, skipped: true });
        assert.deepEqual([owner.sizes(), owner.skipped()], [{ undo: 0, redo: 0, dropped: 0 }, 1]);
        flush(h.queue, order);
        assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), literal.after);
        return;
      }
      assert.deepEqual(owner.undo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), literal.undone);
      assert.deepEqual(owner.redo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), literal.after);
    } finally { a.session.dispose(); h.close(); }
  });
}

const collapsedSplit: Make = (stamps, shared) => splitBeatCommand("R1", "audioText", textCut(1, 1), "N1", { ...stamps, cells }, shared);
for (const literal of [{ name: "split a beat's narration at a point", make: collapsedSplit,
  after: { document: documentWith([beat("R1", { audio: "a", stamp: ALICE }), beat("structure_1_00770031005f0031005f006f005f0030_beat_0", { audio: "bc", stamp: ALICE }),
    ...startRows().slice(1)]), recovery: [] } }, ...cases.filter(literal => !literal.name.startsWith("split"))]) {
  test(`shared structure command as one list equals separate lists: ${literal.name}`, () => {
    const together = setup(), apart = setup(), a = sharedHarness(adapterReplica(together.a));
    try {
      const operations = planned(together.a, a, literal.make);
      assert.deepEqual(executeSharedOperations(together.a, operations, { base: readSharedRevision(together.a) }), { ok: true });
      for (const value of operations) assert.deepEqual(executeSharedOperations(apart.a, [value], { base: readSharedRevision(apart.a) }), { ok: true });
      assert.deepEqual(project(together.a), literal.after);
      assert.deepEqual(project(apart.a), literal.after);
    } finally { a.session.dispose(); together.close(); apart.close(); }
  });
}

test("a split with a selection is one list: its split addresses the text before the deletion, so sent apart the split is refused as stale", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    const [deletion, split] = planned(h.a, a, (cases[0] as StructureLiteral).make);
    assert.ok(deletion && split);
    const base = readSharedRevision(h.a);
    assert.deepEqual(executeSharedOperations(h.a, [deletion], { base }), { ok: true });
    assert.deepEqual(executeSharedOperations(h.a, [split], { base }), { ok: false, reason: "stale-base" });
  } finally { a.session.dispose(); h.close(); }
});

function joinedSetup() {
  const set = setup();
  send(set.a, { kind: "join", id: "joinedA", by: "Bob", from: "R2", into: "R1", glue: " " }, { kind: "join", id: "joinedB", by: "Bob", from: "R5", into: "R4", glue: " " });
  flush(set.queue, "D1");
  return set;
}
const JOINED_R1 = beat("R1", { audio: "abc cd", status: "ready" }), JOINED_R4 = beat("R4", { audio: "gh ij" });
interface JoinedLiteral { readonly name: string; readonly make: Make; readonly operations: readonly unknown[]; readonly after: Expectation; readonly created?: string }
const joinedCases: readonly JoinedLiteral[] = [
  { name: "split a joined beat inside its second part", make: (stamps, shared) => splitBeatCommand("R1", "audioText", textCut(5, 5), "N1", { ...stamps, cells }, shared),
    operations: [{ kind: "split", target: { owner: "R1", segment: "R1", field: "audioText" }, at: { left: null, right: flowBaseReference("R1", "audioText", 5, 5), affinity: "before" },
      observed: [flowBaseReference("R1", "audioText", 0, 6)], boundary: "N1", beat: "N1", fields: created("Alice", 5), id: "w1_1_o_0", by: "Alice" }, stamp("w1_1", "R1", "Alice", 5)],
    after: { document: documentWith([beat("R1", { audio: "abc c", status: "ready", stamp: ALICE }), beat(ADD_A, { audio: "d", stamp: ALICE }), beat("R3"), JOINED_R4]), recovery: [] },
    created: ADD_A },
  { name: "split a joined beat over a selection across its two parts", make: (stamps, shared) => splitBeatCommand("R1", "audioText", textCut(2, 5), "N1", { ...stamps, cells }, shared),
    operations: [{ kind: "text-delete", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: [flowBaseReference("R1", "audioText", 2, 5)], id: "w1_1:0", by: "Alice" },
      { kind: "split", target: { owner: "R1", segment: "R1", field: "audioText" }, at: { left: null, right: flowBaseReference("R1", "audioText", 5, 5), affinity: "before" },
        observed: [flowBaseReference("R1", "audioText", 0, 2), flowBaseReference("R1", "audioText", 5, 6)], boundary: "N1", beat: "N1", fields: created("Alice", 5), id: "w1_1_o_1", by: "Alice" },
      stamp("w1_1", "R1", "Alice", 5)],
    after: { document: documentWith([beat("R1", { audio: "ab", status: "ready", stamp: ALICE }), beat(SPLIT_A, { audio: "d", stamp: ALICE }), beat("R3"), JOINED_R4]), recovery: [] },
    created: SPLIT_A },
  { name: "join the next beat into a joined beat", make: (stamps, shared) => joinBeatsCommand("R1", join(stamps), shared),
    operations: [{ kind: "join", from: "R3", into: "R1", glue: " ", id: "w1_1_o_0", by: "Alice" }, stamp("w1_1", "R1", "Alice", 5)],
    after: { document: documentWith([beat("R1", { audio: "abc cd ef", status: "ready", stamp: ALICE }), JOINED_R4]), recovery: [] } },
  { name: "delete a joined beat", make: (_stamps, shared) => deleteBeatCommand("R1", shared),
    operations: [beatRemoval("w1_1", "Alice", ["R1", "R2"], [3, 2], 0)],
    after: { document: documentWith([beat("R3"), JOINED_R4]), recovery: [removed(JOINED_R1, ["R1", "R2"])] } },
  { name: "remove a joined beat and the beat after it", make: (_stamps, shared) => removeBeatsCommand(["R1", "R3"], shared),
    operations: [beatRemoval("w1_1", "Alice", ["R1", "R2", "R3"], [3, 2, 2], 0)],
    after: { document: documentWith([JOINED_R4]), recovery: [removed(JOINED_R1, ["R1", "R2"]), removed(beat("R3"))] } },
  { name: "remove the header of a scene whose first beat is joined", make: (_stamps, shared) => removeSceneCommand("S1", shared),
    operations: [{ kind: "heading-remove", heading: "S1", observed: [flowBaseReference("S1", "heading", 0, 5)], newBeat: null, nextBeat: "R4", id: "w1_1_o_0", by: "Alice" },
      flag("w1_1", "Alice", "R4")],
    after: { document: documentWith([JOINED_R1, beat("R3"), { ...JOINED_R4, paragraphStart: true }], null), recovery: [HEADING] } }
];
for (const literal of joinedCases) for (const order of ORDERS) test(`shared structure command on a joined beat: ${literal.name}, ${order}`, () => {
  const h = joinedSetup(), a = sharedHarness(adapterReplica(h.a));
  try {
    const before = project(h.a).document;
    assert.deepEqual(before, documentWith([JOINED_R1, beat("R3"), JOINED_R4]));
    assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [literal.operations]);
    flush(h.queue, order);
    assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), literal.after);
    assert.deepEqual(standalone(before, literal.make(stampsOf("Alice", 5)), literal.created), literal.after.document);
  } finally { a.session.dispose(); h.close(); }
});
for (const literal of joinedCases.filter(item => item.name.startsWith("delete") || item.name.startsWith("remove a joined"))) for (const order of ORDERS) {
  test(`shared structure command on a joined beat through the undo owner: ${literal.name}, ${order}`, () => {
    const h = joinedSetup(), a = sharedHarness(adapterReplica(h.a));
    try {
      const owner = owned(h.a, literal.name, planned(h.a, a, literal.make));
      flush(h.queue, order);
      assert.deepEqual(owner.undo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith([JOINED_R1, beat("R3"), JOINED_R4]), recovery: [] });
      assert.deepEqual(owner.redo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), literal.after);
    } finally { a.session.dispose(); h.close(); }
  });
}

test("deleting a joined beat whose second part was split off it removes both parts", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    assert.equal(a.session.run(run(h.a, { make: (stamps, shared) => splitBeatCommand("R3", "audioText", textCut(1, 1), "N1", { ...stamps, cells }, shared) }, "Alice", 5)).kind, "applied");
    assert.equal(a.session.run(run(h.a, { make: (stamps, shared) => joinBeatsCommand("R3", join(stamps), shared) }, "Alice", 5)).kind, "applied");
    const part = "structure_1_00770031005f0031005f006f005f0030_beat_0";
    assert.equal(a.session.run(run(h.a, { make: (_stamps, shared) => deleteBeatCommand("R3", shared) }, "Alice", 5)).kind, "applied");
    assert.deepEqual(a.executed.at(-1)?.operations, [beatRemoval("w1_3", "Alice", ["R3", part], [1, 1], 2)]);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing("split-off part", [h.a, h.b]),
      { document: documentWith([beat("R1"), beat("R2"), beat("R4"), beat("R5")]), recovery: [removed(beat("R3", { audio: "e f", stamp: ALICE }), ["R3", part])] });
  } finally { a.session.dispose(); h.close(); }
});

test("a visual split in a shared session is refused by name with nothing sent; standalone still splits", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    const make: Make = (stamps, shared) => splitBeatCommand("R1", "visualText", textCut(0, 0), "N1", { ...stamps, cells }, shared);
    assert.deepEqual(a.session.read(doc => doc ? run(h.a, { make }, "Alice", 5).plan(doc, capabilities()) : null), { refused: "visual-split-in-shared-session" });
    const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(documentWith(startRows())) };
    const plan = make(stampsOf("Alice", 5)).plan(live, capabilities());
    assert.ok(plan && !("refused" in plan) && plan.shared === undefined);
  } finally { a.session.dispose(); h.close(); }
});

test("structure commands with no author, or no shared ports, plan as before and ask no author when nothing changes", () => {
  let asked = 0;
  const counting: SharedStructurePorts = { author: () => { asked++; return { id: "w9_1", by: "Alice" }; }, cells,
    beatStamp: () => { throw new Error("no stamp expected"); }, joinedParts: () => { throw new Error("no parts expected"); } };
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(documentWith(startRows())) };
  const stamps = stampsOf("Alice", 5);
  for (const command of [splitBeatCommand("R9", "audioText", textCut(0, 0), "N1", { ...stamps, cells }, counting), splitBeatCommand("R1", "status", textCut(0, 0), "N1", { ...stamps, cells }, counting),
    joinBeatsCommand("R5", join(stamps), counting), addBeatCommand("R9", "N1", stamps, counting), deleteBeatCommand("R9", counting), removeBeatsCommand(["R9"], counting),
    removeSceneCommand("S9", counting)]) {
    assert.equal(command.plan(live, capabilities()), null, command.name);
  }
  assert.deepEqual(joinBeatsCommand("R3", join(stamps), counting).plan(live, capabilities()), { refused: "remove the scene header before joining these beats" });
  assert.equal(asked, 0);
  const nobody: SharedStructurePorts = { ...counting, author: () => null };
  for (const literal of cases) {
    const plan = literal.make(stamps, nobody).plan(live, capabilities());
    assert.ok(plan && !("refused" in plan) && plan.shared === undefined, literal.name);
  }
  assert.ok(sharedStructurePorts({ handle: () => null, author: () => ({ id: "w9_1", by: "Alice" }), stamps, cells })() === null, "structure ports in a standalone session");
});
