export interface RowDrag {
  readonly dragging: () => string | null;
  readonly start: (rowId: string) => void;
  readonly end: () => void;
}

export function createRowDrag(): RowDrag {
  let rowId: string | null = null;
  return {
    dragging: () => rowId,
    start(id: string): void { rowId = id; },
    end(): void { rowId = null; }
  };
}
