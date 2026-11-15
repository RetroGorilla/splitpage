import * as Y from "yjs";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { hasLoneSurrogate } from "../../core/document/text-policy.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { readSharedTextTarget, readPhysicalSharedTextTarget } from "./text-address.ts";

export type SharedTextAnchorLocation = { readonly kind: "index" | "gap"; readonly index: number; readonly affinity: "before" | "after" } | { readonly kind: "gone" };

export type SharedAnchorValue = { segment: string; target: SharedTextAddress | null; relative: Uint8Array };

export function readSharedAnchorValue(raw: unknown): SharedAnchorValue | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const target = record.v === 2 ? readSharedTextTarget(record.target) : null;
    if (target && (target.field === "audioText" || target.field === "heading")) return null;
    if (record.v === 1 ? Object.keys(record).sort().join(",") !== "relative,segment,v" : record.v !== 2 || Object.keys(record).sort().join(",") !== "relative,target,v" || !target) return null;
    const segment: unknown = target ? target.segment : record.segment;
    if (typeof segment !== "string" || !segment || hasLoneSurrogate(segment)) return null;
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
    return { segment, target, relative };
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
  const value = readSharedAnchorValue(raw);
  return value ? readSharedContentRef(JSON.stringify(value.target ? { v: 2, target: value.target, relative: [...value.relative] } : { v: 1, segment: value.segment, relative: [...value.relative] })) : null;
}

export function resolveCollabTextAnchor(handle: SharedDocumentHandle, raw: unknown, text: Y.Text): SharedTextAnchorLocation {
  const value = readSharedAnchorValue(raw);
  if (!value) return { kind: "gone" };
  const source = value.target ? readPhysicalSharedTextTarget(handle, value.target)?.text : segmentText(collabState(handle).roots.segments.get(value.segment));
  if (source !== text) return { kind: "gone" };
  const position = Y.decodeRelativePosition(value.relative), absolute = Y.createAbsolutePositionFromRelativePosition(position, collabState(handle).doc);
  if (absolute?.type !== text) return { kind: "gone" };
  const offset = absolute.index + (position.assoc === -1 ? -1 : 0);
  const current = offset >= 0 && offset < text.length ? Y.createRelativePositionFromTypeIndex(text, offset).item : null;
  return { kind: current && position.item && current.client === position.item.client && current.clock === position.item.clock ? "index" : "gap", index: absolute.index, affinity: position.assoc === -1 ? "before" : "after" };
}
