import type { SharedOperation } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";

export type SharedOperationHandlers = {
  readonly [Kind in SharedOperation["kind"]]?: (
    handle: SharedDocumentHandle, operation: Extract<SharedOperation, { kind: Kind }>
  ) => string | null;
};

let registrations: WeakMap<SharedDocumentHandle, SharedOperationHandlers> | null = null;

export function registerSharedOperationHandlers(handle: SharedDocumentHandle, handlers: SharedOperationHandlers): void {
  registrations ??= new WeakMap();
  const previous = registrations.get(handle) ?? {};
  for (const kind of Object.keys(handlers)) {
    if (kind === "scalar" || kind === "status" || Object.hasOwn(previous, kind)) throw new Error(`Handler already registered for ${kind}`);
  }
  registrations.set(handle, Object.freeze({ ...previous, ...handlers }));
}

export function registeredSharedOperationHandlers(handle: SharedDocumentHandle): SharedOperationHandlers {
  return registrations?.get(handle) ?? {};
}
