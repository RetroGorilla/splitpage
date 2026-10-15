import { newBrollShot } from "../../core/document/broll.ts";
import { addGalleryPicture, addGalleryVideo } from "../../core/document/gallery.ts";
import type { GalleryRow } from "../../core/document/gallery.ts";
import type { IdSource, ImageRef } from "../../core/document/ports.ts";
import type { DocumentRow } from "../../core/document/validated.ts";
import { brollInCell } from "../../core/production/broll.ts";
import type { CellDecoder } from "../../core/text/ports.ts";
import { flattenCues } from "../../core/text/cues.ts";
import { flattenDirections } from "../../core/text/directions.ts";
import { clamp, clampRange, deleteRange, insertCell, insertText } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { cellLength } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DeepReadonly, DocumentView } from "../session/document-session.ts";
import type { CellTextPorts } from "../session/ports.ts";
import { CELL_TEXT_DERIVES } from "./cell-text.ts";

export interface TextRange {
  readonly from: number;
  readonly to: number;
}

export interface ImageAttachment {
  readonly kind: "image";
  readonly ref: ImageRef;
  readonly name?: string | undefined;
}

export interface VideoLinkAttachment {
  readonly kind: "video";
  readonly href: string;
}

export interface VideoFileAttachment {
  readonly kind: "videoFile";
  readonly name: string;
  readonly size: number;
  readonly duration?: number | undefined;
  readonly poster?: ImageRef | null | undefined;
}

export type Attachment = ImageAttachment | VideoLinkAttachment | VideoFileAttachment;

export interface AttachedCount {
  pictures: number;
  videos: number;
  links: string[];
}

export type Pasted =
  | { readonly kind: "cell"; readonly runs: readonly Run[] }
  | { readonly kind: "text"; readonly text: string };

export interface PasteRequest {
  readonly rowId: string;
  readonly field: string;
  readonly range: TextRange | null;
  readonly pasted: Pasted | null;
  readonly fromCut: boolean;
  readonly comments: readonly string[];
  readonly attach: readonly Attachment[];
}

export interface BrollSeed {
  readonly audioRef: string;
  readonly location: string;
}

export interface ClipboardPorts extends CellTextPorts {
  readonly ids: Pick<IdSource, "id">;
  readonly brollSeed: (row: DeepReadonly<DocumentRow>) => BrollSeed;
}

export interface EditReport {
  readonly attached: AttachedCount | null;
  readonly caret: number | null;
}

export interface ReportedCommand {
  readonly command: Command;
  readonly report: () => EditReport;
}

export const GALLERY_FIELDS: readonly string[] = Object.freeze([
  "imageRef", "imageName", "imageLinks", "imageAnnotation", "moreImages", "visualImage"
]);

interface ScopeRow {
  readonly id?: unknown;
  readonly visualText?: unknown;
  readonly audioText?: unknown;
}

export interface BrollScope {
  readonly rows?: readonly (ScopeRow | null | undefined)[] | null | undefined;
  readonly brollShots?: readonly ({ readonly id?: unknown } | null | undefined)[] | null | undefined;
}

export function attachToGallery(row: GalleryRow, attach: readonly Attachment[]): AttachedCount {
  const out: AttachedCount = { pictures: 0, videos: 0, links: [] };
  attach.forEach(function (item) {
    if (item.kind === "image") {
      addGalleryPicture(row, item.ref, item.name);
      out.pictures++;
      return;
    }
    const link = item.kind === "video" ? { href: item.href } : { name: item.name, size: item.size, duration: item.duration };
    if (addGalleryVideo(row, link, item.kind === "videoFile" ? item.poster || null : null) !== -1) {
      out.videos++;
      if (item.kind === "video") out.links.push(item.href);
    }
  });
  return out;
}

