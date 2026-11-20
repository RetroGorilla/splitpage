import * as Y from "yjs";
import { normalizeRowGallery, withoutVideoLocations } from "../../../core/document/gallery.ts";
import { normalizeBeatLength, rowStatusId } from "../../../core/document/timing.ts";
import { nativeSegmentSpans } from "./reader.ts";
import {
  copyArgument, copyRecordValue, nativeRecordId, plainRecordArgument, RECORD_UNCHANGED, RECORD_WRITTEN,
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

const BEAT_FIELDS = new Set(["status", "lengthSeconds", "paragraphStart"]);
const BEAT_RESERVED = new Set(["id", "audioText", "visualText", "rank", "joined", "updatedBy", "updatedAt"]);
const GALLERY_FIELDS = ["imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages", "visualImage"];
const NO_IMAGES = { known: () => null, fromDataUrl: () => null };

function beatValue(field: string, value: unknown): boolean {
  switch (field) {
    case "status": return rowStatusId(value) !== null;
    case "lengthSeconds": return normalizeBeatLength(value) === value;
    case "paragraphStart": return value === true;
    default: return true;
  }
}

function checkExtraChange(record: Y.Map<unknown>, field: string, key: string, value: unknown, clear: boolean): NativeRecordOutcome | null {
  if (record.has(key) && !decodeNativeValue(record.get(key))) return refuseRecord("stored");
  if (clear && !record.has(key)) return RECORD_UNCHANGED;
  const supplied: Record<string, unknown> = { imageRef: null };
  for (const name of GALLERY_FIELDS) {
    if (name === field) {
      if (!clear) supplied[name] = value;
      continue;
    }
    const storedKey = nativeFieldKey(name);
    if (!record.has(storedKey)) continue;
    const stored = decodeNativeValue(record.get(storedKey));
    if (!stored) return refuseRecord("stored");
    supplied[name] = stored.value;
  }
  const normalized = { ...supplied };
  normalizeRowGallery(normalized, NO_IMAGES);
  withoutVideoLocations([normalized]);
  return sameNativeValue(supplied, normalized) ? null : refuseRecord("value");
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
    if (!nativeWellFormed(field) || !field || BEAT_RESERVED.has(field)) return refuseRecord("value");
    if (!clear && !beatValue(field, copied)) return refuseRecord("value");
    const named = BEAT_FIELDS.has(field), key = named ? field : nativeFieldKey(field);
    if (!named) {
      const checked = checkExtraChange(record, field, key, copied, clear);
      if (checked) return checked;
    }
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
