import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { HocuspocusProvider, HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { readSyncMessage, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { NativeScriptReader } from "../../../../src/adapters/collab/native/reader.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeSessionChange, NativeSessionSource } from "../../../../src/adapters/collab/native/session.ts";
import { createRichText } from "../../../../src/adapters/richtext/richtext.ts";
import { scenesInOrder } from "../../../../src/core/document/scenes.ts";
import { arrangePackets, cells } from "./helpers.ts";
import { AT, beatField, commentInput, replyInput } from "./record-harness.ts";
import { structureScript } from "./structure-harness.ts";

type Session = ReturnType<typeof openNativeSession>;

const conversion = { cells, creation: "seed", at: AT, by: "Alice" };
const ids = { id: (prefix: string) => prefix + "-test", docId: () => "test" };
const images = { known: () => null, fromDataUrl: () => null };
const status = beatField("A", "status");
const WRITTEN = { kind: "written" };
const UNCHANGED = { kind: "unchanged" };
const narration = { beat: "A", cell: "narration" } as const;
const visual = { ...narration, cell: "visual" } as const;

function open(source: NativeSessionSource, actor = "Alice", Parser = DOMParser): Session {
  const { sanitize } = createRichText({ DOMParser: Parser, images, ids });
  return openNativeSession(source, { actor, sanitize });
}

function fromDocument(rows: Record<string, string> = { A: "a", B: "b", C: "c" }, Parser = DOMParser): Session {
  return open({ kind: "document", document: structureScript(rows), conversion }, "Alice", Parser);
}

function anchor(session: Session, from: number, to = from, target: Parameters<Session["commands"]["anchorText"]>[0] = narration) {
  const result = session.commands.anchorText(target, from, to);
  assert(result.kind === "anchored", JSON.stringify(result));
  return result.range;
}

function type(session: Session, at: number, text: string, target: Parameters<typeof anchor>[3] = narration): void {
  assert.deepEqual(session.commands.typeText(anchor(session, at, at, target), text, {}), WRITTEN);
}

function unchanged(session: Session, run: () => unknown, expected: unknown): void {
  const before = session.encodeState();
  assert.deepEqual(run(), expected);
  assert.deepEqual(session.encodeState(), before);
}

function written(result: { kind: string }): void {
  assert.equal(result.kind, "written");
}

function closedState(changes: NativeSessionChange[], reason: "requested" | "failed"): Uint8Array {
  const final = changes.at(-1);
  assert(final?.kind === "closed");
  assert.equal(final.reason, reason);
  assert.equal(changes.filter(change => change.kind === "closed").length, 1);
  return final.state;
}

function captureMicrotasks(t: TestContext): VoidFunction[] {
  const tasks: VoidFunction[] = [];
  t.mock.method(globalThis, "queueMicrotask", (task: VoidFunction) => { tasks.push(task); });
  return tasks;
}

test("checking healthy peer delivery schedules no session work", t => {
  const session = fromDocument();
  t.after(session.close);
  const enqueue = t.mock.method(globalThis, "queueMicrotask");
  assert.equal(session.checkPeerDelivery(), true);
  assert.equal(enqueue.mock.callCount(), 0);
});

test("finalizing a Markdown heading publishes once and replays its before and after selections", t => {
  const session = fromDocument({ A: "# Scene", B: "Body" });
  t.after(session.close);
  const updates = t.mock.fn();
  session.ydoc.on("update", updates);
  const step = session.commands.finalizeHeading.withSelection(anchor(session, 7), "A", 7, true);
  assert.equal(step.result.kind, "written");
  const body = { beat: "B", cell: "narration" } as const;
  step.recordAfter(anchor(session, 0, 0, body));
  assert.equal(updates.mock.callCount(), 1);
  assert.deepEqual(session.document().rows.map(row => [row.id, row.audioText]), [["B", "Body"]]);
  assert.deepEqual(scenesInOrder(session.document())?.map(scene => [scene.name, scene.firstSceneId]), [["Scene", "B"]]);
  const undo = session.commands.undo();
  assert.equal(undo.kind, "written");
  assert.deepEqual(undo.selection?.head, { target: narration, offset: 7 });
  assert.deepEqual(session.document().rows.map(row => [row.id, row.audioText]), [["A", "# Scene"], ["B", "Body"]]);
  assert.equal(session.commands.undo().kind, "unchanged");
  const redo = session.commands.redo();
  assert.equal(redo.kind, "written");
  assert.deepEqual(redo.selection?.head, { target: body, offset: 0 });
  assert.deepEqual(session.document().rows.map(row => [row.id, row.audioText]), [["B", "Body"]]);
});

for (const tail of ["", "Body"]) test("two peers finalizing the same Markdown heading converge with " + (tail ? "a tail" : "a new blank beat"), t => {
  const a = fromDocument({ A: "# Scene" + tail });
  const b = open({ kind: "state", state: a.encodeState() }, "Other writer");
  t.after(a.close);
  t.after(b.close);
  const base = Y.encodeStateVector(a.ydoc);
  for (const copy of [a, b]) assert.equal(copy.commands.finalizeHeading("A", 7, true).kind, "written");
  const fromA = Y.encodeStateAsUpdate(a.ydoc, base), fromB = Y.encodeStateAsUpdate(b.ydoc, base);
  Y.applyUpdate(a.ydoc, fromB);
  Y.applyUpdate(b.ydoc, fromA);
  assert.deepEqual(a.encodeState(), b.encodeState());
  assert.deepEqual(a.document(), b.document());
  assert.deepEqual(scenesInOrder(a.document())?.map(scene => scene.name), ["Scene"]);
  const rows = a.document().rows;
  if (tail) assert.deepEqual(rows.map(row => [row.id, row.audioText]), [["A", tail]]);
  else {
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.id !== "A" && row.audioText === ""));
  }
});

