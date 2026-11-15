import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { sharedLeftCellKeying, sharedScriptBrollKeyingPorts } from "./ports/shared-broll-keying.ts";
import type { CellBuffer } from "../../features/editing/cell-buffer.ts";
import { productionReaders } from "../document-ports.ts";
import { mountCompositionFeature, mountFocusFeature, mountRowsEditingFeature, refuseSharedSplitNative } from "./editor.ts";
import { notices } from "./ports/effects.ts";
import { sharedBufferPorts } from "./ports/shared-buffer.ts";
import { sharedCommandReport } from "./ports/shared-command-notices.ts";
import { sessionStamps } from "./session-owner.ts";
import type { SharedBindings, SharedSessionParts } from "./shared-session.ts";
import { mountSharedSplitBuffer } from "./split-buffer.ts";

export function sharedSplitBindings(effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report" | "ownershipScan">): SharedBindings & {
  readonly abandonable: () => number;
} {
  let entered: SharedSessionParts | null = null, buffer: CellBuffer | null = null;
  let refusal: string | null = null, closing = false;
  const abandons = new Set<(final: boolean) => void>();
  const abandonment = (abandon: (final: boolean) => void): (() => void) => { abandons.add(abandon); return () => { abandons.delete(abandon); }; };
  function abandonAll(final: boolean): void {
    const errors: unknown[] = [];
    for (const abandon of [...abandons]) { try { abandon(final); } catch (error) { errors.push(error); } }
    if (errors.length) throw errors[0];
  }
  const notify = sharedCommandReport(notices, effects.report);
  return {
    enter: parts => {
      closing = false;
      if (entered === parts && buffer) return;
      entered = parts;
      const leftCell = sharedLeftCellKeying(parts.session, sharedScriptBrollKeyingPorts(parts, sessionStamps),
        { open: () => !closing && entered === parts && !!buffer, notify });
      mountCompositionFeature(true); mountFocusFeature({ leftCell }); mountRowsEditingFeature(true);
      const author = (): { readonly id: string; readonly by: string } => {
        const next = parts.author.next();
        if (!next) throw new Error("The shared Split has no author");
        return next;
      };
      const shared = sharedBufferPorts(parts.handle, parts.session, {
        ...effects, author, readers: productionReaders, stamps: sessionStamps, abandonment,
        report: outcome => { refusal = outcome.kind === "rejected" ? outcome.reason : null; notify(outcome); }
      });
      buffer = mountSharedSplitBuffer({ ...shared, refuseNative: refuseSharedSplitNative });
    },
    settle: () => {
      refusal = null;
      return !buffer || buffer.binding.finish() ? null : refusal ?? "buffer-pending";
    },
    abandon: () => { closing = true; abandonAll(false); },
    drop: () => { closing = true; abandonAll(true); },
    abandonable: () => abandons.size,
    leave: () => {
      closing = true;
      if (!entered && !buffer) return;
      if (buffer && entered?.session.read(doc => doc) === null) abandonAll(true);
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
