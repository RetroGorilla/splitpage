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
import { readSharedRevision } from "../../src/adapters/collab/document.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { projectSharedDocumentWithRecovery } from "../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { flowBaseReference } from "../../src/core/collab/base-reference.ts";
import { adapterReplica, sharedHarness } from "../application/session/shared-session-support.ts";
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
  return { owner, session: harness.session, notices, leave: (rowId = "R1") => keySharedLeftCell(harness.session, rowId, ports).map(outcome => outcome.kind) };
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
      assert.equal(kept.owner.undo().ok, true);
      deliverAll(set.queue, order);
      assert.equal(visual(set, "kept undone", order), "B-roll: Close up");
      assert.deepEqual(agreedShots(set), []);
      assert.deepEqual(dropped.leave(), ["applied"]);
      deliverAll(set.queue, order);
      assert.equal(visual(set, "keyed again", order), KEY(id) + " Close up");
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
    assert.deepEqual({ keyed, undone }, { keyed: 649, undone: 2537 });
  } finally { a.session.dispose(); set.close(); }
});
