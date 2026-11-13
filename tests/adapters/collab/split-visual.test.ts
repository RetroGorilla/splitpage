import { test } from "node:test";
import * as Y from "yjs";
import assert from "node:assert/strict";
import { replicas, operation, agree } from "./executor-support.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import type { SharedContentRef } from "../../../src/core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const SOURCE = { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "de" }] };
const BEAT_A = "structure_1_0065006e007400650072_beat_0", VISUAL_A = "structure_1_0065006e007400650072_visual_0";
const BEAT_B = "structure_2_0065006e007400650072_beat_0", VISUAL_B = "structure_2_0065006e007400650072_visual_0";

function setup(copies: 2 | 3) {
  const set = replicas(copies, SOURCE);
  for (const handle of [set.a, set.b, set.c]) {
    registerSharedTextOperationHandlers(handle); registerSharedSplitHandlers(handle, { cells: createFlowLoadRuntime().cells }); registerSharedUndoOperationHandlers(handle);
  }
  return set;
}

function enter(by: string, offset: number, kind: "split" | "split-before" = "split") {
  return operation({ kind, id: "enter", by, target: { owner: "R1", segment: "b:R1", field: "audioText" },
    at: { left: null, right: flowBaseReference("R1", "audioText", offset), affinity: "before" }, observed: [], boundary: "enter-boundary", beat: "enter-beat", fields: { status: "todo" } });
}

function send(handle: SharedDocumentHandle, ...ops: ReturnType<typeof operation>[]): void {
  assert.deepEqual(executeSharedOperations(handle, ops, { base: readSharedRevision(handle) }), { ok: true });
}

function read(handle: SharedDocumentHandle) {
  const { roots } = collabState(handle);
  const visuals = [...roots.visuals.entries()].map(([id, visual]): unknown[] => {
    assert.ok(visual instanceof Y.Map);
    const text: unknown = visual.get("text"), marks: unknown = visual.get("markRecords"), beat: unknown = visual.get("beat"), rank: unknown = visual.get("rank");
    return [id, beat, rank, text instanceof Y.Text ? text.toString() : null, marks instanceof Y.Map ? marks.size : null];
  }).sort((x, y) => String(x[0]) < String(y[0]) ? -1 : 1);
  const links = [...roots.beats.entries()].map(([id, beat]): unknown[] => { const link: unknown = beat instanceof Y.Map ? beat.get("visual") : undefined; return [id, link ?? null]; }).sort((x, y) => String(x[0]) < String(y[0]) ? -1 : 1);
  return { rows: projectSharedDocument(handle).rows.map(row => [row.id, row.audioText, row.visualText]), visuals, links };
}

for (const order of deliveryOrders) for (const kind of ["split", "split-before"] as const) test(`9e: ${kind} creates the new beat's empty visual in the same step, and three copies agree (${order})`, () => {
  const set = setup(3);
  try {
    send(set.a, enter("Alice", 2, kind));
    set.queue.flush(order);
    const rows = kind === "split" ? [["R1", "ab", ""], [BEAT_A, "c", ""], ["R2", "de", ""]] : [[BEAT_A, "ab", ""], ["R1", "c", ""], ["R2", "de", ""]];
    agree(kind + " visual", order, [set.a, set.b, set.c], read, {
      rows, visuals: [["R1", "R1", "0000000000", "", 0], ["R2", "R2", "0000000000", "", 0], [VISUAL_A, BEAT_A, "0000000000", "", 0]],
      links: [["R1", null], ["R2", null], [BEAT_A, VISUAL_A]]
    });
  } finally { set.close(); }
});

for (const order of deliveryOrders) test(`9e: two copies splitting the same beat at once give each new beat exactly one visual (${order})`, () => {
  const set = setup(3);
  try {
    send(set.a, enter("Alice", 2)); send(set.b, enter("Bob", 2));
    set.queue.flush(order);
    agree("two splits", order, [set.a, set.b, set.c], handle => {
      const { visuals, links } = read(handle);
      return { owners: visuals.map(visual => visual[1]).sort(), links };
    }, { owners: ["R1", "R2", BEAT_A, BEAT_B].sort(), links: [["R1", null], ["R2", null], [BEAT_A, VISUAL_A], [BEAT_B, VISUAL_B]] });
  } finally { set.close(); }
});

test("9e undo: split, type in the new visual, undo the typing, undo the split; until split undo lands (#1534) the split stays and its visual is empty again on three copies", () => {
  const set = setup(3);
  try {
    let serial = 0;
    const undo = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
      reverse: record => reverseSharedUndoRecord(set.a, record, { by: "Alice", nextId: () => "undo-" + String(++serial) }) });
    const perform = (label: string, ops: readonly ReturnType<typeof operation>[]) => undo.perform(() => {
      const execution = executeSharedCommand(set.a, ops, { label, selection: null, typing: null }, { base: readSharedRevision(set.a) });
      assert.deepEqual(execution.result, { ok: true });
      return execution.record;
    });
    perform("enter", [enter("Alice", 2)]);
    const target = { owner: BEAT_A as SharedContentRef, segment: BEAT_A as SharedContentRef, field: "visualText" as const };
    const gap = readSharedPaintedText(set.a, target)?.emptyGap; assert.ok(gap);
    perform("type", [operation({ kind: "text-insert", id: "typed", by: "Alice", target, at: { left: null, right: gap, affinity: "before" }, content: [{ value: "V", marks: [] }] })]);
    set.queue.flush("D1");
    assert.deepEqual(read(set.b).rows, [["R1", "ab", ""], [BEAT_A, "c", "V"], ["R2", "de", ""]]);
    assert.deepEqual(undo.undo(), { ok: true, effective: true, label: "type", selection: null });
    const second = undo.undo();
    set.queue.flush("D1");
    agree("after both undos", "D1", [set.a, set.b, set.c], handle => read(handle).rows, [["R1", "ab", ""], [BEAT_A, "c", ""], ["R2", "de", ""]]);
    assert.deepEqual(second, { ok: false, reason: "undo-unsupported:split" });
  } finally { set.close(); }
});
