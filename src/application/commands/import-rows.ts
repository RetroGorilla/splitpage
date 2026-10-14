import type { DocumentRow, ValidatedDocument } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { Command, Plan } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

export type ImportScan = (doc: ValidatedDocument, rows: readonly DocumentRow[]) => string;

export interface ImportRequest {
  readonly rows: readonly DocumentRow[];
  readonly replace: boolean;
  readonly scan: ImportScan;
}

export interface ImportReport {
  readonly count: number;
  readonly found: string;
}

export interface ReportedImport {
  readonly command: Command;
  readonly report: () => ImportReport;
}

function copied(row: DocumentRow): DocumentRow {
  return JSON.parse(JSON.stringify(row)) as DocumentRow;
}

export function importRowsCommand(request: ImportRequest, ports: StampPorts): ReportedImport {
  let found = "";
  const command: Command = {
    name: request.replace ? "import-replace-rows" : "import-append-rows",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (!request.rows.length) return null;
      const removed = request.replace ? doc.rows.map(function (r) { return r.id; }) : [];
      return {
        changes: changeSet({
          rowsInserted: request.rows.map(function (r) { return r.id; }),
          rowsRemoved: removed,
          derive: CELL_TEXT_DERIVES
        }),
        apply: function (live) {
          found = "";
          const at = ports.clock.nowIso();
          const by = ports.editor.name();
          const added = request.rows.map(function (row) {
            const made = copied(row);
            made.updatedAt = at;
            made.updatedBy = by;
            return made;
          });
          if (request.replace) live.rows.splice(0, live.rows.length, ...added);
          else live.rows.push(...added);
          found = request.scan(live, added);
        }
      };
    }
  };
  return {
    command: command,
    report: function () { return { count: request.rows.length, found: found }; }
  };
}
