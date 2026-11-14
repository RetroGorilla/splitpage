import { test } from "node:test";
import assert from "node:assert/strict";
import { addShotCommand, addShotPropCommand, deleteShotCommand, removeShotPropCommand, setShotsCommand } from "../../../src/application/commands/broll-records.ts";
import { addPersonCommand, deletePersonCommand, deleteTagsCommand, gearQuickAddCommand, registerTagCommand, updateTagsCommand } from "../../../src/application/commands/production-records.ts";
import type { SharedRecordPorts } from "../../../src/application/commands/shared-records.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import { sharedRecordPorts } from "../../../src/bootstrap/wiring/ports/shared-records.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { createSharedDocument, applySharedUpdate, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { sharedRegistryOperations } from "../../../src/core/collab/record-operations.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { replicas, operation } from "../../adapters/collab/executor-support.ts";
import { sharedHarness, adapterReplica } from "../session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";

type Fields = Record<string, unknown>;
type Who = "Alice" | "Bob";
const ORDERS = ["D1", "rev", "dup"] as const;
const D = "t_i9fk0si5uyzl", M = "t_1okou1ndmeusp", LAMP = "t_1gv2lyyv6wgsc", PARK = "t_1nbmjmii3klpi", CRANE = "t_19yaunzw2av0d", CUP = "t_omzgqc181rmzb";
const ANN = { id: "p1", name: "Ann" }, BOB = { id: "p2", name: "Bob" };
const DRONE = { id: D, cat: "gear", name: "Drone", owner: "p1", notes: "", status: "needed" };
const MUG = { id: M, cat: "prop", name: "Mug", owner: "", notes: "", status: "needed" };
const CITY = { id: "b1", name: "City", desc: "", status: "unshot", reshoot: false, notes: "", owner: "p1", audioRef: "", location: "", props: [{ id: M, name: "Mug" }], origin: "list" };
const PARK_SHOT = { id: "b2", name: "Park", desc: "", status: "unshot", owner: "", origin: "list", props: [] };
const SOURCE = {
  rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }],
  people: [ANN, BOB],
  productionTags: [DRONE, MUG],
  brollShots: [{ id: "b1", name: "City", desc: "", status: "unshot", owner: "p1", origin: "list", props: [{ id: M, name: "Mug" }] }]
};
const STAMPS = { clock: { nowIso: () => "2026-11-13T12:00:00.000Z" }, editor: { name: () => "Alice" } };
const ids = (who: Who) => ({ id: (prefix: string) => prefix + (who === "Alice" ? "a9" : "b9"), docId: () => "d" });

interface Registries { readonly people?: readonly Fields[]; readonly tags?: readonly Fields[]; readonly shots?: readonly Fields[] }
function row(id: string, audioText: string): Fields {
  return { id, status: "todo", visualText: "", audioText, imageRef: null, updatedAt: "", updatedBy: null };
}
function documentWith(records: Registries, rows: readonly Fields[] = [row("R1", "ab"), row("R2", "cd")]): Fields {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows, comments: [],
    people: records.people ?? [ANN, BOB], productionTags: records.tags ?? [DRONE, MUG], brollShots: records.shots ?? [CITY], wordsPerMinute: 150, rev: 0 };
}

const create = (index: number, collection: string, record: string, fields: Fields) => ({ kind: "record-create", id: "w1_1:" + index, by: "Alice", target: { collection, record }, fields });
const set = (index: number, collection: string, record: string, field: string, value: unknown) => ({ kind: "record-set", id: "w1_1:" + index, by: "Alice", target: { collection, record }, field, value });
const remove = (index: number, collection: string, record: string) => ({ kind: "record-delete", id: "w1_1:" + index, by: "Alice", target: { collection, record } });
const status = (index: number, scope: string, record: string, value: string, parents: readonly string[] = []) => ({ kind: "status", id: "w1_1:" + index, by: "Alice", target: { scope, record }, value, parents });

