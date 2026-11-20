import type * as Y from "yjs";
import { NativeScriptReader } from "./reader.ts";
import type { NativeWatch } from "./reader.ts";
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

interface DocumentState { open: boolean; destroyed: boolean; readonly handles: Set<() => void>; readonly failures: unknown[] }

const DOCUMENTS = new WeakMap<Y.Doc, DocumentState>();

// why: a throw inside the library's cleanup would surface from a transaction that already committed;
// it is kept and thrown by the next command before that command writes anything
function guardSharedCallback(state: DocumentState, call: () => void): void {
  try { call(); } catch (error) {
    if (!state.open) throw error;
    state.failures.push(error);
  }
}

// why: the transaction state belongs to the document, so a handle opened during a transaction still sees it
function documentState(doc: Y.Doc): DocumentState {
  const known = DOCUMENTS.get(doc);
  if (known) return known;
  const state: DocumentState = { open: false, destroyed: false, handles: new Set(), failures: [] };
  DOCUMENTS.set(doc, state);
  doc.on("beforeAllTransactions", () => guardSharedCallback(state, () => { state.open = true; }));
  doc.on("afterAllTransactions", () => guardSharedCallback(state, () => { state.open = false; }));
  doc.on("destroy", () => guardSharedCallback(state, () => {
    state.destroyed = true;
    for (const close of [...state.handles]) close();
  }));
  return state;
}

export function throwNativeFailures(script: NativeScript): void {
  const failures = DOCUMENTS.get(script.doc)?.failures.splice(0) ?? [];
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Callbacks of the shared script failed");
}

export function openNativeScript(doc: Y.Doc): NativeScript {
  const state = documentState(doc), roots = declareNativeRoots(doc);
  const watch: NativeWatch = (type, listener) => {
    const guarded: typeof listener = events => guardSharedCallback(state, () => listener(events));
    type.observeDeep(guarded);
    return () => { type.unobserveDeep(guarded); };
  };
  const reader = new NativeScriptReader(roots, watch);
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
