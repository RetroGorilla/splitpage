import { projection } from "../../text/runs.ts";
import { projectSharedTextResult } from "./text.ts";
import type { SharedProjectionUnit } from "./units.ts";
import { projectSharedGroupGallery } from "./gallery.ts";

export interface SharedProjectionBeatStructure {
  readonly id: string;
  readonly removed: boolean;
  readonly joins: readonly { readonly id: string; readonly into: string; readonly glue: "" | " " }[];
}

export function projectSharedJoinGroups(beats: readonly SharedProjectionBeatStructure[]) {
  const ids = [...new Set(beats.map(beat => beat.id))], available = new Set(ids);
  const removed = new Set(beats.filter(beat => beat.removed).map(beat => beat.id));
  const joins = new Map(beats.map(beat => [beat.id, [...beat.joins].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0]]));
  const edges = new Map<string, string>(), cycleRoots = new Set<string>();
  for (const id of ids) { const into = joins.get(id)?.into; if (into !== undefined && available.has(into)) edges.set(id, into); }
  const done = new Set<string>(), rank = new Map(ids.map((id, index) => [id, index]));
  for (const start of ids) {
    const path: string[] = [], positions = new Map<string, number>(); let id: string | undefined = start;
    while (id !== undefined && !done.has(id) && !positions.has(id)) {
      positions.set(id, path.length); path.push(id); id = edges.get(id);
    }
    if (id !== undefined && positions.has(id)) {
      const cycle = path.slice(positions.get(id)).sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
      const live = cycle.filter(member => !removed.has(member));
      const root = live[0] ?? cycle[0];
      if (root !== undefined) {
        if (live.length) for (const member of cycle) {
          if (removed.has(member) || member === root) edges.delete(member);
          else edges.set(member, root);
        }
        else edges.delete(root);
        cycleRoots.add(root);
      }
    }
    for (const member of path) done.add(member);
  }
  const affected = new Map<string, boolean>();
  for (const start of ids) {
    const path: string[] = []; let id: string | undefined = start;
    while (id !== undefined && !affected.has(id)) { path.push(id); id = edges.get(id); }
    let removal = id !== undefined && affected.get(id) === true;
    for (const member of path.reverse()) { removal ||= removed.has(member); affected.set(member, removal); }
  }
  for (const [id, parent] of edges) if (removed.has(id) && !affected.get(parent)) edges.delete(id);
  const roots = new Map<string, string>();
  for (const start of ids) {
    const path: string[] = []; let id = start;
    while (!roots.has(id) && edges.has(id)) { path.push(id); id = edges.get(id) ?? id; }
    const root = roots.get(id) ?? id; roots.set(id, root);
    for (const member of path) roots.set(member, root);
  }
  const children = new Map<string, string[]>();
  for (const id of ids) {
    const parent = edges.get(id);
    if (parent !== undefined) { const own = children.get(parent) ?? []; own.push(id); children.set(parent, own); }
  }
  return ids.filter(id => !edges.has(id)).map(root => {
    const cyclic = cycleRoots.has(root), members = [root], stack = [root];
    if (cyclic) members.push(...ids.filter(id => id !== root && roots.get(id) === root));
    else while (stack.length) {
      const parent = stack.pop();
      if (parent !== root && parent !== undefined) members.push(parent);
      if (parent !== undefined) stack.push(...[...children.get(parent) ?? []].reverse());
    }
    return { root, removed: removed.has(root), cyclic,
      members: members.map(id => ({ id, glue: id === root ? "" as const : joins.get(id)?.glue ?? "" })) };
  });
}

export function projectSharedJoinedUnits(parts: readonly { readonly units: readonly SharedProjectionUnit[]; readonly glue: "" | " " }[],
  tags: readonly Readonly<Record<string, unknown>>[], cyclic: boolean): SharedProjectionUnit[] {
  const units: SharedProjectionUnit[] = [];
  for (const [index, part] of parts.entries()) {
    const left = projectSharedTextResult(units, tags).runs, right = projectSharedTextResult(part.units, tags).runs;
    const glue = index === 0 ? "" : cyclic ? projection(left) && projection(right) && !/\s$/.test(projection(left)) ? " " : "" : part.glue;
    if (glue) {
      const last = left.at(-1), first = right[0], marks: SharedProjectionUnit["marks"][number][] = [];
      if (last && first) {
        if (last.marks.href && last.marks.href === first.marks.href) marks.push({ kind: "link", id: "glue", value: last.marks.href });
        for (const anchor of last.marks.cmt ?? []) if (first.marks.cmt?.includes(anchor)) marks.push({ kind: "comment", id: anchor, value: anchor });
        if (!last.atom && !first.atom && last.marks.dir && first.marks.dir) marks.push({ kind: "dir", value: true });
      }
      units.push({ value: glue, marks });
    }
    units.push(...part.units);
  }
  return units;
}

export function projectSharedJoinStatus(statuses: readonly unknown[]): string {
  return statuses.includes("shot") ? "shot" : statuses.includes("ready") ? "ready" : "todo";
}

export function projectSharedJoinedFields(root: Readonly<Record<string, unknown>>, members: readonly Readonly<Record<string, unknown>>[],
  gallery: readonly { readonly key: string; readonly fields: Readonly<Record<string, unknown>> }[]) {
  const row: Record<string, unknown> = { ...root, status: projectSharedJoinStatus(members.map(member => member.status)) };
  return projectSharedGroupGallery(row, members, gallery);
}

export function projectSharedSections(blocks: readonly { readonly kind: "b" | "h"; readonly id: string; readonly name?: string; readonly extra?: Readonly<Record<string, unknown>> }[], visible: ReadonlySet<string>) {
  const sequence = blocks.filter(block => block.kind === "b" || !!block.name);
  const sections: Record<string, unknown>[] = [], empty: { heading: Record<string, unknown>; beforeRowId: string | null }[] = [];
  for (const [position, block] of sequence.entries()) {
    if (block.kind !== "h") continue;
    const nextHeading = sequence.findIndex((value, index) => index > position && value.kind === "h");
    const first = sequence.slice(position + 1, nextHeading < 0 ? undefined : nextHeading).find(value => value.kind === "b" && visible.has(value.id));
    const heading = { ...block.extra, id: block.id, name: block.name };
    if (first) sections.push({ ...heading, firstSceneId: first.id });
    else empty.push({ heading, beforeRowId: sequence.slice(position + 1).find(value => value.kind === "b" && visible.has(value.id))?.id ?? null });
  }
  return { sections, empty };
}
