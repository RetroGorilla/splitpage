import type { SharedHeadingCreate, SharedHeadingFinalize, SharedContentRef } from "../../core/collab/operations.ts";
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
import type { SharedTextWritePlan, CollabTextMutation } from "./text-edit.ts";
import { sharedTextCommandPlan, spliceSharedTextPlan, addSharedTextSource, sharedTextOverlay, SharedTextPreparationError } from "./executor-text-plan.ts";
import { sharedStructureSpans } from "./structure-spans.ts";
import { planSharedStructureHead, planSharedHeadingCreation, planSharedHeadingFinalization, planSharedStructureOwner } from "./structure-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { sharedFollowingBeat } from "./removal-executor.ts";
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

function finalizeHeading(operation: SharedHeadingFinalize, view: SharedPreparationView, identities: SharedStructureIdentityReservations): SharedPreparationResult {
  if (![operation.by, operation.heading].every(isStableSharedIdentity)) throw new SharedStructurePreparationError("unstable-identity");
  if (operation.target.field !== "audioText" || operation.retainedBeat === null || operation.emptyBeat !== null && operation.emptyBeat !== operation.retainedBeat) throw new SharedStructurePreparationError("invalid-heading-target");
  const located = view.resolveOwner(sharedStructureReference(view, operation.target.owner), "audioText");
  if (!located) throw new SharedStructurePreparationError("missing-target");
  const geometry = readSharedJoinedTextGeometry(view, located.owner);
  if (geometry && (geometry.root !== located.owner || geometry.parts.length > 1)) throw new SharedStructurePreparationError("joined-heading");
  const retained = view.resolveOwner(sharedStructureReference(view, operation.retainedBeat), "audioText");
  if (!retained) throw new SharedStructurePreparationError("missing-target");
  const plan = sharedTextCommandPlan(view, operation.target), owner = plan.target.owner, segment = plan.target.segment, keep = retained.owner === owner;
  const span = sharedStructureSpans(view, segment, plan.units).find(span => span.owner === owner && span.field === "audioText");
  if (!span) throw new SharedStructurePreparationError("missing-target");
  const pick = (references: readonly SharedContentRef[]) => references.flatMap(reference => resolveSharedTextReference(view, plan, reference, "range").units);
  const prefix = pick(operation.prefix), name = pick(operation.name), separator = pick(operation.separator), line = [...prefix, ...name, ...separator];
  const { left, right, affinity } = operation.tail, gap = right === null ? null : resolveSharedTextReference(view, plan, right, "point").from;
  const tail = affinity === "before" && gap !== null || left === null ? gap : resolveSharedTextReference(view, plan, left, "left").from;
  const end = span.positions[line.length] ?? span.to;
  if (line.some((unit, index) => plan.units.indexOf(unit) !== span.positions[index]) || tail !== end) throw new SharedStructurePreparationError("invalid-heading-range");
  const heading = sharedStructureIdentity(view.writer, operation.id, "heading");
  reserveSharedStructureIdentity(view, heading, identities);
  if (view.has(["headings", heading])) throw new SharedStructurePreparationError("existing-identity");
  prepareStructureAlias(view, operation.heading, heading);
  const writes: SharedPreparedWrite[] = [{ kind: "map", path: ["headings", heading] }, { kind: "set", path: ["headings", heading, "id"], value: heading },
    { kind: "set", path: ["headings", heading, "extra"], value: "{}" }];
  const edits: CollabTextMutation[] = [], embed = span.from > 0 ? plan.units[span.from - 1] : undefined;
  const insert = (at: number, value: Readonly<Record<string, unknown>>) => { spliceSharedTextPlan(plan, at, at, [value]); edits.push({ type: "atom", at, value }); };
  // why: boundaries go in before any character is deleted, so each sits beside visible characters
  // and typing at the end of the name by another writer stays in the name.
  if (keep) insert(end, { b: owner });
  if (!keep) insert(span.positions[prefix.length] ?? end, { h: heading });
  else if (embed) insert(span.from - 1, { h: heading });
  else {
    writes.push({ kind: "set", path: ["segments", segment, "head"], value: { h: heading } }, { kind: "set", path: ["beats", owner, "segment"], value: segment });
    planSharedStructureHead(view, segment, { h: heading }); planSharedStructureOwner(view, owner, segment);
  }
  const doomed = new Set([...prefix, ...separator, ...keep && embed ? [embed] : []]);
  for (let index = plan.units.length - 1; index >= 0; index--) if (doomed.has(plan.units[index] as typeof plan.units[number])) {
    spliceSharedTextPlan(plan, index, index + 1, []); edits.push({ type: "delete", from: index, to: index + 1 });
  }
  planSharedHeadingCreation(view, heading, segment); planSharedHeadingFinalization(view, retained.owner, heading);
  const description = freezeSharedPreparedValue({ writes, edits: edits.map(edit => ({ target: plan.target, edit, marks: [] })) });
  return { ok: true, writes: freezeSharedPreparedValue([...writes, sharedTextOverlay(plan)]), complete: () => {
    try {
      const value = headingName(view, heading), placed = view.resolveOwner(heading, "heading");
      if (value === null || !placed) return null;
      if (!cappedText(value, 200)) return "invalid-heading-name";
      return sharedFollowingBeat(view, placed) === retained.owner ? null : "misplaced-heading-beat";
    } catch (error) { if (error instanceof SharedTextPreparationError) return error.message; throw error; }
  }, apply: (handle: SharedDocumentHandle) => {
    applySharedMapWrites(handle, description.writes);
    for (const edit of description.edits) applySharedTextEdit(handle, edit);
  } };
}

export function registerSharedHeadingHandlers(handle: SharedDocumentHandle): void {
  const order = observeSharedStructureOrder(handle), identities = observeSharedStructureIdentities(handle);
  const guard = (run: () => SharedPreparationResult): SharedPreparationResult => {
    try { return run(); } catch (error) {
      if (error instanceof SharedStructurePreparationError || error instanceof SharedTextPreparationError) return { ok: false, reason: error.message };
      throw error;
    }
  };
  registerSharedOperationHandlers(handle, { "heading-create": (operation, view) => guard(() => createHeading(operation, view, order, identities)),
    "heading-finalize": (operation, view) => guard(() => finalizeHeading(operation, view, identities)) });
}
