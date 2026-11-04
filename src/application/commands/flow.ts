import { writeScenes } from "../../core/document/scenes.ts";
import type { DocumentScene } from "../../core/document/scenes.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { FlowEdit, FlowRow } from "../../core/flow/flow.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, DocumentView } from "../session/document-session.ts";
import type { CellTextPorts } from "../session/ports.ts";

export function flowCommand(name: string, result: FlowEdit, ports: Pick<CellTextPorts, "clock" | "editor">): Command {
  return {
    name,
    needs: "edit",
    plan: function (doc: DocumentView) {
      const was = new Map(doc.rows.map(row => [row.id, row as unknown as FlowRow]));
      const now = new Map(result.rows.map(row => [row.id, row]));
      const cells: { rowId: string; field: string }[] = [];
      result.rows.forEach(function (row) {
        const old = was.get(row.id);
        if (!old) return;
        new Set(Object.keys(old).concat(Object.keys(row))).forEach(function (field) {
          if (JSON.stringify(old[field]) !== JSON.stringify(row[field])) cells.push({ rowId: row.id, field });
        });
      });
      const inserted = result.rows.filter(row => !was.has(row.id)).map(row => row.id);
      const removed = doc.rows.filter(row => !now.has(row.id)).map(row => row.id);
      const sectionsChanged = JSON.stringify(doc["sections"] ?? null) !== JSON.stringify(result.sections ?? null);
      const docFields: string[] = [];
      if (sectionsChanged) docFields.push("sections");
      if (result.removedComments.length) docFields.push("comments");
      return {
        changes: changeSet({ cells, rowsInserted: inserted, rowsRemoved: removed, rowsMoved: false, runsMoved: true, docFields, derive: [] }),
        apply: function (live: ValidatedDocument) {
          const stamped = new Set(cells.filter(cell => cell.field === "audioText" || cell.field === "visualText").map(cell => cell.rowId).concat(inserted));
          const nowIso = ports.clock.nowIso();
          const editor = ports.editor.name();
          const next = result.rows.map(function (row) {
            const copy = JSON.parse(JSON.stringify(row)) as ValidatedDocument["rows"][number];
            if (stamped.has(row.id)) { copy["updatedAt"] = nowIso; copy["updatedBy"] = editor; }
            return copy;
          });
          live.rows.splice(0, live.rows.length, ...next);
          if (sectionsChanged) writeScenes(live as unknown as Record<string, unknown>, result.sections as readonly DocumentScene[] | undefined);
          if (result.removedComments.length) {
            const gone = new Set(result.removedComments);
            live.comments = live.comments.filter(comment => !gone.has(comment.id));
          }
        }
      };
    }
  };
}
