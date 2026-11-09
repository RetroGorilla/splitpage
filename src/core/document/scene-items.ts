import { deriveDocumentNumbering } from "./numbering.ts";
import type { DocumentNumbering, NumberedScene } from "./numbering.ts";
import type { SceneDocument } from "./scenes.ts";

export function groupItemsByScene<T>(doc: SceneDocument, items: readonly T[], rowId: (item: T) => string | null | undefined,
  numbering: DocumentNumbering = deriveDocumentNumbering(doc)): {
  groups: { scene: NumberedScene; items: T[] }[];
  unassigned: T[];
} {
  const groups = numbering.scenes.map(scene => ({ scene, items: [] as T[] }));
  const byScene = new Map(groups.map(group => [group.scene, group]));
  const unassigned: T[] = [];
  for (const item of items) {
    const id = rowId(item);
    const beat = id ? numbering.beats[id] : undefined;
    const group = beat && byScene.get(beat.scene);
    if (group) group.items.push(item);
    else unassigned.push(item);
  }
  return { groups: groups.filter(group => group.items.length > 0), unassigned };
}
