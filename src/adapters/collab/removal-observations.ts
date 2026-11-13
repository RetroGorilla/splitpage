import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedPreparationView } from "./prepare.ts";
import type { SharedTextIdentity } from "./mark-record.ts";
import type { SharedPlannedTextUnit, SharedTextCommandPlan } from "./executor-text-plan.ts";
import { requireSharedTextOwnership, sharedTextPlanSlot, SharedTextPreparationError } from "./executor-text-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";

export interface SharedRemovalCapture {
  readonly target: SharedTextAddress; readonly known: readonly SharedTextIdentity[]; readonly positions: readonly number[];
}

function capture(view: SharedPreparationView, plan: SharedTextCommandPlan, units: ReadonlySet<SharedPlannedTextUnit>): SharedRemovalCapture {
  const facade = view.text(plan.path), original = new Map(plan.native.units.map((unit, index) => [unit, facade?.units[index]?.identity]));
  const current = new Map(plan.units.map((unit, index) => [unit, index])), known: SharedTextIdentity[] = [], positions: number[] = [];
  for (const unit of units) {
    const identity = original.get(unit), position = current.get(unit);
    if (identity) known.push({ client: identity.client, clock: identity.clock });
    else if (position !== undefined) positions.push(position);
  }
  return { target: plan.target, known, positions };
}

export function prepareSharedRemovalObservations(view: SharedPreparationView, plans: readonly SharedTextCommandPlan[], references: readonly SharedContentRef[], visuals: readonly { readonly beat: SharedContentRef; readonly record: SharedContentRef }[], owned = true): SharedRemovalCapture[] {
  const selected = new Map(plans.map(plan => [plan, new Set<SharedPlannedTextUnit>()]));
  for (const reference of references) {
    let matched = false;
    for (const plan of plans) {
      try {
        const range = resolveSharedTextReference(view, plan, reference, "range");
        if (owned) requireSharedTextOwnership(view, plan, range.from, range.to);
        for (const unit of range.units) selected.get(plan)?.add(unit);
        matched = true; break;
      } catch (error) {
        if (!(error instanceof SharedTextPreparationError)) throw error;
        if (error.message === "stale-base") throw error;
      }
    }
    if (!matched) throw new SharedTextPreparationError("invalid-reference");
  }
  return [...plans.map(plan => capture(view, plan, selected.get(plan) as ReadonlySet<SharedPlannedTextUnit>)), ...visuals.map(({ beat, record }) => {
    const path = ["visuals", record, "text"], plan = sharedTextPlanSlot(view, path).plan;
    return plan ? capture(view, plan, new Set(plan.units)) : {
      target: { owner: beat, segment: record, field: "visualText" as const },
      known: (view.text(path)?.units ?? []).map(unit => ({ client: unit.identity.client, clock: unit.identity.clock })), positions: []
    };
  })];
}
