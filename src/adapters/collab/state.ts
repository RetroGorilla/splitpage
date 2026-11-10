import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { declareCollabRoots } from "./roots.ts";

export class CollabDocumentState {
  readonly doc = new Y.Doc();
  readonly roots = declareCollabRoots(this.doc);
  fresh = true;
}

export function collabState(handle: SharedDocumentHandle): CollabDocumentState {
  if (!(handle instanceof CollabDocumentState)) throw new Error("Expected a shared document handle");
  return handle;
}
