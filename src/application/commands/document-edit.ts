import type { DocumentShape } from "../../core/document/validated.ts";
import type { SharedContentRef, SharedOperation } from "../../core/collab/operations.ts";
import { sharedCellTextOperations } from "../../core/collab/cell-text-operations.ts";
import type { SharedCellSplice } from "../../core/collab/cell-text-operations.ts";
import type { ProductionReaders } from "../../core/production/ports.ts";
import type { CellDecoder } from "../../core/text/ports.ts";
import { changeSet, combined } from "../session/change-set.ts";
import type { CellChange, ChangeSet } from "../session/change-set.ts";
import type { Command, CommandRefusal, DocumentView, Plan, SharedPlan } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

export interface CellRewrite {
  readonly rowId: string;
  readonly field: string;
  readonly html: string;
  readonly seen?: string;
  readonly splices?: readonly SharedCellSplice[];
}

export interface SharedRewritePorts {
  readonly author: () => { readonly id: string; readonly by: string } | null;
  readonly beatStamp: (beat: SharedContentRef, author: { readonly id: string; readonly by: string }) => SharedOperation;
  readonly cells: CellDecoder;
  readonly readers: Pick<ProductionReaders, "whoInField" | "tagsInField" | "cueNamesInField" | "brollInField" | "brollPropsInField">;
}

export const REWRITE_CELL_CHANGED = "rewrite-cell-changed";
export const REWRITE_WITHOUT_SPLICES = "rewrite-without-splices";
export const REWRITE_RECORDS_FROM_TEXT = "rewrite-records-from-text";

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

export function planByTrial(name: string, doc: DocumentView, changes: ChangeSet, edit: LiveEdit): Plan | null;
export function planByTrial(name: string, doc: DocumentView, changes: ChangeSet, edit: LiveEdit, share: ((trial: DocumentShape) => SharedPlan | CommandRefusal | null) | undefined): Plan | CommandRefusal | null;
export function planByTrial(name: string, doc: DocumentView, changes: ChangeSet, edit: LiveEdit, share?: (trial: DocumentShape) => SharedPlan | CommandRefusal | null): Plan | CommandRefusal | null {
  const trial = scratch(doc, changes);
  if (!edit(trial)) return null;
  const plan: Plan = {
    changes: changes,
    apply: function (live) {
      if (!edit(live)) throw new Error(name + " found nothing to change in the live document");
    }
  };
  const shared = share ? share(trial) : null;
  return !shared ? plan : "refused" in shared ? shared : { ...plan, shared };
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

function textRecords(readers: SharedRewritePorts["readers"], html: string | undefined): string {
  return JSON.stringify([readers.whoInField(html), readers.tagsInField(html), readers.cueNamesInField(html), readers.brollInField(html), readers.brollPropsInField(html)]);
}

function sharedRewrites(doc: DocumentView, rewrites: readonly CellRewrite[], stamped: boolean, shared: SharedRewritePorts,
  by: { readonly id: string; readonly by: string }): SharedPlan | CommandRefusal {
  const operations: SharedOperation[] = [], beats: string[] = [];
  for (const rewrite of rewrites) {
    const row = doc.rows.find(function (x) { return x.id === rewrite.rowId; });
    const field = rewrite.field, before = row?.[field];
    if (!row || (field !== "audioText" && field !== "visualText") || typeof before !== "string" || !rewrite.splices) return { refused: REWRITE_WITHOUT_SPLICES };
    if (textRecords(shared.readers, before) !== textRecords(shared.readers, rewrite.html)) return { refused: REWRITE_RECORDS_FROM_TEXT };
    const cell = { owner: row.id, field: field as "audioText" | "visualText", before: shared.cells(before), after: shared.cells(rewrite.html) };
    const written = sharedCellTextOperations(cell, rewrite.splices);
    if (!written) return { refused: REWRITE_WITHOUT_SPLICES };
    for (const operation of written) operations.push({ ...operation, id: (by.id + ":" + operations.length) as SharedContentRef, by: by.by });
    if (stamped && written.length && !beats.includes(row.id)) beats.push(row.id);
  }
  beats.forEach(function (beat, index) { operations.push(shared.beatStamp(beat as SharedContentRef, { id: by.id + "_stamp_" + index, by: by.by })); });
  return { operations: operations };
}

function changedUnderneath(doc: DocumentView, planned: readonly CellRewrite[]): boolean {
  return planned.some(function (rewrite) {
    if (rewrite.seen === undefined) return false;
    const row = doc.rows.find(function (x) { return x.id === rewrite.rowId; });
    return !row || row[rewrite.field] !== rewrite.seen;
  });
}

export function rewriteCellsCommand(name: string, planner: RewritePlanner, stamps: StampPorts, options: RewriteOptions, shared?: SharedRewritePorts | null): Command {
  return {
    name: name,
    needs: options.needs,
    plan: function (doc): Plan | CommandRefusal | null {
      const planned = planner(doc);
      if (shared && changedUnderneath(doc, planned)) return { refused: REWRITE_CELL_CHANGED };
      const rewrites = realRewrites(doc, planned);
      if (!rewrites.length) return null;
      const plan: Plan = {
        changes: withFields(rewriteChanges(rewrites, options.stamped), [], true),
        apply: function (live) { applyRewrites(live, rewrites, options.stamped ? stamps : null); }
      };
      const by = shared ? shared.author() : null;
      if (!shared || !by) return plan;
      const written = sharedRewrites(doc, rewrites, options.stamped, shared, by);
      return "refused" in written ? written : { ...plan, shared: written };
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
