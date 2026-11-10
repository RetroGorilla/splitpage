import { rowIndexOf } from "../../core/document/rows.ts";
import { toHtml } from "../../core/text/html.ts";
import type { Run } from "../../core/text/runs.ts";
import { cellRuns, cellTextCommand } from "../commands/cell-text.ts";
import type { CellRecords } from "../commands/cell-text.ts";
import { galleryCommand } from "../commands/gallery.ts";
import type { GalleryEdit } from "../commands/gallery.ts";
import { moveBeatCommand } from "../commands/rows.ts";
import type { Command, CommandOutcome, DocumentView } from "../session/document-session.ts";
import type { CellTextPorts } from "../session/ports.ts";

export interface CellRange {
  readonly from: number;
  readonly to: number;
}

export interface CellAddress {
  readonly rowId: string | null;
  readonly field: string | null;
}

export interface CellPage<E, Html = never> {
  readonly address: (cell: E) => CellAddress;
  readonly attached: (cell: E) => boolean;
  readonly html: (cell: E) => string;
  readonly selection: (cell: E) => CellRange | null;
  readonly write: (cell: E, html: string | Html) => void;
  readonly focus: (cell: E, sel: CellRange | null | undefined) => void;
}

export interface CellDecoders {
  readonly text: (html: string) => Run[];
  readonly withMedia: (html: string) => Run[];
}

export interface CellUndoPorts {
  readonly applying: () => boolean;
  readonly breakCoalescing: () => void;
  readonly flush: () => void;
  readonly latest: () => unknown;
}

export type ShownRow = DocumentView["rows"][number];

export interface CellEditingPorts<E, Html = never> {
  readonly syncOverride?: (cell: E, runs: readonly Run[]) => boolean;
  readonly page: CellPage<E, Html>;
  readonly document: () => DocumentView | null;
  readonly run: (command: Command) => CommandOutcome;
  readonly text: CellTextPorts;
  readonly decode: CellDecoders;
  readonly undo: CellUndoPorts;
  readonly stale: () => boolean;
  readonly painted: (cell: E, field: string, row: ShownRow) => void;
  readonly shown: <T>(edit: () => T) => T;
  readonly announce: (message: string, before: unknown) => void;
}

export interface OpenCell {
  readonly rowId: string;
  readonly field: string;
  readonly html: string;
  readonly sel: CellRange | null;
}

export interface CellEditResult {
  readonly cell: readonly Run[];
  readonly sel?: CellRange | null | undefined;
  readonly records?: CellRecords | undefined;
}

export type CellEdit = (cell: Run[], sel: CellRange | null) => CellEditResult | null | undefined;

export interface CellEditing<E, Html = never> {
  readonly open: (cell: E, separate?: boolean) => OpenCell | null;
  readonly close: (cell: E, html: string | Html, sel: CellRange | null | undefined) => E;
  readonly edit: (cell: E, change: CellEdit) => E | null;
  readonly sync: (cell: E) => void;
  readonly editGallery: (rowId: string, message: string, edit: GalleryEdit) => boolean;
  readonly moveRow: (rowId: string, targetId: string, after: boolean) => void;
}

function holdsMedia(html: string): boolean {
  return html.indexOf("<img") !== -1 || html.indexOf("video-embed-card") !== -1;
}

function isTextField(field: string | null): field is "visualText" | "audioText" {
  return field === "visualText" || field === "audioText";
}

function took(outcome: CommandOutcome): boolean {
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed";
}

export function createCellEditing<E, Html = never>(ports: CellEditingPorts<E, Html>): CellEditing<E, Html> {
  const page = ports.page;

  function sync(cell: E): void {
    ports.shown(function () { syncShown(cell); });
  }

  function syncShown(cell: E): void {
    if (!page.attached(cell) || ports.undo.applying() || ports.stale()) return;
    const at = page.address(cell);
    const idx = rowIndexOf(ports.document(), at.rowId);
    if (idx === -1) return;
    const rowId = at.rowId as string;
    const field = at.field as string;
    const runs = cellRuns(ports.decode.withMedia(page.html(cell)));
    if (ports.syncOverride?.(cell, runs)) return;
    took(ports.run(cellTextCommand(rowId, field, runs, ports.text)));
    const doc = ports.document();
    if (doc) ports.painted(cell, field, doc.rows[idx] as ShownRow);
  }

  function open(cell: E, separate = true): OpenCell | null {
    if (ports.stale()) return null;
    const at = page.address(cell);
    const idx = rowIndexOf(ports.document(), at.rowId);
    if (idx === -1 || !isTextField(at.field)) return null;
    sync(cell);
    const doc = ports.document();
    const row = doc ? doc.rows[idx] : undefined;
    const html = row ? row[at.field] || "" : "";
    if (holdsMedia(html)) return null;
    const sel = page.selection(cell);
    if (separate) ports.undo.breakCoalescing();
    return { rowId: at.rowId as string, field: at.field, html: html, sel: sel };
  }

  function close(cell: E, html: string | Html, sel: CellRange | null | undefined): E {
    page.write(cell, html);
    sync(cell);
    page.focus(cell, sel);
    ports.undo.flush();
    ports.undo.breakCoalescing();
    return cell;
  }

  function edit(cell: E, change: CellEdit): E | null {
    return ports.shown(function () { return editShown(cell, change); });
  }

  function editShown(cell: E, change: CellEdit): E | null {
    const opened = open(cell, false);
    if (!opened) return null;
    const out = change(ports.decode.text(opened.html), opened.sel);
    if (!out || !out.cell) return null;
    ports.undo.breakCoalescing();
    const next = toHtml(out.cell);
    if (next !== opened.html) {
      const outcome = ports.run(cellTextCommand(opened.rowId, opened.field, cellRuns(out.cell), ports.text, out.records));
      if (outcome.kind === "failed") throw outcome.error;
      if (outcome.kind === "rejected") return null;
    }
    return close(cell, next, out.sel);
  }

  function editGallery(rowId: string, message: string, change: GalleryEdit): boolean {
    if (rowIndexOf(ports.document(), rowId) === -1) return false;
    const before = ports.undo.latest();
    ports.undo.breakCoalescing();
    if (!took(ports.run(galleryCommand(rowId, change, ports.text)))) return false;
    ports.announce(message, before);
    return true;
  }

  function moveRow(rowId: string, targetId: string, after: boolean): void {
    took(ports.run(moveBeatCommand(rowId, targetId, !!after)));
  }

  return { open, close, edit, sync, editGallery, moveRow };
}
