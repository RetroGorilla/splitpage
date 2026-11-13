import type { SharedRecordCreate, SharedRecordSet, SharedRecordDelete } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import type { SharedOperationHandlers } from "./operation-handlers.ts";
import { isSharedRecordNestedField, readPreparedSharedRecord, readSharedNestedInput, sharedRecordFieldAccepted } from "./record-codec.ts";
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
  }
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}
function setValue(view: SharedPreparationView, writes: SharedPreparedWrite[], path: readonly string[], value: unknown): void {
  if (JSON.stringify(sharedJson(view.get(path))) !== JSON.stringify(sharedJson(value))) writes.push({ path, kind: "set", value });
}
function nestedWrites(view: SharedPreparationView, writes: SharedPreparedWrite[], path: readonly string[], field: "links" | "props", value: unknown, visible: readonly { readonly key: string }[] = []): boolean {
  const entries = readSharedNestedInput(field, value);
  if (!entries) return false;
  const visibleKeys = new Set(visible.map(entry => entry.key));
  if (entries.some(([key]) => view.has([...path, key]) && !visibleKeys.has(key))) return false;
  if (view.kind(path) !== "map") writes.push({ path, kind: "map" });
  const retained = new Set(entries.map(([key]) => key));
  for (const key of visibleKeys) if (!retained.has(key)) writes.push({ path: [...path, key], kind: "delete" });
  entries.forEach(([key, fields], index) => {
    const entry = [...path, key];
    if (view.kind(entry) !== "map") writes.push({ path: entry, kind: "map" });
    if (field === "props") setValue(view, writes, [...entry, "value"], fields);
    else {
      for (const name of view.keys(entry)) if (name !== "rank" && name !== "extra" && !Object.hasOwn(fields, name)) writes.push({ path: [...entry, name], kind: "delete" });
      for (const [name, value] of Object.entries(fields)) setValue(view, writes, [...entry, name], value);
      if (!view.has([...entry, "extra"])) writes.push({ path: [...entry, "extra"], kind: "set", value: "{}" });
    }
    setValue(view, writes, [...entry, "rank"], String(index).padStart(10, "0"));
  });
  return true;
}

function prepareCreate(operation: SharedRecordCreate, view: SharedPreparationView): SharedPreparationResult {
  const { collection, record: key } = operation.target, path = [collection, key];
  if (![operation.id, operation.by, key].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  const created = prepareSharedCreatedAttachment(operation, view); if (created) return created;
  if (view.has(path)) return { ok: false, reason: "duplicate-record" };
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
  const writes: SharedPreparedWrite[] = [{ path, kind: "map" }];
  for (const [field, value] of Object.entries(fields)) {
    if (isSharedRecordNestedField(collection, field)) {
      if (!nestedWrites(view, writes, [...path, field], field, value)) return { ok: false, reason: "invalid-record-field" };
    } else {
      if (!sharedRecordFieldAccepted(collection, field, value) || collection === "visuals" && field === "text") return { ok: false, reason: "invalid-record-field" };
      writes.push({ path: [...path, field], kind: "set", value });
    }
  }
  if (!readPreparedSharedRecord(collection, key, candidate(view, writes))) return { ok: false, reason: "invalid-record-shape" };
  return reserveSharedCommandIdentities(view, [key, ...(typeof fields.id === "string" ? [fields.id] : [])]) ? accepted(view, writes) : { ok: false, reason: "existing-identity" };
}

function prepareSet(operation: SharedRecordSet, view: SharedPreparationView): SharedPreparationResult {
  if (![operation.id, operation.by, operation.target.record, operation.field].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  const { collection, record: key } = operation.target, path = [collection, key], value = readPreparedSharedRecord(collection, key, view);
  if (!value) return { ok: false, reason: "missing-or-invalid-record" };
  const field = operation.field;
  if (collection === "visuals" && ["text", "html", "markRecords"].includes(field)) return { ok: false, reason: "text-executor-required" };
  const immutable = collection === "comments" ? ["author", "createdAt", "anchorId", "quote", "kind", "imageValue", "conflictField", "emptyValue", "titleValue"]
    : collection === "replies" ? ["author", "createdAt", "commentId"] : collection === "shots" ? ["origin", "status"] : collection === "tags" ? ["status"] : [];
  if (field === "id" || immutable.includes(field)) return { ok: false, reason: "immutable-record-field" };
  if ((collection === "comments" || collection === "replies") && field === "text" && value.author !== operation.by) return { ok: false, reason: "foreign-author" };
  const writes: SharedPreparedWrite[] = [];
  if (sharedResolutionOperation(operation)) {
    if (operation.clear || !sharedResolutionEntryAccepted(operation.value)) return { ok: false, reason: "invalid-record-field" };
    writes.push(...sharedResolutionWrites(view.keys(path), key => view.get([...path, key]), view.writer, operation.value).map(({ key, ...write }) => ({ ...write, path: [...path, key] })));
  } else if (operation.clear) { if (view.keys(path).includes(field)) writes.push({ path: [...path, field], kind: "delete" }); }
  else if (isSharedRecordNestedField(collection, field)) {
    if (!nestedWrites(view, writes, [...path, field], field, operation.value, value[field] as readonly { readonly key: string }[] | undefined)) return { ok: false, reason: "invalid-record-field" };
  } else {
    if (!sharedRecordFieldAccepted(collection, field, operation.value)) return { ok: false, reason: "invalid-record-field" };
    setValue(view, writes, [...path, field], operation.value);
  }
  return readPreparedSharedRecord(collection, key, candidate(view, writes)) ? accepted(view, writes) : { ok: false, reason: "invalid-record-shape" };
}

function prepareDelete(operation: SharedRecordDelete, view: SharedPreparationView): SharedPreparationResult {
  const { collection, record: key } = operation.target;
  if (![operation.id, operation.by, key].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
  if (!readPreparedSharedRecord(collection, key, view)) return { ok: false, reason: "missing-or-invalid-record" };
  return accepted(view, [{ path: [collection, key], kind: "delete" }]);
}

export const recordHandlers: SharedOperationHandlers = Object.freeze({ "record-create": prepareCreate, "record-set": prepareSet, "record-delete": prepareDelete });
export function registerSharedRecordHandlers(handle: SharedDocumentHandle): void { registerSharedOperationHandlers(handle, recordHandlers); }
