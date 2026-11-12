import type { SharedBeatJoin, SharedJoinGlue, SharedJoinRetire } from "../../core/collab/operations.ts";
import type { SharedPreparationView, SharedPreparationResult, SharedPreparedWrite } from "./prepare.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureIdentity, sharedStructureReference, prepareStructureAlias, SharedStructurePreparationError } from "./structure-identity.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import { sharedJoinGlueRegisterField } from "../../core/collab/projection/join-glue.ts";
import { readSharedJoinEntry, sharedJoinRetirementGroup } from "./join-record.ts";
import { observeSharedJoinIndex } from "./join-index.ts";
import type { SharedJoinIndex } from "./join-index.ts";

function staged(view: SharedPreparationView): Map<string, string> { return view.scratch("issued-joins", () => new Map()); }
function frozen(writes: readonly SharedPreparedWrite[]) {
  const description = freezeSharedPreparedValue(writes);
  return { ok: true as const, writes: description, apply: (handle: SharedDocumentHandle) => applySharedMapWrites(handle, description) };
}

function guard(run: () => SharedPreparationResult): SharedPreparationResult {
  try { return run(); } catch (error) {
    if (error instanceof SharedStructurePreparationError) return { ok: false, reason: error.message };
    throw error;
  }
}

export function prepareSharedBeatJoin(operation: SharedBeatJoin, view: SharedPreparationView, index: SharedJoinIndex): SharedPreparationResult {
  return guard(() => {
    if (![operation.from, operation.into, operation.by].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
    const from = view.resolveOwner(sharedStructureReference(view, operation.from), "audioText");
    const into = view.resolveOwner(sharedStructureReference(view, operation.into), "audioText");
    if (!from || !into) return { ok: false, reason: "missing-join-target" };
    const path = ["beats", from.owner, "joins"], identity = sharedStructureIdentity(view.writer, operation.id, "join");
    if (view.kind(path) !== "map") return { ok: false, reason: "invalid-join-store" };
    if (index.locations(identity).length || staged(view).has(identity) || view.has([...path, identity])) return { ok: false, reason: "existing-join" };
    let generation = -1;
    for (const key of view.keys(path)) {
      const entry = readSharedJoinEntry(view.get([...path, key]));
      if (entry?.into === into.owner && entry.glue === operation.glue) generation = Math.max(generation, entry.generation);
    }
    if (generation === Number.MAX_SAFE_INTEGER) return { ok: false, reason: "join-generation-limit" };
    prepareStructureAlias(view, operation.id, identity); staged(view).set(identity, from.owner);
    return frozen([{ kind: "set", path: [...path, identity],
      value: { into: into.owner, glue: operation.glue, by: operation.by, operation: operation.id, generation: generation + 1 } }]);
  });
}

function prepareJoinChange(operation: SharedJoinGlue | SharedJoinRetire, view: SharedPreparationView, index: SharedJoinIndex): SharedPreparationResult {
  return guard(() => {
    if (![operation.id, operation.by, ...operation.joins].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
    const writes: SharedPreparedWrite[] = [];
    for (const reference of new Set(operation.joins)) {
      const join = sharedStructureReference(view, reference), source = staged(view).get(join);
      const owners = [...new Set([...index.locations(join), ...(source ? [source] : [])])];
      let found = false, active = false;
      for (const from of owners) {
        const entry = readSharedJoinEntry(view.get(["beats", from, "joins", join]));
        if (!entry || view.get(["beats", from, "id"]) !== from) continue;
        found = true;
        const group = sharedJoinRetirementGroup(from, entry);
        const retired = view.get(["retiredJoins", join]) === true || view.get(["retiredJoins", group]) === true;
        if (retired) { if (operation.kind === "join-glue") return { ok: false, reason: "retired-join" }; continue; }
        active = true;
        if (operation.kind === "join-retire") writes.push({ kind: "set", path: ["retiredJoins", group], value: true });
      }
      if (!found) return { ok: false, reason: "missing-join" };
      if (operation.kind === "join-glue") {
        const path = ["meta", sharedJoinGlueRegisterField(join)];
        if (view.get(path) !== operation.glue) writes.push({ kind: "set", path, value: operation.glue });
      } else if (active && view.get(["retiredJoins", join]) !== true) writes.push({ kind: "set", path: ["retiredJoins", join], value: true });
    }
    return frozen(writes);
  });
}

export function registerSharedJoinHandlers(handle: SharedDocumentHandle): void {
  const index = observeSharedJoinIndex(handle);
  registerSharedOperationHandlers(handle, { join: (operation, view) => prepareSharedBeatJoin(operation, view, index),
    "join-glue": (operation, view) => prepareJoinChange(operation, view, index),
    "join-retire": (operation, view) => prepareJoinChange(operation, view, index) });
}
