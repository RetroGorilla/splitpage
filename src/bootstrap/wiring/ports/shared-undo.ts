import { reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../adapters/collab/undo-executor.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { createSharedUndo } from "../../../application/editing/undo/shared-undo.ts";
import type { SharedUndo, SharedUndoReversal } from "../../../application/editing/undo/shared-undo.ts";
import type { SharedUndoRecord } from "../../../core/collab/undo-record.ts";

export const SHARED_UNDO_NO_AUTHOR = "undo-no-author";

export function sharedUndoOwner(handle: SharedDocumentHandle, author: () => { readonly id: string; readonly by: string } | null, now: () => number,
  report: (error: unknown) => void): SharedUndo & { readonly replayed: () => SharedUndoRecord | null } {
  let replayed: SharedUndoRecord | null = null;
  const owner = createSharedUndo({
    now: now,
    supports: supportsSharedUndoPart,
    reverse: record => {
      replayed = null;
      const writer = author();
      if (!writer) return { ok: false, reason: SHARED_UNDO_NO_AUTHOR };
      let serial = 0;
      const taken: { reversal: SharedUndoReversal | null } = { reversal: null };
      try {
        const reversal = reverseSharedUndoRecord(handle, record, { by: writer.by, nextId: () => writer.id + "_" + String(++serial) }, done => { taken.reversal = done; });
        if (reversal.ok && reversal.effective) replayed = record;
        return reversal;
      } catch (error) {
        // why: the reversal stands once written, so the stack moves with it and the callback's failure is reported
        if (!taken.reversal) throw error;
        report(error);
        if (taken.reversal.ok && taken.reversal.effective) replayed = record;
        return taken.reversal;
      }
    }
  });
  return Object.freeze({ ...owner, replayed: () => replayed });
}
