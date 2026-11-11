import * as Y from "yjs";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { hasLoneSurrogate } from "../../core/document/text-policy.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { collabTextTarget, readSharedTextTarget } from "./text-target.ts";

export type SharedAnchorResolution = { readonly segment: string; readonly offset: number } | "gone";
type AnchorValue = { segment: string; target: SharedTextAddress | null; relative: Uint8Array };

function readAnchorValue(raw: unknown): AnchorValue | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const target = record.v === 2 ? readSharedTextTarget(record.target) : null;
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

export function createSharedAnchor(handle: SharedDocumentHandle, address: string | SharedTextAddress, offset: number, affinity: "before" | "after"): SharedContentRef | null {
  const target = typeof address === "string" ? null : readSharedTextTarget(address);
  if (typeof address !== "string" && !target) return null;
  const segment = typeof address === "string" ? address : target?.segment ?? "";
  if (!segment || hasLoneSurrogate(segment) || !Number.isInteger(offset) || offset < 0) return null;
  const text = target ? collabTextTarget(handle, target)?.text : segmentText(collabState(handle).roots.segments.get(segment));
  if (!text || offset > text.length) return null;
  const position = Y.createRelativePositionFromTypeIndex(text, offset, affinity === "before" ? -1 : 0);
  const relative = [...Y.encodeRelativePosition(position)];
  return readSharedAnchor(JSON.stringify(target && (target.field === "visualText" || target.field === "title") ? { v: 2, target, relative } : { v: 1, segment, relative }));
}

export function resolveSharedAnchor(handle: SharedDocumentHandle, raw: unknown): SharedAnchorResolution {
  const value = readAnchorValue(raw);
  if (!value) return "gone";
  const { roots, doc } = collabState(handle);
  const text = value.target ? collabTextTarget(handle, value.target)?.text : segmentText(roots.segments.get(value.segment));
  if (!text) return "gone";
  const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(value.relative), doc);
  return absolute?.type === text ? { segment: value.segment, offset: absolute.index } : "gone";
}

export function resolveSharedTextAnchor(handle: SharedDocumentHandle, raw: unknown, target: SharedTextAddress): number | null {
  const value = readAnchorValue(raw), text = collabTextTarget(handle, target)?.text;
  if (!value || !text) return null;
  const source = value.target ? collabTextTarget(handle, value.target)?.text : segmentText(collabState(handle).roots.segments.get(value.segment));
  if (source !== text) return null;
  const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(value.relative), collabState(handle).doc);
  return absolute?.type === text ? absolute.index : null;
}
