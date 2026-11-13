import type { SharedContentRef, SharedOperation, SharedScalarSet } from "../../core/collab/operations.ts";
import type { StampPorts } from "../../application/session/ports.ts";
import { sharedJson } from "./snapshot.ts";

const SHARED_STAMP_FIELD = "stamp";

export function sharedBeatStamp(beat: SharedContentRef, author: { readonly id: string; readonly by: string }, stamps: StampPorts): SharedScalarSet {
  return { kind: "scalar", id: (author.id + ":stamp") as SharedContentRef, by: author.by, target: { scope: "beat", record: beat }, field: SHARED_STAMP_FIELD,
    value: { at: stamps.clock.nowIso(), by: stamps.editor.name() } };
}

export function sharedStampOperation(operation: SharedOperation): boolean {
  return operation.kind === "scalar" && operation.target.scope === "beat" && operation.field === SHARED_STAMP_FIELD;
}

function stampKeys(keys: Iterable<string>): string[] {
  return [...keys].filter(key => key === SHARED_STAMP_FIELD || key.startsWith(SHARED_STAMP_FIELD + ":")).sort();
}

function retained(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "at")) return false;
  const by: unknown = (value as Record<string, unknown>).by;
  return Object.keys(value).every(key => key === "at" || key === "by") && (by === null || typeof by === "string");
}

function text(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? ""; }

function wins(stamp: Record<string, unknown>, other: Record<string, unknown>): boolean {
  if (text(stamp.at) !== text(other.at)) return text(stamp.at) > text(other.at);
  if (text(stamp.by ?? "") !== text(other.by ?? "")) return text(stamp.by ?? "") > text(other.by ?? "");
  return JSON.stringify(stamp) > JSON.stringify(other);
}

// why: stamps written without seeing each other are all kept, so the one shown is chosen by its own content
// rather than by the Yjs client ids: docs/collaboration/stage-2-commit-time-writers.md#stamps
export function readSharedStamp(beat: { keys: () => Iterable<string>; get: (key: string) => unknown }): Record<string, unknown> | undefined {
  const base = sharedJson(beat.get(SHARED_STAMP_FIELD));
  // why: a stamp step removes the stamps it saw, so a stamp stored with the beat means no step has written since.
  if (base !== undefined) return retained(base) ? base : undefined;
  let shown: Record<string, unknown> | undefined;
  for (const key of stampKeys(beat.keys())) {
    const value = sharedJson(beat.get(key));
    if (retained(value) && (!shown || wins(value, shown))) shown = value;
  }
  return shown;
}

export function sharedStampWrites(keys: Iterable<string>, get: (key: string) => unknown, operation: string,
  value: unknown): readonly { readonly key: string; readonly kind: "delete" | "set"; readonly value?: unknown }[] {
  const seen = stampKeys(keys), only = seen.length === 1 ? seen[0] : undefined;
  if (only !== undefined && JSON.stringify(get(only)) === JSON.stringify(value)) return [];
  return [...seen.map(key => ({ key, kind: "delete" as const })), { key: SHARED_STAMP_FIELD + ":" + operation, kind: "set" as const, value }];
}
