import test from "node:test";
import assert from "node:assert/strict";
import type { SharedOperation, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, observeSharedTransactions, observeSharedUpdates } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { scalarTarget } from "../../../src/adapters/collab/scalar-executor.ts";
import { readSharedStatus, readSharedStatusHeads, readSharedStatusNotices } from "../../../src/adapters/collab/status.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { operation, ref, replicas } from "./executor-support.ts";

const BEAT = { scope: "beat", record: ref("R1") } as const;
const TEXT: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
const BOLD = { kind: "b", value: true } as const;
const ORDERS = ["D1", "rev", "dup"] as const;
const NAMES = ["Alice", "Bob", "Carol"] as const;

function text(handle: SharedDocumentHandle): string {
  return (readSharedTextHistory(handle, TEXT)?.units ?? []).map(unit => String(unit.value) + (unit.marks.some(group => group.kind === "b") ? "*" : "")).join(" ");
}

function insert(handle: SharedDocumentHandle, who: number, at: number, value: string): SharedOperation {
  const left = createSharedAnchor(handle, TEXT, at, "before");
  assert.ok(left);
  return operation({ kind: "text-insert", id: NAMES[who] + ":" + value, by: NAMES[who], target: TEXT, at: { left, right: null, affinity: "after" }, content: [{ value, marks: [] }] });
}

function mark(handle: SharedDocumentHandle, who: number, id: string, from: number, to: number, value: true | null): SharedOperation {
  const span = captureSharedTextRange(handle, TEXT, from, to);
  assert.ok(span);
  return operation({ kind: "mark", id, by: NAMES[who], target: TEXT, observed: [span], mark: { ...BOLD, value } });
}

function seconds(who: number, value: number): SharedOperation {
  return operation({ kind: "scalar", id: NAMES[who] + ":seconds", by: NAMES[who], target: BEAT, field: "lengthSeconds", value });
}

function status(handle: SharedDocumentHandle, who: number, id: string, value: string): SharedOperation {
  return operation({ kind: "status", id, by: NAMES[who], target: BEAT, value, parents: readSharedStatusHeads(handle, BEAT) });
}

interface HeldCase {
  readonly kind: string;
  readonly seed?: (alice: SharedDocumentHandle) => readonly SharedOperation[];
  readonly other: (handle: SharedDocumentHandle, who: number) => SharedOperation;
  readonly command: (alice: SharedDocumentHandle, during: () => () => void, undo: (record: SharedUndoRecord) => SharedUndoRecord) => SharedUndoRecord;
  readonly read: (handle: SharedDocumentHandle) => unknown;
  readonly expected: { readonly 2: unknown; readonly 3: unknown };
}

function commanded(alice: SharedDocumentHandle, operations: readonly SharedOperation[]): SharedUndoRecord {
  const execution = executeSharedCommand(alice, operations, { label: "command", selection: null, typing: null });
  assert.deepEqual(execution.result, { ok: true });
  assert.ok(execution.record);
  return execution.record;
}

