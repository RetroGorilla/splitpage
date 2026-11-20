import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { anchorNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextTarget, NativeUndoPoint } from "../../../../src/adapters/collab/native/text-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import type { NativeUndoOutcome } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { cells, convertedScript } from "./helpers.ts";
import { AT, beatField } from "./record-harness.ts";
import { structureScript } from "./structure-harness.ts";

type Session = ReturnType<typeof openNativeSession>;
const options = { actor: "Writer", sanitize: (html: unknown) => String(html ?? "") };
const doc = structureScript({ A: "abc", B: "defg", C: "hij" }, { A: "12", B: "345" }, [{ id: "H", name: "Intro", before: "A" }]);
const target = (beat: string, cell: NativeTextTarget["cell"] = "narration"): NativeTextTarget => ({ beat, cell });
const aText = target("A"), bText = target("B"), bVisual = target("B", "visual"), heading = target("H", "name");
const status = beatField("A", "status");

function copies(t: TestContext, otherClient = 3, document = doc): [Session, Session] {
  const seed = openNativeSession({ kind: "document", document, conversion: { cells, creation: "seed", at: AT, by: "Writer" } }, options);
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

function selection(outcome: NativeUndoOutcome, field?: NativeTextTarget, from?: number, to = from,
  endField = field): void {
  const step = written(outcome);
  assert.equal(typeof step.entry, "number");
  assert.deepEqual(step.selection, field ? { anchor: { target: field, offset: from }, head: { target: endField, offset: to } } : undefined);
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

test("a press with no captured inverse leaves an earlier inverse selection alone", t => {
  const [s] = copies(t);
  statusWithSelection(s, aText, 1);
  const at = anchor(s, bText, 2);
  const later = s.commands.setField.withSelection(at, beatField("B", "status"), "ready");
  written(later.result);
  later.recordAfter(at);
  selection(s.commands.undo(), bText, 2);

  const undo = Y.UndoManager.prototype.undo;
  t.mock.method(Y.UndoManager.prototype, "undo", function (this: Y.UndoManager) {
    const capture = this.captureTransaction;
    this.captureTransaction = transaction => transaction.origin !== this && capture(transaction);
    try { return undo.call(this); } finally { this.captureTransaction = capture; }
  });
  selection(s.commands.undo(), aText, 1);
  selection(s.commands.redo(), bText, 2);
  assert.equal(s.document().rows[1]?.status, "ready");
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
  const left: Uint8Array[] = [], right: Uint8Array[] = [];
  a.ydoc.on("update", update => left.push(update));
  b.ydoc.on("update", update => right.push(update));
  recordType(a, aText, 0, 2, "x");
  written(b.commands.typeText(anchor(b, aText, 0, 2), "x", {}));
  assert.deepEqual(a.encodeState(), b.encodeState());
  selection(a.commands.undo(), aText, 0, 2);
  selection(b.commands.undo());
  assert.deepEqual(a.encodeState(), b.encodeState());
  selection(a.commands.redo(), aText, 1);
  selection(b.commands.redo());
  assert.deepEqual(a.encodeState(), b.encodeState());
  assert.equal(left.length, 3);
  assert.deepEqual(left, right);
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

test("before and after selection getters run inside admission and a refused recorder reads nothing", t => {
  const [s] = copies(t);
  const direct = openNativeScript(s.ydoc);
  t.after(() => direct.close());
  const at = anchor(s, aText, 1);
  const nested: unknown[] = [];
  const range = { ...at, get from() {
    nested.push(s.commands.undo());
    nested.push(setNativeField(direct, beatField("A", "note"), "nested"));
    return at.from;
  } };
  const step = s.commands.setField.withSelection(range, status, "ready");
  written(step.result);
  assert.deepEqual(nested, Array(2).fill({ kind: "refused", reason: "busy" }));
  const before = s.encodeState();
  const refused = s.commands.setField.withSelection(at, status, "invalid");
  assert.deepEqual(refused.result, { kind: "refused", reason: "value" });
  refused.recordAfter(range);
  assert.equal(nested.length, 2);
  step.recordAfter(range);
  assert.deepEqual(nested, Array(4).fill({ kind: "refused", reason: "busy" }));
  assert.deepEqual(s.encodeState(), before);
  selection(s.commands.undo(), aText, 1);
  selection(s.commands.redo(), aText, 1);
});

test("an unannotated write adds no selection metadata to its Yjs stack item", t => {
  const [s] = copies(t);
  const emitted = t.mock.method(Y.UndoManager.prototype, "emit");
  type(s, aText, 1, "x");
  assert.equal(emitted.mock.callCount(), 1);
  const call = emitted.mock.calls[0];
  assert(call);
  const [name, [event]] = call.arguments;
  assert.equal(name, "stack-item-added");
  assert.equal((event as { stackItem: { meta: Map<unknown, unknown> } }).stackItem.meta.size, 0);
});

test("typing admits the write before reading its selection under both command guards", t => {
  const [s] = copies(t);
  const direct = openNativeScript(s.ydoc);
  t.after(() => direct.close());
  const at = anchor(s, aText, 1), attempts: unknown[] = [];
  const step = s.commands.typeText.withSelection({ ...at, get from() {
    attempts.push(s.commands.undo(), setNativeField(direct, beatField("A", "note"), "nested"));
    return at.from;
  } }, at, "x", {});
  written(step.result);
  step.recordAfter();
  assert.deepEqual(attempts, Array(2).fill({ kind: "refused", reason: "busy" }));
  selection(s.commands.undo(), aText, 1);
  selection(s.commands.redo(), aText, 2);
});

test("the stored positions copy caller-supplied nested IDs", t => {
  const [s] = copies(t);
  const at = anchor(s, aText, 1);
  const mutable = Y.createRelativePositionFromJSON(JSON.parse(JSON.stringify(at.from)) as object);
  const range = { target: aText, from: mutable, to: mutable };
  const step = s.commands.setField.withSelection(range, status, "ready");
  written(step.result);
  step.recordAfter(range);
  assert(mutable.item);
  mutable.item.clock++;
  selection(s.commands.undo(), aText, 1);
  selection(s.commands.redo(), aText, 1);
});

test("an unknown relative item has no selection and a known item from the wrong beat cannot stand in for it", t => {
  const [s] = copies(t);
  const at = anchor(s, aText, 1);
  const unknown = Y.createRelativePositionFromJSON({ ...at.from, item: { client: 99, clock: 0 } });
  const wrong = { ...anchor(s, bText, 1), target: aText };
  const step = s.commands.setField.withSelection(wrong, status, "ready");
  written(step.result);
  step.recordAfter({ target: aText, from: unknown, to: unknown });
  selection(s.commands.undo());
  selection(s.commands.redo());
});

test("destroying the binding retires its pending after recorder", t => {
  const script = convertedScript(doc, 1), undo = openNativeUndo(script);
  t.after(() => script.doc.destroy());
  const anchored = anchorNativeText(script, aText, 1);
  assert.equal(anchored.kind, "anchored");
  const { range } = anchored;
  assert.equal(undo.typingRecorder, undefined);
  const step = undo.captureSelection(range, prepareWrite => {
    assert.equal(typeof undo.typingRecorder, "function");
    return typeNativeText({ ...script, prepareWrite }, range, "x", {}, undefined, undefined, undo.typingRecorder);
  });
  assert.equal(undo.typingRecorder, undefined);
  written(step.result);
  undo.destroy();
  let reads = 0;
  step.recordAfter({ ...range, get from() { reads++; return range.from; } });
  assert.equal(reads, 0);
});

test("typing can record its own relative caret even when a peer edit arrives before the recorder runs", t => {
  const [a, b] = copies(t);
  const at = anchor(a, aText, 1);
  const first = a.commands.typeText.withSelection(at, at, "x", {});
  written(first.result);
  first.recordAfter();
  const next = anchor(a, aText, 2);
  const last = a.commands.typeText.withSelection(next, next, "y", {});
  written(last.result);
  type(b, aText, 0, "pq");
  send(b, a);
  last.recordAfter();
  selection(a.commands.undo(), aText, 3);
  selection(a.commands.redo(), aText, 5);
  assert.equal(a.document().rows[0]?.audioText, "pqaxybc");
});

for (const [joined, field, offset, marks] of [
  [false, aText, 1, { b: true }], [false, aText, 3, { i: true }],
  [true, aText, 3, { b: true }], [true, bText, 0, { i: true }]
] as const) test(`typed caret follows peer prefixes at ${joined ? "joined" : "formatted"} ${field.beat}:${offset}`, t => {
  const [a, b] = copies(t, 3, structureScript({ A: "a<b>b</b>c", B: "defg" }));
  if (joined) {
    written(a.commands.joinRow("B", "A", "--"));
    send(a, b);
  }
  const at = anchor(a, field, offset);
  const step = a.commands.typeText.withSelection(at, at, "x", marks);
  written(step.result);
  type(b, aText, 0, "pq");
  send(b, a);
  step.recordAfter();
  const shifted = offset + (field.beat === "A" ? 2 : 0);
  selection(a.commands.undo(), field, shifted);
  selection(a.commands.redo(), field, shifted + 1);
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

test("deleted range endpoints keep their Yjs gaps, including peer replacement text between them", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 0, 4);
  written(b.commands.deleteText(anchor(b, bText, 3, 4)));
  written(b.commands.deleteText(anchor(b, bText, 0, 1)));
  send(b, a);
  selection(a.commands.undo(), bText, 0, 2);
  selection(a.commands.redo(), bText, 0, 2);
  written(b.commands.replaceText(anchor(b, bText, 0, 2), [{ text: "pq", marks: {} }]));
  send(b, a);
  selection(a.commands.undo(), bText, 0, 2);
  selection(a.commands.redo(), bText, 0, 2);
  assert.equal(a.document().rows[1]?.audioText, "pq");
});

test("two endpoints at the same Yjs gap replay as one caret", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 1, 3);
  written(b.commands.deleteText(anchor(b, bText, 1, 3)));
  send(b, a);
  for (const press of [a.commands.undo, a.commands.redo]) {
    const result = written(press()).selection;
    assert.deepEqual(result, { anchor: { target: bText, offset: 1 }, head: { target: bText, offset: 1 } });
    assert.equal(result.anchor, result.head);
  }
  assert.equal(a.document().rows[1]?.audioText, "dg");
});

for (const [field, offset, text] of [
  [bText, 1, "abc--defg"],
  [bVisual, 1, "12<br>345"]
] as const) {
  test(`joining a beat keeps the selection in its own ${field.cell} cell`, t => {
    const [a, b] = copies(t);
    statusWithSelection(a, field, offset, offset + 1);
    written(b.commands.joinRow("B", "A", "--"));
    send(b, a);
    assert.equal(a.document().rows[0]?.[field.cell === "visual" ? "visualText" : "audioText"], text);
    selection(a.commands.undo(), field, offset, offset + 1);
    selection(a.commands.redo(), field, offset, offset + 1);
  });
}

test("a caret replayed at the right join edge can type directly into its member", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 0);
  written(b.commands.joinRow("B", "A", "--"));
  send(b, a);
  assert.equal(a.document().rows[0]?.audioText, "abc--defg");
  assert.equal(a.narrationCaret("A", 4), null);
  assert.deepEqual(a.narrationCaret("A", 5), { beat: "B", offset: 0 });
  let caret;
  for (const press of [a.commands.undo, a.commands.redo]) {
    const result = written(press());
    assert.deepEqual(result.selection, {
      anchor: { target: bText, offset: 0 }, head: { target: bText, offset: 0 }
    });
    caret = anchor(a, result.selection.anchor.target, result.selection.anchor.offset);
  }
  assert(caret);
  written(a.commands.typeText(caret, "x", {}));
  assert.equal(a.document().rows[0]?.audioText, "abc--xdefg");
});