for (const [name, insertion, title, narrationAfter] of [
  ["different title cutoffs", "", "SceneBody", ""],
  ["an unseen insertion in one title", "PEER", "ScePEERne", "Body"]
] as const) {
  test("competing Markdown conversions converge with one visible title and one stored title after " + name, t => {
    const seed = fromDocument({ A: "# SceneBody" });
    t.after(seed.close);
    const vector = Y.encodeStateVector(seed.ydoc);
    const usedIds = Y.decodeStateVector(vector);
    const [left, right] = [1, 2, 3].filter(id => !usedIds.has(id));
    assert.ok(left && right);
    const state = { kind: "state", state: seed.encodeState() } as const;
    for (const [first, second] of [[left, right], [right, left]]) {
      assert.ok(first && second);
      const a = open(state), b = open(state);
      t.after(a.close);
      t.after(b.close);
      a.ydoc.clientID = first;
      b.ydoc.clientID = second;
      if (insertion) type(b, 5, insertion);
      assert.equal(a.commands.finalizeHeading("A", 7, true).kind, "written");
      assert.equal(b.commands.finalizeHeading("A", 11, true).kind, "written");
      const fromA = Y.encodeStateAsUpdate(a.ydoc, vector), fromB = Y.encodeStateAsUpdate(b.ydoc, vector);
      Y.applyUpdate(a.ydoc, fromB);
      Y.applyUpdate(b.ydoc, fromA);
      const expectedVisible = first < second ? title : "Scene";
      const expectedHidden = first < second ? "Scene" : title;
      const inspect = (copy: Session) => {
        const doc = copy.document(), scenes = scenesInOrder(doc);
        const stored = [...copy.ydoc.getMap<Y.Text>("names")];
        assert.deepEqual(scenes?.map(scene => scene.name), [expectedVisible]);
        assert.deepEqual(doc.rows.map(row => row.audioText ?? ""), [narrationAfter]);
        assert.deepEqual(stored.filter(([id]) => id !== scenes?.[0]?.id).map(([, name]) => name.toString()), [expectedHidden]);
        return { doc, stored: stored.map(([id, name]) => [id, name.toString()]).sort() };
      };
      const expected = inspect(a);
      assert.deepEqual(inspect(b), expected);
      for (const order of [[fromA, fromB], [fromB, fromA]]) {
        const copy = open(state);
        t.after(copy.close);
        for (const update of order) Y.applyUpdate(copy.ydoc, update);
        assert.deepEqual(inspect(copy), expected);
      }
    }
  });
}

test("a relative narration caret resolves in its visible joined row after a peer edit", t => {
  const author = fromDocument({ A: "ab", B: "cd", C: "ef" });
  t.after(author.close);
  written(author.commands.joinRow("B", "A", " "));
  const peer = open({ kind: "state", state: author.encodeState() });
  t.after(peer.close);
  const lower = { beat: "B", cell: "narration" } as const;
  assert.deepEqual(author.narrationCaret("A", 4), { beat: "B", offset: 1 });
  const start = anchor(author, 1, 1, lower);
  type(peer, 0, "Y");
  Y.applyUpdate(author.ydoc, peer.encodeState(), "peer");
  written(author.commands.typeText(start, "X", {}));
  assert.equal(author.narrationHtml("A"), "Yab cXd");
  assert.equal(author.narrationOffset("A", start), 6);
  assert.equal(author.narrationOffset("B", start), null);
});

test("the narration resolver refuses other Yjs associations", t => {
  const session = fromDocument();
  t.after(session.close);
  const point = anchor(session, 0).from;
  assert.equal(session.narrationOffset("A", { from: { ...point, assoc: 1 } }, 1 as 0), null);
});

test("placement ignores fractional indices and clamps an oversized index to the end of the inserted text", t => {
  const session = fromDocument({ A: "Hello", B: "b", C: "c" });
  t.after(session.close);
  const result = session.commands.typeText(anchor(session, 2), "xy", {}, undefined, [0.5, 20]);
  assert.equal(session.narrationHtml("A"), "Hexyllo");
  assert.ok(result.kind === "written" && result.selection);
  assert.equal(result.selection[0], null);
  const end = result.selection[1];
  assert.ok(end);
  assert.equal(session.narrationOffset("A", { from: end }, -1), 4);
});

test("a failed paint capture does not interrupt a transaction and is reported before the next command", t => {
  const session = fromDocument(), target = anchor(session, 0), error = new Error("capture failed");
  t.after(session.close);
  const keep = session.trackNarrationPaint("A");
  const next = session.trackNarrationPaint("B");
  t.after(() => { keep.dispose(); next.dispose(); });
  const readPaint = NativeScriptReader.prototype.narrationPaint;
  const capture = t.mock.method(NativeScriptReader.prototype, "narrationPaint", function (this: NativeScriptReader, row: string, retain: boolean) {
    if (row === "A") throw error;
    return readPaint.call(this, row, retain);
  });
  const map = session.ydoc.getMap("capture-test");
  assert.doesNotThrow(() => { map.set("peer", "written"); });
  assert.equal(map.get("peer"), "written");
  assert.deepEqual(capture.mock.calls.map(call => call.arguments), [["A", true], ["B", true]]);
  keep.dispose();
  next.dispose();
  assert.throws(() => session.commands.typeText(target, "x", {}), error);
  assert.equal(session.narrationHtml("A"), "a");
  type(session, 0, "x");
  assert.equal(session.narrationHtml("A"), "xa");
});

test("the guarded narration resolver refuses a root-named caller position without creating a root", t => {
  const session = fromDocument(), caret = anchor(session, 0), bytes = session.encodeState();
  t.after(session.close);
  const reads = t.mock.fn(() => {
    assert.deepEqual(session.commands.typeText(caret, "x", {}), {
      kind: "recovery", reason: "busy", runs: [{ text: "x", marks: {} }]
    });
    return { item: null, type: null, tname: "unexpected-caret-root", assoc: 0 };
  });
  const roots = [...session.ydoc.share.keys()];
  assert.equal(session.narrationOffset("A", { get from() { return reads(); } }), null);
  assert.equal(reads.mock.callCount(), 1);
  assert.deepEqual([...session.ydoc.share.keys()], roots);
  assert.deepEqual(session.encodeState(), bytes);
  const release = session.holdIngress();
  try {
    assert.equal(session.narrationOffset("A", { get from() { return reads(); } }), null);
    assert.equal(reads.mock.callCount(), 1);
  } finally { release(); }
});

