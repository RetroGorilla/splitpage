import type { SectionView } from "../../application/editing/section-view.ts";
import type { ShotHiding, ShotRow, ShotRowEntry, ShotStrip } from "../../application/shot-hiding.ts";
import { sectionGroups } from "../../core/document/sections.ts";
import type { DocumentSection, SectionDocument } from "../../core/document/sections.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";

export interface SectionDivider {
  readonly section: DocumentSection;
  readonly count: number;
  readonly folded: boolean;
}

export type SectionRowEntry<R extends ShotRow> = ShotRowEntry<R> | ShotStrip | SectionDivider;

export function sectionRowEntries<R extends ShotRow>(doc: Pick<SectionDocument, "sections"> & { readonly rows: readonly R[] }, hiding: Pick<ShotHiding, "groups">, view: Pick<SectionView, "folded">): SectionRowEntry<R>[] {
  const groups = sectionGroups(doc);
  if (!groups.length) return hiding.groups(doc.rows);
  const entries: SectionRowEntry<R>[] = [];
  const beats = (from: number, to: number): void => {
    for (const item of hiding.groups(doc.rows.slice(from, to))) {
      entries.push("strip" in item ? item : { ...item, index: item.index + from });
    }
  };
  beats(0, groups[0]?.start ?? 0);
  for (const group of groups) {
    const folded = view.folded(group.section.id);
    entries.push({ section: group.section, count: group.end - group.start, folded });
    if (!folded) beats(group.start, group.end);
  }
  return entries;
}

export function sectionHeaderHtml(entry: SectionDivider, readOnly = false, total = ""): string {
  const id = escapeHtml(entry.section.id);
  const name = escapeHtml(entry.section.name);
  const disabled = readOnly ? " disabled" : "";
  return '<div class="section-header" data-section-id="' + id + '">' +
    '<button type="button" class="section-grip" draggable="true" aria-label="Drag section ' + name + '"' + disabled + '>⠿</button>' +
    '<button type="button" class="section-fold" data-section-action="fold" aria-expanded="' + !entry.folded + '" aria-label="' +
      (entry.folded ? 'Expand ' : 'Fold ') + name + '">' + (entry.folded ? '▸' : '▾') + '</button>' +
    '<span role="heading" aria-level="2"><button type="button" class="section-name" data-section-action="rename"' + disabled + '>' + name + '</button></span>' +
    '<span class="section-stats">' + entry.count + ' scene' + (entry.count === 1 ? '' : 's') + ' · <span data-section-total="' + id + '">' + escapeHtml(total) + '</span></span>' +
    '<span class="section-hint" aria-hidden="true" hidden></span>' +
    '<details class="section-more"><summary aria-label="Section menu for ' + name + '">⋯</summary><div class="section-menu">' +
    '<button type="button" data-section-action="rename"' + disabled + '>Rename</button>' +
    '<button type="button" data-section-action="up"' + disabled + '>Move section ↑</button>' +
    '<button type="button" data-section-action="down"' + disabled + '>Move section ↓</button>' +
    '<button type="button" data-section-action="remove"' + disabled + '>Remove header</button>' +
    '</div></details></div>';
}
