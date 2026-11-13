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
import { prepareStructureIdentity, reserveSharedStructureIdentity, sharedStructureIdentity, SharedStructurePreparationError } from "./structure-identity.ts";
import { prepareSharedTextCreation } from "./text-creation.ts";
import { applySharedTextCreation } from "./text-target.ts";
import { sharedCreatedAttachments, sharedStructureView } from "./structure-content.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureSpans } from "./structure-spans.ts";
import { planSharedStructureOwner } from "./structure-plan.ts";
import { scalarFieldAllowed } from "./scalar-fields.ts";
import { observeSharedStructureOrder } from "./structure-order-index.ts";
import { prepareSharedSegmentCreation } from "./segment-executor.ts";
import type { SharedStructureContentPorts } from "./structure-content.ts";
import { observeSharedStructureIdentities } from "./structure-reservations.ts";
import type { SharedStructureIdentityReservations } from "./structure-identity.ts";
import { usesSharedJoinedText, readSharedJoinedText, sharedJoinedGap, sharedJoinedSelected, captureSharedJoinedTextSource } from "./joined-text-routing.ts";
import type { SharedTextCommandPlan } from "./executor-text-plan.ts";
import { sharedStructureReference } from "./structure-identity.ts";

export function prepareSharedBeatSplit(operation: SharedBeatSplit | SharedBeatSplitBefore, view: SharedPreparationView, identities: SharedStructureIdentityReservations) {
  try {
    if (!usesSharedJoinedText(view, operation.target)) return preparePhysicalBeatSplit(operation, view, identities);
    const row = readSharedJoinedText(view, operation.target); if (!row) throw new SharedTextPreparationError("missing-target");
    const position = sharedJoinedGap(view, row, operation.at);
    sharedJoinedSelected(view, row, operation.observed);
    if (operation.kind === "split-before" && position.plan.target.owner !== row.spans[0]?.owner) throw new SharedTextPreparationError("partial-joined-prefix");
    const prepared = preparePhysicalBeatSplit(operation, view, identities, position);
    if (prepared.ok) {
      const owner = sharedStructureReference(view, operation.beat), created = readSharedJoinedText(view, { owner, segment: owner, field: "audioText" });
      if (created) captureSharedJoinedTextSource(view, created);
    }
    return prepared;
  } catch (error) { if (error instanceof SharedTextPreparationError) return { ok: false as const, reason: error.message }; throw error; }
}

function preparePhysicalBeatSplit(operation: SharedBeatSplit | SharedBeatSplitBefore, view: SharedPreparationView, identities: SharedStructureIdentityReservations,
  fixed?: { readonly plan: SharedTextCommandPlan; readonly offset: number }) {
  try {
    if (operation.target.field !== "audioText" && operation.target.field !== "heading" || operation.kind === "split-before" && operation.target.field !== "audioText"
      || ![operation.by, operation.boundary].every(isStableSharedIdentity)) throw new SharedTextPreparationError("invalid-split-target");
    const plan = fixed?.plan ?? sharedTextCommandPlan(view, operation.target), { at } = operation;
    const left = fixed || at.left === null ? null : resolveSharedTextReference(view, plan, at.left, "left");
    const right = fixed || at.right === null ? null : resolveSharedTextReference(view, plan, at.right, "point");
    const span = sharedStructureSpans(view, plan.target.segment, plan.units).find(span => span.owner === plan.target.owner);
    if (!span) throw new SharedTextPreparationError("missing-target");
    const offset = Math.max(span.positions[0] ?? span.to, sharedTextInsertionPosition(plan, fixed?.offset ?? (at.affinity === "before" ? right?.from ?? left?.from : left?.from ?? right?.from) ?? span.from));
    if (left && right && left.from > right.from || offset < span.from || offset > span.to) throw new SharedTextPreparationError("invalid-reference");
    if (!fixed) for (const ref of operation.observed) resolveSharedTextReference(view, plan, ref, "range");
    const beat = prepareStructureIdentity(view, operation.id, "beat", operation.beat, identities), path = ["beats", beat];
    const visual = sharedStructureIdentity(view.writer, operation.id, "visual");
    reserveSharedStructureIdentity(view, visual, identities);
    if (view.has(path) || view.has(["visuals", visual])) throw new SharedTextPreparationError("existing-identity");
    const writes: SharedPreparedWrite[] = [{ kind: "map", path }, { kind: "set", path: [...path, "id"], value: beat },
      { kind: "set", path: [...path, "segment"], value: plan.target.segment }, { kind: "set", path: [...path, "splitBy"], value: operation.by },
      { kind: "set", path: [...path, "visual"], value: visual }, { kind: "map", path: [...path, "joins"] }, { kind: "map", path: [...path, "removals"] },
      { kind: "map", path: ["visuals", visual] }, { kind: "set", path: ["visuals", visual, "beat"], value: beat }, { kind: "set", path: ["visuals", visual, "rank"], value: "0000000000" }];
    for (const [field, value] of Object.entries(operation.fields)) {
      if (field === "visualText" && value === "" || field === "imageRef" && value === null) continue;
      if (field !== "status" && !scalarFieldAllowed("beat", field, value, false) || field === "status" && !["todo", "ready", "shot"].includes(String(value))) throw new SharedTextPreparationError("unsupported-beat-field");
      writes.push({ kind: "set", path: [...path, field], value });
    }
    const value = operation.kind === "split-before" ? { b: beat, before: plan.target.owner } : { b: beat };
    const edit: SharedTextWritePlan = { target: plan.target, edit: { type: "atom", at: offset, value }, marks: [] };
    spliceSharedTextPlan(plan, offset, offset, [value]);
    planSharedStructureOwner(view, beat, plan.target.segment);
    addSharedTextSource(view, plan, beat, operation.kind === "split-before" ? span.from : offset + 1, operation.kind === "split-before" ? offset : span.to + 1, "audioText");
    const text = prepareSharedTextCreation(sharedStructureView(view, writes), ["visuals", visual]); if (!text.ok) return text;
    sharedCreatedAttachments(view).push({ collection: "visuals", beat, html: "", record: visual });
    const description = freezeSharedPreparedValue({ writes, text: text.description, edit }), overlay = freezeSharedPreparedValue([...writes, ...text.writes, sharedTextOverlay(plan)]);
    return { ok: true as const, description, writes: overlay, apply: (handle: SharedDocumentHandle) => {
      applySharedMapWrites(handle, description.writes); applySharedTextCreation(handle, description.text); applySharedTextEdit(handle, description.edit);
    } };
  } catch (error) { if (error instanceof SharedTextPreparationError || error instanceof SharedStructurePreparationError) return { ok: false as const, reason: error.message }; throw error; }
}

export function registerSharedSplitHandlers(handle: SharedDocumentHandle, ports: SharedStructureContentPorts): void {
  const order = observeSharedStructureOrder(handle), identities = observeSharedStructureIdentities(handle);
  registerSharedOperationHandlers(handle, { split: (op, view) => prepareSharedBeatSplit(op, view, identities), "split-before": (op, view) => prepareSharedBeatSplit(op, view, identities),
    "segment-create": (operation, view) => prepareSharedSegmentCreation(operation, view, order, ports, identities) });
}