test("generated joined rows round-trip all shown member endpoints through both presses and edit commands", async () => {
  let replayed = 0;
  for (const n of [2, 3, 4]) for (let mask = 0; mask < 2 ** n; mask++) for (const glue of ["", " ", "--"]) {
    const ids = [..."ABCD"].slice(0, n);
    const rows = Object.fromEntries(ids.map((id, i) => [id, mask & (1 << i) ? id.repeat(2) : ""]));
    const document = structureScript(rows, rows);
    const s = openNativeSession({ kind: "document", document, conversion: { cells, creation: "seed", at: AT, by: "Writer" } }, options);
    try {
      for (const [index, id] of ids.entries()) {
        const previous = ids[index - 1];
        if (previous) written(s.commands.joinRow(id, previous, glue));
      }
      assert.equal(s.document().rows.length, 1);
      for (const cell of ["narration", "visual"] as const) {
        const points: NativeUndoPoint[] = [];
        for (const [index, beat] of ids.entries()) {
          const length = rows[beat]?.length ?? 0;
          if (!length && (mask || index)) continue;
          for (let offset = 0; offset <= length; offset++) points.push({ target: { beat, cell }, offset });
        }
        const at = (point: NativeUndoPoint) => anchor(s, point.target, point.offset);
        for (const from of points) for (const to of points) {
          const chosen = { anchor: at(from), head: at(to) };
          const value = s.document().rows[0]?.status === "ready" ? "shot" : "ready";
          const step = s.commands.setField.withSelection(chosen, status, value);
          written(step.result);
          step.recordAfter(chosen);
          for (const press of [s.commands.undo, s.commands.redo]) {
            const actual = written(press()).selection;
            assert.deepEqual(actual, { anchor: from, head: to });
            for (const point of [actual.anchor, actual.head]) {
              assert.deepEqual(s.commands.typeText(at(point), "", {}), { kind: "unchanged" });
            }
            if (from.target.beat === to.target.beat) {
              const range = anchor(s, from.target, Math.min(from.offset, to.offset), Math.max(from.offset, to.offset));
              assert.deepEqual(s.commands.formatText(range, { kind: "plain", mark: "b", on: false }), { kind: "unchanged" });
            }
            replayed++;
          }
        }
      }
    } finally {
      s.close();
      await Promise.resolve();
    }
  }
  assert.equal(replayed, 11916);
});

