import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedCommand, sharedHarness } from "../application/session/shared-session-support.ts";
import { createSharedBufferedText } from "../../src/adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import { readSharedRevision, observeSharedTransactions, transactSharedDocument } from "../../src/adapters/collab/document.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { projectSharedDocumentWithRecovery } from "../../src/adapters/collab/project.ts";
import { assertReplicasAgree } from "./agreement.ts";
import { bufferReaders, bufferStamps } from "./buffer-readers.ts";

function editing(h: Stage1ExecutorHarness, row = "R1") {
  const session = sharedHarness(adapterReplica(h.a));
  let serial = 0;
  const port = createSharedBufferedText(h.a, session.session, { target: id => h.target(id), author: () => ({ id: "buffer:" + ++serial, by: "Alice" }), readers: bufferReaders,
    stamps: bufferStamps("Alice") });
  const painted = readSharedPaintedText(h.a, h.target(row)); assert.ok(painted);
  const edit = port.open(row, painted); assert.ok(edit);
  return { ...session, edit, port, painted };
}

for (const order of ["D1", "rev", "dup", "late-C"] as const) {
  for (const remote of ["same beat", "next beat", "removed beat"] as const) {
    test(`${remote === "removed beat" ? "stale base (T01)" : "painted native commit"}: ${remote}, ${order}`, () => {
      const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }]);
      const a = editing(h);
      try {
        a.edit.replace(1, 3, "Z");
        if (remote === "removed beat") transactSharedDocument(h.b, "local-command", () => {
          const beat = collabState(h.b).roots.beats.get("R1"); assert.ok(beat instanceof Y.Map);
          const removals: unknown = beat.get("removals"); assert.ok(removals instanceof Y.Map);
          removals.set("Bob:remove", true);
        });
        else {
          const row = remote === "same beat" ? "R1" : "R2";
          h.execute("B", [h.insertion("B", row, h.point("B", row, remote === "same beat" ? 2 : 1), "X")], ["b1"]);
          h.execute("B", [h.insertion("B", "R2", h.point("B", "R2", 0), "Y")], ["b2"]);
        }
        h.queue.deliverFrom("B", order);
        assert.equal(readSharedRevision(h.a), a.painted.revision);
        assert.equal(h.characters(h.a, "R1").map(char => char.value).join(""), "abcd");
        assert.equal(a.edit.commit([{ text: "aZd", marks: {} }]).kind, "applied");
        assert.equal(a.executed.length, 1);
        assert.equal(a.executed[0]?.base, a.painted.revision);
        const sent = a.executed[0]?.operations; assert.ok(sent);
        assert.deepEqual(sent.map(operation => operation.kind), ["text-insert", "text-delete", "scalar"]);
        assert.deepEqual(sent[1]?.kind === "text-delete" && sent[1].observed, [a.painted.identity(1), a.painted.identity(2)]);
        assert.deepEqual([...collabState(h.a).ingress.holds], []);
        h.queue.flush(order); h.join();
        const readings = [h.a, h.b, h.c].map((handle, index) => ({ order: index === 2 ? "late-C" as const : order === "late-C" ? "D1" as const : order,
          replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const,
          output: projectSharedDocumentWithRecovery(handle) }));
        assertReplicasAgree("buffer commit", readings);
        const projected = projectSharedDocumentWithRecovery(h.a);
        assert.deepEqual(projected.document.rows.map(row => [row.id, row.audioText]), remote === "removed beat"
          ? [["R2", "ef"]] : remote === "same beat" ? [["R1", "aZXd"], ["R2", "Yef"]] : [["R1", "aZd"], ["R2", "YeXf"]]);
        if (remote === "removed beat") {
          assert.deepEqual(projected.recovery.map(entry => entry.kind === "removed-beat" ? [entry.kind, entry.row.id, entry.row.audioText] : entry.kind), [["removed-beat", "R1", "aZd"]]);
        } else assert.deepEqual(projected.recovery, []);
      } finally { a.session.dispose(); h.destroy(); }
    });
  }
}

