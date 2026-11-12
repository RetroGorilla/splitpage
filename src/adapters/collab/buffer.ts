import type { BufferedTextCommit } from "../../application/editing/ports.ts";
import type { CommonDocumentSession, CommandOutcome } from "../../application/session/document-session.ts";
import { cellEdit, NO_CHANGES } from "../../application/session/change-set.ts";
import { createSharedTextBuffer } from "../../core/collab/buffer.ts";
import { bufferedRecoveryOperations, bufferedTextOperations } from "../../core/collab/buffer-operations.ts";
import { toHtml } from "../../core/text/html.ts";
import { cellLength } from "../../core/text/runs.ts";
import { sharedStructureIdentity, SharedStructurePreparationError } from "./structure-identity.ts";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { readSharedRevision } from "./document.ts";
import { holdSharedBuffer, sharedBufferDeliveryBusy } from "./ingress.ts";
import { readSharedPaintedText } from "./paint-base.ts";
import { resolveSharedBufferedSelection } from "./buffer-selection.ts";
import { sharedAnchorCharacterEnd } from "./anchors.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";

export function sharedBufferedTarget(_handle: SharedDocumentHandle, rowId: string): SharedTextAddress {
  const owner = readSharedContentRef(rowId);
  if (!owner) throw new Error("Invalid buffered beat address");
  return { owner, segment: owner, field: "audioText" };
}

export function createSharedBufferedText(
  handle: SharedDocumentHandle,
  session: Pick<CommonDocumentSession, "run" | "epoch" | "read">,
  ports: { readonly target: (rowId: string) => SharedTextAddress; readonly author: () => { readonly id: string; readonly by: string } }
): BufferedTextCommit {
  return {
    open: (rowId, painted) => {
      if (sharedBufferDeliveryBusy(handle) || readSharedRevision(handle) !== painted.revision) return null;
      const target = ports.target(rowId), epoch = session.epoch(), buffer = createSharedTextBuffer(painted.revision, painted.text);
      const release = holdSharedBuffer(handle);
      let open = true, stranded = false;
      buffer.begin();
      return {
        isOpen: () => open,
        text: () => buffer.text(),
        replace: (from, to, insert) => {
          if (!open) throw new Error("Buffered edit is closed");
          buffer.replace(from, to, insert);
        },
        commit: (runs, selection) => {
          stranded = false;
          if (!open) return { kind: "rejected", reason: "buffer-closed" };
          if (sharedBufferDeliveryBusy(handle)) return { kind: "rejected", reason: "buffer-delivery" };
          if (session.epoch() !== epoch) { stranded = true; return { kind: "rejected", reason: "buffer-epoch" }; }
          let outcome: CommandOutcome, planned = false;
          try {
            const commit = buffer.plan(), operations = bufferedTextOperations(commit, painted, target, runs, ports.author());
            outcome = session.run({ name: "buffered-text", needs: "edit", plan: () => {
              planned = true;
              return {
                changes: cellEdit(rowId, target.field),
                apply: () => { throw new Error("A buffered shared command cannot apply a standalone plan"); },
                shared: { operations, base: commit.base }
              };
            } });
          } catch (error) { return { kind: "failed", error }; }
          // why: a list the document refused after admission stays refused at this base; assumed rule 29 on #1414 places it.
          stranded = planned && outcome.kind === "rejected";
          if (outcome.kind === "applied" || outcome.kind === "committed" || outcome.kind === "noop") {
            const local = selection ? readSharedPaintedText(handle, target) : null;
            const anchors = selection?.map(offset => {
              if (!local) return null;
              const preceding = offset > 0 ? local.identity(offset - 1) : null;
              return preceding ? sharedAnchorCharacterEnd(preceding) : local.identity(0) ?? local.emptyGap ?? null;
            }) ?? [];
            buffer.commit(); open = false;
            try { release(); } catch (error) {
              outcome = outcome.kind === "noop" ? { kind: "failed", error }
                : { ...outcome, kind: "committed", errors: [...(outcome.kind === "committed" ? outcome.errors : []), error] };
            }
            const restored = selection ? resolveSharedBufferedSelection(handle, anchors) : undefined;
            return restored ? { ...outcome, selection: restored } : outcome;
          }
          return outcome;
        },
        recover: runs => {
          if (!open || !stranded) return null;
          if (sharedBufferDeliveryBusy(handle)) return { kind: "rejected", reason: "buffer-delivery" };
          let outcome: CommandOutcome;
          try {
            const author = ports.author(), visual = sharedStructureIdentity(String(collabState(handle).doc.clientID), author.id, "visual");
            const snapshot = { owner: rowId, base: painted.revision, html: toHtml(runs), units: cellLength(runs) };
            outcome = session.run({ name: "buffered-text-recovery", needs: "edit", plan: doc => ({
              changes: NO_CHANGES,
              apply: () => { throw new Error("A buffered shared command cannot apply a standalone plan"); },
              shared: { operations: bufferedRecoveryOperations(snapshot, author, { rows: doc.rows.length, visual }), undo: false }
            }) });
          } catch (error) {
            return error instanceof SharedStructurePreparationError ? { kind: "rejected", reason: error.message } : { kind: "failed", error };
          }
          if (outcome.kind !== "applied" && outcome.kind !== "committed") return outcome;
          // why: a paint during the drain must still read the kept native text here, so the field is reset, not adopted.
          open = false; stranded = false; try { release(); } catch (error) {
            return { ...outcome, kind: "committed", errors: [...(outcome.kind === "committed" ? outcome.errors : []), error] };
          } finally { buffer.cancel(); }
          return outcome;
        },
        cancel: () => { if (open) { open = false; buffer.cancel(); release(); } }
      };
    }
  };
}
