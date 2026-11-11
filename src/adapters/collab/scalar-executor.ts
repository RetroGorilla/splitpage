import * as Y from "yjs";
import type { SharedScalarSet } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedOperationHandlers } from "./operation-handlers.ts";
import { collabState } from "./state.ts";
import { writeSharedStatusEvent } from "./status.ts";

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
      && ((value as Record<string, unknown>).titleOrigin === undefined || ["file", "user"].includes(String((value as Record<string, unknown>).titleOrigin)))
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
  return field === "extra" && !clear && typeof value === "string" && validExtra(value);
}

function validExtra(value: string): boolean {
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed); }
  catch { return false; }
}

function setScalar(handle: SharedDocumentHandle, operation: SharedScalarSet): string | null {
  const target = scalarTarget(handle, operation.target);
  if (!target) return "missing-target";
  const value = operation.clear ? undefined : operation.value;
  if (!scalarFieldAllowed(operation.target.scope, operation.field, value, operation.clear === true)) return "unsupported-scalar-field";
  if (operation.clear) target.delete(operation.field);
  else target.set(operation.field, value);
  return null;
}

export const scalarHandlers: SharedOperationHandlers = Object.freeze({ scalar: setScalar, status: writeSharedStatusEvent });
