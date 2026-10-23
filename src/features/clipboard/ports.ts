import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { BrollSeed } from "../../application/commands/clipboard.ts";
import type { CellEditing, CellRange } from "../../application/editing/cell-editing.ts";
import type { PaintGuard } from "../../application/editing/paint-guard.ts";
import type { RowDrag } from "../../application/editing/row-drag.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { SaveState } from "../../application/save/save-state.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DeepReadonly } from "../../application/session/document-session.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { StoredImageRef } from "../../core/document/text-policy.ts";
import type { DocumentRow, ValidatedDocument } from "../../core/document/validated.ts";
import type { Run } from "../../core/text/runs.ts";

export interface CellClipboardPorts {
  readonly document: Pick<DocumentReader, "read">;
  readonly edits: Pick<DocumentEdits, "run" | "text">;
  readonly undo: Pick<UndoControl, "breakCoalescing" | "flush">;
  readonly pictures: Pick<PictureStore, "internDataUrl" | "persist">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "fromHtml" | "inertBody" | "storedHtmlFromDom">;
  readonly imageRefOf: (el: Element) => StoredImageRef | null;
  readonly ids: Pick<IdSource, "id">;
  readonly nonce: () => string;
  readonly selection: (cell: Element) => CellRange | null;
  readonly cells: Pick<CellEditing<Element>, "open" | "close">;
  readonly paintGuard: Pick<PaintGuard, "whileShown">;
  readonly brollSeed: (row: DeepReadonly<DocumentRow>) => BrollSeed;
}

export interface SceneTag {
  readonly cat: { readonly id: string } | null;
  readonly name: string;
}

export interface SceneClipPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly ids: Pick<IdSource, "id">;
  readonly pictures: Pick<PictureStore, "dataUrlFor" | "internDataUrl" | "queuePersist">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf" | "fromHtml" | "inertBody">;
  readonly migrate: (doc: object) => ValidatedDocument;
  readonly tagsInRows: (rows: readonly unknown[]) => readonly SceneTag[];
  readonly recordPastedBroll: (doc: object, rowId: string, cell: readonly Run[], ids: readonly string[]) => void;
}

export interface SceneSelectPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly edits: Pick<DocumentEdits, "run">;
  readonly reviewRefusal: string;
  readonly undo: Pick<UndoControl, "breakCoalescing" | "flush" | "last" | "undo">;
  readonly saves: Pick<SaveState, "dueNow">;
  readonly pictures: Pick<PictureStore, "ensureBytes">;
  readonly review: Pick<ReviewFacts, "reviewing">;
  readonly notices: Pick<NoticePort, "show" | "showAction">;
  readonly cells: Pick<CellEditing<Element>, "sync">;
  readonly rowDrag: Pick<RowDrag, "dragging">;
  readonly scriptCell: (el: Element) => boolean;
  readonly rows: { readonly closeMenus: () => void };
  readonly production: { readonly scheduleRefresh: () => void };
  readonly stampRow: (row: object) => void;
  readonly onServer: () => boolean;
  readonly writerOpen: () => boolean;
  readonly startNewScript: () => boolean;
  readonly nonce: () => string;
}

export interface CopyPasteMount {
  readonly dispose: () => void;
}
