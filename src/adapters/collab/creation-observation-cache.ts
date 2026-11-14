import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, guardSharedCallback } from "./state.ts";
import { readSharedTextRestoreOperation } from "./mark-provenance.ts";
import { readSharedJoinEntry } from "./join-record.ts";

interface Dependency { readonly map: Y.Map<unknown>; readonly key?: string; readonly ignore?: (key: string) => boolean; readonly births?: Y.Text }
interface Membership { readonly root: Y.Map<unknown>; readonly keys: ReadonlySet<string>; readonly belongs: (raw: unknown) => boolean; readonly field?: string }
interface Joined { readonly root: Y.Map<unknown>; readonly keys: ReadonlySet<string> }
interface Range { readonly text: Y.Text; from: number; to: number }
interface Dependencies { readonly maps: Dependency[]; readonly ranges: Range[]; readonly members: Membership[]; readonly joins: Joined[] }
interface Observation extends Dependencies { dirty: boolean; readonly value: boolean }
interface Cache { readonly entries: Map<string, Observation>; readonly candidates: Set<string> }
interface NativeNode { readonly _item: Y.Item | null }
let collecting: Dependencies | null = null;

export function watchSharedCreationMap(map: Y.Map<unknown>, key?: string, ignore?: (key: string) => boolean): void {
  collecting?.maps.push({ map, ...(key === undefined ? {} : { key }), ...(ignore ? { ignore } : {}) });
}
export function watchSharedCreationMembers(root: Y.Map<unknown>, keys: readonly string[], belongs: (raw: unknown) => boolean, field?: string): void {
  collecting?.members.push({ root, keys: new Set(keys), belongs, ...(field === undefined ? {} : { field }) });
}
export function watchSharedCreationJoins(root: Y.Map<unknown>, keys: ReadonlySet<string>): void { collecting?.joins.push({ root, keys }); }
export function watchSharedCreationText(text: Y.Text, from: number, to: number, store: unknown): void {
  collecting?.ranges.push({ text, from, to });
  if (store instanceof Y.Map) collecting?.maps.push({ map: store, births: text });
}

function moved(range: Range, transaction: Y.Transaction, subs: Set<string | null>, positive: boolean): boolean {
  let offset = 0, shiftFrom = 0, shiftTo = 0, dirty = false;
  for (const part of new Y.YTextEvent(range.text, transaction, subs).delta) {
    if (part.retain) { if (part.attributes && offset < range.to && offset + part.retain > range.from) dirty = true; offset += part.retain; }
    if (part.insert !== undefined) {
      const length = typeof part.insert === "string" ? part.insert.length : 1;
      if (positive && offset >= range.from && offset <= range.to || typeof part.insert !== "string") dirty = true;
      if (offset < range.from) shiftFrom += length;
      if (offset <= range.to) shiftTo += length;
    }
    if (part.delete) {
      if (offset < range.to && offset + part.delete > range.from) dirty = true;
      shiftFrom -= Math.max(0, Math.min(part.delete, range.from - offset));
      shiftTo -= Math.max(0, Math.min(part.delete, range.to - offset)); offset += part.delete;
    }
  }
  range.from += shiftFrom; range.to += shiftTo; return dirty;
}

function peek(root: Y.Map<unknown>, key: string): unknown {
  const item = root._map.get(key); return item && !item.deleted ? item.content.getContent()[0] : null;
}
function child(root: Y.Map<unknown>, type: object) {
  let node = type as NativeNode, field: string | null = null;
  while (node._item && node._item.parent !== root) { field = node._item.parentSub; node = node._item.parent as NativeNode; }
  return node._item?.parent === root && typeof node._item.parentSub === "string" ? { key: node._item.parentSub, field } : null;
}
function membershipChanged(dependency: Membership, changes: ReadonlyMap<object, Set<string | null>>): boolean {
  for (const key of changes.get(dependency.root) ?? []) if (key !== null && (dependency.keys.has(key) || dependency.belongs(peek(dependency.root, key)))) return true;
  for (const [type, fields] of changes) {
    const at = child(dependency.root, type);
    if (at && (dependency.field === undefined || at.field === dependency.field || at.field === null && fields.has(dependency.field))
      && (dependency.keys.has(at.key) || dependency.belongs(peek(dependency.root, at.key)))) return true;
  }
  return false;
}
function joinsChanged(dependency: Joined, changes: ReadonlyMap<object, Set<string | null>>): boolean {
  return membershipChanged({ ...dependency, field: "joins", belongs: raw => {
    const joins: unknown = raw instanceof Y.Map ? peek(raw, "joins") : null;
    return joins instanceof Y.Map && [...joins.keys()].some(key => { const entry = readSharedJoinEntry(peek(joins, key)); return entry !== null && dependency.keys.has(entry.into); });
  } }, changes);
}