export function takenBrollIds(
  scope: BrollScope,
  rowId: string,
  field: string,
  rest: readonly Run[] | null,
  fromCut: boolean,
  cells: CellDecoder
): Record<string, true> {
  const taken: Record<string, true> = Object.create(null) as Record<string, true>;
  function keysOf(cell: readonly Run[]): void {
    cell.forEach(function (r) { if (r.atom === "broll" && r.id) taken[r.id] = true; });
  }
  (scope.rows || []).forEach(function (row) {
    if (!row) return;
    (["visualText", "audioText"] as const).forEach(function (f) {
      if (row.id === rowId && f === field && rest) keysOf(rest);
      else keysOf(cells(typeof row[f] === "string" ? row[f] as string : ""));
    });
  });
  if (!fromCut) {
    (scope.brollShots || []).forEach(function (rec) {
      if (rec && typeof rec.id === "string" && rec.id) taken[rec.id] = true;
    });
  }
  return taken;
}

export function freshBrollIds(
  cell: readonly Run[],
  taken: Readonly<Record<string, true>>,
  mint: () => string
): { cell: Run[]; minted: string[] } {
  const used: Record<string, true> = Object.create(null) as Record<string, true>;
  const minted: string[] = [];
  const out = cell.map(function (r): Run {
    if (r.atom !== "broll") return r;
    let id = r.id;
    if (!id || taken[id] || used[id]) {
      let guard = 0;
      do { id = mint(); } while ((taken[id] || used[id]) && ++guard < 100);
      minted.push(id);
    }
    used[id] = true;
    return id === r.id ? r : Object.assign({}, r, { id: id });
  });
  return { cell: out, minted: minted };
}

function brollKeyIds(cell: readonly Run[]): string[] {
  const ids: string[] = [];
  cell.forEach(function (r) { if (r.atom === "broll" && r.id) ids.push(r.id); });
  return ids;
}

function textOf(row: DeepReadonly<DocumentRow>, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : "";
}

function galleryProbe(row: DeepReadonly<DocumentRow>): GalleryRow {
  const probe: GalleryRow = {};
  GALLERY_FIELDS.forEach(function (key) {
    if (key in row) probe[key] = JSON.parse(JSON.stringify(row[key] ?? null)) as unknown;
  });
  return probe;
}

function textCells(rowId: string, field: string, withGallery: boolean): ChangeSet["cells"] {
  const cells = [{ rowId: rowId, field: field }];
  if (withGallery) GALLERY_FIELDS.forEach(function (key) { cells.push({ rowId: rowId, field: key }); });
  cells.push({ rowId: rowId, field: "updatedAt" }, { rowId: rowId, field: "updatedBy" });
  return cells;
}

interface ShotToRecord {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
}

function pastedShots(next: readonly Run[], ids: readonly string[], known: DocumentView["brollShots"]): ShotToRecord[] {
  if (!ids.length) return [];
  const have: Record<string, true> = Object.create(null) as Record<string, true>;
  known.forEach(function (shot) { if (shot.id) have[shot.id] = true; });
  const out: ShotToRecord[] = [];
  brollInCell(next).forEach(function (found) {
    if (!found.id || ids.indexOf(found.id) === -1 || have[found.id]) return;
    have[found.id] = true;
    out.push({ id: found.id, name: found.name, desc: found.desc });
  });
  return out;
}