interface RecordLiteral {
  readonly name: string;
  readonly make: (shared: SharedRecordPorts | undefined, who: Who) => Command;
  readonly operations: readonly unknown[];
  readonly after: Registries;
  readonly twice: Registries;
}

const quickAdd = () => ({ added: 1, removed: 1, remove: ["Drone"], register: [{ id: CRANE, cat: "gear", name: "Crane", owner: "", notes: "", status: "needed" as const }] });

const cases: readonly RecordLiteral[] = [
  { name: "add a shot", make: s => addShotCommand(structuredClone(PARK_SHOT), s),
    operations: [create(0, "shots", "b2", { status: "unshot", name: "Park", desc: "", owner: "", origin: "list", props: [], rank: "0000000001", extra: "{}" })],
    after: { shots: [CITY, PARK_SHOT] }, twice: { shots: [CITY, PARK_SHOT] } },
  { name: "change a shot's status and notes", make: s => setShotsCommand(["b1"], { status: "shot", notes: "late" }, undefined, undefined, s),
    operations: [set(0, "shots", "b1", "notes", "late"), status(1, "shot", "b1", "shot")],
    after: { shots: [{ ...CITY, status: "shot", notes: "late" }] }, twice: { shots: [{ ...CITY, status: "shot", notes: "late" }] } },
  { name: "set a field the shot table does not store", make: s => setShotsCommand(["b1"], { mood: "calm" }, undefined, undefined, s),
    operations: [set(0, "shots", "b1", "extra", "{\"mood\":\"calm\"}")],
    after: { shots: [{ ...CITY, mood: "calm" }] }, twice: { shots: [{ ...CITY, mood: "calm" }] } },
  { name: "give a shot a new owner", make: (s, who) => setShotsCommand(["b1"], {}, { name: "Cy" }, ids(who), s),
    operations: [create(0, "people", "pa9", { name: "Cy", rank: "0000000002", extra: "{}" }), set(1, "shots", "b1", "owner", "pa9")],
    after: { people: [ANN, BOB, { id: "pa9", name: "Cy" }], shots: [{ ...CITY, owner: "pa9" }] },
    twice: { people: [ANN, BOB, { id: "pa9", name: "Cy" }, { id: "pb9", name: "Cy" }], shots: [{ ...CITY, owner: "pb9" }] } },
  { name: "delete a shot", make: s => deleteShotCommand("b1", s),
    operations: [remove(0, "shots", "b1")], after: { shots: [] }, twice: { shots: [] } },
  { name: "add a prop to a shot", make: s => addShotPropCommand("b1", "Lamp", s),
    operations: [create(0, "tags", LAMP, { status: "needed", cat: "prop", name: "Lamp", owner: "", notes: "", rank: "0000000002", extra: "{}" }),
      set(1, "shots", "b1", "props", [{ id: M, name: "Mug" }, { id: LAMP, name: "Lamp" }])],
    after: { tags: [DRONE, MUG, { id: LAMP, cat: "prop", name: "Lamp", owner: "", notes: "", status: "needed" }], shots: [{ ...CITY, props: [{ id: M, name: "Mug" }, { id: LAMP, name: "Lamp" }] }] },
    twice: { tags: [DRONE, MUG, { id: LAMP, cat: "prop", name: "Lamp", owner: "", notes: "", status: "needed" }], shots: [{ ...CITY, props: [{ id: M, name: "Mug" }, { id: LAMP, name: "Lamp" }] }] } },
  { name: "remove a prop from a shot", make: s => removeShotPropCommand("b1", M, s),
    operations: [set(0, "shots", "b1", "props", [])], after: { shots: [{ ...CITY, props: [] }] }, twice: { shots: [{ ...CITY, props: [] }] } },
  { name: "register a tag", make: s => registerTagCommand({ cat: "location", name: "Park" }, s),
    operations: [create(0, "tags", PARK, { status: "needed", cat: "location", name: "Park", owner: "", notes: "", rank: "0000000002", extra: "{}" })],
    after: { tags: [DRONE, MUG, { id: PARK, cat: "location", name: "Park", owner: "", notes: "", status: "needed" }] },
    twice: { tags: [DRONE, MUG, { id: PARK, cat: "location", name: "Park", owner: "", notes: "", status: "needed" }] } },
  { name: "add a person", make: (s, who) => addPersonCommand("Cy", ids(who), s),
    operations: [create(0, "people", "pa9", { name: "Cy", rank: "0000000002", extra: "{}" })],
    after: { people: [ANN, BOB, { id: "pa9", name: "Cy" }] }, twice: { people: [ANN, BOB, { id: "pa9", name: "Cy" }, { id: "pb9", name: "Cy" }] } },
  { name: "update tags and register one", make: (s, who) => updateTagsCommand([{ cat: "gear", name: "Drone" }, { cat: "prop", name: "Cup" }], { status: "have", owner: { id: "p2" }, notes: "spare" }, ids(who), s),
    operations: [set(0, "tags", D, "owner", "p2"), set(1, "tags", D, "notes", "spare"), status(2, "tag", D, "have"),
      create(3, "tags", CUP, { status: "have", cat: "prop", name: "Cup", owner: "p2", notes: "spare", rank: "0000000002", extra: "{}" })],
    after: { tags: [{ ...DRONE, owner: "p2", notes: "spare", status: "have" }, MUG, { id: CUP, cat: "prop", name: "Cup", owner: "p2", notes: "spare", status: "have" }] },
    twice: { tags: [{ ...DRONE, owner: "p2", notes: "spare", status: "have" }, MUG, { id: CUP, cat: "prop", name: "Cup", owner: "p2", notes: "spare", status: "have" }] } },
  { name: "advance a tag's status", make: (s, who) => updateTagsCommand([{ cat: "gear", name: "Drone" }], { status: { next: true } }, ids(who), s),
    operations: [status(0, "tag", D, "sourcing")], after: { tags: [{ ...DRONE, status: "sourcing" }, MUG] }, twice: { tags: [{ ...DRONE, status: "sourcing" }, MUG] } },
  { name: "delete a person", make: s => deletePersonCommand("p1", s),
    operations: [remove(0, "people", "p1"), set(1, "tags", D, "owner", ""), set(2, "shots", "b1", "owner", "")],
    after: { people: [BOB], tags: [{ ...DRONE, owner: "" }, MUG], shots: [{ ...CITY, owner: "" }] },
    twice: { people: [BOB], tags: [{ ...DRONE, owner: "" }, MUG], shots: [{ ...CITY, owner: "" }] } },
  { name: "delete a tag that labels no text", make: s => deleteTagsCommand([{ cat: "gear", name: "Drone", unlabel: false }], () => [], STAMPS, s),
    operations: [remove(0, "tags", D)], after: { tags: [MUG] }, twice: { tags: [MUG] } },
  { name: "quick-add gear", make: s => gearQuickAddCommand(quickAdd, s),
    operations: [create(0, "tags", CRANE, { status: "needed", cat: "gear", name: "Crane", owner: "", notes: "", rank: "0000000002", extra: "{}" }), remove(1, "tags", D)],
    after: { tags: [MUG, { id: CRANE, cat: "gear", name: "Crane", owner: "", notes: "", status: "needed" }] },
    twice: { tags: [MUG, { id: CRANE, cat: "gear", name: "Crane", owner: "", notes: "", status: "needed" }] } }
];

