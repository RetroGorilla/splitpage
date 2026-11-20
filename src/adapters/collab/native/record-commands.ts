import * as Y from "yjs";
import { normalizeBeatLength, rowStatusId } from "../../../core/document/timing.ts";
import { encodeNativeGallery, normalizeNativeGallery, readNativeGallery } from "./gallery.ts";
import { nativeSegmentSpans } from "./reader.ts";
import {
  copyArgument, copyRecordValue, nativeRecordId, plainRecordArgument, RECORD_UNCHANGED, RECORD_WRITTEN,
  refuseRecord, transactRecord, writeRecordFields
} from "./record-values.ts";
import type { NativeRecordOutcome } from "./record-values.ts";
import type { NativeScript } from "./script.ts";
import {
  NATIVE_GALLERY_FIELDS, NATIVE_GALLERY_KEY, decodeNativeValue, isNativeBeatField, isReservedBeatField, nativeFieldKey, nativeWellFormed,
  sameNativeValue
} from "./values.ts";

export interface NativeFieldTarget {
  readonly kind: "beat" | "heading";
  readonly id: string;
  readonly field: string;
}

function beatValue(field: string, value: unknown): boolean {
  switch (field) {
    case "status": return rowStatusId(value) !== null;
    case "lengthSeconds": return normalizeBeatLength(value) === value;
    case "paragraphStart": return value === true;
    default: return true;
  }
}

function changeGallery(script: NativeScript, id: string, record: Y.Map<unknown>, field: string, value: unknown, clear: boolean): NativeRecordOutcome {
  const raw = record.get(NATIVE_GALLERY_KEY), stored = readNativeGallery(raw) ?? {};
  if (clear && !Object.hasOwn(stored, field)) return RECORD_UNCHANGED;
  const gallery: Record<string, unknown> = { imageRef: null, ...stored };
  if (!clear) gallery[field] = value;
  else if (field === "imageRef") gallery.imageRef = null;
  else Reflect.deleteProperty(gallery, field);
  const normalized = normalizeNativeGallery(gallery);
  if (!sameNativeValue(gallery, normalized)) return refuseRecord("value");
  const projected = script.reader.previewJoinedGallery(id, gallery);
  if (projected && !sameNativeValue(projected, normalizeNativeGallery(projected))) return refuseRecord("value");
  const encoded = encodeNativeGallery(normalized);
  if (raw === encoded) return RECORD_UNCHANGED;
  record.set(NATIVE_GALLERY_KEY, encoded);
  return RECORD_WRITTEN;
}

export function nativeLiveBeatRecord(script: NativeScript, id: string): Y.Map<unknown> | null {
  const { roots, reader } = script, record = roots.beats.get(id);
  if (!(record instanceof Y.Map) || !(roots.visuals.get(id) instanceof Y.Text)) return null;
  const place = reader.beatBoundary(id);
  if (!place || !roots.order.toArray().includes(place.segment)) return null;
  const marker = "b:" + id;
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
    if (kind === "heading") return refuseRecord("value");
    const record = nativeLiveBeatRecord(script, id);
    if (!record) return refuseRecord("missing");
    if (!nativeWellFormed(field) || !field || isReservedBeatField(field)) return refuseRecord("value");
    if (!clear && !beatValue(field, copied)) return refuseRecord("value");
    if (field === "visualImage") return refuseRecord("value");
    if (NATIVE_GALLERY_FIELDS.has(field)) return changeGallery(script, id, record, field, copied, clear);
    const named = isNativeBeatField(field), key = named ? field : nativeFieldKey(field);
    if (!named && record.has(key) && !decodeNativeValue(record.get(key))) return refuseRecord("stored");
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
