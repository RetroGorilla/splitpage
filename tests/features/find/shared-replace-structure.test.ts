import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { fakeNotices, fakeWriterBufferEffects } from "../fakes.ts";
import { FIND_AT, FIND_ORDERS, agreedRows, deliverAll, findCopy, findReplicas, findSource, finder, sendAs } from "./shared-replace-support.ts";

const NEW = "structure_2_006300750074_beat_0";
const SPLIT = { kind: "split", id: "cut", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
  at: { left: null, right: flowBaseReference("R1", "audioText", 3, 3), affinity: "before" },
  observed: [flowBaseReference("R1", "audioText", 0, 3), flowBaseReference("R1", "audioText", 3, 12)], boundary: "N1", beat: "N1",
  fields: { visualText: "", imageRef: null, status: "todo", stamp: { at: FIND_AT, by: "Bob" } } };
const JOIN = { kind: "join", id: "joined", by: "Bob", from: "R2", into: "R1", glue: " " };
const REMOVE = { kind: "remove", id: "removed", by: "Bob", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 12)],
  boundaries: ["R1"], components: [], gallery: [], at: 0 };

type Rows = readonly (readonly [string, unknown])[];
interface Step { readonly outcome: Record<string, unknown>; readonly rows: Rows }
interface Structure {
  readonly name: string;
  readonly operation: unknown;
  readonly synced: boolean;
  readonly after: Rows;
  readonly undo: Step;
  readonly redo?: Step;
  readonly right?: string;
}

const STRUCTURES: readonly Structure[] = [
  { name: "another copy splits the line inside the match while it is replaced", operation: SPLIT, synced: false,
    after: [["R1", "a mug"], [NEW, " of tea"], ["R2", "a cup"]],
    undo: { outcome: { ok: true, effective: true }, rows: [["R1", "a c"], [NEW, "up of tea"], ["R2", "a cup"]] },
    redo: { outcome: { ok: true, effective: true }, rows: [["R1", "a mug"], [NEW, "up of tea"], ["R2", "a cup"]] },
    right: "redo gives a mug | of tea" },
  { name: "another copy joins the next line into this one while it is replaced", operation: JOIN, synced: false,
    after: [["R1", "a mug of tea a cup"]],
    undo: { outcome: { ok: false, reason: "invalid-reference" }, rows: [["R1", "a mug of tea a cup"]] },
    right: "undo gives a cup of tea a cup" },
  { name: "the line is replaced after another copy's join has arrived", operation: JOIN, synced: true,
    after: [["R1", "a mug of tea a cup"]],
    undo: { outcome: { ok: false, reason: "invalid-reference" }, rows: [["R1", "a mug of tea a cup"]] },
    right: "undo gives a cup of tea a cup" },
  { name: "another copy removes the line while it is replaced", operation: REMOVE, synced: false,
    after: [["R2", "a cup"]],
    undo: { outcome: { ok: false, reason: "missing-target" }, rows: [["R2", "a cup"]] } }
];

function handTyped(set: ReturnType<typeof findReplicas>, a: ReturnType<typeof findCopy>) {
  let serial = 0;
  const ports = sharedBufferPorts(set.a, a.session, { ...fakeWriterBufferEffects().effects, readers: bufferReaders, stamps: bufferStamps("Alice", () => FIND_AT),
    author: () => ({ id: "hand" + ++serial, by: "Alice" }) });
  const base = ports.paintedText.read("R1", "audioText"); assert.ok(base);
  const edit = ports.bufferedText.open("R1", base); assert.ok(edit);
  const text = edit.text();
  edit.replace(2, 5, "mug");
  assert.equal(edit.commit([{ text: text.slice(0, 2) + "mug" + text.slice(5), marks: {} }]).kind, "applied");
}

function found(a: ReturnType<typeof findCopy>, notices: ReturnType<typeof fakeNotices>) {
  const route = finder(a.session, notices, a.shared);
  try { route.search("cup", "mug"); route.replace(); } finally { route.dispose(); }
}

function projected(set: ReturnType<typeof findReplicas>, label: string, order: typeof FIND_ORDERS[number]): Rows {
  agreedRows(label, set, order);
  return projectSharedDocumentWithRecovery(set.a).document.rows.map(row => [row.id, row.audioText] as const);
}

const outcome = (value: unknown) => {
  const result = value as Record<string, unknown>;
  return Object.fromEntries(["ok", "effective", "reason"].filter(key => key in result).map(key => [key, result[key]]));
};

for (const structure of STRUCTURES) for (const way of ["typed by hand", "Find"] as const) for (const order of FIND_ORDERS) {
  const label = structure.right ? `known wrong today (${structure.right}): ` : "";
  test(`${label}${structure.name}, replacement ${way}: ${order}`, () => {
    const notices = fakeNotices(), document = findSource("a cup of tea");
    (document.comments as unknown[]).length = 0;
    const set = findReplicas(document), a = findCopy(set.a, "Alice", notices);
    try {
      if (structure.synced) { sendAs(set.b, structure.operation); deliverAll(set.queue, order); }
      if (way === "Find") found(a, notices); else handTyped(set, a);
      if (!structure.synced) sendAs(set.b, structure.operation);
      deliverAll(set.queue, order);
      assert.deepEqual(projected(set, "after", order), structure.after);
      assert.deepEqual(outcome(a.owner.undo()), structure.undo.outcome);
      deliverAll(set.queue, order);
      assert.deepEqual(projected(set, "undone", order), structure.undo.rows);
      if (structure.redo) {
        assert.deepEqual(outcome(a.owner.redo()), structure.redo.outcome);
        deliverAll(set.queue, order);
        assert.deepEqual(projected(set, "redone", order), structure.redo.rows);
      }
    } finally { a.session.dispose(); set.close(); }
  });
}
