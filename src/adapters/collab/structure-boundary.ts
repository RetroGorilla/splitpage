import { isStableSharedIdentity } from "./identity.ts";

export function readSharedStructureBoundary(raw: unknown): { readonly owner: string; readonly field: "audioText" | "heading"; readonly before: string | null } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>, owner = record.b ?? record.h;
  const keys = Object.keys(record).sort().join(",");
  if (typeof owner !== "string" || !owner || !isStableSharedIdentity(owner)) return null;
  if (keys !== "b" && keys !== "h" && keys !== "b,before") return null;
  if (keys === "b,before" && (typeof record.before !== "string" || !record.before || !isStableSharedIdentity(record.before))) return null;
  return { owner, field: keys === "h" ? "heading" : "audioText", before: typeof record.before === "string" ? record.before : null };
}
