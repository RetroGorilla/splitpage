import { compareCodeUnits } from "./order.ts";
import { readWireRecord } from "./records.ts";

export interface RemovalViewRecord {
  beat: string;
  by: string;
  observed: readonly { client: number; clock: number; len: number }[];
}

export function readRemovalRecord(raw: unknown): RemovalViewRecord | null {
  const record = readWireRecord(raw);
  if (!record || !["beat", "range", "header"].includes(typeof record.kind === "string" ? record.kind : "") || typeof record.beat !== "string" || typeof record.by !== "string" || !Array.isArray(record.observed)) return null;
  const observed: { client: number; clock: number; len: number }[] = [];
  for (let index = 0; index < record.observed.length; index++) {
    const rawRange: unknown = record.observed[index];
    const range = readWireRecord(rawRange);
    if (!range || typeof range.client !== "number" || typeof range.clock !== "number" || typeof range.len !== "number"
      || !Number.isSafeInteger(range.client) || !Number.isSafeInteger(range.clock) || !Number.isSafeInteger(range.len)
      || range.client < 0 || range.clock < 0 || range.len < 0) return null;
    observed.push({ client: range.client, clock: range.clock, len: range.len });
  }
  return { beat: record.beat, by: record.by, observed };
}

export function removalIds(entries: Iterable<readonly [string, unknown]>): string[] {
  const members = [...entries];
  return members.some(([, value]) => value === false) ? [] : members.filter(([, value]) => value === true).map(([id]) => id);
}

export function removalAttribution(removals: readonly RemovalViewRecord[]): string {
  return [...new Set(removals.map(removal => removal.by))].sort(compareCodeUnits).join(", ");
}

export function removalObserved(removals: readonly RemovalViewRecord[], identity: { client: number; clock: number } | null): boolean {
  return identity !== null && removals.some(removal => removal.observed.some(range =>
    range.client === identity.client && identity.clock >= range.clock && identity.clock < range.clock + range.len));
}
