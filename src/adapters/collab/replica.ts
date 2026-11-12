import type { ReplicaPort } from "../../application/session/shared-session.ts";
import { executeSharedOperations } from "./execute.ts";
import { createSharedIncrementalProjector } from "./incremental-project.ts";
import type { SharedProjectionWork } from "./projection-cache.ts";
import type { SharedDocumentHandle } from "./types.ts";

export interface SharedReplica extends ReplicaPort {
  readonly dispose: () => void;
}

export function createSharedReplica(handle: SharedDocumentHandle, count?: (work: SharedProjectionWork, key: string) => void): SharedReplica {
  const projector = createSharedIncrementalProjector(handle, count);
  return Object.freeze({
    revision: () => projector.read().revision,
    project: () => projector.read().document,
    changes: () => projector.read().changes,
    execute: (operations: Parameters<ReplicaPort["execute"]>[0], options: Parameters<ReplicaPort["execute"]>[1]) => executeSharedOperations(handle, operations, options),
    observe: (listener: Parameters<ReplicaPort["observe"]>[0]) => projector.observe((_projection, origin) => listener(origin)),
    dispose: projector.dispose
  });
}
