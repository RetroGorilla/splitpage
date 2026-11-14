import { test } from "node:test";
import assert from "node:assert/strict";
import { beatStatusCommand, setBeatFilmedCommand } from "../../../src/application/commands/beat-status.ts";
import { beatLengthCommand } from "../../../src/application/commands/beat-length.ts";
import { targetLengthCommand, wordsPerMinuteCommand } from "../../../src/application/commands/document-settings.ts";
import type { SharedValuePorts } from "../../../src/application/commands/shared-values.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import type { StampPorts } from "../../../src/application/session/ports.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { sharedValuePorts } from "../../../src/bootstrap/wiring/ports/shared-values.ts";
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
import { replicas, operation } from "../../adapters/collab/executor-support.ts";
import { sharedHarness, adapterReplica } from "../session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { bufferStamps } from "../../collab/buffer-readers.ts";

type Fields = Record<string, unknown>;
type Who = "Alice" | "Bob";
const ORDERS = ["D1", "rev", "dup"] as const;
const at = (second: number) => "2026-11-13T10:00:0" + second + ".000Z";
const SOURCE = { title: "Title", targetSeconds: 60, wordsPerMinute: 150,
  rows: [{ id: "R1", audioText: "ab", status: "todo", lengthSeconds: 5, updatedAt: at(0), updatedBy: "Ann" }, { id: "R2", audioText: "cd", status: "todo" }] };

function setup() {
  const set = replicas(2, SOURCE);
  for (const handle of [set.a, set.b, set.c]) registerSharedOperationFamilies(handle, { cells: createFlowLoadRuntime().cells });
  return set;
}
function stampsOf(name: Who, second: number): StampPorts { return bufferStamps(name, () => at(second)); }
function ports(handle: SharedDocumentHandle, stamps: StampPorts): SharedValuePorts {
  const author = sharedAuthorPort({ handle: () => handle, name: () => stamps.editor.name() });
  const shared = sharedValuePorts({ handle: () => handle, author: () => author.next(), stamps })();
  assert.ok(shared);
  return shared;
}
function project(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { document, recovery: recovery.map(entry => entry.kind === "removed-beat" ? { removed: entry.row } : entry) };
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
function typing() {
  return { kind: "text-insert", id: "typed", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
    at: { left: null, right: flowBaseReference("R1", "audioText", 0), affinity: "before" }, content: [{ value: "X", marks: [] }] };
}
function removal() {
  return { kind: "remove", id: "removed", by: "Bob", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 2)],
    boundaries: ["R1"], components: [], gallery: [], at: 0 };
}
const capabilities = () => createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
function standalone(before: Fields, command: Command): Fields {
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(before) };
  const plan = command.plan(live, capabilities());
  assert.ok(plan && !("refused" in plan) && plan.shared === undefined);
  plan.apply(live);
  return live as unknown as Fields;
}

interface Shape {
  readonly status?: string; readonly length?: number | null; readonly stamp?: readonly [string, string];
  readonly audio?: string; readonly target?: number | null; readonly wpm?: number; readonly gone?: boolean;
}
function beatWith(shape: Shape): Fields {
  const [updatedAt, updatedBy] = shape.stamp ?? [at(0), "Ann"], length = shape.length === undefined ? 5 : shape.length;
  return { id: "R1", status: shape.status ?? "todo", visualText: "", audioText: shape.audio ?? "ab", imageRef: null, updatedAt, updatedBy,
    ...length === null ? {} : { lengthSeconds: length } };
}
function documentWith(shape: Shape): Fields {
  const target = shape.target === undefined ? 60 : shape.target;
  return { schema: 2, title: "Title", docId: DOC, rows: [...shape.gone ? [] : [beatWith(shape)],
    { id: "R2", status: "todo", visualText: "", audioText: "cd", imageRef: null, updatedAt: "", updatedBy: null }],
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: shape.wpm ?? 150, rev: 0, ...target === null ? {} : { targetSeconds: target } };
}

