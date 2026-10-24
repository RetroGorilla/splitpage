import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { PaintGuard } from "../../application/editing/paint-guard.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { BrollEntry } from "../../core/production/broll.ts";
import type { FieldHtml } from "../../core/production/ports.ts";
import type { Run } from "../../core/text/runs.ts";

export interface BrollHtmlLine {
  readonly nodes: Node[];
  readonly br: Node | null;
}

export interface BrollAnchors {
  readonly inRows: (rows: readonly { readonly id: string; visualText: FieldHtml }[]) => number;
  readonly htmlLines: (body: HTMLElement) => BrollHtmlLine[];
  readonly keyHtml: (id: string, text: string) => string;
}

export interface BrollRecordsPorts {
  readonly document: Pick<DocumentReader, "read"> & { readonly current: () => ValidatedDocument | null };
  readonly edits: Pick<DocumentEdits, "run" | "edit" | "stamps" | "text">;
  readonly cells: Pick<CellEditing<Element>, "edit">;
  readonly paint: Pick<PaintGuard, "whileShown">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "inertBody" | "sanitizeHtml" | "htmlToPlainText" | "productionReaders">;
  readonly scriptCellOf: (html: FieldHtml) => readonly Run[];
  readonly ids: IdSource;
  readonly caretSpot: (cell: Element) => void;
  readonly position: (cell: Node, node: Node, offset: number) => number | null;
  readonly anchors: BrollAnchors;
  readonly refresh: (job: string) => void;
}

export interface BrollRecords {
  readonly brollEntries: () => BrollEntry[];
  readonly addBrollProp: (shotId: string, rawName: string) => boolean;
  readonly brollShotsByProp: () => Record<string, string[]>;
  readonly maybeCaptureBroll: (e: InputEvent, cellEl: Element) => void;
  readonly anchorBrollInLeftCell: (cellEl: Element) => number;
  readonly renameBrollInScript: (entry: BrollEntry, newName: string) => boolean;
  readonly updateBrollBadge: () => void;
  readonly scheduleBrollRefresh: () => void;
}

export interface BrollRecordsMount extends BrollRecords {
  readonly dispose: () => void;
}
