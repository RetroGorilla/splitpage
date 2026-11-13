import { createSharedBufferedText, sharedBufferedTarget } from "../../../adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../../adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import type { SharedDocumentSession } from "../../../application/session/shared-session.ts";
import type { PaintedTextSource } from "../../../application/editing/ports.ts";
import type { BufferedFieldPorts } from "../../../application/editing/buffered-field.ts";
import { headingFieldKey } from "../../../application/editing/buffered-field-key.ts";
import type { ProductionReaders } from "../../../core/production/ports.ts";
import type { StampPorts } from "../../../application/session/ports.ts";

export function sharedBufferPorts(handle: SharedDocumentHandle, session: Pick<SharedDocumentSession, "run" | "read" | "readAt" | "epoch" | "beforeCommand">,
  effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report"> & {
    readonly author: () => { readonly id: string; readonly by: string };
    readonly readers: ProductionReaders;
    readonly stamps: StampPorts;
  }
): { readonly paintedText: PaintedTextSource; readonly bufferedText: BufferedFieldPorts } {
  const commit = createSharedBufferedText(handle, session, { target: rowId => sharedBufferedTarget(handle, rowId), author: effects.author, readers: effects.readers,
    stamps: effects.stamps });
  return {
    paintedText: {
      documentRevision: () => session.readAt((_doc, revision) => revision),
      read: (owner, field) => field === "audioText" ? readSharedPaintedText(handle, sharedBufferedTarget(handle, owner))
        : field === "heading" ? readSharedPaintedText(handle, sharedBufferedTarget(handle, headingFieldKey(owner))) : null
    },
    bufferedText: { open: commit.open, beforeCommand: session.beforeCommand, missingBase: effects.missingBase, recovered: effects.recovered, report: effects.report }
  };
}