function setup() {
  const set = replicas(2, SOURCE);
  for (const handle of [set.a, set.b, set.c]) registerSharedOperationFamilies(handle, { cells: createFlowLoadRuntime().cells });
  return set;
}
function ports(handle: SharedDocumentHandle, name: Who): SharedRecordPorts {
  const author = sharedAuthorPort({ handle: () => handle, name: () => name });
  return sharedRecordPorts({ handle: () => handle, author: () => author.next() });
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
    at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, content: [{ value: "X", marks: [] }] };
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

for (const literal of cases) test(`shared record command literal: ${literal.name}`, () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    const before = project(h.a).document;
    assert.deepEqual(before, documentWith({}));
    assert.equal(a.session.run(literal.make(ports(h.a, "Alice"), "Alice")).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [literal.operations]);
    flush(h.queue, "D1");
    const expected = documentWith(literal.after);
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: expected, recovery: [] });
    assert.deepEqual(a.session.read(doc => doc), expected);
    assert.deepEqual(b.session.read(doc => doc), expected);
    assert.deepEqual(standalone(before, literal.make(undefined, "Alice")), expected);
  } finally { a.session.dispose(); b.session.dispose(); h.close(); }
});

for (const literal of cases) for (const order of ORDERS) {
  test(`shared record command races typing in a beat: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(literal.make(ports(h.a, "Alice"), "Alice")).kind, "applied");
      send(h.b, typing());
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith(literal.after, [row("R1", "abX"), row("R2", "cd")]), recovery: [] });
    } finally { a.session.dispose(); h.close(); }
  });
  test(`shared record command races removal of a beat: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(literal.make(ports(h.a, "Alice"), "Alice")).kind, "applied");
      send(h.b, removal());
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith(literal.after, [row("R2", "cd")]), recovery: [{ removed: row("R1", "ab") }] });
    } finally { a.session.dispose(); h.close(); }
  });
  test(`shared record command races the same command from the other copy: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(literal.make(ports(h.a, "Alice"), "Alice")).kind, "applied");
      assert.equal(b.session.run(literal.make(ports(h.b, "Bob"), "Bob")).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith(literal.twice), recovery: [] });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
}

for (const literal of cases) test(`shared record command as one list equals separate lists: ${literal.name}`, () => {
  const together = setup(), apart = setup();
  try {
    send(together.a, ...literal.operations);
    for (const value of literal.operations) send(apart.a, value);
    const expected = { document: documentWith(literal.after), recovery: [] };
    assert.deepEqual(project(together.a), expected);
    assert.deepEqual(project(apart.a), expected);
  } finally { together.close(); apart.close(); }
});

for (const literal of cases) test(`shared record command undo and redo: ${literal.name}`, () => {
  const h = setup();
  try {
    const execution = executeSharedCommand(h.a, literal.operations.map(operation) as SharedOperation[], { label: literal.name, selection: null, typing: null }, { base: readSharedRevision(h.a) });
    assert.deepEqual(execution.result, { ok: true });
    assert.ok(execution.record);
    let count = 0;
    const undone = reverseSharedUndoRecord(h.a, execution.record, { by: "Alice", nextId: () => "undo-" + ++count });
    assert.ok(undone.ok, JSON.stringify(undone));
    assert.equal(undone.effective, true);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing(literal.name, [h.a, h.b])?.document, documentWith({}));
    assert.ok(undone.inverse);
    const redone = reverseSharedUndoRecord(h.a, undone.inverse, { by: "Alice", nextId: () => "redo-" + ++count });
    assert.ok(redone.ok, JSON.stringify(redone));
    flush(h.queue, "D1");
    assert.deepEqual(agreeing(literal.name, [h.a, h.b])?.document, documentWith(literal.after));
  } finally { h.close(); }
});

for (const order of ORDERS) {
  test(`deleting a person while the other copy makes them a tag's owner keeps the owner and lists it for recovery: ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(deletePersonCommand("p1", ports(h.a, "Alice"))).kind, "applied");
      assert.equal(b.session.run(updateTagsCommand([{ cat: "prop", name: "Mug" }], { owner: { id: "p1" } }, ids("Bob"), ports(h.b, "Bob"))).kind, "applied");
      assert.deepEqual(b.executed.map(entry => entry.operations), [[{ kind: "record-set", id: "w2_1:0", by: "Bob", target: { collection: "tags", record: M }, field: "owner", value: "p1" }]]);
      flush(h.queue, order);
      assert.deepEqual(agreeing("owner", [h.a, h.b], order), {
        document: documentWith({ people: [BOB], tags: [{ ...DRONE, owner: "" }, { ...MUG, owner: "p1" }], shots: [{ ...CITY, owner: "" }] }),
        recovery: [{ kind: "deleted-person", person: "p1", name: "Ann", by: "Alice", owners: [{ collection: "tags", record: M }], mentions: [] }]
      });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
  test(`deleting a person while the other copy adds a shot they own lists that shot for recovery: ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(deletePersonCommand("p1", ports(h.a, "Alice"))).kind, "applied");
      assert.equal(b.session.run(addShotCommand({ ...structuredClone(PARK_SHOT), owner: "p1" }, ports(h.b, "Bob"))).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing("shot owner", [h.a, h.b], order), {
        document: documentWith({ people: [BOB], tags: [{ ...DRONE, owner: "" }, MUG], shots: [{ ...CITY, owner: "" }, { ...PARK_SHOT, owner: "p1" }] }),
        recovery: [{ kind: "deleted-person", person: "p1", name: "Ann", by: "Alice", owners: [{ collection: "shots", record: "b2" }], mentions: [] }]
      });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
  test(`two copies registering different tags at once keep both, ordered by record: ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(registerTagCommand({ cat: "location", name: "Park" }, ports(h.a, "Alice"))).kind, "applied");
      assert.equal(b.session.run(registerTagCommand({ cat: "prop", name: "Lamp" }, ports(h.b, "Bob"))).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing("ranks", [h.a, h.b], order), { document: documentWith({ tags: [DRONE, MUG,
        { id: LAMP, cat: "prop", name: "Lamp", owner: "", notes: "", status: "needed" },
        { id: PARK, cat: "location", name: "Park", owner: "", notes: "", status: "needed" }] }), recovery: [] });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
}

