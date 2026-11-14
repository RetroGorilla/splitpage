import type { FlowWriter } from "../../features/writer/ports.ts";
import type { SharedWriterSource } from "./writer.ts";
import { createSharedAnchor } from "../../adapters/collab/anchors.ts";
import { resolveSharedBufferedSelection } from "../../adapters/collab/buffer-selection.ts";
import { sharedBufferedTarget } from "../../adapters/collab/buffer.ts";
import { mountSharedEmptyScript } from "./ports/empty-script.ts";
import { edits } from "./ports/editing.ts";
import { notices } from "./ports/effects.ts";
import { sessionStamps } from "./session-owner.ts";

export function mountWriterEmptyScript(flow: FlowWriter, host: HTMLElement, shared: SharedWriterSource): FlowWriter {
  const handle = shared.handle();
  if (!handle) return flow;
  const empty = mountSharedEmptyScript({ handle, session: shared.lifetime, author: shared.author, writer: shared.writer, stamps: sessionStamps }, {
    host, edits, notices, report: shared.text.bufferedText.report,
    place: (rowId, offset) => {
      const anchor = createSharedAnchor(handle, sharedBufferedTarget(handle, rowId), offset, "before");
      const range = anchor ? resolveSharedBufferedSelection(handle, [anchor, anchor]) : null;
      if (!range) return false;
      flow.repaint(); flow.place(range, true); return true;
    }
  });
  return { ...flow,
    settle: () => empty.finish() && (flow.settle?.() ?? true),
    dispose: () => {
      if (!empty.finish() || flow.settle?.() === false || !empty.dispose()) return false;
      return flow.dispose();
    }
  };
}
