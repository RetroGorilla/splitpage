import type { SharedContentRef, SharedOperation, SharedScalarSet } from "../../core/collab/operations.ts";
import type { StampPorts } from "../../application/session/ports.ts";
import { sharedJson } from "./snapshot.ts";
import { scalarFieldAllowed } from "./scalar-fields.ts";

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

function wins(stamp: { readonly at: string; readonly by: string | null }, other: { readonly at: string; readonly by: string | null }): boolean {
  if (stamp.at !== other.at) return stamp.at > other.at;
  if ((stamp.by ?? "") !== (other.by ?? "")) return (stamp.by ?? "") > (other.by ?? "");
  return JSON.stringify(stamp) > JSON.stringify(other);
}

// why: each copy keeps its stamp under its own key, so stamps written without seeing each other are all kept
// and the one shown is chosen by content: docs/collaboration/stage-2-commit-time-writers.md#stamps
export function readSharedStamp(beat: { keys: () => Iterable<string>; get: (key: string) => unknown }): Record<string, unknown> | undefined {
  const base = sharedJson(beat.get(SHARED_STAMP_FIELD));
  // why: a stamp step removes the stamps it saw, so a stamp stored with the beat means no step has written since.
  if (base !== undefined) return retained(base) ? base : undefined;
  let shown: { readonly at: string; readonly by: string | null } | undefined;
  for (const key of stampKeys(beat.keys())) {
    const value = sharedJson(beat.get(key));
    if (scalarFieldAllowed("beat", SHARED_STAMP_FIELD, value, false)) {
      const stamp = value as { readonly at: string; readonly by: string | null };
      if (!shown || wins(stamp, shown)) shown = stamp;
    }
  }
  return shown;
}

export function sharedStampWrites(keys: Iterable<string>, get: (key: string) => unknown, writer: string,
  value: unknown): readonly { readonly key: string; readonly kind: "delete" | "set"; readonly value?: unknown }[] {
  const own = SHARED_STAMP_FIELD + ":" + writer, seen = stampKeys(keys);
  if (seen.length === 1 && seen[0] === own && JSON.stringify(get(own)) === JSON.stringify(value)) return [];
  return [...seen.filter(key => key !== own).map(key => ({ key, kind: "delete" as const })), { key: own, kind: "set" as const, value }];
}
