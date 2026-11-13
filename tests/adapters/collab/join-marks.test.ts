import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { storedValue } from "./helpers.ts";
import { isSharedJoinFormatRegisterField } from "../../../src/core/collab/projection/join-glue.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { beatPos, joinWithPrevious, setMarkAcross } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import type { MarkName } from "../../../src/core/text/runs.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const target = { owner: "R1", segment: "R1", field: "audioText" };
const bold = { kind: "b", value: true }, comment = { kind: "comment", id: "c1", value: true }, link = { kind: "link", id: "https://v/1", value: "https://v/1" };
const strong = (text: string) => `<strong>${text}</strong>`, anchored = (text: string) => `<span class="cmt-anchor" data-cmt="c1">${text}</span>`;
const cases = [
  { name: "inside the first fragment", mark: bold, range: [0, 1], typed: 4, added: strong("a") + "b cXd", removal: [0, 1], again: 6, removed: "ab cXdY" },
  { name: "inside the later fragment", mark: bold, range: [3, 5], typed: 1, added: "aXb " + strong("cd"), removal: [4, 6], again: 0, removed: "YaXb cd" },
  { name: "across the join point", mark: bold, range: [1, 4], typed: 0, added: "Xa" + strong("b c") + "d", removal: [2, 5], again: 6, removed: "Xab cdY" },
  { name: "over the whole row", mark: bold, range: [0, 5], typed: 5, added: strong("ab cd") + "X", removal: [0, 6], again: 0, removed: "Yab cdX" },
  { name: "comment across the join point", mark: comment, range: [1, 4], typed: 0, added: "Xa" + anchored("b c") + "d", removal: [2, 5], again: 6, removed: "Xab cdY" },
  { name: "comment over the whole row", mark: comment, range: [0, 5], typed: 5, added: anchored("ab cd") + "X", removal: [0, 6], again: 0, removed: "Yab cdX" },
  { name: "link over the whole row", mark: link, range: [0, 5], typed: 5, added: '<a href="https://v/1" target="_blank" rel="noopener">ab cd</a>X', removal: [0, 6], again: 0, removed: "Yab cdX" }
] as const;

function rows(handle: SharedDocumentHandle) {
  const result = projectSharedDocumentWithRecovery(handle); assert.deepEqual(result.recovery, []);
  return result.document.rows.map(row => row.audioText);
}
function stored(handle: SharedDocumentHandle) {
  const { roots } = collabState(handle);
  return { records: ["b:R1", "b:R2"].map(id => (storedValue(roots.segments.get(id)) as { markRecords: unknown[] }).markRecords.length),
    space: [...roots.meta.keys()].filter(isSharedJoinFormatRegisterField).map(key => key.split(":")[1]).sort() };
}
function mark(id: string, range: readonly number[], value: Record<string, unknown>) {
  return operation({ kind: "mark", id, by: "Writer", target, observed: [flowBaseReference("R1", "audioText", range[0] ?? 0, range[1] ?? 0)], mark: value });
}
function type(id: string, at: number, value: string) {
  return operation({ kind: "text-insert", id, by: "Other", target, at: { left: null, right: flowBaseReference("R1", "audioText", at), affinity: "before" }, content: [{ value, marks: [] }] });
}

for (const item of cases) for (const order of ["D1", "rev", "dup"] as const) test(`joined row mark ${item.name}, added and removed against concurrent typing: ${order}`, () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] }), handles = [set.a, set.b];
  const incremental = handles.map(handle => captureIncrementalReplica(handle));
  const check = () => handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); });
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
    set.queue.flush(order); check();
    assert.deepEqual(executeSharedOperations(set.a, [mark("add", item.range, item.mark)], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [type("typed", item.typed, "X")], { base: readSharedRevision(set.b) }), { ok: true });
    check(); set.queue.flush(order); check();
    agree("joined mark added " + item.name, order, handles, rows, [item.added]);
    assert.deepEqual(executeSharedOperations(set.a, [mark("remove", item.removal, { ...item.mark, value: null })], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(executeSharedOperations(set.b, [type("again", item.again, "Y")], { base: readSharedRevision(set.b) }), { ok: true });
    check(); set.queue.flush(order); check();
    agree("joined mark removed " + item.name, order, handles, rows, [item.removed]);
  } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
});

