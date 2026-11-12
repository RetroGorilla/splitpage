import * as Y from "yjs";
import type { SharedSoftRemove, SharedRestore, SharedContentRef } from "../../core/collab/operations.ts";
import { readSharedBufferRecoveryMetadata } from "../../core/collab/removal-state.ts";
import type { SharedPreparationView, SharedPreparedWrite, SharedPreparationResult } from "./prepare.ts";
import { applySharedMapWrites } from "./prepare.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, SharedExecutionWriteError } from "./state.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import { sharedStructureIdentity, sharedStructureReference, prepareStructureAlias, reserveSharedStructureIdentity, SharedStructurePreparationError } from "./structure-identity.ts";
import { observeSharedStructureIdentities } from "./structure-reservations.ts";
import type { SharedStructureIdentityReservations } from "./structure-identity.ts";
import type { SharedAttachmentOwnership } from "./structure-index.ts";
import { sharedCreatedAttachments } from "./structure-content.ts";
import { readPreparedSharedRecord } from "./record-codec.ts";
import { sharedTextCommandPlan, SharedTextPreparationError } from "./executor-text-plan.ts";
import type { SharedTextCommandPlan } from "./executor-text-plan.ts";
import { prepareSharedRemovalObservations } from "./removal-observations.ts";
import type { SharedRemovalCapture } from "./removal-observations.ts";
import { readSharedRemovalCommand } from "./removal-record.ts";
import type { SharedStoredRemovalCommand, SharedRemovalTarget, SharedRemovalBufferSource } from "./removal-record.ts";
import { readSharedRemovalState } from "./removal-state.ts";
import { bindSharedStructurePlan, planSharedStructureRemoval, resolveSharedRestorableBeat } from "./structure-plan.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { collabPreparedOperationTextTarget } from "./text-target.ts";
import { isStableSharedIdentity } from "./identity.ts";

function flags(view: SharedPreparationView, beat: string) {
  const path = ["beats", beat, "removals"];
  if (view.kind(path) !== "map") throw new SharedStructurePreparationError("invalid-removal-state");
  return readSharedRemovalState(view.keys(path).map(key => [key, view.get([...path, key])] as const));
}

function prepared(id: SharedContentRef, record: SharedStoredRemovalCommand, writes: SharedPreparedWrite[], captures: readonly SharedRemovalCapture[] = []) {
  const description = freezeSharedPreparedValue({ id, record, writes, captures });
  const overlay = freezeSharedPreparedValue([{ kind: "set" as const, path: ["removalRecords", id], value: record }, ...writes]);
  return { ok: true as const, description, writes: overlay, apply: (handle: SharedDocumentHandle) => {
    if (!collabState(handle).execution?.applying) throw new SharedExecutionWriteError();
    const observed = description.captures.map(capture => ({ target: capture.target, identities: [...capture.known, ...capture.positions.map(position => {
      const item = Y.createRelativePositionFromTypeIndex(collabPreparedOperationTextTarget(handle, capture.target).text, position, 0).item;
      if (!item) throw new Error("Prepared removal identity is missing");
      return { client: item.client, clock: item.clock };
    })] }));
    const value = description.record.kind === "remove" ? { ...description.record, observed } : description.record;
    applySharedMapWrites(handle, freezeSharedPreparedValue([{ kind: "set", path: ["removalRecords", description.id], value }, ...description.writes]));
  } };
}

function attachments(view: SharedPreparationView, index: SharedAttachmentOwnership, collection: "visuals" | "gallery", beat: string) {
  return [...new Set([...index.keys(collection, beat), ...sharedCreatedAttachments(view).filter(item => item.collection === collection && item.beat === beat).map(item => item.record)])]
    .sort().filter(key => readPreparedSharedRecord(collection, key, view)?.beat === beat);
}

