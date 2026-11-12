import type { SharedDocumentHandle } from "./types.ts";
import { collabState, assertNoSharedExecution, guardSharedCallback } from "./state.ts";

export interface SharedStructureOrderView {
  readonly length: () => number;
  readonly index: (segment: string) => number;
  readonly at: (index: number) => string | undefined;
}

let orderViews: WeakMap<SharedDocumentHandle, SharedStructureOrderView> | null = null;

export function observeSharedStructureOrder(handle: SharedDocumentHandle): SharedStructureOrderView {
  const state = collabState(handle); assertNoSharedExecution(state);
  orderViews ??= new WeakMap();
  const previous = orderViews.get(handle); if (previous) return previous;
  const order = state.roots.order, values = order.toArray(), positions = new Map<string, number>();
  const rebuild = () => { positions.clear(); values.forEach((value, index) => { if (!positions.has(value)) positions.set(value, index); }); };
  rebuild();
  const observe: Parameters<typeof order.observe>[0] = event => guardSharedCallback(state, () => {
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
  });
  order.observe(observe); state.doc.once("destroy", () => guardSharedCallback(state, () => order.unobserve(observe)));
  const view = Object.freeze({ length: () => values.length, index: (segment: string) => positions.get(segment) ?? -1, at: (index: number) => values[index] });
  orderViews.set(handle, view); return view;
}

export function sharedOrderPlan(view: { scratch: <T>(key: string, create: () => T) => T }, order: SharedStructureOrderView) {
  return view.scratch("structure-order", () => ({ length: order.length(), positions: [] as { segment: string; index: number }[], insertions: [] as { segment: string; index: number }[] }));
}

export function readPlannedStructureIndex(view: { scratch: <T>(key: string, create: () => T) => T }, order: SharedStructureOrderView, segment: string): number {
  const plan = sharedOrderPlan(view, order), cached = plan.positions.find(position => position.segment === segment);
  if (cached) return cached.index;
  let index = order.index(segment); if (index < 0) return -1;
  for (const inserted of plan.insertions) if (inserted.index <= index) index++;
  plan.positions.push({ segment, index }); return index;
}
