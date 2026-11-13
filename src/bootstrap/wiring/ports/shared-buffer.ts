import { createSharedBufferedText, sharedBufferedTarget } from "../../../adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../../adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import type { SharedDocumentSession } from "../../../application/session/shared-session.ts";
import type { PaintedTextSource } from "../../../application/editing/ports.ts";
import type { WriterBufferPorts } from "../../../features/writer/flow-buffer.ts";
import type { ProductionReaders } from "../../../core/production/ports.ts";

export function sharedWriterBufferPorts(handle: SharedDocumentHandle, session: Pick<SharedDocumentSession, "run" | "read" | "readAt" | "epoch" | "beforeCommand">,
  effects: Pick<WriterBufferPorts, "missingBase" | "recovered" | "report"> & {
    readonly author: () => { readonly id: string; readonly by: string };
    readonly readers: Pick<ProductionReaders, "tagsInField" | "cellOf">;
  }
): { readonly paintedText: PaintedTextSource; readonly bufferedText: WriterBufferPorts } {
  const commit = createSharedBufferedText(handle, session, { target: rowId => sharedBufferedTarget(handle, rowId), author: effects.author, readers: effects.readers });
  return {
    paintedText: {
      documentRevision: () => session.readAt((_doc, revision) => revision),
      read: (rowId, field) => field === "audioText" ? readSharedPaintedText(handle, sharedBufferedTarget(handle, rowId)) : null
    },
    bufferedText: { open: commit.open, beforeCommand: session.beforeCommand, missingBase: effects.missingBase, recovered: effects.recovered, report: effects.report }
  };
}
