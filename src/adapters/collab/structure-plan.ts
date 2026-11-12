import { projectSharedBlocks } from "../../core/collab/projection/blocks.ts";
import type { SharedProjectionStream } from "../../core/collab/projection/blocks.ts";
import type { SharedStructureIndex } from "./structure-index.ts";
import { readProjectionHead } from "./projection-reader.ts";
import { cleanId } from "../../core/document/text-policy.ts";
import { readPlannedStructureIndex } from "./structure-order-index.ts";

interface StructurePlanScratch { readonly scratch: <T>(key: string, create: () => T) => T }

function context(view: StructurePlanScratch) {
  return view.scratch("structure-interpretation", () => ({ index: null as SharedStructureIndex | null,
    records: new Map<string, ReturnType<SharedStructureIndex["records"]>[number]>(), heads: new Map<string, SharedProjectionStream>() }));
}

export function bindSharedStructurePlan(view: StructurePlanScratch, index: SharedStructureIndex): void { context(view).index = index; }
export function planSharedStructureOwner(view: StructurePlanScratch, id: string, segment: string): void { context(view).records.set(id, { id, valid: true, segment }); }
export function planSharedStructureHead(view: StructurePlanScratch, segment: string, head: unknown): void {
  context(view).heads.set(segment, { segment, inOrder: true, head: readProjectionHead(head), parts: [] });
}

export function readSharedStructureStream(view: StructurePlanScratch, segment: string): SharedProjectionStream | undefined {
  const state = context(view), raw = state.heads.get(segment) ?? state.index?.segment(segment); if (!raw) return undefined;
  const slot = view.scratch("text-plan-slot:" + JSON.stringify(["segments", segment, "text"]), () => ({ plan: null as { units: readonly { value: unknown }[] } | null }));
  return slot.plan ? { ...raw, parts: slot.plan.units.map((unit, from) => ({ boundary: readProjectionHead(unit.value), units: [], from, to: from + 1 })) } : raw;
}

export function interpretSharedStructure(view: StructurePlanScratch, requests: readonly { readonly owner: string; readonly heading: boolean }[], actual?: SharedProjectionStream) {
  const state = context(view), index = state.index; if (!index) throw new Error("Structural index is not bound to preparation");
  const names = new Set<string>(), headings = new Set<string>();
  const add = (owner: string, heading: boolean) => { (heading ? headings : names).add(owner); };
  for (const request of requests) add(request.owner, request.heading);
  if (actual) for (const boundary of [actual.head, ...actual.parts.map(part => part.boundary)]) if (boundary) {
    add(boundary.id, boundary.kind === "h"); if (boundary.before) add(boundary.before, false);
  }
  const records = new Map<string, ReturnType<SharedStructureIndex["records"]>[number]>(), keys = new Set<string>(actual ? [actual.segment] : []);
  for (const name of names) {
    for (const record of index.records(name)) records.set(record.id, record);
    for (const record of state.records.values()) if (cleanId(record.id) === cleanId(name)) records.set(record.id, record);
    for (const key of index.candidates(name, false)) keys.add(key);
  }
  for (const record of records.values()) if (record.segment) keys.add(record.segment);
  for (const name of headings) for (const key of index.candidates(name, true)) keys.add(key);
  for (const stream of state.heads.values()) if (stream.head && (stream.head.kind === "h" ? headings.has(stream.head.id) : [...names].some(name => cleanId(name) === cleanId(stream.head?.id)))) keys.add(stream.segment);
  const streams = [...keys].flatMap(key => { const stream = actual?.segment === key ? actual : readSharedStructureStream(view, key); return stream ? [stream] : []; })
    .sort((a, b) => {
      const left = readPlannedStructureIndex(view, index.order, a.segment), right = readPlannedStructureIndex(view, index.order, b.segment);
      return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right) || (a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0);
    });
  return projectSharedBlocks(streams, [...records.values()]);
}

export function resolveSharedStructureOwner(view: StructurePlanScratch, owner: string, field: "audioText" | "heading") {
  const index = context(view).index; if (!index) throw new Error("Structural index is not bound to preparation");
  const heading = field === "heading";
  const block = interpretSharedStructure(view, [{ owner, heading }]).find(block => !block.reason && block.id !== null
    && block.kind === (heading ? "h" : "b") && (heading ? block.id === owner : cleanId(block.id) === cleanId(owner)));
  return block?.id && (!heading || index.heading(block.id)) ? Object.freeze({ owner: block.id, segment: block.segment }) : null;
}

export function resolveIndexedStructureOwner(index: SharedStructureIndex, owner: string, field: "audioText" | "heading") {
  const values = new Map<string, unknown>();
  const view: StructurePlanScratch = { scratch: <T>(key: string, create: () => T): T => { if (!values.has(key)) values.set(key, create()); return values.get(key) as T; } };
  bindSharedStructurePlan(view, index); return resolveSharedStructureOwner(view, owner, field);
}
