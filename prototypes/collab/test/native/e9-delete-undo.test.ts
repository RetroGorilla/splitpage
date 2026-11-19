import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { UndoLayer } from "../../src/native-undo/layer.ts";
import type { NativeDeltaItem } from "../../src/native/variant.ts";
import { histories, rows, type } from "../native-delete/histories.ts";
import { check, exchange, load, readStored, readStyles, readVisible, seed, write } from "../native-delete/kit.ts";
import type { DeleteReplica } from "../native-delete/kit.ts";
import { advance, base, need } from "../native-delete/model.ts";
import type { DeleteCommand, StoredReading } from "../native-delete/model.ts";

function copies(initial = base, left = 11, right = 22): [DeleteReplica, DeleteReplica] {
  const source = seed(initial);
  const result: [DeleteReplica, DeleteReplica] = [load(source.encode(), left), load(source.encode(), right)];
  source.destroy();
  return result;
}

function assertPeers(a: DeleteReplica, b: DeleteReplica): void {
  const late = load(a.encode(), 101);
  try {
    for (const other of [b, late]) {
      assert.deepEqual(readStored(other), readStored(a), "stored copies");
      assert.deepEqual(readVisible(other), readVisible(a), "visible copies");
      assert.deepEqual(readStyles(other), readStyles(a), "formatted copies");
    }
  } finally {
    late.destroy();
  }
}

function press(replica: DeleteReplica, manager: Y.UndoManager, action: "undo" | "redo", expected: StoredReading): void {
  assert.throws(() => check(replica, [expected]), { code: "ERR_ASSERTION" });
  assert.ok(manager[action]());
  check(replica, [expected]);
}

test("E9 one standard undo step restores row, run, scene and heading deletions", t => {
  let pairs = 0;
  for (const policy of ["keep", "drop"] as const) for (const history of histories(1)) {
    const command = need(history.forks[0]?.[0], "deletion");
    const [a, b] = copies(history.initial);
    try {
      let transactions = 0;
      a.doc.on("afterTransaction", tr => { if (tr.origin === a.origin) transactions++; });
      write(a, command, policy);
      const removed = advance(history.initial, command, policy);
      assert.equal(transactions, 1);
      assert.equal(a.undo.undoStack.length, 1);
      exchange(a, b);
      check(a, [removed]);
      check(b, [removed]);
      press(a, a.undo, "undo", history.initial);
      exchange(a, b);
      check(a, [history.initial]);
      check(b, [history.initial]);
      assert.equal(b.undo.undoStack.length, 0);
      press(a, a.undo, "redo", removed);
      exchange(a, b);
      check(a, [removed]);
      check(b, [removed]);
      assertPeers(a, b);
      pairs++;
    } finally {
      a.destroy();
      b.destroy();
    }
  }
  t.diagnostic(`silent undo and redo, each used/effective/failed ${pairs}/${pairs}/${pairs}`);
});

for (const timing of ["before", "during"] as const) test(`E9 undo and marks added ${timing} deletion`, () => {
  const [a, b] = copies();
  try {
    const keys = { b: true, "t:T": true, "c:note": true } as const;
    if (timing === "during") write(a, rows("B"), "keep");
    b.format("B", "audioText", 1, 2, keys);
    b.format("B", "visualText", 0, 1, keys);
    const audio = b.cell("B", "audioText");
    const anchor = Y.createRelativePositionFromTypeIndex(audio.text, audio.start + 1);
    const visualAnchor = Y.createRelativePositionFromTypeIndex(b.cell("B", "visualText").text, 0);
    b.transact(() => { b.doc.getMap("comments").set("note", "Read this"); });
    exchange(a, b);
    if (timing === "before") {
      write(a, rows("B"), "keep");
      exchange(a, b);
    }
    press(a, a.undo, "undo", base);
    exchange(a, b);
    check(a, [base]);
    check(b, [base]);
    assertPeers(a, b);
    const marks = timing === "before" ? [keys] : [];
    assert.deepEqual(a.block("B").delta.flatMap(item => item.attributes ? [item.attributes] : []), marks);
    const visual = a.visuals.get("B")?.toDelta() as NativeDeltaItem[];
    assert.deepEqual(visual.flatMap(item => item.attributes ? [item.attributes] : []), marks);
    for (const [copy, letter, visualIndex] of [[a, "e", 0], [b, "f", null]] as const) {
      const pos = Y.createAbsolutePositionFromRelativePosition(anchor, copy.doc);
      assert.ok(pos?.type instanceof Y.Text);
      const from = copy.cell("B", "audioText").start;
      assert.equal("def"[pos.index - from], letter);
      assert.equal(Y.createAbsolutePositionFromRelativePosition(visualAnchor, copy.doc)?.index ?? null, visualIndex);
    }
    assert.equal(a.doc.getMap("comments").get("note"), "Read this");
    press(a, a.undo, "redo", advance(base, rows("B"), "keep"));
    exchange(a, b);
    check(a, [advance(base, rows("B"), "keep")]);
    assertPeers(a, b);
  } finally {
    a.destroy();
    b.destroy();
  }
});

