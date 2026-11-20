import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { convertedScript } from "./helpers.ts";
import {
  createNativeComment, createNativeReply, removeNativeComment, reopenNativeComment, resolveNativeComment, setNativeCommentBody
} from "../../../../src/adapters/collab/native/comment-commands.ts";
import { removeNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { clearNativeField, setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import { joinNativeRow, removeNativeRows, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import {
  AT, AUTHOR, COMMENT, IMAGE, REPLY, RESOLUTION, beatField, beatStep, checkRecordStep, commentInput, fullUpdate, headingField,
  expectedMint, headingStep, recordCopies, recordRead, recordSnapshot, replyId, replyInput, threadSteps, unchangedRecord
} from "./record-harness.ts";
import type { RecordStep, RecordTestRead } from "./record-harness.ts";

const WRITTEN = { kind: "written" };

test("every record and thread command changes precisely its stored keys and its projection on writer and receiver", () => {
  const { scripts: [writer, receiver], net } = recordCopies();
  assert.ok(writer && receiver);
  const events: unknown[] = [];
  writer.doc.on("update", (_update: Uint8Array, origin: unknown) => { events.push(origin); });
  const annotation = { imageRef: { ...IMAGE, sha256: "b".repeat(64) }, marks: [{ kind: "pen", color: "#111111", width: 0.02, points: [0, 1] }] };
  const fields = {
    status: "ready", lengthSeconds: 0, paragraphStart: true, imageName: "Frame", imageAnnotation: annotation,
    imageLinks: [{ href: "https://example.test/video", poster: true }], moreImages: [{ imageRef: annotation.imageRef, name: "Other" }],
    custom: { nested: [null, true, "text"] }, extra: { imageRef: null, unknownFileField: 42 }
  };
  const steps: RecordStep[] = [
    beatStep("imageRef", IMAGE),
    ...Object.entries(fields).flatMap(([field, value]) => [beatStep(field, value), beatStep(field, undefined)]),
    beatStep("imageRef", IMAGE), beatStep("imageRef", undefined),
    headingStep("heading field"), headingStep(undefined), ...threadSteps("new-thread", "000012V")
  ];
  for (const step of steps) {
    const expectedStored = recordSnapshot(receiver), expectedRead: RecordTestRead = structuredClone(recordRead(receiver));
    step.expect(expectedStored, expectedRead, writer);
    events.length = 0;
    checkRecordStep(writer, step);
    assert.deepEqual(events, [writer.origin], step.name);
    net.settle("twice");
    assert.deepEqual(recordSnapshot(receiver), expectedStored, step.name);
    assert.deepEqual(recordRead(receiver), expectedRead, step.name);
    const document = structuredClone(expectedRead.document);
    const reimported = convertedScript(migrateRows(structuredClone(document)), 20);
    try {
      for (const row of document.rows) {
        if (!Object.hasOwn(row, "status")) row.status = "todo";
        if (!Object.hasOwn(row, "imageRef")) row.imageRef = null;
      }
      assert.deepEqual(reimported.reader.document(), document, step.name + ": file round trip");
    } finally { reimported.doc.destroy(); }
  }
  for (const script of [writer, receiver]) script.doc.destroy();
});

test("equal values and absent clears emit no update, including reordered objects", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  const target = beatField("A", "custom");
  assert.deepEqual(setNativeField(script, target, { a: 1, b: [2, { c: true, d: null }] }), WRITTEN);
  unchangedRecord(script, () => setNativeField(script, target, { b: [2, { d: null, c: true }], a: 1 }));
  unchangedRecord(script, () => clearNativeField(script, beatField("A", "absent")));
  unchangedRecord(script, () => clearNativeField(script, headingField("absent")));
  unchangedRecord(script, () => setNativeField(script, beatField("A", "status"), "todo"));
  unchangedRecord(script, () => setNativeCommentBody(script, COMMENT, AUTHOR, "original"));
  unchangedRecord(script, () => setNativeCommentBody(script, REPLY, AUTHOR, "reply"));
  unchangedRecord(script, () => reopenNativeComment(script, COMMENT));
  unchangedRecord(script, () => reopenNativeComment(script, REPLY));
  assert.deepEqual(resolveNativeComment(script, COMMENT, RESOLUTION), WRITTEN);
  unchangedRecord(script, () => resolveNativeComment(script, COMMENT, { ...RESOLUTION, by: "Carol" }));
  const read = script.reader.row("A")?.fields.custom as { b: object[] };
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.b) && Object.isFrozen(read.b[1]));
  const document = script.reader.document();
  assert.ok(Object.isFrozen(document.comments) && Object.isFrozen(document.comments[0]?.replies?.[0]));
  script.doc.destroy();
});

