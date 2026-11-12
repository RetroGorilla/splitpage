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

export function observeSharedDeclined(handle: SharedDocumentHandle, listener: () => void): () => void {
  const gate = collabState(handle).ingress;
  gate.declineListeners.add(listener);
  return () => { gate.declineListeners.delete(listener); };
}

export function sharedBufferDeliveryBusy(handle: SharedDocumentHandle): boolean {
  const state = collabState(handle);
  return state.ingress.frames > 0 || state.ingress.holds.has("delivering");
}
