import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import type { CellBuffer } from "../../features/editing/cell-buffer.ts";
import { productionReaders } from "../document-ports.ts";
import { mountCompositionFeature, mountFocusFeature, mountRowsEditingFeature } from "./editor.ts";
import { notices } from "./ports/effects.ts";
import { sharedBufferPorts } from "./ports/shared-buffer.ts";
import { sharedCommandReport } from "./ports/shared-command-notices.ts";
import { sessionStamps } from "./session-owner.ts";
import type { SharedBindings, SharedSessionParts } from "./shared-session.ts";
import { mountSharedSplitBuffer } from "./split-buffer.ts";

export function sharedSplitBindings(effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report">): SharedBindings {
  let entered: SharedSessionParts | null = null, buffer: CellBuffer | null = null;
  let refusal: string | null = null;
  const notify = sharedCommandReport(notices, effects.report);
  return {
    enter: parts => {
      if (entered === parts && buffer) return;
      entered = parts;
      mountCompositionFeature(true); mountFocusFeature(true); mountRowsEditingFeature(true);
      const author = (): { readonly id: string; readonly by: string } => {
        const next = parts.author.next();
        if (!next) throw new Error("The shared Split has no author");
        return next;
      };
      const shared = sharedBufferPorts(parts.handle, parts.session, {
        ...effects, author, readers: productionReaders, stamps: sessionStamps,
        report: outcome => { refusal = outcome.kind === "rejected" ? outcome.reason : null; notify(outcome); }
      });
      buffer = mountSharedSplitBuffer(shared);
    },
    settle: () => {
      refusal = null;
      return !buffer || buffer.binding.finish() ? null : refusal ?? "buffer-pending";
    },
    leave: () => {
      if (!entered && !buffer) return;
      if (buffer && !buffer.dispose()) throw new Error(refusal ?? "buffer-pending");
      buffer = null; entered = null;
      const errors: unknown[] = [];
      for (const restore of [() => mountCompositionFeature(), () => mountFocusFeature(), () => mountRowsEditingFeature()]) {
        try { restore(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Could not restore the standalone Split handlers");
    }
  };
}
