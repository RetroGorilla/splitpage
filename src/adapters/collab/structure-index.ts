import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedProjectionBoundary, SharedProjectionStream } from "../../core/collab/projection/blocks.ts";
import { cleanId } from "../../core/document/text-policy.ts";
import { collabState, assertSharedDocumentIdle, guardSharedCallback } from "./state.ts";
import { observeSharedStructureOrder } from "./structure-order-index.ts";
import { readProjectionFields, readProjectionHead } from "./projection-reader.ts";
import { freezeSharedPreparedValue, sharedPreparedValue, sharedPreparedTextInsert } from "./prepare-value.ts";
import { sharedEmbedChangeReader } from "./embed-changes.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { readSharedRemovalState } from "./removal-state.ts";
import { createSharedJoinIndex } from "./join-index.ts";
import type { SharedJoinIndex } from "./join-index.ts";
import { sharedJoinEndpointOffset } from "./join-endpoint.ts";
import type { SharedJoinEndpointPosition } from "./join-endpoint.ts";

export interface SharedAttachmentOwnership {
  readonly keys: (collection: "visuals" | "gallery", beat: string) => readonly string[];
}

export interface SharedStructureIndex {
  readonly segment: (id: string) => SharedProjectionStream | undefined;
  readonly records: (name: string) => readonly { readonly id: string; readonly valid: boolean; readonly segment: string | null }[];
  readonly heading: (id: string) => boolean;
  readonly candidates: (name: string, heading: boolean) => readonly string[];
  readonly order: ReturnType<typeof observeSharedStructureOrder>;
  readonly removed: (id: string) => boolean;
  readonly attachments: () => SharedAttachmentOwnership;
  readonly joins: () => SharedJoinIndex;
  readonly endpoint: (position: SharedJoinEndpointPosition) => number | null;
}
type IndexedStructureSegment = { head: SharedProjectionBoundary | null; text: Y.Text | null;
  boundaries: Map<string, { identity: { client: number; clock: number }; boundary: SharedProjectionBoundary }> };
let indexes: WeakMap<SharedDocumentHandle, SharedStructureIndex> | null = null;

