import * as Y from "yjs";
import type { CollabRoots } from "./roots.ts";
import { sharedJson } from "./snapshot.ts";
import { readSharedJoinEntry, sharedJoinRetirementGroup } from "./join-record.ts";
import { readSharedBoundaryEmbed } from "./structure-boundary.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";

const PREFIX = "splitRetired:";

export type SharedSplitRetirementRoots = Pick<CollabRoots, "meta" | "segments" | "beats" | "visuals" | "gallery" | "statusEvents" | "retiredStatus" | "retiredJoins">;
export type SharedSplitObservationPart = "record" | "boundaries" | "predecessor" | "joins" | "attachments" | "status";
export type SharedSplitObservations = ReadonlyMap<string, unknown>;
export interface SharedSplitReadView {
  readonly get: (path: readonly string[]) => unknown;
  readonly keys: (path: readonly string[]) => readonly string[];
  readonly kind: (path: readonly string[]) => "map" | "text" | "array" | "value" | "missing";
  readonly tree?: (path: readonly string[]) => unknown;
}
type Visit = (count: number) => void;

export function sharedSplitRetiredField(beat: string): string { return PREFIX + beat; }

export function readSharedSplitRetiredBeat(field: string): string | null { return field.startsWith(PREFIX) && field.length > PREFIX.length ? field.slice(PREFIX.length) : null; }

export function readSharedSplitMarks(meta: { readonly keys: () => Iterable<string> }): ReadonlySet<string> {
  return new Set([...meta.keys()].flatMap(key => { const beat = readSharedSplitRetiredBeat(key); return beat ? [beat] : []; }));
}

// why: the stored document is read through the same three questions as the planned state of a list, so readers and
// preparation run one observation; only public reads of the library are used.
export function sharedSplitStoreView(roots: SharedSplitRetirementRoots): SharedSplitReadView {
  const missing = Symbol("missing");
  const at = (path: readonly string[]): unknown => {
    let value: unknown = roots[path[0] as keyof SharedSplitRetirementRoots];
    if (value === undefined) return missing;
    for (const key of path.slice(1)) {
      if (!(value instanceof Y.Map) || !value.has(key)) return missing;
      value = value.get(key);
    }
    return value;
  };
  return {
    get: path => {
      const value = at(path);
      return value === missing || value instanceof Y.Map ? undefined : value instanceof Y.Text ? sharedJson(value.toDelta())
        : value instanceof Y.Array ? sharedJson(value.toArray()) : sharedJson(value);
    },
    keys: path => { const value = at(path); return value instanceof Y.Map ? [...value.keys()] : []; },
    kind: path => {
      const value = at(path);
      return value === missing ? "missing" : value instanceof Y.Map ? "map" : value instanceof Y.Text ? "text" : value instanceof Y.Array ? "array" : "value";
    },
    tree: path => { const value = at(path); return value === missing ? null : storeTree(value); }
  };
}

function storeTree(value: unknown): unknown {
  if (value instanceof Y.Map) return Object.fromEntries([...value.keys()].sort().map(key => [key, storeTree(value.get(key))]));
  return (value instanceof Y.Text ? sharedJson(value.toDelta()) : value instanceof Y.Array ? sharedJson(value.toArray()) : sharedJson(value)) ?? null;
}

// why: the stored document is walked through its own maps, the planned one through the view; both give one tree.
function canonical(view: SharedSplitReadView, path: readonly string[], skip: (key: string, value: unknown) => boolean = () => false): unknown {
  const whole = view.tree?.(path);
  if (whole !== undefined) return whole && typeof whole === "object" && !Array.isArray(whole)
    ? Object.fromEntries(Object.entries(whole).filter(([key, value]) => !skip(key, value))) : whole;
  if (view.kind(path) !== "map") return sharedJson(view.get(path)) ?? null;
  return Object.fromEntries([...view.keys(path)].sort().flatMap(key => {
    const value = canonical(view, [...path, key]);
    return skip(key, value) ? [] : [[key, value]];
  }));
}

function segmentOf(view: SharedSplitReadView, beat: string): string | null {
  const segment = view.get(["beats", beat, "segment"]);
  return typeof segment === "string" ? segment : null;
}

function inserts(view: SharedSplitReadView, segment: string): readonly unknown[] {
  const delta = view.get(["segments", segment, "text"]);
  return Array.isArray(delta) ? delta.map(part => part && typeof part === "object" ? (part as { readonly insert?: unknown }).insert : null) : [];
}

function stamped(key: string): boolean { return key === "stamp" || key.startsWith("stamp:"); }

function typed(value: unknown): unknown { return value && typeof value === "object" ? (value as { readonly type?: unknown }).type : null; }

