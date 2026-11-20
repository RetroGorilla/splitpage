import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeUndoOutcome } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { cells } from "./helpers.ts";
import { AT, beatField } from "./record-harness.ts";
import { structureScript } from "./structure-harness.ts";

type Session = ReturnType<typeof openNativeSession>;
const options = { actor: "Writer", sanitize: (html: unknown) => String(html ?? "") };
const doc = structureScript({ A: "abc", B: "defg", C: "hij" }, { A: "12", B: "345" }, [{ id: "H", name: "Intro", before: "A" }]);
const target = (beat: string, cell: NativeTextTarget["cell"] = "narration"): NativeTextTarget => ({ beat, cell });
const aText = target("A"), bText = target("B"), bVisual = target("B", "visual"), heading = target("H", "name");
const status = beatField("A", "status");

function copies(t: TestContext, otherClient = 3): [Session, Session] {
  const seed = openNativeSession({ kind: "document", document: doc, conversion: { cells, creation: "seed", at: AT, by: "Writer" } }, options);
  const state = { kind: "state", state: seed.encodeState() } as const;
  seed.close();
  const a = openNativeSession(state, options), b = openNativeSession(state, options);
  a.ydoc.clientID = 2;
  b.ydoc.clientID = otherClient;
  t.after(() => { a.close(); b.close(); });
  return [a, b];
}

function anchor(s: Session, field: NativeTextTarget, from: number, to = from) {
  const result = s.commands.anchorText(field, from, to);
  assert.equal(result.kind, "anchored");
  return result.range;
}

function written<T extends { kind: string }>(result: T): Extract<T, { kind: "written" }> {
  assert.equal(result.kind, "written", JSON.stringify(result));
  return result as Extract<T, { kind: "written" }>;
}

function selection(outcome: NativeUndoOutcome, field?: NativeTextTarget, from?: number, to = from): void {
  const step = written(outcome);
  assert.equal(typeof step.entry, "number");
  assert.deepEqual(step.selection, field ? { target: field, from, to } : undefined);
}

function noChange(session: Session, press: () => NativeUndoOutcome, expected: NativeUndoOutcome = { kind: "unchanged" }): void {
  const state = session.encodeState();
  assert.deepEqual(press(), expected);
  assert.deepEqual(session.encodeState(), state);
}

function send(from: Session, to: Session): void {
  Y.applyUpdate(to.ydoc, from.encodeState(), "peer");
}

function type(s: Session, field: NativeTextTarget, at: number, text: string): void {
  written(s.commands.typeText(anchor(s, field, at), text, {}));
}

function recordType(s: Session, field: NativeTextTarget, from: number, to: number, text: string): void {
  const before = anchor(s, field, from, to);
  const step = s.commands.typeText.withSelection(before, before, text, {});
  written(step.result);
  step.recordAfter(anchor(s, field, from + text.length));
}

function statusWithSelection(s: Session, field: NativeTextTarget, from: number, to = from): void {
  const step = s.commands.setField.withSelection(anchor(s, field, from, to), status, "ready");
  written(step.result);
  step.recordAfter(anchor(s, field, from, to));
}

test("a typing group replays the first before range and last after caret across repeated undo and redo", t => {
  const [s] = copies(t);
  recordType(s, aText, 0, 2, "x");
  recordType(s, aText, 1, 1, "y");
  assert.equal(s.document().rows[0]?.audioText, "xyc");
  for (let cycle = 0; cycle < 2; cycle++) {
    selection(s.commands.undo(), aText, 0, 2);
    assert.equal(s.document().rows[0]?.audioText, "abc");
    noChange(s, s.commands.undo);
    selection(s.commands.redo(), aText, 2);
    assert.equal(s.document().rows[0]?.audioText, "xyc");
  }
});

test("a group can start or end with an unannotated write", t => {
  const [s] = copies(t);
  type(s, aText, 0, "x");
  recordType(s, aText, 1, 1, "y");
  selection(s.commands.undo());
  selection(s.commands.redo(), aText, 2);
  s.endTypingGroup();
  recordType(s, aText, 2, 2, "z");
  type(s, aText, 3, "w");
  selection(s.commands.undo(), aText, 2);
  selection(s.commands.redo());
  selection(s.commands.undo(), aText, 2);
  written(s.commands.setField(status, "ready"));
  selection(s.commands.undo());
});

