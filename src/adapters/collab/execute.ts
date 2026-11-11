import * as Y from "yjs";
import type { SharedOperation } from "../../core/collab/operations.ts";
import { readOperation } from "../../core/collab/read-operation.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, transactCollabState } from "./state.ts";
import { withSharedSnapshot } from "./snapshot.ts";
import { registeredSharedOperationHandlers } from "./operation-handlers.ts";
import { scalarHandlers } from "./scalar-executor.ts";

export type SharedExecutionResult = { readonly ok: true } | {
  readonly ok: false; readonly index: number; readonly operation: SharedOperation; readonly reason: string;
};

export function executeSharedOperations(handle: SharedDocumentHandle, operations: readonly SharedOperation[]): SharedExecutionResult {
  const handlers = { ...scalarHandlers, ...registeredSharedOperationHandlers(handle) };
  return withSharedSnapshot(handle, trial => {
    const vector = Y.encodeStateVector(trial.doc);
    let index = 0;
    for (const operation of operations) {
      const validated = readOperation(operation);
      const handler = validated && handlers[validated.kind] as ((handle: SharedDocumentHandle, operation: SharedOperation) => string | null) | undefined;
      if (!validated || !handler) return { ok: false, index, operation, reason: validated ? "unhandled-kind" : "invalid-operation" };
      let reason: string | null;
      try { reason = handler(trial as unknown as SharedDocumentHandle, validated); }
      catch { reason = "invalid-target-shape"; }
      if (reason !== null) return { ok: false, index, operation, reason };
      index++;
    }
    if (operations.length) {
      const update = Y.encodeStateAsUpdate(trial.doc, vector);
      // why: Yjs transactions cannot roll back; only a fully accepted staged update reaches the live document.
      transactCollabState(collabState(handle), "local-command", () => Y.applyUpdate(collabState(handle).doc, update));
    }
    return { ok: true };
  });
}
