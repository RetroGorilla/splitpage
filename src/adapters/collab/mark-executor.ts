import type { SharedMarkChange } from "../../core/collab/operations.ts";
import type { SharedPreparationView } from "./prepare.ts";
import type { SharedTextOperationPreparation, SharedTextExecutionStep } from "./text-description.ts";
import { preparedTextOperation, preparedTextDescription, prepareTextMarkWrite } from "./text-description.ts";
import { sharedTextCommandPlan, sharedTextRange, requireSharedTextOwnership, SharedTextPreparationError } from "./executor-text-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { prepareSharedMarkTranslation } from "./mark-translation.ts";
import { sharedRangeMarkOperation } from "./mark-provenance.ts";

export function prepareSharedMarkChange(operation: SharedMarkChange, view: SharedPreparationView): SharedTextOperationPreparation {
  return preparedTextOperation(() => {
    if (!isStableSharedIdentity(operation.id) || !isStableSharedIdentity(operation.by)
      || !prepareSharedMarkTranslation(operation.mark, view.writer, operation.id, [0])) throw new SharedTextPreparationError("unstable-identity");
    const plan = sharedTextCommandPlan(view, operation.target), value = plan.units.map(unit => typeof unit.value === "string" ? unit.value : "\ufffc").join("");
    const ranges: { from: number; to: number }[] = [], known = view.text(plan.path)?.records ?? [];
    const resolved = operation.observed.map(reference => {
      const range = resolveSharedTextReference(view, plan, reference, "range"), clamped = sharedTextRange(value, range.from, range.to);
      requireSharedTextOwnership(view, plan, clamped.from, clamped.to); return clamped;
    }).sort((a, b) => a.from - b.from || a.to - b.to);
    for (const range of resolved) {
      if (range.to === range.from) continue;
      const previous = ranges.at(-1);
      if (previous && previous.to >= range.from) previous.to = Math.max(previous.to, range.to);
      else ranges.push({ from: range.from, to: range.to });
    }
    const steps: SharedTextExecutionStep[] = ranges.map((range, index) => {
      const active = new Set(plan.units.slice(range.from, range.to).flatMap(unit => unit.additions));
      const translated = prepareSharedMarkTranslation(operation.mark, view.writer, operation.id, [index], plan.additions.filter(addition => active.has(addition.identity)));
      if (!translated) throw new SharedTextPreparationError("unstable-identity");
      // why: an occurrence names the same change it had seen, so the undo of that one leaves this one.
      const seen = translated.type === "add" ? known.filter(item => item.record.type === "add" && item.record.born === null
        && item.record.mark.kind === translated.mark.kind && item.record.mark.value === translated.mark.value && item.from !== null && item.to !== null
        && plan.native.after[item.from] === range.from && plan.native.before[item.to] === range.to).map(item => item.identity) : [];
      const record = prepareTextMarkWrite(plan, view, sharedRangeMarkOperation(operation.id, index, seen), range.from, range.to, translated);
      if (record.kind !== "record") throw new SharedTextPreparationError("invalid-mark-plan");
      return { kind: "mark", target: plan.target, plan: record };
    });
    return preparedTextDescription(steps.map(step => {
      if (step.kind !== "mark") throw new SharedTextPreparationError("invalid-mark-plan");
      return { kind: "set", path: [...plan.storePath, step.plan.identity], value: step.plan };
    }), steps);
  });
}
