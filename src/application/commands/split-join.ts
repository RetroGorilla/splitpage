import { joinWithPrevious } from "../../core/flow/flow.ts";
import { gallerySize, rowSlots, setRowSlots } from "../../core/document/gallery.ts";
import { sceneBeforeBeat } from "../../core/document/scenes.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import { clampRange, deleteRange, splitCell } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan, CommandRefusal } from "../session/document-session.ts";
import type { CellTextPorts } from "../session/ports.ts";
import type { FlowPorts } from "../../core/flow/flow.ts";
import { sharedCreatedBeat, sharedStructureList, sharedStructureTrace } from "./shared-structure.ts";
import type { SharedStructurePorts } from "./shared-structure.ts";

export interface JoinPorts extends CellTextPorts {
  readonly plainText: (html: string | null | undefined) => string;
}

export interface TextCut {
  readonly kind: "text";
  readonly from: number;
  readonly to: number;
}

export type SplitAt = TextCut;

const SPLIT_FIELDS: readonly string[] = Object.freeze(["visualText", "audioText"]);
const VISUAL_CELLS: readonly string[] = Object.freeze([
  "visualText", "visualImage", "imageRef", "imageName", "imageLinks", "imageAnnotation", "moreImages"
]);
const RANK: Readonly<Record<string, number>> = Object.freeze({ todo: 0, ready: 1, shot: 2 });

export function textCut(from: number, to: number): TextCut {
  return Object.freeze({ kind: "text", from: from, to: to });
}

function rankOf(status: unknown): number {
  return typeof status === "string" && Object.prototype.hasOwnProperty.call(RANK, status) ? RANK[status] as number : 0;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function cellHtml(rowId: string, field: string): (doc: DocumentView | null) => string | null {
  return function (doc) {
    const row = doc ? doc.rows.find(function (r) { return r.id === rowId; }) : undefined;
    return row ? textOf(row[field]) : null;
  };
}

function halvesOf(at: SplitAt, html: string, ports: CellTextPorts): readonly [string, string] {
  const cell = ports.cells(html);
  const cut = clampRange(cell, at.from, at.to);
  const halves = splitCell(deleteRange(cell, cut.from, cut.to), cut.from);
  return [toHtml(halves[0]), toHtml(halves[1])];
}

function splitChanges(rowId: string, field: string, createdId: string): ChangeSet {
  return changeSet({
    cells: [
      { rowId: rowId, field: field },
      { rowId: rowId, field: "updatedAt" },
      { rowId: rowId, field: "updatedBy" }
    ],
    rowsInserted: [createdId],
    derive: CELL_TEXT_DERIVES
  });
}

function sharedSplit(doc: DocumentView, row: DocumentRow, at: SplitAt, createdId: string, ports: CellTextPorts, shared: SharedStructurePorts | undefined): Pick<Plan, "shared"> {
  const by = shared?.author();
  if (!shared || !by) return {};
  const trace = sharedStructureTrace(doc, shared, by), cell = shared.cells(row.audioText), cut = clampRange(cell, at.from, at.to);
  trace.delete(row.id, cell, cut.from, cut.to);
  trace.split(row.id, cut.from, { id: createdId, ...sharedCreatedBeat(ports) });
  return { shared: sharedStructureList(trace, shared, by, [row.id]) };
}

export function splitBeatCommand(rowId: string, field: string, at: SplitAt, createdId: string, ports: CellTextPorts, shared?: SharedStructurePorts): Command {
  return {
    name: "split-scene",
    needs: "edit",
    plan: function (doc): Plan | CommandRefusal | null {
      if (SPLIT_FIELDS.indexOf(field) === -1) return null;
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return null;
      if (shared && field !== "audioText") return { refused: "visual-split-in-shared-session" };
      const halves = halvesOf(at, textOf(row[field]), ports);
      return {
        ...sharedSplit(doc, row, at, createdId, ports, shared),
        changes: splitChanges(rowId, field, createdId),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === rowId; });
          if (!target) throw new Error("scene " + rowId + " left the document before it was split");
          target[field] = halves[0];
          target.updatedAt = ports.clock.nowIso();
          target.updatedBy = ports.editor.name();
          const created: DocumentRow = {
            id: createdId, visualText: "", imageRef: null, audioText: "",
            status: "todo", updatedAt: ports.clock.nowIso(), updatedBy: ports.editor.name()
          };
          created[field] = halves[1];
          live.rows.splice(live.rows.indexOf(target) + 1, 0, created);
        }
      };
    }
  };
}

function hasVisual(row: unknown, plainText: JoinPorts["plainText"]): boolean {
  const visual = row as { readonly visualText?: string | null };
  return !!(plainText(visual.visualText) || gallerySize(row));
}

function joinChanges(prevId: string, curId: string, takesVisual: boolean, raisesStatus: boolean): ChangeSet {
  const fields = ["audioText", "updatedAt", "updatedBy"]
    .concat(takesVisual ? VISUAL_CELLS : [])
    .concat(raisesStatus ? ["status"] : []);
  return changeSet({
    cells: fields.map(function (field) { return { rowId: prevId, field: field }; }),
    rowsRemoved: [curId],
    derive: CELL_TEXT_DERIVES
  });
}

function sharedJoin(doc: DocumentView, prevId: string, curId: string, flow: Omit<FlowPorts, "operations">, shared: SharedStructurePorts | undefined): Pick<Plan, "shared"> {
  const by = shared?.author();
  if (!shared || !by) return {};
  const trace = sharedStructureTrace(doc, shared, by);
  joinWithPrevious(doc, curId, { ...flow, trace });
  return { shared: sharedStructureList(trace, shared, by, [prevId]) };
}

export function joinBeatsCommand(intoId: string, ports: JoinPorts, shared?: SharedStructurePorts): Command {
  return {
    name: "join-scenes",
    needs: "edit",
    plan: function (doc): Plan | CommandRefusal | null {
      const at = doc.rows.findIndex(function (r) { return r.id === intoId; });
      const prev = doc.rows[at], cur = doc.rows[at + 1];
      if (!prev || !cur) return null;
      if (sceneBeforeBeat(doc, cur.id)) return { refused: "remove the scene header before joining these beats" };
      const curHasVisual = hasVisual(cur, ports.plainText);
      const flow = { cells: (html: string | null | undefined) => ports.cells(html ?? ""), newId: () => "", hasVisual: (row: unknown) => hasVisual(row, ports.plainText) };
      const result = joinWithPrevious(doc, cur.id, flow);
      if (!result || !("rows" in result)) return result && "refused" in result ? result : null;
      const joined = result.rows[at];
      if (!joined) return null;
      const raisesStatus = rankOf(cur.status) > rankOf(prev.status);
      return {
        ...sharedJoin(doc, prev.id, cur.id, flow, shared),
        changes: joinChanges(prev.id, cur.id, curHasVisual, raisesStatus),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === intoId; });
          const next = target ? live.rows[live.rows.indexOf(target) + 1] : undefined;
          if (!target || !next) throw new Error("scenes " + intoId + " changed before they were joined");
          target.audioText = joined.audioText;
          if (curHasVisual) {
            target.visualText = joined.visualText;
            setRowSlots(target, rowSlots(joined));
          }
          if (raisesStatus) target.status = next.status;
          target.updatedAt = ports.clock.nowIso();
          target.updatedBy = ports.editor.name();
          live.rows.splice(live.rows.indexOf(next), 1);
        }
      };
    }
  };
}
