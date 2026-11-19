import type * as Y from "yjs";
import { NativeScriptReader } from "./reader.ts";
import { declareNativeRoots } from "./roots.ts";
import type { NativeRoots } from "./roots.ts";

export interface NativeScript {
  readonly doc: Y.Doc;
  readonly roots: NativeRoots;
  readonly reader: NativeScriptReader;
  readonly origin: object;
  readonly busy: () => boolean;
  readonly closed: () => boolean;
  readonly close: () => void;
}

interface DocumentState { open: boolean; destroyed: boolean; readonly handles: Set<() => void> }

const DOCUMENTS = new WeakMap<Y.Doc, DocumentState>();

// why: the transaction state belongs to the document, so a handle opened during a transaction still sees it
function documentState(doc: Y.Doc): DocumentState {
  const known = DOCUMENTS.get(doc);
  if (known) return known;
  const state: DocumentState = { open: false, destroyed: false, handles: new Set() };
  DOCUMENTS.set(doc, state);
  doc.on("beforeAllTransactions", () => { state.open = true; });
  doc.on("afterAllTransactions", () => { state.open = false; });
  doc.on("destroy", () => {
    state.destroyed = true;
    for (const close of [...state.handles]) close();
  });
  return state;
}

export function openNativeScript(doc: Y.Doc): NativeScript {
  const state = documentState(doc), roots = declareNativeRoots(doc), reader = new NativeScriptReader(roots);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    state.handles.delete(close);
    reader.close();
  };
  state.handles.add(close);
  if (state.destroyed) close();
  return Object.freeze({ doc, roots, reader, origin: Object.freeze({ script: doc.guid }), busy: () => state.open, closed: () => closed, close });
}

export function closeNativeScript(script: NativeScript): void {
  script.close();
}
