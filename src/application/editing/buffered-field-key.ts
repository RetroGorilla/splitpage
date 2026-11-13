import { changeSet, cellEdit } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import { CELL_TEXT_DERIVES } from "../commands/cell-text.ts";

export type BufferedTextField = "audioText" | "heading" | "title";

export interface BufferedFieldTarget {
  readonly owner: string;
  readonly field: BufferedTextField;
}

export function headingFieldKey(sceneId: string): string {
  return "heading:" + sceneId;
}

export const TITLE_FIELD_KEY = "title:";

export function bufferedFieldTarget(key: string): BufferedFieldTarget | null {
  // why: row and scene ids are cleaned to [A-Za-z0-9_-], so a colon marks a field that is not narration
  const at = key.indexOf(":");
  if (at < 0) return key ? { owner: key, field: "audioText" } : null;
  const field = key.slice(0, at), owner = key.slice(at + 1);
  if (field === "heading" && owner) return { owner, field };
  if (field === "title" && !owner) return { owner, field };
  return null;
}

export function bufferedFieldChanges(key: string): ChangeSet {
  const target = bufferedFieldTarget(key);
  if (target?.field === "heading") return changeSet({ docFields: ["sections"], derive: CELL_TEXT_DERIVES });
  if (target?.field === "title") return changeSet({ docFields: ["title"] });
  return cellEdit(key, "audioText");
}