const DOC = "d00000000000000000000000000000000";
const ALICE = [at(5), "Alice"] as const, BOB = [at(6), "Bob"] as const;
const beat = { scope: "beat", record: "R1" }, document = { scope: "document", record: DOC };
const stamp = (who: string, by: string, second: number) => ({ kind: "scalar", id: who + ":stamp", by, target: beat, field: "stamp", value: { at: at(second), by } });
const scalar = (who: string, by: string, target: unknown, field: string, value: number | null) =>
  ({ kind: "scalar", id: who + ":" + field, by, target, field, ...value === null ? { clear: true } : { value } });
const status = (who: string, by: string, value: string) => ({ kind: "status", id: who + ":status", by, target: beat, value, parents: [] });

interface ValueLiteral {
  readonly name: string;
  readonly make: (stamps: StampPorts, shared?: SharedValuePorts) => Command;
  readonly operations: (who: string, by: string, second: number) => readonly unknown[];
  readonly after: Shape;
  readonly beat: boolean;
}
const cases: readonly ValueLiteral[] = [
  { name: "cycle a beat's status", make: (stamps, shared) => beatStatusCommand("R1", stamps, shared),
    operations: (who, by, second) => [status(who, by, "ready"), stamp(who, by, second)], after: { status: "ready", stamp: ALICE }, beat: true },
  { name: "mark a beat filmed", make: (stamps, shared) => setBeatFilmedCommand("R1", true, stamps, shared),
    operations: (who, by, second) => [status(who, by, "shot"), stamp(who, by, second)], after: { status: "shot", stamp: ALICE }, beat: true },
  { name: "set a beat's length", make: (stamps, shared) => beatLengthCommand("R1", 7, stamps, shared),
    operations: (who, by, second) => [scalar(who, by, beat, "lengthSeconds", 7), stamp(who, by, second)], after: { length: 7, stamp: ALICE }, beat: true },
  { name: "clear a beat's length", make: (stamps, shared) => beatLengthCommand("R1", null, stamps, shared),
    operations: (who, by, second) => [scalar(who, by, beat, "lengthSeconds", null), stamp(who, by, second)], after: { length: null, stamp: ALICE }, beat: true },
  { name: "set the target length", make: (_stamps, shared) => targetLengthCommand(90, shared),
    operations: (who, by) => [scalar(who, by, document, "targetSeconds", 90)], after: { target: 90 }, beat: false },
  { name: "clear the target length", make: (_stamps, shared) => targetLengthCommand(null, shared),
    operations: (who, by) => [scalar(who, by, document, "targetSeconds", null)], after: { target: null }, beat: false },
  { name: "set the words per minute", make: (_stamps, shared) => wordsPerMinuteCommand(180, shared),
    operations: (who, by) => [scalar(who, by, document, "wordsPerMinute", 180)], after: { wpm: 180 }, beat: false }
];
const run = (handle: SharedDocumentHandle, literal: ValueLiteral, who: Who, second: number) => {
  const stamps = stampsOf(who, second);
  return literal.make(stamps, ports(handle, stamps));
};

for (const literal of cases) test(`shared value command literal: ${literal.name}`, () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    const before = project(h.a).document;
    assert.deepEqual(before, documentWith({}));
    assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [literal.operations("w1_1", "Alice", 5)]);
    flush(h.queue, "D1");
    const expected = documentWith(literal.after);
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: expected, recovery: [] });
    assert.deepEqual(a.session.read(doc => doc), expected);
    assert.deepEqual(b.session.read(doc => doc), expected);
    assert.deepEqual(standalone(before, literal.make(stampsOf("Alice", 5))), expected);
  } finally { a.session.dispose(); b.session.dispose(); h.close(); }
});

