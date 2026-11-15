import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { sharedJson } from "./snapshot.ts";
import { readCollabMarkState } from "./mark-state.ts";
import { readSharedMarkProvenance, readSharedTextRestoreOperation } from "./mark-provenance.ts";
import { readSharedBoundaryEmbed } from "./structure-boundary.ts";
import { readSharedStatusEvent } from "../../core/collab/read-operation.ts";
import { isSharedGalleryShown } from "./gallery-retirement.ts";
import { sharedJoinRetirementGroup } from "./join-record.ts";
import { observeSharedJoinIndex } from "./shared-join-index.ts";
import { sharedCreationRecordKeys, sharedCreationRecordOwner } from "./creation-record-index.ts";
import { sharedStatusEventKeys } from "./status-index.ts";
import type { SharedContentRef, SharedRecordCollection } from "../../core/collab/operations.ts";
import { readSharedCreationMarkers, SHARED_CREATION_RETIREMENT_FIELD } from "./creation-marker.ts";
import { sharedJoinGlueRegisterField, sharedJoinFormatRegisterField, projectSharedJoinGlue } from "../../core/collab/projection/join-glue.ts";
import { createSharedJoinIndex } from "./join-index.ts";
import { FORMAT_MARKS } from "../../core/text/runs.ts";
import { cachedSharedCreationObservation, peekSharedCreationObservation, sharedCreationReadsSettled, readSharedCreationCandidates,
  watchSharedCreationMap, watchSharedCreationText, watchSharedCreationMembers, watchSharedCreationJoins } from "./creation-observation-cache.ts";

export const sharedCreationObservationCost = { checks: 0, builds: 0 };

function unstamped(key: string): boolean { return key === "stamp" || key.startsWith("stamp:") || key === SHARED_CREATION_RETIREMENT_FIELD; }

// why: a value restored by its creator is unchanged; the same value last written by another copy is their work.
function fields(raw: unknown, writer: string, skip: (key: string) => boolean = () => false): unknown {
  if (!(raw instanceof Y.Map)) return sharedJson(raw) ?? null;
  watchSharedCreationMap(raw, undefined, skip);
  return [...raw.keys()].sort().flatMap(key => skip(key) ? [] : [[key, fields(raw.get(key), writer),
    String(raw._map.get(key)?.lastId.client) !== writer]]);
}

function text(handle: SharedDocumentHandle, record: Y.Map<unknown>, writer: string, from = 0, to = Infinity): unknown {
  watchSharedCreationMap(record, "text"); watchSharedCreationMap(record, "markRecords"); watchSharedCreationMap(record, "head");
  const raw: unknown = record.get("text"); if (!(raw instanceof Y.Text)) return null;
  const store: unknown = record.get("markRecords"), state = readCollabMarkState(handle, raw, store);
  watchSharedCreationText(raw, from, Math.min(to, raw.length), store);
  const provenance = readSharedMarkProvenance(state.records, store instanceof Y.Map ? [...store.keys()] : []);
  const markWriters = new Map(state.records.map(({ identity, record }) => [identity, String(record.writer)]));
  const markIdentity = (addition: { readonly record: SharedContentRef }) => {
    const source = provenance?.source(addition.record) ?? addition.record;
    return markWriters.get(source) === writer ? "own" : source;
  };
  const restored = new Map<string, { readonly client: number; readonly clock: number }>();
  for (const { record } of state.records) {
    const source = record.type === "birth" ? readSharedTextRestoreOperation(record.operation) : null;
    if (source && record.type === "birth" && String(record.writer) === writer) for (let index = 0; index < record.born.length; index++) {
      restored.set(record.born.client + ":" + (record.born.clock + index), { client: source.client, clock: source.clock + index });
    }
  }
  const root = (identity: { readonly client: number; readonly clock: number }) => {
    const visited = new Set<string>(); let at = identity;
    for (;;) {
      const key = at.client + ":" + at.clock, previous = restored.get(key);
      if (!previous || visited.has(key)) return key;
      visited.add(key); at = previous;
    }
  };
  const values = (raw.toDelta() as { insert: unknown }[]).flatMap(part => typeof part.insert === "string" ? part.insert.split("") : [sharedJson(part.insert)]);
  return state.characters.slice(from, to).map(unit => [root(unit.identity), values[unit.offset], unit.marks.map(mark =>
    [mark.kind, mark.id, mark.values, [...new Set(mark.additions.map(markIdentity))].sort()])]);
}

