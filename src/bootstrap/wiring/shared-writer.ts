import { collabState } from "../../adapters/collab/state.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { productionReaders } from "../document-ports.ts";
import { sharedBufferPorts } from "./ports/shared-buffer.ts";
import { sessionStamps } from "./session-owner.ts";
import type { SharedBindings, SharedSessionParts } from "./shared-session.ts";
import { mountWriterRuntimeFeature, stopWriterRuntimeFeature } from "./writer.ts";

export const SHARED_WRITER_NO_AUTHOR = "The shared Writer has no author";

export function sharedWriterBindings(effects: Pick<BufferedFieldPorts, "missingBase" | "recovered" | "report">): SharedBindings {
  let entered: SharedSessionParts | null = null;
  return {
    enter: parts => {
      entered = parts;
      const author = (): { readonly id: string; readonly by: string } => {
        const next = parts.author.next();
        if (!next) throw new Error(SHARED_WRITER_NO_AUTHOR);
        return next;
      };
      const text = sharedBufferPorts(parts.handle, parts.session, { ...effects, author, readers: productionReaders, stamps: sessionStamps });
      stopWriterRuntimeFeature();
      mountWriterRuntimeFeature({ text, author: parts.author, writer: () => String(collabState(parts.handle).doc.clientID),
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
      stopWriterRuntimeFeature();
      mountWriterRuntimeFeature();
    }
  };
}
