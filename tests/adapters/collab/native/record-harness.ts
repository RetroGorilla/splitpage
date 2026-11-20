import assert from "node:assert/strict";
import * as Y from "yjs";
import { migrateRows, withDocumentPorts } from "../../../../src/bootstrap/document-ports.ts";
import { STATE_FIELDS } from "../../../../src/core/document/fields.ts";
import {
  createNativeComment as createComment, createNativeReply as createReply, removeNativeComment, reopenNativeComment,
  resolveNativeComment, setNativeCommentBody as setBody
} from "../../../../src/adapters/collab/native/comment-commands.ts";
import type { NativeCommentTarget, NativeNewComment, NativeNewReply } from "../../../../src/adapters/collab/native/comment-commands.ts";
import { clearNativeField, setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import type { NativeFieldTarget } from "../../../../src/adapters/collab/native/record-commands.ts";
import type { NativeRecordOutcome } from "../../../../src/adapters/collab/native/record-values.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { convertedScript, joinedScript, ScriptNet } from "./helpers.ts";
import { testNativeUndo } from "./undo-harness.ts";
import type { TestNativeUndo } from "./undo-harness.ts";

export const AT = "2026-11-19T01:02:03.000Z";
export const AUTHOR = "Alice";
export const RESOLUTION = { by: "Bob", at: AT };
export const COMMENT = { comment: "thread" };
export const REPLY = { ...COMMENT, reply: "answer" };
export const IMAGE = { sha256: "a".repeat(64), mime: "image/png", width: 10, height: 20 };

export const BODY_PORTS = { sanitize: (html: string): string => withDocumentPorts(STATE_FIELDS, ports => ports.sanitize(html)) };
export const createNativeComment = (script: NativeScript, input: NativeNewComment) => createComment(script, input, BODY_PORTS);
export const createNativeReply = (script: NativeScript, comment: string, input: NativeNewReply) => createReply(script, comment, input, BODY_PORTS);
export const setNativeCommentBody = (script: NativeScript, target: NativeCommentTarget, actor: string, body: string) => setBody(script, target, actor, body, BODY_PORTS);

export const beatField = (id: string, field: string): NativeFieldTarget => ({ kind: "beat", id, field });
export const headingField = (field: string): NativeFieldTarget => ({ kind: "heading", id: "H", field });
export const fileKey = (field: string): string => "f:" + JSON.stringify(field);
export const replyId = (comment: string, reply: string): string => JSON.stringify([comment, reply]);
export function expectedMint(script: NativeScript, prefix: string): string {
  const client = script.doc.clientID;
  const clock = Y.decodeStateVector(Y.encodeStateVector(script.doc)).get(client) ?? 0;
  return prefix + client.toString(36) + "-" + clock.toString(36);
}
export const replyInput = (id: string, body = "reply") => ({ id, author: AUTHOR, body, createdAt: AT });
export const commentInput = (id: string, body = "original") => ({
  ...replyInput(id, body), field: "audioText" as const, rowId: "A", anchorId: id, quotedText: "alpha"
});

export function recordCopies(ids: readonly number[] = [4, 9]) {
  const seed = convertedScript(migrateRows({
    schema: 2, title: "Records", docId: "records", rev: 0,
    rows: Object.entries({ A: "alpha", B: "bravo", C: "charlie", D: "delta", E: "echo", F: "foxtrot" })
      .map(([id, audioText]) => ({ id, audioText, visualText: "" })),
    sections: [{ id: "H", name: "Scene", firstSceneId: "C" }],
    comments: [{
      ...commentInput("thread"), replies: [replyInput("answer")], resolved: false, kind: "anchor"
    }],
    people: [{ id: "assigned", name: "Someone else" }], productionTags: [], brollShots: []
  }));
  const scripts = ids.map(id => joinedScript(seed, id));
  seed.doc.destroy();
  return { scripts, net: new ScriptNet(scripts) };
}

function stored(value: unknown): unknown {
  if (value instanceof Y.Text) return value.toDelta();
  if (value instanceof Y.Array) return value.toArray().map(stored);
  if (value instanceof Y.Map) return Object.fromEntries([...value.entries()].map(([key, item]) => [key, stored(item)]));
  return value;
}

export type RecordSnapshot = Record<string, Record<string, unknown>>;

export function recordSnapshot(script: NativeScript): RecordSnapshot {
  return structuredClone(Object.fromEntries(Object.entries(script.roots).map(([root, value]) => [root, stored(value)]))) as RecordSnapshot;
}

export function recordRead(script: NativeScript) {
  return { rows: script.reader.rows(), outline: script.reader.outline(), document: script.reader.document() };
}

export const fullUpdate = (script: NativeScript): Uint8Array => Y.encodeStateAsUpdate(script.doc);

export function unchangedRecord(script: NativeScript, run: () => NativeRecordOutcome, reason?: string): void {
  const before = fullUpdate(script);
  assert.deepEqual(run(), reason ? { kind: "refused", reason } : { kind: "unchanged" });
  assert.deepEqual(fullUpdate(script), before);
}

export function recordUndo(script: NativeScript): TestNativeUndo { return testNativeUndo(script); }

export function freshRecordRead(script: NativeScript) {
  const doc = new Y.Doc(), handle = openNativeScript(doc);
  Y.applyUpdate(doc, fullUpdate(script));
  try { return recordRead(handle); } finally { doc.destroy(); }
}

export type RecordTestRead = ReturnType<typeof recordRead>;
type Read = RecordTestRead;
type Fields = Record<string, unknown>;

export interface RecordStep {
  readonly name: string;
  readonly run: (script: NativeScript) => NativeRecordOutcome;
  readonly expect: (snapshot: RecordSnapshot, read: Read, writer: NativeScript) => string | undefined;
}

function filePatch(record: Fields, patch: Fields): void {
  for (const [key, value] of Object.entries(patch)) record[fileKey(key)] = JSON.stringify(value);
}

function collection(snapshot: RecordSnapshot, root: string): Fields {
  const entries = snapshot[root];
  assert.ok(entries, root);
  return entries;
}

function item(snapshot: RecordSnapshot, root: string, id: string): Fields {
  const entry = collection(snapshot, root)[id];
  assert.ok(entry && typeof entry === "object", root + "/" + id);
  return entry as Fields;
}

export function beatStep(field: string, value: unknown, id = "A"): RecordStep {
  const clear = value === undefined, target = beatField(id, field);
  return {
    name: (clear ? "clear beat " : "set beat ") + field,
    run: script => clear ? clearNativeField(script, target) : setNativeField(script, target, value),
    expect(snapshot, read) {
      const record = item(snapshot, "beats", id);
      if (field === "status" || field === "lengthSeconds" || field === "paragraphStart" || field === "extra") {
        if (clear) Reflect.deleteProperty(record, field);
        else record[field] = JSON.stringify(value);
      } else {
        const extra = JSON.parse(String(record.extra ?? "{}")) as Fields;
        if (clear) Reflect.deleteProperty(extra, field);
        else extra[field] = value;
        record.extra = JSON.stringify(extra);
      }
      const row = read.rows.find(row => row.id === id), file = read.document.rows.find(row => row.id === id);
      assert.ok(row && file);
      const fields = row.fields as Fields;
      for (const view of [fields, file]) {
        if (field === "extra") {
          for (const key of Object.keys(view)) if (!["id", "audioText", "visualText", "status", "lengthSeconds", "paragraphStart", "updatedBy", "updatedAt"].includes(key)) Reflect.deleteProperty(view, key);
          if (!clear) Object.assign(view, value);
        } else if (clear) Reflect.deleteProperty(view, field);
        else view[field] = value;
      }
      return undefined;
    }
  };
}

export function threadSteps(anchor: string, rank: string, body = "new body", ids = { comment: "", reply: "" }, replyAuthor = AUTHOR): RecordStep[] {
  const target = () => ({ comment: ids.comment }), reply = () => ({ ...target(), reply: ids.reply });
  const key = () => replyId(ids.comment, ids.reply);
  const comment = commentInput(anchor), newReply = { ...replyInput("unused"), author: replyAuthor };
  const commentFields = {
    author: comment.author, body: comment.body, createdAt: AT, updatedAt: AT, field: comment.field, rowId: comment.rowId,
    anchorId: comment.anchorId, quotedText: comment.quotedText, kind: "anchor", assignee: "", resolved: false, resolvedBy: null, resolvedAt: null
  };
  const replyFields = { author: newReply.author, body: newReply.body, createdAt: AT };
  const find = (read: Read) => {
    const found = read.document.comments.find(record => record.id === ids.comment);
    assert.ok(found);
    return found;
  };
  const patchStep = (onReply: boolean, name: string, run: RecordStep["run"], patch: Fields): RecordStep => ({
    name: name + (onReply ? " reply" : " comment"), run,
    expect(snapshot, read) {
      filePatch(item(snapshot, onReply ? "replies" : "comments", onReply ? key() : ids.comment), patch);
      const parent = find(read), entry = onReply ? parent.replies?.find(record => record.id === ids.reply) : parent;
      assert.ok(entry);
      Object.assign(entry, patch);
      return undefined;
    }
  });
  return [
    {
      name: "create comment", run: script => createNativeComment(script, comment),
      expect(snapshot, read, writer) {
        const id = expectedMint(writer, "c");
        ids.comment = id;
        const record = { rank };
        filePatch(record, commentFields);
        collection(snapshot, "comments")[id] = record;
        read.document.comments.push({ ...commentFields, id, replies: [] });
        return id;
      }
    },
    {
      name: "create reply", run: script => createNativeReply(script, ids.comment, newReply),
      expect(snapshot, read, writer) {
        const id = expectedMint(writer, "rp");
        ids.reply = id;
        const record = { rank: "V00000V", commentId: ids.comment };
        filePatch(record, replyFields);
        collection(snapshot, "replies")[key()] = record;
        const replies = find(read).replies;
        assert.ok(replies);
        replies.push({ ...replyFields, id });
        return id;
      }
    },
    ...[false, true].flatMap(onReply => {
      const subject = onReply ? reply : target;
      return [
        patchStep(onReply, "body", script => setNativeCommentBody(script, subject(), onReply ? replyAuthor : AUTHOR, body), { body }),
        patchStep(onReply, "resolve", script => resolveNativeComment(script, subject(), RESOLUTION), {
          resolved: true, resolvedBy: RESOLUTION.by, resolvedAt: AT
        }),
        patchStep(onReply, "reopen", script => reopenNativeComment(script, subject()), { resolved: false, resolvedBy: null, resolvedAt: null })
      ];
    }),
    {
      name: "remove reply", run: script => removeNativeComment(script, reply()),
      expect(snapshot, read) {
        item(snapshot, "replies", key()).removed = true;
        find(read).replies = [];
        return undefined;
      }
    },
    {
      name: "remove comment", run: script => removeNativeComment(script, target()),
      expect(snapshot, read) {
        item(snapshot, "comments", ids.comment).removed = true;
        read.document.comments = read.document.comments.filter(record => record.id !== ids.comment);
        return undefined;
      }
    }
  ];
}

export function checkRecordStep(script: NativeScript, step: RecordStep, run = () => step.run(script)): { before: RecordSnapshot; expected: RecordSnapshot } {
  const snapshot = recordSnapshot(script), read = structuredClone(recordRead(script));
  const before = structuredClone(snapshot);
  const created = step.expect(snapshot, read, script);
  assert.deepEqual(run(), { kind: "written", ...created ? { created } : {} }, step.name + ": outcome");
  assert.deepEqual(recordSnapshot(script), snapshot, step.name + ": stored snapshot");
  assert.deepEqual(recordRead(script), read, step.name + ": projected document");
  return { before, expected: snapshot };
}
