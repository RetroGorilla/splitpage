import * as Y from "yjs";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedJson } from "./snapshot.ts";

export interface SharedJoinEndpointPosition {
  readonly segment: string;
  readonly type: readonly [number, number];
  readonly item: readonly [number, number] | null;
  readonly assoc: -1 | 0;
}
export interface SharedJoinTextBinding { readonly end: SharedJoinEndpointPosition; readonly start: SharedJoinEndpointPosition; readonly stop: SharedJoinEndpointPosition }
export function sharedJoinEndpointField(join: string): string { return "joinEnd:" + join; }

function readPosition(raw: unknown): SharedJoinEndpointPosition | null {
  const value = sharedJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "assoc,item,segment,type") return null;
  const record = value as Record<string, unknown>;
  const identity = (raw: unknown): readonly [number, number] | null => Array.isArray(raw) && raw.length === 2
    && typeof raw[0] === "number" && Number.isInteger(raw[0]) && raw[0] >= 0 && raw[0] <= 0xffffffff
    && typeof raw[1] === "number" && Number.isSafeInteger(raw[1]) && raw[1] >= 0 ? [raw[0] || 0, raw[1] || 0] : null;
  const type = identity(record.type), item = record.item === null ? null : identity(record.item);
  return typeof record.segment === "string" && record.segment && isStableSharedIdentity(record.segment) && type && (record.item === null || item) && (record.assoc === -1 || record.assoc === 0)
    ? { segment: record.segment, type, item, assoc: record.assoc } : null;
}
export function readSharedJoinEndpoint(raw: unknown): SharedJoinTextBinding | null {
  const value = sharedJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "end,start,stop") return null;
  const record = value as Record<string, unknown>, end = readPosition(record.end), start = readPosition(record.start), stop = readPosition(record.stop);
  return end && start && stop && end.assoc === 0 && start.assoc === -1 && stop.assoc === 0 && start.segment === stop.segment ? { end, start, stop } : null;
}

export function sharedJoinEndpointOffset(position: SharedJoinEndpointPosition, doc: Y.Doc, text: unknown): number | null {
  if (!(text instanceof Y.Text)) return null;
  const relative = Y.createRelativePositionFromJSON({ type: { client: position.type[0], clock: position.type[1] },
    item: position.item ? { client: position.item[0], clock: position.item[1] } : null, assoc: position.assoc });
  const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
  return absolute?.type === text ? absolute.index : null;
}
