import * as Y from "yjs";
import type { CollabRoots } from "./roots.ts";
import { sharedJson } from "./snapshot.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";
import { isSharedResolutionKey } from "./stamp.ts";

export const SHARED_RECORD_DELETION_FIELD = "deletion";
export type SharedDeletionSeen = Readonly<Record<string, string>>;
export interface SharedRecordDeletion { readonly id: string; readonly by: string; readonly seen: SharedDeletionSeen }
export interface SharedDeletionView {
  readonly get: (path: readonly string[]) => unknown;
  readonly keys: (path: readonly string[]) => readonly string[];
  readonly kind: (path: readonly string[]) => "map" | "text" | "array" | "value" | "missing";
}
type StatusRoots = Pick<CollabRoots, "statusEvents" | "retiredStatus">;

const STATUS = "#status";

// why: a mark keeps one short digest per field instead of a copy of the record, so a removal stays small.
function digest(text: string): string {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    a = Math.imul(a ^ unit, 2654435761); b = Math.imul(b ^ unit, 1597334677);
  }
  a = Math.imul(a ^ a >>> 16, 2246822507) ^ Math.imul(b ^ b >>> 13, 3266489909);
  b = Math.imul(b ^ b >>> 16, 2246822507) ^ Math.imul(a ^ a >>> 13, 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

const REMOVED = "~";

function tree(view: SharedDeletionView, path: readonly string[]): unknown {
  if (view.kind(path) !== "map") return sharedJson(view.get(path)) ?? null;
  return Object.fromEntries([...view.keys(path)].sort().map(key => [key, tree(view, [...path, key])]));
}

export function readSharedRecordDeletion(raw: unknown): SharedRecordDeletion | null {
  const value = sharedJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, by, seen } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof by !== "string" || !isStableSharedIdentity(by) || !seen || typeof seen !== "object" || Array.isArray(seen)) return null;
  const fields = Object.entries(seen as Record<string, unknown>);
  return fields.every(([, hash]) => typeof hash === "string") ? { id, by, seen: Object.fromEntries(fields) as SharedDeletionSeen } : null;
}

export function readPreparedRecordDeletion(view: Pick<SharedDeletionView, "get" | "kind">, path: readonly string[]): SharedRecordDeletion | null {
  return view.kind(path) === "map" ? readSharedRecordDeletion(view.get([...path, SHARED_RECORD_DELETION_FIELD])) : null;
}

export function readStoredRecordDeletion(raw: unknown): SharedRecordDeletion | null {
  return raw instanceof Y.Map ? readSharedRecordDeletion(raw.get(SHARED_RECORD_DELETION_FIELD)) : null;
}

// why: a status is set by events beside the record, so a standing event someone sent after the removal is an edit of
// it, and one its sender took back again is not.
export function sharedRecordStatusObservation(view: SharedDeletionView, scope: "tag" | "shot", record: string): string {
  return JSON.stringify(view.keys(["statusEvents"]).filter(key => {
    const event = readSharedStatusEvent(view.get(["statusEvents", key]));
    return event?.target.scope === scope && event.target.record === record && view.kind(["retiredStatus", key]) === "missing";
  }).sort());
}

// why: a rank only orders a list, and a comment's resolution and edit time are stamps (rule 35 on #1414), so a reorder,
// a resolve or a reply made beside a removal is not an edit that needs keeping.
function watched(collection: string | null, field: string): boolean {
  return field !== SHARED_RECORD_DELETION_FIELD && field !== "rank"
    && !(collection === "comments" && (field === "updatedAt" || field === "resolution" || isSharedResolutionKey(field)));
}

// why: a list is watched entry by entry, and an entry carrying its own removal mark is left out of both sides of the
// comparison, so removing an entry is never an edit of the record around it and its raced edits are its own.
export function sharedRecordObservation(view: SharedDeletionView, path: readonly string[], status: string | null, collection: string | null = null): SharedDeletionSeen {
  const seen: Record<string, string> = {};
  for (const field of [...view.keys(path)].sort()) {
    if (!watched(collection, field)) continue;
    const at = [...path, field];
    if (view.kind(at) !== "map") { seen[field] = digest(JSON.stringify(tree(view, at))); continue; }
    seen[field] = digest("list");
    for (const key of [...view.keys(at)].sort()) {
      seen[field + "/" + key] = readSharedRecordDeletion(view.get([...at, key, SHARED_RECORD_DELETION_FIELD])) ? REMOVED : digest(JSON.stringify(tree(view, [...at, key])));
    }
  }
  if (status !== null) seen[STATUS] = digest(status);
  return seen;
}

export function sharedRecordChanges(seen: SharedDeletionSeen, now: SharedDeletionSeen): readonly string[] {
  return [...new Set([...new Set([...Object.keys(seen), ...Object.keys(now)])].filter(field => now[field] !== REMOVED && seen[field] !== now[field])
    .map(field => field === STATUS ? "status" : field.split("/")[0] ?? field))].sort();
}

export function sharedRecordState(deletion: SharedRecordDeletion, now: SharedDeletionSeen): string {
  return deletion.id + ":" + digest(JSON.stringify(Object.entries(now).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

export function sharedRecordDeletionStoreView(roots: CollabRoots): SharedDeletionView {
  const missing = Symbol("missing");
  const at = (path: readonly string[]): unknown => {
    let value: unknown = roots[path[0] as keyof CollabRoots];
    if (value === undefined) return missing;
    for (const key of path.slice(1)) {
      if (!(value instanceof Y.Map) || !value.has(key)) return missing;
      value = value.get(key);
    }
    return value;
  };
  return {
    get: path => { const value = at(path); return value === missing || value instanceof Y.AbstractType ? undefined : value; },
    keys: path => { const value = at(path); return value instanceof Y.Map ? [...value.keys()] : []; },
    kind: path => {
      const value = at(path);
      return value === missing ? "missing" : value instanceof Y.Map ? "map" : value instanceof Y.Text ? "text" : value instanceof Y.Array ? "array" : "value";
    }
  };
}

export function isSharedStatusScope(collection: string): "tag" | "shot" | null {
  return collection === "tags" ? "tag" : collection === "shots" ? "shot" : null;
}

export function readStoredRecordObservation(roots: CollabRoots & StatusRoots, collection: string, path: readonly string[]): SharedDeletionSeen {
  const view = sharedRecordDeletionStoreView(roots), scope = isSharedStatusScope(collection), record = path[1];
  return sharedRecordObservation(view, path, scope && record !== undefined && path.length === 2 ? sharedRecordStatusObservation(view, scope, record) : null,
    path.length === 2 ? collection : null);
}