test("a focus boundary ends capture immediately, clears typing, and leaves empty boundaries and word grouping alone", t => {
  const [s] = copies(t);
  const stop = t.mock.method(Y.UndoManager.prototype, "stopCapturing");
  const state = s.encodeState();
  s.endTypingGroup();
  assert.deepEqual(s.encodeState(), state);
  noChange(s, s.commands.undo);
  recordType(s, aText, 0, 0, "x");
  assert.equal(s.document().rows[0]?.audioText, "xabc");
  const beforeBoundary = stop.mock.callCount();
  s.endTypingGroup();
  assert.equal(stop.mock.callCount(), beforeBoundary + 1);
  s.endTypingGroup();
  assert.equal(stop.mock.callCount(), beforeBoundary + 2);
  recordType(s, aText, 1, 1, "y");
  assert.equal(stop.mock.callCount(), beforeBoundary + 3);
  recordType(s, aText, 2, 2, " ");
  recordType(s, aText, 3, 3, "z");
  selection(s.commands.undo(), aText, 3);
  assert.equal(s.document().rows[0]?.audioText, "xy abc");
  selection(s.commands.undo(), aText, 1);
  assert.equal(s.document().rows[0]?.audioText, "xabc");
  selection(s.commands.undo(), aText, 0);
  assert.equal(s.document().rows[0]?.audioText, "abc");
  noChange(s, s.commands.undo);
});

test("the after recorder is one-shot and cannot annotate a later write or a press", t => {
  const [s] = copies(t);
  const before = anchor(s, aText, 0);
  const old = s.commands.typeText.withSelection(before, before, "x", {});
  written(old.result);
  const next = anchor(s, aText, 1);
  const current = s.commands.typeText.withSelection(next, next, "y", {});
  written(current.result);
  old.recordAfter(anchor(s, aText, 4));
  current.recordAfter(anchor(s, aText, 2));
  current.recordAfter(anchor(s, aText, 4));
  selection(s.commands.undo(), aText, 0);
  selection(s.commands.redo(), aText, 2);

  const beforeLast = anchor(s, aText, 2);
  const last = s.commands.typeText.withSelection(beforeLast, beforeLast, "z", {});
  written(last.result);
  selection(s.commands.undo(), aText, 2);
  last.recordAfter(anchor(s, aText, 4));
  selection(s.commands.redo());
});

test("a write omitted from capture invalidates a delayed after recorder even when it creates a new step", t => {
  const [s] = copies(t);
  const at = anchor(s, aText, 0);
  const step = s.commands.typeText.withSelection(at, at, "x", {});
  written(step.result);
  written(s.commands.setField(status, "ready"));
  let read = false;
  const unexpected = { ...at, get from() { read = true; return at.from; } };
  step.recordAfter(unexpected);
  assert.equal(read, false);
  selection(s.commands.undo());
  selection(s.commands.undo(), aText, 0);
  selection(s.commands.redo());
});

test("an unchanged or refused write cannot replace a previous step's selections", t => {
  const [s] = copies(t);
  statusWithSelection(s, aText, 1);
  const before = s.encodeState(), at = anchor(s, aText, 0);
  const same = s.commands.setField.withSelection(at, status, "ready");
  assert.deepEqual(same.result, { kind: "unchanged" });
  same.recordAfter(at);
  const refused = s.commands.setField.withSelection(at, status, "invalid");
  assert.deepEqual(refused.result, { kind: "refused", reason: "value" });
  refused.recordAfter(at);
  assert.deepEqual(s.encodeState(), before);
  selection(s.commands.undo(), aText, 1);
  selection(s.commands.redo(), aText, 1);
});

