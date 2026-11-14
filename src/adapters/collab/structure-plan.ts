import { projectSharedBlocks } from "../../core/collab/projection/blocks.ts";
import type { SharedProjectionStream } from "../../core/collab/projection/blocks.ts";
import type { SharedStructureIndex } from "./structure-index.ts";
import { readProjectionHead } from "./projection-reader.ts";
import { cleanId } from "../../core/document/text-policy.ts";
import { readPlannedStructureIndex } from "./structure-order-index.ts";

interface StructurePlanScratch { readonly scratch: <T>(key: string, create: () => T) => T }

function context(view: StructurePlanScratch) {
  return view.scratch("structure-interpretation", () => ({ index: null as SharedStructureIndex | null,
    records: new Map<string, ReturnType<SharedStructureIndex["records"]>[number]>(), heads: new Map<string, SharedProjectionStream>(), removed: new Map<string, boolean>(),
    headings: new Map<string, boolean>(), created: new Map<string, string>(), finalized: new Map<string, string>(), converted: new Map<string, string>(),
    retired: new Map<string, boolean>() }));
}

export function bindSharedStructurePlan(view: StructurePlanScratch, index: SharedStructureIndex): void { context(view).index = index; }
export function sharedStructurePlanIndex(view: StructurePlanScratch): SharedStructureIndex {
  const index = context(view).index; if (!index) throw new Error("Structural index is not bound to preparation"); return index;
}
export function planSharedStructureOwner(view: StructurePlanScratch, id: string, segment: string): void { context(view).records.set(id, { id, valid: true, segment, retired: false }); }
export function planSharedSplitRetirement(view: StructurePlanScratch, beat: string, retired: boolean): void { context(view).retired.set(beat, retired); }
export function readSharedSplitCandidates(view: StructurePlanScratch, index: SharedStructureIndex): ReadonlySet<string> {
  const state = context(view);
  return new Set([...index.retired().filter(beat => state.retired.get(beat) !== false), ...[...state.retired].flatMap(([beat, retired]) => retired ? [beat] : [])]);
}

// why: a staged write to what an undone split watches ends its retirement for the rest of the list, as the copy
// that applies it reads it after that write; only a boundary's own beat moves it, and a hidden beat never resolves.
export function planSharedSplitWrite(view: StructurePlanScratch, candidates: ReadonlySet<string>, beats: Iterable<string>): void {
  const state = context(view);
  for (const beat of beats) if (candidates.has(beat)) state.retired.set(beat, false);
}

export function readSharedSplitRetired(view: StructurePlanScratch, beat: string): boolean {
  const state = context(view);
  return state.retired.get(beat) ?? state.index?.records(beat).find(record => record.id === beat)?.retired ?? false;
}
export function isPlannedStructureOwner(view: StructurePlanScratch, id: string): boolean { return context(view).records.has(id); }
export function planSharedStructureRemoval(view: StructurePlanScratch, id: string, removed: boolean): void { context(view).removed.set(id, removed); }
export function planSharedHeadingRemoval(view: StructurePlanScratch, id: string, removed: boolean): void { context(view).headings.set(id, removed); }
export function planSharedHeadingCreation(view: StructurePlanScratch, id: string, segment: string): void { context(view).created.set(id, segment); }
export function planSharedHeadingFinalization(view: StructurePlanScratch, beat: string, heading: string): void { context(view).finalized.set(beat, heading); }
export function readSharedFinalizedHeading(view: StructurePlanScratch, beat: string): string | null { return context(view).finalized.get(beat) ?? null; }
export function planSharedConvertedBeat(view: StructurePlanScratch, beat: string, segment: string): void { context(view).converted.set(beat, segment); }
export function readSharedConvertedBeat(view: StructurePlanScratch, beat: string) {
  const segment = context(view).converted.get(beat); return segment === undefined ? null : Object.freeze({ owner: beat, segment });
}
function plannedRemoval(state: ReturnType<typeof context>, id: string): boolean {
  const planned = state.removed.get(id), index = state.index;
  if (planned !== undefined || !index) return planned ?? false;
  // why: a removal planned or restored earlier in the list replaces the stored removals of that beat for what follows.
  return index.removed(id) || index.coveredBy(id).some(beat => !state.removed.has(beat));
}
export function readSharedStructureRemoval(view: StructurePlanScratch, id: string): boolean { return plannedRemoval(context(view), id); }
export function planSharedStructureHead(view: StructurePlanScratch, segment: string, head: unknown): void {
  context(view).heads.set(segment, { segment, inOrder: true, head: readProjectionHead(head), parts: [] });
}

export function readSharedStructureStream(view: StructurePlanScratch, segment: string): SharedProjectionStream | undefined {
  const state = context(view), raw = state.heads.get(segment) ?? state.index?.segment(segment); if (!raw) return undefined;
  const slot = view.scratch("text-plan-slot:" + JSON.stringify(["segments", segment, "text"]), () => ({ plan: null as { units: readonly { value: unknown }[] } | null }));
  return slot.plan ? { ...raw, parts: slot.plan.units.map((unit, from) => ({ boundary: readProjectionHead(unit.value), units: [], from, to: from + 1 })) } : raw;
}

