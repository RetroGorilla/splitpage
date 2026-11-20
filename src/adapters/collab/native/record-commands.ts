import * as Y from "yjs";
import { normalizeRowGallery, withoutVideoLocations } from "../../../core/document/gallery.ts";
import { normalizeBeatLength, rowStatusId } from "../../../core/document/timing.ts";
import { nativeSegmentSpans } from "./reader.ts";
import {
  copyArgument, copyRecordValue, nativeRecordId, plainRecordArgument, recordBag, RECORD_UNCHANGED, RECORD_WRITTEN,
  refuseRecord, sameNativeValue, transactRecord, writeRecordFields
} from "./record-values.ts";
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
const NO_IMAGES = { known: () => null, fromDataUrl: () => null };

function beatValue(field: string, value: unknown): boolean {
  switch (field) {
    case "status": return rowStatusId(value) !== null;
    case "lengthSeconds": return normalizeBeatLength(value) === value;
    case "paragraphStart": return value === true;
    default: return true;
  }
}

function keptExtras(value: Record<string, unknown>): boolean {
  const supplied = { imageRef: null, ...value }, normalized = { ...supplied };
  normalizeRowGallery(normalized, NO_IMAGES);
  withoutVideoLocations([normalized]);
  return sameNativeValue(supplied, normalized);
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
    const copiedTarget = copyArgument(() => {
      if (!plainRecordArgument(target)) return null;
      const { kind, id, field } = target;
      return { kind, id, field };
    });
    const copiedValue = copyArgument(() => clear ? undefined : copyRecordValue(value));
    return copiedTarget?.value && copiedValue ? { value: { ...copiedTarget.value, copied: copiedValue.value } } : null;
  }, ({ kind, id, field, copied }) => {
    if ((kind !== "beat" && kind !== "heading") || !nativeRecordId(id)) return refuseRecord("missing");
    const record = nativeLiveRecord(script, kind, id);
    if (!record) return refuseRecord("missing");
    const beat = kind === "beat";
    if (!nativeWellFormed(field) || !field || (beat ? BEAT_RESERVED : HEADING_RESERVED).has(field)) return refuseRecord("value");
    if (!clear && beat && !beatValue(field, copied)) return refuseRecord("value");
    if (beat && field === "extra" && !clear) {
      if (!recordBag(copied) || Object.keys(copied).some(key => BEAT_RESERVED.has(key) || key !== "extra" && BEAT_FIELDS.has(key)) ||
          !keptExtras(copied)) return refuseRecord("value");
    }
    if (beat && !BEAT_FIELDS.has(field)) {
      const stored = record.has("extra") ? decodeNativeValue(record.get("extra"))?.value : {};
      if (!recordBag(stored)) return refuseRecord("stored");
      if (clear && !Object.hasOwn(stored, field)) return RECORD_UNCHANGED;
      const next = new Map(Object.entries(stored));
      if (clear) next.delete(field);
      else next.set(field, copied);
      const extra = copyArgument(() => copyRecordValue(Object.fromEntries(next)));
      if (!extra || !recordBag(extra.value)) return refuseRecord("value");
      if (!keptExtras(extra.value)) return refuseRecord("value");
      return writeRecordFields(record, { extra: extra.value });
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
