import { createSharedBufferedText, sharedBufferedTarget } from "../../../adapters/collab/buffer.ts";
import { readSharedPaintedText, readSharedPaintedSelectionText, paintedCaretIdentity } from "../../../adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import type { SharedDocumentSession } from "../../../application/session/shared-session.ts";
import type { PaintedTextSource } from "../../../application/editing/ports.ts";
import type { BufferedFieldPorts } from "../../../application/editing/buffered-field.ts";
import { bufferedFieldTarget } from "../../../application/editing/buffered-field-key.ts";
import type { ProductionReaders } from "../../../core/production/ports.ts";
import type { StampPorts } from "../../../application/session/ports.ts";

export function sharedBufferPorts(handle: SharedDocumentHandle, session: Pick<SharedDocumentSession, "run" | "read" | "readAt" | "epoch" | "beforeCommand">,
  effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report"> & {
    readonly author: () => { readonly id: string; readonly by: string };
    readonly readers: ProductionReaders;
    readonly stamps: StampPorts;
  }
): { readonly paintedText: PaintedTextSource; readonly selectionText: PaintedTextSource; readonly selectionIdentity: typeof paintedCaretIdentity; readonly bufferedText: BufferedFieldPorts } {
  const commit = createSharedBufferedText(handle, session, { target: rowId => sharedBufferedTarget(handle, rowId), author: effects.author, readers: effects.readers,
    stamps: effects.stamps });
  return {
    selectionIdentity: paintedCaretIdentity,
    paintedText: {
      documentRevision: () => session.readAt((_doc, revision) => revision),
      read: (key, field) => field === bufferedFieldTarget(key)?.field ? readSharedPaintedText(handle, sharedBufferedTarget(handle, key)) : null
    },
    selectionText: {
      documentRevision: () => session.readAt((_doc, revision) => revision),
      read: (key, field) => field === bufferedFieldTarget(key)?.field ? readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, key)) : null
    },
    bufferedText: { open: commit.open, beforeCommand: session.beforeCommand, missingBase: effects.missingBase, recovered: effects.recovered, report: effects.report }
  };
}
