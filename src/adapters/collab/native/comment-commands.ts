import * as Y from "yjs";
import { isValidNativeRank, nativeRankBetween } from "./rank.ts";
import { nativeLiveRecord } from "./record-commands.ts";
import { RECORD_UNCHANGED, RECORD_WRITTEN, refuseRecord, transactRecord, writeRecordFields } from "./record-values.ts";
import type { NativeRecordOutcome } from "./record-values.ts";
import type { NativeScript } from "./script.ts";
import { decodeNativeValue, encodeNativeValue, nativeFieldKey, nativeWellFormed } from "./values.ts";

export interface NativeCommentTarget {
  readonly comment: string;
  readonly reply?: string;
}

export interface NativeNewReply {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface NativeNewComment extends NativeNewReply {
  readonly field: "title" | "audioText" | "visualText" | "visualImage";
  readonly rowId: string | null;
  readonly anchorId: string | null;
  readonly quotedText: string;
}

export interface NativeCommentResolution {
  readonly by: string;
  readonly at: string;
}

const BODY = nativeFieldKey("body"), AUTHOR = nativeFieldKey("author"), RESOLVED = nativeFieldKey("resolved");
const RESOLVED_BY = nativeFieldKey("resolvedBy"), RESOLVED_AT = nativeFieldKey("resolvedAt");

function named(value: unknown): value is string {
  return nativeWellFormed(value) && !!value.trim();
}

function timestamp(value: unknown): value is string {
  return named(value) && Number.isFinite(Date.parse(value));
}

function fieldsOf(input: NativeNewReply) {
  const { id, author, body, createdAt } = input;
  return { id, author, body, createdAt };
}

function validNew(input: NativeNewReply): boolean {
  return named(input.id) && named(input.author) && nativeWellFormed(input.body) && timestamp(input.createdAt);
}

function insertRecord(root: Y.Map<Y.Map<unknown>>, key: string, fields: Record<string, unknown>, parent?: string): NativeRecordOutcome {
  if (root.has(key)) return refuseRecord("taken");
  let last: string | null = null;
  for (const record of root.values()) {
    if (!(record instanceof Y.Map)) return refuseRecord("stored");
    if (record.get("removed") === true) continue;
    if (parent !== undefined && record.get("commentId") !== parent) continue;
    const rank: unknown = record.get("rank");
    if (!isValidNativeRank(rank)) return refuseRecord("stored");
    if (last === null || rank > last) last = rank;
  }
  const rank = nativeRankBetween(last, null);
  const entries = Object.entries(fields).map(([field, value]) => [nativeFieldKey(field), encodeNativeValue(value)] as const);
  const record = new Y.Map<unknown>();
  root.set(key, record);
  record.set("rank", rank);
  if (parent !== undefined) record.set("commentId", parent);
  for (const [field, value] of entries) record.set(field, value);
  return RECORD_WRITTEN;
}

function replyKey(comment: string, reply: string): string {
  return JSON.stringify([comment, reply]);
}

export function createNativeComment(script: NativeScript, comment: NativeNewComment): NativeRecordOutcome {
  return transactRecord(script, () => {
    const base = fieldsOf(comment), { field, rowId, anchorId, quotedText } = comment;
    return { ...base, field, rowId, anchorId, quotedText };
  }, input => {
    const { id, field, rowId, anchorId, quotedText, ...base } = input;
    if (!validNew(input) || !nativeWellFormed(quotedText)) return refuseRecord("value");
    if (field === "title") {
      if (rowId !== null || anchorId !== null || !(script.roots.meta.get("title") instanceof Y.Text)) return refuseRecord("missing");
    } else {
      if (field !== "audioText" && field !== "visualText" && field !== "visualImage") return refuseRecord("value");
      if (!named(rowId) || !named(anchorId) || !nativeLiveRecord(script, "beat", rowId)) return refuseRecord("missing");
    }
    return insertRecord(script.roots.comments, id, {
      ...base, field, rowId, anchorId, quotedText, kind: "anchor", assignee: "", updatedAt: base.createdAt,
      resolved: false, resolvedAt: null, resolvedBy: null
    });
  });
}

export function createNativeReply(script: NativeScript, comment: string, reply: NativeNewReply): NativeRecordOutcome {
  return transactRecord(script, () => fieldsOf(reply), input => {
    if (!validNew(input)) return refuseRecord("value");
    if (!findRecord(script, { comment })) return refuseRecord("missing");
    const { id, ...fields } = input;
    return insertRecord(script.roots.replies, replyKey(comment, id), fields, comment);
  });
}

function readTarget(target: NativeCommentTarget): NativeCommentTarget {
  const { comment, reply } = target;
  return reply === undefined ? { comment } : { comment, reply };
}

function findRecord(script: NativeScript, { comment, reply }: NativeCommentTarget) {
  if (!named(comment)) return null;
  const parent = script.roots.comments.get(comment);
  if (!(parent instanceof Y.Map) || parent.get("removed") === true) return null;
  if (reply === undefined) return parent;
  if (!named(reply)) return null;
  const root = script.roots.replies, key = replyKey(comment, reply), record = root.get(key);
  return record instanceof Y.Map && record.get("commentId") === comment && record.get("removed") !== true ? record : null;
}

export function setNativeCommentBody(script: NativeScript, target: NativeCommentTarget, actor: string, body: string): NativeRecordOutcome {
  return transactRecord(script, () => readTarget(target), input => {
    const found = findRecord(script, input);
    if (!found) return refuseRecord("missing");
    if (!nativeWellFormed(body)) return refuseRecord("value");
    if (!named(actor) || decodeNativeValue(found.get(AUTHOR))?.value !== actor) return refuseRecord("author");
    return writeRecordFields(found, { [BODY]: body });
  });
}

export function resolveNativeComment(script: NativeScript, target: NativeCommentTarget, resolution: NativeCommentResolution): NativeRecordOutcome {
  return transactRecord(script, () => {
    const copied = readTarget(target), { by, at } = resolution;
    return { target: copied, by, at };
  }, ({ target: copied, by, at }) => {
    const found = findRecord(script, copied);
    if (!found) return refuseRecord("missing");
    if (!named(by) || !timestamp(at)) return refuseRecord("value");
    if (decodeNativeValue(found.get(RESOLVED))?.value === true) return RECORD_UNCHANGED;
    return writeRecordFields(found, { [RESOLVED]: true, [RESOLVED_BY]: by, [RESOLVED_AT]: at });
  });
}

export function reopenNativeComment(script: NativeScript, target: NativeCommentTarget): NativeRecordOutcome {
  return transactRecord(script, () => readTarget(target), input => {
    const found = findRecord(script, input);
    if (!found) return refuseRecord("missing");
    if (decodeNativeValue(found.get(RESOLVED))?.value !== true) return RECORD_UNCHANGED;
    return writeRecordFields(found, { [RESOLVED]: false, [RESOLVED_BY]: null, [RESOLVED_AT]: null });
  });
}

export function removeNativeComment(script: NativeScript, target: NativeCommentTarget): NativeRecordOutcome {
  return transactRecord(script, () => readTarget(target), input => {
    const found = findRecord(script, input);
    if (!found) return refuseRecord("missing");
    found.set("removed", true);
    return RECORD_WRITTEN;
  });
}
