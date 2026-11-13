import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { sharedBufferedTarget, createSharedBufferedText } from "../../../src/adapters/collab/buffer.ts";
import { bufferReaders } from "../../collab/buffer-readers.ts";
import { resolveSharedBufferedSelection } from "../../../src/adapters/collab/buffer-selection.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedAnchorCharacterEnd } from "../../../src/adapters/collab/anchors.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { nativeText } from "./incremental-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";

const fresh = "structure_1_00730070006c00690074_beat_0";
for (const split of [false, true]) test("Writer buffered target paints and edits the entire joined row, split=" + split, () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  registerSharedJoinHandlers(set.a); registerSharedSplitHandlers(set.a, createFlowLoadRuntime()); registerSharedTextOperationHandlers(set.a);
  const session = sharedHarness(adapterReplica(set.a));
  try {
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " })]), { ok: true });
    if (split) assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "split", id: "split", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, observed: [], beat: "fresh", boundary: "fresh", fields: {} })], { base: readSharedRevision(set.a) }), { ok: true });
    const owner = split ? fresh : "R1", target = sharedBufferedTarget(set.a, owner), painted = readSharedPaintedText(set.a, target); assert.ok(painted);
    assert.deepEqual(target, { owner, segment: owner, field: "audioText" }); assert.equal(painted.text, split ? "b cd" : "ab cd");
    assert.equal(painted.text, projectSharedDocumentWithRecovery(set.a).document.rows.find(row => row.id === owner)?.audioText);
    const points = split ? [[2, { kind: "beat", rowId: fresh, offset: 2 }], [3, { kind: "beat", rowId: fresh, offset: 3 }], [4, { kind: "beat", rowId: fresh, offset: 4 }]] as const
      : [[3, { kind: "beat", rowId: "R1", offset: 3 }], [4, { kind: "beat", rowId: "R1", offset: 4 }], [5, { kind: "beat", rowId: "R1", offset: 5 }]] as const;
    for (const [offset, expected] of points) {
      const unit = painted.identity(offset - 1); assert.ok(unit); const end = sharedAnchorCharacterEnd(unit); assert.ok(end);
      assert.deepEqual(resolveSharedBufferedSelection(set.a, [end, end]), { anchor: expected, head: expected });
    }
    const port = createSharedBufferedText(set.a, session.session, { target: id => sharedBufferedTarget(set.a, id), author: () => ({ id: "buffer", by: "Alice" }), readers: bufferReaders });
    const edit = port.open(owner, painted); assert.ok(edit); const at = split ? 3 : 4;
    edit.replace(at, at, "X"); const result = edit.commit([{ text: split ? "b cXd" : "ab cXd", marks: {} }], [at + 1, at + 1]);
    assert.equal(result.kind, "applied"); assert.ok("selection" in result);
    const restored = split ? { kind: "beat", rowId: fresh, offset: 4 } : { kind: "beat", rowId: "R1", offset: 5 };
    assert.deepEqual(result.selection, { anchor: restored, head: restored });
    assert.equal(nativeText(set.a, "b:R2").toString(), "cXd"); set.queue.flush("dup");
    agree("buffered joined typing", "dup", [set.a, set.b], handle => {
      const rows = projectSharedDocumentWithRecovery(handle).document.rows;
      for (const row of rows) assert.equal(readSharedPaintedText(handle, sharedBufferedTarget(handle, row.id))?.text, row.audioText);
      return rows.map(row => [row.id, row.audioText]);
    }, split ? [["R1", "a"], [fresh, "b cXd"]] : [["R1", "ab cXd"]]);
  } finally { session.session.dispose(); set.close(); }
});

test("retiring the middle join leaves the dependent tail with its native end and fields with its issued destination", () => {
  const set = replicas(3, { rows: [{ id: "R1", audioText: "ab", visualText: "left" }, { id: "R3", audioText: "gh", visualText: "middle" }, { id: "R2", audioText: "cd", visualText: "right", status: "ready" }] });
  try {
    registerSharedJoinHandlers(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "first", by: "Alice", from: "R3", into: "R1", glue: " " }),
      operation({ kind: "join", id: "second", by: "Alice", from: "R2", into: "R1", glue: " " })]), { ok: true }); set.queue.flush("dup");
    assert.deepEqual(projectSharedDocumentWithRecovery(set.a).document.rows.map(row => row.audioText), ["ab gh cd"]);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join-retire", id: "retire", by: "Alice", joins: ["structure_1_00660069007200730074_join_0"] })]), { ok: true }); set.queue.flush("dup");
    agree("retired middle join", "dup", [set.a, set.b, set.c], handle => projectSharedDocumentWithRecovery(handle).document.rows.map(row => [row.id, row.audioText, row.visualText, row.status]),
      [["R1", "ab", "left<br>right", "ready"], ["R3", "gh cd", "middle", "todo"]]);
  } finally { set.close(); }
});
