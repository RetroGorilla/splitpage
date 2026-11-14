import type { SharedRecordCollection, SharedRecordCreate, SharedRecordSet, SharedRecordDelete, SharedRecordRevive } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import type { SharedOperationHandlers } from "./operation-handlers.ts";
import { isSharedRecordNestedField, readPreparedDeletedRecord, readPreparedSharedRecord, readSharedNestedInput, sharedRecordFieldAccepted } from "./record-codec.ts";
import { isSharedStatusScope, readPreparedRecordDeletion, sharedRecordChanges, sharedRecordObservation, sharedRecordStatusObservation, SHARED_RECORD_DELETION_FIELD } from "./record-deletion.ts";
import type { SharedRecordDeletion } from "./record-deletion.ts";
import { noteSharedPlannedPicture, SHARED_GALLERY_RETIREMENT_FIELD } from "./gallery-retirement.ts";
import { applySharedMapWrites } from "./prepare.ts";
import type { SharedPreparedWrite, SharedPreparationView, SharedPreparationResult } from "./prepare.ts";
import { sharedJson } from "./snapshot.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedResolutionEntryAccepted, sharedResolutionOperation, sharedResolutionWrites } from "./stamp.ts";
import { prepareSharedCreatedAttachment, sharedPendingAttachmentKeys } from "./structure-content.ts";
import { reserveSharedCommandIdentities } from "./structure-identity.ts";

function candidate(view: SharedPreparationView, writes: readonly SharedPreparedWrite[]): Pick<SharedPreparationView, "get" | "kind" | "keys"> {
  const edits = new Map<string, SharedPreparedWrite>();
  for (const write of writes) {
    for (const [key, earlier] of edits) if (earlier.path.length > write.path.length && write.path.every((part, index) => earlier.path[index] === part)) edits.delete(key);
    edits.set(JSON.stringify(write.path), write);
  }
  const change = (path: readonly string[]): SharedPreparedWrite | undefined => {
    const exact = edits.get(JSON.stringify(path));
    if (exact) return exact;
    for (let length = path.length - 1; length > 0; length--) if (edits.has(JSON.stringify(path.slice(0, length)))) return { path, kind: "delete" };
    return undefined;
  };
  const kind: SharedPreparationView["kind"] = path => {
    const write = change(path);
    return write ? write.kind === "delete" ? "missing" : write.kind === "set" ? "value" : write.kind : view.kind(path);
  };
  return { kind, get: path => { const write = change(path); return write ? write.kind === "set" ? write.value : undefined : view.get(path); },
    keys: path => {
      if (kind(path) !== "map") return Object.freeze([]);
      const keys = new Set(change(path) ? [] : view.keys(path));
      for (const write of edits.values()) if (write.path.length === path.length + 1 && path.every((part, index) => write.path[index] === part)) {
        const key = write.path.at(-1);
        if (key !== undefined) { if (write.kind === "delete") keys.delete(key); else keys.add(key); }
      }
      return Object.freeze([...keys].sort());
    } };
}
function accepted(view: SharedPreparationView, writes: readonly SharedPreparedWrite[]): SharedPreparationResult {
  for (const write of writes) {
    const [collection, record] = write.path;
    if ((collection === "visuals" || collection === "gallery") && record !== undefined) sharedPendingAttachmentKeys(view, collection).add(record);
    if (collection === "gallery" && record !== undefined) noteSharedPlannedPicture(view, record, false);
  }
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}
type Author = { readonly id: string; readonly by: string };

