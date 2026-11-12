import type { SharedHeadingCreate, SharedContentRef } from "../../core/collab/operations.ts";
import { cappedText } from "../../core/document/text-policy.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView, SharedPreparedWrite, SharedPreparationResult } from "./prepare.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import { observeSharedStructureOrder } from "./structure-order-index.ts";
import type { SharedStructureOrderView } from "./structure-order-index.ts";
import { applySharedOrderInsertion } from "./structure-order.ts";
import { observeSharedStructureIdentities } from "./structure-reservations.ts";
import { sharedStructureIdentity, reserveSharedStructureIdentity, prepareStructureAlias, sharedStructureReference, SharedStructurePreparationError } from "./structure-identity.ts";
import type { SharedStructureIdentityReservations } from "./structure-identity.ts";
import { prepareSharedBeatPlacement } from "./structure-placement.ts";
import { readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";
import { sharedStructureView } from "./structure-content.ts";
import { prepareSharedTextCreation } from "./text-creation.ts";
import { applySharedTextCreation } from "./text-target.ts";
import { applySharedTextEdit } from "./text-edit.ts";
import type { SharedTextWritePlan } from "./text-edit.ts";
import { sharedTextCommandPlan, spliceSharedTextPlan, addSharedTextSource, sharedTextOverlay, SharedTextPreparationError } from "./executor-text-plan.ts";
import { sharedStructureSpans } from "./structure-spans.ts";
import { planSharedStructureHead, planSharedHeadingCreation } from "./structure-plan.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { isStableSharedIdentity } from "./identity.ts";

function headingName(view: SharedPreparationView, heading: SharedContentRef): string | null {
  const owner = view.resolveOwner(heading, "heading");
  if (!owner) return null;
  const plan = sharedTextCommandPlan(view, { owner: heading, segment: owner.segment as SharedContentRef, field: "heading" });
  const span = sharedStructureSpans(view, owner.segment, plan.units).find(span => span.owner === heading && span.field === "heading");
  return (span?.positions ?? []).map(position => plan.units[position]?.value).map(value => typeof value === "string" ? value : "").join("");
}

function createHeading(operation: SharedHeadingCreate, view: SharedPreparationView, order: SharedStructureOrderView, identities: SharedStructureIdentityReservations): SharedPreparationResult {
  if (![operation.by, operation.segment, operation.heading].every(isStableSharedIdentity)) throw new SharedStructurePreparationError("unstable-identity");
  if (operation.at.left !== null || operation.at.right !== operation.firstBeat || operation.at.affinity !== "before") throw new SharedStructurePreparationError("invalid-heading-gap");
  const first = view.resolveOwner(sharedStructureReference(view, operation.firstBeat), "audioText");
  if (!first) throw new SharedStructurePreparationError("missing-target");
  const geometry = readSharedJoinedTextGeometry(view, first.owner);
  if (geometry && geometry.root !== first.owner) throw new SharedStructurePreparationError("joined-heading");
  const heading = sharedStructureIdentity(view.writer, operation.id, "heading"), created = sharedStructureIdentity(view.writer, operation.id, "segment");
  reserveSharedStructureIdentity(view, heading, identities);
  if (view.has(["headings", heading])) throw new SharedStructurePreparationError("existing-identity");
  const placement = prepareSharedBeatPlacement(view, order, { left: null, right: first.owner as SharedContentRef, affinity: "before" }, created);
  const segment = placement.kind === "inline" ? placement.plan.target.segment : created;
  if (placement.kind === "order") { reserveSharedStructureIdentity(view, created, identities); if (view.has(["segments", created])) throw new SharedStructurePreparationError("existing-identity"); }
  prepareStructureAlias(view, operation.heading, heading);
  if (operation.segment !== operation.heading) prepareStructureAlias(view, operation.segment, segment);
  const writes: SharedPreparedWrite[] = [{ kind: "map", path: ["headings", heading] }, { kind: "set", path: ["headings", heading, "id"], value: heading },
    { kind: "set", path: ["headings", heading, "extra"], value: "{}" }];
  const overlay: SharedPreparedWrite[] = [];
  let text: { readonly path: readonly string[]; readonly title: boolean } | null = null, boundary: SharedTextWritePlan | null = null;
  if (placement.kind === "order") {
    writes.push({ kind: "map", path: ["segments", created] }, { kind: "set", path: ["segments", created, "head"], value: { h: heading } });
    planSharedStructureHead(view, created, { h: heading });
    const creation = prepareSharedTextCreation(sharedStructureView(view, writes), ["segments", created]); if (!creation.ok) return creation;
    text = creation.description; overlay.push(...creation.writes);
  } else {
    const { plan, offset } = placement, value = { h: heading };
    spliceSharedTextPlan(plan, offset, offset, [value]);
    addSharedTextSource(view, plan, heading, offset + 1, offset + 1, "heading");
    boundary = { target: plan.target, edit: { type: "atom", at: offset, value }, marks: [] }; overlay.push(sharedTextOverlay(plan));
  }
  planSharedHeadingCreation(view, heading, segment);
  const description = freezeSharedPreparedValue({ writes, text, boundary, placement: placement.kind === "order" ? { index: placement.index, segment } : null });
  return { ok: true, writes: freezeSharedPreparedValue([...writes, ...overlay]), complete: () => {
    try { const name = headingName(view, heading); return name === null || cappedText(name, 200) ? null : "invalid-heading-name"; }
    catch (error) { if (error instanceof SharedTextPreparationError) return error.message; throw error; }
  }, apply: (handle: SharedDocumentHandle) => {
    applySharedMapWrites(handle, description.writes);
    if (description.text) applySharedTextCreation(handle, description.text);
    if (description.boundary) applySharedTextEdit(handle, description.boundary);
    if (description.placement) applySharedOrderInsertion(handle, description.placement);
  } };
}

export function registerSharedHeadingHandlers(handle: SharedDocumentHandle): void {
  const order = observeSharedStructureOrder(handle), identities = observeSharedStructureIdentities(handle);
  registerSharedOperationHandlers(handle, { "heading-create": (operation, view) => {
    try { return createHeading(operation, view, order, identities); } catch (error) {
      if (error instanceof SharedStructurePreparationError || error instanceof SharedTextPreparationError) return { ok: false, reason: error.message };
      throw error;
    }
  } });
}