export function readPlannedSharedTextOffset(view: StructurePlanScratch, segment: string, offset: number, assoc: -1 | 0 = 0): number {
  const slot = view.scratch("text-plan-slot:" + JSON.stringify(["segments", segment, "text"]), () => ({ plan: null as { native?: { after: readonly number[]; before: readonly number[] } } | null }));
  return slot.plan?.native?.[assoc < 0 ? "before" : "after"][offset] ?? offset;
}

export function interpretSharedStructure(view: StructurePlanScratch, requests: readonly { readonly owner: string; readonly heading: boolean }[], actual?: SharedProjectionStream, purpose: "projected" | "restore-membership" = "projected") {
  const state = context(view), index = state.index; if (!index) throw new Error("Structural index is not bound to preparation");
  const names = new Set<string>(), headings = new Set<string>();
  const add = (owner: string, heading: boolean) => { (heading ? headings : names).add(owner); };
  for (const request of requests) add(request.owner, request.heading);
  if (actual) for (const boundary of [actual.head, ...actual.parts.map(part => part.boundary)]) if (boundary) {
    add(boundary.id, boundary.kind === "h"); if (boundary.before) add(boundary.before, false);
  }
  const records = new Map<string, ReturnType<SharedStructureIndex["records"]>[number]>(), keys = new Set<string>(actual ? [actual.segment] : []);
  const planned = (record: ReturnType<SharedStructureIndex["records"]>[number]) => {
    const retired = state.retired.get(record.id); return retired === undefined || retired === record.retired ? record : { ...record, retired };
  };
  for (const name of names) {
    for (const record of index.records(name)) records.set(record.id, planned(record));
    for (const record of state.records.values()) if (cleanId(record.id) === cleanId(name)) records.set(record.id, planned(record));
    for (const key of index.candidates(name, false)) keys.add(key);
  }
  for (const record of records.values()) if (record.segment) keys.add(record.segment);
  for (const name of headings) { for (const key of index.candidates(name, true)) keys.add(key); const created = state.created.get(name); if (created) keys.add(created); }
  for (const stream of state.heads.values()) if (stream.head && (stream.head.kind === "h" ? headings.has(stream.head.id) : [...names].some(name => cleanId(name) === cleanId(stream.head?.id)))) keys.add(stream.segment);
  const streams = [...keys].flatMap(key => { const stream = actual?.segment === key ? actual : readSharedStructureStream(view, key); return stream ? [stream] : []; })
    .sort((a, b) => {
      const left = readPlannedStructureIndex(view, index.order, a.segment), right = readPlannedStructureIndex(view, index.order, b.segment);
      return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right) || (a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0);
    });
  // why: an unrequested boundary still splits the text unless its split was undone, so a retired one is always known.
  for (const stream of streams) for (const part of stream.parts) {
    const id = part.boundary?.kind === "b" ? part.boundary.id : null;
    const record = id === null || records.has(id) ? undefined : state.records.get(id) ?? index.records(id).find(value => value.id === id);
    if (id !== null && record && planned(record).retired) records.set(id, planned(record));
  }
  return projectSharedBlocks(streams, [...records.values()]).filter(block => purpose === "restore-membership" || block.id === null
    || !(block.kind === "h" ? state.headings.get(block.id) ?? index.headingRemoved(block.id) : plannedRemoval(state, block.id)));
}

function resolveOwner(view: StructurePlanScratch, owner: string, field: "audioText" | "heading", purpose: "projected" | "restore-membership") {
  const state = context(view), index = state.index; if (!index) throw new Error("Structural index is not bound to preparation");
  const heading = field === "heading";
  const block = interpretSharedStructure(view, [{ owner, heading }], undefined, purpose).find(block => !block.reason && block.id !== null
    && block.kind === (heading ? "h" : "b") && (heading ? block.id === owner : cleanId(block.id) === cleanId(owner)));
  return block?.id && (!heading || index.heading(block.id) || state.created.has(block.id)) ? Object.freeze({ owner: block.id, segment: block.segment }) : null;
}

export function resolveSharedStructureOwner(view: StructurePlanScratch, owner: string, field: "audioText" | "heading") {
  return resolveOwner(view, owner, field, "projected");
}

export function resolveSharedRestorableBeat(view: StructurePlanScratch, owner: string) {
  const found = resolveOwner(view, owner, "audioText", "restore-membership");
  return found?.owner === owner ? found : null;
}

export function resolveSharedRestorableHeading(view: StructurePlanScratch, owner: string) {
  const found = resolveOwner(view, owner, "heading", "restore-membership");
  return found?.owner === owner ? found : null;
}

function indexedStructureView(index: SharedStructureIndex) {
  const values = new Map<string, unknown>();
  const view: StructurePlanScratch = { scratch: <T>(key: string, create: () => T): T => { if (!values.has(key)) values.set(key, create()); return values.get(key) as T; } };
  bindSharedStructurePlan(view, index); return view;
}

export function resolveIndexedStructureOwner(index: SharedStructureIndex, owner: string, field: "audioText" | "heading") {
  return resolveSharedStructureOwner(indexedStructureView(index), owner, field);
}

export function resolveIndexedRestorableBeat(index: SharedStructureIndex, owner: string) {
  return resolveSharedRestorableBeat(indexedStructureView(index), owner);
}

export function readIndexedStructureSpans(index: SharedStructureIndex, segment: string) {
  const view = indexedStructureView(index), stream = readSharedStructureStream(view, segment);
  return stream ? interpretSharedStructure(view, [], stream).filter(block => block.segment === segment && !block.reason && block.id !== null) : [];
}
