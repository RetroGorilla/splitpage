import { createBufferedField } from "../../../application/editing/buffered-field.ts";
import type { BufferedFieldPorts } from "../../../application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../application/editing/painted-beats.ts";
import type { BufferedTextEdit, PaintedText, PaintedTextSource } from "../../../application/editing/ports.ts";
import { createSelectionModel } from "../../../application/editing/selection.ts";
import type { CommonDocumentSession, DocumentView } from "../../../application/session/document-session.ts";
import { bufferedFieldKey, readBufferedFieldKey } from "../../../core/collab/buffer.ts";
import type { Run } from "../../../core/text/runs.ts";
import { projection } from "../../../core/text/runs.ts";
import { mountCellBuffer } from "../../../features/editing/cell-buffer.ts";
import { createCellPage } from "../../../features/editing/cell-page.ts";
import { ensureTrailingCaretSpot } from "../../../features/common/dom.ts";
import { placeSelection, readSelection } from "../../../features/common/cell-dom.ts";
import type { FlowVisualBufferMount } from "../../../features/writer/flow-visual-box.ts";

function identities(base: PaintedText | null): readonly string[] | null {
  if (!base) return null;
  const keys: string[] = [];
  for (let index = 0; index < base.text.length; index++) { const key = base.identity(index); if (!key) return null; keys.push(key); }
  return keys;
}

export function writerVisualBuffer(shared: { readonly bufferedText: BufferedFieldPorts; readonly paintedText: PaintedTextSource }, source: {
  readonly document: () => DocumentView | null;
  readonly lifetime: Pick<CommonDocumentSession, "epoch">;
  readonly decode: (html: string) => Run[];
  readonly storedHtml: (html: string) => string;
  readonly shown: <T>(edit: () => T) => T;
}): FlowVisualBufferMount {
  return (root, repaint) => {
    const painted = createPaintedBeats(shared.paintedText), listeners = new Set<() => void>();
    const cell = root.querySelector<HTMLElement>(".wr-flow-visual-text"); if (!cell) throw new Error("A Writer visual buffer needs its cell");
    let selectionEdit: BufferedTextEdit | null = null, painting = false;
    const key = () => bufferedFieldKey(cell.dataset.id ?? "", "visualText");
    const order = () => source.document()?.rows.map(row => row.id) ?? [];
    const selection = createSelectionModel({ epoch: source.lifetime.epoch, order, keys: rowId => identities(shared.paintedText.read(bufferedFieldKey(rowId, "visualText"), "visualText")) });
    const record = () => { for (const listener of listeners) listener(); };
    const buffer = mountCellBuffer({ root, ports: {
      field: surface => createBufferedField(shared.bufferedText, surface), painted,
      report: shared.bufferedText.report, decode: source.decode, document: source.document, shown: source.shown,
      page: createCellPage({ storedHtml: source.storedHtml, caretSpot: ensureTrailingCaretSpot }),
      paintedFrom: (element, field, row) => projection(source.decode(element.innerHTML)) === projection(source.decode(String(row[field] ?? ""))),
      notePainted: () => {}, repaintRows: repaint,
      onPainted: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      beforePaint: () => () => {},
      readable: id => shared.paintedText.read(id, readBufferedFieldKey(id).field) !== null
    } });
    const selectionEnd = (): void => { const edit = selectionEdit; selectionEdit = null; edit?.cancel(); };
    return {
      painted: record,
      finish: buffer.binding.finish,
      selectionStart: range => {
        if (selectionEdit?.isOpen()) return true;
        if (range.head.kind !== "beat") return false;
        const base = shared.paintedText.read(range.head.rowId, "audioText");
        selectionEdit = base ? shared.bufferedText.open(range.head.rowId, base) : null;
        if (!selectionEdit) shared.bufferedText.report({ kind: "rejected", reason: "buffer-unavailable" });
        return selectionEdit !== null;
      },
      selectionEnd,
      refresh: paint => {
        if (painting || !buffer.binding.canPaint()) return;
        const focused = root.ownerDocument.activeElement === cell;
        const points = focused ? readSelection(cell, root.ownerDocument.getSelection()) : null, keys = identities(painted.base(key()));
        if (points && keys) selection.remember({ ...points, epoch: source.lifetime.epoch(), rowId: cell.dataset.id ?? "", field: "visualText", keys, order: order() });
        else selection.forget();
        painting = true;
        try {
          paint(); record();
          const resolved = selection.resolve();
          if (focused && resolved && resolved.rowId === cell.dataset.id) { cell.focus({ preventScroll: true }); placeSelection(cell, root.ownerDocument.getSelection(), resolved); }
        } finally { painting = false; }
      },
      dispose: () => { if (!buffer.dispose()) return false; selectionEnd(); return true; }
    };
  };
}
