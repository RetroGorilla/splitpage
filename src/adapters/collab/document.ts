import * as Y from "yjs";
import { CollabDocumentState, collabState, transactCollabState, assertNoSharedExecution, guardSharedCallback } from "./state.ts";
import type { SharedDocumentHandle, SharedTransactionOrigin, SharedApplyResult } from "./types.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";

export function createSharedDocument(): SharedDocumentHandle {
  const handle = new CollabDocumentState() as unknown as SharedDocumentHandle;
  observeSharedStructureIndex(handle); return handle;
}

export function shouldDeliverSharedUpdate(origin: SharedTransactionOrigin | null): boolean { return origin !== "remote"; }
export function readSharedRevision(handle: SharedDocumentHandle): number { return collabState(handle).revision; }

export function transactSharedDocument(handle: SharedDocumentHandle, origin: Exclude<SharedTransactionOrigin, "cleanup">, change: () => void): void {
  const state = collabState(handle);
  transactCollabState(state, origin, change);
}

function namedOrigin(origin: unknown): SharedTransactionOrigin | null {
  return origin === "local-command" || origin === "local-undo" || origin === "hydration" || origin === "remote" || origin === "cleanup" ? origin : null;
}

export function observeSharedTransactions(handle: SharedDocumentHandle, listener: (origin: SharedTransactionOrigin | null) => void): () => void {
  const state = collabState(handle);
  const receive = (transaction: Y.Transaction): void => guardSharedCallback(state, () => listener(namedOrigin(transaction.origin)));
  state.doc.on("afterTransaction", receive);
  return () => state.doc.off("afterTransaction", receive);
}

export function observeSharedUpdates(handle: SharedDocumentHandle, listener: (update: Uint8Array, origin: SharedTransactionOrigin | null) => void): () => void {
  const state = collabState(handle);
  const receive = (update: Uint8Array, origin: unknown): void => guardSharedCallback(state, () => listener(update, namedOrigin(origin)));
  state.doc.on("update", receive);
  return () => state.doc.off("update", receive);
}

export function encodeSharedState(handle: SharedDocumentHandle): Uint8Array {
  return Y.encodeStateAsUpdate(collabState(handle).doc);
}

export function encodeSharedStateVector(handle: SharedDocumentHandle): Uint8Array {
  return Y.encodeStateVector(collabState(handle).doc);
}

export function encodeSharedUpdate(handle: SharedDocumentHandle, vector: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(collabState(handle).doc, vector);
}

export function applySharedUpdate(handle: SharedDocumentHandle, update: Uint8Array): SharedApplyResult {
  const state = collabState(handle), gate = state.ingress;
  const closed = gate.holds.size > 0 || gate.frames > 0 && !state.execution;
  if (!closed) assertNoSharedExecution(state);
  const trial = new CollabDocumentState();
  try {
    const decoded = Y.decodeUpdate(update);
    if (decoded.structs.some(struct => struct.length <= 0)) return { ok: false, reason: "invalid-update" };
    Y.applyUpdate(trial.doc, Y.encodeStateAsUpdate(state.doc));
    Y.applyUpdate(trial.doc, update);
  } catch {
    return { ok: false, reason: "invalid-update" };
  } finally {
    trial.doc.destroy();
  }
  // why: While the gate is closed the update waits its turn, so each revision is announced with exactly its own content.
  if (closed) gate.held.push(Uint8Array.from(update));
  else transactCollabState(state, "remote", () => Y.applyUpdate(state.doc, update, "remote"));
  return { ok: true };
}

export function destroySharedDocument(handle: SharedDocumentHandle): void {
  const state = collabState(handle);
  assertNoSharedExecution(state);
  state.ingress.held.length = 0;
  state.ingress.holds.clear();
  state.doc.destroy();
}
