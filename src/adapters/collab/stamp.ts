import type { SharedContentRef, SharedOperation, SharedScalarSet } from "../../core/collab/operations.ts";
import type { StampPorts } from "../../application/session/ports.ts";
import { sharedJson } from "./snapshot.ts";
import { scalarFieldAllowed } from "./scalar-fields.ts";
import { isStableSharedIdentity } from "./identity.ts";

const SHARED_STAMP_FIELD = "stamp";
const SHARED_RESOLUTION_FIELD = "resolution";
const SHARED_RESOLUTION_STEP = "resolution-stamp";

interface Stamped { readonly at: string; readonly by: string | null }
interface Register { readonly keys: () => Iterable<string>; readonly get: (key: string) => unknown }

export function sharedBeatStamp(beat: SharedContentRef, author: { readonly id: string; readonly by: string }, stamps: StampPorts): SharedScalarSet {
  return { kind: "scalar", id: (author.id + ":stamp") as SharedContentRef, by: author.by, target: { scope: "beat", record: beat }, field: SHARED_STAMP_FIELD,
    value: { at: stamps.clock.nowIso(), by: stamps.editor.name() } };
}

export function sharedStampOperation(operation: SharedOperation): boolean {
  return operation.kind === "scalar" && operation.target.scope === "beat" && operation.field === SHARED_STAMP_FIELD;
}

export function sharedResolutionOperation(operation: SharedOperation): boolean {
  return operation.kind === "record-set" && operation.target.collection === "comments" && operation.field === SHARED_RESOLUTION_STEP;
}

function registerKeys(field: string, keys: Iterable<string>): string[] {
  return [...keys].filter(key => key === field || key.startsWith(field + ":")).sort();
}

export function isSharedResolutionKey(key: string): boolean { return key.startsWith(SHARED_RESOLUTION_FIELD + ":"); }

function retained(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "at")) return false;
  const by: unknown = (value as Record<string, unknown>).by;
  return Object.keys(value).every(key => key === "at" || key === "by") && (by === null || typeof by === "string");
}

function bag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

export function sharedResolutionAccepted(value: unknown): boolean {
  return bag(value) && typeof value.resolved === "boolean"
    && Object.keys(value).every(key => key === "resolved" || key === "resolvedAt" || key === "resolvedBy")
    && (value.resolvedAt === undefined || value.resolvedAt === null || typeof value.resolvedAt === "string")
    && (value.resolvedBy === undefined || value.resolvedBy === null || typeof value.resolvedBy === "string" && isStableSharedIdentity(value.resolvedBy));
}

export function sharedResolutionEntryAccepted(value: unknown): value is Stamped & { readonly resolution: unknown } {
  return bag(value) && Object.keys(value).every(key => key === "at" || key === "by" || key === "resolution") && typeof value.at === "string"
    && (value.by === null || typeof value.by === "string") && sharedResolutionAccepted(value.resolution);
}

function wins(stamp: Stamped, other: Stamped): boolean {
  if (stamp.at !== other.at) return stamp.at > other.at;
  if ((stamp.by ?? "") !== (other.by ?? "")) return (stamp.by ?? "") > (other.by ?? "");
  return JSON.stringify(stamp) > JSON.stringify(other);
}

// why: each copy keeps its stamp under its own key, so stamps written without seeing each other are all kept
// and the one shown is chosen by content: docs/collaboration/stage-2-commit-time-writers.md#stamps
function shownEntry<T extends Stamped>(field: string, register: Register, accepted: (value: unknown) => value is T): T | undefined {
  let shown: T | undefined;
  for (const key of registerKeys(field, register.keys())) {
    const value = key === field ? undefined : sharedJson(register.get(key));
    if (accepted(value) && (!shown || wins(value, shown))) shown = value;
  }
  return shown;
}

export function readSharedStamp(beat: Register): Record<string, unknown> | undefined {
  const base = sharedJson(beat.get(SHARED_STAMP_FIELD));
  // why: a stamp step removes the stamps it saw, so a stamp stored with the beat means no step has written since.
  if (base !== undefined) return retained(base) ? base : undefined;
  return shownEntry(SHARED_STAMP_FIELD, beat, (value): value is Stamped & Record<string, unknown> => scalarFieldAllowed("beat", SHARED_STAMP_FIELD, value, false));
}

export function readSharedResolution(comment: Register): unknown {
  return shownEntry(SHARED_RESOLUTION_FIELD, comment, sharedResolutionEntryAccepted)?.resolution;
}

type RegisterWrite = { readonly key: string; readonly kind: "delete" | "set"; readonly value?: unknown };

function registerWrites(field: string, keys: Iterable<string>, get: (key: string) => unknown, writer: string, value: unknown): readonly RegisterWrite[] {
  const own = field + ":" + writer, seen = registerKeys(field, keys);
  if (seen.length === 1 && seen[0] === own && JSON.stringify(get(own)) === JSON.stringify(value)) return [];
  return [...seen.filter(key => key !== own).map(key => ({ key, kind: "delete" as const })), { key: own, kind: "set" as const, value }];
}

export function sharedStampWrites(keys: Iterable<string>, get: (key: string) => unknown, writer: string, value: unknown): readonly RegisterWrite[] {
  return registerWrites(SHARED_STAMP_FIELD, keys, get, writer, value);
}

export function sharedResolutionWrites(keys: Iterable<string>, get: (key: string) => unknown, writer: string, value: unknown): readonly RegisterWrite[] {
  return registerWrites(SHARED_RESOLUTION_FIELD, keys, get, writer, value);
}
