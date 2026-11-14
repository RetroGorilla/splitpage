import type { SharedValuePorts } from "../../../application/commands/shared-values.ts";
import type { SharedStructurePorts } from "../../../application/commands/shared-structure.ts";
import type { StampPorts } from "../../../application/session/ports.ts";
import type { CellDecoder } from "../../../core/text/ports.ts";
import type { SharedContentRef } from "../../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { sharedBeatStamp } from "../../../adapters/collab/stamp.ts";
import { readSharedStatusHeads } from "../../../adapters/collab/status.ts";
import { readSharedJoinedFields, readSharedJoinedParts } from "../../../adapters/collab/undo-join.ts";

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

export function sharedStructurePorts(source: Parameters<typeof sharedValuePorts>[0] & { readonly cells: CellDecoder }): () => SharedStructurePorts | null {
  const values = sharedValuePorts(source);
  return () => {
    const ports = values();
    return ports && { author: ports.author, beatStamp: ports.beatStamp, cells: html => source.cells(html ?? ""), joinedParts: beat => {
      const handle = source.handle();
      return handle ? readSharedJoinedParts(handle, beat) : [];
    } };
  };
}
