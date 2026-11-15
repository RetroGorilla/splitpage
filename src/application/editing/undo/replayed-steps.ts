import type { Step, StepRow } from "../../../core/text/steps.ts";
import { invertSteps } from "../../../core/text/steps.ts";
import type { ChangeSet } from "../../session/change-set.ts";
import type { UndoDirection } from "./undo.ts";
import { diffStates } from "./history.ts";

export interface ReplayedDocument {
  readonly rows?: readonly Readonly<StepRow>[];
}

const WRITTEN_ORDER: readonly string[] = Object.freeze(["id", "audioText", "visualText", "imageRef", "status"]);

// why: diffStates follows key order, so projected rows take the field order flow.ts writes
function written(row: Readonly<StepRow>): StepRow {
  const ordered: StepRow = {};
  for (const key of WRITTEN_ORDER) if (Object.hasOwn(row, key)) ordered[key] = row[key];
  for (const key of Object.keys(row)) if (!Object.hasOwn(ordered, key)) ordered[key] = row[key];
  return ordered;
}

function changedRows(doc: ReplayedDocument, changes: ChangeSet): StepRow[] {
  const rows = doc.rows ?? [];
  if (changes.whole || changes.cells.some(cell => cell.rowId === null)) return rows.map(written);
  const named = new Set<unknown>([...changes.cells.map(cell => cell.rowId), ...changes.rowsInserted, ...changes.rowsRemoved]);
  return rows.filter(row => named.has(row.id)).map(written);
}

// why: standalone replays a record's diffStates steps, reversed for undo; the changed rows give the same steps
export function replayedSteps(before: ReplayedDocument, after: ReplayedDocument, changes: ChangeSet, dir: UndoDirection): Step[] {
  const was = { rows: changedRows(before, changes) }, now = { rows: changedRows(after, changes) };
  return dir === "undo" ? invertSteps(diffStates(now, was)) : diffStates(was, now);
}
