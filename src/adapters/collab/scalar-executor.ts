import * as Y from "yjs";
import type { SharedScalarSet } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedOperationHandlers } from "./operation-handlers.ts";
import { collabState } from "./state.ts";
import { prepareSharedStatusEvent } from "./status.ts";
import { applySharedMapWrites } from "./prepare.ts";
import type { SharedPreparationView, SharedPreparationResult, SharedPreparedWrite } from "./prepare.ts";
import { sharedStructureReference } from "./structure-identity.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";

export function scalarTarget(handle: SharedDocumentHandle, target: SharedScalarSet["target"]): Y.Map<unknown> | null {
  const roots = collabState(handle).roots;
  const record = target.scope === "document" ? roots.meta.get("docId") === target.record ? roots.meta : null
    : roots[target.scope === "beat" ? "beats" : "headings"].get(target.record);
  return record instanceof Y.Map ? record : null;
}

export function scalarFieldAllowed(scope: SharedScalarSet["target"]["scope"], field: string, value: unknown, clear: boolean): boolean {
  if (scope === "document") {
    if (field === "fileTitle") return !clear && value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).every(key => key === "titleOrigin" || key === "titleVersion")
      && ((value as Record<string, unknown>).titleOrigin === undefined || (value as Record<string, unknown>).titleOrigin === "file" || (value as Record<string, unknown>).titleOrigin === "user")
      && ((value as Record<string, unknown>).titleVersion === undefined || typeof (value as Record<string, unknown>).titleVersion === "string"
        && /^v\d+$/.test(String((value as Record<string, unknown>).titleVersion)));
    if (field === "wordsPerMinute") return !clear && typeof value === "number" && Number.isInteger(value) && value >= 60 && value <= 400;
    if (field === "targetSeconds") return clear || typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 86400;
    if (field === "paragraphsDecided") return !clear && value === true;
  }
  if (scope === "beat") {
    if (field === "lengthSeconds") return clear || typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 86400;
    if (field === "paragraphStart") return clear || value === true;
    if (field === "stamp") return !clear && value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).every(key => key === "at" || key === "by")
      && typeof (value as Record<string, unknown>).at === "string"
      && ((value as Record<string, unknown>).by === null || typeof (value as Record<string, unknown>).by === "string");
  }
  if (scope === "heading" && field === "firstSceneId") return !clear && typeof value === "string" && !!value && isStableSharedIdentity(value);
  return field === "extra" && !clear && typeof value === "string" && validExtra(value);
}

function validExtra(value: string): boolean {
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed); }
  catch { return false; }
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
