import type { SharedTextInsert, SharedTextDelete, SharedInlineValue, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView, SharedPreparationResult, SharedPreparedWrite } from "./prepare.ts";
import type { SharedTextCommandPlan } from "./executor-text-plan.ts";
import type { SharedMarkWriteChangeInput, SharedMarkWritePlan } from "./mark-plan.ts";
import type { SharedTextWritePlan } from "./text-edit.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import { sharedTextCommandPlan, sharedTextOverlay, spliceSharedTextPlan, sharedTextRange, SharedTextPreparationError } from "./executor-text-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { prepareSharedMarkWrite } from "./mark-plan.ts";
import { applySharedTextEdit } from "./text-edit.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { freezeSharedPreparedValue, sharedPreparedTextInsert } from "./prepare-value.ts";
import { applySharedMarkWrite } from "./mark-store.ts";
import { prepareSharedMarkTranslation } from "./mark-translation.ts";

export type SharedTextExecutionStep = { readonly kind: "edit"; readonly write: SharedTextWritePlan }
  | { readonly kind: "mark"; readonly target: SharedTextAddress; readonly plan: Extract<SharedMarkWritePlan, { kind: "record" }> };
export interface SharedTextExecutionDescription { readonly steps: readonly SharedTextExecutionStep[] }
export type SharedTextOperationPreparation = Extract<SharedPreparationResult, { ok: false }>
  | (Extract<SharedPreparationResult, { ok: true }> & { readonly description: SharedTextExecutionDescription });

function applyTextDescription(handle: SharedDocumentHandle, description: SharedTextExecutionDescription): void {
  for (const step of description.steps) {
    if (step.kind === "edit") applySharedTextEdit(handle, step.write);
    else applySharedMarkWrite(handle, { target: step.target, plan: step.plan });
  }
}

export function preparedTextDescription(writes: readonly SharedPreparedWrite[], steps: readonly SharedTextExecutionStep[]): Extract<SharedTextOperationPreparation, { ok: true }> {
  const description = freezeSharedPreparedValue({ steps }), fixedWrites = freezeSharedPreparedValue(writes);
  return { ok: true, writes: fixedWrites, description, apply: handle => applyTextDescription(handle, description) };
}

function inline(value: SharedInlineValue): string | Readonly<Record<string, unknown>> {
  if (typeof value === "string") return value;
  switch (value.atom) {
    case "who": return { w: value.name };
    case "broll":
      if (!isStableSharedIdentity(value.id)) throw new SharedTextPreparationError("unstable-identity");
      return value.text === undefined ? { k: value.id } : { k: value.id, label: value.text };
    case "image": return { img: value.ref };
    case "video": return { video: value.href, host: value.host };
  }
}

export function prepareTextMarkWrite(plan: SharedTextCommandPlan, view: SharedPreparationView, operation: string, from: number, to: number, change: SharedMarkWriteChangeInput): SharedMarkWritePlan {
  const record = prepareSharedMarkWrite({ length: plan.units.length, recordKeys: plan.recordKeys }, Number(view.writer), operation, from, to, change);
  if (!record) throw new SharedTextPreparationError("invalid-or-existing-mark-record");
  plan.recordKeys.push(record.identity);
  if (record.change.type === "add") plan.additions.push({ identity: record.identity, mark: record.change.mark });
  return record;
}

export function preparedTextOperation(prepare: () => SharedTextOperationPreparation): SharedTextOperationPreparation {
  try { return prepare(); }
  catch (error) { if (error instanceof SharedTextPreparationError) return { ok: false, reason: error.message }; throw error; }
}

function checkAuthor(operation: SharedTextInsert | SharedTextDelete): void {
  if (!isStableSharedIdentity(operation.id) || !isStableSharedIdentity(operation.by)) throw new SharedTextPreparationError("unstable-identity");
}