function observed(view: SharedPreparationView, collection: SharedRecordCollection, path: readonly string[]) {
  const scope = path.length === 2 ? isSharedStatusScope(collection) : null, record = path[1];
  return sharedRecordObservation(view, path, scope && record !== undefined ? sharedRecordStatusObservation(view, scope, record) : null, path.length === 2 ? collection : null);
}
// why: a removal keeps the record's map and marks it with what it saw, so an edit made without seeing the removal
// still lands in that map and recovery can show it.
function deletionMark(view: SharedPreparationView, author: Author, collection: SharedRecordCollection, path: readonly string[]): SharedRecordDeletion {
  return { id: JSON.stringify([view.writer, author.id]), by: author.by, seen: observed(view, collection, path) };
}
function racedFields(view: SharedPreparationView, collection: SharedRecordCollection, path: readonly string[], deletion: SharedRecordDeletion | null): ReadonlySet<string> {
  return new Set(deletion ? sharedRecordChanges(deletion.seen, observed(view, collection, path)) : []);
}
function setValue(view: SharedPreparationView, writes: SharedPreparedWrite[], path: readonly string[], value: unknown): void {
  if (JSON.stringify(sharedJson(view.get(path))) !== JSON.stringify(sharedJson(value))) writes.push({ path, kind: "set", value });
}
function nestedWrites(view: SharedPreparationView, writes: SharedPreparedWrite[], path: readonly string[], field: "links" | "props", value: unknown, author: Author,
  visible: readonly { readonly key: string }[] = []): boolean {
  const entries = readSharedNestedInput(field, value);
  if (!entries) return false;
  const visibleKeys = new Set(visible.map(entry => entry.key)), removed = (key: string) => readPreparedRecordDeletion(view, [...path, key]);
  if (entries.some(([key]) => view.has([...path, key]) && !visibleKeys.has(key) && !removed(key))) return false;
  if (view.kind(path) !== "map") writes.push({ path, kind: "map" });
  const retained = new Set(entries.map(([key]) => key));
  for (const key of visibleKeys) if (!retained.has(key)) writes.push({ path: [...path, key, SHARED_RECORD_DELETION_FIELD], kind: "set", value: deletionMark(view, author, "shots", [...path, key]) });
  entries.forEach(([key, fields], index) => {
    const entry = [...path, key], deletion = removed(key);
    // why: an entry put back after someone edited it without seeing its removal keeps that edit.
    const raced = new Set(deletion ? sharedRecordChanges(deletion.seen, sharedRecordObservation(view, entry, null)) : []);
    if (view.kind(entry) !== "map") writes.push({ path: entry, kind: "map" });
    if (field === "props") { if (!raced.has("value")) setValue(view, writes, [...entry, "value"], fields); }
    else {
      for (const name of view.keys(entry)) if (name !== "rank" && name !== "extra" && name !== SHARED_RECORD_DELETION_FIELD && !Object.hasOwn(fields, name) && !raced.has(name)) {
        writes.push({ path: [...entry, name], kind: "delete" });
      }
      for (const [name, value] of Object.entries(fields)) if (!raced.has(name)) setValue(view, writes, [...entry, name], value);
      if (!view.has([...entry, "extra"])) writes.push({ path: [...entry, "extra"], kind: "set", value: "{}" });
    }
    if (deletion) writes.push({ path: [...entry, SHARED_RECORD_DELETION_FIELD], kind: "delete" });
    setValue(view, writes, [...entry, "rank"], String(index).padStart(10, "0"));
  });
  return true;
}