// why: a mark record counts only while its mark shows: a birth record shows nothing, and a removal takes back the marks
// it observed, so a mark added and taken back leaves the visual as the undo saw it (rule 103).
function shownMarks(view: SharedSplitReadView, path: readonly string[]): unknown {
  const records = canonical(view, path);
  if (!records || typeof records !== "object" || Array.isArray(records)) return records;
  const entries = Object.entries(records), taken = new Set(entries.flatMap(([, value]) => {
    const observed = typed(value) === "remove" ? (value as { readonly observed?: unknown }).observed : null;
    return Array.isArray(observed) ? observed.filter((item): item is string => typeof item === "string") : [];
  }));
  return Object.fromEntries(entries.filter(([key, value]) => typed(value) === "add" && !taken.has(key)));
}

interface SharedSplitWatchedPart {
  readonly name: SharedSplitObservationPart;
  readonly observe: (view: SharedSplitReadView, beats: ReadonlySet<string>, visit: Visit) => SharedSplitObservations;
  readonly staged: (path: readonly string[], segment: (beat: string) => string | null, candidates: ReadonlySet<string>) => readonly string[];
}

const inSegment = (segment: string | undefined, of: (beat: string) => string | null, candidates: ReadonlySet<string>) =>
  segment === undefined ? [] : [...candidates].filter(beat => of(beat) === segment);

// why: one table says what an undone split watches, as the new beat is now, for every reader and the planned state of a
// list; each part is read for all marked beats at once, so a text or a collection is walked once.
export const SHARED_SPLIT_WATCHED_PARTS: readonly SharedSplitWatchedPart[] = Object.freeze([
  { name: "record", observe: (view, beats) => new Map([...beats].map(beat => [beat, canonical(view, ["beats", beat], stamped)])),
    staged: ([root, key, field], _segment, candidates) => root === "beats" && key !== undefined && !(field !== undefined && stamped(field)) && candidates.has(key) ? [key] : [] },
  { name: "boundaries", observe: (view, beats, visit) => {
    const found = new Map<string, number>([...beats].map(beat => [beat, 0]));
    for (const segment of new Set([...beats].flatMap(beat => { const of = segmentOf(view, beat); return of === null ? [] : [of]; }))) for (const insert of inserts(view, segment)) {
      visit(1);
      const boundary = readSharedBoundaryEmbed(insert);
      if (boundary?.kind === "b" && beats.has(boundary.id) && segmentOf(view, boundary.id) === segment) found.set(boundary.id, (found.get(boundary.id) ?? 0) + 1);
    }
    return found;
  },
  staged: ([root, key, field], segment, candidates) => root === "segments" ? inSegment(key, segment, candidates) : root === "beats" && field === "segment" ? [...candidates] : [] },
  // why: a boundary read as text joins the block before it, so the undo holds only while that is the source beat.
  { name: "predecessor", observe: (view, beats, visit) => {
    const found = new Map<string, unknown>(), marked = readSharedSplitMarks({ keys: () => view.keys(["meta"]) });
    for (const segment of new Set([...beats].flatMap(beat => { const of = segmentOf(view, beat); return of === null ? [] : [of]; }))) {
      let last: unknown = readSharedBoundaryEmbed(view.get(["segments", segment, "head"])) ?? null;
      for (const insert of inserts(view, segment)) {
        visit(1);
        const boundary = readSharedBoundaryEmbed(insert);
        if (!boundary) continue;
        if (boundary.kind === "b" && beats.has(boundary.id) && !found.has(boundary.id) && segmentOf(view, boundary.id) === segment) found.set(boundary.id, last);
        if (!(boundary.kind === "b" && marked.has(boundary.id))) last = boundary;
      }
    }
    return new Map([...beats].map(beat => [beat, found.get(beat) ?? null]));
  },
  staged: ([root, key, field], segment, candidates) => root === "segments" ? inSegment(key, segment, candidates)
    : root === "meta" && key !== undefined && readSharedSplitRetiredBeat(key) !== null || root === "beats" && field === "segment" ? [...candidates] : [] },
  { name: "joins", observe: (view, beats, visit) => {
    const found = new Map<string, unknown[]>([...beats].map(beat => [beat, []]));
    for (const from of [...view.keys(["beats"])].sort()) for (const key of [...view.keys(["beats", from, "joins"])].sort()) {
      visit(1);
      const entry = readSharedJoinEntry(view.get(["beats", from, "joins", key]));
      if (!entry || !beats.has(entry.into) || view.get(["retiredJoins", key]) === true || view.get(["retiredJoins", sharedJoinRetirementGroup(from, entry)]) === true) continue;
      found.get(entry.into)?.push([from, key, entry]);
    }
    return found;
  },
  staged: ([root, , field], _segment, candidates) => root === "beats" && (field === undefined || field === "joins") || root === "retiredJoins" ? [...candidates] : [] },
  { name: "attachments", observe: (view, beats, visit) => {
    const found = new Map<string, unknown[]>([...beats].map(beat => [beat, []]));
    for (const collection of ["visuals", "gallery"] as const) for (const key of [...view.keys([collection])].sort()) {
      visit(1);
      const beat = view.get([collection, key, "beat"]);
      if (typeof beat !== "string" || !beats.has(beat)) continue;
      found.get(beat)?.push([collection, key, canonical(view, [collection, key], field => field === "markRecords"), shownMarks(view, [collection, key, "markRecords"])]);
    }
    return found;
  },
  staged: ([root], _segment, candidates) => root === "visuals" || root === "gallery" ? [...candidates] : [] },
  { name: "status", observe: (view, beats, visit) => {
    const events = new Map<string, { readonly beat: string; readonly parents: readonly string[] }>();
    for (const key of view.keys(["statusEvents"])) {
      visit(1);
      const event = readSharedStatusEvent(view.get(["statusEvents", key]));
      if (event?.target.scope === "beat" && beats.has(event.target.record)) events.set(key, { beat: event.target.record, parents: event.parents });
    }
    const retired = (key: string) => view.kind(["retiredStatus", key]) !== "missing";
    const superseded = (key: string, seen = new Set<string>()): boolean => !seen.has(key) && [...events].some(([child, event]) =>
      event.parents.includes(key) && (!retired(child) || superseded(child, new Set([...seen, key]))));
    const found = new Map<string, string[]>([...beats].map(beat => [beat, []]));
    for (const [key, event] of [...events].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) if (!retired(key) && !superseded(key)) found.get(event.beat)?.push(key);
    return found;
  },
  staged: ([root], _segment, candidates) => root === "statusEvents" || root === "retiredStatus" ? [...candidates] : [] }
]);

