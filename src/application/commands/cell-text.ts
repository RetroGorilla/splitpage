import { toHtml } from "../../core/text/html.ts";
import { commentIds, isMediaRun, normalizeCell } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import type { CellDecoder } from "../../core/text/ports.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command } from "../session/document-session.ts";
import type { CellTextPorts } from "../session/ports.ts";

export interface CellRuns {
  readonly kind: "runs";
  readonly runs: readonly Run[];
}

export type CellText = CellRuns;

export const CELL_TEXT_DERIVES: readonly string[] = Object.freeze(["production", "broll"]);

const ANCHOR = "cmt-anchor";

export function cellRuns(runs: readonly Run[]): CellRuns {
  return Object.freeze({ kind: "runs", runs: runs });
}

function storedForm(text: CellText): string {
  return toHtml(text.runs);
}

function idsInHtml(html: unknown, cells: CellDecoder): readonly string[] {
  if (typeof html !== "string" || html.indexOf(ANCHOR) === -1) return [];
  return commentIds(cells(html));
}

function idsInRuns(runs: readonly Run[]): readonly string[] {
  return runs.some(function (r) { return !!r.marks.cmt; }) ? commentIds(runs) : [];
}


function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(function (id, i) { return id === b[i]; });
}

function withoutComments(runs: readonly Run[]): string {
  return toHtml(normalizeCell(runs.map(function (r) {
    if (!r.marks.cmt) return r;
    const marks = Object.assign({}, r.marks);
    Reflect.deleteProperty(marks, "cmt");
    return Object.assign({}, r, { marks: marks });
  })));
}

function onlyAnchorsDiffer(before: unknown, after: string, text: CellText, cells: CellDecoder): boolean {
  if (typeof before !== "string" || text.runs.some(isMediaRun)) return false;
  const was = cells(before);
  if (was.some(isMediaRun)) return false;
  return toHtml(was) !== after && withoutComments(was) === withoutComments(text.runs);
}

function textChanges(rowId: string, field: string, runsMoved: boolean): ChangeSet {
  return changeSet({
    cells: [
      { rowId: rowId, field: field },
      { rowId: rowId, field: "updatedAt" },
      { rowId: rowId, field: "updatedBy" }
    ],
    runsMoved: runsMoved,
    derive: CELL_TEXT_DERIVES
  });
}

export function cellTextCommand(rowId: string, field: string, text: CellText, ports: CellTextPorts): Command {
  return {
    name: "set-cell-text",
    needs: "nothing",
    plan: function (doc, capability) {
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return null;
      const before = row[field];
      const after = storedForm(text);
      if (before === after) return null;
      const can = capability.edit();
      if (!can.allowed && !onlyAnchorsDiffer(before, after, text, ports.cells)) return { refused: can.reason };
      const moved = !sameIds(idsInHtml(before, ports.cells), idsInRuns(text.runs));
      return {
        changes: textChanges(rowId, field, moved),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === rowId; });
          if (!target) throw new Error("scene " + rowId + " left the document before its text was set");
          target[field] = after;
          target.updatedAt = ports.clock.nowIso();
          target.updatedBy = ports.editor.name();
        }
      };
    }
  };
}
