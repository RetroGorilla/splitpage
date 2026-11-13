import { collabState } from "../../../adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";

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
