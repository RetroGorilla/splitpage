import type { SharedStructureContentPorts } from "./structure-content.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { registerSharedTextOperationHandlers } from "./text-executor.ts";
import { registerSharedRecordHandlers } from "./record-executor.ts";
import { registerSharedSplitHandlers } from "./split-executor.ts";
import { registerSharedRemovalHandlers } from "./removal-executor.ts";
import { registerSharedJoinHandlers } from "./join-executor.ts";
import { registerSharedHeadingHandlers } from "./heading-executor.ts";
import { registerSharedMoveRefusal } from "./move-refusal.ts";
import { registerSharedUndoOperationHandlers } from "./undo-handlers.ts";

export function registerSharedOperationFamilies(handle: SharedDocumentHandle, ports: SharedStructureContentPorts): void {
  registerSharedTextOperationHandlers(handle);
  registerSharedRecordHandlers(handle);
  registerSharedSplitHandlers(handle, ports);
  registerSharedRemovalHandlers(handle);
  registerSharedJoinHandlers(handle);
  registerSharedHeadingHandlers(handle);
  registerSharedMoveRefusal(handle);
  registerSharedUndoOperationHandlers(handle);
}
