import type { DocumentComment, ValidatedDocument } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

export const SCENE_PASTE_FIELDS: readonly string[] = Object.freeze(["comments", "people", "productionTags", "brollShots"]);

export interface ScenePastePlan {
  readonly inserted: readonly string[];
  readonly replaced: string | null;
  readonly title: boolean;
  readonly saveNow: boolean;
}

export interface ScenePaste {
  readonly plan: (doc: DocumentView) => ScenePastePlan | null;
  readonly apply: (live: ValidatedDocument) => void;
}

function present(doc: DocumentView, rowId: string): boolean {
  return doc.rows.some(function (r) { return r.id === rowId; });
}

export function pasteScenesCommand(paste: ScenePaste): Command {
  return {
    name: "paste-scenes",
    needs: "edit",
    plan: function (doc): Plan | null {
      const planned = paste.plan(doc);
      if (!planned || !planned.inserted.length) return null;
      const replaced = planned.replaced !== null && present(doc, planned.replaced) ? [planned.replaced] : [];
      return {
        changes: changeSet({
          rowsInserted: planned.inserted,
          rowsRemoved: replaced,
          docFields: planned.title ? SCENE_PASTE_FIELDS.concat(["title"]) : SCENE_PASTE_FIELDS,
          derive: CELL_TEXT_DERIVES,
          saveNow: planned.saveNow
        }),
        apply: function (live) {
          paste.apply(live);
          planned.inserted.forEach(function (id) {
            if (!live.rows.some(function (r) { return r.id === id; })) throw new Error("pasted scene " + id + " is not in the document");
          });
        }
      };
    }
  };
}

export function removeScenesCommand(rowIds: readonly string[]): Command {
  return {
    name: "remove-scenes",
    needs: "edit",
    plan: function (doc): Plan | null {
      const gone = rowIds.filter(function (id, at) { return present(doc, id) && rowIds.indexOf(id) === at; });
      if (!gone.length) return null;
      return {
        changes: changeSet({ rowsRemoved: gone, derive: CELL_TEXT_DERIVES, saveNow: true }),
        apply: function (live) {
          const out = new Set(gone);
          for (let i = live.rows.length - 1; i >= 0; i--) {
            const row = live.rows[i];
            if (row && out.has(row.id)) live.rows.splice(i, 1);
          }
        }
      };
    }
  };
}

export function addHeldCommentsCommand(comments: readonly DocumentComment[]): Command {
  return {
    name: "add-held-comments",
    needs: "edit",
    plan: function (doc): Plan | null {
      const fresh = comments.filter(function (c) {
        return !doc.comments.some(function (had) { return had.id === c.id; });
      });
      if (!fresh.length) return null;
      return {
        changes: changeSet({ docFields: ["comments"], runsMoved: true, saveNow: true }),
        apply: function (live) {
          fresh.forEach(function (c) { live.comments.push(JSON.parse(JSON.stringify(c)) as DocumentComment); });
        }
      };
    }
  };
}
