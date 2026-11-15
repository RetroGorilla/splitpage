import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { fakeNotices, fakeWriterBufferEffects } from "../fakes.ts";
import { FIND_AT, FIND_ORDERS, agreedRows, deliverAll, findAct, findCopy, findReplicas, findSource, finder, sendAs } from "./shared-replace-support.ts";

const NEW = "structure_2_006300750074_beat_0";
const splitAt = (at: number) => ({ kind: "split", id: "cut", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" },
  at: { left: null, right: flowBaseReference("R1", "audioText", at, at), affinity: "before" },
  observed: [flowBaseReference("R1", "audioText", 0, at), flowBaseReference("R1", "audioText", at, 12)], boundary: "N1", beat: "N1",
  fields: { visualText: "", imageRef: null, status: "todo", stamp: { at: FIND_AT, by: "Bob" } } });
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
  readonly second?: true;
}

const DONE = { ok: true, effective: true };
const split = (name: string, at: number, after: Rows, undone: Rows): Structure =>
  ({ name: `another copy splits the line ${name} while it is replaced`, operation: splitAt(at), synced: false, after,
    undo: { outcome: DONE, rows: undone }, redo: { outcome: DONE, rows: after } });

const STRUCTURES: readonly Structure[] = [
  split("before the match", 1, [["R1", "a"], [NEW, " mug of tea"], ["R2", "a cup"]], [["R1", "a"], [NEW, " cup of tea"], ["R2", "a cup"]]),
  split("at the start of the match", 2, [["R1", "a mug"], [NEW, " of tea"], ["R2", "a cup"]], [["R1", "a "], [NEW, "cup of tea"], ["R2", "a cup"]]),
  split("inside the match", 3, [["R1", "a mug"], [NEW, " of tea"], ["R2", "a cup"]], [["R1", "a c"], [NEW, "up of tea"], ["R2", "a cup"]]),
  split("at the end of the match", 5, [["R1", "a mug"], [NEW, " of tea"], ["R2", "a cup"]], [["R1", "a cup"], [NEW, " of tea"], ["R2", "a cup"]]),
  split("after the match", 7, [["R1", "a mug o"], [NEW, "f tea"], ["R2", "a cup"]], [["R1", "a cup o"], [NEW, "f tea"], ["R2", "a cup"]]),
  { name: "another copy joins the next line into this one while it is replaced", operation: JOIN, synced: false,
    after: [["R1", "a mug of tea a cup"]],
    undo: { outcome: DONE, rows: [["R1", "a cup of tea a cup"]] }, redo: { outcome: DONE, rows: [["R1", "a mug of tea a cup"]] } },
  { name: "the line is replaced after another copy's join has arrived", operation: JOIN, synced: true,
    after: [["R1", "a mug of tea a cup"]],
    undo: { outcome: DONE, rows: [["R1", "a cup of tea a cup"]] }, redo: { outcome: DONE, rows: [["R1", "a mug of tea a cup"]] } },
  { name: "another copy joins this line into the one before while it is replaced", operation: JOIN, synced: false, second: true,
    after: [["R1", "a cup of tea a mug"]],
    undo: { outcome: DONE, rows: [["R1", "a cup of tea a cup"]] }, redo: { outcome: DONE, rows: [["R1", "a cup of tea a mug"]] } },
  { name: "the joined-in line is replaced after another copy's join has arrived", operation: JOIN, synced: true, second: true,
    after: [["R1", "a cup of tea a mug"]],
    undo: { outcome: DONE, rows: [["R1", "a cup of tea a cup"]] }, redo: { outcome: DONE, rows: [["R1", "a cup of tea a mug"]] } },
  { name: "another copy removes the line while it is replaced", operation: REMOVE, synced: false,
    after: [["R2", "a cup"]],
    undo: { outcome: { ok: false, reason: "missing-target" }, rows: [["R2", "a cup"]] } }
];

function handTyped(set: ReturnType<typeof findReplicas>, a: ReturnType<typeof findCopy>, second: boolean) {
  let serial = 0;
  const ports = sharedBufferPorts(set.a, a.session, { ...fakeWriterBufferEffects().effects, readers: bufferReaders, stamps: bufferStamps("Alice", () => FIND_AT),
    author: () => ({ id: "hand" + ++serial, by: "Alice" }) });
  const row = second && projectSharedDocumentWithRecovery(set.a).document.rows.some(item => item.id === "R2") ? "R2" : "R1";
  const base = ports.paintedText.read(row, "audioText"); assert.ok(base);
  const edit = ports.bufferedText.open(row, base); assert.ok(edit);
  const text = edit.text(), at = second ? text.lastIndexOf("cup") : text.indexOf("cup");
  edit.replace(at, at + 3, "mug");
  assert.equal(edit.commit([{ text: text.slice(0, at) + "mug" + text.slice(at + 3), marks: {} }]).kind, "applied");
}

function found(a: ReturnType<typeof findCopy>, notices: ReturnType<typeof fakeNotices>, second: boolean) {
  const route = finder(a.session, notices, a.shared);
  try { findAct(route, { find: "cup", put: "mug", nth: second ? 1 : 0 }); } finally { route.dispose(); }
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
  test(`${structure.name}, replacement ${way}: ${order}`, () => {
    const notices = fakeNotices(), document = findSource("a cup of tea");
    (document.comments as unknown[]).length = 0;
    const set = findReplicas(document), a = findCopy(set.a, "Alice", notices);
    try {
      if (structure.synced) { sendAs(set.b, structure.operation); deliverAll(set.queue, order); }
      if (way === "Find") found(a, notices, !!structure.second); else handTyped(set, a, !!structure.second);
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
