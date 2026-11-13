import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedCommand, sharedHarness } from "../application/session/shared-session-support.ts";
import { createSharedBufferedText } from "../../src/adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import { projectSharedDocumentWithRecovery } from "../../src/adapters/collab/project.ts";
import { registerSharedRecordHandlers } from "../../src/adapters/collab/record-executor.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { newRegistryTag } from "../../src/core/production/tags.ts";
import { namedTagId } from "../../src/core/text/runs.ts";
import type { Run } from "../../src/core/text/runs.ts";
import { assertReplicasAgree } from "./agreement.ts";
import { bufferReaders, bufferStamps } from "./buffer-readers.ts";

const CHAIR = { id: "t_l9u69h7au1fw", cat: "prop", name: "Chair", status: "needed" };
const DOOR = { id: "t_1opaishvqv40e", cat: "sound", name: "door slam", status: "needed" };
const chair = (text = "Chair"): Run => ({ text, marks: { tag: namedTagId("prop", "Chair") } });

function writer(h: Stage1ExecutorHarness, handle: SharedDocumentHandle, by: string) {
  const session = sharedHarness(adapterReplica(handle));
  let serial = 0;
  const port = createSharedBufferedText(handle, session.session, { target: id => h.target(id), author: () => ({ id: by + ":buffer:" + ++serial, by }), readers: bufferReaders,
    stamps: bufferStamps(by) });
  const open = (row = "R1") => {
    const painted = readSharedPaintedText(handle, h.target(row)); assert.ok(painted);
    const edit = port.open(row, painted); assert.ok(edit);
    return edit;
  };
  return { session, open, sent: () => session.executed.map(entry => entry.operations.map(operation => operation.kind === "record-create"
    ? [operation.kind, operation.target.record, operation.fields] : operation.kind)) };
}

function harness(rows = [{ id: "R1", text: "ab" }]): Stage1ExecutorHarness {
  const h = new Stage1ExecutorHarness(rows);
  for (const handle of [h.a, h.b, h.c]) registerSharedRecordHandlers(handle);
  return h;
}

function tags(handle: SharedDocumentHandle): unknown {
  return projectSharedDocumentWithRecovery(handle).document.productionTags?.map(tag => ({ id: tag?.id, cat: tag?.cat, name: tag?.name, status: tag?.status }));
}

test("a tag typed into narration with no registry entry gets one, minted as a normal script mints it, on every copy", () => {
  assert.deepEqual([newRegistryTag([], "prop", "Chair"), newRegistryTag([], "sound", "door slam")], [{ ...CHAIR, owner: "", notes: "" }, { ...DOOR, owner: "", notes: "" }]);
  for (const order of ["D1", "rev", "dup", "late-C"] as const) {
    const h = harness(), a = writer(h, h.a, "Alice");
    try {
      const edit = a.open(); edit.replace(2, 2, "Chair");
      assert.equal(edit.commit([{ text: "ab", marks: {} }, chair()]).kind, "applied");
      assert.deepEqual(a.sent(), [["text-insert", ["record-create", CHAIR.id, { cat: "prop", name: "Chair", status: "needed" }], "scalar"]]);
      h.queue.flush(order); h.join();
      assertReplicasAgree("tag from text", [h.a, h.b, h.c].map((handle, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order,
        replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const, output: projectSharedDocumentWithRecovery(handle) })));
      for (const handle of [h.a, h.b, h.c]) assert.deepEqual(tags(handle), [CHAIR]);
    } finally { a.session.session.dispose(); h.destroy(); }
  }
});

test("a sound cue typed into narration gets a sound entry; plain typing, a registered tag and a tag the beat already showed unregistered get none", () => {
  const h = harness(), a = writer(h, h.a, "Alice");
  try {
    let edit = a.open(); edit.replace(2, 2, "x");
    assert.equal(edit.commit([{ text: "abx", marks: {} }]).kind, "applied");
    const cue: Run = { text: "SFX: door slam", marks: { cue: true } };
    edit = a.open(); edit.replace(3, 3, "\nSFX: door slam");
    assert.equal(edit.commit([{ text: "abx\n", marks: {} }, cue]).kind, "applied");
    edit = a.open(); edit.replace(0, 0, "Chair");
    assert.equal(edit.commit([chair(), { text: "abx\n", marks: {} }, cue]).kind, "applied");
    edit = a.open(); edit.replace(0, 0, "Chair");
    assert.equal(edit.commit([chair("ChairChair"), { text: "abx\n", marks: {} }, cue]).kind, "applied");
    const removal = h.command("A", { kind: "record-delete", target: { collection: "tags", record: CHAIR.id } });
    assert.equal(a.session.session.run(sharedCommand("remove tag", [removal])).kind, "applied");
    edit = a.open(); edit.replace(0, 0, "y");
    assert.equal(edit.commit([{ text: "y", marks: {} }, chair("ChairChair"), { text: "abx\n", marks: {} }, cue]).kind, "applied");
    const sent = a.sent();
    assert.deepEqual([sent[0], sent[1]?.slice(1), sent[2]?.slice(1), sent[3]?.slice(1), sent[5]?.slice(1)],
      [["text-insert", "scalar"], [["record-create", DOOR.id, { cat: "sound", name: "door slam", status: "needed" }], "scalar"],
        [["record-create", CHAIR.id, { cat: "prop", name: "Chair", status: "needed" }], "scalar"], ["scalar"], ["scalar"]]);
    assert.deepEqual(tags(h.a), [DOOR]);
  } finally { a.session.session.dispose(); h.destroy(); }
});

test("a registered tag typed into a beat that did not show it gets no entry, and the commit applies", () => {
  const h = harness([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]), a = writer(h, h.a, "Alice");
  try {
    let edit = a.open("R1"); edit.replace(2, 2, "Chair");
    assert.equal(edit.commit([{ text: "ab", marks: {} }, chair()]).kind, "applied");
    edit = a.open("R2"); edit.replace(0, 0, "Chair");
    assert.equal(edit.commit([chair(), { text: "cd", marks: {} }]).kind, "applied");
    assert.deepEqual(a.sent()[1], ["text-insert", "scalar"]);
    assert.deepEqual(tags(h.a), [CHAIR]);
    assert.deepEqual(projectSharedDocumentWithRecovery(h.a).recovery, []);
  } finally { a.session.session.dispose(); h.destroy(); }
});

test("two people type the same new tag at the same moment: both words stay and every copy keeps one entry", () => {
  for (const order of ["D1", "rev", "dup", "late-C"] as const) {
    const h = harness(), a = writer(h, h.a, "Alice"), b = writer(h, h.b, "Bob");
    try {
      const left = a.open(), right = b.open();
      left.replace(0, 0, "Chair"); right.replace(2, 2, "Chair");
      assert.equal(left.commit([chair(), { text: "ab", marks: {} }]).kind, "applied");
      assert.equal(right.commit([{ text: "ab", marks: {} }, chair()]).kind, "applied");
      h.queue.flush(order); h.join();
      assertReplicasAgree("same tag from two copies", [h.a, h.b, h.c].map((handle, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order,
        replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const, output: projectSharedDocumentWithRecovery(handle) })));
      for (const handle of [h.a, h.b, h.c]) {
        assert.deepEqual(tags(handle), [CHAIR]);
        assert.equal(h.characters(handle, "R1").map(char => char.value).join(""), "ChairabChair");
      }
    } finally { a.session.session.dispose(); b.session.session.dispose(); h.destroy(); }
  }
});
