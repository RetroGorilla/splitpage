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
    beatStamp: () => { throw new Error("no stamp expected"); }, statusHeads: () => { throw new Error("no heads expected"); },
    statusParts: () => { throw new Error("no parts expected"); } };
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

function alice(handle: SharedDocumentHandle, make: (stamps: StampPorts, shared?: SharedValuePorts) => Command): Command {
  const stamps = stampsOf("Alice", 5);
  return make(stamps, ports(handle, stamps));
}
function joinedSetup(second: string) {
  const set = replicas(2, { title: "Title", rows: [{ id: "R1", audioText: "ab", status: "todo", lengthSeconds: 5, updatedAt: at(0), updatedBy: "Ann" },
    { id: "R2", audioText: "cd", status: second, lengthSeconds: 9 }] });
  for (const handle of [set.a, set.b, set.c]) registerSharedOperationFamilies(handle, { cells: createFlowLoadRuntime().cells });
  const joins = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart, reverse: record => reverseSharedUndoRecord(set.a, record, { by: "Bob", nextId: () => "unjoined" }) });
  joins.perform(() => {
    const done = executeSharedCommand(set.a, [operation({ kind: "join", id: "joined", by: "Bob", from: "R2", into: "R1", glue: " " })],
      { label: "join", selection: null, typing: null }, { base: readSharedRevision(set.a) });
    assert.deepEqual(done.result, { ok: true });
    return done.record;
  });
  flush(set.queue, "D1");
  return { set, unjoin: () => { assert.deepEqual(joins.undo(), { ok: true, effective: true, label: "join", selection: null }); flush(set.queue, "D1"); } };
}
function partRow(id: "R1" | "R2", status: string, audio: string, stamp: readonly [string, string | null], length: number): Fields {
  return { id, status, visualText: "", audioText: audio, imageRef: null, updatedAt: stamp[0], updatedBy: stamp[1], lengthSeconds: length };
}
function partsDocument(rows: readonly Fields[]): Fields {
  return { schema: 2, title: "Title", docId: DOC, rows, comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 };
}
const ANN = [at(0), "Ann"] as const, NOBODY = ["", null] as const;
const joinedDocument = (status: string, stamp: readonly [string, string | null] = ANN, length = 5) => partsDocument([partRow("R1", status, "ab cd", stamp, length)]);
const status2 = (value: string) => [status("w1_1", "Alice", value), { ...status("w1_1", "Alice", value), id: "w1_1:status:1", target: { scope: "beat", record: "R2" } }];

interface JoinedLiteral {
  readonly name: string; readonly second: string; readonly make: (stamps: StampPorts, shared?: SharedValuePorts) => Command;
  readonly operations: readonly unknown[]; readonly before: Fields; readonly after: Fields;
}
const joinedCases: readonly JoinedLiteral[] = [
  { name: "cycle the status of a joined beat that shows its second part's shot", second: "shot", make: (stamps, shared) => beatStatusCommand("R1", stamps, shared),
    operations: [...status2("todo"), stamp("w1_1", "Alice", 5)], before: joinedDocument("shot"), after: joinedDocument("todo", ALICE) },
  { name: "mark filmed a joined beat that shows its second part's ready", second: "ready", make: (stamps, shared) => setBeatFilmedCommand("R1", true, stamps, shared),
    operations: [...status2("shot"), stamp("w1_1", "Alice", 5)], before: joinedDocument("ready"), after: joinedDocument("shot", ALICE) },
  { name: "mark not filmed a joined beat that shows its second part's shot", second: "shot", make: (stamps, shared) => setBeatFilmedCommand("R1", false, stamps, shared),
    operations: [...status2("todo"), stamp("w1_1", "Alice", 5)], before: joinedDocument("shot"), after: joinedDocument("todo", ALICE) },
  { name: "set the length of a joined beat, which shows its first part's length", second: "shot", make: (stamps, shared) => beatLengthCommand("R1", 7, stamps, shared),
    operations: [scalar("w1_1", "Alice", beat, "lengthSeconds", 7), stamp("w1_1", "Alice", 5)], before: joinedDocument("shot"), after: joinedDocument("shot", ALICE, 7) }
];

for (const literal of joinedCases) for (const order of ORDERS) {
  test(`shared value command on a joined beat ends where standalone does: ${literal.name}, ${order}`, () => {
    const { set } = joinedSetup(literal.second), a = sharedHarness(adapterReplica(set.a));
    try {
      const before = project(set.a).document;
      assert.deepEqual(before, literal.before);
      assert.equal(a.session.run(alice(set.a, literal.make)).kind, "applied");
      assert.deepEqual(a.executed.map(entry => entry.operations), [literal.operations]);
      flush(set.queue, order);
      assert.deepEqual(agreeing(literal.name, [set.a, set.b], order), { document: literal.after, recovery: [] });
      assert.deepEqual(standalone(before, literal.make(stampsOf("Alice", 5))), literal.after);
    } finally { a.session.dispose(); set.close(); }
  });
  test(`shared value command on a joined beat through the undo owner: undo shows the joined beat as before, redo as after: ${literal.name}, ${order}`, () => {
    const { set } = joinedSetup(literal.second), a = sharedHarness(adapterReplica(set.a));
    try {
      const plan = a.session.read(doc => doc ? alice(set.a, literal.make).plan(doc, capabilities()) : null);
      assert.ok(plan && !("refused" in plan) && plan.shared);
      const operations = plan.shared.operations as readonly SharedOperation[];
      let count = 0;
      const owner = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
        reverse: record => reverseSharedUndoRecord(set.a, record, { by: "Alice", nextId: () => "u" + ++count }) });
      owner.perform(() => {
        const done = executeSharedCommand(set.a, operations, { label: literal.name, selection: null, typing: null }, { base: readSharedRevision(set.a) });
        assert.deepEqual(done.result, { ok: true });
        return done.record;
      });
      flush(set.queue, order);
      assert.deepEqual(owner.undo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(set.queue, order);
      assert.deepEqual(agreeing(literal.name, [set.a, set.b], order), { document: { ...literal.before, rows: [{ ...(literal.before.rows as Fields[])[0], updatedAt: ALICE[0], updatedBy: ALICE[1] }] }, recovery: [] });
      assert.deepEqual(owner.redo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(set.queue, order);
      assert.deepEqual(agreeing(literal.name, [set.a, set.b], order), { document: literal.after, recovery: [] });
    } finally { a.session.dispose(); set.close(); }
  });
}