export function prepareSharedTextInsertion(operation: SharedTextInsert, view: SharedPreparationView): SharedTextOperationPreparation {
  return preparedTextOperation(() => {
    checkAuthor(operation);
    const plan = sharedTextCommandPlan(view, operation.target), { at } = operation;
    const left = at.left === null ? null : resolveSharedTextReference(view, plan, at.left, "left");
    const right = at.right === null ? null : resolveSharedTextReference(view, plan, at.right, "point");
    if (left && right && left.from > right.from || !left && !right && plan.units.length) throw new SharedTextPreparationError("invalid-reference");
    let offset = (at.affinity === "before" ? right?.from ?? left?.from : left?.from ?? right?.from) ?? 0;
    offset = sharedTextRange(plan.units.map(unit => typeof unit.value === "string" ? unit.value : "\ufffc").join(""), offset, offset).from;
    const chunks = operation.content.map((chunk, chunkIndex) => {
      const value = sharedPreparedTextInsert(inline(chunk.value));
      if (typeof value !== "string" && (!value || typeof value !== "object" || Array.isArray(value))) throw new SharedTextPreparationError("invalid-content");
      const marks = chunk.marks.map((mark, markIndex) => {
        const translated = prepareSharedMarkTranslation(mark, view.writer, operation.id, [chunkIndex, markIndex]);
        if (!translated) throw new SharedTextPreparationError("unstable-identity");
        return translated;
      }).flatMap(mark => mark.type === "add" ? [mark.mark] : []);
      return { value: value as string | Readonly<Record<string, unknown>>, marks };
    });
    const values = chunks.flatMap<unknown>(chunk => typeof chunk.value === "string" ? chunk.value.split("") : [chunk.value]);
    if (!values.length) return preparedTextDescription([], []);
    spliceSharedTextPlan(plan, offset, offset, values, operation.id);
    const edits: SharedTextWritePlan[] = [], records: SharedMarkWritePlan[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]; if (!chunk) throw new SharedTextPreparationError("invalid-content");
      const length = typeof chunk.value === "string" ? chunk.value.length : 1;
      if (!length) continue;
      const marks = [prepareTextMarkWrite(plan, view, JSON.stringify(["text-birth", operation.id, index]), offset, offset + length,
        { type: "birth", observed: plan.additions.map(item => item.identity), born: "inserted" })];
      chunk.marks.forEach((mark, markIndex) => marks.push(prepareTextMarkWrite(plan, view, JSON.stringify(["text-mark", operation.id, index, markIndex]), offset, offset + length, { type: "add", mark, born: "inserted" })));
      for (const mark of marks) records.push(mark);
      edits.push({ target: plan.target, edit: typeof chunk.value === "string" ? { type: "text", at: offset, value: chunk.value } : { type: "atom", at: offset, value: chunk.value }, marks });
      offset += length;
    }
    return preparedTextDescription([sharedTextOverlay(plan), ...records.map(record => ({ kind: "set" as const, path: [...plan.storePath, record.identity], value: record }))],
      edits.map(write => ({ kind: "edit", write })));
  });
}

export function prepareSharedTextDeletion(operation: SharedTextDelete, view: SharedPreparationView): SharedTextOperationPreparation {
  return preparedTextOperation(() => {
    checkAuthor(operation);
    const plan = sharedTextCommandPlan(view, operation.target), selected = new Set(operation.observed.flatMap(reference => resolveSharedTextReference(view, plan, reference, "range").units));
    const ranges: { from: number; to: number }[] = [];
    for (let index = 0; index < plan.units.length; index++) if (selected.has(plan.units[index] as typeof plan.units[number])) {
      const last = ranges.at(-1);
      if (last?.to === index) last.to++;
      else ranges.push({ from: index, to: index + 1 });
    }
    ranges.reverse();
    for (const range of ranges) spliceSharedTextPlan(plan, range.from, range.to, []);
    return preparedTextDescription(ranges.length ? [sharedTextOverlay(plan)] : [], ranges.map(range => ({ kind: "edit", write: { target: plan.target,
      edit: { type: "delete", from: range.from, to: range.to }, marks: [] } })));
  });
}

export function registerSharedTextOperationHandlers(handle: SharedDocumentHandle): void {
  registerSharedOperationHandlers(handle, { "text-insert": prepareSharedTextInsertion, "text-delete": prepareSharedTextDeletion });
}
