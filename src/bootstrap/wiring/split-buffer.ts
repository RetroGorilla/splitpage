import { createBufferedField } from "../../application/editing/buffered-field.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../application/editing/painted-beats.ts";
import type { PaintedTextSource } from "../../application/editing/ports.ts";
import { ensureTrailingCaretSpot } from "../../features/common/dom.ts";
import { mountCellBuffer } from "../../features/editing/cell-buffer.ts";
import type { CellBuffer } from "../../features/editing/cell-buffer.ts";
import { createCellPage } from "../../features/editing/cell-page.ts";
import { noteFieldPainted, onPainted, paintedFromRow, render } from "../../features/rows/render.ts";
import { fromHtml, storedHtmlFromDom } from "../richtext.ts";
import { paintGuard } from "./editor-owners.ts";
import { currentDocument } from "./session-owner.ts";

const MEDIA_CELL = Object.freeze({ media: true });

export function mountSharedSplitBuffer(shared: { readonly paintedText: PaintedTextSource; readonly bufferedText: BufferedFieldPorts }): CellBuffer {
  return mountCellBuffer({
    root: document.getElementById("rows") as HTMLElement,
    ports: {
      field: surface => createBufferedField(shared.bufferedText, surface),
      painted: createPaintedBeats(shared.paintedText),
      report: shared.bufferedText.report,
      page: createCellPage({ storedHtml: storedHtmlFromDom, caretSpot: ensureTrailingCaretSpot }),
      decode: html => fromHtml(html, MEDIA_CELL),
      document: currentDocument,
      paintedFrom: paintedFromRow,
      notePainted: noteFieldPainted,
      shown: edit => paintGuard().whileShown(edit),
      repaintRows: render,
      onPainted
    }
  });
}
