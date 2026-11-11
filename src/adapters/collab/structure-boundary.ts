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

export function sharedStructureSpans(head: unknown, units: readonly { readonly value: unknown }[]) {
  const spans: { owner: string; field: "audioText" | "heading"; from: number; to: number }[] = [];
  let current = readSharedStructureBoundary(head), from = 0;
  for (let index = 0; index <= units.length; index++) {
    const next = index === units.length ? null : readSharedStructureBoundary(units[index]?.value);
    if (index !== units.length && !next) continue;
    if (current) {
      const preceding = next?.before && current.owner !== next.before ? spans.findLast(span => span.owner === next.before) : undefined;
      if (preceding && next) preceding.owner = next.owner;
      spans.push({ owner: next?.before === current.owner ? next.owner : current.owner, field: current.field, from, to: index });
    }
    current = next?.before ? { owner: next.before, field: "audioText", before: null } : next;
    from = index + 1;
  }
  return spans;
}
