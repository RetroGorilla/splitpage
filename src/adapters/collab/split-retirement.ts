import * as Y from "yjs";
import type { CollabRoots } from "./roots.ts";
import { sharedJson } from "./snapshot.ts";
import { sharedPreparedValue } from "./prepare-value.ts";
import { readSharedJoinEntry, sharedJoinRetirementGroup } from "./join-record.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";

const PREFIX = "splitRetired:";

export type SharedSplitRetirementRoots = Pick<CollabRoots, "meta" | "segments" | "beats" | "visuals" | "gallery" | "statusEvents" | "retiredStatus" | "retiredJoins">;
export type SharedSplitObservationPart = "record" | "boundaries" | "joins" | "attachments" | "status";

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

const PARTS: Readonly<Record<SharedSplitObservationPart, (roots: SharedSplitRetirementRoots, beat: string, into: string[]) => void>> = Object.freeze({
  record: (roots, beat, into) => observed(roots.beats.get(beat), "beat", into),
  boundaries: (roots, beat, into) => {
    const record = roots.beats.get(beat), segment = record instanceof Y.Map ? record.get("segment") : null;
    const stored = typeof segment === "string" ? roots.segments.get(segment) : null, text: unknown = stored instanceof Y.Map ? stored.get("text") : null;
    if (text instanceof Y.Text) for (let item = text._start; item; item = item.right) {
      const embed: unknown = !item.deleted && item.content instanceof Y.ContentEmbed ? item.content.embed : null;
      if (embed && typeof embed === "object" && (embed as { readonly b?: unknown }).b === beat) into.push("boundary" + identity(item));
    }
  },
  joins: (roots, beat, into) => {
    for (const [from, record] of sorted(roots.beats.entries())) {
      const joins: unknown = record instanceof Y.Map ? record.get("joins") : null;
      if (joins instanceof Y.Map) for (const [key, item] of sorted<Y.Item>(joins._map.entries())) {
        const entry = item.deleted ? null : readSharedJoinEntry(joins.get(key));
        if (entry?.into !== beat) continue;
        const retired = roots.retiredJoins.get(key) === true || roots.retiredJoins.get(sharedJoinRetirementGroup(from, entry)) === true;
        into.push("join:" + from + "/" + key + identity(item) + (retired ? "-" : ""));
      }
    }
  },
  attachments: (roots, beat, into) => {
    for (const collection of ["visuals", "gallery"] as const) for (const [key, record] of sorted(roots[collection].entries()))
      if (record instanceof Y.Map && record.get("beat") === beat) observed(record, collection + ":" + key, into);
  },
  status: (roots, beat, into) => {
    for (const [key, raw] of sorted(roots.statusEvents.entries())) {
      const event = readSharedStatusEvent(sharedPreparedValue(raw));
      if (event?.target.scope === "beat" && event.target.record === beat) into.push("status:" + key + (roots.retiredStatus.has(key) ? "-" : ""));
    }
  }
});

export const SHARED_SPLIT_OBSERVATION_PARTS: readonly SharedSplitObservationPart[] = Object.freeze(["record", "boundaries", "joins", "attachments", "status"]);

export function readSharedSplitObservationPart(roots: SharedSplitRetirementRoots, beat: string, part: SharedSplitObservationPart): readonly string[] {
  const entries: string[] = []; PARTS[part](roots, beat, entries); return entries;
}

// why: every write gets a new identity, so the list of what a retire saw of the new beat tells, on every copy, whether
// someone changed it without having seen the retire; stamps are left out, since undo never takes one back (rule 35).
export function readSharedSplitObservation(roots: SharedSplitRetirementRoots, beat: string): string {
  return JSON.stringify(SHARED_SPLIT_OBSERVATION_PARTS.map(part => readSharedSplitObservationPart(roots, beat, part)));
}

export function sharedSplitMarkMatches(raw: unknown, observation: string): boolean {
  const mark = sharedJson(raw);
  return mark !== null && typeof mark === "object" && !Array.isArray(mark) && (mark as { readonly observed?: unknown }).observed === observation;
}

export function sharedSplitRetireHolds(roots: SharedSplitRetirementRoots, beat: string): boolean {
  return roots.beats.get(beat) instanceof Y.Map && sharedSplitMarkMatches(roots.meta.get(sharedSplitRetiredField(beat)), readSharedSplitObservation(roots, beat));
}

export function markSharedSplitRetired(roots: SharedSplitRetirementRoots, beat: string): void {
  roots.meta.set(sharedSplitRetiredField(beat), { observed: readSharedSplitObservation(roots, beat) });
}
