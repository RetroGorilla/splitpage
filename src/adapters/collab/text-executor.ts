import type { SharedTextInsert, SharedTextDelete, SharedInlineValue } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView } from "./prepare.ts";
import type { SharedMarkWritePlan } from "./mark-plan.ts";
import type { SharedTextWritePlan } from "./text-edit.ts";
import { registerSharedOperationHandlers } from "./operation-handlers.ts";
import { sharedTextCommandPlan, sharedTextOverlay, spliceSharedTextPlan, sharedTextInsertionPosition, requireSharedTextOwnership, SharedTextPreparationError } from "./executor-text-plan.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { reserveSharedCommandIdentities } from "./structure-identity.ts";
import { sharedPreparedTextInsert } from "./prepare-value.ts";
import { prepareSharedMarkTranslation } from "./mark-translation.ts";

import { preparedTextDescription, prepareTextMarkWrite, preparedTextOperation } from "./text-description.ts";
import type { SharedTextOperationPreparation } from "./text-description.ts";
import { prepareSharedMarkChange } from "./mark-executor.ts";

export function sharedInlineContent(value: SharedInlineValue): string | Readonly<Record<string, unknown>> {
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
    let offset = sharedTextInsertionPosition(plan, (at.affinity === "before" ? right?.from ?? left?.from : left?.from ?? right?.from) ?? 0);
    requireSharedTextOwnership(view, plan, offset, offset);
    const chunks = operation.content.map((chunk, chunkIndex) => {
      if (typeof chunk.value !== "string" && chunk.value.atom === "broll" && !reserveSharedCommandIdentities(view, [chunk.value.id])) throw new SharedTextPreparationError("existing-identity");
      const value = sharedPreparedTextInsert(sharedInlineContent(chunk.value));
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
    for (const range of ranges) requireSharedTextOwnership(view, plan, range.from, range.to);
    ranges.reverse();
    for (const range of ranges) spliceSharedTextPlan(plan, range.from, range.to, []);
    return preparedTextDescription(ranges.length ? [sharedTextOverlay(plan)] : [], ranges.map(range => ({ kind: "edit", write: { target: plan.target,
      edit: { type: "delete", from: range.from, to: range.to }, marks: [] } })));
  });
}

export function registerSharedTextOperationHandlers(handle: SharedDocumentHandle): void {
  registerSharedOperationHandlers(handle, { "text-insert": prepareSharedTextInsertion, "text-delete": prepareSharedTextDeletion, mark: prepareSharedMarkChange });
}
