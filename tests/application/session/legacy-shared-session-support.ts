import type { ReplicaPort } from "../../../src/application/session/shared-session.ts";
import type { SharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

export function adapterReplica(handle: SharedDocumentHandle, undo?: Pick<SharedUndo, "perform">): ReplicaPort {
  return createSharedReplica(handle, undefined, undo);
}

export function registerSplits(handle: SharedDocumentHandle): void {
  registerSharedSplitHandlers(handle, { cells: createFlowLoadRuntime().cells });
}
