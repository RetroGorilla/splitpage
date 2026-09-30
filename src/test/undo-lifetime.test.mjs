import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import {
  absorbRemoteChange, flushEdits, lastUndoEntry, noteEdit, noteRemoteChange, redo, resetUndo, trackDocument,
  undo, undoLifetime, undoMark, undoSizes
} from "../js/12a-undo.js";

function doc(title) {
  return migrateRows({ schema: 2, title: title || "Lifetime", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" },
    { id: "r2", visualText: "two", audioText: "Bravo", status: "todo" }
  ] });
}

function open(state) {
  S.state = state;
  trackDocument();
}

function edit(fn) {
  fn(S.state);
  noteEdit();
  flushEdits();
}

function moved(from, why) {
  const now = undoLifetime();
  assert.notEqual(now, from, why);
  return now;
}

test("the history's lifetime moves on with every reset: a new document, the same one reopened, resetUndo, no document, noteRemoteChange(null)", () => {
  open(doc("First"));
  let life = undoLifetime();

  open(doc("Second"));
  life = moved(life, "another document: trackDocument's restart()");

  edit((s) => { s.rows[0].audioText = "Alpha edited"; });
  assert.equal(undoSizes().undo, 1);
  const again = JSON.parse(JSON.stringify(S.state));
  assert.equal(again.docId, S.state.docId);
  open(again);
  life = moved(life, "the same document id opened again");
  assert.deepEqual(undoSizes(), { undo: 0, redo: 0 });
  assert.equal(lastUndoEntry(), null);

  S.state = doc("Third");
  flushEdits();
  life = moved(life, "a document swapped in without a render: flushEdits' restart()");

  resetUndo();
  life = moved(life, "resetUndo()");

  S.state = null;
  flushEdits();
  life = moved(life, "no document: the !S.state clear in flushEdits");
  open(doc("Fourth"));
  life = moved(life, "a document after none");

  noteRemoteChange(null);
  life = moved(life, "noteRemoteChange(null)");

  S.state = doc("Fifth");
  absorbRemoteChange();
  moved(life, "absorbRemoteChange() over a document it was not tracking");
});

test("the history's lifetime holds through ordinary edits, undo, redo, a mark, a render of the same document and a merge", () => {
  open(doc());
  const life = undoLifetime();

  edit((s) => { s.rows[0].audioText = "Alpha one"; });
  edit((s) => { s.rows[1].status = "shot"; });
  assert.equal(undoSizes().undo, 2);
  assert.equal(undoLifetime(), life, "record");

  undoMark();
  trackDocument();
  assert.equal(undoLifetime(), life, "undoMark and trackDocument on the same document");

  assert.equal(undo().ok, true);
  assert.equal(S.state.rows[1].status, "todo");
  assert.equal(undoLifetime(), life, "undo");

  assert.equal(redo().ok, true);
  assert.equal(S.state.rows[1].status, "shot");
  assert.equal(undoLifetime(), life, "redo");

  assert.equal(undo().ok, true);
  assert.equal(undo().ok, true);
  assert.equal(undo().empty, true);
  assert.equal(redo().ok, true);
  assert.equal(undoLifetime(), life, "undo to the bottom and back");

  const merged = JSON.parse(JSON.stringify(S.state));
  merged.rows[1].audioText = "Bravo from elsewhere";
  noteRemoteChange(merged);
  S.state = merged;
  trackDocument();
  assert.equal(undoLifetime(), life, "a merge keeps the history it forgets from");
  assert.equal(undoSizes().undo, 1);

  S.state.rows[0].visualText = "one reloaded";
  absorbRemoteChange();
  assert.equal(undoLifetime(), life, "a reload into the same document keeps it");
});
