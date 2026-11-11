import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { collabState, assertSharedDocumentIdle, SharedExecutionWriteError } from "./state.ts";
import { SharedStructurePreparationError, sharedStructureReference } from "./structure-identity.ts";
import type { SharedContentRef, SharedIdentityGap } from "../../core/collab/operations.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { readSharedStructureBoundary } from "./structure-boundary.ts";

export interface SharedStructureOrderView {
  readonly length: () => number;
  readonly index: (segment: string) => number;
  readonly previous: (segment: string) => string | null;
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
  const view = Object.freeze({ length: () => values.length, index: (segment: string) => positions.get(segment) ?? -1,
    previous: (segment: string) => values[(positions.get(segment) ?? 0) - 1] ?? null });
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

export function prepareSharedOrderInsertion(view: SharedPreparationView, order: SharedStructureOrderView, at: SharedIdentityGap, segment: string): number {
  const plan = view.scratch("structure-order", () => ({ length: order.length(), positions: [] as { segment: string; index: number }[], insertions: [] as number[] }));
  const position = (reference: SharedContentRef, side: "left" | "right"): number => {
    const key = sharedStructureSegment(view, reference);
    const owner = sharedStructureReference(view, reference);
    if (view.kind(["headings", owner]) === "map") throw new SharedStructurePreparationError("heading-placement-required");
    if (view.kind(["beats", owner]) === "map") {
      const head = readSharedStructureBoundary(view.get(["segments", key, "head"])), deltas = view.get(["segments", key, "text"]);
      if (head?.owner !== owner || head.field !== "audioText") throw new SharedStructurePreparationError("partial-segment-gap");
      if (!Array.isArray(deltas)) throw new SharedStructurePreparationError("invalid-order-target");
      for (let index = 0; index < deltas.length; index++) if (readSharedStructureBoundary((deltas[index] as { insert?: unknown } | undefined)?.insert)) throw new SharedStructurePreparationError("partial-segment-gap");
      const previous = side === "right" ? order.previous(key) : null;
      if (previous && readSharedStructureBoundary(view.get(["segments", previous, "head"]))?.field === "heading") throw new SharedStructurePreparationError("heading-placement-required");
    }
    const cached = plan.positions.find(position => position.segment === key);
    if (cached) return cached.index;
    let index = order.index(key);
    if (index < 0) throw new SharedStructurePreparationError("missing-order-target");
    for (const inserted of plan.insertions) if (inserted <= index) index++;
    plan.positions.push({ segment: key, index }); return index;
  };
  const left = at.left === null ? null : position(at.left, "left"), right = at.right === null ? null : position(at.right, "right");
  if (left !== null && right !== null && left >= right) throw new SharedStructurePreparationError("invalid-order-gap");
  const index = (at.affinity === "before" ? right ?? (left === null ? null : left + 1) : left === null ? right : left + 1) ?? plan.length;
  for (const position of plan.positions) if (position.index >= index) position.index++;
  plan.positions.push({ segment, index }); plan.insertions.push(index); plan.length++;
  return index;
}

export function applySharedOrderInsertion(handle: SharedDocumentHandle, description: { readonly index: number; readonly segment: string }): void {
  const state = collabState(handle);
  if (!state.execution?.applying) throw new SharedExecutionWriteError();
  state.roots.order.insert(description.index, [description.segment]);
}
