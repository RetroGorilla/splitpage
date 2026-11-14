import * as Y from "yjs";
import type { CollabRoots } from "./roots.ts";
import { sharedJson } from "./snapshot.ts";
import { sharedPreparedValue } from "./prepare-value.ts";
import { readSharedJoinEntry, sharedJoinRetirementGroup } from "./join-record.ts";
import { readSharedBoundaryEmbed } from "./structure-boundary.ts";
import { readSharedAttachmentOwner } from "./attachment-retention.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";

const PREFIX = "splitRetired:";

export type SharedSplitRetirementRoots = Pick<CollabRoots, "meta" | "segments" | "beats" | "visuals" | "gallery" | "statusEvents" | "retiredStatus" | "retiredJoins">;
export type SharedSplitObservationPart = "record" | "boundaries" | "joins" | "attachments" | "status";
export type SharedSplitObservations = ReadonlyMap<string, readonly string[]>;
export interface SharedSplitStagedView {
  readonly get: (path: readonly string[]) => unknown;
  readonly keys: (path: readonly string[]) => readonly string[];
}
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

// why: a deleted entry keeps its identity in its map, and every insertion into a text leaves a record in its marks,
// so a change that was taken back still shows, and what a retire saw never comes back once it changed.
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

function joinInto(view: SharedSplitStagedView, from: string, join: string): string[] {
  const found = readSharedJoinEntry(view.get(["beats", from, "joins", join]))?.into;
  return found ? [found] : [];
}

interface SharedSplitWatchedPart {
  readonly name: SharedSplitObservationPart;
  readonly observe: (roots: SharedSplitRetirementRoots, beats: ReadonlySet<string>, into: (beat: string) => string[], visit: Visit) => void;
  readonly staged: (view: SharedSplitStagedView, path: readonly string[]) => readonly string[];
}

// why: one table says what an undone split watches, read by every reader and by the planned state of an operation list,
// so the two cannot disagree; the parts are read for all marked beats at once, each text or collection walked once.
export const SHARED_SPLIT_WATCHED_PARTS: readonly SharedSplitWatchedPart[] = Object.freeze([
  { name: "record", observe: (roots, beats, into) => { for (const beat of beats) observed(roots.beats.get(beat), "beat", into(beat)); },
    staged: (_view, [root, key, field]) => root === "beats" && key !== undefined && !(field !== undefined && (field === "stamp" || field.startsWith("stamp:"))) ? [key] : [] },
  { name: "boundaries", observe: (roots, beats, into, visit) => {
    const segments = new Set([...beats].flatMap(beat => { const segment = segmentOf(roots, beat); return segment === null ? [] : [segment]; }));
    for (const segment of segments) {
      const stored = roots.segments.get(segment), text: unknown = stored instanceof Y.Map ? stored.get("text") : null;
      if (text instanceof Y.Text) for (let item = text._start; item; item = item.right) {
        visit(1);
        const boundary = !item.deleted && item.content instanceof Y.ContentEmbed ? readSharedBoundaryEmbed(item.content.embed) : null;
        if (boundary?.kind === "b" && beats.has(boundary.id) && segmentOf(roots, boundary.id) === segment) into(boundary.id).push("boundary" + identity(item));
      }
    }
  },
  // why: only an operation on a beat itself writes its boundary, and a hidden beat never resolves, so no list stages one.
  staged: () => [] },
  { name: "joins", observe: (roots, beats, into, visit) => {
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
  staged: (view, [root, key, field, entry]) => {
    if (key === undefined) return [];
    if (root === "beats") {
      const joins = field === undefined || field === "joins" && entry === undefined ? view.keys(["beats", key, "joins"]) : field === "joins" && entry !== undefined ? [entry] : [];
      return joins.flatMap(join => joinInto(view, key, join));
    }
    if (root !== "retiredJoins") return [];
    const group = ((): unknown => { try { return JSON.parse(key); } catch { return null; } })();
    if (Array.isArray(group) && group[0] === "join-retirement" && typeof group[2] === "string") return [group[2]];
    return view.keys(["beats"]).flatMap(from => view.keys(["beats", from, "joins"]).includes(key) ? joinInto(view, from, key) : []);
  } },
  { name: "attachments", observe: (roots, beats, into, visit) => {
    for (const collection of ["visuals", "gallery"] as const) for (const [key, latest] of sorted<Y.Item>(roots[collection]._map.entries())) {
      for (let item: Y.Item | null = latest; item; item = item.left) {
        visit(1);
        const live = item.deleted ? null : roots[collection].get(key), beat = live instanceof Y.Map ? live.get("beat") : readSharedAttachmentOwner(item);
        if (typeof beat !== "string" || !beats.has(beat)) continue;
        if (live instanceof Y.Map) observed(live, collection + ":" + key, into(beat)); else into(beat).push(collection + ":" + key + identity(item));
      }
    }
  },
  staged: (view, [root, key]) => {
    if ((root !== "visuals" && root !== "gallery") || key === undefined) return [];
    const beat = view.get([root, key, "beat"]);
    return typeof beat === "string" ? [beat] : [];
  } },
  { name: "status", observe: (roots, beats, into, visit) => {
    for (const [key, raw] of sorted(roots.statusEvents.entries())) {
      visit(1);
      const event = readSharedStatusEvent(sharedPreparedValue(raw));
      if (event?.target.scope === "beat" && beats.has(event.target.record)) into(event.target.record).push("status:" + key + (roots.retiredStatus.has(key) ? "-" : ""));
    }
  },
  staged: (view, [root, key]) => {
    if ((root !== "statusEvents" && root !== "retiredStatus") || key === undefined) return [];
    const event = readSharedStatusEvent(view.get(["statusEvents", key]));
    return event?.target.scope === "beat" ? [event.target.record] : [];
  } }
]);

export const SHARED_SPLIT_OBSERVATION_PARTS: readonly SharedSplitObservationPart[] = Object.freeze(SHARED_SPLIT_WATCHED_PARTS.map(part => part.name));

function watched(part: SharedSplitObservationPart): SharedSplitWatchedPart {
  const found = SHARED_SPLIT_WATCHED_PARTS.find(entry => entry.name === part);
  if (!found) throw new Error("Unknown watched part: " + part);
  return found;
}

export function readSharedSplitObservationPart(roots: SharedSplitRetirementRoots, beats: ReadonlySet<string>, part: SharedSplitObservationPart,
  visit: Visit = () => undefined): SharedSplitObservations {
  const found = new Map<string, string[]>([...beats].map(beat => [beat, []]));
  watched(part).observe(roots, beats, beat => { let entries = found.get(beat); if (!entries) { entries = []; found.set(beat, entries); } return entries; }, visit);
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

export function readSharedSplitWriteBeats(view: SharedSplitStagedView, path: readonly string[], candidates: ReadonlySet<string>): readonly string[] {
  if (!candidates.size) return [];
  return [...new Set(SHARED_SPLIT_WATCHED_PARTS.flatMap(part => part.staged(view, path)))].filter(beat => candidates.has(beat));
}