for (const timing of ["before", "during", "in flight at undo"] as const) for (const field of ["audio", "visual"] as const) {
  test(`E9 other person's undo: ${field} typed ${timing} deletion`, () => {
    const [a, b] = copies();
    try {
      write(b, type("F", "audio", 1, "Ψ"), "keep");
      if (timing !== "before") write(a, rows("B"), "keep");
      write(b, type("B", field, 1), "keep");
      if (timing !== "in flight at undo") exchange(a, b);
      if (timing === "before") {
        write(a, rows("B"), "keep");
        exchange(a, b);
      }
      const typed = advance(base, type("F", "audio", 1, "Ψ"), "keep");
      const restored = timing !== "before" && field === "visual" ? typed
        : advance(typed, type("B", field, timing === "in flight at undo" ? 3 : 1), "keep");
      press(a, a.undo, "undo", timing === "in flight at undo" ? base : restored);
      exchange(a, b);
      check(b, [restored]);
      assertPeers(a, b);
      const undoesOwn = timing !== "before" && field === "audio";
      const expected = undoesOwn ? typed : timing === "before" ? advance(base, type("B", field, 1), "keep") : base;
      press(b, b.undo, "undo", expected);
      exchange(a, b);
      assert.equal(b.undo.undoStack.length, undoesOwn ? 1 : 0);
      assertPeers(a, b);
    } finally {
      a.destroy();
      b.destroy();
    }
  });
}

test("E9 redo of deletion leaves an unseen narration letter in the preceding beat", () => {
  for (const early of [true, false]) {
    const [a, b] = copies();
    try {
      write(a, rows("B"), "keep");
      write(b, type("B", "audio", 1), "keep");
      if (early) exchange(a, b);
      press(a, a.undo, "undo", early ? advance(base, type("B", "audio", 1), "keep") : base);
      exchange(a, b);
      press(a, a.undo, "redo", advance(advance(base, rows("B"), "keep"), type("A", "audio", 3), "keep"));
      exchange(a, b);
      assertPeers(a, b);
    } finally {
      a.destroy();
      b.destroy();
    }
  }
});

const earlier = type("F", "audio", 1, "Ψ");
const audioErase: DeleteCommand = { op: "erase", id: "B", field: "audio", from: 1, to: 2 };
const visualErase: DeleteCommand = { op: "erase", id: "B", field: "visual", from: 0, to: 1 };
const bold: DeleteCommand = { op: "mark", id: "B", field: "audio", from: 1, to: 2, key: "b" };
const status: DeleteCommand = { op: "field", id: "B", value: "ready" };
const withoutStatus = structuredClone(base);
delete need(withoutStatus.beats.B, "B").status;
const withEarlier = advance(base, earlier, "keep");

for (const [name, edit, seen, restored, after, stack, marked] of [
  ["seen narration erase", audioErase, true, advance(withEarlier, audioErase, "keep"), withEarlier, 1, false],
  ["unseen narration erase", audioErase, false, withEarlier, advance(withEarlier, type("B", "audio", 3, "e"), "keep"), 1, false],
  ["seen visual erase", visualErase, true, advance(withEarlier, visualErase, "keep"), advance(base, visualErase, "keep"), 0, false],
  ["unseen visual erase", visualErase, false, withEarlier, base, 0, false],
  ["seen bold", bold, true, withEarlier, base, 0, true],
  ["seen status", status, true, advance(withEarlier, status, "keep"), advance(base, status, "keep"), 0, false],
  ["unseen status", status, false, advance(withoutStatus, earlier, "keep"), withoutStatus, 0, false]
] as const) test(`E9 other person's undo: ${name}`, () => {
  const [a, b] = copies();
  try {
    write(b, earlier, "keep");
    if (!seen) write(a, rows("B"), "keep");
    write(b, edit, "keep");
    exchange(a, b);
    if (seen) {
      write(a, rows("B"), "keep");
      exchange(a, b);
    }
    press(a, a.undo, "undo", restored);
    exchange(a, b);
    check(b, [restored]);
    press(b, b.undo, "undo", after);
    exchange(a, b);
    assert.equal(b.undo.undoStack.length, stack);
    assertPeers(a, b);
    assert.equal(b.block("B").delta.some(item => item.attributes?.b === true), marked);
  } finally {
    a.destroy();
    b.destroy();
  }
});

