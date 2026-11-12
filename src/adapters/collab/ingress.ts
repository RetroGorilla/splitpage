import type { SharedDocumentHandle } from "./types.ts";
import { assertNoSharedExecution, collabState, guardSharedCallback, sharedWriteFrame } from "./state.ts";

export function holdSharedBuffer(handle: SharedDocumentHandle): () => void {
  const state = collabState(handle), gate = state.ingress;
  assertNoSharedExecution(state);
  if (gate.holds.has("buffer")) throw new Error("A shared buffer is already open");
  gate.holds.add("buffer");
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    if (!gate.holds.delete("buffer")) return;
    const declined = gate.declined;
    gate.declined = false;
    sharedWriteFrame(state, () => {
      if (declined) for (const listener of gate.declineListeners) guardSharedCallback(state, listener);
    });
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