function remove(operation: SharedSoftRemove, view: SharedPreparationView, index: SharedAttachmentOwnership, identities: SharedStructureIdentityReservations): SharedPreparationResult {
  const id = sharedStructureIdentity(view.writer, operation.id, "removal"), targets: SharedRemovalTarget[] = [], writes: SharedPreparedWrite[] = [];
  if (view.has(["removalRecords", id])) throw new SharedStructurePreparationError("existing-identity");
  reserveSharedStructureIdentity(view, id, identities); prepareStructureAlias(view, operation.id, id);
  if (!operation.targets.length) throw new SharedStructurePreparationError("missing-target");
  const plans: SharedTextCommandPlan[] = [], visuals: { beat: SharedContentRef; record: SharedContentRef }[] = [], gallery: string[] = [], buffer: SharedRemovalBufferSource[] = [];
  for (const reference of operation.targets) {
    const owner = view.resolveOwner(sharedStructureReference(view, reference), "audioText");
    if (!owner) throw new SharedStructurePreparationError("missing-target");
    if (targets.some(target => target.beat === owner.owner)) continue;
    const state = flags(view, owner.owner), generation = state.generation === null ? 0 : state.generation + 1;
    if (!Number.isSafeInteger(generation)) throw new SharedStructurePreparationError("removal-generation-limit");
    const plan = sharedTextCommandPlan(view, { owner: owner.owner as SharedContentRef, segment: owner.segment as SharedContentRef, field: "audioText" });
    plans.push(plan); targets.push({ beat: owner.owner, segment: owner.segment, generation });
    visuals.push(...attachments(view, index, "visuals", owner.owner).map(record => ({ beat: owner.owner as SharedContentRef, record: record as SharedContentRef })));
    gallery.push(...attachments(view, index, "gallery", owner.owner));
    if (view.has(["beats", owner.owner, "bufferRecovery"])) {
      const metadata = readSharedBufferRecoveryMetadata(view.get(["beats", owner.owner, "bufferRecovery"]));
      if (!metadata) throw new SharedStructurePreparationError("invalid-buffer-recovery-metadata");
      buffer.push({ beat: owner.owner, metadata }); writes.push({ kind: "delete", path: ["beats", owner.owner, "bufferRecovery"] });
    }
    writes.push({ kind: "set", path: ["beats", owner.owner, "removals", id], value: { generation, removed: true } });
  }
  const boundaries = operation.boundaries.map(reference => view.resolveOwner(sharedStructureReference(view, reference), "audioText")?.owner);
  if (boundaries.some(owner => !owner || !targets.some(target => target.beat === owner))) throw new SharedStructurePreparationError("invalid-removal-boundary");
  for (const [collection, supplied, derived] of [["visuals", operation.components, visuals.map(value => value.record)], ["gallery", operation.gallery, gallery]] as const) {
    if (supplied.some(reference => !derived.includes(sharedStructureReference(view, reference)) && !operation.targets.some(target => reference === target + (collection === "visuals" ? ":visual" : ":gallery"))))
      throw new SharedStructurePreparationError(collection === "visuals" ? "invalid-removal-components" : "invalid-removal-gallery");
  }
  const captures = prepareSharedRemovalObservations(view, plans, operation.observed, visuals);
  const record: SharedStoredRemovalCommand = { kind: "remove", writer: view.writer, operation: operation.id, by: operation.by, targets,
    removalKind: operation.removalKind, at: operation.at, observed: captures.map(capture => ({ target: capture.target, identities: capture.known })),
    references: operation.observed, boundaries: boundaries as string[], components: visuals.map(value => value.record), gallery, comments: operation.comments ?? null, buffer };
  for (const target of targets) planSharedStructureRemoval(view, target.beat, true);
  return prepared(id, record, writes, captures);
}

function restore(operation: SharedRestore, view: SharedPreparationView, identities: SharedStructureIdentityReservations): SharedPreparationResult {
  const id = sharedStructureIdentity(view.writer, operation.id, "restore"), targets: SharedRemovalTarget[] = [], writes: SharedPreparedWrite[] = [], removals: string[] = [];
  if (!isStableSharedIdentity(operation.by)) throw new SharedStructurePreparationError("unstable-identity");
  if (view.has(["removalRecords", id])) throw new SharedStructurePreparationError("existing-identity");
  for (const reference of new Set(operation.removals)) {
    const removal = sharedStructureReference(view, reference), record = readSharedRemovalCommand(removal, view.get(["removalRecords", removal]));
    if (!record || record.kind !== "remove") throw new SharedStructurePreparationError("invalid-removal-record");
    removals.push(removal);
    for (const target of record.targets) {
      if (view.kind(["beats", target.beat]) !== "map" || view.get(["beats", target.beat, "id"]) !== target.beat) throw new SharedStructurePreparationError("missing-target");
      const state = flags(view, target.beat);
      if (!state.removed || state.generation !== target.generation || !view.has(["beats", target.beat, "removals", removal])) continue;
      if (!resolveSharedRestorableBeat(view, target.beat)) throw new SharedStructurePreparationError("missing-target");
      writes.push({ kind: "set", path: ["beats", target.beat, "removals", removal], value: { generation: target.generation, removed: false } });
      if (!targets.some(value => value.beat === target.beat)) targets.push(target);
    }
  }
  if (!writes.length) return { ok: true, writes: Object.freeze([]), apply: handle => applySharedMapWrites(handle, Object.freeze([])) };
  reserveSharedStructureIdentity(view, id, identities); prepareStructureAlias(view, operation.id, id);
  for (const target of targets) planSharedStructureRemoval(view, target.beat, false);
  return prepared(id, { kind: "restore", writer: view.writer, operation: operation.id, by: operation.by, targets, removals }, writes);
}

export function registerSharedRemovalHandlers(handle: SharedDocumentHandle): void {
  const structure = observeSharedStructureIndex(handle), index = structure.attachments(), identities = observeSharedStructureIdentities(handle);
  const guard = (run: () => SharedPreparationResult): SharedPreparationResult => {
    try { return run(); } catch (error) {
      if (error instanceof SharedStructurePreparationError || error instanceof SharedTextPreparationError) return { ok: false, reason: error.message };
      throw error;
    }
  };
  registerSharedOperationHandlers(handle, { remove: (operation, view) => guard(() => {
    if (!isStableSharedIdentity(operation.by)) throw new SharedStructurePreparationError("unstable-identity");
    return remove(operation, view, index, identities);
  }), restore: (operation, view) => guard(() => { bindSharedStructurePlan(view, structure); return restore(operation, view, identities); }) });
}
