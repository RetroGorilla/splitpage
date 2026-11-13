import test from "node:test";
import assert from "node:assert/strict";
import type { SharedContentRef, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import { encodeSharedState, observeSharedTransactions, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { readSharedStatus, readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord, SHARED_UNDO_PARTS, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { operation, ref, replicas } from "./executor-support.ts";

const BEAT = { scope: "beat", record: ref("R1") } as const;
const TEXT: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
const BOLD = { kind: "b", value: true } as const;

function shown(handle: SharedDocumentHandle): string[] {
  return (readSharedTextHistory(handle, TEXT)?.units ?? []).map(unit => unit.unit.client + ":" + unit.unit.clock + " " + String(unit.value) + (unit.marks.some(group => group.kind === "b") ? " b" : ""));
}

function unitAt(handle: SharedDocumentHandle, index: number): SharedContentRef {
  const unit = readSharedTextHistory(handle, TEXT)?.units[index];
  assert.ok(unit);
  return unit.identity;
}

function occurrences(handle: SharedDocumentHandle): SharedContentRef[] {
  return (readSharedTextHistory(handle, TEXT)?.records ?? []).filter(item => item.record.type === "add").map(item => item.identity);
}

function statusEvent(id: string, value: string, handle: SharedDocumentHandle) {
  return operation({ kind: "status", id, by: "Alice", target: BEAT, value, parents: readSharedStatusHeads(handle, BEAT) });
}

function retire(id: string, event: string, value: string, record = "R1") {
  return operation({ kind: "status-retire", id, by: "Alice", target: { scope: "beat", record: ref(record) }, event: ref(JSON.stringify(["1", event])), value });
}

function withTextHandlers(run: ReturnType<typeof replicas>): void {
  for (const handle of [run.a, run.b]) { registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle); }
}

test("an execution is a local command unless it says it is an undo; a stale base is refused before either", () => {
  const run = replicas();
  try {
    const origins: (string | null)[] = [];
    const stop = observeSharedTransactions(run.a, origin => { origins.push(origin); });
    assert.deepEqual(executeSharedOperations(run.a, [statusEvent("s1", "ready", run.a)]), { ok: true });
    assert.deepEqual(executeSharedOperations(run.a, [statusEvent("s2", "shot", run.a)], { origin: "local-undo" }), { ok: true });
    assert.deepEqual(executeSharedOperations(run.a, [statusEvent("s3", "ready", run.a)], { origin: "local-command" }), { ok: true });
    assert.deepEqual(executeSharedOperations(run.a, [statusEvent("s4", "todo", run.a)], { origin: "local-undo", base: readSharedRevision(run.a) }), { ok: true });
    assert.deepEqual(executeSharedOperations(run.a, [statusEvent("s5", "ready", run.a)], { origin: "local-undo", base: readSharedRevision(run.a) - 1 }), { ok: false, reason: "stale-base" });
    stop();
    assert.deepEqual(origins, ["local-command", "local-undo", "local-command", "local-undo"]);
    assert.equal(readSharedStatus(run.a, BEAT), "todo");
  } finally { run.close(); }
});

test("a command writes as a local command and its reversal as a local undo, and the reversal of that as a local undo again", () => {
  const run = replicas();
  try {
    registerSharedUndoOperationHandlers(run.a);
    const origins: (string | null)[] = [];
    const stop = observeSharedTransactions(run.a, origin => { origins.push(origin); });
    let serial = 0;
    const writer = { by: "Alice", nextId: () => "u" + ++serial };
    const execution = executeSharedCommand(run.a, [statusEvent("s1", "ready", run.a)], { label: "status", selection: null, typing: null });
    assert.deepEqual(execution.result, { ok: true });
    assert.ok(execution.record);
    assert.deepEqual(execution.record.parts.map(part => part.kind), ["status"]);
    const undone = reverseSharedUndoRecord(run.a, execution.record, writer);
    assert.ok(undone.ok && undone.effective);
    assert.equal(readSharedStatus(run.a, BEAT), "todo");
    assert.deepEqual(undone.inverse.parts.map(part => part.kind), ["status-retired"]);
    const redone = reverseSharedUndoRecord(run.a, undone.inverse, writer);
    assert.ok(redone.ok && redone.effective);
    assert.equal(readSharedStatus(run.a, BEAT), "ready");
    stop();
    assert.deepEqual(origins, ["local-command", "local-undo", "local-undo"]);
    assert.deepEqual(SHARED_UNDO_PARTS, ["text", "mark-add", "mark-remove", "scalar", "status", "status-retired", "record-create", "record-delete", "record-field", "join", "remove", "restore", "discard", "discard-retired", "join-glue", "beat-split"]);
    assert.deepEqual(["text", "status-retired", "structure", "record-create", "record-field", ""].map(supportsSharedUndoPart), [true, true, false, true, true, false]);
  } finally { run.close(); }
});

test("status-retire needs its handler; with it, it retires the event only while the beat shows that value", () => {
  const run = replicas();
  try {
    assert.deepEqual(executeSharedOperations(run.a, [statusEvent("s1", "ready", run.a)]), { ok: true });
    const unhandled = retire("r0", "s1", "ready");
    assert.deepEqual(executeSharedOperations(run.a, [unhandled]), { ok: false, index: 0, operation: unhandled, reason: "unhandled-kind" });
    registerSharedUndoOperationHandlers(run.a);
    const missing = retire("r1", "s1", "ready", "R9");
    assert.deepEqual(executeSharedOperations(run.a, [missing]), { ok: false, index: 0, operation: missing, reason: "missing-status-target" });
    let before = encodeSharedState(run.a);
    assert.deepEqual(executeSharedOperations(run.a, [retire("r2", "s1", "shot")]), { ok: true });
    assert.deepEqual(executeSharedOperations(run.a, [retire("r3", "nobody", "ready")]), { ok: true });
    assert.deepEqual(encodeSharedState(run.a), before);
    assert.equal(readSharedStatus(run.a, BEAT), "ready");
    assert.deepEqual(executeSharedOperations(run.a, [retire("r4", "s1", "ready")], { origin: "local-undo" }), { ok: true });
    assert.equal(readSharedStatus(run.a, BEAT), "todo");
    before = encodeSharedState(run.a);
    assert.deepEqual(executeSharedOperations(run.a, [retire("r5", "s1", "ready")]), { ok: true });
    assert.deepEqual(encodeSharedState(run.a), before);
    assert.deepEqual(executeSharedOperations(run.a, [statusEvent("s9", "todo", run.a)]), { ok: true });
    before = encodeSharedState(run.a);
    assert.deepEqual(executeSharedOperations(run.a, [retire("r6", "s9", "todo")]), { ok: true });
    assert.deepEqual(encodeSharedState(run.a), before);
    assert.equal(readSharedStatus(run.a, BEAT), "todo");
  } finally { run.close(); }
});

test("text-restore brings a deleted character back once, as a new character with the marks it is given", () => {
  const run = replicas();
  try {
    withTextHandlers(run);
    assert.deepEqual(shown(run.a), ["1:54 a", "1:55 b", "1:56 Z"]);
    const span = captureSharedTextRange(run.a, TEXT, 0, 2);
    assert.ok(span);
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "mark", id: "m1", by: "Alice", target: TEXT, observed: [span], mark: BOLD })]), { ok: true });
    const [bold] = occurrences(run.a), a = unitAt(run.a, 0), b = unitAt(run.a, 1);
    assert.ok(bold);
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "text-delete", id: "d1", by: "Alice", target: TEXT, observed: [b] })]), { ok: true });
    assert.deepEqual(shown(run.a), ["1:54 a b", "1:56 Z"]);
    const live = operation({ kind: "text-restore", id: "u0", by: "Alice", target: TEXT, units: [{ unit: a, left: null, value: "a", marks: [] }] });
    let before = encodeSharedState(run.a);
    assert.deepEqual(executeSharedOperations(run.a, [live], { origin: "local-undo" }), { ok: true });
    assert.deepEqual(encodeSharedState(run.a), before);
    const restore = (id: string) => operation({ kind: "text-restore", id, by: "Alice", target: TEXT, units: [{ unit: b, left: a, value: "b", marks: [bold] }] });
    assert.deepEqual(executeSharedOperations(run.a, [restore("u1")], { origin: "local-undo" }), { ok: true });
    const restored = shown(run.a);
    assert.equal(restored.length, 3);
    assert.match(restored[1] ?? "", /^1:\d+ b b$/);
    assert.notEqual(restored[1], "1:55 b b");
    assert.deepEqual([restored[0], restored[2]], ["1:54 a b", "1:56 Z"]);
    before = encodeSharedState(run.a);
    assert.deepEqual(executeSharedOperations(run.a, [restore("u2")], { origin: "local-undo" }), { ok: true });
    assert.deepEqual(encodeSharedState(run.a), before);
    run.queue.flush("D1");
    assert.deepEqual(shown(run.b), restored);
  } finally { run.close(); }
});

