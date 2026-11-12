import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { applySharedMapWrites } from "./prepare.ts";
import type { SharedPreparationView, SharedPreparationResult, SharedPreparedWrite } from "./prepare.ts";
import type { SharedTextCommandPlan } from "./executor-text-plan.ts";
import type { SharedMarkWritePlan } from "./mark-plan.ts";
import type { SharedTextWritePlan } from "./text-edit.ts";
import { prepareSharedMarkWrite } from "./mark-plan.ts";
import { applySharedTextEdit } from "./text-edit.ts";
import { applySharedMarkWrite } from "./mark-store.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { SharedTextPreparationError } from "./executor-text-plan.ts";

export type SharedTextExecutionStep = { readonly kind: "edit"; readonly write: SharedTextWritePlan }
  | { readonly kind: "mark"; readonly target: SharedTextAddress; readonly plan: Extract<SharedMarkWritePlan, { kind: "record" }> }
  | { readonly kind: "map"; readonly writes: readonly SharedPreparedWrite[] };
export interface SharedTextExecutionDescription { readonly steps: readonly SharedTextExecutionStep[] }
export type SharedTextOperationPreparation = Extract<SharedPreparationResult, { ok: false }>
  | (Extract<SharedPreparationResult, { ok: true }> & { readonly description: SharedTextExecutionDescription });
type PlannedTextMarkChange = { readonly type: "add"; readonly mark: unknown; readonly born?: "inserted" }
  | { readonly type: "remove"; readonly observed: readonly string[] }
  | { readonly type: "birth"; readonly observed: readonly string[]; readonly born: "inserted" };

export function applySharedTextDescription(handle: SharedDocumentHandle, description: SharedTextExecutionDescription): void {
  for (const step of description.steps) {
    if (step.kind === "map") applySharedMapWrites(handle, step.writes);
    else if (step.kind === "edit") applySharedTextEdit(handle, step.write);
    else applySharedMarkWrite(handle, { target: step.target, plan: step.plan });
  }
}

export function preparedTextDescription(writes: readonly SharedPreparedWrite[], steps: readonly SharedTextExecutionStep[]): Extract<SharedTextOperationPreparation, { ok: true }> {
  const description = freezeSharedPreparedValue({ steps }), fixedWrites = freezeSharedPreparedValue(writes);
  return { ok: true, writes: fixedWrites, description, apply: handle => applySharedTextDescription(handle, description) };
}

export function prepareTextMarkWrite(plan: SharedTextCommandPlan, view: SharedPreparationView, operation: string, from: number, to: number, change: PlannedTextMarkChange): SharedMarkWritePlan {
  const record = prepareSharedMarkWrite({ length: plan.units.length, recordKeys: plan.recordKeys }, Number(view.writer), operation, from, to, change);
  if (!record) throw new SharedTextPreparationError("invalid-or-existing-mark-record");
  plan.recordKeys.push(record.identity);
  if (record.change.type === "add") {
    plan.additions.push({ identity: record.identity, mark: record.change.mark });
    for (const unit of plan.units.slice(from, to)) unit.additions.push(record.identity);
  } else if (record.change.type === "remove") {
    const observed = record.change.observed;
    for (const unit of plan.units.slice(from, to)) unit.additions = unit.additions.filter(identity => !observed.includes(identity));
  }
  return record;
}

export function preparedTextOperation(prepare: () => SharedTextOperationPreparation): SharedTextOperationPreparation {
  try { return prepare(); }
  catch (error) { if (error instanceof SharedTextPreparationError) return { ok: false, reason: error.message }; throw error; }
}
