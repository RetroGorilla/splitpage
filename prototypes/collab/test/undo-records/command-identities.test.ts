import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import * as commands from "../../src/undo-records/commands.ts";
import { ReplicaHarness } from "../../src/delivery.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import { createProjectionReplica, fromDocument, toDocument } from "../../src/proj/document.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { structuralCaret } from "../../src/structure-selection.ts";
import { projectionDifference } from "../strict-comparison.ts";

function stored(value: unknown): unknown {
  if (value instanceof Y.Map) return [...value.keys()].sort().map(key => [key, stored(value.get(key))]);
  if (value instanceof Y.Array) return value.toArray().map(stored);
  if (value instanceof Y.Text) return value.toDelta();
  return value;
}

const actions: Record<string, (history: CommandHistory) => unknown> = {
  insertText: h => commands.insertText(h, "R\ud800", 1, "X", ["x\ud800"], { "c:C\ud800": true }),
  deleteRange: h => commands.deleteRange(h, "R\ud800", 1, 2),
  formatRange: h => commands.formatRange(h, "R\ud800", 0, 1, { "l:L\ud800": "link\ud800" }),
  formatSelection: h => commands.formatSelection(h, {
    position: structuralCaret(h.replica, "R\ufffd", 0), selectionEnd: structuralCaret(h.replica, "R\ufffd", 1)
  }, { "t:T\ud800": "tag\ud800" }),
  tagRange: h => commands.tagRange(h, "R\ud800", 0, 1, "tag\ud800"),
  addComment: h => commands.addComment(h, "C\ud800", "R\ud800", 0, 1, "Alice"),
  addReply: h => commands.addReply(h, "reply\ud800", "C\ud800", "Alice"),
  split: h => commands.split(h, "R\ud800", 1, "new\ud800", "boundary\ud800", "Alice"),
  join: h => commands.join(h, "S\ud800", "R\ud800", "join\ud800"),
  removeBeat: h => commands.removeBeat(h, "R\ud800", "remove\ud800", "Alice"),
  moveBeat: h => commands.moveBeat(h, "R\ud800", "T\ud800"),
  createHeadingRecord: h => commands.createHeadingRecord(h, "R\ud800", "newHeading\ud800", 1, false, ["heading\ud800"]),
  removeHeadingRecord: h => commands.removeHeadingRecord(h, "H\ud800", "newBeat\ud800", "R\ud800"),
  replaceRange: h => commands.replaceRange(h, commands.captureRange(h, "R\ud800", 1, "T\ud800", 1), "X", ["range\ud800"], "Alice"),
  changeStatus: h => commands.changeStatus(h, "R\ud800", "status\ud800", "ready", "Alice"),
  setScalar: h => commands.setScalar(h, "R\ud800", "field\ud800", "value\ud800")
};

test("every command kind normalizes surrogate identities before writing, undoing and redoing; encoded loads agree strictly", () => {
  assert.deepEqual(Object.keys(commands).filter(key => key !== "captureRange" && key !== "tagKey").sort(), Object.keys(actions).sort());
  const failures: string[] = [];
  for (const [kind, action] of Object.entries(actions)) {
    const movement = kind === "moveBeat" ? new ReplicaHarness("B", [
      { id: "R\ufffd", text: "ab" }, { id: "S\ufffd", text: "cd" }, { id: "T\ufffd", text: "ef" }
    ]) : null;
    const writer = movement?.alice ?? fromDocument({ title: "", rows: [
      { id: "R\ud800", audioText: "# A", visualText: "", status: "todo" },
      { id: "S\ud800", audioText: "bc", visualText: "", status: "todo" },
      { id: "T\ud800", audioText: "de", visualText: "", status: "todo" }
    ], sections: [{ id: "H\ud800", name: "Scene", firstSceneId: "R\ud800" }] }, "B", 200);
    writer.doc.getMap("meta");
    writer.doc.getMap("headings");
    const history = new CommandHistory(writer);
    const compare = (phase: string): void => {
      const loaded = createProjectionReplica("B", 201);
      try {
        Y.applyUpdate(loaded.doc, Y.encodeStateAsUpdate(writer.doc));
        for (const [key, value] of writer.doc.share) {
          if (value instanceof Y.Map) loaded.doc.getMap(key);
          else if (value instanceof Y.Array) loaded.doc.getArray(key);
          else if (value instanceof Y.Text) loaded.doc.getText(key);
        }
        const snapshot = (doc: Y.Doc): unknown => [...doc.share.keys()].sort().map(key => [key, stored(doc.share.get(key))]);
        for (const [label, actual, expected] of [
          ["stored keys and values", snapshot(writer.doc), snapshot(loaded.doc)],
          ["document", toDocument(writer.doc, "B"), toDocument(loaded.doc, "B")],
          ["structure", readStructure(writer.doc, "B", writer.identities), readStructure(loaded.doc, "B", writer.identities)]
        ] as const) {
          assert.equal(projectionDifference(actual, expected, `${kind}/${phase}/${label}`), null);
        }
      } finally { loaded.destroy(); }
    };
    try {
      action(history); compare("command");
      assert.equal(history.undoStack.length, 1, kind);
      assert.equal(history.undo().effective, true, kind); compare("undo");
      assert.equal(history.redo().effective, true, kind); compare("redo");
      assert.equal(history.undo().effective, true, kind); compare("second undo");
    } catch (error) {
      failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (movement) movement.destroy(); else writer.destroy(); }
  }
  assert.deepEqual(failures, []);
});
