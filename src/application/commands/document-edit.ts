import type { DocumentShape } from "../../core/document/validated.ts";
import { changeSet, combined } from "../session/change-set.ts";
import type { CellChange, ChangeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

export interface CellRewrite {
  readonly rowId: string;
  readonly field: string;
  readonly html: string;
}

export type RewritePlanner = (doc: DocumentView) => readonly CellRewrite[];

export type LiveEdit = (live: DocumentShape) => boolean;

function copied<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function scratch(doc: DocumentView, changes: ChangeSet): DocumentShape {
  const copy: Record<string, unknown> = Object.assign({}, doc);
  changes.docFields.forEach(function (key) { copy[key] = copied(doc[key]); });
  if (changes.cells.length || changes.rowsInserted.length || changes.rowsRemoved.length || changes.rowsMoved) copy["rows"] = copied(doc.rows);
  return copy as DocumentShape;
}

export function planByTrial(name: string, doc: DocumentView, changes: ChangeSet, edit: LiveEdit): Plan | null {
  if (!edit(scratch(doc, changes))) return null;
  return {
    changes: changes,
    apply: function (live) {
      if (!edit(live)) throw new Error(name + " found nothing to change in the live document");
    }
  };
}

export function rewriteChanges(rewrites: readonly CellRewrite[], stamped: boolean, runsMoved = false): ChangeSet {
  const cells: CellChange[] = [];
  rewrites.forEach(function (r) {
    cells.push({ rowId: r.rowId, field: r.field });
    if (stamped) cells.push({ rowId: r.rowId, field: "updatedAt" }, { rowId: r.rowId, field: "updatedBy" });
  });
  return changeSet({ cells: cells, runsMoved: runsMoved, derive: CELL_TEXT_DERIVES });
}

export function withFields(changes: ChangeSet, docFields: readonly string[], saveNow: boolean): ChangeSet {
  return combined(changes, changeSet({ docFields: docFields, saveNow: saveNow }));
}

export function applyRewrites(live: DocumentShape, rewrites: readonly CellRewrite[], stamps: StampPorts | null): boolean {
  let changed = false;
  rewrites.forEach(function (r) {
    const row = live.rows.find(function (x) { return x.id === r.rowId; });
    if (!row) throw new Error("scene " + r.rowId + " left the document before its text was rewritten");
    if (row[r.field] === r.html) return;
    row[r.field] = r.html;
    if (stamps) {
      row.updatedAt = stamps.clock.nowIso();
      row.updatedBy = stamps.editor.name();
    }
    changed = true;
  });
  return changed;
}

export function realRewrites(doc: DocumentView, rewrites: readonly CellRewrite[]): readonly CellRewrite[] {
  return rewrites.filter(function (r) {
    const row = doc.rows.find(function (x) { return x.id === r.rowId; });
    return !!row && row[r.field] !== r.html;
  });
}

export interface RewriteOptions {
  readonly needs: "edit" | "nothing";
  readonly stamped: boolean;
}

export function rewriteCellsCommand(name: string, planner: RewritePlanner, stamps: StampPorts, options: RewriteOptions): Command {
  return {
    name: name,
    needs: options.needs,
    plan: function (doc): Plan | null {
      const rewrites = realRewrites(doc, planner(doc));
      if (!rewrites.length) return null;
      return {
        changes: withFields(rewriteChanges(rewrites, options.stamped), [], true),
        apply: function (live) { applyRewrites(live, rewrites, options.stamped ? stamps : null); }
      };
    }
  };
}

export interface RowCopy {
  readonly id: string;
  [field: string]: unknown;
}

export function rewrittenCopies(fields: readonly string[], rewrite: (rows: RowCopy[]) => void): RewritePlanner {
  return function (doc) {
    const rows: RowCopy[] = doc.rows.map(function (row) {
      const copy: RowCopy = { id: row.id };
      fields.forEach(function (field) { copy[field] = row[field]; });
      return copy;
    });
    rewrite(rows);
    const out: CellRewrite[] = [];
    rows.forEach(function (copy, at) {
      const row = doc.rows[at];
      fields.forEach(function (field) {
        const html = copy[field];
        if (row && typeof html === "string" && html !== row[field]) out.push({ rowId: copy.id, field: field, html: html });
      });
    });
    return out;
  };
}
