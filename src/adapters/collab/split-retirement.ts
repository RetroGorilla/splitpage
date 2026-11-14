import * as Y from "yjs";
import type { CollabRoots } from "./roots.ts";
import { sharedJson } from "./snapshot.ts";
import { sharedPreparedValue } from "./prepare-value.ts";
import { readSharedJoinEntry, sharedJoinRetirementGroup } from "./join-record.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";

const PREFIX = "splitRetired:";

export type SharedSplitRetirementRoots = Pick<CollabRoots, "meta" | "segments" | "beats" | "visuals" | "gallery" | "statusEvents" | "retiredStatus" | "retiredJoins">;
export type SharedSplitObservationPart = "record" | "boundaries" | "joins" | "attachments" | "status";
export type SharedSplitObservations = ReadonlyMap<string, readonly string[]>;
type Visit = (count: number) => void;

export function sharedSplitRetiredField(beat: string): string { return PREFIX + beat; }

export function readSharedSplitRetiredBeat(field: string): string | null { return field.startsWith(PREFIX) && field.length > PREFIX.length ? field.slice(PREFIX.length) : null; }

export function readSharedSplitMarks(meta: Y.Map<unknown>): ReadonlySet<string> {
  return new Set([...meta.keys()].flatMap(key => { const beat = readSharedSplitRetiredBeat(key); return beat ? [beat] : []; }));
}

