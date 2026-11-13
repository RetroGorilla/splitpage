import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../application/session/shared-session-support.ts";
import { createSharedBufferedText } from "../../src/adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import { projectSharedDocumentWithRecovery } from "../../src/adapters/collab/project.ts";
import { scalarTarget } from "../../src/adapters/collab/scalar-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../src/adapters/collab/undo-executor.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { mergeSharedUndoRecords, sharedUndoGroupKey } from "../../src/core/collab/undo-record.ts";
import type { SharedUndoRecord } from "../../src/core/collab/undo-record.ts";
import { assertReplicasAgree } from "./agreement.ts";
import { bufferReaders, bufferStamps } from "./buffer-readers.ts";

const ORDERS = ["D1", "rev", "dup", "late-C"] as const;
const at = (second: number): string => "2026-11-12T10:00:0" + second + ".000Z";

function writer(h: Stage1ExecutorHarness, handle: SharedDocumentHandle, by: string, second: number) {
  const session = sharedHarness(adapterReplica(handle));
  let serial = 0;
  const port = createSharedBufferedText(handle, session.session, { target: id => h.target(id), author: () => ({ id: by + ":buffer:" + ++serial, by }), readers: bufferReaders,
    stamps: bufferStamps(by, () => at(second)) });
  const open = () => {
    const painted = readSharedPaintedText(handle, h.target("R1")); assert.ok(painted);
    const edit = port.open("R1", painted); assert.ok(edit);
    return edit;
  };
  return { session, open };
}

function stamps(handle: SharedDocumentHandle): unknown {
  const row = projectSharedDocumentWithRecovery(handle).document.rows[0];
  return { at: row?.updatedAt, by: row?.updatedBy };
}

function stored(h: Stage1ExecutorHarness, handle: SharedDocumentHandle): string[] {
  const beat = scalarTarget(handle, { scope: "beat", record: h.target("R1").owner }); assert.ok(beat);
  return [...beat.keys()].filter(key => key.startsWith("stamp")).sort();
}

function agree(h: Stage1ExecutorHarness, label: string, order: typeof ORDERS[number]): void {
  assertReplicasAgree(label, [h.a, h.b, h.c].map((handle, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order,
    replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const, output: projectSharedDocumentWithRecovery(handle) })));
}

test("a Writer commit carries one stamp for its beat in its own list, and every copy shows it", () => {
  for (const order of ORDERS) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]), a = writer(h, h.a, "Alice", 4);
    try {
      const edit = a.open(); edit.replace(2, 2, "x");
      assert.equal(edit.commit([{ text: "abx", marks: {} }]).kind, "applied");
      assert.deepEqual(a.session.executed.map(entry => entry.operations.map(operation => operation.kind === "scalar"
        ? [operation.target, operation.field, "value" in operation ? operation.value : null] : operation.kind)),
      [["text-insert", [{ scope: "beat", record: "R1" }, "stamp", { at: "2026-11-12T10:00:04.000Z", by: "Alice" }]]]);
      h.queue.flush(order); h.join();
      agree(h, "one stamp", order);
      for (const handle of [h.a, h.b, h.c]) assert.deepEqual(stamps(handle), { at: "2026-11-12T10:00:04.000Z", by: "Alice" });
    } finally { a.session.session.dispose(); h.destroy(); }
  }
});

const CONCURRENT = [
  { a: ["Alice", 5], b: ["Bob", 1], shown: { at: "2026-11-12T10:00:05.000Z", by: "Alice" } },
  { a: ["Alice", 1], b: ["Bob", 5], shown: { at: "2026-11-12T10:00:05.000Z", by: "Bob" } },
  { a: ["Alice", 3], b: ["Bob", 3], shown: { at: "2026-11-12T10:00:03.000Z", by: "Bob" } },
  { a: ["Bob", 3], b: ["Alice", 3], shown: { at: "2026-11-12T10:00:03.000Z", by: "Bob" } }
] as const;

