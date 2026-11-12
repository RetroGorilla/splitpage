import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_KINDS, REENTERED } from "../../../src/application/session/shared-session.ts";
import type { Command, CommandOutcome } from "../../../src/application/session/document-session.ts";
import type { SessionChange } from "../../../src/application/session/change-set.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, observeSharedTransactions, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import type { SharedDocumentHandle, SharedTransactionOrigin } from "../../../src/adapters/collab/types.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { operation, ref } from "../../adapters/collab/executor-support.ts";
import { createMonitoredSharedDocument, deliveryReplica, validatedFixture } from "../../adapters/collab/helpers.ts";
import { recordReplicas } from "../../adapters/collab/record-support.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";
import { adapterReplica, registerSplits, sharedCommand, sharedHarness } from "./shared-session-support.ts";
import type { SharedHarness } from "./shared-session-support.ts";

const NOTHING = { whole: false, cells: [], rowsInserted: [], rowsRemoved: [], rowsMoved: false, runsMoved: false, docFields: [], derive: [], saveNow: false };
const WHOLE = { ...NOTHING, whole: true };
const LENGTH = { ...NOTHING, cells: [{ rowId: "R1", field: "lengthSeconds" }] };
const NARRATION = { ...NOTHING, cells: [{ rowId: "R2", field: "audioText" }] };
const HEADING = { ...NOTHING, docFields: ["sections"] };
const PEOPLE = { ...NOTHING, docFields: ["people"] };
const DOCUMENT = "d00000000000000000000000000000000";

const SOURCE = {
  title: "Title",
  rows: [{ id: "R1", audioText: "abZ", status: "todo" }, { id: "R2", audioText: "cd", status: "todo" }],
  sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }],
  productionTags: [{ id: "t_1", cat: "prop", name: "Cup", status: "needed" }],
  brollShots: [{ id: "S1", name: "Cup", status: "unshot", origin: "list" }]
};

function settled(parts: { length?: number; status?: string; second: string; people: unknown[]; heading: string; pace?: number }): Record<string, unknown> {
  return {
    schema: 2,
    title: "Title",
    docId: DOCUMENT,
    rows: [
      { id: "R1", status: parts.status ?? "todo", visualText: "", audioText: "abZ", imageRef: null, updatedAt: "", updatedBy: null,
        ...(parts.length === undefined ? {} : { lengthSeconds: parts.length }) },
      { id: "R2", status: "todo", visualText: "", audioText: parts.second, imageRef: null, updatedAt: "", updatedBy: null }
    ],
    comments: [],
    people: parts.people,
    productionTags: [{ id: "t_1", cat: "prop", name: "Cup", owner: "", notes: "", status: "needed" }],
    brollShots: [{ id: "S1", name: "Cup", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "list" }],
    wordsPerMinute: parts.pace ?? 150,
    rev: 0,
    sections: [{ id: "H1", name: parts.heading, firstSceneId: "R1" }]
  };
}

interface Seat {
  handle: SharedDocumentHandle;
  h: SharedHarness;
  updates: () => number;
}

function seat(handle: SharedDocumentHandle): Seat {
  let updates = 0;
  registerSharedTextOperationHandlers(handle);
  collabState(handle).doc.on("update", () => { updates++; });
  return { handle, h: sharedHarness(adapterReplica(handle)), updates: () => updates };
}

function world() {
  const run = recordReplicas(2, SOURCE);
  const a = seat(run.a), b = seat(run.b);
  return { run, a, b, close: () => { a.h.session.dispose(); b.h.session.dispose(); run.close(); } };
}

function length(by: string, id: string, seconds: number, row = "R1"): Command {
  return sharedCommand("length", [operation({ kind: "scalar", id, by, target: { scope: "beat", record: row }, field: "lengthSeconds", value: seconds })]);
}

function typed(seat: Seat, by: string, id: string, at: number, text: string): Command {
  const target = { segment: ref("b:R2"), owner: ref("R2"), field: "audioText" as const };
  const right = createSharedAnchor(seat.handle, target, at, "after");
  assert.ok(right);
  return sharedCommand("type", [operation({ kind: "text-insert", id, by, target, at: { left: null, right, affinity: "before" }, content: [{ value: text, marks: [] }] })]);
}