export function observeSharedStructureIndex(handle: SharedDocumentHandle): SharedStructureIndex {
  indexes ??= new WeakMap(); const previous = indexes.get(handle); if (previous) return previous;
  const state = collabState(handle); assertSharedDocumentIdle(state);
  const order = observeSharedStructureOrder(handle), segments = new Map<string, IndexedStructureSegment>(), embeds = sharedEmbedChangeReader(handle);
  const records = new Map<string, ReturnType<SharedStructureIndex["records"]>[number]>(), headings = new Set<string>();
  const removed = new Set<string>();
  let joinIndex: ReturnType<typeof createSharedJoinIndex> | null = null;
  let attachmentsReady = false;
  const attachments = { visuals: new Map<string, Set<string>>(), gallery: new Map<string, Set<string>>() };
  const attachmentUpdater = (collection: "visuals" | "gallery") => {
    const owners = new Map<string, string>(), groups = attachments[collection];
    const update = (key: string) => {
      const previous = owners.get(key); if (previous) { const keys = groups.get(previous); keys?.delete(key); if (!keys?.size) groups.delete(previous); }
      owners.delete(key);
      const raw = state.roots[collection].get(key), beat: unknown = raw instanceof Y.Map ? raw.get("beat") : null;
      if (!key || !isStableSharedIdentity(key) || typeof beat !== "string" || !beat || !isStableSharedIdentity(beat)) return;
      let keys = groups.get(beat); if (!keys) { keys = new Set(); groups.set(beat, keys); }
      keys.add(key); owners.set(key, beat);
    };
    return update;
  };
  const updateVisual = attachmentUpdater("visuals"), updateGallery = attachmentUpdater("gallery");
  const names = new Map<string, Set<string>>(), headingNames = new Map<string, Set<string>>(), recordNames = new Map<string, Set<string>>();
  const member = (map: Map<string, Set<string>>, name: string, key: string, add: boolean) => {
    let values = map.get(name); if (add && !values) { values = new Set(); map.set(name, values); }
    if (add) values?.add(key); else { values?.delete(key); if (!values?.size) map.delete(name); }
  };
  const membership = (key: string, value: IndexedStructureSegment, add: boolean) => {
    for (const boundary of [value.head, ...[...value.boundaries.values()].map(value => value.boundary)]) if (boundary) {
      member(boundary.kind === "h" ? headingNames : names, boundary.kind === "h" ? boundary.id : cleanId(boundary.id), key, add);
      if (boundary.before) member(names, cleanId(boundary.before), key, add);
    }
  };
  const updateSegment = (key: string) => {
    const previous = segments.get(key); if (previous) membership(key, previous, false); segments.delete(key);
    const raw = state.roots.segments.get(key); if (!(raw instanceof Y.Map) || !isStableSharedIdentity(key)) return null;
    const text: unknown = raw.get("text"), boundaries = previous && previous.text === text ? previous.boundaries : new Map<string, { identity: { client: number; clock: number }; boundary: SharedProjectionBoundary }>();
    if (text instanceof Y.Text && previous?.text !== text) {
      let offset = 0;
      for (const delta of text.toDelta() as { insert: unknown }[]) {
        const boundary = readProjectionHead(sharedPreparedTextInsert(delta.insert));
        const identity = boundary ? Y.createRelativePositionFromTypeIndex(text, offset).item : null;
        if (boundary && identity) boundaries.set(identity.client + ":" + identity.clock, { identity: { client: identity.client, clock: identity.clock }, boundary });
        offset += typeof delta.insert === "string" ? delta.insert.length : 1;
      }
    }
    const value = { head: readProjectionHead(sharedPreparedValue(raw.get("head"))), text: text instanceof Y.Text ? text : null, boundaries };
    segments.set(key, value); membership(key, value, true);
    return text instanceof Y.Text && previous?.text !== text ? text : null;
  };
  const updateRecord = (key: string) => {
    records.delete(key); removed.delete(key); member(recordNames, cleanId(key), key, false);
    const beat = state.roots.beats.get(key); if (beat === undefined && !state.roots.beats.has(key)) return;
    const fields = readProjectionFields(beat, "beat"), flags: unknown = beat instanceof Y.Map ? beat.get("removals") : null;
    if (readSharedRemovalState(flags instanceof Y.Map ? flags : []).removed) removed.add(key);
    records.set(key, Object.freeze({ id: key, valid: fields?.id === key, segment: typeof fields?.segment === "string" ? fields.segment : null }));
    member(recordNames, cleanId(key), key, true);
  };
  const updateHeading = (key: string) => { headings.delete(key); if (readProjectionFields(state.roots.headings.get(key), "heading")) headings.add(key); };
  const observe = (root: Y.Map<unknown>, update: (key: string) => unknown, fields: readonly string[], textChanges = false) => {
    const listener: Parameters<typeof root.observeDeep>[0] = (events, transaction) => guardSharedCallback(state, () => {
      if (root === state.roots.beats) joinIndex?.changed(events);
      const changed = new Set<string>(), texts = new Map<Y.Text, string>(), rescanned = new Set<Y.Text>();
      for (const event of events) {
        if (!event.path.length && event instanceof Y.YMapEvent) for (const key of event.keysChanged) { if (typeof key === "string") changed.add(key); }
        else if (textChanges && event.path.length === 2 && event.path[1] === "text" && event.target instanceof Y.Text) texts.set(event.target, String(event.path[0]));
        else if (event.path.length === 1 && event instanceof Y.YMapEvent && [...event.keysChanged].some(key => fields.includes(key as string))) changed.add(String(event.path[0]));
        else if (root === state.roots.beats && event.path.length === 2 && event.path[1] === "removals") changed.add(String(event.path[0]));
      }
      for (const key of changed) { const text = update(key); if (text instanceof Y.Text) rescanned.add(text); }
      if (texts.size) for (const change of embeds.read(transaction)) {
        const key = texts.get(change.text), value = key === undefined ? undefined : segments.get(key);
        if (key === undefined || rescanned.has(change.text) || value?.text !== change.text) continue;
        const boundary = readProjectionHead(sharedPreparedTextInsert(change.value)); if (!boundary) continue;
        membership(key, value, false);
        const identity = change.identity, id = identity.client + ":" + identity.clock;
        if (change.delta === 1) value.boundaries.set(id, { identity, boundary }); else value.boundaries.delete(id);
        membership(key, value, true);
      }
    });
    root.observeDeep(listener); return () => root.unobserveDeep(listener);
  };
  for (const key of state.roots.segments.keys()) updateSegment(key);
  for (const key of state.roots.beats.keys()) updateRecord(key);
  for (const key of state.roots.headings.keys()) updateHeading(key);
  const stops = [observe(state.roots.segments, updateSegment, ["head", "text"], true), observe(state.roots.beats, updateRecord, ["id", "segment", "removals"]),
    observe(state.roots.headings, updateHeading, ["id"]), observe(state.roots.visuals, key => { if (attachmentsReady) updateVisual(key); }, ["beat"]),
    observe(state.roots.gallery, key => { if (attachmentsReady) updateGallery(key); }, ["beat"])];
  state.doc.once("destroy", () => guardSharedCallback(state, () => { for (const stop of stops) stop(); }));
  const attachmentIndex: SharedAttachmentOwnership = Object.freeze({ keys: (collection: "visuals" | "gallery", beat: string) => Object.freeze([...(attachments[collection].get(beat) ?? [])].sort()) });
  const index: SharedStructureIndex = Object.freeze({ order, heading: (id: string) => headings.has(id), removed: (id: string) => removed.has(id),
    joins: () => { if (!joinIndex) { assertSharedDocumentIdle(state); joinIndex = createSharedJoinIndex(state.roots.beats); } return joinIndex.index; },
    endpoint: (position: SharedJoinEndpointPosition) => sharedJoinEndpointOffset(position, state.doc, segments.get(position.segment)?.text),
    attachments: () => { assertSharedDocumentIdle(state); if (!attachmentsReady) {
      for (const key of state.roots.visuals.keys()) updateVisual(key);
      for (const key of state.roots.gallery.keys()) updateGallery(key);
      attachmentsReady = true;
    } return attachmentIndex; },
    records: (name: string) => Object.freeze([...(recordNames.get(cleanId(name)) ?? [])].flatMap(key => { const record = records.get(key); return record ? [record] : []; })),
    candidates: (name: string, heading: boolean) => Object.freeze([...(heading ? headingNames.get(name) : names.get(cleanId(name))) ?? []]),
    segment: (key: string) => {
      const value = segments.get(key); if (!value) return undefined;
      const boundaries = [...value.boundaries.values()].flatMap(({ identity, boundary }) => {
        const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON({ item: identity, assoc: 0 }), state.doc);
        return position?.type === value.text ? [{ boundary, at: position.index }] : [];
      }).sort((a, b) => a.at - b.at);
      const parts: SharedProjectionStream["parts"][number][] = []; let offset = 0;
      for (const { boundary, at } of boundaries) {
        if (at > offset) parts.push({ boundary: null, units: [], from: offset, to: at });
        parts.push({ boundary, units: [], from: at, to: at + 1 }); offset = at + 1;
      }
      if ((value.text?.length ?? 0) > offset) parts.push({ boundary: null, units: [], from: offset, to: value.text?.length ?? offset });
      return freezeSharedPreparedValue({ segment: key, inOrder: order.index(key) >= 0, head: value.head, parts });
    } });
  indexes.set(handle, index); return index;
}
