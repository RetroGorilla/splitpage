export interface FocusMemory<Cell> {
  readonly lastRow: () => string | null;
  readonly focusedRow: (rowId: string) => void;
  readonly writerParagraph: () => Cell | null;
  readonly focusedParagraph: (paragraph: Cell | null) => void;
  readonly promptMutedFor: () => Cell | null;
  readonly mutePrompt: (cell: Cell) => void;
  readonly unmutePrompt: () => void;
}

export function createFocusMemory<Cell>(): FocusMemory<Cell> {
  let row: string | null = null;
  let paragraph: Cell | null = null;
  let muted: Cell | null = null;
  return {
    lastRow: () => row,
    focusedRow(rowId: string): void { row = rowId; },
    writerParagraph: () => paragraph,
    focusedParagraph(next: Cell | null): void { paragraph = next; },
    promptMutedFor: () => muted,
    mutePrompt(cell: Cell): void { muted = cell; },
    unmutePrompt(): void { muted = null; }
  };
}
