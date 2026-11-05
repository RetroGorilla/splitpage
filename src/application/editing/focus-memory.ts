export interface FocusMemory<Cell> {
  readonly lastRow: () => string | null;
  readonly focusedRow: (rowId: string) => void;
  readonly promptMutedFor: () => Cell | null;
  readonly mutePrompt: (cell: Cell) => void;
  readonly unmutePrompt: () => void;
}

export function createFocusMemory<Cell>(): FocusMemory<Cell> {
  let row: string | null = null;
  let muted: Cell | null = null;
  return {
    lastRow: () => row,
    focusedRow(rowId: string): void { row = rowId; },
    promptMutedFor: () => muted,
    mutePrompt(cell: Cell): void { muted = cell; },
    unmutePrompt(): void { muted = null; }
  };
}