function prepareCreate(operation: SharedRecordCreate, view: SharedPreparationView): SharedPreparationResult {
  const { collection, record: key } = operation.target, path = [collection, key];
  if (![operation.id, operation.by, key].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  const created = prepareSharedCreatedAttachment(operation, view); if (created) return created;
  const deletion = view.has(path) ? readPreparedRecordDeletion(view, path) : null;
  if (view.has(path) && !deletion) return { ok: false, reason: "duplicate-record" };
  const fields: Record<string, unknown> = { ...operation.fields };
  if (collection !== "gallery" && collection !== "visuals" && collection !== "replies") {
    if (fields.id !== undefined && fields.id !== key) return { ok: false, reason: "mismatched-record-id" };
    fields.id = key;
  }
  if (collection === "comments" || collection === "replies") {
    if (fields.author !== undefined && fields.author !== operation.by) return { ok: false, reason: "foreign-author" };
    fields.author = operation.by;
  }
  if (collection === "tags" && !Object.hasOwn(fields, "status")) fields.status = "needed";
  if (collection === "shots") { if (!Object.hasOwn(fields, "status")) fields.status = "unshot"; if (!Object.hasOwn(fields, "props")) fields.props = []; }
  if (collection === "gallery") { if (!Object.hasOwn(fields, "links")) fields.links = []; if (!Object.hasOwn(fields, "picture")) fields.picture = {}; }
  // why: a record created again over a removed one brings it back, keeping an edit that raced its removal.
  const raced = racedFields(view, collection, path, deletion), shown = deletion ? readPreparedDeletedRecord(collection, key, view) : null;
  const writes: SharedPreparedWrite[] = deletion ? [] : [{ path, kind: "map" }];
  for (const [field, value] of Object.entries(fields)) {
    if (raced.has(field)) continue;
    if (isSharedRecordNestedField(collection, field)) {
      const visible = shown?.[field] as readonly { readonly key: string }[] | undefined;
      if (!nestedWrites(view, writes, [...path, field], field, value, operation, visible)) return { ok: false, reason: "invalid-record-field" };
    } else {
      if (!sharedRecordFieldAccepted(collection, field, value) || collection === "visuals" && field === "text") return { ok: false, reason: "invalid-record-field" };
      if (deletion) setValue(view, writes, [...path, field], value); else writes.push({ path: [...path, field], kind: "set", value });
    }
  }
  if (deletion) writes.push({ path: [...path, SHARED_RECORD_DELETION_FIELD], kind: "delete" });
  if (!readPreparedSharedRecord(collection, key, candidate(view, writes))) return { ok: false, reason: "invalid-record-shape" };
  if (deletion) return accepted(view, writes);
  return reserveSharedCommandIdentities(view, [key, ...(typeof fields.id === "string" ? [fields.id] : [])]) ? accepted(view, writes) : { ok: false, reason: "existing-identity" };
}

function prepareSet(operation: SharedRecordSet, view: SharedPreparationView): SharedPreparationResult {
  if (![operation.id, operation.by, operation.target.record, operation.field].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  const { collection, record: key } = operation.target, path = [collection, key], value = readPreparedSharedRecord(collection, key, view);
  if (!value) return { ok: false, reason: "missing-or-invalid-record" };
  const field = operation.field;
  if (collection === "visuals" && ["text", "html", "markRecords"].includes(field)) return { ok: false, reason: "text-executor-required" };
  const immutable = collection === "comments" ? ["author", "createdAt", "anchorId", "quote", "kind", "imageValue", "conflictField", "emptyValue", "titleValue"]
    : collection === "replies" ? ["author", "createdAt", "commentId"] : collection === "shots" ? ["origin", "status"] : collection === "tags" ? ["status"]
    : collection === "gallery" ? [SHARED_GALLERY_RETIREMENT_FIELD] : [];
  if (field === "id" || immutable.includes(field)) return { ok: false, reason: "immutable-record-field" };
  if ((collection === "comments" || collection === "replies") && field === "text" && value.author !== operation.by) return { ok: false, reason: "foreign-author" };
  const writes: SharedPreparedWrite[] = [];
  if (sharedResolutionOperation(operation)) {
    if (operation.clear || !sharedResolutionEntryAccepted(operation.value)) return { ok: false, reason: "invalid-record-field" };
    writes.push(...sharedResolutionWrites(view.keys(path), key => view.get([...path, key]), view.writer, operation.value).map(({ key, ...write }) => ({ ...write, path: [...path, key] })));
  } else if (operation.clear) { if (view.keys(path).includes(field)) writes.push({ path: [...path, field], kind: "delete" }); }
  else if (isSharedRecordNestedField(collection, field)) {
    if (!nestedWrites(view, writes, [...path, field], field, operation.value, operation, value[field] as readonly { readonly key: string }[] | undefined)) return { ok: false, reason: "invalid-record-field" };
  } else {
    if (!sharedRecordFieldAccepted(collection, field, operation.value)) return { ok: false, reason: "invalid-record-field" };
    setValue(view, writes, [...path, field], operation.value);
  }
  return readPreparedSharedRecord(collection, key, candidate(view, writes)) ? accepted(view, writes) : { ok: false, reason: "invalid-record-shape" };
}

function prepareDelete(operation: SharedRecordDelete, view: SharedPreparationView): SharedPreparationResult {
  const { collection, record: key } = operation.target;
  if (![operation.id, operation.by, key].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  const record = readPreparedSharedRecord(collection, key, view);
  if (!record) return { ok: false, reason: "missing-or-invalid-record" };
  // why: assumed rule 54 on #1414: a deleted person keeps its name, so recovery can list and restore it.
  const kept: SharedPreparedWrite[] = collection === "people" ? [{ path: ["deletedPeople", key], kind: "set", value: { name: record.name, by: operation.by } }] : [];
  if (collection === "visuals") return accepted(view, [{ path: [collection, key], kind: "delete" }, ...kept]);
  const result = accepted(view, [{ path: [collection, key, SHARED_RECORD_DELETION_FIELD], kind: "set", value: deletionMark(view, operation, collection, [collection, key]) }, ...kept]);
  if (collection === "gallery") noteSharedPlannedPicture(view, key, true);
  return result;
}

function prepareRevive(operation: SharedRecordRevive, view: SharedPreparationView): SharedPreparationResult {
  const { collection, record: key } = operation.target, path = [collection, key];
  if (![operation.id, operation.by, key, ...operation.entry === undefined ? [] : [operation.entry]].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  if (collection === "visuals" || (operation.field === undefined) !== (operation.entry === undefined)) return { ok: false, reason: "invalid-revival" };
  let mark: readonly string[];
  if (operation.field !== undefined && operation.entry !== undefined) {
    if (!isSharedRecordNestedField(collection, operation.field)) return { ok: false, reason: "invalid-revival" };
    if (!readPreparedSharedRecord(collection, key, view)) return { ok: false, reason: "missing-or-invalid-record" };
    mark = [...path, operation.field, operation.entry];
  } else {
    if (!readPreparedDeletedRecord(collection, key, view)) return { ok: false, reason: readPreparedSharedRecord(collection, key, view) ? "record-not-deleted" : "missing-or-invalid-record" };
    mark = path;
  }
  if (!readPreparedRecordDeletion(view, mark)) return { ok: false, reason: "record-not-deleted" };
  const writes: SharedPreparedWrite[] = [{ path: [...mark, SHARED_RECORD_DELETION_FIELD], kind: "delete" }];
  return readPreparedSharedRecord(collection, key, candidate(view, writes)) ? accepted(view, writes) : { ok: false, reason: "invalid-record-shape" };
}

export const recordHandlers: SharedOperationHandlers = Object.freeze({ "record-create": prepareCreate, "record-set": prepareSet, "record-delete": prepareDelete, "record-revive": prepareRevive });
export function registerSharedRecordHandlers(handle: SharedDocumentHandle): void { registerSharedOperationHandlers(handle, recordHandlers); }
