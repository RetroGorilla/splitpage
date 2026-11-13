import * as Y from "yjs";
import type { SharedScalarSet } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedOperationHandlers } from "./operation-handlers.ts";
import { collabState } from "./state.ts";
import { prepareSharedStatusEvent } from "./status.ts";
import { applySharedMapWrites } from "./prepare.ts";
import type { SharedPreparationView, SharedPreparationResult, SharedPreparedWrite } from "./prepare.ts";
import { sharedStructureReference } from "./structure-identity.ts";
import { scalarFieldAllowed } from "./scalar-fields.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { resolveIndexedStructureOwner } from "./structure-plan.ts";
import { sharedStampOperation, sharedStampWrites } from "./stamp.ts";

export function scalarTarget(handle: SharedDocumentHandle, target: SharedScalarSet["target"]): Y.Map<unknown> | null {
  const roots = collabState(handle).roots;
  const owner = target.scope === "document" ? target.record : resolveIndexedStructureOwner(observeSharedStructureIndex(handle), target.record, target.scope === "beat" ? "audioText" : "heading")?.owner;
  const record = target.scope === "document" ? roots.meta.get("docId") === target.record ? roots.meta : null
    : owner === undefined ? null : roots[target.scope === "beat" ? "beats" : "headings"].get(owner);
  return record instanceof Y.Map ? record : null;
}


function prepareScalar(operation: SharedScalarSet, view: SharedPreparationView): SharedPreparationResult {
  const { target } = operation;
  const reference = sharedStructureReference(view, target.record), owner = target.scope === "document" ? reference : view.resolveOwner(reference, target.scope === "beat" ? "audioText" : "heading")?.owner;
  if (!owner) return { ok: false, reason: "missing-target" };
  const path = target.scope === "document" ? ["meta"] : [target.scope === "beat" ? "beats" : "headings", owner];
  if (view.kind(path) !== "map" || target.scope === "document" && view.get(["meta", "docId"]) !== target.record) return { ok: false, reason: "missing-target" };
  const value = operation.clear ? undefined : target.scope === "heading" && operation.field === "firstSceneId" && typeof operation.value === "string"
    ? view.resolveOwner(sharedStructureReference(view, operation.value), "audioText")?.owner : operation.value;
  if (!scalarFieldAllowed(target.scope, operation.field, value, operation.clear === true)) return { ok: false, reason: "unsupported-scalar-field" };
  if (target.scope === "heading" && operation.field === "firstSceneId" && (typeof value !== "string" || view.kind(["beats", value]) !== "map")) return { ok: false, reason: "missing-target" };
  const fieldPath = [...path, operation.field];
  const unchanged = operation.clear ? view.kind(fieldPath) === "missing" : JSON.stringify(view.get(fieldPath)) === JSON.stringify(value);
  const writes: SharedPreparedWrite[] = sharedStampOperation(operation)
    ? sharedStampWrites(view.keys(path), key => view.get([...path, key]), operation.id, value).map(({ key, ...write }) => ({ ...write, path: [...path, key] }))
    : unchanged ? [] : [{ path: fieldPath, kind: operation.clear ? "delete" : "set", value }];
  const description = freezeSharedPreparedValue(writes);
  return { ok: true, writes: description, apply: handle => applySharedMapWrites(handle, description) };
}

export const scalarHandlers: SharedOperationHandlers = Object.freeze({ scalar: prepareScalar, status: prepareSharedStatusEvent });
