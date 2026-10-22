import { currentDocument } from "../legacy/session-bridge.ts";
import { documentView } from "../legacy/document-guard.ts";

export const S = {
  DESKTOP: undefined,

  docIdWrittenOut: undefined,

  serverBookmarks: undefined,

  serverMode: undefined,

  get state() { return documentView(currentDocument()); },

  set state(doc) { throw new TypeError("S.state is read-only: the document session holds the document"); }
};
