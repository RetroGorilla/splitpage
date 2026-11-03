import type { CellEditing, CellRange } from "../../application/editing/cell-editing.ts";
import type { DeleteConfirm } from "../../application/editing/delete-confirm.ts";
import type { PaintGuard } from "../../application/editing/paint-guard.ts";
import type { RowDrag } from "../../application/editing/row-drag.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { Operations } from "../../application/session/operation.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { IdSource } from "../../core/document/ports.ts";

export interface ReadTimePorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly text: Pick<TextServices, "productionReaders">;
  readonly edits: Pick<DocumentEdits, "run" | "stamps">;
  readonly undo: Pick<UndoControl, "undo" | "redo">;
  readonly paint: Pick<PaintGuard, "afterThisPaint">;
  readonly notices: Pick<NoticePort, "show">;
}

interface CellSelectionPort {
  readonly of: (cell: Element) => CellRange | null;
  readonly set: (cell: Element, from: number, to?: number) => void;
}

export interface BeatPorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly edits: Pick<DocumentEdits, "run" | "stamps" | "text">;
  readonly notices: Pick<NoticePort, "show">;
  readonly ids: Pick<IdSource, "id">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf">;
  readonly cells: Pick<CellEditing<Element>, "sync">;
  readonly undo: Pick<UndoControl, "breakCoalescing">;
  readonly selection: Pick<CellSelectionPort, "of">;
  readonly placeCaret: (cell: Element, offset: number) => void;
  readonly rowDrag: Pick<RowDrag, "dragging">;
  readonly deletes: Pick<DeleteConfirm, "armedId" | "arm" | "disarm">;
}

interface SplitBeat {
  readonly id: string;
  readonly field: string;
}

export interface Beats {
  readonly addRow: (afterId: string | null | undefined) => string | null;
  readonly addRowAndFocus: (afterId: string | null | undefined, field: string | null) => void;
  readonly splitField: (cell: Element) => SplitBeat | null;
  readonly splitCellField: (cell: Element) => void;
  readonly focusField: (rowId: string | null, field: string | null, offset?: number) => void;
  readonly swapAdjacent: (rowId: string | null, dir: number) => boolean;
  readonly moveRow: (rowId: string, dir: number) => void;
  readonly armDelete: (btn: Element, rowId: string) => void;
  readonly clearDropMarkers: () => void;
  readonly setDropMarkerForRow: (row: Element, clientY: number) => void;
  readonly updateDragScroll: (clientX: number, clientY: number) => void;
  readonly stopDragScroll: () => void;
  readonly dispose: () => void;
}

export interface BeatMediaPorts {
  readonly document: Pick<DocumentReader, "read">;
  readonly notices: Pick<NoticePort, "show">;
  readonly ownership: Operations;
  readonly pictures: Pick<PictureStore, "internDataUrl" | "persist">;
  readonly cells: Pick<CellEditing<Element>, "editGallery">;
  readonly text: Pick<TextServices<HTMLElement>, "storedHtmlFromDom">;
  readonly selection: CellSelectionPort;
}

export interface PastePlace {
  readonly html: unknown;
  readonly sel: CellRange | null;
}

export interface BeatMedia {
  readonly capturePastePlace: (cell: Element) => PastePlace;
  readonly restorePastePlace: (cell: Element, place: PastePlace) => void;
  readonly showPictureNotAdded: () => void;
  readonly addPicture: (rowId: string, file: File, slot?: number) => void;
  readonly removePicture: (rowId: string, slot?: number) => void;
  readonly removeLink: (rowId: string, slot: number, key: string) => void;
  readonly dispose: () => void;
}