function headed(seat: Seat, by: string, id: string, at: number, text: string): Command {
  const target = { segment: ref("h:H1"), owner: ref("H1"), field: "heading" as const };
  const right = createSharedAnchor(seat.handle, target, at, "after");
  assert.ok(right);
  return sharedCommand("heading", [operation({ kind: "text-insert", id, by, target, at: { left: null, right, affinity: "before" }, content: [{ value: text, marks: [] }] })]);
}

function person(by: string, id: string, key: string, name: string): Command {
  return sharedCommand("person", [operation({ kind: "record-create", id, by, target: { collection: "people", record: key }, fields: { id: key, name } })]);
}

function untouched(seat: Seat): void {
  assert.deepEqual(seat.h.undo, []);
  assert.deepEqual(seat.h.executed, []);
  assert.deepEqual(seat.h.log.filter(entry => entry !== "project" && !entry.startsWith("publish:")), []);
  assert.deepEqual([seat.h.session.generation(), seat.h.clock.armed()], [0, 0]);
}

test("hydration: the plain document arriving is one adoption of the whole document, with no undo entry, effect or operation", () => {
  const handle = createMonitoredSharedDocument();
  try {
    const owner = seat(handle);
    assert.deepEqual([owner.h.session.epoch(), owner.h.session.revision(), owner.h.session.read(doc => doc)], [0, 0, null]);
    hydrateSharedDocument(handle, validatedFixture(SOURCE));
    assert.deepEqual(owner.h.published, [{ kind: "adopt", epoch: 1, generation: 0, changes: WHOLE }]);
    assert.deepEqual(owner.h.log, ["project", "publish:adopt"]);
    untouched(owner);
    assert.deepEqual(owner.h.session.read(doc => doc), settled({ second: "cd", people: [], heading: "Scene" }));
    assert.equal(owner.updates(), 1);
  } finally { destroySharedDocument(handle); }
});

