import { test } from "node:test";
import assert from "node:assert/strict";
import { replicas } from "./executor-support.ts";
import { Stage1ExecutorHarness } from "./stage1-executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { operation } from "./executor-support.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { createSharedBufferedText, sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { resolveSharedBufferedSelection } from "../../../src/adapters/collab/buffer-selection.ts";
import { bufferedFieldKey } from "../../../src/core/collab/buffer.ts";
import { bufferedFieldChanges, headingFieldKey, TITLE_FIELD_KEY } from "../../../src/application/editing/buffered-field-key.ts";
import { beatPos, caretAt, headingPos } from "../../../src/core/flow/flow.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { sharedHarness } from "../../application/session/shared-session-support.ts";
import { adapterReplica, registerSplits } from "../../application/session/legacy-shared-session-support.ts";
import { sharedUndoOwner } from "../../collab/editor-ports/shared-undo.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";


test("the legacy title caret resolves its character anchors in the title field", () => {
  const run = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }], { title: "Draft" });
  try {
    const target = sharedBufferedTarget(run.a, TITLE_FIELD_KEY);
    const anchor = createSharedAnchor(run.a, target, 1, "before"), focus = createSharedAnchor(run.a, target, 4, "after");
    assert.ok(anchor && focus);
    assert.deepEqual(resolveSharedBufferedSelection(run.a, [anchor, focus], { key: TITLE_FIELD_KEY, target }),
      { anchor: beatPos(TITLE_FIELD_KEY, 1), head: beatPos(TITLE_FIELD_KEY, 4) });
  } finally { run.destroy(); }
});

test("title redo restores the pre-typing boundary after replaying an insertion", () => {
  const run = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }], { title: "Draft" });
  let serial = 0;
  const author = () => ({ id: "title-" + ++serial, by: "Alice" });
  registerSharedUndoOperationHandlers(run.a);
  const undo = sharedUndoOwner(run.a, author, () => 0, error => { throw error; });
  const { session } = sharedHarness(adapterReplica(run.a, undo));
  try {
    const key = TITLE_FIELD_KEY, target = sharedBufferedTarget(run.a, key);
    const port = createSharedBufferedText(run.a, session, { target: () => target, author, readers: bufferReaders, stamps: bufferStamps("Alice") });
    const painted = readSharedPaintedText(run.a, target);
    assert.ok(painted);
    const edit = port.open(key, painted);
    assert.ok(edit);
    edit.replace(5, 5, "x");
    assert.equal(edit.commit([{ text: "Draftx", marks: {} }]).kind, "applied");
    assert.equal(undo.undo().ok, true);
    assert.equal(readSharedPaintedText(run.a, target)?.text, "Draft");
    const redo = undo.redo();
    assert.ok(redo.ok && redo.selection);
    assert.equal(readSharedPaintedText(run.a, target)?.text, "Draftx");
    assert.deepEqual(resolveSharedBufferedSelection(run.a, [redo.selection.anchor, redo.selection.focus], { key, target }),
      { anchor: beatPos(key, 5), head: beatPos(key, 5) });
  } finally { session.dispose(); run.destroy(); }
});

test("a visual field resolves its own text anchors and keeps its write target", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "ab", visualText: "Wide" }] });
  try {
    const key = bufferedFieldKey("R1", "visualText"), target = sharedBufferedTarget(run.a, key);
    assert.deepEqual(target, { owner: "R1", segment: "R1", field: "visualText" });
    const anchor = createSharedAnchor(run.a, target, 1, "before"), focus = createSharedAnchor(run.a, target, 4, "after");
    assert.ok(anchor && focus);
    assert.deepEqual(resolveSharedBufferedSelection(run.a, [anchor, focus], { key, target }),
      { anchor: beatPos(key, 1), head: beatPos(key, 4) });
  } finally { run.close(); }
});

test("heading typing publishes sections without a beat stamp and restores a heading caret", () => {
  const run = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }], { sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] });
  const a = sharedHarness(adapterReplica(run.a));
  try {
    const key = headingFieldKey("H1"), target = sharedBufferedTarget(run.a, key);
    const port = createSharedBufferedText(run.a, a.session, { target: () => target, author: () => ({ id: "heading", by: "Alice" }),
      readers: bufferReaders, stamps: bufferStamps("Alice") });
    const base = readSharedPaintedText(run.a, target);
    assert.equal(base?.text, "Scene");
    const edit = base && port.open(key, base);
    assert.ok(edit);
    edit.replace(5, 5, "s");
    const outcome = edit.commit([{ text: "Scenes", marks: {} }], [6, 6]);
    assert.equal(outcome.kind, "applied");
    assert.ok("selection" in outcome);
    assert.deepEqual(outcome.selection, { anchor: headingPos("H1", 6), head: headingPos("H1", 6) });
    assert.deepEqual(a.executed.at(-1)?.operations.map(entry => entry.kind), ["text-insert"]);
    assert.deepEqual(outcome.changes.docFields, ["sections"]);
    assert.deepEqual(bufferedFieldChanges(key).docFields, ["sections"]);
  } finally { a.session.dispose(); run.destroy(); }
});

