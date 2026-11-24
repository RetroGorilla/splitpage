import { createCollaborationState, IDLE_COLLABORATION_SNAPSHOT } from "../../application/collaboration/state.ts";
import type { CollaborationSnapshot, CollaborationState } from "../../application/collaboration/state.ts";

let owner: CollaborationState | null = null;
let retryLocalWrite: (() => Promise<void>) | null = null;

export function collaborationState(): CollaborationState {
  owner ??= createCollaborationState();
  return owner;
}

export function collaborationSnapshot(): CollaborationSnapshot {
  return owner ? owner.snapshot() : IDLE_COLLABORATION_SNAPSHOT;
}

export function onCollaborationChange(listener: (snapshot: CollaborationSnapshot) => void): () => void {
  return collaborationState().onChange(listener);
}

export function setSharedRetryLocalWrite(retry: (() => Promise<void>) | null): void {
  retryLocalWrite = retry;
}

export function retrySharedLocalWrite(): Promise<void> {
  return retryLocalWrite ? retryLocalWrite() : Promise.resolve();
}

export function stopCollaborationOwner(): void {
  retryLocalWrite = null;
  owner?.leave();
}
