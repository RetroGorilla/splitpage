import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replicas, ref, operation } from "./executor-support.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { registeredSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { destroySharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { executeSharedCommand } from "../../../src/adapters/collab/undo-executor.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { sharedRecoveryDiscardOperation } from "../../../src/core/collab/recovery.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const PORTS = { cells: createFlowLoadRuntime().cells };

const OWNERS: Readonly<Record<SharedOperation["kind"], string>> = {
  "text-insert": "text", "text-delete": "text", mark: "text",
  "record-create": "record", "record-set": "record", "record-delete": "record",
  split: "split", "split-before": "split", "segment-create": "split",
  remove: "removal", restore: "removal", "heading-remove": "removal", discard: "removal", "discard-retire": "removal",
  join: "join", "join-glue": "join", "join-retire": "join",
  "heading-create": "heading", "heading-finalize": "heading",
  "segment-move": "move refusal",
  "text-restore": "undo", "mark-retract": "undo", "status-retire": "undo", "split-retire": "undo", "split-restore": "undo",
  scalar: "executor", status: "executor"
};

function familyHandle(): SharedDocumentHandle {
  const handle = createMonitoredSharedDocument();
  registerSharedOperationFamilies(handle, PORTS);
  return handle;
}

function world(source: Record<string, unknown>) {
  const set = replicas(2, source);
  registerSharedOperationFamilies(set.a, PORTS);
  const ran: string[] = [];
  const send = (...ops: unknown[]): void => {
    const read = ops.map(operation);
    assert.deepEqual(executeSharedOperations(set.a, read, { base: readSharedRevision(set.a) }), { ok: true });
    ran.push(...read.map(op => op.kind));
  };
  return { set, a: set.a, send, ran };
}

test("every operation kind has one owner: a family the composition registers, or the executor itself", () => {
  const handle = familyHandle();
  try {
    const registered = Object.keys(registeredSharedOperationHandlers(handle)).sort();
    assert.deepEqual(registered, Object.entries(OWNERS).filter(([, owner]) => owner !== "executor").map(([kind]) => kind).sort());
    assert.deepEqual(registered, ["discard", "discard-retire", "heading-create", "heading-finalize", "heading-remove", "join", "join-glue", "join-retire",
      "mark", "mark-retract", "record-create", "record-delete", "record-set", "remove", "restore", "segment-create", "segment-move", "split",
      "split-before", "split-restore", "split-retire", "status-retire", "text-delete", "text-insert", "text-restore"]);
  } finally { destroySharedDocument(handle); }
});

test("the composition registers once: a second registration on the same handle is refused", () => {
  const handle = familyHandle();
  try {
    assert.throws(() => { registerSharedOperationFamilies(handle, PORTS); }, /Handler already registered for text-insert/);
  } finally { destroySharedDocument(handle); }
});