function narration(handle: SharedDocumentHandle, beat: string, record: Y.Map<unknown>, writer: string): unknown {
  watchSharedCreationMap(record, "segment");
  const roots = collabState(handle).roots, segment: unknown = record.get("segment") ?? "b:" + beat, stored = typeof segment === "string" ? roots.segments.get(segment) : null;
  const raw: unknown = stored instanceof Y.Map ? stored.get("text") : null;
  if (!(stored instanceof Y.Map) || !(raw instanceof Y.Text)) return null;
  const boundaries: { readonly at: number; readonly size: number; readonly value: unknown; readonly identity: unknown }[] = [];
  const head: unknown = stored.get("head"); boundaries.push({ at: 0, size: 0, value: head, identity: [segment, "head"] });
  let offset = 0;
  for (const part of raw.toDelta() as { insert: unknown }[]) {
    if (readSharedBoundaryEmbed(part.insert)) boundaries.push({ at: offset, size: 1, value: part.insert, identity: Y.createRelativePositionFromTypeIndex(raw, offset).item });
    offset += typeof part.insert === "string" ? part.insert.length : 1;
  }
  const index = boundaries.findIndex(item => { const boundary = readSharedBoundaryEmbed(item.value); return boundary?.kind === "b" && boundary.id === beat; });
  const own = boundaries[index], next = boundaries[index + 1];
  const headings = boundaries.slice(0, index).filter(item => readSharedBoundaryEmbed(item.value)?.kind === "h");
  return own ? [segment, own.identity, own.value, headings.at(-1)?.value ?? null,
    boundaries.filter(item => { const boundary = readSharedBoundaryEmbed(item.value); return boundary?.kind === "b" && boundary.id === beat; }).map(item => item.identity),
    text(handle, stored, writer, own.at + own.size, next?.at ?? raw.length)] : null;
}

