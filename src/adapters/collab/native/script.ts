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
  readonly guardSharedCallback: (call: () => void) => void;
  readonly sizeRefusal?: (adds?: boolean) => "full" | null;
  readonly prepareWrite?: () => void;
}

interface PressObservation { readonly origin: object; changed: boolean }

interface DocumentState { press: PressObservation | null; open: boolean; commanding: boolean; destroyed: boolean; readonly handles: Set<() => void>; readonly failures: unknown[] }

const DOCUMENTS = new WeakMap<Y.Doc, DocumentState>();

// why: a throw inside the library's cleanup would surface from a transaction that already committed;
// it is kept and thrown by the next command before that command writes anything
function guardSharedCallback(state: DocumentState, call: () => void): void {
  try { call(); } catch (error) {
    if (!state.open && !state.commanding) throw error;
    state.failures.push(error);
  }
}

// why: the transaction state belongs to the document, so a handle opened during a transaction still sees it
function documentState(doc: Y.Doc): DocumentState {
  const known = DOCUMENTS.get(doc);
  if (known) return known;
  const state: DocumentState = { press: null, open: false, commanding: false, destroyed: false, handles: new Set(), failures: [] };
  DOCUMENTS.set(doc, state);
  doc.on("beforeAllTransactions", () => guardSharedCallback(state, () => { state.open = true; }));
  doc.on("afterAllTransactions", (_, transactions) => guardSharedCallback(state, () => {
    const press = state.press;
    // why: the completed transaction carries the same clock and deletion changes Yjs uses to emit an update
    if (press && !press.changed) press.changed = transactions.some(transaction => transaction.origin === press.origin && (
      transaction.deleteSet.clients.size > 0 || [...transaction.afterState].some(([client, clock]) => transaction.beforeState.get(client) !== clock)
    ));
    state.open = false;
  }));
  doc.on("destroy", () => guardSharedCallback(state, () => {
    state.destroyed = true;
    for (const close of [...state.handles]) close();
  }));
  return state;
}

export function withNativeCommand<T>(script: NativeScript, run: () => T): T {
  const state = documentState(script.doc);
  state.commanding = true;
  try { return run(); } finally { state.commanding = false; }
}

export function observeNativePress<T>(script: NativeScript, origin: object, run: () => T): { result: T; changed: boolean } {
  const state = documentState(script.doc), press = { origin, changed: false };
  state.press = press;
  try {
    const result = withNativeCommand(script, run);
    return { result, changed: press.changed };
  } finally { state.press = null; }
}

export function transactNativeCommand<T>(script: NativeScript, run: () => T, origin: unknown = script.origin): T {
  return withNativeCommand(script, () => {
    script.prepareWrite?.();
    return script.doc.transact(run, origin);
  });
}

export function transactPreparedNativeCommand<Input, Result>(
  script: NativeScript,
  prepare: () => Input,
  write: (input: Input) => Result,
  refuse: (reason: "full") => Result,
  adds?: (input: Input) => boolean
): Result {
  const admit = script.sizeRefusal;
  if (!admit) return transactNativeCommand(script, () => write(prepare()));
  return withNativeCommand(script, () => {
    const input = prepare(), reason = admit(adds?.(input));
    if (reason) return refuse(reason);
    script.prepareWrite?.();
    return script.doc.transact(() => write(input), script.origin);
  });
}

export function throwNativeFailures(script: NativeScript): void {
  const failures = DOCUMENTS.get(script.doc)?.failures.splice(0) ?? [];
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Callbacks of the shared script failed");
}

export function nativeCallbackGuard(doc: Y.Doc): NativeScript["guardSharedCallback"] {
  const state = documentState(doc);
  return call => guardSharedCallback(state, call);
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
  return Object.freeze({
    doc, roots, reader, origin: Object.freeze({ script: doc.guid }),
    busy: () => state.commanding || (state.open && !state.destroyed), closed: () => closed, close,
    guardSharedCallback: (call: () => void) => guardSharedCallback(state, call)
  });
}

export function closeNativeScript(script: NativeScript): void {
  script.close();
}
