import * as Y from "yjs";
import { cappedText, plainName, plainText, textOf } from "../../../core/document/text-policy.ts";
import { isValidNativeRank, nativeRankBetween } from "./rank.ts";
import { nativeLiveBeatRecord } from "./record-commands.ts";
import { copyArgument, nativeRecordId, plainRecordArgument, RECORD_UNCHANGED, RECORD_WRITTEN, refuseRecord, transactRecord, writeRecordFields } from "./record-values.ts";
import type { NativeRecordOutcome } from "./record-values.ts";
import type { NativeScript } from "./script.ts";
import { decodeNativeValue, encodeNativeValue, mintNativeId, nativeFieldKey, nativeWellFormed } from "./values.ts";

export interface NativeCommentTarget {
  readonly comment: string;
  readonly reply?: string;
}

export interface NativeNewReply {
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

export interface NativeCommentBodyPorts {
  readonly sanitize: (html: string) => string;
}

export type NativeThreadCreation = { readonly kind: "written"; readonly created: string } | Extract<NativeRecordOutcome, { kind: "refused" }>;

const BODY = nativeFieldKey("body"), AUTHOR = nativeFieldKey("author"), RESOLVED = nativeFieldKey("resolved");
const RESOLVED_BY = nativeFieldKey("resolvedBy"), RESOLVED_AT = nativeFieldKey("resolvedAt");

function named(value: unknown): value is string {
  return nativeWellFormed(value) && !!value.trim();
}

function timestamp(value: unknown): value is string {
  if (!nativeWellFormed(value)) return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}

function fieldsOf(input: NativeNewReply) {
  if (!plainRecordArgument(input)) throw new TypeError("Expected a plain reply");
  const { author, body, createdAt } = input;
  return { author, body, createdAt };
}

function validNew(input: NativeNewReply): boolean {
  return named(input.author) && plainName(input.author) === input.author && timestamp(input.createdAt);
}

function copyBodyArguments<T>(read: () => T, ports: NativeCommentBodyPorts) {
  const input = copyArgument(read), sanitize = copyArgument(() => ports.sanitize);
  return input && sanitize ? { value: { input: input.value, sanitize: sanitize.value } } : null;
}

function keptBody(body: unknown, sanitize: NativeCommentBodyPorts["sanitize"]): boolean {
  return nativeWellFormed(body) && copyArgument(() => sanitize(textOf(body)))?.value === body;
}

function insertRecord(root: Y.Map<Y.Map<unknown>>, key: string, fields: Record<string, unknown>, parent?: string): Extract<NativeRecordOutcome, { kind: "refused" }> | null {
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
  return null;
}

function replyKey(comment: string, reply: string): string {
  return JSON.stringify([comment, reply]);
}

export function createNativeComment(script: NativeScript, comment: NativeNewComment, ports: NativeCommentBodyPorts): NativeThreadCreation {
  return transactRecord(script, () => copyBodyArguments(() => {
    const base = fieldsOf(comment), { field, rowId, anchorId, quotedText } = comment;
    return { ...base, field, rowId, anchorId, quotedText };
  }, ports), ({ input, sanitize }) => {
    const id = mintNativeId(script.doc, "c"), { field, rowId, anchorId, quotedText, ...base } = input;
    if (!validNew(input) || !keptBody(base.body, sanitize) || !nativeWellFormed(quotedText) || plainText(quotedText) !== quotedText) return refuseRecord("value");
    if (field === "title") {
      if (rowId !== null || anchorId !== null || !(script.roots.meta.get("title") instanceof Y.Text)) return refuseRecord("missing");
    } else {
      if (field !== "audioText" && field !== "visualText" && field !== "visualImage") return refuseRecord("value");
      if (!nativeRecordId(rowId) || !nativeRecordId(anchorId) || !nativeLiveBeatRecord(script, rowId)) return refuseRecord("missing");
      const anchor = script.reader.commentAnchor(anchorId);
      if (anchor && (anchor.rowId !== rowId || anchor.field !== field)) return refuseRecord("anchor");
    }
    return insertRecord(script.roots.comments, id, {
      ...base, field, rowId, anchorId, quotedText, kind: "anchor", assignee: "", updatedAt: base.createdAt,
      resolved: false, resolvedAt: null, resolvedBy: null
    }) ?? Object.freeze({ kind: "written", created: id });
  });
}

export function createNativeReply(script: NativeScript, comment: string, reply: NativeNewReply, ports: NativeCommentBodyPorts): NativeThreadCreation {
  return transactRecord(script, () => copyBodyArguments(() => fieldsOf(reply), ports), ({ input, sanitize }) => {
    const id = mintNativeId(script.doc, "rp");
    if (!validNew(input) || !keptBody(input.body, sanitize)) return refuseRecord("value");
    if (!findRecord(script, { comment })) return refuseRecord("missing");
    return insertRecord(script.roots.replies, replyKey(comment, id), input, comment) ?? Object.freeze({ kind: "written", created: id });
  });
}

function readTarget(target: NativeCommentTarget): NativeCommentTarget {
  if (!plainRecordArgument(target)) throw new TypeError("Expected a plain comment target");
  const { comment, reply } = target;
  return reply === undefined ? { comment } : { comment, reply };
}

function findRecord(script: NativeScript, { comment, reply }: NativeCommentTarget) {
  if (!nativeRecordId(comment)) return null;
  const parent = script.roots.comments.get(comment);
  if (!(parent instanceof Y.Map) || parent.get("removed") === true) return null;
  if (reply === undefined) return parent;
  if (!nativeRecordId(reply)) return null;
  const root = script.roots.replies, key = replyKey(comment, reply), record = root.get(key);
  return record instanceof Y.Map && record.get("commentId") === comment && record.get("removed") !== true ? record : null;
}

export function setNativeCommentBody(script: NativeScript, target: NativeCommentTarget, actor: string, body: string, ports: NativeCommentBodyPorts): NativeRecordOutcome {
  return transactRecord(script, () => copyBodyArguments(() => readTarget(target), ports), ({ input, sanitize }) => {
    const found = findRecord(script, input);
    if (!found) return refuseRecord("missing");
    if (!keptBody(body, sanitize)) return refuseRecord("value");
    if (!named(actor) || decodeNativeValue(found.get(AUTHOR))?.value !== actor) return refuseRecord("author");
    return writeRecordFields(found, { [BODY]: body });
  });
}

export function resolveNativeComment(script: NativeScript, target: NativeCommentTarget, resolution: NativeCommentResolution): NativeRecordOutcome {
  return transactRecord(script, () => {
    const copied = copyArgument(() => readTarget(target));
    const stamp = copyArgument(() => {
      if (!plainRecordArgument(resolution)) throw new TypeError("Expected a plain resolution");
      const { by, at } = resolution;
      return { by, at };
    });
    return copied && stamp ? { value: { target: copied.value, ...stamp.value } } : null;
  }, ({ target: copied, by, at }) => {
    const found = findRecord(script, copied);
    if (!found) return refuseRecord("missing");
    if (!named(by) || cappedText(by, 80) !== by || !timestamp(at)) return refuseRecord("value");
    if (decodeNativeValue(found.get(RESOLVED))?.value === true) return RECORD_UNCHANGED;
    return writeRecordFields(found, { [RESOLVED]: true, [RESOLVED_BY]: by, [RESOLVED_AT]: at });
  });
}

export function reopenNativeComment(script: NativeScript, target: NativeCommentTarget): NativeRecordOutcome {
  return transactRecord(script, () => copyArgument(() => readTarget(target)), input => {
    const found = findRecord(script, input);
    if (!found) return refuseRecord("missing");
    if (decodeNativeValue(found.get(RESOLVED))?.value !== true) return RECORD_UNCHANGED;
    return writeRecordFields(found, { [RESOLVED]: false, [RESOLVED_BY]: null, [RESOLVED_AT]: null });
  });
}

export function removeNativeComment(script: NativeScript, target: NativeCommentTarget): NativeRecordOutcome {
  return transactRecord(script, () => copyArgument(() => readTarget(target)), input => {
    const found = findRecord(script, input);
    if (!found) return refuseRecord("missing");
    found.set("removed", true);
    return RECORD_WRITTEN;
  });
}
