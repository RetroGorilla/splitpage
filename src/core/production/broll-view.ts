import type { ExportPerson, ExportShotEntry } from "../document/export-document.ts";
import type { DocumentRow } from "../document/validated.ts";
import type { Frozen } from "../document/freeze.ts";
import { normalizeTagName } from "../document/tags.ts";
import { brollSortedForList } from "./broll.ts";
import { tagStatus } from "./looks.ts";
import { formatTimecode } from "./timing.ts";

type Shot = Frozen<ExportShotEntry>;
type Person = Frozen<ExportPerson>;
type Row = Frozen<DocumentRow>;

export interface ShotRecord {
  beat: string;
  name: string;
  status: string;
  shot: boolean;
  flagged: boolean;
  location: string;
  props: string[];
  propsWithStatus: string[];
  cuts: string;
  owner: string;
  note: string;
  desc: string;
}
interface BrollGroup {
  key: string;
  kind: string;
  label: string;
  row?: Row | null;
  items: Shot[];
  none?: boolean;
}
export function oneOf(list: readonly { id: string }[], id: unknown, fallback: string): string {
  for (const item of list) if (item.id === id) return item.id;
  return fallback;
}

export const FILTERS = [
  { id: "all",     label: "All" },
  { id: "unshot",  label: "To film" },
  { id: "flagged", label: "Flagged" },
  { id: "shot",    label: "Filmed" }
];

export const PAGE_GROUPS = [
  { id: "location", label: "Location" },
  { id: "scene",    label: "Beat" },
  { id: "person",   label: "Person" }
];

export function matchesFilter(e: Shot, filter: string): boolean {
  if (filter === "unshot") return e.status !== "shot";
  if (filter === "shot") return e.status === "shot";
  if (filter === "flagged") return e.reshoot;
  return true;
}

export function filterCounts(entries: readonly Shot[]) {
  const n = { all: entries.length, unshot: 0, shot: 0, flagged: 0 };
  entries.forEach(function (e) {
    if (e.status === "shot") n.shot++; else n.unshot++;
    if (e.reshoot) n.flagged++;
  });
  return n;
}

export function pageSummaryText(entries: readonly Shot[]): string {
  const n = filterCounts(entries);
  return n.shot + " of " + n.all + " filmed" + (n.flagged ? " · " + n.flagged + " flagged" : "");
}

export function personIn(people: readonly Person[], id: string): Person | null {
  if (!id) return null;
  for (const person of people) {
    if (person.id === id) return person;
  }
  return null;
}

export function beatLabel(e: Shot): string {
  return e.beatNumber ?? "";
}

export function startOf(e: Shot, starts: Readonly<Record<string, number>>): string {
  return e.rowId && starts[e.rowId] !== undefined ? formatTimecode(starts[e.rowId] ?? 0) : "";
}

export function shotRecordForFile(e: Shot, people: readonly Person[]): ShotRecord {
  const who = personIn(people, e.owner);
  return {
    beat: e.rowId ? beatLabel(e) : "",
    name: (e.shotNumber ? e.shotNumber + " " : "") + (e.name || "Untitled shot"),
    status: e.status === "shot" ? "Filmed" : "To film",
    shot: e.status === "shot",
    flagged: !!e.reshoot,
    location: e.location || "",
    props: e.props.map(function (p) { return p.name; }),
    propsWithStatus: e.props.map(function (p) {
      const st = tagStatus(p.status);
      return p.name + (st ? " (" + st.label.toLowerCase() + ")" : "");
    }),
    cuts: e.audioRef || "",
    owner: who ? who.name : "",
    note: e.notes || "",
    desc: e.desc || ""
  };
}

export function brollGroups(entries: readonly Shot[], by: string, from: { rows: readonly Row[]; people: readonly Person[] }): BrollGroup[] {
  const rows = from.rows;
  const people = from.people;
  const sorted = brollSortedForList(entries);
  if (by === "flat") return [{ key: "all", kind: "flat", label: "", items: sorted }];
  const groups: BrollGroup[] = [];
  const byKey: Record<string, BrollGroup> = {};
  sorted.forEach(function (e) {
    let key: string, label: string;
    let kind = by;
    let row: Row | null = null;
    if (by === "scene") {
      if (e.rowIndex === -1) { key = "added"; label = "Added here"; kind = "added"; }
      else { key = "r:" + e.rowId; label = "Beat " + beatLabel(e); row = rows[e.rowIndex] || null; }
    } else if (by === "location") {
      key = e.location ? "l:" + normalizeTagName(e.location) : "none";
      label = e.location || "No location";
    } else {
      const who = personIn(people, e.owner);
      key = who ? "p:" + who.id : "none";
      label = who ? who.name : "Unassigned";
    }
    let group = byKey[key];
    if (!group) {
      group = { key: key, kind: kind, label: label, row: row, items: [], none: key === "none" };
      byKey[key] = group;
      groups.push(group);
    }
    group.items.push(e);
  });
  if (by !== "scene") {
    groups.sort(function (a, b) {
      if (a.none !== b.none) return a.none ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  }
  return groups;
}


export const BROLL_PANEL_GROUPS = [
  { id: "scene", label: "Beat", button: "By beat" },
  { id: "location", label: "Location", button: "By location" },
  { id: "flat", label: "None", button: "Not grouped" }
];
