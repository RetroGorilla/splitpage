import { cappedText } from "./text-policy.ts";

export interface DocumentSection {
  readonly id: string;
  readonly name: string;
  readonly firstSceneId: string;
}

export interface SectionDocument {
  readonly rows: readonly { readonly id: string }[];
  readonly sections?: unknown;
}

export interface SectionGroup {
  readonly section: DocumentSection;
  readonly start: number;
  readonly end: number;
}

export function normalizeSections(value: unknown): DocumentSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const anchors = new Set<string>();
  const out: DocumentSection[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" && /^[A-Za-z0-9_-]+$/.test(item.id) ? item.id : "";
    const firstSceneId = typeof item.firstSceneId === "string" ? item.firstSceneId : "";
    const name = cappedText(item.name, 200);
    if (!id || !name || !firstSceneId || ids.has(id) || anchors.has(firstSceneId)) continue;
    ids.add(id);
    anchors.add(firstSceneId);
    out.push({ id, name, firstSceneId });
  }
  return out.length ? out : undefined;
}

export function sectionGroups(doc: SectionDocument): SectionGroup[] {
  const sections = normalizeSections(doc.sections);
  if (!sections) return [];
  const positions = new Map(doc.rows.map((row, i) => [row.id, i]));
  const groups = sections.flatMap(section => {
    const start = positions.get(section.firstSceneId);
    return start === undefined ? [] : [{ section, start, end: doc.rows.length }];
  }).sort((a, b) => a.start - b.start);
  groups.forEach((group, i) => { group.end = groups[i + 1]?.start ?? doc.rows.length; });
  return groups;
}

export function sectionsInOrder(doc: SectionDocument): DocumentSection[] | undefined {
  const sections = sectionGroups(doc).map(group => group.section);
  return sections.length ? sections : undefined;
}

export function sectionForScene(doc: SectionDocument, rowId: string): DocumentSection | undefined {
  const at = doc.rows.findIndex(row => row.id === rowId);
  return sectionGroups(doc).find(group => at >= group.start && at < group.end)?.section;
}

export function sectionBeforeScene(doc: SectionDocument, rowId: string): DocumentSection | undefined {
  return normalizeSections(doc.sections)?.find(section => section.firstSceneId === rowId);
}

export function sectionsAfterRemoval(doc: SectionDocument, removed: ReadonlySet<string>): DocumentSection[] | undefined {
  const sections = sectionGroups(doc).flatMap(group => {
    const first = doc.rows.slice(group.start, group.end).find(row => !removed.has(row.id));
    return first ? [{ ...group.section, firstSceneId: first.id }] : [];
  });
  return sections.length ? sections : undefined;
}

export function writeSections(doc: Record<string, unknown>, sections: readonly DocumentSection[] | undefined): void {
  if (sections?.length) doc.sections = sections.map(section => ({ ...section }));
  else delete doc.sections;
}
