import { sectionForScene } from "../../core/document/sections.ts";
import type { SectionDocument } from "../../core/document/sections.ts";

export interface SectionView {
  readonly folded: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly reveal: (doc: SectionDocument, rowId: string) => void;
  readonly reset: () => void;
  readonly subscribe: (changed: () => void) => () => void;
}

export function createSectionView(): SectionView {
  const folded = new Set<string>();
  const listeners = new Set<() => void>();
  function changed(): void { for (const listener of listeners) listener(); }
  return {
    folded: id => folded.has(id),
    toggle(id) { if (folded.has(id)) folded.delete(id); else folded.add(id); changed(); },
    reveal(doc, rowId) {
      const section = sectionForScene(doc, rowId);
      if (section && folded.delete(section.id)) changed();
    },
    reset() { if (!folded.size) return; folded.clear(); changed(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}
