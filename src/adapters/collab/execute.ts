import type { SharedOperation } from "../../core/collab/operations.ts";
import { readOperation } from "../../core/collab/read-operation.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { assertSharedDocumentIdle, collabState, sharedWriteFrame, transactCollabState, SharedExecutionWriteError } from "./state.ts";
import type { CollabDocumentState } from "./state.ts";
import { createSharedPreparation } from "./prepare.ts";
import type { SharedPreparationResult, SharedPreparationView } from "./prepare.ts";
import { registeredSharedOperationHandlers } from "./operation-handlers.ts";
import { scalarHandlers } from "./scalar-executor.ts";
import { readSharedRevision } from "./document.ts";
import { noteSharedOperationList } from "./operation-list-notes.ts";

export type SharedExecutionResult = { readonly ok: true } | {
  readonly ok: false; readonly index: number; readonly operation: SharedOperation; readonly reason: string;
};

export interface SharedExecutionOptions { readonly base?: number; readonly origin?: "local-command" | "local-undo" }
export type SharedBaseExecutionResult = SharedExecutionResult | { readonly ok: false; readonly reason: "stale-base" };

export function executeSharedOperations(handle: SharedDocumentHandle, operations: readonly SharedOperation[]): SharedExecutionResult;
export function executeSharedOperations(handle: SharedDocumentHandle, operations: readonly SharedOperation[], options?: SharedExecutionOptions): SharedBaseExecutionResult;
export function executeSharedOperations(handle: SharedDocumentHandle, operations: readonly SharedOperation[], options?: SharedExecutionOptions): SharedBaseExecutionResult {
  const state = collabState(handle);
  assertSharedDocumentIdle(state);
  return sharedWriteFrame(state, () => runSharedExecution(state, handle, operations, options));
}

function runSharedExecution(state: CollabDocumentState, handle: SharedDocumentHandle, operations: readonly SharedOperation[], options?: SharedExecutionOptions): SharedBaseExecutionResult {
  const execution = { applying: false };
  state.execution = execution;
  try {
    if (options?.base !== undefined && options.base !== readSharedRevision(handle)) return { ok: false, reason: "stale-base" };
    const handlers = { ...scalarHandlers, ...registeredSharedOperationHandlers(handle) };
    const preparation = createSharedPreparation(handle, options?.base ?? null), accepted: Extract<SharedPreparationResult, { ok: true }>[] = [];
    noteSharedOperationList(preparation.view, operations);
    let index = 0;
    try { for (const operation of operations) {
      const validated = readOperation(operation);
      const handler = validated && handlers[validated.kind] as ((operation: SharedOperation, view: SharedPreparationView) => SharedPreparationResult) | undefined;
      if (!validated || !handler) return { ok: false, index, operation, reason: validated ? "unhandled-kind" : "invalid-operation" };
      let prepared: SharedPreparationResult;
      try { prepared = handler(validated, preparation.view); }
      catch (error) {
        if (error instanceof SharedExecutionWriteError) throw error;
        prepared = { ok: false, reason: "invalid-target-shape" };
      }
      if (!prepared.ok) return { ok: false, index, operation, reason: prepared.reason };
      preparation.include(prepared.writes); accepted.push(prepared);
      index++;
    }
    for (const [at, prepared] of accepted.entries()) {
      const reason = prepared.complete?.(), operation = operations[at];
      if (reason && operation) return { ok: false, index: at, operation, reason };
    } } finally { preparation.close(); }
    if (accepted.length) transactCollabState(state, options?.origin ?? "local-command", () => {
      execution.applying = true;
      try { for (const prepared of accepted) prepared.apply(handle); }
      finally { execution.applying = false; }
    }, execution);
    return { ok: true };
  } finally { state.execution = null; }
}
