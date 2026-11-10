import { normalizeImageRef } from "../../../shared/blob-policy.ts";
import { ROW_STATUS_IDS } from "../document/timing.ts";
import { TAG_STATUS_IDS } from "../document/tags.ts";
import { BROLL_STATUS_IDS } from "../document/broll.ts";
import type { SharedContentRef, SharedMarkValue, SharedOperation } from "./operations.ts";

type OperationReader = (value: unknown) => unknown;
type OperationFields = Readonly<Record<string, OperationReader>>;

function storedString(raw: string): string { return raw.replace(/\p{Cs}/gu, "\uFFFD"); }

export function readSharedContentRef(raw: unknown): SharedContentRef | null {
  return typeof raw === "string" && raw.length > 0 ? storedString(raw) as SharedContentRef : null;
}

function object(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function need(condition: boolean): asserts condition {
  if (!condition) throw new Error("Invalid operation");
}

function ordered(entries: [string, unknown][]): Record<string, unknown> {
  const keys = new Set<string>();
  for (const [key] of entries) {
    need(!keys.has(key));
    keys.add(key);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function fields(raw: unknown, shape: OperationFields, optional: OperationFields = {}): Record<string, unknown> {
  need(object(raw));
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(shape)) {
    const read = shape[key];
    need(Object.hasOwn(raw, key) && read !== undefined);
    entries.push([key, read(raw[key])]);
  }
  for (const key of Object.keys(optional)) {
    const read = optional[key];
    if (Object.hasOwn(raw, key) && read) entries.push([key, read(raw[key])]);
  }
  for (const key of Object.keys(raw)) need(Object.hasOwn(shape, key) || Object.hasOwn(optional, key));
  return ordered(entries);
}

function oneOf(...values: readonly unknown[]): OperationReader { return raw => { need(values.includes(raw)); return raw; }; }
function string(raw: unknown): string { need(typeof raw === "string"); return storedString(raw); }
function numeric(raw: unknown): number { need(typeof raw === "number" && Number.isFinite(raw)); return raw; }
function ref(raw: unknown): SharedContentRef { const value = readSharedContentRef(raw); need(value !== null); return value; }
function nullableRef(raw: unknown): SharedContentRef | null { return raw === null ? null : ref(raw); }
function list(read: OperationReader): OperationReader {
  return raw => {
    need(Array.isArray(raw));
    const result: unknown[] = [];
    for (let index = 0; index < raw.length; index++) result.push(read(raw[index]));
    return result;
  };
}
function address(raw: unknown): unknown {
  return fields(raw, { segment: ref, owner: ref, field: oneOf("audioText", "visualText", "heading", "title") });
}
function gap(raw: unknown): unknown {
  return fields(raw, { left: nullableRef, right: nullableRef, affinity: oneOf("before", "after") });
}
function recordAddress(raw: unknown): unknown {
  return fields(raw, { collection: oneOf("comments", "replies", "people", "tags", "shots", "gallery", "visuals"), record: ref });
}
function scalarAddress(raw: unknown): unknown {
  return fields(raw, { scope: oneOf("document", "beat", "heading"), record: ref });
}
function mark(raw: unknown): unknown {
  need(object(raw));
  if (typeof raw.kind === "string" && ["b", "i", "u", "s", "hl", "dir", "cue"].includes(raw.kind)) {
    return fields(raw, { kind: oneOf("b", "i", "u", "s", "hl", "dir", "cue"), value: oneOf(true, null) });
  }
  if (raw.kind === "comment") return fields(raw, { kind: oneOf("comment"), id: ref, value: oneOf(true, null) });
  if (raw.kind === "tag") return fields(raw, { kind: oneOf("tag"), id: ref, value: nullableRef });
  return fields(raw, { kind: oneOf("link"), id: ref, value: value => value === null ? null : string(value) });
}
function image(raw: unknown): unknown {
  const result = fields(raw, { sha256: string }, { width: numeric, height: numeric, mime: string });
  need(normalizeImageRef({ width: 1, height: 1, mime: "image/png", ...result }) !== null);
  return result;
}
function inline(raw: unknown): unknown {
  if (typeof raw === "string") return string(raw);
  need(object(raw));
  if (raw.atom === "broll") return fields(raw, { atom: oneOf("broll"), id: ref });
  if (raw.atom === "who") return fields(raw, { atom: oneOf("who"), name: string });
  if (raw.atom === "image") return fields(raw, { atom: oneOf("image"), ref: image });
  return fields(raw, { atom: oneOf("video"), href: string, host: string });
}
function chunk(raw: unknown): unknown {
  const result = fields(raw, { value: inline, marks: list(mark) });
  const keys = new Set<string>();
  for (const item of result.marks as SharedMarkValue[]) {
    const key = "id" in item ? item.kind + ":" + item.id : item.kind;
    need(!keys.has(key));
    keys.add(key);
  }
  return result;
}

function normalize(raw: unknown): unknown {
  if (typeof raw === "string") return storedString(raw);
  if (Array.isArray(raw)) {
    const result: unknown[] = [];
    for (let index = 0; index < raw.length; index++) result.push(normalize(raw[index]));
    return result;
  }
  if (!object(raw)) return raw;
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(raw)) {
    const stored = storedString(key);
    entries.push([stored, normalize(raw[key])]);
  }
  return ordered(entries);
}

function jsonFields(raw: unknown): unknown { need(object(raw)); return normalize(raw); }

function canonical(raw: unknown): unknown {
  const encoded = JSON.stringify(raw);
  return encoded === undefined ? null : JSON.parse(encoded) as unknown;
}

function readKind<K extends SharedOperation["kind"]>(raw: unknown, kind: K, shape: OperationFields, optional: OperationFields = {}): Extract<SharedOperation, { kind: K }> | null {
  try {
    const value = fields(canonical(raw), { kind: oneOf(kind), id: ref, by: string, ...shape }, optional);
    return value as unknown as Extract<SharedOperation, { kind: K }>;
  } catch { return null; }
}

export function readTextInsert(raw: unknown) {
  return readKind(raw, "text-insert", { target: address, at: gap, content: list(chunk) });
}
export function readTextDelete(raw: unknown) {
  return readKind(raw, "text-delete", { target: address, observed: list(ref) });
}
export function readMarkChange(raw: unknown) {
  return readKind(raw, "mark", { target: address, observed: list(ref), mark });
}
export function readSegmentCreate(raw: unknown) {
  return readKind(raw, "segment-create", { segment: ref, beat: ref, at: gap, fields: jsonFields });
}
export function readBeatSplit(raw: unknown) {
  return readKind(raw, "split", { target: address, at: gap, observed: list(ref), boundary: ref, beat: ref, fields: jsonFields });
}
export function readBeatSplitBefore(raw: unknown) {
  return readKind(raw, "split-before", { target: address, at: gap, observed: list(ref), boundary: ref, beat: ref, fields: jsonFields });
}
export function readBeatJoin(raw: unknown) {
  return readKind(raw, "join", { from: ref, into: ref, glue: oneOf(" ", "") });
}
export function readJoinGlue(raw: unknown) {
  return readKind(raw, "join-glue", { joins: list(ref), glue: oneOf(" ", "") });
}
export function readSoftRemove(raw: unknown) {
  return readKind(raw, "remove", { removalKind: oneOf("beat", "range", "header", "became-heading"), targets: list(ref),
    observed: list(ref), boundaries: list(ref), components: list(ref), gallery: list(ref), at: numeric });
}
export function readRestore(raw: unknown) {
  return readKind(raw, "restore", { removals: list(ref) });
}
export function readSegmentMove(raw: unknown) {
  return readKind(raw, "segment-move", { segments: list(ref), observedOrder: list(ref), at: gap });
}
export function readHeadingCreate(raw: unknown) {
  return readKind(raw, "heading-create", { segment: ref, heading: ref, firstBeat: ref, at: gap });
}
export function readHeadingFinalize(raw: unknown) {
  return readKind(raw, "heading-finalize", { target: address, heading: ref, prefix: list(ref), name: list(ref), separator: list(ref),
    tail: gap, retainedBeat: nullableRef, emptyBeat: nullableRef });
}
export function readHeadingRemove(raw: unknown) {
  return readKind(raw, "heading-remove", { heading: ref, observed: list(ref), newBeat: nullableRef, nextBeat: nullableRef });
}
export function readRecordCreate(raw: unknown) {
  return readKind(raw, "record-create", { target: recordAddress, fields: jsonFields });
}
function readField<K extends "record-set" | "scalar">(raw: unknown, kind: K, target: OperationReader) {
  try {
    const value = canonical(raw);
    if (object(value) && value.clear === true) return readKind(value, kind, { target, field: ref, clear: oneOf(true) });
    return readKind(value, kind, { target, field: ref, value: normalize }, { clear: oneOf(false) });
  } catch { return null; }
}
export function readRecordSet(raw: unknown) { return readField(raw, "record-set", recordAddress); }
export function readRecordDelete(raw: unknown) {
  return readKind(raw, "record-delete", { target: recordAddress });
}
export function readScalarSet(raw: unknown) { return readField(raw, "scalar", scalarAddress); }
export function readSharedStatusEvent(raw: unknown) {
  const event = readKind(raw, "status", { target: value => fields(value, { scope: oneOf("beat", "tag", "shot"), record: ref }),
    value: string, parents: list(ref) }, { prior: normalize });
  if (!event) return null;
  const values: readonly string[] = event.target.scope === "beat" ? ROW_STATUS_IDS : event.target.scope === "tag" ? TAG_STATUS_IDS : BROLL_STATUS_IDS;
  return values.includes(event.value) ? event : null;
}

export function readOperation(raw: unknown): SharedOperation | null {
  try {
    const value = canonical(raw);
    if (!object(value)) return null;
    switch (value.kind) {
      case "text-insert": return readTextInsert(value);
      case "text-delete": return readTextDelete(value);
      case "mark": return readMarkChange(value);
      case "segment-create": return readSegmentCreate(value);
      case "split": return readBeatSplit(value);
      case "split-before": return readBeatSplitBefore(value);
      case "join": return readBeatJoin(value);
      case "join-glue": return readJoinGlue(value);
      case "remove": return readSoftRemove(value);
      case "restore": return readRestore(value);
      case "segment-move": return readSegmentMove(value);
      case "heading-create": return readHeadingCreate(value);
      case "heading-finalize": return readHeadingFinalize(value);
      case "heading-remove": return readHeadingRemove(value);
      case "record-create": return readRecordCreate(value);
      case "record-set": return readRecordSet(value);
      case "record-delete": return readRecordDelete(value);
      case "scalar": return readScalarSet(value);
      case "status": return readSharedStatusEvent(value);
      default: return null;
    }
  } catch { return null; }
}