test("empty, converted and encoded opens use a fresh undo binding", t => {
  const empty = open({ kind: "empty" }), author = fromDocument();
  t.after(() => { empty.close(); author.close(); });
  assert.deepEqual(empty.document().rows, []);
  unchanged(empty, empty.commands.undo, UNCHANGED);
  assert.deepEqual(author.document().rows.map(row => row.audioText), ["a", "b", "c"]);
  unchanged(author, author.commands.undo, UNCHANGED);
  type(author, 0, "x");
  const stored = author.encodeState();
  const reopened = open({ kind: "state", state: stored });
  t.after(reopened.close);
  assert.deepEqual(reopened.document(), author.document());
  assert.deepEqual(reopened.encodeState(), stored);
  unchanged(reopened, reopened.commands.undo, UNCHANGED);
  unchanged(reopened, reopened.commands.redo, UNCHANGED);
  type(reopened, 0, "y");
  written(reopened.commands.undo());
  assert.deepEqual(reopened.document(), author.document());
});

test("a failed open destroys its partial document", t => {
  const destroy = t.mock.method(Y.Doc.prototype, "destroy");
  assert.throws(() => open({ kind: "state", state: new Uint8Array([1]) }));
  assert.equal(destroy.mock.callCount(), 1);
});

for (const boundary of ["typing", "undo", "redo", "refusal", "throw"] as const) {
  test(`stock peer delivery after ${boundary} stays out of local undo and converges`, t => {
    const a = fromDocument(), b = open({ kind: "state", state: a.encodeState() });
    t.after(() => { a.close(); b.close(); });
    if (boundary === "throw") {
      const failure = new Error("observer failure after write");
      const at = anchor(a, 0);
      a.ydoc.once("afterTransaction", () => { throw failure; });
      assert.throws(() => a.commands.typeText(at, "local ", {}), failure);
    } else type(a, 0, "local ");
    if (boundary === "undo" || boundary === "redo") written(a.commands.undo());
    if (boundary === "redo") written(a.commands.redo());
    if (boundary === "refusal") unchanged(a, () => a.commands.setField(status, "invalid"), { kind: "refused", reason: "value" });

    Y.applyUpdate(b.ydoc, a.encodeState(), "peer");
    type(b, 0, "peer ", visual);
    Y.applyUpdate(a.ydoc, b.encodeState(), "peer");
    assert.deepEqual(a.document(), b.document());
    assert.equal(a.document().rows[0]?.audioText, boundary === "undo" ? "a" : "local a");
    assert.equal(a.document().rows[0]?.visualText, "peer ");
    if (boundary === "undo") written(a.commands.redo());
    written(a.commands.undo());
    unchanged(a, a.commands.undo, UNCHANGED);
    Y.applyUpdate(b.ydoc, a.encodeState(), "peer");
    assert.deepEqual(a.document(), b.document());
    assert.equal(a.document().rows[0]?.audioText, "a");
    assert.equal(a.document().rows[0]?.visualText, "peer ");
  });
}

test("stock delivery changes the plain Y.Doc and subscribers run safely after transactions", async t => {
  const a = fromDocument(), b = open({ kind: "empty" });
  t.after(() => { a.close(); b.close(); });
  const broken = b.subscribe(() => { throw new Error("subscriber"); });
  const received: string[] = [];
  const stop = b.subscribe(change => {
    received.push(change.kind + ":" + b.document().rows[0]?.audioText);
  });
  Y.applyUpdate(b.ydoc, a.encodeState(), { provider: true });
  assert.deepEqual(received, []);
  await Promise.resolve();
  assert.deepEqual(received, ["changed:a"]);
  unchanged(b, b.commands.undo, UNCHANGED);
  const schedule = t.mock.method(globalThis, "queueMicrotask");
  type(b, 0, "z");
  type(b, 1, "z");
  assert.equal(schedule.mock.callCount(), 1);
  await Promise.resolve();
  assert.deepEqual(received, ["changed:a", "changed:zza"]);
  stop();
  broken();
  type(b, 1, "z");
  await Promise.resolve();
  assert.deepEqual(received, ["changed:a", "changed:zza"]);
});

test("session admission waits out a raw Yjs transaction without replacing its document", async t => {
  const a = fromDocument();
  t.after(a.close);
  const doc = a.ydoc, at = anchor(a, 0);
  doc.transact(() => {
    assert.deepEqual(a.commands.undo(), { kind: "refused", reason: "busy" });
    assert.deepEqual(a.commands.typeText(at, "nested", {}), {
      kind: "recovery", reason: "busy", runs: [{ text: "nested", marks: {} }]
    });
    assert.equal(a.ydoc, doc);
  });
  await Promise.resolve();
  assert.equal(a.ydoc, doc);
  assert.equal(a.document().rows[0]?.audioText, "a");
  written(a.commands.typeText(at, "local ", {}));
});

test("reentry during argument copying is refused before a nested command can write", t => {
  const session = fromDocument();
  t.after(session.close);
  const before = session.encodeState();
  const tasks = captureMicrotasks(t);
  const value = { get nested() {
    unchanged(session, () => session.commands.setField(status, "ready"), { kind: "refused", reason: "busy" });
    unchanged(session, session.commands.undo, { kind: "refused", reason: "busy" });
    assert.equal(tasks.length, 0);
    return "value";
  } };
  written(session.commands.setField(beatField("A", "field"), value));
  assert.notDeepEqual(session.encodeState(), before);
  assert.equal(session.document().rows[0]?.audioText, "a");
  assert.equal(session.document().rows[0]?.status, "todo");
  assert.deepEqual(session.document().rows[0]?.field, { nested: "value" });
  assert.equal(tasks.length, 1);
  tasks.shift()?.();
  assert.equal(tasks.length, 0);
  session.close();
  tasks.shift()?.();
  assert.equal(tasks.length, 0);
});

