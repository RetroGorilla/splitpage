import { collabState } from "../../adapters/collab/state.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { productionReaders } from "../document-ports.ts";
import { sharedBufferPorts } from "./ports/shared-buffer.ts";
import { sharedCommandReport } from "./ports/shared-command-notices.ts";
import { notices } from "./ports/effects.ts";
import { writerView } from "./ports/preferences.ts";
import { documentReader } from "./ports/document.ts";
import { sessionStamps, sharedSession } from "./session-owner.ts";
import type { SharedBindings, SharedSessionParts } from "./shared-session.ts";
import { mountWriterRuntimeFeature, stopWriterRuntimeFeature, writerControls } from "./writer.ts";
import type { SharedWriterSource } from "./writer.ts";
import type { FlowRange } from "../../core/flow/flow.ts";

export const SHARED_WRITER_NO_AUTHOR = "The shared Writer has no author";

export function sharedWriterBindings(effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report">): SharedBindings {
  let entered: SharedSessionParts | null = null;
  let cancelReopen: (() => void) | null = null;
  let pendingSelection: FlowRange | null = null;
  let reopenPending = false;
  function restart(shared?: SharedWriterSource): void {
    const open = writerView().writerOpen() || reopenPending;
    const selection = pendingSelection ?? writerControls()?.writerFlowControl()?.selection() ?? null;
    cancelReopen?.();
    cancelReopen = null;
    pendingSelection = selection;
    reopenPending = open;
    stopWriterRuntimeFeature();
    const control = mountWriterRuntimeFeature(shared);
    if (!open) return;
    const reopen = (): void => {
      if (!documentReader.current() || sharedSession() !== !!shared) return;
      cancelReopen?.();
      cancelReopen = null;
      control.openWriter();
      if (selection) control.writerFlowControl()?.place(selection, true);
      pendingSelection = null;
      reopenPending = false;
    };
    const offChange = documentReader.onChange(reopen), offReplaced = documentReader.onReplaced(reopen);
    cancelReopen = () => { offChange(); offReplaced(); };
    reopen();
  }
  return {
    enter: parts => {
      entered = parts;
      const author = (): { readonly id: string; readonly by: string } => {
        const next = parts.author.next();
        if (!next) throw new Error(SHARED_WRITER_NO_AUTHOR);
        return next;
      };
      const text = sharedBufferPorts(parts.handle, parts.session, { ...effects, report: sharedCommandReport(notices, effects.report), author, readers: productionReaders, stamps: sessionStamps });
      restart({ text, author: parts.author, writer: () => String(collabState(parts.handle).doc.clientID),
        handle: () => entered === parts ? parts.handle : null, lifetime: parts.session });
    },
    settle: () => {
      const refused = entered ? entered.session.admit() : null;
      if (!refused) return null;
      if (refused.kind === "failed") effects.report(refused);
      return refused.kind === "rejected" ? refused.reason : "settle-failed";
    },
    leave: () => {
      entered = null;
      restart();
    }
  };
}
