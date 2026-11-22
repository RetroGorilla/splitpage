import { createSharedBufferedText, sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedDocumentSession } from "../../../src/application/session/shared-session.ts";
import type { PaintedTextSource } from "../../../src/application/editing/ports.ts";
import type { BufferedTextCommit } from "../../../src/application/editing/ports.ts";
import type { ProductionReaders } from "../../../src/core/production/ports.ts";
import type { StampPorts } from "../../../src/application/session/ports.ts";

export function sharedBufferPorts(handle: SharedDocumentHandle, session: Pick<SharedDocumentSession, "run" | "read" | "readAt" | "epoch" | "beforeCommand">,
  effects: {
    readonly author: () => { readonly id: string; readonly by: string };
    readonly readers: ProductionReaders;
    readonly stamps: StampPorts;
  }
): { readonly paintedText: PaintedTextSource; readonly bufferedText: BufferedTextCommit } {
  const commit = createSharedBufferedText(handle, session, { target: rowId => sharedBufferedTarget(handle, rowId), author: effects.author, readers: effects.readers,
    stamps: effects.stamps });
  return {
    paintedText: {
      documentRevision: () => session.readAt((_doc, revision) => revision),
      read: (key, field) => field === "audioText" ? readSharedPaintedText(handle, sharedBufferedTarget(handle, key)) : null
    },
    bufferedText: commit
  };
}
