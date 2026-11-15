import type { RowFieldStep, StepRow } from "../../../core/text/steps.ts";
import type { SharedRecordedCell } from "../../../core/collab/undo-record.ts";
import type { UndoDirection } from "./undo.ts";

export interface ReplayedDocument {
  readonly rows?: readonly Readonly<StepRow>[];
}

// why: standalone replays the cells its entry wrote, reversed for undo; the record keeps them from commit
export function replayedSteps(before: ReplayedDocument, after: ReplayedDocument, cells: readonly SharedRecordedCell[], dir: UndoDirection): RowFieldStep[] {
  const row = (doc: ReplayedDocument, rowId: string) => (doc.rows ?? []).find(item => item.id === rowId);
  const steps: RowFieldStep[] = [];
  for (const cell of dir === "undo" ? [...cells].reverse() : cells) {
    const was = row(before, cell.rowId), now = row(after, cell.rowId);
    if (!was || !now || was[cell.field] === now[cell.field]) continue;
    steps.push({ op: "rowField", rowId: cell.rowId, key: cell.field, before: was[cell.field], after: now[cell.field] });
  }
  return steps;
}
