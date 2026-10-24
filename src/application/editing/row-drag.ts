export interface RowDrag {
  readonly dragging: () => string | null;
  readonly start: (rowId: string) => void;
  readonly end: () => void;
  readonly onEnd: (listener: () => void) => () => void;
}

export function createRowDrag(): RowDrag {
  let rowId: string | null = null;
  const ended: (() => void)[] = [];
  return {
    dragging: () => rowId,
    start(id: string): void { rowId = id; },
    end(): void {
      rowId = null;
      for (const listener of ended.slice()) listener();
    },
    onEnd(listener: () => void): () => void {
      ended.push(listener);
      return () => {
        const at = ended.indexOf(listener);
        if (at !== -1) ended.splice(at, 1);
      };
    }
  };
}
