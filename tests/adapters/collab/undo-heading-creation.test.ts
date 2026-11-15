import test from "node:test";
import assert from "node:assert/strict";
import { replicas, operation } from "./executor-support.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { applySharedUpdate, encodeSharedState, destroySharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { isSharedCreationRetired, sharedCreationObservationCost } from "../../../src/adapters/collab/creation-retirement.ts";
import type { SharedUndoPart, SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev", "dup"] as const;
const SOURCE = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }, { id: "R2", audioText: "c" }], sections: [{ id: "H0", name: "Open", firstSceneId: "R0" }] };
type Reading = ReturnType<typeof projectSharedDocumentWithRecovery>;

function start(order: typeof ORDERS[number], source: Record<string, unknown> = SOURCE) {
  const h = replicas(2, source), handles = [h.a, h.b];
  for (const handle of handles) registerSharedOperationFamilies(handle, { cells: runtime.cells });
  const incremental = handles.map(handle => captureIncrementalReplica(handle));
  let serial = 0;
  const owner = createSharedUndo({ now: () => serial * 2000, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(h.a, record, { by: "Alice", nextId: () => "undo" + ++serial }) });
  const flush = () => { h.queue.flush(order); handles.forEach((handle, i) => { const current = incremental[i]; assert.ok(current); assertIncremental(handle, current.projector); }); };
  const check = (expected: Reading) => {
    flush(); const late = createMonitoredSharedDocument();
    try {
      assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
      for (const handle of [...handles, late]) assert.deepEqual(projectSharedDocumentWithRecovery(handle), expected);
    } finally { destroySharedDocument(late); }
  };
  const command = (values: readonly unknown[], label = "create") => {
    let record: SharedUndoRecord | null = null;
    owner.perform(() => {
      const result = executeSharedCommand(h.a, values.map(operation), { label, selection: null, typing: null }, { base: readSharedRevision(h.a) });
      assert.deepEqual(result.result, { ok: true }); record = result.record; return result.record;
    });
    assert.ok(record); return record as SharedUndoRecord;
  };
  const send = (values: readonly unknown[], handle: SharedDocumentHandle = h.b) =>
    assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
  const part = (record: SharedUndoRecord) => {
    const found = record.parts.find(item => item.kind === "heading-creation"); assert.ok(found?.kind === "heading-creation"); return found;
  };
  const scene = (firstBeat = "R1", name = "New") => { const made = part(command(addScene("scene", firstBeat, name), "add-section")); flush(); return made; };
  return { ...h, owner, flush, check, command, send, part, scene, close: () => { incremental.forEach(value => value.projector.dispose()); h.close(); } };
}

function addScene(id: string, firstBeat: string, name: string, by = "Alice") {
  const heading = "scene_" + id;
  return [{ kind: "heading-create", id, by, segment: heading, heading, firstBeat, at: { left: null, right: firstBeat, affinity: "before" } },
    { kind: "text-insert", id: id + "_name", by, target: { owner: heading, segment: heading, field: "heading" },
      at: { left: null, right: flowBaseReference(heading, "heading", 0), affinity: "before" }, content: [{ value: name, marks: [] }] }];
}

function paste(firstBeat = "R1", name = "New", by = "Alice") {
  const source = (from: number, to = from) => flowBaseReference("PS", "audioText", from, to), length = name.length;
  return [{ kind: "segment-create", id: "paste_beat", by, segment: "P0", beat: "P0", at: { left: null, right: firstBeat, affinity: "before" }, fields: { audioText: "p", visualText: "", status: "todo" } },
    { kind: "segment-create", id: "paste_source", by, segment: "PS", beat: "PS", at: { left: null, right: "P0", affinity: "before" },
      fields: { audioText: "# " + name + "<br>", visualText: "", status: "todo" } },
    { kind: "heading-finalize", id: "paste", by, target: { owner: "PS", segment: "PS", field: "audioText" }, heading: "HP", prefix: [source(0, 2)], name: [source(2, length + 2)],
      separator: [source(length + 2, length + 3)], tail: { left: null, right: source(length + 3), affinity: "before" }, retainedBeat: "P0", emptyBeat: null }];
}

type Made = Extract<SharedUndoPart, { kind: "heading-creation" }>;
const rename = (made: Made, value = "Z", by = "Bob") => ({ kind: "text-insert", id: "rename", by, target: { owner: made.heading, segment: made.segment, field: "heading" },
  at: { left: flowBaseReference(made.heading, "heading", 0), right: null, affinity: "after" }, content: [{ value, marks: [] }] });