export const SHARED_SPLIT_OBSERVATION_PARTS: readonly SharedSplitObservationPart[] = Object.freeze(SHARED_SPLIT_WATCHED_PARTS.map(part => part.name));

export function readSharedSplitObservationPart(view: SharedSplitReadView, beats: ReadonlySet<string>, part: SharedSplitObservationPart,
  visit: Visit = () => undefined): SharedSplitObservations {
  const found = SHARED_SPLIT_WATCHED_PARTS.find(entry => entry.name === part);
  if (!found) throw new Error("Unknown watched part: " + part);
  return found.observe(view, beats, visit);
}

// why: the hold is judged on the new beat as it is now (rule 103): a change taken back leaves it as the undo saw it.
export function composeSharedSplitObservation(parts: readonly SharedSplitObservations[], beat: string): string {
  return JSON.stringify(parts.map(part => part.get(beat) ?? null));
}

export function readSharedSplitObservation(view: SharedSplitReadView, beat: string): string {
  const beats = new Set([beat]);
  return composeSharedSplitObservation(SHARED_SPLIT_OBSERVATION_PARTS.map(part => readSharedSplitObservationPart(view, beats, part)), beat);
}

export function sharedSplitMarkMatches(raw: unknown, observation: string): boolean {
  const mark = sharedJson(raw);
  return mark !== null && typeof mark === "object" && !Array.isArray(mark) && (mark as { readonly observed?: unknown }).observed === observation;
}

export function readSharedSplitHolds(view: SharedSplitReadView, beats: ReadonlySet<string>, parts: readonly SharedSplitObservations[]): ReadonlySet<string> {
  return new Set([...beats].filter(beat => view.kind(["beats", beat]) === "map"
    && sharedSplitMarkMatches(view.get(["meta", sharedSplitRetiredField(beat)]), composeSharedSplitObservation(parts, beat))));
}

export function readSharedSplitRetirements(roots: SharedSplitRetirementRoots, marked: ReadonlySet<string>): ReadonlySet<string> {
  const view = sharedSplitStoreView(roots);
  return readSharedSplitHolds(view, marked, SHARED_SPLIT_OBSERVATION_PARTS.map(part => readSharedSplitObservationPart(view, marked, part)));
}

export function sharedSplitRetireHolds(roots: SharedSplitRetirementRoots, beat: string): boolean {
  return readSharedSplitRetirements(roots, new Set([beat])).has(beat);
}

export function readSharedSplitStaged(path: readonly string[], segment: (beat: string) => string | null, candidates: ReadonlySet<string>): ReadonlyMap<SharedSplitObservationPart, readonly string[]> {
  return new Map(SHARED_SPLIT_WATCHED_PARTS.map(part => [part.name, part.staged(path, segment, candidates)]));
}
