import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { Run } from "../../core/text/runs.ts";
import type { CommandOutcome } from "../session/document-session.ts";

export interface WholeFieldTextCommit {
  readonly commit: (rowId: string, field: string, runs: readonly Run[]) => CommandOutcome;
}

export interface PaintedText {
  readonly revision: number;
  readonly text: string;
  readonly identity: (index: number) => SharedContentRef | null;
}

export interface PaintedTextSource {
  readonly read: (rowId: string, field: string) => PaintedText | null;
}
