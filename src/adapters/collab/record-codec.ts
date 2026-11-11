import * as Y from "yjs";
import type { SharedRecordCollection } from "../../core/collab/operations.ts";
import { TAG_CATEGORY_IDS, TAG_STATUS_IDS } from "../../core/document/tags.ts";
import { BROLL_STATUS_IDS, brollPropKey } from "../../core/document/broll.ts";
import { normalizeMarks, videoLinkKey } from "../../core/document/gallery.ts";
import type { VideoLink } from "../../core/document/gallery.ts";
import { normalizeImageRef } from "../../../shared/blob-policy.ts";
import { sharedJson } from "./snapshot.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";

interface RecordFieldSource {
  readonly keys: () => readonly string[];
  readonly get: (field: string) => unknown;
  readonly child: (field: string) => RecordFieldSource | null;
}
function nativeSource(raw: unknown): RecordFieldSource | null {
  if (!(raw instanceof Y.Map)) return null;
  const source: Y.Map<unknown> = raw;
  return { keys: () => [...source.keys()].sort(), get: field => source.get(field), child: field => nativeSource(source.get(field)) };
}
function preparedSource(view: Pick<SharedPreparationView, "get" | "kind" | "keys">, path: readonly string[]): RecordFieldSource | null {
  if (view.kind(path) !== "map") return null;
  return { keys: () => view.keys(path), get: field => view.get([...path, field]), child: field => preparedSource(view, [...path, field]) };
}

export const sharedRecordFields = Object.freeze({
  comments: Object.freeze(["id", "rowId", "field", "anchorId", "author", "createdAt", "updatedAt", "assignee", "kind", "imageValue", "conflictField", "emptyValue", "titleValue", "text", "quote", "resolution", "rank", "extra"]),
  replies: Object.freeze(["id", "commentId", "author", "createdAt", "text", "rank", "extra"]),
  people: Object.freeze(["id", "name", "rank", "extra"]),
  tags: Object.freeze(["id", "cat", "name", "owner", "notes", "status", "rank", "extra"]),
  shots: Object.freeze(["id", "name", "desc", "status", "reshoot", "notes", "audioRef", "location", "owner", "origin", "props", "rank", "extra"]),
  gallery: Object.freeze(["beat", "rank", "picture", "links", "extra"]),
  visuals: Object.freeze(["beat", "rank", "extra"])
});

