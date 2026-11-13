import type { SharedMarkChange } from "../../core/collab/operations.ts";
import type { SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import type { SharedTextOperationPreparation, SharedTextExecutionStep } from "./text-description.ts";
import { preparedTextOperation, preparedTextDescription, prepareTextMarkWrite } from "./text-description.ts";
import { sharedTextCommandPlan, sharedTextRange, requireSharedTextOwnership, SharedTextPreparationError } from "./executor-text-plan.ts";
import type { SharedTextCommandPlan, SharedPlannedTextUnit } from "./executor-text-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { prepareSharedMarkTranslation } from "./mark-translation.ts";
import { readSharedMarkGeneration, sharedRangeMarkOperation } from "./mark-provenance.ts";
import { usesSharedJoinedText, readSharedJoinedText, sharedJoinedSelected } from "./joined-text-routing.ts";
import { sharedJoinFormatRegisterField } from "../../core/collab/projection/join-glue.ts";
import { FORMAT_MARKS } from "../../core/text/runs.ts";

interface MarkRange { from: number; to: number }

export function prepareSharedMarkChange(operation: SharedMarkChange, view: SharedPreparationView): SharedTextOperationPreparation {
  return preparedTextOperation(() => {
    if (!isStableSharedIdentity(operation.id) || !isStableSharedIdentity(operation.by)
      || !prepareSharedMarkTranslation(operation.mark, view.writer, operation.id, [0])) throw new SharedTextPreparationError("unstable-identity");
    if (!usesSharedJoinedText(view, operation.target)) return preparePhysicalMarkChange(operation, view);
    const row = readSharedJoinedText(view, operation.target); if (!row) throw new SharedTextPreparationError("missing-target");
    const writes: SharedPreparedWrite[] = [], steps: SharedTextExecutionStep[] = [];
    const selected = sharedJoinedSelected(view, row, operation.observed);
    // why: each range keeps its own position in the command, as in one text, so comment occurrences stay distinct.
    for (const part of selected.physical) {
      const planned = markSteps(operation, view, part.plan, unitRanges(view, part.plan, part.units), steps.length);
      writes.push(...planned.writes); steps.push(...planned.steps);
    }
    const format = FORMAT_MARKS.find(kind => kind === operation.mark.kind);
    // why: a removal deletes only the value it saw, so a concurrent add wins on the space as it does on the pieces.
    const spaces: SharedPreparedWrite[] = format ? selected.groups.flatMap((group): SharedPreparedWrite[] => {
      const path = ["meta", sharedJoinFormatRegisterField(group, format)];
      return operation.mark.value === true ? [{ kind: "set", path, value: true }] : view.has(path) ? [{ kind: "delete", path }] : [];
    }) : [];
    if (spaces.length) { writes.push(...spaces); steps.push({ kind: "map", writes: spaces }); }
    return preparedTextDescription(writes, steps);
  });
}

function preparePhysicalMarkChange(operation: SharedMarkChange, view: SharedPreparationView): SharedTextOperationPreparation {
  const plan = sharedTextCommandPlan(view, operation.target), value = plan.units.map(unit => typeof unit.value === "string" ? unit.value : "\ufffc").join("");
  const ranges: MarkRange[] = [];
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
  const planned = markSteps(operation, view, plan, ranges, 0);
  return preparedTextDescription(planned.writes, planned.steps);
}

function unitRanges(view: SharedPreparationView, plan: SharedTextCommandPlan, units: ReadonlySet<SharedPlannedTextUnit>): MarkRange[] {
  const ranges: MarkRange[] = [];
  for (let index = 0; index < plan.units.length; index++) if (units.has(plan.units[index] as SharedPlannedTextUnit)) {
    const last = ranges.at(-1);
    if (last?.to === index) last.to++; else ranges.push({ from: index, to: index + 1 });
  }
  for (const range of ranges) requireSharedTextOwnership(view, plan, range.from, range.to);
  return ranges;
}

function markSteps(operation: SharedMarkChange, view: SharedPreparationView, plan: SharedTextCommandPlan, ranges: readonly MarkRange[], first: number) {
  const known = view.text(plan.path)?.records ?? [];
  const steps: SharedTextExecutionStep[] = ranges.map((range, offset) => {
    const index = first + offset, active = new Set(plan.units.slice(range.from, range.to).flatMap(unit => unit.additions));
    const translated = prepareSharedMarkTranslation(operation.mark, view.writer, operation.id, [index], plan.additions.filter(addition => active.has(addition.identity)));
    if (!translated) throw new SharedTextPreparationError("unstable-identity");
    // why: a mark made after seeing the same change is the next one, so the undo of the earlier one leaves it.
    const seen = translated.type === "add" ? known.filter(item => item.record.type === "add" && item.record.born === null
      && item.record.mark.kind === translated.mark.kind && item.record.mark.value === translated.mark.value && item.from !== null && item.to !== null
      && plan.native.after[item.from] === range.from && plan.native.before[item.to] === range.to).map(item => readSharedMarkGeneration(item.record)) : [];
    const generation = seen.reduce((highest, value) => Math.max(highest, value), 0) + 1;
    const record = prepareTextMarkWrite(plan, view, sharedRangeMarkOperation(operation.id, index, generation), range.from, range.to, translated);
    if (record.kind !== "record") throw new SharedTextPreparationError("invalid-mark-plan");
    return { kind: "mark", target: plan.target, plan: record };
  });
  const writes: SharedPreparedWrite[] = steps.map(step => {
    if (step.kind !== "mark") throw new SharedTextPreparationError("invalid-mark-plan");
    return { kind: "set", path: [...plan.storePath, step.plan.identity], value: step.plan };
  });
  return { writes, steps };
}
