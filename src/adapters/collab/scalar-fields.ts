import type { SharedScalarSet } from "../../core/collab/operations.ts";
import { isStableSharedIdentity } from "./identity.ts";

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
