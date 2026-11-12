import type { SharedRecordCollection } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { withSharedSnapshot } from "./snapshot.ts";
import { readStoredSharedRecord } from "./record-codec.ts";

export interface SharedRecordReading { readonly key: string; readonly fields: Readonly<Record<string, unknown>> }

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function time(value: unknown): number {
  const stamp = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2})))?$/.exec(value) : null;
  if (!stamp) {
    const number = typeof value === "string" || typeof value === "number" ? Number(value) : 0;
    return Number.isFinite(number) ? number : 0;
  }
  const year = Number(stamp[1]), month = Number(stamp[2]), day = Number(stamp[3]);
  const hour = Number(stamp[4] ?? 0), minute = Number(stamp[5] ?? 0), second = Number(stamp[6] ?? 0), millis = Number((stamp[7] ?? "").padEnd(3, "0"));
  const zoneHour = Number(stamp[9] ?? 0), zoneMinute = Number(stamp[10] ?? 0);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return 0;
  return date.getTime() - (stamp[8] === "-" ? -1 : 1) * (zoneHour * 60 + zoneMinute) * 60000;
}

export function readSharedRecords(handle: SharedDocumentHandle, collection: SharedRecordCollection): SharedRecordReading[] {
  return withSharedSnapshot(handle, copy => {
    const root = copy.roots[collection], result: SharedRecordReading[] = [];
    for (const key of [...root.keys()].sort()) {
      const fields = readStoredSharedRecord(collection, key, root.get(key));
      if (fields) result.push({ key, fields });
    }
    return sortSharedRecordReadings(collection, result);
  });
}

export function sortSharedRecordReadings(collection: SharedRecordCollection, result: SharedRecordReading[]): SharedRecordReading[] {
    return result.sort((a, b) => collection === "replies"
      ? time(a.fields.createdAt) - time(b.fields.createdAt) || compare(String(a.fields.id), String(b.fields.id)) || compare(a.key, b.key)
      : compare(typeof a.fields.rank === "string" ? a.fields.rank : "", typeof b.fields.rank === "string" ? b.fields.rank : "") || compare(a.key, b.key));
}
