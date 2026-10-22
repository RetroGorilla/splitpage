import { currentDocument } from "../legacy/session-bridge.ts";
import { documentView } from "../legacy/document-guard.ts";

export const S = {
  DESKTOP: undefined,

  docIdWrittenOut: undefined,

  serverBookmarks: undefined,

  serverMode: undefined,

  get state() { return documentView(currentDocument()); },

  set state(doc) { throw new TypeError("The document is read-only here: the document session holds it"); }
};