test("seeded list, text, records, values and creation: each kind runs on a handle built by the composition", () => {
  const { set, a, send, ran } = world({ title: "Script", rows: [{ id: "R1", audioText: "abcdefgh" }, { id: "R2", audioText: "uvwxyz" }, { id: "R3", audioText: "thirty" }] });
  try {
    const target = { owner: "R1", segment: "b:R1", field: "audioText" }, by = "Writer";
    send({ kind: "text-insert", id: "k1", by, target, at: { left: null, right: flowBaseReference("R1", "audioText", 0), affinity: "before" }, content: [{ value: "A", marks: [] }] });
    send({ kind: "mark", id: "k2", by, target, observed: [flowBaseReference("R1", "audioText", 0, 2)], mark: { kind: "b", value: true } });
    const preparation = createSharedPreparation(a);
    const occurrences = preparation.view.text(["segments", "b:R1", "text"])?.records.filter(item => item.record.type === "add").map(item => item.identity);
    preparation.close(); assert.ok(occurrences);
    send({ kind: "mark-retract", id: "k3", by, target, occurrences });
    const anchorTarget = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    const deleted = createSharedAnchor(a, anchorTarget, 6, "after"), left = createSharedAnchor(a, anchorTarget, 5, "after"); assert.ok(deleted && left);
    send({ kind: "text-delete", id: "k4", by, target, observed: [flowBaseReference("R1", "audioText", 6, 7)] });
    send({ kind: "text-restore", id: "k5", by, target, units: [{ unit: deleted, left, value: "f", marks: [] }] });
    send({ kind: "scalar", id: "k6", by, target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 12 });
    const statusTarget = { scope: "beat" as const, record: ref("R1") };
    send({ kind: "status", id: "k7", by, target: statusTarget, value: "ready", parents: readSharedStatusHeads(a, statusTarget) });
    send({ kind: "status-retire", id: "k8", by, target: statusTarget, value: "ready", event: JSON.stringify([String(collabState(a).doc.clientID), "k7"]) });
    send({ kind: "record-create", id: "k9", by, target: { collection: "people", record: "P1" }, fields: { id: "P1", name: "Ada" } });
    send({ kind: "record-set", id: "k10", by, target: { collection: "people", record: "P1" }, field: "name", value: "Ada B" });
    send({ kind: "record-delete", id: "k11", by, target: { collection: "people", record: "P1" } });
    for (const [kind, row] of [["split", "R2"], ["split-before", "R3"]] as const) send({ kind, id: "k-" + kind, by,
      target: { owner: row, segment: "b:" + row, field: "audioText" }, at: { left: null, right: flowBaseReference(row, "audioText", 2), affinity: "before" },
      observed: [], boundary: kind + "-boundary", beat: kind + "-beat", fields: { status: "todo" } });
    send({ kind: "segment-create", id: "k12", by, segment: "new-segment", beat: "new-beat", at: { left: null, right: null, affinity: "after" }, fields: { status: "todo" } });
    assert.deepEqual(ran, ["text-insert", "mark", "mark-retract", "text-delete", "text-restore", "scalar", "status", "status-retire",
      "record-create", "record-set", "record-delete", "split", "split-before", "segment-create"]);
  } finally { set.close(); }
});

