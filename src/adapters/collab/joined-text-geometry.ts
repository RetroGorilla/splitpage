import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedStructureReadView } from "./structure-read-view.ts";
import { projectSharedJoinedLayout } from "../../core/collab/projection/join-layout.ts";
import type { SharedProjectionBeatStructure } from "../../core/collab/projection/joins.ts";
import { projectSharedJoinGlue, sharedJoinGlueRegisterField, readSharedJoinGlue } from "../../core/collab/projection/join-glue.ts";
import { sharedStructurePlanIndex, readSharedStructureStream, interpretSharedStructure, resolveSharedRestorableBeat, readSharedStructureRemoval, readPlannedSharedTextOffset } from "./structure-plan.ts";
import { sharedJoinRetirementGroup } from "./join-record.ts";
import { readSharedJoinEndpoint, sharedJoinEndpointField } from "./join-endpoint.ts";
import { sharedPlannedJoins, sharedPlannedJoinEnds } from "./join-plan.ts";
import { readPlannedStructureIndex } from "./structure-order-index.ts";

export interface SharedJoinedTextFragment { readonly owner: string; readonly segment: string; readonly from: number; readonly to: number; readonly glue: "" | " "; readonly group: string | null; readonly glueSet?: true }
export interface SharedJoinedTextGeometry { readonly root: string; readonly removed: boolean; readonly cyclic: boolean; readonly parts: readonly SharedJoinedTextFragment[] }
function value(view: SharedStructureReadView, path: readonly string[]) { return view.kind(path) === "value" ? view.get(path) : undefined; }

function joinedTextGeometry(view: SharedStructureReadView, owner: string): { readonly geometry: SharedJoinedTextGeometry; readonly fields: readonly string[] } | null {
  const index = sharedStructurePlanIndex(view), joins = index.joins(), planned = sharedPlannedJoins(view);
  const names = [owner], visited = new Set<string>(), segments = new Set<string>();
  const blocks: ReturnType<typeof interpretSharedStructure> = [];
  while (names.length) {
    const name = names.pop(); if (name === undefined || visited.has(name)) continue; visited.add(name);
    names.push(...joins.neighbors(name));
    for (const item of planned.values()) if (item.from === name || item.entry.into === name) names.push(item.from, item.entry.into);
    const staged = resolveSharedRestorableBeat(view, name);
    const keys = [...index.candidates(name, false), ...(staged ? [staged.segment] : [])];
    for (const entry of joins.entries(name)) keys.push(...index.joinSegments(entry.id));
    for (const [id, item] of planned) if (item.from === name) {
      const pending = sharedPlannedJoinEnds(view).get(id); if (pending) keys.push(pending.target.segment, pending.source.segment);
    }
    for (const key of new Set(keys)) if (!segments.has(key)) {
      for (const id of index.segmentJoins(key)) for (const source of joins.locations(id)) if (joins.entries(source).some(entry => entry.id === id)) names.push(source);
      segments.add(key); const stream = readSharedStructureStream(view, key); if (!stream) continue;
      const parts = interpretSharedStructure(view, [], stream, "restore-membership");
      blocks.push(...parts.filter(block => block.segment === key));
      names.push(...parts.flatMap(block => block.kind === "b" && block.id !== null && !block.reason ? [block.id] : []));
    }
  }
  const ordered = blocks.filter(block => block.kind === "b" && block.id !== null && !block.reason).sort((a, b) =>
    readPlannedStructureIndex(view, index.order, a.segment) - readPlannedStructureIndex(view, index.order, b.segment) || a.from - b.from);
  const byId = new Map(ordered.map(block => [block.id as string, block]));
  const groups = new Map<string, string>();
  const structures: SharedProjectionBeatStructure[] = ordered.map(block => {
    const id = block.id as string, entries = new Map(joins.entries(id).map(entry => [entry.id, entry]));
    for (const [key, item] of planned) if (item.from === id) entries.set(key, { id: key, into: item.entry.into, glue: item.entry.glue, generation: item.entry.generation });
    const live = [...entries.values()].flatMap(entry => {
      const group = sharedJoinRetirementGroup(id, entry); groups.set(entry.id, group);
      if (value(view, ["retiredJoins", entry.id]) === true || value(view, ["retiredJoins", group]) === true) return [];
      const end = sharedJoinEndpointField(entry.id), pending = sharedPlannedJoinEnds(view).get(entry.id), stored = value(view, ["meta", end]);
      const position = readSharedJoinEndpoint(stored);
      const resolve = (point: NonNullable<typeof position>["end"]) => {
        const offset = index.endpoint(point); return offset === null ? null : { segment: point.segment, offset: readPlannedSharedTextOffset(view, point.segment, offset, point.assoc) };
      };
      const destination = position && resolve(position.end), start = position && resolve(position.start), stop = position && resolve(position.stop);
      const binding = pending ? { end: { segment: pending.target.segment, offset: pending.point.offset }, start: { segment: pending.source.segment, offset: pending.start.offset }, stop: { segment: pending.source.segment, offset: pending.stop.offset } }
        : destination && start && stop ? { end: destination, start, stop } : null;
      const register = value(view, ["meta", sharedJoinGlueRegisterField(group)]);
      return [{ id: entry.id, into: entry.into, ...(pending || view.has(["meta", end]) ? { binding } : {}), glue: projectSharedJoinGlue(entry.glue, register), ...(readSharedJoinGlue(register) === null ? {} : { glueSet: true as const }) }];
    });
    return { id, removed: readSharedStructureRemoval(view, id), joins: live };
  });
  const selected = projectSharedJoinedLayout(ordered as (typeof ordered[number] & { id: string })[], structures).find(group => group.members.some(member => member.id === owner));
  if (!selected) return null;
  return { fields: selected.fields, geometry: { root: selected.root, removed: selected.removed, cyclic: selected.cyclic, parts: selected.members.flatMap(member => {
    const block = byId.get(member.id); if (!block) return [];
    return [{ owner: member.id, segment: block.segment, from: block.from, to: block.to, glue: member.glue, group: member.join ? groups.get(member.join) ?? null : null, ...(member.glueSet ? { glueSet: true as const } : {}) }];
  }) } };
}

export function readSharedJoinedTextGeometry(view: SharedStructureReadView, owner: string): SharedJoinedTextGeometry | null {
  return joinedTextGeometry(view, owner)?.geometry ?? null;
}

export function readSharedJoinedVisualOwners(view: SharedStructureReadView, owner: string): readonly string[] | null {
  const read = joinedTextGeometry(view, owner);
  return read && !read.geometry.removed ? read.fields : null;
}

export function sharedJoinedTextBaseline(view: SharedStructureReadView, target: SharedTextAddress): SharedJoinedTextGeometry | null {
  const cache = view.scratch("joined-text-baselines", () => new Map<string, SharedJoinedTextGeometry | null>());
  if (!cache.has(target.owner)) {
    const geometry = readSharedJoinedTextGeometry(view, target.owner); cache.set(target.owner, geometry);
    if (geometry && !cache.has(geometry.root)) cache.set(geometry.root, geometry);
  }
  return cache.get(target.owner) ?? null;
}
