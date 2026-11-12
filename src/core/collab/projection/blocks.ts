import type { SharedProjectionUnit } from "./units.ts";
import { cleanId } from "../../document/text-policy.ts";

export interface SharedProjectionBoundary {
  readonly kind: "b" | "h";
  readonly id: string;
  readonly before: string | null;
}
export interface SharedProjectionStream {
  readonly segment: string;
  readonly inOrder: boolean;
  readonly head: SharedProjectionBoundary | null;
  readonly parts: readonly { readonly boundary: SharedProjectionBoundary | null; readonly units: readonly SharedProjectionUnit[]; readonly from: number; readonly to: number }[];
}
export type SharedProjectionFragmentReason = "missing-boundary" | "invalid-prefix" | "missing-beat" | "wrong-shape-beat" | "unowned-beat" | "foreign-segment" | "duplicate-boundary" | "invalid-beat-id";

export function projectSharedBlocks(streams: readonly SharedProjectionStream[], records: readonly { readonly id: string; readonly valid: boolean; readonly segment: string | null }[],
  collect: (parts: readonly (readonly SharedProjectionUnit[])[]) => SharedProjectionUnit[] = parts => parts.flat()) {
  const contains = new Map<string, Set<string>>(), fallback = new Map<string, string>();
  for (const stream of streams) {
    const names = new Set<string>(); contains.set(stream.segment, names);
    if (stream.head?.kind === "b") { names.add(stream.head.id); if (stream.inOrder && !fallback.has(stream.head.id)) fallback.set(stream.head.id, stream.segment); }
    for (const part of stream.parts) if (part.boundary?.kind === "b") names.add(part.boundary.id);
  }
  const owners = new Map(records.map(record => [record.id, { valid: record.valid,
    segment: record.segment && contains.get(record.segment)?.has(record.id) ? record.segment : fallback.get(record.id) ?? null }]));
  const result: { kind: "b" | "h"; id: string | null; segment: string; from: number; to: number; units: SharedProjectionUnit[]; reason: SharedProjectionFragmentReason | null }[] = [];
  const headings = new Set<string>(), beats = new Set<string>();
  for (const stream of streams) {
    if (!stream.inOrder) continue;
    const local: typeof result = [];
    const units = new Map<typeof result[number], (readonly SharedProjectionUnit[])[]>();
    const fresh = (head: SharedProjectionBoundary | null, from: number): typeof result[number] => ({ kind: head?.kind ?? "b", id: head?.id ?? null,
      segment: stream.segment, from, to: from, units: [], reason: head ? null : "missing-boundary" });
    let current = fresh(stream.head, 0), last = stream.head, adjacent = true;
    for (const part of stream.parts) {
      const next = part.boundary;
      if (!next) {
        const parts = units.get(current) ?? []; parts.push(part.units); units.set(current, parts);
        current.to = part.to; if (part.to > part.from) adjacent = false; continue;
      }
      if (adjacent && last?.kind === next.kind && last.id === next.id) { current.to = part.to; continue; }
      current.to = part.from; local.push(current);
      if (next.before) {
        const source = local.findLast(block => block.kind === "b" && block.id === next.before && !block.reason);
        if (source) source.id = next.id;
        current = fresh({ kind: "b", id: next.before, before: null }, part.to);
        if (!source) current.reason = "invalid-prefix";
      } else current = fresh(next, part.to);
      last = next; adjacent = true;
    }
    local.push(current);
    const seen = new Set<string>();
    for (const block of local) {
      block.units = collect(units.get(block) ?? []);
      if (block.id === null && !block.units.length && block.from === block.to) continue;
      if (!block.reason && block.id !== null) {
        if (block.kind === "b") {
          const record = owners.get(block.id);
          if (!record) block.reason = "missing-beat";
          else if (!record.valid) block.reason = "wrong-shape-beat";
          else if (!record.segment) block.reason = "unowned-beat";
          else if (record.segment !== stream.segment) block.reason = "foreign-segment";
          if (!block.reason && !cleanId(block.id)) block.reason = "invalid-beat-id";
          if (!block.reason && beats.has(cleanId(block.id))) block.reason = "duplicate-boundary";
        }
        const key = block.kind + block.id;
        if (!block.reason && (seen.has(key) || block.kind === "h" && headings.has(block.id))) block.reason = "duplicate-boundary";
        if (!block.reason) { seen.add(key); if (block.kind === "h") headings.add(block.id); else beats.add(cleanId(block.id)); }
      }
      result.push(block);
    }
  }
  return result;
}