test("local command: each kind of operation is one execute, one edit and the precise set; the other replica reports the same set as one remote change", () => {
  const w = world();
  try {
    const cases: [Command, Record<string, unknown>][] = [
      [length("A", "o1", 7), LENGTH],
      [sharedCommand("status", [operation({ kind: "status", id: "o2", by: "A", target: { scope: "beat", record: "R1" }, value: "ready", parents: [] })]), { ...NOTHING, cells: [{ rowId: "R1", field: "status" }] }],
      [typed(w.a, "A", "o3", 1, "X"), NARRATION],
      [headed(w.a, "A", "o4", 5, "!"), HEADING],
      [person("A", "o5", "P1", "Ann"), PEOPLE],
      [sharedCommand("pace", [operation({ kind: "scalar", id: "o6", by: "A", target: { scope: "document", record: DOCUMENT }, field: "wordsPerMinute", value: 180 })]), { ...NOTHING, docFields: ["wordsPerMinute"] }]
    ];
    cases.forEach(([command, changes], index) => {
      assert.deepEqual(w.a.h.session.run(command), { kind: "applied", generation: index + 1, changes }, command.name);
      assert.deepEqual(w.a.h.published.at(-1), { kind: "edit", epoch: 1, generation: index + 1, changes }, command.name);
      assert.equal(w.a.h.published.length, index + 1);
      w.run.queue.flush("D1");
      assert.deepEqual(w.b.h.published.at(-1), { kind: "remote", epoch: 1, generation: 0, changes }, command.name);
      assert.equal(w.b.h.published.length, index + 1);
    });
    assert.deepEqual(w.a.h.undo.map(entry => entry.changes), cases.map(([, changes]) => changes));
    assert.deepEqual(w.a.h.executed.length, 6);
    assert.deepEqual(w.a.h.log.slice(0, 8), ["project", "execute", "project", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
    untouched(w.b);
    assert.deepEqual(w.run.queue.history.filter(entry => entry.startsWith("enqueue B")), []);
    const expected = settled({ length: 7, status: "ready", second: "cXd", people: [{ id: "P1", name: "Ann" }], heading: "Scene!", pace: 180 });
    assert.deepEqual(w.a.h.session.read(doc => doc), expected);
    assert.deepEqual(w.b.h.session.read(doc => doc), expected);
    assert.deepEqual([w.a.updates(), w.b.updates()], [6, 6]);
  } finally { w.close(); }
});

test("split: one transaction names the shortened cell and the inserted beat on both replicas; the test entry port rewrites the beat's writer-scoped id", () => {
  const w = world();
  try {
    registerSplits(w.a.handle);
    registerSplits(w.b.handle);
    const target = { segment: ref("b:R1"), owner: ref("R1"), field: "audioText" as const };
    const changes = { ...NOTHING, cells: [{ rowId: "R1", field: "audioText" }], rowsInserted: ["structure1enterbeat"] };
    const outcome = w.a.h.session.run(sharedCommand("split", [operation({ kind: "split", id: "enter", by: "A", target,
      at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, observed: [flowBaseReference("R1", "audioText", 0, 3)],
      boundary: "same-boundary", beat: "same-beat", fields: { status: "todo" } })]));
    assert.deepEqual(outcome, { kind: "applied", generation: 1, changes });
    w.run.queue.flush("D1");
    assert.deepEqual(w.a.h.published, [{ kind: "edit", epoch: 1, generation: 1, changes }]);
    assert.deepEqual(w.b.h.published, [{ kind: "remote", epoch: 1, generation: 0, changes }]);
    untouched(w.b);
    const rows = [
      { id: "R1", status: "todo", visualText: "", audioText: "ab", imageRef: null, updatedAt: "", updatedBy: null },
      { id: "structure1enterbeat", status: "todo", visualText: "", audioText: "Z", imageRef: null, updatedAt: "", updatedBy: null },
      { id: "R2", status: "todo", visualText: "", audioText: "cd", imageRef: null, updatedAt: "", updatedBy: null }
    ];
    assert.deepEqual(w.a.h.session.read(doc => doc?.rows), rows);
    assert.deepEqual(w.b.h.session.read(doc => doc?.rows), rows);
    for (const made of [w.a, w.b]) assert.deepEqual(projectSharedDocument(made.handle).rows.map(row => row.id), ["R1", "[\"structure\",\"1\",\"enter\",\"beat\"]", "R2"]);
    assert.deepEqual([w.a.updates(), w.b.updates()], [1, 1]);
  } finally { w.close(); }
});

test("paint-time base: an observer told of a received update before the owner still reads the old document with the old revision; once published, both have moved together", () => {
  const run = recordReplicas(2, SOURCE);
  const seen: unknown[] = [];
  let pair: () => unknown = () => "no owner";
  const stop = observeSharedTransactions(run.b, origin => { seen.push(["observer", origin, readSharedRevision(run.b), pair()]); });
  const a = seat(run.a), b = seat(run.b);
  pair = () => b.h.session.readAt((doc, revision) => [revision, doc?.rows[0]?.["lengthSeconds"] ?? null]);
  b.h.session.subscribe(() => { seen.push(["subscriber", readSharedRevision(run.b), pair()]); });
  try {
    assert.deepEqual([readSharedRevision(run.b), pair()], [1, [1, null]]);
    assert.deepEqual(a.h.session.run(length("A", "o1", 7)), { kind: "applied", generation: 1, changes: LENGTH });
    assert.deepEqual(seen, []);
    run.queue.flush("D1");
    assert.deepEqual(seen, [["observer", "remote", 2, [1, null]], ["subscriber", 2, [2, 7]]]);
    assert.deepEqual([readSharedRevision(run.b), pair()], [2, [2, 7]]);
  } finally { stop(); a.h.session.dispose(); b.h.session.dispose(); run.close(); }
});

const LENGTH_SECOND = { ...NOTHING, cells: [{ rowId: "R2", field: "lengthSeconds" }] };

function twoUpdates(handle: SharedDocumentHandle, writer: Seat): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const stop = deliveryReplica(handle).onLocalUpdate(update => { updates.push(update); });
  assert.deepEqual(writer.h.session.run(length("A", "o1", 7)), { kind: "applied", generation: 1, changes: LENGTH });
  assert.deepEqual(writer.h.session.run(length("A", "o2", 9, "R2")), { kind: "applied", generation: 2, changes: LENGTH_SECOND });
  stop();
  assert.equal(updates.length, 2);
  return updates;
}

function pairOf(made: Pick<Seat, "h">, handle: SharedDocumentHandle): unknown {
  return made.h.session.readAt((doc, revision) => [revision, readSharedRevision(handle), doc?.rows.map(row => row["lengthSeconds"] ?? null)]);
}

test("regression: an update an earlier observer applies while the owner's replica is notifying is held; each revision is published with exactly its own change", () => {
  const run = recordReplicas(2, SOURCE);
  const pending: Uint8Array[] = [], nested: unknown[] = [], seen: unknown[] = [];
  const stop = observeSharedTransactions(run.b, () => { const next = pending.shift(); if (next) nested.push(applySharedUpdate(run.b, next)); });
  const a = seat(run.a), b = seat(run.b);
  b.h.session.subscribe(change => { seen.push([change.changes.cells, pairOf(b, run.b)]); });
  try {
    const [first, second] = twoUpdates(run.a, a);
    assert.ok(first && second);
    pending.push(second);
    assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
    assert.deepEqual(nested, [{ ok: true }]);
    assert.deepEqual(seen, [
      [[{ rowId: "R1", field: "lengthSeconds" }], [2, 2, [7, null]]],
      [[{ rowId: "R2", field: "lengthSeconds" }], [3, 3, [7, 9]]]
    ]);
    assert.deepEqual(b.h.published, [
      { kind: "remote", epoch: 1, generation: 0, changes: LENGTH },
      { kind: "remote", epoch: 1, generation: 0, changes: LENGTH_SECOND }
    ]);
    assert.deepEqual([b.updates(), pairOf(b, run.b)], [2, [3, 3, [7, 9]]]);
    untouched(b);
  } finally { stop(); a.h.session.dispose(); b.h.session.dispose(); run.close(); }
});

test("regression: an update one owner's subscriber applies before a second owner has received the first is held; both owners publish one exact change per revision", () => {
  const run = recordReplicas(2, SOURCE);
  const pending: Uint8Array[] = [], nested: unknown[] = [], seen: unknown[] = [];
  const a = seat(run.a), b = seat(run.b), later = { h: sharedHarness(adapterReplica(run.b)) };
  b.h.session.subscribe(() => { const next = pending.shift(); if (next) nested.push(applySharedUpdate(run.b, next)); });
  later.h.session.subscribe(change => { seen.push([change.changes.cells, pairOf(later, run.b)]); });
  try {
    const [first, second] = twoUpdates(run.a, a);
    assert.ok(first && second);
    pending.push(second);
    assert.deepEqual(applySharedUpdate(run.b, first), { ok: true });
    assert.deepEqual(nested, [{ ok: true }]);
    assert.deepEqual(seen, [
      [[{ rowId: "R1", field: "lengthSeconds" }], [2, 2, [7, null]]],
      [[{ rowId: "R2", field: "lengthSeconds" }], [3, 3, [7, 9]]]
    ]);
    const expected = [
      { kind: "remote", epoch: 1, generation: 0, changes: LENGTH },
      { kind: "remote", epoch: 1, generation: 0, changes: LENGTH_SECOND }
    ];
    assert.deepEqual(b.h.published, expected);
    assert.deepEqual(later.h.published, expected);
    assert.deepEqual([pairOf(b, run.b), pairOf(later, run.b)], [[3, 3, [7, 9]], [3, 3, [7, 9]]]);
  } finally { a.h.session.dispose(); b.h.session.dispose(); later.h.session.dispose(); run.close(); }
});

test("declared limit, the test entry mints a record from received text: a remote B-roll line leaves the shared shot collection empty, yet the held document gains a shot and the change names brollShots", () => {
  const run = recordReplicas(2, { title: "Title", rows: [{ id: "R1", audioText: "ab", visualText: "Steam", status: "todo" }] });
  const a = seat(run.a), b = seat(run.b);
  try {
    const target = { owner: ref("R1"), segment: ref("R1"), field: "visualText" as const };
    const changes = { ...NOTHING, cells: [{ rowId: "R1", field: "visualText" }], docFields: ["brollShots"] };
    const outcome = a.h.session.run(sharedCommand("visual", [operation({ kind: "text-insert", id: "v1", by: "A", target,
      at: { left: null, right: flowBaseReference("R1", "visualText", 0), affinity: "before" }, content: [{ value: "B-roll: ", marks: [] }] })]));
    assert.deepEqual(outcome, { kind: "applied", generation: 1, changes });
    run.queue.flush("D1");
    assert.deepEqual(b.h.published, [{ kind: "remote", epoch: 1, generation: 0, changes }]);
    assert.deepEqual(b.h.executed, []);
    for (const made of [a, b]) {
      assert.deepEqual(projectSharedDocument(made.handle).brollShots, []);
      assert.equal(made.h.session.read(doc => doc?.rows[0]?.visualText), "B-roll: Steam");
      const shots = made.h.session.read(doc => doc ? JSON.parse(JSON.stringify(doc.brollShots)) as Record<string, unknown>[] : []);
      assert.equal(shots.length, 1);
      assert.match(String(shots[0]?.["id"]), /^bs-load-[0-9a-f]+-1$/);
      assert.deepEqual({ ...shots[0], id: "" }, { id: "", name: "Steam", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "ab", location: "", props: [], origin: "script" });
    }
    assert.deepEqual([a.updates(), b.updates()], [1, 1]);
  } finally { a.h.session.dispose(); b.h.session.dispose(); run.close(); }
});

const ADAPTER_ORIGIN_KINDS: Record<SharedTransactionOrigin, string> = {
  "hydration": "adopt",
  "local-command": "edit",
  "local-undo": "replay",
  "remote": "remote",
  "cleanup": "remote"
};

test("origins: the owner's table names every origin the adapter can emit; an adapter undo is a replay and a transaction the adapter cannot name is reported", () => {
  assert.deepEqual(ORIGIN_KINDS, ADAPTER_ORIGIN_KINDS);
  const w = world();
  try {
    transactSharedDocument(w.a.handle, "local-undo", () => { collabState(w.a.handle).doc.getMap("outside").set("k", 1); });
    assert.deepEqual(w.a.h.published, [{ kind: "replay", epoch: 1, generation: 1, changes: NOTHING }]);
    assert.deepEqual(w.a.h.undo, []);
    assert.deepEqual(w.a.h.log, ["project", "project", "dirty:1", "draft:1", "save:1", "publish:replay"]);
    assert.deepEqual(w.a.h.reported, []);
    collabState(w.a.handle).doc.transact(() => { collabState(w.a.handle).doc.getMap("outside").set("k", 2); }, "someone else");
    assert.deepEqual(w.a.h.published.slice(1), [{ kind: "remote", epoch: 1, generation: 1, changes: NOTHING }]);
    assert.deepEqual(w.a.h.reported.map(error => (error as Error).message), ["A shared transaction had an origin the session does not recognise: null"]);
    assert.deepEqual(w.a.h.undo, []);
  } finally { w.close(); }
});

test("remote update: one remote change with the precise set; undo depth, effects, generation and stamps are untouched and the receiver writes nothing", () => {
  const w = world();
  try {
    assert.equal(w.a.h.session.run(typed(w.a, "A", "o1", 1, "X")).kind, "applied");
    const before = encodeSharedState(w.b.handle);
    w.run.queue.flush("D1");
    assert.deepEqual(w.b.h.published, [{ kind: "remote", epoch: 1, generation: 0, changes: NARRATION }]);
    assert.deepEqual(w.b.h.log, ["project", "project", "publish:remote"]);
    untouched(w.b);
    assert.notDeepEqual(encodeSharedState(w.b.handle), before);
    assert.deepEqual(encodeSharedState(w.b.handle), encodeSharedState(w.a.handle));
    assert.deepEqual(w.run.queue.history.map(entry => entry.split(" ").slice(0, 3).join(" ")), ["enqueue A1 A->B", "deliver A1 A->B"]);
    assert.deepEqual(w.b.h.session.read(doc => doc), settled({ second: "cXd", people: [], heading: "Scene" }));
  } finally { w.close(); }
});

test("duplicate delivery: an update already applied becomes no change and is not projected again", () => {
  const w = world();
  try {
    assert.equal(w.a.h.session.run(length("A", "o1", 7)).kind, "applied");
    const update = w.run.queue.pending[0];
    assert.ok(update);
    w.run.queue.deliver(update.id, 3);
    assert.ok(applySharedUpdate(w.b.handle, encodeSharedState(w.a.handle)).ok);
    assert.deepEqual(w.b.h.published, [{ kind: "remote", epoch: 1, generation: 0, changes: LENGTH }]);
    assert.deepEqual(w.b.h.log, ["project", "project", "publish:remote"]);
    assert.deepEqual([w.b.h.session.revision(), w.b.updates()], [2, 1]);
    untouched(w.b);
  } finally { w.close(); }
});

const EXPECTED: Record<"D1" | "rev" | "dup" | "late-C", Record<"A" | "B", unknown[]>> = {
  "D1": {
    A: [["edit", 1, LENGTH], ["edit", 2, HEADING], ["remote", 2, NARRATION], ["remote", 2, PEOPLE]],
    B: [["edit", 1, NARRATION], ["edit", 2, PEOPLE], ["remote", 2, LENGTH], ["remote", 2, HEADING]]
  },
  "dup": {
    A: [["edit", 1, LENGTH], ["edit", 2, HEADING], ["remote", 2, NARRATION], ["remote", 2, PEOPLE]],
    B: [["edit", 1, NARRATION], ["edit", 2, PEOPLE], ["remote", 2, LENGTH], ["remote", 2, HEADING]]
  },
  "rev": {
    A: [["edit", 1, LENGTH], ["edit", 2, HEADING], ["remote", 2, { ...NOTHING, cells: [{ rowId: "R2", field: "audioText" }], docFields: ["people"] }]],
    B: [["edit", 1, NARRATION], ["edit", 2, PEOPLE], ["remote", 2, { ...NOTHING, cells: [{ rowId: "R1", field: "lengthSeconds" }], docFields: ["sections"] }]]
  },
  "late-C": {
    A: [["edit", 1, LENGTH], ["remote", 1, NARRATION], ["edit", 2, HEADING], ["remote", 2, PEOPLE]],
    B: [["edit", 1, NARRATION], ["remote", 1, LENGTH], ["edit", 2, PEOPLE], ["remote", 2, HEADING]]
  }
};

function told(changes: readonly SessionChange[]): unknown[] {
  return changes.map(change => [change.kind, change.generation, change.changes]);
}

test("two owners through the delivery queue, in order, reversed, duplicated and with a late joiner: each reports exactly what it received and all end equal", () => {
  const final = settled({ length: 7, second: "cXd", people: [{ id: "P1", name: "Ann" }], heading: "Scene!" });
  const readings: ReplicaReading<unknown>[] = [{ order: "D2", replica: "A", output: final }];
  for (const order of ["D1", "rev", "dup", "late-C"] as const) {
    const w = world(), late = createMonitoredSharedDocument();
    try {
      const c = seat(late);
      const first = (): void => {
        assert.equal(w.a.h.session.run(length("A", "a1", 7)).kind, "applied");
        assert.equal(w.b.h.session.run(typed(w.b, "B", "b1", 1, "X")).kind, "applied");
      };
      const second = (): void => {
        assert.equal(w.a.h.session.run(headed(w.a, "A", "a2", 5, "!")).kind, "applied");
        assert.equal(w.b.h.session.run(person("B", "b2", "P1", "Ann")).kind, "applied");
      };
      first();
      if (order === "late-C") {
        w.run.queue.flush("D1");
        w.run.queue.lateJoin("C", deliveryReplica(late), "A", encodeSharedState(w.a.handle));
        assert.deepEqual(told(c.h.published), [["adopt", 0, WHOLE]]);
        assert.equal(c.h.session.epoch(), 1);
      }
      second();
      w.run.queue.flush(order satisfies DeliveryOrder);
      assert.deepEqual(told(w.a.h.published), EXPECTED[order].A, `${order} A`);
      assert.deepEqual(told(w.b.h.published), EXPECTED[order].B, `${order} B`);
      for (const owner of [w.a, w.b]) {
        assert.equal(owner.h.published.length, owner.updates(), `${order}: one change per applied transaction`);
        assert.deepEqual(owner.h.undo.length, 2, `${order}: only the two local commands are undoable`);
        assert.deepEqual(owner.h.log.filter(entry => entry.startsWith("save:")), ["save:1", "save:2"], order);
        assert.equal(owner.h.executed.length, 2, order);
      }
      readings.push({ order, replica: "A", output: w.a.h.session.read(doc => doc) }, { order, replica: "B", output: w.b.h.session.read(doc => doc) });
      if (order === "late-C") {
        assert.deepEqual(told(c.h.published), [["adopt", 0, WHOLE], ["remote", 0, HEADING], ["remote", 0, PEOPLE]]);
        untouched(c);
        assert.equal(c.h.published.length, c.updates());
        readings.push({ order, replica: "C", output: c.h.session.read(doc => doc) });
      }
      c.h.session.dispose();
    } finally { w.close(); destroySharedDocument(late); }
  }
  assert.equal(readings.length, 10);
  assertReplicasAgree("shared session projection", readings);
});

test("refused: a stale base or a handler refusal makes no change, calls no subscriber and leaves the replica's bytes", () => {
  const w = world();
  try {
    const painted = w.a.h.session.revision();
    assert.equal(w.b.h.session.run(typed(w.b, "B", "b1", 1, "X")).kind, "applied");
    w.run.queue.flush("D1");
    const before = encodeSharedState(w.a.handle), heard = w.a.h.published.length;
    assert.deepEqual([painted, w.a.h.session.revision(), heard], [1, 2, 1]);
    const stale = sharedCommand("stale", [operation({ kind: "scalar", id: "a1", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 })], { base: painted });
    assert.deepEqual(w.a.h.session.run(stale), { kind: "rejected", reason: "stale-base" });
    assert.deepEqual(w.a.h.session.run(length("A", "a2", 7, "R9")), { kind: "rejected", reason: "missing-target" });
    const mixed = sharedCommand("mixed", [
      operation({ kind: "scalar", id: "a3", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 }),
      operation({ kind: "scalar", id: "a4", by: "A", target: { scope: "beat", record: "R9" }, field: "lengthSeconds", value: 7 })
    ]);
    assert.deepEqual(w.a.h.session.run(mixed), { kind: "rejected", reason: "missing-target" });
    assert.equal(w.a.h.published.length, heard);
    assert.deepEqual(w.a.h.undo, []);
    assert.deepEqual(w.a.h.log.filter(entry => /^(dirty|draft|save|undo)/.test(entry)), []);
    assert.deepEqual(encodeSharedState(w.a.handle), before);
    assert.deepEqual([w.a.h.session.generation(), w.a.h.session.revision(), w.a.h.executed.length], [0, 2, 3]);
    assert.deepEqual(w.run.queue.pending, []);
    assert.deepEqual(w.a.h.session.run(length("A", "a5", 7)), { kind: "applied", generation: 1, changes: LENGTH });
  } finally { w.close(); }
});

for (const during of ["edit", "remote"] as const) {
  test(`re-entry over the adapter: a command a subscriber issues while a ${during} change is delivered is rejected as reentered, nothing throws and nothing more is written`, () => {
    const w = world();
    try {
      const nested: CommandOutcome[] = [];
      const stop = w.a.h.session.subscribe(() => { nested.push(w.a.h.session.run(length("A", "nested", 99, "R2"))); });
      if (during === "edit") assert.deepEqual(w.a.h.session.run(length("A", "outer", 7)), { kind: "applied", generation: 1, changes: LENGTH });
      else {
        assert.equal(w.b.h.session.run(length("B", "outer", 7)).kind, "applied");
        w.run.queue.flush("D1");
      }
      stop();
      assert.deepEqual(nested, [{ kind: "rejected", reason: REENTERED }]);
      assert.deepEqual(w.a.h.reported, []);
      assert.equal(w.a.h.executed.length, during === "edit" ? 1 : 0);
      assert.deepEqual(w.a.h.published.map(change => [change.kind, change.changes]), [[during, LENGTH]]);
      assert.deepEqual(w.a.h.session.read(doc => doc), settled({ length: 7, second: "cd", people: [], heading: "Scene" }));
      assert.deepEqual(w.a.h.session.run(length("A", "after", 99, "R2")), { kind: "applied", generation: during === "edit" ? 2 : 1, changes: { ...NOTHING, cells: [{ rowId: "R2", field: "lengthSeconds" }] } });
    } finally { w.close(); }
  });
}