test("a busy boundary and refused presses leave the pending selection and encoded state alone", t => {
  const [s] = copies(t);
  const at = anchor(s, aText, 0);
  const step = s.commands.typeText.withSelection(at, at, "x", {});
  written(step.result);
  const after = anchor(s, aText, 1);
  const stop = t.mock.method(Y.UndoManager.prototype, "stopCapturing");
  s.ydoc.transact(() => {
    s.endTypingGroup();
    assert.equal(stop.mock.callCount(), 0);
    noChange(s, s.commands.undo, { kind: "refused", reason: "busy" });
    noChange(s, s.commands.redo, { kind: "refused", reason: "busy" });
    const busy = s.commands.setField.withSelection(at, status, "ready");
    assert.deepEqual(busy.result, { kind: "refused", reason: "busy" });
    busy.recordAfter(at);
    step.recordAfter(at);
  });
  step.recordAfter(after);
  selection(s.commands.undo(), aText, 0);
  selection(s.commands.redo(), aText, 1);
  s.close();
  noChange(s, s.commands.undo, { kind: "refused", reason: "closed" });
  noChange(s, s.commands.redo, { kind: "refused", reason: "closed" });
});

test("selections never enter the encoded document through a write, undo, or redo", t => {
  const [a, b] = copies(t, 2);
  recordType(a, aText, 0, 2, "x");
  written(b.commands.typeText(anchor(b, aText, 0, 2), "x", {}));
  assert.deepEqual(a.encodeState(), b.encodeState());
  selection(a.commands.undo(), aText, 0, 2);
  selection(b.commands.undo());
  assert.deepEqual(a.encodeState(), b.encodeState());
  selection(a.commands.redo(), aText, 1);
  selection(b.commands.redo());
  assert.deepEqual(a.encodeState(), b.encodeState());
});

test("selection snapshots reject a forged root name and ignore caller mutation after capture", t => {
  const [s, control] = copies(t, 2);
  const at = anchor(s, aText, 1);
  const before = { ...at };
  const forged = Y.createRelativePositionFromJSON({ ...at.from, tname: "foreign-root" });
  const step = s.commands.setField.withSelection(before, status, "ready");
  written(step.result);
  before.from = before.to = anchor(s, aText, 0).from;
  step.recordAfter({ target: aText, from: forged, to: forged });
  written(control.commands.setField(status, "ready"));
  selection(s.commands.undo(), aText, 1);
  selection(control.commands.undo());
  selection(s.commands.redo());
  selection(control.commands.redo());
  assert.deepEqual([...s.ydoc.share.keys()], [...control.ydoc.share.keys()]);
  assert.deepEqual(s.encodeState(), control.encodeState());
});

test("peers keep separate undo and selections while a local caret shifts with a peer's prefix", t => {
  const [a, b] = copies(t);
  recordType(a, aText, 1, 1, "x");
  recordType(b, aText, 0, 0, "pq");
  send(a, b);
  send(b, a);
  selection(a.commands.undo(), aText, 3);
  assert.equal(a.document().rows[0]?.audioText, "pqabc");
  noChange(a, a.commands.undo);
  selection(a.commands.redo(), aText, 4);
  assert.equal(a.document().rows[0]?.audioText, "pqaxbc");
  send(a, b);
  selection(b.commands.undo(), aText, 0);
  assert.equal(b.document().rows[0]?.audioText, "axbc");
  noChange(b, b.commands.undo);
  send(b, a);
  assert.deepEqual(a.document(), b.document());
});

test("deleting the caret's neighbour leaves the caret at the gap in the same cell", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 1);
  written(b.commands.deleteText(anchor(b, bText, 0, 3)));
  send(b, a);
  selection(a.commands.undo(), bText, 0);
  selection(a.commands.redo(), bText, 0);
  assert.equal(a.document().rows[1]?.audioText, "g");
});

test("deleting a range's two endpoints keeps surviving interior text and collapses when none survives", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 0, 4);
  written(b.commands.deleteText(anchor(b, bText, 3, 4)));
  written(b.commands.deleteText(anchor(b, bText, 0, 1)));
  send(b, a);
  selection(a.commands.undo(), bText, 0, 2);
  selection(a.commands.redo(), bText, 0, 2);
  written(b.commands.replaceText(anchor(b, bText, 0, 2), [{ text: "pq", marks: {} }]));
  send(b, a);
  selection(a.commands.undo(), bText, 0);
  assert.equal(a.document().rows[1]?.audioText, "pq");
});

