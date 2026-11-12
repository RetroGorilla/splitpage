import { projectSharedJoinForest, projectSharedJoinGroups } from "./joins.ts";
import type { SharedProjectionBeatStructure } from "./joins.ts";

export interface SharedJoinLayoutBlock { readonly id: string; readonly segment: string; readonly from: number; readonly to: number }
export interface SharedJoinLayoutPart extends SharedJoinLayoutBlock { readonly glue: "" | " "; readonly join: string | null; readonly glueSet?: true }
export interface SharedJoinLayoutRow { readonly root: string; readonly removed: boolean; readonly cyclic: boolean; readonly members: readonly SharedJoinLayoutPart[]; readonly fields: readonly string[] }

export function projectSharedJoinedLayout(blocks: readonly SharedJoinLayoutBlock[], structures: readonly SharedProjectionBeatStructure[]): SharedJoinLayoutRow[] {
  const forest = projectSharedJoinForest(structures), byId = new Map(blocks.map(block => [block.id, block]));
  const ranks = new Map(blocks.map((block, index) => [block.id, index]));
  const sources = new Map<string, { id: string; into: string; entry: NonNullable<ReturnType<typeof forest.joins.get>>; blocks: readonly SharedJoinLayoutBlock[]; end: string; cyclic: boolean }>();
  const originalGroups = projectSharedJoinGroups(structures);
  const cycles = new Map(originalGroups.filter(group => group.cyclic).flatMap(group => group.members.map(member => [member.id, group] as const)));
  for (const [id, into] of forest.edges) {
    const entry = forest.joins.get(id), own = byId.get(id); if (!entry || !own || entry.binding === null) continue;
    const cycle = cycles.get(id), root = cycle?.root;
    const endEntry = root ? forest.joins.get(forest.cycleEnds.get(root) ?? "") : entry;
    const point = endEntry?.binding?.end;
    const host = point ? blocks.find(block => block.segment === point.segment && block.from <= point.offset && block.to >= point.offset) : byId.get(root ?? into);
    if (!host) continue;
    const binding = entry.binding;
    const parts = binding ? blocks.filter(block => block.segment === binding.start.segment && binding.stop.segment === binding.start.segment
      && block.from >= binding.start.offset && block.to <= binding.stop.offset) : [own];
    if (!parts.length) continue;
    sources.set(id, { id, into: root ?? into, entry, blocks: parts, end: host.id, cyclic: !!root });
  }
  const ownership = new Map<string, string>();
  for (const block of blocks) {
    const candidates = [...sources.values()].filter(source => source.blocks.includes(block)).sort((a, b) =>
      a.blocks.length - b.blocks.length || (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
    const first = candidates[0]; if (first) ownership.set(block.id, first.id);
  }
  const scope = (kind: "source" | "block", id: string) => JSON.stringify([kind, id]);
  const effective = [...sources.values()].map(source => ({ id: scope("source", source.id), removed: false, joins: [{ ...source.entry,
    into: ownership.has(source.end) ? scope("source", ownership.get(source.end) as string) : scope("block", source.end) }] }));
  const scopeStructures: SharedProjectionBeatStructure[] = [
    ...blocks.flatMap(block => ownership.has(block.id) ? effective.filter(value => value.id === scope("source", ownership.get(block.id) as string))
      : [{ id: scope("block", block.id), removed: false, joins: [] }])
  ];
  const safe = projectSharedJoinForest(scopeStructures);
  const children = new Map<string, typeof sources extends Map<string, infer T> ? T[] : never>();
  const detached = new Set<string>();
  for (const source of sources.values()) {
    if (!safe.edges.has(scope("source", source.id))) { detached.add(source.id); continue; }
    const list = children.get(source.end) ?? []; list.push(source); children.set(source.end, list);
  }
  for (const list of children.values()) list.sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
  const rows: { root: string; removed: boolean; cyclic: boolean; members: SharedJoinLayoutPart[]; fields: string[] }[] = [];
  const emitted = new Set<string>(), active = new Set<string>();
  const render = (parts: readonly SharedJoinLayoutBlock[], fold: boolean, source?: NonNullable<ReturnType<typeof sources.get>>, inheritedRemoved = false) => {
    if (source && active.has(source.id)) return;
    if (source) active.add(source.id);
    let first = true;
    for (const block of parts) {
      if (emitted.has(block.id) || source && ownership.get(block.id) !== source.id) continue;
      emitted.add(block.id);
      const removed = inheritedRemoved || forest.removed.has(block.id);
      let row = fold && first && rows.at(-1)?.removed === removed ? rows.at(-1) : undefined;
      if (!row) { row = { root: block.id, removed, cyclic: false, members: [], fields: [] }; rows.push(row); }
      row.cyclic ||= source?.cyclic ?? false;
      row.members.push({ ...block, glue: first && fold ? source?.entry.glue ?? "" : "", join: first && fold ? source?.entry.id ?? null : null,
        ...(first && fold && source?.entry.glueSet ? { glueSet: true as const } : {}) });
      first = false;
      for (const child of children.get(block.id) ?? []) render(child.blocks, true, child, row.removed);
    }
    if (source) active.delete(source.id);
  };
  for (const block of blocks) {
    const owner = ownership.get(block.id);
    if (!owner) render([block], false);
    else if (detached.has(owner)) { const source = sources.get(owner); if (source) render(source.blocks, false, source); }
  }
  for (const block of blocks) if (!emitted.has(block.id)) render([block], false);
  const rowOf = new Map(rows.flatMap(row => row.members.map(member => [member.id, row] as const)));
  const fieldStructures: SharedProjectionBeatStructure[] = blocks.map(block => ({ id: block.id, removed: forest.removed.has(block.id), joins: [] }));
  for (const source of sources.values()) {
    const first = source.blocks.find(block => ownership.get(block.id) === source.id);
    const fields = fieldStructures.find(block => block.id === first?.id);
    if (fields) (fields.joins as SharedProjectionBeatStructure["joins"][number][]).push({ ...source.entry, into: source.into });
  }
  for (const group of projectSharedJoinGroups(fieldStructures)) {
    const row = rowOf.get(group.root); if (row) row.fields.push(...group.members.map(member => member.id));
  }
  return rows;
}
