import type { SharedOperation } from "../../core/collab/operations.ts";
import { readOperation } from "../../core/collab/read-operation.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, transactCollabState } from "./state.ts";
import { createSharedPreparation } from "./prepare.ts";
import type { SharedPreparationResult, SharedPreparationView } from "./prepare.ts";
import { registeredSharedOperationHandlers } from "./operation-handlers.ts";
import { scalarHandlers } from "./scalar-executor.ts";

export type SharedExecutionResult = { readonly ok: true } | {
  readonly ok: false; readonly index: number; readonly operation: SharedOperation; readonly reason: string;
};

export function executeSharedOperations(handle: SharedDocumentHandle, operations: readonly SharedOperation[]): SharedExecutionResult {
  const handlers = { ...scalarHandlers, ...registeredSharedOperationHandlers(handle) };
  const preparation = createSharedPreparation(handle), accepted: Extract<SharedPreparationResult, { ok: true }>[] = [];
  let index = 0;
  for (const operation of operations) {
    const validated = readOperation(operation);
    const handler = validated && handlers[validated.kind] as ((operation: SharedOperation, view: SharedPreparationView) => SharedPreparationResult) | undefined;
    if (!validated || !handler) return { ok: false, index, operation, reason: validated ? "unhandled-kind" : "invalid-operation" };
    let prepared: SharedPreparationResult;
    try { prepared = handler(validated, preparation.view); }
    catch { prepared = { ok: false, reason: "invalid-target-shape" }; }
    if (!prepared.ok) return { ok: false, index, operation, reason: prepared.reason };
    preparation.include(prepared.writes); accepted.push(prepared);
    index++;
  }
  if (accepted.length) transactCollabState(collabState(handle), "local-command", () => { for (const prepared of accepted) prepared.apply(handle); });
  return { ok: true };
}