const changes = [
  { name: "a rename", make: (made: Made) => rename(made) },
  { name: "a scene value", make: (made: Made) => ({ kind: "scalar", id: "extra", by: "Bob", target: { scope: "heading", record: made.heading }, field: "extra", value: "{\"mood\":\"dark\"}" }) },
  { name: "a scene removal", make: (made: Made) => ({ kind: "heading-remove", id: "unhead", by: "Bob", heading: made.heading,
    observed: [flowBaseReference(made.heading, "heading", 0, 3)], newBeat: null, nextBeat: null }) },
  { name: "a bold name", make: (made: Made) => ({ kind: "mark", id: "bold", by: "Bob", target: { owner: made.heading, segment: made.segment, field: "heading" },
    observed: [flowBaseReference(made.heading, "heading", 0, 3)], mark: { kind: "b", value: true } }) },
  { name: "a split of the name", make: (made: Made) => ({ kind: "split", id: "split", by: "Bob", target: { owner: made.heading, segment: made.segment, field: "heading" },
    at: { left: flowBaseReference(made.heading, "heading", 0), right: flowBaseReference(made.heading, "heading", 1), affinity: "before" }, observed: [], boundary: "N2", beat: "N2", fields: {} }) }
];

for (const order of ORDERS) test(`rule 202: undo of the add-scene box removes the heading line only, and redo brings back the same heading: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), made = h.scene(), after = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(after.document.sections, [{ id: "H0", name: "Open", firstSceneId: "R0" }, { id: made.heading, name: "New", firstSceneId: "R1" }]);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "add-section", selection: null }); h.check(before);
    assert.deepEqual(before.document.sections, [{ id: "H0", name: "Open", firstSceneId: "R0" }]);
    assert.deepEqual(h.owner.sizes(), { undo: 0, redo: 1, dropped: 0 });
    assert.equal(h.owner.redo().ok, true); h.check(after);
    assert.equal(h.owner.undo().ok, true); h.check(before);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`rule 204: a whole paste of a beat under a new heading is one step, undone and redone with the same identities: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), record = h.command(paste(), "paste"); h.flush();
    assert.deepEqual(record.parts.map(item => item.kind), ["beat-create", "beat-create", "heading-creation"]);
    const after = projectSharedDocumentWithRecovery(h.a), made = h.part(record);
    assert.deepEqual([after.document.rows.map(row => row.audioText), after.document.sections],
      [["x", "p", "ab", "c"], [{ id: "H0", name: "Open", firstSceneId: "R0" }, { id: made.heading, name: "New", firstSceneId: after.document.rows[1]?.id }]]);
    assert.equal(h.owner.undo().ok, true); h.check(before);
    assert.equal(h.owner.redo().ok, true); h.check(after);
    assert.equal(h.owner.undo().ok, true); h.check(before);
  } finally { h.close(); }
});

for (const change of changes) for (const order of ORDERS) for (const seen of [true, false]) test(`rules 203 and 205: heading creation undo versus ${change.name} by another copy, seen=${seen}: ${order}`, () => {
  const h = start(order);
  try {
    const made = h.scene(); h.send([change.make(made)]);
    const other = projectSharedDocumentWithRecovery(h.b);
    if (seen) h.flush();
    const state = encodeSharedState(h.a), revision = readSharedRevision(h.a), outcome = h.owner.undo();
    if (seen) {
      assert.deepEqual(outcome, { ok: true, effective: false, label: "add-section", selection: null, reason: "used-up" });
      assert.equal(readSharedRevision(h.a), revision); assert.deepEqual(encodeSharedState(h.a), state);
      assert.deepEqual(h.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
    } else assert.deepEqual(outcome, { ok: true, effective: true, label: "add-section", selection: null });
    h.check(other);
    if (!seen) {
      assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "add-section", selection: null, reason: "used-up" });
      h.check(other);
    }
  } finally { h.close(); }
});

