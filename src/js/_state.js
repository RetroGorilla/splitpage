import { currentDocument } from "../legacy/session-bridge.ts";

export const S = {
  docIdWrittenOut: undefined,

  serverBookmarks: undefined,

  serverMode: undefined,

  get state() { return currentDocument(); },

  set state(doc) { throw new TypeError("The document is read-only here: the document session holds it"); }
};