test("a command interrupted before update closes as failed with the committed write and preserves the original error", async t => {
  const destroyUndo = t.mock.method(Y.UndoManager.prototype, "destroy");
  const closeReader = t.mock.method(NativeScriptReader.prototype, "close");
  const session = fromDocument(), changes: NativeSessionChange[] = [];
  t.after(session.close);
  const doc = session.ydoc;
  session.subscribe(change => changes.push(change));
  const peer = open({ kind: "state", state: session.encodeState() });
  t.after(peer.close);
  type(session, 0, "x");
  type(peer, 0, "p", visual);
  Y.applyUpdate(doc, peer.encodeState(), "peer");
  await Promise.resolve();
  changes.length = 0;
  const at = anchor(session, 1);
  const failure = new Error("interrupted cleanup");
  doc.once("afterTransactionCleanup", () => { throw failure; });
  doc.once("destroy", () => { throw new Error("destroy listener"); });
  assert.throws(() => session.commands.typeText(at, "y", {}), failure);
  assert.equal(session.document().rows[0]?.audioText, "xya");
  assert.equal(session.ydoc, doc);
  unchanged(session, session.commands.undo, { kind: "refused", reason: "closed" });
  assert.equal(changes.length, 0);
  await Promise.resolve();
  assert.equal(destroyUndo.mock.callCount(), 1);
  assert.equal(closeReader.mock.callCount(), 1);
  assert.equal(doc.isDestroyed, true);
  assert.deepEqual(changes.map(change => change.kind), ["closed"]);
  const reopened = open({ kind: "state", state: closedState(changes, "failed") });
  t.after(reopened.close);
  assert.equal(reopened.document().rows[0]?.audioText, "xya");
  assert.equal(reopened.document().rows[0]?.visualText, "p");
  unchanged(reopened, reopened.commands.undo, UNCHANGED);
  session.close();
  await Promise.resolve();
  assert.equal(changes.length, 1);
  assert.throws(session.document, /closed/);
});

test("stock Yjs stops emitting updates on the same document after an update listener throws", t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const text = doc.getText("script"), failure = new Error("interrupted cleanup");
  doc.once("update", () => { throw failure; });
  assert.throws(() => text.insert(0, "a"), failure);
  const updates: Uint8Array[] = [];
  doc.on("update", update => { updates.push(update); });
  text.insert(1, "b");
  assert.equal(text.toString(), "ab");
  assert.deepEqual(updates, []);
});

test("failed close lets the caller open a new session and provider; server resync delivers a late frame", async t => {
  const session = fromDocument(), peer = open({ kind: "state", state: session.encodeState() });
  const socket = new HocuspocusProviderWebsocket({ url: "ws://unused.invalid", autoConnect: false });
  const outgoing: Uint8Array[] = [];
  function attach(document: Y.Doc) {
    const provider = new HocuspocusProvider({
      websocketProvider: socket, document, name: "script", awareness: null,
      onOutgoingMessage: ({ message }) => { outgoing.push(message.toUint8Array()); }
    });
    provider.attach();
    return provider;
  }
  const old = session.ydoc;
  const oldProvider = attach(old);
  let provider = oldProvider;
  t.after(() => { provider.destroy(); socket.destroy(); session.close(); peer.close(); });
  const changes: NativeSessionChange[] = [];
  session.subscribe(change => changes.push(change));

  const at = anchor(session, 0), failure = new Error("interrupted cleanup");
  old.once("afterTransactionCleanup", () => { throw failure; });
  assert.throws(() => session.commands.typeText(at, "x", {}), failure);
  await Promise.resolve();
  oldProvider.destroy();
  const reopened = open({ kind: "state", state: closedState(changes, "failed") });
  t.after(reopened.close);
  provider = attach(reopened.ydoc);
  assert.notEqual(provider.document, old);
  assert.equal(session.ydoc, old);
  assert.equal(reopened.document().rows[0]?.audioText, "xa");
  outgoing.length = 0;

  Y.applyUpdate(peer.ydoc, reopened.encodeState(), "peer");
  type(peer, 0, "p", visual);
  const frame = createEncoder();
  writeVarString(frame, "script");
  writeVarUint(frame, MessageType.Sync);
  writeUpdate(frame, peer.encodeState());
  const delayed = new MessageEvent("message", { data: toUint8Array(frame) });
  const prior = reopened.encodeState();
  const priorOld = session.encodeState();
  oldProvider.onMessage(delayed);
  assert.notDeepEqual(session.encodeState(), priorOld);
  assert.deepEqual(reopened.encodeState(), prior);
  assert.equal(reopened.document().rows[0]?.visualText, "");
  const serverResync = new MessageEvent("message", { data: toUint8Array(frame) });
  provider.onMessage(serverResync);
  assert.deepEqual(reopened.document(), peer.document());
  assert.equal(reopened.document().rows[0]?.visualText, "p");
  assert.deepEqual(outgoing, []);
  unchanged(reopened, reopened.commands.undo, UNCHANGED);

  type(reopened, 1, "y");
  assert.equal(outgoing.length, 1);
  assert.equal(provider.hasUnsyncedChanges, true);
  assert(outgoing[0]);
  const sent = createDecoder(outgoing[0]);
  assert.equal(readVarString(sent), "script");
  assert.equal(readVarUint(sent), MessageType.Sync);
  readSyncMessage(sent, createEncoder(), peer.ydoc, "provider");
  assert.deepEqual(peer.document(), reopened.document());
});

