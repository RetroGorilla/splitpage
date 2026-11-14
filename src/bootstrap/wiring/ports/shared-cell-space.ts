let reader: ((cell: Element) => string | null) | null = null;

export function sharedCellSpaceForm(cell: Element): string | null { return reader?.(cell) ?? null; }

export function connectSharedCellSpaceForm(read: (cell: Element) => string | null): () => void {
  if (reader) throw new Error("A shared Split clipboard is already mounted");
  reader = read;
  return () => { if (reader === read) reader = null; };
}
