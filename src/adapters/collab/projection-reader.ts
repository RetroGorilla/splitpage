import * as Y from "yjs";
import { scalarFieldAllowed } from "./scalar-fields.ts";
import { readSharedStamp } from "./stamp.ts";
import { sharedJson } from "./snapshot.ts";
import { isStableSharedIdentity } from "./identity.ts";
import type { SharedProjectionBeatStructure } from "../../core/collab/projection/joins.ts";
import type { SharedProjectionUnit } from "../../core/collab/projection/units.ts";
import type { SharedInlineValue } from "../../core/collab/operations.ts";
import { readTextInsert } from "../../core/collab/read-operation.ts";
import { readSharedStructureBoundary } from "./structure-boundary.ts";
import { projectSharedBlocks } from "../../core/collab/projection/blocks.ts";
import type { SharedProjectionBoundary, SharedProjectionStream } from "../../core/collab/projection/blocks.ts";
import { readSharedRemovalState } from "./removal-state.ts";
import { projectSharedJoinGlue, sharedJoinGlueRegisterField, readSharedJoinGlue, projectSharedJoinFormats } from "../../core/collab/projection/join-glue.ts";
import { readSharedJoinEntry, sharedJoinRetirementGroup } from "./join-record.ts";
import { readSharedJoinEndpoint, sharedJoinEndpointField } from "./join-endpoint.ts";
import type { SharedJoinEndpointPosition } from "./join-endpoint.ts";

function bag(value: unknown): Record<string, unknown> {
  const json = sharedJson(value);
  return json !== null && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
}
function retainedStamp(value: unknown): boolean {
  const stamp = bag(value);
  return Object.hasOwn(stamp, "at") && Object.keys(stamp).every(key => key === "at" || key === "by")
    && (stamp.by === null || typeof stamp.by === "string");
}
export function readProjectionFields(raw: unknown, scope: "document" | "beat" | "heading"): Record<string, unknown> | null {
  if (!(raw instanceof Y.Map) && !(raw instanceof Map)) return null;
  const output: [string, unknown][] = [];
  const fields = scope === "document" ? ["fileTitle", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "extra"]
    : scope === "beat" ? ["lengthSeconds", "paragraphStart", "stamp", "extra", "segment", "splitBy"] : ["extra"];
  for (const key of fields) {
    const value = key === "stamp" ? readSharedStamp(raw) : sharedJson(raw.get(key));
    const valid = key === "segment" || key === "splitBy" ? typeof value === "string" && (key !== "segment" || value.length > 0) && isStableSharedIdentity(value)
      : key === "stamp" ? retainedStamp(value) : scalarFieldAllowed(scope, key, value, false);
    if (valid) output.push([key, value]);
  }
  if (scope === "document") {
    const id: unknown = raw.get("docId"), schema: unknown = raw.get("schema"), capture = bag(raw.get("capture"));
    if (typeof id === "string" && id.length > 0 && isStableSharedIdentity(id)) output.push(["docId", id]);
    if (typeof schema === "number" && Number.isFinite(schema)) output.push(["schema", schema]);
    const retained: [string, unknown][] = [];
    for (const key of ["rev", "lastEditedBy", "lastEditedAt", "personColors"]) {
      const value = capture[key];
      if (Object.hasOwn(capture, key) && (key === "lastEditedAt" || (key === "rev" ? typeof value === "number" : key === "personColors" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === "string"))) retained.push([key, value]);
    }
    output.push(["capture", Object.fromEntries(retained)]);
  } else {
    const id: unknown = raw.get("id");
    if (typeof id !== "string" || !id || !isStableSharedIdentity(id)) return null;
    output.push(["id", id]);
  }
  return Object.fromEntries(output);
}
export function readProjectionHead(raw: unknown): SharedProjectionBoundary | null {
  const head = readSharedStructureBoundary(sharedJson(raw));
  return head ? { kind: head.field === "heading" ? "h" : "b", id: head.owner, before: head.before } : null;
}

export function readProjectionInlineValue(raw: unknown): SharedInlineValue | null {
  const atom = sharedJson(raw);
  if (typeof atom === "string") return atom;
  if (!atom || typeof atom !== "object" || Array.isArray(atom)) return null;
  const item = atom as Record<string, unknown>;
  const value = "k" in item ? { atom: "broll", id: item.k, ...(item.label === undefined ? {} : { text: item.label }) }
    : "w" in item ? { atom: "who", name: item.w } : "img" in item ? { atom: "image", ref: item.img }
    : { atom: "video", href: item.video, host: item.host };
  const read = readTextInsert({ kind: "text-insert", id: "projection", by: "", target: { owner: "projection", segment: "projection", field: "audioText" }, at: { left: null, right: null, affinity: "before" }, content: [{ value, marks: [] }] })?.content[0]?.value;
  return read && (typeof read === "string" || read.atom !== "broll" || isStableSharedIdentity(read.id)) ? read : null;
}