for (const boundary of ["bound command", "undo", "redo", "requested close"] as const) {
  test(`a busy script closes as failed at a ${boundary} when the raw write emitted no update`, async t => {
    const session = fromDocument(), doc = session.ydoc, changes: NativeSessionChange[] = [];
    const peer = open({ kind: "state", state: session.encodeState() });
    t.after(() => { session.close(); peer.close(); });
    session.subscribe(change => changes.push(change));
    type(session, 0, "x");
    Y.applyUpdate(peer.ydoc, session.encodeState(), "peer");
    type(peer, 0, "p", visual);
    Y.applyUpdate(doc, peer.encodeState(), "peer");
    await Promise.resolve();
    changes.length = 0;
    type(peer, 1, "q", visual);
    const failure = new Error("interrupted cleanup");
    doc.once("afterTransactionCleanup", () => {
      if (boundary === "requested close") session.close();
      throw failure;
    });
    assert.throws(() => Y.applyUpdate(doc, peer.encodeState(), "peer"), failure);
    if (boundary !== "requested close") {
      const run = boundary === "bound command" ? () => session.commands.anchorText(narration, 0) : session.commands[boundary];
      unchanged(session, run, { kind: "refused", reason: "busy" });
    }
    assert.equal(session.ydoc, doc);
    assert.equal(changes.length, 0);
    await Promise.resolve();
    assert.deepEqual(changes.map(change => change.kind), ["closed"]);
    const reopened = open({ kind: "state", state: closedState(changes, "failed") });
    t.after(reopened.close);
    assert.deepEqual(reopened.document(), peer.document());
    assert.equal(reopened.document().rows[0]?.audioText, "xa");
    assert.equal(reopened.document().rows[0]?.visualText, "pq");
    unchanged(session, session.commands.redo, { kind: "refused", reason: "closed" });
  });
}

test("an undo listener throw with completed cleanup preserves command admission", t => {
  const session = fromDocument();
  t.after(session.close);
  const doc = session.ydoc, failure = new Error("completed cleanup");
  type(session, 0, "x");
  doc.once("afterTransaction", () => { throw failure; });
  assert.throws(session.commands.undo, failure);
  assert.equal(session.ydoc, doc);
  assert.equal(session.document().rows[0]?.audioText, "a");
  unchanged(session, session.commands.redo, UNCHANGED);
  type(session, 0, "z");
  assert.equal(session.document().rows[0]?.audioText, "za");
});

test("a close requested in a raw transaction waits for it to finish", async t => {
  const session = fromDocument(), doc = session.ydoc;
  t.after(session.close);
  const destroy = t.mock.method(doc, "destroy");
  const changes: NativeSessionChange[] = [];
  session.subscribe(change => changes.push(change));
  doc.transact(() => {
    session.close();
    assert.equal(destroy.mock.callCount(), 0);
  });
  assert.equal(destroy.mock.callCount(), 0);
  assert.deepEqual(changes, []);
  await Promise.resolve();
  assert.equal(destroy.mock.callCount(), 1);
  assert.equal(session.ydoc, doc);
  assert.deepEqual(closedState(changes, "requested"), session.encodeState());
});

test("a close during argument copying waits for the command to finish", async t => {
  const session = fromDocument(), doc = session.ydoc;
  t.after(session.close);
  const destroy = t.mock.method(doc, "destroy");
  written(session.commands.setField(beatField("A", "field"), { get nested() {
    session.close();
    assert.equal(destroy.mock.callCount(), 0);
    return "value";
  } }));
  await Promise.resolve();
  assert.equal(destroy.mock.callCount(), 1);
  const reopened = open({ kind: "state", state: session.encodeState() });
  t.after(reopened.close);
  assert.deepEqual(reopened.document().rows[0]?.field, { nested: "value" });
});

test("close during a command delivers the committed document before retiring undo and reporting closed", async t => {
  const destroyUndo = t.mock.method(Y.UndoManager.prototype, "destroy");
  const session = fromDocument(), doc = session.ydoc;
  t.after(session.close);
  const destroyDoc = t.mock.method(doc, "destroy", function (this: Y.Doc) {
    assert.equal(destroyUndo.mock.callCount(), 1);
    return Y.Doc.prototype.destroy.call(this);
  });
  const changes: string[] = [];
  const closed: NativeSessionChange[] = [];
  session.subscribe(change => {
    changes.push(change.kind === "changed" ? `changed:${session.document().rows[0]?.audioText}` : change.kind);
  });
  session.subscribe(change => closed.push(change));
  doc.once("destroy", () => { throw new Error("destroy listener"); });
  const update = anchor(session, 0);
  doc.once("beforeTransaction", () => {
    session.close();
    assert.equal(destroyDoc.mock.callCount(), 0);
    assert.equal(destroyUndo.mock.callCount(), 0);
    assert.equal(session.document().rows[0]?.audioText, "a");
  });
  written(session.commands.typeText(update, "x", {}));
  unchanged(session, session.commands.undo, { kind: "refused", reason: "closed" });
  unchanged(session, () => session.commands.typeText(update, "z", {}), {
    kind: "recovery", reason: "closed", runs: [{ text: "z", marks: {} }]
  });
  const late: NativeSessionChange[] = [];
  session.subscribe(change => late.push(change));
  assert.equal(destroyDoc.mock.callCount(), 0);
  await Promise.resolve();
  assert.equal(destroyDoc.mock.callCount(), 1);
  assert.deepEqual(changes, ["changed:xa", "closed"]);
  assert.throws(session.document, /closed/);
  assert.deepEqual(late, []);
  const reopened = open({ kind: "state", state: closedState(closed, "requested") });
  t.after(reopened.close);
  assert.equal(reopened.document().rows[0]?.audioText, "xa");
});

test("all compound writes finish and publish before a close requested at transaction start", async t => {
  const first = fromDocument({}), split = fromDocument({ A: "abc" }), replace = fromDocument({ A: "abc" });
  const selection = anchor(split, 1, 2);
  for (const [session, run, expected] of [
    [first, () => first.commands.createFirstBeat("first"), ["first"]],
    [split, () => split.commands.deleteAndSplit(selection), ["a", "c"]],
    [replace, () => replace.commands.replaceAll([{ row: "A", cell: "narration", start: 1, end: 2 }], "x"), ["axc"]]
  ] as const) {
    t.after(session.close);
    const changes: NativeSessionChange[] = [], seen: string[][] = [];
    session.subscribe(change => {
      changes.push(change);
      if (change.kind === "changed") seen.push(session.document().rows.map(row => row.audioText ?? ""));
    });
    session.ydoc.once("beforeTransaction", session.close);
    written(run());
    assert.equal(changes.length, 0);
    await Promise.resolve();
    assert.deepEqual(changes.map(change => change.kind), ["changed", "closed"]);
    assert.deepEqual(seen, [expected]);
    const reopened = open({ kind: "state", state: closedState(changes, "requested") });
    t.after(reopened.close);
    assert.deepEqual(reopened.document().rows.map(row => row.audioText ?? ""), expected);
  }
});