test("text-restore refuses a unit that is not a character, a mark it does not know and a missing text", () => {
  const run = replicas();
  try {
    withTextHandlers(run);
    const a = unitAt(run.a, 0), b = unitAt(run.a, 1), end = createSharedAnchor(run.a, TEXT, 2, "before");
    assert.ok(end);
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: "text-delete", id: "d1", by: "Alice", target: TEXT, observed: [b] })]), { ok: true });
    const before = encodeSharedState(run.a);
    const cases = [
      { units: [{ unit: end, left: a, value: "b", marks: [] }], target: TEXT, reason: "invalid-reference" },
      { units: [{ unit: b, left: a, value: "b", marks: [ref(JSON.stringify(["1", "nothing"]))] }], target: TEXT, reason: "invalid-reference" },
      { units: [{ unit: b, left: a, value: "b", marks: [] }], target: { ...TEXT, owner: ref("R9"), segment: ref("b:R9") }, reason: "missing-target" }
    ];
    for (const [index, item] of cases.entries()) {
      const refused = operation({ kind: "text-restore", id: "u" + index, by: "Alice", target: item.target, units: item.units });
      assert.deepEqual(executeSharedOperations(run.a, [refused], { origin: "local-undo" }), { ok: false, index: 0, operation: refused, reason: item.reason });
    }
    assert.deepEqual(encodeSharedState(run.a), before);
  } finally { run.close(); }
});