for (const schedule of ["seen", "crossed", "offline"] as const) test(`E9 two deleters undo with ${schedule} delivery`, () => {
  const [a, b] = copies();
  try {
    const removed = advance(base, rows("B"), "keep");
    write(a, rows("B"), "keep");
    write(b, rows("B"), "keep");
    if (schedule !== "offline") exchange(a, b);
    check(a, [removed]);
    check(b, [removed]);
    press(a, a.undo, "undo", base);
    if (schedule === "seen") exchange(a, b);
    assert.ok(b.undo.undo());
    if (schedule !== "seen") check(b, [base]);
    exchange(a, b);
    assertPeers(a, b);
    assert.deepEqual(readStored(a).segments.S?.units, [
      ..."abc", { kind: "b", id: "B" }, { kind: "b", id: "B" }, ..."defdef", { kind: "b", id: "C" }, ..."ghi"
    ]);
    assert.deepEqual(readVisible(a).filter(entry => "id" in entry && entry.id === "B"), [
      { id: "B", members: ["B"], audio: "", visual: "2", status: "todo" }
    ]);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("E9 bare Y.Text duplicates a span when both writers delete and undo before syncing", () => {
  const first = new Y.Doc(), second = new Y.Doc();
  const a = first.getText("text"), b = second.getText("text");
  a.insert(0, "abcdefghi");
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  const firstUndo = new Y.UndoManager(a), secondUndo = new Y.UndoManager(b);
  try {
    for (const [text, manager] of [[a, firstUndo], [b, secondUndo]] as const) {
      text.delete(3, 3);
      assert.equal(text.toString(), "abcghi");
      assert.ok(manager.undo());
      assert.equal(text.toString(), "abcdefghi");
    }
    const fromFirst = Y.encodeStateAsUpdate(first), fromSecond = Y.encodeStateAsUpdate(second);
    Y.applyUpdate(first, fromSecond);
    Y.applyUpdate(second, fromFirst);
    assert.equal(a.toString(), "abcdefdefghi");
    assert.equal(b.toString(), "abcdefdefghi");
  } finally {
    firstUndo.destroy();
    secondUndo.destroy();
    first.destroy();
    second.destroy();
  }
});

interface CreationTotals { lost: number; placed: number; stranded: number; recovery: number; bytes: number; freshBytes: number }
interface CreationControlCount { used: number; effective: number; failed: number }
type CreationControls = Record<"undo" | "redo", CreationControlCount>;

function checkCreationControl(
  replica: DeleteReplica, withoutPress: StoredReading, expected: StoredReading, counts: CreationControlCount
): void {
  counts.used++;
  assert.notDeepEqual(withoutPress, expected);
  counts.effective++;
  assert.throws(() => check(replica, [expected]), { code: "ERR_ASSERTION" });
  counts.failed++;
}

function creation(
  command: Extract<DeleteCommand, { op: "split" | "insert" }>, keep: boolean, seedNumber: number,
  totals: CreationTotals, controls: CreationControls
): void {
  const [a, b] = copies(base, 1 + seedNumber, 70 - seedNumber);
  const layer = keep ? new UndoLayer(a, { creations: "keep-always", grouping: "yjs" }) : null;
  const manager = layer?.manager ?? a.undo, id = command.created;
  try {
    write(a, command, "keep");
    const created = advance(base, command, "keep");
    exchange(a, b);
    check(b, [created]);
    const at = seedNumber % 2;
    const updates: Uint8Array[] = [];
    b.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin === b.origin) updates.push(update); });
    write(b, type(id, "audio", at), "keep");
    write(b, type(id, "visual", 0, "Ψ"), "keep");
    write(b, { op: "field", id, value: "ready" }, "keep");
    assert.equal(updates.length, 3);
    const incoming = seedNumber % 3 === 0 ? updates.toReversed() : seedNumber % 3 === 1 ? [...updates, ...updates] : updates;
    const deleted = expectedCreation(command, keep, at);
    const muted = load(a.encode(), 100);
    try {
      for (const update of incoming) Y.applyUpdate(muted.doc, update, "remote");
      const bothLetters = advance(advance(created, type(id, "audio", at), "keep"), type(id, "visual", 0, "Ψ"), "keep");
      const withoutUndo = advance(bothLetters, { op: "field", id, value: "ready" }, "keep");
      check(muted, [withoutUndo]);
      checkCreationControl(muted, withoutUndo, deleted, controls.undo);
    } finally {
      muted.destroy();
    }
    assert.ok(manager.undo());
    for (const update of incoming) Y.applyUpdate(a.doc, update, "remote");
    Y.applyUpdate(b.doc, a.encode(), "remote");
    assertPeers(a, b);
    const after = readStored(a), display = readVisible(a);
    const recovery = a.recovery().find(entry => entry.beat === id);
    check(a, [deleted]);
    check(b, [deleted]);
    for (const char of ["Ω", "Ψ"]) {
      if (display.some(entry => "id" in entry && (entry.audio.includes(char) || entry.visual.includes(char)))) totals.placed++;
      else if (recovery?.visual.includes(char)) totals.recovery++;
      else if (Object.values(after.segments).some(segment => segment.units.includes(char)) ||
        Object.values(after.visuals).some(text => text.includes(char))) totals.stranded++;
      else totals.lost++;
    }
    totals.bytes += a.encode().length;
    const fresh = load(a.encode(), 100);
    totals.freshBytes += fresh.encode().length;
    fresh.destroy();
    let redone = created;
    if (command.op === "split" || keep) redone = advance(redone, type(id, "audio", at), "keep");
    if (keep) {
      redone = advance(redone, type(id, "visual", 0, "Ψ"), "keep");
      redone = advance(redone, { op: "field", id, value: "ready" }, "keep");
    } else {
      redone = structuredClone(redone);
      redone.beats[id] = {};
    }
    checkCreationControl(a, deleted, redone, controls.redo);
    assert.ok(manager.redo());
    check(a, [redone]);
    exchange(a, b);
    assertPeers(a, b);
    check(b, [redone]);
  } finally {
    manager.destroy();
    a.destroy();
    b.destroy();
  }
}

