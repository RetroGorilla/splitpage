import { normalizeSections, sectionGroups, sectionsInOrder } from "../document/sections.ts";
import type { DocumentSection, SectionDocument } from "../document/sections.ts";

function same(a: DocumentSection | undefined, b: DocumentSection | undefined): boolean {
  return a?.name === b?.name && a?.firstSceneId === b?.firstSceneId;
}

function property(base: string | undefined, mine: string, theirs: string): string {
  return base !== undefined && theirs === base ? mine : theirs;
}

function survivingAnchor(section: DocumentSection, side: SectionDocument, surviving: ReadonlySet<string>): string | undefined {
  if (surviving.has(section.firstSceneId)) return section.firstSceneId;
  const group = sectionGroups(side).find(item => item.section.id === section.id);
  return group ? side.rows.slice(group.start, group.end).find(row => surviving.has(row.id))?.id : undefined;
}

export function mergeSections(
  base: SectionDocument | null | undefined, mine: SectionDocument, theirs: SectionDocument,
  rows: SectionDocument["rows"]
): DocumentSection[] | undefined {
  const b = new Map((normalizeSections(base?.sections) ?? []).map(section => [section.id, section]));
  const m = new Map((normalizeSections(mine.sections) ?? []).map(section => [section.id, section]));
  const t = new Map((normalizeSections(theirs.sections) ?? []).map(section => [section.id, section]));
  const surviving = new Set(rows.map(row => row.id));
  const merged: DocumentSection[] = [];
  for (const id of new Set([...t.keys(), ...m.keys()])) {
    const bs = b.get(id), ms = m.get(id), ts = t.get(id);
    if (!ms && bs && same(bs, ts)) continue;
    if (!ts && bs && same(bs, ms)) continue;
    const picked = ms && ts ? {
      id,
      name: property(bs?.name, ms.name, ts.name),
      firstSceneId: property(bs?.firstSceneId, ms.firstSceneId, ts.firstSceneId)
    } : ms ?? ts;
    if (!picked) continue;
    const side = picked.firstSceneId === ts?.firstSceneId ? theirs : mine;
    const anchor = survivingAnchor(picked, side, surviving);
    if (anchor) merged.push({ ...picked, firstSceneId: anchor });
  }
  return sectionsInOrder({ rows, sections: merged });
}

export function sectionMergeOrder<T extends { readonly id: string }>(
  base: SectionDocument | null | undefined, mine: SectionDocument, theirs: SectionDocument, rows: T[]
): T[] {
  if (!base || !(base.sections || mine.sections || theirs.sections)) return rows;
  const baseIds = new Set(base.rows.map(row => row.id));
  const mineIds = new Set(mine.rows.map(row => row.id));
  const theirIds = new Set(theirs.rows.map(row => row.id));
  const common = (side: SectionDocument): string => side.rows
    .filter(row => baseIds.has(row.id) && mineIds.has(row.id) && theirIds.has(row.id)).map(row => row.id).join("\n");
  if (common(theirs) !== common(base) || common(mine) === common(base)) return rows;
  const byId = new Map(rows.map(row => [row.id, row]));
  const ordered = mine.rows.flatMap(row => {
    const found = byId.get(row.id);
    return found ? [found] : [];
  });
  const placed = new Set(ordered.map(row => row.id));
  const incomingGroups = sectionGroups(theirs);
  const incomingPosition = new Map(theirs.rows.map((row, i) => [row.id, i]));
  rows.forEach((row, i) => {
    if (placed.has(row.id)) return;
    const position = incomingPosition.get(row.id);
    const group = position === undefined ? undefined : incomingGroups.find(item => position >= item.start && position < item.end);
    if (group && position !== undefined) {
      const members = theirs.rows.slice(group.start, group.end);
      const memberAt = position - group.start;
      const preceding = members.slice(0, memberAt).reverse().find(member => placed.has(member.id));
      const following = members.slice(memberAt + 1).find(member => placed.has(member.id));
      const anchor = preceding ?? following;
      if (anchor) {
        const at = ordered.findIndex(item => item.id === anchor.id) + (preceding ? 1 : 0);
        ordered.splice(at, 0, row);
        placed.add(row.id);
        return;
      }
    }
    let at = 0;
    for (let prev = i - 1; prev >= 0; prev--) {
      const anchor = ordered.findIndex(item => item.id === rows[prev]?.id);
      if (anchor !== -1) { at = anchor + 1; break; }
    }
    ordered.splice(at, 0, row);
    placed.add(row.id);
  });
  return ordered;
}
