import type { SharedDocumentHandle } from "./types.ts";
import { assertSharedIngressAllowed, collabState, sharedWriteFrame } from "./state.ts";

export function holdSharedBuffer(handle: SharedDocumentHandle): () => void {
  const state = collabState(handle), gate = state.ingress;
  assertSharedIngressAllowed(state);
  if (state.destroyed) throw new Error("Cannot buffer a destroyed shared document");
  if (gate.holds.has("buffer")) throw new Error("A shared buffer is already open");
  gate.holds.add("buffer");
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    if (!gate.holds.delete("buffer")) return;
    if (gate.declined) gate.declinedReports++;
    gate.declined = false;
    sharedWriteFrame(state, () => {});
  };
}

// why: a Split command reads what its author saw after admission commits the typing and before held updates land
export function holdSharedCapture(handle: SharedDocumentHandle): () => void {
  const state = collabState(handle), gate = state.ingress;
  assertSharedIngressAllowed(state);
  if (state.destroyed) throw new Error("Cannot capture a destroyed shared document");
  if (gate.holds.has("capture")) throw new Error("A shared capture is already open");
  gate.holds.add("capture");
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    if (!gate.holds.delete("capture")) return;
    sharedWriteFrame(state, () => {});
  };
}

export function observeSharedDeclined(handle: SharedDocumentHandle, listener: () => void): () => void {
  const gate = collabState(handle).ingress;
  gate.declineListeners.add(listener);
  return () => { gate.declineListeners.delete(listener); };
}

export function observeSharedIntakeStopped(handle: SharedDocumentHandle, listener: () => void): () => void {
  const gate = collabState(handle).ingress;
  gate.stopListeners.add(listener);
  return () => { gate.stopListeners.delete(listener); };
}

export function sharedIntakeStopped(handle: SharedDocumentHandle): boolean {
  return collabState(handle).trial?.stopped() ?? false;
}

export function sharedBufferDeliveryBusy(handle: SharedDocumentHandle): boolean {
  const state = collabState(handle);
  return state.ingress.frames > 0 || state.ingress.holds.has("delivering");
}
