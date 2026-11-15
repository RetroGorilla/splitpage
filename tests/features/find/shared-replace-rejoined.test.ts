import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { fakeNotices, fakeWriterBufferEffects } from "../fakes.ts";
import { FIND_AT, FIND_ORDERS, agreedRows, deliverAll, findAct, findCopy, findReplicas, findSource, finder, sendAs } from "./shared-replace-support.ts";

const FIRST = "structure_2_006300750074_beat_0", SECOND = "structure_2_0063007500740032_beat_0";
const split = (id: string, owner: string, at: number, length: number) => ({ kind: "split", id, by: "Bob", target: { owner, segment: owner, field: "audioText" },
  at: { left: null, right: flowBaseReference(owner, "audioText", at, at), affinity: "before" },
  observed: [flowBaseReference(owner, "audioText", 0, at), flowBaseReference(owner, "audioText", at, length)], boundary: "N" + id, beat: "N" + id,
  fields: { visualText: "", imageRef: null, status: "todo", stamp: { at: FIND_AT, by: "Bob" } } });
const join = (id: string, from: string, into = "R1") => ({ kind: "join", id, by: "Bob", from, into, glue: " " });
const ONCE = [[split("cut", "R1", 3, 12)], [join("rejoin", FIRST)]];
const TWICE = [[split("cut", "R1", 3, 12)], [split("cut2", FIRST, 3, 9)], [join("rejoin2", SECOND, FIRST)], [join("rejoin", FIRST)]];

const CASES = [
  { name: "a replacement across two rejoined spans", structure: ONCE, find: "c up", rejoined: "a c up of tea", after: "a mug of tea" },
  { name: "a replacement starting on the edge of a rejoined span", structure: ONCE, find: "up of", rejoined: "a c up of tea", after: "a c mug tea" },
  { name: "a replacement ending on the edge of a rejoined span", structure: ONCE, find: "a c", rejoined: "a c up of tea", after: "mug up of tea" },
  { name: "a replacement across three rejoined spans", structure: TWICE, find: "c up  of", rejoined: "a c up  of tea", after: "a mug tea" }
] as const;

function typed(set: ReturnType<typeof findReplicas>, a: ReturnType<typeof findCopy>, find: string) {
  let serial = 0;
  const ports = sharedBufferPorts(set.a, a.session, { ...fakeWriterBufferEffects().effects, readers: bufferReaders, stamps: bufferStamps("Alice", () => FIND_AT),
    author: () => ({ id: "hand" + ++serial, by: "Alice" }) });
  const base = ports.paintedText.read("R1", "audioText"); assert.ok(base);
  const edit = ports.bufferedText.open("R1", base); assert.ok(edit);
  const text = edit.text(), at = text.indexOf(find);
  assert.ok(at >= 0);
  edit.replace(at, at + find.length, "mug");
  assert.equal(edit.commit([{ text: text.slice(0, at) + "mug" + text.slice(at + find.length), marks: {} }]).kind, "applied");
}

const rows = (set: ReturnType<typeof findReplicas>, label: string, order: typeof FIND_ORDERS[number]) => {
  agreedRows(label, set, order);
  return projectSharedDocumentWithRecovery(set.a).document.rows.map(row => [row.id, row.audioText]);
};

for (const item of CASES) for (const way of ["typed by hand", "Find"] as const) for (const order of FIND_ORDERS) {
  test(`${item.name}, replacement ${way}, undone, redone and undone: ${order}`, () => {
    const notices = fakeNotices(), document = findSource("a cup of tea");
    (document.comments as unknown[]).length = 0;
    const set = findReplicas(document), a = findCopy(set.a, "Alice", notices);
    try {
      for (const step of item.structure) { sendAs(set.b, ...step); deliverAll(set.queue, order); }
      assert.deepEqual(rows(set, "rejoined", order), [["R1", item.rejoined], ["R2", "a cup"]]);
      if (way === "Find") {
        const route = finder(a.session, notices, a.shared);
        try { findAct(route, { find: item.find, put: "mug" }); } finally { route.dispose(); }
      } else typed(set, a, item.find);
      deliverAll(set.queue, order);
      assert.deepEqual(rows(set, "replaced", order), [["R1", item.after], ["R2", "a cup"]]);
      for (const [step, expected] of [["undo", item.rejoined], ["redo", item.after], ["undo", item.rejoined]] as const) {
        const result = (step === "undo" ? a.owner.undo() : a.owner.redo()) as Record<string, unknown>;
        assert.equal(result.ok, true); assert.equal(result.effective, true);
        deliverAll(set.queue, order);
        assert.deepEqual(rows(set, step, order), [["R1", expected], ["R2", "a cup"]]);
      }
    } finally { a.session.dispose(); set.close(); }
  });
}