test("malformed values, reserved fields and stale rows or headings refuse without changing the full update", () => {
  const { scripts: [script] } = recordCopies([7]);
  assert.ok(script);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const invalid: readonly (readonly [string, unknown])[] = [
    ["status", "finished"], ["lengthSeconds", -1], ["lengthSeconds", 1.5], ["lengthSeconds", 86401], ["paragraphStart", false],
    ["imageRef", { sha256: IMAGE.sha256 }], ["imageName", "\ud800"], ["imageAnnotation", { imageRef: IMAGE, marks: [false] }],
    ["imageLinks", [{ href: "javascript:alert(1)" }]], ["imageLinks", [{ name: "file", location: { path: "local" } }]],
    ["moreImages", [{}]], ["extra", { status: "ready" }], ["custom", cyclic], ["custom", NaN], ["custom", new Date()],
    ["custom", { key: undefined }], ["custom", ["\ud800"]], ["custom", new Array<unknown>(1)]
  ];
  for (const [field, value] of invalid) unchangedRecord(script, () => setNativeField(script, beatField("A", field), value), "value");
  for (const field of ["rank", "joined", "id", "audioText", "visualText", "updatedAt", "updatedBy"]) {
    unchangedRecord(script, () => clearNativeField(script, beatField("A", field)), "value");
  }
  for (const field of ["rank", "removed", "id", "name", "firstSceneId"]) unchangedRecord(script, () => clearNativeField(script, headingField(field)), "value");
  assert.deepEqual(removeNativeRows(script, ["B"]), WRITTEN);
  script.roots.beats.delete("C");
  script.roots.visuals.delete("D");
  for (const id of ["missing", "B", "C", "D"]) {
    unchangedRecord(script, () => setNativeField(script, beatField(id, "status"), "ready"), "missing");
    unchangedRecord(script, () => clearNativeField(script, beatField(id, "status")), "missing");
  }
  assert.deepEqual(removeNativeHeading(script, "H"), WRITTEN);
  unchangedRecord(script, () => setNativeField(script, headingField("note"), "hidden"), "missing");
  script.doc.destroy();
});

test("joined fields address one member and keep the reader's head, status and gallery projection", () => {
  const { scripts: [script] } = recordCopies([7]);
  assert.ok(script);
  assert.deepEqual(joinNativeRow(script, "B", "A", " "), WRITTEN);
  const set = (id: string, field: string, value: unknown) => assert.deepEqual(setNativeField(script, beatField(id, field), value), WRITTEN);
  set("A", "status", "ready");
  set("A", "lengthSeconds", 10);
  set("B", "status", "shot");
  set("B", "lengthSeconds", 20);
  set("B", "imageRef", IMAGE);
  const combined = script.reader.row("A");
  assert.deepEqual(combined?.members, ["A", "B"]);
  assert.equal(combined?.fields.status, "shot");
  assert.equal(combined?.fields.lengthSeconds, 10);
  assert.deepEqual(combined?.fields.imageRef, IMAGE);
  assert.equal(script.reader.row("B"), null);
  assert.deepEqual(clearNativeField(script, beatField("B", "status")), WRITTEN);
  assert.equal(script.reader.row("A")?.fields.status, "ready");
  assert.deepEqual(unjoinNativeRow(script, "B"), WRITTEN);
  assert.equal(script.reader.row("B")?.fields.lengthSeconds, 20);
  assert.deepEqual(script.reader.row("B")?.fields.imageRef, IMAGE);
  script.doc.destroy();
});

