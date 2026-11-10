import type { ProjectionDelta } from "../proj/richtext.ts";
import type { ProjectionBag } from "../proj/value.ts";

export interface PerfTextChange {
  insert?: string | object | undefined;
  retain?: number | undefined;
  delete?: number | undefined;
  attributes?: Record<string, unknown> | undefined;
}

export function deltaLength(value: ProjectionDelta): number {
  return typeof value.insert === "string" ? value.insert.length : 1;
}

export function patchDelta(source: readonly ProjectionDelta[], changes: readonly PerfTextChange[]): ProjectionDelta[] {
  const result: ProjectionDelta[] = [];
  let index = 0, offset = 0;
  const take = (length: number, keep: boolean, attributes?: Record<string, unknown>): void => {
    while (length > 0) {
      const item = source[index];
      if (!item) throw new Error("Event extends beyond cached text");
      const count = Math.min(length, deltaLength(item) - offset);
      if (keep) {
        const attrs = Object.fromEntries(Object.entries({ ...item.attributes, ...attributes }).filter(([, value]) => value !== null));
        result.push({ insert: typeof item.insert === "string" ? item.insert.slice(offset, offset + count) : item.insert, attributes: attrs });
      }
      length -= count;
      offset += count;
      if (offset === deltaLength(item)) { index++; offset = 0; }
    }
  };
  for (const change of changes) {
    if (change.retain !== undefined) take(change.retain, true, change.attributes);
    if (change.delete !== undefined) take(change.delete, false);
    if (change.insert !== undefined) result.push({ insert: change.insert as string | ProjectionBag, attributes: change.attributes ?? {} });
  }
  while (index < source.length) take(deltaLength(source[index] as ProjectionDelta) - offset, true);
  const compact: ProjectionDelta[] = [];
  for (const item of result) {
    const previous = compact.at(-1);
    if (previous && typeof previous.insert === "string" && typeof item.insert === "string" && sameAttributes(previous.attributes, item.attributes)) previous.insert += item.insert;
    else compact.push(item);
  }
  return compact;
}

function sameAttributes(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

export function sameDelta(a: readonly ProjectionDelta[], b: readonly ProjectionDelta[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return other && (item.insert === other.insert || (typeof item.insert === "object" && typeof other.insert === "object" && JSON.stringify(item.insert) === JSON.stringify(other.insert))) && sameAttributes(item.attributes, other.attributes);
  });
}