for (const order of ORDERS) test(`a status written to a joined beat stays on both parts after the join is undone: ${order}`, () => {
  const { set, unjoin } = joinedSetup("shot"), a = sharedHarness(adapterReplica(set.a));
  try {
    assert.equal(a.session.run(alice(set.a, (joinedCases[0] as JoinedLiteral).make)).kind, "applied");
    flush(set.queue, order);
    unjoin();
    assert.deepEqual(agreeing("unjoined", [set.a, set.b], order),
      { document: partsDocument([partRow("R1", "todo", "ab", ALICE, 5), partRow("R2", "todo", "cd", NOBODY, 9)]), recovery: [] });
  } finally { a.session.dispose(); set.close(); }
});

interface UnjoinedLiteral { readonly name: string; readonly second: string; readonly make: (stamps: StampPorts, shared?: SharedValuePorts) => Command; readonly r1: string }
const unjoinedCases: readonly UnjoinedLiteral[] = [
  { name: "cycle the first part's status", second: "shot", make: (stamps, shared) => beatStatusCommand("R1", stamps, shared), r1: "ready" },
  { name: "mark the first part filmed", second: "ready", make: (stamps, shared) => setBeatFilmedCommand("R1", true, stamps, shared), r1: "shot" }
];
for (const literal of unjoinedCases) for (const order of ORDERS) {
  test(`after the join is undone a status command writes the first part only: ${literal.name}, ${order}`, () => {
    const { set, unjoin } = joinedSetup(literal.second), a = sharedHarness(adapterReplica(set.a));
    try {
      unjoin();
      const before = project(set.a).document, untouched = partRow("R2", literal.second, "cd", NOBODY, 9);
      assert.deepEqual(before, partsDocument([partRow("R1", "todo", "ab", ANN, 5), untouched]));
      assert.equal(a.session.run(alice(set.a, literal.make)).kind, "applied");
      assert.deepEqual(a.executed.map(entry => entry.operations), [[status("w1_1", "Alice", literal.r1), stamp("w1_1", "Alice", 5)]]);
      flush(set.queue, order);
      const expected = partsDocument([partRow("R1", literal.r1, "ab", ALICE, 5), untouched]);
      assert.deepEqual(agreeing(literal.name, [set.a, set.b], order), { document: expected, recovery: [] });
      assert.deepEqual(standalone(before, literal.make(stampsOf("Alice", 5))), expected);
    } finally { a.session.dispose(); set.close(); }
  });
  test(`after the join is undone a status command undoes and redoes through the owner: ${literal.name}, ${order}`, () => {
    const { set, unjoin } = joinedSetup(literal.second), a = sharedHarness(adapterReplica(set.a));
    try {
      unjoin();
      const plan = a.session.read(doc => doc ? alice(set.a, literal.make).plan(doc, capabilities()) : null);
      assert.ok(plan && !("refused" in plan) && plan.shared);
      const operations = plan.shared.operations as readonly SharedOperation[];
      let count = 0;
      const owner = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
        reverse: record => reverseSharedUndoRecord(set.a, record, { by: "Alice", nextId: () => "u" + ++count }) });
      owner.perform(() => {
        const done = executeSharedCommand(set.a, operations, { label: literal.name, selection: null, typing: null }, { base: readSharedRevision(set.a) });
        assert.deepEqual(done.result, { ok: true });
        return done.record;
      });
      flush(set.queue, order);
      const untouched = partRow("R2", literal.second, "cd", NOBODY, 9);
      assert.deepEqual(owner.undo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(set.queue, order);
      assert.deepEqual(agreeing(literal.name, [set.a, set.b], order), { document: partsDocument([partRow("R1", "todo", "ab", ALICE, 5), untouched]), recovery: [] });
      assert.deepEqual(owner.redo(), { ok: true, effective: true, label: literal.name, selection: null });
      flush(set.queue, order);
      assert.deepEqual(agreeing(literal.name, [set.a, set.b], order), { document: partsDocument([partRow("R1", literal.r1, "ab", ALICE, 5), untouched]), recovery: [] });
    } finally { a.session.dispose(); set.close(); }
  });
}

test("after the join is undone, marking a first part that is not filmed as not filmed plans nothing", () => {
  const { set, unjoin } = joinedSetup("shot"), a = sharedHarness(adapterReplica(set.a));
  try {
    unjoin();
    assert.ok(a.session.read(doc => doc ? setBeatFilmedCommand("R1", false, stampsOf("Alice", 5), ports(set.a, stampsOf("Alice", 5))).plan(doc, capabilities()) : "missing") === null);
  } finally { a.session.dispose(); set.close(); }
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