test("selection replay identifies a later Y.Text segment even when an earlier segment has the same offsets", t => {
  const document = structureScript({ A: "abc", B: "def" }, {}, [
    { id: "H1", name: "First", before: "A" }, { id: "H2", name: "Second", before: "B" }
  ]);
  const [a] = copies(t, 3, document);
  assert.notDeepEqual(anchor(a, aText, 1).from.type, anchor(a, bText, 1).from.type);
  statusWithSelection(a, bText, 1);
  selection(a.commands.undo(), bText, 1);
  selection(a.commands.redo(), bText, 1);
});

test("only the document that authored a caret can follow its split ownership before capture", t => {
  const [a, b] = copies(t);
  const foreign = anchor(a, aText, 2), local = anchor(b, aText, 2);
  const created = written(b.commands.splitRow(anchor(b, aText, 1))).created;
  const step = b.commands.setField.withSelection(foreign, status, "ready");
  written(step.result);
  step.recordAfter(local);
  selection(b.commands.undo());
  selection(b.commands.redo(), target(created), 1);
});

test("undo of a hidden record still restores the caret from the row where the step was made", t => {
  const [a, b] = copies(t);
  const step = a.commands.setField.withSelection(anchor(a, aText, 1), beatField("B", "status"), "ready");
  written(step.result);
  written(b.commands.removeRows(["B"]));
  send(b, a);
  const shown = a.document(), before = a.encodeState();
  selection(a.commands.undo(), aText, 1);
  assert.deepEqual(a.document(), shown);
  assert.notDeepEqual(a.encodeState(), before);
});

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

