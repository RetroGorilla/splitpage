import * as Y from "yjs";
import type { SharedTextAddress, SharedContentRef } from "../../core/collab/operations.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { collabTextTarget, collabWritingTextTarget, collabPurposeTextTarget, collabPreparedOperationTextTarget } from "./text-target.ts";
import { resolveCollabTextAnchor, encodeCollabTextAnchor } from "./anchors.ts";
import { transactSharedDocument } from "./document.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle } from "./state.ts";
import { readSharedMarkRecord, readSharedMarkRecordIdentity, sharedMarkContains, sharedMarkRecordKey } from "./mark-record.ts";
import type { SharedMarkRecord, SharedMarkGroup, SharedMarkedCharacter } from "./mark-record.ts";
import { sharedPreparedValue, sharedPreparedTextInsert, freezeSharedPreparedValue } from "./prepare-value.ts";
import { prepareSharedMarkWrite } from "./mark-plan.ts";
import type { SharedMarkWritePlan, SharedMarkWriteChangeInput } from "./mark-plan.ts";
import type { SharedMarkBirth } from "./mark-record.ts";
import { countSharedRead } from "./read-counts.ts";

export type SharedMarkWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: "missing-text" | "missing-store" | "invalid-record" | "existing-record" };
export interface SharedResolvedMarkRecord { readonly identity: SharedContentRef; readonly record: SharedMarkRecord; readonly from: number | null; readonly to: number | null }
type LocatedMark = { record: SharedMarkRecord; reference: SharedContentRef; from: number; to: number; order: number };

function writingIdentity(handle: SharedDocumentHandle) { const state = collabState(handle); return state.hydrating ? "hydration" as const : state.doc.clientID; }

export function writeSharedMarkRecord(handle: SharedDocumentHandle, target: SharedTextAddress, key: string, raw: unknown): SharedMarkWriteResult {
  assertSharedDocumentIdle(collabState(handle));
  const normalized = sharedMarkRecordKey(key, writingIdentity(handle)), record = normalized && readSharedMarkRecord(normalized, raw);
  if (!record) return { ok: false, reason: "invalid-record" };
  const found = collabWritingTextTarget(handle, target);
  if (!found) return { ok: false, reason: "missing-text" };
  const store: unknown = found.container.get(found.marksKey);
  if (!(store instanceof Y.Map)) return { ok: false, reason: "missing-store" };
  const start = resolveCollabTextAnchor(handle, record.start, found.text), end = resolveCollabTextAnchor(handle, record.end, found.text);
  const from = start.kind === "gone" ? null : start.index, to = end.kind === "gone" ? null : end.index;
  if (from === null || to === null || to < from || from < found.from || to > found.to) return { ok: false, reason: "invalid-record" };
  if (store.has(normalized)) return { ok: false, reason: "existing-record" };
  transactSharedDocument(handle, "local-command", () => storeRecord(store, normalized, record));
  return { ok: true };
}

export function prepareSharedMarkRecord(handle: SharedDocumentHandle, target: SharedTextAddress, operation: string, from: number, to: number,
  change: SharedMarkWriteChangeInput): SharedMarkRecord | null {
  const found = collabWritingTextTarget(handle, target);
  if (!found || from < found.from || to > found.to || change.born === "inserted") return null;
  const plan = prepareSharedMarkWrite({ length: found.text.length, recordKeys: [] }, writingIdentity(handle), operation, from, to, change);
  return plan ? anchoredRecord(found.text, found.target, plan, null) : null;
}

function anchoredRecord(text: Y.Text, target: SharedTextAddress, plan: SharedMarkWritePlan, inserted: SharedMarkBirth | null): SharedMarkRecord {
  const start = encodeCollabTextAnchor(text, target, plan.from, "after"), end = encodeCollabTextAnchor(text, target, plan.to, "before"), change = plan.change;
  if (change.type === "add") return { type: "add", operation: plan.operation, writer: plan.writer, start, end, mark: change.mark, born: change.born === "inserted" ? inserted : change.born };
  if (change.type === "remove") return { type: "remove", operation: plan.operation, writer: plan.writer, start, end, observed: change.observed };
  return { type: "birth", operation: plan.operation, writer: plan.writer, start, end, observed: change.observed, born: (change.born === "inserted" ? inserted : change.born) as SharedMarkBirth };
}

function storeRecord(store: Y.Map<unknown>, key: string, record: SharedMarkRecord): void { store.set(key, record); }

export function writeCollabMarkPlan(text: Y.Text, store: Y.Map<unknown>, target: SharedTextAddress, plan: SharedMarkWritePlan, inserted: SharedMarkBirth | null): void {
  storeRecord(store, plan.identity, anchoredRecord(text, target, plan, inserted));
}

export function applySharedMarkWrite(handle: SharedDocumentHandle, description: { readonly target: SharedTextAddress; readonly plan: Extract<SharedMarkWritePlan, { kind: "record" }> }): void {
  const { text, store } = collabPreparedOperationTextTarget(handle, description.target);
  writeCollabMarkPlan(text, store, description.target, description.plan, null);
}

export function readSharedMarkCharacters(handle: SharedDocumentHandle, target: SharedTextAddress): SharedMarkedCharacter[] | null {
  const found = target.segment === target.owner ? collabTextTarget(handle, target) : collabPurposeTextTarget(handle, target, "stored-anchor-read");
  if (!found) return null;
  return [...readCollabMarkState(handle, found.text, found.container.get(found.marksKey)).characters];
}

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
    for (const { record, reference } of relevant) if (record.type === "add" && !excluded.has(reference) && record.mark.value !== null) {
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
