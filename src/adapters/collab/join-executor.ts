import type { SharedBeatJoin } from "../../core/collab/operations.ts";
import type { SharedPreparationView, SharedPreparationResult, SharedPreparedWrite } from "./prepare.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureIdentity, sharedStructureReference, SharedStructurePreparationError } from "./structure-identity.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";

export function prepareSharedBeatJoin(operation: SharedBeatJoin, view: SharedPreparationView): SharedPreparationResult {
  try {
    if (![operation.from, operation.into, operation.by].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
    const from = view.resolveOwner(sharedStructureReference(view, operation.from), "audioText");
    const into = view.resolveOwner(sharedStructureReference(view, operation.into), "audioText");
    if (!from || !into) return { ok: false, reason: "missing-join-target" };
    const path = ["beats", from.owner, "joins"], identity = sharedStructureIdentity(view.writer, operation.id, "join");
    if (view.kind(path) !== "map") return { ok: false, reason: "invalid-join-store" };
    if (view.has([...path, identity])) return { ok: false, reason: "existing-join" };
    const writes = freezeSharedPreparedValue<SharedPreparedWrite[]>([{ kind: "set", path: [...path, identity],
      value: { into: into.owner, glue: operation.glue, by: operation.by, operation: operation.id, observed: view.keys(path) } }]);
    return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
  } catch (error) {
    if (error instanceof SharedStructurePreparationError) return { ok: false, reason: error.message };
    throw error;
  }
}

export function registerSharedJoinHandlers(handle: SharedDocumentHandle): void {
  registerSharedOperationHandlers(handle, { join: prepareSharedBeatJoin });
}