test("undo of identical retyped narration tracks a peer insertion in its original gap", () => {
  const run = new Stage1ExecutorHarness([{ id: "R1", text: "the the" }]);
  let serial = 0;
  const author = () => ({ id: "typing-" + ++serial, by: "Alice" });
  registerSharedUndoOperationHandlers(run.a);
  const undo = sharedUndoOwner(run.a, author, () => 0, error => { throw error; });
  const { session } = sharedHarness(adapterReplica(run.a, undo));
  try {
    collabState(run.b).doc.clientID = 0;
    const target = sharedBufferedTarget(run.a, "R1");
    const port = createSharedBufferedText(run.a, session, { target: () => target, author, readers: bufferReaders, stamps: bufferStamps("Alice") });
    const painted = readSharedPaintedText(run.a, target);
    assert.ok(painted);
    const edit = port.open("R1", painted);
    assert.ok(edit);
    edit.replace(4, 7, "the");
    assert.equal(edit.commit([{ text: "the the", marks: {} }]).kind, "applied");
    run.execute("B", [run.insertion("B", "R1", run.point("B", "R1", 4), "n")], ["peer"]);
    run.queue.flush("D1");
    assert.equal(readSharedPaintedText(run.a, target)?.text, "the nthe");
    const undone = undo.undo();
    assert.ok(undone.ok && undone.effective && undone.selection);
    assert.deepEqual(resolveSharedBufferedSelection(run.a, [undone.selection.anchor, undone.selection.focus]), caretAt(beatPos("R1", 5)));
    run.queue.flush("dup");
    run.join();
    for (const handle of [run.a, run.b, run.c]) assert.equal(run.characters(handle, "R1").map(unit => unit.value).join(""), "the nthe");
  } finally { session.dispose(); run.destroy(); }
});

for (const [label, kind, typedAt, splitAt, rows, expectedRow, offset] of [
  ["before caret", "split", 4, 2, ["ab", "cdQ", "next"], "structure_2_0073_beat_0", 3],
  ["after caret", "split", 1, 3, ["aQbc", "d", "next"], "R1", 2],
  ["at caret", "split", 2, 2, ["abQ", "cd", "next"], "R1", 3],
  ["before beat", "split-before", 1, 2, ["aQb", "cd", "next"], "structure_2_0073_beat_0", 2]
] as const) test("the drained split " + label + " maps the persisted typing caret", () => {
  const run = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }, { id: "R2", text: "next" }]);
  const { session } = sharedHarness(adapterReplica(run.a));
  try {
    registerSplits(run.b);
    const target = sharedBufferedTarget(run.a, "R1"), author = () => ({ id: "typing", by: "Alice" });
    const port = createSharedBufferedText(run.a, session, { target: () => target, author, readers: bufferReaders, stamps: bufferStamps("Alice") });
    const painted = readSharedPaintedText(run.a, target);
    assert.ok(painted);
    const edit = port.open("R1", painted);
    assert.ok(edit);
    edit.replace(typedAt, typedAt, "Q");
    const at = run.point("B", "R1", splitAt);
    assert.deepEqual(executeSharedOperations(run.b, [operation({ kind, id: "s", by: "Bob", target: run.target("R1"),
      at: { left: at, right: at, affinity: "before" }, beat: "tail", boundary: "tail", observed: [], fields: {} })]), { ok: true });
    run.queue.flush("D1");
    const outcome = edit.commit([{ text: "abcd".slice(0, typedAt) + "Q" + "abcd".slice(typedAt), marks: {} }], [typedAt + 1, typedAt + 1]);
    assert.equal(outcome.kind, "applied");
    assert.ok("selection" in outcome);
    assert.deepEqual(outcome.selection, caretAt(beatPos(expectedRow, offset)));
    assert.deepEqual(projectSharedDocumentWithRecovery(run.a).document.rows.map(row => row.audioText), rows);
  } finally { session.dispose(); run.destroy(); }
});
