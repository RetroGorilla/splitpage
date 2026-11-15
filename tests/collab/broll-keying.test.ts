import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { scriptCellOf } from "../../src/bootstrap/richtext.ts";
import { htmlToPlainText } from "../../src/bootstrap/plain-text.ts";
import { sharedBrollKeyingPorts } from "../../src/bootstrap/wiring/ports/shared-broll-keying.ts";
import { sharedAuthorPort } from "../../src/bootstrap/wiring/ports/shared-author.ts";
import { sharedUndoOwner } from "../../src/bootstrap/wiring/ports/shared-undo.ts";
import { sharedCommandRefusalNotice } from "../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { keySharedLeftCell } from "../../src/application/commands/shared-broll-keying.ts";
import { readSharedRevision, createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../../src/adapters/collab/document.ts";
import { createSharedAnchor } from "../../src/adapters/collab/anchors.ts";
import { readSharedTextHistory } from "../../src/adapters/collab/text-history.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { explode } from "../../src/core/text/edits.ts";
import type { Run } from "../../src/core/text/runs.ts";
import { sharedCellTextOperations } from "../../src/core/collab/cell-text-operations.ts";
import { sharedStructureKey } from "../../src/core/collab/structure-key.ts";
import { sharedStructurePorts } from "../../src/bootstrap/wiring/ports/shared-values.ts";
import { deleteBeatCommand } from "../../src/application/commands/rows.ts";
import type { SharedTextAddress } from "../../src/core/collab/operations.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { projectSharedDocumentWithRecovery } from "../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { flowBaseReference } from "../../src/core/collab/base-reference.ts";
import { adapterReplica, sharedHarness, sharedCommand } from "../application/session/shared-session-support.ts";
import { operation } from "../adapters/collab/executor-support.ts";
import { fakeNotices } from "../features/fakes.ts";
import { agreedRows, deliverAll, findReplicas, sendAs } from "../features/find/shared-replace-support.ts";
import type { FindOrder } from "../features/find/shared-replace-support.ts";
import { bufferReaders, bufferStamps } from "./buffer-readers.ts";

const ORDERS: readonly FindOrder[] = ["D1", "rev", "dup"];
const AT = "2026-11-15T10:00:00.000Z";
const KEY = (id: string) => '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">B-roll:</span>';
const SEED = { desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "Pour the coffee", location: "", props: [], origin: "script" };

function source(visualText: string): Record<string, unknown> {
  return { schema: 2, docId: "d00000000000000000000000000000000", title: "",
    rows: [{ id: "R1", status: "todo", audioText: "Pour the coffee", visualText }, { id: "R2", status: "todo", audioText: "Drink", visualText: "Wide" }],
    productionTags: [], brollShots: [{ id: "S1", name: "Mug", status: "unshot", origin: "list" }] };
}

function typedLine(name: string) {
  const set = findReplicas(source(name));
  sendAs(set.b, { kind: "text-insert", id: "marker", by: "Bob", target: { owner: "R1", segment: "R1", field: "visualText" },
    at: { left: null, right: flowBaseReference("R1", "visualText", 0), affinity: "before" }, content: [{ value: "B-roll: ", marks: [] }] });
  deliverAll(set.queue, "D1");
  assert.equal(projectSharedDocumentWithRecovery(set.a).document.rows[0]?.visualText, "B-roll: " + name);
  return set;
}

function copy(handle: SharedDocumentHandle, name: string, notices = fakeNotices()) {
  const author = sharedAuthorPort({ handle: () => handle, name: () => name });
  const owner = sharedUndoOwner(handle, () => author.next(), () => 0, error => { throw error; });
  const harness = sharedHarness(adapterReplica(handle, owner), { refused: sharedCommandRefusalNotice(notices.notices) });
  const ports = sharedBrollKeyingPorts(handle, { author: () => author.next(), cells: scriptCellOf, readers: bufferReaders, plainTextOf: htmlToPlainText,
    stamps: bufferStamps(name, () => AT) });
  return { owner, session: harness.session, notices, harness, ports, leave: (rowId = "R1") => keySharedLeftCell(harness.session, rowId, ports).map(outcome => outcome.kind) };
}

function shots(handle: SharedDocumentHandle) {
  return projectSharedDocumentWithRecovery(handle).document.brollShots.filter(shot => shot.id !== "S1").map(shot => ({ ...shot }));
}

function visual(set: ReturnType<typeof findReplicas>, label: string, order: FindOrder) {
  return agreedRows(label, set, order).map(row => row.visualText)[0];
}

function agreedShots(set: ReturnType<typeof findReplicas>) {
  const a = shots(set.a);
  assert.deepEqual(shots(set.b), a);
  const late = createSharedDocument();
  try {
    assert.equal(applySharedUpdate(late, encodeSharedState(set.a)).ok, true);
    const snapshot = (handle: SharedDocumentHandle) => {
      const doc = projectSharedDocumentWithRecovery(handle).document;
      return { text: doc.rows.map(row => [row.visualText, row.audioText]), keys: doc.rows.map(row => explode(scriptCellOf(String(row.visualText ?? ""))).flatMap(unit => unit.atom?.atom === "broll" ? [unit.atom.id] : [])), shots: doc.brollShots };
    };
    assert.deepEqual(snapshot(set.b), snapshot(set.a));
    assert.deepEqual(snapshot(late), snapshot(set.a));
  } finally { destroySharedDocument(late); }
  return a;
}

function lineKeyOf(handle: SharedDocumentHandle): string {
  const shot = shots(handle)[0];
  assert.ok(shot);
  assert.match(shot.id, /^bs_k\d+_\d+$/);
  return shot.id;
}

function bytes(handle: SharedDocumentHandle, run: () => void): number {
  const doc = collabState(handle).doc, before = Y.encodeStateVector(doc);
  run();
  return Y.encodeStateAsUpdate(doc, before).byteLength;
}

for (const order of ORDERS) {
  test(`leaving a Split visual cell keys its line and makes its shot on every copy, with one undo entry: ${order}`, () => {
    const set = typedLine("Close up"), a = copy(set.a, "Alice");
    try {
      assert.deepEqual(a.leave(), ["applied"]);
      deliverAll(set.queue, order);
      const id = lineKeyOf(set.a);
      assert.equal(visual(set, "keyed", order), KEY(id) + " Close up");
      assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
      assert.deepEqual(a.owner.sizes(), { undo: 1, redo: 0, dropped: 0 });
      assert.deepEqual(a.notices.shown, []);
    } finally { a.session.dispose(); set.close(); }
  });

  test(`undo of the keying takes back the key and the shot it made; redo brings back the same key and shot: ${order}`, () => {
    const set = typedLine("Close up"), a = copy(set.a, "Alice");
    try {
      a.leave(); deliverAll(set.queue, order);
      const id = lineKeyOf(set.a), made = agreedShots(set);
      assert.equal(a.owner.undo().ok, true); deliverAll(set.queue, order);
      assert.equal(visual(set, "undone", order), "B-roll: Close up");
      assert.deepEqual(agreedShots(set), []);
      assert.equal(a.owner.redo().ok, true); deliverAll(set.queue, order);
      assert.equal(visual(set, "redone", order), KEY(id) + " Close up");
      assert.deepEqual(agreedShots(set), made);
    } finally { a.session.dispose(); set.close(); }
  });
}

test("leaving a cell with nothing to key runs no command, keeps no undo entry and stores nothing", () => {
  for (const cell of ["Wide shot", "", KEY("S1") + " Mug"]) {
    const set = findReplicas(source(cell)), a = copy(set.a, "Alice"), before = readSharedRevision(set.a);
    try {
      assert.deepEqual(a.leave(), []);
      assert.deepEqual(a.leave("R2"), []);
      assert.equal(readSharedRevision(set.a), before);
      assert.equal(set.queue.pending.length, 0);
      assert.deepEqual(a.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
      agreedShots(set);
    } finally { a.session.dispose(); set.close(); }
  }
});

test("a line naming a shot no line holds takes that shot's key and makes no shot", () => {
  const set = typedLine("Mug"), a = copy(set.a, "Alice");
  try {
    assert.deepEqual(a.leave(), ["applied"]);
    deliverAll(set.queue, "D1");
    assert.equal(visual(set, "reused", "D1"), KEY("S1") + " Mug");
    assert.deepEqual(agreedShots(set), []);
  } finally { a.session.dispose(); set.close(); }
});

test("rule 198: leaving a row that is gone, or a session with no document, keys nothing", () => {
  const set = typedLine("Close up"), a = copy(set.a, "Alice");
  try {
    assert.deepEqual(a.leave("R9"), []);
    a.session.dispose();
    assert.deepEqual(a.leave(), []);
    assert.equal(set.queue.pending.length, 0);
    agreedShots(set);
  } finally { set.close(); }
});

for (const order of ORDERS) {
  test(`rule 196: two copies leaving one line at once store one shot under one id; the next leave drops the later key: ${order}`, () => {
    const set = typedLine("Close up"), a = copy(set.a, "Alice"), b = copy(set.b, "Bob");
    try {
      assert.deepEqual(a.leave(), ["applied"]);
      assert.deepEqual(b.leave(), ["applied"]);
      deliverAll(set.queue, order);
      const id = lineKeyOf(set.a), doubled = String(visual(set, "doubled", order) ?? "");
      const repeat = /data-broll-id="(broll_[^"]+)"/.exec(doubled)?.[1] ?? "";
      assert.equal(doubled, KEY(id) + KEY(repeat) + " Close up");
      assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
      const dropped = repeat.split("_").at(-2) === "1" ? a : b, kept = dropped === a ? b : a;
      assert.deepEqual(dropped.leave(), ["applied"]);
      deliverAll(set.queue, order);
      assert.equal(visual(set, "cleaned", order), KEY(id) + " Close up");
      assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
      assert.deepEqual([a.owner.sizes(), b.owner.sizes()], [{ undo: 1, redo: 0, dropped: 0 }, { undo: 1, redo: 0, dropped: 0 }]);
      const revision = readSharedRevision(set.a);
      assert.deepEqual(dropped.owner.undo(), { ok: true, effective: false, label: "key-broll-lines", selection: null, reason: "used-up" });
      assert.equal(set.queue.pending.length, 0);
      assert.equal(readSharedRevision(set.a), revision);
      assert.deepEqual(dropped.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
      assert.deepEqual(kept.owner.undo(), { ok: true, effective: false, label: "key-broll-lines", selection: null, reason: "used-up" });
      assert.equal(set.queue.pending.length, 0);
      assert.equal(visual(set, "peer key contribution uses up both undos", order), KEY(id) + " Close up");
      assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
    } finally { a.session.dispose(); b.session.dispose(); set.close(); }
  });

  test(`rule 196: two copies cleaning the doubled key at once delete the same key and converge: ${order}`, () => {
    const set = typedLine("Close up"), a = copy(set.a, "Alice"), b = copy(set.b, "Bob");
    try {
      a.leave(); b.leave(); deliverAll(set.queue, order);
      const id = lineKeyOf(set.a);
      assert.deepEqual([a.leave(), b.leave()], [["applied"], ["applied"]]);
      deliverAll(set.queue, order);
      assert.equal(visual(set, "both cleaned", order), KEY(id) + " Close up");
      assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
      assert.deepEqual([a.leave(), b.leave()], [[], []]);
    } finally { a.session.dispose(); b.session.dispose(); set.close(); }
  });

  test(`rule 197: text another copy types into the line while it is keyed stays after the key; the shot keeps the name seen: ${order}`, () => {
    const set = typedLine("Close up"), a = copy(set.a, "Alice");
    try {
      a.leave();
      sendAs(set.b, { kind: "text-insert", id: "typed", by: "Bob", target: { owner: "R1", segment: "R1", field: "visualText" },
        at: { left: flowBaseReference("R1", "visualText", 15), right: null, affinity: "after" }, content: [{ value: " shot", marks: [] }] },
      { kind: "text-insert", id: "inside", by: "Bob", target: { owner: "R1", segment: "R1", field: "visualText" },
        at: { left: null, right: flowBaseReference("R1", "visualText", 6), affinity: "before" }, content: [{ value: "s", marks: [] }] });
      deliverAll(set.queue, order);
      const id = lineKeyOf(set.a);
      assert.equal(visual(set, "typed meanwhile", order), KEY(id) + "s Close up shot");
      assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
    } finally { a.session.dispose(); set.close(); }
  });

  test(`rule 199: undo of the keying after another copy changed the shot is used up and writes nothing: ${order}`, () => {
    const set = typedLine("Close up"), a = copy(set.a, "Alice");
    try {
      a.leave(); deliverAll(set.queue, order);
      const id = lineKeyOf(set.a);
      sendAs(set.b, { kind: "record-set", id: "renamed", by: "Bob", target: { collection: "shots", record: id }, field: "notes", value: "handheld" });
      deliverAll(set.queue, order);
      const revision = readSharedRevision(set.a);
      assert.deepEqual(a.owner.undo(), { ok: true, effective: false, label: "key-broll-lines", selection: null, reason: "used-up" });
      assert.equal(readSharedRevision(set.a), revision);
      assert.equal(set.queue.pending.length, 0);
      assert.deepEqual(a.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
      assert.equal(visual(set, "kept", order), KEY(id) + " Close up");
      assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED, notes: "handheld" }]);
    } finally { a.session.dispose(); set.close(); }
  });

  test(`rule 145: undo of the keying after another copy deleted the key is used up and writes nothing: ${order}`, () => {
    const set = typedLine("Close up"), a = copy(set.a, "Alice");
    try {
      a.leave(); deliverAll(set.queue, order);
      const id = lineKeyOf(set.a);
      sendAs(set.b, { kind: "text-delete", id: "cut", by: "Bob", target: { owner: "R1", segment: "R1", field: "visualText" }, observed: [flowBaseReference("R1", "visualText", 0, 1)] });
      deliverAll(set.queue, order);
      assert.deepEqual(a.owner.undo(), { ok: true, effective: false, label: "key-broll-lines", selection: null, reason: "used-up" });
      assert.equal(set.queue.pending.length, 0);
      assert.equal(visual(set, "cut", order), " Close up");
      assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
    } finally { a.session.dispose(); set.close(); }
  });
}

