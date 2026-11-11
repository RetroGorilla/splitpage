import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedPreparationView } from "../../../src/adapters/collab/prepare.ts";
import type { SharedPreparationText } from "../../../src/adapters/collab/prepare-text.ts";
import { prepareSharedMarkWrite } from "../../../src/adapters/collab/mark-plan.ts";
import { applySharedTextEdit } from "../../../src/adapters/collab/text-edit.ts";
import { readSharedTextTarget } from "../../../src/adapters/collab/text-target.ts";

export function installTextSeamProbe(handle: SharedDocumentHandle, inspect?: (view: SharedPreparationView, text: SharedPreparationText) => void): void {
  registerSharedOperationHandlers(handle, { "text-insert": (op, view) => {
    const path = ["segments", "b:R1", "text"], text = view.text(path), target = readSharedTextTarget({ owner: "R1", segment: "b:R1", field: "audioText" });
    if (!text || !target || view.kind(["segments", "b:R1", "markRecords"]) !== "map") return { ok: false, reason: "missing-text" };
    inspect?.(view, text);
    const plan = view.scratch("text:R1", () => ({ units: text.units.map(unit => unit.value), keys: [...text.recordKeys], additions: text.records.filter(item => item.record.type === "add").map(item => item.identity) }));
    const from = Number(op.at.right), chunk = op.content[0];
    if (!chunk || typeof chunk.value !== "string" || !chunk.value.length || !Number.isSafeInteger(from) || from < 0 || from > plan.units.length) return { ok: false, reason: "invalid-fixture-range" };
    const value = chunk.value;
    plan.units.splice(from, 0, ...value.split(""));
    const input = { length: plan.units.length, recordKeys: plan.keys };
    const birth = prepareSharedMarkWrite(input, Number(view.writer), op.id, from, from + value.length, { type: "birth", observed: plan.additions, born: "inserted" });
    const addition = chunk.marks[0] && prepareSharedMarkWrite(input, Number(view.writer), op.id + ":mark", from, from + value.length, { type: "add", mark: chunk.marks[0], born: "inserted" });
    if (!birth || chunk.marks.length && !addition) return { ok: false, reason: "invalid-mark-plan" };
    const marks = addition ? [birth, addition] : [birth];
    plan.keys.push(...marks.map(mark => mark.identity));
    if (addition) plan.additions.push(addition.identity);
    const writes = [{ kind: "text" as const, path, value: [{ insert: plan.units.join("") }] },
      ...marks.map(mark => ({ kind: "set" as const, path: ["segments", "b:R1", "markRecords", mark.identity], value: mark }))];
    return { ok: true, writes, apply: current => applySharedTextEdit(current, { target, edit: { type: "text", at: from, value }, marks }) };
  } });
}
