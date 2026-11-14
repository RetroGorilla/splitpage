import { test } from "node:test";
import assert from "node:assert/strict";
import { replicas, operation, agree } from "./executor-support.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { beatPos, enterAt } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import type { SharedUndoRecord } from "../../../src/core/collab/undo-record.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const runtime = createFlowLoadRuntime();
const SOURCE = { rows: [{ id: "R1", audioText: "abX# Q<br>cd" }, { id: "R2", audioText: "ef" }] };

function read(handle: SharedDocumentHandle) {
  const document = projectSharedDocumentWithRecovery(handle).document;
  return { rows: document.rows.map(row => [row.id.startsWith("structure_") ? "Rs" : row.id, row.audioText]),
    headings: ((document.sections ?? []) as { readonly name: unknown }[]).map(section => section.name) };
}

function setup() {
  const set = replicas(3, SOURCE), handles = [set.a, set.b, set.c];
  for (const handle of handles) registerSharedOperationFamilies(handle, { cells: runtime.cells });
  let serial = 0;
  const enter = (): SharedUndoRecord => {
    const document = projectSharedDocumentWithRecovery(set.a).document;
    const outcome = enterAt({ rows: document.rows, comments: [] } as FlowDoc, { anchor: beatPos("R1", 2), head: beatPos("R1", 3) },
      { ...runtime.ports, newId: () => "fresh", operations: { id: "enter", by: "Writer" } });
    assert.ok(outcome && "rows" in outcome && outcome.ops);
    const execution = executeSharedCommand(set.a, [...outcome.ops], { label: "enter", selection: null, typing: null }, { base: readSharedRevision(set.a) });
    assert.deepEqual(execution.result, { ok: true }); assert.ok(execution.record); return execution.record;
  };
  const head = (beat: string): void => {
    const base = (from: number, to = from) => flowBaseReference(beat, "audioText", from, to);
    const finalize = operation({ kind: "heading-finalize", id: "fin", by: "Other", target: { owner: beat, segment: beat, field: "audioText" }, heading: "Hq",
      prefix: [base(0, 2)], name: [base(2, 3)], separator: [base(3, 4)], retainedBeat: beat, emptyBeat: null, tail: { left: null, right: base(4), affinity: "before" } });
    assert.deepEqual(executeSharedOperations(set.b, [finalize], { base: readSharedRevision(set.b) }), { ok: true });
  };
  const reverse = (record: SharedUndoRecord): SharedUndoRecord => {
    const done = reverseSharedUndoRecord(set.a, record, { by: "Writer", nextId: () => "undo" + String(++serial) });
    assert.ok(done.ok, JSON.stringify(done)); assert.equal(done.effective, true); return done.inverse;
  };
  const newBeat = (record: SharedUndoRecord): string => {
    const beat = record.parts.flatMap(part => part.kind === "beat-split" ? [part.beat] : [])[0]; assert.ok(beat); return beat;
  };
  return { set, handles, enter, head, reverse, newBeat };
}

const headed = { rows: [["R1", "ab"], ["Rs", "cd"], ["R2", "ef"]], headings: ["Q"] };
const undone = { rows: [["R1", "abX"], ["Rs", "cd"], ["R2", "ef"]], headings: ["Q"] };

test("Enter over a selection records as deleted only the selected character, not the ones that moved into the new beat", () => {
  const { set, enter } = setup();
  try {
    const record = enter();
    assert.deepEqual(record.parts.map(part => part.kind === "text" ? [part.kind, part.deleted.map(unit => unit.value)] : [part.kind]), [["text", ["X"]], ["beat-split"]]);
  } finally { set.close(); }
});

for (const order of deliveryOrders) test(`undo of Enter over a selection never brings back the "# " and line break another writer's heading consumed, on three copies: ${order}`, () => {
  const { set, handles, enter, head, reverse, newBeat } = setup();
  try {
    const record = enter(); set.queue.flush(order);
    agree("entered", order, handles, read, { rows: [["R1", "ab"], ["Rs", "# Q<br>cd"], ["R2", "ef"]], headings: [] });
    head(newBeat(record)); set.queue.flush(order); agree("headed", order, handles, read, headed);
    const back = reverse(record); set.queue.flush(order); agree("undone", order, handles, read, undone);
    const again = reverse(back); set.queue.flush(order); agree("redone", order, handles, read, headed);
    reverse(again); set.queue.flush(order); agree("undone again", order, handles, read, undone);
  } finally { set.close(); }
});

for (const order of deliveryOrders) test(`an undo of Enter over a selection in flight while another writer heads the new beat brings back only the selected character, on three copies: ${order}`, () => {
  const { set, handles, enter, head, reverse, newBeat } = setup();
  try {
    const record = enter(); set.queue.flush(order);
    reverse(record); head(newBeat(record)); set.queue.flush(order);
    agree("undone and headed", order, handles, read, undone);
  } finally { set.close(); }
});