test("body edits require the stored author and thread mutations refuse invalid or removed targets", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  for (const target of [COMMENT, REPLY]) {
    unchangedRecord(script, () => setNativeCommentBody(script, target, "Bob", "foreign"), "author");
    unchangedRecord(script, () => setNativeCommentBody(script, target, AUTHOR, "\ud800"), "value");
    unchangedRecord(script, () => resolveNativeComment(script, target, { ...RESOLUTION, at: "invalid" }), "value");
  }
  unchangedRecord(script, () => createNativeComment(script, { ...commentInput("bad"), rowId: "gone" }), "missing");
  unchangedRecord(script, () => createNativeReply(script, "thread", { ...replyInput("bad"), createdAt: "invalid" }), "value");
  assert.deepEqual(resolveNativeComment(script, COMMENT, RESOLUTION), WRITTEN);
  assert.deepEqual(removeNativeComment(script, COMMENT), WRITTEN);
  unchangedRecord(script, () => createNativeReply(script, "thread", replyInput("late")), "missing");
  for (const target of [COMMENT, REPLY]) {
    unchangedRecord(script, () => setNativeCommentBody(script, target, AUTHOR, "late"), "missing");
    unchangedRecord(script, () => reopenNativeComment(script, target), "missing");
    unchangedRecord(script, () => removeNativeComment(script, target), "missing");
  }
  script.doc.destroy();
});

test("caller objects and nested arrays are read once by index, including inherited slots, without calling iterators", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  const reads: string[] = [], read = <T>(key: string, value: T): T => { reads.push(key); return value; };
  class Links extends Array<unknown> {
    [Symbol.iterator](): ArrayIterator<unknown> { throw new Error("caller iterator"); }
    get 0(): unknown { return read("0", { get href() { return read("href", "https://example.test/video"); } }); }
  }
  const links = new Proxy(new Links(1), { get(target, key, receiver) {
    if (key === "length") reads.push("length");
    return Reflect.get(target, key, receiver) as unknown;
  } });
  const field = {
    get kind() { return read("kind", "beat" as const); },
    get id() { return read("beat", "A"); },
    get field() { return read("field", "imageLinks"); }
  };
  assert.deepEqual(setNativeField(script, field, links), WRITTEN);
  assert.deepEqual(reads.splice(0), ["kind", "beat", "field", "length", "0", "href"]);
  const shared = { get leaf() { return read("leaf", true); } };
  assert.deepEqual(setNativeField(script, beatField("A", "custom"), { left: shared, right: shared }), WRITTEN);
  assert.deepEqual(reads.splice(0), ["leaf"]);
  const reply = {
    get author() { return read("author", AUTHOR); },
    get body() { return read("body", "body"); }, get createdAt() { return read("createdAt", AT); }
  };
  const created = expectedMint(script, "rp");
  assert.deepEqual(createNativeReply(script, "thread", reply), { ...WRITTEN, created });
  assert.deepEqual(reads.splice(0), ["author", "body", "createdAt"]);
  const target = {
    get comment() { return read("comment", "thread"); },
    get reply() { return read("reply", created); }
  };
  assert.deepEqual(resolveNativeComment(script, target, {
    get by() { return read("by", "Bob"); }, get at() { return read("at", AT); }
  }), WRITTEN);
  assert.deepEqual(reads, ["comment", "reply", "by", "at"]);
  script.doc.destroy();
});

test("throwing accessors refuse and reentrant accessors run before the command's checks", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  const fail = (): never => { throw new Error("accessor"); };
  unchangedRecord(script, () => setNativeField(script, beatField("A", "custom"), { get nested() { return fail(); } }), "value");
  unchangedRecord(script, () => createNativeComment(script, { ...commentInput("throw"), get quotedText() { return fail(); } }), "value");
  unchangedRecord(script, () => setNativeCommentBody(script, { get comment() { return fail(); } }, AUTHOR, "text"), "value");
  let afterInner: Uint8Array | undefined;
  const outcome = setNativeField(script, beatField("B", "custom"), { get nested() {
    assert.deepEqual(removeNativeRows(script, ["B"]), WRITTEN);
    afterInner = fullUpdate(script);
    return true;
  } });
  assert.deepEqual(outcome, { kind: "refused", reason: "missing" });
  assert.deepEqual(fullUpdate(script), afterInner);
  assert.deepEqual(setNativeCommentBody(script, {
    get comment() {
      assert.deepEqual(resolveNativeComment(script, COMMENT, RESOLUTION), WRITTEN);
      return COMMENT.comment;
    }
  }, AUTHOR, "after inner"), WRITTEN);
  assert.equal(script.reader.document().comments[0]?.resolved, true);
  assert.equal(script.reader.document().comments[0]?.body, "after inner");
  script.doc.destroy();
});

