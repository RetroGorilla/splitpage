import type { SharedValuePorts } from "../../../application/commands/shared-values.ts";
import type { StampPorts } from "../../../application/session/ports.ts";
import type { SharedContentRef } from "../../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { sharedBeatStamp } from "../../../adapters/collab/stamp.ts";
import { readSharedStatusHeads } from "../../../adapters/collab/status.ts";
import { readSharedJoinedFields } from "../../../adapters/collab/undo-join.ts";

export function sharedValuePorts(source: { readonly handle: () => SharedDocumentHandle | null; readonly author: SharedValuePorts["author"]; readonly stamps: StampPorts }): () => SharedValuePorts | null {
  return () => source.handle() ? {
    author: source.author,
    beatStamp: (beat, author) => sharedBeatStamp(beat as SharedContentRef, author, source.stamps),
    statusHeads: beat => {
      const handle = source.handle();
      return handle ? readSharedStatusHeads(handle, { scope: "beat", record: beat as SharedContentRef }) : [];
    },
    statusParts: beat => {
      const handle = source.handle();
      return handle ? readSharedJoinedFields(handle, beat) : [beat];
    }
  } : null;
}
