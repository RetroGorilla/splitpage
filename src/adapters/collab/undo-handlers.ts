import type { SharedContentRef, SharedMarkRetract, SharedTextRestore } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import type { SharedMarkWritePlan } from "./mark-plan.ts";
import type { SharedTextWritePlan } from "./text-edit.ts";
import type { SharedTextExecutionStep, SharedTextOperationPreparation } from "./text-description.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { preparedTextDescription, preparedTextOperation, prepareTextMarkWrite } from "./text-description.ts";
import {
  sharedTextCommandPlan, sharedTextOverlay, spliceSharedTextPlan, sharedTextInsertionPosition, requireSharedTextOwnership, SharedTextPreparationError
} from "./executor-text-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { sharedInlineContent } from "./text-executor.ts";
import { sharedPreparedTextInsert } from "./prepare-value.ts";
import { readSharedAnchorUnit } from "./anchors.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { prepareSharedStatusRetire } from "./status.ts";
import { prepareSharedSplitRestore, prepareSharedSplitRetire } from "./undo-split.ts";
import { SHARED_MARK_PROVENANCE_MARKER, readSharedTextRestoreOperation, sharedMarkCopyOperation, sharedMarkRetractOperation, sharedTextRestoreOperation } from "./mark-provenance.ts";

function checkAuthor(operation: { readonly id: string; readonly by: string }): void {
  if (!isStableSharedIdentity(operation.id) || !isStableSharedIdentity(operation.by)) throw new SharedTextPreparationError("unstable-identity");
}

// why: readers look for retractions and copies only on a text with this marker, so the first one writes it.
function marker(view: SharedPreparationView, store: readonly string[]): SharedPreparedWrite[] {
  const path = [...store, SHARED_MARK_PROVENANCE_MARKER];
  return view.has(path) ? [] : [{ kind: "set", path, value: true }];
}

function marked(writes: readonly SharedPreparedWrite[], steps: readonly SharedTextExecutionStep[], extra: readonly SharedPreparedWrite[]): SharedTextOperationPreparation {
  const prepared = preparedTextDescription([...writes, ...extra], steps);
  return extra.length ? { ...prepared, apply: handle => { prepared.apply(handle); applySharedMapWrites(handle, extra); } } : prepared;
}

export function prepareSharedTextRestore(operation: SharedTextRestore, view: SharedPreparationView): SharedTextOperationPreparation {
  return preparedTextOperation(() => {
    checkAuthor(operation);
    const plan = sharedTextCommandPlan(view, operation.target), facade = view.text(plan.path);
    if (!facade) throw new SharedTextPreparationError("missing-target");
    const restored = new Set(facade.records.flatMap(item => {
      const original = item.record.type === "birth" ? readSharedTextRestoreOperation(item.record.operation) : null;
      return original ? [original.client + ":" + original.clock] : [];
    }));
    const edits: SharedTextWritePlan[] = [], records: SharedMarkWritePlan[] = [];
    let previous: { readonly left: SharedContentRef | null; readonly end: number } | null = null;
    operation.units.forEach((unit, index) => {
      const original = readSharedAnchorUnit(unit.unit), place = facade.resolveAnchor(unit.unit);
      if (!original || original.after || place.kind === "gone") throw new SharedTextPreparationError("invalid-reference");
      // why: a character that is visible again, or that someone already restored, comes back once.
      if (place.kind === "index" || restored.has(original.client + ":" + original.clock)) return;
      let offset: number;
      // why: characters restored after the same neighbour keep the order they are given in.
      if (previous && previous.left === unit.left) offset = previous.end;
      else if (unit.left === null) offset = resolveSharedTextReference(view, plan, unit.unit, "point").from;
      else {
        const left = resolveSharedTextReference(view, plan, unit.left, "range");
        if (!left.units.length) throw new SharedTextPreparationError("invalid-reference");
        offset = left.to;
      }
      offset = sharedTextInsertionPosition(plan, offset);
      requireSharedTextOwnership(view, plan, offset, offset);
      const value = sharedPreparedTextInsert(sharedInlineContent(unit.value));
      if (typeof value !== "string" && (!value || typeof value !== "object" || Array.isArray(value))) throw new SharedTextPreparationError("invalid-content");
      const content = value as string | Readonly<Record<string, unknown>>, length = typeof content === "string" ? content.length : 1;
      if (!length) return;
      const observed = plan.additions.map(item => item.identity);
      spliceSharedTextPlan(plan, offset, offset, typeof content === "string" ? content.split("") : [content]);
      const marks = [prepareTextMarkWrite(plan, view, sharedTextRestoreOperation(operation.id, index, original), offset, offset + length,
        { type: "birth", observed, born: "inserted" })];
      unit.marks.forEach((source, markIndex) => {
        const found = plan.additions.find(item => item.identity === source);
        if (!found) throw new SharedTextPreparationError("invalid-reference");
        marks.push(prepareTextMarkWrite(plan, view, sharedMarkCopyOperation(operation.id, index, markIndex, source), offset, offset + length,
          { type: "add", mark: found.mark, born: "inserted" }));
      });
      for (const mark of marks) records.push(mark);
      const beside = { client: original.client, clock: original.clock + length - 1 };
      edits.push({ target: plan.target, marks,
        edit: typeof content === "string" ? { type: "text", at: offset, value: content, beside } : { type: "atom", at: offset, value: content, beside } });
      previous = { left: unit.left, end: offset + length };
    });
    const copied = records.length > edits.length;
    return marked(edits.length ? [sharedTextOverlay(plan), ...records.map(record => ({ kind: "set" as const, path: [...plan.storePath, record.identity], value: record }))] : [],
      edits.map(write => ({ kind: "edit", write })), copied ? marker(view, plan.storePath) : []);
  });
}

export function prepareSharedMarkRetract(operation: SharedMarkRetract, view: SharedPreparationView): SharedTextOperationPreparation {
  return preparedTextOperation(() => {
    checkAuthor(operation);
    const plan = sharedTextCommandPlan(view, operation.target), known = view.text(plan.path)?.records ?? [];
    const steps: SharedTextExecutionStep[] = operation.occurrences.map((occurrence, index) => {
      const found = known.find(item => item.identity === occurrence && item.record.type === "add");
      if (!found) throw new SharedTextPreparationError("invalid-reference");
      const from = found.from === null ? 0 : plan.native.after[found.from] ?? 0, to = Math.max(from, found.to === null ? 0 : plan.native.before[found.to] ?? 0);
      const record = prepareTextMarkWrite(plan, view, sharedMarkRetractOperation(operation.id, index), from, to, { type: "remove", observed: [occurrence] });
      if (record.kind !== "record") throw new SharedTextPreparationError("invalid-mark-plan");
      return { kind: "mark", target: plan.target, plan: record };
    });
    return marked(steps.map(step => {
      if (step.kind !== "mark") throw new SharedTextPreparationError("invalid-mark-plan");
      return { kind: "set", path: [...plan.storePath, step.plan.identity], value: step.plan };
    }), steps, steps.length ? marker(view, plan.storePath) : []);
  });
}

export function registerSharedUndoOperationHandlers(handle: SharedDocumentHandle): void {
  registerSharedOperationHandlers(handle, { "text-restore": prepareSharedTextRestore, "mark-retract": prepareSharedMarkRetract, "status-retire": prepareSharedStatusRetire,
    "split-retire": prepareSharedSplitRetire, "split-restore": prepareSharedSplitRestore });
}