export function readSharedCreationContent(handle: SharedDocumentHandle, beat: string, writer: string): string {
  sharedCreationObservationCost.builds++;
  const roots = collabState(handle).roots, record = roots.beats.get(beat);
  watchSharedCreationMap(roots.beats, beat);
  const owned = (collection: "beats" | "headings" | "visuals" | "gallery" | "comments" | "replies", field: string, owner: string) => {
    const keys = sharedCreationRecordKeys(handle, collection, field, owner);
    watchSharedCreationMembers(roots[collection], keys, raw => raw instanceof Y.Map && raw.get(field) === owner, field, owner, raw => { const value: unknown = raw instanceof Y.Map ? raw.get(field) : null; return typeof value === "string" ? value : null; }); return keys;
  };
  if (!(record instanceof Y.Map)) return "null";
  const attachments = (["visuals", "gallery"] as const).flatMap(collection => owned(collection, "beat", beat).flatMap(id => {
    const value = roots[collection].get(id);
    watchSharedCreationMap(roots[collection], id); if (value instanceof Y.Map && collection === "gallery") watchSharedCreationMap(value, "retired");
    return value instanceof Y.Map && (collection !== "gallery" || isSharedGalleryShown(roots, id, value))
      ? [[collection, id, fields(value, writer, key => key === "text" || key === "markRecords" || key === "retired"), collection === "visuals" ? text(handle, value, writer) : null]] : [];
  }));
  const comments = owned("comments", "rowId", beat).map(id => [id, roots.comments.get(id)] as const);
  const commentIds = new Set(comments.map(([id]) => id));
  const replies = [...commentIds].flatMap(comment => owned("replies", "commentId", comment).map(id => [id, roots.replies.get(id)] as const));
  const index = sharedCreationReadsSettled(handle) ? observeSharedJoinIndex(handle) : createSharedJoinIndex(roots.beats).index;
  const connected = new Set([beat]);
  for (const from of connected) for (const neighbor of index.neighbors(from)) connected.add(neighbor);
  watchSharedCreationJoins(roots.beats, connected);
  const register = (key: string, fallback: unknown) => {
    watchSharedCreationMap(roots.meta, key);
    const item = roots.meta._map.get(key);
    return [fields(roots.meta.get(key) ?? fallback, writer), item !== undefined && String(item.lastId.client) !== writer];
  };
  const joins = [...connected].sort().flatMap(from => index.entries(from).map(entry => {
    const group = sharedJoinRetirementGroup(from, entry), glue = sharedJoinGlueRegisterField(group);
    watchSharedCreationMap(roots.retiredJoins, entry.id); watchSharedCreationMap(roots.retiredJoins, group);
    return [from, entry.id, entry.into, entry.glue, entry.generation, roots.retiredJoins.has(entry.id), roots.retiredJoins.has(group),
      projectSharedJoinGlue(entry.glue, roots.meta.get(glue)), register(glue, entry.glue), FORMAT_MARKS.map(format => register(sharedJoinFormatRegisterField(group, format), false))];
  }));
  const joinedText = [...connected].filter(id => id !== beat).sort().map(id => {
    const value = roots.beats.get(id); return [id, value instanceof Y.Map ? narration(handle, id, value, writer) : null];
  });
  const statusKeys = (sharedCreationReadsSettled(handle) ? sharedStatusEventKeys(handle, { scope: "beat", record: beat as SharedContentRef }) : null) ?? [...roots.statusEvents.keys()];
  const ownStatus = statusKeys.filter(id => { const event = readSharedStatusEvent(roots.statusEvents.get(id)); return event?.target.scope === "beat" && event.target.record === beat; });
  watchSharedCreationMembers(roots.statusEvents, ownStatus, raw => { const event = readSharedStatusEvent(raw); return event?.target.scope === "beat" && event.target.record === beat; }, "target", beat, raw => { const event = readSharedStatusEvent(raw); return event?.target.scope === "beat" ? event.target.record : null; });
  for (const id of ownStatus) { watchSharedCreationMap(roots.statusEvents, id); watchSharedCreationMap(roots.retiredStatus, id); }
  const status = statusKeys.filter(id => {
    const event = readSharedStatusEvent(roots.statusEvents.get(id)); return event?.target.scope === "beat" && event.target.record === beat && !roots.retiredStatus.has(id);
  }).sort().map(id => [id, sharedJson(roots.statusEvents.get(id))]);
  const splits = owned("beats", "splitSource", beat);
  const headings = owned("headings", "firstBeat", beat);
  return JSON.stringify([fields(record, writer, unstamped), narration(handle, beat, record, writer), attachments, joins, status,
    comments.map(([id, value]) => [id, fields(value, writer, key => key === "updatedAt")]), replies.map(([id, value]) => [id, fields(value, writer)]), splits, headings, joinedText]);
}

export function isSharedCreationRetired(handle: SharedDocumentHandle, beat: string): boolean {
  sharedCreationObservationCost.checks++;
  if (!readSharedCreationMarkers(handle).has(beat)) return false;
  const state = collabState(handle);
  const read = () => {
    watchSharedCreationMap(state.roots.creationRetired, beat);
    const raw: unknown = state.roots.creationRetired.get(beat);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const { observed, writer } = raw as Record<string, unknown>;
    return typeof observed === "string" && typeof writer === "string" && readSharedCreationContent(handle, beat, writer) === observed;
  };
  return cachedSharedCreationObservation(handle, beat, read);
}

export function readSharedCreationHidden(handle: SharedDocumentHandle, beat: string): boolean {
  if (!readSharedCreationMarkers(handle).has(beat)) return false;
  return peekSharedCreationObservation(handle, beat) ?? isSharedCreationRetired(handle, beat);
}

export function readSharedCreationRetirements(handle: SharedDocumentHandle): ReadonlySet<string> {
  const markers = readSharedCreationMarkers(handle), hidden = new Set<string>();
  if (!markers.size) return hidden;
  for (const beat of readSharedCreationCandidates(handle)) if (readSharedCreationHidden(handle, beat)) hidden.add(beat);
  return hidden;
}

export function isSharedCreationRecordShown(handle: SharedDocumentHandle, collection: SharedRecordCollection, fields: Readonly<Record<string, unknown>>): boolean {
  if (!["gallery", "visuals", "comments", "replies"].includes(collection) || !readSharedCreationMarkers(handle).size) return true;
  const beat = collection === "comments" ? fields.rowId : collection === "replies"
    ? sharedCreationRecordOwner(handle, "comments", "rowId", String(fields.commentId)) : fields.beat;
  return typeof beat !== "string" || !readSharedCreationHidden(handle, beat);
}