test("stored size: one keying and its undo, as encoded updates", () => {
  const set = typedLine("Close up"), a = copy(set.a, "Alice");
  try {
    const keyed = bytes(set.a, () => { assert.deepEqual(a.leave(), ["applied"]); });
    const undone = bytes(set.a, () => { assert.equal(a.owner.undo().ok, true); });
    assert.deepEqual({ keyed, undone }, { keyed: 649, undone: 2819 });
    deliverAll(set.queue, "D1"); agreedShots(set);
  } finally { a.session.dispose(); set.close(); }
});

const TARGET = { owner: "R1", segment: "R1", field: "visualText" } as SharedTextAddress;

function writtenCell(html: string) {
  const set = findReplicas(source("~")), before = scriptCellOf("~"), after = scriptCellOf(html);
  const operations = sharedCellTextOperations({ owner: "R1", field: "visualText", before, after }, [{ from: 0, to: 1, insert: after }]);
  assert.ok(operations);
  sendAs(set.b, ...operations.map((operation, index) => ({ ...operation, id: "seed-" + index, by: "Bob" })));
  deliverAll(set.queue, "D1");
  return set;
}

function insertAt(handle: SharedDocumentHandle, at: number, value: string, id = "peer-edit") {
  const anchor = createSharedAnchor(handle, TARGET, at, "before");
  assert.ok(anchor);
  sendAs(handle, { kind: "text-insert", id, by: "Bob", target: TARGET,
    at: { left: null, right: anchor, affinity: "before" }, content: [{ value, marks: [] }] });
}

