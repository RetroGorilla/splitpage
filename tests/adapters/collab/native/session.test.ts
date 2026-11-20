import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeSessionChange, NativeSessionSource } from "../../../../src/adapters/collab/native/session.ts";
import { createRichText } from "../../../../src/adapters/richtext/richtext.ts";
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

function fromDocument(rows = { A: "a", B: "b", C: "c" }, Parser = DOMParser): Session {
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

test("a peer update submitted inside a command is copied and applied between commands outside local undo", t => {
  const a = fromDocument(), b = open({ kind: "state", state: a.encodeState() });
  t.after(() => { a.close(); b.close(); });
  const before = Y.encodeStateVector(b.ydoc);
  type(b, 0, "peer ");
  const packet = Y.encodeStateAsUpdate(b.ydoc, before);
  const at = anchor(a, 0);
  a.ydoc.once("beforeTransaction", () => {
    a.applyPeerUpdate(packet);
    packet.fill(0);
    assert.equal(a.document().rows[0]?.audioText, "a");
    assert.deepEqual(a.commands.typeText(at, "nested", {}), {
      kind: "recovery", reason: "busy", runs: [{ text: "nested", marks: {} }]
    });
    assert.deepEqual(a.commands.undo(), { kind: "refused", reason: "busy" });
  });
  written(a.commands.typeText(at, "local ", {}));
  assert.match(a.document().rows[0]?.audioText ?? "", /^(?:local peer |peer local )a$/);
  written(a.commands.undo());
  assert.equal(a.document().rows[0]?.audioText, "peer a");
  unchanged(a, a.commands.undo, UNCHANGED);
});

test("stock delivery changes the plain Y.Doc and subscribers run safely after transactions", async t => {
  const a = fromDocument(), b = open({ kind: "empty" });
  t.after(() => { a.close(); b.close(); });
  const broken = b.subscribe(() => { throw new Error("subscriber"); });
  const received: string[] = [];
  const stop = b.subscribe(change => {
    received.push(change + ":" + b.document().rows[0]?.audioText);
  });
  Y.applyUpdate(b.ydoc, a.encodeState(), { provider: true });
  assert.deepEqual(received, []);
  await Promise.resolve();
  assert.deepEqual(received, ["changed:a"]);
  unchanged(b, b.commands.undo, UNCHANGED);
  type(b, 0, "z");
  type(b, 1, "z");
  await Promise.resolve();
  assert.deepEqual(received, ["changed:a", "changed:zza"]);
  stop();
  broken();
  type(b, 1, "z");
  await Promise.resolve();
  assert.deepEqual(received, ["changed:a", "changed:zza"]);
});

test("session admission waits out a raw Yjs transaction without replacing its document", async t => {
  const a = fromDocument(), b = open({ kind: "state", state: a.encodeState() });
  t.after(() => { a.close(); b.close(); });
  const doc = a.ydoc, at = anchor(a, 0);
  type(b, 0, "peer ");
  doc.transact(() => {
    a.applyPeerUpdate(b.encodeState());
    assert.equal(a.document().rows[0]?.audioText, "a");
    assert.deepEqual(a.commands.undo(), { kind: "refused", reason: "busy" });
    assert.deepEqual(a.commands.anchorText(narration, 0), { kind: "refused", reason: "busy" });
    assert.equal(a.ydoc, doc);
  });
  await Promise.resolve();
  assert.equal(a.ydoc, doc);
  assert.equal(a.document().rows[0]?.audioText, "peer a");
  written(a.commands.typeText(at, "local ", {}));
});

test("reentry during argument copying is refused before a nested command can write", t => {
  const session = fromDocument(), peer = open({ kind: "state", state: session.encodeState() });
  t.after(() => { session.close(); peer.close(); });
  type(peer, 0, "p");
  const before = session.encodeState();
  const value = { get nested() {
    session.applyPeerUpdate(peer.encodeState());
    assert.deepEqual(session.encodeState(), before);
    unchanged(session, () => session.commands.setField(status, "ready"), { kind: "refused", reason: "busy" });
    unchanged(session, session.commands.undo, { kind: "refused", reason: "busy" });
    return "value";
  } };
  written(session.commands.setField(beatField("A", "field"), value));
  assert.notDeepEqual(session.encodeState(), before);
  assert.equal(session.document().rows[0]?.audioText, "pa");
  assert.equal(session.document().rows[0]?.status, "todo");
  assert.deepEqual(session.document().rows[0]?.field, { nested: "value" });
});

test("interrupted cleanup reopens current stored state, retires history and publishes undo reset", async t => {
  const destroyUndo = t.mock.method(Y.UndoManager.prototype, "destroy");
  const session = fromDocument(), changes: NativeSessionChange[] = [];
  t.after(session.close);
  const doc = session.ydoc;
  session.subscribe(change => changes.push(change));
  type(session, 0, "x");
  await Promise.resolve();
  changes.length = 0;
  const at = anchor(session, 1);
  const failure = new Error("interrupted update");
  doc.once("update", () => { throw failure; });
  assert.throws(() => session.commands.typeText(at, "y", {}), failure);
  assert.notEqual(session.ydoc, doc);
  assert.deepEqual(session.encodeState(), Y.encodeStateAsUpdate(doc));
  assert.equal(session.document().rows[0]?.audioText, "xya");
  assert.equal(destroyUndo.mock.callCount(), 1);
  unchanged(session, session.commands.undo, UNCHANGED);
  await Promise.resolve();
  assert.deepEqual(changes, ["changed", "undo-reset"]);
  type(session, 2, "z");
  written(session.commands.undo());
  assert.equal(session.document().rows[0]?.audioText, "xya");
});

test("busy after a failed raw delivery recovers at the next boundary", async t => {
  const session = fromDocument(), peer = open({ kind: "state", state: session.encodeState() });
  t.after(() => { session.close(); peer.close(); });
  type(peer, 0, "p");
  const doc = session.ydoc, failure = new Error("interrupted delivery");
  doc.once("update", () => { throw failure; });
  assert.throws(() => Y.applyUpdate(doc, peer.encodeState(), "provider"), failure);
  assert.deepEqual(session.commands.anchorText(narration, 0), { kind: "refused", reason: "busy" });
  await Promise.resolve();
  assert.notEqual(session.ydoc, doc);
  assert.equal(session.document().rows[0]?.audioText, "pa");
  unchanged(session, session.commands.undo, UNCHANGED);
});

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
  doc.transact(() => {
    session.close();
    assert.equal(destroy.mock.callCount(), 0);
  });
  assert.equal(destroy.mock.callCount(), 0);
  await Promise.resolve();
  assert.equal(destroy.mock.callCount(), 1);
  assert.equal(session.ydoc, doc);
});

