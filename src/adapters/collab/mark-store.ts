import * as Y from "yjs";
import type { SharedTextAddress, SharedContentRef } from "../../core/collab/operations.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { collabTextTarget } from "./text-target.ts";
import { createSharedAnchor, resolveSharedTextAnchor } from "./anchors.ts";
import { transactSharedDocument } from "./document.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertSharedDocumentIdle } from "./state.ts";
import { readSharedMarkRecord, sharedMarkContains, sharedMarkRecordKey } from "./mark-record.ts";
import type { SharedMarkRecord, SharedMarkGroup, SharedMarkedCharacter } from "./mark-record.ts";

export type SharedMarkWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: "missing-text" | "missing-store" | "invalid-record" | "existing-record" };
type LocatedMark = { record: SharedMarkRecord; reference: SharedContentRef; from: number; to: number };

function writingIdentity(handle: SharedDocumentHandle) { const state = collabState(handle); return state.hydrating ? "hydration" as const : state.doc.clientID; }

export function writeSharedMarkRecord(handle: SharedDocumentHandle, target: SharedTextAddress, key: string, raw: unknown): SharedMarkWriteResult {
  assertSharedDocumentIdle(collabState(handle));
  const normalized = sharedMarkRecordKey(key, writingIdentity(handle)), record = normalized && readSharedMarkRecord(normalized, raw);
  if (!record) return { ok: false, reason: "invalid-record" };
  const found = collabTextTarget(handle, target);
  if (!found) return { ok: false, reason: "missing-text" };
  const store: unknown = found.container.get(found.marksKey);
  if (!(store instanceof Y.Map)) return { ok: false, reason: "missing-store" };
  const from = resolveSharedTextAnchor(handle, record.start, target), to = resolveSharedTextAnchor(handle, record.end, target);
  if (from === null || to === null || to < from) return { ok: false, reason: "invalid-record" };
  if (store.has(normalized)) return { ok: false, reason: "existing-record" };
  transactSharedDocument(handle, "local-command", () => store.set(normalized, record));
  return { ok: true };
}

export function prepareSharedMarkRecord(handle: SharedDocumentHandle, target: SharedTextAddress, operation: string, from: number, to: number,
  change: { readonly type: "add"; readonly mark: unknown; readonly born?: unknown } | { readonly type: "remove" | "birth"; readonly observed: readonly string[]; readonly born?: unknown }): SharedMarkRecord | null {
  if (to < from) return null;
  const id = readSharedContentRef(operation), start = createSharedAnchor(handle, target, from, "after"), end = createSharedAnchor(handle, target, to, "before");
  if (!id || !start || !end) return null;
  const writer = writingIdentity(handle);
  const raw = change.type === "add" ? { type: "add", operation: id, writer, start, end, mark: change.mark, born: change.born ?? null }
    : change.type === "remove" ? { type: "remove", operation: id, writer, start, end, observed: change.observed }
    : { type: "birth", operation: id, writer, start, end, observed: change.observed, born: change.born };
  return readSharedMarkRecord(sharedMarkRecordKey(id, writer) ?? "", raw);
}

export function readSharedMarkCharacters(handle: SharedDocumentHandle, target: SharedTextAddress): SharedMarkedCharacter[] | null {
  const found = collabTextTarget(handle, target);
  if (!found) return null;
  const store: unknown = found.container.get(found.marksKey), located: LocatedMark[] = [];
  if (store instanceof Y.Map) for (const key of [...store.keys()].sort()) {
    const record = readSharedMarkRecord(key, store.get(key));
    if (!record) continue;
    const from = resolveSharedTextAnchor(handle, record.start, target), to = resolveSharedTextAnchor(handle, record.end, target);
    const reference = readSharedContentRef(key);
    if (reference && from !== null && to !== null && to > from) located.push({ record, reference, from, to });
  }
  const value = found.text.toDelta().map((delta: { insert: unknown }) => typeof delta.insert === "string" ? delta.insert : "\ufffc").join("");
  const result: SharedMarkedCharacter[] = [];
  for (let offset = 0; offset < value.length; offset++) {
    const identity = Y.createRelativePositionFromTypeIndex(found.text, offset).item;
    if (!identity) throw new Error("Shared text character has no identity");
    const relevant = located.filter(item => item.from <= offset && item.to > offset && sharedMarkContains(item.record.type === "remove" ? null : item.record.born, identity));
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
  return result;
}