test("a peer split carries surviving endpoints independently into distinct rows", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, bText, 3);
  const spanning = a.commands.setField.withSelection(anchor(a, bText, 1, 4), status, "shot");
  written(spanning.result);
  spanning.recordAfter(anchor(a, bText, 1, 4));
  const created = written(b.commands.splitRow(anchor(b, bText, 2))).created;
  send(b, a);
  selection(a.commands.undo(), bText, 1, 2, target(created));
  selection(a.commands.undo(), target(created), 1);
  assert.equal(a.document().rows.find(row => row.id === created)?.audioText, "fg");
  selection(a.commands.redo(), target(created), 1);
  selection(a.commands.redo(), bText, 1, 2, target(created));
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

test("a deleted range end cannot follow a split into a joined member", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, aText, 0, 3);
  const created = written(b.commands.splitRow(anchor(b, aText, 1))).created;
  written(b.commands.deleteText(anchor(b, target(created), 1, 2)));
  written(b.commands.joinRow(created, "A", "--"));
  send(b, a);
  assert.equal(a.document().rows[0]?.audioText, "a--b");
  selection(a.commands.undo());
  selection(a.commands.redo());
});

test("a deleted range anchor cannot follow a split even while the head survives", t => {
  const [a, b] = copies(t);
  statusWithSelection(a, aText, 1, 3);
  const created = written(b.commands.splitRow(anchor(b, aText, 1))).created;
  written(b.commands.deleteText(anchor(b, target(created), 0, 1)));
  send(b, a);
  assert.equal(a.document().rows.find(row => row.id === created)?.audioText, "c");
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

test("an entirely empty joined visual row anchors its head at offset zero", t => {
  const [a, b] = copies(t, 3, structureScript({ A: "abc", B: "def" }));
  written(b.commands.joinRow("B", "A", ""));
  send(b, a);
  const visual = target("A", "visual");
  statusWithSelection(a, visual, 0);
  selection(a.commands.undo(), visual, 0);
  selection(a.commands.redo(), visual, 0);
});

for (const disappeared of ["anchor", "head"] as const) test(`a range omits selection when its ${disappeared} Yjs type disappears`, t => {
  const [a, b] = copies(t);
  const created = written(b.commands.splitRow(anchor(b, aText, 1))).created;
  type(b, target(created, "visual"), 0, "x");
  written(b.commands.joinRow(created, "A", "--"));
  send(b, a);
  const visual = target("A", "visual");
  assert.equal(a.document().rows[0]?.visualText, "12<br>x");
  const stable = anchor(a, visual, 1), removed = anchor(a, target(created, "visual"), 0);
  const pair = disappeared === "anchor" ? { anchor: removed, head: stable } : { anchor: stable, head: removed };
  const step = a.commands.setField.withSelection(pair, status, "ready");
  written(step.result);
  step.recordAfter(pair);
  for (let i = 0; i < 3; i++) written(b.commands.undo());
  send(b, a);
  assert.equal(a.document().rows[0]?.visualText, "12");
  selection(a.commands.undo());
  selection(a.commands.redo());
});

test("a range has no selection when the peer's missing segment invalidates its narration anchor", t => {
  const [a, b] = copies(t, 3, structureScript({ A: "abc", B: "def" }, {}, [
    { id: "H1", name: "First", before: "A" }, { id: "H2", name: "Second", before: "B" }
  ]));
  const peer = openNativeScript(b.ydoc);
  t.after(() => peer.close());
  const pair = { anchor: anchor(a, aText, 1), head: anchor(a, bText, 1) };
  const step = a.commands.setField.withSelection(pair, beatField("B", "status"), "ready");
  written(step.result);
  step.recordAfter(pair);
  const segment = peer.reader.beatBoundary("A")?.segment;
  assert(segment);
  b.ydoc.transact(() => peer.roots.segments.delete(segment), "peer");
  send(b, a);
  assert.deepEqual(a.document().rows.map(row => row.id), ["B"]);
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