test("a close during argument copying waits for the command to finish", t => {
  const session = fromDocument(), doc = session.ydoc;
  t.after(session.close);
  const destroy = t.mock.method(doc, "destroy");
  written(session.commands.setField(beatField("A", "field"), { get nested() {
    session.close();
    assert.equal(destroy.mock.callCount(), 0);
    return "value";
  } }));
  assert.equal(destroy.mock.callCount(), 1);
  const reopened = open({ kind: "state", state: session.encodeState() });
  t.after(reopened.close);
  assert.deepEqual(reopened.document().rows[0]?.field, { nested: "value" });
});

test("close during a command retires its undo binding only after the write", async t => {
  const destroyUndo = t.mock.method(Y.UndoManager.prototype, "destroy");
  const session = fromDocument(), doc = session.ydoc;
  t.after(session.close);
  const destroyDoc = t.mock.method(doc, "destroy", function (this: Y.Doc) {
    assert.equal(destroyUndo.mock.callCount(), 1);
    return Y.Doc.prototype.destroy.call(this);
  });
  const changes: NativeSessionChange[] = [];
  session.subscribe(change => changes.push(change));
  const update = anchor(session, 0);
  doc.once("beforeTransaction", () => {
    session.close();
    assert.equal(destroyDoc.mock.callCount(), 0);
    assert.equal(destroyUndo.mock.callCount(), 0);
    assert.equal(session.document().rows[0]?.audioText, "a");
  });
  written(session.commands.typeText(update, "x", {}));
  assert.equal(destroyDoc.mock.callCount(), 1);
  const reopened = open({ kind: "state", state: session.encodeState() });
  t.after(reopened.close);
  assert.equal(reopened.document().rows[0]?.audioText, "xa");
  unchanged(session, session.commands.undo, { kind: "refused", reason: "closed" });
  unchanged(session, () => session.commands.typeText(update, "z", {}), {
    kind: "recovery", reason: "closed", runs: [{ text: "z", marks: {} }]
  });
  const late: NativeSessionChange[] = [];
  session.subscribe(change => late.push(change));
  type(reopened, 0, "p");
  unchanged(session, () => session.applyPeerUpdate(reopened.encodeState()), undefined);
  session.close();
  assert.equal(destroyDoc.mock.callCount(), 1);
  await Promise.resolve();
  assert.deepEqual(changes, ["changed", "closed"]);
  assert.deepEqual(late, []);
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
          copy.applyPeerUpdate(update);
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
    late.applyPeerUpdate(c.encodeState());
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