export function readProjectionBlocks(order: Y.Array<string>, segments: Y.Map<unknown>, beats: Y.Map<unknown>, readUnits?: (container: Y.Map<unknown>) => readonly SharedProjectionUnit[]) {
  const streams: SharedProjectionStream[] = [];
  const ordered = new Set(order.toArray());
  for (const key of new Set([...ordered, ...[...segments.keys()].sort()])) {
    if (typeof key !== "string" || !isStableSharedIdentity(key)) continue;
    const segment: unknown = segments.get(key); if (!(segment instanceof Y.Map)) continue;
    streams.push(readProjectionStream(key, segment, ordered.has(key), readUnits?.(segment) ?? []));
  }
  const records = [...beats.keys()].sort().map(id => {
    const fields = readProjectionFields(beats.get(id), "beat");
    return { id, valid: fields?.id === id, segment: typeof fields?.segment === "string" ? fields.segment : null };
  });
  return projectSharedBlocks(streams, records);
}

export function readProjectionStream(key: string, segment: Y.Map<unknown>, inOrder: boolean, all: readonly SharedProjectionUnit[]): SharedProjectionStream {
  const parts: SharedProjectionStream["parts"][number][] = []; let cursor = 0, offset = 0;
  const text: unknown = segment.get("text");
  for (const delta of text instanceof Y.Text ? text.toDelta() as { insert: unknown }[] : []) {
    const boundary = readProjectionHead(delta.insert), value = boundary ? null : readProjectionInlineValue(delta.insert);
    const size = typeof value === "string" ? value.length : value ? 1 : 0, length = typeof delta.insert === "string" ? delta.insert.length : 1;
    parts.push({ boundary, units: all.slice(cursor, cursor + size), from: offset, to: offset + length });
    cursor += size; offset += length;
  }
  return { segment: key, inOrder, head: readProjectionHead(segment.get("head")), parts };
}

export function readProjectionBeatStructure(raw: unknown, id: string, retirements: Y.Map<unknown>, glueRegisters: Y.Map<unknown>, registerRead?: (field: string) => void,
  endpointOffset?: (position: SharedJoinEndpointPosition) => number | null): SharedProjectionBeatStructure {
  const joins: SharedProjectionBeatStructure["joins"][number][] = [];
  if (!(raw instanceof Y.Map) || readProjectionFields(raw, "beat")?.id !== id) return { id, joins, removed: false };
  const stored: unknown = raw.get("joins"), removals: unknown = raw.get("removals");
  if (stored instanceof Y.Map) for (const key of [...stored.keys()].sort()) {
    if (!key || !isStableSharedIdentity(key) || retirements.get(key) === true) continue;
    const value = readSharedJoinEntry(stored.get(key));
    if (value && retirements.get(sharedJoinRetirementGroup(id, value)) !== true) {
      const group = sharedJoinRetirementGroup(id, value), field = sharedJoinGlueRegisterField(group); registerRead?.(field);
      const end = sharedJoinEndpointField(key); registerRead?.(end);
      const stored = glueRegisters.get(end), position = readSharedJoinEndpoint(stored);
      const resolve = (point: SharedJoinEndpointPosition) => { const offset = endpointOffset?.(point); return typeof offset === "number" ? { segment: point.segment, offset } : null; };
      const destination = position && resolve(position.end), start = position && resolve(position.start), stop = position && resolve(position.stop);
      const binding = destination && start && stop ? { end: destination, start, stop } : null;
      const register = glueRegisters.get(field), formats = projectSharedJoinFormats(group, format => { registerRead?.(format); return glueRegisters.get(format); });
      joins.push({ id: key, into: value.into, glue: projectSharedJoinGlue(value.glue, register),
        ...(stored === undefined && !glueRegisters.has(end) ? {} : { binding }), ...(readSharedJoinGlue(register) === null ? {} : { glueSet: true as const }), ...(formats.length ? { formats } : {}) });
    }
  }
  const removed = readSharedRemovalState(removals instanceof Y.Map ? removals : []).removed;
  return { id, joins, removed };
}
