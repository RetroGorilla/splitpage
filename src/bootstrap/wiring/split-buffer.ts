import { createBufferedField } from "../../application/editing/buffered-field.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../application/editing/painted-beats.ts";
import type { PaintedTextSource } from "../../application/editing/ports.ts";
import { ensureTrailingCaretSpot } from "../../features/common/dom.ts";
import { mountCellBuffer } from "../../features/editing/cell-buffer.ts";
import type { CellBuffer } from "../../features/editing/cell-buffer.ts";
import { createCellPage } from "../../features/editing/cell-page.ts";
import { noteFieldPainted, onBeforePaint, onPainted, paintedFromRow, render } from "../../features/rows/render.ts";
import { fromHtml, storedHtmlFromDom } from "../richtext.ts";
import { readBufferedFieldKey } from "../../core/collab/buffer.ts";
import { paintGuard, editorSelection } from "./editor-owners.ts";
import { documentReader } from "./ports/document.ts";
import type { SharedContentRef } from "../../core/collab/operations.ts";

const MEDIA_CELL = Object.freeze({ media: true });

export function mountSharedSplitBuffer(shared: { readonly paintedText: PaintedTextSource; readonly selectionText: PaintedTextSource;
  readonly selectionIdentity: (reference: SharedContentRef) => string; readonly bufferedText: BufferedFieldPorts }): CellBuffer {
  return mountCellBuffer({
    root: document.getElementById("rows") as HTMLElement,
    ports: {
      field: surface => createBufferedField(shared.bufferedText, surface),
      painted: createPaintedBeats(shared.paintedText),
      report: shared.bufferedText.report,
      page: createCellPage({ storedHtml: storedHtmlFromDom, caretSpot: ensureTrailingCaretSpot }),
      decode: html => fromHtml(html, MEDIA_CELL),
      document: documentReader.current,
      paintedFrom: paintedFromRow,
      notePainted: noteFieldPainted,
      shown: edit => paintGuard().whileShown(edit),
      repaintRows: render,
      onPainted,
      beforePaint: onBeforePaint,
      readable: key => shared.paintedText.read(key, readBufferedFieldKey(key).field) !== null,
      caret: { selection: editorSelection(), afterPaint: task => paintGuard().afterThisPaint(task),
        text: key => shared.selectionText.read(key, readBufferedFieldKey(key).field), identity: shared.selectionIdentity }
    }
  });
}
