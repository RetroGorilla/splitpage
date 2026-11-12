import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { collabState, assertSharedDocumentIdle, SharedExecutionWriteError } from "./state.ts";
import { SharedStructurePreparationError, sharedStructureReference } from "./structure-identity.ts";
import type { SharedContentRef, SharedIdentityGap } from "../../core/collab/operations.ts";
import { isStableSharedIdentity } from "./identity.ts";

export interface SharedStructureOrderView {
  readonly length: () => number;
  readonly index: (segment: string) => number;
  readonly at: (index: number) => string | undefined;
}

let orderViews: WeakMap<SharedDocumentHandle, SharedStructureOrderView> | null = null;

export function observeSharedStructureOrder(handle: SharedDocumentHandle): SharedStructureOrderView {
  const state = collabState(handle); assertSharedDocumentIdle(state);
  orderViews ??= new WeakMap();
  const previous = orderViews.get(handle); if (previous) return previous;
  const order = state.roots.order, values = order.toArray(), positions = new Map<string, number>();
  const rebuild = () => { positions.clear(); values.forEach((value, index) => { if (!positions.has(value)) positions.set(value, index); }); };
  rebuild();
  const observe: Parameters<typeof order.observe>[0] = event => {
    let offset = 0;
    for (const change of event.delta) {
      if (change.retain) offset += change.retain;
      if (change.delete) values.splice(offset, change.delete);
      if (change.insert) {
        const inserted = change.insert as string[];
        for (let start = 0; start < inserted.length; start += 1024) values.splice(offset + start, 0, ...inserted.slice(start, start + 1024));
        offset += inserted.length;
      }
    }
    rebuild();
  };
  order.observe(observe); state.doc.once("destroy", () => order.unobserve(observe));
  const view = Object.freeze({ length: () => values.length, index: (segment: string) => positions.get(segment) ?? -1, at: (index: number) => values[index] });
  orderViews.set(handle, view); return view;
}

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

function sharedOrderPlan(view: SharedPreparationView, order: SharedStructureOrderView) {
  return view.scratch("structure-order", () => ({ length: order.length(), positions: [] as { segment: string; index: number }[], insertions: [] as { segment: string; index: number }[] }));
}

export function sharedPlannedSegmentIndex(view: SharedPreparationView, order: SharedStructureOrderView, segment: string): number {
  const plan = sharedOrderPlan(view, order), cached = plan.positions.find(position => position.segment === segment);
  if (cached) return cached.index;
  let index = order.index(segment);
  if (index < 0) throw new SharedStructurePreparationError("missing-order-target");
  for (const inserted of plan.insertions) if (inserted.index <= index) index++;
  plan.positions.push({ segment, index }); return index;
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
