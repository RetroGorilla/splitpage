import * as Y from "yjs";
import type { SharedSoftRemove, SharedTextAddress } from "../../core/collab/operations.ts";
import { readTextInsert } from "../../core/collab/read-operation.ts";
import { readSharedBufferRecoveryMetadata } from "../../core/collab/removal-state.ts";
import type { SharedRemovalBufferSource } from "../../core/collab/removal-state.ts";
import type { SharedTextIdentity } from "./mark-record.ts";
import { sharedPreparedValue } from "./prepare-value.ts";
import { sharedStructureIdentity } from "./structure-identity.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { readSharedActiveRemovals, readSharedRemovalState } from "./removal-state.ts";
import { sharedRecoveryIdentityKey } from "../../core/collab/recovery.ts";
import type { SharedRecoveryRemovalSource } from "../../core/collab/recovery.ts";
import type { CollabReadCaches } from "./read-cache.ts";

export interface SharedRemovalTarget { readonly beat: string; readonly segment: string; readonly generation: number }
export interface SharedRemovalObservation { readonly target: SharedTextAddress; readonly identities: readonly SharedTextIdentity[] }
export type SharedStoredRemovalCommand = {
  readonly writer: string; readonly operation: string; readonly by: string; readonly targets: readonly SharedRemovalTarget[];
} & ({ readonly kind: "restore"; readonly removals: readonly string[] } | {
  readonly kind: "remove"; readonly removalKind: SharedSoftRemove["removalKind"]; readonly at: number;
  readonly observed: readonly SharedRemovalObservation[]; readonly references: readonly string[]; readonly boundaries: readonly string[];
  readonly components: readonly string[]; readonly gallery: readonly string[]; readonly comments: readonly string[] | null;
  readonly buffer: readonly SharedRemovalBufferSource[];
});

function bag(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function ref(value: unknown): value is string { return typeof value === "string" && value.length > 0 && isStableSharedIdentity(value); }
function refs(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) if (!ref(value[index])) return false;
  return true;
}

export function readSharedRemovalCommand(key: string, raw: unknown): SharedStoredRemovalCommand | null {
  const value = bag(sharedPreparedValue(raw));
  if (!value || !ref(key) || value.kind !== "remove" && value.kind !== "restore" || !ref(value.writer) || !ref(value.operation)
    || typeof value.by !== "string" || !isStableSharedIdentity(value.by) || !Array.isArray(value.targets) || !value.targets.length) return null;
  try { if (sharedStructureIdentity(value.writer, value.operation, value.kind === "remove" ? "removal" : "restore") !== key) return null; } catch { return null; }
  const targets: SharedRemovalTarget[] = [];
  for (let index = 0; index < value.targets.length; index++) {
    const target = bag(value.targets[index]);
    if (!target || !ref(target.beat) || !ref(target.segment) || typeof target.generation !== "number" || !Number.isSafeInteger(target.generation) || target.generation < 0
      || targets.some(value => value.beat === target.beat)) return null;
    targets.push({ beat: target.beat, segment: target.segment, generation: target.generation });
  }
  const common = { writer: value.writer, operation: value.operation, by: value.by, targets };
  if (value.kind === "restore") return refs(value.removals) ? { kind: "restore", ...common, removals: value.removals } : null;
  if (typeof value.removalKind !== "string" || !["beat", "range", "header", "became-heading"].includes(value.removalKind) || typeof value.at !== "number" || !Number.isFinite(value.at)
    || !refs(value.references) || !refs(value.boundaries) || !refs(value.components) || !refs(value.gallery) || value.comments !== null && !refs(value.comments)
    || !Array.isArray(value.observed) || !Array.isArray(value.buffer)) return null;
  const observed: SharedRemovalObservation[] = [], buffer: SharedRemovalBufferSource[] = [];
  for (let index = 0; index < value.observed.length; index++) {
    const item = bag(value.observed[index]), target = item && readTextInsert({ kind: "text-insert", id: "observation", by: "", target: item.target,
      at: { left: null, right: null, affinity: "before" }, content: [] })?.target;
    if (!item || !target || !ref(target.owner) || !ref(target.segment) || !Array.isArray(item.identities)) return null;
    const identities: SharedTextIdentity[] = [];
    for (let unit = 0; unit < item.identities.length; unit++) {
      const identity = bag(item.identities[unit]);
      if (!identity || typeof identity.client !== "number" || !Number.isSafeInteger(identity.client) || identity.client < 0
        || typeof identity.clock !== "number" || !Number.isSafeInteger(identity.clock) || identity.clock < 0) return null;
      identities.push({ client: identity.client, clock: identity.clock });
    }
    observed.push({ target, identities });
  }
  for (let index = 0; index < value.buffer.length; index++) {
    const item = bag(value.buffer[index]), metadata = item && readSharedBufferRecoveryMetadata(item.metadata);
    if (!item || !ref(item.beat) || !metadata || !targets.some(target => target.beat === item.beat)) return null;
    buffer.push({ beat: item.beat, metadata });
  }
  return { kind: "remove", ...common, removalKind: value.removalKind as SharedSoftRemove["removalKind"], at: value.at, observed,
    references: value.references, boundaries: value.boundaries, components: value.components, gallery: value.gallery, comments: value.comments, buffer };
}
const noFlags = Object.freeze({ keys: Object.freeze([]), active: Object.freeze([]) });

