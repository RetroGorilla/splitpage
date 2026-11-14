import type { BufferedFieldBinding, BufferedFieldPorts, BufferedFieldSurface } from "../../application/editing/buffered-field.ts";
import type { CellDecoders, CellEditingPorts, CellPage, ShownRow } from "../../application/editing/cell-editing.ts";
import type { PaintGuard } from "../../application/editing/paint-guard.ts";
import type { PaintedBeats } from "../../application/editing/painted-beats.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { SelectionModel } from "../../application/editing/selection.ts";
import type { PaintedText } from "../../application/editing/ports.ts";

export interface CellReachPorts {
  readonly window: Window;
}

export interface DraftEditPorts {
  readonly text: Pick<TextServices<HTMLElement>, "fromHtml" | "inertBody" | "cleanPastedCell" | "sanitizeHtml" | "storedHtmlFromDom">;
}

export interface CellBufferPorts {
  readonly field: (surface: BufferedFieldSurface<HTMLElement>) => BufferedFieldBinding;
  readonly painted: Pick<PaintedBeats, "record" | "base" | "text" | "field" | "clear">;
  readonly report: BufferedFieldPorts["report"];
  readonly page: Pick<CellPage<Element, unknown>, "html" | "write" | "focus" | "selection">;
  readonly decode: CellDecoders["withMedia"];
  readonly document: () => DocumentView | null;
  readonly paintedFrom: (cell: Element, field: string, row: ShownRow) => boolean;
  readonly notePainted: CellEditingPorts<Element, unknown>["painted"];
  readonly shown: PaintGuard["whileShown"];
  readonly repaintRows: () => void;
  readonly onPainted: (listener: () => void) => () => void;
  readonly beforePaint: (check: () => void) => () => void;
  readonly readable: (key: string) => boolean;
  readonly caret?: {
    readonly selection: Pick<SelectionModel, "snapshot">;
    readonly afterPaint: PaintGuard["afterThisPaint"];
    readonly text: (key: string) => PaintedText | null;
  };
}