test("a subscriber closing on changed and the other subscribers all receive closed", async t => {
  const session = fromDocument(), doc = session.ydoc;
  t.after(session.close);
  const schedule = t.mock.method(globalThis, "queueMicrotask");
  const changes: string[] = [];
  session.subscribe(change => {
    changes.push(`first:${change.kind}`);
    if (change.kind === "changed") {
      session.close();
      session.close();
    }
    throw new Error("subscriber");
  });
  session.subscribe(change => {
    changes.push(change.kind === "changed" ? `second:${session.document().rows[0]?.audioText}` : `second:${change.kind}`);
  });
  type(session, 0, "x");
  await Promise.resolve();
  assert.deepEqual(changes, ["first:changed", "second:xa", "first:closed", "second:closed"]);
  assert.equal(schedule.mock.callCount(), 1);
  session.close();
  doc.getText("retired").insert(0, "x");
  await Promise.resolve();
  assert.equal(schedule.mock.callCount(), 1);
  assert.deepEqual(changes, ["first:changed", "second:xa", "first:closed", "second:closed"]);
});

test("local update subscriptions preserve Yjs bytes and isolate subscriber faults", async t => {
  const session = fromDocument();
  const peer = open({ kind: "state", state: session.encodeState() }, "Peer");
  t.after(session.close);
  t.after(peer.close);
  const source = t.mock.fn<(bytes: Uint8Array) => void>();
  const received = t.mock.fn<(bytes: Uint8Array) => void>();
  session.ydoc.on("update", source);
  const stopFault = session.subscribeLocalUpdates(bytes => {
    bytes.fill(0);
    throw new Error("local update subscriber");
  });
  const stop = session.subscribeLocalUpdates(received);
  const unexpected = t.mock.fn();
  peer.subscribeLocalUpdates(unexpected);
  type(session, 0, "x");
  type(session, 1, "y");
  assert.equal(received.mock.callCount(), 2);
  assert.equal(source.mock.callCount(), 2);
  for (const [index, call] of received.mock.calls.entries()) {
    const bytes = call.arguments[0];
    assert.deepEqual(bytes, source.mock.calls[index]?.arguments[0]);
    Y.applyUpdate(peer.ydoc, bytes);
  }
  assert.equal(unexpected.mock.callCount(), 0);
  assert.deepEqual(peer.document(), session.document());
  stop();
  stopFault();
  type(session, 2, "z");
  assert.equal(received.mock.callCount(), 2);
  session.subscribeLocalUpdates(received);
  session.close();
  await Promise.resolve();
  session.ydoc.getText("retired").insert(0, "ignored");
  assert.equal(received.mock.callCount(), 2);
});

test("closing releases subscriber references after delivering closed", async t => {
  const session = fromDocument();
  t.after(session.close);
  const listener = t.mock.fn();
  const add = t.mock.method(Set.prototype, "add");
  session.subscribe(listener);
  const retained = add.mock.calls.find(call => call.arguments[0] === listener)?.this;
  assert(retained instanceof Set);
  assert.equal(retained.has(listener), true);
  session.close();
  await Promise.resolve();
  assert.equal(listener.mock.callCount(), 1);
  assert.deepEqual(listener.mock.calls[0]?.arguments, [{ kind: "closed", reason: "requested", state: session.encodeState() }]);
  assert.equal(retained.size, 0);
});

test("a write and close from a change subscriber publish two bounded batches and one close", t => {
  const session = fromDocument();
  t.after(session.close);
  const tasks = captureMicrotasks(t);
  const changes: string[] = [];
  session.subscribe(change => {
    if (change.kind !== "changed") {
      changes.push(change.kind);
      return;
    }
    const text = session.document().rows[0]?.audioText;
    changes.push(`changed:${text}`);
    if (text === "xa") {
      session.ydoc.once("beforeTransaction", session.close);
      type(session, 1, "y");
    }
  });
  type(session, 0, "x");
  assert.equal(tasks.length, 1);
  tasks.shift()?.();
  assert.deepEqual(changes, ["changed:xa"]);
  assert.equal(tasks.length, 1);
  tasks.shift()?.();
  assert.deepEqual(changes, ["changed:xa", "changed:xya", "closed"]);
  assert.equal(tasks.length, 0);
});

test("the real body sanitiser runs inside the transaction before a write and a throw is refused", t => {
  const events: string[] = [], failure = new Error("parser failed");
  let bytes: Uint8Array, shouldThrow = false, unmodified = false;
  class Parser extends DOMParser {
    override parseFromString(...args: Parameters<DOMParser["parseFromString"]>) {
      events.push("sanitize");
      unmodified = Buffer.compare(session.encodeState(), bytes) === 0;
      if (shouldThrow) throw failure;
      return super.parseFromString(...args);
    }
  }
  const session = fromDocument(undefined, Parser);
  t.after(session.close);
  session.ydoc.on("beforeTransaction", () => events.push("begin"));
  session.ydoc.on("update", () => events.push("write"));
  session.ydoc.on("afterAllTransactions", () => events.push("end"));
  bytes = session.encodeState();
  const comment = commentInput("anchor");
  const created = session.commands.createComment(comment);
  assert.equal(created.kind, "written");
  assert.equal(unmodified, true);
  assert.deepEqual(events.splice(0), ["begin", "sanitize", "write", "end"]);
  bytes = session.encodeState();
  unchanged(session, () => session.commands.createComment({ ...comment, body: "<script>bad</script>safe" }), { kind: "refused", reason: "value" });
  assert.equal(unmodified, true);
  assert.deepEqual(events.splice(0), ["begin", "sanitize", "end"]);
  shouldThrow = true;
  unchanged(session, () => session.commands.createComment(comment), { kind: "refused", reason: "value" });
  assert.deepEqual(events.splice(0), ["begin", "sanitize", "end"]);
  written(session.commands.setField(status, "ready"));
});

