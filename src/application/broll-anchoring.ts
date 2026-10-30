export interface BrollAnchorDeclines {
  readonly reset: () => void;
  readonly decline: (rows: readonly { readonly id: string }[] | null | undefined) => void;
  readonly declined: (id: string) => boolean;
}

export function createBrollAnchoring(): BrollAnchorDeclines {
  let declined: Record<string, boolean> = Object.create(null);
  return Object.freeze({
    reset: (): void => {
      declined = Object.create(null);
    },
    decline: (rows: readonly { readonly id: string }[] | null | undefined): void => {
      (rows || []).forEach(function (row) { declined[row.id] = true; });
    },
    declined: (id: string): boolean => !!declined[id]
  });
}
