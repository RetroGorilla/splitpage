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

export function scalarTarget(handle: SharedDocumentHandle, target: SharedScalarSet["target"]): Y.Map<unknown> | null {
  const roots = collabState(handle).roots;
  const record = target.scope === "document" ? roots.meta.get("docId") === target.record ? roots.meta : null
    : roots[target.scope === "beat" ? "beats" : "headings"].get(target.record);
  return record instanceof Y.Map ? record : null;
}


function prepareScalar(operation: SharedScalarSet, view: SharedPreparationView): SharedPreparationResult {
  const { target } = operation;
  const path = target.scope === "document" ? ["meta"] : [target.scope === "beat" ? "beats" : "headings", sharedStructureReference(view, target.record)];
  if (view.kind(path) !== "map" || target.scope === "document" && view.get(["meta", "docId"]) !== target.record) return { ok: false, reason: "missing-target" };
  const value = operation.clear ? undefined : target.scope === "heading" && operation.field === "firstSceneId" && typeof operation.value === "string"
    ? sharedStructureReference(view, operation.value) : operation.value;
  if (!scalarFieldAllowed(target.scope, operation.field, value, operation.clear === true)) return { ok: false, reason: "unsupported-scalar-field" };
  if (target.scope === "heading" && operation.field === "firstSceneId" && (typeof value !== "string" || view.kind(["beats", value]) !== "map")) return { ok: false, reason: "missing-target" };
  const fieldPath = [...path, operation.field];
  const unchanged = operation.clear ? view.kind(fieldPath) === "missing" : JSON.stringify(view.get(fieldPath)) === JSON.stringify(value);
  const writes: SharedPreparedWrite[] = unchanged ? []
    : [{ path: fieldPath, kind: operation.clear ? "delete" : "set", value }];
  const description = freezeSharedPreparedValue(writes);
  return { ok: true, writes: description, apply: handle => applySharedMapWrites(handle, description) };
}

export const scalarHandlers: SharedOperationHandlers = Object.freeze({ scalar: prepareScalar, status: prepareSharedStatusEvent });