for (const [field, before, after, text] of [
  [bText, 1, 6, "abc--defg"],
  [bVisual, 1, 4, "12<br>345"]
] as const) {
  test(`joining a beat projects its ${field.cell} range into the displayed row after the join separator`, t => {
    const [a, b] = copies(t);
    statusWithSelection(a, field, before, before + 1);
    written(b.commands.joinRow("B", "A", "--"));
    send(b, a);
    assert.equal(a.document().rows[0]?.[field.cell === "visual" ? "visualText" : "audioText"], text);
    selection(a.commands.undo(), target("A", field.cell), after, after + 1);
    selection(a.commands.redo(), target("A", field.cell), after, after + 1);
  });
}

test("a split can record a different surface after the write using the minted beat ID", t => {
  const [s] = copies(t);
  const at = anchor(s, bText, 2);
  const split = s.commands.splitRow.withSelection(at, at);
  const created = written(split.result).created;
  split.recordAfter(anchor(s, target(created), 0));
  selection(s.commands.undo(), bText, 2);
  assert.equal(s.document().rows[1]?.audioText, "defg");
  selection(s.commands.redo(), target(created), 0);
  assert.equal(s.document().rows.find(row => row.id === created)?.audioText, "fg");
});

test("a peer split carries a caret with its surviving text but a range across distinct rows has no surface", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 3);
  const spanning = a.commands.setField.withSelection(anchor(a, bText, 1, 4), status, "shot");
  written(spanning.result);
  spanning.recordAfter(anchor(a, bText, 1, 4));
  const created = written(b.commands.splitRow(anchor(b, bText, 2))).created;
  send(b, a);
  selection(a.commands.undo());
  selection(a.commands.undo(), target(created), 1);
  assert.equal(a.document().rows.find(row => row.id === created)?.audioText, "fg");
  selection(a.commands.redo(), target(created), 1);
  selection(a.commands.redo());
});

test("a split at the end cannot move a caret into an empty beat using the next boundary alone", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 4);
  const created = written(b.commands.splitRow(anchor(b, bText, 4))).created;
  send(b, a);
  assert.deepEqual(a.document().rows.map(row => [row.id, row.audioText]), [["A", "abc"], ["B", "defg"], [created, ""], ["C", "hij"]]);
  selection(a.commands.undo());
  selection(a.commands.redo());
});

test("a deleted anchor cannot move a caret into a different row at the gap", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 2);
  const created = written(b.commands.splitRow(anchor(b, bText, 1))).created;
  written(b.commands.deleteText(anchor(b, target(created), 1, 2)));
  send(b, a);
  assert.equal(a.document().rows.find(row => row.id === created)?.audioText, "eg");
  selection(a.commands.undo());
  selection(a.commands.redo());
});

test("a joined member with an empty visual cell has no visible cell span to restore", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, target("C", "visual"), 0);
  written(b.commands.joinRow("C", "B", " "));
  send(b, a);
  assert.equal(a.document().rows[1]?.visualText, "345");
  selection(a.commands.undo());
  selection(a.commands.redo());
});

test("moving a beat follows its ID and keeps its offset", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 2);
  written(b.commands.moveBlocks([{ kind: "beat", id: "B" }], { kind: "beat", id: "A" }));
  send(b, a);
  assert.deepEqual(a.document().rows.map(row => row.id), ["B", "A", "C"]);
  selection(a.commands.undo(), bText, 2);
  selection(a.commands.redo(), bText, 2);
});

for (const cell of ["narration", "visual"] as const) {
  test(`rule (g) resolves a restored ${cell} selection when only the split boundary returns`, t => {
    const [a, b] = copies(t);
    const created = written(a.commands.splitRow(anchor(a, bText, 1))).created;
    send(a, b);
    const removal = b.commands.removeRows.withSelection(anchor(b, target(created, cell), cell === "visual" ? 0 : 1), [created]);
    written(removal.result);
    send(b, a);
    selection(a.commands.undo());
    send(a, b);
    if (cell === "narration") selection(b.commands.undo(), bText, 2);
    else selection(b.commands.undo());
    assert.deepEqual(b.document().rows.map(row => row.audioText), ["abc", "defg", "hij"]);
    assert.equal(b.commands.anchorText(target(created, cell), 0).kind, "refused");
  });
}

