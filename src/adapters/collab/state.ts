import * as Y from "yjs";
import type { SharedDocumentHandle, SharedTransactionOrigin } from "./types.ts";
import { declareCollabRoots } from "./roots.ts";
import { CollabReadCaches } from "./read-cache.ts";

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

export class CollabDocumentState {
  readonly doc = new Y.Doc();
  readonly roots = declareCollabRoots(this.doc);
  fresh = true;
  revision = 0;
  readonly adapterTransactions = new WeakSet<Y.Transaction>();
  readonly hydrationTransactions = new WeakSet<Y.Transaction>();
  hydrating = false;
  readonly pendingTickets = new Map<object, Exclude<SharedTransactionOrigin, "cleanup">>();
  adapterBatch = false;
  execution: { applying: boolean } | null = null;

  readonly reads = new CollabReadCaches();

  constructor() {
    this.doc.on("beforeTransaction", () => { this.reads.begin(); });
    this.doc.on("beforeObserverCalls", transaction => {
      this.reads.settle(transaction.changed);
      if (transaction.changed.size || transaction.deleteSet.clients.size || transaction.beforeState.size !== transaction.afterState.size
        || [...transaction.beforeState].some(([client, clock]) => transaction.afterState.get(client) !== clock)) this.revision++;
      if (this.adapterTransactions.has(transaction)) this.adapterBatch = true;
      // why: The completed delete set distinguishes native formatting maintenance from ordinary observer writes.
      if (this.adapterBatch && transaction.origin === null && transaction.local && formattingCleanup(transaction)) transaction.origin = "cleanup";
    });
    this.doc.on("afterAllTransactions", () => { this.adapterBatch = false; });
  }
}

export class SharedExecutionWriteError extends Error {
  constructor() { super("Shared document writes cannot reenter operation execution"); }
}

export function assertSharedDocumentIdle(state: CollabDocumentState): void {
  if (state.execution) throw new SharedExecutionWriteError();
}

export function transactCollabState(state: CollabDocumentState, origin: Exclude<SharedTransactionOrigin, "cleanup">, change: () => void, execution?: object): void {
  if (state.execution && state.execution !== execution) throw new SharedExecutionWriteError();
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
      try { change(); } finally { state.hydrating = previous; }
    }, ticket);
  } finally { state.pendingTickets.delete(ticket); }
}

export function collabState(handle: SharedDocumentHandle): CollabDocumentState {
  if (!(handle instanceof CollabDocumentState)) throw new Error("Expected a shared document handle");
  return handle;
}
