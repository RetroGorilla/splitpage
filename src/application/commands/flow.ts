import { writeScenes } from "../../core/document/scenes.ts";
import type { DocumentScene } from "../../core/document/scenes.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { FlowDoc, FlowOutcome, FlowRange, FlowRow } from "../../core/flow/flow.ts";
import { sentenceParagraphs } from "../../core/flow/flow.ts";
import type { FlowPorts } from "../../core/flow/flow.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Replay } from "../session/document-session.ts";
import type { CellTextPorts } from "../session/ports.ts";

export function initializeFlowParagraphs(ports: FlowPorts, allowed: () => boolean, settled: (starts: readonly string[]) => void): Replay {
  return {
    name: "initialize-flow-paragraphs",
    plan: doc => {
      if (doc.paragraphsDecided || !allowed()) return null;
      const rows = sentenceParagraphs(doc, ports);
      const starts = rows.filter((row, index) => row.paragraphStart === true && !doc.rows[index]?.paragraphStart).map(row => row.id);
      return {
        changes: changeSet({ cells: starts.map(rowId => ({ rowId, field: "paragraphStart" })), docFields: ["paragraphsDecided"] }),
        apply: live => {
          for (const row of live.rows) if (starts.includes(row.id)) row.paragraphStart = true;
          live.paragraphsDecided = true;
        },
        settle: () => { settled(starts); }
      };
    }
  };
}

export function flowCommand(name: string, operation: (doc: FlowDoc) => FlowOutcome, ports: Pick<CellTextPorts, "clock" | "editor">, before?: FlowRange | null): Command {
  return {
    name,
    needs: "edit",
    plan: function (doc: DocumentView) {
      const result = operation(doc);
      if (!result || "move" in result) return null;
      if ("refused" in result) return result;
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
      const oldOrder = doc.rows.filter(row => now.has(row.id)).map(row => row.id);
      const newOrder = result.rows.filter(row => was.has(row.id)).map(row => row.id);
      const rowsMoved = oldOrder.some((id, index) => id !== newOrder[index]);
      const sectionsChanged = JSON.stringify(doc["sections"] ?? null) !== JSON.stringify(result.sections ?? null);
      const docFields: string[] = [];
      if (sectionsChanged) docFields.push("sections");
      docFields.push("comments");
      const stamped = new Set(cells.filter(cell => cell.field === "audioText" || cell.field === "visualText").map(cell => cell.rowId).concat(inserted));
      for (const rowId of stamped) {
        if (was.has(rowId)) cells.push({ rowId, field: "updatedAt" }, { rowId, field: "updatedBy" });
      }
      if (!cells.length && !inserted.length && !removed.length && !rowsMoved && !sectionsChanged && !result.removedComments.length) return null;
      return {
        ...(before ? { selection: { before, after: result.selection } } : {}),
        changes: changeSet({ cells, rowsInserted: inserted, rowsRemoved: removed, rowsMoved, runsMoved: true, docFields, derive: ["production", "broll"] }),
        apply: function (live: ValidatedDocument) {
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