test("a comment over the virtual separator alone writes nothing; bold there stores only the space format", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  try {
    registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
    const before = encodeSharedState(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [mark("glue", [2, 3], comment)], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(encodeSharedState(set.a), before); assert.deepEqual(rows(set.a), ["ab cd"]);
    assert.deepEqual(executeSharedOperations(set.a, [mark("glue-bold", [2, 3], bold)], { base: readSharedRevision(set.a) }), { ok: true });
    assert.deepEqual(stored(set.a), { records: [0, 0], space: ["b"] }); assert.deepEqual(rows(set.a), ["ab" + strong(" ") + "cd"]);
  } finally { set.close(); }
});

test("native anchors in both fragments mark the later fragment and the join point", () => {
  for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
    try {
      registerSharedJoinHandlers(set.a); registerSharedTextOperationHandlers(set.a);
      assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
      const b = createSharedAnchor(set.a, "b:R1", 1, "after"), c = createSharedAnchor(set.a, "b:R2", 0, "after"); assert.ok(b && c);
      assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "mark", id: "native", by: "Writer", target, observed: [b, c], mark: bold })]), { ok: true });
      set.queue.flush(order); agree("native joined mark", order, [set.a, set.b], rows, ["a" + strong("b") + " " + strong("c") + "d"]);
    } finally { set.close(); }
  }
});

const runtime = createFlowLoadRuntime(), box = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">';
const pieces = { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }], productionTags: [{ id: "t_box", cat: "prop", name: "Box", status: "needed" }] };
function joined(order: "D1" | "rev" | "dup", copies: 2 | 3 = 2) {
  const set = replicas(copies, pieces), handles = [set.a, set.b, set.c].slice(0, copies), incremental = handles.map(handle => captureIncrementalReplica(handle));
  handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle); });
  assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
  const flush = () => { set.queue.flush(order); handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); }); };
  flush();
  return { set, handles, flush, close: () => { incremental.forEach(value => value.projector.dispose()); set.close(); } };
}
function appMark(handle: SharedDocumentHandle, id: string, range: readonly [number, number], name: MarkName) {
  const document = projectSharedDocumentWithRecovery(handle).document;
  const result = setMarkAcross({ rows: document.rows, sections: document.sections, comments: [] } as FlowDoc, { anchor: beatPos("R1", range[0]), head: beatPos("R1", range[1]) },
    name, { ...runtime.ports, operations: { id, by: "Writer" } });
  assert.ok(result && "rows" in result && result.ops);
  return { ops: result.ops, app: result.rows[0]?.audioText };
}
function press(handle: SharedDocumentHandle, id: string, range: readonly [number, number], name: MarkName) {
  const { ops, app } = appMark(handle, id, range, name);
  assert.deepEqual(executeSharedOperations(handle, ops, { base: readSharedRevision(handle) }), { ok: true });
  assert.deepEqual(rows(handle), [app]);
  return ops.map(op => op.kind === "mark" ? op.mark.value : op.kind);
}
const readStored = (handle: SharedDocumentHandle) => ({ rows: rows(handle), stored: stored(handle) });

for (const order of ["D1", "rev", "dup"] as const) test(`app bold over the whole joined row adds, removes and adds again with one space value: ${order}`, () => {
  const run = joined(order);
  try {
    assert.deepEqual(press(run.set.a, "first", [0, 5], "b"), [true]); run.flush();
    agree("first press", order, run.handles, readStored, { rows: [strong("ab cd")], stored: { records: [1, 1], space: ["b"] } });
    assert.deepEqual(press(run.set.b, "second", [0, 5], "b"), [null]); run.flush();
    agree("second press", order, run.handles, readStored, { rows: ["ab cd"], stored: { records: [2, 2], space: [] } });
    assert.deepEqual(press(run.set.a, "third", [0, 5], "b"), [true]); run.flush();
    agree("third press", order, run.handles, readStored, { rows: [strong("ab cd")], stored: { records: [3, 3], space: ["b"] } });
  } finally { run.close(); }
});