test("a second status change names the first as its parent", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    const shared = ports(h.a, "Alice");
    assert.equal(a.session.run(updateTagsCommand([{ cat: "gear", name: "Drone" }], { status: { next: true } }, ids("Alice"), shared)).kind, "applied");
    assert.equal(a.session.run(updateTagsCommand([{ cat: "gear", name: "Drone" }], { status: { next: true } }, ids("Alice"), shared)).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [[status(0, "tag", D, "sourcing")],
      [{ kind: "status", id: "w1_2:0", by: "Alice", target: { scope: "tag", record: D }, value: "have", parents: ["[\"1\",\"w1_1:0\"]"] }]]);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing("heads", [h.a, h.b]), { document: documentWith({ tags: [{ ...DRONE, status: "have" }, MUG] }), recovery: [] });
  } finally { a.session.dispose(); h.close(); }
});

test("deleting a tag whose labels need a text rewrite is refused by name and writes nothing", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    const before = encodeSharedState(h.a);
    const command = deleteTagsCommand([{ cat: "gear", name: "Drone", unlabel: true }], () => [{ rowId: "R1", field: "audioText", html: "a" }], STAMPS, ports(h.a, "Alice"));
    assert.deepEqual(a.session.run(command), { kind: "rejected", reason: "tag-text-rewrite" });
    assert.deepEqual(a.executed, []);
    assert.deepEqual(encodeSharedState(h.a), before);
  } finally { a.session.dispose(); h.close(); }
});

