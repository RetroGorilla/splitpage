import type { ValidatedDocument } from "../../core/document/validated.ts";
import { scenesAfterRemoval, scenesInOrder, writeScenes } from "../../core/document/scenes.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

export const BEAT_PASTE_FIELDS: readonly string[] = Object.freeze(["comments", "people", "productionTags", "brollShots"]);

export interface BeatPastePlan {
  readonly inserted: readonly string[];
  readonly replaced: string | null;
  readonly title: boolean;
  readonly saveNow: boolean;
}

export interface BeatPaste {
  readonly plan: (doc: DocumentView) => BeatPastePlan | null;
  readonly apply: (live: ValidatedDocument) => void;
}

function present(doc: DocumentView, rowId: string): boolean {
  return doc.rows.some(function (r) { return r.id === rowId; });
}

export function pasteBeatsCommand(paste: BeatPaste): Command {
  return {
    name: "paste-scenes",
    needs: "edit",
    plan: function (doc): Plan | null {
      const planned = paste.plan(doc);
      if (!planned || !planned.inserted.length) return null;
      const replaced = planned.replaced !== null && present(doc, planned.replaced) ? [planned.replaced] : [];
      const scenes = scenesInOrder(doc);
      const nextScenes = replaced.length ? scenes?.map(scene => scene.firstSceneId === planned.replaced
        ? { ...scene, firstSceneId: planned.inserted[0] as string } : scene) : scenes;
      return {
        changes: changeSet({
          rowsInserted: planned.inserted,
          rowsRemoved: replaced,
          docFields: BEAT_PASTE_FIELDS.concat(planned.title ? ["title"] : [], scenes ? ["sections"] : []),
          derive: CELL_TEXT_DERIVES,
          saveNow: planned.saveNow
        }),
        apply: function (live) {
          paste.apply(live);
          if (scenes) writeScenes(live, nextScenes);
          planned.inserted.forEach(function (id) {
            if (!live.rows.some(function (r) { return r.id === id; })) throw new Error("pasted scene " + id + " is not in the document");
          });
        }
      };
    }
  };
}

export function removeBeatsCommand(rowIds: readonly string[]): Command {
  return {
    name: "remove-scenes",
    needs: "edit",
    plan: function (doc): Plan | null {
      const gone = rowIds.filter(function (id, at) { return present(doc, id) && rowIds.indexOf(id) === at; });
      if (!gone.length) return null;
      const hadScenes = !!scenesInOrder(doc);
      const scenes = scenesAfterRemoval(doc, new Set(gone));
      return {
        changes: changeSet({ rowsRemoved: gone, docFields: hadScenes ? ["sections"] : [], derive: CELL_TEXT_DERIVES, saveNow: true }),
        apply: function (live) {
          const out = new Set(gone);
          for (let i = live.rows.length - 1; i >= 0; i--) {
            const row = live.rows[i];
            if (row && out.has(row.id)) live.rows.splice(i, 1);
          }
          if (hadScenes) writeScenes(live, scenes);
        }
      };
    }
  };
}
