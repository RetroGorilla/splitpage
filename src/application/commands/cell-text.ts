import { toHtml } from "../../core/text/html.ts";
import { commentIds } from "../../core/text/runs.ts";
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

export interface SanitisedMediaHtml {
  readonly kind: "media-html";
  readonly html: string;
}

export type CellText = CellRuns | SanitisedMediaHtml;

export const CELL_TEXT_DERIVES: readonly string[] = Object.freeze(["production", "broll"]);

const ANCHOR = "cmt-anchor";

export function cellRuns(runs: readonly Run[]): CellRuns {
  return Object.freeze({ kind: "runs", runs: runs });
}

export function sanitisedMediaHtml(html: string): SanitisedMediaHtml {
  return Object.freeze({ kind: "media-html", html: html });
}

function storedForm(text: CellText): string {
  return text.kind === "runs" ? toHtml(text.runs) : text.html;
}

function idsInHtml(html: unknown, cells: CellDecoder): readonly string[] {
  if (typeof html !== "string" || html.indexOf(ANCHOR) === -1) return [];
  return commentIds(cells(html));
}

function idsInRuns(runs: readonly Run[]): readonly string[] {
  return runs.some(function (r) { return !!r.marks.cmt; }) ? commentIds(runs) : [];
}

function idsIn(text: CellText, stored: string, cells: CellDecoder): readonly string[] {
  return text.kind === "runs" ? idsInRuns(text.runs) : idsInHtml(stored, cells);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(function (id, i) { return id === b[i]; });
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
    plan: function (doc) {
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return null;
      const before = row[field];
      const after = storedForm(text);
      if (before === after) return null;
      const moved = !sameIds(idsInHtml(before, ports.cells), idsIn(text, after, ports.cells));
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