test("record commands that change nothing, or run without an author, ask for no author and plan no shared operations", () => {
  let asked = 0;
  const counting: SharedRecordPorts = { author: () => { asked++; return { id: "w9_1", by: "Alice" }; }, ranks: () => [], heads: () => [] };
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(documentWith({})) };
  const idle = [
    registerTagCommand({ cat: "gear", name: "Drone" }, counting), addPersonCommand("Ann", ids("Alice"), counting), deleteShotCommand("b9", counting),
    setShotsCommand(["b1"], { status: "unshot" }, undefined, undefined, counting), deletePersonCommand("p9", counting),
    gearQuickAddCommand(() => ({ added: 0, removed: 0, remove: [], register: [] }), counting),
    deleteTagsCommand([{ cat: "gear", name: "Crane", unlabel: false }], () => [], STAMPS, counting),
    addShotPropCommand("b9", "Lamp", counting), removeShotPropCommand("b1", LAMP, counting), addShotCommand({ ...structuredClone(CITY) }, counting),
    updateTagsCommand([{ cat: "gear", name: "Drone" }], { notes: "" }, ids("Alice"), counting)
  ];
  assert.deepEqual(idle.map(command => command.plan(live, capabilities())), idle.map(() => null));
  assert.equal(asked, 0);
  const reads: string[] = [];
  const nobody: SharedRecordPorts = { author: () => null, ranks: collection => { reads.push(collection); return []; }, heads: scope => { reads.push(scope); return []; } };
  const planned = cases.map(literal => {
    try {
      const plan = literal.make(nobody, "Alice").plan(live, capabilities());
      return plan && !("refused" in plan) && plan.shared === undefined ? "plain" : "shared";
    } catch (error) { return String(error); }
  });
  assert.deepEqual(planned, cases.map(() => "plain"));
  assert.deepEqual(reads, []);
});

