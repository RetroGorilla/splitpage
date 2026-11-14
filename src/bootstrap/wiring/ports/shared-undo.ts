import { reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../adapters/collab/undo-executor.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { createSharedUndo } from "../../../application/editing/undo/shared-undo.ts";
import type { SharedUndo } from "../../../application/editing/undo/shared-undo.ts";

export const SHARED_UNDO_NO_AUTHOR = "undo-no-author";

export function sharedUndoOwner(handle: SharedDocumentHandle, author: () => { readonly id: string; readonly by: string } | null, now: () => number): SharedUndo {
  return createSharedUndo({
    now: now,
    supports: supportsSharedUndoPart,
    reverse: record => {
      const writer = author();
      if (!writer) return { ok: false, reason: SHARED_UNDO_NO_AUTHOR };
      let serial = 0;
      return reverseSharedUndoRecord(handle, record, { by: writer.by, nextId: () => writer.id + "_" + String(++serial) });
    }
  });
}