function usedUp(a: ReturnType<typeof copy>, set: ReturnType<typeof findReplicas>) {
  const revision = readSharedRevision(set.a);
  assert.deepEqual(a.owner.undo(), { ok: true, effective: false, label: "key-broll-lines", selection: null, reason: "used-up" });
  assert.equal(readSharedRevision(set.a), revision);
  assert.equal(set.queue.pending.length, 0);
  assert.deepEqual(a.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
  agreedShots(set);
}

const ATOMS: readonly Run[] = [
  { atom: "image", ref: { sha256: "a".repeat(64), mime: "image/png", width: 1, height: 1 }, text: "", marks: {} },
  { atom: "video", href: "https://example.com/clip.mp4", host: "example.com", text: "", marks: {} },
  { atom: "who", name: "Bob", text: "@Bob", marks: {} }
];

for (const order of ORDERS) {
  for (const atom of ATOMS) for (const position of ["before", "after", "between"] as const) {
    test(`marker replacement preserves ${atom.atom} ${position} the marker on all copies: ${order}`, () => {
      const text = (value: string): Run => ({ text: value, marks: {} });
      const cell = toHtml(position === "before" ? [atom, text("B-roll: Close up")]
        : position === "after" ? [text("B-roll: Close up"), atom] : [text("B-roll: "), atom, text("Close up")]);
      const set = writtenCell(cell), a = copy(set.a, "Alice");
      try {
        assert.deepEqual(a.leave(), ["applied"]); deliverAll(set.queue, order);
        const id = lineKeyOf(set.a), image = toHtml([atom]);
        assert.equal(visual(set, "atom retained", order), position === "before" ? image + KEY(id) + " Close up"
          : position === "after" ? KEY(id) + " Close up" + image : KEY(id) + " " + image + "Close up");
        assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
      } finally { a.session.dispose(); set.close(); }
    });
  }

  for (const cleaner of ["A", "B", "both"] as const) test(`changed first character gives different adjacent ids; ${cleaner} cleans and removes the unheld shot: ${order}`, () => {
    const set = writtenCell("B-roll: Close up"), a = copy(set.a, "Alice"), b = copy(set.b, "Bob");
    try {
      a.leave();
      sendAs(set.b, { kind: "text-delete", id: "first-gone", by: "Bob", target: TARGET, observed: [flowBaseReference("R1", "visualText", 0, 1)] });
      insertAt(set.b, 0, "B", "first-back");
      b.leave(); deliverAll(set.queue, order);
      const before = agreedShots(set);
      assert.equal(before.length, 2);
      const keys = explode(scriptCellOf(String(visual(set, "different ids", order)))).flatMap(unit => unit.atom?.atom === "broll" ? [unit.atom.id] : []);
      assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
      const firstKey = keys[0]; assert.ok(firstKey);
      if (cleaner !== "B") assert.deepEqual(a.leave(), ["applied"]);
      if (cleaner !== "A") assert.deepEqual(b.leave(), ["applied"]);
      deliverAll(set.queue, order);
      assert.equal(visual(set, "different ids cleaned", order), KEY(firstKey) + " Close up");
      assert.deepEqual(agreedShots(set), before.filter(shot => shot.id === keys[0]));
      assert.deepEqual([a.owner.sizes(), b.owner.sizes()], [{ undo: 1, redo: 0, dropped: 0 }, { undo: 1, redo: 0, dropped: 0 }]);
    } finally { a.session.dispose(); b.session.dispose(); set.close(); }
  });

  test(`nameless marker waits for a name; an existing named key without a record is repaired by the leaving copy: ${order}`, () => {
    for (const keyed of [false, true]) {
      const set = writtenCell(keyed ? KEY("bs_missing") + " Close up" : "B-roll: "), a = copy(set.a, "Alice");
      try {
        if (!keyed) {
          assert.deepEqual(a.leave(), []); assert.equal(set.queue.pending.length, 0); agreedShots(set);
          insertAt(set.b, 8, "Close up"); deliverAll(set.queue, order);
        }
        assert.deepEqual(a.leave(), ["applied"]); deliverAll(set.queue, order);
        const id = keyed ? "bs_missing" : lineKeyOf(set.a);
        assert.equal(visual(set, "named record", order), KEY(id) + " Close up");
        assert.deepEqual(agreedShots(set), [{ id, name: "Close up", ...SEED }]);
        assert.equal(a.harness.executed.at(-1)?.operations.find(operation => operation.kind === "record-create")?.by, "Alice");
      } finally { a.session.dispose(); set.close(); }
    }
  });

  test(`leaving never revives a removed shot: ${order}`, () => {
    const set = findReplicas(source(KEY("S1") + " Mug")), a = copy(set.a, "Alice");
    try {
      sendAs(set.b, { kind: "record-delete", id: "shot-gone", by: "Bob", target: { collection: "shots", record: "S1" } });
      deliverAll(set.queue, order);
      const revision = readSharedRevision(set.a);
      assert.deepEqual(a.leave(), []); assert.equal(readSharedRevision(set.a), revision);
      assert.equal(visual(set, "removed shot stays removed", order), KEY("S1") + " Mug"); agreedShots(set);
      assert.equal(projectSharedDocumentWithRecovery(set.a).document.brollShots.length, 0);
    } finally { a.session.dispose(); set.close(); }
  });

  for (const edit of ["concurrent-key", "append", "delete-name", "other-line", "same-value-replacement", "shot-panel", "missing-shot"] as const) test(`undo checks the whole keyed line and peer contributions: ${edit}: ${order}`, () => {
    const set = writtenCell((edit === "missing-shot" ? KEY("bs_missing") : "B-roll:") + " Close up<br>Wide"), a = copy(set.a, "Alice"), b = copy(set.b, "Bob");
    try {
      a.leave();
      if (edit === "concurrent-key") b.leave();
      else {
        deliverAll(set.queue, order);
        if (edit === "shot-panel") sendAs(set.b, { kind: "record-set", id: "panel", by: "Bob", target: { collection: "shots", record: lineKeyOf(set.b) }, field: "notes", value: "handheld" });
        else if (edit === "delete-name" || edit === "same-value-replacement") {
          const history = readSharedTextHistory(set.b, TARGET); assert.ok(history);
          const character = history.units[2]; assert.ok(character);
          sendAs(set.b, { kind: "text-delete", id: "cut-name", by: "Bob", target: TARGET, observed: [character.identity] });
          if (edit === "same-value-replacement") insertAt(set.b, 2, "C");
        } else insertAt(set.b, edit === "other-line" ? 15 : 10, " shot");
      }
      deliverAll(set.queue, order); agreedShots(set);
      if (edit === "other-line") {
        const undone = a.owner.undo(); assert.ok(undone.ok); assert.equal(undone.effective, true); deliverAll(set.queue, order);
        assert.equal(visual(set, "other line survives undo", order), "B-roll: Close up<br>Wide shot");
        assert.deepEqual(agreedShots(set), []);
      } else usedUp(a, set);
    } finally { a.session.dispose(); b.session.dispose(); set.close(); }
  });

  test(`two real lines with equal text keep both keys and shots: ${order}`, () => {
    const set = writtenCell("B-roll: Close up<br>B-roll: Close up"), a = copy(set.a, "Alice");
    try {
      a.leave(); deliverAll(set.queue, order);
      const made = agreedShots(set); assert.equal(made.length, 2);
      assert.notEqual(made[0]?.id, made[1]?.id);
      const before = visual(set, "real lines keyed", order);
      assert.deepEqual(a.leave(), []); deliverAll(set.queue, order);
      assert.equal(visual(set, "real lines kept", order), before); assert.deepEqual(agreedShots(set), made);
    } finally { a.session.dispose(); set.close(); }
  });

  for (const edit of ["append", "delete"] as const) test(`undoing one's own later ${edit} keeps keying undo usable: ${order}`, () => {
    const set = writtenCell("B-roll: Close up"), a = copy(set.a, "Alice");
    try {
      a.leave(); deliverAll(set.queue, order);
      const history = readSharedTextHistory(set.a, TARGET); assert.ok(history);
      const last = history.units.at(-1), character = history.units[2]; assert.ok(last && character);
      const local = edit === "append" ? { kind: "text-insert", id: "local-append", by: "Alice", target: TARGET,
        at: { left: last.identity, right: null, affinity: "after" }, content: [{ value: " shot", marks: [] }] }
        : { kind: "text-delete", id: "local-delete", by: "Alice", target: TARGET, observed: [character.identity] };
      assert.equal(a.session.run(sharedCommand("local-line-edit", [operation(local)])).kind, "applied");
      const editedUndo = a.owner.undo(); assert.ok(editedUndo.ok); assert.equal(editedUndo.effective, true);
      deliverAll(set.queue, order); agreedShots(set);
      const keyingUndo = a.owner.undo(); assert.ok(keyingUndo.ok); assert.equal(keyingUndo.effective, true);
      deliverAll(set.queue, order);
      assert.equal(visual(set, "local edits undone", order), "B-roll: Close up"); assert.deepEqual(agreedShots(set), []);
    } finally { a.session.dispose(); set.close(); }
  });

  test(`cleanup preserves an unseen edit to the removed shot in recovery: ${order}`, () => {
    const set = writtenCell(KEY("S1") + KEY("bs_later") + " Mug"), a = copy(set.a, "Alice");
    try {
      sendAs(set.a, { kind: "record-create", id: "later-shot", by: "Alice", target: { collection: "shots", record: "bs_later" }, fields: { name: "Mug", ...SEED } });
      deliverAll(set.queue, order);
      a.leave();
      sendAs(set.b, { kind: "record-set", id: "unseen-notes", by: "Bob", target: { collection: "shots", record: "bs_later" }, field: "notes", value: "keep this edit" });
      deliverAll(set.queue, order);
      assert.equal(visual(set, "cleaned with unseen shot edit", order), KEY("S1") + " Mug");
      assert.deepEqual(agreedShots(set), []);
      const recovered = projectSharedDocumentWithRecovery(set.a).recovery;
      assert.match(JSON.stringify(recovered), /keep this edit/);
    } finally { a.session.dispose(); set.close(); }
  });

  for (const concurrent of [false, true]) test(`row removal ${concurrent ? "concurrent with keying" : "after seeing keying"} keeps the shot for recovery: ${order}`, () => {
    const set = writtenCell("B-roll: Close up"), a = copy(set.a, "Alice"), b = copy(set.b, "Bob");
    try {
      a.leave();
      if (!concurrent) deliverAll(set.queue, order);
      const ports = sharedStructurePorts({ handle: () => set.b, author: b.ports.author, stamps: bufferStamps("Bob", () => AT), cells: scriptCellOf })();
      assert.ok(ports);
      assert.equal(b.session.run(deleteBeatCommand("R1", ports)).kind, "applied");
      const removal = b.harness.executed.at(-1)?.operations.find(operation => operation.kind === "remove"); assert.ok(removal);
      deliverAll(set.queue, order);
      const kept = agreedShots(set); assert.equal(kept.length, 1);
      const keptShot = kept[0]; assert.ok(keptShot);
      assert.equal(projectSharedDocumentWithRecovery(set.a).document.rows.some(row => row.id === "R1"), false);
      sendAs(set.b, { kind: "restore", id: "row-back", by: "Bob", removals: [sharedStructureKey("2", removal.id, "removal", 0)] });
      deliverAll(set.queue, order);
      assert.equal(visual(set, "restored row", order), KEY(keptShot.id) + " Close up");
      assert.deepEqual(agreedShots(set), kept);
    } finally { a.session.dispose(); b.session.dispose(); set.close(); }
  });
}

for (const reason of ["read-only", "stale-base"]) test(`refused cleanup stops the leave before keying, with one notice: ${reason}`, () => {
  const set = writtenCell(KEY("S1") + KEY("bs_repeat") + " Mug<br>B-roll: Close up"), a = copy(set.a, "Alice");
  try {
    a.harness.deny(reason);
    assert.deepEqual(a.leave(), ["rejected"]);
    assert.equal(a.notices.shown.length, 1);
    assert.equal(set.queue.pending.length, 0);
    assert.deepEqual(a.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
    agreedShots(set);
  } finally { a.session.dispose(); set.close(); }
});

test("failed cleanup stops the leave before a second command is attempted", () => {
  const set = writtenCell(KEY("S1") + KEY("bs_repeat") + " Mug<br>B-roll: Close up"), a = copy(set.a, "Alice");
  try {
    const names: string[] = [], error = new Error("cleanup failed");
    const outcomes = keySharedLeftCell({ read: a.session.read, run: command => { names.push(command.name); return { kind: "failed", error }; } }, "R1", a.ports);
    assert.deepEqual(names, ["drop-repeated-broll-keys"]);
    assert.deepEqual(outcomes, [{ kind: "failed", error }]);
    assert.equal(set.queue.pending.length, 0); agreedShots(set);
  } finally { a.session.dispose(); set.close(); }
});