for (const [name, range, format, added, records] of [
  ["bold over the first piece", [0, 2], "b", strong("ab") + " cd", [2, 0]], ["bold over the second piece", [3, 5], "b", "ab " + strong("cd"), [0, 2]],
  ["bold over the space only", [2, 3], "b", "ab" + strong(" ") + "cd", [0, 0]], ["highlight over the whole row", [0, 5], "hl", "<mark>ab cd</mark>", [2, 2]],
  ["underline over the whole row", [0, 5], "u", "<u>ab cd</u>", [2, 2]]
] as const) for (const order of ["D1", "rev", "dup"] as const) test(`app ${name} of a joined row reads as the app and toggles off: ${order}`, () => {
  const run = joined(order);
  try {
    press(run.set.a, "on", range, format); run.flush(); agree(name, order, run.handles, rows, [added]);
    press(run.set.b, "off", range, format); run.flush(); agree(name + " off", order, run.handles, readStored, { rows: ["ab cd"], stored: { records: [...records], space: [] } });
  } finally { run.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a tag over the whole joined row stays one span per piece and stores nothing for the space: ${order}`, () => {
  const run = joined(order);
  try {
    assert.deepEqual(executeSharedOperations(run.set.a, [mark("tag", [0, 5], { kind: "tag", id: "t_box", value: "t_box" })], { base: readSharedRevision(run.set.a) }), { ok: true }); run.flush();
    agree("tag", order, run.handles, handle => ({ rows: rows(handle), space: stored(handle).space }), { rows: [box + "ab</span> " + box + "cd</span>"], space: [] });
  } finally { run.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`bold added and removed over the whole joined row at once ends bold on the pieces and the space: ${order}`, () => {
  const run = joined(order);
  try {
    press(run.set.a, "first", [0, 5], "b"); run.flush();
    assert.deepEqual(executeSharedOperations(run.set.a, [mark("again", [0, 5], bold)], { base: readSharedRevision(run.set.a) }), { ok: true });
    assert.deepEqual(press(run.set.b, "clear", [0, 5], "b"), [null]); run.flush();
    agree("add against remove", order, run.handles, handle => ({ rows: rows(handle), space: stored(handle).space }), { rows: [strong("ab cd")], space: ["b"] });
  } finally { run.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`an unjoin keeps each piece's own bold and a new join starts with a plain space: ${order}`, () => {
  const run = joined(order);
  try {
    press(run.set.a, "whole", [0, 5], "b"); run.flush();
    assert.deepEqual(executeSharedOperations(run.set.a, [operation({ kind: "join-retire", id: "apart", by: "Writer", joins: ["structure_1_006a006f0069006e_join_0"] })]), { ok: true }); run.flush();
    agree("unjoined", order, run.handles, rows, [strong("ab"), strong("cd")]);
    const document = projectSharedDocumentWithRecovery(run.set.a).document, app = joinWithPrevious({ rows: document.rows, comments: [] }, "R2", runtime.ports);
    assert.ok(app && "rows" in app); assert.equal(app.rows[0]?.audioText, strong("ab") + " " + strong("cd"));
    assert.deepEqual(executeSharedOperations(run.set.a, [operation({ kind: "join", id: "rejoin", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true }); run.flush();
    agree("joined again", order, run.handles, rows, [strong("ab") + " " + strong("cd")]);
  } finally { run.close(); }
});

for (const [seen, added, space] of [["B", strong("ab") + " " + strong("cd"), []], ["A", strong("ab cd"), ["b"]]] as const)
  for (const order of ["D1", "rev", "dup"] as const) test(`declared limit: two bolds at once and a removal that saw only ${seen === "B" ? "the higher writer's leave the space plain" : "the lower writer's keep the row bold"}: ${order}`, () => {
    const run = joined(order, 3);
    try {
      press(run.set.a, "bold-a", [0, 5], "b"); press(run.set.b, "bold-b", [0, 5], "b");
      for (const message of run.set.queue.pending.filter(item => item.from === seen && item.to === "C")) run.set.queue.deliver(message.id, order === "dup" ? 2 : 1);
      assert.deepEqual(press(run.set.c, "clear-c", [0, 5], "b"), [null]); run.flush();
      agree("two bolds and a removal", order, run.handles, handle => ({ rows: rows(handle), space: stored(handle).space }), { rows: [added], space: [...space] });
    } finally { run.close(); }
  });

test("undo of bold over a whole joined row retracts every piece's records and clears the space", () => {
  const run = joined("D1");
  try {
    const execution = executeSharedCommand(run.set.a, appMark(run.set.a, "bold", [0, 5], "b").ops, { label: "bold", selection: null, typing: null },
      { base: readSharedRevision(run.set.a) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record);
    const undone = reverseSharedUndoRecord(run.set.a, execution.record, { by: "Writer", nextId: () => "undo" }); run.flush();
    assert.ok(undone.ok && undone.effective);
    agree("undone", "D1", run.handles, handle => ({ rows: rows(handle), space: stored(handle).space }), { rows: ["ab cd"], space: [] });
  } finally { run.close(); }
});

function recorded(handle: SharedDocumentHandle, id: string, range: readonly [number, number], name: MarkName) {
  const execution = executeSharedCommand(handle, appMark(handle, id, range, name).ops, { label: name, selection: null, typing: null }, { base: readSharedRevision(handle) });
  assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); return execution.record;
}
function reverse(handle: SharedDocumentHandle, record: SharedUndoRecord, id: string) {
  let count = 0;
  const done = reverseSharedUndoRecord(handle, record, { by: "Writer", nextId: () => id + ++count }); assert.ok(done.ok); return done;
}
const readSpace = (handle: SharedDocumentHandle) => ({ rows: rows(handle), space: stored(handle).space });
const plain = { rows: ["ab cd"], space: [] }, whole = { rows: [strong("ab cd")], space: ["b"] }, gap = { rows: ["ab" + strong(" ") + "cd"], space: ["b"] };

for (const [name, setup, range, format, after, undone] of [
  ["bold over the whole row", null, [0, 5], "b", whole, plain],
  ["removal of bold over a row that was bold", [0, 5], [0, 5], "b", plain, whole],
  ["bold over the space only", null, [2, 3], "b", gap, plain],
  ["highlight over the whole row", null, [0, 5], "hl", { rows: ["<mark>ab cd</mark>"], space: ["hl"] }, plain],
  ["bold over the whole row whose space was already bold", [2, 3], [0, 5], "b", whole, gap]
] as const) for (const order of ["D1", "rev", "dup"] as const) test(`undo and redo of ${name} of a joined row take back and reapply the pieces and the space: ${order}`, () => {
  const run = joined(order);
  try {
    if (setup) { press(run.set.a, "setup", setup, "b"); run.flush(); }
    const record = recorded(run.set.a, "command", range, format); run.flush(); agree(name, order, run.handles, readSpace, after);
    const undo = reverse(run.set.a, record, "undo"); run.flush(); assert.ok(undo.ok && undo.effective); agree(name + " undone", order, run.handles, readSpace, undone);
    const redo = reverse(run.set.a, undo.inverse, "redo"); run.flush(); assert.ok(redo.ok && redo.effective); agree(name + " redone", order, run.handles, readSpace, after);
    const again = reverse(run.set.a, redo.inverse, "again"); run.flush(); assert.ok(again.ok && again.effective); agree(name + " undone again", order, run.handles, readSpace, undone);
  } finally { run.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a space another writer cleared after the command stays plain through undo and redo; the pieces follow the undo: ${order}`, () => {
  const run = joined(order);
  try {
    const record = recorded(run.set.a, "bold", [0, 5], "b"); run.flush();
    press(run.set.b, "space", [2, 3], "b"); run.flush(); agree("space cleared", order, run.handles, readSpace, { rows: [strong("ab") + " " + strong("cd")], space: [] });
    const undo = reverse(run.set.a, record, "undo"); run.flush(); assert.ok(undo.ok && undo.effective); agree("undone", order, run.handles, readSpace, plain);
    const redo = reverse(run.set.a, undo.inverse, "redo"); run.flush(); assert.ok(redo.ok && redo.effective);
    agree("redone", order, run.handles, readSpace, { rows: [strong("ab") + " " + strong("cd")], space: [] });
  } finally { run.close(); }
});

test("not settled by the rules: a space another writer cleared and then bolded again holds what the command wrote, so the undo clears it", () => {
  const run = joined("D1");
  try {
    const record = recorded(run.set.a, "bold", [0, 5], "b"); run.flush();
    press(run.set.b, "clear", [0, 5], "b"); run.flush(); press(run.set.b, "space", [2, 3], "b"); run.flush(); agree("space bold again", "D1", run.handles, readSpace, gap);
    const undo = reverse(run.set.a, record, "undo"); run.flush(); assert.ok(undo.ok && undo.effective); agree("undone", "D1", run.handles, readSpace, plain);
  } finally { run.close(); }
});

for (const [name, value, after] of [
  ["comment", comment, anchored("ab cd")], ["link", link, '<a href="https://v/1" target="_blank" rel="noopener">ab cd</a>'],
  ["tag", { kind: "tag", id: "t_box", value: "t_box" }, box + "ab</span> " + box + "cd</span>"]
] as const) for (const order of ["D1", "rev", "dup"] as const) test(`undo of a ${name} over the whole joined row takes it off both pieces: ${order}`, () => {
  const run = joined(order);
  try {
    const execution = executeSharedCommand(run.set.a, [mark(name, [0, 5], value)], { label: name, selection: null, typing: null }, { base: readSharedRevision(run.set.a) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); run.flush(); agree(name, order, run.handles, rows, [after]);
    const undo = reverse(run.set.a, execution.record, "undo"); run.flush(); assert.ok(undo.ok && undo.effective); agree(name + " undone", order, run.handles, readSpace, plain);
  } finally { run.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`an unjoin before the undo: the pieces' bold is taken back, the old space is not written and a new join is plain: ${order}`, () => {
  const run = joined(order);
  try {
    const record = recorded(run.set.a, "bold", [0, 5], "b"); run.flush();
    assert.deepEqual(record.parts.map(part => [part.kind, "spaces" in part ? part.spaces?.length : 0]), [["mark-add", 0], ["mark-add", 0], ["mark-add", 1]]);
    assert.deepEqual(executeSharedOperations(run.set.b, [operation({ kind: "join-retire", id: "apart", by: "Other", joins: ["structure_1_006a006f0069006e_join_0"] })]), { ok: true });
    run.flush(); agree("unjoined", order, run.handles, readSpace, { rows: [strong("ab"), strong("cd")], space: ["b"] });
    const undo = reverse(run.set.a, record, "undo"); run.flush(); assert.ok(undo.ok && undo.effective);
    assert.deepEqual(undo.inverse.parts.map(part => "spaces" in part), [false, false, false]);
    agree("undone", order, run.handles, readSpace, { rows: ["ab", "cd"], space: ["b"] });
    assert.deepEqual(executeSharedOperations(run.set.a, [operation({ kind: "join", id: "rejoin", by: "Writer", from: "R2", into: "R1", glue: " " })]), { ok: true });
    run.flush(); agree("joined again", order, run.handles, readSpace, { rows: ["ab cd"], space: ["b"] });
  } finally { run.close(); }
});