test("busy and closed, including closure by a later accessor or beforeTransaction, refuse unwritten", () => {
  const { scripts: [first, second, third] } = recordCopies([5, 6, 7]);
  assert.ok(first && second && third);
  first.doc.transact(() => {
    unchangedRecord(first, () => clearNativeField(first, beatField("A", "status")), "busy");
    unchangedRecord(first, () => createNativeReply(first, "thread", replyInput("busy")), "busy");
  });
  unchangedRecord(first, () => setNativeField(first, { ...beatField("", "status"), get field() { first.close(); return "status"; } }, "nonsense"), "closed");
  unchangedRecord(first, () => removeNativeComment(first, COMMENT), "closed");
  unchangedRecord(second, () => createNativeComment(second, {
    ...commentInput(""), get quotedText() { second.close(); return ""; }
  }), "closed");
  third.doc.once("beforeTransaction", () => third.close());
  unchangedRecord(third, () => setNativeCommentBody(third, COMMENT, AUTHOR, "late"), "closed");
  let transactions = 0;
  first.doc.on("beforeTransaction", () => { transactions++; });
  unchangedRecord(first, () => setNativeField(first, beatField("A", "status"), "ready"), "closed");
  assert.equal(transactions, 0);
  for (const script of [first, second, third]) script.doc.destroy();
});

test("record targeting rejects invalid kinds, nonplain targets and identities the core would rewrite", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  const field = headingField("note"), array = Object.assign([], field), callable = Object.assign(() => null, field);
  for (const invalid of [array, callable]) unchangedRecord(script, () => setNativeField(script, invalid, "value"), "value");
  const badKind = { ...field, kind: "other" } as unknown as typeof field;
  unchangedRecord(script, () => setNativeField(script, badKind, "value"), "missing");
  script.roots.comments.set(" thread ", new Y.Map());
  script.roots.replies.set(replyId("thread", " answer "), new Y.Map([["commentId", "thread"]]));
  unchangedRecord(script, () => removeNativeComment(script, { comment: " thread " }), "missing");
  unchangedRecord(script, () => removeNativeComment(script, { comment: "thread", reply: " answer " }), "missing");
  for (const placement of [{ rowId: " A " }, { anchorId: " anchor " }]) {
    unchangedRecord(script, () => createNativeComment(script, { ...commentInput("anchor"), ...placement }), "missing");
  }
  script.doc.destroy();
});

test("the core gallery rules refuse excess links, duplicate pictures and legacy visualImage writes", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  const links = Array.from({ length: 21 }, (_, index) => ({ href: "https://example.test/" + index }));
  unchangedRecord(script, () => setNativeField(script, beatField("A", "imageLinks"), links), "value");
  assert.deepEqual(setNativeField(script, beatField("A", "imageRef"), IMAGE), WRITTEN);
  unchangedRecord(script, () => setNativeField(script, beatField("A", "moreImages"), [{ imageRef: IMAGE }, { imageRef: IMAGE }]), "value");
  unchangedRecord(script, () => setNativeField(script, beatField("A", "visualImage"), 42), "value");
  unchangedRecord(script, () => setNativeField(script, beatField("A", "extra"), { visualImage: 42 }), "value");
  script.doc.destroy();
});

test("the depth and expanded size bounds refuse plain file values before encoding", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  let deep: unknown = "leaf", wide: unknown = "leaf";
  for (let index = 0; index < 4800; index++) deep = [deep];
  for (let index = 0; index < 24; index++) wide = [wide, wide];
  unchangedRecord(script, () => setNativeField(script, headingField("note"), deep), "value");
  unchangedRecord(script, () => setNativeField(script, headingField("note"), wide), "value");
  script.doc.destroy();
});

test("copying a second argument still runs its accessors when the first throws", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  const fail = (): never => { throw new Error("accessor"); }, reads: string[] = [];
  unchangedRecord(script, () => resolveNativeComment(script, { get comment() { return fail(); } }, {
    get by() { reads.push("by"); return "Bob"; },
    get at() { reads.push("at"); return AT; }
  }), "value");
  unchangedRecord(script, () => setNativeField(script, { ...headingField("note"), get field() { return fail(); } }, {
    get nested() { reads.push("nested"); return true; }
  }), "value");
  assert.deepEqual(reads, ["by", "at", "nested"]);
  script.doc.destroy();
});

