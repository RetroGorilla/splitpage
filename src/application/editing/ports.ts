import type { Run } from "../../core/text/runs.ts";
import type { CommandOutcome } from "../session/document-session.ts";

export interface WholeFieldTextCommit {
  readonly commit: (rowId: string, field: string, runs: readonly Run[]) => CommandOutcome;
}
