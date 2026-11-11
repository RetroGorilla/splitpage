import { defaultTagOf } from "../../text/runs.ts";
import type { SharedProjectionUnit } from "./units.ts";

export interface SharedTagProjectionRejection {
  readonly kind: "crossing-tag" | "deleted-tag";
  readonly occurrence: string;
  readonly tag: string;
  readonly from: number;
  readonly to: number;
  readonly words: string;
}

interface TagExtent { id: string; tag: string; from: number; to: number }

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function projectSharedTagExtents(units: readonly SharedProjectionUnit[], tags: readonly Readonly<Record<string, unknown>>[]): {
  readonly units: readonly SharedProjectionUnit[];
  readonly rejected: readonly SharedTagProjectionRejection[];
} {
  const extents = new Map<string, TagExtent>();
  units.forEach((unit, index) => {
    if (typeof unit.value !== "string") return;
    for (const mark of unit.marks) if (mark.kind === "tag" && mark.id !== undefined && typeof mark.value === "string") {
      const key = JSON.stringify([mark.id, mark.value]), extent = extents.get(key);
      if (extent) extent.to = index + 1;
      else extents.set(key, { id: mark.id, tag: mark.value, from: index, to: index + 1 });
    }
  });
  const names: TagExtent[] = [];
  for (const extent of [...extents.values()].sort((a, b) => compare(a.tag, b.tag) || a.from - b.from || a.to - b.to || compare(a.id, b.id))) {
    const previous = names.at(-1);
    if (previous?.tag === extent.tag && extent.from <= previous.to) {
      previous.to = Math.max(previous.to, extent.to);
      if (extent.id < previous.id) previous.id = extent.id;
    } else names.push({ ...extent });
  }
  const accepted: TagExtent[] = [], rejected: SharedTagProjectionRejection[] = [];
  for (const extent of names.sort((a, b) => a.from - b.from || b.to - a.to || compare(a.id, b.id) || compare(a.tag, b.tag))) {
    const missing = !tags.some(tag => tag.id === extent.tag) && defaultTagOf(extent.tag) === null;
    const crossing = accepted.some(other => extent.from < other.to && other.from < extent.to
      && !(extent.from >= other.from && extent.to <= other.to) && !(other.from >= extent.from && other.to <= extent.to));
    if (missing || crossing) rejected.push({ kind: missing ? "deleted-tag" : "crossing-tag", occurrence: extent.id,
      tag: extent.tag, from: extent.from, to: extent.to, words: units.slice(extent.from, extent.to)
        .filter(unit => typeof unit.value === "string" && unit.marks.some(mark => mark.kind === "tag" && mark.value === extent.tag))
        .map(unit => unit.value as string).join("") });
    else accepted.push(extent);
  }
  const ordered = [...accepted].sort((a, b) => b.to - b.from - (a.to - a.from) || compare(a.id, b.id) || compare(a.tag, b.tag));
  return { units: units.map((unit, index) => ({ value: unit.value, marks: [
    ...unit.marks.filter(mark => mark.kind !== "tag"),
    ...ordered.flatMap(extent => {
      if (typeof unit.value !== "string" || index < extent.from || index >= extent.to) return [];
      const mark = unit.marks.filter(mark => mark.kind === "tag" && mark.value === extent.tag)
        .sort((a, b) => compare(a.id ?? "", b.id ?? ""))[0];
      return mark ? [mark] : [];
    })
  ] })), rejected };
}
