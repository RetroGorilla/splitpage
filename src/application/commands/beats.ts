import type { ValidatedDocument } from "../../core/document/validated.ts";
import { sceneFirstBeatId, scenesAfterRemoval, scenesInOrder, startsParagraph, withSceneFirstBeat, writeScenes } from "../../core/document/scenes.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";
import { applyParagraphFlags, paragraphCells, paragraphFlagsAfterOrder } from "./paragraphs.ts";
import type { DocumentScene } from "../../core/document/scenes.ts";
import { sharedRemoval } from "./shared-structure.ts";
import type { SharedStructurePorts } from "./shared-structure.ts";

export const BEAT_PASTE_FIELDS: readonly string[] = Object.freeze(["comments", "people", "productionTags", "brollShots"]);

export interface BeatPastePlan {
  readonly inserted: readonly string[];
  readonly replaced: string | null;
  readonly title: boolean;
  readonly saveNow: boolean;
  readonly afterRowId?: string | null | undefined;
  readonly sections?: readonly DocumentScene[] | undefined;
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
      const nextScenes = replaced.length ? scenes?.map(scene => sceneFirstBeatId(scene) === planned.replaced
        ? withSceneFirstBeat(scene, planned.inserted[0] as string) : scene) : scenes;
      const after = doc.rows.findIndex(row => row.id === planned.afterRowId);
      const at = replaced.length ? doc.rows.findIndex(row => row.id === planned.replaced)
        : after === -1 ? doc.rows.length : after + 1;
      const following = doc.rows[at + replaced.length];
      const boundary = at === 0 || !following || startsParagraph(doc, following.id) ||
        (replaced.length > 0 && startsParagraph(doc, replaced[0] as string));
      const flags = following && boundary && !startsParagraph(doc, following.id)
        ? [{ rowId: following.id, start: true }] : [];
      return {
        changes: changeSet({
          cells: paragraphCells(flags),
          rowsInserted: planned.inserted,
          rowsRemoved: replaced,
          docFields: BEAT_PASTE_FIELDS.concat(planned.title ? ["title"] : [], scenes || planned.sections?.length ? ["sections"] : []),
          derive: CELL_TEXT_DERIVES,
          saveNow: planned.saveNow
        }),
        apply: function (live) {
          paste.apply(live);
          const combined = [...(nextScenes ?? []), ...(planned.sections ?? [])];
          if (scenes || planned.sections?.length) {
            const positions = new Map(live.rows.map((row, index) => [row.id, index]));
            combined.sort((a, b) => (positions.get(a.firstSceneId) ?? 0) - (positions.get(b.firstSceneId) ?? 0));
            writeScenes(live, combined);
          }
          planned.inserted.forEach(function (id) {
            if (!live.rows.some(function (r) { return r.id === id; })) throw new Error("pasted scene " + id + " is not in the document");
          });
          const first = planned.inserted[0] as string;
          applyParagraphFlags(live.rows, [{ rowId: first, start: boundary &&
            live.rows[0]?.id !== first && !combined.some(scene => sceneFirstBeatId(scene) === first) }, ...flags]);
        }
      };
    }
  };
}

export function removeBeatsCommand(rowIds: readonly string[], shared?: SharedStructurePorts): Command {
  return {
    name: "remove-scenes",
    needs: "edit",
    plan: function (doc): Plan | null {
      const gone = rowIds.filter(function (id, at) { return present(doc, id) && rowIds.indexOf(id) === at; });
      if (!gone.length) return null;
      const hadScenes = !!scenesInOrder(doc);
      const scenes = scenesAfterRemoval(doc, new Set(gone));
      const flags = paragraphFlagsAfterOrder(doc, doc.rows.filter(row => !gone.includes(row.id)).map(row => row.id), scenes);
      return {
        ...sharedRemoval(doc, gone, flags, shared),
        changes: changeSet({ rowsRemoved: gone, cells: paragraphCells(flags), docFields: hadScenes ? ["sections"] : [], derive: CELL_TEXT_DERIVES, saveNow: true }),
        apply: function (live) {
          const out = new Set(gone);
          for (let i = live.rows.length - 1; i >= 0; i--) {
            const row = live.rows[i];
            if (row && out.has(row.id)) live.rows.splice(i, 1);
          }
          if (hadScenes) writeScenes(live, scenes);
          applyParagraphFlags(live.rows, flags);
        }
      };
    }
  };
}