test("seeded list, split undo: a split's retirement and restoration run on a handle built by the composition", () => {
  const { set, a, send, ran } = world({ rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    const target = { owner: "R1", segment: "R1", field: "audioText" };
    const split = operation({ kind: "split", id: "cut", by: "Alice", target, at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" },
      observed: [], boundary: "Rs", beat: "Rs", fields: {} });
    const done = executeSharedCommand(a, [split], { label: "split", selection: null, typing: null }, { base: readSharedRevision(a) });
    const part = done.record?.parts[0]; assert.ok(part?.kind === "beat-split");
    send({ kind: "split-retire", id: "out", by: "Alice", beat: part.beat });
    const rows = projectSharedDocumentWithRecovery(a).document.rows.map(row => row.audioText);
    send({ kind: "split-restore", id: "back", by: "Alice", beat: part.beat });
    assert.deepEqual([ran, rows, projectSharedDocumentWithRecovery(a).document.rows.map(row => row.audioText)], [["split-retire", "split-restore"], ["abcd"], ["ab", "cd"]]);
  } finally { set.close(); }
});

test("seeded list, joins: join, a separator change and a retirement run on a handle built by the composition", () => {
  const { set, send, ran } = world({ rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] });
  try {
    const joined = "structure_1_006a006f0069006e_join_0";
    send({ kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " });
    send({ kind: "join-glue", id: "glue", by: "Alice", joins: [joined], glue: "" });
    send({ kind: "join-retire", id: "unjoin", by: "Alice", joins: [joined] });
    assert.deepEqual(ran, ["join", "join-glue", "join-retire"]);
  } finally { set.close(); }
});

test("seeded list, removal and recovery: remove, discard, discard retirement and restore run on a handle built by the composition", () => {
  const { set, a, send, ran } = world({ rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    send({ kind: "remove", id: "gone", by: "Alice", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 2)],
      boundaries: ["R1"], components: [], gallery: [], at: 0 });
    const entry = projectSharedDocumentWithRecovery(a).recovery.find(item => item.kind === "removed-beat"); assert.ok(entry);
    const discard = sharedRecoveryDiscardOperation(entry, { id: "drop", by: "Bob" }); assert.ok(discard);
    send(discard);
    const [key] = [...collabState(a).roots.discards.keys()]; assert.ok(key);
    send({ kind: "discard-retire", id: "keep", by: "Bob", discard: key });
    send({ kind: "restore", id: "back", by: "Alice", removals: ["structure_1_0067006f006e0065_removal_0"] });
    assert.deepEqual([ran, projectSharedDocumentWithRecovery(a).document.rows.map(row => row.id)], [["remove", "discard", "discard-retire", "restore"], ["R1", "R2"]]);
  } finally { set.close(); }
});

test("seeded list, headings: create with a name, finalize a typed line and remove a heading on handles built by the composition", () => {
  const created = world({ rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }] });
  const finalized = world({ rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab<br>cd", paragraphStart: true }, { id: "R2", audioText: "ef" }] });
  const removed = world({ rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }], sections: [{ id: "H1", name: "In", firstSceneId: "R1" }] });
  try {
    created.send({ kind: "heading-create", id: "head", by: "Alice", segment: "Hn", heading: "Hn", firstBeat: "R1", at: { left: null, right: "R1", affinity: "before" } },
      { kind: "text-insert", id: "name", by: "Alice", target: { owner: "Hn", segment: "Hn", field: "heading" },
        at: { left: null, right: flowBaseReference("Hn", "heading", 0), affinity: "before" }, content: [{ value: "Name", marks: [] }] });
    const base = (from: number, to = from) => flowBaseReference("R1", "audioText", from, to);
    finalized.send({ kind: "heading-finalize", id: "fin_o_0", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" }, heading: "Hn",
      prefix: [base(0, 2)], name: [base(2, 4)], separator: [base(4, 5)], retainedBeat: "R1", emptyBeat: null, tail: { left: null, right: base(5), affinity: "before" } },
    { kind: "scalar", id: "fin:2", by: "Alice", target: { scope: "beat", record: "R1" }, field: "paragraphStart", clear: true });
    removed.send({ kind: "heading-remove", id: "unhead", by: "Alice", heading: "H1", observed: [flowBaseReference("H1", "heading", 0, 2)], newBeat: null, nextBeat: null });
    assert.deepEqual([created.ran, finalized.ran, removed.ran], [["heading-create", "text-insert"], ["heading-finalize", "scalar"], ["heading-remove"]]);
  } finally { created.set.close(); finalized.set.close(); removed.set.close(); }
});

test("seeded list, moves: a segment move reaches the registered refusal and writes nothing (rule 40)", () => {
  const { set, a } = world({ rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    const move = operation({ kind: "segment-move", id: "move", by: "Alice", segments: ["b:R2"], observedOrder: ["b:R2"], at: { left: null, right: "b:R1", affinity: "before" } });
    const revision = readSharedRevision(a);
    assert.deepEqual(executeSharedOperations(a, [move], { base: revision }), { ok: false, index: 0, operation: move, reason: "move-in-shared-session" });
    assert.equal(readSharedRevision(a), revision);
  } finally { set.close(); }
});

test("the composition's registration is inert: nothing under src calls it yet", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files = (dir: string): string[] => readdirSync(root + dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(dir + "/" + entry.name) : /\.ts$/.test(entry.name) ? [dir + "/" + entry.name] : []);
  assert.deepEqual(files("src").filter(path => /registerSharedOperationFamilies|operation-families\.ts|sharedAuthorPort|shared-author\.ts/.test(readFileSync(root + path, "utf8"))).sort(),
    ["src/adapters/collab/operation-families.ts", "src/bootstrap/wiring/ports/shared-author.ts"]);
});
