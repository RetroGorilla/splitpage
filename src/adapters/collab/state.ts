import * as Y from "yjs";
import type { SharedDocumentHandle, SharedTransactionOrigin } from "./types.ts";
import { declareCollabRoots } from "./roots.ts";

function formattingCleanup(transaction: Y.Transaction): boolean {
  if (transaction.beforeState.size !== transaction.afterState.size) return false;
  for (const [client, clock] of transaction.beforeState) if (transaction.afterState.get(client) !== clock) return false;
  let deleted = false, formatsOnly = true;
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, item => {
    deleted = true;
    if (!(item instanceof Y.Item) || !(item.content instanceof Y.ContentFormat)) formatsOnly = false;
  });
  return deleted && formatsOnly;
}

export type IngressHold = "delivering" | "buffer";

export class IngressGate {
  readonly holds = new Set<IngressHold>();
  readonly held: Uint8Array[] = [];
  readonly errors: unknown[] = [];
  heldBytes = 0;
  declined = false;
  declinedReports = 0;
  readonly declineListeners = new Set<() => void>();
  frames = 0;
  notifications = 0;
}

export class CollabDocumentState {
  readonly doc = new Y.Doc();
  readonly roots = declareCollabRoots(this.doc);
  fresh = true;
  destroyed = false;
  revision = 0;
  readonly adapterTransactions = new WeakSet<Y.Transaction>();
  readonly hydrationTransactions = new WeakSet<Y.Transaction>();
  hydrating = false;
  readonly pendingTickets = new Map<object, Exclude<SharedTransactionOrigin, "cleanup">>();
  adapterBatch = false;
  execution: { applying: boolean } | null = null;
  readonly ingress = new IngressGate();

  constructor() {
    this.doc.on("beforeObserverCalls", transaction => guardSharedCallback(this, () => {
      if (this.ingress.frames) this.ingress.holds.add("delivering");
      if (transaction.changed.size || transaction.deleteSet.clients.size || transaction.beforeState.size !== transaction.afterState.size
        || [...transaction.beforeState].some(([client, clock]) => transaction.afterState.get(client) !== clock)) this.revision++;
      if (this.adapterTransactions.has(transaction)) this.adapterBatch = true;
      // why: The completed delete set distinguishes native formatting maintenance from ordinary observer writes.
      if (this.adapterBatch && transaction.origin === null && transaction.local && formattingCleanup(transaction)) transaction.origin = "cleanup";
    }));
    this.doc.on("afterAllTransactions", () => guardSharedCallback(this, () => { this.adapterBatch = false; }));
  }
}

export class SharedExecutionWriteError extends Error {
  constructor() { super("Shared document writes cannot reenter operation execution"); }
}

export function assertNoSharedExecution(state: CollabDocumentState): void {
  if (state.execution) throw new SharedExecutionWriteError();
}

export function assertSharedIngressAllowed(state: CollabDocumentState): void {
  if (state.execution && (state.execution.applying || !state.ingress.notifications)) throw new SharedExecutionWriteError();
}

export function assertSharedDocumentIdle(state: CollabDocumentState, execution?: object): void {
  if (state.execution && state.execution !== execution || state.ingress.holds.has("delivering")) throw new SharedExecutionWriteError();
}

// why: A throw inside the library's cleanup would abort it; the error is kept and thrown after the drain.
export function guardSharedCallback(state: CollabDocumentState, call: () => void): void {
  const gate = state.ingress;
  gate.notifications++;
  try {
    try { call(); } catch (error) {
      if (!gate.frames) throw error;
      gate.errors.push(error);
    }
  } finally { gate.notifications--; }
}

function settleIngress(state: CollabDocumentState): void {
  const gate = state.ingress;
  try {
    for (;;) {
      gate.holds.delete("delivering");
      if (gate.holds.size) return;
      const next = gate.held[0];
      if (!next) {
        if (!gate.declinedReports) return;
        gate.declinedReports--;
        gate.holds.add("delivering");
        for (const listener of gate.declineListeners) guardSharedCallback(state, listener);
        continue;
      }
      gate.holds.add("delivering");
      try { runCollabTransaction(state, "remote", () => Y.applyUpdate(state.doc, next, "remote")); }
      catch (error) { gate.errors.push(error); }
      if (gate.held[0] === next) { gate.held.shift(); gate.heldBytes -= next.byteLength; }
    }
  } finally { gate.holds.delete("delivering"); }
}

// why: The outermost adapter write owns the end of its notifications: the gate opens and the held updates apply here.
export function sharedWriteFrame<T>(state: CollabDocumentState, write: (recordFailure: (error: unknown) => void) => T): T {
  const gate = state.ingress;
  if (gate.frames) {
    gate.frames++;
    try { return write(() => {}); } finally { gate.frames--; }
  }
  let result: { value: T } | null = null;
  const failure = { recorded: false, error: undefined as unknown };
  const recordFailure = (error: unknown): void => { failure.recorded = true; failure.error = error; gate.errors.push(error); };
  gate.frames = 1;
  try {
    try { result = { value: write(recordFailure) }; }
    catch (error) { if (!failure.recorded || !Object.is(failure.error, error)) gate.errors.push(error); }
    settleIngress(state);
  } finally { gate.frames = 0; }
  const errors = gate.errors.splice(0);
  if (errors.length > 1) throw new AggregateError(errors, "Shared document callbacks failed");
  if (errors.length || !result) throw errors[0];
  return result.value;
}

function runCollabTransaction(state: CollabDocumentState, origin: Exclude<SharedTransactionOrigin, "cleanup">, change: () => void, recordFailure?: (error: unknown) => void): void {
  const requested: unknown = origin;
  if (requested === "cleanup") throw new Error("Cleanup origin is assigned only to checked formatting maintenance");
  const ticket = {};
  state.pendingTickets.set(ticket, origin);
  try {
    state.doc.transact(transaction => {
      const pendingOrigin = state.pendingTickets.get(transaction.origin as object);
      if (pendingOrigin !== undefined) {
        transaction.origin = pendingOrigin;
        state.adapterTransactions.add(transaction);
      } else if (!state.adapterTransactions.has(transaction)) {
        throw new Error("Shared adapter calls cannot run inside an external transaction");
      }
      // why: Early nested callbacks retain the first hydration identity; a later hydration label cannot claim it.
      if (transaction.origin === "hydration" && state.fresh && Y.encodeStateAsUpdate(state.doc).length === 2) state.hydrationTransactions.add(transaction);
      state.fresh = false;
      const previous = state.hydrating;
      state.hydrating = state.hydrationTransactions.has(transaction);
      try { change(); }
      catch (error) { recordFailure?.(error); throw error; }
      finally { state.hydrating = previous; }
    }, ticket);
  } finally { state.pendingTickets.delete(ticket); }
}

export function transactCollabState(state: CollabDocumentState, origin: Exclude<SharedTransactionOrigin, "cleanup">, change: () => void, execution?: object): void {
  assertSharedDocumentIdle(state, execution);
  sharedWriteFrame(state, recordFailure => runCollabTransaction(state, origin, change, recordFailure));
}

export function collabState(handle: SharedDocumentHandle): CollabDocumentState {
  if (!(handle instanceof CollabDocumentState)) throw new Error("Expected a shared document handle");
  return handle;
}
