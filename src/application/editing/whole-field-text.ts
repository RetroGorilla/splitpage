import { cellRuns, cellTextCommand } from "../commands/cell-text.ts";
import type { DocumentEdits } from "../session/document-edits.ts";
import type { WholeFieldTextCommit } from "./ports.ts";

export function createWholeFieldTextCommit(edits: Pick<DocumentEdits, "run" | "text">): WholeFieldTextCommit {
  return {
    commit: (rowId, field, runs) => edits.run(cellTextCommand(rowId, field, cellRuns(runs), edits.text))
  };
}
