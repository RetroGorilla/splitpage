import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedStructureReadView } from "./structure-read-view.ts";
import type { readSharedJoinEntry } from "./join-record.ts";

export function sharedPlannedJoins(view: Pick<SharedStructureReadView, "scratch">) {
  return view.scratch("issued-joins", () => new Map<string, { readonly from: string; readonly entry: NonNullable<ReturnType<typeof readSharedJoinEntry>> }>());
}
export function sharedPlannedJoinEnds(view: Pick<SharedStructureReadView, "scratch">) {
  return view.scratch("issued-join-ends", () => new Map<string, { readonly target: SharedTextAddress; readonly point: { offset: number }; readonly source: SharedTextAddress; readonly start: { offset: number }; readonly stop: { offset: number } }>());
}