const under = [
  { name: "a beat added after the heading's first beat", make: () => ({ kind: "segment-create", id: "bob_beat", by: "Bob", segment: "B1", beat: "B1",
    at: { left: "R1", right: null, affinity: "after" }, fields: { audioText: "bob", status: "todo" } }) },
  { name: "a beat added directly under the heading line", make: () => ({ kind: "segment-create", id: "bob_beat", by: "Bob", segment: "B1", beat: "B1",
    at: { left: null, right: "R1", affinity: "before" }, fields: { audioText: "bob", status: "todo" } }) },
  { name: "typing in the heading's first beat", make: () => ({ kind: "text-insert", id: "bob_type", by: "Bob", target: { owner: "R1", segment: "b:R1", field: "audioText" },
    at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" }, content: [{ value: "Q", marks: [] }] }) }
];
for (const change of under) for (const order of ORDERS) for (const seen of [true, false]) test(`rule 206: ${change.name} by another person is not work on the heading; the undo removes the line and their work stays, seen=${seen}: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a); h.scene(); h.send([change.make()]);
    if (seen) h.flush();
    assert.deepEqual(h.owner.undo(), { ok: true, effective: true, label: "add-section", selection: null }); h.flush();
    const now = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(now.document.sections, before.document.sections);
    assert.deepEqual(now.recovery, []);
    const texts = now.document.rows.map(row => row.audioText);
    assert.deepEqual(texts, change.name.startsWith("typing") ? ["x", "abQ", "c"] : change.name.includes("directly") ? ["x", "bob", "ab", "c"] : ["x", "ab", "bob", "c"]);
    h.check(now);
    assert.equal(h.owner.redo().ok, true); h.flush();
    assert.deepEqual(projectSharedDocumentWithRecovery(h.a).document.sections.map(section => section.name), ["Open", "New"]);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`rule 203: the creator's own rename is undone first and leaves the creation undoable: ${order}`, () => {
  const h = start(order);
  try {
    const before = projectSharedDocumentWithRecovery(h.a), made = h.scene(), created = projectSharedDocumentWithRecovery(h.a);
    h.command([rename(made, "Y", "Alice")], "rename"); h.flush();
    const renamed = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(renamed.document.sections.map(section => section.name), ["Open", "NYew"]);
    assert.equal(h.owner.undo().ok, true); h.check(created);
    assert.equal(h.owner.undo().ok, true); h.check(before);
    assert.equal(h.owner.redo().ok, true); h.check(created);
    assert.equal(h.owner.redo().ok, true); h.check(renamed);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`rule 203: a rename the creator left in place uses the creation undo up at the adapter: ${order}`, () => {
  const h = start(order);
  try {
    const record = h.command(addScene("scene", "R1", "New"), "add-section"); h.flush();
    h.send([rename(h.part(record), "Y", "Alice")], h.a); h.flush();
    const state = encodeSharedState(h.a);
    assert.deepEqual(reverseSharedUndoRecord(h.a, record, { by: "Alice", nextId: () => "direct" }), { ok: true, effective: false, selection: null, inverse: record });
    assert.deepEqual(encodeSharedState(h.a), state);
  } finally { h.close(); }
});

for (const order of ORDERS) for (const seen of [true, false]) test(`rule 204: a whole paste is used up when another person edits its pasted beat; nothing is written, seen=${seen}: ${order}`, () => {
  const h = start(order);
  try {
    const record = h.command(paste(), "paste"); h.flush();
    const beat = record.parts.find(item => item.kind === "beat-create" && projectSharedDocumentWithRecovery(h.a).document.rows.some(row => row.id === item.beat));
    assert.ok(beat?.kind === "beat-create");
    h.send([{ kind: "text-insert", id: "bob_type", by: "Bob", target: { owner: beat.beat, segment: beat.beat, field: "audioText" },
      at: { left: flowBaseReference(beat.beat, "audioText", 0), right: null, affinity: "after" }, content: [{ value: "Q", marks: [] }] }]);
    const other = projectSharedDocumentWithRecovery(h.b);
    if (seen) h.flush();
    const state = encodeSharedState(h.a), outcome = h.owner.undo();
    if (seen) {
      assert.deepEqual(outcome, { ok: true, effective: false, label: "paste", selection: null, reason: "used-up" }); assert.deepEqual(encodeSharedState(h.a), state);
      h.check(other); assert.deepEqual(other.document.sections.map(section => section.name), ["Open", "New"]);
      return;
    }
    assert.deepEqual(outcome, { ok: true, effective: true, label: "paste", selection: null }); h.flush();
    const merged = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual([merged.document.rows.map(row => row.audioText), merged.document.sections.map(section => section.name), merged.recovery], [["x", "pQ", "ab", "c"], ["Open"], []]);
    assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "paste", selection: null, reason: "used-up" });
    h.check(merged);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`rule 207: a heading made over the creator's own new beat stays a structural change of that beat after the heading's undo (rule 147): ${order}`, () => {
  const h = start(order);
  try {
    const record = h.command([{ kind: "segment-create", id: "add", by: "Alice", beat: "N1", segment: "N1", at: { left: "R2", right: null, affinity: "after" }, fields: { audioText: "n", status: "todo" } }]);
    const beat = record.parts[0]; assert.ok(beat?.kind === "beat-create"); h.flush();
    h.scene(beat.beat);
    assert.equal(h.owner.undo().ok, true); h.flush();
    const shown = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(shown.document.sections.map(section => section.name), ["Open"]);
    assert.deepEqual(h.owner.undo(), { ok: true, effective: false, label: "create", selection: null, reason: "used-up" });
    h.check(shown);
  } finally { h.close(); }
});

for (const order of ORDERS) test(`rule 205: an unseen rename arrives after the undo; the heading comes back with it on every copy and a late joiner, and the redo is used up: ${order}`, () => {
  const h = start(order);
  try {
    const made = h.scene(); h.send([rename(made, "Q")]);
    assert.equal(h.owner.undo().ok, true);
    assert.equal(isSharedCreationRetired(h.a, made.heading), true);
    h.flush();
    assert.equal(isSharedCreationRetired(h.a, made.heading), false);
    const shown = projectSharedDocumentWithRecovery(h.a);
    assert.deepEqual(shown.document.sections.map(section => section.name), ["Open", "NQew"]);
    assert.deepEqual(h.owner.redo(), { ok: true, effective: false, label: "add-section", selection: null, reason: "used-up" });
    h.check(shown);
  } finally { h.close(); }
});

test("rule 208: a heading finished from a typed Writer line stays skipped with rule 71, and a demotion stays refused by name", () => {
  const h = start("D1", { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab<br>cd", paragraphStart: true }, { id: "R2", audioText: "ef" }] });
  try {
    const base = (from: number, to = from) => flowBaseReference("R1", "audioText", from, to);
    const record = h.command([{ kind: "heading-finalize", id: "fin", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" }, heading: "Hn",
      prefix: [base(0, 2)], name: [base(2, 4)], separator: [base(4, 5)], retainedBeat: "R1", emptyBeat: null, tail: { left: null, right: base(5), affinity: "before" } }], "finish heading");
    assert.deepEqual(record.parts.map(item => item.kind === "structure" ? item.command : item.kind), ["heading-finalize"]);
    assert.deepEqual(h.owner.undo(), { ok: false, reason: "undo-unsupported:heading-finalize", skipped: true });
    assert.deepEqual(["heading-finalize", "heading-remove", "heading-create", "heading-creation"].map(supportsSharedUndoPart), [false, false, false, true]);
  } finally { h.close(); }
});

test("a retired heading is read again when its name changes and not when someone types in another beat", () => {
  const h = start("D1");
  try {
    const made = h.scene(); assert.equal(h.owner.undo().ok, true); h.send([rename(made, "Q")]);
    assert.equal(isSharedCreationRetired(h.a, made.heading), true);
    const builds = sharedCreationObservationCost.builds;
    h.send([{ kind: "text-insert", id: "far", by: "Bob", target: { owner: "R2", segment: "b:R2", field: "audioText" },
      at: { left: flowBaseReference("R2", "audioText", 0), right: null, affinity: "after" }, content: [{ value: "Q", marks: [] }] }], h.a);
    assert.equal(isSharedCreationRetired(h.a, made.heading), true);
    assert.equal(sharedCreationObservationCost.builds, builds);
    h.flush();
    assert.equal(isSharedCreationRetired(h.a, made.heading), false);
  } finally { h.close(); }
});

for (const length of [1, 200]) test(`heading creation undo and redo stored size: a name of ${length} characters`, t => {
  const h = start("D1");
  try {
    h.scene("R1", "n".repeat(length));
    const made = encodeSharedState(h.a).byteLength;
    assert.equal(h.owner.undo().ok, true);
    const undone = encodeSharedState(h.a).byteLength;
    assert.equal(h.owner.redo().ok, true);
    const redone = encodeSharedState(h.a).byteLength;
    t.diagnostic(JSON.stringify({ length, undo: undone - made, redo: redone - undone }));
    assert.deepEqual({ undo: undone - made, redo: redone - undone }, length === 1 ? { undo: 371, redo: -305 } : { undo: 3754, redo: -3687 });
  } finally { h.close(); }
});
