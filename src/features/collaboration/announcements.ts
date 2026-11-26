import { accessRemovedMessage, PASSWORD_RECOVERY_UNREACHABLE } from "../../application/collaboration/state.ts";
import type { CollaborationSnapshot } from "../../application/collaboration/state.ts";
import type { CollaborationAnnouncementsPorts } from "./ports.ts";

export function announceCollaboration(document: Document, message: string): void {
  const region = document.getElementById("collaboration-announcements");
  if (region) region.textContent = message;
}

function connection(snapshot: CollaborationSnapshot) {
  return snapshot.relay.connected && snapshot.relay.firstSyncDone;
}

export function mountCollaborationAnnouncements(document: Document, { collaboration }: CollaborationAnnouncementsPorts): () => void {
  const region = document.createElement("div");
  region.id = "collaboration-announcements";
  region.className = "busy-bar-label";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  document.body.append(region);
  let previous = collaboration.snapshot();
  let interrupted = false;
  const unsubscribe = collaboration.onChange(snapshot => {
    const wasOnline = connection(previous);
    const online = connection(snapshot);
    if (!snapshot.active) interrupted = false;
    else if (snapshot.refusal && snapshot.refusal !== previous.refusal) {
      interrupted = true;
      region.textContent = snapshot.refusal === "password-changed"
        ? "The link password changed. Re-enter it to reconnect."
        : snapshot.refusal === "device-credential-expired" ? accessRemovedMessage(snapshot.refusal)
          : "Access removed. Your local copy is kept on this device.";
    } else if (snapshot.passwordRecoveryCheck === "retryable" && previous.passwordRecoveryCheck !== "retryable") {
      interrupted = true;
      region.textContent = PASSWORD_RECOVERY_UNREACHABLE;
    } else if (wasOnline && !online && !snapshot.mergeTooLarge) {
      interrupted = true;
      region.textContent = "Offline. Your changes are kept on this device.";
    } else if (online && interrupted) {
      interrupted = false;
      region.textContent = "Reconnected to the shared script.";
    }
    previous = snapshot;
  });
  return () => { unsubscribe(); region.remove(); };
}
