import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { removeNativeComment, reopenNativeComment, resolveNativeComment } from "../../../../src/adapters/collab/native/comment-commands.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading, restoreNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import { clearNativeField, setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, deleteNativeText, replaceNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import {
  AUTHOR, COMMENT, REPLY, RESOLUTION, beatField, commentInput, createNativeComment, createNativeReply, recordCopies, replyInput, setNativeCommentBody
} from "./record-harness.ts";
import { caret, stateOf } from "./structure-harness.ts";

function startingState(): Uint8Array {
  const { scripts: [script] } = recordCopies([2]);
  assert.ok(script);
  try {
    assert.equal(setNativeField(script, beatField("A", "lengthSeconds"), 12).kind, "written");
    assert.equal(createNativeHeading(script, caret(script, "D", 0), "J", "Deleted").kind, "written");
    assert.equal(removeNativeHeading(script, "J").kind, "written");
    assert.equal(joinNativeRow(script, "F", "E", " ").kind, "written");
    assert.equal(resolveNativeComment(script, REPLY, RESOLUTION).kind, "written");
    return Y.encodeStateAsUpdate(script.doc);
  } finally { script.doc.destroy(); }
}

const base = startingState();
type Result = { kind: string; reason?: string };

function commands(doc: Y.Doc) {
  const script = openNativeScript(doc), history = openNativeUndo(script);
  Y.applyUpdate(doc, base, "remote");
  assert.equal(typeNativeText(script, caret(script, "A", 0), "x", {}).kind, "written");
  history.stopCapturing();
  assert.equal(typeNativeText(script, caret(script, "A", 0), "y", {}).kind, "written");
  assert.equal(history.undo().kind, "written");
  const audio = anchorNativeText(script, { beat: "A", cell: "narration" }, 0, 1);
  const name = anchorNativeText(script, { beat: "H", cell: "name" }, 0, 1);
  assert.equal(audio.kind, "anchored");
  assert.equal(name.kind, "anchored");
  const audioCaret = caret(script, "B", 0), headingCaret = caret(script, "C", 0);
  const all: Readonly<Record<string, () => Result>> = {
    type: () => typeNativeText(script, audioCaret, "z", {}),
    replace: () => replaceNativeText(script, audio.range, [{ text: "z", marks: {} }]),
    deleteText: () => deleteNativeText(script, audio.range),
    format: () => formatNativeText(script, audio.range, { kind: "plain", mark: "b", on: true }),
    createHeading: () => createNativeHeading(script, headingCaret, "K", "New"),
    renameHeading: () => renameNativeHeading(script, name.range, "N"),
    removeHeading: () => removeNativeHeading(script, "H"),
    restoreHeading: () => restoreNativeHeading(script, "J"),
    move: () => moveNativeBlocks(script, [{ kind: "beat", id: "E" }], { kind: "beat", id: "A" }),
    setField: () => setNativeField(script, beatField("A", "status"), "ready"),
    clearField: () => clearNativeField(script, beatField("A", "lengthSeconds")),
    createComment: () => createNativeComment(script, commentInput("new-comment")),
    createReply: () => createNativeReply(script, COMMENT.comment, replyInput("new-reply")),
    setCommentBody: () => setNativeCommentBody(script, COMMENT, AUTHOR, "new body"),
    resolveComment: () => resolveNativeComment(script, COMMENT, RESOLUTION),
    reopenComment: () => reopenNativeComment(script, REPLY),
    removeComment: () => removeNativeComment(script, COMMENT),
    split: () => splitNativeRow(script, audioCaret),
    join: () => joinNativeRow(script, "B", "A", " "),
    unjoin: () => unjoinNativeRow(script, "F"),
    removeRows: () => removeNativeRows(script, ["B"]),
    undo: history.undo,
    redo: history.redo
  };
  return { script, history, all };
}

function checkBusy(result: Result, name: string): void {
  const text = ["type", "replace", "deleteText"].includes(name);
  assert.equal(result.kind, text ? "recovery" : "refused", name);
  assert.equal(result.reason, "busy", name);
}

for (const phase of ["beforeAllTransactions", "afterAllTransactions"] as const) {
  test(`every editing command refuses as callee and holds admission as caller in ${phase}`, () => {
    const run = (which: "caller" | "callee", name: string): void => {
      const doc = new Y.Doc();
      let atEvent: (() => void) | undefined, calls = 0;
      const listener = () => {
        if (!atEvent) return;
        const run = atEvent;
        atEvent = undefined;
        calls++;
        run();
      };
      if (phase === "beforeAllTransactions") doc.on(phase, listener);
      const { script, history, all } = commands(doc);
      if (phase === "afterAllTransactions") doc.on(phase, listener);
      const invoke = (command: string) => {
        const act = all[command];
        assert.ok(act, command);
        return act();
      };
      const caller = which === "caller" ? name : "type", callee = which === "callee" ? name : "undo";
      const outerBefore = stateOf(script);
      atEvent = () => {
        const before = stateOf(script);
        checkBusy(invoke(callee), callee);
        assert.deepEqual(stateOf(script), before);
      };
      try {
        assert.equal(invoke(caller).kind, "written", caller);
        assert.equal(calls, 1, caller);
        assert.notDeepEqual(stateOf(script), outerBefore, caller);
      } finally { history.destroy(); doc.destroy(); }
    };
    const doc = new Y.Doc(), listing = commands(doc), names = Object.keys(listing.all);
    listing.history.destroy();
    doc.destroy();
    for (const name of names) {
      run("caller", name);
      run("callee", name);
    }
  });
}
