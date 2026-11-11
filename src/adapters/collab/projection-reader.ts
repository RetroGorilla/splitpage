import * as Y from "yjs";
import { scalarFieldAllowed } from "./scalar-executor.ts";
import { sharedJson } from "./snapshot.ts";
import { isStableSharedIdentity } from "./identity.ts";

function bag(value: unknown): Record<string, unknown> {
  const json = sharedJson(value);
  return json !== null && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
}
function retainedStamp(value: unknown): boolean {
  const stamp = bag(value);
  return Object.hasOwn(stamp, "at") && Object.keys(stamp).every(key => key === "at" || key === "by")
    && (stamp.by === null || typeof stamp.by === "string");
}
export function readProjectionFields(raw: unknown, scope: "document" | "beat" | "heading"): Record<string, unknown> | null {
  if (!(raw instanceof Y.Map)) return null;
  const output: [string, unknown][] = [];
  const fields = scope === "document" ? ["fileTitle", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "extra"]
    : scope === "beat" ? ["lengthSeconds", "paragraphStart", "stamp", "extra"] : ["extra"];
  for (const key of fields) {
    const value = sharedJson(raw.get(key));
    if (key === "stamp" ? retainedStamp(value) : scalarFieldAllowed(scope, key, value, false)) output.push([key, value]);
  }
  if (scope === "document") {
    const id: unknown = raw.get("docId"), schema: unknown = raw.get("schema"), capture = bag(raw.get("capture"));
    if (typeof id === "string" && id.length > 0 && isStableSharedIdentity(id)) output.push(["docId", id]);
    if (typeof schema === "number" && Number.isFinite(schema)) output.push(["schema", schema]);
    const retained: [string, unknown][] = [];
    for (const key of ["rev", "lastEditedBy", "lastEditedAt", "personColors"]) {
      const value = capture[key];
      if (Object.hasOwn(capture, key) && (key === "lastEditedAt" || (key === "rev" ? typeof value === "number" : key === "personColors" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === "string"))) retained.push([key, value]);
    }
    output.push(["capture", Object.fromEntries(retained)]);
  } else {
    const id: unknown = raw.get("id");
    if (typeof id !== "string" || !id || !isStableSharedIdentity(id)) return null;
    output.push(["id", id]);
  }
  return Object.fromEntries(output);
}
export function readProjectionHead(raw: unknown): { readonly kind: "b" | "h"; readonly id: string } | null {
  const head = bag(raw), keys = Object.keys(head), kind = keys[0];
  if (keys.length !== 1 || kind !== "b" && kind !== "h") return null;
  const id = head[kind];
  return typeof id === "string" && id.length > 0 && isStableSharedIdentity(id) ? { kind, id } : null;
}