test("typing groups by word and cell, and an empty redo ends the group", async t => {
  const session = fromDocument();
  t.after(session.close);
  type(session, 0, "h");
  await setTimeout(1100);
  type(session, 1, "i");
  type(session, 2, " ");
  type(session, 3, "w");
  type(session, 0, "v", visual);
  unchanged(session, session.commands.redo, UNCHANGED);
  type(session, 1, "x", visual);
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.visualText, "v");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.visualText, "");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "hi a");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "a");
  unchanged(session, session.commands.undo, UNCHANGED);
});

for (const direction of [-1, 1] as const) {
  test(`a ${direction === -1 ? "Backspace" : "Delete"} run groups across peer updates and replays its endpoint carets`, t => {
    const session = fromDocument({ A: "abcdef" });
    const peer = open({ kind: "state", state: session.encodeState() }, "Bob");
    t.after(session.close);
    t.after(peer.close);
    const erase = direction === -1 ? 3 : 2;
    const remove = (from: number, at: number) => {
      const before = from + (direction === -1 ? 1 : 0);
      const step = session.commands.deleteTextInRun.withSelection(anchor(session, before), anchor(session, from, from + 1), direction, at);
      written(step.result);
      step.recordAfter(anchor(session, from));
    };
    remove(2, 0);
    type(peer, 0, "X");
    Y.applyUpdate(session.ydoc, peer.encodeState(), "peer");
    remove(direction === -1 ? 2 : 3, 999);
    remove(direction === -1 ? 1 : 3, 1998);
    const after = direction === -1 ? "Xdef" : "Xabf";
    assert.equal(session.document().rows[0]?.audioText, after);
    for (const [press, text, offset] of [["undo", "Xabcdef", erase + 1], ["redo", after, direction === -1 ? 1 : 3]] as const) {
      const result = session.commands[press]();
      assert.equal(result.kind, "written");
      const point = { target: narration, offset };
      assert.deepEqual(result.selection, { anchor: point, head: point });
      assert.equal(session.document().rows[0]?.audioText, text);
      Y.applyUpdate(peer.ydoc, session.encodeState(), "peer");
      assert.equal(peer.document().rows[0]?.audioText, text);
    }
    unchanged(session, session.commands.redo, UNCHANGED);
  });
}

const deletionBoundaries: ReadonlyArray<readonly [
  name: string, intervene: (session: Session) => void, at?: number, direction?: -1 | 1, from?: number,
  target?: Parameters<typeof anchor>[3]
]> = [
  ["a one-second pause", () => {}, 1000],
  ["a displaced caret", () => {}, 1, 1, 1],
  ["a change of direction", () => {}, 1, -1, 1],
  ["a different beat", () => {}, 1, 1, 2, { beat: "B", cell: "narration" }],
  ["a different cell in the same beat", () => {}, 1, 1, 2, visual],
  ["a typed letter", session => type(session, 0, "X"), 1, 1, 3],
  ["a command", session => written(session.commands.setField(status, "ready"))],
  ["an explicit capture boundary", session => session.endTypingGroup()],
  ["an empty redo", session => unchanged(session, session.commands.redo, UNCHANGED)]
];

for (const [boundary, intervene, at = 1, direction = 1, from = 2, target = narration] of deletionBoundaries) {
  test(`a native deletion run ends at ${boundary}`, t => {
    const session = fromDocument({ A: "abcdef", B: "ghijkl" });
    t.after(session.close);
    if (target === visual) type(session, 0, "uvwxyz", visual);
    written(session.commands.deleteTextInRun(anchor(session, 2, 3), 1, 0));
    intervene(session);
    const before = session.document().rows;
    written(session.commands.deleteTextInRun(anchor(session, from, from + 1, target), direction, at));
    assert.notDeepEqual(session.document().rows, before);
    written(session.commands.undo());
    assert.deepEqual(session.document().rows, before);
  });
}

test("a non-typing edit separates the typing on both sides", t => {
  const session = fromDocument();
  t.after(session.close);
  type(session, 0, "x");
  written(session.commands.setField(status, "ready"));
  type(session, 1, "y");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "xa");
  assert.equal(session.document().rows[0]?.status, "ready");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "xa");
  assert.equal(session.document().rows[0]?.status, "todo");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "a");
});

test("typing in two beats of the same cell kind creates two undo steps", t => {
  const session = fromDocument();
  t.after(session.close);
  type(session, 0, "x");
  type(session, 0, "y", { ...narration, beat: "B" });
  written(session.commands.undo());
  assert.deepEqual(session.document().rows.map(row => row.audioText), ["xa", "b", "c"]);
  written(session.commands.undo());
  assert.deepEqual(session.document().rows.map(row => row.audioText), ["a", "b", "c"]);
});

test("an empty typing replacement preserves the preceding space boundary", t => {
  const session = fromDocument();
  t.after(session.close);
  type(session, 0, "x ");
  written(session.commands.typeText(anchor(session, 2, 3), "", {}));
  type(session, 2, "y");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "x ");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "a");
});

test("unchanged typing in another beat leaves the current capture intact", t => {
  const session = fromDocument();
  t.after(session.close);
  type(session, 0, "x");
  const other = anchor(session, 0, 0, { ...narration, beat: "B" });
  unchanged(session, () => session.commands.typeText(other, "", {}), UNCHANGED);
  type(session, 1, "y");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "a");
  unchanged(session, session.commands.undo, UNCHANGED);
});

for (const boundary of ["undo", "redo"] as const) {
  test(`an empty typing replacement starts with fresh word state after ${boundary}`, t => {
    const session = fromDocument();
    t.after(session.close);
    type(session, 0, "x ");
    if (boundary === "undo") {
      type(session, 2, "y ");
      written(session.commands.undo());
    } else {
      unchanged(session, session.commands.redo, UNCHANGED);
    }
    written(session.commands.typeText(anchor(session, 2, 3), "", {}));
    type(session, 2, "z");
    written(session.commands.undo());
    assert.equal(session.document().rows[0]?.audioText, "x a");
  });
}

