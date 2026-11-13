import type * as Y from "yjs";
import type { SharedDiscardRetire, SharedRecoveryDiscard } from "../../core/collab/operations.ts";
import { sharedRecoveryKinds } from "../../core/collab/operations.ts";
import type { SharedActiveDiscard } from "../../core/collab/recovery.ts";
import { applySharedMapWrites } from "./prepare.ts";
import type { SharedPreparationResult, SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { readSharedRemovalCommand } from "./removal-record.ts";
import { sharedStructureReference } from "./structure-identity.ts";

function readDiscard(raw: unknown): SharedActiveDiscard | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { kind, key, removals } = raw as Record<string, unknown>;
  if (!sharedRecoveryKinds().some(known => known === kind) || kind === "scene-with-no-beats" || typeof key !== "string") return null;
  if (!Array.isArray(removals) || !removals.every(id => typeof id === "string")) return null;
  return { entry: { kind: kind as SharedActiveDiscard["entry"]["kind"], key }, removals: removals as string[] };
}

export function readSharedActiveDiscards(discards: Y.Map<unknown>, retired: Y.Map<unknown>): readonly SharedActiveDiscard[] {
  if (!discards.size) return [];
  return [...discards.keys()].sort().flatMap(key => {
    const discard = retired.has(key) ? null : readDiscard(discards.get(key));
    return discard ? [discard] : [];
  });
}

export function sharedRemovalDiscardRetires(view: SharedPreparationView, removals: readonly string[]): SharedPreparedWrite[] {
  return view.keys(["discards"]).filter(key => !view.has(["retiredDiscards", key])
    && (readDiscard(view.get(["discards", key]))?.removals.some(removal => removals.includes(removal)) ?? false))
    .sort().map(key => ({ path: ["retiredDiscards", key], kind: "set", value: true }));
}

function refuse(reason: string): SharedPreparationResult { return { ok: false, reason }; }

export function prepareSharedDiscard(operation: SharedRecoveryDiscard, view: SharedPreparationView): SharedPreparationResult {
  if (!isStableSharedIdentity(operation.id) || !isStableSharedIdentity(operation.by)) return refuse("unstable-identity");
  if (operation.entry.kind === "scene-with-no-beats") return refuse("not-discardable");
  const key = JSON.stringify([view.writer, operation.id]);
  if (view.kind(["discards", key]) !== "missing") return refuse("duplicate-discard");
  const removable = operation.entry.kind === "removed-beat" || operation.entry.kind === "removed-heading";
  if (removable !== operation.removals.length > 0) return refuse("invalid-discard");
  const removals = [...new Set(operation.removals.map(reference => sharedStructureReference(view, reference)))].sort();
  if (removals.some(removal => readSharedRemovalCommand(removal, view.get(["removalRecords", removal]))?.kind !== "remove")) return refuse("invalid-removal-record");
  const writes: SharedPreparedWrite[] = [{ path: ["discards", key], kind: "set", value: { kind: operation.entry.kind, key: operation.entry.key, removals, by: operation.by } }];
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}

export function prepareSharedDiscardRetire(operation: SharedDiscardRetire, view: SharedPreparationView): SharedPreparationResult {
  if (!isStableSharedIdentity(operation.id) || !isStableSharedIdentity(operation.by)) return refuse("unstable-identity");
  if (view.kind(["discards", operation.discard]) === "missing") return refuse("missing-discard");
  const writes: SharedPreparedWrite[] = view.has(["retiredDiscards", operation.discard]) ? [] : [{ path: ["retiredDiscards", operation.discard], kind: "set", value: true }];
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}