test("a peer removal leaves no narration or visual target, and a peer restoration reveals the kept visual cell", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 1);
  const step = a.commands.setField.withSelection(anchor(a, bVisual, 1), status, "shot");
  written(step.result);
  step.recordAfter(anchor(a, bVisual, 1));
  written(b.commands.removeRows(["B"]));
  send(b, a);
  selection(a.commands.undo());
  selection(a.commands.undo());
  written(b.commands.undo());
  send(b, a);
  written(a.commands.redo());
  selection(a.commands.redo(), bVisual, 1);
  assert.equal(a.document().rows[1]?.visualText, "345");
});

test("undoing a removal follows locally restored narration", t => {
  const [s] = copies(t);
  const step = s.commands.removeRows.withSelection(anchor(s, bText, 1, 3), ["B"]);
  written(step.result);
  step.recordAfter(anchor(s, aText, 3));
  selection(s.commands.undo(), bText, 1, 3);
  selection(s.commands.redo(), aText, 3);
});

test("a peer's restored narration uses the stock gap of the deleted anchor", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 2);
  written(b.commands.removeRows(["B"]));
  send(b, a);
  written(b.commands.undo());
  send(b, a);
  assert.equal(a.document().rows[1]?.audioText, "defg");
  selection(a.commands.undo(), bText, 4);
  selection(a.commands.redo(), bText, 4);
});

test("a peer undo of heading creation leaves no name type to resolve", t => {
  const [a, b] = copies(t);
  written(b.commands.createHeading(anchor(b, bText, 0), "H2", "Second"));
  send(b, a);
  statusWithSelection(a, target("H2", "name"), 2);
  written(b.commands.undo());
  send(b, a);
  assert.deepEqual(a.document().sections, [{ id: "H", name: "Intro", firstSceneId: "A" }]);
  selection(a.commands.undo());
  selection(a.commands.redo());
});

test("heading name replay requires a visible heading and follows its restored name cell", t => {
  const [a, b] = copies(t);
  const at = anchor(a, heading, 0, 5);
  const rename = a.commands.renameHeading.withSelection(at, at, "Next");
  written(rename.result);
  rename.recordAfter(anchor(a, heading, 4));
  written(b.commands.removeHeading("H"));
  send(b, a);
  selection(a.commands.undo());
  written(b.commands.restoreHeading("H"));
  send(b, a);
  selection(a.commands.redo(), heading, 4);
  assert.deepEqual(a.document().sections, [{ id: "H", name: "Next", firstSceneId: "A" }]);
  selection(a.commands.undo(), heading, 0, 5);
});

test("an earlier stacked heading has no name field in the current document projection", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, heading, 2);
  written(b.commands.createHeading(anchor(b, aText, 0), "H2", "Second"));
  send(b, a);
  assert.deepEqual(a.document().sections, [{ id: "H2", name: "Second", firstSceneId: "A" }]);
  selection(a.commands.undo());
  selection(a.commands.redo());
});

test("a press that skips a spent step returns the older step's selection, and an all-spent press returns none", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 3);
  recordType(a, aText, 1, 1, "x");
  send(a, b);
  written(b.commands.deleteText(anchor(b, aText, 1, 2)));
  send(b, a);
  selection(a.commands.undo(), bText, 3);
  assert.equal(a.document().rows[0]?.audioText, "abc");
  selection(a.commands.redo(), bText, 3);
  noChange(a, a.commands.redo);
  selection(a.commands.undo(), bText, 3);
  recordType(a, aText, 1, 1, "y");
  send(a, b);
  written(b.commands.deleteText(anchor(b, aText, 1, 2)));
  send(b, a);
  noChange(a, a.commands.undo);
});
