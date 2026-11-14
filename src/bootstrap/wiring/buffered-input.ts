import { createBufferedField } from "../../application/editing/buffered-field.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../application/editing/painted-beats.ts";
import type { PaintedTextSource } from "../../application/editing/ports.ts";
import { onBeforePaint, onPainted, render } from "../../features/rows/render.ts";
import type { BufferedInputPorts } from "../../features/common/buffered-input.ts";
import { paintGuard } from "./editor-owners.ts";
import { sharedUndoActions } from "../../application/editing/undo/shared-undo-actions.ts";
import type { SharedUndo } from "../../application/editing/undo/shared-undo.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import type { SharedDocumentHandle } from "../../adapters/collab/types.ts";
import { resolveSharedBufferedSelection } from "../../adapters/collab/buffer-selection.ts";
import { sharedBufferedTarget } from "../../adapters/collab/buffer.ts";

export function sharedBufferedInputHistory(handle: SharedDocumentHandle, session: Pick<SharedDocumentSession, "admit">,
  owner: Pick<SharedUndo, "undo" | "redo">): NonNullable<BufferedInputPorts["history"]> {
  return {
    ...sharedUndoActions(session, owner),
    selection: (key, selection) => resolveSharedBufferedSelection(handle, [selection.anchor, selection.focus], { key, target: sharedBufferedTarget(handle, key) })
  };
}

export function sharedBufferedInputPorts(shared: { readonly paintedText: PaintedTextSource; readonly bufferedText: BufferedFieldPorts },
  history?: BufferedInputPorts["history"]): BufferedInputPorts {
  return {
    field: surface => createBufferedField(shared.bufferedText, surface),
    painted: createPaintedBeats(shared.paintedText),
    report: shared.bufferedText.report,
    shown: edit => paintGuard().whileShown(edit),
    repaint: render,
    onPainted,
    beforePaint: onBeforePaint,
    ...history ? { history } : {}
  };
}