for (const literal of cases) for (const order of ORDERS) {
  test(`shared value command races the same command from the other copy: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
      assert.equal(b.session.run(run(h.b, literal, "Bob", 6)).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith({ ...literal.after, ...literal.beat ? { stamp: BOB } : {} }), recovery: [] });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
  test(`shared value command races typing in its beat: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
      send(h.b, typing());
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith({ ...literal.after, audio: "Xab" }), recovery: [] });
    } finally { a.session.dispose(); h.close(); }
  });
  test(`shared value command races removal of its beat: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(run(h.a, literal, "Alice", 5)).kind, "applied");
      send(h.b, removal());
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order),
        { document: documentWith({ ...literal.after, gone: true }), recovery: [{ removed: beatWith(literal.after) }] });
    } finally { a.session.dispose(); h.close(); }
  });
}

for (const literal of cases) test(`shared value command as one list equals separate lists: ${literal.name}`, () => {
  const together = setup(), apart = setup(), operations = literal.operations("w1_1", "Alice", 5);
  try {
    send(together.a, ...operations);
    for (const value of operations) send(apart.a, value);
    const expected = { document: documentWith(literal.after), recovery: [] };
    assert.deepEqual(project(together.a), expected);
    assert.deepEqual(project(apart.a), expected);
  } finally { together.close(); apart.close(); }
});

for (const literal of cases) for (const order of ORDERS) {
  test(`shared value command through the undo owner: undo puts the value back and keeps the stamp, redo writes it again: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      const plan = a.session.read(doc => doc ? run(h.a, literal, "Alice", 5).plan(doc, capabilities()) : null);
      assert.ok(plan && !("refused" in plan) && plan.shared);
      const operations = plan.shared.operations as readonly SharedOperation[];
      let count = 0;
      const owner = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
        reverse: record => reverseSharedUndoRecord(h.a, record, { by: "Alice", nextId: () => "u" + ++count }) });
      owner.perform(() => {
        const done = executeSharedCommand(h.a, operations, { label: literal.name, selection: null, typing: null }, { base: readSharedRevision(h.a) });
        assert.deepEqual(done.result, { ok: true });
        return done.record;
      });
      flush(h.queue, order);
      assert.deepEqual(owner.undo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith(literal.beat ? { stamp: ALICE } : {}), recovery: [] });
      assert.deepEqual(owner.redo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith(literal.after), recovery: [] });
    } finally { a.session.dispose(); h.close(); }
  });
}

test("value commands with no author, or no shared ports, plan as before and ask no author when nothing changes", () => {
  let asked = 0;
  const counting: SharedValuePorts = { author: () => { asked++; return { id: "w9_1", by: "Alice" }; },
    beatStamp: () => { throw new Error("no stamp expected"); }, statusHeads: () => { throw new Error("no heads expected"); } };
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(documentWith({})) };
  const stamps = stampsOf("Alice", 5);
  for (const command of [beatStatusCommand("R9", stamps, counting), setBeatFilmedCommand("R1", false, stamps, counting), beatLengthCommand("R1", 5, stamps, counting),
    targetLengthCommand(60, counting), wordsPerMinuteCommand(150, counting), wordsPerMinuteCommand(20, counting)]) {
    assert.equal(command.plan(live, capabilities()), null, command.name);
  }
  assert.equal(asked, 0);
  const nobody: SharedValuePorts = { ...counting, author: () => null };
  for (const literal of cases) {
    const plan = literal.make(stamps, nobody).plan(live, capabilities());
    assert.ok(plan && !("refused" in plan) && plan.shared === undefined, literal.name);
  }
  assert.ok(sharedValuePorts({ handle: () => null, author: () => ({ id: "w9_1", by: "Alice" }), stamps })() === null, "value ports in a standalone session");
});

test("a status change after another copy's status names that copy's status as its parent", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    assert.equal(b.session.run(run(h.b, cases[0] as ValueLiteral, "Bob", 4)).kind, "applied");
    flush(h.queue, "D1");
    assert.equal(a.session.run(run(h.a, cases[0] as ValueLiteral, "Alice", 5)).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [[{ ...status("w1_1", "Alice", "shot"), parents: ["[\"2\",\"w2_1:status\"]"] }, stamp("w1_1", "Alice", 5)]]);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing("parents", [h.a, h.b]), { document: documentWith({ status: "shot", stamp: ALICE }), recovery: [] });
  } finally { a.session.dispose(); b.session.dispose(); h.close(); }
});
