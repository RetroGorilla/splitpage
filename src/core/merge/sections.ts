import { normalizeSections, sectionGroups } from "../document/sections.ts";
import type { DocumentSection, SectionDocument } from "../document/sections.ts";

function identities(base: SectionDocument | null | undefined, mine: SectionDocument, theirs: SectionDocument): Map<string, string> {
  const b = new Map((normalizeSections(base?.sections) ?? []).map(section => [section.id, section]));
  const m = new Map((normalizeSections(mine.sections) ?? []).map(section => [section.id, section]));
  const t = new Map((normalizeSections(theirs.sections) ?? []).map(section => [section.id, section]));
  const merged = new Map<string, string>();
  for (const id of new Set([...t.keys(), ...m.keys()])) {
    const bs = b.get(id), ms = m.get(id), ts = t.get(id);
    if (!ms && bs && ts?.name === bs.name) continue;
    if (!ts && bs && ms?.name === bs.name) continue;
    const name = ms && ts ? bs && ts.name === bs.name ? ms.name : ts.name : (ms ?? ts)?.name;
    if (name) merged.set(id, name);
  }
  return merged;
}

function membership(doc: SectionDocument): Map<string, string> {
  const out = new Map(doc.rows.map(row => [row.id, ""]));
  for (const group of sectionGroups(doc)) {
    for (let i = group.start; i < group.end; i++) {
      const row = doc.rows[i];
      if (row) out.set(row.id, group.section.id);
    }
  }
  return out;
}

function mergeOrder(base: readonly string[], mine: readonly string[], theirs: readonly string[], all: readonly string[]): string[] {
  const allowed = new Set(all), b = new Set(base), m = new Set(mine), t = new Set(theirs);
  const common = (ids: readonly string[]): string => ids.filter(id => b.has(id) && m.has(id) && t.has(id)).join("\n");
  const preferred = common(theirs) === common(base) && common(mine) !== common(base) ? mine : theirs;
  const additions = preferred === mine ? theirs : mine;
  const ordered = preferred.filter(id => allowed.has(id));
  const placed = new Set(ordered);
  for (const source of [additions, all]) {
    source.forEach((id, i) => {
      if (!allowed.has(id) || placed.has(id)) return;
      const preceding = source.slice(0, i).reverse().find(item => placed.has(item));
      const following = source.slice(i + 1).find(item => placed.has(item));
      const at = preceding !== undefined ? ordered.indexOf(preceding) + 1 : following !== undefined ? ordered.indexOf(following) : ordered.length;
      ordered.splice(at, 0, id);
      placed.add(id);
    });
  }
  return ordered;
}

export function mergeSectionLayout<T extends { readonly id: string }>(
  base: SectionDocument | null | undefined, mine: SectionDocument, theirs: SectionDocument, rows: T[]
): { rows: T[]; sections: DocumentSection[] | undefined } {
  if (!(base?.sections || mine.sections || theirs.sections)) return { rows, sections: undefined };
  const empty: SectionDocument = { rows: [] };
  const original = base ?? empty;
  const names = identities(base, mine, theirs);
  const sectionIds = (doc: SectionDocument): string[] => sectionGroups(doc).map(group => group.section.id);
  const baseOrder = sectionIds(original), mineOrder = sectionIds(mine), theirOrder = sectionIds(theirs);
  const order = mergeOrder(baseOrder, mineOrder, theirOrder, [...names.keys()]);
  const b = membership(original), m = membership(mine), t = membership(theirs);
  const mineGroups = new Map(m), theirGroups = new Map(t);
  for (const [members, ids] of [[m, mineOrder], [t, theirOrder]] as const) {
    for (const [rowId, sectionId] of b) {
      if (!sectionId || ids.includes(sectionId) || !members.has(rowId)) continue;
      const preceding = baseOrder.slice(0, baseOrder.indexOf(sectionId)).reverse().find(id => ids.includes(id)) ?? "";
      if (members.get(rowId) === preceding) members.set(rowId, sectionId);
    }
  }
  if (!base && !mineOrder.length && theirOrder.length) m.clear();
  if (!base && !theirOrder.length && mineOrder.length) t.clear();
  const assignments = rows.map(row => {
    const bm = b.get(row.id), mm = m.get(row.id), tm = t.get(row.id);
    const preferMine = tm === undefined || (mm !== undefined && tm === bm);
    let id = (preferMine ? mm : tm) ?? "";
    if (id && !names.has(id)) {
      const observedMine = mineGroups.get(row.id), observedTheirs = theirGroups.get(row.id);
      id = (observedTheirs === undefined || (observedMine !== undefined && observedTheirs === bm) ? observedMine : observedTheirs) ?? "";
    }
    return { row, id, sideOrder: preferMine ? mineOrder : theirOrder };
  });
  const populated = new Set(assignments.filter(item => names.has(item.id)).map(item => item.id));
  const survivingGroup = (id: string, sideOrder: readonly string[]): string => {
    if (!id || populated.has(id)) return id;
    const source = baseOrder.includes(id) ? baseOrder : sideOrder;
    const before = source.slice(0, source.indexOf(id));
    return before.reverse().find(item => populated.has(item)) ?? "";
  };
  const bucket = new Map<string, T[]>();
  for (const assignment of assignments) {
    const { row } = assignment;
    const id = survivingGroup(assignment.id, assignment.sideOrder);
    const group = bucket.get(id) ?? [];
    group.push(row);
    bucket.set(id, group);
  }
  const ordered: T[] = [], sections: DocumentSection[] = [];
  const canonicalGroups = ["", ...baseOrder];
  const rank = new Map(canonicalGroups.map((id, i) => [id, i]));
  for (const side of [mine, theirs]) {
    for (const group of sectionGroups(side)) {
      if (rank.has(group.section.id)) continue;
      const neighbour = side.rows.slice(0, group.start + 1).reverse().find(row => b.has(row.id));
      rank.set(group.section.id, rank.get(neighbour ? b.get(neighbour.id) ?? "" : "") ?? 0);
    }
  }
  for (const id of ["", ...order]) {
    const group = bucket.get(id);
    if (!group?.length) continue;
    const byId = new Map(group.map(row => [row.id, row]));
    const ids = (doc: SectionDocument, members: ReadonlyMap<string, string>): string[] =>
      doc.rows.filter(row => byId.has(row.id))
        .sort((a, z) => (rank.get(members.get(a.id) ?? "") ?? 0) - (rank.get(members.get(z.id) ?? "") ?? 0))
        .map(row => row.id);
    const groupOrder = mergeOrder(ids(original, b), ids(mine, mineGroups), ids(theirs, theirGroups), group.map(row => row.id));
    for (const rowId of groupOrder) {
      const row = byId.get(rowId);
      if (row) ordered.push(row);
    }
    const firstSceneId = groupOrder[0], name = names.get(id);
    if (id && name && firstSceneId) sections.push({ id, name, firstSceneId });
  }
  return { rows: ordered, sections: sections.length ? sections : undefined };
}