function cache(handle: SharedDocumentHandle): Cache {
  const state = collabState(handle);
  return state.reads.keep(state.roots.creationRetired, "creation-observations", () => {
    const entries = new Map<string, Observation>(), candidates = new Set(state.roots.creationRetired.keys());
    const changed = (transaction: Y.Transaction) => guardSharedCallback(state, () => {
      const changes = transaction.changed as unknown as ReadonlyMap<object, Set<string | null>>;
      for (const beat of changes.get(state.roots.creationRetired) ?? []) if (beat !== null) {
        if (state.roots.creationRetired.has(beat)) { candidates.add(beat); const entry = entries.get(beat); if (entry) entry.dirty = true; }
        else { candidates.delete(beat); entries.delete(beat); }
      }
      for (const [beat, entry] of entries) {
        if (!state.roots.creationRetired.has(beat)) { entries.delete(beat); candidates.delete(beat); continue; }
        for (const range of entry.ranges) {
          const subs = changes.get(range.text);
          if (subs && moved(range, transaction, subs, entry.value)) entry.dirty = true;
        }
        if (entry.members.some(dependency => membershipChanged(dependency, changes)) || entry.joins.some(dependency => joinsChanged(dependency, changes))) entry.dirty = true;
        for (const dependency of entry.maps) {
          const changedKeys = changes.get(dependency.map); if (!changedKeys) continue;
          const keys = [...changedKeys].filter(key => key === null || !dependency.ignore?.(key));
          if (dependency.key !== undefined) { if (keys.includes(dependency.key)) entry.dirty = true; }
          else if (keys.length && (!dependency.births || !changes.has(dependency.births) || keys.some(key => {
            const record: unknown = key === null ? null : peek(dependency.map, key);
            if (!record || typeof record !== "object" || !("type" in record) || !("operation" in record) || typeof record.operation !== "string") return true;
            // why: marks born on new characters cannot alter older characters; restore births still invalidate.
            return readSharedTextRestoreOperation(record.operation) !== null
              || record.type !== "birth" && !(record.type === "add" && "born" in record && record.born !== null);
          }))) entry.dirty = true;
        }
        if (entry.dirty) candidates.add(beat);
      }
    });
    state.doc.on("beforeObserverCalls", changed);
    state.doc.once("destroy", () => guardSharedCallback(state, () => { state.doc.off("beforeObserverCalls", changed); }));
    return { entries, candidates };
  });
}

export function sharedCreationReadsSettled(handle: SharedDocumentHandle): boolean {
  const state = collabState(handle); return state.reads.settled && state.transactionDepth === 0;
}
export function peekSharedCreationObservation(handle: SharedDocumentHandle, beat: string): boolean | undefined {
  if (!sharedCreationReadsSettled(handle)) return undefined;
  const previous = cache(handle).entries.get(beat); return previous && !previous.dirty ? previous.value : undefined;
}
export function cachedSharedCreationObservation(handle: SharedDocumentHandle, beat: string, read: () => boolean): boolean {
  // why: the native transaction remains open through its observers; only then have all dependencies been invalidated.
  if (!sharedCreationReadsSettled(handle)) return read();
  const { entries, candidates } = cache(handle), previous = entries.get(beat);
  if (previous && !previous.dirty) return previous.value;
  const before = collecting, dependencies: Dependencies = { maps: [], ranges: [], members: [], joins: [] }; collecting = dependencies;
  try {
    const value = read(); entries.set(beat, { ...dependencies, dirty: false, value });
    if (value) candidates.add(beat); else candidates.delete(beat); return value;
  } finally { collecting = before; }
}

export function readSharedCreationCandidates(handle: SharedDocumentHandle): ReadonlySet<string> {
  const state = collabState(handle);
  return sharedCreationReadsSettled(handle) ? cache(handle).candidates : new Set(state.roots.creationRetired.keys());
}
