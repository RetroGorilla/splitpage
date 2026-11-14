import { collabState } from "../../../adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import { sharedBeatStamp } from "../../../adapters/collab/stamp.ts";
import { readSharedStatusHeads } from "../../../adapters/collab/status.ts";
import type { SharedListPorts } from "../../../application/commands/shared-list.ts";
import type { StampPorts } from "../../../application/session/ports.ts";
import { flowIdentity } from "../../../core/flow/operations.ts";

export interface SharedWriterAuthor {
  readonly id: string;
  readonly by: string;
}

export interface SharedAuthorPort {
  readonly next: () => SharedWriterAuthor | null;
}

export function sharedAuthorPort(source: { readonly handle: () => SharedDocumentHandle | null; readonly name: () => string }): SharedAuthorPort {
  let serial = 0;
  return {
    next: () => {
      const handle = source.handle();
      return handle ? { id: "w" + String(collabState(handle).doc.clientID) + "_" + String(++serial), by: source.name() } : null;
    }
  };
}

export function sharedListPorts(handle: SharedDocumentHandle, author: SharedAuthorPort, stamps: StampPorts): SharedListPorts {
  return {
    author: () => {
      const next = author.next();
      if (!next) throw new Error("A shared list needs the shared session's author");
      return next;
    },
    beatStamp: (beat, by) => sharedBeatStamp(flowIdentity(beat), by, stamps),
    statusParents: beat => readSharedStatusHeads(handle, { scope: "beat", record: flowIdentity(beat) })
  };
}