function bag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
function image(value: unknown): boolean {
  return bag(value) && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)
    && (Object.keys(value).length === 1 || normalizeImageRef(value) !== null);
}
function timestamp(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function extra(value: unknown): boolean {
  try { return typeof value === "string" && bag(JSON.parse(value) as unknown); } catch { return false; }
}

function identity(value: unknown): value is string { return typeof value === "string" && isStableSharedIdentity(value); }

export function sharedRecordFieldAccepted(kind: SharedRecordCollection, field: string, value: unknown): boolean {
  if (sharedJson(value) === undefined) return false;
  if (!isStableSharedIdentity(field) || kind === "visuals" && ["text", "html", "markRecords"].includes(field)) return false;
  if (field === "id") return identity(value) && value.length > 0;
  if (!(sharedRecordFields[kind] as readonly string[]).includes(field)) return !(kind === "comments" && ["body", "quotedText", "resolved", "resolvedAt", "resolvedBy", "replies"].includes(field)
    || kind === "replies" && field === "body");
  if (field === "extra") return extra(value);
  if (isSharedRecordNestedField(kind, field)) return readSharedNestedInput(field, value) !== null;
  if (["commentId", "beat"].includes(field)) return identity(value) && value.length > 0;
  if (["author", "assignee", "owner"].includes(field)) return identity(value);
  if (field === "createdAt" || field === "updatedAt") return timestamp(value);
  if (field === "rowId" || field === "anchorId") return value === null || identity(value);
  if (field === "field") return typeof value === "string" && ["audioText", "visualText", "visualImage", "title"].includes(value);
  if (kind === "comments" && field === "kind") return value === "anchor" || value === "conflict";
  if (field === "status") return typeof value === "string" && (kind === "tags" ? TAG_STATUS_IDS as readonly string[] : BROLL_STATUS_IDS).includes(value);
  if (field === "cat") return typeof value === "string" && (TAG_CATEGORY_IDS as readonly string[]).includes(value);
  if (field === "origin") return value === "script" || value === "list";
  if (field === "reshoot" || field === "emptyValue") return typeof value === "boolean";
  if (field === "imageValue") return value === null || image(value);
  if (field === "resolution") return bag(value) && typeof value.resolved === "boolean"
    && Object.keys(value).every(key => key === "resolved" || key === "resolvedAt" || key === "resolvedBy")
    && (value.resolvedAt === undefined || value.resolvedAt === null || typeof value.resolvedAt === "string")
    && (value.resolvedBy === undefined || value.resolvedBy === null || identity(value.resolvedBy));
  if (field === "picture") return bag(value) && Object.keys(value).every(key => ["imageRef", "name", "annotation"].includes(key))
    && (value.imageRef === undefined || value.imageRef === null || image(value.imageRef))
    && (value.name === undefined || typeof value.name === "string")
    && (value.annotation === undefined || value.annotation === null || bag(value.annotation) && image(value.annotation.imageRef)
      && Array.isArray(value.annotation.marks)
      && JSON.stringify(sharedJson(normalizeMarks(value.annotation.marks))) === JSON.stringify(value.annotation.marks));
  return typeof value === "string";
}

export function isSharedRecordNestedField(kind: SharedRecordCollection, field: string): field is "links" | "props" {
  return kind === "gallery" && field === "links" || kind === "shots" && field === "props";
}

export function readSharedNestedInput(field: "links" | "props", input: unknown): [string, Record<string, unknown>][] | null {
  if (!Array.isArray(input)) return null;
  const entries: [string, Record<string, unknown>][] = [], seen = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const value = sharedJson(input[index]);
    if (!bag(value)) return null;
    if (Object.hasOwn(value, "rank") || Object.hasOwn(value, "extra") || Object.keys(value).some(key => !isStableSharedIdentity(key))) return null;
    let key: string;
    if (field === "props") {
      if (!identity(value.id) || typeof value.name !== "string" || !value.id && !identity(value.name)) return null;
      key = brollPropKey(value.id, value.name);
    } else {
      if (Object.hasOwn(value, "location")) return null;
      if (value.href !== undefined && (typeof value.href !== "string" || !/^https?:\/\//i.test(value.href))) return null;
      if (value.href === undefined && (typeof value.name !== "string" || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)) return null;
      if (value.name !== undefined && typeof value.name !== "string" || value.size !== undefined && (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)
        || value.duration !== undefined && (typeof value.duration !== "number" || value.duration < 0 || value.duration > 1e7)
        || value.poster !== undefined && typeof value.poster !== "boolean") return null;
      key = videoLinkKey(value as VideoLink);
    }
    if (!isStableSharedIdentity(key) || seen.has(key)) return null;
    seen.add(key); entries.push([key, value]);
  }
  return entries;
}

function nested(field: "links" | "props", raw: RecordFieldSource | null): unknown[] | null {
  if (!raw) return null;
  const entries: { key: string; rank: string; fields: Record<string, unknown> }[] = [];
  for (const key of raw.keys()) {
    if (!isStableSharedIdentity(key)) continue;
    const source = raw.child(key);
    if (!source) continue;
    if (source.keys().some(field => !isStableSharedIdentity(field))) continue;
    const rank: unknown = source.get("rank");
    if (typeof rank !== "string") continue;
    const value = field === "props" ? sharedJson(source.get("value")) : sharedJson(Object.fromEntries(source.keys().filter(key => key !== "rank" && key !== "extra").map(key => [key, source.get(key)])));
    const validated = readSharedNestedInput(field, [value]);
    if (!validated || validated[0]?.[0] !== key) continue;
    const fields: [string, unknown][] = [];
    for (const name of field === "props" ? ["id", "name"] : ["href", "name", "size", "duration", "poster"]) {
      if (bag(value) && Object.hasOwn(value, name)) fields.push([name, value[name]]);
    }
    if (bag(value)) for (const name of Object.keys(value).sort()) if (!fields.some(([key]) => key === name)) fields.push([name, value[name]]);
    fields.push(["rank", rank]);
    if (extra(source.get("extra"))) fields.push(["extra", source.get("extra")]);
    entries.push({ key, rank, fields: Object.fromEntries(fields) });
  }
  return entries.sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(entry => ({ key: entry.key, fields: entry.fields }));
}

function readRecordFields(kind: SharedRecordCollection, key: string, raw: RecordFieldSource | null): Record<string, unknown> | null {
  if (!raw || !key || !isStableSharedIdentity(key)) return null;
  const output: [string, unknown][] = [], known: readonly string[] = sharedRecordFields[kind], keys = raw.keys();
  if (keys.some(field => !isStableSharedIdentity(field))) return null;
  for (const field of [...known, ...keys.filter(field => !known.includes(field) && !(kind === "visuals" && ["text", "html", "markRecords"].includes(field))).sort()]) {
    if (!keys.includes(field)) continue;
    const nestedField = isSharedRecordNestedField(kind, field);
    const value = nestedField ? nested(field, raw.child(field)) : sharedJson(raw.get(field));
    if (nestedField ? value === null : !sharedRecordFieldAccepted(kind, field, value)) return null;
    output.push([field, value]);
  }
  const value = Object.fromEntries(output);
  const required = kind === "comments" ? ["id", "author"] : kind === "replies" ? ["id", "commentId", "author"]
    : kind === "people" ? ["id", "name"] : kind === "tags" ? ["id", "cat", "name"] : kind === "shots" ? ["id"] : ["beat", "rank"];
  if (required.some(field => typeof value[field] !== "string")) return null;
  if (kind === "replies" ? key !== JSON.stringify([value.commentId, value.id]) : value.id !== undefined && value.id !== key) return null;
  return value;
}

export function readStoredSharedRecord(kind: SharedRecordCollection, key: string, raw: unknown): Record<string, unknown> | null {
  return readRecordFields(kind, key, nativeSource(raw));
}
export function readPreparedSharedRecord(kind: SharedRecordCollection, key: string, view: Pick<SharedPreparationView, "get" | "kind" | "keys">): Record<string, unknown> | null {
  return readRecordFields(kind, key, preparedSource(view, [kind, key]));
}
