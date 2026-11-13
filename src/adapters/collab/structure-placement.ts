import type { SharedContentRef, SharedIdentityGap } from "../../core/collab/operations.ts";
import type { SharedPreparationView } from "./prepare.ts";
import type { SharedStructureOrderView } from "./structure-order-index.ts";
import { sharedStructureSegment, prepareSharedOrderInsertion, sharedPlannedSegmentIndex, sharedPlannedSegmentAt } from "./structure-order.ts";
import { sharedStructureReference, SharedStructurePreparationError } from "./structure-identity.ts";
import { sharedStructureSpans } from "./structure-spans.ts";
import { sharedTextCommandPlan, sharedTextInsertionPosition } from "./executor-text-plan.ts";
import { readProjectionHead } from "./projection-reader.ts";
import { readSharedFinalizedHeading } from "./structure-plan.ts";

export function prepareSharedBeatPlacement(view: SharedPreparationView, order: SharedStructureOrderView, gap: SharedIdentityGap, segment: string) {
  const locate = (reference: SharedContentRef | null) => {
    if (reference === null) return null;
    const named = sharedStructureReference(view, reference), resolved = view.resolveOwner(named, "audioText") ?? view.resolveOwner(named, "heading");
    const owner = resolved?.owner ?? named;
    if (!["beats", "headings", "segments"].some(root => view.kind([root, owner]) === "map")) return null;
    const key = sharedStructureSegment(view, reference), index = sharedPlannedSegmentIndex(view, order, key);
    const field = view.kind(["beats", owner]) === "map" ? "audioText" : view.kind(["headings", owner]) === "map" ? "heading" : null;
    if (field === null) return { key, index, plan: null, span: null };
    const plan = sharedTextCommandPlan(view, { owner: owner as SharedContentRef, segment: key as SharedContentRef, field });
    const span = sharedStructureSpans(view, key, plan.units).find(span => span.owner === plan.target.owner && span.field === field);
    if (!span) throw new SharedStructurePreparationError("missing-order-target");
    return { key, index, plan, span };
  };
  const left = locate(gap.left), right = locate(gap.right);
  if (left && right && (left.index > right.index || left.index === right.index && (!left.span || !right.span || left.span.owner === right.span.owner || left.span.to > right.span.from))) throw new SharedStructurePreparationError("invalid-order-gap");
  const claimed = gap.affinity === "before" && right?.span ? readSharedFinalizedHeading(view, right.span.owner) : null, heading = claimed === null ? null : locate(claimed as SharedContentRef);
  // why: the app chooses scene intent before it adds the scene it finalizes, so a beat placed before
  // the finalized heading's first beat goes before that heading.
  if (heading?.plan && heading.span) return heading.span.from > 0 ? { kind: "inline" as const, plan: heading.plan, offset: sharedTextInsertionPosition(heading.plan, heading.span.from - 1) }
    : { kind: "order" as const, index: prepareSharedOrderInsertion(view, order, { left: null, right: heading.key as SharedContentRef, affinity: "before" }, segment) };
  const candidates = gap.affinity === "before" ? [[gap.right, "right"], [gap.left, "left"]] as const : [[gap.left, "left"], [gap.right, "right"]] as const;
  for (const [reference, side] of candidates) {
    if (reference === null) continue;
    const located = side === "left" ? left : right; if (!located) continue;
    const { key, plan, span } = located;
    const beforeHeading = side === "right" && gap.affinity === "after" && readProjectionHead(view.get(["segments", key, "head"]))?.kind === "h";
    if (plan && span && !beforeHeading) {
      if (side === "right" ? span.from > 0 : span.to < plan.units.length) {
        const offset = sharedTextInsertionPosition(plan, side === "right" ? span.from - 1 : span.to);
        return { kind: "inline" as const, plan, offset };
      }
    }
    let rightKey = key;
    if (side === "right" && gap.affinity === "after") {
      for (let index = located.index - 1; index >= 0; index--) {
        const previous = sharedPlannedSegmentAt(view, order, index);
        const head = previous === undefined ? undefined : view.get(["segments", previous, "head"]);
        const boundary = readProjectionHead(head);
        if (boundary?.kind !== "h" || previous === undefined) break;
        const previousPlan = sharedTextCommandPlan(view, { owner: boundary.id as SharedContentRef, segment: previous as SharedContentRef, field: "heading" });
        if (sharedStructureSpans(view, previous, previousPlan.units).some(span => span.field === "audioText")) break;
        rightKey = previous as string;
      }
    }
    const at = { left: side === "left" ? key as SharedContentRef : null, right: side === "right" ? rightKey as SharedContentRef : null, affinity: gap.affinity };
    return { kind: "order" as const, index: prepareSharedOrderInsertion(view, order, at, segment) };
  }
  if (gap.right !== null) throw new SharedStructurePreparationError("missing-order-target");
  return { kind: "order" as const, index: prepareSharedOrderInsertion(view, order, { left: null, right: null, affinity: gap.affinity }, segment) };
}
