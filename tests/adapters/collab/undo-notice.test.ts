import { test } from "node:test";
import assert from "node:assert/strict";
import { replicas, operation, agree } from "./executor-support.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { sharedUndoNotice } from "../../../src/application/editing/undo/shared-undo-notice.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedContentRef } from "../../../src/core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const runtime = createFlowLoadRuntime(), ORDERS = ["D1", "rev"] as const;
const SOURCE = { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }], people: [{ id: "P1", name: "Ada" }] };
const USED_UP = "That step could not be undone because someone else changed it.";
const cell = (owner: string) => ({ owner: owner as SharedContentRef, segment: owner as SharedContentRef, field: "audioText" as const });
const typeAt = (id: string, owner: string, offset: number, value: string, by = "Alice") => operation({ kind: "text-insert", id, by, target: cell(owner),
  at: { left: flowBaseReference(owner, "audioText", offset - 1), right: null, affinity: "after" }, content: [{ value, marks: [] }] });
const rows = (handle: SharedDocumentHandle) => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id.startsWith("structure_") ? "Rs" : row.id, row.audioText]);

function setup(order: typeof ORDERS[number]) {
  const set = replicas(2, SOURCE), handles = [set.a, set.b];
  for (const handle of handles) registerSharedOperationFamilies(handle, { cells: runtime.cells });
  let now = 0, serial = 0;
  const undo = createSharedUndo({ now: () => now, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(set.a, record, { by: "Alice", nextId: () => "undo" + String(++serial) }) });
  const notices: string[] = [];
  const perform = (label: string, ops: readonly ReturnType<typeof operation>[]) => {
    now += 5000;
    undo.perform(() => { const execution = executeSharedCommand(set.a, ops, { label, selection: null, typing: null }, { base: readSharedRevision(set.a) });
      assert.deepEqual(execution.result, { ok: true }); return execution.record; });
    set.queue.flush(order);
  };
  const press = () => { const outcome = undo.undo(), notice = sharedUndoNotice(outcome, "undo"); if (notice) notices.push(notice); set.queue.flush(order); return outcome; };
  const other = (...ops: unknown[]) => { assert.deepEqual(executeSharedOperations(set.b, ops.map(operation), { base: readSharedRevision(set.b) }), { ok: true }); set.queue.flush(order); };
  return { set, handles, undo, perform, press, other, notices, check: (label: string, expected: unknown) => agree(label, order, handles, rows, expected) };
}

const ways: readonly (readonly [string, (run: ReturnType<typeof setup>) => void, readonly (readonly string[])[]])[] = [
  ["the other person deleted the text", run => {
    run.perform("type", [typeAt("y", "R1", 4, "Y")]);
    run.other({ kind: "text-delete", id: "gone", by: "Bob", target: cell("R1"), observed: [createSharedAnchor(run.set.b, cell("R1"), 4, "after")] });
  }, [["R1", "abcd"], ["R2", "ef"]]],
  ["the other person removed the beat", run => {
    run.perform("type", [typeAt("y", "R1", 4, "Y")]);
    run.other({ kind: "remove", id: "gone", by: "Bob", removalKind: "beat", targets: ["R1"], boundaries: ["R1"], observed: [], components: [], gallery: [], at: 0 });
  }, [["R2", "ef"]]],
  ["the other person changed the new beat of a split", run => {
    run.perform("split", [operation({ kind: "split", id: "cut", by: "Alice", target: cell("R1"), at: { left: flowBaseReference("R1", "audioText", 1), right: null, affinity: "after" },
      observed: [], boundary: "Rs", beat: "Rs", fields: {} })]);
    const beat = projectSharedDocumentWithRecovery(run.set.b).document.rows[1]?.id; assert.ok(beat);
    run.other({ kind: "scalar", id: "f", by: "Bob", target: { scope: "beat", record: beat }, field: "lengthSeconds", value: 9 });
  }, [["R1", "ab"], ["Rs", "cd"], ["R2", "ef"]]],
  ["the other person deleted the record", run => {
    run.perform("rename", [operation({ kind: "record-set", id: "name", by: "Alice", target: { collection: "people", record: "P1" }, field: "name", value: "Ada B" })]);
    run.other({ kind: "record-delete", id: "gone", by: "Bob", target: { collection: "people", record: "P1" } });
  }, [["R1", "abcd"], ["R2", "ef"]]]
];

for (const [name, usedUp, after] of ways) for (const order of ORDERS) test(`rule 90: when ${name}, Ctrl+Z says so once, and the next Ctrl+Z takes back the step before: ${order}`, () => {
  const run = setup(order);
  try {
    run.perform("first", [typeAt("x", "R2", 2, "X")]);
    usedUp(run);
    const afterRows = after.map(row => [...row]), withX = afterRows.map(row => row[0] === "R2" ? ["R2", "efX"] : row);
    run.check("used up", withX);
    const outcome = run.press();
    assert.ok(outcome.ok && !outcome.effective && outcome.reason === "used-up", JSON.stringify(outcome));
    assert.deepEqual(run.notices, [USED_UP]); run.check("nothing written", withX);
    assert.deepEqual(run.press(), { ok: true, effective: true, label: "first", selection: null });
    assert.deepEqual(run.notices, [USED_UP]); run.check("the step before taken back", afterRows);
    assert.deepEqual(run.press(), { ok: false, empty: true }); assert.deepEqual(run.notices, [USED_UP]);
  } finally { run.set.close(); }
});
