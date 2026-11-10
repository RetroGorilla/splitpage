import * as Y from "yjs";
import { CollabDocumentState, collabState } from "./state.ts";
import type { SharedDocumentHandle, SharedTransactionOrigin, SharedApplyResult } from "./types.ts";

export function createSharedDocument(): SharedDocumentHandle {
  return new CollabDocumentState() as unknown as SharedDocumentHandle;
}

export function transactSharedDocument(handle: SharedDocumentHandle, origin: SharedTransactionOrigin, change: () => void): void {
  const state = collabState(handle);
  state.fresh = false;
  state.doc.transact(change, origin);
}

export function observeSharedTransactions(handle: SharedDocumentHandle, listener: (origin: SharedTransactionOrigin | null) => void): () => void {
  const state = collabState(handle);
  const receive = (transaction: Y.Transaction): void => {
    const origin: unknown = transaction.origin;
    listener(origin === "local-command" || origin === "local-undo" || origin === "hydration" || origin === "remote" ? origin : null);
  };
  state.doc.on("afterTransaction", receive);
  return () => state.doc.off("afterTransaction", receive);
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
  const state = collabState(handle);
  const trial = new CollabDocumentState();
  try {
    Y.decodeUpdate(update);
    Y.applyUpdate(trial.doc, Y.encodeStateAsUpdate(state.doc));
    Y.applyUpdate(trial.doc, update);
  } catch {
    return { ok: false, reason: "invalid-update" };
  } finally {
    trial.doc.destroy();
  }
  state.fresh = false;
  Y.applyUpdate(state.doc, update, "remote");
  return { ok: true };
}

export function destroySharedDocument(handle: SharedDocumentHandle): void {
  collabState(handle).doc.destroy();
}
