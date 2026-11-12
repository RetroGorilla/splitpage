import type { BufferedTextCommit } from "../../application/editing/ports.ts";
import type { CommonDocumentSession, CommandOutcome } from "../../application/session/document-session.ts";
import { cellEdit } from "../../application/session/change-set.ts";
import { SharedTextBuffer } from "../../core/collab/buffer.ts";
import { bufferedTextOperations } from "../../core/collab/buffer-operations.ts";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { readSharedRevision } from "./document.ts";
import { holdSharedBuffer, sharedBufferDeliveryBusy } from "./ingress.ts";

export function createSharedBufferedText(
  handle: SharedDocumentHandle,
  session: Pick<CommonDocumentSession, "run" | "epoch">,
  ports: { readonly target: (rowId: string) => SharedTextAddress; readonly author: () => { readonly id: string; readonly by: string } }
): BufferedTextCommit {
  return {
    open: (rowId, painted) => {
      if (sharedBufferDeliveryBusy(handle) || readSharedRevision(handle) !== painted.revision) return null;
      const target = ports.target(rowId), epoch = session.epoch(), buffer = new SharedTextBuffer(painted.revision, painted.text);
      const release = holdSharedBuffer(handle);
      let open = true;
      buffer.begin();
      return {
        text: () => buffer.text(),
        replace: (from, to, insert) => {
          if (!open) throw new Error("Buffered edit is closed");
          buffer.replace(from, to, insert);
        },
        commit: runs => {
          if (!open) return { kind: "rejected", reason: "buffer-closed" };
          if (sharedBufferDeliveryBusy(handle)) return { kind: "rejected", reason: "buffer-delivery" };
          if (session.epoch() !== epoch) return { kind: "rejected", reason: "buffer-epoch" };
          let outcome: CommandOutcome;
          try {
            const commit = buffer.plan(), operations = bufferedTextOperations(commit, painted, target, runs, ports.author());
            outcome = session.run({ name: "buffered-text", needs: "edit", plan: () => ({
              changes: cellEdit(rowId, target.field),
              apply: () => { throw new Error("A buffered shared command cannot apply a standalone plan"); },
              shared: { operations, base: commit.base }
            }) });
          } catch (error) { return { kind: "failed", error }; }
          if (outcome.kind === "applied" || outcome.kind === "committed" || outcome.kind === "noop") {
            buffer.commit(); open = false;
            try { release(); } catch (error) {
              return outcome.kind === "noop" ? { kind: "failed", error }
                : { ...outcome, kind: "committed", errors: [...(outcome.kind === "committed" ? outcome.errors : []), error] };
            }
          }
          return outcome;
        },
        cancel: () => { if (open) { open = false; buffer.cancel(); release(); } }
      };
    }
  };
}
