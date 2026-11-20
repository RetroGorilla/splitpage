import * as Y from "yjs";
import { normalizeImageRef } from "../../../../shared/blob-policy.ts";
import { nativeSegmentSpans } from "./reader.ts";
import { copyRecordValue, isFileValue, recordBag, RECORD_UNCHANGED, RECORD_WRITTEN, refuseRecord, transactRecord, writeRecordFields } from "./record-values.ts";
import type { NativeRecordOutcome } from "./record-values.ts";
import type { NativeScript } from "./script.ts";
import { decodeNativeValue, nativeFieldKey, nativeWellFormed } from "./values.ts";

export interface NativeFieldTarget {
  readonly kind: "beat" | "heading";
  readonly id: string;
  readonly field: string;
}

const BEAT_FIELDS = new Set(["status", "lengthSeconds", "paragraphStart", "extra"]);
const BEAT_RESERVED = new Set(["id", "audioText", "visualText", "rank", "joined", "updatedBy", "updatedAt"]);
const HEADING_RESERVED = new Set(["id", "name", "firstSceneId", "rank", "removed"]);
const ANNOTATION_COLORS = new Set(["#e5383b", "#ffb703", "#2a9d8f", "#3a86ff", "#111111", "#ffffff"]);

function between(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && value >= low && value <= high;
}

function annotation(value: unknown): boolean {
  if (!recordBag(value) || !normalizeImageRef(value.imageRef) || !Array.isArray(value.marks)) return false;
  const marks: readonly unknown[] = value.marks;
  return marks.length > 0 && marks.length <= 500 && marks.every(mark => {
    if (!recordBag(mark) || typeof mark.color !== "string" || !ANNOTATION_COLORS.has(mark.color)) return false;
    if (mark.kind === "text") {
      return between(mark.size, 0.01, 0.3) && between(mark.x, 0, 1) && between(mark.y, 0, 1) &&
        typeof mark.text === "string" && !!mark.text.trim() && [...mark.text].length <= 500;
    }
    if (mark.kind !== "pen" && mark.kind !== "highlight") return false;
    const points: unknown = mark.points;
    return between(mark.width, 0.001, 0.2) && Array.isArray(points) && points.length >= 2 &&
      points.length <= 4000 && points.length % 2 === 0 && points.every(point => between(point, 0, 1));
  });
}

function pictureName(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const characters = [...value];
  return characters.length <= 200 && characters.every(character => character.charCodeAt(0) >= 32);
}

function links(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>();
  let poster = false;
  return value.every((link: unknown) => {
    if (!recordBag(link) || Object.hasOwn(link, "location")) return false;
    if (link.size !== undefined && (!between(link.size, 0, Number.MAX_VALUE) || !Number.isInteger(link.size))) return false;
    if (link.duration !== undefined && (typeof link.duration !== "number" || link.duration < 0 || link.duration > 1e7)) return false;
    if (link.poster !== undefined && (link.poster !== true || poster)) return false;
    poster ||= link.poster === true;
    let identity: string;
    if (typeof link.href === "string") {
      if (!/^https?:\/\/[^\s/]/i.test(link.href) || /\s/.test(link.href) || link.href.length > 2048) return false;
      identity = "u:" + link.href;
    } else {
      if (link.href !== undefined || !pictureName(link.name)) return false;
      identity = "f:" + String(link.name) + ":" + String(link.size ?? 0);
    }
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

function gallery(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 60 && value.every((slot: unknown) => {
    if (!recordBag(slot)) return false;
    const image = normalizeImageRef(slot.imageRef);
    if (slot.imageRef !== undefined && !image || slot.name !== undefined && (!image || !pictureName(slot.name)) ||
        slot.annotation !== undefined && (!image || !annotation(slot.annotation)) ||
        slot.links !== undefined && !links(slot.links)) return false;
    return !!image || Array.isArray(slot.links) && slot.links.some((link: unknown) => recordBag(link) && link.poster === true);
  });
}

function beatValue(field: string, value: unknown): boolean {
  switch (field) {
    case "status": return value === "todo" || value === "ready" || value === "shot";
    case "lengthSeconds": return between(value, 0, 86400) && Number.isInteger(value);
    case "paragraphStart": return value === true;
    case "imageRef": return value === null || normalizeImageRef(value) !== null;
    case "imageName": return pictureName(value);
    case "imageAnnotation": return annotation(value);
    case "imageLinks": return links(value);
    case "moreImages": return gallery(value);
    default: return true;
  }
}

function extraValue(value: unknown): boolean {
  return recordBag(value) && Object.entries(value).every(([field, item]) =>
    !BEAT_RESERVED.has(field) && (field === "extra" || !BEAT_FIELDS.has(field)) && beatValue(field, item));
}

export function nativeLiveRecord(script: NativeScript, kind: NativeFieldTarget["kind"], id: string): Y.Map<unknown> | null {
  const { roots, reader } = script, beat = kind === "beat";
  const record = (beat ? roots.beats : roots.headings).get(id);
  if (!(record instanceof Y.Map) || !((beat ? roots.visuals : roots.names).get(id) instanceof Y.Text)) return null;
  const place = beat ? reader.beatBoundary(id) : reader.headingBoundary(id, false);
  if (!place || !roots.order.toArray().includes(place.segment)) return null;
  const marker = (beat ? "b:" : "h:") + id;
  return nativeSegmentSpans(roots.segments.get(place.segment))?.some(span => span.key === marker) ? record : null;
}

function changeField(script: NativeScript, target: NativeFieldTarget, value: unknown, clear: boolean): NativeRecordOutcome {
  return transactRecord(script, () => {
    const { kind, id, field } = target;
    return { kind, id, field, value: copyRecordValue(value) };
  }, ({ kind, id, field, value: copied }) => {
    if ((kind !== "beat" && kind !== "heading") || !nativeWellFormed(id) || !id) return refuseRecord("missing");
    const record = nativeLiveRecord(script, kind, id);
    if (!record) return refuseRecord("missing");
    const beat = kind === "beat";
    if (!nativeWellFormed(field) || !field || (beat ? BEAT_RESERVED : HEADING_RESERVED).has(field)) return refuseRecord("value");
    if (!clear && (!isFileValue(copied) || (beat && !(field === "extra" ? extraValue(copied) : beatValue(field, copied))))) return refuseRecord("value");
    if (beat && !BEAT_FIELDS.has(field)) {
      const stored = record.has("extra") ? decodeNativeValue(record.get("extra"))?.value : {};
      if (!recordBag(stored)) return refuseRecord("stored");
      if (clear && !Object.hasOwn(stored, field)) return RECORD_UNCHANGED;
      const next = new Map(Object.entries(stored));
      if (clear) next.delete(field);
      else next.set(field, copied);
      return writeRecordFields(record, { extra: Object.fromEntries(next) });
    }
    const key = beat ? field : nativeFieldKey(field);
    if (!clear) return writeRecordFields(record, { [key]: copied });
    if (!record.has(key)) return RECORD_UNCHANGED;
    record.delete(key);
    return RECORD_WRITTEN;
  });
}

export function setNativeField(script: NativeScript, target: NativeFieldTarget, value: unknown): NativeRecordOutcome {
  return changeField(script, target, value, false);
}

export function clearNativeField(script: NativeScript, target: NativeFieldTarget): NativeRecordOutcome {
  return changeField(script, target, undefined, true);
}