test("mark-retract takes one occurrence away and leaves a later mark over the same characters", () => {
  const run = replicas();
  try {
    withTextHandlers(run);
    const span = captureSharedTextRange(run.a, TEXT, 0, 2);
    assert.ok(span);
    const bold = (id: string) => operation({ kind: "mark", id, by: "Alice", target: TEXT, observed: [span], mark: BOLD });
    assert.deepEqual(executeSharedOperations(run.a, [bold("m1")]), { ok: true });
    const [first] = occurrences(run.a);
    assert.ok(first);
    assert.deepEqual(executeSharedOperations(run.a, [bold("m2")]), { ok: true });
    const second = occurrences(run.a).find(identity => identity !== first);
    assert.ok(second);
    const retract = (id: string, occurrence: SharedContentRef) => operation({ kind: "mark-retract", id, by: "Alice", target: TEXT, occurrences: [occurrence] });
    assert.deepEqual(executeSharedOperations(run.a, [retract("x1", first)], { origin: "local-undo" }), { ok: true });
    assert.deepEqual(shown(run.a), ["1:54 a b", "1:55 b b", "1:56 Z"]);
    assert.deepEqual(executeSharedOperations(run.a, [retract("x2", second)], { origin: "local-undo" }), { ok: true });
    assert.deepEqual(shown(run.a), ["1:54 a", "1:55 b", "1:56 Z"]);
    const unknown = retract("x3", ref(JSON.stringify(["1", "nothing"])));
    const before = encodeSharedState(run.a);
    assert.deepEqual(executeSharedOperations(run.a, [unknown], { origin: "local-undo" }), { ok: false, index: 0, operation: unknown, reason: "invalid-reference" });
    assert.deepEqual(encodeSharedState(run.a), before);
    run.queue.flush("rev");
    assert.deepEqual(shown(run.b), ["1:54 a", "1:55 b", "1:56 Z"]);
  } finally { run.close(); }
});