const CASES: readonly HeldCase[] = [
  { kind: "text", other: (handle, who) => insert(handle, who, 2, String(NAMES[who]).charAt(0)),
    command: (alice, during) => { const stop = during(); try { return commanded(alice, [insert(alice, 0, 2, "A")]); } finally { stop(); } },
    read: text, expected: { 2: "a b B Z", 3: "a b B C Z" } },
  { kind: "mark-add", other: (handle, who) => mark(handle, who, NAMES[who] + ":bold", 1, 3, true),
    command: (alice, during) => { const stop = during(); try { return commanded(alice, [mark(alice, 0, "Alice:bold", 0, 2, true)]); } finally { stop(); } },
    read: text, expected: { 2: "a b* Z*", 3: "a b* Z*" } },
  { kind: "mark-remove", seed: alice => [mark(alice, 0, "seed:bold", 0, 3, true)], other: (handle, who) => mark(handle, who, NAMES[who] + ":plain", 1, 3, null),
    command: (alice, during) => { const stop = during(); try { return commanded(alice, [mark(alice, 0, "Alice:plain", 0, 2, null)]); } finally { stop(); } },
    read: text, expected: { 2: "a* b* Z", 3: "a* b* Z" } },
  { kind: "scalar", other: (_handle, who) => seconds(who, 20 + who),
    command: (alice, during) => { const stop = during(); try { return commanded(alice, [seconds(0, 7)]); } finally { stop(); } },
    read: handle => scalarTarget(handle, BEAT)?.get("lengthSeconds"), expected: { 2: 21, 3: 22 } },
  { kind: "status", other: (handle, who) => status(handle, who, NAMES[who] + ":status", "shot"),
    command: (alice, during) => { const stop = during(); try { return commanded(alice, [status(alice, 0, "Alice:status", "ready")]); } finally { stop(); } },
    read: handle => [readSharedStatus(handle, BEAT), readSharedStatusNotices(handle, BEAT)],
    expected: { 2: ["todo", ["Alice: concurrent status change did not apply", "Bob: concurrent status change did not apply"]],
      3: ["todo", ["Alice: concurrent status change did not apply", "Bob: concurrent status change did not apply", "Carol: concurrent status change did not apply"]] } },
  { kind: "status-retired", other: (handle, who) => status(handle, who, NAMES[who] + ":status", "shot"),
    command: (alice, during, undo) => {
      const retired = undo(commanded(alice, [status(alice, 0, "Alice:status", "ready")]));
      assert.deepEqual(retired.parts.map(part => part.kind), ["status-retired"]);
      const stop = during();
      try { return undo(retired); } finally { stop(); }
    },
    read: handle => [readSharedStatus(handle, BEAT), readSharedStatusHeads(handle, BEAT)],
    expected: { 2: ["todo", ["[\"1\",\"undo:2\"]", "[\"2\",\"Bob:status\"]"]], 3: ["todo", ["[\"1\",\"undo:2\"]", "[\"2\",\"Bob:status\"]", "[\"3\",\"Carol:status\"]"]] } }
];

for (const item of CASES) for (const writers of [2, 3] as const) for (const order of ORDERS) {
  test(`${item.kind}: another writer's change to the same target arrives during the command's notification; the undo leaves it: ${writers} writers, ${order}`, () => {
    const run = replicas(3), copies = [run.a, run.b, run.c].slice(0, writers), late = createMonitoredSharedDocument();
    const [alice, ...others] = copies;
    assert.ok(alice);
    try {
      for (const handle of copies) { registerSharedTextOperationHandlers(handle); registerSharedUndoOperationHandlers(handle); }
      registerSharedTextOperationHandlers(late); registerSharedUndoOperationHandlers(late);
      if (item.seed) {
        assert.deepEqual(executeSharedOperations(alice, item.seed(alice)), { ok: true });
        run.queue.flush("D1");
      }
      const incoming: Uint8Array[] = [];
      others.forEach((handle, index) => {
        const stop = observeSharedUpdates(handle, update => { incoming.push(update); });
        assert.deepEqual(executeSharedOperations(handle, [item.other(handle, index + 1)]), { ok: true });
        stop();
      });
      assert.equal(incoming.length, writers - 1);
      let serial = 0, delivered = 0;
      const writer = { by: "Alice", nextId: () => "undo:" + ++serial };
      const undo = (record: SharedUndoRecord): SharedUndoRecord => {
        const reversal = reverseSharedUndoRecord(alice, record, writer);
        assert.ok(reversal.ok);
        return reversal.inverse;
      };
      const during = () => observeSharedTransactions(alice, () => {
        for (let next = incoming.shift(); next; next = incoming.shift()) { assert.deepEqual(applySharedUpdate(alice, next), { ok: true }); delivered++; }
      });
      const record = item.command(alice, during, undo);
      assert.equal(delivered, writers - 1);
      undo(record);
      run.queue.flush(order);
      assert.ok(applySharedUpdate(late, encodeSharedState(alice)).ok);
      const expected = item.expected[writers];
      assert.deepEqual([...copies, late].map(item.read), [...copies, late].map(() => expected));
    } finally { destroySharedDocument(late); run.close(); }
  });
}
