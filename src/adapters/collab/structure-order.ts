import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { collabState, SharedExecutionWriteError } from "./state.ts";
import { SharedStructurePreparationError, sharedStructureReference } from "./structure-identity.ts";
import type { SharedContentRef, SharedIdentityGap } from "../../core/collab/operations.ts";
import { isStableSharedIdentity } from "./identity.ts";

import type { SharedStructureOrderView } from "./structure-order-index.ts";
import { sharedOrderPlan, readPlannedStructureIndex } from "./structure-order-index.ts";

export function sharedStructureSegment(view: SharedPreparationView, raw: SharedContentRef): string {
  const reference = sharedStructureReference(view, raw);
  if (view.kind(["segments", reference]) === "map") return reference;
  for (const [root, prefix] of [["beats", "b:"], ["headings", "h:"]] as const) {
    if (view.kind([root, reference]) !== "map") continue;
    const segment = view.get([root, reference, "segment"]);
    if (segment !== undefined && (typeof segment !== "string" || !segment || !isStableSharedIdentity(segment))) throw new SharedStructurePreparationError("unstable-identity");
    return typeof segment === "string" ? segment : prefix + reference;
  }
  throw new SharedStructurePreparationError("missing-order-target");
}

export function sharedPlannedSegmentIndex(view: SharedPreparationView, order: SharedStructureOrderView, segment: string): number {
  const index = readPlannedStructureIndex(view, order, segment);
  if (index < 0) throw new SharedStructurePreparationError("missing-order-target");
  return index;
}

export function sharedPlannedSegmentAt(view: SharedPreparationView, order: SharedStructureOrderView, index: number): string | undefined {
  const plan = sharedOrderPlan(view, order);
  for (let step = plan.insertions.length - 1; step >= 0; step--) {
    const inserted = plan.insertions[step];
    if (!inserted) continue;
    if (index === inserted.index) return inserted.segment;
    if (index > inserted.index) index--;
  }
  return order.at(index);
}

export function prepareSharedOrderInsertion(view: SharedPreparationView, order: SharedStructureOrderView, at: SharedIdentityGap, segment: string): number {
  const plan = sharedOrderPlan(view, order);
  const left = at.left === null ? null : sharedPlannedSegmentIndex(view, order, at.left), right = at.right === null ? null : sharedPlannedSegmentIndex(view, order, at.right);
  if (left !== null && right !== null && left >= right) throw new SharedStructurePreparationError("invalid-order-gap");
  const index = (at.affinity === "before" ? right ?? (left === null ? null : left + 1) : left === null ? right : left + 1) ?? plan.length;
  for (const position of plan.positions) if (position.index >= index) position.index++;
  plan.positions.push({ segment, index }); plan.insertions.push({ segment, index }); plan.length++;
  return index;
}

export function applySharedOrderInsertion(handle: SharedDocumentHandle, description: { readonly index: number; readonly segment: string }): void {
  const state = collabState(handle);
  if (!state.execution?.applying) throw new SharedExecutionWriteError();
  state.roots.order.insert(description.index, [description.segment]);
}