test("the registry diff refuses lists it cannot state as record operations", () => {
  const edit = (before: Fields[], after: Fields[]) => sharedRegistryOperations({ before: { people: before, tags: [], shots: [] }, after: { people: after, tags: [], shots: [] },
    ranks: () => [], heads: () => [], author: { id: "w1_1", by: "Alice" } });
  assert.deepEqual(edit([ANN, BOB], [BOB, ANN]), { refused: "records-reordered" });
  assert.deepEqual(edit([ANN], [ANN, { name: "Cy" }]), { refused: "records-without-id" });
  assert.deepEqual(edit([ANN, ANN], [ANN]), { refused: "records-without-id" });
  assert.deepEqual(sharedRegistryOperations({ before: { people: [], tags: [null], shots: [] }, after: { people: [], tags: [], shots: [] },
    ranks: () => [], heads: () => [], author: { id: "w1_1", by: "Alice" } }), { refused: "records-without-id" });
});

test("the registry diff clears a stored field the edit drops and sets one it changes", () => {
  assert.deepEqual(sharedRegistryOperations({ before: { people: [], tags: [{ ...MUG, notes: "chipped" }], shots: [] }, after: { people: [], tags: [{ id: M, cat: "prop", name: "Cup", owner: "", status: "needed" }], shots: [] },
    ranks: () => [], heads: () => [], author: { id: "w1_1", by: "Alice" } }), { operations: [
    { kind: "record-set", id: "w1_1:0", by: "Alice", target: { collection: "tags", record: M }, field: "name", value: "Cup" },
    { kind: "record-set", id: "w1_1:1", by: "Alice", target: { collection: "tags", record: M }, field: "notes", clear: true }] });
});

test("the registry diff ranks new records after the highest stored rank", () => {
  const added = (ranks: readonly string[]) => sharedRegistryOperations({ before: { people: [], tags: [], shots: [] },
    after: { people: [{ id: "p7", name: "Di", colour: "red" }, { id: "p8", name: "Ed" }], tags: [], shots: [] },
    ranks: () => ranks, heads: () => [], author: { id: "w1_1", by: "Alice" } });
  const person = (index: number, record: string, name: string, rank: string, extra: string) => ({ kind: "record-create", id: "w1_1:" + index, by: "Alice", target: { collection: "people", record }, fields: { name, rank, extra } });
  assert.deepEqual(added([]), { operations: [person(0, "p7", "Di", "0000000000", "{\"colour\":\"red\"}"), person(1, "p8", "Ed", "0000000001", "{}")] });
  assert.deepEqual(added(["0000000004", "0000000012", "0000000003"]), { operations: [person(0, "p7", "Di", "0000000013", "{\"colour\":\"red\"}"), person(1, "p8", "Ed", "0000000014", "{}")] });
  assert.deepEqual(added(["9999999999"]), { operations: [person(0, "p7", "Di", "9999999999V", "{\"colour\":\"red\"}"), person(1, "p8", "Ed", "9999999999VV", "{}")] });
  assert.deepEqual(added(["5"]), { operations: [person(0, "p7", "Di", "5V", "{\"colour\":\"red\"}"), person(1, "p8", "Ed", "5VV", "{}")] });
});
