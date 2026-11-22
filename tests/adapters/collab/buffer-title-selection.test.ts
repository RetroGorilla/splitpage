import { test } from "node:test";
import assert from "node:assert/strict";
import { replicas } from "./executor-support.ts";
import { Stage1ExecutorHarness } from "./stage1-executor-support.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { createSharedBufferedText, sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { resolveSharedBufferedSelection } from "../../../src/adapters/collab/buffer-selection.ts";
import { bufferedFieldKey } from "../../../src/core/collab/buffer.ts";
import { TITLE_FIELD_KEY } from "../../../src/application/editing/buffered-field-key.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { sharedHarness } from "../../application/session/shared-session-support.ts";
import { adapterReplica } from "../../application/session/legacy-shared-session-support.ts";
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
