import type { RowFieldStep, StepRow } from "../../../core/text/steps.ts";
import type { ChangeSet } from "../../session/change-set.ts";
import { diffStates } from "./history.ts";

const TEXT_FIELDS: readonly string[] = Object.freeze(["audioText", "visualText"]);

export interface ReplayedDocument {
  readonly rows?: readonly Readonly<StepRow>[];
}

function rowOf(doc: ReplayedDocument, rowId: string): Readonly<StepRow> | undefined {
  return (doc.rows ?? []).find(row => row.id === rowId);
}

// why: a shared replay gives the caret the same cell steps a standalone replay applies, from the rows the change names
export function replayedTextSteps(before: ReplayedDocument, after: ReplayedDocument, changes: ChangeSet): RowFieldStep[] {
  if (changes.whole || changes.cells.some(cell => cell.rowId === null)) {
    return diffStates({ rows: [...before.rows ?? []] }, { rows: [...after.rows ?? []] }).filter((step): step is RowFieldStep => step.op === "rowField" && TEXT_FIELDS.includes(step.key));
  }
  const steps: RowFieldStep[] = [];
  for (const cell of changes.cells) for (const key of TEXT_FIELDS) {
    const rowId = cell.rowId;
    if (rowId === null || cell.field !== null && cell.field !== key || steps.some(step => step.rowId === rowId && step.key === key)) continue;
    const was = rowOf(before, rowId)?.[key], now = rowOf(after, rowId)?.[key];
    if (now === undefined || was === now) continue;
    steps.push({ op: "rowField", rowId, key, before: was ?? "", after: now });
  }
  return steps;
}
