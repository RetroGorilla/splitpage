import { gallerySize, rowSlots, setRowSlots } from "../../core/document/gallery.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import { clampRange, deleteRange, joinCells, splitCell } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { cellLength, projection } from "../../core/text/runs.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DeepReadonly, DocumentView, Plan, Refusal } from "../session/document-session.ts";
import type { CellTextPorts } from "../session/ports.ts";

export interface JoinPorts extends CellTextPorts {
  readonly plainText: (html: string | null | undefined) => string;
}

export interface TextCut {
  readonly kind: "text";
  readonly from: number;
  readonly to: number;
}

export interface MediaHalves {
  readonly kind: "media-halves";
  readonly first: string;
  readonly second: string;
}

export type SplitAt = TextCut | MediaHalves;

const BOTH_VISUALS = "both scenes have a visual";

const SPLIT_FIELDS: readonly string[] = Object.freeze(["visualText", "audioText"]);
const VISUAL_CELLS: readonly string[] = Object.freeze([
  "visualText", "visualImage", "imageRef", "imageName", "imageLinks", "imageAnnotation", "moreImages"
]);
const RANK: Readonly<Record<string, number>> = Object.freeze({ todo: 0, ready: 1, shot: 2 });
const MEDIA = /<img|video-embed-card/;
const OPEN_END = /(<br\s*\/?>|\s)$/i;
const SPACE_END = /\s$/;

export function textCut(from: number, to: number): TextCut {
  return Object.freeze({ kind: "text", from: from, to: to });
}

export function mediaHalves(first: string, second: string): MediaHalves {
  return Object.freeze({ kind: "media-halves", first: first, second: second });
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
  if (at.kind === "media-halves") return [at.first, at.second];
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
    rowsInserted: [createdId]
  });
}

export function splitSceneCommand(rowId: string, field: string, at: SplitAt, createdId: string, ports: CellTextPorts): Command {
  return {
    name: "split-scene",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (SPLIT_FIELDS.indexOf(field) === -1) return null;
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row) return null;
      const halves = halvesOf(at, textOf(row[field]), ports);
      return {
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

function hasVisual(row: DeepReadonly<DocumentRow>, plainText: JoinPorts["plainText"]): boolean {
  return !!(plainText(row.visualText) || gallerySize(row));
}

export function bothScenesHaveVisual(intoId: string, plainText: JoinPorts["plainText"]): (doc: DocumentView | null) => boolean {
  return function (doc) {
    if (!doc) return false;
    const at = doc.rows.findIndex(function (r) { return r.id === intoId; });
    const prev = doc.rows[at], cur = doc.rows[at + 1];
    return !!prev && !!cur && hasVisual(prev, plainText) && hasVisual(cur, plainText);
  };
}

function joinedAudio(a: string, b: string, ports: CellTextPorts): string {
  if (MEDIA.test(a + b)) return a + ((a && b && !OPEN_END.test(a)) ? " " : "") + b;
  const ca = ports.cells(a), cb = ports.cells(b);
  const glue = cellLength(ca) && cellLength(cb) && !SPACE_END.test(projection(ca)) ? " " : "";
  return toHtml(joinCells(ca, cb, glue));
}

function joinChanges(prevId: string, curId: string, takesVisual: boolean, raisesStatus: boolean): ChangeSet {
  const fields = ["audioText", "updatedAt", "updatedBy"]
    .concat(takesVisual ? VISUAL_CELLS : [])
    .concat(raisesStatus ? ["status"] : []);
  return changeSet({
    cells: fields.map(function (field) { return { rowId: prevId, field: field }; }),
    rowsRemoved: [curId]
  });
}

export function joinScenesCommand(intoId: string, ports: JoinPorts): Command {
  return {
    name: "join-scenes",
    needs: "edit",
    plan: function (doc): Plan | Refusal | null {
      const at = doc.rows.findIndex(function (r) { return r.id === intoId; });
      const prev = doc.rows[at], cur = doc.rows[at + 1];
      if (!prev || !cur) return null;
      const curHasVisual = hasVisual(cur, ports.plainText);
      if (hasVisual(prev, ports.plainText) && curHasVisual) return { refused: BOTH_VISUALS };
      const audio = joinedAudio(textOf(prev.audioText), textOf(cur.audioText), ports);
      const raisesStatus = rankOf(cur.status) > rankOf(prev.status);
      return {
        changes: joinChanges(prev.id, cur.id, curHasVisual, raisesStatus),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === intoId; });
          const next = target ? live.rows[live.rows.indexOf(target) + 1] : undefined;
          if (!target || !next) throw new Error("scenes " + intoId + " changed before they were joined");
          target.audioText = audio;
          if (curHasVisual) {
            target.visualText = next.visualText;
            setRowSlots(target, rowSlots(next));
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
