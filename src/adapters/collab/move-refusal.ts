import type { SharedCommandPermission } from "../../core/collab/refusals.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import type { SharedDocumentHandle } from "./types.ts";

export function registerSharedMoveRefusal(handle: SharedDocumentHandle): void {
  const reason = "move-in-shared-session" satisfies SharedCommandPermission;
  registerSharedOperationHandlers(handle, { "segment-move": () => ({ ok: false, reason }) });
}