test("two copies stamp one beat at the same moment: every copy shows the later time, then the later name, whichever copy wrote it", () => {
  for (const { a: [first, early], b: [second, late], shown } of CONCURRENT) for (const order of ORDERS) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]), a = writer(h, h.a, first, early), b = writer(h, h.b, second, late);
    try {
      const left = a.open(), right = b.open();
      left.replace(0, 0, "x"); right.replace(2, 2, "y");
      assert.equal(left.commit([{ text: "xab", marks: {} }]).kind, "applied");
      assert.equal(right.commit([{ text: "aby", marks: {} }]).kind, "applied");
      h.queue.flush(order); h.join();
      agree(h, "concurrent stamps", order);
      for (const handle of [h.a, h.b, h.c]) {
        assert.deepEqual(stamps(handle), shown, first + " and " + second + ", " + order);
        assert.deepEqual(stored(h, handle), ["stamp:Alice:buffer:1:stamp", "stamp:Bob:buffer:1:stamp"]);
      }
    } finally { a.session.session.dispose(); b.session.session.dispose(); h.destroy(); }
  }
});

test("a stamp replaces the stamps its copy has seen, even with an earlier clock, and the beat keeps only it", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]), a = writer(h, h.a, "Alice", 5), b = writer(h, h.b, "Bob", 1);
  try {
    let edit = a.open(); edit.replace(2, 2, "x");
    assert.equal(edit.commit([{ text: "abx", marks: {} }]).kind, "applied");
    h.queue.flush("D1");
    edit = b.open(); edit.replace(3, 3, "y");
    assert.equal(edit.commit([{ text: "abxy", marks: {} }]).kind, "applied");
    h.queue.flush("D1"); h.join();
    for (const handle of [h.a, h.b, h.c]) {
      assert.deepEqual(stamps(handle), { at: "2026-11-12T10:00:01.000Z", by: "Bob" });
      assert.deepEqual(stored(h, handle), ["stamp:Bob:buffer:1:stamp"]);
    }
  } finally { a.session.session.dispose(); b.session.session.dispose(); h.destroy(); }
});

test("undo of stamped typing leaves the stamp on every copy, and the stamped keystrokes still group", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]);
  try {
    for (const handle of [h.a, h.b, h.c]) registerSharedUndoOperationHandlers(handle);
    const typed = (offset: number, value: string, second: number): SharedUndoRecord => {
      const operations = [h.insertion("A", "R1", h.point("A", "R1", offset), value),
        h.command("A", { kind: "scalar", target: { scope: "beat", record: h.target("R1").owner }, field: "stamp", value: { at: at(second), by: "Alice" } })];
      const execution = executeSharedCommand(h.a, operations, { label: "typing", selection: null, typing: value });
      assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record);
      return execution.record;
    };
    const first = typed(2, "x", 1), second = typed(3, "y", 2);
    assert.deepEqual([first, second].map(record => record.parts.map(part => part.kind)), [["text"], ["text"]]);
    assert.equal(sharedUndoGroupKey(first), '["R1","b:R1","audioText"]');
    assert.equal(sharedUndoGroupKey(second), sharedUndoGroupKey(first));
    const group = mergeSharedUndoRecords(first, second); assert.ok(group);
    let serial = 0;
    const reversal = reverseSharedUndoRecord(h.a, group, { by: "Alice", nextId: () => "undo:" + ++serial });
    assert.equal(reversal.ok && reversal.effective, true);
    h.queue.flush("D1"); h.join();
    for (const handle of [h.a, h.b, h.c]) {
      assert.equal(projectSharedDocumentWithRecovery(handle).document.rows[0]?.audioText, "ab");
      assert.deepEqual(stamps(handle), { at: "2026-11-12T10:00:02.000Z", by: "Alice" });
    }
  } finally { h.destroy(); }
});