export function pasteCommand(request: PasteRequest, ports: ClipboardPorts): ReportedCommand {
  let attached: AttachedCount | null = null;
  let caret: number | null = null;
  const command: Command = {
    name: "paste-into-cell",
    needs: "edit",
    plan: function (doc) {
      const row = doc.rows.find(function (r) { return r.id === request.rowId; });
      if (!row) return null;
      const field = request.field;
      const before = textOf(row, field);
      let after = before;
      let shots: ShotToRecord[] = [];
      if (request.pasted) {
        const cell = ports.cells(before);
        const range = request.range ? clampRange(cell, request.range.from, request.range.to) : { from: cellLength(cell), to: cellLength(cell) };
        const rest = deleteRange(cell, range.from, range.to);
        const from = clamp(rest, range.from);
        let next: Run[];
        let ids: string[] = [];
        if (request.pasted.kind === "text") {
          next = insertText(rest, from, request.pasted.text);
        } else {
          let piece = request.pasted.runs;
          if (piece.some(function (r) { return !!r.atom; })) {
            const taken = takenBrollIds(doc, request.rowId, field, rest, request.fromCut, ports.cells);
            piece = freshBrollIds(piece, taken, function () { return ports.ids.id("bs"); }).cell;
          }
          if (field === "visualText") piece = flattenCues(flattenDirections(piece));
          next = insertCell(rest, from, piece).cell;
          ids = brollKeyIds(piece);
        }
        caret = from + cellLength(next) - cellLength(rest);
        if (field === "visualText") shots = pastedShots(next, ids, doc.brollShots);
        after = toHtml(next);
      }
      const textChanged = after !== before;
      let counts: AttachedCount | null = null;
      if (request.attach.length) {
        const probe = attachToGallery(galleryProbe(row), request.attach);
        if (probe.pictures || probe.videos) counts = probe;
      }
      if (!textChanged && !counts && !shots.length) return null;
      const seed = shots.length ? ports.brollSeed(row) : null;
      return {
        changes: changeSet({
          cells: textCells(request.rowId, field, counts !== null).filter(function (c) {
            return textChanged || c.field !== field;
          }),
          docFields: shots.length ? ["brollShots"] : [],
          runsMoved: request.fromCut && request.comments.length > 0,
          derive: CELL_TEXT_DERIVES
        }),
        apply: function (live) {
          const found = live.rows.find(function (r) { return r.id === request.rowId; });
          if (!found) throw new Error("scene " + request.rowId + " left the document before the paste");
          const target: DocumentRow = found;
          let stamped = false;
          function stamp(): void {
            if (stamped) return;
            stamped = true;
            target.updatedAt = ports.clock.nowIso();
            target.updatedBy = ports.editor.name();
          }
          if (shots.length && seed) {
            const have: Record<string, true> = Object.create(null) as Record<string, true>;
            live.brollShots.forEach(function (shot) { have[shot.id] = true; });
            shots.forEach(function (shot) {
              if (have[shot.id]) return;
              live.brollShots.push(newBrollShot(shot.id, { name: shot.name, desc: shot.desc, audioRef: seed.audioRef, location: seed.location }));
            });
          }
          if (textChanged) {
            target[field] = after;
            stamp();
          }
          if (counts) {
            const done = attachToGallery(target, request.attach);
            stamp();
            attached = done;
          }
        }
      };
    }
  };
  return { command: command, report: function () { return { attached: attached, caret: caret }; } };
}

export function cutCommand(rowId: string, field: string, range: TextRange, ports: CellTextPorts): ReportedCommand {
  let caret: number | null = null;
  const command: Command = {
    name: "cut-from-cell",
    needs: "edit",
    plan: function (doc) {
      const row = doc.rows.find(function (r) { return r.id === rowId; });
      if (!row || range.from === range.to) return null;
      const before = textOf(row, field);
      const cell = ports.cells(before);
      const span = clampRange(cell, range.from, range.to);
      caret = span.from;
      const after = toHtml(deleteRange(cell, span.from, span.to));
      if (after === before) return null;
      return {
        changes: changeSet({ cells: textCells(rowId, field, false), derive: CELL_TEXT_DERIVES }),
        apply: function (live) {
          const target = live.rows.find(function (r) { return r.id === rowId; });
          if (!target) throw new Error("scene " + rowId + " left the document before the cut");
          target[field] = after;
          target.updatedAt = ports.clock.nowIso();
          target.updatedBy = ports.editor.name();
        }
      };
    }
  };
  return { command: command, report: function () { return { attached: null, caret: caret }; } };
}
