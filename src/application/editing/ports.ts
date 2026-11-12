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
  readonly emptyGap?: SharedContentRef;
  readonly endGap?: SharedContentRef;
}

export interface BufferedTextEdit {
  readonly text: () => string;
  readonly replace: (from: number, to: number, insert: string) => void;
  readonly commit: (runs: readonly Run[]) => CommandOutcome;
  readonly cancel: () => void;
}

export interface BufferedTextCommit {
  readonly open: (rowId: string, painted: PaintedText) => BufferedTextEdit | null;
}

export interface PaintedTextSource {
  readonly documentRevision: () => number;
  readonly read: (rowId: string, field: string) => PaintedText | null;
}
