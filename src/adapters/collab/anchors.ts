import * as Y from "yjs";
import type { SharedContentRef } from "../../core/collab/operations.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { hasLoneSurrogate } from "../../core/document/text-policy.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";

export type SharedAnchorResolution = { readonly segment: string; readonly offset: number } | "gone";
type AnchorValue = { segment: string; relative: Uint8Array };

function readAnchorValue(raw: unknown): AnchorValue | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "relative,segment,v" || record.v !== 1) return null;
    if (typeof record.segment !== "string" || !record.segment || hasLoneSurrogate(record.segment)) return null;
    if (!Array.isArray(record.relative)) return null;
    const bytes = record.relative as unknown[];
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (!Object.hasOwn(bytes, index) || typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    }
    const relative = Uint8Array.from(bytes as number[]);
    const position = Y.decodeRelativePosition(relative);
    if (position.assoc !== -1 && position.assoc !== 0) return null;
    if (Object.is(position.assoc, -0)) return null;
    if (position.tname !== null || (position.item === null && position.type === null)) return null;
    const canonical = Y.encodeRelativePosition(position);
    if (canonical.length !== relative.length || canonical.some((byte, index) => byte !== relative[index])) return null;
    return { segment: record.segment, relative };
  } catch {
    return null;
  }
}

function segmentText(value: unknown): Y.Text | null {
  if (!(value instanceof Y.Map)) return null;
  const text: unknown = value.get("text");
  return text instanceof Y.Text ? text : null;
}

export function readSharedAnchor(raw: unknown): SharedContentRef | null {
  const value = readAnchorValue(raw);
  return value ? readSharedContentRef(JSON.stringify({ v: 1, segment: value.segment, relative: [...value.relative] })) : null;
}

export function createSharedAnchor(handle: SharedDocumentHandle, segment: string, offset: number, affinity: "before" | "after"): SharedContentRef | null {
  if (!segment || hasLoneSurrogate(segment) || !Number.isInteger(offset) || offset < 0) return null;
  const text = segmentText(collabState(handle).roots.segments.get(segment));
  if (!text || offset > text.length) return null;
  const position = Y.createRelativePositionFromTypeIndex(text, offset, affinity === "before" ? -1 : 0);
  return readSharedAnchor(JSON.stringify({ v: 1, segment, relative: [...Y.encodeRelativePosition(position)] }));
}

export function resolveSharedAnchor(handle: SharedDocumentHandle, raw: unknown): SharedAnchorResolution {
  const value = readAnchorValue(raw);
  if (!value) return "gone";
  const { roots, doc } = collabState(handle);
  const text = segmentText(roots.segments.get(value.segment));
  if (!text) return "gone";
  const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(value.relative), doc);
  return absolute?.type === text ? { segment: value.segment, offset: absolute.index } : "gone";
}