function expectedCreation(
  command: Extract<DeleteCommand, { op: "split" | "insert" }>, keep: boolean, at: number
): StoredReading {
  const expected = structuredClone(base), id = command.created;
  if (command.op === "split") need(expected.segments.S, "script").units.splice(5 + at, 0, "Ω");
  if (keep) {
    expected.beats[id] = { status: "ready" };
    expected.visuals[id] = "Ψ";
    if (command.op === "insert") {
      const segment = `seg-b-${id}`;
      expected.segments[segment] = { head: null, units: ["Ω"] };
    }
  }
  return expected;
}

test("E9 creation undo with unseen typing, plain and keep-always", t => {
  const counts: CreationControls = {
    undo: { used: 0, effective: 0, failed: 0 }, redo: { used: 0, effective: 0, failed: 0 }
  };
  const historiesPerCase = 40;
  let historiesRun = 0;
  for (const command of [
    { op: "split", id: "B", at: 1, created: "N" },
    { op: "insert", before: "D", created: "N", value: "@" }
  ] as const) for (const keep of [false, true]) {
    const totals = { lost: 0, placed: 0, stranded: 0, recovery: 0, bytes: 0, freshBytes: 0 };
    for (let n = 1; n <= historiesPerCase; n++) {
      creation(command, keep, n, totals, counts);
      historiesRun++;
    }
    t.diagnostic(JSON.stringify({ op: command.op, keep, histories: historiesPerCase, ...totals }));
  }
  for (const [action, { used, effective, failed }] of Object.entries(counts)) {
    assert.deepEqual([used, effective, failed], [historiesRun, historiesRun, historiesRun]);
    t.diagnostic(`silent creation ${action}, used/effective/failed ${used}/${effective}/${failed}`);
  }
});