function removalFlags(beats: Y.Map<unknown>, beat: string, caches: CollabReadCaches): { readonly keys: readonly string[]; readonly active: readonly string[] } {
  const raw = caches.entry(beats, "removal-source-beat", beat, () => beats.get(beat));
  const flags: unknown = raw instanceof Y.Map ? caches.entry(raw, "removal-source-map", "removals", () => (raw as Y.Map<unknown>).get("removals")) : null;
  return flags instanceof Y.Map ? caches.memo([flags], "removal-source-keys", () => {
    const entries = [...flags.keys()].map(key => [key, flags.get(key)] as const);
    return { keys: entries.filter(entry => readSharedRemovalState([entry]).generation !== null).map(([key]) => key), active: readSharedActiveRemovals(entries) };
  }) : noFlags;
}

function removalRecord(records: Y.Map<unknown>, key: string, caches: CollabReadCaches): SharedStoredRemovalCommand | null {
  return caches.entry(records, "removal-source-record", key, () => readSharedRemovalCommand(key, records.get(key)));
}

export function readSharedRemovalSources(records: Y.Map<unknown>, keys: readonly string[], caches: CollabReadCaches): SharedRecoveryRemovalSource[] {
  return keys.flatMap(key => {
    const source = caches.entry(records, "removal-recovery-source", key, () => {
      const record = removalRecord(records, key, caches);
      return record?.kind === "remove" ? Object.freeze({ key, by: record.by,
        observed: new Set(record.observed.flatMap(value => value.identities.map(sharedRecoveryIdentityKey))) as ReadonlySet<string> }) : null;
    });
    return source ? [source] : [];
  });
}

export function readSharedActiveRemovalSources(beats: Y.Map<unknown>, records: Y.Map<unknown>, beat: string, caches: CollabReadCaches): SharedRecoveryRemovalSource[] {
  return readSharedRemovalSources(records, removalFlags(beats, beat, caches).active, caches);
}

export function readSharedRemovalBufferSources(beats: Y.Map<unknown>, records: Y.Map<unknown>, members: readonly string[], caches: CollabReadCaches): SharedRemovalBufferSource[] {
  const sources = new Map<string, SharedRemovalBufferSource>();
  for (const beat of members) {
    for (const key of removalFlags(beats, beat, caches).keys) {
      const record = removalRecord(records, key, caches);
      if (record?.kind !== "remove") continue;
      for (const source of record.buffer) if (source.beat === beat) sources.set(JSON.stringify([beat, source.metadata.bufferSourceOwner, source.metadata.bufferPaintedBase]), source);
    }
  }
  return [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, source]) => source);
}
