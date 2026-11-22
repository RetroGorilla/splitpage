import type { BufferedInputPorts } from "../../src/features/common/buffered-input.ts";
import { sharedUndoActions } from "../../src/application/editing/undo/shared-undo-actions.ts";
import type { SharedUndo } from "../../src/application/editing/undo/shared-undo.ts";
import type { SharedDocumentSession } from "../../src/application/session/shared-session.ts";
import type { SharedDocumentHandle } from "../../src/adapters/collab/types.ts";
import { resolveSharedBufferedSelection } from "../../src/adapters/collab/buffer-selection.ts";
import { sharedBufferedTarget } from "../../src/adapters/collab/buffer.ts";

export function sharedBufferedInputHistory(handle: SharedDocumentHandle, session: Pick<SharedDocumentSession, "admit">,
  owner: Pick<SharedUndo, "undo" | "redo">): NonNullable<BufferedInputPorts["history"]> {
  return {
    ...sharedUndoActions(session, owner),
    selection: (key, selection) => resolveSharedBufferedSelection(handle, [selection.anchor, selection.focus], { key, target: sharedBufferedTarget(handle, key) })
  };
}
