import type { ReplicaPort } from "../../application/session/shared-session.ts";
import { executeSharedOperations } from "./execute.ts";
import { createSharedIncrementalProjector } from "./incremental-project.ts";
import type { SharedProjectionWork } from "./projection-cache.ts";
import type { SharedDocumentHandle } from "./types.ts";

export interface SharedReplica extends ReplicaPort {
  readonly dispose: () => void;
}

export const REPLICA_DISPOSED = "replica-disposed";

export function createSharedReplica(handle: SharedDocumentHandle, count?: (work: SharedProjectionWork, key: string) => void): SharedReplica {
  const projector = createSharedIncrementalProjector(handle, count);
  let disposed = false;
  // why: After a failed publication the pair is the revision being retried and a fresh attempt at its document,
  // never the live revision beside the older document.
  const published = () => projector.pending() === null ? projector.read() : projector.retry();
  return Object.freeze({
    revision: () => projector.pending() ?? projector.read().revision,
    project: () => published().document,
    changes: () => published().changes,
    recovery: () => published().recovery,
    execute: (operations: Parameters<ReplicaPort["execute"]>[0], options: Parameters<ReplicaPort["execute"]>[1]) =>
      disposed ? { ok: false as const, reason: REPLICA_DISPOSED } : executeSharedOperations(handle, operations, options),
    observe: (listener: Parameters<ReplicaPort["observe"]>[0]) =>
      projector.observe((_projection, origin) => listener(origin), (error, origin) => listener(origin, { error })),
    dispose: () => { disposed = true; projector.dispose(); }
  });
}
