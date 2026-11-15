import * as Y from "yjs";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { resolveCollabTextAnchor } from "./anchor-codec.ts";
import { readSharedMarkRecord, readSharedMarkRecordIdentity, sharedMarkContains } from "./mark-record.ts";
import type { SharedMarkRecord, SharedMarkGroup, SharedMarkedCharacter } from "./mark-record.ts";
import { sharedPreparedValue, sharedPreparedTextInsert, freezeSharedPreparedValue } from "./prepare-value.ts";
import { readSharedMarkProvenance } from "./mark-provenance.ts";
import { countSharedRead } from "./read-counts.ts";

export interface SharedResolvedMarkRecord { readonly identity: SharedContentRef; readonly record: SharedMarkRecord; readonly from: number | null; readonly to: number | null }
type LocatedMark = { record: SharedMarkRecord; reference: SharedContentRef; from: number; to: number; order: number };

export interface SharedMarkStateReading {
  readonly records: readonly SharedResolvedMarkRecord[];
  readonly recordKeys: readonly string[];
  readonly characters: readonly SharedMarkedCharacter[];
}

// why: a reading stays valid until its text or its record store changes; anchors move only when their own text does.
export function readCollabMarkState(handle: SharedDocumentHandle, text: Y.Text, store: unknown): SharedMarkStateReading {
  return collabState(handle).reads.memo(store instanceof Y.Map ? [text, store] : [text], "mark-state", () => freezeSharedPreparedValue(markState(handle, text, store)));
}

function markState(handle: SharedDocumentHandle, text: Y.Text, store: unknown): SharedMarkStateReading {
  const located: LocatedMark[] = [], records: SharedResolvedMarkRecord[] = [], caches = collabState(handle).reads;
  const keys = store instanceof Y.Map ? [...store.keys()].sort() : [];
  if (store instanceof Y.Map) for (const key of keys) {
    const record = caches.entry(store, "mark-record", key, () => {
      countSharedRead("markRecords");
      return readSharedMarkRecord(key, sharedPreparedValue(store.get(key)));
    });
    if (!record) continue;
    countSharedRead("markAnchors", 2);
    const start = resolveCollabTextAnchor(handle, record.start, text), end = resolveCollabTextAnchor(handle, record.end, text);
    const from = start.kind === "gone" ? null : start.index, to = end.kind === "gone" ? null : end.index;
    const reference = readSharedContentRef(key);
    if (reference) records.push({ identity: reference, record, from, to });
    if (reference && from !== null && to !== null && to > from) located.push({ record, reference, from, to, order: located.length });
  }
  const value = text.toDelta().map((delta: { insert: unknown }) => typeof delta.insert === "string" ? sharedPreparedTextInsert(delta.insert) as string : "\ufffc").join("");
  const result: SharedMarkedCharacter[] = [], starting = [...located].sort((a, b) => a.from - b.from || a.order - b.order);
  const provenance = readSharedMarkProvenance(records, keys);
  let covering: LocatedMark[] = [], next = 0;
  countSharedRead("texts");
  for (let offset = 0; offset < value.length; offset++) {
    countSharedRead("identities");
    const identity = Y.createRelativePositionFromTypeIndex(text, offset).item;
    if (!identity) throw new Error("Shared text character has no identity");
    // why: records enter at their first unit and leave at their end, so a unit meets only the records that cover it.
    for (let entering = starting[next]; entering && entering.from <= offset; entering = starting[++next]) covering.push(entering);
    if (covering.some(item => item.to <= offset)) covering = covering.filter(item => item.to > offset);
    countSharedRead("markChecks", covering.length);
    const relevant = covering.filter(item => sharedMarkContains(item.record.type === "remove" ? null : item.record.born, identity)).sort((a, b) => a.order - b.order);
    const excluded = new Set(relevant.flatMap(item => item.record.type === "add" ? [] : item.record.observed));
    const groups = new Map<string, { kind: SharedMarkGroup["kind"]; id: SharedContentRef | null; additions: { record: SharedContentRef; operation: SharedContentRef; value: true | string }[] }>();
    // why: a copy on a restored character stands for its source, so what takes the source away here takes the copy too.
    const taken = provenance ? new Set(relevant.flatMap(item => item.record.type === "remove" ? item.record.observed.map(provenance.source) : [])) : null;
    for (const { record, reference } of relevant) if (record.type === "add" && !excluded.has(reference) && record.mark.value !== null) {
      if (provenance && (taken?.has(provenance.source(reference)) || provenance.cancelled.has(provenance.source(reference)))) continue;
      const mark = record.mark;
      if (mark.value === null) continue;
      const id = "id" in mark ? mark.id : null, key = JSON.stringify([mark.kind, id]);
      let group = groups.get(key);
      if (!group) { group = { kind: mark.kind, id, additions: [] }; groups.set(key, group); }
      group.additions.push({ record: reference, operation: record.operation, value: mark.value });
    }
    const marks = [...groups.keys()].sort().map(key => {
      const group = groups.get(key);
      if (!group) throw new Error("Missing mark group");
      group.additions.sort((a, b) => a.record < b.record ? -1 : a.record > b.record ? 1 : 0);
      const values = [...new Set(group.additions.map(addition => addition.value))].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      return { kind: group.kind, id: group.id, values, additions: group.additions };
    });
    result.push({ offset, identity: { client: identity.client, clock: identity.clock }, value: value.charAt(offset), marks });
  }
  return { records, recordKeys: keys.filter(key => readSharedMarkRecordIdentity(key) !== null), characters: result };
}