test("commit moment inside unchanged-revision delivery retains the dirty edit and succeeds on explicit retry", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]), a = editing(h);
  try {
    a.edit.replace(2, 2, "Z");
    const outcomes: unknown[] = [];
    const stop = observeSharedTransactions(h.a, () => { outcomes.push(a.edit.commit([{ text: "abZ", marks: {} }])); });
    transactSharedDocument(h.a, "local-command", () => {});
    stop();
    assert.deepEqual(outcomes, [{ kind: "rejected", reason: "buffer-delivery" }]);
    assert.deepEqual([a.executed.length, a.edit.text(), [...collabState(h.a).ingress.holds]], [0, "abZ", ["buffer"]]);
    assert.equal(a.edit.commit([{ text: "abZ", marks: {} }]).kind, "applied");
    assert.equal(h.characters(h.a, "R1").map(char => char.value).join(""), "abZ");
  } finally { a.session.dispose(); h.destroy(); }
});

test("a revision-changing local notification makes retry stale: the bare adapter retains text and hold", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]), a = editing(h);
  try {
    a.edit.replace(2, 2, "Z");
    const outcomes: unknown[] = [];
    const stop = observeSharedTransactions(h.a, () => { outcomes.push(a.edit.commit([{ text: "abZ", marks: {} }])); });
    const scalar = h.command("A", { kind: "scalar", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });
    assert.equal(a.session.run(sharedCommand("length", [scalar])).kind, "applied");
    stop();
    assert.deepEqual(outcomes, [{ kind: "rejected", reason: "buffer-delivery" }]);
    assert.deepEqual(a.edit.commit([{ text: "abZ", marks: {} }]), { kind: "rejected", reason: "stale-base" });
    assert.deepEqual([a.edit.text(), [...collabState(h.a).ingress.holds]], ["abZ", ["buffer"]]);
    assert.equal(h.characters(h.a, "R1").map(char => char.value).join(""), "ab");
    assert.equal(a.session.read(doc => doc?.rows[0]?.lengthSeconds), 7);
    a.edit.cancel();
  } finally { a.session.dispose(); h.destroy(); }
});

for (const text of ["", "ab"]) {
  test(`painted ${text ? "end" : "empty"} gap inserts at its own beat`, () => {
    const h = new Stage1ExecutorHarness([{ id: "R1", text }, { id: "R2", text: "next" }]), a = editing(h);
    try {
      a.edit.replace(text.length, text.length, "Z");
      assert.equal(a.edit.commit([{ text: text + "Z", marks: {} }]).kind, "applied");
      assert.equal(h.characters(h.a, "R1").map(char => char.value).join(""), text + "Z");
      assert.equal(h.characters(h.a, "R2").map(char => char.value).join(""), "next");
    } finally { a.session.dispose(); h.destroy(); }
  });
}

test("native identical-text replacement names the selected occurrence, with inserted marks", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "aaa" }]), a = editing(h);
  try {
    a.edit.replace(1, 2, "a");
    assert.equal(a.edit.commit([{ text: "a", marks: {} }, { text: "a", marks: { b: true } }, { text: "a", marks: {} }]).kind, "applied");
    const sent = a.executed[0]?.operations; assert.ok(sent);
    assert.deepEqual(sent[1]?.kind === "text-delete" && sent[1].observed, [a.painted.identity(1)]);
    assert.deepEqual(h.characters(h.a, "R1").map(char => char.marks.map(mark => mark.kind)), [[], ["b"], []]);
  } finally { a.session.dispose(); h.destroy(); }
});

test("another local write makes the commit stale: refusal retains native intent until cancel", () => {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]), a = editing(h);
  try {
    a.edit.replace(2, 2, "Z");
    transactSharedDocument(h.a, "local-command", () => collabState(h.a).roots.meta.set("probe", true));
    assert.deepEqual(a.edit.commit([{ text: "abZ", marks: {} }]), { kind: "rejected", reason: "stale-base" });
    assert.equal(a.edit.text(), "abZ");
    assert.deepEqual([...collabState(h.a).ingress.holds], ["buffer"]);
    a.edit.cancel();
    assert.deepEqual([...collabState(h.a).ingress.holds], []);
    assert.equal(a.port.open("R1", a.painted), null);
    assert.equal(h.characters(h.a, "R1").map(char => char.value).join(""), "ab");
  } finally { a.session.dispose(); h.destroy(); }
});
