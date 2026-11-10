import * as Y from "yjs";
import type { SharedDocumentHandle, SharedTransactionOrigin } from "./types.ts";
import { declareCollabRoots } from "./roots.ts";

export class CollabDocumentState {
  readonly doc = new Y.Doc();
  readonly roots = declareCollabRoots(this.doc);
  fresh = true;
  activeOrigin: SharedTransactionOrigin | null = null;

  constructor() {
    this.doc.on("beforeTransaction", transaction => {
      // why: Native cleanup creates local deletes that must be delivered even when a received update triggered them.
      if (transaction.origin === null && this.activeOrigin !== null) transaction.origin = "cleanup";
    });
  }
}

export function withSharedOrigin(state: CollabDocumentState, origin: SharedTransactionOrigin, change: () => void): void {
  const previous = state.activeOrigin;
  state.activeOrigin = origin;
  try { change(); }
  finally { state.activeOrigin = previous; }
}

export function collabState(handle: SharedDocumentHandle): CollabDocumentState {
  if (!(handle instanceof CollabDocumentState)) throw new Error("Expected a shared document handle");
  return handle;
}
