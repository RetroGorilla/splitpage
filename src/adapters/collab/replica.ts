import type { ReplicaExecution, ReplicaPort } from "../../application/session/shared-session.ts";
import type { SharedUndo } from "../../application/editing/undo/shared-undo.ts";
import { executeSharedOperations } from "./execute.ts";
import { executeSharedCommand } from "./undo-executor.ts";
import type { SharedUndoRecord } from "../../core/collab/undo-record.ts";
import { createSharedIncrementalProjector } from "./incremental-project.ts";
import type { SharedProjectionWork } from "./projection-cache.ts";
import type { SharedDocumentHandle } from "./types.ts";

export interface SharedReplica extends ReplicaPort {
  readonly dispose: () => void;
}

export const REPLICA_DISPOSED = "replica-disposed";

export function createSharedReplica(handle: SharedDocumentHandle, count?: (work: SharedProjectionWork, key: string) => void,
  undo?: Pick<SharedUndo, "perform">): SharedReplica {
  const projector = createSharedIncrementalProjector(handle, count);
  let disposed = false;
  // why: After a failed publication the pair is the revision being retried and a fresh attempt at its document,
  // never the live revision beside the older document.
  const published = () => projector.pending() === null ? projector.read() : projector.retry();
  const execute: ReplicaPort["execute"] = (operations, options) => {
    if (disposed) return { ok: false, reason: REPLICA_DISPOSED };
    const description = options.description;
    if (!undo || !description) return executeSharedOperations(handle, operations, { base: options.base });
    let result: ReplicaExecution = { ok: false, reason: "undo-not-run" };
    const failed: { thrown: boolean; error: unknown } = { thrown: false, error: undefined };
    // why: a document callback that throws after the commit is rethrown by the write frame; the record is taken first
    undo.perform(() => {
      let kept: SharedUndoRecord | null = null;
      try {
        executeSharedCommand(handle, operations, description, { base: options.base, done: done => {
          result = done.result;
          kept = done.result.ok ? done.record : null;
        } });
      } catch (error) { failed.thrown = true; failed.error = error; }
      return kept;
    });
    if (failed.thrown) throw failed.error;
    return result;
  };
  return Object.freeze({
    revision: () => projector.pending() ?? projector.read().revision,
    project: () => published().document,
    changes: () => published().changes,
    recovery: () => published().recovery,
    execute: execute,
    observe: (listener: Parameters<ReplicaPort["observe"]>[0]) =>
      projector.observe((_projection, origin) => listener(origin), (error, origin) => listener(origin, { error })),
    dispose: () => { disposed = true; projector.dispose(); }
  });
}
