import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, guardSharedCallback } from "./state.ts";
import { readSharedTextRestoreOperation } from "./mark-provenance.ts";

interface Dependency { readonly map: Y.Map<unknown>; readonly key?: string; readonly ignore?: (key: string) => boolean; readonly births?: Y.Text; readonly children?: string | true }
interface Range { readonly text: Y.Text; from: number; to: number }
interface Observation { readonly maps: Dependency[]; readonly ranges: Range[]; dirty: boolean; readonly value: boolean }
interface Cache { readonly entries: Map<string, Observation>; readonly hidden: Set<string>; revision: number }
interface NativeNode { readonly _item: Y.Item | null }
let collecting: { maps: Dependency[]; ranges: Range[] } | null = null;

export function watchSharedCreationMap(map: Y.Map<unknown>, key?: string, ignore?: (key: string) => boolean): void {
  collecting?.maps.push({ map, ...(key === undefined ? {} : { key }), ...(ignore ? { ignore } : {}) });
}
export function watchSharedCreationChildren(map: Y.Map<unknown>, field: string | true = true): void { collecting?.maps.push({ map, children: field }); }
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
      // why: ordinary added characters cannot repair a mismatch; deletions, formatting and restorations can.
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

function childChanged(dependency: Dependency, type: object, fields: ReadonlySet<string | null>): boolean {
  let node = type as NativeNode, field: string | null = null;
  while (node._item && node._item.parent !== dependency.map) { field = node._item.parentSub; node = node._item.parent as NativeNode; }
  return node._item?.parent === dependency.map && (dependency.children === true
    || typeof dependency.children === "string" && (node === type ? fields.has(dependency.children) : field === dependency.children));
}

function cache(handle: SharedDocumentHandle): Cache {
  const state = collabState(handle);
  return state.reads.keep(state.roots.beats, "creation-observations", () => {
    const value: Cache = { entries: new Map(), hidden: new Set(), revision: state.revision };
    const changed = (transaction: Y.Transaction) => guardSharedCallback(state, () => {
      const changes = transaction.changed as unknown as ReadonlyMap<object, Set<string | null>>;
      let deleted: Set<unknown> | null = null;
      const deletedText = (text: Y.Text) => {
        if (!deleted) {
          deleted = new Set();
          Y.iterateDeletedStructs(transaction, transaction.deleteSet, item => {
            if (item instanceof Y.Item && item.countable) deleted?.add(item.parent);
          });
        }
        return deleted.has(text);
      };
      for (const entry of value.entries.values()) {
        for (const range of entry.ranges) {
          const subs = changes.get(range.text);
          if (subs && (entry.value ? moved(range, transaction, subs, entry.value) : deletedText(range.text))) entry.dirty = true;
        }
        for (const dependency of entry.maps) {
          if (dependency.children && [...changes].some(([type, fields]) => childChanged(dependency, type, fields))) entry.dirty = true;
          const changedKeys = changes.get(dependency.map); if (!changedKeys) continue;
          const keys = [...changedKeys].filter(key => key === null || !dependency.ignore?.(key));
          if (dependency.key !== undefined) { if (keys.includes(dependency.key)) entry.dirty = true; }
          else if (keys.length && (!dependency.births || !changes.has(dependency.births) || keys.some(key => {
            const item = key === null ? null : dependency.map._map.get(key);
            const record: unknown = item && !item.deleted ? item.content.getContent()[0] : null;
            if (!record || typeof record !== "object" || !("type" in record) || !("operation" in record) || typeof record.operation !== "string") return true;
            // why: marks born on new characters cannot alter older characters; restore births still invalidate.
            return readSharedTextRestoreOperation(record.operation) !== null
              || record.type !== "birth" && !(record.type === "add" && "born" in record && record.born !== null);
          }))) entry.dirty = true;
        }
      }
      value.revision = state.revision;
    });
    state.doc.on("beforeObserverCalls", changed);
    state.doc.once("destroy", () => guardSharedCallback(state, () => { state.doc.off("beforeObserverCalls", changed); }));
    return value;
  });
}

export function cachedSharedCreationObservation(handle: SharedDocumentHandle, beat: string, read: () => boolean): boolean {
  const state = collabState(handle), held = cache(handle), previous = held.entries.get(beat);
  // why: open writes and callbacks before dependency invalidation must read the current contents.
  if (!state.reads.settled || held.revision !== state.revision) return read();
  if (previous && !previous.dirty) return previous.value;
  const before = collecting, dependencies = { maps: [] as Dependency[], ranges: [] as Range[] };
  collecting = dependencies;
  try {
    const value = read(); held.entries.set(beat, { ...dependencies, dirty: false, value });
    if (value) held.hidden.add(beat); else held.hidden.delete(beat);
    return value;
  } finally { collecting = before; }
}

export function sharedCreationObservationDirty(handle: SharedDocumentHandle, beat: string): boolean {
  const state = collabState(handle), held = cache(handle), entry = held.entries.get(beat);
  return !state.reads.settled || held.revision !== state.revision || !entry || entry.dirty;
}

export function sharedCreationObservationHidden(handle: SharedDocumentHandle): Set<string> { return cache(handle).hidden; }

export function pruneSharedCreationObservations(handle: SharedDocumentHandle, markers: ReadonlySet<string>): void {
  const held = cache(handle);
  for (const beat of held.entries.keys()) if (!markers.has(beat)) { held.entries.delete(beat); held.hidden.delete(beat); }
}
