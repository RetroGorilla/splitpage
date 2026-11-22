import type { SharedAuthorPort } from "../../bootstrap/legacy-shared-switch-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";


export function sharedAuthorPort(source: { readonly handle: () => SharedDocumentHandle | null; readonly name: () => string }): SharedAuthorPort {
  let serial = 0;
  return {
    next: () => {
      const handle = source.handle();
      return handle ? { id: "w" + String(collabState(handle).doc.clientID) + "_" + String(++serial), by: source.name() } : null;
    }
  };
}
