import { createSharedBufferedText, sharedBufferedTarget } from "../../../adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../../adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import type { SharedDocumentSession } from "../../../application/session/shared-session.ts";
import type { PaintedTextSource } from "../../../application/editing/ports.ts";
import type { WriterBufferPorts } from "../../../features/writer/flow-buffer.ts";

export function sharedWriterBufferPorts(handle: SharedDocumentHandle, session: Pick<SharedDocumentSession, "run" | "read" | "readAt" | "epoch" | "beforeCommand">,
  effects: Pick<WriterBufferPorts, "missingBase" | "report"> & { readonly author: () => { readonly id: string; readonly by: string } }
): { readonly paintedText: PaintedTextSource; readonly bufferedText: WriterBufferPorts } {
  const commit = createSharedBufferedText(handle, session, { target: rowId => sharedBufferedTarget(handle, rowId), author: effects.author });
  return {
    paintedText: {
      documentRevision: () => session.readAt((_doc, revision) => revision),
      read: (rowId, field) => field === "audioText" ? readSharedPaintedText(handle, sharedBufferedTarget(handle, rowId)) : null
    },
    bufferedText: { open: commit.open, beforeCommand: session.beforeCommand, missingBase: effects.missingBase, report: effects.report }
  };
}
