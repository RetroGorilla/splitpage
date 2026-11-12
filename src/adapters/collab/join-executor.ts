import type { SharedBeatJoin, SharedJoinGlue, SharedJoinRetire } from "../../core/collab/operations.ts";
import type { SharedPreparationView, SharedPreparationResult, SharedPreparedWrite } from "./prepare.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureIdentity, sharedStructureReference, prepareStructureAlias, requireSharedStructureOperationId, SharedStructurePreparationError } from "./structure-identity.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import { sharedJoinGlueRegisterField } from "../../core/collab/projection/join-glue.ts";
import { readSharedJoinEntry, sharedJoinRetirementGroup } from "./join-record.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import type { SharedJoinIndex } from "./join-index.ts";
import { collabState, SharedExecutionWriteError } from "./state.ts";
import { sharedPlannedJoins, sharedPlannedJoinEnds } from "./join-plan.ts";
import { sharedJoinedTextBaseline, readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";
import { sharedTextPoint } from "./text-points.ts";
import { sharedJoinEndpointField } from "./join-endpoint.ts";
import { applySharedJoinEndpoint } from "./join-endpoint-write.ts";
import type { SharedJoinEndpointWrite } from "./join-endpoint-write.ts";

function value(view: SharedPreparationView, path: readonly string[]) {
  return view.kind(path) === "value" ? view.get(path) : undefined;
}
function entry(view: SharedPreparationView, path: readonly string[]) {
  return readSharedJoinEntry(value(view, path));
}
function frozen(writes: readonly SharedPreparedWrite[], rawEndpoint?: SharedJoinEndpointWrite) {
  const description = freezeSharedPreparedValue(writes);
  const endpoint = rawEndpoint ? freezeSharedPreparedValue(rawEndpoint) : null;
  return { ok: true as const, writes: description, apply: (handle: SharedDocumentHandle) => {
    if (!collabState(handle).execution?.applying) throw new SharedExecutionWriteError();
    applySharedMapWrites(handle, description);
    if (endpoint) applySharedJoinEndpoint(handle, endpoint);
  } };
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
    if (index.locations(identity).length || sharedPlannedJoins(view).has(identity) || view.has(["meta", sharedJoinEndpointField(identity)])) return { ok: false, reason: "existing-join" };
    let generation = -1;
    const previous = [...index.entries(from.owner), ...[...sharedPlannedJoins(view).values()].filter(item => item.from === from.owner).map(item => item.entry)];
    for (const known of previous) {
      if (known.into === into.owner && known.glue === operation.glue) generation = Math.max(generation, known.generation);
    }
    if (generation === Number.MAX_SAFE_INTEGER) return { ok: false, reason: "join-generation-limit" };
    const target = { owner: into.owner as SharedBeatJoin["into"], segment: into.owner as SharedBeatJoin["into"], field: "audioText" as const };
    sharedJoinedTextBaseline(view, target);
    const geometry = readSharedJoinedTextGeometry(view, into.owner), parts = geometry?.root === into.owner ? geometry.parts : geometry?.parts.filter(part => part.owner === into.owner);
    const end = parts?.at(-1); if (!end) return { ok: false, reason: "missing-join-target" };
    sharedJoinedTextBaseline(view, { owner: from.owner as SharedBeatJoin["from"], segment: from.owner as SharedBeatJoin["from"], field: "audioText" });
    const sourceGeometry = readSharedJoinedTextGeometry(view, from.owner);
    const sourcePart = sourceGeometry?.parts.find(part => part.owner === from.owner); if (!sourcePart) return { ok: false, reason: "missing-join-target" };
    const source = { owner: from.owner as SharedBeatJoin["from"], segment: sourcePart.segment as SharedBeatJoin["from"], field: "audioText" as const };
    const endpoint = { join: identity, target: { owner: end.owner as SharedBeatJoin["into"], segment: end.segment as SharedBeatJoin["into"], field: "audioText" as const }, index: end.to, source, from: sourcePart.from, to: sourcePart.to };
    prepareStructureAlias(view, operation.id, identity); sharedPlannedJoins(view).set(identity, { from: from.owner, entry: { into: into.owner, glue: operation.glue, generation: generation + 1 } });
    sharedPlannedJoinEnds(view).set(identity, { target: endpoint.target, point: sharedTextPoint(view, ["segments", end.segment, "text"], end.to), source,
      start: sharedTextPoint(view, ["segments", source.segment, "text"], sourcePart.from, -1), stop: sharedTextPoint(view, ["segments", source.segment, "text"], sourcePart.to) });
    return frozen([{ kind: "set", path: [...path, identity],
      value: { into: into.owner, glue: operation.glue, by: operation.by, operation: operation.id, generation: generation + 1 } }], endpoint);
  });
}

function prepareJoinChange(operation: SharedJoinGlue | SharedJoinRetire, view: SharedPreparationView, index: SharedJoinIndex): SharedPreparationResult {
  return guard(() => {
    if (![operation.id, operation.by, ...operation.joins].every(isStableSharedIdentity)) return { ok: false, reason: "unstable-identity" };
    requireSharedStructureOperationId(operation.id);
    const writes: SharedPreparedWrite[] = [];
    for (const reference of new Set(operation.joins)) {
      const join = sharedStructureReference(view, reference), source = sharedPlannedJoins(view).get(join)?.from;
      const owners = [...new Set([...index.locations(join), ...(source ? [source] : [])])];
      let found = false, active = false;
      for (const from of owners) {
        const known = entry(view, ["beats", from, "joins", join]);
        if (!known || value(view, ["beats", from, "id"]) !== from) continue;
        found = true;
        const group = sharedJoinRetirementGroup(from, known);
        const retired = value(view, ["retiredJoins", join]) === true || value(view, ["retiredJoins", group]) === true;
        if (retired) { if (operation.kind === "join-glue") return { ok: false, reason: "retired-join" }; continue; }
        view.resolveOwner(from, "audioText");
        sharedJoinedTextBaseline(view, { owner: from as SharedBeatJoin["from"], segment: from as SharedBeatJoin["from"], field: "audioText" });
        active = true;
        if (operation.kind === "join-retire") writes.push({ kind: "set", path: ["retiredJoins", group], value: true });
        else {
          const path = ["meta", sharedJoinGlueRegisterField(group)];
          if (value(view, path) !== operation.glue) writes.push({ kind: "set", path, value: operation.glue });
        }
      }
      if (!found) return { ok: false, reason: "missing-join" };
      if (operation.kind === "join-retire" && active && value(view, ["retiredJoins", join]) !== true) writes.push({ kind: "set", path: ["retiredJoins", join], value: true });
    }
    return frozen(writes);
  });
}

export function registerSharedJoinHandlers(handle: SharedDocumentHandle): void {
  const index = observeSharedStructureIndex(handle).joins();
  registerSharedOperationHandlers(handle, { join: (operation, view) => prepareSharedBeatJoin(operation, view, index),
    "join-glue": (operation, view) => prepareJoinChange(operation, view, index),
    "join-retire": (operation, view) => prepareJoinChange(operation, view, index) });
}
