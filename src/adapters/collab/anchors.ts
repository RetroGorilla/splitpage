import * as Y from "yjs";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { hasLoneSurrogate } from "../../core/document/text-policy.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { collabTextTarget, collabWritingTextPosition, collabPurposeTextTarget, collabProjectedSegmentAnchorTarget, readSharedTextTarget, collabPreparedOperationTextTarget, collabStoredJoinGluePosition, collabProjectedTextOffset } from "./text-target.ts";
import { readSharedJoinGlueReference } from "./join-glue-reference.ts";

export type SharedAnchorResolution = { readonly segment: string; readonly offset: number } | "gone";
export type SharedTextAnchorLocation = { readonly kind: "index" | "gap"; readonly index: number; readonly affinity: "before" | "after" } | { readonly kind: "gone" };
type AnchorValue = { segment: string; target: SharedTextAddress | null; relative: Uint8Array };

function readAnchorValue(raw: unknown): AnchorValue | null {
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
  const value = readAnchorValue(raw);
  return value ? readSharedContentRef(JSON.stringify(value.target ? { v: 2, target: value.target, relative: [...value.relative] } : { v: 1, segment: value.segment, relative: [...value.relative] })) : null;
}

export function sharedAnchorCharacterEnd(raw: unknown): SharedContentRef | null {
  const value = readAnchorValue(raw);
  if (!value) return null;
  const position = Y.decodeRelativePosition(value.relative);
  if (position.assoc !== 0 || position.item === null) return null;
  position.assoc = -1;
  const relative = [...Y.encodeRelativePosition(position)];
  return readSharedAnchor(JSON.stringify(value.target ? { v: 2, target: value.target, relative } : { v: 1, segment: value.segment, relative }));
}

export function readSharedAnchorUnit(raw: unknown): { readonly client: number; readonly clock: number; readonly after: boolean } | null {
  const value = readAnchorValue(raw);
  if (!value) return null;
  const position = Y.decodeRelativePosition(value.relative);
  return position.item ? { client: position.item.client, clock: position.item.clock, after: position.assoc === -1 } : null;
}

export function createSharedAnchor(handle: SharedDocumentHandle, address: string | SharedTextAddress, offset: number, affinity: "before" | "after"): SharedContentRef | null {
  const target = typeof address === "string" ? null : readSharedTextTarget(address);
  if (typeof address !== "string" && !target) return null;
  const found = target ? collabWritingTextPosition(handle, target, offset) : collabProjectedSegmentAnchorTarget(handle, address as string, offset);
  const segment = typeof address === "string" ? address : found?.target.segment ?? "";
  if (!segment || hasLoneSurrogate(segment) || !Number.isInteger(offset) || offset < 0) return null;
  const text = found?.text;
  const actual = found && "offset" in found ? found.offset as number : offset;
  if (!text || actual < found.from || actual > found.to) return null;
  return readSharedAnchor(encodedAnchor(text, segment, found?.target ?? target, actual, affinity));
}

function encodedAnchor(text: Y.Text, segment: string, target: SharedTextAddress | null, offset: number, affinity: "before" | "after"): SharedContentRef {
  const relative = [...Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset, affinity === "before" ? -1 : 0))];
  return JSON.stringify(target && (target.field === "visualText" || target.field === "title") ? { v: 2, target, relative } : { v: 1, segment, relative }) as SharedContentRef;
}

export function encodeCollabTextAnchor(text: Y.Text, target: SharedTextAddress, offset: number, affinity: "before" | "after"): SharedContentRef {
  return encodedAnchor(text, target.segment, target, offset, affinity);
}

export function applySharedTextAnchor(handle: SharedDocumentHandle, description: { readonly target: SharedTextAddress; readonly index: number; readonly affinity: "before" | "after" }): SharedContentRef {
  return encodeCollabTextAnchor(collabPreparedOperationTextTarget(handle, description.target).text, description.target, description.index, description.affinity);
}

export function resolveCollabTextAnchor(handle: SharedDocumentHandle, raw: unknown, text: Y.Text): SharedTextAnchorLocation {
  const value = readAnchorValue(raw);
  if (!value) return { kind: "gone" };
  const source = value.target ? collabPurposeTextTarget(handle, value.target, "stored-anchor-read")?.text : segmentText(collabState(handle).roots.segments.get(value.segment));
  if (source !== text) return { kind: "gone" };
  const position = Y.decodeRelativePosition(value.relative), absolute = Y.createAbsolutePositionFromRelativePosition(position, collabState(handle).doc);
  if (absolute?.type !== text) return { kind: "gone" };
  const offset = absolute.index + (position.assoc === -1 ? -1 : 0);
  const current = offset >= 0 && offset < text.length ? Y.createRelativePositionFromTypeIndex(text, offset).item : null;
  return { kind: current && position.item && current.client === position.item.client && current.clock === position.item.clock ? "index" : "gap", index: absolute.index, affinity: position.assoc === -1 ? "before" : "after" };
}

export function resolveSharedAnchor(handle: SharedDocumentHandle, raw: unknown): SharedAnchorResolution {
  const glue = readSharedJoinGlueReference(raw);
  if (glue) {
    const point = collabStoredJoinGluePosition(handle, glue.group, glue.after);
    return point ? { segment: point.target.segment, offset: point.offset } : "gone";
  }
  const value = readAnchorValue(raw);
  if (!value) return "gone";
  const { roots, doc } = collabState(handle);
  const text = value.target ? collabPurposeTextTarget(handle, value.target, "stored-anchor-read")?.text : segmentText(roots.segments.get(value.segment));
  if (!text) return "gone";
  const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(value.relative), doc);
  return absolute?.type === text ? { segment: value.segment, offset: absolute.index } : "gone";
}

export function resolveSharedTextAnchor(handle: SharedDocumentHandle, raw: unknown, target: SharedTextAddress): number | null {
  if (target.field === "audioText" && target.segment === target.owner) {
    const resolved = resolveSharedAnchor(handle, raw);
    return resolved === "gone" ? null : collabProjectedTextOffset(handle, target, resolved.segment, resolved.offset);
  }
  const value = readAnchorValue(raw), stored = value?.target;
  const physical = target.segment !== target.owner || stored?.owner === target.owner && stored.segment === target.segment && stored.field === target.field;
  const text = (physical ? collabPurposeTextTarget(handle, target, "stored-anchor-read") : collabTextTarget(handle, target))?.text;
  if (!value || !text) return null;
  const source = value.target ? collabPurposeTextTarget(handle, value.target, "stored-anchor-read")?.text : segmentText(collabState(handle).roots.segments.get(value.segment));
  if (source !== text) return null;
  const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(value.relative), collabState(handle).doc);
  return absolute?.type === text ? absolute.index : null;
}
