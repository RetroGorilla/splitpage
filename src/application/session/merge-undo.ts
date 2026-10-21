import type { MergeUndoRecord } from "./apply-merge.ts";

export interface MergeUndo {
  readonly last: () => MergeUndoRecord | null;
  readonly arm: (record: MergeUndoRecord | null) => void;
}

export function createMergeUndo(): MergeUndo {
  let record: MergeUndoRecord | null = null;
  return {
    last: () => record,
    arm(next: MergeUndoRecord | null): void { record = next; }
  };
}
