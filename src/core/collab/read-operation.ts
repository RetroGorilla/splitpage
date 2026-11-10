import { normalizeImageRef } from "../../../shared/blob-policy.ts";
import { ROW_STATUS_IDS } from "../document/timing.ts";
import { TAG_STATUS_IDS } from "../document/tags.ts";
import { BROLL_STATUS_IDS } from "../document/broll.ts";
import type { SharedContentRef, SharedOperation } from "./operations.ts";

type OperationCheck = (value: unknown) => boolean;
type OperationFields = Readonly<Record<string, OperationCheck>>;

function storedString(raw: string): string { return raw.replace(/\p{Cs}/gu, "\uFFFD"); }

export function readSharedContentRef(raw: unknown): SharedContentRef | null {
  return typeof raw === "string" && raw.length > 0 ? storedString(raw) as SharedContentRef : null;
}

function object(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function fields(raw: unknown, shape: OperationFields): boolean {
  if (!object(raw)) return false;
  for (const key of Object.keys(shape)) {
    const check = shape[key];
    if (!Object.hasOwn(raw, key) || !check || !check(raw[key])) return false;
  }
  return true;
}

function oneOf(...values: readonly unknown[]): OperationCheck { return raw => values.includes(raw); }
function string(raw: unknown): boolean { return typeof raw === "string"; }
function ref(raw: unknown): boolean { return readSharedContentRef(raw) !== null; }
function nullableRef(raw: unknown): boolean { return raw === null || ref(raw); }
function list(check: OperationCheck): OperationCheck {
  return raw => {
    if (!Array.isArray(raw)) return false;
    for (let index = 0; index < raw.length; index++) if (!check(raw[index])) return false;
    return true;
  };
}
function address(raw: unknown): boolean {
  return fields(raw, { segment: ref, owner: ref, field: oneOf("audioText", "visualText", "heading", "title") });
}
function gap(raw: unknown): boolean {
  return fields(raw, { left: nullableRef, right: nullableRef, affinity: oneOf("before", "after") });
}
function recordAddress(raw: unknown): boolean {
  return fields(raw, { collection: oneOf("comments", "replies", "people", "tags", "shots", "gallery", "visuals"), record: ref });
}
function scalarAddress(raw: unknown): boolean {
  return fields(raw, { scope: oneOf("document", "beat", "heading"), record: ref });
}
function fieldValue(raw: unknown): boolean {
  if (!object(raw)) return false;
  if (raw.clear === true) return !Object.hasOwn(raw, "value");
  return Object.hasOwn(raw, "value") && (!Object.hasOwn(raw, "clear") || raw.clear === false);
}
function mark(raw: unknown): boolean {
  if (!object(raw)) return false;
  if (oneOf("b", "i", "u", "s", "hl", "dir", "cue")(raw.kind)) return fields(raw, { value: oneOf(true, null) });
  if (raw.kind === "comment") return fields(raw, { id: ref, value: oneOf(true, null) });
  if (raw.kind === "tag") return fields(raw, { id: ref, value: nullableRef });
  return raw.kind === "link" && fields(raw, { id: ref, value: value => value === null || string(value) });
}
function inline(raw: unknown): boolean {
  if (string(raw)) return true;
  if (!object(raw)) return false;
  if (raw.atom === "broll") return fields(raw, { id: ref });
  if (raw.atom === "who") return fields(raw, { name: string });
  if (raw.atom === "image") return object(raw.ref) && normalizeImageRef({ width: 1, height: 1, mime: "image/png", ...raw.ref }) !== null;
  return raw.atom === "video" && fields(raw, { href: string, host: string });
}
function chunk(raw: unknown): boolean {
  if (!fields(raw, { value: inline, marks: list(mark) })) return false;
  const keys = new Set<string>();
  for (const item of (raw as { marks: { kind: string; id?: string }[] }).marks) {
    const key = item.id === undefined ? item.kind : item.kind + ":" + item.id;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
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
  const keys = new Set<string>();
  for (const key of Object.keys(raw)) {
    const stored = storedString(key);
    if (keys.has(stored)) throw new Error("Colliding stored keys");
    keys.add(stored);
    entries.push([stored, normalize(raw[key])]);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function canonical(raw: unknown): unknown {
  const encoded = JSON.stringify(raw);
  return encoded === undefined ? null : normalize(JSON.parse(encoded));
}

function readKind<K extends SharedOperation["kind"]>(raw: unknown, kind: K, shape: OperationFields): Extract<SharedOperation, { kind: K }> | null {
  try {
    const value = canonical(raw);
    if (!fields(value, { kind: oneOf(kind), id: ref, by: string, ...shape })) return null;
    return value as Extract<SharedOperation, { kind: K }>;
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
  return readKind(raw, "segment-create", { segment: ref, beat: ref, at: gap, fields: object });
}
export function readBeatSplit(raw: unknown) {
  return readKind(raw, "split", { target: address, at: gap, observed: list(ref), boundary: ref, beat: ref, fields: object });
}
export function readBeatJoin(raw: unknown) {
  return readKind(raw, "join", { from: ref, into: ref, glue: oneOf(" ", "") });
}
export function readJoinGlue(raw: unknown) {
  return readKind(raw, "join-glue", { joins: list(ref), glue: oneOf(" ", "") });
}
export function readSoftRemove(raw: unknown) {
  return readKind(raw, "remove", { removalKind: oneOf("beat", "range", "header", "became-heading"), targets: list(ref),
    observed: list(ref), boundaries: list(ref), components: list(ref), gallery: list(ref), at: value => typeof value === "number" });
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
  return readKind(raw, "record-create", { target: recordAddress, fields: object });
}
export function readRecordSet(raw: unknown) {
  const operation = readKind(raw, "record-set", { target: recordAddress, field: ref });
  return operation && fieldValue(operation) ? operation : null;
}
export function readRecordDelete(raw: unknown) {
  return readKind(raw, "record-delete", { target: recordAddress });
}
export function readScalarSet(raw: unknown) {
  const operation = readKind(raw, "scalar", { target: scalarAddress, field: ref });
  return operation && fieldValue(operation) ? operation : null;
}
export function readSharedStatusEvent(raw: unknown) {
  const event = readKind(raw, "status", { target: value => fields(value, { scope: oneOf("beat", "tag", "shot"), record: ref }),
    value: string, parents: list(ref) });
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
