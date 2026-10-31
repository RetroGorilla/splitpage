import { normalizeSections, sectionGroups } from "../document/sections.ts";
import type { DocumentSection, SectionDocument } from "../document/sections.ts";

function same(a: DocumentSection | undefined, b: DocumentSection | undefined): boolean {
  return a?.name === b?.name && a?.firstSceneId === b?.firstSceneId;
}

function identities(base: SectionDocument | null | undefined, mine: SectionDocument, theirs: SectionDocument): Map<string, string> {
  const b = new Map((normalizeSections(base?.sections) ?? []).map(section => [section.id, section]));
  const m = new Map((normalizeSections(mine.sections) ?? []).map(section => [section.id, section]));
  const t = new Map((normalizeSections(theirs.sections) ?? []).map(section => [section.id, section]));
  const merged = new Map<string, string>();
  for (const id of new Set([...t.keys(), ...m.keys()])) {
    const bs = b.get(id), ms = m.get(id), ts = t.get(id);
    if (!ms && bs && same(bs, ts)) continue;
    if (!ts && bs && same(bs, ms)) continue;
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
  const sameRows = (side: SectionDocument): boolean => side.rows.length === original.rows.length &&
    side.rows.every((row, i) => row.id === original.rows[i]?.id);
  for (const [side, members, ids] of [[mine, m, mineOrder], [theirs, t, theirOrder]] as const) {
    if (!sameRows(side)) continue;
    for (const [rowId, sectionId] of b) {
      if (sectionId && names.has(sectionId) && !ids.includes(sectionId)) members.set(rowId, sectionId);
    }
  }
  const survivingGroup = (id: string, sideOrder: readonly string[]): string => {
    if (!id || names.has(id)) return id;
    const source = baseOrder.includes(id) ? baseOrder : sideOrder;
    const before = source.slice(0, source.indexOf(id));
    return before.reverse().find(item => names.has(item)) ?? "";
  };
  const bucket = new Map<string, T[]>();
  for (const row of rows) {
    const projected = (members: ReadonlyMap<string, string>, sideOrder: readonly string[]): string | undefined => {
      const member = members.get(row.id);
      return member === undefined ? undefined : survivingGroup(member, sideOrder);
    };
    const bm = projected(b, baseOrder), mm = projected(m, mineOrder), tm = projected(t, theirOrder);
    const chosen = mm === undefined ? tm : tm === undefined ? mm : tm === bm ? mm : tm;
    const id = chosen ?? "";
    const group = bucket.get(id) ?? [];
    group.push(row);
    bucket.set(id, group);
  }
  const ordered: T[] = [], sections: DocumentSection[] = [];
  const canonicalGroups = ["", ...baseOrder, ...order.filter(id => !baseOrder.includes(id))];
  for (const id of ["", ...order]) {
    const group = bucket.get(id);
    if (!group?.length) continue;
    const byId = new Map(group.map(row => [row.id, row]));
    const ids = (doc: SectionDocument, members: ReadonlyMap<string, string>, sideOrder: readonly string[]): string[] =>
      doc.rows.filter(row => byId.has(row.id) && survivingGroup(members.get(row.id) ?? "", sideOrder) === id)
        .sort((a, z) => canonicalGroups.indexOf(members.get(a.id) ?? "") - canonicalGroups.indexOf(members.get(z.id) ?? ""))
        .map(row => row.id);
    const groupOrder = mergeOrder(ids(original, b, baseOrder), ids(mine, m, mineOrder), ids(theirs, t, theirOrder), group.map(row => row.id));
    for (const rowId of groupOrder) {
      const row = byId.get(rowId);
      if (row) ordered.push(row);
    }
    const firstSceneId = groupOrder[0], name = names.get(id);
    if (id && name && firstSceneId) sections.push({ id, name, firstSceneId });
  }
  return { rows: ordered, sections: sections.length ? sections : undefined };
}
