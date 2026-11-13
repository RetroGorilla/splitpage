import { changeSet, cellEdit } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import { CELL_TEXT_DERIVES } from "../commands/cell-text.ts";
import { readBufferedFieldKey } from "../../core/collab/buffer.ts";
import { cappedText } from "../../core/document/text-policy.ts";
import { SCENE_NAME_MAX } from "../../core/flow/flow.ts";

export type BufferedTextField = "audioText" | "visualText" | "heading" | "title";

export interface BufferedFieldTarget {
  readonly owner: string;
  readonly field: BufferedTextField;
}

export function headingFieldKey(sceneId: string): string {
  return "heading:" + sceneId;
}

export const TITLE_FIELD_KEY = "title:";

export function bufferedFieldTarget(key: string): BufferedFieldTarget | null {
  // why: row and scene ids are cleaned to [A-Za-z0-9_-], so a colon marks a heading or title key, never a beat cell's
  const at = key.indexOf(":");
  if (at < 0) {
    const cell = readBufferedFieldKey(key);
    return cell.rowId ? { owner: cell.rowId, field: cell.field } : null;
  }
  const field = key.slice(0, at), owner = key.slice(at + 1);
  if (field === "heading" && owner) return { owner, field };
  if (field === "title" && !owner) return { owner, field };
  return null;
}

export function unsettledHeading(text: string): { readonly reason: string; readonly hold: boolean } | null {
  if (!cappedText(text, SCENE_NAME_MAX)) return { reason: "buffer-heading-empty", hold: true };
  return Array.from(text).length > SCENE_NAME_MAX ? { reason: "buffer-heading-length", hold: false } : null;
}

export function bufferedFieldChanges(key: string): ChangeSet {
  const target = bufferedFieldTarget(key);
  if (target?.field === "heading") return changeSet({ docFields: ["sections"], derive: CELL_TEXT_DERIVES });
  if (target?.field === "title") return changeSet({ docFields: ["title"] });
  return target ? cellEdit(target.owner, target.field) : cellEdit(key, "audioText");
}