test("both empty undo and empty redo stop capture before starting their press", t => {
  const session = fromDocument();
  t.after(session.close);
  const stop = t.mock.method(Y.UndoManager.prototype, "stopCapturing");
  unchanged(session, session.commands.undo, UNCHANGED);
  assert.equal(stop.mock.callCount(), 1);
  unchanged(session, session.commands.redo, UNCHANGED);
  assert.equal(stop.mock.callCount(), 2);
});

test("a taken minted ID refuses without writing until a local write advances the clock", t => {
  const client = 571;
  const taken = "c" + client.toString(36) + "-0";
  const comment = commentInput("anchor");
  const seed = open({
    kind: "document",
    document: { ...structureScript({ A: "a" }), comments: [{ ...commentInput(taken), replies: [] }] },
    conversion
  });
  t.after(seed.close);
  const copy = open({ kind: "state", state: seed.encodeState() });
  t.after(copy.close);
  copy.ydoc.clientID = client;
  for (let attempt = 0; attempt < 2; attempt++) {
    unchanged(copy, () => copy.commands.createComment(comment), { kind: "refused", reason: "taken" });
  }
  written(copy.commands.setField(status, "ready"));
  assert.deepEqual(copy.commands.createComment(comment), { kind: "written", created: taken.replace(/0$/, "1") });
});

test("body editing uses the session actor for comments and replies", t => {
  const author = fromDocument();
  t.after(author.close);
  const comment = author.commands.createComment(commentInput("anchor"));
  assert(comment.kind === "written");
  const reply = author.commands.createReply(comment.created, replyInput("reply"));
  assert(reply.kind === "written");
  const peer = open({ kind: "state", state: author.encodeState() }, "Bob");
  t.after(peer.close);
  for (const target of [{ comment: comment.created }, { comment: comment.created, reply: reply.created }]) {
    unchanged(peer, () => peer.commands.setCommentBody(target, "edited"), { kind: "refused", reason: "author" });
    written(author.commands.setCommentBody(target, "edited"));
    unchanged(author, () => author.commands.setCommentBody(target, "edited"), UNCHANGED);
  }
  assert.equal(author.document().comments[0]?.body, "edited");
  assert.equal(author.document().comments[0]?.replies?.[0]?.body, "edited");
});

for (const seed of [2, 19, 73, 108]) {
  test(`mixed session commands converge across three writers and a late joiner, seed ${seed}`, t => {
    const a = fromDocument(), state = a.encodeState();
    const copies = [a, open({ kind: "state", state }, "Bob"), open({ kind: "state", state }, "Carol")] as const;
    const [, b, c] = copies;
    const packets: { from: Session; update: Uint8Array }[] = [];
    for (const copy of copies) {
      t.after(copy.close);
      copy.ydoc.on("update", (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
        if (transaction.local) packets.push({ from: copy, update });
      });
    }
    function exchange(): void {
      const pending = packets.splice(0);
      copies.forEach((copy, index) => {
        for (const update of arrangePackets(pending.filter(packet => packet.from !== copy).map(packet => packet.update), "shuffled", seed + index)) {
          Y.applyUpdate(copy.ydoc, update, "peer");
        }
      });
    }

    type(a, 0, "hello ");
    written(a.commands.undo());
    written(a.commands.redo());
    written(b.commands.formatText(anchor(b, 0, 1, { ...narration, beat: "B" }), { kind: "plain", mark: "b", on: true }));
    written(b.commands.setField(status, "ready"));
    written(b.commands.undo());
    written(c.commands.moveBlocks([{ kind: "beat", id: "C" }], { kind: "beat", id: "A" }));
    const comment = c.commands.createComment(commentInput("anchor"));
    assert(comment.kind === "written");
    exchange();
    for (const copy of copies) assert.equal(copy.document().rows.find(row => row.id === "A")?.status, "todo");

    const before = copies.map(copy => copy.document());
    unchanged(b, () => b.commands.deleteText(anchor(b, 0)), UNCHANGED);
    assert.deepEqual(packets, []);
    exchange();
    assert.deepEqual(copies.map(copy => copy.document()), before);

    written(a.commands.resolveComment({ comment: comment.created }, { by: "Alice", at: AT }));
    type(c, 0, "image", visual);
    written(b.commands.setField(status, "shot"));
    exchange();
    const late = open({ kind: "empty" }, "Late");
    t.after(late.close);
    Y.applyUpdate(late.ydoc, c.encodeState(), "peer");
    for (const copy of [...copies, late]) {
      const document = copy.document();
      assert.deepEqual(document.rows.map(({ id, audioText, visualText }) => [id, audioText, visualText]), [
        ["C", "c", ""], ["A", "hello a", "image"], ["B", "<strong>b</strong>", ""]
      ]);
      assert.equal(document.rows[1]?.status, "shot");
      assert.deepEqual(document.comments.map(({ id, body, resolved, resolvedBy }) => [id, body, resolved, resolvedBy]), [
        [comment.created, "original", true, "Alice"]
      ]);
      assert.deepEqual(document, a.document());
    }
    unchanged(late, late.commands.undo, UNCHANGED);
  });
}

test("an update scheduling failure leaves cleanup complete and is reported before the next write", async t => {
  const session = fromDocument(), changes: NativeSessionChange[] = [];
  t.after(session.close);
  session.subscribe(change => changes.push(change));
  const failure = new Error("scheduling failed");
  const schedule = t.mock.method(globalThis, "queueMicrotask", () => { throw failure; });
  type(session, 0, "x");
  schedule.mock.restore();
  const before = session.encodeState();
  assert.throws(() => session.commands.setField(status, "ready"), failure);
  assert.deepEqual(session.encodeState(), before);
  type(session, 1, "y");
  await Promise.resolve();
  assert.deepEqual(changes, [{ kind: "changed" }]);
  assert.equal(session.document().rows[0]?.audioText, "xya");
});