function sorted<T>(entries: Iterable<readonly [string, T]>): (readonly [string, T])[] {
  return [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function identity(item: Y.Item): string { return "@" + item.id.client + ":" + item.id.clock + (item.deleted ? "-" : ""); }

function observed(value: unknown, path: string, into: string[]): void {
  if (value instanceof Y.Map) {
    for (const [key, item] of sorted<Y.Item>(value._map.entries())) {
      if (path === "beat" && (key === "stamp" || key.startsWith("stamp:"))) continue;
      into.push(path + "/" + key + identity(item));
      if (!item.deleted) observed(value.get(key), path + "/" + key, into);
    }
  } else if (value instanceof Y.Text) into.push(path + "=" + JSON.stringify(value.toDelta()));
  else if (value instanceof Y.AbstractType) into.push(path + "=" + JSON.stringify(value.toJSON()));
}

function segmentOf(roots: SharedSplitRetirementRoots, beat: string): string | null {
  const record = roots.beats.get(beat), segment = record instanceof Y.Map ? record.get("segment") : null;
  return typeof segment === "string" ? segment : null;
}

// why: the parts are read for all marked beats at once, so a text or a collection is walked once, not once per mark.
const PARTS: Readonly<Record<SharedSplitObservationPart, (roots: SharedSplitRetirementRoots, beats: ReadonlySet<string>, into: (beat: string) => string[], visit: Visit) => void>> = Object.freeze({
  record: (roots, beats, into) => { for (const beat of beats) observed(roots.beats.get(beat), "beat", into(beat)); },
  boundaries: (roots, beats, into, visit) => {
    const segments = new Set([...beats].flatMap(beat => { const segment = segmentOf(roots, beat); return segment === null ? [] : [segment]; }));
    for (const segment of segments) {
      const stored = roots.segments.get(segment), text: unknown = stored instanceof Y.Map ? stored.get("text") : null;
      if (text instanceof Y.Text) for (let item = text._start; item; item = item.right) {
        visit(1);
        const embed: unknown = !item.deleted && item.content instanceof Y.ContentEmbed ? item.content.embed : null;
        const beat = embed && typeof embed === "object" ? (embed as { readonly b?: unknown }).b : null;
        if (typeof beat === "string" && beats.has(beat) && segmentOf(roots, beat) === segment) into(beat).push("boundary" + identity(item));
      }
    }
  },
  joins: (roots, beats, into, visit) => {
    for (const [from, record] of sorted(roots.beats.entries())) {
      const joins: unknown = record instanceof Y.Map ? record.get("joins") : null;
      if (!(joins instanceof Y.Map)) continue;
      for (const [key, item] of sorted<Y.Item>(joins._map.entries())) {
        visit(1);
        const entry = item.deleted ? null : readSharedJoinEntry(joins.get(key));
        if (!entry || !beats.has(entry.into)) continue;
        const retired = roots.retiredJoins.get(key) === true || roots.retiredJoins.get(sharedJoinRetirementGroup(from, entry)) === true;
        into(entry.into).push("join:" + from + "/" + key + identity(item) + (retired ? "-" : ""));
      }
    }
  },
  attachments: (roots, beats, into, visit) => {
    for (const collection of ["visuals", "gallery"] as const) for (const [key, record] of sorted(roots[collection].entries())) {
      visit(1);
      const beat: unknown = record instanceof Y.Map ? record.get("beat") : null;
      if (typeof beat === "string" && beats.has(beat)) observed(record, collection + ":" + key, into(beat));
    }
  },
  status: (roots, beats, into, visit) => {
    for (const [key, raw] of sorted(roots.statusEvents.entries())) {
      visit(1);
      const event = readSharedStatusEvent(sharedPreparedValue(raw));
      if (event?.target.scope === "beat" && beats.has(event.target.record)) into(event.target.record).push("status:" + key + (roots.retiredStatus.has(key) ? "-" : ""));
    }
  }
});

export const SHARED_SPLIT_OBSERVATION_PARTS: readonly SharedSplitObservationPart[] = Object.freeze(["record", "boundaries", "joins", "attachments", "status"]);

export function readSharedSplitObservationPart(roots: SharedSplitRetirementRoots, beats: ReadonlySet<string>, part: SharedSplitObservationPart,
  visit: Visit = () => undefined): SharedSplitObservations {
  const found = new Map<string, string[]>([...beats].map(beat => [beat, []]));
  PARTS[part](roots, beats, beat => { let entries = found.get(beat); if (!entries) { entries = []; found.set(beat, entries); } return entries; }, visit);
  return found;
}

// why: every write gets a new identity, so the list of what a retire saw of the new beat tells, on every copy, whether
// someone changed it without having seen the retire; stamps are left out, since undo never takes one back (rule 35).
export function composeSharedSplitObservation(parts: readonly SharedSplitObservations[], beat: string): string {
  return JSON.stringify(parts.map(part => part.get(beat) ?? []));
}

export function readSharedSplitObservation(roots: SharedSplitRetirementRoots, beat: string): string {
  const beats = new Set([beat]);
  return composeSharedSplitObservation(SHARED_SPLIT_OBSERVATION_PARTS.map(part => readSharedSplitObservationPart(roots, beats, part)), beat);
}

export function sharedSplitMarkMatches(raw: unknown, observation: string): boolean {
  const mark = sharedJson(raw);
  return mark !== null && typeof mark === "object" && !Array.isArray(mark) && (mark as { readonly observed?: unknown }).observed === observation;
}

export function readSharedSplitRetirements(roots: SharedSplitRetirementRoots, marked: ReadonlySet<string>): ReadonlySet<string> {
  const beats = new Set([...marked].filter(beat => roots.beats.get(beat) instanceof Y.Map));
  const parts = SHARED_SPLIT_OBSERVATION_PARTS.map(part => readSharedSplitObservationPart(roots, beats, part));
  return new Set([...beats].filter(beat => sharedSplitMarkMatches(roots.meta.get(sharedSplitRetiredField(beat)), composeSharedSplitObservation(parts, beat))));
}

export function sharedSplitRetireHolds(roots: SharedSplitRetirementRoots, beat: string): boolean {
  return readSharedSplitRetirements(roots, new Set([beat])).has(beat);
}

export function markSharedSplitRetired(roots: SharedSplitRetirementRoots, beat: string): void {
  roots.meta.set(sharedSplitRetiredField(beat), { observed: readSharedSplitObservation(roots, beat) });
}

// why: these are the places a retire watches, read from the planned state, so a list stages what a copy will read.
export function readSharedSplitWriteBeats(view: { readonly get: (path: readonly string[]) => unknown; readonly keys: (path: readonly string[]) => readonly string[] },
  path: readonly string[], candidates: ReadonlySet<string>): readonly string[] {
  const [root, key, field, entry] = path;
  if (key === undefined || !candidates.size) return [];
  const into = (from: string, join: string): string[] => { const found = readSharedJoinEntry(view.get(["beats", from, "joins", join]))?.into; return found ? [found] : []; };
  if (root === "beats") {
    if (field !== undefined && (field === "stamp" || field.startsWith("stamp:"))) return [];
    const joins = field === undefined || field === "joins" && entry === undefined ? view.keys(["beats", key, "joins"]) : field === "joins" && entry !== undefined ? [entry] : [];
    return [key, ...joins.flatMap(join => into(key, join))];
  }
  if (root === "visuals" || root === "gallery") { const beat = view.get([root, key, "beat"]); return typeof beat === "string" ? [beat] : []; }
  if (root === "statusEvents" || root === "retiredStatus") {
    const event = readSharedStatusEvent(view.get(["statusEvents", key]));
    return event?.target.scope === "beat" ? [event.target.record] : [];
  }
  if (root === "retiredJoins") {
    const group = ((): unknown => { try { return JSON.parse(key); } catch { return null; } })();
    if (Array.isArray(group) && group[0] === "join-retirement" && typeof group[2] === "string") return [group[2]];
    return view.keys(["beats"]).flatMap(from => view.keys(["beats", from, "joins"]).includes(key) ? into(from, key) : []);
  }
  return [];
}
