import type { SharedBeatSplit, SharedBeatSplitBefore } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { applySharedTextEdit } from "./text-edit.ts";
import type { SharedTextWritePlan } from "./text-edit.ts";
import { sharedTextCommandPlan, sharedTextOverlay, spliceSharedTextPlan, addSharedTextSource, sharedTextInsertionPosition, SharedTextPreparationError } from "./executor-text-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { prepareStructureIdentity, SharedStructurePreparationError } from "./structure-identity.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureSpans } from "./structure-boundary.ts";
import { scalarFieldAllowed } from "./scalar-executor.ts";
import { observeSharedStructureOrder } from "./structure-order.ts";
import { prepareSharedSegmentCreation } from "./segment-executor.ts";

export function prepareSharedBeatSplit(operation: SharedBeatSplit | SharedBeatSplitBefore, view: SharedPreparationView) {
  try {
    if (operation.target.field !== "audioText" && operation.target.field !== "heading" || operation.kind === "split-before" && operation.target.field !== "audioText"
      || ![operation.by, operation.boundary].every(isStableSharedIdentity)) throw new SharedTextPreparationError("invalid-split-target");
    const plan = sharedTextCommandPlan(view, operation.target), { at } = operation;
    const left = at.left === null ? null : resolveSharedTextReference(view, plan, at.left, "left");
    const right = at.right === null ? null : resolveSharedTextReference(view, plan, at.right, "point");
    const span = sharedStructureSpans(view.get([...plan.path.slice(0, -1), "head"]), plan.units).find(span => span.owner === plan.target.owner);
    if (!span) throw new SharedTextPreparationError("missing-target");
    const offset = sharedTextInsertionPosition(plan, (at.affinity === "before" ? right?.from ?? left?.from : left?.from ?? right?.from) ?? span.from);
    if (left && right && left.from > right.from || offset < span.from || offset > span.to) throw new SharedTextPreparationError("invalid-reference");
    for (const ref of operation.observed) resolveSharedTextReference(view, plan, ref, "range");
    const beat = prepareStructureIdentity(view, operation.id, "beat", operation.beat), path = ["beats", beat];
    if (view.has(path)) throw new SharedTextPreparationError("existing-identity");
    const writes: SharedPreparedWrite[] = [{ kind: "map", path }, { kind: "set", path: [...path, "id"], value: beat },
      { kind: "set", path: [...path, "segment"], value: plan.target.segment }, { kind: "set", path: [...path, "splitBy"], value: operation.by },
      { kind: "map", path: [...path, "joins"] }, { kind: "map", path: [...path, "removals"] }];
    for (const [field, value] of Object.entries(operation.fields)) {
      if (field === "visualText" && value === "" || field === "imageRef" && value === null) continue;
      if (field !== "status" && !scalarFieldAllowed("beat", field, value, false) || field === "status" && !["todo", "ready", "shot"].includes(String(value))) throw new SharedTextPreparationError("unsupported-beat-field");
      writes.push({ kind: "set", path: [...path, field], value });
    }
    const value = operation.kind === "split-before" ? { b: beat, before: plan.target.owner } : { b: beat };
    const edit: SharedTextWritePlan = { target: plan.target, edit: { type: "atom", at: offset, value }, marks: [] };
    spliceSharedTextPlan(plan, offset, offset, [value]);
    addSharedTextSource(plan, beat, operation.kind === "split-before" ? span.from : offset + 1, operation.kind === "split-before" ? offset : span.to + 1, "audioText");
    const description = freezeSharedPreparedValue({ writes, edit }), overlay = freezeSharedPreparedValue([...writes, sharedTextOverlay(plan)]);
    return { ok: true as const, description, writes: overlay, apply: (handle: SharedDocumentHandle) => {
      applySharedMapWrites(handle, description.writes); applySharedTextEdit(handle, description.edit);
    } };
  } catch (error) { if (error instanceof SharedTextPreparationError || error instanceof SharedStructurePreparationError) return { ok: false as const, reason: error.message }; throw error; }
}

export function registerSharedSplitHandlers(handle: SharedDocumentHandle): void {
  const order = observeSharedStructureOrder(handle);
  registerSharedOperationHandlers(handle, { split: prepareSharedBeatSplit, "split-before": prepareSharedBeatSplit,
    "segment-create": (operation, view) => prepareSharedSegmentCreation(operation, view, order) });
}