test("creation refuses invalid input, noncanonical stamps, title placement and corrupt sibling ranks", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  const input = commentInput("anchor");
  unchangedRecord(script, () => createNativeComment(script, { ...input, body: "\ud800" }), "value");
  unchangedRecord(script, () => createNativeComment(script, { ...input, createdAt: "12" }), "value");
  unchangedRecord(script, () => createNativeReply(script, COMMENT.comment, { ...replyInput("unused"), createdAt: "12" }), "value");
  unchangedRecord(script, () => resolveNativeComment(script, COMMENT, { ...RESOLUTION, at: "12" }), "value");
  unchangedRecord(script, () => createNativeComment(script, { ...input, field: "title" }), "missing");
  const title = { ...input, field: "title" as const, rowId: null, anchorId: null };
  const created = expectedMint(script, "c");
  assert.deepEqual(createNativeComment(script, title), { ...WRITTEN, created });
  script.roots.meta.delete("title");
  unchangedRecord(script, () => createNativeComment(script, title), "missing");
  script.roots.comments.get(COMMENT.comment)?.set("rank", "0");
  unchangedRecord(script, () => createNativeComment(script, input), "stored");
  script.doc.destroy();
});

test("malformed stored extras and removed or mismatched reply records refuse", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  script.roots.beats.get("A")?.set("extra", "[]");
  unchangedRecord(script, () => setNativeField(script, beatField("A", "note"), "value"), "stored");
  const reply = script.roots.replies.get(replyId(REPLY.comment, REPLY.reply));
  assert.ok(reply);
  reply.set("commentId", "different-parent");
  unchangedRecord(script, () => removeNativeComment(script, REPLY), "missing");
  reply.set("commentId", COMMENT.comment);
  assert.deepEqual(removeNativeComment(script, REPLY), WRITTEN);
  unchangedRecord(script, () => setNativeCommentBody(script, REPLY, AUTHOR, "hidden"), "missing");
  script.doc.destroy();
});

test("a minted ID already held by a flagged record refuses for both comments and replies", () => {
  const { scripts: [writer, peer], net } = recordCopies();
  assert.ok(writer && peer);
  peer.roots.comments.set(expectedMint(writer, "c"), new Y.Map([["removed", true]]));
  peer.roots.replies.set(replyId(COMMENT.comment, expectedMint(writer, "rp")), new Y.Map([["removed", true]]));
  net.settle();
  unchangedRecord(writer, () => createNativeComment(writer, commentInput("anchor")), "taken");
  unchangedRecord(writer, () => createNativeReply(writer, COMMENT.comment, replyInput("unused")), "taken");
  for (const script of [writer, peer]) script.doc.destroy();
});

test("a record, visual or order entry lost during beforeTransaction refuses a warm target", () => {
  for (const missing of ["record", "visual", "order"]) {
    const { scripts: [writer, peer] } = recordCopies();
    assert.ok(writer && peer);
    assert.ok(writer.reader.row("B"));
    if (missing === "record") (peer.roots.beats as Y.Map<unknown>).set("B", new Y.Text());
    if (missing === "visual") peer.roots.visuals.delete("B");
    if (missing === "order") peer.roots.order.delete(0);
    const update = fullUpdate(peer);
    writer.doc.once("beforeTransaction", () => Y.applyUpdate(writer.doc, update, "remote"));
    assert.deepEqual(setNativeField(writer, beatField("B", "status"), "ready"), { kind: "refused", reason: "missing" }, missing);
    assert.deepEqual(fullUpdate(writer), update, missing);
    for (const script of [writer, peer]) script.doc.destroy();
  }
});

test("as built: an actor whose name equals the stored author can change the whole body", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  assert.deepEqual(setNativeCommentBody(script, COMMENT, "Alice", "same name"), WRITTEN);
  assert.equal(script.reader.document().comments[0]?.body, "same name");
  script.doc.destroy();
});

test("a peer removal arriving in beforeTransaction leaves the stale field command with no write", () => {
  const { scripts: [writer, remover] } = recordCopies();
  assert.ok(writer && remover);
  assert.equal(writer.reader.row("B")?.audioText, "bravo");
  assert.deepEqual(removeNativeRows(remover, ["B"]), WRITTEN);
  const removal = fullUpdate(remover);
  writer.doc.once("beforeTransaction", () => Y.applyUpdate(writer.doc, removal, "remote"));
  assert.deepEqual(setNativeField(writer, beatField("B", "status"), "shot"), { kind: "refused", reason: "missing" });
  assert.deepEqual(fullUpdate(writer), removal);
  assert.equal(writer.reader.row("B"), null);
  for (const script of [writer, remover]) script.doc.destroy();
});
